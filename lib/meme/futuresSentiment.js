/**
 * Binance Futures 공개 API - OI spike, funding heat (BTC 기준, 4심볼 공통 근사)
 * 캐시 1분
 */

const axios = require('axios');
const logger = require('./logger');
const cache = require('./cache');

const CACHE_KEY = 'meme:futures';
const CACHE_TTL_MS = 60 * 1000;
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];

async function fetchOiAndFunding(symbol = 'BTCUSDT') {
  const t0 = Date.now();
  const key = CACHE_KEY + ':' + symbol;
  const cached = cache.get(key, CACHE_TTL_MS);
  if (cached != null) return cached;

  logger.fetch(`source=binance_futures symbol=${symbol} start`, { symbol });
  try {
    const [oiRes, fundRes, oiHistRes] = await Promise.all([
      axios.get('https://fapi.binance.com/fapi/v1/openInterest', { params: { symbol }, timeout: 5000 }),
      axios.get('https://fapi.binance.com/fapi/v1/fundingRate', { params: { symbol, limit: 1 }, timeout: 5000 }),
      axios.get('https://fapi.binance.com/futures/data/openInterestHist', { params: { symbol, period: '5m', limit: 30 }, timeout: 5000 }).catch(() => ({ data: [] }))
    ]);
    const oi = Number(oiRes.data?.openInterest || 0);
    const fr = fundRes.data && fundRes.data[0] ? Number(fundRes.data[0].fundingRate || 0) : 0;
    let oi_spike = 1;
    if (oi > 0 && Array.isArray(oiHistRes.data) && oiHistRes.data.length > 0) {
      const hist = oiHistRes.data.map(d => Number(d.sumOpenInterest || 0)).filter(Boolean);
      const avg = hist.reduce((a, b) => a + b, 0) / hist.length;
      if (avg > 0) oi_spike = oi / avg;
    }
    const funding_heat = Math.min(2, Math.abs(fr) * 1000);
    const result = { oi, funding_rate: fr, oi_spike, funding_heat };
    cache.set(key, result, CACHE_TTL_MS);
    const latency = Date.now() - t0;
    logger.fetch(`source=binance_futures symbol=${symbol} ok latency_ms=${latency} oi=${oi} fr=${fr}`, { symbol, latency_ms: latency });
    return result;
  } catch (err) {
    logger.error(`source=binance_futures symbol=${symbol} fail`, { code: err.response?.status || err.code, message: err.message });
    logger.fallback(`futures symbol=${symbol} use 1,0`, { reason: err.message });
    return { oi: 0, funding_rate: 0, oi_spike: 1, funding_heat: 0 };
  }
}

async function fetchAll() {
  const out = {};
  const symMap = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT' };
  for (const s of ['BTC', 'ETH', 'SOL', 'XRP']) {
    out[s] = await fetchOiAndFunding(symMap[s]);
  }
  return out;
}

module.exports = { fetchOiAndFunding, fetchAll };
