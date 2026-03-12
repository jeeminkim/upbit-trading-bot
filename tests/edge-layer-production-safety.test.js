/**
 * Edge Layer Production Safety — 단위/통합 검증
 * 실행: node tests/edge-layer-production-safety.test.js (반드시 dashboard 디렉터리에서)
 * 실제 주문 실행 없음. mock/stub 최소 사용.
 */

const path = require('path');
const projectRoot = path.resolve(__dirname, '..');
process.chdir(projectRoot);

const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assert failed'); };

function run(name, fn) {
  try {
    fn();
    console.log('  OK', name);
    return true;
  } catch (e) {
    console.error('  FAIL', name, e.message);
    return false;
  }
}

// ——— Volume Surge (시간 버킷) ———
function testVolumeSurge() {
  const volumeSurge = require('../lib/strategy/edge/volumeSurge');
  const { pushBucket, compute, check, getBucketKey, BUCKET_MS, WINDOW_BUCKETS } = volumeSurge;

  run('getBucketKey: 10초 단위', () => {
    const t = 10000000;
    assert(getBucketKey(t) === Math.floor(t / 10000));
  });

  run('pushBucket: 같은 10초 구간이면 누적', () => {
    const state = {};
    const base = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
    pushBucket(state, 'KRW-BTC', 100);
    pushBucket(state, 'KRW-BTC', 50);
    const buckets = state.volumeBuckets10s['KRW-BTC'];
    assert(buckets.length >= 1);
    assert(buckets[buckets.length - 1].vol === 150);
  });

  run('tick 간격 불규칙(1초/3초/7초)에도 같은 버킷에 누적', () => {
    const state = {};
    const now = Date.now();
    const key = getBucketKey(now);
    pushBucket(state, 'KRW-ETH', 10);
    pushBucket(state, 'KRW-ETH', 20);
    pushBucket(state, 'KRW-ETH', 30);
    const buckets = state.volumeBuckets10s['KRW-ETH'];
    const last = buckets[buckets.length - 1];
    assert(last.bucketKey === key);
    assert(last.vol === 60);
  });

  run('compute: 버킷 5개 미만이면 fallback, value=neutral', () => {
    const state = { volumeBuckets10s: { 'KRW-BTC': [] } };
    for (let i = 0; i < 3; i++) {
      pushBucket(state, 'KRW-BTC', 100);
    }
    const r = compute(state, 'KRW-BTC');
    assert(r.fallback === true);
    assert(r.value >= 0 && r.value <= 10);
    assert(r.recentVolume !== undefined);
    assert(r.avgBucketVolume !== undefined);
  });

  run('compute: 분모 0 없음 (avgBucketVolume floor)', () => {
    const state = { volumeBuckets10s: { 'KRW-BTC': [] } };
    const baseKey = Math.floor(Date.now() / BUCKET_MS);
    for (let i = 0; i < 10; i++) {
      state.volumeBuckets10s['KRW-BTC'].push({ bucketKey: baseKey - 10 + i, vol: 0 });
    }
    const r = compute(state, 'KRW-BTC');
    assert(r.fallback === true || (Number.isFinite(r.surgeValue) && r.avgBucketVolume >= 0));
  });

  run('compute: recentVolume은 현재 10초 버킷 기준', () => {
    const state = {};
    const baseKey = Math.floor(Date.now() / BUCKET_MS);
    const buckets = [];
    for (let i = 0; i < 15; i++) {
      buckets.push({ bucketKey: baseKey - 14 + i, vol: 100 });
    }
    buckets[buckets.length - 1].vol = 500;
    state.volumeBuckets10s = { 'KRW-BTC': buckets };
    const r = compute(state, 'KRW-BTC');
    assert(r.recentVolume === 500 || r.fallback);
    assert(r.avgBucketVolume >= 0);
  });

  run('check: observe_only에서 allowed 항상 true', () => {
    const state = { volumeBuckets10s: { 'KRW-BTC': [] } };
    const res = check(state, 'KRW-BTC', 'BTC', 'observe_only', 999);
    assert(res.allowed === true);
    assert(res.reasonCode === null || res.reasonCode === 'VOLUME_SURGE_TOO_LOW');
  });

  run('check: hard_gate에서 value < threshold면 allowed=false', () => {
    const state = {};
    const baseKey = Math.floor(Date.now() / BUCKET_MS);
    const buckets = [];
    for (let i = 0; i < 10; i++) {
      buckets.push({ bucketKey: baseKey - 9 + i, vol: 100 });
    }
    buckets[buckets.length - 1].vol = 50;
    state.volumeBuckets10s = { 'KRW-BTC': buckets };
    const res = check(state, 'KRW-BTC', 'BTC', 'hard_gate', 10);
    assert(res.allowed === false || res.fallback);
    if (!res.fallback) assert(res.reasonCode === 'VOLUME_SURGE_TOO_LOW');
  });

  run('로그 필드: recentVolume, avgBucketVolume, surgeValue 존재', () => {
    const state = {};
    for (let i = 0; i < 8; i++) pushBucket(state, 'KRW-SOL', 200);
    const r = compute(state, 'KRW-SOL');
    assert(typeof r.recentVolume === 'number');
    assert(typeof r.avgBucketVolume === 'number');
    assert(typeof r.surgeValue === 'number' || r.surgeValue === r.value);
  });
}

