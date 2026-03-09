/**
 * Upbit REST API 연동 (인증·잔고·시세·호가)
 * API Key는 서버 환경변수/config에서만 로드 (클라이언트 노출 금지)
 * invalid_query_payload 401 방지: querystring으로 키 정렬·인코딩 통일 후 sha512 해시 생성
 */

const crypto = require('crypto');
const querystring = require('querystring');
const axios = require('axios');

const BASE_URL = 'https://api.upbit.com/v1';

// ---------- JWT 인증 (Upbit: query_hash = SHA512(query string), 서명 = HS256) ----------

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * JWT 토큰 생성 (수동/자동 주문 공통)
 * @param {string} accessKey
 * @param {string} secretKey
 * @param {string} queryString - GET/POST 공통: querystring으로 만든 단일 문자열 (해시와 요청에 동일 사용)
 * @returns {string} Bearer 제외한 JWT
 */
function generateUpbitToken(accessKey, secretKey, queryString) {
  const nonce = crypto.randomUUID();
  const payload = {
    access_key: accessKey,
    nonce,
    query_hash: null,
    query_hash_alg: 'SHA512'
  };
  if (queryString && queryString.length > 0) {
    payload.query_hash = crypto.createHash('sha512').update(queryString, 'utf8').digest('hex');
  }
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signatureInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.createHmac('sha256', secretKey).update(signatureInput).digest();
  const encodedSignature = base64UrlEncode(signature);
  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

/**
 * 파라미터를 문자열로 정규화 (ord_type, side 등 오타/타입 방지)
 */
function normalizeParamValue(v) {
  if (v == null) return '';
  return String(v).trim();
}

/**
 * 객체 → query string (키 알파벳 정렬, querystring 인코딩). GET/POST query_hash 일치용.
 */
function buildQueryStringForHash(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const sorted = {};
  Object.keys(obj)
    .sort()
    .forEach((k) => {
      sorted[k] = normalizeParamValue(obj[k]);
    });
  return querystring.stringify(sorted);
}

/**
 * POST /orders body: 모든 값을 문자열로 정규화 후 정렬·querystring으로 query_hash용 문자열 생성
 */
function orderBodyToQueryString(body) {
  if (!body || typeof body !== 'object') return '';
  const normalized = {};
  Object.keys(body).forEach((k) => {
    normalized[k] = normalizeParamValue(body[k]);
  });
  return buildQueryStringForHash(normalized);
}

function createClient(accessKey, secretKey) {
  async function request(method, path, params = null) {
    const url = `${BASE_URL}${path}`;
    const isPostOrder = method === 'POST' && path === '/orders';
    let fullUrl = url;
    let queryString = '';
    let data = undefined;

    if (isPostOrder && params && typeof params === 'object' && !(params instanceof URLSearchParams)) {
      const normalizedBody = {};
      Object.keys(params)
        .sort()
        .forEach((k) => {
          normalizedBody[k] = normalizeParamValue(params[k]);
        });
      data = normalizedBody;
      queryString = orderBodyToQueryString(normalizedBody);
      fullUrl = url;
    } else {
      queryString = params ? buildQueryStringForHash(params) : '';
      fullUrl = queryString ? `${url}?${queryString}` : url;
    }

    const token = generateUpbitToken(accessKey, secretKey, queryString);
    try {
      const res = await axios({
        method,
        url: fullUrl,
        headers: { Authorization: `Bearer ${token}` },
        data,
        timeout: 10000
      });
      return res.data;
    } catch (err) {
      if (err.response) throw new Error(`Upbit API ${err.response.status}: ${JSON.stringify(err.response.data)}`);
      throw err;
    }
  }
  return { request };
}

// ---------- 공개 API (인증 불필요) ----------
/** 마켓 코드 목록 (공개). market: KRW-BTC 등 */
async function getMarketAll() {
  try {
    const res = await axios.get(`${BASE_URL}/market/all`, { timeout: 8000 });
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    console.error('Upbit getMarketAll error:', err.message);
    return [];
  }
}

async function getTickers(markets) {
  try {
    const list = Array.isArray(markets) ? markets.join(',') : markets;
    const res = await axios.get(`${BASE_URL}/ticker`, {
      params: { markets: list },
      timeout: 5000
    });
    return res.data;
  } catch (err) {
    console.error('Upbit getTickers error:', err.message);
    return [];
  }
}

async function getOrderbook(markets) {
  try {
    const list = Array.isArray(markets) ? markets.join(',') : markets;
    const res = await axios.get(`${BASE_URL}/orderbook`, {
      params: { markets: list },
      timeout: 5000
    });
    return res.data;
  } catch (err) {
    console.error('Upbit getOrderbook error:', err.message);
    return [];
  }
}

/** 분봉 캔들 (공개 API). unit: 1,3,5,10,15,30,60,240. count 최대 200. to: ISO8601 마지막 캔들 시각(미포함) */
async function getCandlesMinutes(unit, market, count = 200, to = null) {
  try {
    const params = { market, count: Math.min(200, count) };
    if (to) params.to = to;
    const res = await axios.get(`${BASE_URL}/candles/minutes/${unit}`, {
      params,
      timeout: 8000
    });
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    if (err.response && err.response.status === 429) throw new Error('TOO_MANY_REQUESTS');
    console.error('Upbit getCandlesMinutes error:', err.message);
    return [];
  }
}

/** 일봉 캔들 (공개 API). count 최대 200. */
async function getCandlesDays(market, count = 200, to = null) {
  try {
    const params = { market, count: Math.min(200, count) };
    if (to) params.to = to;
    const res = await axios.get(`${BASE_URL}/candles/days`, {
      params,
      timeout: 8000
    });
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    if (err.response && err.response.status === 429) throw new Error('TOO_MANY_REQUESTS');
    console.error('Upbit getCandlesDays error:', err.message);
    return [];
  }
}

// ---------- 계좌(잔고) 조회 (인증 필요) ----------
async function getAccounts(accessKey, secretKey) {
  if (!accessKey || !secretKey) return [];
  try {
    const client = createClient(accessKey, secretKey);
    return await client.request('GET', '/accounts');
  } catch (err) {
    console.error('Upbit getAccounts error:', err.message);
    return [];
  }
}

// ---------- 자산 요약 계산 (총 매수금액, 평가금액, 주문가능 KRW) ----------
// APENFT·PURSE 강제 제외: 계좌 조회 직후 필터 적용, 이후 모든 총 매수/평가 금액은 filteredAccounts만 사용
function summarizeAccounts(accounts, tickersByMarket) {
  const filteredAccounts = (accounts || []).filter(
    (acc) => !['APENFT', 'PURSE'].includes(acc.currency)
  );
  let totalBuyKrw = 0;   // 총 매수금액 (필터 적용)
  let totalEvaluationKrw = 0;   // 총 평가금액 (필터 적용)
  let krwBalance = 0;
  const tickerMap = {};
  (tickersByMarket || []).forEach(t => { tickerMap[t.market] = t; });
  filteredAccounts.forEach((acc) => {
    const currency = acc.currency;
    const balance = parseFloat(acc.balance || 0);
    const avgBuyPrice = parseFloat(acc.avg_buy_price || 0);
    if (currency === 'KRW') {
      krwBalance = balance;
      return;
    }
    const market = `KRW-${currency}`;
    const ticker = tickerMap[market];
    const price = ticker ? ticker.trade_price : avgBuyPrice;
    const buyKrw = avgBuyPrice * balance;
    const evalKrw = price * balance;
    totalBuyKrw += buyKrw;
    totalEvaluationKrw += evalKrw;
  });
  const orderableKrw = krwBalance;
  return {
    totalBuyKrw,
    totalEvaluationKrw: totalEvaluationKrw + krwBalance,
    orderableKrw,
    totalBuyKrwForCoins: totalBuyKrw,
    evaluationKrwForCoins: totalEvaluationKrw
  };
}

// ---------- 최근 체결/주문 내역 (실제 주문 API 연동 시 확장) ----------
async function getRecentOrders(accessKey, secretKey, market, limit = 10) {
  if (!accessKey || !secretKey) return [];
  try {
    const client = createClient(accessKey, secretKey);
    const state = 'done';
    const data = await client.request('GET', '/orders', { market, state, limit: String(limit) });
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('Upbit getRecentOrders error:', err.message);
    return [];
  }
}

/** 체결 대기(wait) 주문 목록 조회. market 생략 시 전체 */
async function getOpenOrders(accessKey, secretKey, market = null) {
  if (!accessKey || !secretKey) return [];
  try {
    const client = createClient(accessKey, secretKey);
    const params = { state: 'wait', limit: '100' };
    if (market) params.market = market;
    const data = await client.request('GET', '/orders', params);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('Upbit getOpenOrders error:', err.message);
    return [];
  }
}

/** 주문 1건 취소 (uuid) */
async function cancelOrder(accessKey, secretKey, uuid) {
  if (!accessKey || !secretKey || !uuid) return null;
  try {
    const client = createClient(accessKey, secretKey);
    const data = await client.request('DELETE', '/order', { uuid });
    return data;
  } catch (err) {
    console.error('Upbit cancelOrder error:', err.message);
    throw err;
  }
}

/** 모든 미체결 주문 일괄 취소 (cancel_all_orders) */
async function cancelAllOrders(accessKey, secretKey, markets = null) {
  const list = markets && markets.length
    ? (await Promise.all(markets.map((m) => getOpenOrders(accessKey, secretKey, m)))).flat()
    : await getOpenOrders(accessKey, secretKey);
  const results = { cancelled: 0, errors: [] };
  for (const order of list) {
    const uuid = order.uuid;
    if (!uuid) continue;
    try {
      await cancelOrder(accessKey, secretKey, uuid);
      results.cancelled++;
    } catch (e) {
      results.errors.push({ uuid, message: e.message });
    }
  }
  return results;
}

/** 거래대금(acc_trade_price_24h) 상위 limit개 KRW 종목 티커만 조회 (429 방지: 30개 단위 요청 + 250ms 간격) */
const TICKER_DELAY_MS = 250;

async function getTopKrwTickersByTradePrice(limit = 30) {
  const allMarkets = await getMarketAll();
  const krwMarkets = (allMarkets || []).filter((m) => m.market && m.market.startsWith('KRW-')).map((m) => m.market);
  if (krwMarkets.length === 0) return [];
  const merged = [];
  const chunkSize = 30;
  for (let i = 0; i < krwMarkets.length; i += chunkSize) {
    const chunk = krwMarkets.slice(i, i + chunkSize);
    const tickers = await getTickers(chunk);
    if (Array.isArray(tickers)) merged.push(...tickers);
    if (i + chunkSize < krwMarkets.length) {
      await new Promise((resolve) => setTimeout(resolve, TICKER_DELAY_MS));
    }
  }
  const sorted = merged
    .filter((t) => t.acc_trade_price_24h != null)
    .sort((a, b) => (b.acc_trade_price_24h || 0) - (a.acc_trade_price_24h || 0));
  return sorted.slice(0, limit);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  getMarketAll,
  getTickers,
  getTopKrwTickersByTradePrice,
  delay,
  getOrderbook,
  getAccounts,
  getCandlesMinutes,
  getCandlesDays,
  summarizeAccounts,
  getRecentOrders,
  getOpenOrders,
  cancelOrder,
  cancelAllOrders,
  createClient,
  generateUpbitToken,
  orderBodyToQueryString
};
