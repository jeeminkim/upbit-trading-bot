const { UPBIT_FEE_RATE } = require('../constants');

/**
 * 업비트 표준 수익률 계산 — 보유 KRW 제외, 코인 매수금/평가금만 사용 (수수료 미반영)
 */
function calculateUpbitProfitPct(totalBuyKrw, totalEvalKrw) {
  const buy = Number(totalBuyKrw);
  if (!buy || buy <= 0) return 0;
  const evalKrw = Number(totalEvalKrw) || 0;
  return ((evalKrw - buy) / buy) * 100;
}

/**
 * 수수료 반영 실질 수익률 (업비트 표준). 실제 낸 돈 vs 실제 받을 돈 기준.
 * @param {number} totalBuyKrw - 코인 매수 금액 (수수료 미포함)
 * @param {number} totalEvalKrw - 현재가/매도가 기준 평가 금액
 * @param {number} [feeRate] - 수수료율 (기본 UPBIT_FEE_RATE)
 * @returns {number} 수익률 %
 */
function calculateNetProfitPct(totalBuyKrw, totalEvalKrw, feeRate = UPBIT_FEE_RATE) {
  const buy = Number(totalBuyKrw);
  if (!buy || buy <= 0) return 0;
  const evalKrw = Number(totalEvalKrw) || 0;
  const rate = Number(feeRate) || UPBIT_FEE_RATE;
  const actualCost = buy * (1 + rate);
  const actualRevenue = evalKrw * (1 - rate);
  return ((actualRevenue - actualCost) / actualCost) * 100;
}

/**
 * 수수료 반영 실질 수익금 (원)
 */
function calculateNetProfitKrw(totalBuyKrw, totalEvalKrw, feeRate = UPBIT_FEE_RATE) {
  const buy = Number(totalBuyKrw);
  if (!buy || buy <= 0) return 0;
  const evalKrw = Number(totalEvalKrw) || 0;
  const rate = Number(feeRate) || UPBIT_FEE_RATE;
  const actualCost = buy * (1 + rate);
  const actualRevenue = evalKrw * (1 - rate);
  return actualRevenue - actualCost;
}

/**
 * 실질 수익이 나기 위한 최소 목표가(손익분기점)
 * (매도가 * (1 - fee)) > (평단가 * (1 + fee)) 가 성립하는 최소 매도가
 * @param {number} avgPrice - 매수 평단가
 * @param {number} [feeRate] - 수수료율 (기본 UPBIT_FEE_RATE)
 * @returns {number} 수수료 제외하고도 수익이 시작되는 가격
 */
function getBreakEvenPrice(avgPrice, feeRate = UPBIT_FEE_RATE) {
  const p = Number(avgPrice);
  if (!p || p <= 0) return 0;
  const rate = Number(feeRate) || UPBIT_FEE_RATE;
  return (p * (1 + rate)) / (1 - rate);
}

/**
 * 익절 가능 여부: 실질 수익률이 최소 마진 이상일 때만 true
 * @param {number} currentPrice - 현재가
 * @param {number} avgPrice - 매수 평단가
 * @param {number} [minPct] - 최소 수익률 (기본 MIN_PROFIT_EXIT_PCT)
 * @param {number} [feeRate] - 수수료율
 * @returns {boolean}
 */
function canExitWithProfit(currentPrice, avgPrice, minPct, feeRate = UPBIT_FEE_RATE) {
  const { MIN_PROFIT_EXIT_PCT } = require('../constants');
  const pct = calculateNetProfitPct(avgPrice, currentPrice, feeRate);
  const minimum = minPct != null ? Number(minPct) : MIN_PROFIT_EXIT_PCT;
  return pct >= minimum;
}

module.exports = {
  calculateUpbitProfitPct,
  calculateNetProfitPct,
  calculateNetProfitKrw,
  getBreakEvenPrice,
  canExitWithProfit
};
