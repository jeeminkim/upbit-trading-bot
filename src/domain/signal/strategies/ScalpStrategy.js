/**
 * SCALP 전략 — 기존 lib/scalpEngine.runEntryPipeline 브리지
 * 출력을 SignalDecision 형식으로 변환. (단계적 이관: 기존 로직 유지)
 */

const path = require('path');
const scalpEngine = require('../../../../lib/scalpEngine');

const SOURCE_NAME = 'SCALP';

/**
 * 진입 최소 스코어 (profile.entry_score_min 대체용; 실제는 scalpEngine.getProfile() 사용)
 */
function getEntryScoreMin() {
  const profile = scalpEngine.getProfile();
  return profile?.entry_score_min ?? 0;
}

/**
 * 레거시 컨텍스트로 스칼프 판단 후 SignalDecision + legacy 필드 반환 (server.js nextScalpState 연동용)
 * @param {Object} ctx - { legacySnapshot, prevHigh, currentPrice, market, marketContext?, availableKrw? }
 * @returns {{ decision: import('../../../shared/types/Signal').SignalDecision, legacy: { p0Allowed: boolean, p0Reason: string|null, priceBreak: boolean, volSurge: boolean, marketScore: number|null, quantityMultiplier: number } } | null}
 */
function evaluateFromLegacy(ctx) {
  if (!ctx?.legacySnapshot || ctx.market == null) return null;
  const { legacySnapshot, prevHigh, currentPrice, market, marketContext = null, availableKrw = null } = ctx;
  const pipeline = scalpEngine.runEntryPipeline(
    legacySnapshot,
    prevHigh,
    currentPrice,
    market,
    marketContext,
    availableKrw
  );
  if (!pipeline) return null;

  const score = pipeline.score ?? 0;
  const entryMin = getEntryScoreMin();
  const p0Allowed = pipeline.p0Allowed === true;
  const side = p0Allowed && score >= entryMin ? 'LONG' : 'FLAT';

  const reasons = [];
  if (pipeline.volSurge) reasons.push('vol_surge');
  if (pipeline.priceBreak) reasons.push('price_break');
  if (pipeline.marketScore != null) reasons.push(`market_score:${pipeline.marketScore}`);

  const invalidation = [];
  if (!p0Allowed && pipeline.p0Reason) invalidation.push(pipeline.p0Reason);
  if (score < entryMin && p0Allowed) invalidation.push('score_below_min');

  const decision = {
    market,
    side,
    score,
    confidence: p0Allowed ? Math.min(1, (score - entryMin) / Math.max(1, 7 - entryMin)) : 0,
    expectedEdgeBp: 0,
    horizonSec: 60,
    reasons,
    invalidation,
    source: SOURCE_NAME
  };

  const legacy = {
    score: pipeline.score,
    p0Allowed: pipeline.p0Allowed === true,
    p0Reason: pipeline.p0Reason ?? null,
    priceBreak: !!pipeline.priceBreak,
    volSurge: !!pipeline.volSurge,
    marketScore: pipeline.marketScore ?? null,
    quantityMultiplier: pipeline.quantityMultiplier ?? 1.0
  };

  return { decision, legacy };
}

module.exports = {
  getEntryScoreMin,
  evaluateFromLegacy,
  SOURCE_NAME
};
