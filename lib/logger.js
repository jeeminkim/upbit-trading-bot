/**
 * Logger - 매매 로그 + 거절 로그 4시간 단위 자동 삭제 통합
 * - log / logTag: 파일(logs/trade.log) + 실시간 소켓 전송용 버퍼
 * - 로그 로테이션: 파일당 최대 10MB, 백업 5개 유지
 * - scheduleRejectLogCleanup: 4시간 주기로 reject_logs 오래된 행 삭제
 * - truncateLogsOlderThanDays: 서버 재기동 시 7일 초과 로그 라인 삭제 (trade.log 등)
 */

const path = require('path');
const fs = require('fs');
const logRotation = require('./logRotation');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'trade.log');
const MAX_RECENT_LINES = 200;
const MAX_LOG_SIZE_BYTES = logRotation.DEFAULT_MAX_SIZE_BYTES; // 10MB
const MAX_LOG_BACKUPS = 5;
const TRUNCATE_DAYS_ON_BOOT = 7;

let recentLines = [];
let rejectLogCleanupTimer = null;

/** 로그 디렉터리 존재 보장 */
function ensureLogDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (err) {
    console.error('Failed to create log dir:', err.message);
  }
}

/** ISO 시간 문자열 (로그 타임스탬프용) */
function formatTime() {
  return new Date().toISOString();
}

/** 한 줄을 파일 끝에 추가 (동기). 10MB 초과 시 로테이션 후 추가 */
function appendToFile(line) {
  ensureLogDir();
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size >= MAX_LOG_SIZE_BYTES) {
      logRotation.rotateIfNeeded(LOG_FILE, MAX_LOG_SIZE_BYTES, MAX_LOG_BACKUPS);
    }
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (err) {
    console.error('Failed to write trade.log:', err.message);
  }
}

/** 최근 N줄 메모리 버퍼에 추가 (소켓 전송용) */
function pushRecent(line) {
  recentLines.push(line);
  if (recentLines.length > MAX_RECENT_LINES) recentLines.shift();
}

/** 일반 로그: [시간] 메시지 [메타] */
function log(message, meta = null) {
  const time = formatTime();
  const metaStr = meta != null ? ` ${JSON.stringify(meta)}` : '';
  const line = `[${time}] ${message}${metaStr}`;
  appendToFile(line);
  pushRecent(line);
  return line;
}

/** 태그 로그: [시간] [태그] 메시지 [메타] (예: [BUY_SIGNAL], [EXIT]) */
function logTag(tag, message, meta = null) {
  const time = formatTime();
  const metaStr = meta != null ? ` ${JSON.stringify(meta)}` : '';
  const line = `[${time}] [${tag}] ${message}${metaStr}`;
  appendToFile(line);
  pushRecent(line);
  return line;
}

function getRecentLogs() {
  return [...recentLines];
}

function clearRecent() {
  recentLines = [];
}

/**
 * 거절 로그(reject_logs) 자동 삭제 스케줄 등록
 * - intervalMs 마다 cutoffHours 이전 데이터 삭제 (중복·노후 데이터 정리)
 * @param {Object} db - db 모듈 (insertRejectLog, cleanupRejectLogs 등 보유)
 * @param {number} [intervalMs] - 주기(ms). 기본 4시간
 * @param {number} [cutoffHours] - 이 시간(시간) 이전 로그 삭제. 기본 4
 * @returns {NodeJS.Timeout|null} clearInterval 로 해제 가능
 */
function scheduleRejectLogCleanup(db, intervalMs = 4 * 60 * 60 * 1000, cutoffHours = 4) {
  if (!db || typeof db.cleanupRejectLogs !== 'function') return null;
  if (rejectLogCleanupTimer) clearInterval(rejectLogCleanupTimer);
  const run = () => {
    db.cleanupRejectLogs(cutoffHours).then((deleted) => {
      if (deleted > 0) console.log(`[Logger] Reject 로그 정리: ${deleted}건 삭제`);
    }).catch((e) => console.error('[Logger] cleanupRejectLogs:', e.message));
  };
  run(); // 첫 실행 (1회)
  rejectLogCleanupTimer = setInterval(run, intervalMs);
  return rejectLogCleanupTimer;
}

let memoryCleanupTimer = null;

/**
 * 메모리 로그 버퍼 자동 청소 (4시간마다)
 * - recentLines(실시간 소켓 전송용) 비우기 → 대시보드 메모리 점유·속도 유지
 * - 파일(trade.log)은 유지, 메모리만 Flush
 * @param {number} [intervalMs] - 주기(ms). 기본 4시간
 * @returns {NodeJS.Timeout|null}
 */
function scheduleMemoryCleanup(intervalMs = 4 * 60 * 60 * 1000) {
  if (memoryCleanupTimer) clearInterval(memoryCleanupTimer);
  memoryCleanupTimer = setInterval(() => {
    clearRecent();
    console.log('[Logger] 메모리 로그 버퍼 정리 완료 (4시간 주기)');
  }, intervalMs);
  return memoryCleanupTimer;
}

/**
 * 서버 재기동 시 호출: trade.log 등 logs/ 내 .log 파일에서 N일(기본 7일) 초과 라인 삭제
 * @param {number} [days] - 유지 일수 (기본 7)
 * @returns {number} 삭제된 총 라인 수
 */
function truncateLogsOlderThanDays(days = TRUNCATE_DAYS_ON_BOOT) {
  return logRotation.rotateAndTruncateLogDir(LOG_DIR, days, MAX_LOG_SIZE_BYTES, MAX_LOG_BACKUPS);
}

module.exports = {
  log,
  logTag,
  getRecentLogs,
  clearRecent,
  formatTime,
  scheduleRejectLogCleanup,
  scheduleMemoryCleanup,
  truncateLogsOlderThanDays,
  LOG_DIR,
  LOG_FILE
};
