/**
 * EdgeEstimator — 신호 품질 레이어 (strategy signal → EdgeEstimator → position sizing)
 * TradeEdgeScore = 0.30*signal + 0.25*regime + 0.15*vol + 0.15*liq + 0.15*slippage_inverse
 * 모드: observe_only | soft_gate | hard_gate. reject 시 reason code 필수.
 */

const configDefault = require('../../config.default');
const edgeMetrics = require('./edgeMetrics');

const LOG_TAG = '[EDGE]';
const REASON = {
  EDGE_SCORE_TOO_LOW: 'EDGE_SCORE_TOO_LOW',
  BREAKOUT_NOT_CONFIRMED: 'BREAKOUT_NOT_CONFIRMED',
  VOLUME_SURGE_TOO_LOW: 'VOLUME_SURGE_TOO_LOW',
  ORDERBOOK_LIQUIDITY_INSUFFICIENT: 'ORDERBOOK_LIQUIDITY_INSUFFICIENT',
  NORMALIZATION_FALLBACK_USED: 'NORMALIZATION_FALLBACK_USED',
  ASSET_PROFILE_REJECTED: 'ASSET_PROFILE_REJECTED',
  PASS: 'PASS'
};

function _clamp01(v) {
  if (v == null || Number.isNaN(Number(v))) return 0;
  return Math.max(0, Math.min(1, Number(v)));
}

/**
 * @param {Object} inputs - { signalScore, regimeScore, volatilityFactor, liquidityFactor, slippageRiskInverse } (0~1)
 * @param {Object} options - { mode, threshold, symbol }
 * @returns { { edgeScore: number, decision: 'PASS'|'REJECT', reasonCode: string, details?: Object } }
 */
function evaluate(inputs, options = {}) {
  const cfg = configDefault.EDGE_LAYER || {};
  const mode = (options.mode || cfg.mode || 'observe_only').toLowerCase();
  const threshold = options.threshold != null ? options.threshold : (cfg.edgeThreshold ?? 0.55);
  const symbol = (options.symbol || '').toUpperCase().replace(/^KRW-/, '');

  const w = {
    signal: cfg.weightSignalScore ?? 0.30,
    regime: cfg.weightRegimeScore ?? 0.25,
    vol: cfg.weightVolatilityFactor ?? 0.15,
    liq: cfg.weightLiquidityFactor ?? 0.15,
    slippage: cfg.weightSlippageRiskInverse ?? 0.15
  };

  const s = _clamp01(inputs.signalScore);
  const r = _clamp01(inputs.regimeScore);
  const v = _clamp01(inputs.volatilityFactor);
  const l = _clamp01(inputs.liquidityFactor);
  const p = _clamp01(inputs.slippageRiskInverse);

  const edgeScore = w.signal * s + w.regime * r + w.vol * v + w.liq * l + w.slippage * p;
  const details = { signalScore: s, regimeScore: r, volatilityFactor: v, liquidityFactor: l, slippageRiskInverse: p, threshold };

  if (edgeScore >= threshold) {
    edgeMetrics.incrementEdgePass(symbol);
    if (mode === 'observe_only') {
      try { console.log(LOG_TAG, 'observe_only PASS', { symbol, edgeScore, threshold }); } catch (_) {}
    }
    return { edgeScore, decision: 'PASS', reasonCode: REASON.PASS, details };
  }

  edgeMetrics.incrementEdgeReject(symbol);
  const reasonCode = REASON.EDGE_SCORE_TOO_LOW;

  if (mode === 'observe_only') {
    try { console.log(LOG_TAG, 'observe_only REJECT (no block)', { symbol, edgeScore, threshold, reasonCode }); } catch (_) {}
    return { edgeScore, decision: 'PASS', reasonCode: REASON.PASS, details: { ...details, shadowReject: reasonCode } };
  }

  if (mode === 'soft_gate') {
    try { console.warn(LOG_TAG, 'soft_gate REJECT (warning only)', { symbol, edgeScore, threshold, reasonCode }); } catch (_) {}
    return { edgeScore, decision: 'PASS', reasonCode: REASON.PASS, details: { ...details, softReject: reasonCode } };
  }

  return { edgeScore, decision: 'REJECT', reasonCode, details };
}

function isEnabled() {
  const cfg = require('../../config.default').EDGE_LAYER;
  return !!(cfg && cfg.enabled);
}

function getMode() {
  const cfg = require('../../config.default').EDGE_LAYER;
  return (cfg && cfg.mode) ? String(cfg.mode).toLowerCase() : 'observe_only';
}

module.exports = {
  evaluate,
  isEnabled,
  getMode,
  REASON
};
