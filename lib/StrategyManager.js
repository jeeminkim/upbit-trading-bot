/**
 * StrategyManager - 일반/공격적/경주마 모드 간 프로필 전환 및 스케줄링
 * - 단일 프로필 저장소: setProfile / getProfile
 * - 경주마 시간대(08:55~09:10 KST) 자동 전환 및 복구
 * - [🔓 완화] getRelaxedModeRemainingMs() > 0 일 때만 RELAXED_OVERRIDES 병합
 * - 경주마 수동 ON 시에도 최대 유지 시간 cap 적용 (무기한 유지 금지)
 */

const { DEFAULT_PROFILE, RACE_HORSE_OVERRIDES, RELAXED_OVERRIDES } = require('../config.default');

/** 사용자 경주마 ON 시 최대 유지 시간(ms). 2시간. */
const MAX_MANUAL_RACE_HORSE_MS = 2 * 60 * 60 * 1000;

let baseProfile = { ...DEFAULT_PROFILE };
let profile = { ...baseProfile };
let raceHorseActive = false;
/** [🔓 매매 엔진 기준 완화] 적용 만료 시각(ms). 0이면 미적용 */
let relaxedUntil = 0;
/** 사용자가 버튼으로 경주마 모드 ON 한 경우 — 스케줄이 시간대 밖이어도 OFF로 덮어쓰지 않음 (단, raceHorseManualUntil 초과 시 자동 OFF) */
let userRequestedRaceHorse = false;
/** 사용자 경주마 ON 시 만료 시각(ms). 이 시각이 지나면 자동 OFF */
let raceHorseManualUntil = null;
/** 자동 만료 로그 1회만 남기기 위한 플래그 */
let raceHorseExpiryLogged = false;

/**
 * KST 08:55 ~ 09:10 경주마 스케줄 시간대 여부 (자동 ON/OFF용)
 * @returns {boolean}
 */
function isRaceHorseWindow() {
  const now = new Date();
  const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const totalMinutes = kst.getHours() * 60 + kst.getMinutes();
  const start = 8 * 60 + 55;
  const end = 9 * 60 + 10;
  return totalMinutes >= start && totalMinutes < end;
}

/**
 * KST 09:00 ~ 10:00 경주마 실시간 가동 시간대 여부 (50% 매수·상태 표시용)
 * @returns {boolean}
 */
function isRaceHorseTimeWindow() {
  const now = new Date();
  const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const totalMinutes = kst.getHours() * 60 + kst.getMinutes();
  const start = 9 * 60 + 0;
  const end = 10 * 60 + 0;
  return totalMinutes >= start && totalMinutes < end;
}

/**
 * 사용자 설정을 병합하여 기본 프로필 갱신
 * @param {Object} overrides - 덮어쓸 키-값 (일부만 넘겨도 됨)
 */
function setProfile(overrides) {
  if (!overrides || typeof overrides !== 'object') return;
  baseProfile = { ...DEFAULT_PROFILE, ...baseProfile, ...overrides };
  refreshProfile();
}

/**
 * 내부 profile 변수 갱신 (baseProfile + relaxed + raceHorse 순서)
 * 병합 순서: base -> relaxed -> raceHorse (동시 켜질 때 경주마가 우선)
 */
function refreshProfile() {
  let p = { ...baseProfile };
  if (getRelaxedModeRemainingMs() > 0) {
    p = { ...p, ...RELAXED_OVERRIDES };
  }
  if (raceHorseActive) {
    p = { ...p, ...RACE_HORSE_OVERRIDES };
  }
  profile = p;
}

/**
 * 현재 적용 중인 프로필 반환 (읽기 전용 복사)
 * 매 호출 시 relaxed/경주마 만료 반영 — 완화 만료 시 자동 기본 복귀
 * @returns {Object}
 */
function getProfile() {
  const relaxedRemaining = getRelaxedModeRemainingMs();
  let p = { ...baseProfile };
  if (relaxedRemaining > 0) {
    p = { ...p, ...RELAXED_OVERRIDES };
  }
  if (raceHorseActive) {
    p = { ...p, ...RACE_HORSE_OVERRIDES };
  }
  return { ...p };
}

