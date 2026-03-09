/**
 * 독립 스캘프 — 전략 스코어링 및 최종 진입 결정
 * Adaptive Volume + Sweep/Breakout/OBI 스코어 조합
 */

const strategies = require('./strategies');
const baseline = require('./adaptiveBaseline');

class ScalpOrchestrator {
  async decide(marketData) {
    const { symbol, vol10s, price, ob } = marketData;

    // 1. Adaptive Volume Check
    const volPass = baseline.checkPass(symbol, vol10s);

    // 2. 전략별 스코어 계산
    const scores = {
      sweep: strategies.liquiditySweep(marketData),
      breakout: strategies.microBreakout(marketData),
      imbalance: strategies.orderbookImbalance(marketData)
    };

    const bestStrategy = Object.keys(scores).reduce((a, b) => (scores[a] > scores[b] ? a : b));
    const bestScore = scores[bestStrategy];

    if (bestScore >= 0.6 && volPass.soft) {
      return {
        shouldEntry: true,
        strategy: bestStrategy.toUpperCase(),
        symbol,
        score: bestScore,
        volPass
      };
    }
    return { shouldEntry: false };
  }
}

module.exports = new ScalpOrchestrator();
