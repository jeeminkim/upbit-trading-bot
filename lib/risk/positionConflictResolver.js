/**
 * 포지션 충돌 해결: 전략 간 덮어쓰기 방지, 우선권 + 포지션 성격 고려
 * - SCALP 진입 후 REGIME 강해져도 즉시 갈아타지 않음 (upgrade 후보로만)
 * - REGIME 진입 후 SCALP 단기 청산 신호는 partial exit / warning 후보로만
 */

/** 포지션 소유 전략 추적: symbol -> 'SCALP' | 'REGIME' */
const positionOwner = {};

function setPositionOwner(symbol, strategy) {
  if (symbol) positionOwner[symbol] = strategy;
}

function getPositionOwner(symbol) {
  return positionOwner[symbol] || null;
}

function clearPositionOwner(symbol) {
  if (symbol) delete positionOwner[symbol];
}

/**
 * 새 진입이 기존 포지션과 충돌하는지
 * @param {string} symbol
 * @param {string} incomingStrategy - SCALP | REGIME
 * @param {string[]} currentPositionSymbols - 현재 보유 심볼 목록
 */
function wouldConflict(symbol, incomingStrategy, currentPositionSymbols) {
  if (!currentPositionSymbols || !currentPositionSymbols.includes(symbol)) return false;
  const owner = getPositionOwner(symbol);
  if (!owner) return false;
  if (owner === incomingStrategy) return false;
  return true;
}

/**
 * 진입 허용 여부: 다른 전략이 소유한 포지션에 같은 심볼로 진입하려 하면 차단
 */
function allowEntry(symbol, strategy, currentPositionSymbols) {
  if (wouldConflict(symbol, strategy, currentPositionSymbols)) {
    return { allowed: false, reason: 'position_owned_by_other_strategy' };
  }
  return { allowed: true };
}

/**
 * 청산 제안 시: REGIME 포지션에 SCALP가 exit 제안해도 무조건 exit 하지 않고 warning 후보
 */
function exitSuggestion(symbol, exitRequestingStrategy) {
  const owner = getPositionOwner(symbol);
  if (!owner) return { canExit: true, downgrade: false };
  if (owner === exitRequestingStrategy) return { canExit: true, downgrade: false };
  if (owner === 'REGIME' && exitRequestingStrategy === 'SCALP') {
    return { canExit: false, downgrade: true, reason: 'regime_position_scalp_exit_suggestion' };
  }
  if (owner === 'SCALP' && exitRequestingStrategy === 'REGIME') {
    return { canExit: false, downgrade: true, reason: 'scalp_position_regime_exit_suggestion' };
  }
  return { canExit: true, downgrade: false };
}

module.exports = {
  setPositionOwner,
  getPositionOwner,
  clearPositionOwner,
  wouldConflict,
  allowEntry,
  exitSuggestion
};
