/**
 * 업비트 수수료 등 전역 상수 — 모든 엔진에서 동일 참조
 */
const UPBIT_FEE_RATE = 0.0005; // 0.05% (매수 또는 매도 1회)
const ROUND_TRIP_FEE = 0.001;  // 0.1% (매수+매도 합산)

/** 익절 허용 최소 수익률: 왕복 수수료 0.1% + 슬리피지 방어 및 순수익 확보용 마진 0.15% 포함. 이 이상일 때만 익절 처리 */
const MIN_PROFIT_EXIT_PCT = 0.25;

module.exports = {
  UPBIT_FEE_RATE,
  ROUND_TRIP_FEE,
  MIN_PROFIT_EXIT_PCT
};
