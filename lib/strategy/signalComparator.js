/**
 * 두 시그널(SCALP vs REGIME) 비교 및 최종 orchestrator_score 계산
 * consensus 보너스, 전략별 패널티 적용
 * - threshold는 런타임 전략 모드(lib/runtimeStrategyConfig)에서 읽음. Dashboard/Discord에서 전환 가능.
 * - EDGE_LAYER 사용 시 비교 전 전략별 점수 정규화 (mean/std, warm-up fallback, outlier clamp)
 */

const runtimeStrategyConfig = require('../runtimeStrategyConfig');
const configDefault = require('../../config.default');

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

const MAX_SCORE_HISTORY = 100;
const strategyScoreHistory = { SCALP: [], REGIME: [] };

/**
 * 전략별 점수 정규화 (비교 전 적용). EDGE_LAYER 사용 시에만 활성화.
 * min_samples 미달 또는 std < epsilon 이면 raw score 반환 (warm-up fallback).
 * @param {string} strategy - 'SCALP' | 'REGIME'
 * @param {number} rawScore - 0~1
 * @returns { number } 0~1 정규화 점수 또는 raw score
 */
function normalizeStrategyScore(strategy, rawScore) {
  const cfg = configDefault.EDGE_LAYER || {};
  if (!cfg.enabled) return rawScore;
  const minSamples = (cfg.normalizerMinSamples != null && cfg.normalizerMinSamples > 0) ? cfg.normalizerMinSamples : 10;
  const epsilon = (cfg.normalizerStdEpsilon != null && cfg.normalizerStdEpsilon >= 0) ? cfg.normalizerStdEpsilon : 1e-6;
  const clampVal = (cfg.normalizerOutlierClamp != null && cfg.normalizerOutlierClamp > 0) ? cfg.normalizerOutlierClamp : 3;

  const arr = strategyScoreHistory[strategy];
  if (!Array.isArray(arr)) return rawScore;
  arr.push(Math.max(0, Math.min(1, Number(rawScore) || 0)));
  while (arr.length > MAX_SCORE_HISTORY) arr.shift();

  if (arr.length < minSamples) return rawScore;

  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  const mean = sum / arr.length;
  let varSum = 0;
  for (let i = 0; i < arr.length; i++) varSum += (arr[i] - mean) * (arr[i] - mean);
  const std = Math.sqrt(varSum / arr.length);
  if (std < epsilon) return rawScore;

  const normalized = (rawScore - mean) / std;
  const clamped = Math.max(-clampVal, Math.min(clampVal, normalized));
  return (clamped + clampVal) / (2 * clampVal);
}

/** 런타임 전략 모드에서 진입 임계값 반환 (매 판단 시점 최신값) */
function getThreshold() {
  return runtimeStrategyConfig.getThresholdEntry();
}

/**
 * 단일 시그널에 대한 orchestrator_score + breakdown
 * @param {Object} signal - UnifiedSignal
 * @param {Object} opts - { isScalp, isRegime, hasExistingPosition, consensusBonus }
 * @returns { { finalScore: number, components: Object, penalties: Object, bonuses: Object } }
 */
function computeOrchestratorScore(signal, opts = {}) {
  const components = { score: 0, confidence: 0, expected_edge: 0, risk_level: 0 };
  const penalties = { transaction_cost: 0, drawdown: 0, duplicate_symbol: 0 };
  const bonuses = { consensus: 0 };

  if (!signal) {
    return { finalScore: 0, components, penalties, bonuses };
  }

  const score = Math.max(0, Math.min(1, signal.score ?? 0));
  const confidence = Math.max(0, Math.min(1, signal.confidence ?? 0));
  const expected_edge = Math.max(0, Math.min(1, signal.expected_edge ?? score));
  const risk_level = Math.max(0, Math.min(1, signal.risk_level ?? 0.5));

  components.score = score;
  components.confidence = confidence;
  components.expected_edge = expected_edge;
  components.risk_level = risk_level;

  let v =
    ORCH_WEIGHTS.score * score +
    ORCH_WEIGHTS.confidence * confidence +
    ORCH_WEIGHTS.expected_edge * expected_edge +
    ORCH_WEIGHTS.risk_level * risk_level;

  if (opts.isScalp) {
    v -= SCALP_TRANSACTION_COST_PENALTY;
    penalties.transaction_cost = SCALP_TRANSACTION_COST_PENALTY;
  }
  if (opts.isRegime) {
    v -= REGIME_DRAWDOWN_PENALTY;
    penalties.drawdown = REGIME_DRAWDOWN_PENALTY;
  }
  if (opts.hasExistingPosition) {
    v -= DUPLICATE_SYMBOL_PENALTY;
    penalties.duplicate_symbol = DUPLICATE_SYMBOL_PENALTY;
  }
  if (opts.consensusBonus) {
    v += CONSENSUS_BONUS;
    bonuses.consensus = CONSENSUS_BONUS;
  }

  const finalScore = Math.max(0, Math.min(1, v));
  return { finalScore, components, penalties, bonuses };
}

