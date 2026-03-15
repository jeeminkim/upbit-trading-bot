/**
 * Google Trends (무료) - trend_spike = current_interest / avg_interest_30d
 * 캐시 10분. 429/HTML 응답 시 백오프·재시도 후 fallback, JSON 파싱 전 응답 형태 검증.
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
const BASE_RETRY_DELAY_MS = 2000;
const MAX_RETRY_DELAY_MS = 30000;
const MAX_RETRIES = 3;
const DELAY_BETWEEN_SYMBOLS_MS = 1500;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBackoffDelay(attempt) {
  const raw = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
  return Math.min(raw, MAX_RETRY_DELAY_MS);
}

function isLikelyJson(str) {
  if (typeof str !== 'string') return false;
  const t = str.trim();
  return t.startsWith('{') || t.startsWith('[');
}

function looksLikeHtml(text) {
  if (typeof text !== 'string') return false;
  const s = text.trim().slice(0, 50).toLowerCase();
  return s.startsWith('<!doctype html') || s.startsWith('<html');
}

function isRateLimitError(errOrText) {
  const text = typeof errOrText === 'string'
    ? errOrText
    : (errOrText?.message || '');
  return /429|too many requests/i.test(text);
}

function fallbackTrendSpike(symbol, reason) {
  logger.fallback(`google_trends symbol=${symbol} use 1`, { reason });
  const trendSpike = 1;
  cache.set(CACHE_KEY + ':' + symbol, trendSpike, CACHE_TTL_MS);
  return trendSpike;
}

function normalizeTrendSpike(parsed, symbol) {
  const timeline = parsed?.default?.timelineData || parsed?.timelineData || [];
  let trendSpike = 1;
  if (timeline.length >= 7) {
    const values = timeline.map(d => (d.value && d.value[0]) || 0).filter(Boolean);
    const current = values[values.length - 1] || 1;
    const avg30 = values.reduce((a, b) => a + b, 0) / (values.length || 1);
    trendSpike = avg30 > 0 ? Math.min(3, current / avg30) : 1;
  }
  cache.set(CACHE_KEY + ':' + symbol, trendSpike, CACHE_TTL_MS);
  return trendSpike;
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

  const keyword = KEYWORDS[symbol] || symbol.toLowerCase();
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const res = await Promise.race([
        googleTrends.interestOverTime({
          keyword,
          startTime: new Date(Date.now() - 32 * 24 * 60 * 60 * 1000)
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))
      ]);

      const resStr = typeof res === 'string' ? res : (res != null ? String(res) : '');

      if (!resStr || looksLikeHtml(resStr) || !isLikelyJson(resStr)) {
        const preview = resStr.slice(0, 200);
        writeTrendsError('[DATA_SOURCE_WARN] source=google_trends reason=invalid_json', { symbol, preview, attempt });
        logger.dataSourceWarn(`source=google_trends reason=invalid_json symbol=${symbol}`);
        if (isRateLimitError(resStr)) {
          lastError = new Error(`google_trends invalid_json due to rate limit: ${symbol}`);
          if (attempt < MAX_RETRIES) {
            await sleep(getBackoffDelay(attempt));
            continue;
          }
        }
        return fallbackTrendSpike(symbol, 'invalid_json');
      }

      let parsed;
      try {
        parsed = JSON.parse(resStr);
      } catch (err) {
        writeTrendsError('[DATA_SOURCE_WARN] source=google_trends reason=parse_error', { symbol, error: err.message, attempt });
        logger.dataSourceWarn(`source=google_trends reason=parse_error symbol=${symbol} error=${err?.message}`);
        lastError = err;
        if (isRateLimitError(resStr) && attempt < MAX_RETRIES) {
          await sleep(getBackoffDelay(attempt));
          continue;
        }
        return fallbackTrendSpike(symbol, 'parse_error');
      }

      const trendSpike = normalizeTrendSpike(parsed, symbol);
      logger.fetch(`source=google_trends symbol=${symbol} ok latency_ms=${Date.now() - t0} trend_spike=${trendSpike}`, { symbol, latency_ms: Date.now() - t0 });
      return trendSpike;
    } catch (err) {
      lastError = err;
      writeTrendsError('[DATA_SOURCE_WARN] source=google_trends reason=request_error', { symbol, message: err.message, attempt });
      logger.error(`source=google_trends symbol=${symbol} fail`, { code: err.code || 'ERR', message: err.message });
      logger.dataSourceWarn(`source=google_trends reason=request_error symbol=${symbol} message=${err?.message}`);
      if (isRateLimitError(err) && attempt < MAX_RETRIES) {
        await sleep(getBackoffDelay(attempt));
        continue;
      }
      if (/timeout/i.test(err.message) && attempt < MAX_RETRIES) {
        await sleep(getBackoffDelay(attempt));
        continue;
      }
      return fallbackTrendSpike(symbol, 'request_error');
    }
  }

  writeTrendsError('[DATA_SOURCE_WARN] source=google_trends reason=exhausted_retries', { symbol, message: lastError?.message || 'unknown' });
  return fallbackTrendSpike(symbol, 'exhausted_retries');
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
      await sleep(DELAY_BETWEEN_SYMBOLS_MS);
    }
  }
  return out;
}

module.exports = { fetchTrendSpike, fetchAll };
