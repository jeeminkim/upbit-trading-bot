/**
 * 최근 15분 MPI 시계열 (메모리 rolling)
 */

const MAX_HISTORY_MINUTES = 15;
const INTERVAL_MS = 60 * 1000;

const bySymbol = { BTC: [], ETH: [], SOL: [], XRP: [] };

function push(symbol, point) {
  const arr = bySymbol[symbol];
  if (!arr) return;
  arr.push({ ...point, ts: Date.now() });
  const cutoff = Date.now() - MAX_HISTORY_MINUTES * 60 * 1000;
  while (arr.length && arr[0].ts < cutoff) arr.shift();
}

function get(symbol, minutes = 15) {
  const arr = bySymbol[symbol] || [];
  const cutoff = Date.now() - minutes * 60 * 1000;
  return arr.filter(p => p.ts >= cutoff);
}

function getLastN(symbol, n) {
  const arr = bySymbol[symbol] || [];
  return arr.slice(-n);
}

module.exports = { push, get, getLastN };
