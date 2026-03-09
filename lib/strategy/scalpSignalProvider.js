/**
 * SCALP 봇 시그널 제공자.
 * state.scalpState, profile 기반으로 진입 후보를 공통 시그널 형식으로 반환.
 * 기존 SCALP 로직은 변경하지 않고 읽기만 함.
 */

const { normalizeScalpRaw } = require('./signalNormalizer');

const SCALP_MARKETS = ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL'];

/**
 * 현재 scalpState + profile 기준으로 심볼별 SCALP 시그널 생성 (진입 후보만)
 * @param {Object} scalpState - state.scalpState (market -> { entryScore, p0GateStatus, ... })
 * @param {Object} profile - scalpEngine.getProfile()
 * @param {number} [entryScoreMin] - 최소 진입 점수
 * @returns {Array<Object>} UnifiedSignal[]
 */
function getScalpSignals(scalpState, profile, entryScoreMin) {
  const min = entryScoreMin != null ? entryScoreMin : (profile?.entry_score_min ?? 4);
  const out = [];
  for (const market of SCALP_MARKETS) {
    const entry = scalpState && scalpState[market];
    if (!entry) continue;
    const score = entry.entryScore != null ? entry.entryScore : 0;
    const p0Allowed = entry.p0GateStatus == null;
    if (score < min || !p0Allowed) continue;
    const pipeline = {
      score: entry.entryScore,
      p0Allowed,
      p0Reason: entry.p0GateStatus || null,
      marketScore: entry.marketScore != null ? entry.marketScore : null,
      quantityMultiplier: entry.quantityMultiplier != null ? entry.quantityMultiplier : 1
    };
    const signal = normalizeScalpRaw(market, pipeline, entry, profile, p0Allowed);
    if (signal.side === 'BUY') out.push(signal);
  }
  return out;
}

/**
 * 단일 최고 점수 SCALP 후보 1개 반환 (오케스트레이터 비교용)
 */
function getBestScalpSignal(scalpState, profile, entryScoreMin) {
  const signals = getScalpSignals(scalpState, profile, entryScoreMin);
  if (signals.length === 0) return null;
  return signals.reduce((a, b) => (a.score >= b.score ? a : b));
}

module.exports = {
  getScalpSignals,
  getBestScalpSignal,
  SCALP_MARKETS
};
