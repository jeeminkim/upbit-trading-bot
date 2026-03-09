/**
 * 시간 기반 모드 상태 영속성 — data/system_state.json
 * - scalp_mode: { active, startTime, endTime }
 * - ai_weight: [ { ticker, endTime } ]
 * - soft_criteria: { active, endTime }
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
    soft_criteria: { active: false, endTime: null }
  };
}

/**
 * @param {Object} state - { scalp_mode, ai_weight, soft_criteria }
 */
function save(state) {
  if (!state || typeof state !== 'object') return;
  try {
    ensureDir();
    const payload = {
      scalp_mode: state.scalp_mode || defaultState().scalp_mode,
      ai_weight: Array.isArray(state.ai_weight) ? state.ai_weight : [],
      soft_criteria: state.soft_criteria || defaultState().soft_criteria
    };
    fs.writeFileSync(FILE_PATH, JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {
    console.warn('[systemStatePersistence] save:', e?.message);
  }
}

/**
 * @returns {Object} { scalp_mode, ai_weight, soft_criteria }
 */
function load() {
  try {
    if (!fs.existsSync(FILE_PATH)) return defaultState();
    const raw = fs.readFileSync(FILE_PATH, 'utf8');
    const data = JSON.parse(raw);
    return {
      scalp_mode: data.scalp_mode && typeof data.scalp_mode === 'object' ? data.scalp_mode : defaultState().scalp_mode,
      ai_weight: Array.isArray(data.ai_weight) ? data.ai_weight : [],
      soft_criteria: data.soft_criteria && typeof data.soft_criteria === 'object' ? data.soft_criteria : defaultState().soft_criteria
    };
  } catch (e) {
    console.warn('[systemStatePersistence] load:', e?.message);
    return defaultState();
  }
}

module.exports = {
  save,
  load,
  defaultState,
  FILE_PATH
};
