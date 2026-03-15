/**
 * 전략 판단 Explain 로그 — 7시점 기록, EventBus EXPLAIN_ENTRY 연동
 * - threshold/모드: lib/runtimeStrategyConfig 기준. runtime_mode, updated_by_mode_source 포함.
 * - trade_skipped 시 skip_reason 필수 (score_below_threshold, duplicate_cooldown, ws_lag, daily_loss_limit, no_signal, p0_gate_blocked 등)
 */

const runtimeStrategyConfig = require('../runtimeStrategyConfig');

const MAX_ENTRIES = 200;
const buffer = [];

function getThresholdEntry() {
  return runtimeStrategyConfig.getThresholdEntry();
}

function getMinOrchestratorScore() {
  return runtimeStrategyConfig.getMinOrchestratorScore();
}

/**
 * @param {Object} entry - Explain 로그 한 건 (공통/점수/상태/리스크 게이트 필드)
 */
function log(entry) {
  const ts = entry.timestamp != null ? entry.timestamp : new Date().toISOString();
  const runtimeState = runtimeStrategyConfig.getState();
  const profile = runtimeState.profile || {};
  const payload = {
    timestamp: ts,
    symbol: entry.symbol ?? entry.coin ?? '—',
    source_strategy: entry.source_strategy ?? 'SCALP',
    action: entry.action ?? (entry.decision ?? 'SKIP'),
    skip_reason: entry.skip_reason ?? null,
    reason_details: entry.reason_details ?? entry.reason ?? null,
    raw_entry_score: entry.raw_entry_score,
    entry_score_min: entry.entry_score_min,
    normalized_score: entry.normalized_score,
    confidence: entry.confidence,
    expected_edge: entry.expected_edge,
    risk_level: entry.risk_level,
    final_orchestrator_score: entry.final_orchestrator_score,
    threshold_entry: entry.threshold_entry ?? profile.thresholdEntry,
    min_orchestrator_score: entry.min_orchestrator_score ?? profile.minOrchestratorScore,
    runtime_mode: entry.runtime_mode ?? runtimeState.mode,
    updated_by_mode_source: entry.updated_by_mode_source ?? runtimeState.updatedBy,
    mode_profile_snapshot: entry.mode_profile_snapshot ?? runtimeStrategyConfig.getProfileSnapshot(),
    p0_allowed: entry.p0_allowed,
    p0_reason: entry.p0_reason,
    market_score: entry.market_score,
    quantity_multiplier: entry.quantity_multiplier,
    has_existing_position: entry.has_existing_position,
    consensus_applied: entry.consensus_applied,
    consensus_bonus: entry.consensus_bonus,
    risk_gate_allowed: entry.risk_gate_allowed,
    risk_gate_reasons: entry.risk_gate_reasons,
    open_position_count: entry.open_position_count,
    ws_lag_ms: entry.ws_lag_ms,
    daily_loss_state: entry.daily_loss_state,
    duplicate_cooldown_hit: entry.duplicate_cooldown_hit,
    reason_summary: entry.reason_summary ?? (entry.skip_reason ? `SKIP(${entry.skip_reason})` : entry.action),
    ...entry
  };
  buffer.unshift(payload);
  if (buffer.length > MAX_ENTRIES) buffer.pop();

  try {
    const { EventBus } = require('../../dist-refactor/packages/core/src/EventBus');
    EventBus.emit('EXPLAIN_ENTRY', payload);
  } catch (_) {}
}

function getRecent(limit = 50) {
  return buffer.slice(0, limit);
}

function clear() {
  buffer.length = 0;
}

module.exports = {
  log,
  getRecent,
  clear,
  getThresholdEntry,
  getMinOrchestratorScore
};
