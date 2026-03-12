/**
 * Volume Surge — recent_10s_volume / avg_10s_volume_over_last_5m
 * 5분 히스토리 없으면 neutral fallback. division by zero / insufficient history 처리.
 */

const configDefault = require('../../config.default');
const edgeMetrics = require('./edgeMetrics');

const LOG_TAG = '[VOL_SURGE]';
const REASON = 'VOLUME_SURGE_TOO_LOW';
const BUCKET_SEC = 10;
const WINDOW_BUCKETS = 30; // 5min = 30 * 10s

/** state.volumeBuckets10s = { 'KRW-BTC': [ { t, vol }, ... ], ... } */
function getOrCreateBuckets(state, market) {
  if (!state.volumeBuckets10s) state.volumeBuckets10s = {};
  if (!state.volumeBuckets10s[market]) state.volumeBuckets10s[market] = [];
  return state.volumeBuckets10s[market];
}

function pushBucket(state, market, volKrw) {
  const buckets = getOrCreateBuckets(state, market);
  const t = Date.now();
  buckets.push({ t, vol: volKrw });
  const cutoff = t - WINDOW_BUCKETS * BUCKET_SEC * 1000;
  while (buckets.length > 0 && buckets[0].t < cutoff) buckets.shift();
}

/**
 * @param {Object} state - state.volumeBuckets10s[market]
 * @param {string} market - KRW-BTC 등
 * @returns { { value: number, sufficient: boolean, fallback: boolean } }
 */
function compute(state, market) {
  const cfg = configDefault.EDGE_LAYER || {};
  const buckets = state && getOrCreateBuckets(state, market);
  const neutral = cfg.volumeSurgeNeutralFallback != null ? cfg.volumeSurgeNeutralFallback : 1.0;

  if (!buckets || buckets.length < 5) {
    return { value: neutral, sufficient: true, fallback: true };
  }

  const recent = buckets[buckets.length - 1];
  const recentVol = recent && typeof recent.vol === 'number' ? recent.vol : 0;

  let sum = 0;
  let count = 0;
  for (let i = 0; i < buckets.length; i++) {
    const v = buckets[i].vol;
    if (typeof v === 'number' && !Number.isNaN(v)) {
      sum += v;
      count++;
    }
  }
  const avg = count > 0 ? sum / count : 0;

  if (avg <= 0) {
    return { value: neutral, sufficient: true, fallback: true };
  }

  const value = recentVol / avg;
  if (!Number.isFinite(value) || value < 0) {
    return { value: neutral, sufficient: true, fallback: true };
  }

  return { value, sufficient: true, fallback: false };
}

/**
 * @param {Object} state
 * @param {string} market
 * @param {string} symbol - BTC, ETH 등
 * @param {string} mode - observe_only | soft_gate | hard_gate
 * @param {number} threshold - config volumeSurgeThresholdByAsset[symbol]
 * @returns { { allowed: boolean, reasonCode: string|null, value: number, fallback: boolean } }
 */
function check(state, market, symbol, mode = 'observe_only', threshold) {
  const cfg = configDefault.EDGE_LAYER || {};
  const th = threshold != null ? threshold : (cfg.volumeSurgeThresholdByAsset && cfg.volumeSurgeThresholdByAsset[(symbol || '').toUpperCase()]) || 2.2;
  const sym = (symbol || '').toUpperCase().replace(/^KRW-/, '');

  const { value, fallback } = compute(state, market);

  if (fallback) {
    return { allowed: true, reasonCode: null, value, fallback: true };
  }

  const allowed = value >= th;
  if (!allowed) {
    edgeMetrics.incrementVolumeReject(sym);
    try { console.warn(LOG_TAG, 'volume surge too low', { symbol: sym, value, threshold: th }); } catch (_) {}
  }

  if (mode === 'observe_only' || mode === 'soft_gate') return { allowed: true, reasonCode: allowed ? null : REASON, value, fallback: false };
  return { allowed, reasonCode: allowed ? null : REASON, value, fallback: false };
}

module.exports = { pushBucket, compute, check, REASON, getOrCreateBuckets };
