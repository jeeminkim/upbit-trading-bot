/**
 * Volume Surge — recent_10s_volume / avg_10s_volume_over_last_5m
 * 시간 버킷(10초) 기준 집계. tick 간격과 무관하게 timestamp bucketize.
 * 5분 히스토리 없으면 neutral fallback. division by zero / insufficient history / abnormal spike 처리.
 */

const configDefault = require('../../config.default');
const edgeMetrics = require('./edgeMetrics');

const LOG_TAG = '[VOL_SURGE]';
const REASON = 'VOLUME_SURGE_TOO_LOW';
const BUCKET_MS = 10000;       // 10초
const WINDOW_BUCKETS = 30;     // 5min = 30 * 10s
const MIN_BUCKETS_FOR_AVG = 5; // 최소 버킷 수 미만이면 fallback
const MAX_SURGE_CLAMP = 50;    // abnormal spike 시 상한

/** state.volumeBuckets10s = { 'KRW-BTC': [ { bucketKey, vol }, ... ], ... }  (bucketKey = floor(ts/10000)) */
function getOrCreateBuckets(state, market) {
  if (!state.volumeBuckets10s) state.volumeBuckets10s = {};
  if (!state.volumeBuckets10s[market]) state.volumeBuckets10s[market] = [];
  return state.volumeBuckets10s[market];
}

/**
 * 10초 시간 버킷 키 (tick 간격과 무관)
 * @param {number} timestampMs
 * @returns {number}
 */
function getBucketKey(timestampMs) {
  const t = Number(timestampMs);
  if (!Number.isFinite(t)) return Math.floor(Date.now() / BUCKET_MS);
  return Math.floor(t / BUCKET_MS);
}

/**
 * 틱 델타를 해당 10초 버킷에 누적. 오래된 버킷은 제거 (최근 5분만 유지).
 * @param {Object} state
 * @param {string} market
 * @param {number} volKrw - 이번 틱의 거래대금 델타 (KRW)
 */
function pushBucket(state, market, volKrw) {
  const buckets = getOrCreateBuckets(state, market);
  const now = Date.now();
  const key = getBucketKey(now);
  const vol = typeof volKrw === 'number' && Number.isFinite(volKrw) ? Math.max(0, volKrw) : 0;

  const last = buckets.length > 0 ? buckets[buckets.length - 1] : null;
  if (last && last.bucketKey === key) {
    last.vol += vol;
  } else {
    buckets.push({ bucketKey: key, vol });
  }

  const cutoffKey = key - WINDOW_BUCKETS;
  while (buckets.length > 0 && buckets[0].bucketKey < cutoffKey) buckets.shift();
}

/**
 * 최근 10초 거래량 = 현재 버킷의 누적 vol.
 * 최근 5분 평균 = (최근 5분 내 버킷들의 vol 합) / 버킷 수 (분모 floor 1).
 * @param {Object} state - state.volumeBuckets10s[market]
 * @param {string} market - KRW-BTC 등
 * @returns { { value: number, sufficient: boolean, fallback: boolean, recentVolume: number, avgBucketVolume: number, surgeValue: number, context?: Object } }
 */
