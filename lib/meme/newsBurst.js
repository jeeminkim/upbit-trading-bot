/**
 * CryptoPanic 뉴스 버스트 — 호출 전면 중단 (API 비사용). FALLBACK만 반환.
 * cryptopanic 관련 로그/호출 없음.
 */

const FALLBACK = { news_count_1h: 0, news_count_24h: 1, news_burst: 1 };

/** CryptoPanic 호출 없이 FALLBACK 반환 */
async function fetchNewsBurst(symbol) {
  return FALLBACK;
}

async function fetchAll() {
  const symbols = ['BTC', 'ETH', 'SOL', 'XRP'];
  const out = {};
  for (const sym of symbols) {
    out[sym] = FALLBACK;
  }
  return out;
}

module.exports = { fetchNewsBurst, fetchAll };
