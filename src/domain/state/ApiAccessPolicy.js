/**
 * API 접근 정책 — mode 기반 주문/시세/대시보드 허용 여부 및 pause 로그 쓰로틀
 * EngineStateStore 확장 필드: mode, recoveryUntil, emergencyPauseReason, lastPauseLogAt, lastResumeLogAt
 */

const { NORMAL, EMERGENCY_PAUSE, RECOVERY } = require('./EngineMode');

const RECOVERY_DURATION_MS = 30 * 1000;
const PAUSE_LOG_MIN_INTERVAL_MS = 60 * 1000;

/**
 * 현재 state에서 모드 계산 (emergencyPauseUntil, recoveryUntil 기반)
 * @param {Object} state
 * @returns {string} NORMAL | EMERGENCY_PAUSE | RECOVERY
 */
function getMode(state) {
  if (!state) return NORMAL;
  const now = Date.now();
  if (state.emergencyPauseUntil != null && now < state.emergencyPauseUntil) return EMERGENCY_PAUSE;
  if (state.recoveryUntil != null && now < state.recoveryUntil) return RECOVERY;
  return NORMAL;
}

/**
 * pause 종료 시 RECOVERY 전이, recovery 종료 시 NORMAL 전이 적용 및 로그
 * @param {Object} stateStore - { get, update }
 * @returns {string} 현재 모드
 */
function refreshEngineMode(stateStore) {
  if (!stateStore || typeof stateStore.get !== 'function') return NORMAL;
  const state = stateStore.get();
  const now = Date.now();
  let nextMode = getMode(state);
  let updated = false;
  const updates = {};

  if (state.emergencyPauseUntil != null && now >= state.emergencyPauseUntil) {
    updates.emergencyPauseUntil = null;
    updates.mode = RECOVERY;
    updates.recoveryUntil = now + RECOVERY_DURATION_MS;
    updates.lastRecoveryFetchAt = now;
    updates.lastResumeLogAt = now;
    updated = true;
    if (shouldLogPauseState(now, state.lastResumeLogAt, PAUSE_LOG_MIN_INTERVAL_MS)) {
      console.warn('[EngineMode] PAUSE 종료 → RECOVERY (30초 저빈도)', { recoveryUntil: updates.recoveryUntil });
    }
  }

  if (state.recoveryUntil != null && now >= state.recoveryUntil) {
    updates.recoveryUntil = null;
    updates.mode = NORMAL;
    updated = true;
    if (shouldLogPauseState(now, state.lastResumeLogAt, PAUSE_LOG_MIN_INTERVAL_MS)) {
      console.warn('[EngineMode] RECOVERY 종료 → NORMAL');
    }
  }

  if (updated) {
    Object.assign(updates, { mode: updates.mode ?? nextMode });
    stateStore.update(updates);
    return updates.mode;
  }

  stateStore.update({ mode: nextMode });
  return nextMode;
}

/**
 * pause 중 로그 flood 방지: 진입/종료 시 1회, 남은 시간 갱신이 클 때만
 * @param {number} now
 * @param {number|null} lastLogAt
 * @param {number} minIntervalMs
 * @returns {boolean}
 */
function shouldLogPauseState(now, lastLogAt, minIntervalMs) {
  if (lastLogAt == null) return true;
  return now - lastLogAt >= (minIntervalMs || PAUSE_LOG_MIN_INTERVAL_MS);
}

/**
 * 주문 제출 허용 여부 (PAUSE/RECOVERY에서는 금지)
 */
function canPlaceOrder(state) {
  return getMode(state) === NORMAL;
}

/**
 * 시세/계정 조회 허용 여부
 * @param {Object} state
 * @param {string} purpose - 'trading' | 'dashboard' | 'healthcheck' | 'exit'
 */
function canFetchMarketData(state, purpose) {
  const mode = getMode(state);
  if (mode === NORMAL) return true;
  if (mode === EMERGENCY_PAUSE) {
    return purpose === 'dashboard' || purpose === 'healthcheck';
  }
  if (mode === RECOVERY) {
    return purpose === 'exit' || purpose === 'dashboard' || purpose === 'healthcheck';
  }
  return false;
}

/**
 * 대시보드/상태 표시용 조회 허용 (PAUSE에서도 선택적 허용)
 */
function canFetchDashboardData(state) {
  const mode = getMode(state);
  return mode === NORMAL || mode === RECOVERY || mode === EMERGENCY_PAUSE;
}

module.exports = {
  getMode,
  refreshEngineMode,
  shouldLogPauseState,
  canPlaceOrder,
  canFetchMarketData,
  canFetchDashboardData,
  RECOVERY_DURATION_MS,
  PAUSE_LOG_MIN_INTERVAL_MS
};
