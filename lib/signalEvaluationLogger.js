/**
 * SignalEngine 검증용 구조화 로그 — 1줄 1이벤트, grep/집계 가능
 * type: signal_evaluation, 키 고정
 */
function logSignalEvaluation(payload) {
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
  console.log(line);
}

module.exports = { logSignalEvaluation };
