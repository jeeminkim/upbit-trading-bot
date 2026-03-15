/**
 * MarketAnalyzer - 멀티 타임프레임(30m/4h/1d) 데이터 수집 및 시장 점수 전담
 * - SharedCache 사용: 전역 캐시로 중복 API 호출 방지, 쿼터 절약
 * - 30m/4h: 1분 TTL, 1d: 5분 TTL (config.default 연동)
 * - API 재시도: 네트워크 오류 시에도 봇 멈추지 않도록 재시도
 * - Market Score: 일봉 이평선 정배열(40) + 4h RSI≥50(30) + 30m 거래량 증가(30) = 100점
 */

const upbit = require('./upbit');
const SharedCache = require('./SharedCache');
const { CACHE_TTL_MEDIUM_MS, CACHE_TTL_DAILY_MS, API_RETRY_MAX, API_RETRY_DELAY_MS } = require('../config.default');

const API_DELAY_MS = 100;
const RSI_PERIOD = 14;
const MA_SHORT = 5;
const MA_LONG = 20;
const VOL_COMPARE_CANDLES = 5;
const MARKET_SCORE_CRASH_THRESHOLD = 20;

/** 캐시 키 접두사 (대표 마켓 1개 사용 시) */
const KEY_30 = 'candles30';
const KEY_4H = 'candles4h';
const KEY_1D = 'candles1d';
const KEY_LAST_ERROR = 'marketAnalyzer_lastError';

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 재시도 래퍼: 실패 시 최대 N회 재시도 (네트워크 오류 시 봇 정지 방지)
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function withRetry(fn) {
  let lastErr;
  for (let i = 0; i <= (API_RETRY_MAX ?? 3); i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < (API_RETRY_MAX ?? 3)) await delay(API_RETRY_DELAY_MS ?? 500);
    }
  }
  throw lastErr;
}

/**
 * 단일 마켓 캔들 조회 (SharedCache 사용, TTL 내면 캐시 반환)
 * - 순차 호출 + 재시도로 429/네트워크 오류 대응
 */
async function fetchCandlesSequential(markets, unitType, unitOrDay, count) {
  const result = {};
  for (const market of markets) {
    const cacheKey = unitType === 'days' ? `${KEY_1D}:${market}` : (unitOrDay === 30 ? `${KEY_30}:${market}` : `${KEY_4H}:${market}`);
    const ttl = unitType === 'days' ? CACHE_TTL_DAILY_MS : CACHE_TTL_MEDIUM_MS;
    const cached = SharedCache.get(cacheKey);
    if (cached != null && Array.isArray(cached) && cached.length > 0) {
      result[market] = cached;
      await delay(API_DELAY_MS);
      continue;
    }
    try {
      let data;
      if (unitType === 'days') {
        data = await withRetry(() => upbit.getCandlesDays(market, count));
      } else {
        data = await withRetry(() => upbit.getCandlesMinutes(unitOrDay, market, count));
      }
      const arr = Array.isArray(data) ? data : [];
      SharedCache.set(cacheKey, arr, ttl);
      SharedCache.remove(KEY_LAST_ERROR);
      result[market] = arr;
    } catch (e) {
      if (e.message === 'TOO_MANY_REQUESTS') {
        await delay(500);
        try {
          if (unitType === 'days') {
            result[market] = await withRetry(() => upbit.getCandlesDays(market, count));
          } else {
            result[market] = await withRetry(() => upbit.getCandlesMinutes(unitOrDay, market, count));
          }
          const arr = Array.isArray(result[market]) ? result[market] : [];
          SharedCache.set(cacheKey, arr, ttl);
          result[market] = arr;
        } catch (e2) {
          SharedCache.set(KEY_LAST_ERROR, e2.message, 60000);
          result[market] = [];
        }
      } else {
        SharedCache.set(KEY_LAST_ERROR, e.message, 60000);
        result[market] = [];
      }
    }
    await delay(API_DELAY_MS);
  }
  return result;
}

/** 일봉 이평선 정배열: 단기 이평 > 장기 이평 (MA5 > MA20) → 40점 */
function scoreDailyMaAlignment(candles1d) {
  if (!Array.isArray(candles1d) || candles1d.length < MA_LONG) return 0;
  const closes = candles1d.map((c) => c.trade_price || c.close).filter((v) => v != null);
  if (closes.length < MA_LONG) return 0;
  const maShort = closes.slice(0, MA_SHORT).reduce((a, b) => a + b, 0) / Math.min(MA_SHORT, closes.length);
  const maLong = closes.slice(0, MA_LONG).reduce((a, b) => a + b, 0) / MA_LONG;
  return maShort > maLong ? 40 : 0;
}

