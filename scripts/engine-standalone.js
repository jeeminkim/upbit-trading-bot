/**
 * market-bot 전용: 엔진 lock + server.js + trading 루프 + HTTP API (port 3001).
 * api-server는 이 프로세스를 건드리지 않고, proxy만 함.
 */
const path = require('path');
const express = require('express');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const root = path.join(__dirname, '..');
const serverLock = require(path.join(root, 'lib', 'serverLock'));
const lockPath = path.join(root, '.server.lock');

const result = serverLock.tryAcquire(lockPath);
if (!result.acquired) {
  console.error('[market-bot] Engine lock not acquired. Another instance may be running.');
  process.exit(1);
}
console.log('[market-bot] engine lock acquired');

if (process.env.ADMIN_ID || process.env.ADMIN_DISCORD_ID) {
  console.log('[market-bot] ADMIN_ID loaded: Yes');
} else {
  console.log('[market-bot] ADMIN_ID loaded: No');
}

let server;
try {
  server = require(path.join(root, 'server.js'));
} catch (e) {
  console.error('[market-bot] server.js load failed:', e?.message || e);
  process.exit(1);
}
// 원인 분석용 로그 [market-bot][proxy] <tag> <detail>
// 태그: after_require(기동 직후) | wait_handlers(대기 시작) | handlers_not_ready(미준비) | handlers_ok(정상) | withServer_error(예외)
const PROXY_LOG = (tag, detail) => console.log('[market-bot][proxy]', tag, typeof detail === 'object' ? JSON.stringify(detail) : detail);
PROXY_LOG('after_require', {
  hasServer: !!server,
  hasInitPromise: !!(server && server.initPromise),
  hasFetchAssets: !!(server && typeof server.fetchAssets === 'function'),
  hasDiscordHandlers: !!(server && server.discordHandlers),
  serverKeys: server && typeof server === 'object' ? Object.keys(server).slice(0, 20) : [],
});
const EngineControlService = require(path.join(root, 'dist-refactor', 'packages', 'core', 'src', 'EngineControlService.js')).EngineControlService;
const runtimeStrategyConfig = require(path.join(root, 'lib', 'runtimeStrategyConfig'));

// trading-engine 구독 (ENGINE_STARTED 시 루프 시작)
require(path.join(root, 'dist-refactor', 'apps', 'trading-engine', 'src', 'index.js'));

const ENGINE_PORT = Number(process.env.ENGINE_PORT) || 3001;
const SCALP_MARKETS = ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL'];

/** server.fetchAssets가 없을 때 Upbit 직접 호출로 자산 조회 (proxy 버튼 동작 보장) */
async function fetchAssetsFallback() {
  const fs = require('fs');
  const CONFIG_PATH = process.env.CONFIG_PATH || path.join(root, 'config.json');
  const fromEnv = (key, def = '') => (process.env[key] || '').trim() || def;
  let accessKey = fromEnv('UPBIT_ACCESS_KEY', '');
  let secretKey = fromEnv('UPBIT_SECRET_KEY', '');
  if (server && server.apiKeys && (server.apiKeys.accessKey || server.apiKeys.secretKey)) {
    accessKey = server.apiKeys.accessKey || accessKey;
    secretKey = server.apiKeys.secretKey || secretKey;
  } else if (fs.existsSync(CONFIG_PATH)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      accessKey = config.access_key || accessKey;
      secretKey = config.secret_key || secretKey;
    } catch (_) {}
  }
  if (!accessKey || !secretKey) return null;
  const upbit = require(path.join(root, 'lib', 'upbit'));
  const [accounts, tickers] = await Promise.all([
    upbit.getAccounts(accessKey, secretKey),
    upbit.getTickers(SCALP_MARKETS)
  ]);
  return upbit.summarizeAccounts(accounts, tickers);
}

/** /status, /pnl 공통: server.fetchAssets 우선, 없으면 fallback 사용 */
async function getAssetsForStatus() {
  const s = server;
  if (!s) return null;
  const init = s.initPromise || s.init;
  if (init && typeof init.then === 'function') await init;
  const fn = typeof s.fetchAssets === 'function' ? s.fetchAssets : null;
  if (fn) return await fn();
  return await fetchAssetsFallback();
}

const app = express();
app.use(express.json());

app.get('/engine-status', (_req, res) => {
  const ctrl = EngineControlService.getState();
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

app.post('/engine/start', (req, res) => {
  const updatedBy = (req.body && req.body.updatedBy) || 'api';
  const r = EngineControlService.startEngine(updatedBy);
  res.json({ success: r.started, noop: r.noop, message: r.message });
});

app.post('/engine/stop', (req, res) => {
  const updatedBy = (req.body && req.body.updatedBy) || 'api';
  const r = EngineControlService.stopEngine(updatedBy);
  res.json({ success: r.stopped, noop: r.noop, message: r.message });
});

app.get('/status', async (_req, res) => {
  try {
    if (!server) return res.status(503).json({ error: 'server module not loaded' });
    const assets = await getAssetsForStatus();
    if (assets == null) return res.status(503).json({ error: 'fetchAssets not available (server not ready)', message: 'API 키(config.json 또는 .env)를 확인하세요.' });
    if (server.state) server.state.assets = assets;
    const ProfitCalculationService = require(path.join(root, 'dist-refactor', 'packages', 'core', 'src', 'ProfitCalculationService.js')).ProfitCalculationService;
    const summary = ProfitCalculationService.getSummary(assets);
    res.json({
      assets,
      profitSummary: summary,
      strategySummary: (server.state && server.state.strategySummary) || null,
      botEnabled: (server.state && server.state.botEnabled) != null ? server.state.botEnabled : null,
    });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || 'Unknown' });
  }
});

