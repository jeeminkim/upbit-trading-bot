/**
 * Edge Layer 메트릭 — edge/liquidity/breakout/volume reject 카운트 (자산별)
 * production-safe: 자산 키 없으면 기본 객체 사용
 */

const metrics = {
  edge_pass_count: {},
  edge_reject_count: {},
  liquidity_reject_count: {},
  breakout_reject_count: {},
  volume_reject_count: {},
  normalization_fallback_count: {} // by strategy: SCALP, REGIME
};

function _ensureKey(obj, symbol) {
  const k = (symbol || '').toUpperCase();
  if (!obj[k]) obj[k] = 0;
  return k;
}

function incrementEdgePass(symbol) {
  const k = _ensureKey(metrics.edge_pass_count, symbol);
  metrics.edge_pass_count[k] += 1;
}

function incrementEdgeReject(symbol) {
  const k = _ensureKey(metrics.edge_reject_count, symbol);
  metrics.edge_reject_count[k] += 1;
}

function incrementLiquidityReject(symbol) {
  const k = _ensureKey(metrics.liquidity_reject_count, symbol);
  metrics.liquidity_reject_count[k] += 1;
}

function incrementBreakoutReject(symbol) {
  const k = _ensureKey(metrics.breakout_reject_count, symbol);
  metrics.breakout_reject_count[k] += 1;
}

function incrementVolumeReject(symbol) {
  const k = _ensureKey(metrics.volume_reject_count, symbol);
  metrics.volume_reject_count[k] += 1;
}

function incrementNormalizationFallback(strategy) {
  const k = (strategy || 'UNKNOWN').toUpperCase();
  if (!metrics.normalization_fallback_count[k]) metrics.normalization_fallback_count[k] = 0;
  metrics.normalization_fallback_count[k] += 1;
}

function getMetrics() {
  return {
    edge_pass_count: { ...metrics.edge_pass_count },
    edge_reject_count: { ...metrics.edge_reject_count },
    liquidity_reject_count: { ...metrics.liquidity_reject_count },
    breakout_reject_count: { ...metrics.breakout_reject_count },
    volume_reject_count: { ...metrics.volume_reject_count },
    normalization_fallback_count: { ...metrics.normalization_fallback_count }
  };
}

/**
 * 5분 summary / 주기 로그용. 자산별 pass/reject 요약.
 * @returns { { edgePass: number, edgeReject: number, volumeReject: number, liquidityReject: number, byAsset: Object } }
 */
function getMetricsSummary() {
  const m = metrics;
  const byAsset = {};
  const symbols = new Set([
    ...Object.keys(m.edge_pass_count),
    ...Object.keys(m.edge_reject_count),
    ...Object.keys(m.volume_reject_count),
    ...Object.keys(m.liquidity_reject_count)
  ]);
  for (const sym of symbols) {
    byAsset[sym] = {
      edgePass: m.edge_pass_count[sym] || 0,
      edgeReject: m.edge_reject_count[sym] || 0,
      volumeReject: m.volume_reject_count[sym] || 0,
      liquidityReject: m.liquidity_reject_count[sym] || 0
    };
  }
  return {
    edgePass: Object.values(m.edge_pass_count).reduce((a, b) => a + b, 0),
    edgeReject: Object.values(m.edge_reject_count).reduce((a, b) => a + b, 0),
    volumeReject: Object.values(m.volume_reject_count).reduce((a, b) => a + b, 0),
    liquidityReject: Object.values(m.liquidity_reject_count).reduce((a, b) => a + b, 0),
    normalizationFallback: { ...m.normalization_fallback_count },
    byAsset
  };
}

function resetMetrics() {
  metrics.edge_pass_count = {};
  metrics.edge_reject_count = {};
  metrics.liquidity_reject_count = {};
  metrics.breakout_reject_count = {};
  metrics.volume_reject_count = {};
  metrics.normalization_fallback_count = {};
}

module.exports = {
  incrementEdgePass,
  incrementEdgeReject,
  incrementLiquidityReject,
  incrementBreakoutReject,
  incrementVolumeReject,
  incrementNormalizationFallback,
  getMetrics,
  getMetricsSummary,
  resetMetrics
};
