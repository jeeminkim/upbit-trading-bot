/**
 * 설정 기본값 (Default Config)
 * - 가중치 0 또는 설정 누락 시에도 시스템이 뻗지 않도록 기본값 보장
 * - 학습 목적: 다른 모듈에서 require('./config.default') 로 안전하게 참조
 */

/** SCALP 프로필 기본값. 0 허용(지표 무시), 누락 시 아래 값 사용 */
const DEFAULT_PROFILE = {
  // P0 진입 금지 필터
  max_spread_pct: 0.001,
  min_depth_qty: 0.001,
  volume_multiplier: 1.3,
  micro_move_threshold: 0.001,
  tail_body_ratio_limit: 1.5,
  rest_latency_ms_max: 500,
  ws_lag_ms_max: 1500,
  kimp_block_pct: 3,
  slippage_shutdown_bps: 5.0,
  // Entry Score 가중치 (0 = 무시, 1 = 표준, 0.5 = 보편 권장)
  entry_tick_buffer: 2,
  strength_threshold: 0.55,
  obi_threshold: 0.1,
  entry_score_min: 4,
  weight_price_break: 1,
  weight_vol_surge: 1,
  weight_obi: 1,
  weight_strength: 1,
  weight_spread: 0.5,
  weight_depth: 0.5,
  weight_kimp: 0.5,
  require_retest: false,
  // 청산
  stop_loss_pct: -0.35,
  time_stop_sec: 150,
  min_take_profit_floor_pct: 0.15,
  weakness_drop_ratio: 0.2,
  take_profit_target_pct: 1.0,
  trailing_stop_pct: 0.5,
  score_out_threshold: 1,
  fee_rate_est: 0.0005,
  // 리스크 캡
  max_trades_per_day: 15,
  loss_streak_limit: 3,
  daily_loss_limit_pct: -1.5,
  min_order_krw: 5000,
  slippage_tolerance_pct: 0.0005,
  // Greedy·모드
  greedy_mode: false,
  max_bet_multiplier: 2.0,
  aggressive_mode: false,
  race_horse_scheduler_enabled: false
};

/** 경주마 모드(08:55~09:10 KST) 적용 시 덮어쓸 가중치 */
const RACE_HORSE_OVERRIDES = {
  weight_vol_surge: 3.0,
  weight_strength: 3.0,
  weight_price_break: 0.5,
  kimp_block_pct: 7
};

/** [🔓 매매 엔진 기준 완화] 4시간 적용 시: RSI·체결강도 하한 완화로 거래 빈도 상승 */
const RELAXED_OVERRIDES = {
  entry_score_min: 2,
  strength_threshold: 0.5
};

/** 업비트 최소 주문 금액 (원) */
const MIN_ORDER_KRW = 5000;

/** 캐시 TTL (ms): 중기 1분, 장기 5분 */
const CACHE_TTL_MEDIUM_MS = 60 * 1000;
const CACHE_TTL_DAILY_MS = 5 * 60 * 1000;

/** 거절 로그 자동 삭제: 기준 시간(시간), 주기(ms) */
const REJECT_LOG_CUTOFF_HOURS = 4;
const CLEANUP_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** API 재시도: 최대 횟수, 대기(ms) */
const API_RETRY_MAX = 3;
const API_RETRY_DELAY_MS = 500;

/**
 * 오케스트레이터 관련 설정
 *
 * DEPRECATED / DO NOT USE FOR RUNTIME DECISION:
 * - entry_threshold, min_score_gate 는 런타임 진입 판단에 사용되지 않습니다.
 * - SOURCE OF TRUTH = lib/runtimeStrategyConfig.js (MODE_PROFILES, getThresholdEntry, getMinOrchestratorScore)
 * - signalComparator / riskGate 는 위 런타임 설정만 참조합니다.
 * - 아래 값은 레거시/문서용이며, 제거해도 런타임 동작에는 영향 없습니다.
 *
 * 사용 중:
 * - normalizer_floor_score: B안. 통과 신호 최저 정규화 점수 (0~1). 설정 시 signalNormalizer에서 사용 (기본 0.35)
 */
const ORCHESTRATOR = {
  /** @deprecated DO NOT USE. 진입 판단은 lib/runtimeStrategyConfig.js 단일 소스 */
  entry_threshold: undefined,
  /** @deprecated DO NOT USE. 진입 판단은 lib/runtimeStrategyConfig.js 단일 소스 */
  min_score_gate: undefined,
  normalizer_floor_score: undefined
};

