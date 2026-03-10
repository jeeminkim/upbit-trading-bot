/**
 * @file Market.js
 * 시장 스냅샷 타입 — MarketDataEngine → SignalEngine/RiskEngine 간 계약
 */

/**
 * 1분/5분 캔들 한 개
 * @typedef {{ ts: number; open: number; high: number; low: number; close: number; volume: number }} Candle
 */

/**
 * @typedef {Object} MarketSnapshot
 * @property {string} market
 * @property {number} ts
 * @property {number} tradePrice
 * @property {number} bestBid
 * @property {number} bestAsk
 * @property {number} spreadBp
 * @property {number} orderbookImbalance
 * @property {number} tradeVelocity1s
 * @property {number} tradeVelocity5s
 * @property {number} volume1m
 * @property {number} volume5m
 * @property {number} [wsLagMs]
 * @property {Candle[]} [candles1m]
 * @property {Candle[]} [candles5m]
 */

module.exports = {};
