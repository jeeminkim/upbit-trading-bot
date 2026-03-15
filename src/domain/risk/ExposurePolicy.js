/**
 * 노출 정책 — 보유 종목 수·종목당 최대 투자 금액 제한
 */

const DEFAULT_MAX_POSITIONS = 4;
const DEFAULT_MIN_ORDER_KRW = 5000;

/**
 * @param {Array<{ currency?: string, balance?: string }>} accounts - 업비트 잔고 목록
 * @param {Object} assets - { orderableKrw, totalEvaluationKrw }
 * @param {string} market - 예: KRW-BTC
 * @param {number} budgetKrw - 이번 주문 예정 금액
 * @param {{ maxPositions?: number, minOrderKrw?: number }} [options]
 * @returns {{ allowed: boolean, reasons: string[] }}
 */
function check(accounts, assets, market, budgetKrw, options = {}) {
  const reasons = [];
  const maxPositions = options.maxPositions ?? DEFAULT_MAX_POSITIONS;
  const minOrderKrw = options.minOrderKrw ?? DEFAULT_MIN_ORDER_KRW;

  const orderableKrw = assets?.orderableKrw ?? 0;
  if (orderableKrw < minOrderKrw) {
    reasons.push('MIN_ORDER_KRW');
    return { allowed: false, reasons };
  }
  if (budgetKrw != null && budgetKrw > 0 && orderableKrw < budgetKrw * 1.0005) {
    reasons.push('INSUFFICIENT_KRW');
    return { allowed: false, reasons };
  }

  const scalpMarkets = ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL'];
  const currenciesWithBalance = (accounts || [])
    .filter((a) => {
      const cur = (a.currency || '').toUpperCase();
      if (cur === 'KRW') return false;
      const m = 'KRW-' + cur;
      return scalpMarkets.includes(m) && parseFloat(a.balance || 0) > 0;
    })
    .map((a) => (a.currency || '').toUpperCase());
  const uniquePositions = new Set(currenciesWithBalance);
  const marketCurrency = (market || '').replace('KRW-', '');
  const alreadyHas = uniquePositions.has(marketCurrency);
  if (!alreadyHas && uniquePositions.size >= maxPositions) {
    reasons.push('MAX_POSITIONS');
    return { allowed: false, reasons };
  }

  return { allowed: true, reasons: [] };
}

module.exports = { check };
