/**
 * @file Signal.js
 * 시그널 결정 타입 — SignalEngine → RiskEngine/Execution 간 계약
 */

/**
 * @typedef {Object} SignalDecision
 * @property {string} market
 * @property {"LONG"|"FLAT"} side
 * @property {number} score
 * @property {number} confidence
 * @property {number} expectedEdgeBp
 * @property {number} horizonSec
 * @property {string[]} reasons
 * @property {string[]} invalidation
 * @property {string} source
 */

module.exports = {};
