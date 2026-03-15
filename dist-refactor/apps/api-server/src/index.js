"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.httpServer = exports.io = exports.app = void 0;
const path_1 = __importDefault(require("path"));
require('dotenv').config({ path: path_1.default.join(process.cwd(), '.env') });
const runtimeStrategyConfig = require(path_1.default.join(process.cwd(), 'lib', 'runtimeStrategyConfig'));
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
const StrategyExplainService_1 = require("../../../packages/core/src/StrategyExplainService");
const LogUtil_1 = require("../../../packages/core/src/LogUtil");
const errors_1 = require("../../../packages/shared/src/errors");
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const app = (0, express_1.default)();
exports.app = app;
const API_LOG_TAG = 'API';
const httpServer = (0, http_1.createServer)(app);
exports.httpServer = httpServer;
const io = new socket_io_1.Server(httpServer);
exports.io = io;
const MARKET_BOT_URL = (process.env.MARKET_BOT_URL || 'http://localhost:3001').replace(/\/$/, '');
/** timeoutMs: 지정 시 해당 시간 내 응답 없으면 503 반환. /api/services-status 등에서 API 전체 block 방지용. */
async function proxyToMarketBot(path, opts) {
    let timeoutId;
    const signal = opts?.timeoutMs != null && opts.timeoutMs > 0
        ? (() => {
            const controller = new AbortController();
            timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs);
            return controller.signal;
        })()
        : undefined;
    try {
        const res = await fetch(MARKET_BOT_URL + path, {
            method: opts?.method || 'GET',
            headers: opts?.body ? { 'Content-Type': 'application/json' } : undefined,
            body: opts?.body ? JSON.stringify(opts.body) : undefined,
            signal,
        });
        if (timeoutId)
            clearTimeout(timeoutId);
        const data = await res.json().catch(() => ({}));
        return { ok: res.ok, data, status: res.status };
    }
    catch (e) {
        if (timeoutId)
            clearTimeout(timeoutId);
        return { ok: false, data: { error: e.message }, status: 503 };
    }
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
app.get('/api/dashboard', async (_req, res) => {
    const r = await proxyToMarketBot('/dashboard');
    if (r.ok && r.data)
        return res.json(r.data);
    res.status(r.status || 503).json(r.data || { error: 'Engine (market-bot) unavailable' });
});
app.get('/api/status', async (_req, res) => {
    const r = await proxyToMarketBot('/status');
    if (r.ok && r.data)
        return res.json(r.data);
    res.status(r.status || 503).json(r.data || { error: 'Engine (market-bot) unavailable' });
});
app.get('/api/pnl', async (_req, res) => {
    const r = await proxyToMarketBot('/pnl');
    if (r.ok && r.data)
        return res.json(r.data);
    res.status(r.status || 503).json(r.data || { error: 'Engine (market-bot) unavailable' });
});
app.get('/api/engine-status', async (_req, res) => {
    const r = await proxyToMarketBot('/engine-status');
    if (r.ok && r.data)
        return res.json(r.data);
    res.status(r.status || 503).json(r.data || { status: 'unavailable', error: 'Engine (market-bot) unavailable' });
});
/** reasonCode: 집계/표시용 표준 코드. 문자열 오타 방지용 상수 */
const REASON_CODE = {
    OK: 'OK',
    TIMEOUT: 'TIMEOUT',
    CONNECTION_REFUSED: 'CONNECTION_REFUSED',
    UNREACHABLE: 'UNREACHABLE',
    STOPPED: 'STOPPED',
    UNAVAILABLE: 'UNAVAILABLE',
};
function deriveReasonAndCode(r) {
    if (r.ok)
        return { reason: null, reasonCode: REASON_CODE.OK };
    const msg = (r.data?.error ?? '').toLowerCase();
    if (msg.includes('abort') || msg.includes('timeout'))
        return { reason: 'timeout', reasonCode: REASON_CODE.TIMEOUT };
    if (msg.includes('econnrefused') || msg.includes('connection refused'))
        return { reason: 'connection refused', reasonCode: REASON_CODE.CONNECTION_REFUSED };
    if (msg.includes('enotfound') || msg.includes('getaddrinfo'))
        return { reason: 'unreachable', reasonCode: REASON_CODE.UNREACHABLE };
    return { reason: r.data?.error ?? 'unavailable', reasonCode: REASON_CODE.UNAVAILABLE };
}
/** 서비스 상태 패널용. market-bot 무응답 시에도 짧은 시간 내 응답하도록 timeout 적용(전체 API block 방지). */
const SERVICES_STATUS_TIMEOUT_MS = 5000;
const SERVICES_STATUS_TTL_MS = 1500;
/** in-flight Promise가 hang 시 deadlock 방지. 이 시간 초과 시 fallback 반환 후 inFlight 정리 */
const SERVICES_STATUS_IN_FLIGHT_TIMEOUT_MS = 8000;
/** 마지막 정상 응답 시각 (in-memory). first run null 허용 */
let lastMarketBotOkAt = null;
let lastEngineOkAt = null;
/** TTL 캐시: 연타/동시 호출 시 market-bot 부하 완화. Redis/파일 금지, in-memory만 */
let cachedServicesStatus = null;
/** 동시 요청 deduplication: TTL miss 시 실제 fetch는 1번만, 나머지는 같은 Promise await. timeout 시 fallback으로 resolve 후 정리 */
let servicesStatusInFlight = null;
function buildServicesStatusResponse(statusR, engineR) {
    const marketBot = statusR.ok === true;
    const engineStatus = engineR.ok && engineR.data ? engineR.data.status : undefined;
    const engineRunning = engineStatus === 'RUNNING';
    const now = Date.now();
    if (statusR.ok)
        lastMarketBotOkAt = now;
    if (engineR.ok && engineRunning)
        lastEngineOkAt = now;
    const marketBotRC = deriveReasonAndCode(statusR);
    const engineReasonCode = engineR.ok
        ? (engineRunning ? { reason: null, reasonCode: REASON_CODE.OK } : { reason: 'stopped', reasonCode: REASON_CODE.STOPPED })
        : deriveReasonAndCode(engineR);
    const age = (ts) => (ts != null ? Math.floor((now - ts) / 1000) : null);
    return {
        apiServer: true,
        marketBot,
        engineRunning: !!engineRunning,
        details: {
            apiServer: {
                reasonCode: REASON_CODE.OK,
                reason: null,
                lastOkAt: now,
                lastOkAgeSec: 0,
            },
            marketBot: {
                reasonCode: marketBotRC.reasonCode,
                reason: marketBotRC.reason,
                lastOkAt: lastMarketBotOkAt,
                lastOkAgeSec: age(lastMarketBotOkAt),
            },
            engine: {
                reasonCode: engineReasonCode.reasonCode,
                reason: engineReasonCode.reason,
                lastOkAt: lastEngineOkAt,
                lastOkAgeSec: age(lastEngineOkAt),
            },
        },
    };
}
/** fetch 예외 시 사용. reasonCode/reason/lastOkAt/lastOkAgeSec 구조 유지, lastOkAt은 기존 메모리 값 유지 */
function buildFallbackServicesStatusResponse(errorMessage) {
    const now = Date.now();
    const age = (ts) => (ts != null ? Math.floor((now - ts) / 1000) : null);
    return {
        apiServer: true,
        marketBot: false,
        engineRunning: false,
        details: {
            apiServer: {
                reasonCode: REASON_CODE.OK,
                reason: null,
                lastOkAt: now,
                lastOkAgeSec: 0,
            },
            marketBot: {
                reasonCode: REASON_CODE.UNAVAILABLE,
                reason: errorMessage || 'status fetch failed',
                lastOkAt: lastMarketBotOkAt,
                lastOkAgeSec: age(lastMarketBotOkAt),
            },
            engine: {
                reasonCode: REASON_CODE.UNAVAILABLE,
                reason: errorMessage || 'status fetch failed',
                lastOkAt: lastEngineOkAt,
                lastOkAgeSec: age(lastEngineOkAt),
            },
        },
    };
}
/** TTL 밖에서만 호출. 동시 요청 시 이 Promise를 공유해 fetch 1회만 수행. 예외 시 fallback 반환으로 resolve 유지 */
async function fetchServicesStatusInternal() {
    try {
        const [statusR, engineR] = await Promise.all([
            proxyToMarketBot('/status', { timeoutMs: SERVICES_STATUS_TIMEOUT_MS }),
            proxyToMarketBot('/engine-status', { timeoutMs: SERVICES_STATUS_TIMEOUT_MS }),
        ]);
        return buildServicesStatusResponse(statusR, engineR);
    }
    catch (e) {
        return buildFallbackServicesStatusResponse(e.message);
    }
}
/** in-flight에 최대 대기 시간 적용. 초과 시 fallback 반환하여 deadlock 방지. 항상 resolve. */
function startServicesStatusInFlight() {
    return (async () => {
        try {
            return await Promise.race([
                fetchServicesStatusInternal(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('services-status in-flight timeout')), SERVICES_STATUS_IN_FLIGHT_TIMEOUT_MS)),
            ]);
        }
        catch (e) {
            return buildFallbackServicesStatusResponse(e.message);
        }
    })();
}
/** debug: 요청당 1줄. cache hit / inFlight reuse / reasonCode 모니터링용 */
function logServicesStatusDebug(result, cacheHit, inFlightReuse) {
    try {
        const mb = result.details.marketBot.reasonCode;
        const eng = result.details.engine.reasonCode;
        console.log('[api-server][services-status] cacheHit=' + (cacheHit ? 1 : 0) + ' inFlightReuse=' + (inFlightReuse ? 1 : 0) + ' marketBot=' + mb + ' engine=' + eng);
    }
    catch (_) { }
}
/** 캐시된 응답 반환 시 lastOkAgeSec만 현재 시각 기준으로 갱신 */
function refreshCachedServicesStatus(cached) {
    const now = Date.now();
    const age = (ts) => (ts != null ? Math.floor((now - ts) / 1000) : null);
    return {
        ...cached,
        details: {
            apiServer: { ...cached.details.apiServer, lastOkAgeSec: 0 },
            marketBot: { ...cached.details.marketBot, lastOkAgeSec: age(cached.details.marketBot.lastOkAt) },
            engine: { ...cached.details.engine, lastOkAgeSec: age(cached.details.engine.lastOkAt) },
        },
    };
}
/** 순서: 1) TTL cache hit → 즉시 캐시 반환. 2) TTL miss → inFlight 있으면 await. 3) 없으면 새 fetch 시작. 중복 fetch 방지. */
app.get('/api/services-status', async (_req, res) => {
    const now = Date.now();
    if (cachedServicesStatus !== null && now - cachedServicesStatus.fetchedAt < SERVICES_STATUS_TTL_MS) {
        const out = refreshCachedServicesStatus(cachedServicesStatus.result);
        logServicesStatusDebug(out, true, false);
        return res.json(out);
    }
    if (servicesStatusInFlight !== null) {
        const result = await servicesStatusInFlight;
        const out = refreshCachedServicesStatus(result);
        logServicesStatusDebug(out, false, true);
        return res.json(out);
    }
    servicesStatusInFlight = startServicesStatusInFlight();
    try {
        const result = await servicesStatusInFlight;
        cachedServicesStatus = { result, fetchedAt: Date.now() };
        logServicesStatusDebug(result, false, false);
        return res.json(result);
    }
    finally {
        servicesStatusInFlight = null;
    }
});
app.post('/api/engine/start', async (req, res) => {
    const userId = (req.body && req.body.userId) || req.headers?.['x-user-id'] || 'api';
    const updatedBy = (req.body && req.body.updatedBy) || userId;
    const r = await proxyToMarketBot('/engine/start', { method: 'POST', body: { ...req.body, updatedBy } });
    await AuditLogService_1.AuditLogService.log({
        userId,
        command: 'engine_start',
        timestamp: new Date().toISOString(),
        success: !!(r.ok && r.data && r.data.success),
    });
    if (r.ok && r.data)
        return res.json(r.data);
    res.status(r.status || 503).json(r.data || { success: false, message: 'Engine (market-bot) unavailable' });
});
app.post('/api/engine/stop', async (req, res) => {
    const userId = (req.body && req.body.userId) || req.headers?.['x-user-id'] || 'api';
    const updatedBy = (req.body && req.body.updatedBy) || userId;
    const r = await proxyToMarketBot('/engine/stop', { method: 'POST', body: { ...req.body, updatedBy } });
    await AuditLogService_1.AuditLogService.log({
        userId,
        command: 'engine_stop',
        timestamp: new Date().toISOString(),
        success: true,
    });
    if (r.ok && r.data)
        return res.json(r.data);
    res.status(r.status || 503).json(r.data || { success: false, message: 'Engine (market-bot) unavailable' });
});
app.post('/api/sell-all', async (req, res) => {
    const userId = (req.body && req.body.userId) || req.headers?.['x-user-id'] || 'api';
    const r = await proxyToMarketBot('/sell-all', { method: 'POST', body: req.body });
    await AuditLogService_1.AuditLogService.log({
        userId,
        command: 'sell_all',
        timestamp: new Date().toISOString(),
        success: !!(r.ok && r.data && r.data.success),
    });
    if (r.ok && r.data)
        return res.json(r.data);
    res.status(r.status || 503).json(r.data || { success: false, message: 'Engine (market-bot) unavailable' });
});
// ——— Discord 역할 A/B/C 패널용: market-bot proxy (engine-standalone에 구현된 discordHandlers 호출) ———
app.post('/api/race-horse-toggle', async (_req, res) => {
    const r = await proxyToMarketBot('/race-horse-toggle', { method: 'POST' });
    if (r.ok && r.data)
        return res.json(r.data);
    res.status(r.status || 503).json(r.data || { error: 'market-bot unavailable' });
});
app.get('/api/relax-status', async (_req, res) => {
    const r = await proxyToMarketBot('/relax-status');
    if (r.ok && r.data)
        return res.json(r.data);
    res.status(r.status || 503).json(r.data || { remainingMs: 0 });
});
app.post('/api/relax', async (req, res) => {
    const r = await proxyToMarketBot('/relax', { method: 'POST', body: req.body || {} });
    if (r.ok && r.data)
        return res.json(r.data);
    res.status(r.status || 503).json(r.data || { error: 'market-bot unavailable' });
});
app.post('/api/relax-extend', async (_req, res) => {
    const r = await proxyToMarketBot('/relax-extend', { method: 'POST' });
    if (r.ok && r.data)
        return res.json(r.data);
    res.status(r.status || 503).json(r.data || { error: 'market-bot unavailable' });
});
app.get('/api/independent-scalp-status', async (_req, res) => {
    const r = await proxyToMarketBot('/independent-scalp-status');
    if (r.ok && r.data)
        return res.json(r.data);
    res.status(r.status || 503).json(r.data || { isRunning: false, remainingMs: 0 });
});
app.post('/api/independent-scalp-start', async (_req, res) => {
    const r = await proxyToMarketBot('/independent-scalp-start', { method: 'POST' });
    if (r.ok && r.data)
        return res.json(r.data);
    res.status(r.status || 503).json(r.data || { success: false });
});
app.post('/api/independent-scalp-stop', async (_req, res) => {
    const r = await proxyToMarketBot('/independent-scalp-stop', { method: 'POST' });
    if (r.ok && r.data)
        return res.json(r.data);
    res.status(r.status || 503).json(r.data || { success: false });
});
app.post('/api/independent-scalp-extend', async (_req, res) => {
    const r = await proxyToMarketBot('/independent-scalp-extend', { method: 'POST' });
    if (r.ok && r.data)
        return res.json(r.data);
    res.status(r.status || 503).json(r.data || { success: false });
});
app.get('/api/analyst/diagnose_no_trade', async (_req, res) => {
    const r = await proxyToMarketBot('/api/analyst/diagnose_no_trade');
    if (r.ok && r.data)
        return res.json(r.data);
    res.status(r.status || 503).json(r.data || { error: 'market-bot unavailable' });
});
app.get('/api/analyst/suggest_logic', async (_req, res) => {
    const r = await proxyToMarketBot('/api/analyst/suggest_logic');
    if (r.ok && r.data)
        return res.json(r.data);
    res.status(r.status || 503).json(r.data || { error: 'market-bot unavailable' });
});
app.get('/api/analyst/advisor_one_liner', async (_req, res) => {
    const r = await proxyToMarketBot('/api/analyst/advisor_one_liner');
    if (r.ok && r.data)
        return res.json(r.data);
    res.status(r.status || 503).json(r.data || { content: '' });
});
app.get('/api/analyst/daily_log_analysis', async (_req, res) => {
    const r = await proxyToMarketBot('/api/analyst/daily_log_analysis');
    if (r.ok && r.data)
        return res.json(r.data);
    res.status(r.status || 503).json(r.data || { content: '' });
});
app.get('/api/analyst/api_usage_monitor', async (_req, res) => {
    const r = await proxyToMarketBot('/api/analyst/api_usage_monitor');
    if (r.ok && r.data)
        return res.json(r.data);
    res.status(r.status || 503).json(r.data || { content: '' });
});
app.get('/api/ai_analysis', async (_req, res) => {
    const r = await proxyToMarketBot('/api/ai_analysis');
    if (r.ok && r.data)
        return res.json(r.data);
    res.status(r.status || 503).json(r.data || { content: '' });
});
app.post('/api/admin/git-pull-restart', async (_req, res) => {
    const r = await proxyToMarketBot('/admin/git-pull-restart', { method: 'POST' });
    if (r.ok && r.data)
        return res.json(r.data);
    res.status(r.status || 503).json(r.data || { error: 'market-bot unavailable' });
});
app.post('/api/admin/simple-restart', async (_req, res) => {
    const r = await proxyToMarketBot('/admin/simple-restart', { method: 'POST' });
    if (r.ok && r.data)
        return res.json(r.data);
    res.status(r.status || 503).json(r.data || { error: 'market-bot unavailable' });
});
/** 비상: stale .server.lock 제거, 프로젝트 관련 좀비 정리 (api-server에서 실행, 본인 PID는 건드리지 않음) */
app.post('/api/admin/cleanup-processes', (req, res) => {
    const userId = (req.body && req.body.userId) || req.headers?.['x-user-id'] || 'api';
    const root = process.cwd();
    const lockPath = path_1.default.join(root, '.server.lock');
    const lines = [];
    try {
        if (fs_1.default.existsSync(lockPath)) {
            try {
                const raw = fs_1.default.readFileSync(lockPath, 'utf8');
                const data = JSON.parse(raw);
                const pid = typeof data.pid === 'number' ? data.pid : parseInt(String(data.pid), 10);
                try {
                    process.kill(pid, 0);
                }
                catch (_) {
                    fs_1.default.unlinkSync(lockPath);
                    lines.push(`stale .server.lock 제거 (pid ${pid} 미존재)`);
                    LogUtil_1.LogUtil.logWarn(API_LOG_TAG, 'admin_cleanup_processes: stale lock removed', { userId, pid });
                }
            }
            catch (e) {
                fs_1.default.unlinkSync(lockPath);
                lines.push('손상된 .server.lock 제거');
                LogUtil_1.LogUtil.logWarn(API_LOG_TAG, 'admin_cleanup_processes: corrupted lock removed', { message: e.message });
            }
        }
        else {
            lines.push('.server.lock 없음');
        }
        const summary = lines.length ? lines.join('\n') : '정리할 항목 없음';
        LogUtil_1.LogUtil.logWarn(API_LOG_TAG, 'admin_cleanup_processes completed', { userId, summary });
        return res.json({ ok: true, summary });
    }
    catch (e) {
        LogUtil_1.LogUtil.logError(API_LOG_TAG, 'admin_cleanup_processes failed', { userId, message: e.message });
        return res.status(500).json({ ok: false, error: e.message });
    }
});
/** PM2 앱 이름으로 허용된 대상만 (market-bot, discord-operator). api-server 자신은 제외 */
const FORCE_KILL_APP_NAMES = ['market-bot', 'discord-operator'];
/** 비상: PM2 목록에서 market-bot, discord-operator만 taskkill (Windows). api-server는 kill하지 않음 */
app.post('/api/admin/force-kill-bot', (req, res) => {
    const userId = (req.body && req.body.userId) || req.headers?.['x-user-id'] || 'api';
    const selfPid = process.pid;
    const killed = [];
    const failed = [];
    try {
        let list = [];
        try {
            const out = (0, child_process_1.execSync)('pm2 jlist', { encoding: 'utf8', timeout: 5000 });
            const arr = JSON.parse(out || '[]');
            list = (Array.isArray(arr) ? arr : []).map((p) => ({
                pid: typeof p.pid === 'number' ? p.pid : parseInt(String(p.pid), 10),
                name: p.name || p.pm2_env?.name,
            })).filter((p) => p.pid && !Number.isNaN(p.pid));
        }
        catch (_) {
            LogUtil_1.LogUtil.logWarn(API_LOG_TAG, 'admin_force_kill_bot: pm2 jlist failed, skip', { userId });
            return res.json({ ok: true, summary: 'PM2 목록 조회 실패. 수동으로 pm2 list 후 taskkill 하세요.', killed: [] });
        }
        for (const p of list) {
            const name = (p.name || '').toString();
            if (!FORCE_KILL_APP_NAMES.includes(name))
                continue;
            if (p.pid === selfPid)
                continue;
            try {
                if (process.platform === 'win32') {
                    (0, child_process_1.execSync)(`taskkill /PID ${p.pid} /F`, { timeout: 3000 });
                }
                else {
                    process.kill(p.pid, 'SIGKILL');
                }
                killed.push(p.pid);
                LogUtil_1.LogUtil.logWarn(API_LOG_TAG, 'admin_force_kill_bot: process killed', { userId, pid: p.pid, name });
            }
            catch (e) {
                failed.push(p.pid);
                LogUtil_1.LogUtil.logWarn(API_LOG_TAG, 'admin_force_kill_bot: kill failed', { userId, pid: p.pid, name, message: e.message });
            }
        }
        const summary = killed.length
            ? `종료됨: ${killed.join(', ')}${failed.length ? ` / 실패: ${failed.join(', ')}` : ''}`
            : failed.length
                ? `실패: ${failed.join(', ')}`
                : '종료할 프로세스 없음 (market-bot, discord-operator만 대상)';
        LogUtil_1.LogUtil.logWarn(API_LOG_TAG, 'admin_force_kill_bot completed', { userId, killed, failed });
        return res.json({ ok: true, summary, killed, failed });
    }
    catch (e) {
        LogUtil_1.LogUtil.logError(API_LOG_TAG, 'admin_force_kill_bot failed', { userId, message: e.message });
        return res.status(500).json({ ok: false, error: e.message });
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
/** 콘솔 대시보드용 세그먼트 빌드 (market-bot proxy 기반). */
async function buildConsoleSegments() {
    const engineState = EngineStateService_1.EngineStateService.getState();
    const health = HealthReportService_1.HealthReportService.build('api-server', { upbitAuthOk: true, discordConnected: true });
    const circuitUpbit = CircuitBreakerService_1.CircuitBreakerService.getState('upbit');
    const circuitGemini = CircuitBreakerService_1.CircuitBreakerService.getState('gemini');
    const explainRecent = StrategyExplainService_1.StrategyExplainService.getRecent(80);
    const strategyConfigState = runtimeStrategyConfig.getState();
    const adminStatus = getAdminConfigStatus();
    const engineStatusR = await proxyToMarketBot('/engine-status');
    const engineCtrl = engineStatusR.ok && engineStatusR.data ? engineStatusR.data : { status: 'unavailable', startedAt: null, stoppedAt: null, updatedBy: '—', lastReason: '—' };
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
        const statusR = await proxyToMarketBot('/status');
        if (statusR.ok && statusR.data && statusR.data.assets) {
            const st = statusR.data;
            if (st.lastOrderAt)
                system_status.lastOrderAt = st.lastOrderAt;
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
const PORT = Number(process.env.API_SERVER_PORT || process.env.PORT) || 3100;
// ——— 포트 바인딩 재시도: process.exit 사용 금지. PM2 restart loop 방지를 위해 무한 재시도.
// 리스너: 매 시도마다 httpServer.once('error', ...) 1회만 등록. EADDRINUSE/기타 오류 시 delay 후 재시도.
const RETRY_BASE_MS = 5000;
const MAX_RETRY_DELAY = 15000;
let listenRetryCount = 0;
let listenRetryTimer = null;
function onListenSuccess() {
    listenRetryCount = 0;
    console.log('[api-server] http://localhost:' + PORT);
    const adminStatus = getAdminConfigStatus();
    const strategyState = runtimeStrategyConfig.getState();
    console.log('[startup] app=api-server port=' + PORT + ' ADMIN_ID loaded: ' + (adminStatus.adminConfigPresent ? 'Yes' : 'No') + ' runtimeMode=' + (strategyState?.mode || '—') + ' no engine (proxy to market-bot)');
    console.log('[api-server] no engine side effects confirmed');
    // 운영 관찰: 5분마다 메모리 사용량 로그 (leak 추적: 절대값 + 직전 대비 delta + 연속 증가 경고)
    const MEMORY_LOG_INTERVAL_MS = 5 * 60 * 1000;
    const MEMORY_INCREASE_WARN_THRESHOLD = 5;
    let lastMemorySnapshot = null;
    let heapIncreaseCount = 0;
    let externalIncreaseCount = 0;
    setInterval(() => {
        try {
            const mu = process.memoryUsage();
            const rssMb = Math.round(mu.rss / 1024 / 1024);
            const heapUsedMb = Math.round(mu.heapUsed / 1024 / 1024);
            const heapTotalMb = Math.round(mu.heapTotal / 1024 / 1024);
            const external = mu.external ?? 0;
            const externalMb = Math.round(external / 1024 / 1024);
            let dr = 0;
            let dh = 0;
            let de = 0;
            let rssDelta = '';
            let heapUsedDelta = '';
            let heapTotalDelta = '';
            let externalDelta = '';
            if (lastMemorySnapshot !== null) {
                dr = Math.round((mu.rss - lastMemorySnapshot.rss) / 1024 / 1024);
                dh = Math.round((mu.heapUsed - lastMemorySnapshot.heapUsed) / 1024 / 1024);
                const dt = Math.round((mu.heapTotal - lastMemorySnapshot.heapTotal) / 1024 / 1024);
                de = Math.round((external - lastMemorySnapshot.external) / 1024 / 1024);
                rssDelta = dr >= 0 ? ' +' + dr + 'MB' : ' ' + dr + 'MB';
                heapUsedDelta = dh >= 0 ? ' +' + dh + 'MB' : ' ' + dh + 'MB';
                heapTotalDelta = dt >= 0 ? ' +' + dt + 'MB' : ' ' + dt + 'MB';
                externalDelta = de >= 0 ? ' +' + de + 'MB' : ' ' + de + 'MB';
                if (dh > 0)
                    heapIncreaseCount++;
                else
                    heapIncreaseCount = 0;
                if (de > 0)
                    externalIncreaseCount++;
                else
                    externalIncreaseCount = 0;
            }
            else {
                rssDelta = heapUsedDelta = heapTotalDelta = externalDelta = ' (first)';
            }
            lastMemorySnapshot = { rss: mu.rss, heapUsed: mu.heapUsed, heapTotal: mu.heapTotal, external };
            console.log('[api-server][memory] rss=' + rssMb + 'MB' + rssDelta +
                ' heapUsed=' + heapUsedMb + 'MB' + heapUsedDelta +
                ' heapTotal=' + heapTotalMb + 'MB' + heapTotalDelta +
                ' external=' + externalMb + 'MB' + externalDelta);
            if (heapIncreaseCount >= MEMORY_INCREASE_WARN_THRESHOLD) {
                const drStr = dr >= 0 ? ' +' + dr + 'MB' : ' ' + dr + 'MB';
                const dhStr = dh >= 0 ? ' +' + dh + 'MB' : ' ' + dh + 'MB';
                const deStr = de >= 0 ? ' +' + de + 'MB' : ' ' + de + 'MB';
                console.warn('[api-server][memory][warn] heapUsed increasing continuously', 'rss=' + rssMb + 'MB' + drStr + ', heapUsed=' + heapUsedMb + 'MB' + dhStr + ', external=' + externalMb + 'MB' + deStr + ', heapIncreaseCount=' + heapIncreaseCount);
            }
            if (externalIncreaseCount >= MEMORY_INCREASE_WARN_THRESHOLD) {
                const drStr = dr >= 0 ? ' +' + dr + 'MB' : ' ' + dr + 'MB';
                const dhStr = dh >= 0 ? ' +' + dh + 'MB' : ' ' + dh + 'MB';
                const deStr = de >= 0 ? ' +' + de + 'MB' : ' ' + de + 'MB';
                console.warn('[api-server][memory][warn] external increasing continuously', 'rss=' + rssMb + 'MB' + drStr + ', heapUsed=' + heapUsedMb + 'MB' + dhStr + ', external=' + externalMb + 'MB' + deStr + ', externalIncreaseCount=' + externalIncreaseCount);
            }
        }
        catch (_) { }
    }, MEMORY_LOG_INTERVAL_MS);
}
/** 포트 바인딩 재시도. EADDRINUSE/기타 오류 시에도 process.exit 없이 delay 후 재시도하여 PM2 restart loop 방지. */
function startServer(port) {
    if (listenRetryTimer !== null)
        return;
    httpServer.once('error', (err) => {
        listenRetryCount++;
        const delay = Math.min(RETRY_BASE_MS * listenRetryCount, MAX_RETRY_DELAY) +
            Math.floor(Math.random() * 1000);
        const sec = Math.round(delay / 1000);
        if (err.code === 'EADDRINUSE') {
            console.warn('[api-server] port ' + port + ' already in use');
            console.warn('[api-server] retrying port bind retryCount=' + listenRetryCount + ' delay=' + delay + 'ms (' + sec + 's)');
        }
        else {
            console.error('[api-server] server error (will retry)', err.code || err.message);
            console.warn('[api-server] retrying port bind retryCount=' + listenRetryCount + ' delay=' + delay + 'ms (' + sec + 's)');
        }
        listenRetryTimer = setTimeout(() => {
            listenRetryTimer = null;
            startServer(port);
        }, delay);
    });
    httpServer.listen(port, onListenSuccess);
}
startServer(PORT);
