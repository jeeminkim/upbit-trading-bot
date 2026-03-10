/**
 * PositionEngine — 수익률 계산(PROFIT_CALC_SPEC 100% 준수), state.assets 연동, ExitPolicy(손절/익절 감시)
 */

const path = require('path');
const TradeExecutor = require(path.join(__dirname, '../../../lib/TradeExecutor'));

/**
 * PROFIT_CALC_SPEC.md: totalBuyKrwForCoins, evaluationKrwForCoins 사용, KRW 제외
 * @param {Object} assets - summarizeAccounts 결과 (totalBuyKrwForCoins, evaluationKrwForCoins, totalBuyKrw 등)
 * @returns {{ totalBuyKrwForCoins: number, evaluationKrwForCoins: number, profitPct: number }}
 */
function getProfitFromAssets(assets) {
  const totalBuy = assets?.totalBuyKrwForCoins ?? assets?.totalBuyKrw ?? 0;
  const evalCoins = assets?.evaluationKrwForCoins ?? 0;
  if (totalBuy <= 0) {
    return { totalBuyKrwForCoins: 0, evaluationKrwForCoins: evalCoins, profitPct: 0 };
  }
  const profitLoss = evalCoins - totalBuy;
  const profitPct = (profitLoss / totalBuy) * 100;
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
 * 청산 신호 — 레거시 TradeExecutor.checkExit (scalpEngine.shouldExitScalp) 브리지
 * @param {Object} position - { entryPrice, entryTimeMs, strengthPeak60s?, highSinceEntry? }
 * @param {Object} snapshot - 현재 호가·체결 스냅샷
 * @param {number} currentPrice
 * @param {number|null} currentEntryScore
 * @returns {{ exit: boolean, reason?: string }}
 */
function getExitSignal(position, snapshot, currentPrice, currentEntryScore) {
  return TradeExecutor.checkExit(position, snapshot, currentPrice, currentEntryScore);
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