/**
 * Edge Layer — 신호 품질/체결 품질/리스크 품질 개선 (insertion between strategy signal and position sizing)
 * USE_EDGE_LAYER=1 로 활성화. 모드: observe_only | soft_gate | hard_gate
 */
const EDGE_LAYER = {
  enabled: process.env.USE_EDGE_LAYER === '1' || process.env.USE_EDGE_LAYER === 'true',
  mode: (process.env.EDGE_LAYER_MODE || 'observe_only').toLowerCase(), // observe_only | soft_gate | hard_gate
  edgeThreshold: Number(process.env.EDGE_THRESHOLD) || 0.55,
  // TradeEdgeScore 가중치 (합 1.0)
  weightSignalScore: 0.30,
  weightRegimeScore: 0.25,
  weightVolatilityFactor: 0.15,
  weightLiquidityFactor: 0.15,
  weightSlippageRiskInverse: 0.15,
  // Breakout: 자산별 민감도 (SOL 강화, XRP 완화)
  breakoutFactorByAsset: {
    BTC: 1.0,
    ETH: 1.0,
    SOL: 1.2,
    XRP: 0.8
  },
  // Volume surge: recent_10s / avg_10s_over_5m > threshold
  volumeSurgeThresholdByAsset: {
    BTC: 2.2,
    ETH: 2.2,
    SOL: 2.2,
    XRP: 2.2
  },
  volumeSurgeNeutralFallback: 1.0,
  // true면 recentVolume = 최근 완성된 10초 버킷 (경계 변동성 완화). false면 현재 진행 중 버킷.
  volumeSurgeUseCompletedBucket: false,
  // Liquidity: top3_bid_liquidity_krw > position_size_krw * multiplier
  liquidityMultiplierByAsset: {
    BTC: 3.0,
    ETH: 3.0,
    SOL: 3.5,
    XRP: 4.0
  },
  // Orchestrator 정규화
  normalizerMinSamples: 10,
  normalizerStdEpsilon: 1e-6,
  normalizerOutlierClamp: 3.0,
  // 포지션 사이징: 자산별 기본 allocation (비율 0~1)
  allocationByAsset: {
    BTC: 0.15,
    ETH: 0.15,
    SOL: 0.10,
    XRP: 0.10
  },
  // 초공격 스캘프 max allocation
  aggressiveScalpMaxAllocation: 0.06,
  // 운영 모드 multiplier (SAFE / BALANCED / ACTIVE). OPERATING_MODE env로 전환
  operatingMode: (process.env.OPERATING_MODE || 'A_BALANCED').toUpperCase(),
  modeMultiplier: {
    SAFE: 0.6,
    A_CONSERVATIVE: 0.6,
    A_BALANCED: 1.0,
    A_ACTIVE: 1.4
  },
  // 자산별 전략 프로파일 (signal weighting, threshold, liquidity sensitivity, volatility breakout, mean reversion weight)
  assetProfile: {
    BTC: { signalWeight: 1.0, liquiditySensitivity: 1.0, volatilityBreakout: 1.0, meanReversionWeight: 0.5 },
    ETH: { signalWeight: 1.0, liquiditySensitivity: 1.0, volatilityBreakout: 1.0, meanReversionWeight: 0.5 },
    SOL: { signalWeight: 1.0, liquiditySensitivity: 1.1, volatilityBreakout: 1.2, meanReversionWeight: 0.4 },
    XRP: { signalWeight: 1.0, liquiditySensitivity: 1.1, volatilityBreakout: 0.8, meanReversionWeight: 0.7 }
  }
};

/** 프로필에서 안전하게 숫자 가져오기 (null/undefined 시 기본값) */
function getProfileNum(profile, key, fallback = 0) {
  const v = profile[key];
  if (v == null || Number.isNaN(Number(v))) return fallback;
  return Number(v);
}

/** 가중치 값 보정: 0 허용, 0~3 범위 */
function clampWeight(value) {
  if (value == null || Number.isNaN(parseFloat(value))) return undefined;
  const n = parseFloat(value);
  if (n < 0) return undefined;
  return Math.min(3, n);
}

module.exports = {
  DEFAULT_PROFILE,
  RACE_HORSE_OVERRIDES,
  RELAXED_OVERRIDES,
  MIN_ORDER_KRW,
  CACHE_TTL_MEDIUM_MS,
  CACHE_TTL_DAILY_MS,
  REJECT_LOG_CUTOFF_HOURS,
  CLEANUP_INTERVAL_MS,
  API_RETRY_MAX,
  API_RETRY_DELAY_MS,
  ORCHESTRATOR,
  EDGE_LAYER,
  getProfileNum,
  clampWeight
};
