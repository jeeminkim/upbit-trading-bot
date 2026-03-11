/**
 * RuntimeStrategyModeService — 전략 운영 모드의 단일 소스 (trading-engine / dashboard / discord 공통)
 *
 * 설계 원칙:
 * - threshold 숫자 토글이 아니라 "전략 파라미터 묶음(mode profile)"으로 관리.
 * - Discord/Dashboard는 상태를 갖지 않고, 항상 이 서비스를 통해 조회/변경.
 * - 향후 regimeStrictness, rotationEnabled, newsBlock, scalpSensitivity 등 확장 가능.
 */

/** 모드별 프로필 (1차: threshold 위주, 구조는 확장 대비) */
const MODE_PROFILES = {
  SAFE: {
    thresholdEntry: 0.62,
    minOrchestratorScore: 0.62,
    regimeStrictness: 'normal',
    rotationEnabled: true,
    newsBlock: false,
    scalpSensitivity: 'normal',
    description: '기존 보수 운영 모드',
  },
  A_CONSERVATIVE: {
    thresholdEntry: 0.45,
    minOrchestratorScore: 0.45,
    regimeStrictness: 'normal',
    rotationEnabled: true,
    newsBlock: false,
    scalpSensitivity: 'normal',
    description: '소폭 완화',
  },
  A_BALANCED: {
    thresholdEntry: 0.38,
    minOrchestratorScore: 0.38,
    regimeStrictness: 'normal',
    rotationEnabled: true,
    newsBlock: false,
    scalpSensitivity: 'normal',
    description: '거래 회복용 기본 추천 모드',
  },
  A_ACTIVE: {
    thresholdEntry: 0.35,
    minOrchestratorScore: 0.35,
    regimeStrictness: 'normal',
    rotationEnabled: true,
    newsBlock: false,
    scalpSensitivity: 'normal',
    description: '좀 더 적극적인 모드',
  },
};

const DEFAULT_MODE = 'SAFE';

let state = {
  mode: DEFAULT_MODE,
  profile: { ...MODE_PROFILES[DEFAULT_MODE] },
  updatedBy: 'system',
  updatedAt: null,
};

const changeHistory = [];
const MAX_HISTORY = 50;

function getState() {
  return {
    mode: state.mode,
    profile: { ...state.profile },
    updatedBy: state.updatedBy,
    updatedAt: state.updatedAt,
  };
}

function getMode() {
  return state.mode;
}

/** 현재 프로필 스냅샷 (Explain 로그 등에 사용) */
function getProfileSnapshot() {
  return { ...state.profile };
}

function getThresholdEntry() {
  return state.profile.thresholdEntry;
}

function getMinOrchestratorScore() {
  return state.profile.minOrchestratorScore;
}

/**
 * @param {string} mode - SAFE | A_CONSERVATIVE | A_BALANCED | A_ACTIVE
 * @param {string} updatedBy - 'discord' | 'dashboard' | 'system'
 * @returns {{ ok: boolean, previous: object, current: object, error?: string }}
 */
function setMode(mode, updatedBy = 'system') {
  const profile = MODE_PROFILES[mode];
  if (!profile) {
    return { ok: false, error: `Unknown mode: ${mode}. Use SAFE, A_CONSERVATIVE, A_BALANCED, A_ACTIVE` };
  }
  const previous = getState();
  state = {
    mode,
    profile: { ...profile },
    updatedBy: updatedBy || 'system',
    updatedAt: new Date().toISOString(),
  };
  changeHistory.unshift({ ...getState(), previousMode: previous.mode });
  if (changeHistory.length > MAX_HISTORY) changeHistory.pop();
  return { ok: true, previous, current: getState() };
}

function getChangeHistory(limit = 10) {
  return changeHistory.slice(0, limit);
}

function getPresetModes() {
  return Object.keys(MODE_PROFILES);
}

/** 모드별 프로필 메타 (설명 등) — UI 표시용 */
function getModeMeta() {
  return Object.entries(MODE_PROFILES).reduce((acc, [k, v]) => {
    acc[k] = { description: v.description, thresholdEntry: v.thresholdEntry, minOrchestratorScore: v.minOrchestratorScore };
    return acc;
  }, {});
}

module.exports = {
  MODE_PROFILES,
  DEFAULT_MODE,
  getState,
  getMode,
  getProfileSnapshot,
  getThresholdEntry,
  getMinOrchestratorScore,
  setMode,
  getChangeHistory,
  getPresetModes,
  getModeMeta,
};
