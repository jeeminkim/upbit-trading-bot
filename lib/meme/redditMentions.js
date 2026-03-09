/**
 * Reddit 멘션 (무료, 인증 없음) - mentions_1h, mentions_24h, velocity
 * 캐시 2분. 레이트리밋 대비 백오프 + fallback
 */

const axios = require('axios');
const logger = require('./logger');
const cache = require('./cache');

const CACHE_KEY = 'meme:reddit';
const CACHE_TTL_MS = 2 * 60 * 1000;
const SUBREDDITS = ['cryptocurrency', 'bitcoin', 'ethtrader', 'solana', 'xrp'];
const SYMBOL_TERMS = {
  BTC: ['bitcoin', 'btc'],
  ETH: ['ethereum', 'eth'],
  SOL: ['solana', 'sol'],
  XRP: ['xrp', 'ripple']
};

function countMentions(text, terms) {
  if (!text || typeof text !== 'string') return 0;
  const lower = text.toLowerCase();
  let n = 0;
  for (const t of terms) {
    if (lower.includes(t.toLowerCase())) n++;
  }
  return n;
}

async function fetchSubreddit(subreddit, limit = 50) {
  const url = `https://www.reddit.com/r/${subreddit}/new.json?limit=${limit}`;
  const res = await axios.get(url, {
    timeout: 8000,
    headers: { 'User-Agent': 'MemePressureIndex/1.0 (learning bot)' }
  });
  const list = res.data?.data?.children || [];
  return list.map(c => ({
    title: c.data?.title || '',
    selftext: c.data?.selftext || '',
    created_utc: c.data?.created_utc
  }));
}

async function fetchMentions(symbol) {
  const t0 = Date.now();
  const key = CACHE_KEY + ':' + symbol;
  const cached = cache.get(key, CACHE_TTL_MS);
  if (cached != null) return cached;

  logger.fetch(`source=reddit symbol=${symbol} start`, { symbol });
  const terms = SYMBOL_TERMS[symbol] || [symbol.toLowerCase()];
  let mentions1h = 0;
  let mentions24h = 0;
  const now = Date.now() / 1000;

  try {
    for (const sub of SUBREDDITS) {
      const posts = await fetchSubreddit(sub);
      for (const p of posts) {
        const age = now - (p.created_utc || 0);
        const count = countMentions(p.title + ' ' + p.selftext, terms) ? 1 : 0;
        if (age <= 3600) mentions1h += count;
        if (age <= 86400) mentions24h += count;
      }
      await new Promise(r => setTimeout(r, 1100));
    }
    const latency = Date.now() - t0;
    const velocity = mentions24h > 0 ? mentions1h / (mentions24h / 24) : (mentions1h > 0 ? 24 : 1);
    const result = { mentions_1h: mentions1h, mentions_24h: mentions24h, velocity: Math.min(5, velocity) };
    cache.set(key, result, CACHE_TTL_MS);
    logger.fetch(`source=reddit symbol=${symbol} ok latency_ms=${latency} m1h=${mentions1h} m24h=${mentions24h}`, { symbol, latency_ms: latency });
    return result;
  } catch (err) {
    logger.error(`source=reddit symbol=${symbol} fail`, { code: err.response?.status || err.code, message: err.message });
    logger.fallback(`reddit symbol=${symbol} use prev or 1`, { reason: err.message });
    return { mentions_1h: 0, mentions_24h: 1, velocity: 1 };
  }
}

async function fetchAll() {
  const out = {};
  for (const sym of ['BTC', 'ETH', 'SOL', 'XRP']) {
    out[sym] = await fetchMentions(sym);
    await new Promise(r => setTimeout(r, 500));
  }
  return out;
}

module.exports = { fetchMentions, fetchAll };
