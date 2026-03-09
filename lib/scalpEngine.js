/**
 * SCALP 모드 전용 로직 (SCALP_LOGIC_FOR_NODEJS.md 명세 기반)
 * - 프로필·경주마: StrategyManager 위임 (단일 소스)
 * - Entry Score: EntryScoreCalculator 사용 (확장 가능)
 * - P0 게이트, Vol Surge, 청산 판단, runEntryPipeline 제공
 */

const path = require('path');
const fs = require('fs');
const StrategyManager = require('./StrategyManager');
const configDefault = require('../config.default');
const { computeScore: computeEntryScore } = require('./EntryScoreCalculator');

// 호가단위 (Upbit KRW 마켓 근사). prev_high + entry_tick_buffer * tickSize
const TICK_SIZE_BY_MARKET = {
  'KRW-BTC': 1000,
  'KRW-ETH': 100,
  'KRW-XRP': 1,
  'KRW-SOL': 10
};
function getTickSize(market) {
  return TICK_SIZE_BY_MARKET[market] ?? 1;
}

// ---------- 1. 프로필: StrategyManager 위임 (config.default 기본값) ----------
const DEFAULT_PROFILE = configDefault.DEFAULT_PROFILE;
const RACE_HORSE_OVERRIDES = configDefault.RACE_HORSE_OVERRIDES;

function setProfile(overrides) {
  StrategyManager.setProfile(overrides);
}

function getProfile() {
  return StrategyManager.getProfile();
}

function setRaceHorseActive(active) {
  StrategyManager.setRaceHorseActive(active);
}

function isRaceHorseActive() {
  return StrategyManager.isRaceHorseActive();
}

// ---------- 2. P0 게이트: 진입 금지 여부 (명세 Step 1) ----------
// 반환: { allowed: boolean, reason?: string }
function checkEntryGates(snapshot) {
  if (!snapshot) return { allowed: false, reason: 'BLOCK_LIQUIDITY' };
  const profile = getProfile();

  const kimpLimit = profile.kimp_block_pct != null ? profile.kimp_block_pct : 3;
  if (snapshot.kimp_pct != null && kimpLimit < 100 && snapshot.kimp_pct > kimpLimit) {
    return { allowed: false, reason: 'BLOCK_KIMP' };
  }

  if (snapshot.spread_anomaly_blocked || snapshot.flow_anomaly_blocked) {
    return { allowed: false, reason: 'BLOCK_LIQUIDITY' };
  }

  const spreadRatio = snapshot.spread_ratio != null
    ? snapshot.spread_ratio
    : (snapshot.spread_pct != null ? snapshot.spread_pct * 0.01 : null);
  if (spreadRatio != null) {
    const median = snapshot.median_spread_60s;
    const maxSpread = median != null
      ? Math.max(profile.max_spread_pct, median * 1.5)
      : profile.max_spread_pct;
    if (spreadRatio > maxSpread) return { allowed: false, reason: 'BLOCK_SPREAD' };
  }

  const depthBid = snapshot.topN_depth_bid ?? 0;
  const depthAsk = snapshot.topN_depth_ask ?? 0;
  if (depthBid < profile.min_depth_qty || depthAsk < profile.min_depth_qty) {
    return { allowed: false, reason: 'BLOCK_LIQUIDITY' };
  }

  if (snapshot.rest_latency_ms != null && snapshot.rest_latency_ms > profile.rest_latency_ms_max) {
    return { allowed: false, reason: 'BLOCK_LAG' };
  }
  if (snapshot.ws_lag_ms != null && snapshot.ws_lag_ms > profile.ws_lag_ms_max) {
    return { allowed: false, reason: 'BLOCK_LAG' };
  }

  const slippageBps = snapshot.realized_slippage_bps_avg;
  if (slippageBps != null && slippageBps > profile.slippage_shutdown_bps) {
    return { allowed: false, reason: 'BLOCK_SLIPPAGE' };
  }

  return { allowed: true };
}

// ---------- 3. Vol Surge (명세 Step 2) ----------
function getVolSurge(snapshot) {
  if (snapshot.vol_surge_final != null) return !!snapshot.vol_surge_final;
  const profile = getProfile();
  const vol10s = snapshot.vol_now_krw_10s ?? snapshot.vol_krw_10s ?? snapshot.krw_notional_10s ?? 0;
  const baseline = snapshot.vol_baseline_krw_10s_used ?? snapshot.vol_surge_baseline_notional ?? 0;
  if (baseline <= 0) return false;
  return vol10s >= baseline * profile.volume_multiplier;
}

