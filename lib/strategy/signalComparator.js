/**
 * 두 시그널(SCALP vs REGIME) 비교 및 최종 orchestrator_score 계산
 * consensus 보너스, 전략별 패널티 적용
 */

const ORCH_WEIGHTS = {
  score: 0.40,
  confidence: 0.25,
  expected_edge: 0.20,
  risk_level: -0.15
};

const THRESHOLD_CONSENSUS_DIFF = 0.15;
const CONSENSUS_BONUS = 0.08;
const SCALP_TRANSACTION_COST_PENALTY = 0.02;
const REGIME_DRAWDOWN_PENALTY = 0.01;
const DUPLICATE_SYMBOL_PENALTY = 0.20;

/**
 * 단일 시그널에 대한 orchestrator_score
 * @param {Object} signal - UnifiedSignal
 * @param {Object} opts - { isScalp, isRegime, hasExistingPosition, consensusBonus }
 */
function computeOrchestratorScore(signal, opts = {}) {
  if (!signal) return 0;
  const score = Math.max(0, Math.min(1, signal.score ?? 0));
  const confidence = Math.max(0, Math.min(1, signal.confidence ?? 0));
  const expected_edge = Math.max(0, Math.min(1, signal.expected_edge ?? score));
  const risk_level = Math.max(0, Math.min(1, signal.risk_level ?? 0.5));

  let v =
    ORCH_WEIGHTS.score * score +
    ORCH_WEIGHTS.confidence * confidence +
    ORCH_WEIGHTS.expected_edge * expected_edge +
    ORCH_WEIGHTS.risk_level * risk_level;

  if (opts.isScalp) v -= SCALP_TRANSACTION_COST_PENALTY;
  if (opts.isRegime) v -= REGIME_DRAWDOWN_PENALTY;
  if (opts.hasExistingPosition) v -= DUPLICATE_SYMBOL_PENALTY;
  if (opts.consensusBonus) v += CONSENSUS_BONUS;

  return Math.max(0, Math.min(1, v));
}

/**
 * SCALP vs REGIME 같은 심볼 BUY일 때 consensus 여부 및 보너스
 */
function getConsensus(scalpSignal, regimeSignal) {
  if (!scalpSignal || !regimeSignal) return { isConsensus: false, bonus: 0 };
  if (scalpSignal.side !== 'BUY' || regimeSignal.side !== 'BUY') return { isConsensus: false, bonus: 0 };
  if (scalpSignal.symbol !== regimeSignal.symbol) return { isConsensus: false, bonus: 0 };
  const diff = Math.abs((scalpSignal.score || 0) - (regimeSignal.score || 0));
  const isConsensus = diff <= THRESHOLD_CONSENSUS_DIFF;
  return {
    isConsensus,
    bonus: isConsensus ? CONSENSUS_BONUS : 0,
    symbol: scalpSignal.symbol
  };
}

/**
 * 두 후보 중 더 나은 쪽 선택 (같은 심볼 / 다른 심볼 모두)
 * @returns { { chosen: 'SCALP'|'REGIME'|'CONSENSUS'|'NONE', signal: Object|null, finalScore: number, reason: string } }
 */
function compareAndChoose(scalpSignal, regimeSignal, existingPositionSymbols = []) {
  const hasPos = (sym) => existingPositionSymbols.includes(sym);

  const scalpScore = scalpSignal
    ? computeOrchestratorScore(scalpSignal, { isScalp: true, hasExistingPosition: hasPos(scalpSignal.symbol) })
    : 0;
  const regimeScore = regimeSignal
    ? computeOrchestratorScore(regimeSignal, { isRegime: true, hasExistingPosition: hasPos(regimeSignal.symbol) })
    : 0;

  const consensus = getConsensus(scalpSignal, regimeSignal);
  let scalpFinal = scalpScore;
  let regimeFinal = regimeScore;
  if (consensus.isConsensus && consensus.symbol) {
    if (scalpSignal && scalpSignal.symbol === consensus.symbol) scalpFinal += consensus.bonus;
    if (regimeSignal && regimeSignal.symbol === consensus.symbol) regimeFinal += consensus.bonus;
  }

  if (!scalpSignal && !regimeSignal) {
    return { chosen: 'NONE', signal: null, finalScore: 0, reason: 'no signals', consensus: false };
  }
  if (scalpSignal && !regimeSignal) {
    return {
      chosen: 'SCALP',
      signal: scalpSignal,
      finalScore: scalpFinal,
      reason: 'scalp only',
      consensus: false
    };
  }
  if (!scalpSignal && regimeSignal) {
    return {
      chosen: 'REGIME',
      signal: regimeSignal,
      finalScore: regimeFinal,
      reason: 'regime only',
      consensus: false
    };
  }

  if (consensus.isConsensus && scalpSignal.symbol === regimeSignal.symbol) {
    const combinedScore = Math.max(scalpFinal, regimeFinal);
    const better = scalpFinal >= regimeFinal ? scalpSignal : regimeSignal;
    return {
      chosen: 'CONSENSUS',
      signal: better,
      finalScore: combinedScore,
      reason: 'consensus same symbol',
      consensus: true
    };
  }

  if (scalpSignal.symbol === regimeSignal.symbol) {
    const better = scalpFinal >= regimeFinal ? scalpSignal : regimeSignal;
    const chosen = scalpFinal >= regimeFinal ? 'SCALP' : 'REGIME';
    return {
      chosen,
      signal: better,
      finalScore: Math.max(scalpFinal, regimeFinal),
      reason: chosen === 'SCALP' ? 'higher score same symbol' : 'higher score same symbol',
      consensus: false
    };
  }

  const pickScalp = scalpFinal >= regimeFinal;
  return {
    chosen: pickScalp ? 'SCALP' : 'REGIME',
    signal: pickScalp ? scalpSignal : regimeSignal,
    finalScore: pickScalp ? scalpFinal : regimeFinal,
    reason: pickScalp ? 'higher edge lower risk (scalp)' : 'higher edge lower risk (regime)',
    consensus: false
  };
}

module.exports = {
  computeOrchestratorScore,
  getConsensus,
  compareAndChoose,
  ORCH_WEIGHTS,
  THRESHOLD_ENTRY: 0.62
};
