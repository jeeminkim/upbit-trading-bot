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
const EngineControlService = require(path.join(root, 'dist-refactor', 'packages', 'core', 'src', 'EngineControlService.js')).EngineControlService;
const runtimeStrategyConfig = require(path.join(root, 'lib', 'runtimeStrategyConfig'));

// trading-engine 구독 (ENGINE_STARTED 시 루프 시작)
require(path.join(root, 'dist-refactor', 'apps', 'trading-engine', 'src', 'index.js'));

const ENGINE_PORT = Number(process.env.ENGINE_PORT) || 3001;
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
    const s = server;
    await s.initPromise;
    s.state.assets = await s.fetchAssets();
    const assets = s.state.assets;
    const ProfitCalculationService = require(path.join(root, 'dist-refactor', 'packages', 'core', 'src', 'ProfitCalculationService.js')).ProfitCalculationService;
    const summary = ProfitCalculationService.getSummary(assets);
    res.json({
      assets,
      profitSummary: summary,
      strategySummary: s.state.strategySummary || null,
      botEnabled: s.state.botEnabled,
    });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || 'Unknown' });
  }
});

app.get('/pnl', async (_req, res) => {
  try {
    const s = server;
    await s.initPromise;
    s.state.assets = await s.fetchAssets();
    const summary = require(path.join(root, 'dist-refactor', 'packages', 'core', 'src', 'ProfitCalculationService.js')).ProfitCalculationService.getSummary(s.state.assets);
    res.json({ assets: s.state.assets, profitSummary: summary });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || 'Unknown' });
  }
});

app.get('/dashboard', async (_req, res) => {
  try {
    const s = server;
    await s.initPromise;
    const state = require(path.join(root, 'dist-refactor', 'packages', 'core', 'src', 'EngineStateService.js')).EngineStateService.getState();
    const summary = require(path.join(root, 'dist-refactor', 'packages', 'core', 'src', 'ProfitCalculationService.js')).ProfitCalculationService.getSummary(state.assets);
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
    await s.initPromise;
    const result = await s.discordHandlers.sellAll();
    const ok = typeof result === 'string';
    res.json(ok ? { success: true, message: result } : { success: false, message: String(result || 'Unknown') });
  } catch (e) {
    res.status(500).json({ success: false, message: (e && e.message) || 'Unknown' });
  }
});

// ——— Discord 패널 복구: 역할 A/B/C 버튼용 proxy (discordHandlers 호출) ———
function withServer(fn) {
  return async (req, res) => {
    try {
      const init = server && (server.initPromise || server.init);
      if (init && typeof init.then === 'function') await init;
      const h = server && server.discordHandlers;
      if (!h) return res.status(503).json({ error: 'discordHandlers not ready' });
      return await fn(req, res, h);
    } catch (e) {
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

const initPromise = server && (server.initPromise || server.init);
if (initPromise && typeof initPromise.then === 'function') {
  initPromise.then(() => {
    EngineControlService.startEngine('system');
    console.log('[market-bot] trading loop started (ENGINE_STARTED)');
  }).catch((e) => {
    console.error('[market-bot] server init failed:', e && e.message);
  });
} else {
  console.warn('[market-bot] server.initPromise not available, starting engine without wait');
  EngineControlService.startEngine('system');
}

app.listen(ENGINE_PORT, () => {
  console.log('[market-bot] engine API http://localhost:' + ENGINE_PORT);
});
