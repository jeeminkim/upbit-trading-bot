/**
 * 오케스트레이터 최종 단계 안전장치
 * - max_open_positions, hourly_entry_limit, duplicate cooldown, stale/ws block, daily loss, consecutive loss halt
 */

const DEFAULT = {
  max_open_positions: 4,
  hourly_entry_limit: 12,
  duplicate_cooldown_minutes: 30,
  daily_loss_limit_pct: -1.5,
  consecutive_loss_halt: 3,
  min_orchestrator_score: 0.62
};

let options = { ...DEFAULT };

function setOptions(opts) {
  if (opts && typeof opts === 'object') options = { ...options, ...opts };
}

function getOptions() {
  return { ...options };
}

/** 현재 오픈 포지션 수 (KRW 제외 코인 보유 종목 수) */
function countOpenPositions(accounts) {
  if (!Array.isArray(accounts)) return 0;
  return accounts.filter((a) => (a.currency || '').toUpperCase() !== 'KRW' && parseFloat(a.balance || 0) > 0).length;
}

/** 시간당 진입 횟수 제한: lastEntries = [{ timestamp }] */
function isWithinHourlyLimit(lastEntries, limit) {
  const cap = limit != null ? limit : options.hourly_entry_limit;
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const recent = (lastEntries || []).filter((e) => e && e.timestamp >= hourAgo);
  return recent.length < cap;
}

/** 동일 심볼 중복 진입 쿨다운 (분) */
function isInCooldown(symbol, lastEntryBySymbol, cooldownMinutes) {
  const min = cooldownMinutes != null ? cooldownMinutes : options.duplicate_cooldown_minutes;
  const last = lastEntryBySymbol && lastEntryBySymbol[symbol];
  if (!last) return false;
  return Date.now() - last < min * 60 * 1000;
}

/** 일일 손실 한도 (assets.totalBuyKrw, totalEvaluationKrw 기준) */
function isDailyLossBreach(assets, dailyLossLimitPct) {
  const limit = dailyLossLimitPct != null ? dailyLossLimitPct : options.daily_loss_limit_pct;
  if (limit >= 0) return false;
  const buy = assets?.totalBuyKrw ?? 0;
  const evalKrw = assets?.totalEvaluationKrw ?? 0;
  if (buy <= 0) return false;
  const pct = ((evalKrw - buy) / buy) * 100;
  return pct <= limit;
}

/** 연속 손실 N회 시 진입 차단 (recentTrades: [{ net_return }]) */
function isConsecutiveLossHalt(recentTrades, n) {
  const limit = n != null ? n : options.consecutive_loss_halt;
  const trades = (recentTrades || []).slice(0, limit);
  if (trades.length < limit) return false;
  return trades.every((t) => (t.net_return != null ? t.net_return < 0 : false));
}

/** 데이터 품질 / stale / ws 불안정 시 차단 */
function isDataQualityBlocked(wsLagMs, maxWsLagMs, staleThresholdMs) {
  const maxLag = maxWsLagMs != null ? maxWsLagMs : 2000;
  const stale = staleThresholdMs != null ? staleThresholdMs : 5000;
  if (wsLagMs != null && wsLagMs > maxLag) return { block: true, reason: 'ws_lag' };
  return { block: false };
}

/**
 * 통합 게이트: 진입 허용 여부 및 사유
 * @param {Object} ctx - { accounts, assets, lastEntries, lastEntryBySymbol, recentTrades, wsLagMs }
 * @param {string} symbol
 * @param {number} finalScore
 */
function checkAll(ctx, symbol, finalScore) {
  const reasons = [];
  const accounts = ctx.accounts || [];
  const openCount = countOpenPositions(accounts);
  if (openCount >= options.max_open_positions) {
    reasons.push('max_open_positions');
  }
  if (!isWithinHourlyLimit(ctx.lastEntries, options.hourly_entry_limit)) {
    reasons.push('hourly_entry_limit');
  }
  if (isInCooldown(symbol, ctx.lastEntryBySymbol, options.duplicate_cooldown_minutes)) {
    reasons.push('duplicate_cooldown');
  }
  if (ctx.assets && isDailyLossBreach(ctx.assets, options.daily_loss_limit_pct)) {
    reasons.push('daily_loss_limit');
  }
  if (ctx.recentTrades && isConsecutiveLossHalt(ctx.recentTrades, options.consecutive_loss_halt)) {
    reasons.push('consecutive_loss_halt');
  }
  const dq = isDataQualityBlocked(ctx.wsLagMs, 2000);
  if (dq.block) reasons.push(dq.reason);
  if (finalScore < options.min_orchestrator_score) {
    reasons.push('score_below_threshold');
  }
  return {
    allowed: reasons.length === 0,
    reasons
  };
}

/**
 * 초 scalp 경량 risk gate — daily loss, ws_lag, symbol cooldown 만 적용
 * @param {Object} ctx - { assets, wsLagMs, lastEntryBySymbol, recentTrades }
 * @param {string} symbol
 * @param {{ daily_loss_limit_pct?: number, duplicate_cooldown_minutes?: number, max_ws_lag_ms?: number }} [opts]
 * @returns {{ allowed: boolean, reasons: string[] }}
 */
function checkScalpLight(ctx, symbol, opts) {
  const reasons = [];
  const limitPct = opts?.daily_loss_limit_pct != null ? opts.daily_loss_limit_pct : options.daily_loss_limit_pct;
  const cooldownMin = opts?.duplicate_cooldown_minutes != null ? opts.duplicate_cooldown_minutes : options.duplicate_cooldown_minutes;
  const maxWsLag = opts?.max_ws_lag_ms != null ? opts.max_ws_lag_ms : 2000;

  if (ctx.assets && isDailyLossBreach(ctx.assets, limitPct)) {
    reasons.push('daily_loss_limit');
  }
  const dq = isDataQualityBlocked(ctx.wsLagMs, maxWsLag);
  if (dq.block) reasons.push(dq.reason || 'ws_lag');
  if (isInCooldown(symbol, ctx.lastEntryBySymbol, cooldownMin)) {
    reasons.push('duplicate_cooldown');
  }

  return {
    allowed: reasons.length === 0,
    reasons
  };
}

module.exports = {
  setOptions,
  getOptions,
  countOpenPositions,
  isWithinHourlyLimit,
  isInCooldown,
  isDailyLossBreach,
  isConsecutiveLossHalt,
  isDataQualityBlocked,
  checkAll,
  checkScalpLight,
  DEFAULT
};
