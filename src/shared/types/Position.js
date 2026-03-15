/**
 * @file Position.js
 * 포지션 타입 — PositionEngine 생명주기 계약 (수익률 계산은 업비트 방식: 보유 KRW 제외)
 */

/**
 * @typedef {Object} Position
 * @property {string} market
 * @property {number} qty
 * @property {number} avgPrice
 * @property {number} investedKrw
 * @property {number} openedAt
 * @property {number} updatedAt
 * @property {number} stopLossBp
 * @property {number[]} takeProfitBp
 * @property {number} realizedPnlKrw
 * @property {number} feesKrw
 * @property {string[]} [thesis]
 * @property {"OPEN"|"CLOSING"|"CLOSED"} status
 */

module.exports = {};
