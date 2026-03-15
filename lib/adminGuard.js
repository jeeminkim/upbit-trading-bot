/**
 * 관리자 인증 공통 모듈 — .env ADMIN_ID 체크 로직 일원화
 * server.js, discordBot.js 등에서 동일한 규칙으로 사용
 */

/**
 * 환경/설정에서 읽은 관리자 ID 문자열 정규화 (앞뒤 따옴표·공백 제거)
 * @param {string|undefined|null} v
 * @returns {string}
 */
function normalizeAdminId(v) {
  if (v == null) return '';
  const s = String(v).replace(/^["'\s]+|["'\s]+$/g, '').trim();
  return s;
}

/**
 * 실제 사용할 관리자 ID 결정 (env/config → 백업 ID 순)
 * @param {string} envAdminId - .env 또는 config에서 읽은 값 (정규화된 문자열)
 * @param {string} backupAdminId - 백업 하드코딩 ID (공개 저장소에서는 빈 문자열 권장)
 * @returns {string|null}
 */
function getEffectiveAdminId(envAdminId, backupAdminId) {
  const a = normalizeAdminId(envAdminId);
  const b = normalizeAdminId(backupAdminId);
  const id = a || b || null;
  return id || null;
}

/**
 * 해당 사용자 ID가 관리자 인증을 통과하는지 여부
 * @param {string} userId - 디스코드 interaction.user.id
 * @param {string|null} effectiveAdminId - getEffectiveAdminId() 결과
 * @returns {boolean}
 */
function isAdminUser(userId, effectiveAdminId) {
  if (!effectiveAdminId || !userId) return false;
  return String(userId) === String(effectiveAdminId);
}

module.exports = {
  normalizeAdminId,
  getEffectiveAdminId,
  isAdminUser
};
