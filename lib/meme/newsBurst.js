/**
 * CryptoPanic 뉴스 버스트 (무료 public 또는 auth_token) - news_count_1h, news_count_24h, news_burst
 * 캐시 5분. 404/에러 시 해당 심볼만 fallback, 프로세스 중단 없음.
 */

const axios = require('axios');
const logger = require('./logger');
const cache = require('./cache');

const CACHE_KEY = 'meme:news';
const CACHE_TTL_MS = 5 * 60 * 1000;
const BASE_URL = 'https://cryptopanic.com/api/v1/posts/';
const SYMBOL_TERMS = {
  BTC: ['bitcoin', 'btc'],
  ETH: ['ethereum', 'eth'],
  SOL: ['solana', 'sol'],
  XRP: ['xrp', 'ripple']
};

const FALLBACK = { news_count_1h: 0, news_count_24h: 1, news_burst: 1 };

function countInPost(post, terms) {
  const text = [post.title, post.domain, (post.currencies || []).map(c => c.code).join(' ')].join(' ').toLowerCase();
  for (const t of terms) {
    if (text.includes(t.toLowerCase())) return 1;
  }
  return 0;
}

async function fetchNewsBurst(symbol) {
  const t0 = Date.now();
  const key = CACHE_KEY + ':' + symbol;
  const cached = cache.get(key, CACHE_TTL_MS);
  if (cached != null) return cached;

  logger.fetch(`source=cryptopanic symbol=${symbol} start`, { symbol });
  try {
    const params = { public: 'true' };
    const authToken = (process.env.CRYPTOPANIC_API_KEY || process.env.CRYPTOPANIC_TOKEN || '').trim();
    if (authToken) params.auth_token = authToken;
    const res = await axios.get(BASE_URL, { timeout: 10000, params, validateStatus: (s) => s < 500 });
    if (res.status === 404) {
      logger.dataSourceWarn(`source=cryptopanic symbol=${symbol} reason=not_found status=404`);
      logger.fallback(`news symbol=${symbol} use fallback`, { reason: '404' });
      return FALLBACK;
    }
    if (res.status !== 200) {
      logger.dataSourceWarn(`source=cryptopanic symbol=${symbol} reason=bad_status status=${res.status}`);
      return FALLBACK;
    }
    const list = res.data?.results || [];
    const terms = SYMBOL_TERMS[symbol] || [symbol.toLowerCase()];
    const now = Date.now();
    let count1h = 0;
    let count24h = 0;
    for (const p of list) {
      const published = p.published_at ? new Date(p.published_at).getTime() : 0;
      const ageMs = now - published;
      const hit = countInPost(p, terms);
      if (hit) {
        if (ageMs <= 3600 * 1000) count1h++;
        if (ageMs <= 86400 * 1000) count24h++;
      }
    }
    const news_burst = count24h > 0 ? count1h / (count24h / 24) : (count1h > 0 ? 24 : 1);
    const result = { news_count_1h: count1h, news_count_24h: count24h, news_burst: Math.min(5, news_burst) };
    cache.set(key, result, CACHE_TTL_MS);
    const latency = Date.now() - t0;
    logger.fetch(`source=cryptopanic symbol=${symbol} ok latency_ms=${latency} n1h=${count1h} n24h=${count24h}`, { symbol, latency_ms: latency });
    return result;
  } catch (err) {
    const status = err.response?.status;
    logger.error(`source=cryptopanic symbol=${symbol} fail`, { code: status || err.code, message: err.message });
    logger.dataSourceWarn(`source=cryptopanic symbol=${symbol} reason=request_error status=${status || 'ERR'} message=${err.message}`);
    logger.fallback(`news symbol=${symbol} use fallback`, { reason: err.message });
    return FALLBACK;
  }
}

async function fetchAll() {
  const symbols = ['BTC', 'ETH', 'SOL', 'XRP'];
  const out = {};
  for (const sym of symbols) {
    try {
      out[sym] = await fetchNewsBurst(sym);
    } catch (e) {
      logger.dataSourceWarn(`source=cryptopanic symbol=${sym} reason=exception message=${e?.message}`);
      out[sym] = FALLBACK;
    }
  }
  return out;
}

module.exports = { fetchNewsBurst, fetchAll };
