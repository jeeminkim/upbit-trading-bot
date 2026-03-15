/**
 * 멀티타임프레임 학습: 1h/4h/12h/1d 캔들로 feature vector 구성, BUY_GOOD/BUY_BAD/SELL_GOOD 라벨링
 * 저장: /data/pattern_dataset.json
 */

const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DATASET_FILE = path.join(DATA_DIR, 'pattern_dataset.json');
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP'];
const MARKET_PREFIX = 'KRW-';

let getCandlesMinutes = null;
let getCandlesDays = null;

function setCandleFetchers(minutesFn, daysFn) {
  getCandlesMinutes = minutesFn;
  getCandlesDays = daysFn;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function rsi(closes, period = 14) {
  if (!closes || closes.length < period + 1) return 0.5;
  const changes = [];
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);
  const recent = changes.slice(-period);
  const gains = recent.filter(c => c > 0).reduce((a, b) => a + b, 0) / period;
  const losses = recent.filter(c => c < 0).reduce((a, b) => a + Math.abs(b), 0) / period;
  if (losses === 0) return 1;
  const rs = gains / losses;
  return rs / (1 + rs);
}

function atr(high, low, close, period = 14) {
  if (!close || close.length < period + 1) return 0;
  const tr = [];
  for (let i = 1; i < close.length; i++) {
    tr.push(Math.max(
      (high[i] || close[i]) - (low[i] || close[i]),
      Math.abs((high[i] || close[i]) - close[i - 1]),
      Math.abs((low[i] || close[i]) - close[i - 1])
    ));
  }
  const recent = tr.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / period;
}

/**
 * 한 시점의 feature vector
 */
function buildFeatureVector(symbol, candles1h, candles4h, candles12h, candles1d, orderbookImbalance = 0, spreadRatio = 0, mpi = 0) {
  const c1 = (candles1h || []).map(c => Number(c.trade_price)).filter(n => !isNaN(n));
  const h1 = (candles1h || []).map(c => Number(c.high_price)).filter(n => !isNaN(n));
  const l1 = (candles1h || []).map(c => Number(c.low_price)).filter(n => !isNaN(n));
  const c4 = (candles4h || []).map(c => Number(c.trade_price)).filter(n => !isNaN(n));
  const c12 = (candles12h || []).map(c => Number(c.trade_price)).filter(n => !isNaN(n));
  const c1d = (candles1d || []).map(c => Number(c.trade_price)).filter(n => !isNaN(n));

  const price = c1.length ? c1[c1.length - 1] : 0;
  const momentum1h = c1.length >= 5 ? (c1[c1.length - 1] - c1[c1.length - 5]) / (c1[c1.length - 5] || 1) : 0;
  const rsi1h = rsi(c1, 14);
  const vol1h = c1.length >= 20 ? (() => {
    const mean = c1.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const var_ = c1.slice(-20).reduce((a, b) => a + (b - mean) ** 2, 0) / 20;
    return Math.sqrt(var_) / (mean || 1);
  })() : 0;
  const volZ = vol1h > 0 ? Math.min(2, vol1h / 0.01) : 0;
  const atr1h = atr(h1, l1, c1, 14);
  const atrNorm = price > 0 ? atr1h / price : 0;

  const trend4h = c4.length >= 5 ? (c4[c4.length - 1] - c4[c4.length - 5]) / (c4[c4.length - 5] || 1) : 0;
  const high4h = (candles4h || []).slice(-5).reduce((m, c) => Math.max(m, Number(c.high_price) || 0), 0);
  const pullback4h = high4h > 0 && price > 0 ? (high4h - price) / high4h : 0;

  const trend12h = c12.length >= 3 ? (c12[c12.length - 1] - c12[c12.length - 3]) / (c12[c12.length - 3] || 1) : 0;
  const regime12h = Math.abs(trend12h);

  const trend1d = c1d.length >= 5 ? (c1d[c1d.length - 1] - c1d[c1d.length - 5]) / (c1d[c1d.length - 5] || 1) : 0;
  const trendStrength1d = Math.abs(trend1d);

  return {
    symbol,
    timestamp: Math.floor(Date.now() / 1000),
    features: {
      momentum_1h: momentum1h,
      rsi_1h: rsi1h,
      vol_z_1h: volZ,
      atr_1h: atrNorm,
      trend_4h: trend4h,
      pullback_4h: pullback4h,
      regime_strength_12h: regime12h,
      trend_strength_1d: trendStrength1d,
      orderbook_imbalance: orderbookImbalance,
      spread_ratio: spreadRatio,
      mpi: mpi / 100
    }
  };
}