/** RSI 계산 (period일) */
function calcRsi(prices, period = RSI_PERIOD) {
  if (!Array.isArray(prices) || prices.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 0; i < period; i++) {
    const change = (prices[i] || 0) - (prices[i + 1] || 0);
    if (change > 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** 4시간봉 RSI 50 이상 → 30점 */
function score4hRsi(candles4h) {
  if (!Array.isArray(candles4h) || candles4h.length < RSI_PERIOD + 1) return 0;
  const prices = candles4h.map((c) => c.trade_price || c.close).filter((v) => v != null).reverse();
  const rsi = calcRsi(prices, RSI_PERIOD);
  if (rsi == null) return 0;
  return rsi >= 50 ? 30 : 0;
}

/** 30분봉 최근 거래량이 직전 N개 평균보다 증가 → 30점 */
function score30mVolumeSurge(candles30) {
  if (!Array.isArray(candles30) || candles30.length < VOL_COMPARE_CANDLES + 1) return 0;
  const vols = candles30.map((c) => c.candle_acc_trade_volume || c.volume || 0).filter((v) => v != null);
  if (vols.length < VOL_COMPARE_CANDLES + 1) return 0;
  const latest = vols[0];
  const prevAvg = vols.slice(1, VOL_COMPARE_CANDLES + 1).reduce((a, b) => a + b, 0) / VOL_COMPARE_CANDLES;
  if (prevAvg <= 0) return 30;
  return latest > prevAvg ? 30 : 0;
}

/** 캔들 데이터로 Market Score 0~100 계산 */
function computeMarketScore(candles30, candles4h, candles1d) {
  const s1 = scoreDailyMaAlignment(candles1d || []);
  const s2 = score4hRsi(candles4h || []);
  const s3 = score30mVolumeSurge(candles30 || []);
  return Math.min(100, Math.round(s1 + s2 + s3));
}

/** 추천 비중 승수: (Market_Score / 50). 100→2, 25→0.5. 상한은 프로필 max_bet_multiplier */
function getRecommendedMultiplier(marketScore, maxBetMultiplier = 2) {
  if (marketScore == null || marketScore <= 0) return 0.5;
  const raw = marketScore / 50;
  return Math.min(maxBetMultiplier, Math.max(0.1, raw));
}

/** 30m/4h 캔들 갱신 (SharedCache TTL 내면 스킵, 대표 마켓 1개) */
async function refreshMediumTerm(representativeMarket = 'KRW-BTC') {
  const c30 = SharedCache.get(`${KEY_30}:${representativeMarket}`);
  const c4h = SharedCache.get(`${KEY_4H}:${representativeMarket}`);
  if (c30 != null && c4h != null && c30.length > 0) {
    return { candles30: c30, candles4h: c4h };
  }
  try {
    const r30 = await fetchCandlesSequential([representativeMarket], 'minutes', 30, 60);
    const r4h = await fetchCandlesSequential([representativeMarket], 'minutes', 240, 60);
    const out30 = Array.isArray(r30[representativeMarket]) ? r30[representativeMarket] : [];
    const out4h = Array.isArray(r4h[representativeMarket]) ? r4h[representativeMarket] : [];
    return { candles30: out30, candles4h: out4h };
  } catch (e) {
    SharedCache.set(KEY_LAST_ERROR, e.message, 60000);
    return {
      candles30: SharedCache.get(`${KEY_30}:${representativeMarket}`) || [],
      candles4h: SharedCache.get(`${KEY_4H}:${representativeMarket}`) || []
    };
  }
}

/** 1d 캔들 갱신 (SharedCache TTL 내면 스킵) */
async function refreshDaily(representativeMarket = 'KRW-BTC') {
  const c1d = SharedCache.get(`${KEY_1D}:${representativeMarket}`);
  if (c1d != null && c1d.length > 0) return c1d;
  try {
    const r = await fetchCandlesSequential([representativeMarket], 'days', null, 60);
    return Array.isArray(r[representativeMarket]) ? r[representativeMarket] : [];
  } catch (e) {
    SharedCache.set(KEY_LAST_ERROR, e.message, 60000);
    return SharedCache.get(`${KEY_1D}:${representativeMarket}`) || [];
  }
}

/** 현재 SharedCache 기준 Market Score·추천 비중·블록 사유 반환 (모든 코인 공유 context) */
function getMarketContext(representativeMarketOrMaxBet = 'KRW-BTC', maxBetMultiplier = 2) {
  let representativeMarket = 'KRW-BTC';
  let maxBet = 2;
  if (arguments.length === 1 && typeof representativeMarketOrMaxBet === 'number') {
    maxBet = representativeMarketOrMaxBet;
  } else {
    if (representativeMarketOrMaxBet != null && typeof representativeMarketOrMaxBet === 'string') representativeMarket = representativeMarketOrMaxBet;
    if (typeof maxBetMultiplier === 'number') maxBet = maxBetMultiplier;
  }
  const candles30 = SharedCache.get(`${KEY_30}:${representativeMarket}`) || [];
  const candles4h = SharedCache.get(`${KEY_4H}:${representativeMarket}`) || [];
  const candles1d = SharedCache.get(`${KEY_1D}:${representativeMarket}`) || [];
  const score = computeMarketScore(candles30, candles4h, candles1d);
  const recommendedMultiplier = getRecommendedMultiplier(score, maxBet);
  const blockReason = score < MARKET_SCORE_CRASH_THRESHOLD ? 'BLOCK_MARKET_CRASH' : null;
  return {
    marketScore: score,
    recommendedMultiplier,
    blockReason,
    lastError: SharedCache.get(KEY_LAST_ERROR) || null
  };
}

/** 1분 주기: 30m/4h 갱신 후 점수 재계산 */
async function tickMediumTerm(representativeMarket = 'KRW-BTC', maxBetMultiplier = 2) {
  await refreshMediumTerm(representativeMarket);
  return getMarketContext(representativeMarket, maxBetMultiplier);
}

/** 5분 주기: 1d 갱신 후 점수 재계산 */
async function tickDaily(representativeMarket = 'KRW-BTC', maxBetMultiplier = 2) {
  await refreshDaily(representativeMarket);
  return getMarketContext(representativeMarket, maxBetMultiplier);
}

/** 서버 기동 시 한 번 호출해 캐시 워밍업 가능 */
async function warmup(representativeMarket = 'KRW-BTC') {
  await refreshMediumTerm(representativeMarket);
  await delay(API_DELAY_MS);
  await refreshDaily(representativeMarket);
  return getMarketContext(2);
}

module.exports = {
  MARKET_SCORE_CRASH_THRESHOLD,
  refreshMediumTerm,
  refreshDaily,
  getMarketContext,
  getRecommendedMultiplier,
  tickMediumTerm,
  tickDaily,
  warmup,
  computeMarketScore
};