// ---------- 4. Entry Score: Final_Score = (항목별 충족여부 × 사용자 설정 가중치) 합 ----------
function entryScore(snapshot, priceBreak, volSurge) {
  const gates = snapshot ? checkEntryGates(snapshot) : { allowed: true, reason: null };
  const p0Reason = gates.allowed ? null : (gates.reason || 'BLOCK_LIQUIDITY');
  return entryScoreWeighted(snapshot, priceBreak, volSurge, p0Reason);
}

/** Entry Score: EntryScoreCalculator 사용 (가중치·지표 확장 가능) */
function entryScoreWeighted(snapshot, priceBreak, volSurge, p0Reason) {
  return computeEntryScore(getProfile(), snapshot, priceBreak, volSurge, p0Reason);
}

// ---------- 5. 청산·익절 판단 (명세 섹션 4 + Take-Profit) ----------
// position: { entryPrice, entryTimeMs, strengthPeak60s, highSinceEntry? }
// currentEntryScore: 보유 중 실시간 Entry Score (score_out 판단용)
// 반환: { exit: boolean, reason?: string }  reason 예: 'take_profit_target' | 'trailing_stop' | 'score_out' | 'time_stop' | 'stop' | 'weakness'
function shouldExitScalp(position, snapshot, currentPrice, currentEntryScore) {
  if (!position || !snapshot) return { exit: false };
  const profile = getProfile();

  const entryTimeMs = position.entryTimeMs;
  if (entryTimeMs != null && entryTimeMs > 0) {
    const holdSec = (Date.now() - entryTimeMs) / 1000;
    if (holdSec >= profile.time_stop_sec) {
      return { exit: true, reason: 'time_stop' };
    }
  }
  // entryTimeMs 없음(외부 매수/미기록)이면 time_stop 미적용, 익절/손절/트레일링만 적용

  const netReturnPct = (currentPrice - position.entryPrice) / position.entryPrice * 100 - (profile.fee_rate_est != null ? profile.fee_rate_est * 100 * 2 : 0);
  if (netReturnPct <= profile.stop_loss_pct) {
    return { exit: true, reason: 'stop' };
  }

  const targetPct = profile.take_profit_target_pct != null ? profile.take_profit_target_pct : profile.min_take_profit_floor_pct;
  if (targetPct != null && targetPct > 0 && netReturnPct >= targetPct) {
    return { exit: true, reason: 'take_profit_target' };
  }

  const highSinceEntry = position.highSinceEntry != null ? position.highSinceEntry : currentPrice;
  const trailingPct = profile.trailing_stop_pct;
  if (trailingPct != null && trailingPct > 0 && highSinceEntry > 0) {
    const dropFromHighPct = (highSinceEntry - currentPrice) / highSinceEntry * 100;
    if (dropFromHighPct >= trailingPct) {
      return { exit: true, reason: 'trailing_stop' };
    }
  }

  const scoreOut = profile.score_out_threshold;
  if (scoreOut != null && currentEntryScore != null && !Number.isNaN(Number(currentEntryScore)) && Number(currentEntryScore) <= scoreOut) {
    return { exit: true, reason: 'score_out' };
  }

  if (netReturnPct >= (profile.min_take_profit_floor_pct || 0)) {
    const peak = position.strengthPeak60s ?? snapshot.strength_peak_60s ?? 1;
    const strength = snapshot.strength_for_score ?? snapshot.strength_proxy_60s ?? 0;
    if (strength <= peak * (1 - profile.weakness_drop_ratio)) {
      return { exit: true, reason: 'weakness' };
    }
    const obi = snapshot.obi_topN ?? 0;
    if (obi < -0.3) return { exit: true, reason: 'weakness' };
  }

  return { exit: false };
}

/** 익절/청산 사유에 대한 로그용 한글 라벨 (예: "익절 완료 (사유: 트레일링 스탑)") */
function getExitReasonLabel(reason) {
  const map = {
    take_profit_target: '목표 익절',
    trailing_stop: '트레일링 스탑',
    score_out: '강제 익절(Score-out)',
    time_stop: '타임스탑',
    stop: '손절',
    weakness: '지표 약화'
  };
  return map[reason] || reason || '청산';
}