/**
 * 라벨링: future 12h max_up >= 2.5% and drawdown_before_up <= -1% → BUY_GOOD; future drop >= -1.5% → BUY_BAD; future drop >= -2% → SELL_GOOD
 */
function labelPoint(featurePoint, futureCloses12h) {
  if (!futureCloses12h || futureCloses12h.length < 2) return null;
  const price0 = featurePoint.features ? (featurePoint.price || 0) : 0;
  const c = futureCloses12h;
  const maxUp = Math.max(...c.map(p => (p - price0) / (price0 || 1)));
  const minDown = Math.min(...c.map(p => (p - price0) / (price0 || 1)));
  const finalReturn = (c[c.length - 1] - price0) / (price0 || 1);
  if (maxUp >= 0.025 && minDown <= -0.01) return 'BUY_GOOD';
  if (finalReturn <= -0.015) return 'BUY_BAD';
  if (finalReturn <= -0.02) return 'SELL_GOOD';
  return 'NEUTRAL';
}

/**
 * 데이터셋 로드
 */
function loadDataset() {
  try {
    if (fs.existsSync(DATASET_FILE)) {
      const raw = fs.readFileSync(DATASET_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {}
  return { points: [], updatedAt: 0 };
}

/**
 * 데이터셋 저장
 */
function saveDataset(data) {
  try {
    ensureDataDir();
    data.updatedAt = Math.floor(Date.now() / 1000);
    fs.writeFileSync(DATASET_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[patternLearner] saveDataset', e.message);
  }
}

/**
 * 한 심볼에 대해 캔들 수집 → 과거 시점(24h 전) feature + 그 후 12h로 라벨 → points에 추가 (최대 500개 유지)
 * Upbit 캔들: [0]=최신, [23]=23h ago. 인덱스 24 시점의 "future" = [12]~[23] (그 다음 12h)
 */
async function learnOne(symbol, getMpi) {
  if (!getCandlesMinutes || !getCandlesDays) return;
  const market = MARKET_PREFIX + symbol;
  try {
    const [c1h, c4h, c1d] = await Promise.all([
      getCandlesMinutes(60, market, 50),
      getCandlesMinutes(240, market, 30),
      getCandlesDays(market, 30)
    ]);
    if (!c1h || c1h.length < 25) return;
    const idx = 24;
    const c1hPast = c1h.slice(idx);
    const c4hPast = (c4h || []).slice(0, 7);
    const c12hPast = c1h.slice(idx, idx + 12);
    const c1dPast = (c1d || []).slice(0, 5);
    const featurePoint = buildFeatureVector(symbol, c1hPast, c4hPast, c12hPast, c1dPast, 0, 0, getMpi ? getMpi(symbol) : 0);
    const price0 = Number(c1h[idx].trade_price) || 0;
    featurePoint.price = price0;
    const futureCloses = c1h.slice(12, 24).map(c => Number(c.trade_price)).filter(n => !isNaN(n));
    const label = labelPoint(featurePoint, futureCloses);
    if (label && label !== 'NEUTRAL') {
      featurePoint.label = label;
      const data = loadDataset();
      data.points = data.points || [];
      data.points.push(featurePoint);
      if (data.points.length > 500) data.points = data.points.slice(-500);
      saveDataset(data);
    }
  } catch (e) {
    console.error('[patternLearner] learnOne', symbol, e.message);
  }
}

async function learnAll(getMpi) {
  for (const sym of SYMBOLS) {
    await learnOne(sym, getMpi);
    await new Promise(r => setTimeout(r, 400));
  }
}

module.exports = {
  setCandleFetchers,
  buildFeatureVector,
  loadDataset,
  saveDataset,
  learnOne,
  learnAll,
  DATASET_FILE
};