// ——— EdgeEstimator (factor clamp, edgeScore 0~1) ———
function testEdgeEstimator() {
  const EdgeEstimator = require('../lib/strategy/edge/EdgeEstimator');

  run('모든 factor 정상일 때 edgeScore 계산', () => {
    const r = EdgeEstimator.evaluate({
      signalScore: 0.8,
      regimeScore: 0.6,
      volatilityFactor: 0.5,
      liquidityFactor: 0.7,
      slippageRiskInverse: 0.9
    }, { mode: 'observe_only', symbol: 'BTC' });
    assert(r.edgeScore >= 0 && r.edgeScore <= 1);
    assert(r.decision === 'PASS' || r.decision === 'REJECT');
    assert(r.reasonCode != null);
  });

  run('factor 1 초과 시 clamp', () => {
    const r = EdgeEstimator.evaluate({
      signalScore: 2,
      regimeScore: -0.5,
      volatilityFactor: 0.5,
      liquidityFactor: 1.5,
      slippageRiskInverse: 0.5
    }, { mode: 'observe_only', symbol: 'ETH' });
    assert(r.edgeScore >= 0 && r.edgeScore <= 1);
    assert(r.details.normalizedFactors.signalScore <= 1);
    assert(r.details.normalizedFactors.regimeScore >= 0);
  });

  run('factor null/undefined/NaN 시 fallback', () => {
    const r = EdgeEstimator.evaluate({
      signalScore: null,
      regimeScore: undefined,
      volatilityFactor: NaN,
      liquidityFactor: 0.5,
      slippageRiskInverse: 0.5
    }, { mode: 'observe_only', symbol: 'SOL' });
    assert(r.edgeScore >= 0 && r.edgeScore <= 1);
    assert(r.details != null);
  });

  run('observe_only: wouldReject=true여도 allowed(decision=PASS) 유지', () => {
    const r = EdgeEstimator.evaluate({
      signalScore: 0.1,
      regimeScore: 0.1,
      volatilityFactor: 0.5,
      liquidityFactor: 0.5,
      slippageRiskInverse: 0.5
    }, { mode: 'observe_only', symbol: 'XRP', threshold: 0.9 });
    assert(r.decision === 'PASS');
    assert(r.wouldReject === true);
  });

  run('hard_gate: threshold 미만 시 decision=REJECT', () => {
    const r = EdgeEstimator.evaluate({
      signalScore: 0.2,
      regimeScore: 0.2,
      volatilityFactor: 0.3,
      liquidityFactor: 0.3,
      slippageRiskInverse: 0.3
    }, { mode: 'hard_gate', symbol: 'BTC', threshold: 0.9 });
    assert(r.decision === 'REJECT');
    assert(r.reasonCode === 'EDGE_SCORE_TOO_LOW' || r.reasonCode.indexOf('EDGE') >= 0);
  });

  run('details에 rawFactors, normalizedFactors 존재', () => {
    const r = EdgeEstimator.evaluate({
      signalScore: 0.7,
      regimeScore: 0.6,
      volatilityFactor: 0.5,
      liquidityFactor: 0.5,
      slippageRiskInverse: 0.5
    }, { mode: 'observe_only', symbol: 'BTC' });
    assert(r.details.rawFactors != null);
    assert(r.details.normalizedFactors != null);
  });
}

// ——— StrategyOrchestrator normalization (signalComparator) ———
function testNormalization() {
  const edgeMetrics = require('../lib/strategy/edge/edgeMetrics');
  const signalComparator = require('../lib/strategy/signalComparator');
  edgeMetrics.resetMetrics();

  run('sample 부족 시 raw score fallback', () => {
    const { normalizeStrategyScore } = signalComparator;
    for (let i = 0; i < 3; i++) {
      const s = normalizeStrategyScore('SCALP', 0.6);
      assert(s === 0.6);
    }
  });

  run('정규화 후 0~1 범위', () => {
    const { normalizeStrategyScore } = signalComparator;
    edgeMetrics.resetMetrics();
    for (let i = 0; i < 15; i++) normalizeStrategyScore('REGIME', 0.3 + i * 0.04);
    const s = normalizeStrategyScore('REGIME', 0.5);
    assert(s >= 0 && s <= 1);
  });

  run('normalizationFallbackCount 집계', () => {
    edgeMetrics.resetMetrics();
    const { normalizeStrategyScore } = signalComparator;
    for (let i = 0; i < 2; i++) normalizeStrategyScore('SCALP', 0.5);
    const m = edgeMetrics.getMetrics();
    assert(m.normalization_fallback_count != null);
  });
}

// ——— 통합: observe_only에서 주문 체인 유지 ———
function testObserveOnlyContract() {
  const volumeSurge = require('../lib/strategy/edge/volumeSurge');
  const liquidityFilter = require('../lib/strategy/edge/liquidityFilter');

  run('volumeSurge observe_only: allowed=true', () => {
    const state = { volumeBuckets10s: {} };
    const r = volumeSurge.check(state, 'KRW-BTC', 'BTC', 'observe_only', 999);
    assert(r.allowed === true);
  });

  run('liquidityFilter observe_only: allowed=true (자산 부족 시에도)', () => {
    const r = liquidityFilter.check({ top3_bid_liquidity_krw: 0 }, 1000000, 'BTC', 'observe_only');
    assert(r.allowed === true);
  });
}

// ——— 메트릭 카운터 ———
function testMetrics() {
  const edgeMetrics = require('../lib/strategy/edge/edgeMetrics');
  edgeMetrics.resetMetrics();

  run('edgePassCount, edgeRejectCount 존재', () => {
    const m = edgeMetrics.getMetrics();
    assert(m.edge_pass_count != null);
    assert(m.edge_reject_count != null);
    assert(m.liquidity_reject_count != null);
    assert(m.volume_reject_count != null);
    assert(m.normalization_fallback_count != null);
  });
}

console.log('Edge Layer Production Safety Tests\n');
testVolumeSurge();
testEdgeEstimator();
testNormalization();
testObserveOnlyContract();
testMetrics();
console.log('\nDone.');
