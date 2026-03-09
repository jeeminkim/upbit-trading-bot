/**
 * 독립 스캘프 — 거래량 적응형 베이스라인 엔진
 * symbol별 10s 거래량 윈도우로 베이스라인 산출, soft/hard 패스 판정
 */

class AdaptiveVolumeEngine {
  constructor() {
    this.stats = {}; // symbol -> number[] (최근 60개 vol10s)
    this.absMinKrw = {
      BTC: 3000000,
      ETH: 2000000,
      SOL: 1500000,
      XRP: 1000000
    };
  }

  update(symbol, vol10s) {
    if (!this.stats[symbol]) this.stats[symbol] = [];
    this.stats[symbol].push(vol10s);
    if (this.stats[symbol].length > 60) this.stats[symbol].shift();
  }

  getBaseline(symbol) {
    const data = this.stats[symbol] || [];
    if (data.length < 10) return this.absMinKrw[symbol] ?? 1000000;

    const sorted = [...data].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const last = data[data.length - 1] || 0;
    return Math.max(
      Math.min(median, last * 2.5),
      this.absMinKrw[symbol] ?? 1000000
    );
  }

  checkPass(symbol, volNow10s) {
    const baseline = this.getBaseline(symbol);
    const absMin = this.absMinKrw[symbol] ?? 1000000;
    return {
      soft: volNow10s >= baseline * 1.12 || volNow10s >= absMin,
      hard: volNow10s >= baseline * 1.25
    };
  }
}

module.exports = new AdaptiveVolumeEngine();
