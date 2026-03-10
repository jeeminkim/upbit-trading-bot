const PositionEngine = require('./PositionEngine');

module.exports = {
  PositionEngine,
  getProfitFromAssets: PositionEngine.getProfitFromAssets,
  getProfitPct: PositionEngine.getProfitPct,
  getExitSignal: PositionEngine.getExitSignal
};
