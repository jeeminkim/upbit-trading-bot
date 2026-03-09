/**
 * REGIME 봇 시그널 제공자.
 * regimeDetector.readLastLines + MPI 기반으로 진입 후보를 공통 시그널 형식으로 반환.
 * 기존 REGIME 로직은 변경하지 않고 읽기만 함.
 */

const { normalizeRegimeRaw } = require('./signalNormalizer');

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP'];

/**
 * 최근 regime 기록에서 심볼별 최신 regime으로 시그널 생성
 * @param {Array<Object>} regimeLines - regimeDetector.readLastLines(n)
 * @param {Object} mpiBySymbol - symbol -> mpi (0~100)
 * @returns {Array<Object>} UnifiedSignal[]
 */
function getRegimeSignals(regimeLines, mpiBySymbol) {
  if (!Array.isArray(regimeLines)) return [];
  const bySymbol = {};
  for (const r of regimeLines) {
    if (r && r.symbol) bySymbol[r.symbol] = r;
  }
  const out = [];
  for (const symbol of SYMBOLS) {
    const rec = bySymbol[symbol];
    const mpi = mpiBySymbol && mpiBySymbol[symbol];
    const signal = normalizeRegimeRaw(symbol, rec, mpi);
    if (signal.side === 'BUY') out.push(signal);
  }
  return out;
}

/**
 * 단일 최고 점수 REGIME 후보 1개 반환
 */
function getBestRegimeSignal(regimeLines, mpiBySymbol) {
  const signals = getRegimeSignals(regimeLines, mpiBySymbol);
  if (signals.length === 0) return null;
  return signals.reduce((a, b) => (a.score >= b.score ? a : b));
}

module.exports = {
  getRegimeSignals,
  getBestRegimeSignal,
  SYMBOLS
};