/**
 * 완화 모드가 실제 프로필에 반영 중인지
 * @returns {boolean}
 */
function isRelaxedOverrideActive() {
  return getRelaxedModeRemainingMs() > 0;
}

/**
 * 경주마 모드 활성/비활성 설정 (스케줄 또는 내부 로직용). raceHorseManualUntil 은 건드리지 않음
 * @param {boolean} active
 */
function setRaceHorseActive(active) {
  userRequestedRaceHorse = !!active;
  raceHorseActive = !!active;
  if (!active) raceHorseManualUntil = null;
  refreshProfile();
}

/**
 * 사용자 버튼(디스코드 등)으로 경주마 ON/OFF. ON 시 최대 유지 시간(MAX_MANUAL_RACE_HORSE_MS) 적용
 * @param {boolean} active
 */
function setRaceHorseActiveByUser(active) {
  if (active) {
    userRequestedRaceHorse = true;
    raceHorseActive = true;
    raceHorseManualUntil = Date.now() + MAX_MANUAL_RACE_HORSE_MS;
    raceHorseExpiryLogged = false;
  } else {
    userRequestedRaceHorse = false;
    raceHorseActive = false;
    raceHorseManualUntil = null;
  }
  refreshProfile();
}

/**
 * 경주마 모드가 현재 켜져 있는지
 * @returns {boolean}
 */
function isRaceHorseActive() {
  return raceHorseActive;
}

/**
 * 스케줄에 따른 경주마 전환: 호출 시점에 시간대와 설정을 보고 자동으로 켜기/끄기
 * - 사용자 ON 이어도 raceHorseManualUntil 초과 시 자동 OFF (무기한 유지 금지)
 */
function updateRaceHorseFromSchedule() {
  const now = Date.now();
  const enabled = !!baseProfile.race_horse_scheduler_enabled;

  if (enabled && isRaceHorseWindow()) {
    setRaceHorseActive(true);
    return isRaceHorseActive();
  }

  if (userRequestedRaceHorse && raceHorseManualUntil != null && now >= raceHorseManualUntil) {
    userRequestedRaceHorse = false;
    raceHorseActive = false;
    raceHorseManualUntil = null;
    refreshProfile();
    if (!raceHorseExpiryLogged) {
      raceHorseExpiryLogged = true;
      console.warn('[StrategyManager] 경주마 모드 자동 만료 (최대 유지 시간 경과)');
    }
    return false;
  }

  if (!userRequestedRaceHorse) {
    setRaceHorseActive(false);
  }
  return isRaceHorseActive();
}

/**
 * [🔓 매매 엔진 기준 완화] 적용 — ttlMs 동안 RSI/거래량 조건 완화
 * @param {number} ttlMs - 적용 시간(ms). 0이면 해제
 */
function setRelaxedMode(ttlMs) {
  relaxedUntil = ttlMs > 0 ? Date.now() + ttlMs : 0;
}

/**
 * [🔓 기준 완화] 남은 시간(ms). 미적용 시 0
 * @returns {number}
 */
function getRelaxedModeRemainingMs() {
  if (relaxedUntil <= 0) return 0;
  const remaining = relaxedUntil - Date.now();
  if (remaining <= 0) {
    relaxedUntil = 0;
    return 0;
  }
  return remaining;
}

module.exports = {
  isRaceHorseWindow,
  isRaceHorseTimeWindow,
  setProfile,
  getProfile,
  isRelaxedOverrideActive,
  setRaceHorseActive,
  setRaceHorseActiveByUser,
  isRaceHorseActive,
  setRelaxedMode,
  getRelaxedModeRemainingMs,
  updateRaceHorseFromSchedule,
  MAX_MANUAL_RACE_HORSE_MS,
  DEFAULT_PROFILE,
  RACE_HORSE_OVERRIDES
};
