/**
 * 레거시 청산 판단 브리지 — TradeExecutor.checkExit(scalpEngine.shouldExitScalp) 래핑
 * 전략/포지션 판단과 주문 실행 분리를 위해 ExitPolicy에서 사용
 */

const path = require('path');
const TradeExecutor = require(path.join(__dirname, '../../../lib/TradeExecutor'));

/**
 * @param {Object} position - { entryPrice, entryTimeMs, strengthPeak60s?, highSinceEntry? }
 * @param {Object} snapshot - 호가·체결 스냅샷
 * @param {number} currentPrice
 * @param {number|null} currentEntryScore
 * @returns {{ exit: boolean, reason?: string }}
 */
function evaluate(position, snapshot, currentPrice, currentEntryScore) {
  return TradeExecutor.checkExit(position, snapshot, currentPrice, currentEntryScore);
}

module.exports = { evaluate };
