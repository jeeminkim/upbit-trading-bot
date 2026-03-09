/**
 * Google Trends (무료) - trend_spike = current_interest / avg_interest_30d
 * 캐시 10분. HTML/비JSON 응답 시 로그 후 fallback 1, 크래시 방지.
 */

const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const cache = require('./cache');

const CACHE_KEY = 'meme:google_trends';
const CACHE_TTL_MS = 10 * 60 * 1000;
const KEYWORDS = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'xrp' };
const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const TRENDS_ERROR_LOG = path.join(LOG_DIR, 'google_trends_error.log');
const DELAY_BETWEEN_SYMBOLS_MS = 800;

function ensureDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (_) {}
}

function writeTrendsError(message, detail) {
  ensureDir();
  const line = `[${new Date().toISOString()}] ${message}${detail ? ' ' + JSON.stringify(detail) : ''}\n`;
  try {
    fs.appendFileSync(TRENDS_ERROR_LOG, line, 'utf8');
  } catch (_) {}
}

function isLikelyJson(str) {
  if (typeof str !== 'string') return false;
  const t = str.trim();
  return t.startsWith('{') || t.startsWith('[');
}

function isLikelyHtml(str) {
  if (typeof str !== 'string') return false;
  const t = str.trim();
  return t.startsWith('<') || t.startsWith('<!') || /^\s*<\?xml/i.test(t);
}

async function fetchTrendSpike(symbol) {
  const t0 = Date.now();
  const cached = cache.get(CACHE_KEY + ':' + symbol, CACHE_TTL_MS);
  if (cached != null) {
    return cached;
  }
  logger.fetch(`source=google_trends symbol=${symbol} start`, { symbol });
  let googleTrends;
  try {
    googleTrends = require('google-trends-api');
  } catch (e) {
    logger.fallback('google_trends_api module not installed, use 1', { reason: e.message });
    return 1;
  }
  try {
    const keyword = KEYWORDS[symbol] || symbol.toLowerCase();
    const res = await Promise.race([
      googleTrends.interestOverTime({ keyword, startTime: new Date(Date.now() - 32 * 24 * 60 * 60 * 1000) }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))
    ]);
    const latency = Date.now() - t0;
    let trendSpike = 1;
    const resStr = typeof res === 'string' ? res : (res != null ? String(res) : '');
    if (!isLikelyJson(resStr)) {
      if (isLikelyHtml(resStr) || resStr.length > 0) {
        logger.dataSourceWarn(`source=google_trends reason=invalid_json symbol=${symbol}`);
        writeTrendsError('[DATA_SOURCE_WARN] source=google_trends reason=invalid_json', { symbol, preview: resStr.slice(0, 200) });
      }
      logger.fallback(`google_trends symbol=${symbol} use 1 (데이터 일시적 불가)`, { reason: 'invalid_response' });
      cache.set(CACHE_KEY + ':' + symbol, trendSpike, CACHE_TTL_MS);
      return trendSpike;
    }
    try {
      const parsed = typeof res === 'string' ? JSON.parse(res) : res;
      const timeline = parsed?.default?.timelineData || parsed?.timelineData || [];
      if (timeline.length >= 7) {
        const values = timeline.map(d => (d.value && d.value[0]) || 0).filter(Boolean);
        const current = values[values.length - 1] || 1;
        const avg30 = values.reduce((a, b) => a + b, 0) / (values.length || 1);
        trendSpike = avg30 > 0 ? Math.min(3, current / avg30) : 1;
      }
    } catch (e) {
      logger.dataSourceWarn(`source=google_trends reason=parse_error symbol=${symbol} error=${e?.message}`);
      writeTrendsError('[DATA_SOURCE_WARN] source=google_trends reason=parse_error', { symbol, error: e?.message });
      logger.fallback(`google_trends parse symbol=${symbol} use 1`, { error: e.message });
    }
    cache.set(CACHE_KEY + ':' + symbol, trendSpike, CACHE_TTL_MS);
    logger.fetch(`source=google_trends symbol=${symbol} ok latency_ms=${latency} trend_spike=${trendSpike}`, { symbol, latency_ms: latency });
    return trendSpike;
  } catch (err) {
    logger.error(`source=google_trends symbol=${symbol} fail`, { code: err.code || 'ERR', message: err.message });
    logger.dataSourceWarn(`source=google_trends reason=request_error symbol=${symbol} message=${err?.message}`);
    writeTrendsError('[DATA_SOURCE_WARN] source=google_trends reason=request_error', { symbol, message: err?.message });
    logger.fallback(`google_trends symbol=${symbol} use 1`, { reason: err.message });
    return 1;
  }
}

async function fetchAll() {
  const symbols = ['BTC', 'ETH', 'SOL', 'XRP'];
  const out = {};
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    try {
      out[sym] = await fetchTrendSpike(sym);
    } catch (e) {
      logger.dataSourceWarn(`source=google_trends symbol=${sym} reason=exception message=${e?.message}`);
      writeTrendsError('[DATA_SOURCE_WARN] source=google_trends reason=exception', { symbol: sym, message: e?.message });
      out[sym] = 1;
    }
    if (i < symbols.length - 1 && DELAY_BETWEEN_SYMBOLS_MS > 0) {
      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_SYMBOLS_MS));
    }
  }
  return out;
}

module.exports = { fetchTrendSpike, fetchAll };
