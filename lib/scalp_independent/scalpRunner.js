/**
 * 독립 초단타 스캘프 봇 — 메인 루프 및 Upbit API 연동
 * server.js에서 tick(ctx) 호출 또는 start() 후 내부 setInterval
 * - 우선권 SCALP 시에만 진입, 메인 오케스트레이터는 server에서 차단
 * - 익절/손절 후 independent_scalp_history.jsonl + independent_scalp.log 기록
 */

const path = require('path');
const fs = require('fs');
const logRotation = require('../logRotation');

const scalpState = require('./scalpState');
const baseline = require('./adaptiveBaseline');
const scalpOrchestrator = require('./scalpOrchestrator');
const { UPBIT_FEE_RATE } = require(path.join(__dirname, '..', '..', 'src/shared/constants'));

const SCALP_MARKETS = ['KRW-BTC', 'KRW-ETH', 'KRW-SOL', 'KRW-XRP'];
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const LOG_FILE = path.join(__dirname, '..', '..', 'logs', 'independent_scalp.log');
const MAX_LOG_SIZE_BYTES = logRotation.DEFAULT_MAX_SIZE_BYTES;
const MAX_LOG_BACKUPS = 5;
const HISTORY_FILE = path.join(DATA_DIR, 'independent_scalp_history.jsonl');

const MIN_ORDER_KRW = 5000;
const TAKE_PROFIT_PCT = 0.2;
const STOP_LOSS_PCT = -0.15;
/** 최소 거래 간격(초): 무한 매매 방지 */
const MIN_TRADE_INTERVAL_MS = 30 * 1000;

function ensureDirs() {
  [path.dirname(LOG_FILE), DATA_DIR].forEach((dir) => {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}
  });
}

function logLine(msg) {
  ensureDirs();
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size >= MAX_LOG_SIZE_BYTES) {
      logRotation.rotateIfNeeded(LOG_FILE, MAX_LOG_SIZE_BYTES, MAX_LOG_BACKUPS);
    }
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch (_) {}
  console.log('[SCALP_INDEPENDENT]', msg);
}

function appendHistory(record) {
  ensureDirs();
  try {
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(record) + '\n', 'utf8');
  } catch (_) {}
}

/**
 * 10초 거래량 근사: 24h 체결대금을 초당으로 나눈 뒤 * 10 (업비트는 10s API 없음)
 */
function approxVol10sKrw(ticker) {
  const acc = Number(ticker?.acc_trade_price_24h) || 0;
  if (acc <= 0) return 0;
  return (acc / 8640) * 10; // 24*360 = 8640 초
}

/**
 * 시장 데이터 수집 및 decide → 진입/청산 처리
 * @param {Object} ctx - { upbit, getOrderbook, getTickers, state, apiKeys, TradeExecutor, recordTrade?, emitDashboard? }
 */