/** 기존 호환: 숫자만 필요한 경우 */
function computeOrchestratorScoreValue(signal, opts = {}) {
  return computeOrchestratorScore(signal, opts).finalScore;
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
 * breakdown 보존, 탈락 시그널의 점수·사유 포함
 * @returns { { chosen, signal, finalScore, reason, consensus, rejected, breakdown } }
 */
function compareAndChoose(scalpSignal, regimeSignal, existingPositionSymbols = []) {
  const hasPos = (sym) => existingPositionSymbols.includes(sym);

  const scalpScoreNorm = scalpSignal != null
    ? normalizeStrategyScore('SCALP', Math.max(0, Math.min(1, scalpSignal.score ?? 0)))
    : 0;
  const regimeScoreNorm = regimeSignal != null
    ? normalizeStrategyScore('REGIME', Math.max(0, Math.min(1, regimeSignal.score ?? 0)))
    : 0;
  const scalpSignalNorm = scalpSignal ? { ...scalpSignal, score: scalpScoreNorm } : null;
  const regimeSignalNorm = regimeSignal ? { ...regimeSignal, score: regimeScoreNorm } : null;

  const scalpResult = scalpSignalNorm
    ? computeOrchestratorScore(scalpSignalNorm, { isScalp: true, hasExistingPosition: hasPos(scalpSignal.symbol) })
    : { finalScore: 0, components: {}, penalties: {}, bonuses: {} };
  const regimeResult = regimeSignalNorm
    ? computeOrchestratorScore(regimeSignalNorm, { isRegime: true, hasExistingPosition: hasPos(regimeSignal.symbol) })
    : { finalScore: 0, components: {}, penalties: {}, bonuses: {} };

  let scalpFinal = scalpResult.finalScore;
  let regimeFinal = regimeResult.finalScore;

  const consensus = getConsensus(scalpSignal, regimeSignal);
  if (consensus.isConsensus && consensus.symbol) {
    if (scalpSignal && scalpSignal.symbol === consensus.symbol) scalpFinal += consensus.bonus;
    if (regimeSignal && regimeSignal.symbol === consensus.symbol) regimeFinal += consensus.bonus;
  }

  const rejected = [];
  if (scalpSignal && regimeSignal && scalpSignal.symbol !== regimeSignal.symbol) {
    rejected.push({ strategy: 'SCALP', signal: scalpSignal, finalScore: scalpFinal, reason: 'not_chosen' });
    rejected.push({ strategy: 'REGIME', signal: regimeSignal, finalScore: regimeFinal, reason: 'not_chosen' });
  } else if (scalpSignal && regimeSignal && scalpSignal.symbol === regimeSignal.symbol) {
    const loser = scalpFinal >= regimeFinal ? regimeSignal : scalpSignal;
    const loserStrategy = scalpFinal >= regimeFinal ? 'REGIME' : 'SCALP';
    rejected.push({ strategy: loserStrategy, signal: loser, finalScore: scalpFinal >= regimeFinal ? regimeFinal : scalpFinal, reason: 'same_symbol_lower_score' });
  }

  if (!scalpSignal && !regimeSignal) {
    return {
      chosen: 'NONE',
      signal: null,
      finalScore: 0,
      reason: 'no signals',
      consensus: false,
      rejected: [],
      breakdown: null
    };
  }
  if (scalpSignal && !regimeSignal) {
    return {
      chosen: 'SCALP',
      signal: scalpSignal,
      finalScore: scalpFinal,
      reason: 'scalp only',
      consensus: false,
      rejected: [],
      breakdown: scalpResult
    };
  }
  if (!scalpSignal && regimeSignal) {
    return {
      chosen: 'REGIME',
      signal: regimeSignal,
      finalScore: regimeFinal,
      reason: 'regime only',
      consensus: false,
      rejected: [],
      breakdown: regimeResult
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
      consensus: true,
      rejected,
      breakdown: scalpFinal >= regimeFinal ? scalpResult : regimeResult
    };
  }

  if (scalpSignal.symbol === regimeSignal.symbol) {
    const better = scalpFinal >= regimeFinal ? scalpSignal : regimeSignal;
    const chosen = scalpFinal >= regimeFinal ? 'SCALP' : 'REGIME';
    return {
      chosen,
      signal: better,
      finalScore: Math.max(scalpFinal, regimeFinal),
      reason: 'higher score same symbol',
      consensus: false,
      rejected,
      breakdown: chosen === 'SCALP' ? scalpResult : regimeResult
    };
  }

  const pickScalp = scalpFinal >= regimeFinal;
  return {
    chosen: pickScalp ? 'SCALP' : 'REGIME',
    signal: pickScalp ? scalpSignal : regimeSignal,
    finalScore: pickScalp ? scalpFinal : regimeFinal,
    reason: pickScalp ? 'higher edge lower risk (scalp)' : 'higher edge lower risk (regime)',
    consensus: false,
    rejected,
    breakdown: pickScalp ? scalpResult : regimeResult
  };
}

module.exports = {
  computeOrchestratorScore,
  computeOrchestratorScoreValue,
  getConsensus,
  compareAndChoose,
  getThreshold,
  normalizeStrategyScore,
  ORCH_WEIGHTS,
  get THRESHOLD_ENTRY() { return getThreshold(); },
  CONSENSUS_BONUS
};
