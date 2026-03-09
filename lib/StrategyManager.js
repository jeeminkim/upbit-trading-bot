/**
 * StrategyManager - 일반/공격적/경주마 모드 간 프로필 전환 및 스케줄링
 * - 단일 프로필 저장소: setProfile / getProfile
 * - 경주마 시간대(08:55~09:10 KST) 자동 전환 및 복구
 * - 학습: 모듈 내부 상태(baseProfile, profile, raceHorseActive)로 전략 일원화
 */

const { DEFAULT_PROFILE, RACE_HORSE_OVERRIDES, RELAXED_OVERRIDES } = require('../config.default');

let baseProfile = { ...DEFAULT_PROFILE };
let profile = { ...baseProfile };
let raceHorseActive = false;
/** [🔓 매매 엔진 기준 완화] 적용 만료 시각(ms). 0이면 미적용 */
let relaxedUntil = 0;
/** 사용자가 버튼으로 경주마 모드 ON 한 경우 — 스케줄이 시간대 밖이어도 OFF로 덮어쓰지 않음 */
let userRequestedRaceHorse = false;

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
 * 사용자 설정을 병합하여 기본 프로필 갱신 후, 경주마 활성 시 오버레이 적용
 * @param {Object} overrides - 덮어쓸 키-값 (일부만 넘겨도 됨)
 */
function setProfile(overrides) {
  if (!overrides || typeof overrides !== 'object') return;
  baseProfile = { ...DEFAULT_PROFILE, ...baseProfile, ...overrides };
  profile = { ...baseProfile, ...(raceHorseActive ? RACE_HORSE_OVERRIDES : {}) };
}

/**
 * 현재 적용 중인 프로필 반환 (읽기 전용 복사)
 * @returns {Object}
 */
function getProfile() {
  return { ...profile };
}

/**
 * 경주마 모드 활성/비활성 설정. 활성 시 RACE_HORSE_OVERRIDES 가 profile 에 병합됨
 * 사용자 버튼 ON 시 userRequestedRaceHorse 로 기억해 스케줄이 시간대 밖에서 OFF 덮어쓰기 방지
 * @param {boolean} active
 */
function setRaceHorseActive(active) {
  userRequestedRaceHorse = !!active;
  raceHorseActive = !!active;
  profile = { ...baseProfile, ...(raceHorseActive ? RACE_HORSE_OVERRIDES : {}) };
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
 * - 사용자가 버튼으로 ON 한 경우(userRequestedRaceHorse) 시간대 밖이어도 OFF로 덮어쓰지 않음 → 대기중 유지
 */
function updateRaceHorseFromSchedule() {
  const enabled = !!baseProfile.race_horse_scheduler_enabled;
  if (enabled && isRaceHorseWindow()) {
    setRaceHorseActive(true);
  } else if (!userRequestedRaceHorse) {
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
  setRaceHorseActive,
  isRaceHorseActive,
  setRelaxedMode,
  getRelaxedModeRemainingMs,
  updateRaceHorseFromSchedule,
  DEFAULT_PROFILE,
  RACE_HORSE_OVERRIDES
};
