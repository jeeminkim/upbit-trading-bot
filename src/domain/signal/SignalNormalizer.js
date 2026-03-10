/**
 * 다중 전략 시그널 정규화/병합 (스코어·신뢰도 보정)
 * 현재는 패스스루; 추후 Regime/Pattern/Meme 전략 추가 시 가중 평균 등 적용
 */

/**
 * @param {import('../../shared/types/Signal').SignalDecision[]} decisions
 * @returns {import('../../shared/types/Signal').SignalDecision[]}
 */
function normalize(decisions) {
  if (!Array.isArray(decisions)) return [];
  return decisions.filter((d) => d != null && d.market);
}

module.exports = { normalize };
