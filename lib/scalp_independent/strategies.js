/**
 * 독립 스캘프 — 3가지 초단타 전략: Sweep, Breakout, OBI
 * marketData: { symbol, vol10s, price, ob, high40s?, strength?, obi? }
 * 반환: 0~1 스코어 (진입 강도)
 */

/**
 * Liquidity Sweep: 한쪽 호가 스윕 후 반등 기대
 * ob: orderbook units, price: 현재가, strength: 매수비율
 */
function liquiditySweep(marketData) {
  const { ob, strength, price } = marketData;
  if (!ob || !ob.orderbook_units?.length) return 0;
  const units = ob.orderbook_units;
  const bestBid = Number(units[0]?.bid_price) || 0;
  const bestAsk = Number(units[0]?.ask_price) || 0;
  const bidDepth = units.slice(0, 5).reduce((s, u) => s + (Number(u.bid_size) || 0), 0);
  const askDepth = units.slice(0, 5).reduce((s, u) => s + (Number(u.ask_size) || 0), 0);
  const total = bidDepth + askDepth;
  if (total <= 0) return 0;
  const obi = (bidDepth - askDepth) / total;
  // 스윕: 한쪽이 압도 후 반대편 유입 기대 → 극단적 OBI에서 회귀 시 스코어
  const extremeObi = Math.abs(obi) > 0.25;
  const strengthOk = (obi > 0 && strength > 0.52) || (obi < 0 && strength < 0.48);
  if (!extremeObi) return 0.4;
  return strengthOk ? 0.55 + Math.min(0.2, Math.abs(obi) * 0.5) : 0.45;
}

/**
 * Micro Breakout: 최근 40초 고점 돌파
 * marketData.high40s: 최근 40초 고가 (또는 price로 근사)
 */
function microBreakout(marketData) {
  const { price, high40s } = marketData;
  const high = high40s != null ? high40s : price;
  if (price == null || high == null) return 0;
  const breakPct = (price - high) / high;
  if (breakPct <= 0) return 0.35;
  if (breakPct < 0.001) return 0.5;
  if (breakPct < 0.003) return 0.6 + breakPct * 50;
  return Math.min(0.95, 0.7 + breakPct * 30);
}

/**
 * Orderbook Imbalance: 호가 불균형으로 방향성 점수
 */
function orderbookImbalance(marketData) {
  const { ob, strength } = marketData;
  if (!ob || !ob.orderbook_units?.length) return 0;
  const units = ob.orderbook_units;
  const bidDepth = units.slice(0, 5).reduce((s, u) => s + (Number(u.bid_size) || 0), 0);
  const askDepth = units.slice(0, 5).reduce((s, u) => s + (Number(u.ask_size) || 0), 0);
  const total = bidDepth + askDepth;
  if (total <= 0) return 0.5;
  const obi = (bidDepth - askDepth) / total;
  const str = strength != null ? strength : 0.5;
  // OBI와 체결강도 일치 시 높은 스코어
  const aligned = (obi > 0.1 && str > 0.55) || (obi < -0.1 && str < 0.45);
  const base = 0.45 + Math.abs(obi) * 0.5;
  return aligned ? Math.min(0.9, base + 0.15) : base;
}

module.exports = {
  liquiditySweep,
  microBreakout,
  orderbookImbalance
};
