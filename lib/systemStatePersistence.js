/**
 * 시간 기반 모드 상태 영속성 — data/system_state.json
 * - scalp_mode: { active, startTime, endTime }
 * - ai_weight: [ { ticker, endTime } ]
 * - soft_criteria: { active, endTime }
 * - gemini_enabled: boolean (구글 결제 차단 시 false, 새벽 4시에 true로 복구)
 * 서버 재기동 시 load() 후 Date.now() < endTime 인 항목만 복구
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE_PATH = path.join(DATA_DIR, 'system_state.json');

function ensureDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.warn('[systemStatePersistence] ensureDir:', e?.message);
  }
}

function defaultState() {
  return {
    scalp_mode: { active: false, startTime: null, endTime: null },
    ai_weight: [],
    soft_criteria: { active: false, endTime: null },
    gemini_enabled: true
  };
}

/**
 * @param {Object} state - { scalp_mode, ai_weight, soft_criteria, gemini_enabled }
 */
function save(state) {
  if (!state || typeof state !== 'object') return;
  try {
    ensureDir();
    const payload = {
      scalp_mode: state.scalp_mode || defaultState().scalp_mode,
      ai_weight: Array.isArray(state.ai_weight) ? state.ai_weight : [],
      soft_criteria: state.soft_criteria || defaultState().soft_criteria,
      gemini_enabled: state.gemini_enabled !== false
    };
    fs.writeFileSync(FILE_PATH, JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {
    console.warn('[systemStatePersistence] save:', e?.message);
  }
}

/**
 * @returns {Object} { scalp_mode, ai_weight, soft_criteria, gemini_enabled }
 */
function load() {
  try {
    if (!fs.existsSync(FILE_PATH)) return defaultState();
    const raw = fs.readFileSync(FILE_PATH, 'utf8');
    const data = JSON.parse(raw);
    return {
      scalp_mode: data.scalp_mode && typeof data.scalp_mode === 'object' ? data.scalp_mode : defaultState().scalp_mode,
      ai_weight: Array.isArray(data.ai_weight) ? data.ai_weight : [],
      soft_criteria: data.soft_criteria && typeof data.soft_criteria === 'object' ? data.soft_criteria : defaultState().soft_criteria,
      gemini_enabled: data.gemini_enabled !== false
    };
  } catch (e) {
    console.warn('[systemStatePersistence] load:', e?.message);
    return defaultState();
  }
}

/**
 * 만료된 모드 정보 제거 (Date.now() > endTime) 후 최소화된 객체 반환. 파일 갱신용.
 * @param {Object} state - load() 결과
 * @returns {Object} 정제된 상태 (만료 항목 제거, active 플래그 정리)
 */
function pruneExpiredState(state) {
  if (!state || typeof state !== 'object') return defaultState();
  const now = Date.now();
  const out = { scalp_mode: defaultState().scalp_mode, ai_weight: [], soft_criteria: defaultState().soft_criteria, gemini_enabled: state.gemini_enabled !== false };

  const sm = state.scalp_mode;
  if (sm && typeof sm === 'object') {
    const endValid = sm.endTime != null && sm.endTime > now;
    out.scalp_mode = {
      active: !!(sm.active && endValid),
      startTime: endValid ? sm.startTime : null,
      endTime: endValid ? sm.endTime : null
    };
  }

  if (Array.isArray(state.ai_weight)) {
    out.ai_weight = state.ai_weight.filter((x) => x && x.endTime != null && x.endTime > now);
  }

  const sc = state.soft_criteria;
  if (sc && typeof sc === 'object') {
    const endValid = sc.endTime != null && sc.endTime > now;
    out.soft_criteria = {
      active: !!(sc.active && endValid),
      endTime: endValid ? sc.endTime : null
    };
  }

  out.gemini_enabled = state.gemini_enabled !== false;
  return out;
}

module.exports = {
  save,
  load,
  defaultState,
  pruneExpiredState,
  FILE_PATH
};