async function tick(ctx) {
  scalpState.checkExpiry();
  if (!scalpState.isRunning || scalpState.priorityOwner !== 'SCALP') return;
  if (scalpState.isRiskHalt()) {
    logLine('[SCALP_BOT_STATE] state=RISK_HALT priority=SCALP');
    return;
  }
  if (scalpState.activePosition) {
    await tickExit(ctx);
    return;
  }

  const { upbit, state, apiKeys, TradeExecutor } = ctx || {};
  if (!upbit || !apiKeys?.accessKey || !apiKeys?.secretKey || !TradeExecutor) return;

  try {
    const [tickers, orderbooks] = await Promise.all([
      upbit.getTickers ? upbit.getTickers(SCALP_MARKETS) : [],
      upbit.getOrderbook ? upbit.getOrderbook(SCALP_MARKETS) : []
    ]);
    const tickerMap = {};
    (tickers || []).forEach((t) => { tickerMap[t.market] = t; });
    const obMap = {};
    (orderbooks || []).forEach((o) => { obMap[o.market] = o; });

    for (const market of SCALP_MARKETS) {
      const symbol = market.replace('KRW-', '');
      const ticker = tickerMap[market];
      const ob = obMap[market];
      const price = state?.prices?.[market]?.tradePrice ?? state?.prices?.[market]?.trade_price ?? ticker?.trade_price;
      const vol10s = approxVol10sKrw(ticker);
      baseline.update(symbol, vol10s);

      const high40s = price; // 실제로는 40초 고가 큐 필요 시 state에서 유지
      const units = ob?.orderbook_units || [];
      const bidDepth = units.slice(0, 5).reduce((s, u) => s + (Number(u.bid_size) || 0), 0);
      const askDepth = units.slice(0, 5).reduce((s, u) => s + (Number(u.ask_size) || 0), 0);
      const total = bidDepth + askDepth;
      const strength = total > 0 ? bidDepth / total : 0.5;
      const obi = total > 0 ? (bidDepth - askDepth) / total : 0;

      const marketData = {
        symbol,
        vol10s,
        price,
        ob,
        high40s,
        strength,
        obi
      };

      const volPass = baseline.checkPass(symbol, vol10s);
      if (volPass.soft) logLine(`[ADAPTIVE_BASELINE] symbol=${symbol} vol_now_10s=${Math.round(vol10s)} baseline=${Math.round(baseline.getBaseline(symbol))} soft_pass=true`);

      const decision = await scalpOrchestrator.decide(marketData);
      if (!decision.shouldEntry) continue;

      if (scalpState.lastEntryTime != null && (Date.now() - scalpState.lastEntryTime) < MIN_TRADE_INTERVAL_MS) {
        logLine(`[SCALP_SKIP] symbol=${symbol} min_interval=${MIN_TRADE_INTERVAL_MS / 1000}s`);
        continue;
      }

      logLine(`[${decision.strategy}_SIGNAL] symbol=${symbol} score=${decision.score.toFixed(2)} reason="vol_soft + best_strategy"`);
      logLine(`[SCALP_DECISION] symbol=${symbol} chosen=${decision.strategy} score=${decision.score.toFixed(2)} action=ENTRY`);

      // 독립 스캘프 전용: 총 자산의 50% 투입 (orderableKrw + 코인 평가액), 가용 KRW 초과 불가
      const orderableKrw = state?.assets?.orderableKrw ?? 0;
      const totalEval = state?.assets?.totalEvaluationKrw ?? 0;
      const totalCoinEval = Math.max(0, (totalEval || 0) - (orderableKrw || 0));
      const totalAssets = orderableKrw + totalCoinEval;
      let amountKrw = totalAssets > 0 ? Math.floor(totalAssets * 0.5) : 0;
      amountKrw = Math.min(orderableKrw, amountKrw);
      amountKrw = Math.max(MIN_ORDER_KRW, amountKrw);
      if (amountKrw * (1 + UPBIT_FEE_RATE) > orderableKrw && orderableKrw > 0) {
        amountKrw = Math.floor(orderableKrw / (1 + UPBIT_FEE_RATE));
      }
      if (amountKrw < MIN_ORDER_KRW) {
        logLine(`[SCALP_SKIP] symbol=${symbol} insufficient_funds orderableKrw=${orderableKrw}`);
        if (ctx.sendAlert) ctx.sendAlert('⚠️ 잔액 부족으로 매수 건너뜀 (독립 스캘프)');
        continue;
      }

      try {
        const order = await TradeExecutor.placeMarketBuyByPrice(apiKeys.accessKey, apiKeys.secretKey, market, Math.round(amountKrw), orderableKrw);
        const execPrice = order && (order.price != null ? order.price : order.avg_price);
        const volume = order && (order.executed_volume != null ? order.executed_volume : order.volume);
        scalpState.activePosition = {
          symbol,
          market,
          entryPrice: execPrice ?? price,
          entryTime: Date.now(),
          strategy: decision.strategy,
          quantityKrw: amountKrw,
          volume
        };
        scalpState.dailyEntries += 1;
        scalpState.lastEntryTime = Date.now();
        if (ctx.recordTrade) {
          ctx.recordTrade({
            timestamp: new Date().toISOString(),
            ticker: market,
            side: 'buy',
            price: scalpState.activePosition.entryPrice,
            quantity: volume ?? 0,
            fee: 0,
            revenue: 0,
            net_return: 0,
            reason: 'SCALP_INDEPENDENT_' + decision.strategy,
            strategy_id: null
          });
        }
        logLine(`[SCALP_ENTRY] symbol=${symbol} side=BUY price=${scalpState.activePosition.entryPrice} qty=${volume} mode=TAKER`);
        if (ctx.emitDashboard) ctx.emitDashboard().catch(() => {});
        return; // 한 틱에 한 건만
      } catch (err) {
        const isInsufficient = err?.code === 'INSUFFICIENT_FUNDS_BID' || (err?.message && String(err.message).includes('INSUFFICIENT_FUNDS_BID'));
        logLine(`[SCALP_ENTRY_ERR] symbol=${symbol} err=${err?.message}`);
        if (isInsufficient && ctx.sendAlert) ctx.sendAlert('⚠️ 잔액 부족으로 매수 건너뜀 (독립 스캘프)');
      }
    }
  } catch (err) {
    logLine(`[SCALP_TICK_ERR] ${err?.message}`);
  }
}

