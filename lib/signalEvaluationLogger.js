/**
 * SignalEngine 검증용 구조화 로그 — 1줄 1이벤트, grep/집계 가능
 * type: signal_evaluation, 키 고정
 * LOG_LEVEL=DEBUG 일 때만 출력 (기본 운영 모드에서는 과다 로그 억제)
 */
const LOG_LEVEL = (process.env.LOG_LEVEL || process.env.RUNTIME_LOG_MODE || 'NORMAL').toUpperCase();

function logSignalEvaluation(payload) {
  if (LOG_LEVEL !== 'DEBUG') return;
  const line = JSON.stringify({
    type: 'signal_evaluation',
    market: payload.market ?? null,
    legacyScore: payload.legacyScore ?? null,
    signalEngineScore: payload.signalEngineScore ?? null,
    finalDecision: payload.finalDecision ?? null,
    blockReason: Array.isArray(payload.blockReason) ? payload.blockReason : (payload.blockReason ? [payload.blockReason] : null),
    path: payload.path ?? null,
    ts: payload.ts != null ? payload.ts : Date.now()
  });
  const ts = new Date().toISOString();
  console.log(`[${ts}] [DEBUG] [signal_evaluation] ${line}`);
}

module.exports = { logSignalEvaluation };
