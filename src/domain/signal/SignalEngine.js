/**
 * SignalEngine — 전략별 시그널 수집 후 정규화하여 SignalDecision[] 반환
 * 현재는 ScalpStrategy만 연결; 추후 Regime/Pattern/Meme 전략 추가
 */

const SignalNormalizer = require('./SignalNormalizer');

/**
 * @param {Array<{ evaluateFromLegacy: (ctx: object) => object | null }>} strategies
 * @param {{ normalize: (decisions: object[]) => object[] }} normalizer
 */
function SignalEngine(strategies, normalizer) {
  this.strategies = strategies || [];
  this.normalizer = normalizer || SignalNormalizer;
}

/**
 * 레거시 컨텍스트맵으로 시그널 평가 (server.js runScalpCycle 연동용)
 * @param {Record<string, { legacySnapshot: object, prevHigh: number, currentPrice: number, market: string, marketContext?: object, availableKrw?: number }>} contextByMarket
 * @returns {{ decisions: import('../../shared/types/Signal').SignalDecision[], byMarket: Record<string, { decision: object, legacy: object }> }}
 */
SignalEngine.prototype.evaluateFromLegacy = function evaluateFromLegacy(contextByMarket) {
  const decisions = [];
  const byMarket = {};
  for (const market of Object.keys(contextByMarket || {})) {
    const ctx = contextByMarket[market];
    for (const strategy of this.strategies) {
      if (typeof strategy.evaluateFromLegacy !== 'function') continue;
      const result = strategy.evaluateFromLegacy(ctx);
      if (result) {
        decisions.push(result.decision);
        byMarket[market] = result;
        break;
        // 첫 번째 전략 결과만 사용 (현재 SCALP 단일)
      }
    }
  }
  return {
    decisions: this.normalizer.normalize(decisions),
    byMarket
  };
};

module.exports = SignalEngine;
