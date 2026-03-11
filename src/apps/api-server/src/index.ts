import path from 'path';
require('dotenv').config({ path: path.join(process.cwd(), '.env') });
const runtimeStrategyConfig = require(path.join(process.cwd(), 'lib', 'runtimeStrategyConfig'));
import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { EngineStateService } from '../../../packages/core/src/EngineStateService';
import { EngineControlService } from '../../../packages/core/src/EngineControlService';
import { ProfitCalculationService } from '../../../packages/core/src/ProfitCalculationService';
import { EventBus } from '../../../packages/core/src/EventBus';
import { HealthReportService } from '../../../packages/core/src/HealthReportService';
import { MarketSnapshotService } from '../../../packages/core/src/MarketSnapshotService';
import { GeminiAnalysisService } from '../../../packages/core/src/GeminiAnalysisService';
import { CircuitBreakerService } from '../../../packages/core/src/CircuitBreakerService';
import { AuditLogService } from '../../../packages/core/src/AuditLogService';
import { StrategyExplainService } from '../../../packages/core/src/StrategyExplainService';
import { AppErrorCode } from '../../../packages/shared/src/errors';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const MARKET_BOT_URL = (process.env.MARKET_BOT_URL || 'http://localhost:3001').replace(/\/$/, '');

async function proxyToMarketBot(path: string, opts?: { method?: string; body?: any }): Promise<{ ok: boolean; data?: any; status?: number }> {
  try {
    const res = await fetch(MARKET_BOT_URL + path, {
      method: opts?.method || 'GET',
      headers: opts?.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data, status: res.status };
  } catch (e) {
    return { ok: false, data: { error: (e as Error).message }, status: 503 };
  }
}

app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

function getAdminConfigStatus(): { adminConfigPresent: boolean; adminConfigWarning: string | null } {
  const present = !!(
    (process.env.ADMIN_ID || '').trim() ||
    (process.env.ADMIN_DISCORD_ID || '').trim() ||
    (process.env.DISCORD_ADMIN_ID || '').trim() ||
    (process.env.SUPER_ADMIN_ID || '').trim()
  );
  return {
    adminConfigPresent: present,
    adminConfigWarning: present ? null : 'ADMIN_ID or ADMIN_DISCORD_ID is not set. Strategy mode change via Discord may not work for admin-only operations.',
  };
}

app.get('/api/health', (_req: Request, res: Response) => {
  const report = HealthReportService.build('api-server', { upbitAuthOk: true, discordConnected: true });
  const admin = getAdminConfigStatus();
  res.json({ ...report, adminConfigPresent: admin.adminConfigPresent, adminConfigWarning: admin.adminConfigWarning });
});

app.get('/api/dashboard', async (_req: Request, res: Response) => {
  const r = await proxyToMarketBot('/dashboard');
  if (r.ok && r.data) return res.json(r.data);
  res.status(r.status || 503).json(r.data || { error: 'Engine (market-bot) unavailable' });
});

app.get('/api/status', async (_req: Request, res: Response) => {
  const r = await proxyToMarketBot('/status');
  if (r.ok && r.data) return res.json(r.data);
  res.status(r.status || 503).json(r.data || { error: 'Engine (market-bot) unavailable' });
});

app.get('/api/pnl', async (_req: Request, res: Response) => {
  const r = await proxyToMarketBot('/pnl');
  if (r.ok && r.data) return res.json(r.data);
  res.status(r.status || 503).json(r.data || { error: 'Engine (market-bot) unavailable' });
});

app.get('/api/engine-status', async (_req: Request, res: Response) => {
  const r = await proxyToMarketBot('/engine-status');
  if (r.ok && r.data) return res.json(r.data);
  res.status(r.status || 503).json(r.data || { status: 'unavailable', error: 'Engine (market-bot) unavailable' });
});

app.post('/api/engine/start', async (req: Request, res: Response) => {
  const userId = (req.body && req.body.userId) || (req.headers?.['x-user-id'] as string) || 'api';
  const updatedBy = (req.body && req.body.updatedBy) || userId;
  const r = await proxyToMarketBot('/engine/start', { method: 'POST', body: { ...req.body, updatedBy } });
  await AuditLogService.log({
    userId,
    command: 'engine_start',
    timestamp: new Date().toISOString(),
    success: !!(r.ok && r.data && r.data.success),
  });
  if (r.ok && r.data) return res.json(r.data);
  res.status(r.status || 503).json(r.data || { success: false, message: 'Engine (market-bot) unavailable' });
});

app.post('/api/engine/stop', async (req: Request, res: Response) => {
  const userId = (req.body && req.body.userId) || (req.headers?.['x-user-id'] as string) || 'api';
  const updatedBy = (req.body && req.body.updatedBy) || userId;
  const r = await proxyToMarketBot('/engine/stop', { method: 'POST', body: { ...req.body, updatedBy } });
  await AuditLogService.log({
    userId,
    command: 'engine_stop',
    timestamp: new Date().toISOString(),
    success: true,
  });
  if (r.ok && r.data) return res.json(r.data);
  res.status(r.status || 503).json(r.data || { success: false, message: 'Engine (market-bot) unavailable' });
});

app.post('/api/sell-all', async (req: Request, res: Response) => {
  const userId = (req.body && req.body.userId) || (req.headers?.['x-user-id'] as string) || 'api';
  const r = await proxyToMarketBot('/sell-all', { method: 'POST', body: req.body });
  await AuditLogService.log({
    userId,
    command: 'sell_all',
    timestamp: new Date().toISOString(),
    success: !!(r.ok && r.data && r.data.success),
  });
  if (r.ok && r.data) return res.json(r.data);
  res.status(r.status || 503).json(r.data || { success: false, message: 'Engine (market-bot) unavailable' });
});

// ——— Discord 역할 A/B/C 패널용: market-bot proxy (engine-standalone에 구현된 discordHandlers 호출) ———
app.post('/api/race-horse-toggle', async (_req: Request, res: Response) => {
  const r = await proxyToMarketBot('/race-horse-toggle', { method: 'POST' });
  if (r.ok && r.data) return res.json(r.data);
  res.status(r.status || 503).json(r.data || { error: 'market-bot unavailable' });
});
app.get('/api/relax-status', async (_req: Request, res: Response) => {
  const r = await proxyToMarketBot('/relax-status');
  if (r.ok && r.data) return res.json(r.data);
  res.status(r.status || 503).json(r.data || { remainingMs: 0 });
});
app.post('/api/relax', async (req: Request, res: Response) => {
  const r = await proxyToMarketBot('/relax', { method: 'POST', body: req.body || {} });
  if (r.ok && r.data) return res.json(r.data);
  res.status(r.status || 503).json(r.data || { error: 'market-bot unavailable' });
});
app.post('/api/relax-extend', async (_req: Request, res: Response) => {
  const r = await proxyToMarketBot('/relax-extend', { method: 'POST' });
  if (r.ok && r.data) return res.json(r.data);
  res.status(r.status || 503).json(r.data || { error: 'market-bot unavailable' });
});
app.get('/api/independent-scalp-status', async (_req: Request, res: Response) => {
  const r = await proxyToMarketBot('/independent-scalp-status');
  if (r.ok && r.data) return res.json(r.data);
  res.status(r.status || 503).json(r.data || { isRunning: false, remainingMs: 0 });
});
app.post('/api/independent-scalp-start', async (_req: Request, res: Response) => {
  const r = await proxyToMarketBot('/independent-scalp-start', { method: 'POST' });
  if (r.ok && r.data) return res.json(r.data);
  res.status(r.status || 503).json(r.data || { success: false });
});
app.post('/api/independent-scalp-stop', async (_req: Request, res: Response) => {
  const r = await proxyToMarketBot('/independent-scalp-stop', { method: 'POST' });
  if (r.ok && r.data) return res.json(r.data);
  res.status(r.status || 503).json(r.data || { success: false });
});
app.post('/api/independent-scalp-extend', async (_req: Request, res: Response) => {
  const r = await proxyToMarketBot('/independent-scalp-extend', { method: 'POST' });
  if (r.ok && r.data) return res.json(r.data);
  res.status(r.status || 503).json(r.data || { success: false });
});
app.get('/api/analyst/diagnose_no_trade', async (_req: Request, res: Response) => {
  const r = await proxyToMarketBot('/api/analyst/diagnose_no_trade');
  if (r.ok && r.data) return res.json(r.data);
  res.status(r.status || 503).json(r.data || { error: 'market-bot unavailable' });
});
app.get('/api/analyst/suggest_logic', async (_req: Request, res: Response) => {
  const r = await proxyToMarketBot('/api/analyst/suggest_logic');
  if (r.ok && r.data) return res.json(r.data);
  res.status(r.status || 503).json(r.data || { error: 'market-bot unavailable' });
});
app.get('/api/analyst/advisor_one_liner', async (_req: Request, res: Response) => {
  const r = await proxyToMarketBot('/api/analyst/advisor_one_liner');
  if (r.ok && r.data) return res.json(r.data);
  res.status(r.status || 503).json(r.data || { content: '' });
});
app.get('/api/analyst/daily_log_analysis', async (_req: Request, res: Response) => {
  const r = await proxyToMarketBot('/api/analyst/daily_log_analysis');
  if (r.ok && r.data) return res.json(r.data);
  res.status(r.status || 503).json(r.data || { content: '' });
});
app.get('/api/analyst/api_usage_monitor', async (_req: Request, res: Response) => {
  const r = await proxyToMarketBot('/api/analyst/api_usage_monitor');
  if (r.ok && r.data) return res.json(r.data);
  res.status(r.status || 503).json(r.data || { content: '' });
});
app.get('/api/ai_analysis', async (_req: Request, res: Response) => {
  const r = await proxyToMarketBot('/api/ai_analysis');
  if (r.ok && r.data) return res.json(r.data);
  res.status(r.status || 503).json(r.data || { content: '' });
});
app.post('/api/admin/git-pull-restart', async (_req: Request, res: Response) => {
  const r = await proxyToMarketBot('/admin/git-pull-restart', { method: 'POST' });
  if (r.ok && r.data) return res.json(r.data);
  res.status(r.status || 503).json(r.data || { error: 'market-bot unavailable' });
});
app.post('/api/admin/simple-restart', async (_req: Request, res: Response) => {
  const r = await proxyToMarketBot('/admin/simple-restart', { method: 'POST' });
  if (r.ok && r.data) return res.json(r.data);
  res.status(r.status || 503).json(r.data || { error: 'market-bot unavailable' });
});

app.get('/api/strategy-config', (_req: Request, res: Response) => {
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
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.post('/api/strategy-mode', async (req: Request, res: Response) => {
  const userId = (req.body && req.body.userId) || (req.headers?.['x-user-id'] as string) || 'api';
  const updatedBy = (req.body && req.body.updatedBy) || (req.get?.('x-updated-by') as string) || 'dashboard';
  const mode = (req.body && req.body.mode) as string;
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
    EventBus.emit('STRATEGY_MODE_CHANGED', payload);
    EventBus.emit('STRATEGY_THRESHOLD_UPDATED', payload);
    await AuditLogService.log({
      userId,
      command: 'strategy_mode_change',
      timestamp: new Date().toISOString(),
      success: true,
    });
    res.json({ ok: true, mode: payload.mode, profile: payload.profile, thresholdEntry: payload.thresholdEntry, minOrchestratorScore: payload.minOrchestratorScore, updatedBy: payload.updatedBy, updatedAt: payload.updatedAt });
  } catch (e) {
    await AuditLogService.log({
      userId,
      command: 'strategy_mode_change',
      timestamp: new Date().toISOString(),
      success: false,
      errorCode: (e as Error).message,
    });
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

const ANALYST_TIMEOUT_MS = 25000;

function withAnalystTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('ANALYSIS_TIMEOUT')), ANALYST_TIMEOUT_MS)
    ),
  ]);
}

