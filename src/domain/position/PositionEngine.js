/**
 * PositionEngine — 수익률 계산(PROFIT_CALC_SPEC 100% 준수), state.assets 연동, ExitPolicy(손절/익절 감시)
 * 업비트 표준: 분모=총매수(코인만), 분자=평가금(코인만). 보유 KRW/전체자산 사용 금지.
 */

const path = require('path');
const TradeExecutor = require(path.join(__dirname, '../../../lib/TradeExecutor'));
const { calculateNetProfitPct } = require(path.join(__dirname, '../../shared/utils/math'));
const { UPBIT_FEE_RATE } = require(path.join(__dirname, '../../shared/constants'));
const ExitPolicy = require(path.join(__dirname, 'ExitPolicy'));

/**
 * PROFIT_CALC_SPEC: totalBuyKrwForCoins(분모), evaluationKrwForCoins(분자)만 사용. 수수료 0.05% 반영.
 * @param {Object} assets - summarizeAccounts 결과 (totalBuyKrwForCoins, evaluationKrwForCoins)
 * @returns {{ totalBuyKrwForCoins: number, evaluationKrwForCoins: number, profitPct: number }}
 */
function getProfitFromAssets(assets) {
  const totalBuy = Number(assets?.totalBuyKrwForCoins ?? 0) || 0;
  const evalCoins = Number(assets?.evaluationKrwForCoins ?? 0) || 0;
  const profitPct = calculateNetProfitPct(totalBuy, evalCoins, UPBIT_FEE_RATE);
  return {
    totalBuyKrwForCoins: totalBuy,
    evaluationKrwForCoins: evalCoins,
    profitPct
  };
}

/**
 * 대시보드/디스코드와 동일한 수치 노출용 (기존 getProfitPct와 동일 식)
 * @param {Object} assets
 * @returns {number} 수익률 %
 */
function getProfitPct(assets) {
  return getProfitFromAssets(assets).profitPct;
}

/**
 * 청산 신호 — domain ExitPolicy 사용 (내부는 LegacyExitBridge → TradeExecutor.checkExit)
 * @param {Object} position - { entryPrice, entryTimeMs, strengthPeak60s?, highSinceEntry? }
 * @param {Object} snapshot - 현재 호가·체결 스냅샷
 * @param {number} currentPrice
 * @param {number|null} currentEntryScore
 * @returns {{ exit: boolean, reason?: string }}
 */
function getExitSignal(position, snapshot, currentPrice, currentEntryScore) {
  return ExitPolicy.evaluate(position, snapshot, currentPrice, currentEntryScore);
}

/**
 * @param {Object} [stateStore] - get()으로 assets 읽을 때 사용 (선택)
 */
function PositionEngine(stateStore) {
  this.stateStore = stateStore || null;
}

PositionEngine.prototype.getProfitFromAssets = function (assets) {
  const a = assets != null ? assets : (this.stateStore && this.stateStore.get().assets);
  return getProfitFromAssets(a);
};

PositionEngine.prototype.getProfitPct = function (assets) {
  const a = assets != null ? assets : (this.stateStore && this.stateStore.get().assets);
  return getProfitPct(a);
};

PositionEngine.prototype.getExitSignal = function (position, snapshot, currentPrice, currentEntryScore) {
  return getExitSignal(position, snapshot, currentPrice, currentEntryScore);
};

module.exports = PositionEngine;
module.exports.getProfitFromAssets = getProfitFromAssets;
module.exports.getProfitPct = getProfitPct;
module.exports.getExitSignal = getExitSignal;
