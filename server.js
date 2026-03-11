/**
 * 스캘핑 HTS 백엔드 (express, socket.io, SQLite, dotenv)
 *
 * 단일 진입점: node server.js 한 번만 실행.
 * - 포트 3000: 웹 대시보드 + Scalp 엔진
 * - 같은 프로세스에서 디스코드 봇 login (별도 포트 없음). .env/config에 DISCORD_TOKEN, CHANNEL_ID 설정 시.
 *
 * SCALP 엔진 (SCALP_LOGIC_FOR_NODEJS.md):
 * - P0 게이트 8단계, Vol Surge, Entry Score, 청산 로직
 * - [🚀 엔진 가동] → state.botEnabled = true (매매 시작)
 * - [🛑 즉시 정지] → state.botEnabled = false + 미체결 주문 일괄 취소
 *
 * SQLite trades.db: 매수/매도 시 ticker, side, price, quantity, fee, net_return, reason, timestamp 저장
 */

const path = require('path');
const { exec } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// PM2 안정화: Unhandled Rejection/Exception 시 프로세스 종료 방지 (online 유지)
process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.message : String(reason));
  if (reason && typeof reason.stack === 'string') console.error(reason.stack);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.message || err);
  if (err && typeof err.stack === 'string') console.error(err.stack);
  // 프로세스 종료하지 않고 로그만 (PM2가 online 유지)
});

// 이 프로세스의 디스코드 봇: DISCORD_TOKEN 또는 DISCORD_BOT_TOKEN만 사용 (매매/제어 봇 1개). MarketSearchEngine은 별도 프로세스(market_search.js)에서 MARKET_BOT_TOKEN 사용.
const fs = require('fs');
const serverLock = require('./lib/serverLock');
const SERVER_LOCK_PATH = path.join(__dirname, '.server.lock');
(function ensureSingleInstance() {
  const result = serverLock.tryAcquire(SERVER_LOCK_PATH);
  if (!result.acquired) {
    console.error('[fatal][server] Another active instance detected. Startup aborted.', {
      existing_pid: result.existingPid,
      lock_file: SERVER_LOCK_PATH,
      cwd: result.existingCwd || process.cwd(),
    });
    process.exit(1);
  }
  function releaseLock() {
    serverLock.release(SERVER_LOCK_PATH);
  }
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
})();
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const axios = require('axios');

const upbit = require('./lib/upbit');
const upbitWs = require('./lib/upbitWs');
const scalpEngine = require('./lib/scalpEngine');
const StrategyManager = require('./lib/StrategyManager');
const MarketAnalyzer = require('./lib/MarketAnalyzer');
const tradeLogger = require('./lib/logger');
const memeEngine = require('./lib/meme/memeEngine');
const signalStore = require('./lib/meme/signalStore');
const mpiDiagnostics = require('./lib/meme/mpiDiagnostics');
const regimeDetector = require('./lib/regime/regimeDetector');
const patternLearner = require('./lib/pattern/patternLearner');
const similarityEngine = require('./lib/pattern/similarityEngine');
const futuresSentiment = require('./lib/meme/futuresSentiment');
const db = require('./lib/db');
const configDefault = require('./config.default');
const { UPBIT_FEE_RATE } = require(path.join(__dirname, 'src/shared/constants'));
const TradeExecutor = require('./lib/TradeExecutor');
const ExitPolicy = require(path.join(__dirname, 'src/domain/position/ExitPolicy'));
const ApiAccessPolicy = require(path.join(__dirname, 'src/domain/state/ApiAccessPolicy'));
const EngineMode = require(path.join(__dirname, 'src/domain/state/EngineMode'));
const signalEvaluationLogger = require('./lib/signalEvaluationLogger');
const discordBot = require('./lib/discordBot');
const { MessageEmbed } = require('discord.js');
const orchestrator = require('./lib/strategy/orchestrator');
const raceHorsePolicy = require('./lib/strategy/raceHorsePolicy');
const scalpRunner = require('./lib/scalp_independent/scalpRunner');
const scalpState = require('./lib/scalp_independent/scalpState');
const systemStatePersistence = require('./lib/systemStatePersistence');
const tradeHistoryLogger = require('./lib/tradeHistoryLogger');
const EngineStateStore = require('./domain/state/EngineStateStore');
const TradingEngine = require('./domain/trading/TradingEngine');
const USE_SIGNAL_ENGINE = process.env.USE_SIGNAL_ENGINE === '1';
let signalEngineFromBootstrap = null;
let riskEngineFromBootstrap = null;
let executionEngineFromBootstrap = null;
let positionEngineFromBootstrap = null;
if (USE_SIGNAL_ENGINE) {
  try {
    const { bootstrap } = require('./src/composition/bootstrap');
    const composed = bootstrap({ stateStore: null });
    signalEngineFromBootstrap = composed.signalEngine;
    riskEngineFromBootstrap = composed.riskEngine;
    executionEngineFromBootstrap = composed.executionEngine;
    positionEngineFromBootstrap = composed.positionEngine;
    console.log('[Arch] SignalEngine + Risk/Execution/Position 엔진 로드됨 — USE_SIGNAL_ENGINE=1');
  } catch (e) {
    console.warn('[Arch] bootstrap 로드 실패:', e?.message);
  }
}
const geminiResolvedPath = require.resolve('./lib/gemini');
const geminiModule = require('./lib/gemini');
console.log('[Gemini] server.js가 로드한 gemini 모듈 절대경로:', geminiResolvedPath);
if (typeof geminiModule.getModelName === 'function') {
  console.log('[Gemini] server.js 로드 모델:', geminiModule.getModelName());
}

// API 키: dashboard/config.json 우선, 없으면 .env 또는 환경변수
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
const FNG_API_URL = 'https://api.alternative.me/fng/';
const FX_API_URL = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json';
const BINANCE_TICKER_URL = 'https://api.binance.com/api/v3/ticker/price';
const COINGECKO_GLOBAL_URL = 'https://api.coingecko.com/api/v3/global';
const ANALYST_EMBED_COLOR = 0x0099ff;
/** 전 종목(BTC, ETH, XRP, SOL) 동일 로직 적용. 루프에서 RSI·볼린저·진입점을 종목별 독립 계산. 부팅 시 fetchAssets 선행으로 재기동 후에도 보유 종목 매도 감시 가능 */
const SCALP_MARKETS = ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL'];
const BINANCE_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'SOLUSDT'];
const ASSET_POLL_MS = 1000;
const FX_POLL_MS = 60000;
const LOG_EMIT_MS = 800;
const PREV_HIGH_WINDOW = 60;

function loadApiKeys() {
  const fromEnv = (key, def = '') => (process.env[key] || '').trim() || def;
  const base = {
    discordBotToken: process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN || '',
    discordChannelId: process.env.CHANNEL_ID || process.env.DISCORD_CHANNEL_ID || '',
    discordAdminId: '',
    tradingLogChannelId: process.env.TRADING_LOG_CHANNEL_ID || '',
    aiAnalysisChannelId: process.env.AI_ANALYSIS_CHANNEL_ID || ''
  };
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const config = JSON.parse(raw);
      base.accessKey = config.access_key || fromEnv('UPBIT_ACCESS_KEY', '');
      base.secretKey = config.secret_key || fromEnv('UPBIT_SECRET_KEY', '');
      base.discordBotToken = base.discordBotToken || config.discord_token || config.discord_bot_token || '';
      base.discordChannelId = base.discordChannelId || config.channel_id || config.discord_channel_id || '';
      base.discordAdminId = normalizeAdminId(process.env.ADMIN_ID || process.env.DISCORD_ADMIN_ID || config.admin_id || config.discord_admin_id || '');
      base.discordAdminDiscordId = normalizeAdminId(process.env.ADMIN_DISCORD_ID || config.discord_admin_discord_id || '');
      base.accessKeyMini = fromEnv('UPBIT_ACCESS_KEY_MINI', '');
      base.secretKeyMini = fromEnv('UPBIT_SECRET_KEY_MINI', '');
      return base;
    }
  } catch (err) {
    console.warn('config.json load failed:', err.message);
  }
  base.accessKey = fromEnv('UPBIT_ACCESS_KEY', '');
  base.secretKey = fromEnv('UPBIT_SECRET_KEY', '');
  base.discordAdminId = normalizeAdminId(process.env.ADMIN_ID || process.env.DISCORD_ADMIN_ID || '');
  base.discordAdminDiscordId = normalizeAdminId(process.env.ADMIN_DISCORD_ID || '');
  base.accessKeyMini = fromEnv('UPBIT_ACCESS_KEY_MINI', '');
  base.secretKeyMini = fromEnv('UPBIT_SECRET_KEY_MINI', '');
  return base;
}

const adminGuard = require('./lib/adminGuard');
const normalizeAdminId = adminGuard.normalizeAdminId;

const apiKeysRaw = loadApiKeys();
let activeKeySet = 'default';

function getActiveUpbitKeys() {
  if (activeKeySet === 'mini' && apiKeysRaw.accessKeyMini && apiKeysRaw.secretKeyMini) {
    return { accessKey: apiKeysRaw.accessKeyMini, secretKey: apiKeysRaw.secretKeyMini };
  }
  return { accessKey: apiKeysRaw.accessKey, secretKey: apiKeysRaw.secretKey };
}

function hasMiniKeySet() {
  return !!(apiKeysRaw.accessKeyMini && apiKeysRaw.secretKeyMini);
}

function isUpbitAuthError(err) {
  const msg = (err && err.message) || '';
  return /401|unauthorized|invalid_query|ip\s*mismatch|ip\s*불일치|등록된\s*ip/i.test(msg);
}

async function withUpbitFailover(fn) {
  const mode = state ? ApiAccessPolicy.getMode(state) : EngineMode.NORMAL;
  if (mode === EngineMode.EMERGENCY_PAUSE) {
    return undefined;
  }
  try {
    return await fn();
  } catch (e) {
    if (isUpbitAuthError(e) && activeKeySet === 'default' && hasMiniKeySet()) {
      activeKeySet = 'mini';
      if (discordBot && typeof discordBot.sendToChannel === 'function') {
        discordBot.sendToChannel('⚠️ 기본 API 키 IP 인증 실패 - 미니 PC용 대체 키로 자동 전환되었습니다.').catch(() => {});
      }
      return await fn();
    }
    throw e;
  }
}

const apiKeys = new Proxy(apiKeysRaw, {
  get(target, prop) {
    if (prop === 'accessKey') return getActiveUpbitKeys().accessKey;
    if (prop === 'secretKey') return getActiveUpbitKeys().secretKey;
    return target[prop];
  }
});
// Discord 관리자: 권한 판별은 ADMIN_ID 우선 사용 (PermissionService/discord-operator도 동일). ADMIN_DISCORD_ID는 역할 C 전용.
const adminIdRaw = (process.env.ADMIN_ID || '').trim();
const adminDiscordIdRaw = (process.env.ADMIN_DISCORD_ID || '').trim();
const discordAdminIdRaw = (process.env.DISCORD_ADMIN_ID || '').trim();
const superAdminIdRaw = (process.env.SUPER_ADMIN_ID || '').trim();
const hasAdminId = !!(adminIdRaw || adminDiscordIdRaw || discordAdminIdRaw || superAdminIdRaw);
if (!hasAdminId) {
  console.warn('[config][warn] ADMIN_ID is not set.');
  console.warn('[config][warn] Strategy mode change via Discord may not work as expected for admin-only operations.');
  console.warn('[config][warn] Please set ADMIN_ID or ADMIN_DISCORD_ID in environment variables.');
  console.log('[startup] ADMIN_ID loaded: No');
} else {
  const which = adminIdRaw ? 'ADMIN_ID' : (adminDiscordIdRaw ? 'ADMIN_DISCORD_ID' : (discordAdminIdRaw ? 'DISCORD_ADMIN_ID' : 'SUPER_ADMIN_ID'));
  console.log('[startup] ADMIN_ID loaded: Yes (' + which + ')');
}
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const MEME_PAGE_ONLY = process.env.MEME_PAGE_ONLY === '1';
const ORCH_PAGE_ONLY = process.env.ORCH_PAGE_ONLY === '1';

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  if (ORCH_PAGE_ONLY) return res.redirect('/orchestrator');
  if (MEME_PAGE_ONLY) return res.redirect('/meme');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/meme', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'meme.html'));
});
app.get('/meme/diagnostics', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'diagnostics.html'));
});
app.get('/meme/regime', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'regime.html'));
});
app.get('/stats', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'stats.html'));
});
app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});
app.get('/manual_trade', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'manual_trade.html'));
});
app.get('/orchestrator', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'public', 'orchestrator.html'));
});
app.get('/api/orchestrator/state', (req, res) => {
  try {
    const log = orchestrator.getDecisionLog();
    const summary30 = orchestrator.getDecisionSummary30Min(log);
    const scalpState = state.scalpState || {};
    const profile = scalpEngine.getProfile();
    const regimeLines = regimeDetector.readLastLines(32);
    const mpiList = memeEngine.getAllMPI();
    const mpiBySymbol = {};
    (mpiList || []).forEach((p) => { mpiBySymbol[p.symbol] = p.mpi; });
    const scalpSignalProvider = require('./lib/strategy/scalpSignalProvider');
    const regimeSignalProvider = require('./lib/strategy/regimeSignalProvider');
    const bestScalp = scalpSignalProvider.getBestScalpSignal(scalpState, profile, profile?.entry_score_min);
    const bestRegime = regimeSignalProvider.getBestRegimeSignal(regimeLines, mpiBySymbol);
    res.json({
      scalpSignal: bestScalp,
      regimeSignal: bestRegime,
      decisionLog: log,
      decisionSummary30Min: summary30,
      botEnabled: state.botEnabled,
      orchPageOnly: ORCH_PAGE_ONLY
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'orchestrator state error' });
  }
});
app.get('/api/orchestrator/history', (req, res) => {
  try {
    const n = Math.min(100, parseInt(req.query.n, 10) || 20);
    const lines = orchestrator.readHistoryLines(n);
    res.json({ history: lines });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'history error' });
  }
});
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await db.getStats();
    const payload = { ...stats };
    payload.fxUsdKrw = state.fxUsdKrw;
    payload.assets = state.assets || null;
    if (state.assets != null && state.fxUsdKrw != null && state.fxUsdKrw > 0) {
      payload.assetUsd = (state.assets.totalEvaluationKrw || 0) / state.fxUsdKrw;
    }
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message, winRate: 0, cumulativeRevenue: 0, bestReturn: null, worstReturn: null, totalTrades: 0, dailyProfits: [] });
  }
});

// 보유 자산 목록 (업비트 계정 기준, 통계/투자내역 페이지용)
app.get('/api/accounts', async (req, res) => {
  try {
    if (!apiKeys.accessKey || !apiKeys.secretKey) {
      return res.json({ list: [], assets: null });
    }
    const [accounts, tickers] = await withUpbitFailover(async () => {
      const k = getActiveUpbitKeys();
      return Promise.all([
        upbit.getAccounts(k.accessKey, k.secretKey),
        upbit.getTickers(SCALP_MARKETS)
      ]);
    });
    const tickerMap = {};
    (tickers || []).forEach((t) => { tickerMap[t.market] = t; });
    const list = (accounts || [])
      .filter((a) => a.currency !== 'KRW')
      .map((a) => {
        const market = 'KRW-' + a.currency;
        const t = tickerMap[market];
        const price = t ? t.trade_price : parseFloat(a.avg_buy_price) || 0;
        const balance = parseFloat(a.balance) || 0;
        const avg = parseFloat(a.avg_buy_price) || 0;
        return {
          currency: a.currency,
          balance,
          avgBuyPrice: avg,
          tradePrice: price,
          evalKrw: price * balance
        };
      })
      .filter((row) => row.balance > 0);
    res.json({ list, assets: state.assets });
  } catch (err) {
    console.error('api/accounts error:', err.message);
    res.json({ list: [], assets: null });
  }
});
app.get('/api/meme/mpi', (req, res) => {
  try {
    const list = memeEngine.getAllMPI();
    const historyBySymbol = {};
    for (const sym of ['BTC', 'ETH', 'SOL', 'XRP']) {
      historyBySymbol[sym] = memeEngine.getHistory(sym, 15);
    }
    const updatedAt = list.length ? new Date((list[0] && list[0].timestamp) * 1000).toLocaleString('ko-KR') : '—';
    let regimeBySymbol = {};
    try {
      regimeBySymbol = regimeDetector.readLastLines(4).reduce((acc, r) => {
        if (r && r.symbol) acc[r.symbol] = r;
        return acc;
      }, {});
    } catch (_) {}
    res.json({
      list,
      historyBySymbol,
      regimeBySymbol,
      updatedAt,
      cacheStatus: '1분 갱신',
      memePageOnly: MEME_PAGE_ONLY
    });
  } catch (err) {
    res.status(500).json({ error: err.message, list: [], historyBySymbol: {} });
  }
});

app.get('/api/meme/signals', (req, res) => {
  try {
    const n = Math.min(100, parseInt(req.query.limit, 10) || 20);
    const signals = signalStore.getSignalsLast(n);
    res.json({ signals });
  } catch (err) {
    res.status(500).json({ error: err.message, signals: [] });
  }
});

app.get('/api/meme/diagnostics/stats', (req, res) => {
  try {
    const signals = mpiDiagnostics.getSignalsLast();
    const byThreshold = mpiDiagnostics.statsByThreshold(signals);
    const bySymbol = mpiDiagnostics.statsBySymbol(signals);
    const componentImportance = mpiDiagnostics.componentImportance(signals);
    res.json({ byThreshold, bySymbol, componentImportance, totalSignals: signals.length });
  } catch (err) {
    res.status(500).json({ error: err.message, byThreshold: {}, bySymbol: {}, componentImportance: {} });
  }
});

app.get('/api/regime/current', (req, res) => {
  try {
    const last = regimeDetector.readLastLines(32);
    const bySymbol = {};
    for (const r of last) {
      if (r && r.symbol) bySymbol[r.symbol] = r;
    }
    res.json({ bySymbol });
  } catch (err) {
    res.status(500).json({ error: err.message, bySymbol: {} });
  }
});

app.get('/api/regime/history', (req, res) => {
  try {
    const symbol = req.query.symbol || 'BTC';
    const n = Math.min(200, parseInt(req.query.limit, 10) || 50);
    const all = regimeDetector.readLastLines(n * 4);
    const filtered = all.filter(r => r && r.symbol === symbol);
    res.json({ symbol, history: filtered });
  } catch (err) {
    res.status(500).json({ error: err.message, history: [] });
  }
});

