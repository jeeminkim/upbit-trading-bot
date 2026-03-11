/**
 * StrategyExplainService — 전략 판단 근거 기록 및 대시보드 연동
 * - 왜 샀는가? 왜 팔았는가? 왜 거래하지 않았는가?
 * - EventBus: STRATEGY_SIGNAL, ORDER_SUBMITTED, ORDER_FILLED, TRADE_SKIPPED, EXPLAIN_ENTRY 구독
 */

import { EventBus } from './EventBus';
import type { EventType } from '../../shared/src/types';

export interface ExplainEntry {
  timestamp: string;
  coin: string;
  decision: 'BUY' | 'SELL' | 'HOLD' | 'SKIP';
  edgeScoreBps?: number;
  regime?: string;
  spread?: number;
  volume?: number;
  reason: string;
  meta?: Record<string, unknown>;
  /** 확장: 대시보드 decision/execution 로그용 */
  symbol?: string;
  source_strategy?: string;
  action?: string;
  skip_reason?: string | null;
  reason_details?: string | null;
  raw_entry_score?: number | null;
  entry_score_min?: number | null;
  normalized_score?: number | null;
  confidence?: number | null;
  expected_edge?: number | null;
  risk_level?: number | null;
  final_orchestrator_score?: number | null;
  threshold_entry?: number | null;
  min_orchestrator_score?: number | null;
  p0_allowed?: boolean | null;
  p0_reason?: string | null;
  market_score?: number | null;
  quantity_multiplier?: number | null;
  has_existing_position?: boolean | null;
  consensus_applied?: boolean | null;
  consensus_bonus?: number | null;
  risk_gate_allowed?: boolean | null;
  risk_gate_reasons?: string[] | null;
  open_position_count?: number | null;
  ws_lag_ms?: number | null;
  daily_loss_state?: number | null;
  duplicate_cooldown_hit?: boolean | null;
  reason_summary?: string | null;
  runtime_mode?: string | null;
  updated_by_mode_source?: string | null;
  mode_profile_snapshot?: Record<string, unknown> | null;
}

const MAX_ENTRIES = 200;
const entries: ExplainEntry[] = [];

function toExplainEntry(p: any): ExplainEntry {
  const symbol = p?.symbol ?? p?.coin ?? '—';
  const decision = (p?.action ?? p?.decision ?? 'SKIP') as 'BUY' | 'SELL' | 'HOLD' | 'SKIP';
  const reason = p?.reason ?? p?.reason_summary ?? p?.reason_details ?? '—';
  return {
    timestamp: typeof p?.timestamp === 'string' ? p.timestamp : new Date().toISOString(),
    coin: symbol,
    decision: ['BUY', 'SELL', 'HOLD', 'SKIP'].includes(decision) ? decision : 'SKIP',
    edgeScoreBps: p?.edgeScoreBps ?? p?.edgeBps,
    regime: p?.regime,
    spread: p?.spread,
    volume: p?.volume,
    reason,
    meta: p,
    symbol: p?.symbol,
    source_strategy: p?.source_strategy,
    action: p?.action,
    skip_reason: p?.skip_reason,
    reason_details: p?.reason_details,
    raw_entry_score: p?.raw_entry_score,
    entry_score_min: p?.entry_score_min,
    normalized_score: p?.normalized_score,
    confidence: p?.confidence,
    expected_edge: p?.expected_edge,
    risk_level: p?.risk_level,
    final_orchestrator_score: p?.final_orchestrator_score,
    threshold_entry: p?.threshold_entry,
    min_orchestrator_score: p?.min_orchestrator_score,
    p0_allowed: p?.p0_allowed,
    p0_reason: p?.p0_reason,
    market_score: p?.market_score,
    quantity_multiplier: p?.quantity_multiplier,
    has_existing_position: p?.has_existing_position,
    consensus_applied: p?.consensus_applied,
    consensus_bonus: p?.consensus_bonus,
    risk_gate_allowed: p?.risk_gate_allowed,
    risk_gate_reasons: p?.risk_gate_reasons,
    open_position_count: p?.open_position_count,
    ws_lag_ms: p?.ws_lag_ms,
    daily_loss_state: p?.daily_loss_state,
    duplicate_cooldown_hit: p?.duplicate_cooldown_hit,
    reason_summary: p?.reason_summary,
    runtime_mode: p?.runtime_mode,
    updated_by_mode_source: p?.updated_by_mode_source,
    mode_profile_snapshot: p?.mode_profile_snapshot ?? undefined,
  };
}

function pushEntry(entry: ExplainEntry): void {
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.pop();
}

export const StrategyExplainService = {
  addEntry(entry: ExplainEntry): void {
    pushEntry(entry);
  },

  getRecent(limit: number = 50): ExplainEntry[] {
    return entries.slice(0, limit);
  },

  clear(): void {
    entries.length = 0;
  },

  /** EventBus 구독 등록 (api-server에서 호출) */
  subscribeToEventBus(): () => void {
    const unsubStrategy = EventBus.subscribe('STRATEGY_SIGNAL', (p: any) => {
      pushEntry({
        timestamp: new Date().toISOString(),
        coin: p?.coin ?? p?.symbol ?? '—',
        decision: (p?.side ?? p?.decision ?? 'HOLD').toUpperCase().startsWith('B') ? 'BUY' : (p?.side ?? '').toUpperCase().startsWith('S') ? 'SELL' : 'HOLD',
        edgeScoreBps: p?.edgeScoreBps ?? p?.edgeBps,
        regime: p?.regime,
        spread: p?.spread,
        volume: p?.volume,
        reason: p?.reason ?? 'strategy_signal',
        meta: p,
      });
    });
    const unsubSubmitted = EventBus.subscribe('ORDER_SUBMITTED', (p: any) => {
      pushEntry({
        timestamp: new Date().toISOString(),
        coin: (p?.market ?? p?.coin ?? '').replace('KRW-', '') || '—',
        decision: (p?.side ?? 'BUY').toUpperCase().startsWith('S') ? 'SELL' : 'BUY',
        edgeScoreBps: p?.edgeScoreBps ?? p?.edgeBps,
        regime: p?.regime,
        spread: p?.spread,
        volume: p?.volume,
        reason: p?.reason ?? 'order_submitted',
        meta: p,
      });
    });
    const unsubFilled = EventBus.subscribe('ORDER_FILLED', (p: any) => {
      pushEntry({
        timestamp: new Date().toISOString(),
        coin: (p?.market ?? p?.ticker ?? p?.coin ?? '').replace('KRW-', '') || '—',
        decision: (p?.side ?? 'BUY').toUpperCase().startsWith('S') ? 'SELL' : 'BUY',
        edgeScoreBps: p?.edgeScoreBps ?? p?.edgeBps,
        regime: p?.regime,
        spread: p?.spread,
        volume: p?.volume,
        reason: p?.reason ?? 'order_filled',
        meta: p,
      });
    });
    const unsubSkipped = EventBus.subscribe('TRADE_SKIPPED', (p: any) => {
      pushEntry(toExplainEntry({ ...p, decision: 'SKIP', reason: p?.reason ?? 'trade_skipped' }));
    });
    const unsubExplain = EventBus.subscribe('EXPLAIN_ENTRY', (p: any) => {
      pushEntry(toExplainEntry(p));
    });
    return () => {
      unsubStrategy();
      unsubSubmitted();
      unsubFilled();
      unsubSkipped();
      unsubExplain();
    };
  },
};
