/**
 * PositionEngine, PositionStore — 추후 구현
 *
 * 수익률 계산 계승 (업비트 방식, KRW 제외):
 * - 총매수: totalBuyKrwForCoins ?? totalBuyKrw (보유 코인만)
 * - 평가: evaluationKrwForCoins
 * - 수익률(%) = (evaluationKrwForCoins - totalBuyKrwForCoins) / totalBuyKrwForCoins * 100
 * - server.js getProfitPct(assets) 및 buildCurrentStateEmbed 로직 그대로 유지
 */
module.exports = {};