app.get('/pnl', async (_req, res) => {
  try {
    if (!server) return res.status(503).json({ error: 'server module not loaded' });
    const assets = await getAssetsForStatus();
    if (assets == null) return res.status(503).json({ error: 'fetchAssets not available (server not ready)', message: 'API 키(config.json 또는 .env)를 확인하세요.' });
    if (server.state) server.state.assets = assets;
    const summary = require(path.join(root, 'dist-refactor', 'packages', 'core', 'src', 'ProfitCalculationService.js')).ProfitCalculationService.getSummary(assets);
    res.json({ assets, profitSummary: summary });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || 'Unknown' });
  }
});

app.get('/dashboard', async (_req, res) => {
  try {
    const s = server;
    if (!s) return res.status(503).json({ error: 'server module not loaded' });
    const init = s.initPromise || s.init;
    if (init && typeof init.then === 'function') await init;
    const state = require(path.join(root, 'dist-refactor', 'packages', 'core', 'src', 'EngineStateService.js')).EngineStateService.getState();
    const summary = require(path.join(root, 'dist-refactor', 'packages', 'core', 'src', 'ProfitCalculationService.js')).ProfitCalculationService.getSummary(state.assets || []);
    res.json({
      assets: state.assets,
      profitSummary: summary,
      botEnabled: state.botEnabled,
      lastOrderAt: state.lastOrderAt,
    });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || 'Unknown' });
  }
});

app.post('/sell-all', async (req, res) => {
  try {
    const s = server;
    const init = s && (s.initPromise || s.init);
    if (init && typeof init.then === 'function') await init;
    if (!s || !s.discordHandlers) return res.status(503).json({ error: 'discordHandlers not ready', message: 'market-bot이 서버 초기화 중입니다. 1~2분 후 다시 시도하세요.' });
    const result = await s.discordHandlers.sellAll();
    const ok = typeof result === 'string';
    res.json(ok ? { success: true, message: result } : { success: false, message: String(result || 'Unknown') });
  } catch (e) {
    res.status(500).json({ success: false, message: (e && e.message) || 'Unknown' });
  }
});

// ——— Discord 패널 복구: 역할 A/B/C 버튼용 proxy (discordHandlers 호출) ———
const PROXY_NOT_READY_MSG = 'market-bot이 서버 초기화 중입니다. 1~2분 후 다시 시도하세요.';
// initPromise 완료 후 discordHandlers가 IIFE 내부에서 설정되므로 요청 시 최대 15초 대기
async function waitForDiscordHandlers(maxMs) {
  const step = 400;
  const deadline = Date.now() + (maxMs || 15000);
  while (Date.now() < deadline) {
    const h = server && server.discordHandlers;
    if (h) return h;
    await new Promise((r) => setTimeout(r, step));
  }
  return server && server.discordHandlers;
}

function withServer(fn) {
  return async (req, res) => {
    const path = req.path || req.url || '';
    const t0 = Date.now();
    try {
      const init = server && (server.initPromise || server.init);
      const hadInit = !!(init && typeof init.then === 'function');
      if (hadInit) await init;
      let h = server && server.discordHandlers;
      const waitedMs = hadInit ? Date.now() - t0 : 0;
      if (!h) {
        PROXY_LOG('wait_handlers', { path, hadInit, waitedMs });
        h = await waitForDiscordHandlers(5000);
      }
      const totalMs = Date.now() - t0;
      if (!h) {
        PROXY_LOG('handlers_not_ready', { path, totalMs, hasServer: !!server, hasInitPromise: !!(server && server.initPromise) });
        // 무조건 응답: 200 + 안내 메시지 (오류 대신 안내로 표시)
        return res.status(200).json({
          content: PROXY_NOT_READY_MSG,
          description: PROXY_NOT_READY_MSG,
          title: '준비 중',
          _proxyNotReady: true,
        });
      }
      PROXY_LOG('handlers_ok', { path, totalMs });
      return await fn(req, res, h);
    } catch (e) {
      PROXY_LOG('withServer_error', { path, error: (e && e.message) || String(e) });
      res.status(500).json({ error: (e && e.message) || 'Unknown' });
    }
  };
}

app.post('/race-horse-toggle', withServer(async (_req, res, h) => {
  const result = await h.toggleRaceHorse();
  const active = result && result.active === true;
  res.json({ active, message: active ? '경주마 모드 예약됨' : '경주마 모드 OFF' });
}));