// ---------- 6. 진입 파이프라인 Step 1~4 순차 실행 (명세 섹션 3) ----------
// snapshot, prevHigh(과거 구간 high), currentPrice, market(틱 크기용), marketContext(선택, Greedy 시 사용)
// 반환: { p0Allowed, p0Reason, volSurge, priceBreak, score, marketScore, quantityMultiplier }
function runEntryPipeline(snapshot, prevHigh, currentPrice, market, marketContext = null, availableKrw = null) {
  const profile = getProfile();
  const tickSize = getTickSize(market || '');
  const bufferTicks = profile.entry_tick_buffer;
  const result = {
    p0Allowed: false,
    p0Reason: null,
    volSurge: false,
    priceBreak: false,
    score: 0,
    marketScore: null,
    quantityMultiplier: 1.0
  };

  const minOrderKrw = configDefault.MIN_ORDER_KRW != null ? configDefault.MIN_ORDER_KRW : 5000;
  if (availableKrw != null && availableKrw < minOrderKrw) {
    result.p0Allowed = false;
    result.p0Reason = 'MIN_ORDER_KRW';
    return result;
  }

  const gates = checkEntryGates(snapshot);
  result.p0Allowed = gates.allowed;
  result.p0Reason = gates.allowed ? null : (gates.reason || 'BLOCK_LIQUIDITY');

  if (profile.greedy_mode && marketContext != null) {
    result.marketScore = marketContext.marketScore != null ? marketContext.marketScore : null;
    if (marketContext.blockReason === 'BLOCK_MARKET_CRASH') {
      result.p0Allowed = false;
      result.p0Reason = 'BLOCK_MARKET_CRASH';
      result.quantityMultiplier = 0;
    } else {
      const maxBet = profile.max_bet_multiplier != null ? profile.max_bet_multiplier : 2;
      const score = marketContext.marketScore != null ? marketContext.marketScore : 0;
      if (profile.aggressive_mode && score >= 70) {
        result.quantityMultiplier = maxBet;
      } else {
        result.quantityMultiplier = marketContext.recommendedMultiplier != null
          ? Math.min(maxBet, Math.max(0.1, marketContext.recommendedMultiplier))
          : 1.0;
      }
    }
  }

  result.volSurge = getVolSurge(snapshot);

  if (prevHigh != null && currentPrice != null && bufferTicks != null && tickSize != null) {
    const threshold = prevHigh + bufferTicks * tickSize;
    result.priceBreak = currentPrice > threshold;
  }

  result.score = entryScoreWeighted(snapshot, result.priceBreak, result.volSurge, result.p0Reason);
  return result;
}

// ---------- MPI 기반 포지션 사이징 배율 (다이내믹 수량) ----------
// MPI 점수 구간별 수량 배율: 과열(축소), 추세강화(증액), 관심저조(기본), 냉각(축소)
function getMpiPositionMultiplier(mpi) {
  if (mpi == null || mpi === '' || isNaN(Number(mpi))) return 1.0;
  const n = Number(mpi);
  if (n >= 80 && n <= 100) return 0.5;   // 과열: 50%
  if (n >= 50 && n < 80) return 1.2;    // 추세 강화: 120%
  if (n >= 20 && n < 50) return 1.0;    // 관심 저조: 100%
  if (n >= 0 && n < 20) return 0.7;     // 냉각: 70%
  if (n > 100) return 0.5;
  return 1.0;
}

/**
 * 매수 주문에 사용할 금액(KRW) 결정 — 경주마 모드·실시간 가동 시간대·공격적 승인 종목에 따라 분기
 * - 버튼 OFF 또는 9~10시 아님: 프로필 min_order_krw 사용. symbol이 공격적 승인 종목이면 maxInvestment 2배 상한 적용.
 * - 버튼 ON이고 9~10시(실시간 가동 중)일 때만: (보유 KRW + 총 코인 평가액)의 50%로 시장가 매수
 * @param {{ orderableKrw: number, totalCoinEval: number, isRaceHorseMode: boolean, isRaceHorseTimeWindow: boolean, minOrderKrw?: number, symbol?: string }} opts
 * @returns {{ amountKrw: number, skipReason?: string }}
 */
function getBuyOrderAmountKrw(opts) {
  const orderableKrw = opts?.orderableKrw ?? 0;
  const totalCoinEval = opts?.totalCoinEval ?? 0;
  const isRaceHorseMode = !!opts?.isRaceHorseMode;
  const isRaceHorseTimeWindow = !!opts?.isRaceHorseTimeWindow;
  const minOrderKrw = opts?.minOrderKrw != null ? opts.minOrderKrw : (configDefault.MIN_ORDER_KRW ?? 5000);
  const symbol = (opts?.symbol || '').toUpperCase().replace(/^KRW-/, '');

  if (orderableKrw < minOrderKrw) {
    return { amountKrw: 0, skipReason: 'MIN_ORDER_KRW' };
  }

  const use50Percent = isRaceHorseMode && isRaceHorseTimeWindow;
  if (!use50Percent) {
    const profile = getProfile();
    let baseKrw = profile.min_order_krw != null ? profile.min_order_krw : 10000;
    if (symbol && getAggressiveSymbols().includes(symbol)) {
      baseKrw = Math.min(orderableKrw, baseKrw * 2);
    }
    const amountKrw = Math.max(minOrderKrw, Math.min(orderableKrw, baseKrw));
    return { amountKrw };
  }

  // 실시간 가동 중: (보유 KRW + 총 코인 평가액)의 50%, 가용 KRW 초과 불가
  const total = orderableKrw + totalCoinEval;
  let amountKrw = Math.floor(total * 0.5);
  amountKrw = Math.min(orderableKrw, amountKrw);
  if (amountKrw < minOrderKrw) {
    return { amountKrw: 0, skipReason: 'MIN_ORDER_KRW' };
  }
  return { amountKrw };
}

