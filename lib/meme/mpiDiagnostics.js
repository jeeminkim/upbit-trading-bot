/**
 * Signal 성능검진: PENDING 시그널에 대해 +5m/+15m/+60m 수익률·max_up/max_down 계산, label 부여
 * threshold별·symbol별 win rate, avg return, false_positive_rate
 * 무료 Upbit 분봉으로 가격 조회
 */

const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const signalStore = require('./signalStore');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SIGNALS_FILE = path.join(DATA_DIR, 'meme_signals.jsonl');
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP'];
const MARKET_PREFIX = 'KRW-';

/** Upbit 1분봉으로 특정 시각 이후 가격 조회. to = exclusive (해당 분 캔들 포함하려면 to = ts + 60) */
let getCandlesMinutes = null;

function setCandleFetcher(fn) {
  getCandlesMinutes = fn;
}

/**
 * signal detected_at(초) 기준 +afterSec 초 시점의 종가
 */
async function getPriceAt(symbol, detectedAtSec, afterSec, fetcher) {
  const fn = fetcher || getCandlesMinutes;
  if (!fn) return null;
  const market = MARKET_PREFIX + symbol;
  const toMs = (detectedAtSec + afterSec + 60) * 1000;
  const toIso = new Date(toMs).toISOString().slice(0, 19);
  try {
    const candles = await fn(1, market, 1, toIso);
    if (candles && candles[0]) return Number(candles[0].trade_price) || null;
  } catch (e) {
    logger.eval(`getPriceAt symbol=${symbol} after=${afterSec}s`, { message: e.message });
  }
  return null;
}

/**
 * 60분 동안 1분봉으로 max_up, max_down (signal 가격 대비)
 */
async function getMaxUpDown(symbol, priceAtSignal, detectedAtSec, fetcher) {
  const fn = fetcher || getCandlesMinutes;
  if (!fn || !priceAtSignal || priceAtSignal <= 0) return { max_up_60m: null, max_down_60m: null };
  const market = MARKET_PREFIX + symbol;
  const toMs = (detectedAtSec + 60 * 60 + 60) * 1000;
  const toIso = new Date(toMs).toISOString().slice(0, 19);
  try {
    const candles = await fn(1, market, 61, toIso);
    if (!Array.isArray(candles) || candles.length === 0) return { max_up_60m: null, max_down_60m: null };
    let maxUp = 0;
    let maxDown = 0;
    for (const c of candles) {
      const p = Number(c.trade_price) || Number(c.high_price) || Number(c.low_price);
      if (!p) continue;
      const ret = (p - priceAtSignal) / priceAtSignal;
      if (ret > maxUp) maxUp = ret;
      if (ret < maxDown) maxDown = ret;
    }
    return { max_up_60m: maxUp, max_down_60m: maxDown };
  } catch (e) {
    logger.eval(`getMaxUpDown symbol=${symbol}`, { message: e.message });
    return { max_up_60m: null, max_down_60m: null };
  }
}

function returnLabel(return_5m, return_15m, return_60m) {
  const r = return_60m ?? return_15m ?? return_5m;
  if (r == null) return 'NEUTRAL';
  if (r >= 0.01) return 'SUCCESS';
  if (r <= -0.01) return 'FAIL';
  return 'NEUTRAL';
}

/**
 * 단일 시그널 평가 후 evaluation 필드 갱신
 */
async function evaluateOne(signal, upbitGetCandles) {
  const fetcher = upbitGetCandles || getCandlesMinutes;
  if (!fetcher) return signal;
  const { symbol, detected_at, price_at_signal, evaluation } = signal;
  if (evaluation?.label !== 'PENDING') return signal;

  const p0 = price_at_signal && price_at_signal > 0 ? price_at_signal : null;
  if (!p0) return signal;

  const [p5, p15, p60] = await Promise.all([
    getPriceAt(symbol, detected_at, 5 * 60, fetcher),
    getPriceAt(symbol, detected_at, 15 * 60, fetcher),
    getPriceAt(symbol, detected_at, 60 * 60, fetcher)
  ]);

  const return_5m = p5 != null ? (p5 - p0) / p0 : null;
  const return_15m = p15 != null ? (p15 - p0) / p0 : null;
  const return_60m = p60 != null ? (p60 - p0) / p0 : null;

  const { max_up_60m, max_down_60m } = await getMaxUpDown(symbol, p0, detected_at, fetcher);

  const label = returnLabel(return_5m, return_15m, return_60m);
  logger.eval(`signal=${signal.id} return_5m=${return_5m != null ? (return_5m * 100).toFixed(2) + '%' : 'n/a'} return_60m=${return_60m != null ? (return_60m * 100).toFixed(2) + '%' : 'n/a'} label=${label}`, { id: signal.id, label });

  return {
    ...signal,
    evaluation: {
      return_5m,
      return_15m,
      return_60m,
      max_up_60m: max_up_60m ?? undefined,
      max_down_60m: max_down_60m ?? undefined,
      label
    }
  };
}

