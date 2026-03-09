/**
 * 패턴 유사도: cosine similarity, Top K neighbors
 * entry_similarity_score = avg(sim to BUY_GOOD) - avg(sim to BUY_BAD), range 0~1
 * entry 조건: similarity_score > 0.65
 */

const patternLearner = require('./patternLearner');

function featureToVector(features) {
  if (!features) return [];
  const keys = [
    'momentum_1h', 'rsi_1h', 'vol_z_1h', 'atr_1h',
    'trend_4h', 'pullback_4h', 'regime_strength_12h', 'trend_strength_1d',
    'orderbook_imbalance', 'spread_ratio', 'mpi'
  ];
  return keys.map(k => Number(features[k]) || 0);
}

function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0;
  const cos = dot / denom;
  return Math.max(0, Math.min(1, (cos + 1) / 2));
}

const K = 15;

/**
 * 현재 feature vector와 데이터셋에서 Top K 이웃 찾기 (cosine similarity 기준)
 */
function topKNeighbors(currentVector, dataset, k = K) {
  const points = (dataset?.points || []).filter(p => p.features && p.label);
  if (points.length === 0) return [];
  const withSim = points.map(p => ({
    point: p,
    sim: cosineSimilarity(currentVector, featureToVector(p.features))
  }));
  withSim.sort((a, b) => b.sim - a.sim);
  return withSim.slice(0, k);
}

/**
 * entry_similarity_score = avg(sim to BUY_GOOD) - avg(sim to BUY_BAD), 클램프 0~1
 */
function entrySimilarityScore(neighbors) {
  const good = neighbors.filter(n => n.point.label === 'BUY_GOOD');
  const bad = neighbors.filter(n => n.point.label === 'BUY_BAD');
  const avgGood = good.length ? good.reduce((a, n) => a + n.sim, 0) / good.length : 0;
  const avgBad = bad.length ? bad.reduce((a, n) => a + n.sim, 0) / bad.length : 0;
  const raw = avgGood - avgBad;
  return Math.max(0, Math.min(1, (raw + 1) / 2));
}

/**
 * 현재 feature(또는 feature point)에 대해 similarity_score 계산
 * @returns { score, neighbors, entryRecommended: score > 0.65 }
 */
function computeSimilarityScore(currentFeaturePointOrFeatures, dataset) {
  const vector = currentFeaturePointOrFeatures?.features
    ? featureToVector(currentFeaturePointOrFeatures.features)
    : featureToVector(currentFeaturePointOrFeatures);
  const neighbors = topKNeighbors(vector, dataset, K);
  const score = entrySimilarityScore(neighbors);
  return {
    similarity_score: score,
    neighbors: neighbors.map(n => ({ label: n.point.label, sim: n.sim })),
    entryRecommended: score > 0.65
  };
}

module.exports = {
  featureToVector,
  cosineSimilarity,
  topKNeighbors,
  entrySimilarityScore,
  computeSimilarityScore,
  K
};
