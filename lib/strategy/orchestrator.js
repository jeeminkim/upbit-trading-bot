/**
 * 전략 오케스트레이터: SCALP vs REGIME 병렬 평가, 더 우수한 1개만 실행
 * - 두 봇 모두 살아있고, 최종 주문은 오케스트레이터만 실행
 * - 포지션 충돌/과매매/중복 진입 방지
 */

const path = require('path');
const fs = require('fs');
const scalpSignalProvider = require('./scalpSignalProvider');
const regimeSignalProvider = require('./regimeSignalProvider');
const signalComparator = require('./signalComparator');
const riskGate = require('../risk/riskGate');
const positionConflictResolver = require('../risk/positionConflictResolver');
const explainLogger = require('./explainLogger');
const runtimeStrategyConfig = require('../runtimeStrategyConfig');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'orchestrator_history.jsonl');
const LOG_TAG = '[ORCH]';

const decisionLog = [];
const MAX_DECISION_LOG = 20;
const hourlyEntries = [];
const lastEntryBySymbol = {};
const MAX_HOURLY_ENTRIES = 200;

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error(LOG_TAG, 'ensureDataDir:', e?.message);
  }
}

function appendHistory(record) {
  try {
    ensureDataDir();
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(record) + '\n', 'utf8');
  } catch (e) {
    console.error(LOG_TAG, 'appendHistory:', e?.message);
  }
}

const LOG_LEVEL_ORCH = (process.env.LOG_LEVEL || process.env.RUNTIME_LOG_MODE || 'NORMAL').toUpperCase();

