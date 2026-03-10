/**
 * 시장 품질 게이트 — scalpEngine P0 게이트 중 슬리피지·지연 이식
 * (김프/스프레드/깊이/유동성은 Signal 쪽 레거시 pipeline에서 이미 반영)
 */

const scalpEngine = require('../../../lib/scalpEngine');

/**
 * @param {Object} snapshot - 레거시 스냅샷 (ws_lag_ms, realized_slippage_bps_avg, rest_latency_ms 등)
 * @param {Object} [profile] - scalpEngine.getProfile() 결과 (미전달 시 내부에서 조회)
 * @returns {{ allowed: boolean, reason?: string }}
 */
function check(snapshot, profile) {
  if (!snapshot) return { allowed: false, reason: 'BLOCK_LIQUIDITY' };
  const p = profile || scalpEngine.getProfile();

  if (snapshot.rest_latency_ms != null && p.rest_latency_ms_max != null && snapshot.rest_latency_ms > p.rest_latency_ms_max) {
    return { allowed: false, reason: 'BLOCK_LAG' };
  }
  if (snapshot.ws_lag_ms != null && p.ws_lag_ms_max != null && snapshot.ws_lag_ms > p.ws_lag_ms_max) {
    return { allowed: false, reason: 'BLOCK_LAG' };
  }
  const slippageBps = snapshot.realized_slippage_bps_avg;
  const limitBps = p.slippage_shutdown_bps != null ? p.slippage_shutdown_bps : 5;
  if (slippageBps != null && slippageBps > limitBps) {
    return { allowed: false, reason: 'BLOCK_SLIPPAGE' };
  }
  return { allowed: true };
}

module.exports = { check };