function compute(state, market) {
  const cfg = configDefault.EDGE_LAYER || {};
  const buckets = state && getOrCreateBuckets(state, market);
  const neutral = cfg.volumeSurgeNeutralFallback != null ? cfg.volumeSurgeNeutralFallback : 1.0;

  const emptyResult = (fallbackReason) => ({
    value: neutral,
    sufficient: true,
    fallback: true,
    recentVolume: 0,
    avgBucketVolume: 0,
    surgeValue: neutral,
    context: { fallbackReason, fallbackValue: neutral }
  });

  if (!buckets || buckets.length < MIN_BUCKETS_FOR_AVG) {
    return emptyResult('INSUFFICIENT_HISTORY');
  }

  const now = Date.now();
  const currentKey = getBucketKey(now);
  const useCompletedBucket = !!(cfg.volumeSurgeUseCompletedBucket);

  // 현재 진행 중인 버킷 vs 최근 완성된 10초 버킷 (경계 변동성 완화 옵션)
  const keyForRecent = useCompletedBucket ? currentKey - 1 : currentKey;
  let recentVolume = 0;
  const bucketForRecent = buckets.find(b => b.bucketKey === keyForRecent);
  if (bucketForRecent && typeof bucketForRecent.vol === 'number' && Number.isFinite(bucketForRecent.vol)) {
    recentVolume = bucketForRecent.vol;
  }

  const bucketProgress = (now % BUCKET_MS) / BUCKET_MS;

  let sum = 0;
  let count = 0;
  for (let i = 0; i < buckets.length; i++) {
    const v = buckets[i].vol;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      sum += v;
      count++;
    }
  }

  const denominator = Math.max(1, count);
  const avgBucketVolume = sum / denominator;

  if (avgBucketVolume <= 0) {
    return {
      value: neutral,
      sufficient: true,
      fallback: true,
      recentVolume,
      avgBucketVolume: 0,
      surgeValue: neutral,
      context: { fallbackReason: 'ZERO_AVG_BUCKET' }
    };
  }

  let surgeValue = recentVolume / avgBucketVolume;
  if (!Number.isFinite(surgeValue) || surgeValue < 0) {
    return {
      value: neutral,
      sufficient: true,
      fallback: true,
      recentVolume,
      avgBucketVolume,
      surgeValue: neutral,
      context: { fallbackReason: 'INVALID_SURGE' }
    };
  }

  // abnormal spike: 보수적 상한
  if (surgeValue > MAX_SURGE_CLAMP) {
    surgeValue = MAX_SURGE_CLAMP;
  }

  try {
    console.info(LOG_TAG, 'volume surge computed', {
      market,
      recentVolume,
      avgBucketVolume,
      surgeValue,
      bucketCount: count,
      bucketKey: currentKey,
      bucketProgress,
      useCompletedBucket
    });
  } catch (_) {}

  return {
    value: surgeValue,
    sufficient: true,
    fallback: false,
    recentVolume,
    avgBucketVolume,
    surgeValue,
    context: { bucketCount: count, bucketKey: currentKey, bucketProgress, useCompletedBucket }
  };
}

/**
 * @param {Object} state
 * @param {string} market
 * @param {string} symbol - BTC, ETH 등
 * @param {string} mode - observe_only | soft_gate | hard_gate
 * @param {number} threshold - config volumeSurgeThresholdByAsset[symbol]
 * @returns { { allowed: boolean, wouldReject?: boolean, reasonCode: string|null, value: number, fallback: boolean, recentVolume?: number, avgBucketVolume?: number, surgeValue?: number } }
 */
function check(state, market, symbol, mode = 'observe_only', threshold) {
  const cfg = configDefault.EDGE_LAYER || {};
  const th = threshold != null ? threshold : (cfg.volumeSurgeThresholdByAsset && cfg.volumeSurgeThresholdByAsset[(symbol || '').toUpperCase()]) || 2.2;
  const sym = (symbol || '').toUpperCase().replace(/^KRW-/, '');

  const computed = compute(state, market);
  const { value, fallback, recentVolume, avgBucketVolume, surgeValue, context } = computed;

  if (fallback) {
    return {
      allowed: true,
      wouldReject: false,
      reasonCode: null,
      value,
      fallback: true,
      fallbackValue: value,
      recentVolume,
      avgBucketVolume,
      surgeValue,
      context: { ...context, reason: 'NEUTRAL_FALLBACK', fallbackValue: value }
    };
  }

  const wouldReject = value < th;

  if (wouldReject) {
    edgeMetrics.incrementVolumeReject(sym);
    try {
      console.warn(LOG_TAG, 'volume surge too low', {
        symbol: sym,
        value,
        threshold: th,
        recentVolume,
        avgBucketVolume,
        surgeValue,
        context
      });
    } catch (_) {}
  }

  if (mode === 'observe_only' || mode === 'soft_gate') {
    return {
      allowed: true,
      wouldReject: wouldReject || undefined,
      reasonCode: wouldReject ? REASON : null,
      value,
      fallback: false,
      recentVolume,
      avgBucketVolume,
      surgeValue,
      context: wouldReject ? { ...context, reasonCode: REASON } : context
    };
  }

  return {
    allowed: !wouldReject,
    reasonCode: wouldReject ? REASON : null,
    value,
    fallback: false,
    recentVolume,
    avgBucketVolume,
    surgeValue,
    context: wouldReject ? { ...context, reasonCode: REASON } : context
  };
}

module.exports = { pushBucket, compute, check, REASON, getOrCreateBuckets, getBucketKey, BUCKET_MS, WINDOW_BUCKETS };
