/**
 * 경주마 모드 정책: 조건 기반 공격 모드 + BTC/ETH/SOL/XRP 내부 rotation
 * - 무조건 50% 금지. 신호 품질에 따라 FULL_50 / MEDIUM_25 / LIGHT_10 / NORMAL / BLOCKED
 * - 회전은 4개 코인 내부에서만, 명확한 우위·기대값·비용 반영 시에만 허용
 * - cash lock / risk gate / emergency pause 등 기존 정책 비침습
 */

/** 경주마 모드에서 진입·회전 허용 코인 */
const RACE_HORSE_ALLOWED_SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP'];

/** 티어별 최소 orchestrator score */
const THRESHOLD_FULL_50_SCORE = 0.78;
const THRESHOLD_MEDIUM_25_SCORE = 0.70;
const THRESHOLD_LIGHT_10_SCORE = 0.65;
const THRESHOLD_NORMAL_SCORE = 0.62;

/** 회전·기대값 상수 (실전형) */
const MIN_ROTATION_EDGE_GAP = 0.12;
const MIN_EXPECTED_EDGE_BP = 15;
const MAX_ROTATIONS_PER_SESSION = 3;
const MIN_HOLD_SEC_BEFORE_ROTATE = 300;
const FEE_RATE_BP = 10;
const SLIPPAGE_SAFETY_BP = 5;
const ROTATION_COST_BP = FEE_RATE_BP + SLIPPAGE_SAFETY_BP;

/** 세션 내 회전 횟수 (창 종료 시 리셋은 server에서 처리 권장) */
let sessionRotationCount = 0;

function getSessionRotationCount() {
  return sessionRotationCount;
}
function incrementSessionRotationCount() {
  sessionRotationCount += 1;
}
function resetSessionRotationCount() {
  sessionRotationCount = 0;
}

/**
 * 티어에 따른 자본 비율 (총자산 대비). null이면 기본 엔진 금액 사용, 0이면 매수 금지.
 * @param {string} tier - 'FULL_50'|'MEDIUM_25'|'LIGHT_10'|'NORMAL'|'BLOCKED'
 * @returns {number|null|0} 0.5 | 0.25 | 0.1 | null (base) | 0 (block)
 */
function getRaceHorseCapitalFraction(tier) {
  switch (tier) {
    case 'FULL_50': return 0.5;
    case 'MEDIUM_25': return 0.25;
    case 'LIGHT_10': return 0.1;
    case 'NORMAL': return null;
    case 'BLOCKED': return 0;
    default: return null;
  }
}

function isSymbolAllowedForRaceHorse(symbol) {
  const s = (symbol || '').toUpperCase().replace(/^KRW-/, '');
  return RACE_HORSE_ALLOWED_SYMBOLS.includes(s);
}

/**
 * 경주마 신호 품질 → 사이징 티어
 * - FULL_50: volume surge + strength + breakout + orch score 높음 + expected edge + P0 정상
 * - MEDIUM_25: 조건 양호, 확신 중간
 * - LIGHT_10: 후보 맞지만 추격 위험
 * - NORMAL: 기본 금액만
 * - BLOCKED: 매수 금지
 */
function evaluateRaceHorseConviction(signal, finalScore, scalpStateEntry) {
  const reasons = signal?.reasons || [];
  const hasVolSurge = reasons.includes('vol_surge');
  const hasStrength = reasons.includes('strength_ok');
  const hasBreakout = reasons.includes('price_break');
  const p0Allowed = scalpStateEntry?.p0GateStatus == null;
  const scoreOk = typeof finalScore === 'number' && !Number.isNaN(finalScore);
  const expectedEdge = Math.max(0, (signal?.expected_edge ?? 0) * 100) || (signal?.score ?? 0) * 100;

  const strongCount = [hasVolSurge, hasStrength, hasBreakout, p0Allowed].filter(Boolean).length;
  const orchFull = scoreOk && finalScore >= THRESHOLD_FULL_50_SCORE;
  const orchMedium = scoreOk && finalScore >= THRESHOLD_MEDIUM_25_SCORE;
  const orchLight = scoreOk && finalScore >= THRESHOLD_LIGHT_10_SCORE;
  const orchNormal = scoreOk && finalScore >= THRESHOLD_NORMAL_SCORE;
  const edgeOk = expectedEdge >= MIN_EXPECTED_EDGE_BP || (signal?.score ?? 0) >= 0.6;

  if (strongCount >= 3 && orchFull && p0Allowed && edgeOk) return 'FULL_50';
  if (strongCount >= 2 && orchMedium && edgeOk) return 'MEDIUM_25';
  if ((strongCount >= 1 || orchLight) && orchNormal) return 'LIGHT_10';
  if (orchNormal) return 'NORMAL';
  return 'BLOCKED';
}

/** @deprecated alias */
function isRaceHorseHighConviction(signal, finalScore, scalpStateEntry) {
  return evaluateRaceHorseConviction(signal, finalScore, scalpStateEntry);
}

