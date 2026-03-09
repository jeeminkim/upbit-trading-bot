/**
 * SCALP/REGIME 원시 출력을 공통 UnifiedSignal 포맷으로 정규화
 */

const { createEmptySignal, clampScore } = require('./signalSchema');

const SCORE_MAX_ENTRY = 10; // scalp entry_score_min ~ 10 구간을 0~1로 매핑

function normalizeScalpRaw(market, pipeline, scalpStateEntry, profile, p0Allowed) {
  const symbol = (market || '').replace(/^KRW-/, '') || 'BTC';
  const base = createEmptySignal('SCALP', symbol, 'BUY');
  if (!pipeline || !scalpStateEntry) return base;

  const scoreRaw = pipeline.score != null ? pipeline.score : scalpStateEntry.entryScore;
  base.score = clampScore((scoreRaw - (profile?.entry_score_min ?? 4)) / (SCORE_MAX_ENTRY - (profile?.entry_score_min ?? 4)));
  base.confidence = p0Allowed ? clampScore(scoreRaw / SCORE_MAX_ENTRY) : 0.2;
  base.expected_edge = base.score * 0.9;
  base.risk_level = clampScore(1 - (pipeline.marketScore != null ? pipeline.marketScore / 100 : 0.5));
  base.expected_horizon = 'short';
  base.reasons = [];
  if (scalpStateEntry.priceBreak) base.reasons.push('price_break');
  if (scalpStateEntry.volSurge) base.reasons.push('vol_surge');
  if (scalpStateEntry.strengthOk) base.reasons.push('strength_ok');
  if (scalpStateEntry.obiOk) base.reasons.push('obi_ok');
  base.diagnostics = {
    p0Allowed: !!pipeline.p0Allowed,
    p0Reason: pipeline.p0Reason || null,
    quantityMultiplier: pipeline.quantityMultiplier ?? 1,
    marketScore: pipeline.marketScore ?? null
  };
  base.timestamp = Math.floor(Date.now() / 1000);
  return base;
}

function normalizeRegimeRaw(symbol, regimeRecord, mpi) {
  const base = createEmptySignal('REGIME', symbol || 'BTC', 'BUY');
  if (!regimeRecord) return base;

  const regime = regimeRecord.regime || 'RANGE';
  const trend = regimeRecord.trend_strength != null ? regimeRecord.trend_strength : 0;
  const vol = regimeRecord.volatility != null ? regimeRecord.volatility : 0;

  const isBull = regime === 'TREND_UP';
  const isBear = regime === 'TREND_DOWN';
  if (isBear) {
    base.side = 'NONE';
    base.reasons.push('regime_bear');
    return base;
  }
  base.side = isBull ? 'BUY' : 'NONE';
  base.regime_context = regime;
  base.score = isBull ? clampScore(0.5 + trend * 2) : clampScore(0.3 + (1 - Math.min(1, vol * 20)) * 0.3);
  base.confidence = clampScore(0.4 + (isBull ? trend : 0.2));
  base.expected_edge = base.score * 0.85;
  base.risk_level = clampScore(vol * 15);
  base.expected_horizon = 'medium';
  base.reasons.push('regime_' + regime.toLowerCase());
  if (mpi != null && !Number.isNaN(Number(mpi))) base.reasons.push('mpi=' + Number(mpi).toFixed(0));
  base.diagnostics = { regime, trend_strength: trend, volatility: vol, mpi: mpi ?? null };
  base.timestamp = regimeRecord.timestamp || Math.floor(Date.now() / 1000);
  return base;
}

module.exports = {
  normalizeScalpRaw,
  normalizeRegimeRaw
};