app.get('/api/analyst/scan-vol', async (_req: Request, res: Response) => {
  try {
    const enriched = await withAnalystTimeout(
      CircuitBreakerService.execute('upbit', () => MarketSnapshotService.getEnrichedTopN(10))
    );
    const payload = enriched.map((e) => ({
      symbol: e.symbol,
      price: e.price,
      rsi: e.rsi,
      strength: e.strength,
      volumeChange: e.volumeChange,
    }));
    const result = await withAnalystTimeout(
      CircuitBreakerService.execute('gemini', () => GeminiAnalysisService.scanVolAnalysis(payload))
    );
    if (result.ok) {
      return res.json({ ok: true, data: { text: result.data }, meta: { cachedAt: Date.now() } });
    }
    return res.status(503).json({
      ok: false,
      error: result.error?.code || AppErrorCode.GEMINI_UNAVAILABLE,
      message: result.error?.message,
    });
  } catch (_e) {
    return res.status(500).json({ ok: false, error: 'ANALYSIS_FAILED' });
  }
});

app.get('/api/analyst/summary', async (_req: Request, res: Response) => {
  try {
    const indicators = await withAnalystTimeout(MarketSnapshotService.getMarketIndicators());
    const ctx = {
      fng: indicators.fng
        ? `공포·탐욕 지수: ${indicators.fng.value} (${indicators.fng.classification})`
        : '공포·탐욕: —',
      btcTrend: indicators.btcTrend,
      topTickers: indicators.topTickersText,
      kimp: indicators.kimpAvg != null ? `김치 프리미엄(평균): ${indicators.kimpAvg.toFixed(2)}%` : '김프: —',
    };
    const result = await withAnalystTimeout(
      CircuitBreakerService.execute('gemini', () => GeminiAnalysisService.marketSummaryAnalysis(ctx))
    );
    if (result.ok) {
      return res.json({ ok: true, data: { text: result.data } });
    }
    return res.status(503).json({
      ok: false,
      error: result.error?.code || AppErrorCode.GEMINI_UNAVAILABLE,
      message: result.error?.message,
    });
  } catch (_e) {
    return res.status(500).json({ ok: false, error: 'ANALYSIS_FAILED' });
  }
});