/**
 * ctx = { signal, finalScore, scalpStateEntry } → getRaceHorseSizingTier
 */
function getRaceHorseSizingTier(ctx) {
  if (!ctx) return 'BLOCKED';
  return evaluateRaceHorseConviction(ctx.signal, ctx.finalScore, ctx.scalpStateEntry);
}

/**
 * 단일 자산(코인)에 대한 경주마 상대강도 점수 (0~1)
 * momentum, volume surge, breakout, orderbook strength, orchestrator score, expected edge, spread penalty 반영
 */
function computeRaceHorseAssetScore(assetContext) {
  if (!assetContext || !assetContext.symbol) return 0;
  const entry = assetContext.scalpStateEntry || {};
  const signal = assetContext.signal || {};
  const entryScore = entry.entryScore != null ? entry.entryScore : 0;
  const entryMin = assetContext.entryScoreMin ?? 4;
  if (entry.p0GateStatus != null || entryScore < entryMin) return 0;

  const reasons = signal.reasons || [];
  const volSurge = reasons.includes('vol_surge') ? 1 : 0;
  const strength = reasons.includes('strength_ok') ? 1 : 0;
  const breakout = reasons.includes('price_break') ? 1 : 0;
  const orchScore = Math.max(0, Math.min(1, assetContext.finalScore ?? 0));
  const rawScore = (entryScore - entryMin) / Math.max(1, 10 - entryMin);
  const edge = Math.max(0, (signal.expected_edge ?? signal.score ?? 0));

  let score = 0.2 * Math.min(1, rawScore) + 0.2 * (volSurge + strength + breakout) / 3 + 0.25 * orchScore + 0.2 * edge;
  if (entry.spread_ratio != null && entry.spread_ratio > 0.001) score -= 0.1;
  return Math.max(0, Math.min(1, score));
}

/**
 * 4개 코인에 대해 상대강도 순으로 정렬
 * @param {Object} scalpState - state.scalpState
 * @param {Object} signalsBySymbol - symbol -> { signal, finalScore } (선택)
 * @param {number} entryScoreMin
 * @returns {Array<{ symbol: string, score: number }>}
 */