// SCALP 프로필 (설정 페이지 초기값)
app.get('/api/scalp-profile', (req, res) => {
  try {
    const p = scalpEngine.getProfile();
    const volSurgeWeight = Math.round(1 + (p.volume_multiplier - 1.1) / 0.5 * 9);
    const priceBreakWeight = Math.round(1 + (p.entry_tick_buffer - 1) / 4 * 9);
    const strengthWeight = Math.round(1 + (p.strength_threshold - 0.5) / 0.45 * 9);
    res.json({
      p0_kimp_block: (p.kimp_block_pct != null ? p.kimp_block_pct : 3) < 100,
      p0_lag_block: (p.rest_latency_ms_max || 500) < 10000,
      kimp_block_pct: p.kimp_block_pct != null ? p.kimp_block_pct : 3,
      slippage_tolerance_pct: p.slippage_tolerance_pct != null ? p.slippage_tolerance_pct * 100 : 0.05,
      slippage_shutdown_bps: p.slippage_shutdown_bps != null ? p.slippage_shutdown_bps : 5,
      rest_latency_ms_max: p.rest_latency_ms_max != null ? p.rest_latency_ms_max : 500,
      ws_lag_ms_max: p.ws_lag_ms_max != null ? p.ws_lag_ms_max : 1500,
      vol_surge_weight: Math.min(10, Math.max(1, volSurgeWeight)),
      price_break_weight: Math.min(10, Math.max(1, priceBreakWeight)),
      strength_weight: Math.min(10, Math.max(1, strengthWeight)),
      weight_price_break: p.weight_price_break != null ? p.weight_price_break : 1,
      weight_vol_surge: p.weight_vol_surge != null ? p.weight_vol_surge : 1,
      weight_obi: p.weight_obi != null ? p.weight_obi : 1,
      weight_strength: p.weight_strength != null ? p.weight_strength : 1,
      weight_spread: p.weight_spread != null ? p.weight_spread : 0.5,
      weight_depth: p.weight_depth != null ? p.weight_depth : 0.5,
      weight_kimp: p.weight_kimp != null ? p.weight_kimp : 0.5,
      stop_loss_pct: p.stop_loss_pct != null ? p.stop_loss_pct : -0.35,
      time_stop_sec: p.time_stop_sec != null ? p.time_stop_sec : 150,
      take_profit_target_pct: p.take_profit_target_pct != null ? p.take_profit_target_pct : 1,
      trailing_stop_pct: p.trailing_stop_pct != null ? p.trailing_stop_pct : 0.5,
      score_out_threshold: p.score_out_threshold != null ? p.score_out_threshold : 1,
      min_order_krw: p.min_order_krw != null ? p.min_order_krw : 5000,
      greedy_mode: !!p.greedy_mode,
      max_bet_multiplier: p.max_bet_multiplier != null ? Math.min(2.5, Math.max(1, Number(p.max_bet_multiplier))) : 2,
      aggressive_mode: !!p.aggressive_mode,
      race_horse_scheduler_enabled: !!p.race_horse_scheduler_enabled
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 현재 적용 전략 요약 (대시보드 상단용)
app.get('/api/strategy-current', async (req, res) => {
  try {
    if (state.strategySummary) {
      return res.json(state.strategySummary);
    }
    const latest = await db.getLatestStrategyLog();
    if (!latest) return res.json({ id: null, created_at: null, strategyName: null, weights: null, take_profit_target_pct: null, trailing_stop_pct: null, score_out_threshold: null, stop_loss_pct: null, time_stop_sec: null, race_horse_scheduler_enabled: false });
    const p = latest.profile || {};
    const aggressive = !!p.aggressive_mode;
    const summary = {
      id: latest.id,
      created_at: latest.created_at,
      strategyName: aggressive ? 'Aggressive' : (latest.race_horse_scheduler_enabled ? 'RaceHorse(예약)' : 'SCALP 기본'),
      aggressive_mode: aggressive,
      race_horse_scheduler_enabled: !!latest.race_horse_scheduler_enabled,
      weights: latest.profile ? {
        weight_price_break: latest.profile.weight_price_break,
        weight_vol_surge: latest.profile.weight_vol_surge,
        weight_obi: latest.profile.weight_obi,
        weight_strength: latest.profile.weight_strength,
        weight_spread: latest.profile.weight_spread,
        weight_depth: latest.profile.weight_depth,
        weight_kimp: latest.profile.weight_kimp
      } : null,
      take_profit_target_pct: latest.take_profit_target_pct,
      trailing_stop_pct: latest.trailing_stop_pct,
      score_out_threshold: latest.score_out_threshold,
      stop_loss_pct: latest.stop_loss_pct,
      time_stop_sec: latest.time_stop_sec
    };
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 전략별 성과 (승률, 평균 수익률, MDD)
app.get('/api/strategy-stats', async (req, res) => {
  try {
    const list = await db.getStrategyStats();
    res.json(list);
  } catch (err) {
    res.status(500).json([]);
  }
});

// 거래 내역: SQLite (기본 50건, ?limit= 쿼리 지원)
app.get('/api/trades', async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const list = await db.getRecentTrades(limit);
    res.json(list);
  } catch (err) {
    res.json([]);
  }
});

// API 키 연결 확인 (잔고 조회로 검증)
app.get('/api/check-upbit', async (req, res) => {
  const sysdate = new Date();
  const sysdateStr = sysdate.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'medium' });
  if (!apiKeys.accessKey || !apiKeys.secretKey) {
    return res.json({ ok: false, message: 'API 키가 설정되지 않았습니다.', sysdate: sysdateStr });
  }
  try {
    const accounts = await withUpbitFailover(async () => {
      const k = getActiveUpbitKeys();
      return upbit.getAccounts(k.accessKey, k.secretKey);
    });
    if (!Array.isArray(accounts)) {
      return res.json({ ok: false, message: '잔고 조회 응답 형식 오류', sysdate: sysdateStr });
    }
    return res.json({ ok: true, message: '연결완료', sysdate: sysdateStr });
  } catch (err) {
    return res.json({ ok: false, message: err.message || '연결 실패', sysdate: sysdateStr });
  }
});

/** 전 엔진 공통: 이 금액 미만이면 신규 매수 전부 중단 (init보다 위에서 정의해 TDZ 방지) */
const GLOBAL_MIN_BUYABLE_KRW = 5000;

EngineStateStore.init({
  assets: null,
  prices: {},
  fng: null,
  botEnabled: false,
  trades: [],
  rejectLogs: [],
  scalpState: {},
  marketContext: null,
  wsLagMs: null,
  lastEmit: null,
  fxUsdKrw: null,
  binancePrices: {},
  kimpByMarket: {},
  kimpAvg: null,
  raceHorseActive: false,
  currentStrategyId: null,
  strategySummary: null,
  accounts: [],
  lastOrchestratorResult: null,
  serviceStopped: false,
  emergencyPauseUntil: null,
  emergencyPauseReason: null,
  mode: EngineMode.NORMAL,
  recoveryUntil: null,
  lastPauseLogAt: null,
  lastResumeLogAt: null,
  lastRecoveryFetchAt: null,
  geminiEnabled: true,
  scalpMode: false,
  cashLock: {
    active: false,
    reason: null,
    orderableKrw: null,
    requiredKrw: GLOBAL_MIN_BUYABLE_KRW,
    since: null,
    notifiedAt: null
  }
});
if (executionEngineFromBootstrap) executionEngineFromBootstrap.stateStore = EngineStateStore;
if (positionEngineFromBootstrap) positionEngineFromBootstrap.stateStore = EngineStateStore;
const state = EngineStateStore.get();

const priceHistory = {};
SCALP_MARKETS.forEach(m => { priceHistory[m] = []; });

function pushPrice(market, price) {
  const arr = priceHistory[market];
  if (!arr) return;
  arr.push(price);
  if (arr.length > PREV_HIGH_WINDOW) arr.shift();
}

function getPrevHigh(market) {
  const arr = priceHistory[market];
  if (!arr || arr.length === 0) return null;
  return Math.max(...arr);
}

async function fetchAssets() {
  const keys = getActiveUpbitKeys();
  if (!keys.accessKey || !keys.secretKey) return null;
  try {
    return await withUpbitFailover(async () => {
      const [accounts, tickers] = await Promise.all([
        upbit.getAccounts(getActiveUpbitKeys().accessKey, getActiveUpbitKeys().secretKey),
        upbit.getTickers(SCALP_MARKETS)
      ]);
      return upbit.summarizeAccounts(accounts, tickers);
    });
  } catch (err) {
    console.error('fetchAssets error:', err.message);
    return null;
  }
}

/**
 * 수익률(%) 업비트 표준, 수수료 0.05% 반영. 보유 KRW 제외, 코인만.
 * 공통: src/shared/utils/math.js calculateNetProfitPct 사용.
 */
function getProfitPct(assets) {
  if (!assets) return 0;
  const totalBuy = Number(assets.totalBuyKrwForCoins ?? 0) || 0;
  const totalEval = Number(assets.evaluationKrwForCoins ?? 0) || 0;
  return require('./src/shared/utils/math').calculateNetProfitPct(totalBuy, totalEval, UPBIT_FEE_RATE);
}

/** AI 추천 대형주 승인 대상 티커 (대괄호 추출 후 이 목록에 있을 때만 승인 버튼 노출) */
const ALLOWED_AGGRESSIVE_TICKERS = ['BTC', 'ETH', 'SOL', 'XRP'];

/** AI 분석 본문에서 추천 티커 추출. 대괄호 [BTC] 형식 또는 [ETH] 등 */
function extractRecommendedTicker(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(/\[(BTC|ETH|SOL|XRP)\]/i);
  return m ? m[1].toUpperCase() : null;
}

/** 경주마 모드 상태 라벨 — 버튼 ON/OFF + 9~10시 여부로 세분화 */
function getRaceHorseStatusLabel(raceHorseActive) {
  if (!raceHorseActive) return '❄️ 비활성';
  if (!StrategyManager.isRaceHorseTimeWindow()) return '⏳ 경주마 시간 대기 중 (자산 50% 세팅 완료)';
  return '🔥 실시간 가동 중 (공격적 매수 진행)';
}

/** [🔓 매매 엔진 기준 완화] 상태 라벨 — 남은 시간 -HH:MM. 미적용 시 null */
function getRelaxedModeLabel() {
  const remainingMs = StrategyManager.getRelaxedModeRemainingMs();
  if (remainingMs <= 0) return null;
  const totalMin = Math.floor(remainingMs / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `🔓 완화 적용 중 (-${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')})`;
}

/** 남은 시간(ms) → "HH:mm:ss 남음" */
function formatRemainingHMS(remainingMs) {
  if (remainingMs == null || remainingMs <= 0) return null;
  const totalSec = Math.floor(remainingMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} 남음`;
}

function getCurrentSystemState() {
  const st = scalpRunner.getStatus(state);
  const scalpRemaining = st?.remainingMs ?? 0;
  const aggressiveList = scalpEngine.getAggressiveSymbols();
  const ai_weight = aggressiveList.map((ticker) => ({
    ticker,
    endTime: Date.now() + (scalpEngine.getAggressiveSymbolRemainingMs(ticker) || 0)
  })).filter((x) => x.endTime > Date.now());
  const relaxedRemaining = StrategyManager.getRelaxedModeRemainingMs();
  return {
    scalp_mode: {
      active: !!(st?.isRunning && scalpRemaining > 0),
      startTime: st?.endTime != null ? st.endTime - 3 * 60 * 60 * 1000 : null,
      endTime: st?.isRunning && st?.endTime ? st.endTime : null
    },
    ai_weight,
    soft_criteria: {
      active: relaxedRemaining > 0,
      endTime: relaxedRemaining > 0 ? Date.now() + relaxedRemaining : null
    },
    gemini_enabled: state.geminiEnabled !== false
  };
}

function persistSystemState() {
  EngineStateStore.savePersisted(getCurrentSystemState);
}
EngineStateStore.setPersistCallback(getCurrentSystemState);

/** buildCurrentStateEmbed opts에 넣을 모드별 남은 시간 */
function getModeRemainingOpts() {
  const st = scalpRunner.getStatus(state);
  const aggressiveList = scalpEngine.getAggressiveSymbols();
  return {
    scalpRemainingMs: st?.remainingMs ?? 0,
    aiWeightRemaining: (aggressiveList || []).map((ticker) => ({
      ticker,
      remainingMs: scalpEngine.getAggressiveSymbolRemainingMs(ticker) || 0
    })).filter((x) => x.remainingMs > 0),
    relaxedRemainingMs: StrategyManager.getRelaxedModeRemainingMs(),
    relaxedOverrideActive: StrategyManager.isRelaxedOverrideActive ? StrategyManager.isRelaxedOverrideActive() : false
  };
}

function restoreSystemState() {
  const loaded = EngineStateStore.loadPersisted();
  const now = Date.now();
  // 재기동 후 자동 진입 금지: scalp_mode는 endTime만 참고 복원하고, isRunning은 켜지 않음 (paused_after_restart)
  if (loaded.scalp_mode.active && loaded.scalp_mode.endTime != null && loaded.scalp_mode.endTime > now) {
    scalpState.restoreFromPersistence(loaded.scalp_mode.endTime);
    EngineStateStore.update({ scalpMode: false });
    console.log('[Boot] system_state: 초단타 스캘프 모드 복구됨 (일시정지, 수동 시작 필요. 만료 참고:', new Date(loaded.scalp_mode.endTime).toISOString(), ')');
  }
  // 시간제 모드(경주마/AI가중치/기준완화)는 재기동 후 자동 ON 복원 금지 — 남은 시간은 persist에만 남기고 활성화하지 않음
  if (loaded.gemini_enabled === false) {
    EngineStateStore.update({ geminiEnabled: false });
    console.log('[Boot] system_state: Gemini AI 비활성 상태 복구됨 (결제 차단 등)');
  }
  // 만료된 모드 제거 후 파일 갱신하여 크기 최소화
  const pruned = systemStatePersistence.pruneExpiredState(loaded);
  try {
    systemStatePersistence.save(pruned);
  } catch (e) {
    console.warn('[Boot] system_state 정제 저장 실패:', e?.message);
  }
}

/** APENFT·PURSE 제외된 filteredAccounts 기준(upbit.summarizeAccounts). getProfitPct 사용. Discord [📊 현재 상태] 및 emitDashboard 동기화용
 * @param {Object} [opts] - { isEngineRunning, raceHorseStatusLabel 또는 isRaceHorseMode } (미전달 시 최초 기동 표시)
 */
function buildCurrentStateEmbed(assets, summary, opts) {
  const isEngineRunning = opts?.isEngineRunning === true;
  const raceHorseLabel =
    opts?.raceHorseStatusLabel != null
      ? opts.raceHorseStatusLabel
      : (opts?.isRaceHorseMode === true ? '🔥 활성' : '❄️ 비활성');
  const w = (summary && summary.weights) || {};
  const totalBuyKrw = Math.floor(Number(assets?.totalBuyKrwForCoins ?? 0) || 0);
  const totalEvalCoins = Math.floor(Number(assets?.evaluationKrwForCoins ?? 0) || 0);
  const orderableKrw = Math.floor(assets?.orderableKrw ?? 0);
  const profitLossKrw = totalEvalCoins - totalBuyKrw;
  const profitPctNum = positionEngineFromBootstrap ? positionEngineFromBootstrap.getProfitPct(assets) : getProfitPct(assets);
  const profitRateStr = (totalBuyKrw <= 0 ? 0 : Math.floor(profitPctNum * 100) / 100).toFixed(2) + '%';
  const emoji = profitPctNum > 0 ? '🟢 ' : profitPctNum < 0 ? '🔴 ' : '⚪ ';
  const profitPct = emoji + (profitPctNum >= 0 ? '+' : '') + profitRateStr;
  const strategyName = summary?.strategyName || 'SCALP 기본';
  const weightTable = [
    '| 항목 | 값 |',
    '|------|-----|',
    `| 돌파(price_break) | ${w.weight_price_break ?? '—'} |`,
    `| Vol(vol_surge) | ${w.weight_vol_surge ?? '—'} |`,
    `| OBI | ${w.weight_obi ?? '—'} |`,
    `| Strength | ${w.weight_strength ?? '—'} |`,
    `| 스프레드 | ${w.weight_spread ?? '—'} |`,
    `| Depth | ${w.weight_depth ?? '—'} |`,
    `| Kimp | ${w.weight_kimp ?? '—'} |`
  ].join('\n');
  const investmentSummary = [
    '**💰 투자 내역 요약**',
    `• **총매수**: ${totalBuyKrw.toLocaleString('ko-KR')} 원`,
    `• **총평가**: ${totalEvalCoins.toLocaleString('ko-KR')} 원`,
    `• **평가손익**: ${profitLossKrw.toLocaleString('ko-KR')} 원`,
    `• **수익률**: ${profitPct}`,
    `• **주문가능**: ${orderableKrw.toLocaleString('ko-KR')} 원`
  ].join('\n');
  const fields = [
    { name: '매매 엔진 상태', value: isEngineRunning ? '🟢 구동 중' : '🔴 정지됨', inline: true },
    { name: '경주마 모드', value: raceHorseLabel, inline: true },
    { name: '투자 내역', value: investmentSummary, inline: false },
    { name: '총 손익률', value: profitPct, inline: true },
    { name: '가동 전략', value: strategyName, inline: false },
    { name: 'RaceHorse(예약) 가중치', value: '```\n' + weightTable + '\n```', inline: false }
  ];
  const relaxedLabel = opts?.relaxedModeLabel;
  if (relaxedLabel) {
    fields.push({ name: '매매 모드', value: relaxedLabel, inline: true });
  }
  const scalpRemainingMs = opts?.scalpRemainingMs ?? 0;
  const aiWeightRemaining = opts?.aiWeightRemaining ?? [];
  const relaxedRemainingMs = opts?.relaxedRemainingMs ?? 0;
  const modeTimeLines = [];
  modeTimeLines.push(`• **초단타 스캘프**: ${scalpRemainingMs > 0 ? formatRemainingHMS(scalpRemainingMs) : '—'}`);
  if (Array.isArray(aiWeightRemaining) && aiWeightRemaining.length > 0) {
    modeTimeLines.push(`• **AI 가중치**: ${aiWeightRemaining.map((x) => `${x.ticker} ${formatRemainingHMS(x.remainingMs)}`).join(', ')}`);
  } else {
    modeTimeLines.push(`• **AI 가중치**: —`);
  }
  modeTimeLines.push(`• **기준 완화**: ${relaxedRemainingMs > 0 ? formatRemainingHMS(relaxedRemainingMs) : '—'}`);
  fields.push({ name: '⏱ 모드별 남은 시간', value: modeTimeLines.join('\n'), inline: false });

  const aiUsage = opts?.aiUsage;
  if (aiUsage && typeof aiUsage.count === 'number' && typeof aiUsage.limit === 'number') {
    fields.push({ name: 'AI 사용량', value: `${aiUsage.count} / ${aiUsage.limit}`, inline: true });
  }
  const aggressiveList = opts?.aggressiveSymbols;
  if (Array.isArray(aggressiveList) && aggressiveList.length > 0) {
    fields.push(
      { name: '가중치 적용 모델', value: '개별 티커 4시간 상향', inline: false },
      {
        name: '🔥 특별 관리 종목 (가중치 상향 적용 중)',
        value: aggressiveList.map((s) => `${s} (가중치 상향)`).join(', ') + '\n_아래 버튼으로 티커별 해지 가능_',
        inline: false
      }
    );
  }
  return new MessageEmbed()
    .setTitle('📊 현재 상태')
    .setColor(0x5865f2)
    .addFields(...fields)
    .setFooter({ text: 'APENFT·PURSE·잡코인 제외 · 수익률 = (평가손익/총매수)×100, 총매수 0이면 0%' })
    .setTimestamp();
}

async function fetchFng() {
  try {
    const res = await axios.get(FNG_API_URL, { timeout: 5000 });
    const data = res.data?.data?.[0];
    if (!data) return null;
    return {
      value: parseInt(data.value, 10),
      valueClassification: data.value_classification,
      timestamp: data.timestamp ? new Date(parseInt(data.timestamp, 10) * 1000).toISOString() : new Date().toISOString()
    };
  } catch (err) {
    console.error('FNG error:', err.message);
    return state.fng;
  }
}

async function fetchFx() {
  try {
    const res = await axios.get(FX_API_URL, { timeout: 8000 });
    const krw = res.data?.usd?.krw;
    if (krw != null) state.fxUsdKrw = Number(krw);
  } catch (err) {
    if (state.fxUsdKrw == null) console.warn('FX fetch failed:', err.message);
  }
}

async function fetchBinance() {
  try {
    const res = await axios.get(BINANCE_TICKER_URL, { timeout: 5000 });
    const arr = res.data;
    if (!Array.isArray(arr)) return;
    const map = {};
    arr.forEach((item) => {
      if (item.symbol && item.price != null) map[item.symbol] = Number(item.price);
    });
    state.binancePrices = map;
  } catch (err) {
    if (Object.keys(state.binancePrices).length === 0) console.warn('Binance fetch failed:', err.message);
  }
}

function computeKimp() {
  const fx = state.fxUsdKrw;
  const binance = state.binancePrices;
  const prices = state.prices;
  if (!fx || fx <= 0) return;
  const marketToBinance = { 'KRW-BTC': 'BTCUSDT', 'KRW-ETH': 'ETHUSDT', 'KRW-XRP': 'XRPUSDT', 'KRW-SOL': 'SOLUSDT' };
  const kimpByMarket = {};
  let sum = 0;
  let count = 0;
  for (const market of SCALP_MARKETS) {
    const upbitPrice = prices[market]?.tradePrice;
    const binanceSymbol = marketToBinance[market];
    const binancePrice = binance[binanceSymbol];
    if (upbitPrice != null && upbitPrice > 0 && binancePrice != null && binancePrice > 0) {
      const fairKrw = binancePrice * fx;
      const kimpPct = (upbitPrice / fairKrw - 1) * 100;
      kimpByMarket[market] = kimpPct;
      sum += kimpPct;
      count++;
    }
  }
  state.kimpByMarket = kimpByMarket;
  state.kimpAvg = count > 0 ? sum / count : null;
}

function buildSnapshotFromOrderbook(orderbookItem, ticker, market) {
  if (!orderbookItem || !ticker) return null;
  const units = orderbookItem.orderbook_units || [];
  const bestBid = units[0]?.bid_price ?? 0;
  const bestAsk = units[0]?.ask_price ?? 0;
  const mid = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;
  const spreadRatio = mid > 0 ? spread / mid : 0;
  const depthBid = units.slice(0, 5).reduce((s, u) => s + (parseFloat(u.bid_size) || 0), 0);
  const depthAsk = units.slice(0, 5).reduce((s, u) => s + (parseFloat(u.ask_size) || 0), 0);
  const total = depthBid + depthAsk;
  const strength = total > 0 ? depthBid / total : 0.5;
  const obi = total > 0 ? (depthBid - depthAsk) / total : 0;
  const kimpPct = market != null && state.kimpByMarket[market] != null ? state.kimpByMarket[market] : null;
  return {
    mid_price: mid,
    best_bid: bestBid,
    best_ask: bestAsk,
    last_trade_price: ticker.trade_price,
    spread_ratio: spreadRatio,
    spread_pct: spreadRatio * 100,
    topN_depth_bid: depthBid,
    topN_depth_ask: depthAsk,
    strength_proxy_60s: strength,
    strength_for_score: strength,
    strength_peak_60s: strength,
    obi_topN: obi,
    vol_now_krw_10s: 0,
    vol_baseline_krw_10s_used: 0,
    vol_surge_final: false,
    rest_latency_ms: null,
    ws_lag_ms: null,
    realized_slippage_bps_avg: null,
    spread_anomaly_blocked: false,
    flow_anomaly_blocked: false,
    kimp_pct: kimpPct
  };
}

const MIN_ORDER_KRW = configDefault.MIN_ORDER_KRW != null ? configDefault.MIN_ORDER_KRW : 5000;

/**
 * 회전 exit-first: symbolsToSell에 대해 시장가 매도만 수행. 같은 틱에 매수하지 않음.
 * @param {string[]} symbolsToSell - 매도할 코인 심볼 (BTC, ETH 등)
 * @returns {Promise<{ sold: string[], errors: string[] }>}
 */
async function executeRotationSell(symbolsToSell) {
  const sold = [];
  const errors = [];
  if (!symbolsToSell || symbolsToSell.length === 0) return { sold, errors };
  if (!apiKeys.accessKey || !apiKeys.secretKey) return { sold, errors };
  const accounts = state.accounts || [];
  for (const sym of symbolsToSell) {
    const market = 'KRW-' + sym;
    const acc = accounts.find((a) => (a.currency || '').toUpperCase() === sym.toUpperCase());
    const balance = acc ? parseFloat(acc.balance || 0) : 0;
    if (balance <= 0) continue;
    const volume = Math.floor(balance * 1e8) / 1e8;
    if (volume <= 0) continue;
    try {
      const order = await withUpbitFailover(async () => {
        const k = getActiveUpbitKeys();
        return TradeExecutor.placeMarketSellByVolume(k.accessKey, k.secretKey, market, volume);
      });
      const price = order && (order.price != null ? order.price : order.avg_price);
      tradeLogger.logTag('ROTATION_SELL', `${market} 회전 매도 (exit-first)`, { market, volume, price });
      sold.push(sym);
      state.assets = await fetchAssets();
      if (state.botEnabled && apiKeys.accessKey && apiKeys.secretKey) {
        try {
          state.accounts = await withUpbitFailover(async () => {
            const k = getActiveUpbitKeys();
            return upbit.getAccounts(k.accessKey, k.secretKey) || [];
          });
        } catch (_) {}
      }
    } catch (err) {
      errors.push(sym + ': ' + (err?.message || ''));
      tradeLogger.logTag('에러', 'Rotation sell 실패: ' + market, { error: err?.message });
    }
  }
  return { sold, errors };
}

/** 경주마 스케줄 반영 + state 동기화 (StrategyManager 단일 소스). 창 종료 시 회전 카운트 리셋 */
function updateRaceHorseState() {
  const wasActive = state.raceHorseActive;
  StrategyManager.updateRaceHorseFromSchedule();
  state.raceHorseActive = StrategyManager.isRaceHorseActive();
  if (wasActive && !state.raceHorseActive && raceHorsePolicy.resetSessionRotationCount) {
    raceHorsePolicy.resetSessionRotationCount();
  }
}

/**
 * 전 엔진 공통 현금 부족 락: orderableKrw < GLOBAL_MIN_BUYABLE_KRW 이면 신규 매수 전부 중단.
 * 활성/해제 시 각 1회만 로그·Discord 알림 (spam 방지).
 * cash lock은 persist 하지 않음 — 재기동 후 첫 자산 조회로 다시 계산.
 */
function updateCashLock(orderableKrw) {
  const krw = typeof orderableKrw === 'number' && Number.isFinite(orderableKrw) ? orderableKrw : 0;
  const lock = state.cashLock || {};
  const wasActive = lock.active === true;

  if (krw < GLOBAL_MIN_BUYABLE_KRW) {
    if (!wasActive) {
      state.cashLock = {
        active: true,
        reason: 'insufficient_krw',
        orderableKrw: krw,
        requiredKrw: GLOBAL_MIN_BUYABLE_KRW,
        since: Date.now(),
        notifiedAt: null
      };
      const msg = `남은 현금이 부족합니다. 충분한 현금이 매도를 통해 확보될 때까지 신규 매수 시도를 중단합니다. (주문가능 KRW: ${Math.floor(krw).toLocaleString('ko-KR')} / 필요 최소: ${GLOBAL_MIN_BUYABLE_KRW})`;
      tradeLogger.logTag('CashLock', msg, { orderableKrw: krw, requiredKrw: GLOBAL_MIN_BUYABLE_KRW });
      if (discordBot.sendToChannel) discordBot.sendToChannel('⚠️ ' + msg).catch(() => {});
      state.cashLock.notifiedAt = Date.now();
    } else {
      state.cashLock.orderableKrw = krw;
    }
  } else {
    if (wasActive) {
      const msg = `현금이 확보되어 신규 매수 잠금을 해제했습니다. (주문가능 KRW: ${Math.floor(krw).toLocaleString('ko-KR')})`;
      tradeLogger.logTag('CashLock', msg, { orderableKrw: krw });
      if (discordBot.sendToChannel) discordBot.sendToChannel('✅ ' + msg).catch(() => {});
    }
    state.cashLock = {
      active: false,
      reason: null,
      orderableKrw: krw,
      requiredKrw: GLOBAL_MIN_BUYABLE_KRW,
      since: null,
      notifiedAt: null
    };
  }
}

/** MPI 점수로 수량 배율 반환. 주문 시 최종 수량 = 기본 수량 * 이 배율 */
function getMpiMultiplierForMarket(market) {
  const sym = market.replace(/^KRW-/, '');
  const list = memeEngine.getAllMPI();
  const point = list && list.find((p) => p.symbol === sym);
  const mpi = point && point.mpi != null ? point.mpi : null;
  return { mpiScore: mpi, appliedMultiplier: scalpEngine.getMpiPositionMultiplier(mpi) };
}

/**
 * 기본 주문 금액(KRW)에 MPI 배율을 적용한 최종 수량 계산.
 * 최종 금액이 업비트 최소 주문(5,000원) 미만이면 진입하지 않음(skip).
 * @returns {{ quantity: number, quantityKrw: number, mpiScore: number|null, appliedMultiplier: number, skipReason?: string }}
 */
function computeOrderQuantityWithMpi(market, baseQuantityKrw, currentPrice) {
  const { mpiScore, appliedMultiplier } = getMpiMultiplierForMarket(market);
  const quantityKrw = baseQuantityKrw * appliedMultiplier;
  if (quantityKrw < MIN_ORDER_KRW || currentPrice == null || currentPrice <= 0) {
    return {
      quantity: 0,
      quantityKrw: 0,
      mpiScore: mpiScore ?? null,
      appliedMultiplier,
      skipReason: quantityKrw > 0 ? null : 'MIN_ORDER_KRW'
    };
  }
  const quantity = quantityKrw / currentPrice;
  return { quantity, quantityKrw, mpiScore: mpiScore ?? null, appliedMultiplier };
}

async function runScalpCycle() {
  try {
    const [tickers, orderbooks] = await Promise.all([
      upbit.getTickers(SCALP_MARKETS),
      upbit.getOrderbook(SCALP_MARKETS)
    ]);
    const tickerMap = {};
    (tickers || []).forEach(t => { tickerMap[t.market] = t; });
    const obMap = {};
    (orderbooks || []).forEach(ob => { obMap[ob.market] = ob; });

    const mpiList = memeEngine.getAllMPI();
    const mpiBySymbol = {};
    (mpiList || []).forEach((p) => { mpiBySymbol[p.symbol] = p.mpi; });

    const profile = scalpEngine.getProfile();
    const nextScalpState = {};
    state.lastSnapshots = state.lastSnapshots || {};

    let signalEngineResult = null;
    if (USE_SIGNAL_ENGINE && signalEngineFromBootstrap) {
      const contextByMarket = {};
      for (const m of SCALP_MARKETS) {
        const ticker = tickerMap[m];
        const snap = buildSnapshotFromOrderbook(obMap[m], ticker, m);
        if (snap) state.lastSnapshots[m] = snap;
        const cp = state.prices[m]?.tradePrice ?? ticker?.trade_price;
        if (cp != null) pushPrice(m, cp);
        contextByMarket[m] = {
          legacySnapshot: snap,
          prevHigh: getPrevHigh(m),
          currentPrice: cp,
          market: m,
          marketContext: profile.greedy_mode ? state.marketContext : null,
          availableKrw: state.assets?.orderableKrw ?? null
        };
      }
      signalEngineResult = signalEngineFromBootstrap.evaluateFromLegacy(contextByMarket);
    }

    for (const market of SCALP_MARKETS) {
      // 종목별 독립: RSI·볼린저·strength·OBI·entry pipeline 계산
      const sym = market.replace(/^KRW-/, '');
      const mpiScore = mpiBySymbol[sym] != null ? mpiBySymbol[sym] : null;
      const mpiMultiplier = scalpEngine.getMpiPositionMultiplier(mpiScore);

      const ticker = tickerMap[market];
      const snapshot = (USE_SIGNAL_ENGINE && signalEngineResult && state.lastSnapshots[market])
        ? state.lastSnapshots[market]
        : buildSnapshotFromOrderbook(obMap[market], ticker, market);
      if (snapshot) state.lastSnapshots[market] = snapshot;
      const currentPrice = state.prices[market]?.tradePrice ?? ticker?.trade_price;
      if (currentPrice != null) pushPrice(market, currentPrice);
      const prevHigh = getPrevHigh(market);

      if (!snapshot) {
        nextScalpState[market] = {
          entryScore: 0,
          p0GateStatus: 'BLOCK_LIQUIDITY',
          strength_proxy_60s: 0,
          mpiScore: mpiScore ?? null,
          mpiMultiplier,
          priceBreak: false,
          volSurge: false,
          strengthOk: false,
          obiOk: false
        };
        continue;
      }

      const marketContext = profile.greedy_mode ? state.marketContext : null;
      const orderableKrw = state.assets && state.assets.orderableKrw != null ? state.assets.orderableKrw : null;
      let pipeline;
      let legacyScore = null;
      if (signalEngineResult && signalEngineResult.byMarket[market]) {
        const res = signalEngineResult.byMarket[market];
        legacyScore = res.legacy != null && typeof res.legacy.score === 'number' ? res.legacy.score : null;
        pipeline = {
          score: res.decision.score,
          p0Allowed: res.legacy.p0Allowed,
          p0Reason: res.legacy.p0Reason,
          priceBreak: res.legacy.priceBreak,
          volSurge: res.legacy.volSurge,
          marketScore: res.legacy.marketScore,
          quantityMultiplier: res.legacy.quantityMultiplier
        };
        signalEvaluationLogger.logSignalEvaluation({
          market,
          legacyScore: legacyScore ?? pipeline.score,
          signalEngineScore: res.decision.score,
          finalDecision: pipeline.p0Allowed ? 'ALLOWED' : 'BLOCKED',
          blockReason: pipeline.p0Allowed ? null : [pipeline.p0Reason || 'p0'],
          path: 'signal-engine',
          ts: Date.now()
        });
      } else {
        pipeline = scalpEngine.runEntryPipeline(snapshot, prevHigh, currentPrice, market, marketContext, orderableKrw);
        signalEvaluationLogger.logSignalEvaluation({
          market,
          legacyScore: pipeline.score,
          signalEngineScore: null,
          finalDecision: pipeline.p0Allowed ? 'ALLOWED' : 'BLOCKED',
          blockReason: pipeline.p0Allowed ? null : [pipeline.p0Reason || 'p0'],
          path: 'legacy',
          ts: Date.now()
        });
      }
      const strength = snapshot.strength_proxy_60s != null ? snapshot.strength_proxy_60s : 0.5;
      const effectiveStrengthThreshold = scalpEngine.getEffectiveStrengthThreshold ? scalpEngine.getEffectiveStrengthThreshold(profile, market) : profile.strength_threshold;
      const strengthOk = strength >= (effectiveStrengthThreshold ?? profile.strength_threshold);
      const raceHorseScalpOverlap = !!(state.raceHorseActive && scalpRunner.getStatus?.()?.isRunning);
      const effectiveObiThreshold = scalpEngine.getEffectiveObiThreshold ? scalpEngine.getEffectiveObiThreshold(profile, market, raceHorseScalpOverlap) : profile.obi_threshold;
      const obiOk = (snapshot.obi_topN ?? 0) >= (effectiveObiThreshold ?? profile.obi_threshold);
      nextScalpState[market] = {
        entryScore: pipeline.score,
        p0GateStatus: pipeline.p0Allowed ? null : pipeline.p0Reason,
        strength_proxy_60s: strength,
        mpiScore: mpiScore ?? null,
        mpiMultiplier,
        priceBreak: !!pipeline.priceBreak,
        volSurge: !!pipeline.volSurge,
        strengthOk,
        obiOk,
        marketScore: pipeline.marketScore,
        quantityMultiplier: pipeline.quantityMultiplier
      };

      const effectiveEntryMin = scalpEngine.getEffectiveEntryScoreMin(profile.entry_score_min, market);
      if (state.botEnabled) {
        if (pipeline.score >= effectiveEntryMin) {
          if (!pipeline.p0Allowed) {
            const reasonMap = {
              BLOCK_KIMP: '김프과열',
              BLOCK_LATENCY: '지연초과',
              BLOCK_SPREAD: '스프레드불안',
              BLOCK_LIQUIDITY: '유동성부족',
              BLOCK_MARKET_CRASH: '시장 점수 미달(Score: ' + (pipeline.marketScore != null ? pipeline.marketScore : '—') + ')',
              MIN_ORDER_KRW: '최소 금액 미달'
            };
            const reasonText = reasonMap[pipeline.p0Reason] || pipeline.p0Reason || 'P0차단';
            let detailStr = '';
            if (pipeline.p0Reason === 'BLOCK_KIMP' && snapshot.kimp_pct != null) detailStr = snapshot.kimp_pct.toFixed(1) + '%';
            const reasonWithDetail = reasonText + (detailStr ? '(' + detailStr + ')' : '');
            const displayReason = '사유: ' + reasonWithDetail;
            const profileForReject = scalpEngine.getProfile();
            const rejectMsg = profileForReject.aggressive_mode ? ('Aggressive 모드 기각: ' + displayReason) : displayReason;
            recordReject(market, rejectMsg, pipeline.score);
          } else {
            if (orderableKrw != null && orderableKrw < MIN_ORDER_KRW) {
              recordReject(market, '최소 금액 미달', pipeline.score);
              continue;
            }
            const slippageBps = snapshot.realized_slippage_bps_avg;
            const slippageLimit = profile.slippage_shutdown_bps != null ? profile.slippage_shutdown_bps : 5;
            if (slippageBps != null && slippageBps > slippageLimit) {
              recordReject(market, '슬리피지초과', pipeline.score);
            } else {
              const price = currentPrice != null ? currentPrice : snapshot.last_trade_price;
              const multStr = pipeline.quantityMultiplier != null ? ` 비중×${pipeline.quantityMultiplier.toFixed(2)}` : '';
              tradeLogger.logTag('BUY_SIGNAL', `Score: ${pipeline.score}, Price: ${price != null ? price.toLocaleString('ko-KR') : '—'}${multStr}`, { market, score: pipeline.score, price, quantityMultiplier: pipeline.quantityMultiplier });
            }
          }
        }
      }
    }

    state.scalpState = nextScalpState;
  } catch (err) {
    tradeLogger.logTag('에러', 'SCALP cycle: ' + err.message);
    console.error('runScalpCycle error:', err.message);
  }
}

/**
 * fetchAssets/state.accounts 기준 보유 종목 중 SCALP_MARKETS에 대해 익절/손절/트레일링 등 전략 매도 감시.
 * 봇이 매수하지 않은 외부 자산(업비트 잔고)도 평균매입가로 포지션을 구성해 동일 전략 적용.
 * (독립 스캘프 봇이 해당 마켓을 보유 중이면 해당 마켓은 scalpRunner가 담당하므로 스킵)
 */
async function runExitPipeline() {
  if (!apiKeys.accessKey || !apiKeys.secretKey) return;
  // 진입 엔진이 꺼져 있어도 기존 포지션 청산은 허용 (스캘프 포지션 또는 메인 잔고)
  if (!state.botEnabled && !scalpRunner.getStatus?.()?.activePosition) return;
  const accounts = state.accounts || [];
  const snapshots = state.lastSnapshots || {};
  const pipelineScalpState = state.scalpState || {};
  const runnerStatus = scalpRunner.getStatus?.();
  const posByScalp = runnerStatus?.activePosition;
  const scalpMarket = posByScalp?.market;
  // 독립 스캘프가 해당 마켓을 보유·가동 중일 때만 메인 exit 스킵 (스캘프 tickExit가 담당). paused/정지 시 메인도 청산 가능
  const scalpRunningForMarket = !!(runnerStatus?.isRunning && scalpMarket);

  for (const market of SCALP_MARKETS) {
    if (scalpRunningForMarket && scalpMarket === market) continue;
    const currency = market.replace(/^KRW-/, '');
    const acc = accounts.find((a) => (a.currency || '').toUpperCase() === currency.toUpperCase());
    if (!acc) continue;
    const balance = parseFloat(acc.balance || 0);
    if (balance <= 0) continue;
    const snapshot = snapshots[market];
    if (!snapshot) continue;
    const currentPrice = state.prices[market]?.tradePrice ?? state.prices[market]?.trade_price;
    if (currentPrice == null || currentPrice <= 0) continue;
    const avgBuy = parseFloat(acc.avg_buy_price || 0);
    const entryPrice = avgBuy > 0 ? avgBuy : currentPrice;
    const position = {
      entryPrice,
      entryTimeMs: 0,
      highSinceEntry: currentPrice,
      strengthPeak60s: snapshot.strength_proxy_60s ?? snapshot.strength_peak_60s
    };
    const currentEntryScore = pipelineScalpState[market]?.entryScore ?? null;
    const { exit, reason } = ExitPolicy.evaluate(position, snapshot, currentPrice, currentEntryScore);
    if (!exit) continue;
    const volume = Math.floor(balance * 1e8) / 1e8;
    if (volume <= 0) continue;
    if (!ApiAccessPolicy.canPlaceOrder(state)) continue;
    try {
      const order = await withUpbitFailover(async () => {
        const k = getActiveUpbitKeys();
        return TradeExecutor.placeMarketSellByVolume(k.accessKey, k.secretKey, market, volume);
      });
      const executedPrice = order && (order.price != null ? order.price : order.avg_price);
      const exitPrice = executedPrice != null ? Number(executedPrice) : currentPrice;
      const totalBuyKrw = entryPrice * volume;
      const totalEvalKrw = exitPrice * volume;
      const math = require('./src/shared/utils/math');
      const exitProfitPct = math.calculateNetProfitPct(totalBuyKrw, totalEvalKrw, UPBIT_FEE_RATE);
      const exitProfitKrw = math.calculateNetProfitKrw(totalBuyKrw, totalEvalKrw, UPBIT_FEE_RATE);
      const entryTimeMs = acc.updated_at ? new Date(acc.updated_at).getTime() : null;
      const durationSec = entryTimeMs != null ? Math.round((Date.now() - entryTimeMs) / 1000) : 0;
      const durationStr = entryTimeMs != null
        ? (durationSec >= 3600 ? `${Math.floor(durationSec / 3600)}h ${Math.floor((durationSec % 3600) / 60)}m` : durationSec >= 60 ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s` : `${durationSec}s`)
        : '—';

      const label = TradeExecutor.getExitReasonLabel ? TradeExecutor.getExitReasonLabel(reason) : (reason || '청산');
      tradeLogger.logTag('EXIT', `${market} ${label}`, { market, reason, volume });
      state.assets = await fetchAssets();
      const exitRow = {
        timestamp: new Date().toISOString(),
        ticker: market,
        side: 'sell',
        price: exitPrice,
        quantity: volume,
        fee: 0,
        revenue: (exitPrice - entryPrice) * volume,
        net_return: exitProfitPct / 100,
        reason: label,
        strategy_id: state.currentStrategyId
      };
      exitRow.portfolioProfitPct = getProfitPct(state.assets);
      exitRow.exitProfitPct = exitProfitPct;
      exitRow.exitProfitKrw = exitProfitKrw;
      exitRow.exitPrice = exitPrice;
      exitRow.avgPrice = entryPrice;
      exitRow.duration = durationStr;
      exitRow.symbol = market.replace('KRW-', '');
      recordTrade(exitRow);
      if (state.accounts) {
        const idx = state.accounts.findIndex((a) => (a.currency || '').toUpperCase() === currency.toUpperCase());
        if (idx >= 0) state.accounts[idx] = { ...state.accounts[idx], balance: '0' };
      }
      emitDashboard().catch(() => {});
    } catch (e) {
      tradeLogger.logTag('에러', 'EXIT 매도 실패: ' + (e?.message || ''));
    }
  }
}

/** 동일 종목·동일 거절 사유 연속 시 중복 기록 방지 (last_reject_reason). 로그는 사유 변경 또는 마지막 출력 후 5분 시에만 1회 출력 */
const lastRejectBySymbol = Object.create(null);
const lastRejectLogAt = Object.create(null);
const REJECT_LOG_THROTTLE_MS = 5 * 60 * 1000;

/** 진입 조건 충족했으나 주문 미실행 사유 기록. 동일 사유 시 로그 생략, 사유 변경 또는 5분 경과 시에만 단일 로그 + DB */
function recordReject(ticker, reason, scoreAtReject) {
  const symbol = ticker || '';
  const r = reason || '';
  const now = Date.now();
  const lastReason = lastRejectBySymbol[symbol];
  const lastLogAt = lastRejectLogAt[symbol] || 0;

  if (r === lastReason) {
    if (now - lastLogAt < REJECT_LOG_THROTTLE_MS) return;
    tradeLogger.logTag('REJECT', `${symbol} ${r}`, { ticker: symbol, reason: r });
    lastRejectLogAt[symbol] = now;
    return;
  }
  lastRejectBySymbol[symbol] = r;
  lastRejectLogAt[symbol] = now;
  db.insertRejectLog({
    timestamp: new Date().toISOString(),
    ticker: symbol,
    reason: r,
    score_at_reject: scoreAtReject != null ? scoreAtReject : null
  }).catch((e) => console.error('recordReject:', e.message));
  tradeLogger.logTag('REJECT', `${symbol} ${r}`, { ticker: symbol, reason: r });
}

/**
 * 실제 체결 거래 기록: DB 저장 + 로그창 메시지 ([BUY_COMPLETE] / [EXIT])
 * row에 mpi_score, applied_multiplier 있으면 DB·로그에 반영.
 */
function recordTrade(row) {
  const r = { ...row, strategy_id: row.strategy_id ?? state.currentStrategyId };
  db.insertTrade(r).catch((e) => console.error('recordTrade:', e.message));
  try {
    const { EventBus } = require('./dist-refactor/packages/core/src/EventBus');
    EventBus.emit('ORDER_FILLED', {
      market: row.ticker,
      ticker: row.ticker,
      side: row.side,
      price: row.price,
      volume: row.quantity,
      reason: row.reason,
    });
  } catch (_) {}
  const side = (row.side || '').toLowerCase();
  const tag = row.is_test ? '수동/테스트' : (side === 'buy' ? 'BUY_COMPLETE' : 'EXIT');
  if (row.is_test) {
    const msg = side === 'buy'
      ? `[매수] ${row.ticker || '—'} ${row.quantity != null ? '수량 ' + row.quantity : ''} ${row.price != null ? row.price + '원' : ''}`
      : `[매도] ${row.ticker || '—'} ${row.quantity != null ? '수량 ' + row.quantity : ''} ${row.reason || ''}`;
    tradeLogger.logTag(tag, msg, { ticker: row.ticker, side, quantity: row.quantity, price: row.price, reason: row.reason });
    return;
  }
  if (side === 'buy') {
    let msg = `Ticker: ${row.ticker || '—'}`;
    if (row.quantity != null && row.applied_multiplier != null) {
      msg += ` 수량: ${row.quantity} (MPI ${row.applied_multiplier}배 적용)`;
    } else if (row.quantity != null) {
      msg += ` 수량: ${row.quantity}`;
    }
    tradeLogger.logTag('BUY_COMPLETE', msg, { ticker: row.ticker, quantity: row.quantity, applied_multiplier: row.applied_multiplier });
  } else if (side === 'sell') {
    const pct = row.net_return != null ? row.net_return.toFixed(2) : '—';
    tradeLogger.logTag('EXIT', `Reason: ${row.reason || '—'}, Profit: ${pct}%`, { reason: row.reason, net_return: row.net_return });
  }
  if (discordBot.sendTradeAlert) {
    const pct = row.portfolioProfitPct != null ? row.portfolioProfitPct : (row.net_return != null ? row.net_return * 100 : undefined);
    discordBot.sendTradeAlert({
      ticker: row.ticker,
      side: row.side,
      price: row.price,
      quantity: row.quantity,
      currentReturnPct: pct,
      profitPct: row.exitProfitPct,
      profitKrw: row.exitProfitKrw,
      exitPrice: row.exitPrice,
      avgPrice: row.avgPrice,
      duration: row.duration,
      symbol: row.symbol
    }).catch(() => {});
  }
  try {
    tradeHistoryLogger.appendTradeHistory(row, { rsi: row.rsi, trend_score: row.trend_score });
  } catch (_) {}
}

async function fetchTrades() {
  if (!apiKeys.accessKey || !apiKeys.secretKey) return [];
  try {
    const all = await withUpbitFailover(async () => {
      const k = getActiveUpbitKeys();
      const out = [];
      for (const market of SCALP_MARKETS) {
        const orders = await upbit.getRecentOrders(k.accessKey, k.secretKey, market, 5);
        out.push(...(orders || []).map((o) => ({
          uuid: o.uuid,
          market: o.market,
          side: o.side,
          ord_type: o.ord_type,
          price: o.price || o.avg_price,
          volume: o.volume || o.executed_volume,
          state: o.state,
          created_at: o.created_at,
          executed_at: o.executed_at
        })));
      }
      out.sort((a, b) => new Date(b.executed_at || b.created_at || 0) - new Date(a.executed_at || a.created_at || 0));
      return out.slice(0, 10);
    });
    return all;
  } catch (err) {
    console.error('fetchTrades error:', err.message);
    return state.trades;
  }
}

/** 대시보드 로그: [BUY_COMPLETE], [EXIT], [에러]만 전송. [BUY_SIGNAL]/BLOCK_* 판단 로그는 제외 */
function getFilteredLogsForDashboard() {
  const raw = tradeLogger.getRecentLogs();
  return raw.filter((line) => {
    if (line.includes('[BUY_COMPLETE]') || line.includes('[EXIT]') || line.includes('[에러]') || line.includes('[ERROR]')) return true;
    if (line.includes('[BUY_SIGNAL]') || /\[BLOCK_[^\]]*\]/.test(line)) return false;
    return false;
  });
}

async function emitDashboard() {
  try {
    state.trades = await db.getRecentTrades(10);
    state.rejectLogs = await db.getRecentRejectLogs(20);
  } catch (e) {}
  const assets = state.assets;
  const totalBuyKrw = assets?.totalBuyKrwForCoins ?? assets?.totalBuyKrw ?? 0;
  const totalEvalCoins = assets?.evaluationKrwForCoins ?? 0;
  const profitPct = getProfitPct(assets);
  const profitKrw = totalEvalCoins - totalBuyKrw;
  state.lastEmit = {
    assets: state.assets,
    profitSummary: { totalEval: totalEvalCoins, totalBuyKrw, profitKrw, profitPct },
    modeRemaining: getModeRemainingOpts(),
    prices: state.prices,
    fng: state.fng,
    botEnabled: state.botEnabled,
    trades: state.trades,
    rejectLogs: state.rejectLogs,
    scalpState: state.scalpState,
    marketContext: state.marketContext,
    wsLagMs: state.wsLagMs,
    logs: getFilteredLogsForDashboard(),
    fxUsdKrw: state.fxUsdKrw,
    kimpAvg: state.kimpAvg,
    kimpByMarket: state.kimpByMarket,
    raceHorseActive: state.raceHorseActive,
    independentScalpStatus: scalpRunner.getStatus(state),
    cashLock: state.cashLock
  };
  io.emit('dashboard', state.lastEmit);
  if (discordBot.updateStatusMessage) {
    const aggressiveSymbols = scalpEngine.getAggressiveSymbols();
    const gemini = require('./lib/gemini');
    const statusEmbed = buildCurrentStateEmbed(state.assets, state.strategySummary || {}, {
      isEngineRunning: state.botEnabled,
      raceHorseStatusLabel: getRaceHorseStatusLabel(state.raceHorseActive),
      aggressiveSymbols,
      relaxedModeLabel: getRelaxedModeLabel(),
      aiUsage: gemini.getDailyUsage ? gemini.getDailyUsage() : null,
      ...getModeRemainingOpts()
    });
    discordBot.updateStatusMessage(statusEmbed, aggressiveSymbols).catch(() => {});
  }
}

(async () => {
  try {
    const list = await upbit.getTickers(SCALP_MARKETS);
    (list || []).forEach(t => {
      state.prices[t.market] = {
        market: t.market,
        tradePrice: t.trade_price,
        signedChangeRate: t.signed_change_rate,
        timestamp: t.timestamp ? new Date(t.timestamp).toISOString() : new Date().toISOString()
      };
      pushPrice(t.market, t.trade_price);
    });
  } catch (e) {}
})();

upbitWs.subscribeTicker(SCALP_MARKETS, (tick) => {
  state.prices[tick.market] = tick;
  if (tick.wsLagMs != null) state.wsLagMs = tick.wsLagMs;
  pushPrice(tick.market, tick.tradePrice);
  emitDashboard().catch((e) => console.error('emitDashboard:', e.message));
}, (err) => {
  tradeLogger.logTag('에러', 'Upbit WS: ' + (err && err.message));
  if (discordBot.sendErrorAlert) discordBot.sendErrorAlert('Upbit WebSocket 오류', err && err.message).catch(() => {});
});

fetchFx().catch(() => {});
fetchBinance().catch(() => {});

const MARKET_ANALYZER_REP = 'KRW-BTC';
const MEDIUM_TERM_MS = 60 * 1000;
const DAILY_TERM_MS = 5 * 60 * 1000;
const CLEANUP_INTERVAL_MS = configDefault.CLEANUP_INTERVAL_MS != null ? configDefault.CLEANUP_INTERVAL_MS : 4 * 60 * 60 * 1000;
const TMP_DIR = path.join(__dirname, 'tmp');
const CLEANUP_HOUR_4AM = 4;

const tradingEngine = new TradingEngine(EngineStateStore, {
  ASSET_POLL_MS,
  FX_POLL_MS,
  MEDIUM_TERM_MS,
  DAILY_TERM_MS,
  PERSIST_MS: 60 * 1000,
  REJECT_EMIT_MS: 1000,
  CLEANUP_INTERVAL_MS,
  CLEANUP_HOUR_4AM
});

const RECOVERY_FETCH_INTERVAL_MS = 10 * 1000;

async function runOneTick() {
  const mode = ApiAccessPolicy.refreshEngineMode(EngineStateStore);
  if (mode === EngineMode.EMERGENCY_PAUSE) {
    if (typeof io !== 'undefined' && io.emit) io.emit('dashboard:state', EngineStateStore.get()).catch(() => {});
    return;
  }
  updateRaceHorseState();
  if (mode === EngineMode.RECOVERY) {
    const now = Date.now();
    const last = state.lastRecoveryFetchAt ?? 0;
    if (now - last >= RECOVERY_FETCH_INTERVAL_MS) {
      state.assets = await fetchAssets();
      EngineStateStore.update({ lastRecoveryFetchAt: now });
    }
  } else {
    state.assets = await fetchAssets();
  }
  if (state.botEnabled && apiKeys.accessKey && apiKeys.secretKey) {
    try {
      state.accounts = await withUpbitFailover(async () => {
        const k = getActiveUpbitKeys();
        return upbit.getAccounts(k.accessKey, k.secretKey) || [];
      });
    } catch (_) {
      state.accounts = state.accounts || [];
    }
  } else {
    state.accounts = state.accounts || [];
  }
  updateCashLock(state.assets?.orderableKrw ?? 0);
  state.fng = await fetchFng();
  state.trades = await db.getRecentTrades(10);
  computeKimp();
  await runScalpCycle();
  await runExitPipeline();

  if (positionEngineFromBootstrap && state.assets) {
    const fromPosition = positionEngineFromBootstrap.getProfitFromAssets(state.assets);
    const fromLegacy = getProfitPct(state.assets);
    const diff = Math.abs((fromPosition.profitPct ?? 0) - (fromLegacy ?? 0));
    if (diff > 0.001) {
      console.warn('[수익률 정합성] PositionEngine vs getProfitPct 불일치:', { positionEngine: fromPosition.profitPct, legacy: fromLegacy, diff });
    }
  }

  const mpiList = memeEngine.getAllMPI();
  const mpiBySymbol = {};
  (mpiList || []).forEach((p) => { mpiBySymbol[p.symbol] = p.mpi; });
  const orchCtx = {
    scalpState: state.scalpState,
    profile: scalpEngine.getProfile(),
    regimeLines: regimeDetector.readLastLines(32),
    mpiBySymbol,
    accounts: state.accounts,
    assets: state.assets,
    recentTrades: state.trades || [],
    wsLagMs: state.wsLagMs
  };
  const orchResult = orchestrator.tick(orchCtx);
  state.lastOrchestratorResult = orchResult;

  try {
    const decisionLog = orchestrator.getDecisionLog();
    const history = orchestrator.readHistoryLines(20);
    const p0Summary = (state.scalpState && typeof state.scalpState === 'object')
      ? Object.entries(state.scalpState).map(([m, s]) => ({ market: m, p0Allowed: s?.pipeline?.p0Allowed, p0Reason: s?.pipeline?.p0Reason })).filter((e) => e.p0Allowed === false || e.p0Reason)
      : [];
    const decisionSummary30Min = orchestrator.getDecisionSummary30Min(decisionLog || []);
    io.emit('orchestrator:update', {
      decisionLog: decisionLog || [],
      decisionSummary30Min: decisionSummary30Min || [],
      history: history || [],
      lastResult: { action: orchResult.action, chosenStrategy: orchResult.chosenStrategy, finalScore: orchResult.finalScore, reason: orchResult.reason, signal: orchResult.signal },
      scalpSignal: orchCtx.scalpState ? (require('./lib/strategy/scalpSignalProvider').getBestScalpSignal(state.scalpState, scalpEngine.getProfile(), scalpEngine.getProfile()?.entry_score_min)) : null,
      regimeSignal: (require('./lib/strategy/regimeSignalProvider').getBestRegimeSignal(regimeDetector.readLastLines(32), mpiBySymbol)),
      p0Summary
    });
  } catch (e) { /* non-fatal */ }

  if (state.botEnabled && orchResult.action === 'ENTER' && orchResult.signal && apiKeys.accessKey && apiKeys.secretKey) {
    if (state.cashLock?.active) {
      tradeLogger.logTag('거절', 'Cash lock: 신규 매수 중단', { orderableKrw: state.cashLock.orderableKrw, requiredKrw: state.cashLock.requiredKrw });
    } else if (scalpState.priorityOwner === 'SCALP') {
      // 독립 스캘프 봇 가동 중: 메인 오케스트레이터 진입 차단 (우선권 탈취)
    } else {
      const market = 'KRW-' + orchResult.signal.symbol;
      const symbol = orchResult.signal?.symbol || market.replace('KRW-', '');
      const isRaceHorseTimeWindow = StrategyManager.isRaceHorseTimeWindow();
      if (state.raceHorseActive && isRaceHorseTimeWindow && !raceHorsePolicy.isSymbolAllowedForRaceHorse(symbol)) {
        tradeLogger.logTag('거절', '경주마: 허용 코인 아님 (BTC/ETH/SOL/XRP만)', { symbol });
      } else {
      const profile = scalpEngine.getProfile();
      const positionSymbols = (state.accounts || [])
        .filter((a) => (a.currency || '').toUpperCase() !== 'KRW' && parseFloat(a.balance || 0) > 0)
        .map((a) => (a.currency || '').toUpperCase());
      const holdingAllowed = (positionSymbols || []).filter((s) => raceHorsePolicy.isSymbolAllowedForRaceHorse(s));
      let rotationBlock = false;
      let multiAction = null;
      if (state.raceHorseActive && isRaceHorseTimeWindow && holdingAllowed.length > 0) {
        const signalsBySymbol = { [symbol]: { signal: orchResult.signal, finalScore: orchResult.finalScore } };
        const rankedUniverse = raceHorsePolicy.rankRaceHorseUniverse(state.scalpState, signalsBySymbol, profile?.entry_score_min ?? 4);
        const lastEntryBySymbol = typeof orchestrator.getLastEntryBySymbol === 'function' ? orchestrator.getLastEntryBySymbol() : {};
        const now = Date.now();
        const holdSecondsBySymbol = {};
        const holdingScoreDecayBySymbol = {};
        const entryMin = profile?.entry_score_min ?? 4;
        holdingAllowed.forEach((s) => {
          holdSecondsBySymbol[s] = (now - (lastEntryBySymbol[s] || 0)) / 1000;
          const m = 'KRW-' + s;
          const entryScore = state.scalpState && state.scalpState[m] ? (state.scalpState[m].entryScore ?? entryMin) : entryMin;
          holdingScoreDecayBySymbol[s] = entryScore < entryMin ? Math.min(1, (entryMin - entryScore) / Math.max(1, entryMin)) : 0;
        });
        const rotCtx = {
          rankedUniverse,
          holdSecondsBySymbol,
          holdingScoreDecayBySymbol,
          profile,
          scalpState: state.scalpState,
          accounts: state.accounts
        };
        multiAction = raceHorsePolicy.decideMultiPositionAction(holdingAllowed, rankedUniverse, rotCtx);
        if ((multiAction.action === 'FULL_SWITCH_ONE_ASSET' || multiAction.action === 'REDUCE_WEAKER_ADD_WINNER') && multiAction.toSymbol === symbol) {
          await executeRotationSell(multiAction.symbolsToSell || []);
          state.rotationDidExitFirst = { toSymbol: multiAction.toSymbol, at: Date.now() };
          tradeLogger.logTag('ROTATION', 'exit-first 완료, 이번 틱 매수 없음', { action: multiAction.action, sold: multiAction.symbolsToSell, toSymbol: multiAction.toSymbol });
          rotationBlock = true;
        } else if (multiAction.action === 'HOLD_ALL' && multiAction.toSymbol !== symbol) {
          tradeLogger.logTag('거절', '경주마: HOLD_ALL, 회전 미허용', { toSymbol: multiAction.toSymbol, signalSymbol: symbol, reason: multiAction.reason });
          rotationBlock = true;
        } else if (multiAction.action === 'NO_ACTION' && !holdingAllowed.includes(symbol)) {
          rotationBlock = true;
        }
      }
      const isRotationEnter = state.raceHorseActive && isRaceHorseTimeWindow && holdingAllowed.length > 0 && !holdingAllowed.includes(symbol) && !rotationBlock;
      if (!rotationBlock) {
      state.assets = await fetchAssets();
      const orderableKrw = state.assets?.orderableKrw ?? 0;
      const currentPrice = state.prices[market]?.tradePrice ?? state.prices[market]?.trade_price ?? null;
      const totalCoinEval = state.assets?.evaluationKrwForCoins ?? Math.max(0, (state.assets?.totalEvaluationKrw ?? 0) - (orderableKrw || 0));
      const scalpStateEntry = state.scalpState && state.scalpState[market] ? state.scalpState[market] : null;
      const snapshotForTier = state.lastSnapshots && state.lastSnapshots[market] ? state.lastSnapshots[market] : null;
      const raceHorseTier = (state.raceHorseActive && isRaceHorseTimeWindow)
        ? raceHorsePolicy.evaluateRaceHorseConviction(orchResult.signal, orchResult.finalScore, scalpStateEntry, { symbol, snapshot: snapshotForTier })
        : null;
      const { amountKrw, raceHorseTier: tier, skipReason } = scalpEngine.getBuyOrderAmountKrw({
        orderableKrw,
        totalCoinEval,
        isRaceHorseMode: state.raceHorseActive,
        isRaceHorseTimeWindow,
        raceHorseTier,
        minOrderKrw: MIN_ORDER_KRW,
        symbol
      });
      if (skipReason === 'RACE_HORSE_BLOCKED') {
        tradeLogger.logTag('거절', '경주마: BLOCKED(매수 금지)', { market, tier });
      }
      const useRaceHorseSizing = tier === 'FULL_50' || tier === 'MEDIUM_25' || tier === 'LIGHT_10';
      const aggressiveMult = scalpEngine.getSymbolWeightMultiplier(symbol);
      const baseKrwForOrder = amountKrw <= 0 ? 0 : (useRaceHorseSizing ? amountKrw : amountKrw * aggressiveMult);
      let quantityKrw = baseKrwForOrder <= 0
        ? 0
        : useRaceHorseSizing
          ? amountKrw
          : computeOrderQuantityWithMpi(market, baseKrwForOrder, currentPrice).quantityKrw;
      if (orderableKrw > 0 && quantityKrw * (1 + UPBIT_FEE_RATE) > orderableKrw) {
        quantityKrw = Math.min(quantityKrw, Math.floor(orderableKrw / (1 + UPBIT_FEE_RATE)));
      }
      if (quantityKrw >= (configDefault.MIN_ORDER_KRW || 5000)) {
        const useRiskExecution = USE_SIGNAL_ENGINE && riskEngineFromBootstrap && executionEngineFromBootstrap;
        const decision = state.scalpState[market]?.pipeline?.decision || { side: 'LONG', market };
        if (useRiskExecution) {
          const riskContext = {
            snapshot: state.lastSnapshots?.[market],
            profile: scalpEngine.getProfile(),
            assets: state.assets,
            accounts: state.accounts || [],
            budgetKrw: quantityKrw
          };
          const verdict = riskEngineFromBootstrap.evaluate(decision, riskContext);
          if (!verdict.allowed) {
            tradeLogger.logTag('Risk', 'Risk Rejected: ' + (verdict.reasons?.join(', ') || 'UNKNOWN'));
            if (discordBot.sendToChannel) {
              discordBot.sendToChannel('🛑 Risk Rejected: ' + (verdict.reasons?.join(', ') || 'UNKNOWN')).catch(() => {});
            }
          } else if (!ApiAccessPolicy.canPlaceOrder(state)) {
            tradeLogger.logTag('거절', 'Orchestrator ENTER (Risk): PAUSE/RECOVERY로 주문 불가', { market });
          } else {
            try {
              const plan = { mode: 'MARKET', market, budgetKrw: Math.round(quantityKrw), slices: [{ ratio: 1, type: 'MARKET' }], maxSlippageBp: 50 };
              const k = getActiveUpbitKeys();
              const result = await executionEngineFromBootstrap.execute(plan, k, { orderableKrw });
              const order = result.success ? result.order : null;
              const price = order && (order.price != null ? order.price : order.avg_price);
              const volume = order && (order.executed_volume != null ? order.executed_volume : order.volume);
              if (result.success && order) {
                recordTrade({
                  timestamp: new Date().toISOString(),
                  ticker: market,
                  side: 'buy',
                  price: price ?? 0,
                  quantity: volume ?? 0,
                  fee: 0,
                  revenue: 0,
                  net_return: 0,
                  reason: 'ORCH_' + (orchResult.chosenStrategy || 'ENTER'),
                  strategy_id: state.currentStrategyId
                });
                orchestrator.recordEntry(orchResult.signal.symbol, orchResult.chosenStrategy);
                if ((isRotationEnter || (state.rotationDidExitFirst && state.rotationDidExitFirst.toSymbol === symbol)) && raceHorsePolicy.incrementSessionRotationCount) {
                  raceHorsePolicy.incrementSessionRotationCount();
                  if (state.rotationDidExitFirst) delete state.rotationDidExitFirst;
                }
                state.assets = await fetchAssets();
                emitDashboard().catch(() => {});
              } else if (!result.success) {
                tradeLogger.logTag('에러', 'ExecutionEngine 주문 실패: ' + (result.error || ''));
                if (discordBot.sendErrorAlert) discordBot.sendErrorAlert('매수 실패', result.error).catch(() => {});
              }
            } catch (err) {
              const isInsufficient = err?.code === 'INSUFFICIENT_FUNDS_BID' || (err?.message && String(err.message).includes('INSUFFICIENT_FUNDS_BID'));
              tradeLogger.logTag('에러', 'Orchestrator ENTER 주문 실패: ' + (err?.message || ''));
              if (isInsufficient && discordBot.sendToChannel) {
                discordBot.sendToChannel('⚠️ 잔액 부족으로 매수 건너뜀 (주문가능KRW 부족)').catch(() => {});
              } else if (!isInsufficient && discordBot.sendErrorAlert) {
                discordBot.sendErrorAlert('오케스트레이터 매수 실패', err?.message).catch(() => {});
              }
            }
          }
        } else {
          if (!ApiAccessPolicy.canPlaceOrder(state)) {
            tradeLogger.logTag('거절', 'Orchestrator ENTER: PAUSE/RECOVERY로 주문 불가', { market });
          } else {
          try {
            const order = await withUpbitFailover(() => {
              const k = getActiveUpbitKeys();
              return TradeExecutor.placeMarketBuyByPrice(k.accessKey, k.secretKey, market, Math.round(quantityKrw), orderableKrw);
            });
            const price = order && (order.price != null ? order.price : order.avg_price);
            const volume = order && (order.executed_volume != null ? order.executed_volume : order.volume);
            recordTrade({
            timestamp: new Date().toISOString(),
            ticker: market,
            side: 'buy',
            price: price ?? 0,
            quantity: volume ?? 0,
            fee: 0,
            revenue: 0,
            net_return: 0,
            reason: 'ORCH_' + (orchResult.chosenStrategy || 'ENTER'),
            strategy_id: state.currentStrategyId
          });
          orchestrator.recordEntry(orchResult.signal.symbol, orchResult.chosenStrategy);
          if ((isRotationEnter || (state.rotationDidExitFirst && state.rotationDidExitFirst.toSymbol === symbol)) && raceHorsePolicy.incrementSessionRotationCount) {
            raceHorsePolicy.incrementSessionRotationCount();
            if (state.rotationDidExitFirst) delete state.rotationDidExitFirst;
          }
          state.assets = await fetchAssets();
          emitDashboard().catch(() => {});
        } catch (err) {
          const isInsufficient = err?.code === 'INSUFFICIENT_FUNDS_BID' || (err?.message && String(err.message).includes('INSUFFICIENT_FUNDS_BID'));
          tradeLogger.logTag('에러', 'Orchestrator ENTER 주문 실패: ' + (err?.message || ''));
          if (isInsufficient && discordBot.sendToChannel) {
            discordBot.sendToChannel('⚠️ 잔액 부족으로 매수 건너뜀 (주문가능KRW 부족)').catch(() => {});
          } else if (!isInsufficient && discordBot.sendErrorAlert) {
            discordBot.sendErrorAlert('오케스트레이터 매수 실패', err?.message).catch(() => {});
          }
        }
          }
      }
      } else if (quantityKrw > 0 && quantityKrw < (configDefault.MIN_ORDER_KRW || 5000)) {
        tradeLogger.logTag('거절', 'Orchestrator ENTER: 주문가능KRW 부족으로 매수 스킵 (최소주문금액 미달)', { market, quantityKrw, orderableKrw });
        if (discordBot.sendToChannel) discordBot.sendToChannel('⚠️ 잔액 부족으로 매수 건너뜀 (최소 주문금액 미달)').catch(() => {});
      }
      }
      }
    }
  }

  // 청산은 항상 허용: 스캘프 포지션이 있으면 엔진 on/off 무관하게 tickExit 호출 (어느 봇이 매수했든 매도 가능)
  const scalpCtx = {
    upbit,
    state,
    apiKeys,
    TradeExecutor,
    recordTrade,
    emitDashboard,
    sendAlert: (msg) => { if (discordBot.sendToChannel) discordBot.sendToChannel(msg).catch(() => {}); },
    lastEntryBySymbol: (typeof orchestrator.getLastEntryBySymbol === 'function' ? orchestrator.getLastEntryBySymbol() : {}),
    recordEntryForCooldown: (symbol) => { if (symbol && typeof orchestrator.recordEntry === 'function') orchestrator.recordEntry(symbol, 'SCALP'); }
  };
  if (scalpState.activePosition) {
    try {
      await scalpRunner.tickExit(scalpCtx);
    } catch (e) {
      console.warn('scalpRunner.tickExit:', e?.message);
    }
  }
  if (state.scalpMode && scalpState.isRunning) {
    try {
      await scalpRunner.tick(scalpCtx);
      if (!scalpState.isRunning) EngineStateStore.update({ scalpMode: false });
    } catch (e) {
      console.warn('scalpRunner.tick:', e?.message);
    }
  }
}

function runDbCleanup() {
  db.cleanupOldNonTrades(4).then((deleted) => {
    if (deleted > 0) console.log(`DB Cleanup: ${deleted}개의 불필요한 로그를 삭제했습니다.`);
  }).catch((e) => console.error('runDbCleanup:', e.message));
}

let lastCleanupDate = null;
function getTradingEngineCallbacks() {
  return {
    runOneTick,
    runFx: () => {
      fetchFx().catch(() => {});
      fetchBinance().catch(() => {});
    },
    runMarketAnalyzerMedium: async () => {
      try {
        const profile = scalpEngine.getProfile();
        const maxBet = profile.max_bet_multiplier != null ? profile.max_bet_multiplier : 2;
        state.marketContext = await MarketAnalyzer.tickMediumTerm(MARKET_ANALYZER_REP, maxBet);
      } catch (e) {}
    },
    runMarketAnalyzerDaily: async () => {
      try {
        const profile = scalpEngine.getProfile();
        const maxBet = profile.max_bet_multiplier != null ? profile.max_bet_multiplier : 2;
        state.marketContext = await MarketAnalyzer.tickDaily(MARKET_ANALYZER_REP, maxBet);
      } catch (e) {}
    },
    runPersist: persistSystemState,
    runRejectEmit: () => {
      (async () => {
        try {
          state.rejectLogs = await db.getRecentRejectLogs(20);
        } catch (e) {}
        if (state.lastEmit) {
          computeKimp();
          state.lastEmit.logs = getFilteredLogsForDashboard();
          state.lastEmit.scalpState = state.scalpState;
          state.lastEmit.wsLagMs = state.wsLagMs;
          state.lastEmit.assets = state.assets;
          const a = state.assets;
          const tb = Math.floor(Number(a?.totalBuyKrwForCoins ?? a?.totalBuyKrw ?? 0));
          const teCoins = Math.floor(Number(a?.evaluationKrwForCoins ?? 0));
          const profitPctNum = getProfitPct(a);
          state.lastEmit.profitSummary = { totalEval: teCoins, totalBuyKrw: tb, profitKrw: teCoins - tb, profitPct: tb > 0 ? profitPctNum : 0 };
          state.lastEmit.prices = state.prices;
          state.lastEmit.fng = state.fng;
          state.lastEmit.trades = state.trades;
          state.lastEmit.rejectLogs = state.rejectLogs;
          state.lastEmit.marketContext = state.marketContext;
          state.lastEmit.botEnabled = state.botEnabled;
          state.lastEmit.raceHorseActive = state.raceHorseActive;
          state.lastEmit.fxUsdKrw = state.fxUsdKrw;
          state.lastEmit.kimpAvg = state.kimpAvg;
          state.lastEmit.kimpByMarket = state.kimpByMarket;
          if (state.strategySummary) {
            state.strategySummary.strategyName = state.raceHorseActive ? 'RaceHorse' : (state.strategySummary.aggressive_mode ? 'Aggressive' : (state.strategySummary.race_horse_scheduler_enabled ? 'RaceHorse(예약)' : 'SCALP 기본'));
          }
          state.lastEmit.strategySummary = state.strategySummary;
          state.lastEmit.modeRemaining = getModeRemainingOpts();
          state.lastEmit.independentScalpStatus = scalpRunner.getStatus(state);
          state.lastEmit.cashLock = state.cashLock;
          io.emit('dashboard', state.lastEmit);
        }
      })();
    },
    runCleanup: runDbCleanup,
    run4AmCheck: () => {
      const now = new Date();
      const kstHour = (now.getUTCHours() + 9) % 24;
      const today = now.toISOString().slice(0, 10);
      if (kstHour === CLEANUP_HOUR_4AM && lastCleanupDate !== today) {
        lastCleanupDate = today;
        performSystemCleanup().catch((e) => console.warn('[Cleanup] 스케줄 실행 오류:', e?.message));
      }
    },
    emitDashboard: () => emitDashboard(),
    onPollError: (err) => console.error('poll error:', err?.message),
    setAbortController: (controller) => {
      if (controller) upbit.setAbortSignal(controller.signal);
      else upbit.clearAbortSignal();
    }
  };
}

// 거절 로그 4시간 단위 삭제: Logger 모듈에서 스케줄 (단일 책임)
tradeLogger.scheduleRejectLogCleanup(db, CLEANUP_INTERVAL_MS, configDefault.REJECT_LOG_CUTOFF_HOURS);
tradeLogger.scheduleMemoryCleanup(CLEANUP_INTERVAL_MS);

/**
 * 시스템 최적화: tmp/ 삭제, 오래된 로그·거래이력·임시 라벨 정리. 매일 4시 실행 (TradingEngine run4AmCheck).
 * @returns {Promise<{ freedBytes: number }>}
 */
async function performSystemCleanup() {
  // 매일 새벽 4시: 새 달 예산 갱신 또는 수동 결제 복구 시 AI 재시도
  EngineStateStore.update({ geminiEnabled: true });
  let freedBytes = 0;
  try {
    if (fs.existsSync(TMP_DIR) && fs.statSync(TMP_DIR).isDirectory()) {
      const files = fs.readdirSync(TMP_DIR);
      for (const f of files) {
        const full = path.join(TMP_DIR, f);
        try {
          const stat = fs.statSync(full);
          if (stat.isFile()) {
            freedBytes += stat.size;
            fs.unlinkSync(full);
          }
        } catch (_) {}
      }
    }
    if (typeof tradeLogger.truncateLogsOlderThanDays === 'function') {
      const logLinesRemoved = tradeLogger.truncateLogsOlderThanDays(7);
      freedBytes += logLinesRemoved * 200;
    }
    if (typeof tradeHistoryLogger.trimTradeHistoryOlderThanDays === 'function') {
      const tradeLinesRemoved = tradeHistoryLogger.trimTradeHistoryOlderThanDays(30);
      freedBytes += tradeLinesRemoved * 300;
    }
    if (typeof tradeHistoryLogger.cleanupTemporaryLabelsOlderThanHours === 'function') {
      const labelLinesRemoved = tradeHistoryLogger.cleanupTemporaryLabelsOlderThanHours(24);
      freedBytes += labelLinesRemoved * 250;
    }
    if (typeof tradeHistoryLogger.trimStrategyMemoryToMax === 'function') {
      const memoryLinesRemoved = tradeHistoryLogger.trimStrategyMemoryToMax();
      freedBytes += memoryLinesRemoved * 150;
    }
    const freedMB = (freedBytes / (1024 * 1024)).toFixed(2);
    console.log('[Cleanup] 시스템 최적화 완료, 약', freedMB, 'MB 정리됨');
    if (discordBot && typeof discordBot.sendToChannel === 'function' && apiKeys.discordChannelId) {
      discordBot.sendToChannel(`🧹 시스템 최적화 완료: ${freedMB}MB 정리됨`).catch(() => {});
    }
  } catch (e) {
    console.warn('[Cleanup] performSystemCleanup:', e?.message);
  }
  return { freedBytes };
}

io.on('connection', (socket) => {
  emitDashboard().catch((e) => console.error('emitDashboard:', e.message));
  socket.emit('dashboard', {
    ...state.lastEmit,
    logs: getFilteredLogsForDashboard(),
    scalpState: state.scalpState
  });
  socket.on('setBot', (enabled) => {
    state.botEnabled = !!enabled;
    emitDashboard().catch((e) => console.error('emitDashboard:', e.message));
  });
  socket.on('updateConfig', (payload, cb) => {
    if (!payload || typeof payload !== 'object') return;
    const p = payload;
    const overrides = {};
    if (p.kimp_block_pct != null) {
      const k = parseFloat(p.kimp_block_pct);
      if (!Number.isNaN(k)) overrides.kimp_block_pct = Math.min(20, Math.max(0.5, k));
    } else {
      overrides.kimp_block_pct = p.p0_kimp_block !== false ? 3 : 999;
    }
    if (p.max_latency_ms != null) {
      const ms = parseInt(p.max_latency_ms, 10);
      if (!Number.isNaN(ms) && ms > 0) {
        const val = Math.min(10000, Math.max(100, ms));
        overrides.rest_latency_ms_max = val;
        overrides.ws_lag_ms_max = Math.min(10000, val * 3);
      }
    } else {
      overrides.rest_latency_ms_max = p.p0_lag_block !== false ? 500 : 999999;
      overrides.ws_lag_ms_max = p.p0_lag_block !== false ? 1500 : 999999;
    }
    if (p.slippage_tolerance_pct != null) {
      const s = parseFloat(p.slippage_tolerance_pct);
      if (!Number.isNaN(s) && s >= 0) overrides.slippage_tolerance_pct = Math.min(0.02, s / 100);
    }
    const clampWeight = (x) => (x != null && !Number.isNaN(parseFloat(x)) && parseFloat(x) >= 0 ? Math.min(3, parseFloat(x)) : undefined);
    if (p.weight_price_break != null) overrides.weight_price_break = clampWeight(p.weight_price_break);
    if (p.weight_vol_surge != null) overrides.weight_vol_surge = clampWeight(p.weight_vol_surge);
    if (p.weight_obi != null) overrides.weight_obi = clampWeight(p.weight_obi);
    if (p.weight_strength != null) overrides.weight_strength = clampWeight(p.weight_strength);
    if (p.weight_spread != null) overrides.weight_spread = clampWeight(p.weight_spread);
    if (p.weight_depth != null) overrides.weight_depth = clampWeight(p.weight_depth);
    if (p.weight_kimp != null) overrides.weight_kimp = clampWeight(p.weight_kimp);
    const v = Math.min(10, Math.max(1, parseInt(p.vol_surge_weight, 10) || 5));
    overrides.volume_multiplier = 1.1 + ((v - 1) / 9) * 0.5;
    const pb = Math.min(10, Math.max(1, parseInt(p.price_break_weight, 10) || 4));
    overrides.entry_tick_buffer = Math.round(1 + ((pb - 1) / 9) * 4);
    const st = Math.min(10, Math.max(1, parseInt(p.strength_weight, 10) || 2));
    overrides.strength_threshold = 0.5 + ((st - 1) / 9) * 0.45;
    const sl = parseFloat(p.stop_loss_pct);
    if (!Number.isNaN(sl) && sl <= 0) overrides.stop_loss_pct = sl;
    const ts = parseInt(p.time_stop_sec, 10);
    if (!Number.isNaN(ts) && ts > 0) overrides.time_stop_sec = ts;
    const tpt = parseFloat(p.take_profit_target_pct);
    if (p.take_profit_target_pct != null && !Number.isNaN(tpt) && tpt >= 0) overrides.take_profit_target_pct = Math.min(10, tpt);
    const trl = parseFloat(p.trailing_stop_pct);
    if (p.trailing_stop_pct != null && !Number.isNaN(trl) && trl >= 0) overrides.trailing_stop_pct = Math.min(10, trl);
    const sco = parseInt(p.score_out_threshold, 10);
    if (p.score_out_threshold != null && !Number.isNaN(sco) && sco >= 0) overrides.score_out_threshold = Math.min(7, sco);
    overrides.min_order_krw = Math.max(5000, parseInt(p.min_order_krw, 10) || 5000);
    if (p.greedy_enabled != null) overrides.greedy_mode = !!p.greedy_enabled;
    if (p.max_bet_multiplier != null) {
      const m = parseFloat(p.max_bet_multiplier);
      if (!Number.isNaN(m)) overrides.max_bet_multiplier = Math.min(2.5, Math.max(1, m));
    }
    if (p.aggressive_mode != null) overrides.aggressive_mode = !!p.aggressive_mode;
    if (p.race_horse_scheduler_enabled != null) overrides.race_horse_scheduler_enabled = !!p.race_horse_scheduler_enabled;
    scalpEngine.setProfile(overrides);
    updateRaceHorseState();
    const profileSnapshot = scalpEngine.getProfile();
    db.insertStrategyLog(profileSnapshot).then((id) => {
      if (id != null) state.currentStrategyId = id;
      const aggressive = !!profileSnapshot.aggressive_mode;
      const raceHorseEnabled = !!profileSnapshot.race_horse_scheduler_enabled;
      state.strategySummary = {
        id: state.currentStrategyId,
        created_at: new Date().toISOString(),
        strategyName: state.raceHorseActive ? 'RaceHorse' : (aggressive ? 'Aggressive' : (raceHorseEnabled ? 'RaceHorse(예약)' : 'SCALP 기본')),
        aggressive_mode: aggressive,
        race_horse_scheduler_enabled: raceHorseEnabled,
        take_profit_target_pct: profileSnapshot.take_profit_target_pct,
        trailing_stop_pct: profileSnapshot.trailing_stop_pct,
        score_out_threshold: profileSnapshot.score_out_threshold,
        stop_loss_pct: profileSnapshot.stop_loss_pct,
        time_stop_sec: profileSnapshot.time_stop_sec,
        weights: {
          weight_price_break: profileSnapshot.weight_price_break,
          weight_vol_surge: profileSnapshot.weight_vol_surge,
          weight_obi: profileSnapshot.weight_obi,
          weight_strength: profileSnapshot.weight_strength,
          weight_spread: profileSnapshot.weight_spread,
          weight_depth: profileSnapshot.weight_depth,
          weight_kimp: profileSnapshot.weight_kimp
        }
      };
      if (typeof cb === 'function') {
        const now = new Date();
        const appliedAt = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0') + ':' + now.getSeconds().toString().padStart(2, '0');
        cb({ appliedAt, strategyId: state.currentStrategyId });
      }
    }).catch((e) => {
      if (typeof cb === 'function') cb({ appliedAt: null, error: e.message });
    });
  });

  function emitManualLog(type, message) {
    socket.emit('manualTradeLog', { type: type || 'info', message: message || '' });
  }

  socket.on('manualBuy', async (data, cb) => {
    const market = (data && data.market) || 'KRW-BTC';
    const amountKrw = Math.max(5500, parseInt(data && data.amountKrw, 10) || 5500);
    if (!apiKeys.accessKey || !apiKeys.secretKey) {
      emitManualLog('error', 'API Key가 설정되지 않았습니다.');
      if (typeof cb === 'function') cb({ success: false, message: 'API Key가 설정되지 않았습니다.' });
      return;
    }
    if (!ApiAccessPolicy.canPlaceOrder(state)) {
      emitManualLog('error', 'PAUSE/RECOVERY 중에는 주문할 수 없습니다.');
      if (typeof cb === 'function') cb({ success: false, message: 'PAUSE/RECOVERY 중에는 주문할 수 없습니다.' });
      return;
    }
    if (state.cashLock?.active) {
      const msg = `현금 부족으로 신규 매수가 잠겨 있습니다. (주문가능: ${Math.floor(state.cashLock.orderableKrw ?? 0).toLocaleString('ko-KR')}원 / 필요 최소: ${state.cashLock.requiredKrw}원)`;
      emitManualLog('error', msg);
      if (typeof cb === 'function') cb({ success: false, message: msg });
      return;
    }
    emitManualLog('info', `${market} ${amountKrw.toLocaleString('ko-KR')}원 시장가 매수 요청 중…`);
    try {
      const order = await withUpbitFailover(async () => {
        const k = getActiveUpbitKeys();
        const validation = await TradeExecutor.validateApiKeys(k.accessKey, k.secretKey);
        if (!validation.valid) throw new Error(validation.error || TradeExecutor.API_KEY_ERROR_MSG);
        return TradeExecutor.placeMarketBuyByPrice(k.accessKey, k.secretKey, market, amountKrw);
      });
      const price = order && (order.price != null ? order.price : order.avg_price);
      const volume = order && (order.executed_volume != null ? order.executed_volume : order.volume);
      recordTrade({
        timestamp: new Date().toISOString(),
        ticker: market,
        side: 'buy',
        price: price ?? 0,
        quantity: volume ?? 0,
        fee: 0,
        revenue: 0,
        net_return: 0,
        reason: '수동/테스트',
        is_test: true
      });
      state.assets = await fetchAssets();
      state.trades = await db.getRecentTrades(10);
      emitDashboard().catch(() => {});
      const sym = market.replace('KRW-', '');
      const msg = `주문 완료: [${sym}] ${amountKrw.toLocaleString('ko-KR')}원 매수 성공`;
      emitManualLog('success', msg);
      if (typeof cb === 'function') cb({ success: true, message: msg, order });
    } catch (err) {
      const msg = (err && err.message) || '매수 요청 실패';
      emitManualLog('error', msg);
      if (typeof cb === 'function') cb({ success: false, message: msg });
    }
  });

  socket.on('manualSell', async (data, cb) => {
    const market = (data && data.market) || 'KRW-BTC';
    if (!apiKeys.accessKey || !apiKeys.secretKey) {
      emitManualLog('error', 'API Key가 설정되지 않았습니다.');
      if (typeof cb === 'function') cb({ success: false, message: 'API Key가 설정되지 않았습니다.' });
      return;
    }
    const currency = market.replace('KRW-', '');
    let volume = 0;
    try {
      const accounts = await withUpbitFailover(async () => {
        const k = getActiveUpbitKeys();
        return upbit.getAccounts(k.accessKey, k.secretKey);
      });
      const acc = (accounts || []).find((a) => (a.currency || '').toUpperCase() === currency.toUpperCase());
      volume = acc ? parseFloat(acc.balance || 0) : 0;
    } catch (e) {
      emitManualLog('error', '잔고 조회 실패: ' + (e.message || ''));
      if (typeof cb === 'function') cb({ success: false, message: '잔고 조회 실패' });
      return;
    }
    if (volume <= 0) {
      emitManualLog('error', `${currency} 보유 수량이 없습니다.`);
      if (typeof cb === 'function') cb({ success: false, message: `${currency} 보유 수량이 없습니다.` });
      return;
    }
    if (!ApiAccessPolicy.canPlaceOrder(state)) {
      emitManualLog('error', 'PAUSE/RECOVERY 중에는 주문할 수 없습니다.');
      if (typeof cb === 'function') cb({ success: false, message: 'PAUSE/RECOVERY 중에는 주문할 수 없습니다.' });
      return;
    }
    emitManualLog('info', `${market} 전량(${volume}) 시장가 매도 요청 중…`);
    try {
      const order = await withUpbitFailover(async () => {
        const k = getActiveUpbitKeys();
        return TradeExecutor.placeMarketSellByVolume(k.accessKey, k.secretKey, market, volume);
      });
      recordTrade({
        timestamp: new Date().toISOString(),
        ticker: market,
        side: 'sell',
        price: order && (order.price != null ? order.price : order.avg_price) || 0,
        quantity: volume,
        fee: 0,
        revenue: 0,
        net_return: 0,
        reason: '수동/테스트',
        is_test: true
      });
      state.assets = await fetchAssets();
      state.trades = await db.getRecentTrades(10);
      emitDashboard().catch(() => {});
      const sym = market.replace('KRW-', '');
      const msg = `주문 완료: [${sym}] 전량 매도 성공`;
      emitManualLog('success', msg);
      if (typeof cb === 'function') cb({ success: true, message: msg, order });
    } catch (err) {
      const msg = (err && err.message) || '매도 요청 실패';
      emitManualLog('error', msg);
      if (typeof cb === 'function') cb({ success: false, message: msg });
    }
  });

  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3000;

const initPromise = (async () => {
  try {
    await db.init();
    state.trades = await db.getRecentTrades(10);
    const latest = await db.getLatestStrategyLog();
    if (latest) {
      state.currentStrategyId = latest.id;
      const p = latest.profile || {};
      const aggressive = !!p.aggressive_mode;
      const raceHorseEnabled = !!latest.race_horse_scheduler_enabled;
      state.strategySummary = {
        id: latest.id,
        created_at: latest.created_at,
        strategyName: aggressive ? 'Aggressive' : (raceHorseEnabled ? 'RaceHorse(예약)' : 'SCALP 기본'),
        aggressive_mode: aggressive,
        race_horse_scheduler_enabled: raceHorseEnabled,
        take_profit_target_pct: latest.take_profit_target_pct,
        trailing_stop_pct: latest.trailing_stop_pct,
        score_out_threshold: latest.score_out_threshold,
        stop_loss_pct: latest.stop_loss_pct,
        time_stop_sec: latest.time_stop_sec,
        weights: latest.profile ? {
          weight_price_break: latest.profile.weight_price_break,
          weight_vol_surge: latest.profile.weight_vol_surge,
          weight_obi: latest.profile.weight_obi,
          weight_strength: latest.profile.weight_strength,
          weight_spread: latest.profile.weight_spread,
          weight_depth: latest.profile.weight_depth,
          weight_kimp: latest.profile.weight_kimp
        } : null
      };
    }
  } catch (e) {
    console.warn('DB init/load:', e && e.message);
  }
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  mpiDiagnostics.setCandleFetcher(upbit.getCandlesMinutes);
  regimeDetector.setCandleFetcher(upbit.getCandlesMinutes);
  regimeDetector.setCandlesDays(upbit.getCandlesDays);
  regimeDetector.setFuturesFetcher((pair) => futuresSentiment.fetchOiAndFunding(pair));
  patternLearner.setCandleFetchers(upbit.getCandlesMinutes, upbit.getCandlesDays);

  const discordHandlers = {
    /** 부팅 직렬화: ready 시 자산/API/엔진 3요소 정상 여부 — 모두 OK일 때만 "시스템 재가동 완료 🟢" */
    getBootReadyCheck: () => {
      const assetsOk = !!(state.assets && (state.assets.orderableKrw != null || state.assets.totalEvaluationKrw != null));
      const apiOk = !!(apiKeys.accessKey && apiKeys.secretKey);
      const engineOk = true; // initPromise 완료 시 엔진·DB 로드 완료
      return { assetsOk, apiOk, engineOk, allOk: assetsOk && apiOk && engineOk };
    },
    /** 가동 시 [📊 현재 상태] 1회 전송용. discordBot에서 isMainReportSent로 중복 차단. 데이터 없으면 로딩 안내 임베드 반환 */
    getStartupStatusEmbed: async () => {
      let assets = state.assets;
      try {
        assets = await fetchAssets();
        state.assets = assets;
      } catch (e) {
        console.warn('[getStartupStatusEmbed] fetchAssets 실패:', e?.message);
      }
      const hasData = assets && (assets.totalEvaluationKrw != null || assets.orderableKrw != null);
      if (!hasData) {
        return new MessageEmbed()
          .setTitle('📊 현재 상태')
          .setColor(0x5865f2)
          .addFields(
            { name: '매매 엔진 상태', value: state.botEnabled ? '🟢 구동 중' : '🔴 정지됨', inline: true },
            { name: '경주마 모드', value: getRaceHorseStatusLabel(state.raceHorseActive), inline: true },
            { name: '상태', value: '데이터 로딩 중… (Upbit API 확인 후 [📊 현재 상태] 버튼으로 새로고침)', inline: false }
          )
          .setFooter({ text: 'APENFT·PURSE 제외 · 수익률 = (평가손익/총매수)×100 (보유 KRW 제외)' })
          .setTimestamp();
      }
      const gemini = require('./lib/gemini');
      return buildCurrentStateEmbed(assets, state.strategySummary || {}, {
        isEngineRunning: state.botEnabled,
        raceHorseStatusLabel: getRaceHorseStatusLabel(state.raceHorseActive),
        aggressiveSymbols: scalpEngine.getAggressiveSymbols(),
        relaxedModeLabel: getRelaxedModeLabel(),
        aiUsage: gemini.getDailyUsage ? gemini.getDailyUsage() : null,
        ...getModeRemainingOpts()
      });
    },
    engineStart: async () => {
      if (!apiKeys.accessKey || !apiKeys.secretKey) {
        return { success: false, message: 'API 키가 설정되지 않았습니다.' };
      }
      if (!tradingEngine.isRunning()) {
        tradingEngine.start(getTradingEngineCallbacks());
      }
      EngineStateStore.update({ serviceStopped: false });
      try {
        await withUpbitFailover(async () => {
          const k = getActiveUpbitKeys();
          const client = upbit.createClient(k.accessKey, k.secretKey);
          await client.request('GET', '/orders', { market: 'KRW-BTC', state: 'done', limit: '1' });
        });
        state.botEnabled = true;
        state.assets = await fetchAssets();
        if (state.assets && state.assets.totalEvaluationKrw != null) {
          state.initialAssetsForReturn = state.assets.totalEvaluationKrw;
        }
        emitDashboard().catch(() => {});
        return { success: true, message: '자동 매매를 시작합니다.' };
      } catch (e) {
        const msg = e?.message || '';
        const is401 = /401|invalid_query|unauthorized/i.test(msg);
        state.botEnabled = false;
        return {
          success: false,
          message: is401
            ? '인증 오류(401)가 지속됩니다. API 키와 IP 등록 상태를 확인하세요.'
            : '연결 실패: ' + msg
        };
      }
    },
    engineStop: async () => {
      tradingEngine.stop();
      if (apiKeys.accessKey && apiKeys.secretKey) {
        try {
          await withUpbitFailover(async () => {
            const k = getActiveUpbitKeys();
            return upbit.cancelAllOrders(k.accessKey, k.secretKey, SCALP_MARKETS);
          });
        } catch (e) {
          console.warn('cancelAllOrders:', e?.message);
        }
      }
      emitDashboard().catch(() => {});
    },
    /** 경주마 모드 토글 — 변동성 큰 종목 스캐닝 주기 단축 */
    toggleRaceHorse: async () => {
      StrategyManager.setRaceHorseActiveByUser(!StrategyManager.isRaceHorseActive());
      state.raceHorseActive = StrategyManager.isRaceHorseActive();
      emitDashboard().catch(() => {});
      return { active: state.raceHorseActive };
    },
    /** [🔓 매매 엔진 기준 완화] 상태 — Discord 버튼용 */
    getRelaxedStatus: () => ({ remainingMs: StrategyManager.getRelaxedModeRemainingMs() }),
    /** [🔓 매매 엔진 기준 완화] 4시간 적용 */
    setRelaxedMode: (ttlMs) => {
      StrategyManager.setRelaxedMode(ttlMs || 4 * 60 * 60 * 1000);
      emitDashboard().catch(() => {});
      persistSystemState();
    },
    /** [🔓 기준 완화] 4시간 연장 (종료 시각을 현재+4h로 갱신) */
    extendRelaxMode: () => {
      StrategyManager.setRelaxedMode(4 * 60 * 60 * 1000);
      emitDashboard().catch(() => {});
      persistSystemState();
    },
    /** 독립 초단타 스캘프 봇 상태 (디스코드/대시보드용) */
    getIndependentScalpStatus: () => scalpRunner.getStatus(state),
    /** 독립 스캘프 3시간 시한부 가동 (우선권 SCALP). 기준 완화 중이면 자동 종료 후 스캘프 우선 */
    setIndependentScalpActivate: (mode = 'SUPER_AGGRESSIVE') => {
      if (StrategyManager.getRelaxedModeRemainingMs() > 0) StrategyManager.setRelaxedMode(0);
      scalpState.activate(mode);
      EngineStateStore.update({ scalpMode: true });
      emitDashboard().catch(() => {});
      persistSystemState();
      return { success: true, remainingMs: scalpState.getRemainingMs() };
    },
    /** 독립 스캘프 중지 (우선권 MAIN 반납). 자산 동기화 후 일반 모드 주도권 복원 */
    setIndependentScalpStop: () => {
      EngineStateStore.update({ scalpMode: false, botEnabled: true });
      scalpState.stop();
      fetchAssets().then((a) => {
        if (a != null) state.assets = a;
        emitDashboard().catch(() => {});
        persistSystemState();
      }).catch(() => {});
      return { success: true };
    },
    /** 독립 스캘프 3시간 연장: 남은 시간(ms)이 60분 미만일 때만 expiryTime에 3*60*60*1000 추가 */
    extendIndependentScalp: () => {
      const extended = scalpState.extend();
      emitDashboard().catch(() => {});
      persistSystemState();
      const remainingMs = scalpState.getRemainingMs();
      return { success: extended, remainingMs };
    },
    /** [🛠️ 역할 C] git pull origin main 후 변경 시 2초 뒤 process.exit(0). PM2가 재시작. */
    adminGitPullRestart: () => {
      return new Promise((resolve) => {
        const repoRoot = path.join(__dirname, '..');
        exec('git pull origin main', { cwd: repoRoot }, (err, stdout, stderr) => {
          const out = (stdout || '') + (stderr || '');
          if (err) {
            resolve({ content: '❌ git pull 오류: ' + (err.message || out || '알 수 없음') });
            return;
          }
          if (/Already up to date/i.test(out)) {
            resolve({ content: '✅ 현재 최신 상태입니다. 변경 사항이 없어 재기동하지 않습니다.' });
            return;
          }
          setTimeout(() => {
            console.log('[Admin] git pull 반영 후 재기동합니다. (PM2가 프로세스를 자동 재시작합니다.)');
            process.exit(0);
          }, 2000);
          resolve({ content: '🚀 최신 소스 코드를 가져왔습니다. 시스템을 재기동합니다...' });
        });
      });
    },
    /** [🛠️ 역할 C] 1초 뒤 process.exit(0). PM2가 재시작. */
    adminSimpleRestart: () => {
      setTimeout(() => {
        console.log('[Admin] 수동 재기동 요청. (PM2가 프로세스를 자동 재시작합니다.)');
        process.exit(0);
      }, 1000);
      return Promise.resolve({ content: '♻️ 즉시 재기동을 시작합니다...' });
    },
    currentState: async () => {
      state.assets = await fetchAssets();
      const assets = state.assets;
      const gemini = require('./lib/gemini');
      const embed = buildCurrentStateEmbed(assets, state.strategySummary || {}, {
        isEngineRunning: state.botEnabled,
        raceHorseStatusLabel: getRaceHorseStatusLabel(state.raceHorseActive),
        aggressiveSymbols: scalpEngine.getAggressiveSymbols(),
        relaxedModeLabel: getRelaxedModeLabel(),
        aiUsage: gemini.getDailyUsage ? gemini.getDailyUsage() : null,
        ...getModeRemainingOpts()
      });
      const profitPctNum = positionEngineFromBootstrap ? positionEngineFromBootstrap.getProfitPct(assets) : getProfitPct(assets);
      const totalEval = assets?.totalEvaluationKrw ?? 0;
      try {
        const { geminiEnabled } = EngineStateStore.get();
        if (!geminiEnabled) {
          embed.addFields({
            name: '⚡ 실시간 요약',
            value: `현재 수익률: ${profitPctNum.toFixed(2)}% | ⚡ AI 일시 중지 (기본 매매 모드)`,
            inline: false
          });
        } else {
          const gemini = require('./lib/gemini');
          const riskLine = await gemini.askGeminiForPortfolioRisk(profitPctNum, totalEval);
          const geminiValue = riskLine
            ? `현재 수익률: ${profitPctNum.toFixed(2)}% | ⚡ Gemini 분석: ${riskLine}`
            : `현재 수익률: ${profitPctNum.toFixed(2)}%`;
          embed.addFields({ name: '⚡ 실시간 요약', value: geminiValue, inline: false });
        }
      } catch (e) {
        const gemini = require('./lib/gemini');
        if (typeof gemini.handleGeminiError === 'function') gemini.handleGeminiError(e);
        embed.addFields({
          name: '⚡ 실시간 요약',
          value: `현재 수익률: ${profitPctNum.toFixed(2)}% | ⚡ Gemini 분석: —`,
          inline: false
        });
      }
      return embed;
    },
    currentReturn: async () => {
      state.assets = await fetchAssets();
      const assets = state.assets;
      const totalBuyKrw = Math.floor(Number(assets?.totalBuyKrwForCoins ?? 0) || 0);
      const totalEvalCoins = Math.floor(Number(assets?.evaluationKrwForCoins ?? 0) || 0);
      const totalKrw = Math.floor(assets?.orderableKrw ?? 0);
      const profitLossKrw = totalEvalCoins - totalBuyKrw;
      const profitPctNum = positionEngineFromBootstrap ? positionEngineFromBootstrap.getProfitPct(assets) : getProfitPct(assets);
      const pctStr = (totalBuyKrw <= 0 ? 0 : Math.floor(profitPctNum * 100) / 100).toFixed(2) + '%';
      const isProfit = profitLossKrw > 0;
      const isZero = profitLossKrw === 0;
      const arrow = isProfit ? '▲' : isZero ? '－' : '▼';
      const emoji = isProfit ? '🟢' : isZero ? '⚪' : '🔴';
      const profitLine =
        totalBuyKrw > 0
          ? `${emoji} **현재 손익**: ${isProfit ? '+' : ''}${profitLossKrw.toLocaleString('ko-KR')}원 (${arrow} ${profitPctNum >= 0 ? '+' : ''}${pctStr})`
          : '⚪ **현재 손익**: 0원 (수익률 0.00%)';
      const summaryLine =
        totalBuyKrw > 0
          ? `총 매수: ${totalBuyKrw.toLocaleString('ko-KR')}원 / 총평가(코인): ${totalEvalCoins.toLocaleString('ko-KR')}원`
          : '—';
      let holdingList = '없음';
      if (apiKeys.accessKey && apiKeys.secretKey) {
        try {
          const accounts = await withUpbitFailover(async () => {
            const k = getActiveUpbitKeys();
            return upbit.getAccounts(k.accessKey, k.secretKey) || [];
          });
          const coins = (accounts || []).filter(
            (a) => a.currency !== 'KRW' && !['APENFT', 'PURSE'].includes(a.currency) && parseFloat(a.balance || 0) > 0
          );
          holdingList = coins.length ? coins.map((a) => a.currency).join(', ') : '없음';
        } catch (_) {}
      }
      const embedColor = isProfit ? 0x57f287 : isZero ? 0x95a5a6 : 0xed4245;
      const embed = new MessageEmbed()
        .setTitle(isProfit ? '🟢 현재 수익률' : isZero ? '⚪ 현재 수익률' : '🔴 현재 수익률')
        .setColor(embedColor)
        .addFields(
          { name: '주문가능(KRW)', value: totalKrw.toLocaleString('ko-KR') + ' 원', inline: true },
          { name: '총평가', value: totalEvalCoins.toLocaleString('ko-KR') + ' 원', inline: true },
          { name: '총매수', value: totalBuyKrw.toLocaleString('ko-KR') + ' 원', inline: true },
          { name: '평가 손익', value: profitLine + '\n' + summaryLine, inline: false },
          { name: '가동중인 종목', value: holdingList, inline: false }
        )
        .setFooter({ text: 'APENFT·PURSE·잡코인 제외 · 수익률 = (평가손익/총매수)×100, 총매수 0이면 0%' })
        .setTimestamp();
      return embed;
    },
    /** 상위 5종목 원본 데이터 (복사용). APENFT/PURSE 제외는 자산 쪽에서만 적용. */
    aiAnalysisData: async () => {
      try {
        const tickers = await upbit.getTopKrwTickersByTradePrice(30);
        if (!tickers || tickers.length === 0) return '마켓 목록 조회 실패';
        const top5 = tickers.slice(0, 5);
        const lines = ['다음 데이터를 분석해서 1% 수익 가능한 스캘핑 타점을 잡아줘:\n\n'];
        for (const t of top5) {
          const market = t.market || '';
          const symbol = market.replace('KRW-', '');
          const price = t.trade_price != null ? Number(t.trade_price) : 0;
          let rsi = '—';
          let trend5m = '—';
          let strength = '—';
          try {
            const candles = await upbit.getCandlesMinutes(5, market, 15);
            await upbit.delay(250);
            if (Array.isArray(candles) && candles.length >= 15) {
              const closes = candles.slice(0, 15).map((c) => Number(c.trade_price)).filter((n) => !isNaN(n));
              if (closes.length >= 15) {
                let gains = 0;
                let losses = 0;
                for (let i = 0; i < 14; i++) {
                  const d = closes[i] - closes[i + 1];
                  if (d > 0) gains += d;
                  else losses -= d;
                }
                const avgGain = gains / 14;
                const avgLoss = losses / 14;
                if (avgLoss > 0) {
                  const rs = avgGain / avgLoss;
                  rsi = (100 - 100 / (1 + rs)).toFixed(1);
                } else rsi = avgGain > 0 ? '100' : '50';
              }
              const last3 = candles.slice(0, 3).map((c) => Number(c.trade_price));
              if (last3.length === 3) {
                const up = last3[0] > last3[2];
                trend5m = up ? '상승' : '하락';
              }
            }
          } catch (_) {}
          try {
            const orderbooks = await upbit.getOrderbook([market]);
            await upbit.delay(250);
            const ob = Array.isArray(orderbooks) ? orderbooks[0] : orderbooks;
            if (ob && ob.orderbook_units && ob.orderbook_units.length > 0) {
              let bidVol = 0;
              let askVol = 0;
              ob.orderbook_units.forEach((u) => {
                bidVol += (Number(u.bid_size) || 0) * (Number(u.bid_price) || 0);
                askVol += (Number(u.ask_size) || 0) * (Number(u.ask_price) || 0);
              });
              const total = bidVol + askVol;
              strength = total > 0 ? ((bidVol / total) * 100).toFixed(1) + '%' : '—';
            }
          } catch (_) {}
          lines.push(`[${symbol}] 현재가 ${price.toLocaleString('ko-KR')}원 | RSI(14) ${rsi} | 체결강도(매수비율) ${strength} | 5분봉 추세 ${trend5m}`);
        }
        return lines.join('\n');
      } catch (e) {
        return 'AI 분석 데이터 수집 실패: ' + (e?.message || '');
      }
    },
    /** [💡 AI 자동 분석]: 상위 5종목 수집 후 Gemini 2.5 Flash로 타점·추천 종목 분석, 3문단 이내 리포트 반환 */
    aiAutoAnalysis: async () => {
      try {
        const tickers = await upbit.getTopKrwTickersByTradePrice(30);
        if (!tickers || tickers.length === 0) return '마켓 목록 조회 실패.';
        const top5 = tickers.slice(0, 5);
        const dataItems = [];
        for (const t of top5) {
          const market = t.market || '';
          const symbol = market.replace('KRW-', '');
          const price = t.trade_price != null ? Number(t.trade_price) : 0;
          let rsi = '—';
          let trend5m = '—';
          let strength = '—';
          try {
            const candles = await upbit.getCandlesMinutes(5, market, 15);
            await upbit.delay(250);
            if (Array.isArray(candles) && candles.length >= 15) {
              const closes = candles.slice(0, 15).map((c) => Number(c.trade_price)).filter((n) => !isNaN(n));
              if (closes.length >= 15) {
                let gains = 0;
                let losses = 0;
                for (let i = 0; i < 14; i++) {
                  const d = closes[i] - closes[i + 1];
                  if (d > 0) gains += d;
                  else losses -= d;
                }
                const avgGain = gains / 14;
                const avgLoss = losses / 14;
                if (avgLoss > 0) {
                  const rs = avgGain / avgLoss;
                  rsi = (100 - 100 / (1 + rs)).toFixed(1);
                } else rsi = avgGain > 0 ? '100' : '50';
              }
              const last3 = candles.slice(0, 3).map((c) => Number(c.trade_price));
              if (last3.length === 3) trend5m = last3[0] > last3[2] ? '상승' : '하락';
            }
          } catch (_) {}
          try {
            const orderbooks = await upbit.getOrderbook([market]);
            await upbit.delay(250);
            const ob = Array.isArray(orderbooks) ? orderbooks[0] : orderbooks;
            if (ob?.orderbook_units?.length > 0) {
              let bidVol = 0;
              let askVol = 0;
              ob.orderbook_units.forEach((u) => {
                bidVol += (Number(u.bid_size) || 0) * (Number(u.bid_price) || 0);
                askVol += (Number(u.ask_size) || 0) * (Number(u.ask_price) || 0);
              });
              const total = bidVol + askVol;
              strength = total > 0 ? ((bidVol / total) * 100).toFixed(1) + '%' : '—';
            }
          } catch (_) {}
          dataItems.push({ symbol, price, rsi, strength, trend5m });
        }
        const { geminiEnabled } = EngineStateStore.get();
        let report = null;
        if (geminiEnabled) {
          try {
            report = await require('./lib/gemini').askGeminiForScalpPoint(dataItems);
          } catch (e) {
            const gemini = require('./lib/gemini');
            if (typeof gemini.handleGeminiError === 'function') gemini.handleGeminiError(e);
          }
        }
        const text = report || (geminiEnabled ? '현재 AI 분석이 지연되고 있습니다. 잠시 후 시도해 주세요.' : 'AI 기능이 일시 중지되었습니다. (기본 매매 모드)');
        const recommendedTicker = extractRecommendedTicker(text);
        const tickerForConfirm =
          recommendedTicker && ALLOWED_AGGRESSIVE_TICKERS.includes(recommendedTicker) ? recommendedTicker : null;
        if (tickerForConfirm) {
          const remainingMs = scalpEngine.getAggressiveSymbolRemainingMs(tickerForConfirm);
          if (remainingMs > 0) {
            return { text, recommendedTicker: tickerForConfirm, aggressiveAlready: true, remainingMs };
          }
        }
        return { text, recommendedTicker: tickerForConfirm };
      } catch (e) {
        const gemini = require('./lib/gemini');
        if (typeof gemini.handleGeminiError === 'function') gemini.handleGeminiError(e);
        return { text: 'AI 자동 분석 실패: ' + (e?.message || ''), recommendedTicker: null };
      }
    },
    /** AI 승인 버튼 [✅ 공격적 매매 진행] 클릭 시 해당 티커 가중치 4시간 상향 (티커별 독립) */
    setAggressiveSymbol: (symbol) => {
      if (!symbol || !ALLOWED_AGGRESSIVE_TICKERS.includes(String(symbol).toUpperCase())) return { success: false };
      scalpEngine.setAggressiveSymbol(symbol, 4 * 60 * 60 * 1000);
      emitDashboard().catch(() => {});
      persistSystemState();
      return { success: true };
    },
    /** 특별 관리 종목 가중치 해지 (4시간 이내에도 즉시 해지 가능) */
    clearAggressiveSymbol: (symbol) => {
      if (!symbol) return { success: false };
      scalpEngine.clearAggressiveSymbol(symbol);
      emitDashboard().catch(() => {});
      persistSystemState();
      return { success: true };
    },
    /** API 사용량·무료 토큰 모니터링 (OpenAI + Gemini) */
    getApiUsageMonitor: async () => {
      const apiUsageMonitor = require('./lib/apiUsageMonitor');
      const report = await apiUsageMonitor.getCombinedReport();
      return { content: report };
    },
    sellAll: async () => {
      if (!apiKeys.accessKey || !apiKeys.secretKey) return 'API 키 미설정';
      if (!ApiAccessPolicy.canPlaceOrder(state)) return 'PAUSE/RECOVERY 중에는 주문할 수 없습니다.';
      let accounts;
      try {
        accounts = await withUpbitFailover(async () => {
          const k = getActiveUpbitKeys();
          return upbit.getAccounts(k.accessKey, k.secretKey);
        });
      } catch (e) {
        return '계좌 조회 실패: ' + (e?.message || '');
      }
      if (!Array.isArray(accounts)) return '계좌 조회 실패';
      const sold = [];
      for (const acc of accounts) {
        const currency = acc.currency;
        if (currency === 'KRW') continue;
        if (['APENFT', 'PURSE'].includes(currency)) continue;
        const balance = parseFloat(acc.balance || 0);
        if (balance <= 0) continue;
        const market = 'KRW-' + currency;
        const volume = Math.floor(balance * 1e8) / 1e8;
        if (volume <= 0) continue;
        try {
          await withUpbitFailover(async () => {
            const k = getActiveUpbitKeys();
            return TradeExecutor.placeMarketSellByVolume(k.accessKey, k.secretKey, market, volume);
          });
          sold.push(`${currency} ${volume}`);
        } catch (e) {
          console.warn('sellAll', market, e?.message);
        }
      }
      state.assets = await fetchAssets();
      emitDashboard().catch(() => {});
      return sold.length ? sold.join(', ') + ' 시장가 매도 접수.' : '매도할 보유 종목 없음.';
    }
  };

  async function enrichSurgeWithRsiStrength(top3) {
    const out = [];
    for (const s of top3) {
      let rsi = null;
      let strength = null;
      try {
        const candles = await upbit.getCandlesMinutes(5, s.market, 15);
        await upbit.delay(250);
        if (Array.isArray(candles) && candles.length >= 15) {
          const closes = candles.slice(0, 15).map((c) => Number(c.trade_price)).filter((n) => !isNaN(n));
          if (closes.length >= 15) {
            let gains = 0;
            let losses = 0;
            for (let i = 0; i < 14; i++) {
              const d = closes[i] - closes[i + 1];
              if (d > 0) gains += d;
              else losses -= d;
            }
            const avgLoss = losses / 14;
            if (avgLoss > 0) rsi = (100 - 100 / (1 + (gains / 14) / avgLoss)).toFixed(1);
            else rsi = gains > 0 ? '100' : '50';
          }
        }
      } catch (_) {}
      try {
        const orderbooks = await upbit.getOrderbook([s.market]);
        await upbit.delay(250);
        const ob = Array.isArray(orderbooks) ? orderbooks[0] : orderbooks;
        if (ob?.orderbook_units?.length > 0) {
          let bidVol = 0;
          let askVol = 0;
          ob.orderbook_units.forEach((u) => {
            bidVol += (Number(u.bid_size) || 0) * (Number(u.bid_price) || 0);
            askVol += (Number(u.ask_size) || 0) * (Number(u.ask_price) || 0);
          });
          const total = bidVol + askVol;
          strength = total > 0 ? ((bidVol / total) * 100).toFixed(1) + '%' : null;
        }
      } catch (_) {}
      out.push({
        symbol: s.symbol,
        ratio: s.ratio,
        recentVol: s.recentVol,
        rsi: rsi != null ? rsi : '—',
        strength: strength != null ? strength : '—'
      });
    }
    return out;
  }

  /** 거래 부재 진단 누적 (최대 20건). suggestLogic은 5회 이상일 때만 분석. 항목: { ts, source, localSummary, finalBody, meta } */
  const diagnosticsStore = [];
  const DIAGNOSTICS_STORE_MAX = 20;
  const MIN_DIAGNOSTICS_FOR_SUGGEST = 5;
  /** 진단/수정안 Embed footer용 프롬프트 버전 (품질 추적용) */
  const DIAGNOSIS_PROMPT_VERSION = 'v1';
  const LOGIC_PROMPT_VERSION = 'v2';

  /** 수정안 제안 Gemini 응답 품질 검증: 위험한 과도 제안·비정상 길이 시 fallback 유도 */
  function validateLogicSuggestionResponse(text) {
    if (!text || typeof text !== 'string') return false;
    const t = text.trim();
    if (t.length < 10) return false;
    if (t.length > 2500) return false;
    const dangerous = /모든\s*기준을\s*낮추세요|전부\s*완화|일괄\s*낮추세요|기준\s*전부\s*완화/;
    if (dangerous.test(t)) return false;
    return true;
  }

  /** 오늘(일 단위) 로그만 수집 — logs/*.log 중 오늘 날짜가 포함된 라인만 (pm2 템플릿 %name% 제외) */
  function readTodayLogContent() {
    const logDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logDir)) return '';
    const todayStr = new Date().toISOString().slice(0, 10);
    const maxFileBytes = 400000;
    const chunks = [];
    try {
      const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.log') && !f.includes('%'));
      for (const f of files) {
        try {
          const full = path.join(logDir, f);
          const stat = fs.statSync(full);
          if (!stat.isFile()) continue;
          let content = fs.readFileSync(full, 'utf8');
          if (content.length > maxFileBytes) content = content.slice(-maxFileBytes);
          const lines = content.split(/\r?\n/).filter((l) => l.includes(todayStr));
          if (lines.length) chunks.push('[파일: ' + f + ']\n' + lines.join('\n'));
        } catch (_) {}
      }
    } catch (e) {
      return '';
    }
    return chunks.join('\n\n');
  }

  const analystHandlers = {
    scanVol: async () => {
      try {
        const tickers = await upbit.getTopKrwTickersByTradePrice(10);
        if (!tickers || tickers.length === 0) return null;
        const enriched = [];
        for (const t of tickers) {
          const market = t.market || '';
          const symbol = market.replace('KRW-', '');
          const price = t.trade_price != null ? Number(t.trade_price) : null;
          let rsi = '—';
          let strength = '—';
          let volumeChange = '—';
          try {
            const candles = await upbit.getCandlesMinutes(5, market, 15);
            await upbit.delay(250);
            if (Array.isArray(candles) && candles.length >= 15) {
              const closes = candles.slice(0, 15).map((c) => Number(c.trade_price)).filter((n) => !isNaN(n));
              if (closes.length >= 15) {
                let gains = 0;
                let losses = 0;
                for (let i = 0; i < 14; i++) {
                  const d = closes[i] - closes[i + 1];
                  if (d > 0) gains += d;
                  else losses -= d;
                }
                const avgLoss = losses / 14;
                if (avgLoss > 0) rsi = (100 - 100 / (1 + (gains / 14) / avgLoss)).toFixed(1);
                else rsi = gains > 0 ? '100' : '50';
              }
              const vol = (c) => Number(c.candle_acc_trade_volume) || 0;
              const recent3 = candles.slice(0, 3).reduce((s, c) => s + vol(c), 0);
              const prev6 = candles.slice(3, 9).reduce((s, c) => s + vol(c), 0);
              const avgPrev = prev6 / 6 || 1;
              const ratio = avgPrev > 0 ? recent3 / avgPrev : 0;
              volumeChange = ratio.toFixed(2) + '배(최근3봉/이전6봉평균)';
            }
          } catch (_) {}
          try {
            const orderbooks = await upbit.getOrderbook([market]);
            await upbit.delay(250);
            const ob = Array.isArray(orderbooks) ? orderbooks[0] : orderbooks;
            if (ob?.orderbook_units?.length > 0) {
              let bidVol = 0;
              let askVol = 0;
              ob.orderbook_units.forEach((u) => {
                bidVol += (Number(u.bid_size) || 0) * (Number(u.bid_price) || 0);
                askVol += (Number(u.ask_size) || 0) * (Number(u.ask_price) || 0);
              });
              const total = bidVol + askVol;
              strength = total > 0 ? ((bidVol / total) * 100).toFixed(1) + '%' : '—';
            }
          } catch (_) {}
          enriched.push({ symbol, price, rsi, strength, volumeChange });
        }

        let geminiText = null;
        if (EngineStateStore.get().geminiEnabled) {
          try {
            const gemini = require('./lib/gemini');
            geminiText = await gemini.askGeminiForScanVol(enriched);
          } catch (e) {
            const gemini = require('./lib/gemini');
            if (typeof gemini.handleGeminiError === 'function') gemini.handleGeminiError(e);
            geminiText = '연동 실패: ' + (e?.message || 'API 키 확인');
          }
        }

        const dataLines = enriched
          .map(
            (e) =>
              `[${e.symbol}] 현재가 ${e.price != null ? e.price.toLocaleString('ko-KR') : '—'}원 | RSI ${e.rsi} | 체결강도 ${e.strength} | 5분봉 거래량 ${e.volumeChange}`
          )
          .join('\n');
        const embed = new MessageEmbed()
          .setTitle('🔍 급등주 분석 (거래대금 상위 10종목)')
          .setColor(ANALYST_EMBED_COLOR)
          .setFooter({ text: 'Gemini 1.5 Flash' })
          .setTimestamp();
        if (geminiText) {
          embed.setDescription(geminiText);
          if (dataLines.length > 0 && dataLines.length <= 900) {
            embed.addFields({ name: '📊 참고 데이터', value: '```\n' + dataLines + '\n```', inline: false });
          }
        } else {
          embed.setDescription('```\n' + dataLines + '\n```');
        }
        return embed;
      } catch (e) {
        return new MessageEmbed()
          .setTitle('🔍 급등주 분석')
          .setColor(ANALYST_EMBED_COLOR)
          .setDescription('오류: ' + (e?.message || '조회 실패'))
          .setTimestamp();
      }
    },
    getPrompt: async () => {
      try {
        const fng = state.fng || {};
        const fngStr = fng.value != null ? `공포·탐욕 지수: ${fng.value} (${fng.valueClassification || '—'})` : '공포·탐욕: —';
        let btcTrend = '—';
        try {
          const btcTicker = await upbit.getTickers(['KRW-BTC']).then((r) => (Array.isArray(r) ? r[0] : r));
          if (btcTicker?.signed_change_rate != null) {
            const rate = Number(btcTicker.signed_change_rate) * 100;
            btcTrend = `비트코인 24h: ${rate >= 0 ? '+' : ''}${rate.toFixed(2)}%`;
          }
        } catch (_) {}
        const tickers = await upbit.getTopKrwTickersByTradePrice(30);
        const top10 = (tickers || []).slice(0, 10);
        const topTickersLines = top10.map((t) => {
          const symbol = (t.market || '').replace('KRW-', '');
          const price = t.trade_price != null ? Number(t.trade_price) : 0;
          const change24h = t.signed_change_rate != null ? (Number(t.signed_change_rate) * 100).toFixed(2) + '%' : '—';
          return `[${symbol}] 현재가 ${price.toLocaleString('ko-KR')}원 | 24h ${change24h}`;
        }).join('\n');
        const kimpStr = state.kimpAvg != null ? `김치 프리미엄(평균): ${state.kimpAvg.toFixed(2)}%` : '김프: —';
        const ctx = { fng: fngStr, btcTrend, topTickers: topTickersLines || '—', kimp: kimpStr };
        let summaryText = null;
        if (EngineStateStore.get().geminiEnabled) {
          try {
            const gemini = require('./lib/gemini');
            summaryText = await gemini.askGeminiForMarketSummary(ctx);
          } catch (e) {
            const gemini = require('./lib/gemini');
            if (typeof gemini.handleGeminiError === 'function') gemini.handleGeminiError(e);
            summaryText = '시황 요약 생성 실패: ' + (e?.message || 'API 확인');
          }
        }
        return new MessageEmbed()
          .setTitle('💡 시황 요약')
          .setColor(ANALYST_EMBED_COLOR)
          .setDescription(summaryText || (ctx.fng + '\n' + ctx.btcTrend + '\n' + ctx.topTickers + '\n' + ctx.kimp))
          .setFooter({ text: 'Gemini 2.5 Flash · 3문단 요약' })
          .setTimestamp();
      } catch (e) {
        return new MessageEmbed()
          .setTitle('💡 시황 요약')
          .setColor(ANALYST_EMBED_COLOR)
          .setDescription('오류: ' + (e?.message || '조회 실패'))
          .setTimestamp();
      }
    },
    majorIndicators: async () => {
      let btcDom = '—';
      try {
        const res = await axios.get(COINGECKO_GLOBAL_URL, { timeout: 6000 });
        const data = res.data?.data;
        if (data?.market_cap_percentage?.btc != null) {
          btcDom = data.market_cap_percentage.btc.toFixed(1) + '%';
        }
      } catch (_) {}
      const fng = state.fng || {};
      const fngVal = fng.value != null ? fng.value : null;
      const fngLabel = fng.valueClassification || '—';
      const fngStr = fngVal != null ? `${fngVal} (${fngLabel})` : '—';
      const kimpAvg = state.kimpAvg != null ? state.kimpAvg.toFixed(2) + '%' : '—';
      const kimpByMarket = state.kimpByMarket || {};
      const kimpLines = Object.keys(kimpByMarket).length
        ? Object.entries(kimpByMarket).map(([m, p]) => `${m.replace('KRW-', '')}: ${(p != null ? p.toFixed(2) : '—')}%`).join(', ')
        : '—';
      return new MessageEmbed()
        .setTitle('📈 주요지표')
        .setColor(ANALYST_EMBED_COLOR)
        .addFields(
          { name: '비트코인 도미넌스', value: btcDom, inline: true },
          { name: '공포·탐욕 지수', value: fngStr, inline: true },
          { name: '김프(평균)', value: kimpAvg, inline: true },
          { name: '김프(종목별)', value: kimpLines.length > 1024 ? kimpLines.slice(0, 1021) + '…' : kimpLines, inline: false }
        )
        .setFooter({ text: 'F&G: alternative.me | 김프: 업비트 vs 바이낸스 기준' })
        .setTimestamp();
    },
    diagnoseNoTrade: async () => {
      try {
        const hours = 12;
        const [trades12h, reject12h] = await Promise.all([
          db.getTradesSinceHours(hours),
          db.getRejectLogsSinceHours(hours)
        ]);
        const profile = scalpEngine.getProfile() || {};
        const assets = state.assets;
        const lastRejectStr = Object.keys(lastRejectBySymbol).length
          ? Object.entries(lastRejectBySymbol).map(([sym, r]) => `${sym}: ${(r || '').slice(0, 40)}`).join(' | ')
          : '없음';
        const diagnoseAnalyzer = require('./lib/diagnoseNoTradeAnalyzer');
        const localSummary = diagnoseAnalyzer.buildDiagnoseSummary({
          trades12h,
          reject12h,
          profile,
          assets,
          lastRejectBySymbol,
          botEnabled: state.botEnabled
        });
        const rejectReasonsSample = reject12h.slice(0, 10).map((r) => r.reason || '').filter(Boolean).join('; ') || '없음';
        const structuredForGemini = [
          `[최근 ${hours}시간 매매 건수] ${trades12h.length}`,
          `[최근 ${hours}시간 거절 건수] ${reject12h.length}`,
          `[거절 주요 사유 샘플] ${rejectReasonsSample}`,
          `[프로필] entry_score_min=${profile.entry_score_min ?? '—'}, strength_threshold=${profile.strength_threshold ?? '—'}, rsi_oversold=${profile.rsi_oversold ?? '—'}`,
          `[주문 가능 원화] ${assets?.orderableKrw != null ? Number(assets.orderableKrw).toLocaleString('ko-KR') : '—'}원`,
          `[엔진 가동] ${state.botEnabled ? 'ON' : 'OFF'}`,
          `[종목별 마지막 거절] ${lastRejectStr}`,
          '[로컬 진단 요약]',
          localSummary || '없음'
        ].join('\n');

        let body = localSummary || '진단 데이터 수집 완료. 요약을 생성할 수 없습니다.';
        let usedGemini = false;
        if (EngineStateStore.get().geminiEnabled) {
          try {
            const gemini = require('./lib/gemini');
            const geminiResult = await gemini.askGeminiForNoTradeDiagnosis(structuredForGemini);
            if (geminiResult && typeof geminiResult === 'string' && geminiResult.trim().length >= 10) {
              body = geminiResult.trim();
              usedGemini = true;
            }
          } catch (e) {
            if (typeof require('./lib/gemini').handleGeminiError === 'function') require('./lib/gemini').handleGeminiError(e);
          }
        }
        if (body) {
          diagnosticsStore.push({
            ts: Date.now(),
            source: usedGemini ? 'gemini' : 'local',
            localSummary: localSummary || '',
            finalBody: body,
            meta: {
              trades12h: trades12h.length,
              rejects12h: reject12h.length,
              topRejectReasons: rejectReasonsSample,
              entryScoreMin: profile.entry_score_min ?? null,
              strengthThreshold: profile.strength_threshold ?? null,
              orderableKrw: assets?.orderableKrw ?? null,
              botEnabled: state.botEnabled
            }
          });
          if (diagnosticsStore.length > DIAGNOSTICS_STORE_MAX) diagnosticsStore.shift();
        }
        return new MessageEmbed()
          .setTitle('🔍 거래 부재 원인 진단')
          .setColor(ANALYST_EMBED_COLOR)
          .setDescription(body)
          .addFields({ name: '수집 데이터', value: `최근 ${hours}h 매매 ${trades12h.length}건, 거절 ${reject12h.length}건`, inline: false })
          .setFooter({ text: usedGemini ? `Gemini 2.5 Flash · prompt ${DIAGNOSIS_PROMPT_VERSION}` : `로컬 분석 (fallback) · ${DIAGNOSIS_PROMPT_VERSION}` })
          .setTimestamp();
      } catch (e) {
        return new MessageEmbed()
          .setTitle('🔍 거래 부재 원인 진단')
          .setColor(ANALYST_EMBED_COLOR)
          .setDescription('오류: ' + (e?.message || '진단 실패'))
          .setTimestamp();
      }
    },
    suggestLogic: async () => {
      try {
        const n = diagnosticsStore.length;
        if (n < MIN_DIAGNOSTICS_FOR_SUGGEST) {
          return new MessageEmbed()
            .setTitle('💡 매매 로직 수정안 제안')
            .setColor(ANALYST_EMBED_COLOR)
            .setDescription(`아직 데이터가 부족합니다 (현재: ${n}/${MIN_DIAGNOSTICS_FOR_SUGGEST}). 분석이 더 쌓인 후에 요청해 주세요.`)
            .addFields({ name: '안내', value: '「🔍 거래 부재 원인 진단」 버튼을 여러 번 실행해 진단을 쌓아 주세요.', inline: false })
            .setTimestamp();
        }
        const entries = diagnosticsStore.map((d) => (typeof d === 'string' ? { finalBody: d, meta: {} } : d));
        const diagnoseAnalyzer = require('./lib/diagnoseNoTradeAnalyzer');
        const baseSuggestion = diagnoseAnalyzer.buildSuggestSummary(entries.map((e) => e.finalBody));
        let body = baseSuggestion || '제안을 생성할 수 없습니다.';
        let usedGemini = false;
        if (EngineStateStore.get().geminiEnabled) {
          const principleBlock = [
            '[안전 원칙]',
            '- 안전장치 완화는 매우 보수적으로 할 것.',
            '- 한 번에 1~2개 항목만 제안할 것.',
            '- 근거 없는 threshold 완화 금지. 수정 금지 항목이 있으면 명시할 것.',
            '- 20줄 이내로만 출력.'
          ].join('\n');
          const accumulatedParts = entries.map((e, i) => {
            const meta = e.meta || {};
            const metaLine = Object.keys(meta).length
              ? `[메타] 매매 ${meta.trades12h ?? '—'}건, 거절 ${meta.rejects12h ?? '—'}건, entry_score_min=${meta.entryScoreMin ?? '—'}, strength_threshold=${meta.strengthThreshold ?? '—'}, orderableKrw=${meta.orderableKrw ?? '—'}, bot=${meta.botEnabled ?? '—'}, topRejectReasons=${(meta.topRejectReasons || '').slice(0, 80)}`
              : '';
            return `[진단 ${i + 1}]\n${e.finalBody}${metaLine ? '\n' + metaLine : ''}`;
          });
          const accumulatedText = accumulatedParts.join('\n---\n');
          const principleAndAccumulated = `${principleBlock}\n\n[누적 진단 요약]\n${accumulatedText}`;
          try {
            const gemini = require('./lib/gemini');
            const geminiResult = await gemini.askGeminiForLogicSuggestion(principleAndAccumulated);
            const trimmed = geminiResult && typeof geminiResult === 'string' ? geminiResult.trim() : '';
            if (validateLogicSuggestionResponse(trimmed)) {
              body = trimmed;
              usedGemini = true;
            }
          } catch (e) {
            if (typeof require('./lib/gemini').handleGeminiError === 'function') require('./lib/gemini').handleGeminiError(e);
          }
        }
        return new MessageEmbed()
          .setTitle('💡 매매 로직 수정안 제안')
          .setColor(ANALYST_EMBED_COLOR)
          .setDescription(body)
          .setFooter({ text: usedGemini ? `Gemini 2.5 Flash · logic ${LOGIC_PROMPT_VERSION}` : `로컬 분석 (fallback) · ${LOGIC_PROMPT_VERSION}` })
          .setTimestamp();
      } catch (e) {
        return new MessageEmbed()
          .setTitle('💡 매매 로직 수정안 제안')
          .setColor(ANALYST_EMBED_COLOR)
          .setDescription('오류: ' + (e?.message || '제안 실패'))
          .setTimestamp();
      }
    },
    /** 하루치 로그(일 단위) 분석 — 당일 로그 + DB 요약을 Gemini로 분석 후 Discord에 결론 전달 (OpenAI 미사용) */
    dailyLogAnalysis: async () => {
      try {
        const logText = readTodayLogContent();
        if (!logText || logText.trim().length === 0) {
          return { content: '오늘자 로그가 없습니다. (logs/ 폴더의 .log 파일에서 오늘 날짜 라인만 사용합니다)' };
        }
        let dbContext = '';
        try {
          const [trades, rejects] = await Promise.all([
            db.getTradesSinceHours(24),
            db.getRejectLogsSinceHours(24)
          ]);
          const todayStats = await db.getTodayStats();
          dbContext = `[당일 DB 요약] 거래 ${trades?.length ?? 0}건, 거절 ${rejects?.length ?? 0}건, 당일 PnL ${todayStats.pnl ?? 0}, 승률 ${(todayStats.winRate ?? 0).toFixed(1)}%\n`;
          if (trades?.length) dbContext += '최근 거래(최대 5건): ' + JSON.stringify(trades.slice(0, 5).map((t) => ({ ticker: t.ticker, side: t.side, reason: t.reason, net_return: t.net_return }))) + '\n';
          if (rejects?.length) dbContext += '최근 거절(최대 10건): ' + JSON.stringify(rejects.slice(0, 10).map((r) => ({ ticker: r.ticker, reason: r.reason }))) + '\n';
        } catch (_) {}
        if (!EngineStateStore.get().geminiEnabled) {
          return { content: 'AI 기능이 일시 중지되었습니다. (예산 초과 등으로 구글 결제 차단 시 기본 모드로 전환됩니다.)' };
        }
        const gemini = require('./lib/gemini');
        const analysis = await gemini.askGeminiForLogAnalysis(logText, dbContext || undefined);
        return { content: analysis || '분석 결과를 생성하지 못했습니다.' };
      } catch (e) {
        const gemini = require('./lib/gemini');
        if (typeof gemini.handleGeminiError === 'function') gemini.handleGeminiError(e);
        return { content: '로그 분석 오류: ' + (e?.message || '알 수 없음') };
      }
    },
    /** 조언자의 한마디: 최근 3건 거래 → Gemini 분석 → 교훈 한 줄 strategy_memory.txt에 저장 */
    advisorOneLiner: async () => {
      try {
        const trades = tradeHistoryLogger.getLastTradesForAdvisor(3);
        const memoryText = tradeHistoryLogger.getStrategyMemory();
        const tradesText = trades.length
          ? trades.map((t) => JSON.stringify({ ticker: t.ticker, side: t.side, timestamp: t.timestamp, price: t.price, quantity: t.quantity, net_return: t.net_return, reason: t.reason, rsi: t.rsi, trend_score: t.trend_score })).join('\n')
          : '최근 거래 이력이 없습니다. 매수/매도가 발생하면 여기에 기록됩니다.';
        if (!EngineStateStore.get().geminiEnabled) {
          return { content: 'AI 기능이 일시 중지되었습니다. (예산 초과로 구글 결제 차단 시 기본 매매 모드로 전환됩니다.)' };
        }
        const gemini = require('./lib/gemini');
        const { analysis, lesson } = await gemini.askGeminiForAdvisorAdvice(tradesText, memoryText || undefined);
        if (lesson) tradeHistoryLogger.appendStrategyMemory(lesson);
        return { content: analysis };
      } catch (e) {
        const gemini = require('./lib/gemini');
        if (typeof gemini.handleGeminiError === 'function') gemini.handleGeminiError(e);
        return { content: '조언자 분석 오류: ' + (e?.message || '알 수 없음') };
      }
    }
  };

  discordHandlers.analyst = analystHandlers;

  app.get('/api/analyst/scan_vol', async (req, res) => {
    try {
      const embed = await analystHandlers.scanVol();
      if (!embed) return res.status(500).json({ error: 'No data' });
      return res.json(embed.toJSON());
    } catch (e) {
      return res.status(500).json({ error: e?.message || 'scan_vol error' });
    }
  });
  app.get('/api/analyst/get_prompt', async (req, res) => {
    try {
      const embed = await analystHandlers.getPrompt();
      if (!embed) return res.status(500).json({ error: 'No data' });
      return res.json(embed.toJSON());
    } catch (e) {
      return res.status(500).json({ error: e?.message || 'get_prompt error' });
    }
  });
  app.get('/api/analyst/major_indicators', async (req, res) => {
    try {
      const embed = await analystHandlers.majorIndicators();
      if (!embed) return res.status(500).json({ error: 'No data' });
      return res.json(embed.toJSON());
    } catch (e) {
      return res.status(500).json({ error: e?.message || 'major_indicators error' });
    }
  });

  const effectiveAdminIdForApi = (apiKeys.discordAdminId || process.env.ADMIN_ID || '').trim();
  app.get('/api/analyst/diagnose_no_trade', async (req, res) => {
    if (effectiveAdminIdForApi && req.query.admin_id !== effectiveAdminIdForApi) {
      return res.status(403).json({ error: '관리자만 사용할 수 있습니다.' });
    }
    try {
      const embed = await analystHandlers.diagnoseNoTrade();
      if (!embed) return res.status(500).json({ error: 'No data' });
      return res.json(embed.toJSON());
    } catch (e) {
      return res.status(500).json({ error: e?.message || 'diagnose_no_trade error' });
    }
  });
  app.get('/api/analyst/suggest_logic', async (req, res) => {
    if (effectiveAdminIdForApi && req.query.admin_id !== effectiveAdminIdForApi) {
      return res.status(403).json({ error: '관리자만 사용할 수 있습니다.' });
    }
    try {
      const embed = await analystHandlers.suggestLogic();
      if (!embed) return res.status(500).json({ error: 'No data' });
      return res.json(embed.toJSON());
    } catch (e) {
      return res.status(500).json({ error: e?.message || 'suggest_logic error' });
    }
  });

  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
  function startFourHourlyMarketReport(aiAnalysisChannelId) {
    if (!aiAnalysisChannelId || !discordBot.sendToChannelId) return;
    async function runReport() {
      try {
        const tickers = await upbit.getTopKrwTickersByTradePrice(30);
        if (!tickers || tickers.length === 0) return;
        let upCount = 0;
        let downCount = 0;
        const topGainers = [];
        const topLosers = [];
        for (const t of tickers) {
          const rate = t.signed_change_rate != null ? Number(t.signed_change_rate) * 100 : 0;
          if (rate > 0) upCount++;
          else if (rate < 0) downCount++;
          const symbol = (t.market || '').replace('KRW-', '');
          if (rate > 0) topGainers.push({ symbol, rate });
          else if (rate < 0) topLosers.push({ symbol, rate });
        }
        topGainers.sort((a, b) => b.rate - a.rate);
        topLosers.sort((a, b) => a.rate - b.rate);
        const upPct = tickers.length > 0 ? ((upCount / tickers.length) * 100).toFixed(1) : '0';
        const downPct = tickers.length > 0 ? ((downCount / tickers.length) * 100).toFixed(1) : '0';
        const top3Up = topGainers.slice(0, 3).map((x) => `${x.symbol} +${x.rate.toFixed(2)}%`).join(', ');
        const top3Down = topLosers.slice(0, 3).map((x) => `${x.symbol} ${x.rate.toFixed(2)}%`).join(', ');
        const embed = new MessageEmbed()
          .setTitle('📊 4시간 시황 브리핑')
          .setColor(ANALYST_EMBED_COLOR)
          .setDescription(`업비트 거래대금 상위 30종목 기준 시장 요약`)
          .addFields(
            { name: '상승 비율', value: `${upCount}종 (${upPct}%)`, inline: true },
            { name: '하락 비율', value: `${downCount}종 (${downPct}%)`, inline: true },
            { name: '상위 상승', value: top3Up || '—', inline: false },
            { name: '상위 하락', value: top3Down || '—', inline: false }
          )
          .setFooter({ text: 'MyScalpBot · 4시간마다 자동 발송' })
          .setTimestamp();
        await discordBot.sendToChannelId(aiAnalysisChannelId, embed);
      } catch (e) {
        console.warn('[MyScalpBot] 4시간 시황 브리핑 실패:', e?.message);
      }
    }
    runReport();
    setInterval(runReport, FOUR_HOURS_MS);
    console.log('[MyScalpBot] 4시간 시황 브리핑 예약됨 (#ai-analysis 채널)');
  }

  const ONE_HOUR_MS = 60 * 60 * 1000;
  function startHourlyHealthCheck() {
    if (!discordBot.sendDmToAdmin) return;
    function runHealthCheck() {
      if (discordBot.isOnline()) {
        discordBot.sendDmToAdmin('가즈아').then((ok) => {
          if (ok) console.log('[MyScalpBot] 1시간 헬스체크 DM 전송 (가즈아)');
        });
      }
    }
    setInterval(runHealthCheck, ONE_HOUR_MS);
    setTimeout(runHealthCheck, ONE_HOUR_MS);
    console.log('[MyScalpBot] 1시간 헬스체크 예약됨 (관리자 DM: 가즈아)');
  }

  if (require.main !== module) module.exports.discordHandlers = discordHandlers;

  if (require.main === module) {
    // 부팅 시퀀스 직렬화: 1) fetchAssets 2) gemini.init() 3) client.login (순서 보장)
    if (apiKeys.discordBotToken && apiKeys.discordChannelId) {
      try {
        console.log('[Boot] 1/3 Upbit 자산 조회 중…');
        const assets = await fetchAssets();
        state.assets = assets;
        console.log('[Boot] 2/3 Gemini 초기화 중…');
        const gemini = require('./lib/gemini');
        if (typeof gemini.init === 'function') await gemini.init();
        else if (typeof gemini.getModelName === 'function') gemini.getModelName();
        console.log('[Boot] 3/3 Discord 로그인 시퀀스 시작');
      } catch (e) {
        console.warn('[Boot] 자산/Gemini 준비 오류:', e?.message);
      }
    }

    if (apiKeys.discordBotToken && apiKeys.discordChannelId) {
      try {
        restoreSystemState();
        if (typeof tradeLogger.truncateLogsOlderThanDays === 'function') {
          const removed = tradeLogger.truncateLogsOlderThanDays(7);
          if (removed > 0) console.log('[Boot] 로그 7일 초과 라인 정리:', removed, '줄');
        }
        console.log('[MyScalpBot] 시작 중 (DISCORD_TOKEN/DISCORD_BOT_TOKEN 사용)…');
        const startupPromise = await discordBot.start({
          token: apiKeys.discordBotToken,
          channelId: apiKeys.discordChannelId,
          adminId: apiKeys.discordAdminId || null,
          adminDiscordId: apiKeys.discordAdminDiscordId || apiKeys.discordAdminId || null,
          tradingLogChannelId: apiKeys.tradingLogChannelId || null,
          aiAnalysisChannelId: apiKeys.aiAnalysisChannelId || null,
          handlers: discordHandlers
        });
        if (typeof upbit.setRateLimitAlertCallback === 'function') {
          upbit.setRateLimitAlertCallback(() => {
            if (discordBot.sendToChannel) discordBot.sendToChannel('⚠️ 업비트 429 — 5분간 API 일시 중단').catch(() => {});
          });
        }
        if (typeof upbit.setEmergencyPauseCallback === 'function') {
          upbit.setEmergencyPauseCallback((pauseMs) => {
            const ms = pauseMs || 5 * 60 * 1000;
            const now = Date.now();
            const s = EngineStateStore.get();
            const shouldLog = ApiAccessPolicy.shouldLogPauseState(now, s.lastPauseLogAt, ApiAccessPolicy.PAUSE_LOG_MIN_INTERVAL_MS);
            EngineStateStore.update({
              emergencyPauseUntil: now + ms,
              emergencyPauseReason: 'rate_limit_429',
              mode: EngineMode.EMERGENCY_PAUSE,
              lastPauseLogAt: now
            });
            if (shouldLog) {
              console.warn('[EngineMode] EMERGENCY_PAUSE 진입 (429)', { until: now + ms, reason: 'rate_limit_429' });
            }
            if (discordBot.sendToChannel) {
              discordBot.sendToChannel(`⚠️ 업비트 429 발생 — ${Math.round(ms / 1000)}초간 API 일시 중단 (Emergency Pause)`).catch(() => {});
            }
          });
        }
        if (typeof geminiModule.setOnBillingDisabledCallback === 'function') {
          geminiModule.setOnBillingDisabledCallback(() => {
            EngineStateStore.update({ geminiEnabled: false });
            const msg = '⚠️ 예산 초과로 구글 결제가 차단되었습니다. AI 기능을 정지하고 기본 매매 모드로 전환합니다.';
            if (discordBot.sendDmToAdmin) {
              discordBot.sendDmToAdmin(msg).catch(() => {});
            }
            if (discordBot.sendToChannel) {
              discordBot.sendToChannel(msg).catch(() => {});
            }
          });
        }
        if (startupPromise && typeof startupPromise.then === 'function') {
          await startupPromise;
          console.log('[MyScalpBot] 재가동 패널 전송 순서 완료 (역할 A → B → C → [📊 현재 상태]). 메시지 순서: MarketSearchEngine(별도 프로세스) → 역할 A → B → C.');
        }
        console.log('[MyScalpBot] 로그인 요청 완료. 온라인 시 "[MyScalpBot] 온라인" 로그 확인.');
        startFourHourlyMarketReport(apiKeys.aiAnalysisChannelId);
        startHourlyHealthCheck();
      } catch (e) {
        console.error('[MyScalpBot] 로그인 실패:', e?.message);
      }
    } else {
      console.warn('[MyScalpBot] 미시작 — .env에 DISCORD_TOKEN(또는 DISCORD_BOT_TOKEN)과 CHANNEL_ID를 넣으면 매매 봇이 올라갑니다.');
    }

    server.listen(PORT, () => {
    console.log(`대시보드 http://localhost:${PORT}`);
    console.log('API 키:', apiKeys.accessKey ? '적용됨' : '미설정');
    console.log('Upbit WebSocket 시세 구독:', SCALP_MARKETS.join(', '));
    console.log('SQLite trades.db:', path.join(__dirname, 'trades.db'));
    if (MEME_PAGE_ONLY) console.log('MEME_PAGE_ONLY=1: /meme 전용 모드');
    if (ORCH_PAGE_ONLY) console.log('ORCH_PAGE_ONLY=1: /orchestrator 전용 모드');
    console.log('[server] 매매 엔진은 Discord/API에서 시작 버튼으로만 기동됩니다 (자동 시작 없음).');
    const cbs = getTradingEngineCallbacks();
    setTimeout(() => cbs.runMarketAnalyzerMedium().catch(() => {}), 3000);
    setTimeout(() => cbs.runMarketAnalyzerDaily().catch(() => {}), 15000);
    memeEngine.start(async (symbol) => {
      const t = state.prices['KRW-' + symbol];
      return t?.trade_price ?? 0;
    });
    setInterval(() => {
      mpiDiagnostics.runEvaluation(upbit.getCandlesMinutes).catch((e) => console.warn('mpiDiagnostics.runEvaluation', e?.message));
    }, 10 * 60 * 1000);
    setInterval(() => {
      regimeDetector.detectAll().catch((e) => console.warn('regimeDetector.detectAll', e?.message));
    }, 5 * 60 * 1000);
    setTimeout(() => regimeDetector.detectAll().catch(() => {}), 5000);
    setInterval(() => {
      const getMpi = (sym) => (memeEngine.getMPI(sym) || {}).mpi ?? 0;
      patternLearner.learnAll(getMpi).catch((e) => console.warn('patternLearner.learnAll', e?.message));
    }, 30 * 60 * 1000);
  });
  }
})();

if (require.main !== module) {
  module.exports = {
    initPromise,
    state,
    EngineStateStore,
    tradingEngine,
    app,
    io,
    server,
    fetchAssets,
    runScalpCycle,
    buildCurrentStateEmbed,
    buildCurrentReturnEmbed,
    getProfitPct,
    apiKeys,
    SCALP_MARKETS,
    upbit,
    cancelAllOrders,
    TradeExecutor,
    db,
    discordHandlers: null
  };
}

/**
 * 단일 진입점: node server.js 한 번만 실행하면
 * - 포트 3000에서 웹 대시보드(Express) + Scalp 엔진이 구동되고
 * - .env/config에 DISCORD_TOKEN, CHANNEL_ID가 있으면 같은 프로세스에서 디스코드 봇이 login 됨.
 * discord_agent.js는 사용하지 말고 server.js만 실행하세요. (중복 실행 시 포트 충돌)
 */