async function tickExit(ctx) {
  const pos = scalpState.activePosition;
  if (!pos) return;

  const { state, apiKeys, TradeExecutor } = ctx || {};
  const market = pos.market;
  const currentPrice = state?.prices?.[market]?.tradePrice ?? state?.prices?.[market]?.trade_price;
  if (currentPrice == null || currentPrice <= 0) return;

  const entryPrice = pos.entryPrice;
  const volume = pos.volume ?? 0;
  const totalBuyKrw = entryPrice > 0 && volume > 0 ? entryPrice * volume : 0;
  const evaluationKrw = currentPrice > 0 && volume > 0 ? currentPrice * volume : 0;
  const pct = totalBuyKrw > 0 ? ((evaluationKrw - totalBuyKrw) / totalBuyKrw) * 100 : 0;

  const exitByTp = pct >= TAKE_PROFIT_PCT;
  const exitBySl = pct <= STOP_LOSS_PCT;
  const durationSec = Math.round((Date.now() - pos.entryTime) / 1000);

  if (!exitByTp && !exitBySl) return;

  try {
    if (volume > 0 && apiKeys?.accessKey && apiKeys?.secretKey && TradeExecutor?.placeMarketSellByVolume) {
      await TradeExecutor.placeMarketSellByVolume(apiKeys.accessKey, apiKeys.secretKey, market, volume);
    }
  } catch (err) {
    logLine(`[SCALP_EXIT_ERR] symbol=${pos.symbol} err=${err?.message}`);
  }

  if (exitByTp) logLine(`[SCALP_EXIT_TP] symbol=${pos.symbol} pnl=+${pct.toFixed(2)}% duration=${durationSec}s`);
  else logLine(`[SCALP_EXIT_SL] symbol=${pos.symbol} pnl=${pct.toFixed(2)}% duration=${durationSec}s`);

  scalpState.dailyPnl += pct;
  if (pct < 0) scalpState.recordLoss();
  else scalpState.recordWin();

  appendHistory({
    ts: Date.now(),
    symbol: pos.symbol,
    strategy: pos.strategy,
    entry: pos.entryPrice,
    exit: currentPrice,
    pnl: pct,
    vol_baseline: baseline.getBaseline(pos.symbol),
    duration_sec: durationSec
  });

  scalpState.activePosition = null;
  if (ctx.emitDashboard) ctx.emitDashboard().catch(() => {});
}

/** server.js에서 호출: 독립 스캘프 상태 (디스코드/대시보드용) */
function getStatus() {
  return {
    isRunning: scalpState.isRunning,
    isRaceHorseMode: scalpState.isRaceHorseMode,
    priorityOwner: scalpState.priorityOwner,
    endTime: scalpState.endTime,
    remainingMs: scalpState.getRemainingMs(),
    dailyEntries: scalpState.dailyEntries,
    dailyPnl: scalpState.dailyPnl,
    consecutiveLosses: scalpState.consecutiveLosses,
    riskHaltUntil: scalpState.riskHaltUntil,
    isRiskHalt: scalpState.isRiskHalt(),
    activePosition: scalpState.activePosition
  };
}

module.exports = {
  tick,
  getStatus,
  scalpState,
  SCALP_MARKETS
};
