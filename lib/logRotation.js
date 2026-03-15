/**
 * 로그 로테이션 및 오래된 로그 정리
 * - rotateIfNeeded: 파일이 maxSizeBytes 초과 시 백업 유지(최대 maxBackups개)
 * - truncateLinesOlderThanDays: 파일에서 N일 초과 라인 제거 (서버 재기동 시 호출)
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_BACKUPS = 5;

/**
 * 로그 라인에서 ISO 날짜 추출. [2025-03-10T12:00:00.000Z] 형태 또는 줄 앞쪽 ISO 문자열
 * @param {string} line
 * @returns {number|null} timestamp ms or null
 */
function parseLineTimestamp(line) {
  if (!line || typeof line !== 'string') return null;
  const m = line.match(/\[?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\]?/);
  if (m) {
    const t = Date.parse(m[1]);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * 파일 크기가 maxSizeBytes 초과 시 로테이션: current -> .1, .1 -> .2, ... maxBackups 개만 유지
 * @param {string} filePath - 절대 경로
 * @param {number} [maxSizeBytes]
 * @param {number} [maxBackups]
 * @returns {boolean} rotated 여부
 */
function rotateIfNeeded(filePath, maxSizeBytes = DEFAULT_MAX_SIZE_BYTES, maxBackups = DEFAULT_MAX_BACKUPS) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (stat.size < maxSizeBytes) return false;

    // 가장 오래된 백업 삭제 후 .4->.5, .3->.4, .2->.3, .1->.2, current->.1
    const oldest = `${filePath}.${maxBackups}`;
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    for (let i = maxBackups - 1; i >= 1; i--) {
      const src = `${filePath}.${i}`;
      const dest = `${filePath}.${i + 1}`;
      if (fs.existsSync(src)) fs.renameSync(src, dest);
    }
    if (fs.existsSync(filePath)) fs.renameSync(filePath, `${filePath}.1`);
    fs.writeFileSync(filePath, '', 'utf8');
    return true;
  } catch (e) {
    if (typeof console !== 'undefined') console.warn('[logRotation] rotateIfNeeded:', e?.message);
    return false;
  }
}

/**
 * 로그 파일에서 N일이 지난 라인 제거 후 파일 덮어쓰기 (서버 재기동 시 호출)
 * @param {string} filePath
 * @param {number} days - 이 일수 이내 라인만 유지
 * @returns {number} 제거된 라인 수
 */
function truncateLinesOlderThanDays(filePath, days) {
  try {
    if (!fs.existsSync(filePath)) return 0;
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const kept = [];
    let removed = 0;
    for (const line of lines) {
      const ts = parseLineTimestamp(line);
      if (ts != null && ts < cutoff) {
        removed++;
        continue;
      }
      kept.push(line);
    }
    if (removed > 0) {
      fs.writeFileSync(filePath, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
    }
    return removed;
  } catch (e) {
    if (typeof console !== 'undefined') console.warn('[logRotation] truncateLinesOlderThanDays:', e?.message);
    return 0;
  }
}

/**
 * 디렉터리 내 .log 파일에 대해 로테이션 + N일 초과 라인 삭제 (부팅 시 한 번 호출 권장)
 * @param {string} logDir - logs 디렉터리 경로
 * @param {number} days - 이 일수 이내만 유지 (기본 7)
 * @param {number} maxSizeBytes
 * @param {number} maxBackups
 */
function rotateAndTruncateLogDir(logDir, days = 7, maxSizeBytes = DEFAULT_MAX_SIZE_BYTES, maxBackups = DEFAULT_MAX_BACKUPS) {
  let totalRemoved = 0;
  try {
    if (!fs.existsSync(logDir) || !fs.statSync(logDir).isDirectory()) return totalRemoved;
    const files = fs.readdirSync(logDir);
    const logFiles = files.filter((f) => f.endsWith('.log') && !f.includes('%'));
    for (const f of logFiles) {
      const full = path.join(logDir, f);
      try {
        rotateIfNeeded(full, maxSizeBytes, maxBackups);
        const removed = truncateLinesOlderThanDays(full, days);
        totalRemoved += removed;
      } catch (_) {}
    }
  } catch (e) {
    if (typeof console !== 'undefined') console.warn('[logRotation] rotateAndTruncateLogDir:', e?.message);
  }
  return totalRemoved;
}

module.exports = {
  rotateIfNeeded,
  truncateLinesOlderThanDays,
  rotateAndTruncateLogDir,
  parseLineTimestamp,
  DEFAULT_MAX_SIZE_BYTES,
  DEFAULT_MAX_BACKUPS
};
