"use strict";
/**
 * 공통 로그 헬퍼 — 모든 로그에 ISO timestamp 포함, LOG_LEVEL로 정보성 로그 억제
 * - ERROR_ONLY: error만 출력
 * - NORMAL: error, warn, startup/critical 유지, info/debug 최소화
 * - DEBUG: 전부 출력
 * 환경변수: LOG_LEVEL 또는 RUNTIME_LOG_MODE (우선: LOG_LEVEL)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LogUtil = void 0;
exports.formatLog = formatLog;
exports.logError = logError;
exports.logWarn = logWarn;
exports.logInfo = logInfo;
exports.logDebug = logDebug;
exports.isDebugLog = isDebugLog;
exports.isErrorOnlyLog = isErrorOnlyLog;
const LOG_LEVEL_ENV = (process.env.LOG_LEVEL || process.env.RUNTIME_LOG_MODE || 'NORMAL').toUpperCase();
const LEVEL_ORDER = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
function currentLevel() {
    if (LOG_LEVEL_ENV === 'ERROR_ONLY')
        return LEVEL_ORDER.ERROR;
    if (LOG_LEVEL_ENV === 'DEBUG')
        return LEVEL_ORDER.DEBUG;
    return LEVEL_ORDER.WARN; // NORMAL: error + warn + 핵심만 info
}
function timestamp() {
    return new Date().toISOString();
}
/** [2026-03-12T09:01:22.123Z] [LEVEL] [tag] message meta */
function formatLog(level, tag, message, meta) {
    const metaStr = meta != null && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp()}] [${level}] [${tag}] ${message}${metaStr}`;
}
function write(level, tag, message, meta) {
    const line = formatLog(level, tag, message, meta);
    if (level === 'ERROR') {
        console.error(line);
    }
    else if (level === 'WARN') {
        console.warn(line);
    }
    else {
        console.log(line);
    }
}
/** error는 항상 출력 (timestamp 포함) */
function logError(tag, message, meta) {
    write('ERROR', tag, message, meta);
}
/** warn은 NORMAL/DEBUG에서 출력 */
function logWarn(tag, message, meta) {
    if (currentLevel() < LEVEL_ORDER.WARN)
        return;
    write('WARN', tag, message, meta);
}
/** info는 DEBUG에서만 또는 NORMAL에서 핵심만 (caller가 조건 부여) */
function logInfo(tag, message, meta) {
    if (currentLevel() < LEVEL_ORDER.INFO)
        return;
    write('INFO', tag, message, meta);
}
function logDebug(tag, message, meta) {
    if (currentLevel() < LEVEL_ORDER.DEBUG)
        return;
    write('DEBUG', tag, message, meta);
}
/** 현재 모드가 DEBUG인지 (과다 로그 허용 여부) */
function isDebugLog() {
    return LOG_LEVEL_ENV === 'DEBUG';
}
/** 현재 모드가 ERROR_ONLY인지 */
function isErrorOnlyLog() {
    return LOG_LEVEL_ENV === 'ERROR_ONLY';
}
exports.LogUtil = {
    formatLog,
    logError,
    logWarn,
    logInfo,
    logDebug,
    timestamp,
    isDebugLog,
    isErrorOnlyLog,
    getRuntimeMode: () => LOG_LEVEL_ENV,
};
