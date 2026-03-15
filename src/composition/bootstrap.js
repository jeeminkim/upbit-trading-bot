/**
 * Composition Root — 엔진 DI 및 조립
 * SignalEngine, RiskEngine, ExecutionEngine, PositionEngine 조립.
 */

const path = require('path');
const SignalEngine = require('../domain/signal/SignalEngine');
const SignalNormalizer = require('../domain/signal/SignalNormalizer');
const ScalpStrategy = require('../domain/signal/strategies/ScalpStrategy');
const RiskEngine = require('../domain/risk/RiskEngine');
const MarketQualityGate = require('../domain/risk/MarketQualityGate');
const ExposurePolicy = require('../domain/risk/ExposurePolicy');
const ExecutionEngine = require('../domain/execution/ExecutionEngine');
const PositionEngine = require('../domain/position/PositionEngine');

/**
 * @param {Object} [deps] - { stateStore } EngineStateStore (get/update)
 * @returns {{ signalEngine, riskEngine, executionEngine, positionEngine }}
 */
function bootstrap(deps = {}) {
  const stateStore = deps.stateStore || null;
  const signalEngine = new SignalEngine([ScalpStrategy], SignalNormalizer);
  const riskEngine = new RiskEngine(MarketQualityGate, ExposurePolicy);
  const executionEngine = new ExecutionEngine(stateStore);
  const positionEngine = new PositionEngine(stateStore);
  return { signalEngine, riskEngine, executionEngine, positionEngine };
}

module.exports = { bootstrap };
