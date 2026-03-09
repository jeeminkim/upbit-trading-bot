/**
 * MPI 오케스트레이터: 1분마다 BTC/ETH/SOL/XRP MPI 계산, history 저장, getMPI/getAllMPI/getHistory
 */

const logger = require('./logger');
const historyStore = require('./historyStore');
const signalStore = require('./signalStore');
const googleTrends = require('./googleTrends');
const redditMentions = require('./redditMentions');
const newsBurst = require('./newsBurst');
const futuresSentiment = require('./futuresSentiment');
const mpiCalculator = require('./mpiCalculator');

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP'];
const INTERVAL_MS = 60 * 1000;

let latestBySymbol = {};
let mpiHistoryForVelocity = { BTC: [], ETH: [], SOL: [], XRP: [] };
/** @type {((symbol: string) => Promise<number>) | null} */
let getPriceAsync = null;

function avgLast15Min(symbol) {
  const arr = mpiHistoryForVelocity[symbol] || [];
  const cutoff = Date.now() - 15 * 60 * 1000;
  const recent = arr.filter(p => p.ts >= cutoff).map(p => p.mpi);
  return recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null;
}

function signalSeverity(mpi) {
  if (mpi >= 90) return 'EXTREME';
  if (mpi >= 80) return 'HIGH';
  if (mpi >= 70) return 'ELEVATED';
  return null;
}

function isCriticalSignal(mpi, mpi_velocity, raw) {
  const trend_spike = raw?.trend_spike ?? 0;
  const social_velocity = raw?.reddit_velocity ?? 0;
  const oi_spike = raw?.oi_spike ?? 0;
  return mpi >= 70 && mpi_velocity > 5 && trend_spike >= 1.5 && social_velocity >= 1.3 && oi_spike >= 1.2;
}

async function computeOne(symbol) {
  const [reddit, trends, news, futures] = await Promise.all([
    redditMentions.fetchMentions(symbol).catch(() => ({ velocity: 1 })),
    googleTrends.fetchTrendSpike(symbol).catch(() => 1),
    newsBurst.fetchNewsBurst(symbol).catch(() => ({ news_burst: 1 })),
    futuresSentiment.fetchOiAndFunding(symbol === 'BTC' ? 'BTCUSDT' : symbol === 'ETH' ? 'ETHUSDT' : symbol === 'SOL' ? 'SOLUSDT' : 'XRPUSDT').catch(() => ({ oi_spike: 1, funding_heat: 0 }))
  ]);

  logger.raw(`symbol=${symbol} reddit_mentions_1h=${reddit?.mentions_1h} reddit_mentions_24h=${reddit?.mentions_24h} trend_spike=${trends} news_burst=${news?.news_burst} oi=${futures?.oi} funding=${futures?.funding_rate}`, { symbol });

  const { mpi, mpi_raw, components, raw } = mpiCalculator.computeMPI(symbol, reddit, trends, news, futures);

  const prevAvg = avgLast15Min(symbol);
  const mpi_velocity = prevAvg != null ? mpi - prevAvg : 0;

  const arr = mpiHistoryForVelocity[symbol] || [];
  arr.push({ mpi, ts: Date.now() });
  while (arr.length > 20) arr.shift();
  mpiHistoryForVelocity[symbol] = arr;

  logger.score(`symbol=${symbol} mpi=${mpi} mpi_velocity=${mpi_velocity >= 0 ? '+' : ''}${mpi_velocity.toFixed(1)}`, { symbol, mpi, mpi_velocity });

  const ts = Math.floor(Date.now() / 1000);
  let price = 0;
  try {
    if (getPriceAsync) price = await getPriceAsync(symbol);
  } catch (_) {}

  const point = {
    symbol,
    mpi,
    mpi_velocity,
    components,
    raw,
    timestamp: ts
  };
  latestBySymbol[symbol] = point;
  historyStore.push(symbol, point);

  try {
    signalStore.appendHistory({ symbol, timestamp: ts, price, mpi, mpi_velocity, components, raw });
  } catch (e) {
    logger.error('signalStore.appendHistory', { message: e.message });
  }

  if (isCriticalSignal(mpi, mpi_velocity, raw)) {
    const severity = signalSeverity(mpi);
    logger.signal(`reason="MPI>=70 velocity>5" symbol=${symbol} mpi=${mpi} severity=${severity}`, { symbol, mpi, mpi_velocity, severity });
    try {
      const id = signalStore.makeSignalId(symbol, ts);
      signalStore.appendSignal({
        id,
        symbol,
        detected_at: ts,
        price_at_signal: price,
        mpi,
        mpi_velocity,
        components,
        evaluation: {
          return_5m: null,
          return_15m: null,
          return_60m: null,
          max_up_60m: null,
          max_down_60m: null,
          label: 'PENDING'
        }
      });
    } catch (e) {
      logger.error('signalStore.appendSignal', { message: e.message });
    }
  }

  return point;
}

async function runCycle() {
  logger.fetch('meme_engine cycle start', {});
  for (const symbol of SYMBOLS) {
    try {
      await computeOne(symbol);
    } catch (err) {
      logger.error(`meme_engine symbol=${symbol}`, { message: err.message });
      logger.fallback(`symbol=${symbol} keep previous MPI`, {});
    }
    await new Promise(r => setTimeout(r, 500));
  }
  logger.fetch('meme_engine cycle done', {});
}

function getMPI(symbol) {
  return latestBySymbol[symbol] || null;
}

function getAllMPI() {
  return SYMBOLS.map(s => latestBySymbol[s] || null).filter(Boolean);
}

function getHistory(symbol, minutes = 15) {
  return historyStore.get(symbol, minutes);
}

let intervalId;
/**
 * @param {((symbol: string) => Promise<number>) | null} getPrice - 코인별 현재가 조회 (예: KRW-BTC trade_price)
 */
function start(getPrice = null) {
  getPriceAsync = getPrice || null;
  runCycle();
  intervalId = setInterval(runCycle, INTERVAL_MS);
}
function stop() {
  if (intervalId) clearInterval(intervalId);
}

module.exports = {
  start,
  stop,
  getMPI,
  getAllMPI,
  getHistory,
  runCycle,
  SYMBOLS
};
