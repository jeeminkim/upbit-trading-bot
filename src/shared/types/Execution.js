/**
 * @file Execution.js
 * 집행 계획 타입 — Risk 통과 후 ExecutionEngine 입력 계약
 */

/**
 * @typedef {Object} ExecutionSlice
 * @property {number} ratio
 * @property {"MARKET"|"LIMIT"} type
 * @property {number} [timeoutMs]
 * @property {number} [priceOffsetBp]
 */

/**
 * @typedef {Object} ExecutionPlan
 * @property {string} market
 * @property {"MARKET"|"LIMIT"|"SCALED"} mode
 * @property {number} budgetKrw
 * @property {ExecutionSlice[]} slices
 * @property {number} stopLossBp
 * @property {number[]} takeProfitBp
 * @property {number} maxSlippageBp
 */

module.exports = {};
