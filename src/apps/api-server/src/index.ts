import path from 'path';
require('dotenv').config({ path: path.join(process.cwd(), '.env') });
import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { EngineStateService } from '../../../packages/core/src/EngineStateService';
import { ProfitCalculationService } from '../../../packages/core/src/ProfitCalculationService';
import { EventBus } from '../../../packages/core/src/EventBus';
import { HealthReportService } from '../../../packages/core/src/HealthReportService';
import { MarketSnapshotService } from '../../../packages/core/src/MarketSnapshotService';
import { GeminiAnalysisService } from '../../../packages/core/src/GeminiAnalysisService';
import { CircuitBreakerService } from '../../../packages/core/src/CircuitBreakerService';
import { AuditLogService } from '../../../packages/core/src/AuditLogService';
import { AppErrorCode } from '../../../packages/shared/src/errors';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const serverPath = path.join(process.cwd(), 'server.js');
let serverModule: any = null;

async function getServer(): Promise<any> {
  if (!serverModule) {
    serverModule = require(serverPath);
    await serverModule.initPromise;
  }
  return serverModule;
}

app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

app.get('/api/health', (_req: Request, res: Response) => {
  const report = HealthReportService.build('api-server', { upbitAuthOk: true, discordConnected: true });
  res.json(report);
});

app.get('/api/dashboard', (_req: Request, res: Response) => {
  const state = EngineStateService.getState();
  const summary = ProfitCalculationService.getSummary(state.assets);
  res.json({
    assets: state.assets,
    profitSummary: summary,
    botEnabled: state.botEnabled,
    lastOrderAt: state.lastOrderAt,
  });
});

app.get('/api/status', async (_req: Request, res: Response) => {
  try {
    const s = await getServer();
    s.state.assets = await s.fetchAssets();
    const assets = s.state.assets;
    const summary = ProfitCalculationService.getSummary(assets);
    res.json({
      assets,
      profitSummary: summary,
      strategySummary: s.state.strategySummary || null,
      botEnabled: s.state.botEnabled,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get('/api/pnl', async (_req: Request, res: Response) => {
  try {
    const s = await getServer();
    s.state.assets = await s.fetchAssets();
    const assets = s.state.assets;
    const summary = ProfitCalculationService.getSummary(assets);
    res.json({ assets, profitSummary: summary });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.post('/api/engine/start', async (req: Request, res: Response) => {
  const userId = (req.body && req.body.userId) || (req.headers?.['x-user-id'] as string) || 'api';
  try {
    const s = await getServer();
    const result = await s.discordHandlers.engineStart();
    if (result && result.success) EngineStateService.setBotEnabled(true);
    await AuditLogService.log({
      userId,
      command: 'engine_start',
      timestamp: new Date().toISOString(),
      success: !!(result && result.success),
    });
    res.json(result || { success: false, message: 'Unknown' });
  } catch (e) {
    await AuditLogService.log({
      userId,
      command: 'engine_start',
      timestamp: new Date().toISOString(),
      success: false,
      errorCode: (e as Error).message,
    });
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

app.post('/api/engine/stop', async (req: Request, res: Response) => {
  const userId = (req.body && req.body.userId) || (req.headers?.['x-user-id'] as string) || 'api';
  try {
    const s = await getServer();
    s.discordHandlers.engineStop();
    EngineStateService.setBotEnabled(false);
    await AuditLogService.log({
      userId,
      command: 'engine_stop',
      timestamp: new Date().toISOString(),
      success: true,
    });
    res.json({ success: true, message: '엔진 정지됨' });
  } catch (e) {
    await AuditLogService.log({
      userId,
      command: 'engine_stop',
      timestamp: new Date().toISOString(),
      success: false,
      errorCode: (e as Error).message,
    });
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

app.post('/api/sell-all', async (req: Request, res: Response) => {
  const userId = (req.body && req.body.userId) || (req.headers?.['x-user-id'] as string) || 'api';
  try {
    const s = await getServer();
    const result = await s.discordHandlers.sellAll();
    const ok = typeof result === 'string';
    await AuditLogService.log({
      userId,
      command: 'sell_all',
      timestamp: new Date().toISOString(),
      success: ok,
    });
    res.json(ok ? { success: true, message: result } : { success: false, message: String(result || 'Unknown') });
  } catch (e) {
    await AuditLogService.log({
      userId,
      command: 'sell_all',
      timestamp: new Date().toISOString(),
      success: false,
      errorCode: (e as Error).message,
    });
    res.status(500).json({ success: false, message: (e as Error).message });
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

io.on('connection', (socket) => {
  const state = EngineStateService.getState();
  const summary = ProfitCalculationService.getSummary(state.assets);
  socket.emit('dashboard', {
    assets: state.assets,
    profitSummary: summary,
    botEnabled: state.botEnabled,
    lastOrderAt: state.lastOrderAt,
  });
});

// FIX: DASHBOARD_EMIT은 socket.io / web dashboard 전용. Discord status 메시지는 discord-operator startup 시에만 전송.
EventBus.subscribe('DASHBOARD_EMIT', (payload: { lastEmit: any }) => {
  io.emit('dashboard', payload.lastEmit);
});

const PORT = Number(process.env.PORT) || 3000;

httpServer.on('error', (err: NodeJS.ErrnoException) => {
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
  } catch (e) {
    console.error('[api-server] trading-engine load failed:', (e as Error).message);
  }
});

export { app, io, httpServer, getServer };