app.get('/relax-status', withServer((_req, res, h) => {
  const status = h.getRelaxedStatus && h.getRelaxedStatus();
  res.json(status || { remainingMs: 0 });
}));
app.post('/relax', withServer((req, res, h) => {
  const ttlMs = req.body && req.body.ttlMs ? Number(req.body.ttlMs) : 4 * 60 * 60 * 1000;
  if (h.setRelaxedMode) h.setRelaxedMode(ttlMs);
  res.json({ ok: true, message: '기준 완화 적용됨' });
}));
app.post('/relax-extend', withServer((_req, res, h) => {
  if (h.extendRelaxMode) h.extendRelaxMode();
  res.json({ ok: true, message: '기준 완화 연장됨' });
}));

app.get('/independent-scalp-status', withServer((_req, res, h) => {
  const status = h.getIndependentScalpStatus && h.getIndependentScalpStatus();
  res.json(status || { isRunning: false, remainingMs: 0 });
}));
app.post('/independent-scalp-start', withServer((_req, res, h) => {
  const result = h.setIndependentScalpActivate ? h.setIndependentScalpActivate('SUPER_AGGRESSIVE') : { success: false };
  res.json(result || { success: false });
}));
app.post('/independent-scalp-stop', withServer((_req, res, h) => {
  if (h.setIndependentScalpStop) h.setIndependentScalpStop();
  res.json({ success: true });
}));
app.post('/independent-scalp-extend', withServer((_req, res, h) => {
  const result = h.extendIndependentScalp ? h.extendIndependentScalp() : { success: false };
  res.json(result || { success: false });
}));

app.get('/api/analyst/diagnose_no_trade', withServer(async (_req, res, h) => {
  if (!h.analyst || !h.analyst.diagnoseNoTrade) return res.status(404).json({ error: 'not implemented' });
  const embed = await h.analyst.diagnoseNoTrade();
  res.json(embed && typeof embed.toJSON === 'function' ? embed.toJSON() : embed);
}));
app.get('/api/analyst/suggest_logic', withServer(async (_req, res, h) => {
  if (!h.analyst || !h.analyst.suggestLogic) return res.status(404).json({ error: 'not implemented' });
  const embed = await h.analyst.suggestLogic();
  res.json(embed && typeof embed.toJSON === 'function' ? embed.toJSON() : embed);
}));
app.get('/api/analyst/advisor_one_liner', withServer(async (_req, res, h) => {
  if (!h.analyst || !h.analyst.advisorOneLiner) return res.status(404).json({ error: 'not implemented' });
  const result = await h.analyst.advisorOneLiner();
  res.json(result && typeof result.content === 'string' ? { content: result.content } : { content: String(result || '') });
}));
app.get('/api/analyst/daily_log_analysis', withServer(async (_req, res, h) => {
  if (!h.analyst || !h.analyst.dailyLogAnalysis) return res.status(404).json({ error: 'not implemented' });
  const result = await h.analyst.dailyLogAnalysis();
  res.json(result && typeof result.content === 'string' ? { content: result.content } : { content: String(result || '') });
}));
app.get('/api/analyst/api_usage_monitor', withServer(async (_req, res, h) => {
  if (!h.getApiUsageMonitor) return res.status(404).json({ error: 'not implemented' });
  const result = await h.getApiUsageMonitor();
  const content = typeof result === 'string' ? result : (result && result.content) || JSON.stringify(result || {});
  res.json({ content });
}));
app.get('/api/ai_analysis', withServer(async (_req, res, h) => {
  if (!h.aiAutoAnalysis) return res.status(404).json({ error: 'not implemented' });
  const raw = await h.aiAutoAnalysis();
  const content = typeof raw === 'string' ? raw : (raw && raw.content) || (raw && raw.message) || JSON.stringify(raw || '');
  res.json({ content });
}));

app.post('/admin/git-pull-restart', withServer(async (_req, res, h) => {
  if (!h.adminGitPullRestart) return res.status(404).json({ error: 'not implemented' });
  const result = await h.adminGitPullRestart();
  const content = result && result.content ? result.content : '요청 처리됨';
  res.json({ ok: true, content });
}));
app.post('/admin/simple-restart', withServer(async (_req, res, h) => {
  if (!h.adminSimpleRestart) return res.status(404).json({ error: 'not implemented' });
  const result = await h.adminSimpleRestart();
  const content = result && result.content ? result.content : '재기동 예약됨';
  res.json({ ok: true, content });
}));

// 즉시 listen → api-server가 "fetch failed" 없이 연결 가능. /status·/pnl은 fallback, analyst는 withServer에서 대기 후 503 또는 정상 응답
app.listen(ENGINE_PORT, () => {
  console.log('[market-bot] engine API http://localhost:' + ENGINE_PORT);
});

const init = server && (server.initPromise || server.init);
if (init && typeof init.then === 'function') {
  init.then(() => {
    console.log('[market-bot] server ready. Engine remains STOPPED until Discord [엔진 가동] is used.');
  }).catch((e) => {
    console.error('[market-bot] server init failed:', e && e.message);
  });
} else {
  console.warn('[market-bot] server.initPromise not available.');
}