app.get('/api/analyst/indicators', async (_req: Request, res: Response) => {
  try {
    const indicators = await withAnalystTimeout(MarketSnapshotService.getMarketIndicators());
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
  } catch (_e) {
    return res.status(500).json({ ok: false, error: 'ANALYSIS_FAILED' });
  }
});

app.get('/api/analyst/scalp-point', async (_req: Request, res: Response) => {
  try {
    const enriched = await withAnalystTimeout(
      CircuitBreakerService.execute('upbit', () => MarketSnapshotService.getEnrichedTopN(5))
    );
    const dataText = MarketSnapshotService.getScalpPointDataLines(enriched);
    const result = await withAnalystTimeout(
      CircuitBreakerService.execute('gemini', () => GeminiAnalysisService.scalpPointAnalysis(dataText))
    );
    if (result.ok) {
      return res.json({ ok: true, data: { text: result.data } });
    }
    return res.status(503).json({
      ok: false,
      error: result.error?.code || AppErrorCode.GEMINI_UNAVAILABLE,
      message: result.error?.message,
    });
  } catch (_e) {
    return res.status(500).json({ ok: false, error: 'ANALYSIS_FAILED' });
  }
});

app.get('/api/strategy-status', async (_req: Request, res: Response) => {
  try {
    const state = runtimeStrategyConfig.getState();
    const explainRecent = StrategyExplainService.getRecent(100);
    const now = Date.now();
    const thirtyMinAgo = now - 30 * 60 * 1000;
    const parseTs = (e: any) => {
      const t = e?.timestamp;
      if (!t) return 0;
      return typeof t === 'string' ? new Date(t).getTime() : t;
    };
    const recent = explainRecent.filter((e) => parseTs(e) >= thirtyMinAgo);
    const trades = recent.filter((e) => (e.action ?? e.decision) === 'BUY');
    const skips = recent.filter((e) => (e.action ?? e.decision) === 'SKIP');
    const skipReasons: Record<string, number> = {};
    skips.forEach((e) => {
      const r = (e as any).skip_reason || 'unknown';
      skipReasons[r] = (skipReasons[r] || 0) + 1;
    });
    const skipTop5 = Object.entries(skipReasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => ({ reason, count }));
    const buyRecent5 = trades.slice(0, 5).map((e) => ({
      symbol: (e as any).symbol ?? e.coin,
      time: (e as any).timestamp,
      finalScore: (e as any).final_orchestrator_score,
      reason: (e as any).reason_summary ?? e.reason,
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
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get('/api/strategy-explain-recent', async (_req: Request, res: Response) => {
  try {
    const explainRecent = StrategyExplainService.getRecent(10);
    const decisions = explainRecent.map((e) => ({
      symbol: (e as any).symbol ?? e.coin,
      source_strategy: (e as any).source_strategy,
      action: (e as any).action ?? e.decision,
      raw_entry_score: (e as any).raw_entry_score,
      normalized_score: (e as any).normalized_score,
      final_orchestrator_score: (e as any).final_orchestrator_score,
      threshold_entry: (e as any).threshold_entry,
      skip_reason: (e as any).skip_reason,
      reason_summary: (e as any).reason_summary ?? e.reason,
      timestamp: (e as any).timestamp,
    }));
    res.json({ ok: true, decisions });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** 콘솔 대시보드용 세그먼트 빌드 (market-bot proxy 기반). */
async function buildConsoleSegments(): Promise<{
  system_status: any;
  market_state: any;
  strategy_signals: any;
  positions: any;
  execution_log: any;
  risk_monitor: any;
  circuit_breaker: any;
  strategy_config: any;
}> {
  const engineState = EngineStateService.getState();
  const health = HealthReportService.build('api-server', { upbitAuthOk: true, discordConnected: true });
  const circuitUpbit = CircuitBreakerService.getState('upbit');
  const circuitGemini = CircuitBreakerService.getState('gemini');
  const explainRecent = StrategyExplainService.getRecent(80);
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
    latencyMs: null as number | null,
    circuitBreaker: circuitUpbit === 'CLOSED' && circuitGemini === 'CLOSED' ? 'normal' : `${circuitUpbit}/${circuitGemini}`,
    uptimeSec: health.uptimeSec,
    lastOrderAt: engineState.lastOrderAt,
    adminConfigPresent: adminStatus.adminConfigPresent,
    adminConfigWarning: adminStatus.adminConfigWarning,
  };

  const market_state = {
    mode: '—',
    volatility: '—',
    spreadBps: null as number | null,
    liquidity: '—',
    regime: '—',
  };

  const strategy_signals = [] as { coin: string; signalType: string; edgeBps: number | null; rotationCandidate: boolean }[];
  const positions = [] as { coin: string; size: number; entryPrice: number; pnl: number; pnlPct: number; holdTimeMin: number }[];
  const execution_log = explainRecent.map((e) => ({
    time: e.timestamp,
    coin: e.coin ?? e.symbol,
    action: e.action ?? e.decision,
    price: (e.meta as any)?.price ?? null,
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

  const profitSummary = ProfitCalculationService.getSummary(engineState.assets);
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
  const parseTs = (e: any) => {
    const t = e?.timestamp;
    if (!t) return 0;
    return typeof t === 'string' ? new Date(t).getTime() : t;
  };
  const recentExplain = explainRecent.filter((e) => parseTs(e) >= thirtyMinAgo);
  const skipReasons30m: Record<string, number> = {};
  recentExplain.forEach((e) => {
    const a = (e as any).action ?? (e as any).decision;
    if (a === 'SKIP') {
      const r = (e as any).skip_reason || 'unknown';
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
    tradeCountLast30m: recentExplain.filter((e) => ((e as any).action ?? (e as any).decision) === 'BUY').length,
    decisionCountLast30m: recentExplain.length,
    skipReasonDistribution: skipReasons30m,
  };

  try {
    const statusR = await proxyToMarketBot('/status');
    if (statusR.ok && statusR.data && statusR.data.assets) {
      const st = statusR.data;
      if (st.lastOrderAt) system_status.lastOrderAt = st.lastOrderAt;
    }
  } catch (_) {}

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

function emitConsoleToAll(): void {
  buildConsoleSegments().then((segments) => {
    io.emit('console:system_status', segments.system_status);
    io.emit('console:market_state', segments.market_state);
    io.emit('console:strategy_signals', segments.strategy_signals);
    io.emit('console:positions', segments.positions);
    io.emit('console:execution_log', segments.execution_log);
    io.emit('console:risk_monitor', segments.risk_monitor);
    io.emit('console:circuit_breaker', segments.circuit_breaker);
    io.emit('console:strategy_config', segments.strategy_config);
  }).catch(() => {});
}

io.on('connection', (socket) => {
  const state = EngineStateService.getState();
  const summary = ProfitCalculationService.getSummary(state.assets);
  socket.emit('dashboard', {
    assets: state.assets,
    profitSummary: summary,
    botEnabled: state.botEnabled,
    lastOrderAt: state.lastOrderAt,
  });
  emitConsoleToAll();
});

StrategyExplainService.subscribeToEventBus();

// FIX: DASHBOARD_EMIT은 socket.io / web dashboard 전용.
EventBus.subscribe('DASHBOARD_EMIT', (payload: { lastEmit: any }) => {
  io.emit('dashboard', payload.lastEmit);
  emitConsoleToAll();
});

const PORT = Number(process.env.PORT) || 3000;

httpServer.on('error', (err: NodeJS.ErrnoException) => {
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
  console.log('[startup] app=api-server port=' + PORT + ' ADMIN_ID loaded: ' + (adminStatus.adminConfigPresent ? 'Yes' : 'No') + ' runtimeMode=' + (strategyState?.mode || '—') + ' no engine (proxy to market-bot)');
  console.log('[api-server] no engine side effects confirmed');
});

export { app, io, httpServer };
