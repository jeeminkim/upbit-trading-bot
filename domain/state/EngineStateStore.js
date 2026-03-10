/**
 * 엔진 런타임 상태 싱글톤 — server.js 전역 state 대체
 * - get() / update() 로만 접근하여 일관성 보장
 * - systemStatePersistence와 연동: 부팅 시 복구, 변경 시 자동 저장(콜백으로 payload 생성)
 */

const systemStatePersistence = require('../../lib/systemStatePersistence');

let state = null;
let persistCallback = null;

function get() {
  if (state == null) throw new Error('EngineStateStore not initialized');
  return state;
}

/**
 * @param {Object} partial - 병합할 부분 상태 (shallow merge)
 * @returns {Object} 현재 전체 state 참조
 */
function update(partial) {
  if (state == null) throw new Error('EngineStateStore not initialized');
  if (partial && typeof partial === 'object') {
    Object.assign(state, partial);
    if (typeof persistCallback === 'function') {
      try {
        const payload = persistCallback();
        if (payload) systemStatePersistence.save(payload);
      } catch (e) {
        console.warn('[EngineStateStore] persist on update:', e?.message);
      }
    }
  }
  return state;
}

/**
 * 초기 상태로 설정. 서버 부팅 시 1회 호출.
 * @param {Object} initialState
 */
function init(initialState) {
  if (state != null) return state;
  state = Object.assign({}, initialState);
  return state;
}

/**
 * system_state.json 복구용 — load() 결과를 반환. 적용(restore)은 server에서 수행.
 * @returns {Object} systemStatePersistence.load()
 */
function loadPersisted() {
  return systemStatePersistence.load();
}

/**
 * 상태 변경 시 자동 저장에 쓸 payload 생성 함수 등록 (getCurrentSystemState 등)
 * @param {function(): Object} fn - persist 시 호출되어 { scalp_mode, ai_weight, soft_criteria } 반환
 */
function setPersistCallback(fn) {
  persistCallback = typeof fn === 'function' ? fn : null;
}

/**
 * 수동 persist 트리거 (주기 타이머에서 호출)
 * @param {function(): Object} [buildPayload] - 미전달 시 등록된 persistCallback 사용
 */
function savePersisted(buildPayload) {
  try {
    const payload = typeof buildPayload === 'function' ? buildPayload() : (persistCallback ? persistCallback() : null);
    if (payload) systemStatePersistence.save(payload);
  } catch (e) {
    console.warn('[EngineStateStore] savePersisted:', e?.message);
  }
}

module.exports = {
  get,
  update,
  init,
  loadPersisted,
  setPersistCallback,
  savePersisted
};