// ---------- AI 승인 공격적 매매: 특정 티커 가중치·진입 조건 완화 (4시간 유지) ----------
const aggressiveSymbols = {}; // symbol (대문자) -> { until: number }

function setAggressiveSymbol(symbol, ttlMs) {
  const sym = (symbol || '').toUpperCase().replace(/^KRW-/, '');
  if (!sym) return;
  aggressiveSymbols[sym] = { until: Date.now() + (ttlMs || 4 * 60 * 60 * 1000) };
}

function clearAggressiveSymbol(symbol) {
  const sym = (symbol || '').toUpperCase().replace(/^KRW-/, '');
  if (sym) delete aggressiveSymbols[sym];
}

/** 만료된 항목 제거 후, 현재 유효한 대형주 승인 종목 목록 반환 */
function getAggressiveSymbols() {
  const now = Date.now();
  const list = [];
  for (const [sym, data] of Object.entries(aggressiveSymbols)) {
    if (data && data.until > now) list.push(sym);
    else delete aggressiveSymbols[sym];
  }
  return list;
}

/** 해당 티커 가중치 유효 남은 시간(ms). 없거나 만료면 0 */
function getAggressiveSymbolRemainingMs(symbol) {
  const sym = (symbol || '').toUpperCase().replace(/^KRW-/, '');
  const data = aggressiveSymbols[sym];
  if (!data || !data.until) return 0;
  const remaining = data.until - Date.now();
  return remaining > 0 ? remaining : 0;
}

/** 해당 종목이 공격적 매매 승인 상태면 1.5~2배, 아니면 1 */
function getSymbolWeightMultiplier(symbol) {
  const sym = (symbol || '').toUpperCase().replace(/^KRW-/, '');
  if (getAggressiveSymbols().includes(sym)) return 1.5;
  return 1.0;
}

/** 진입 최소 스코어: AI 가중치 적용 종목은 15% 하향 조정하여 더 공격적 매수 */
function getEffectiveEntryScoreMin(baseMin, market) {
  const sym = (market || '').replace(/^KRW-/, '').toUpperCase();
  if (!getAggressiveSymbols().includes(sym)) return baseMin != null ? baseMin : 4;
  const base = baseMin != null ? baseMin : 4;
  return Math.max(1, Math.floor(base * 0.85));
}

/** Strength 필터: AI 가중치 적용 종목은 기준 완화(0.05 하향, 최소 0.5) */
function getEffectiveStrengthThreshold(profile, market) {
  const sym = (market || '').replace(/^KRW-/, '').toUpperCase();
  const base = profile?.strength_threshold != null ? profile.strength_threshold : 0.55;
  if (!getAggressiveSymbols().includes(sym)) return base;
  return Math.max(0.5, base - 0.05);
}

/** OBI 기준: 경주마+스캘프 동시 가동 시 호가창 지지 확실한 타점만 — threshold 상향 */
function getEffectiveObiThreshold(profile, market, raceHorseScalpOverlap) {
  const base = profile?.obi_threshold != null ? profile.obi_threshold : 0;
  if (!raceHorseScalpOverlap) return base;
  return base + 0.15;
}

module.exports = {
  DEFAULT_PROFILE,
  setProfile,
  getProfile,
  setRaceHorseActive,
  isRaceHorseActive,
  getTickSize,
  checkEntryGates,
  getVolSurge,
  entryScore,
  entryScoreWeighted,
  shouldExitScalp,
  getExitReasonLabel,
  runEntryPipeline,
  getMpiPositionMultiplier,
  getBuyOrderAmountKrw,
  setAggressiveSymbol,
  clearAggressiveSymbol,
  getAggressiveSymbols,
  getAggressiveSymbolRemainingMs,
  getSymbolWeightMultiplier,
  getEffectiveEntryScoreMin,
  getEffectiveStrengthThreshold,
  getEffectiveObiThreshold
};
