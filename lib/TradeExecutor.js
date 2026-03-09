/**
 * TradeExecutor - 업비트 주문 실행 + 익절/손절(트레일링 스탑) 감시
 * - 주문: API 재시도 래퍼로 네트워크 오류 시에도 봇 정지 방지
 * - 감시: 포지션·스냅샷·현재가·Entry Score로 청산 여부 판단, 사유 로그
 * - 학습: 실행부와 판단부(scalpEngine) 분리해 테스트·확장 용이
 */

const upbit = require('./upbit');
const scalpEngine = require('./scalpEngine');
const { API_RETRY_MAX, API_RETRY_DELAY_MS } = require('../config.default');

const API_KEY_ERROR_MSG = 'API Key 권한 오류: 매수/매도 권한을 확인하세요';

/**
 * API Key 유효성 검사 (계좌 조회로 권한 확인). 매수/매도 실행 전 호출 권장.
 * @param {string} accessKey
 * @param {string} secretKey
 * @returns {Promise<{ valid: boolean, error?: string }>}
 */
async function validateApiKeys(accessKey, secretKey) {
  if (!accessKey || !secretKey) {
    return { valid: false, error: API_KEY_ERROR_MSG };
  }
  try {
    const accounts = await upbit.getAccounts(accessKey, secretKey);
    if (!Array.isArray(accounts)) {
      return { valid: false, error: API_KEY_ERROR_MSG };
    }
    return { valid: true };
  } catch (err) {
    const msg = (err && err.message) || '';
    if (/invalid|unauthorized|forbidden|401|403|권한/i.test(msg)) {
      return { valid: false, error: API_KEY_ERROR_MSG };
    }
    return { valid: false, error: msg || API_KEY_ERROR_MSG };
  }
}

/**
 * 지연 (ms)
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 재시도 래퍼: 실패 시 최대 N회 재시도 (네트워크 오류 등에서 봇 멈춤 방지)
 * @param {() => Promise<T>} fn
 * @param {number} maxRetries
 * @returns {Promise<T>}
 * @template T
 */
async function withRetry(fn, maxRetries = API_RETRY_MAX) {
  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < maxRetries) await delay(API_RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

const MIN_ORDER_KRW = 5000;
const FEE_BUFFER_RATIO = 1.0005;
const SAFE_CAP_RATIO = 0.99;

/**
 * 시장가 매수 (KRW 금액 지정)
 * - Upbit: ord_type=price, price=금액(원) 이면 해당 금액만큼 시장가 매수
 * - orderableKrw 제공 시: (주문금액+수수료 0.05%) > 주문가능KRW 이면 잔액의 99%로 제한, 최소금액 미만이면 INSUFFICIENT_FUNDS_BID throw
 * @param {string} accessKey
 * @param {string} secretKey
 * @param {string} market - 예: KRW-BTC
 * @param {number} priceKrw - 주문 금액(원)
 * @param {number|null} [orderableKrw] - 주문 가능 KRW (제공 시 insufficient_funds_bid 방지용 검증)
 * @returns {Promise<Object>} Upbit 주문 응답
 */
async function placeMarketBuyByPrice(accessKey, secretKey, market, priceKrw, orderableKrw = null) {
  let amountKrw = Math.floor(Number(priceKrw) || 0);
  if (orderableKrw != null && orderableKrw >= 0) {
    const requiredKrw = amountKrw * FEE_BUFFER_RATIO;
    if (requiredKrw > orderableKrw) {
      amountKrw = Math.floor(orderableKrw * SAFE_CAP_RATIO);
      if (amountKrw < MIN_ORDER_KRW) {
        const err = new Error('INSUFFICIENT_FUNDS_BID');
        err.code = 'INSUFFICIENT_FUNDS_BID';
        throw err;
      }
    }
  }

  const client = upbit.createClient(accessKey, secretKey);
  return withRetry(async () => {
    const body = {
      market: String(market),
      side: 'bid',
      ord_type: 'price',
      price: String(amountKrw)
    };
    return await client.request('POST', '/orders', body);
  });
}

/**
 * 시장가 매도 (수량 지정)
 * @param {string} accessKey
 * @param {string} secretKey
 * @param {string} market
 * @param {number} volume - 매도 수량
 * @returns {Promise<Object>}
 */
async function placeMarketSellByVolume(accessKey, secretKey, market, volume) {
  const client = upbit.createClient(accessKey, secretKey);
  return withRetry(async () => {
    const body = {
      market: String(market),
      side: 'ask',
      ord_type: 'market',
      volume: String(volume)
    };
    return await client.request('POST', '/orders', body);
  });
}

/**
 * 익절/손절/트레일링 스탑 등 청산 필요 여부 판단 (scalpEngine 프로필 사용)
 * @param {Object} position - { entryPrice, entryTimeMs, strengthPeak60s?, highSinceEntry? }
 * @param {Object} snapshot - 현재 호가·체결 스냅샷
 * @param {number} currentPrice - 현재가
 * @param {number|null} currentEntryScore - 보유 중 실시간 Entry Score (score_out 판단용)
 * @returns {{ exit: boolean, reason?: string }}
 */
function checkExit(position, snapshot, currentPrice, currentEntryScore) {
  return scalpEngine.shouldExitScalp(position, snapshot, currentPrice, currentEntryScore);
}

/**
 * 청산 사유 한글 라벨 (로그용)
 * @param {string} reason
 * @returns {string}
 */
function getExitReasonLabel(reason) {
  return scalpEngine.getExitReasonLabel(reason);
}

module.exports = {
  validateApiKeys,
  API_KEY_ERROR_MSG,
  withRetry,
  placeMarketBuyByPrice,
  placeMarketSellByVolume,
  checkExit,
  getExitReasonLabel
};
