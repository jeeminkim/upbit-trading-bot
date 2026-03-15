/**
 * 공통 로그 헬퍼 — 모든 로그에 ISO timestamp 포함, LOG_LEVEL로 정보성 로그 억제
 * - ERROR_ONLY: error만 출력
 * - NORMAL: error, warn, startup/critical 유지, info/debug 최소화
 * - DEBUG: 전부 출력
 * 환경변수: LOG_LEVEL 또는 RUNTIME_LOG_MODE (우선: LOG_LEVEL)
 */

export type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';
export type RuntimeLogMode = 'ERROR_ONLY' | 'NORMAL' | 'DEBUG';

const LOG_LEVEL_ENV = (process.env.LOG_LEVEL || process.env.RUNTIME_LOG_MODE || 'NORMAL').toUpperCase() as RuntimeLogMode;
const LEVEL_ORDER: Record<LogLevel, number> = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };

function currentLevel(): number {
  if (LOG_LEVEL_ENV === 'ERROR_ONLY') return LEVEL_ORDER.ERROR;
  if (LOG_LEVEL_ENV === 'DEBUG') return LEVEL_ORDER.DEBUG;
  return LEVEL_ORDER.WARN; // NORMAL: error + warn + 핵심만 info
}

function timestamp(): string {
  return new Date().toISOString();
}

/** [2026-03-12T09:01:22.123Z] [LEVEL] [tag] message meta */
export function formatLog(level: LogLevel, tag: string, message: string, meta?: Record<string, unknown> | null): string {
  const metaStr = meta != null && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  return `[${timestamp()}] [${level}] [${tag}] ${message}${metaStr}`;
}

function write(level: LogLevel, tag: string, message: string, meta?: Record<string, unknown> | null): void {
  const line = formatLog(level, tag, message, meta);
  if (level === 'ERROR') {
    console.error(line);
  } else if (level === 'WARN') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/** error는 항상 출력 (timestamp 포함) */
export function logError(tag: string, message: string, meta?: Record<string, unknown> | null): void {
  write('ERROR', tag, message, meta);
}

/** warn은 NORMAL/DEBUG에서 출력 */
export function logWarn(tag: string, message: string, meta?: Record<string, unknown> | null): void {
  if (currentLevel() < LEVEL_ORDER.WARN) return;
  write('WARN', tag, message, meta);
}

/** info는 DEBUG에서만 또는 NORMAL에서 핵심만 (caller가 조건 부여) */
export function logInfo(tag: string, message: string, meta?: Record<string, unknown> | null): void {
  if (currentLevel() < LEVEL_ORDER.INFO) return;
  write('INFO', tag, message, meta);
}

export function logDebug(tag: string, message: string, meta?: Record<string, unknown> | null): void {
  if (currentLevel() < LEVEL_ORDER.DEBUG) return;
  write('DEBUG', tag, message, meta);
}

/** 현재 모드가 DEBUG인지 (과다 로그 허용 여부) */
export function isDebugLog(): boolean {
  return LOG_LEVEL_ENV === 'DEBUG';
}

/** 현재 모드가 ERROR_ONLY인지 */
export function isErrorOnlyLog(): boolean {
  return LOG_LEVEL_ENV === 'ERROR_ONLY';
}

export const LogUtil = {
  formatLog,
  logError,
  logWarn,
  logInfo,
  logDebug,
  timestamp,
  isDebugLog,
  isErrorOnlyLog,
  getRuntimeMode: (): RuntimeLogMode => LOG_LEVEL_ENV,
};