/**
 * jsonl 파일 전체를 읽어서 특정 id만 evaluation 갱신 후 다시 쓰기 (덮어쓰기)
 */
function rewriteSignalsFile(signals) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const content = signals.map(s => JSON.stringify(s)).join('\n') + (signals.length ? '\n' : '');
    fs.writeFileSync(SIGNALS_FILE, content, 'utf8');
  } catch (e) {
    logger.error('rewriteSignalsFile', { message: e.message });
  }
}

/**
 * PENDING 시그널만 평가하고 파일 갱신 (detected_at이 60분 이상 지난 것만)
 */
async function runEvaluation(upbitGetCandles) {
  const signals = signalStore.getSignalsLast(500);
  const pending = signals.filter(s => s.evaluation?.label === 'PENDING');
  const nowSec = Math.floor(Date.now() / 1000);
  const evaluable = pending.filter(s => nowSec - s.detected_at >= 60 * 60 + 60);
  if (evaluable.length === 0) return;

  logger.diag(`evaluating ${evaluable.length} pending signals`, { count: evaluable.length });
  const updated = new Map(signals.map(s => [s.id, s]));

  for (const s of evaluable) {
    try {
      const evaluated = await evaluateOne(s, upbitGetCandles);
      updated.set(evaluated.id, evaluated);
    } catch (err) {
      logger.error('evaluateOne', { id: s.id, message: err.message });
    }
    await new Promise(r => setTimeout(r, 200));
  }

  const newList = signals.map(s => updated.get(s.id) || s);
  rewriteSignalsFile(newList);
}

/**
 * threshold별 통계 (70, 80, 90)
 */
function statsByThreshold(signals) {
  const evaluated = signals.filter(s => s.evaluation?.label && s.evaluation.label !== 'PENDING');
  const byThresh = { 70: [], 80: [], 90: [] };
  for (const s of evaluated) {
    const mpi = s.mpi ?? 0;
    if (mpi >= 90) byThresh[90].push(s);
    else if (mpi >= 80) byThresh[80].push(s);
    else if (mpi >= 70) byThresh[70].push(s);
  }
  const out = {};
  for (const [t, list] of Object.entries(byThresh)) {
    const success = list.filter(s => s.evaluation?.label === 'SUCCESS').length;
    const fail = list.filter(s => s.evaluation?.label === 'FAIL').length;
    const total = list.length;
    const win_rate = total ? success / total : 0;
    const returns = list.map(s => s.evaluation?.return_60m).filter(r => r != null);
    const avg_return = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : null;
    const false_positive_rate = total ? fail / total : 0;
    out[t] = { total, success, fail, win_rate, avg_return, false_positive_rate };
  }
  return out;
}

/**
 * symbol별 통계
 */
function statsBySymbol(signals) {
  const evaluated = signals.filter(s => s.evaluation?.label && s.evaluation.label !== 'PENDING');
  const bySym = {};
  for (const s of SYMBOLS) bySym[s] = [];
  for (const s of evaluated) {
    if (bySym[s.symbol]) bySym[s.symbol].push(s);
  }
  const out = {};
  for (const [sym, list] of Object.entries(bySym)) {
    const success = list.filter(s => s.evaluation?.label === 'SUCCESS').length;
    const total = list.length;
    const win_rate = total ? success / total : 0;
    const returns = list.map(s => s.evaluation?.return_60m).filter(r => r != null);
    const avg_return = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : null;
    out[sym] = { total, success, win_rate, avg_return };
  }
  return out;
}

/**
 * 컴포넌트 중요도: 성공 시그널 vs 실패 시그널에서 S,T,N,O,F 평균 차이
 */
function componentImportance(signals) {
  const success = signals.filter(s => s.evaluation?.label === 'SUCCESS');
  const fail = signals.filter(s => s.evaluation?.label === 'FAIL');
  const keys = ['S', 'T', 'N', 'O', 'F'];
  const out = {};
  for (const k of keys) {
    const sAvg = success.length ? success.reduce((a, s) => a + (s.components?.[k] ?? 0), 0) / success.length : 0;
    const fAvg = fail.length ? fail.reduce((a, s) => a + (s.components?.[k] ?? 0), 0) / fail.length : 0;
    out[k] = { success_avg: sAvg, fail_avg: fAvg, diff: sAvg - fAvg };
  }
  return out;
}

module.exports = {
  setCandleFetcher,
  evaluateOne,
  runEvaluation,
  statsByThreshold,
  statsBySymbol,
  componentImportance,
  getSignalsLast: () => signalStore.getSignalsLast(100)
};
