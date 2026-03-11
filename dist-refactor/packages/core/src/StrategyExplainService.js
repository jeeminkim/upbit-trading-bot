"use strict";
/**
 * StrategyExplainService — 전략 판단 근거 기록 및 대시보드 연동
 * - 왜 샀는가? 왜 팔았는가? 왜 거래하지 않았는가?
 * - EventBus: STRATEGY_SIGNAL, ORDER_SUBMITTED, ORDER_FILLED, TRADE_SKIPPED, EXPLAIN_ENTRY 구독
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.StrategyExplainService = void 0;
const EventBus_1 = require("./EventBus");
const MAX_ENTRIES = 200;
const entries = [];
function toExplainEntry(p) {
    const symbol = p?.symbol ?? p?.coin ?? '—';
    const decision = (p?.action ?? p?.decision ?? 'SKIP');
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
function pushEntry(entry) {
    entries.unshift(entry);
    if (entries.length > MAX_ENTRIES)
        entries.pop();
}
exports.StrategyExplainService = {
    addEntry(entry) {
        pushEntry(entry);
    },
    getRecent(limit = 50) {
        return entries.slice(0, limit);
    },
    clear() {
        entries.length = 0;
    },
    /** EventBus 구독 등록 (api-server에서 호출) */
    subscribeToEventBus() {
        const unsubStrategy = EventBus_1.EventBus.subscribe('STRATEGY_SIGNAL', (p) => {
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
        const unsubSubmitted = EventBus_1.EventBus.subscribe('ORDER_SUBMITTED', (p) => {
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
        const unsubFilled = EventBus_1.EventBus.subscribe('ORDER_FILLED', (p) => {
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
        const unsubSkipped = EventBus_1.EventBus.subscribe('TRADE_SKIPPED', (p) => {
            pushEntry(toExplainEntry({ ...p, decision: 'SKIP', reason: p?.reason ?? 'trade_skipped' }));
        });
        const unsubExplain = EventBus_1.EventBus.subscribe('EXPLAIN_ENTRY', (p) => {
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