function logTag(tag, message, meta = {}) {
  decisionLog.push({ ts: Date.now(), tag, message, meta });
  if (decisionLog.length > MAX_DECISION_LOG) decisionLog.shift();
  if (LOG_LEVEL_ORCH !== 'DEBUG') return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [DEBUG] ${tag} ${message}` + (Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '');
  console.log(line);
}

/**
 * 한 사이클 평가 및 결정
 * @param {Object} ctx - { scalpState, profile, regimeLines, mpiBySymbol, accounts, assets, recentTrades, wsLagMs }
 * @returns { { action: 'ENTER'|'SKIP'|'HOLD'|'EXIT', chosenStrategy: 'SCALP'|'REGIME'|'CONSENSUS'|'NONE', signal: Object|null, finalScore: number, reason: string, skipReasons: string[] } }
 */
function tick(ctx) {
  const {
    scalpState = {},
    profile = {},
    regimeLines = [],
    mpiBySymbol = {},
    accounts = [],
    assets = null,
    recentTrades = [],
    wsLagMs = null
  } = ctx;

  const entryScoreMin = profile?.entry_score_min ?? 4;
  const scalpSignal = scalpSignalProvider.getBestScalpSignal(scalpState, profile, entryScoreMin);
  const regimeSignal = regimeSignalProvider.getBestRegimeSignal(regimeLines, mpiBySymbol);

  if (scalpSignal) {
    logTag('[SCALP_SIGNAL]', `symbol=${scalpSignal.symbol} score=${(scalpSignal.score || 0).toFixed(2)} confidence=${(scalpSignal.confidence || 0).toFixed(2)} side=${scalpSignal.side}`);
    const scalpEntry = scalpState['KRW-' + scalpSignal.symbol];
    explainLogger.log({
      symbol: scalpSignal.symbol,
      source_strategy: 'SCALP',
      action: 'CANDIDATE',
      raw_entry_score: scalpEntry?.entryScore ?? scalpSignal.diagnostics?.rawScore,
      entry_score_min: entryScoreMin,
      normalized_score: scalpSignal.score,
      confidence: scalpSignal.confidence,
      expected_edge: scalpSignal.expected_edge,
      risk_level: scalpSignal.risk_level,
      p0_allowed: scalpSignal.diagnostics?.p0Allowed ?? true,
      p0_reason: scalpSignal.diagnostics?.p0Reason ?? null,
      market_score: scalpSignal.diagnostics?.marketScore ?? null,
      quantity_multiplier: scalpSignal.diagnostics?.quantityMultiplier ?? 1,
      reason_summary: 'scalp candidate + normalize done'
    });
  }
  if (regimeSignal) {
    logTag('[REGIME_SIGNAL]', `symbol=${regimeSignal.symbol} score=${(regimeSignal.score || 0).toFixed(2)} confidence=${(regimeSignal.confidence || 0).toFixed(2)} side=${regimeSignal.side} regime=${regimeSignal.regime_context || '—'}`);
  }

  const positionSymbols = (accounts || [])
    .filter((a) => (a.currency || '').toUpperCase() !== 'KRW' && parseFloat(a.balance || 0) > 0)
    .map((a) => (a.currency || '').toUpperCase());

  const compareResult = signalComparator.compareAndChoose(scalpSignal, regimeSignal, positionSymbols);
  const { chosen, signal, finalScore, reason, consensus, breakdown, rejected } = compareResult;

  explainLogger.log({
    symbol: signal?.symbol ?? '—',
    source_strategy: chosen === 'NONE' ? null : chosen,
    action: chosen === 'NONE' ? 'SKIP' : 'COMPARE_DONE',
    final_orchestrator_score: finalScore,
    threshold_entry: signalComparator.getThreshold(),
    min_orchestrator_score: runtimeStrategyConfig.getMinOrchestratorScore(),
    normalized_score: signal?.score,
    confidence: signal?.confidence,
    expected_edge: signal?.expected_edge,
    risk_level: signal?.risk_level,
    has_existing_position: signal ? positionSymbols.includes(signal.symbol) : false,
    consensus_applied: consensus ?? false,
    consensus_bonus: consensus ? signalComparator.CONSENSUS_BONUS : 0,
    reason_summary: reason,
    reason_details: rejected?.length ? JSON.stringify(rejected.map(r => ({ strategy: r.strategy, finalScore: r.finalScore, reason: r.reason }))) : null
  });

  if (consensus && signal) {
    logTag('[CONSENSUS]', `symbol=${signal.symbol} bonus=${signalComparator.CONSENSUS_BONUS}`);
  }

  logTag('[ORCH_COMPARE]', `scalp=${(scalpSignal?.score ?? 0).toFixed(2)} regime=${(regimeSignal?.score ?? 0).toFixed(2)} final=${(finalScore || 0).toFixed(2)} chosen=${chosen}`);

  if (chosen === 'NONE' || !signal) {
    logTag('[ORCH_DECISION]', 'action=SKIP chosen=NONE reason=no_qualifying_signal');
    logTag('[SKIP_REASON]', 'reason=both below or no signals');
    explainLogger.log({
      symbol: '—',
      source_strategy: 'NONE',
      action: 'SKIP',
      skip_reason: 'no_signal',
      final_orchestrator_score: 0,
      threshold_entry: signalComparator.getThreshold(),
      min_orchestrator_score: runtimeStrategyConfig.getMinOrchestratorScore(),
      reason_summary: 'SKIP(no_signal)'
    });
    appendHistory({
      timestamp: Math.floor(Date.now() / 1000),
      scalp_signal: scalpSignal || null,
      regime_signal: regimeSignal || null,
      chosen_strategy: 'NONE',
      final_action: 'SKIP',
      final_score: 0,
      reason: 'no qualifying signal'
    });
    return {
      action: 'SKIP',
      chosenStrategy: 'NONE',
      signal: null,
      finalScore: 0,
      reason: 'no qualifying signal',
      skipReasons: ['no_signal']
    };
  }

  const gateCtx = {
    accounts,
    assets,
    lastEntries: hourlyEntries,
    lastEntryBySymbol,
    recentTrades,
    wsLagMs
  };
  const gate = riskGate.checkAll(gateCtx, signal.symbol, finalScore);
  const openPositionCount = riskGate.countOpenPositions(accounts);

  explainLogger.log({
    symbol: signal.symbol,
    source_strategy: chosen,
    action: 'RISK_GATE_DONE',
    risk_gate_allowed: gate.allowed,
    risk_gate_reasons: gate.reasons,
    open_position_count: openPositionCount,
    ws_lag_ms: wsLagMs,
    final_orchestrator_score: finalScore,
    threshold_entry: signalComparator.getThreshold(),
    min_orchestrator_score: runtimeStrategyConfig.getMinOrchestratorScore(),
    daily_loss_state: assets ? ((assets.totalBuyKrw > 0 && assets.totalEvaluationKrw != null) ? ((assets.totalEvaluationKrw - assets.totalBuyKrw) / assets.totalBuyKrw) * 100 : null) : null,
    duplicate_cooldown_hit: gate.reasons.includes('duplicate_cooldown'),
    reason_summary: gate.allowed ? 'risk_gate_ok' : 'risk_gate:' + gate.reasons.join(',')
  });

  if (!gate.allowed) {
    logTag('[ORCH_DECISION]', `action=SKIP chosen=${chosen} reason=risk_gate`);
    logTag('[SKIP_REASON]', `reason=${gate.reasons.join(', ')}`);
    const skipReason = gate.reasons.includes('score_below_threshold') ? 'score_below_threshold' : gate.reasons[0] || 'risk_gate';
    explainLogger.log({
      symbol: signal.symbol,
      source_strategy: chosen,
      action: 'SKIP',
      skip_reason: skipReason,
      risk_gate_allowed: false,
      risk_gate_reasons: gate.reasons,
      final_orchestrator_score: finalScore,
      normalized_score: signal.score,
      threshold_entry: signalComparator.getThreshold(),
      min_orchestrator_score: runtimeStrategyConfig.getMinOrchestratorScore(),
      reason_summary: `SKIP(${skipReason})`
    });
    appendHistory({
      timestamp: Math.floor(Date.now() / 1000),
      scalp_signal: scalpSignal || null,
      regime_signal: regimeSignal || null,
      chosen_strategy: chosen,
      final_action: 'SKIP',
      final_score: finalScore,
      reason: 'risk_gate: ' + gate.reasons.join(', ')
    });
    return {
      action: 'SKIP',
      chosenStrategy: chosen,
      signal,
      finalScore,
      reason: 'risk_gate',
      skipReasons: gate.reasons
    };
  }

  const conflict = positionConflictResolver.allowEntry(signal.symbol, chosen === 'CONSENSUS' ? 'REGIME' : chosen, positionSymbols);
  if (!conflict.allowed) {
    logTag('[CONFLICT]', `symbol=${signal.symbol} reason=${conflict.reason}`);
    logTag('[ORCH_DECISION]', 'action=SKIP reason=position_conflict');
    explainLogger.log({
      symbol: signal.symbol,
      source_strategy: chosen,
      action: 'SKIP',
      skip_reason: 'position_conflict',
      reason_details: conflict.reason,
      final_orchestrator_score: finalScore,
      threshold_entry: signalComparator.getThreshold(),
      min_orchestrator_score: runtimeStrategyConfig.getMinOrchestratorScore(),
      reason_summary: 'SKIP(position_conflict)'
    });
    return {
      action: 'SKIP',
      chosenStrategy: chosen,
      signal,
      finalScore,
      reason: conflict.reason,
      skipReasons: [conflict.reason]
    };
  }

  const threshold = signalComparator.getThreshold();
  if (finalScore < threshold) {
    logTag('[ORCH_DECISION]', `action=SKIP chosen=${chosen} reason=below threshold ${finalScore.toFixed(2)} < ${threshold}`);
    logTag('[SKIP_REASON]', 'reason=both below threshold');
    explainLogger.log({
      symbol: signal.symbol,
      source_strategy: chosen,
      action: 'SKIP',
      skip_reason: 'score_below_threshold',
      final_orchestrator_score: finalScore,
      normalized_score: signal.score,
      threshold_entry: threshold,
      min_orchestrator_score: runtimeStrategyConfig.getMinOrchestratorScore(),
      reason_summary: 'SKIP(score_below_threshold)'
    });
    return {
      action: 'SKIP',
      chosenStrategy: chosen,
      signal,
      finalScore,
      reason: 'below_threshold',
      skipReasons: ['score_below_threshold']
    };
  }

  explainLogger.log({
    symbol: signal.symbol,
    source_strategy: chosen,
    action: 'BUY',
    skip_reason: null,
    raw_entry_score: scalpSignal && signal.symbol === scalpSignal.symbol ? (scalpState['KRW-' + signal.symbol]?.entryScore) : null,
    entry_score_min: entryScoreMin,
    normalized_score: signal.score,
    confidence: signal.confidence,
    expected_edge: signal.expected_edge,
    risk_level: signal.risk_level,
    final_orchestrator_score: finalScore,
    threshold_entry: threshold,
    min_orchestrator_score: runtimeStrategyConfig.getMinOrchestratorScore(),
    risk_gate_allowed: true,
    reason_summary: `BUY ${signal.symbol} (${reason})`
  });

  logTag('[ORCH_DECISION]', `action=ENTER symbol=${signal.symbol} strategy=${chosen} reason="${reason}"`);
  appendHistory({
    timestamp: Math.floor(Date.now() / 1000),
    scalp_signal: scalpSignal || null,
    regime_signal: regimeSignal || null,
    chosen_strategy: chosen,
    final_action: 'ENTER',
    final_score: finalScore,
    reason
  });

  return {
    action: 'ENTER',
    chosenStrategy: chosen,
    signal,
    finalScore,
    reason,
    skipReasons: []
  };
}

function recordEntry(symbol, strategy) {
  const now = Date.now();
  hourlyEntries.push({ symbol, timestamp: now });
  if (hourlyEntries.length > MAX_HOURLY_ENTRIES) hourlyEntries.splice(0, hourlyEntries.length - MAX_HOURLY_ENTRIES);
  lastEntryBySymbol[symbol] = now;
  positionConflictResolver.setPositionOwner(symbol, strategy === 'CONSENSUS' ? 'REGIME' : strategy);
}

/** 초 scalp 경량 risk gate용 — 동일 심볼 cooldown 공유 */
function getLastEntryBySymbol() {
  return { ...lastEntryBySymbol };
}

const THIRTY_MIN_MS = 30 * 60 * 1000;

function parseLogMessage(tag, message) {
  const m = (message || '').trim();
  const out = { tag };
  if (tag === '[REGIME_SIGNAL]' || tag === '[SCALP_SIGNAL]') {
    const symbol = m.match(/symbol=(\S+)/)?.[1] || '—';
    const score = m.match(/score=([\d.]+)/)?.[1];
    const confidence = m.match(/confidence=([\d.]+)/)?.[1];
    const side = m.match(/side=(\w+)/)?.[1] || '—';
    const regime = m.match(/regime=(\S+)/)?.[1] || '—';
    out.symbol = symbol;
    out.score = score;
    out.confidence = confidence;
    out.side = side;
    out.regime = regime;
  } else if (tag === '[ORCH_COMPARE]') {
    out.scalp = m.match(/scalp=([\d.]+)/)?.[1];
    out.regime = m.match(/regime=([\d.]+)/)?.[1];
    out.final = m.match(/final=([\d.]+)/)?.[1];
    out.chosen = m.match(/chosen=(\w+)/)?.[1];
  } else if (tag === '[ORCH_DECISION]') {
    out.action = m.match(/action=(\w+)/)?.[1];
    out.chosen = m.match(/chosen=(\w+)/)?.[1];
    out.reason = m.match(/reason=([^\s"]+)/)?.[1];
    out.symbol = m.match(/symbol=(\w+)/)?.[1];
    out.strategy = m.match(/strategy=(\w+)/)?.[1];
  } else if (tag === '[SKIP_REASON]') {
    out.reason = m.replace(/^reason=/, '').trim() || '—';
  }
  return out;
}

/**
 * 의사결정 로그를 30분 단위로 묶어 인간 언어 요약 생성
 * @param {Array<{ ts: number, tag: string, message: string }>} log
 * @returns {Array<{ periodStart: number, periodEnd: number, periodLabel: string, summary: string }>}
 */
function getDecisionSummary30Min(log) {
  if (!log || log.length === 0) return [];
  const byBucket = new Map();
  for (const entry of log) {
    const ts = entry.ts || Date.now();
    const bucket = Math.floor(ts / THIRTY_MIN_MS) * THIRTY_MIN_MS;
    if (!byBucket.has(bucket)) byBucket.set(bucket, []);
    byBucket.get(bucket).push({ ...entry, ts });
  }
  const sortedBuckets = [...byBucket.keys()].sort((a, b) => b - a);
  const result = [];
  for (const bucketStart of sortedBuckets) {
    const entries = byBucket.get(bucketStart).sort((a, b) => a.ts - b.ts);
    const parsed = entries.map((e) => ({ ...parseLogMessage(e.tag, e.message), ts: e.ts }));
    const regimeSignal = parsed.find((p) => p.tag === '[REGIME_SIGNAL]');
    const scalpSignal = parsed.find((p) => p.tag === '[SCALP_SIGNAL]');
    const compare = parsed.find((p) => p.tag === '[ORCH_COMPARE]');
    const decision = parsed.find((p) => p.tag === '[ORCH_DECISION]');
    const skipReason = parsed.find((p) => p.tag === '[SKIP_REASON]');

    let summary = '';
    const chosen = decision?.chosen || compare?.chosen || '—';
    const action = decision?.action || '—';
    const reason = decision?.reason || skipReason?.reason || '—';

    if (action === 'ENTER' && decision?.symbol) {
      summary = `${chosen} 봇이 ${decision.symbol} ${decision.symbol ? '진입' : ''} 실행. 사유: ${reason}.`;
    } else {
      const signalSource = regimeSignal ? 'REGIME' : (scalpSignal ? 'SCALP' : '—');
      const symbol = regimeSignal?.symbol || scalpSignal?.symbol || '—';
      const confidence = regimeSignal?.confidence || scalpSignal?.confidence || '—';
      const regimeCtx = regimeSignal?.regime || '—';
      const side = regimeSignal?.side || scalpSignal?.side || '—';
      const scalpScore = compare?.scalp ?? '—';
      const regimeScore = compare?.regime ?? '—';
      const finalScore = compare?.final ?? '—';

      const hasSignal = (signalSource !== '—' && symbol !== '—');
      if (hasSignal) {
        summary = `${chosen} 봇이 ${symbol} ${side === 'BUY' ? '매수' : side === 'SELL' ? '매도' : side} 신호`;
        if (confidence !== '—') summary += `(신뢰도 ${confidence}`;
        if (regimeCtx !== '—') summary += (confidence !== '—' ? ', ' : '(') + `${regimeCtx}`;
        if (confidence !== '—' || regimeCtx !== '—') summary += ')';
        summary += '를 냈으나 ';
      }
      if (reason === 'risk_gate') summary += '리스크 게이트로 진입 스킵.';
      else if (reason && reason.includes('threshold')) summary += '점수 기준 미달로 스킵.';
      else if (reason === 'position_conflict') summary += '포지션 충돌로 스킵.';
      else if (reason) summary += `사유: ${reason}로 스킵.`;
      else summary += '진입하지 않음.';
      if (scalpScore !== '—' || regimeScore !== '—' || finalScore !== '—') {
        summary += ` SCALP ${scalpScore} vs REGIME ${regimeScore} → 최종 ${finalScore}(${chosen} 선택).`;
      }
    }

    const bucketEnd = bucketStart + THIRTY_MIN_MS - 1;
    const startDate = new Date(bucketStart);
    const endDate = new Date(bucketEnd);
    const periodLabel = startDate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) + '~' + endDate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    result.push({ periodStart: bucketStart, periodEnd: bucketEnd, periodLabel, summary: summary || '의사결정 없음' });
  }
  return result.sort((a, b) => b.periodStart - a.periodStart);
}

function getDecisionLog() {
  return [...decisionLog];
}

function getHistoryPath() {
  return HISTORY_FILE;
}

function readHistoryLines(n = 50) {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const content = fs.readFileSync(HISTORY_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.slice(-n).map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

module.exports = {
  tick,
  recordEntry,
  getLastEntryBySymbol,
  getDecisionLog,
  getDecisionSummary30Min,
  getHistoryPath,
  readHistoryLines,
  appendHistory,
  logTag,
  THRESHOLD_ENTRY: signalComparator.THRESHOLD_ENTRY
};
