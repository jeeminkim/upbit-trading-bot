/**
 * 공통 시그널 인터페이스 (SCALP / REGIME 통일)
 * 두 전략 출력을 동일 포맷으로 정규화해 오케스트레이터가 비교할 수 있게 함.
 */

/** @typedef {'SCALP'|'REGIME'} StrategyType */
/** @typedef {'BTC'|'ETH'|'SOL'|'XRP'} SymbolType */
/** @typedef {'BUY'|'SELL'|'NONE'} SideType */
/** @typedef {'short'|'medium'|'long'} ExpectedHorizon */

/**
 * @typedef {Object} UnifiedSignal
 * @property {StrategyType} strategy
 * @property {string} symbol - BTC | ETH | SOL | XRP
 * @property {SideType} side
 * @property {number} score - 0~1
 * @property {number} confidence - 0~1
 * @property {number} expected_edge - 예상 기대수익 점수 (0~1)
 * @property {number} risk_level - 0~1
 * @property {string|null} regime_context - REGIME 전용 (TREND_UP 등)
 * @property {string[]} reasons
 * @property {Object} diagnostics
 * @property {number} timestamp
 * @property {string} [expected_horizon] - short | medium | long
 */

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP'];
const SIDES = ['BUY', 'SELL', 'NONE'];

function createEmptySignal(strategy, symbol, side = 'NONE') {
  return {
    strategy,
    symbol: symbol || 'BTC',
    side,
    score: 0,
    confidence: 0,
    expected_edge: 0,
    risk_level: 1,
    regime_context: null,
    reasons: [],
    diagnostics: {},
    timestamp: Math.floor(Date.now() / 1000),
    expected_horizon: strategy === 'SCALP' ? 'short' : 'medium'
  };
}

function clampScore(v) {
  if (v == null || Number.isNaN(Number(v))) return 0;
  return Math.max(0, Math.min(1, Number(v)));
}

module.exports = {
  SYMBOLS,
  SIDES,
  createEmptySignal,
  clampScore
};
