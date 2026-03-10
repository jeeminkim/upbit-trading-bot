/**
 * Exit 정책 — 청산 신호 판단을 도메인 계층으로 분리
 * 현재는 LegacyExitBridge를 통해 기존 TradeExecutor.checkExit 재사용
 */

const LegacyExitBridge = require('./LegacyExitBridge');

/**
 * 포지션 청산 필요 여부 평가
 * @param {Object} position - { entryPrice, entryTimeMs, strengthPeak60s?, highSinceEntry? }
 * @param {Object} snapshot - 현재 호가·체결 스냅샷
 * @param {number} currentPrice
 * @param {number|null} currentEntryScore
 * @returns {{ exit: boolean, reason?: string }}
 */
function evaluate(position, snapshot, currentPrice, currentEntryScore) {
  return LegacyExitBridge.evaluate(position, snapshot, currentPrice, currentEntryScore);
}

module.exports = { evaluate };
