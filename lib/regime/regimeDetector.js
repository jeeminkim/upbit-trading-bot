/**
 * Regime Detection: TREND_UP, TREND_DOWN, RANGE, VOLATILE
 * ATR expansion, MA slope, price distance from MA, volatility clustering, funding/OI trend
 * 결과 저장: /data/regime_history.jsonl
 */

const path = require('path');
const fs = require('fs');
const logger = require('../meme/logger');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const REGIME_FILE = path.join(DATA_DIR, 'regime_history.jsonl');
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP'];
const MARKET_PREFIX = 'KRW-';

/** Upbit getCandlesMinutes(minuteUnit, market, count, to) 주입 */
let getCandlesMinutes = null;
/** Upbit getCandlesDays(market, count, to) 주입 */
let getCandlesDays = null;
/** optional: funding rate / OI for regime (futures) */
let getFuturesSentiment = null;

function setCandleFetcher(fn) {
  getCandlesMinutes = fn;
}
function setCandlesDays(fn) {
  getCandlesDays = fn;
}
function setFuturesFetcher(fn) {
  getFuturesSentiment = fn;
}

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error('[regimeDetector] ensureDataDir:', e.message);
  }
}

function appendRegime(record) {
  try {
    ensureDataDir();
    fs.appendFileSync(REGIME_FILE, JSON.stringify(record) + '\n', 'utf8');
  } catch (e) {
    console.error('[regimeDetector] appendRegime:', e.message);
  }
}

/**
 * 1h 캔들 N개로 ATR(14), MA(20) slope, price vs MA 거리, volatility(표준편차) 계산
 */
function computeMetrics(candles1h) {
  if (!Array.isArray(candles1h) || candles1h.length < 20) return null;
  const close = candles1h.map(c => Number(c.trade_price)).filter(n => !isNaN(n));
  const high = candles1h.map(c => Number(c.high_price)).filter(n => !isNaN(n));
  const low = candles1h.map(c => Number(c.low_price)).filter(n => !isNaN(n));
  if (close.length < 20) return null;

  const period = 14;
  const maLen = 20;
  const atr = (() => {
    const tr = [];
    for (let i = 1; i < close.length; i++) {
      const h = high[i] ?? close[i];
      const l = low[i] ?? close[i];
      tr.push(Math.max(h - l, Math.abs(h - close[i - 1]), Math.abs(l - close[i - 1])));
    }
    if (tr.length < period) return 0;
    let sum = tr.slice(0, period).reduce((a, b) => a + b, 0);
    let atrVal = sum / period;
    for (let i = period; i < tr.length; i++) {
      atrVal = (atrVal * (period - 1) + tr[i]) / period;
    }
    return atrVal;
  })();

  const ma20 = close.length >= maLen
    ? close.slice(-maLen).reduce((a, b) => a + b, 0) / maLen
    : close[close.length - 1];
  const price = close[close.length - 1];
  const priceDistanceFromMa = price > 0 ? (price - ma20) / price : 0;

  const maPrev = close.length >= maLen + 5
    ? close.slice(-maLen - 5, -5).reduce((a, b) => a + b, 0) / maLen
    : ma20;
  const maSlope = maPrev !== 0 ? (ma20 - maPrev) / maPrev : 0;

  const recent = close.slice(-20);
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const variance = recent.reduce((a, b) => a + (b - mean) ** 2, 0) / recent.length;
  const volatility = mean > 0 ? Math.sqrt(variance) / mean : 0;

  const atrPct = price > 0 ? atr / price : 0;
  return {
    atr,
    atrPct,
    ma20,
    maSlope,
    priceDistanceFromMa,
    volatility,
    price
  };
}

/**
 * trend_score, volatility_score, range_score → argmax → TREND_UP | TREND_DOWN | RANGE | VOLATILE
 */
function classifyRegime(symbol, metrics, fundingHeat = 0) {
  if (!metrics) return { regime: 'RANGE', volatility: 0, trend_strength: 0 };
  const { maSlope, priceDistanceFromMa, volatility, atrPct } = metrics;

  const trend_score = maSlope > 0.02 ? 1 : maSlope > 0.005 ? 0.6 : maSlope < -0.02 ? -1 : maSlope < -0.005 ? -0.6 : 0;
  const trend_strength = Math.abs(maSlope) * 50 + Math.min(1, Math.abs(priceDistanceFromMa) * 10);
  const volatility_score = (atrPct > 0.03 ? 1 : atrPct > 0.015 ? 0.6 : 0) + (volatility > 0.02 ? 0.5 : 0);
  const range_score = Math.abs(maSlope) < 0.005 && volatility < 0.015 ? 1 : 0.3;

  let regime = 'RANGE';
  const scores = [
    { name: 'TREND_UP', v: trend_score > 0.3 ? trend_strength : 0 },
    { name: 'TREND_DOWN', v: trend_score < -0.3 ? trend_strength : 0 },
    { name: 'RANGE', v: range_score },
    { name: 'VOLATILE', v: volatility_score }
  ];
  const best = scores.reduce((a, b) => (b.v > a.v ? b : a), { name: 'RANGE', v: 0 });
  if (best.v > 0.3) regime = best.name;

  logger.regime(`symbol=${symbol} regime=${regime} volatility=${(metrics.volatility || 0).toFixed(2)} trend_strength=${trend_strength.toFixed(2)}`, { symbol, regime, volatility: metrics.volatility, trend_strength });
  return { regime, volatility: metrics.volatility ?? 0, trend_strength };
}

/**
 * 심볼 하나에 대해 캔들 조회 → 메트릭 → regime → 저장
 */
async function detectOne(symbol) {
  if (!getCandlesMinutes) return null;
  const market = MARKET_PREFIX + symbol;
  try {
    const candles1h = await getCandlesMinutes(60, market, 50);
    const metrics = computeMetrics(candles1h);
    let fundingHeat = 0;
    if (getFuturesSentiment) {
      try {
        const pair = symbol === 'BTC' ? 'BTCUSDT' : symbol === 'ETH' ? 'ETHUSDT' : symbol === 'SOL' ? 'SOLUSDT' : 'XRPUSDT';
        const f = await getFuturesSentiment(pair);
        fundingHeat = f?.funding_heat ?? 0;
      } catch (_) {}
    }
    const { regime, volatility, trend_strength } = classifyRegime(symbol, metrics, fundingHeat);
    const ts = Math.floor(Date.now() / 1000);
    const record = { symbol, timestamp: ts, regime, volatility, trend_strength };
    appendRegime(record);
    return record;
  } catch (e) {
    logger.error('regimeDetector detectOne', { symbol, message: e.message });
    return null;
  }
}

async function detectAll() {
  const results = {};
  for (const symbol of SYMBOLS) {
    try {
      const r = await detectOne(symbol);
      if (r) results[symbol] = r;
    } catch (err) {
      logger.error('regimeDetector detectAll', { symbol, message: err.message });
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return results;
}

function readLastLines(n = 200) {
  try {
    if (!fs.existsSync(REGIME_FILE)) return [];
    const content = fs.readFileSync(REGIME_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.slice(-n).map(line => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

module.exports = {
  setCandleFetcher,
  setCandlesDays,
  setFuturesFetcher,
  detectOne,
  detectAll,
  readLastLines,
  REGIME_FILE
};
