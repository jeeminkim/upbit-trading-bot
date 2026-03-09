/**
 * SharedCache - 전역 API 캐시 (Single Source of Truth)
 * - 중복 API 호출 방지, 쿼터 절약
 * - TTL(유효 시간) 기반 만료
 * - 학습: 키-값 저장소 + 타임스탬프로 만료 판단
 */

/** @typedef {{ value: any, expiresAt: number }} CacheEntry */

const cache = new Map();

/**
 * 캐시에 값 저장
 * @param {string} key - 캐시 키
 * @param {*} value - 저장할 값 (객체·배열·원시값)
 * @param {number} [ttlMs] - 유효 시간(ms). 없으면 만료 없음
 */
function set(key, value, ttlMs) {
  const entry = {
    value,
    expiresAt: ttlMs != null && ttlMs > 0 ? Date.now() + ttlMs : Number.MAX_SAFE_INTEGER
  };
  cache.set(key, entry);
}

/**
 * 캐시에서 값 조회 (만료된 항목은 삭제 후 undefined 반환)
 * @param {string} key
 * @returns {*|undefined}
 */
function get(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

/**
 * 키가 존재하고 만료되지 않았는지 여부
 * @param {string} key
 * @returns {boolean}
 */
function has(key) {
  const entry = cache.get(key);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return false;
  }
  return true;
}

/**
 * 특정 키 삭제
 * @param {string} key
 */
function remove(key) {
  cache.delete(key);
}

/**
 * 캐시 전체 비우기 (테스트·리셋용)
 */
function clear() {
  cache.clear();
}

/**
 * 만료된 항목만 제거 (메모리 정리)
 */
function pruneExpired() {
  const now = Date.now();
  for (const [k, entry] of cache.entries()) {
    if (now > entry.expiresAt) cache.delete(k);
  }
}

module.exports = {
  set,
  get,
  has,
  remove,
  clear,
  pruneExpired
};
