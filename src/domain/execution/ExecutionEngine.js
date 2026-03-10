/**
 * ExecutionEngine — ExecutionPlan 수용, lib/TradeExecutor 브리지, 실패 시 로그·상태 업데이트
 */

const path = require('path');
const TradeExecutor = require(path.join(__dirname, '../../../lib/TradeExecutor'));

/**
 * @param {Object} [stateStore] - EngineStateStore (실패 시 lastOrderError 등 업데이트용)
 */
function ExecutionEngine(stateStore) {
  this.stateStore = stateStore || null;
}

/**
 * ExecutionPlan에 따라 주문 집행 (시장가 단일 슬라이스 우선 지원)
 * @param {import('../../shared/types/Execution').ExecutionPlan} plan
 * @param {{ accessKey: string, secretKey: string }} apiKeys
 * @param {{ orderableKrw?: number }} [options]
 * @returns {Promise<{ success: boolean, order?: Object, error?: string }>}
 */
ExecutionEngine.prototype.execute = async function execute(plan, apiKeys, options = {}) {
  if (!plan || !apiKeys?.accessKey || !apiKeys?.secretKey) {
    const err = 'ExecutionEngine: plan or apiKeys missing';
    this._recordFailure(err);
    return { success: false, error: err };
  }
  if (plan.mode !== 'MARKET' || !plan.slices?.length) {
    const err = 'ExecutionEngine: only MARKET mode with slices supported';
    this._recordFailure(err);
    return { success: false, error: err };
  }

  const budgetKrw = Math.floor(plan.budgetKrw || 0);
  const orderableKrw = options.orderableKrw ?? 0;
  if (budgetKrw < 5000) {
    const err = 'ExecutionEngine: budgetKrw below minimum';
    this._recordFailure(err);
    return { success: false, error: err };
  }

  try {
    const order = await TradeExecutor.placeMarketBuyByPrice(
      apiKeys.accessKey,
      apiKeys.secretKey,
      plan.market,
      budgetKrw,
      orderableKrw || null
    );
    this._clearFailure();
    return { success: true, order };
  } catch (e) {
    const error = e?.message || String(e);
    console.error('[ExecutionEngine] 주문 실패:', plan.market, error);
    this._recordFailure(error);
    return { success: false, error };
  }
};

/**
 * 매도 (수량 기준) — 청산 시 브리지
 */
ExecutionEngine.prototype.executeSell = async function executeSell(market, volume, apiKeys) {
  if (!apiKeys?.accessKey || !apiKeys?.secretKey || !market || volume <= 0) {
    const err = 'ExecutionEngine.executeSell: invalid args';
    this._recordFailure(err);
    return { success: false, error: err };
  }
  try {
    const order = await TradeExecutor.placeMarketSellByVolume(
      apiKeys.accessKey,
      apiKeys.secretKey,
      market,
      volume
    );
    this._clearFailure();
    return { success: true, order };
  } catch (e) {
    const error = e?.message || String(e);
    console.error('[ExecutionEngine] 매도 실패:', market, error);
    this._recordFailure(error);
    return { success: false, error };
  }
};

ExecutionEngine.prototype._recordFailure = function _recordFailure(error) {
  if (this.stateStore && typeof this.stateStore.update === 'function') {
    this.stateStore.update({ lastOrderError: error, lastOrderErrorAt: Date.now() });
  }
};

ExecutionEngine.prototype._clearFailure = function _clearFailure() {
  if (this.stateStore && typeof this.stateStore.update === 'function') {
    this.stateStore.update({ lastOrderError: null, lastOrderErrorAt: null });
  }
};

module.exports = ExecutionEngine;
