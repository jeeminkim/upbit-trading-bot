"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.httpServer = exports.io = exports.app = void 0;
exports.getServer = getServer;
const path_1 = __importDefault(require("path"));
require('dotenv').config({ path: path_1.default.join(process.cwd(), '.env') });
const express_1 = __importDefault(require("express"));
const http_1 = require("http");
const socket_io_1 = require("socket.io");
const EngineStateService_1 = require("../../../packages/core/src/EngineStateService");
const ProfitCalculationService_1 = require("../../../packages/core/src/ProfitCalculationService");
const EventBus_1 = require("../../../packages/core/src/EventBus");
const HealthReportService_1 = require("../../../packages/core/src/HealthReportService");
const MarketSnapshotService_1 = require("../../../packages/core/src/MarketSnapshotService");
const GeminiAnalysisService_1 = require("../../../packages/core/src/GeminiAnalysisService");
const CircuitBreakerService_1 = require("../../../packages/core/src/CircuitBreakerService");
const AuditLogService_1 = require("../../../packages/core/src/AuditLogService");
const errors_1 = require("../../../packages/shared/src/errors");
const app = (0, express_1.default)();
exports.app = app;
const httpServer = (0, http_1.createServer)(app);
exports.httpServer = httpServer;
const io = new socket_io_1.Server(httpServer);
exports.io = io;
const serverPath = path_1.default.join(process.cwd(), 'server.js');
let serverModule = null;
async function getServer() {
    if (!serverModule) {
        serverModule = require(serverPath);
        await serverModule.initPromise;
    }
    return serverModule;
}
app.use(express_1.default.json());
app.use(express_1.default.static(path_1.default.join(process.cwd(), 'public')));
app.get('/api/health', (_req, res) => {
    const report = HealthReportService_1.HealthReportService.build('api-server', { upbitAuthOk: true, discordConnected: true });
    res.json(report);
});
app.get('/api/dashboard', (_req, res) => {
    const state = EngineStateService_1.EngineStateService.getState();
    const summary = ProfitCalculationService_1.ProfitCalculationService.getSummary(state.assets);
    res.json({
        assets: state.assets,
        profitSummary: summary,
        botEnabled: state.botEnabled,
        lastOrderAt: state.lastOrderAt,
    });
});
app.get('/api/status', async (_req, res) => {
    try {
        const s = await getServer();
        s.state.assets = await s.fetchAssets();
        const assets = s.state.assets;
        const summary = ProfitCalculationService_1.ProfitCalculationService.getSummary(assets);
        res.json({
            assets,
            profitSummary: summary,
            strategySummary: s.state.strategySummary || null,
            botEnabled: s.state.botEnabled,
        });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.get('/api/pnl', async (_req, res) => {
    try {
        const s = await getServer();
        s.state.assets = await s.fetchAssets();
        const assets = s.state.assets;
        const summary = ProfitCalculationService_1.ProfitCalculationService.getSummary(assets);
        res.json({ assets, profitSummary: summary });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/engine/start', async (req, res) => {
    const userId = (req.body && req.body.userId) || req.headers?.['x-user-id'] || 'api';
    try {
        const s = await getServer();
        const result = await s.discordHandlers.engineStart();
        if (result && result.success)
            EngineStateService_1.EngineStateService.setBotEnabled(true);
        await AuditLogService_1.AuditLogService.log({
            userId,
            command: 'engine_start',
            timestamp: new Date().toISOString(),
            success: !!(result && result.success),
        });
        res.json(result || { success: false, message: 'Unknown' });
    }
    catch (e) {
        await AuditLogService_1.AuditLogService.log({
            userId,
            command: 'engine_start',
            timestamp: new Date().toISOString(),
            success: false,
            errorCode: e.message,
        });
        res.status(500).json({ success: false, message: e.message });
    }
});
app.post('/api/engine/stop', async (req, res) => {
    const userId = (req.body && req.body.userId) || req.headers?.['x-user-id'] || 'api';
    try {
        const s = await getServer();
        s.discordHandlers.engineStop();
        EngineStateService_1.EngineStateService.setBotEnabled(false);
        await AuditLogService_1.AuditLogService.log({
            userId,
            command: 'engine_stop',
            timestamp: new Date().toISOString(),
            success: true,
        });
        res.json({ success: true, message: '엔진 정지됨' });
    }
    catch (e) {
        await AuditLogService_1.AuditLogService.log({
            userId,
            command: 'engine_stop',
            timestamp: new Date().toISOString(),
            success: false,
            errorCode: e.message,
        });
        res.status(500).json({ success: false, message: e.message });
    }
});
app.post('/api/sell-all', async (req, res) => {
    const userId = (req.body && req.body.userId) || req.headers?.['x-user-id'] || 'api';
    try {
        const s = await getServer();
        const result = await s.discordHandlers.sellAll();
        const ok = typeof result === 'string';
        await AuditLogService_1.AuditLogService.log({
            userId,
            command: 'sell_all',
            timestamp: new Date().toISOString(),
            success: ok,
        });
        res.json(ok ? { success: true, message: result } : { success: false, message: String(result || 'Unknown') });
    }
    catch (e) {
        await AuditLogService_1.AuditLogService.log({
            userId,
            command: 'sell_all',
            timestamp: new Date().toISOString(),
            success: false,
            errorCode: e.message,
        });
        res.status(500).json({ success: false, message: e.message });
    }
});
const ANALYST_TIMEOUT_MS = 25000;
function withAnalystTimeout(p) {
    return Promise.race([
        p,
        new Promise((_, reject) => setTimeout(() => reject(new Error('ANALYSIS_TIMEOUT')), ANALYST_TIMEOUT_MS)),
    ]);
}
app.get('/api/analyst/scan-vol', async (_req, res) => {
    try {
        const enriched = await withAnalystTimeout(CircuitBreakerService_1.CircuitBreakerService.execute('upbit', () => MarketSnapshotService_1.MarketSnapshotService.getEnrichedTopN(10)));
        const payload = enriched.map((e) => ({
            symbol: e.symbol,
            price: e.price,
            rsi: e.rsi,
            strength: e.strength,
            volumeChange: e.volumeChange,
        }));
        const result = await withAnalystTimeout(CircuitBreakerService_1.CircuitBreakerService.execute('gemini', () => GeminiAnalysisService_1.GeminiAnalysisService.scanVolAnalysis(payload)));
        if (result.ok) {
            return res.json({ ok: true, data: { text: result.data }, meta: { cachedAt: Date.now() } });
        }
        return res.status(503).json({
            ok: false,
            error: result.error?.code || errors_1.AppErrorCode.GEMINI_UNAVAILABLE,
            message: result.error?.message,
        });
    }
    catch (_e) {
        return res.status(500).json({ ok: false, error: 'ANALYSIS_FAILED' });
    }
});
app.get('/api/analyst/summary', async (_req, res) => {
    try {
        const indicators = await withAnalystTimeout(MarketSnapshotService_1.MarketSnapshotService.getMarketIndicators());
        const ctx = {
            fng: indicators.fng
                ? `공포·탐욕 지수: ${indicators.fng.value} (${indicators.fng.classification})`
                : '공포·탐욕: —',
            btcTrend: indicators.btcTrend,
            topTickers: indicators.topTickersText,
            kimp: indicators.kimpAvg != null ? `김치 프리미엄(평균): ${indicators.kimpAvg.toFixed(2)}%` : '김프: —',
        };
        const result = await withAnalystTimeout(CircuitBreakerService_1.CircuitBreakerService.execute('gemini', () => GeminiAnalysisService_1.GeminiAnalysisService.marketSummaryAnalysis(ctx)));
        if (result.ok) {
            return res.json({ ok: true, data: { text: result.data } });
        }
        return res.status(503).json({
            ok: false,
            error: result.error?.code || errors_1.AppErrorCode.GEMINI_UNAVAILABLE,
            message: result.error?.message,
        });
    }
    catch (_e) {
        return res.status(500).json({ ok: false, error: 'ANALYSIS_FAILED' });
    }
});
app.get('/api/analyst/indicators', async (_req, res) => {
    try {
        const indicators = await withAnalystTimeout(MarketSnapshotService_1.MarketSnapshotService.getMarketIndicators());
        return res.json({
            ok: true,
            data: {
                fng: indicators.fng,
                btcTrend: indicators.btcTrend,
                kimpAvg: indicators.kimpAvg,
                kimpByMarket: indicators.kimpByMarket,
                topTickersText: indicators.topTickersText,
            },
        });
    }
    catch (_e) {
        return res.status(500).json({ ok: false, error: 'ANALYSIS_FAILED' });
    }
});
app.get('/api/analyst/scalp-point', async (_req, res) => {
    try {
        const enriched = await withAnalystTimeout(CircuitBreakerService_1.CircuitBreakerService.execute('upbit', () => MarketSnapshotService_1.MarketSnapshotService.getEnrichedTopN(5)));
        const dataText = MarketSnapshotService_1.MarketSnapshotService.getScalpPointDataLines(enriched);
        const result = await withAnalystTimeout(CircuitBreakerService_1.CircuitBreakerService.execute('gemini', () => GeminiAnalysisService_1.GeminiAnalysisService.scalpPointAnalysis(dataText)));
        if (result.ok) {
            return res.json({ ok: true, data: { text: result.data } });
        }
        return res.status(503).json({
            ok: false,
            error: result.error?.code || errors_1.AppErrorCode.GEMINI_UNAVAILABLE,
            message: result.error?.message,
        });
    }
    catch (_e) {
        return res.status(500).json({ ok: false, error: 'ANALYSIS_FAILED' });
    }
});
io.on('connection', (socket) => {
    const state = EngineStateService_1.EngineStateService.getState();
    const summary = ProfitCalculationService_1.ProfitCalculationService.getSummary(state.assets);
    socket.emit('dashboard', {
        assets: state.assets,
        profitSummary: summary,
        botEnabled: state.botEnabled,
        lastOrderAt: state.lastOrderAt,
    });
});
// FIX: DASHBOARD_EMIT은 socket.io / web dashboard 전용. Discord status 메시지는 discord-operator startup 시에만 전송.
EventBus_1.EventBus.subscribe('DASHBOARD_EMIT', (payload) => {
    io.emit('dashboard', payload.lastEmit);
});
const PORT = Number(process.env.PORT) || 3000;
httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[api-server] Port ${PORT} already in use. Stop the other process (e.g. upbit-bot or another api-server) or set PORT=3001 in .env`);
        process.exit(0);
    }
    throw err;
});
httpServer.listen(PORT, () => {
    console.log(`[api-server] http://localhost:${PORT}`);
    try {
        require('../../trading-engine/src/index');
        console.log('[api-server] trading-engine loaded');
    }
    catch (e) {
        console.error('[api-server] trading-engine load failed:', e.message);
    }
});