function rankRaceHorseUniverse(scalpState, signalsBySymbol, entryScoreMin) {
  const out = [];
  const markets = ['KRW-BTC', 'KRW-ETH', 'KRW-SOL', 'KRW-XRP'];
  for (const market of markets) {
    const symbol = market.replace(/^KRW-/, '');
    const entry = scalpState && scalpState[market];
    const sig = (signalsBySymbol && signalsBySymbol[symbol]) || {};
    const score = computeRaceHorseAssetScore({
      symbol,
      scalpStateEntry: entry,
      signal: sig.signal || null,
      finalScore: sig.finalScore,
      entryScoreMin
    });
    out.push({ symbol, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * 현재 보유 → 후보로 회전 허용 여부 및 방식
 * - 후보 점수가 현재보다 충분히 높고, 보유 신호 decay 또는 후보 high conviction, 회전 비용 상쇄 여부
 */
function shouldRotateHolding(currentHoldingSymbol, candidateSymbol, ctx) {
  if (!currentHoldingSymbol || !candidateSymbol || currentHoldingSymbol === candidateSymbol) {
    return { allowed: true, action: 'ADD_TO_WINNER', reason: 'same_or_add' };
  }
  if (!isSymbolAllowedForRaceHorse(currentHoldingSymbol) || !isSymbolAllowedForRaceHorse(candidateSymbol)) {
    return { allowed: false, action: 'HOLD', reason: 'symbol_not_allowed' };
  }

  const ranked = ctx.rankedUniverse || [];
  const currentScore = ranked.find((r) => r.symbol === currentHoldingSymbol)?.score ?? 0;
  const candidateScore = ranked.find((r) => r.symbol === candidateSymbol)?.score ?? 0;
  const scoreGap = candidateScore - currentScore;

  if (sessionRotationCount >= MAX_ROTATIONS_PER_SESSION) {
    return { allowed: false, action: 'HOLD', reason: 'max_rotations_per_session' };
  }
  const holdSec = ctx.holdSecondsBySymbol && ctx.holdSecondsBySymbol[currentHoldingSymbol];
  if (holdSec != null && holdSec < MIN_HOLD_SEC_BEFORE_ROTATE) {
    return { allowed: false, action: 'HOLD', reason: 'min_hold_not_met' };
  }

  const edgeBp = (ctx.candidateExpectedEdgeBp != null ? ctx.candidateExpectedEdgeBp : scoreGap * 100) || 0;
  if (edgeBp < ROTATION_COST_BP) {
    return { allowed: false, action: 'HOLD', reason: 'edge_below_rotation_cost' };
  }
  if (scoreGap < MIN_ROTATION_EDGE_GAP) {
    return { allowed: false, action: 'HOLD', reason: 'rotation_edge_gap_small' };
  }

  const currentDecay = ctx.currentSignalDecay === true;
  if (scoreGap >= 0.25) return { allowed: true, action: 'FULL_SWITCH', reason: 'clear_superiority' };
  if (scoreGap >= MIN_ROTATION_EDGE_GAP && (currentDecay || candidateScore >= 0.6)) {
    return { allowed: true, action: 'PARTIAL_SWITCH', reason: 'moderate_superiority' };
  }
  return { allowed: false, action: 'HOLD', reason: 'insufficient_advantage' };
}

/**
 * 현재 보유 중인 허용 코인과 랭킹을 보고, 최적 회전 후보 및 액션 결정
 */
function selectBestRotationCandidate(currentHoldings, rankedUniverse, ctx) {
  const holdingAllowed = (currentHoldings || []).filter((s) => isSymbolAllowedForRaceHorse(s));
  if (rankedUniverse.length === 0) return { action: 'HOLD', toSymbol: null, fromSymbol: null, scoreGap: 0 };

  const best = rankedUniverse[0];
  if (holdingAllowed.length === 0) {
    return { action: 'ADD_TO_WINNER', toSymbol: best.symbol, fromSymbol: null, scoreGap: best.score };
  }
  const bestHolding = holdingAllowed[0];
  const bestHoldingScore = rankedUniverse.find((r) => r.symbol === bestHolding)?.score ?? 0;
  const gap = best.score - bestHoldingScore;
  if (best.symbol === bestHolding) {
    return { action: 'ADD_TO_WINNER', toSymbol: best.symbol, fromSymbol: null, scoreGap: gap };
  }
  const rot = shouldRotateHolding(bestHolding, best.symbol, {
    ...ctx,
    rankedUniverse
  });
  if (rot.allowed) {
    return {
      action: rot.action,
      toSymbol: best.symbol,
      fromSymbol: bestHolding,
      scoreGap: gap,
      reason: rot.reason
    };
  }
  return { action: 'HOLD', toSymbol: bestHolding, fromSymbol: null, scoreGap: 0, reason: rot.reason };
}

/**
 * evaluateRaceHorseContext: 한 번에 티어 + 회전 권고
 * @param {Object} ctx - { signal, finalScore, scalpStateEntry, scalpState, accounts, rankedUniverse?, holdSecondsBySymbol?, candidateExpectedEdgeBp? }
 * @returns {{ tier: string, capitalFraction: number|null|0, rotation: { action, toSymbol, fromSymbol } }}
 */
function evaluateRaceHorseContext(ctx) {
  const tier = getRaceHorseSizingTier(ctx);
  const capitalFraction = getRaceHorseCapitalFraction(tier);
  const positionSymbols = (ctx.accounts || [])
    .filter((a) => (a.currency || '').toUpperCase() !== 'KRW' && parseFloat(a.balance || 0) > 0)
    .map((a) => (a.currency || '').toUpperCase());
  const ranked = ctx.rankedUniverse || rankRaceHorseUniverse(ctx.scalpState, ctx.signalsBySymbol, ctx.profile?.entry_score_min);
  const rotation = selectBestRotationCandidate(positionSymbols, ranked, ctx);
  return { tier, capitalFraction, rotation };
}

function getRaceHorseContext(positionSymbols, scalpState, profile) {
  const allowed = [...RACE_HORSE_ALLOWED_SYMBOLS];
  const holdingAllowed = (positionSymbols || []).filter((s) => isSymbolAllowedForRaceHorse(s));
  const entryScoreMin = profile?.entry_score_min ?? 4;
  let candidateSymbol = null;
  let bestScore = -1;
  const markets = ['KRW-BTC', 'KRW-ETH', 'KRW-SOL', 'KRW-XRP'];
  for (const market of markets) {
    const entry = scalpState && scalpState[market];
    if (!entry || entry.entryScore == null || entry.entryScore < entryScoreMin || entry.p0GateStatus != null) continue;
    if (entry.entryScore > bestScore) {
      bestScore = entry.entryScore;
      candidateSymbol = market.replace(/^KRW-/, '');
    }
  }
  return { allowedSymbols: allowed, holdingAllowed, candidateSymbol };
}

module.exports = {
  RACE_HORSE_ALLOWED_SYMBOLS,
  THRESHOLD_FULL_50_SCORE,
  THRESHOLD_MEDIUM_25_SCORE,
  THRESHOLD_LIGHT_10_SCORE,
  MIN_ROTATION_EDGE_GAP,
  MIN_EXPECTED_EDGE_BP,
  MAX_ROTATIONS_PER_SESSION,
  MIN_HOLD_SEC_BEFORE_ROTATE,
  ROTATION_COST_BP,
  getSessionRotationCount,
  incrementSessionRotationCount,
  resetSessionRotationCount,
  isSymbolAllowedForRaceHorse,
  getRaceHorseCapitalFraction,
  evaluateRaceHorseConviction,
  getRaceHorseSizingTier,
  isRaceHorseHighConviction,
  computeRaceHorseAssetScore,
  rankRaceHorseUniverse,
  shouldRotateHolding,
  selectBestRotationCandidate,
  evaluateRaceHorseContext,
  getRaceHorseContext
};
