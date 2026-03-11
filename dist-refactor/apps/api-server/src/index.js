"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.httpServer = exports.io = exports.app = void 0;
exports.getServer = getServer;
const path_1 = __importDefault(require("path"));
require('dotenv').config({ path: path_1.default.join(process.cwd(), '.env') });
const runtimeStrategyConfig = require(path_1.default.join(process.cwd(), 'lib', 'runtimeStrategyConfig'));
const express_1 = __importDefault(require("express"));
const http_1 = require("http");
const socket_io_1 = require("socket.io");
const EngineStateService_1 = require("../../../packages/core/src/EngineStateService");
const EngineControlService_1 = require("../../../packages/core/src/EngineControlService");
const ProfitCalculationService_1 = require("../../../packages/core/src/ProfitCalculationService");
const EventBus_1 = require("../../../packages/core/src/EventBus");
const HealthReportService_1 = require("../../../packages/core/src/HealthReportService");
const MarketSnapshotService_1 = require("../../../packages/core/src/MarketSnapshotService");
const GeminiAnalysisService_1 = require("../../../packages/core/src/GeminiAnalysisService");
const CircuitBreakerService_1 = require("../../../packages/core/src/CircuitBreakerService");
const AuditLogService_1 = require("../../../packages/core/src/AuditLogService");
const StrategyExplainService_1 = require("../../../packages/core/src/StrategyExplainService");
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
function getAdminConfigStatus() {
    const present = !!((process.env.ADMIN_ID || '').trim() ||
        (process.env.ADMIN_DISCORD_ID || '').trim() ||
        (process.env.DISCORD_ADMIN_ID || '').trim() ||
        (process.env.SUPER_ADMIN_ID || '').trim());
    return {
        adminConfigPresent: present,
        adminConfigWarning: present ? null : 'ADMIN_ID or ADMIN_DISCORD_ID is not set. Strategy mode change via Discord may not work for admin-only operations.',
    };
}
app.get('/api/health', (_req, res) => {
    const report = HealthReportService_1.HealthReportService.build('api-server', { upbitAuthOk: true, discordConnected: true });
    const admin = getAdminConfigStatus();
    res.json({ ...report, adminConfigPresent: admin.adminConfigPresent, adminConfigWarning: admin.adminConfigWarning });
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
app.get('/api/engine-status', (_req, res) => {
    const ctrl = EngineControlService_1.EngineControlService.getState();
    const strategyState = runtimeStrategyConfig.getState();
    res.json({
        status: ctrl.status,
        startedAt: ctrl.startedAt,
        stoppedAt: ctrl.stoppedAt,
        updatedBy: ctrl.updatedBy,
        lastReason: ctrl.lastReason,
        runtimeMode: strategyState?.mode ?? null,
    });
});
app.post('/api/engine/start', async (req, res) => {
    const userId = (req.body && req.body.userId) || req.headers?.['x-user-id'] || 'api';
    const updatedBy = (req.body && req.body.updatedBy) || userId;
    try {
        const result = EngineControlService_1.EngineControlService.startEngine(updatedBy);
        if (result.noop) {
            await AuditLogService_1.AuditLogService.log({
                userId,
                command: 'engine_start',
                timestamp: new Date().toISOString(),
                success: true,
            });
            return res.json({ success: true, noop: true, message: result.message });
        }
        const s = await getServer();
        const serverResult = await s.discordHandlers.engineStart();
        if (serverResult && !serverResult.success) {
            EngineControlService_1.EngineControlService.stopEngine('system');
            await AuditLogService_1.AuditLogService.log({
                userId,
                command: 'engine_start',
                timestamp: new Date().toISOString(),
                success: false,
                errorCode: serverResult.message || 'engineStart failed',
            });
            return res.json(serverResult);
        }
        await AuditLogService_1.AuditLogService.log({
            userId,
            command: 'engine_start',
            timestamp: new Date().toISOString(),
            success: true,
        });
        res.json({ success: true, message: result.message });
    }
    catch (e) {
        EngineControlService_1.EngineControlService.stopEngine('system');
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
    const updatedBy = (req.body && req.body.updatedBy) || userId;
    try {
        const result = EngineControlService_1.EngineControlService.stopEngine(updatedBy);
        if (result.noop) {
            await AuditLogService_1.AuditLogService.log({
                userId,
                command: 'engine_stop',
                timestamp: new Date().toISOString(),
                success: true,
            });
            return res.json({ success: true, noop: true, message: result.message });
        }
        const s = await getServer();
        s.discordHandlers.engineStop();
        await AuditLogService_1.AuditLogService.log({
            userId,
            command: 'engine_stop',
            timestamp: new Date().toISOString(),
            success: true,
        });
        res.json({ success: true, message: result.message || '엔진 정지됨' });
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
app.get('/api/strategy-config', (_req, res) => {
    try {
        const state = runtimeStrategyConfig.getState();
        res.json({
            mode: state.mode,
            profile: state.profile,
            thresholdEntry: state.profile?.thresholdEntry,
            minOrchestratorScore: state.profile?.minOrchestratorScore,
            updatedBy: state.updatedBy,
            updatedAt: state.updatedAt,
            presetModes: runtimeStrategyConfig.getPresetModes(),
            modeMeta: runtimeStrategyConfig.getModeMeta?.() ?? {},
        });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/strategy-mode', async (req, res) => {
    const userId = (req.body && req.body.userId) || req.headers?.['x-user-id'] || 'api';
    const updatedBy = (req.body && req.body.updatedBy) || req.get?.('x-updated-by') || 'dashboard';
    const mode = (req.body && req.body.mode);
    if (!mode || typeof mode !== 'string') {
        return res.status(400).json({ ok: false, error: 'mode required (SAFE, A_CONSERVATIVE, A_BALANCED, A_ACTIVE)' });
    }
    try {
        const result = runtimeStrategyConfig.setMode(mode.trim().toUpperCase(), updatedBy);
        if (!result.ok) {
            return res.status(400).json({ ok: false, error: result.error });
        }
        const current = result.current;
        const payload = {
            mode: current.mode,
            profile: current.profile,
            thresholdEntry: current.profile?.thresholdEntry,
            minOrchestratorScore: current.profile?.minOrchestratorScore,
            updatedBy: current.updatedBy,
            updatedAt: current.updatedAt,
        };
        EventBus_1.EventBus.emit('STRATEGY_MODE_CHANGED', payload);
        EventBus_1.EventBus.emit('STRATEGY_THRESHOLD_UPDATED', payload);
        await AuditLogService_1.AuditLogService.log({
            userId,
            command: 'strategy_mode_change',
            timestamp: new Date().toISOString(),
            success: true,
        });
        res.json({ ok: true, mode: payload.mode, profile: payload.profile, thresholdEntry: payload.thresholdEntry, minOrchestratorScore: payload.minOrchestratorScore, updatedBy: payload.updatedBy, updatedAt: payload.updatedAt });
    }
    catch (e) {
        await AuditLogService_1.AuditLogService.log({
            userId,
            command: 'strategy_mode_change',
            timestamp: new Date().toISOString(),
            success: false,
            errorCode: e.message,
        });
        res.status(500).json({ ok: false, error: e.message });
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
app.get('/api/strategy-status', async (_req, res) => {
    try {
        const state = runtimeStrategyConfig.getState();
        const explainRecent = StrategyExplainService_1.StrategyExplainService.getRecent(100);
        const now = Date.now();
        const thirtyMinAgo = now - 30 * 60 * 1000;
        const parseTs = (e) => {
            const t = e?.timestamp;
            if (!t)
                return 0;
            return typeof t === 'string' ? new Date(t).getTime() : t;
        };
        const recent = explainRecent.filter((e) => parseTs(e) >= thirtyMinAgo);
        const trades = recent.filter((e) => (e.action ?? e.decision) === 'BUY');
        const skips = recent.filter((e) => (e.action ?? e.decision) === 'SKIP');
        const skipReasons = {};
        skips.forEach((e) => {
            const r = e.skip_reason || 'unknown';
            skipReasons[r] = (skipReasons[r] || 0) + 1;
        });
        const skipTop5 = Object.entries(skipReasons)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([reason, count]) => ({ reason, count }));
        const buyRecent5 = trades.slice(0, 5).map((e) => ({
            symbol: e.symbol ?? e.coin,
            time: e.timestamp,
            finalScore: e.final_orchestrator_score,
            reason: e.reason_summary ?? e.reason,
        }));
        res.json({
            mode: state.mode,
            thresholdEntry: state.thresholdEntry,
            minOrchestratorScore: state.minOrchestratorScore,
            updatedBy: state.updatedBy,
            updatedAt: state.updatedAt,
            tradeCountLast30m: trades.length,
            decisionCountLast30m: recent.length,
            skipTop5,
            buyRecent5,
        });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.get('/api/strategy-explain-recent', async (_req, res) => {
    try {
        const explainRecent = StrategyExplainService_1.StrategyExplainService.getRecent(10);
        const decisions = explainRecent.map((e) => ({
            symbol: e.symbol ?? e.coin,
            source_strategy: e.source_strategy,
            action: e.action ?? e.decision,
            raw_entry_score: e.raw_entry_score,
            normalized_score: e.normalized_score,
            final_orchestrator_score: e.final_orchestrator_score,
            threshold_entry: e.threshold_entry,
            skip_reason: e.skip_reason,
            reason_summary: e.reason_summary ?? e.reason,
            timestamp: e.timestamp,
        }));
        res.json({ ok: true, decisions });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
/** 콘솔 대시보드용 세그먼트 빌드 (getServer().state 기반). 실패 시 기본값만 반환 */
async function buildConsoleSegments() {
    const engineState = EngineStateService_1.EngineStateService.getState();
    const health = HealthReportService_1.HealthReportService.build('api-server', { upbitAuthOk: true, discordConnected: true });
    const circuitUpbit = CircuitBreakerService_1.CircuitBreakerService.getState('upbit');
    const circuitGemini = CircuitBreakerService_1.CircuitBreakerService.getState('gemini');
    const explainRecent = StrategyExplainService_1.StrategyExplainService.getRecent(80);
    const strategyConfigState = runtimeStrategyConfig.getState();
    const adminStatus = getAdminConfigStatus();
    const engineCtrl = EngineControlService_1.EngineControlService.getState();
    const system_status = {
        engine: engineCtrl.status,
        engineStartedAt: engineCtrl.startedAt,
        engineStoppedAt: engineCtrl.stoppedAt,
        engineUpdatedBy: engineCtrl.updatedBy,
        marketData: circuitUpbit === 'CLOSED' ? 'healthy' : circuitUpbit === 'OPEN' ? 'unhealthy' : 'degraded',
        exchange: health.upbitAuthOk ? 'connected' : 'disconnected',
        latencyMs: null,
        circuitBreaker: circuitUpbit === 'CLOSED' && circuitGemini === 'CLOSED' ? 'normal' : `${circuitUpbit}/${circuitGemini}`,
        uptimeSec: health.uptimeSec,
        lastOrderAt: engineState.lastOrderAt,
        adminConfigPresent: adminStatus.adminConfigPresent,
        adminConfigWarning: adminStatus.adminConfigWarning,
    };
    const market_state = {
        mode: '—',
        volatility: '—',
        spreadBps: null,
        liquidity: '—',
        regime: '—',
    };
    const strategy_signals = [];
    const positions = [];
    const execution_log = explainRecent.map((e) => ({
        time: e.timestamp,
        coin: e.coin ?? e.symbol,
        action: e.action ?? e.decision,
        price: e.meta?.price ?? null,
        edge: e.edgeScoreBps != null ? `${e.edgeScoreBps}bps` : null,
        reason: e.reason ?? e.reason_summary ?? null,
        symbol: e.symbol ?? e.coin,
        source_strategy: e.source_strategy ?? null,
        raw_entry_score: e.raw_entry_score ?? null,
        normalized_score: e.normalized_score != null ? Number(e.normalized_score) : null,
        final_orchestrator_score: e.final_orchestrator_score != null ? Number(e.final_orchestrator_score) : null,
        threshold_entry: e.threshold_entry != null ? Number(e.threshold_entry) : null,
        min_orchestrator_score: e.min_orchestrator_score != null ? Number(e.min_orchestrator_score) : null,
        skip_reason: e.skip_reason ?? null,
        reason_summary: e.reason_summary ?? e.reason ?? null,
    }));
    const profitSummary = ProfitCalculationService_1.ProfitCalculationService.getSummary(engineState.assets);
    const risk_monitor = {
        exposurePct: engineState.assets
            ? (engineState.assets.totalEvaluationKrw ?? 0) / Math.max(1, (engineState.assets.totalEvaluationKrw ?? 0) + (engineState.assets.orderableKrw ?? 0)) * 100
            : 0,
        dailyPnlPct: profitSummary.profitPct ?? 0,
        drawdownPct: 0,
        riskLimit: '—',
    };
    const circuit_breaker = {
        upbit: circuitUpbit,
        gemini: circuitGemini,
        status: circuitUpbit === 'CLOSED' ? 'normal' : 'tripped',
    };
    const now = Date.now();
    const thirtyMinAgo = now - 30 * 60 * 1000;
    const parseTs = (e) => {
        const t = e?.timestamp;
        if (!t)
            return 0;
        return typeof t === 'string' ? new Date(t).getTime() : t;
    };
    const recentExplain = explainRecent.filter((e) => parseTs(e) >= thirtyMinAgo);
    const skipReasons30m = {};
    recentExplain.forEach((e) => {
        const a = e.action ?? e.decision;
        if (a === 'SKIP') {
            const r = e.skip_reason || 'unknown';
            skipReasons30m[r] = (skipReasons30m[r] || 0) + 1;
        }
    });
    const strategy_config = {
        mode: strategyConfigState.mode,
        profile: strategyConfigState.profile,
        description: strategyConfigState.profile?.description,
        thresholdEntry: strategyConfigState.profile?.thresholdEntry,
        minOrchestratorScore: strategyConfigState.profile?.minOrchestratorScore,
        updatedBy: strategyConfigState.updatedBy,
        updatedAt: strategyConfigState.updatedAt,
        tradeCountLast30m: recentExplain.filter((e) => (e.action ?? e.decision) === 'BUY').length,
        decisionCountLast30m: recentExplain.length,
        skipReasonDistribution: skipReasons30m,
    };
    try {
        const s = await getServer();
        const st = s.state || {};
        system_status.latencyMs = typeof st.wsLagMs === 'number' ? st.wsLagMs : null;
        if (st.marketContext && typeof st.marketContext === 'object') {
            market_state.mode = st.marketContext.regime ?? st.marketContext.mode ?? '—';
            market_state.volatility = st.marketContext.volatility ?? '—';
            market_state.liquidity = st.marketContext.liquidity ?? '—';
        }
        if (st.lastOrchestratorResult?.signal) {
            const sig = st.lastOrchestratorResult.signal;
            const sym = (sig.symbol || (sig.market || '').replace('KRW-', '')) || '—';
            strategy_signals.push({
                coin: sym,
                signalType: st.lastOrchestratorResult.action === 'ENTER' ? 'BUY' : 'HOLD',
                edgeBps: st.lastOrchestratorResult.finalScore != null ? Math.round(st.lastOrchestratorResult.finalScore * 100) : null,
                rotationCandidate: !!(st.raceHorseActive && ['BTC', 'ETH', 'SOL', 'XRP'].includes(sym)),
            });
        }
        if (st.scalpState && typeof st.scalpState === 'object') {
            for (const [market, entry] of Object.entries(st.scalpState)) {
                const sym = (market || '').replace('KRW-', '') || '—';
                if (entry?.entryScore != null && !strategy_signals.some((s) => s.coin === sym)) {
                    strategy_signals.push({
                        coin: sym,
                        signalType: entry.entryScore >= (st.strategySummary?.entry_score_min ?? 4) ? 'BUY' : 'HOLD',
                        edgeBps: entry.entryScore != null ? Math.round(entry.entryScore * 10) : null,
                        rotationCandidate: ['BTC', 'ETH', 'SOL', 'XRP'].includes(sym),
                    });
                }
            }
        }
        const accounts = st.accounts || [];
        const prices = st.prices || {};
        for (const a of accounts) {
            const cur = (a.currency || '').toUpperCase();
            if (cur === 'KRW')
                continue;
            const bal = parseFloat(a.balance || 0);
            if (bal <= 0)
                continue;
            const avgBuy = parseFloat(a.avg_buy_price || 0);
            const market = 'KRW-' + cur;
            const ticker = prices[market];
            const tradePrice = ticker?.tradePrice ?? ticker?.trade_price ?? 0;
            const entryPrice = avgBuy > 0 ? avgBuy : tradePrice;
            const pnlPct = entryPrice > 0 && tradePrice > 0 ? ((tradePrice / entryPrice) - 1) * 100 : 0;
            const updatedAt = a.updated_at ? new Date(a.updated_at).getTime() : null;
            const holdTimeMin = updatedAt ? Math.floor((Date.now() - updatedAt) / 60000) : 0;
            positions.push({
                coin: cur,
                size: bal,
                entryPrice,
                pnl: (tradePrice - entryPrice) * bal,
                pnlPct,
                holdTimeMin,
            });
        }
        if (st.trades && Array.isArray(st.trades) && execution_log.length < 30) {
            for (const t of st.trades.slice(0, 20)) {
                execution_log.push({
                    time: t.timestamp ?? t.created_at,
                    coin: (t.ticker || t.market || '').replace('KRW-', ''),
                    action: (t.side || 'BUY').toUpperCase(),
                    price: t.price ?? null,
                    edge: null,
                    reason: t.reason ?? '—',
                    symbol: (t.ticker || t.market || '').replace('KRW-', ''),
                    source_strategy: null,
                    raw_entry_score: null,
                    normalized_score: null,
                    final_orchestrator_score: null,
                    threshold_entry: null,
                    min_orchestrator_score: null,
                    skip_reason: null,
                    reason_summary: t.reason ?? '—',
                });
            }
        }
    }
    catch (_) { }
    return {
        system_status,
        market_state,
        strategy_signals,
        positions,
        execution_log,
        risk_monitor,
        circuit_breaker,
        strategy_config,
    };
}
function emitConsoleToAll() {
    buildConsoleSegments().then((segments) => {
        io.emit('console:system_status', segments.system_status);
        io.emit('console:market_state', segments.market_state);
        io.emit('console:strategy_signals', segments.strategy_signals);
        io.emit('console:positions', segments.positions);
        io.emit('console:execution_log', segments.execution_log);
        io.emit('console:risk_monitor', segments.risk_monitor);
        io.emit('console:circuit_breaker', segments.circuit_breaker);
        io.emit('console:strategy_config', segments.strategy_config);
    }).catch(() => { });
}
io.on('connection', (socket) => {
    const state = EngineStateService_1.EngineStateService.getState();
    const summary = ProfitCalculationService_1.ProfitCalculationService.getSummary(state.assets);
    socket.emit('dashboard', {
        assets: state.assets,
        profitSummary: summary,
        botEnabled: state.botEnabled,
        lastOrderAt: state.lastOrderAt,
    });
    emitConsoleToAll();
});
StrategyExplainService_1.StrategyExplainService.subscribeToEventBus();
// FIX: DASHBOARD_EMIT은 socket.io / web dashboard 전용.
EventBus_1.EventBus.subscribe('DASHBOARD_EMIT', (payload) => {
    io.emit('dashboard', payload.lastEmit);
    emitConsoleToAll();
});
const PORT = Number(process.env.PORT) || 3000;
httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error('[fatal][api-server] Port ' + PORT + ' already in use. Stop the other process (e.g. upbit-bot or another api-server) or set PORT=3001 in .env');
        process.exit(1);
    }
    throw err;
});
httpServer.listen(PORT, () => {
    console.log(`[api-server] http://localhost:${PORT}`);
    const adminStatus = getAdminConfigStatus();
    const strategyState = runtimeStrategyConfig.getState();
    console.log('[startup] app=api-server port=' + PORT + ' adminConfigPresent=' + adminStatus.adminConfigPresent + ' runtimeMode=' + (strategyState?.mode || '—') + ' lockFile=.server.lock');
    try {
        require('../../trading-engine/src/index');
        console.log('[api-server] trading-engine loaded');
    }
    catch (e) {
        console.error('[api-server] trading-engine load failed:', e.message);
    }
});
