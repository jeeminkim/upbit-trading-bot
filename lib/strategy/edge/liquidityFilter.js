/**
 * Orderbook Liquidity Filter — 진입 전 top3 bid liquidity > position_size * multiplier
 * 모드: observe_only | soft_gate | hard_gate. 실패 시 ORDERBOOK_LIQUIDITY_INSUFFICIENT
 */

const configDefault = require('../../config.default');
const edgeMetrics = require('./edgeMetrics');

const LOG_TAG = '[LIQ]';
const REASON = 'ORDERBOOK_LIQUIDITY_INSUFFICIENT';

/**
 * orderbook_units 또는 snapshot에서 top3 bid liquidity (KRW) 계산
 * @param {Array} orderbookUnits - [{ bid_price, bid_size }, ...]
 * @returns {number} top3_bid_liquidity_krw
 */
function getTop3BidLiquidityKrw(orderbookUnits) {
  if (!Array.isArray(orderbookUnits) || orderbookUnits.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < Math.min(3, orderbookUnits.length); i++) {
    const p = parseFloat(orderbookUnits[i].bid_price) || 0;
    const s = parseFloat(orderbookUnits[i].bid_size) || 0;
    sum += p * s;
  }
  return sum;
}

/**
 * @param {Object} snapshotOrOrderbook - snapshot.top3_bid_liquidity_krw 있으면 사용, 없으면 orderbook_units 사용
 * @param {number} positionSizeKrw - 주문 예정 금액 (KRW)
 * @param {string} symbol - BTC, ETH, SOL, XRP
 * @param {string} mode - observe_only | soft_gate | hard_gate
 * @returns { { allowed: boolean, reasonCode: string|null, top3BidKrw: number, requiredKrw: number } }
 */
function check(snapshotOrOrderbook, positionSizeKrw, symbol, mode = 'observe_only') {
  const cfg = configDefault.EDGE_LAYER || {};
  const multipliers = cfg.liquidityMultiplierByAsset || { BTC: 3.0, ETH: 3.0, SOL: 3.5, XRP: 4.0 };
  const sym = (symbol || '').toUpperCase().replace(/^KRW-/, '');
  const mult = multipliers[sym] != null ? multipliers[sym] : 3.0;

  let top3BidKrw = 0;
  if (snapshotOrOrderbook && snapshotOrOrderbook.top3_bid_liquidity_krw != null) {
    top3BidKrw = Number(snapshotOrOrderbook.top3_bid_liquidity_krw);
  } else if (snapshotOrOrderbook && Array.isArray(snapshotOrOrderbook.orderbook_units)) {
    top3BidKrw = getTop3BidLiquidityKrw(snapshotOrOrderbook.orderbook_units);
  } else if (snapshotOrOrderbook && snapshotOrOrderbook.units) {
    top3BidKrw = getTop3BidLiquidityKrw(snapshotOrOrderbook.units);
  }

  const requiredKrw = positionSizeKrw * mult;
  const allowed = top3BidKrw >= requiredKrw;

  if (!allowed) {
    edgeMetrics.incrementLiquidityReject(sym);
    try { console.warn(LOG_TAG, 'liquidity insufficient', { symbol: sym, top3BidKrw, requiredKrw, mult }); } catch (_) {}
  }

  if (mode === 'observe_only') return { allowed: true, reasonCode: allowed ? null : REASON, top3BidKrw, requiredKrw };
  if (mode === 'soft_gate') return { allowed: true, reasonCode: allowed ? null : REASON, top3BidKrw, requiredKrw };
  return { allowed, reasonCode: allowed ? null : REASON, top3BidKrw, requiredKrw };
}

module.exports = { check, getTop3BidLiquidityKrw, REASON };
