/**
 * 거래 부재 원인 진단 · 매매 로직 수정안 제안 — 로컬 규칙 기반 (Gemini 미사용)
 * Discord 버튼 [🔍 거래 부재 원인 진단] / [💡 매매 로직 수정안 제안] 결과 생성
 */

/**
 * 최근 12시간 데이터로 "왜 거래가 없었는지" 3줄 요약 생성
 * @param {Object} opts
 * @param {Array} opts.trades12h - 최근 12h 매매 건
 * @param {Array} opts.reject12h - 최근 12h 거절 로그
 * @param {Object} opts.profile - scalpEngine.getProfile()
 * @param {Object} opts.assets - state.assets (orderableKrw 등)
 * @param {Object} opts.lastRejectBySymbol - 종목별 마지막 거절 사유
 * @param {boolean} opts.botEnabled - 엔진 가동 여부
 * @returns {string} 3줄 요약
 */
function buildDiagnoseSummary(opts) {
  const { trades12h = [], reject12h = [], profile = {}, assets, lastRejectBySymbol = {}, botEnabled } = opts;
  const lines = [];

  if (!botEnabled) {
    lines.push('1) 엔진이 꺼져 있어 매매가 발생하지 않습니다. [🚀 엔진 가동] 후 다시 확인하세요.');
  }

  const orderableKrw = assets?.orderableKrw != null ? Number(assets.orderableKrw) : null;
  if (orderableKrw !== null && orderableKrw < 5000) {
    lines.push('2) 주문 가능 원화가 부족합니다. 원화를 입금하거나 보유 코인 일부 매도 후 재시도하세요.');
  }

  const entryMin = profile.entry_score_min != null ? Number(profile.entry_score_min) : null;
  const rsiOversold = profile.rsi_oversold != null ? Number(profile.rsi_oversold) : null;
  const strengthThreshold = profile.strength_threshold != null ? Number(profile.strength_threshold) : null;

  if (reject12h.length > 0) {
    const reasons = reject12h.map((r) => (r.reason || '').toLowerCase());
    const hasRsi = reasons.some((r) => /rsi|진입|score|점수/.test(r));
    const hasSpread = reasons.some((r) => /spread|스프레드/.test(r));
    const hasLiquidity = reasons.some((r) => /liquidity|깊이|depth|잔고|orderable/.test(r));
    const hasKimp = reasons.some((r) => /kimp|김프/.test(r));
    if (hasRsi && entryMin != null) {
      lines.push(`3) 진입 점수 미달로 대기 중입니다. (현재 기준 entry_score_min=${entryMin}). RSI/체결강도가 조건을 충족하지 못해 거절된 건이 많습니다.`);
    } else if (hasSpread) {
      lines.push('3) 스프레드가 허용 한도를 넘어 진입이 거절되었습니다. max_spread_pct 또는 변동성 완화 후 재시도하세요.');
    } else if (hasLiquidity) {
      lines.push('3) 호가 유동성 부족 또는 주문 가능 금액 부족으로 거절된 건이 있습니다. 시장 상황과 잔고를 확인하세요.');
    } else if (hasKimp) {
      lines.push('3) 김프 한도(kimp_block_pct) 초과로 진입이 차단되었습니다. 김프가 낮아질 때까지 대기 중입니다.');
    } else {
      const lastRejectEntries = Object.entries(lastRejectBySymbol);
      const sample = lastRejectEntries.slice(0, 2).map(([sym, r]) => `${sym}: ${(r || '').slice(0, 30)}`).join(' / ');
      lines.push(`3) 최근 거절 사유: ${sample || reject12h[0]?.reason || '진입 조건 미충족'}. (거절 ${reject12h.length}건)`);
    }
  }

  if (trades12h.length > 0 && lines.length < 3) {
    lines.push(`${trades12h.length}건 매매가 발생했습니다. 정상 체결 중입니다.`);
  }

  if (lines.length === 0) {
    lines.push('1) 최근 12시간 매매·거절 데이터가 없거나 적습니다.');
    lines.push('2) 엔진을 켠 뒤 시장이 진입 조건을 충족할 때까지 대기 중일 수 있습니다.');
    lines.push(`3) 현재 설정: entry_score_min=${entryMin ?? '—'}, rsi_oversold=${rsiOversold ?? '—'}, strength_threshold=${strengthThreshold ?? '—'}. 조건 완화 시 진입 빈도가 늘 수 있습니다.`);
  }

  return lines.slice(0, 3).join('\n');
}

/**
 * 누적 진단 요약 N건을 바탕으로 매매 로직 수정안 5줄 이내 제안
 * @param {string[]} diagnosticsStore - 이전 diagnoseNoTrade 요약 문자열 배열
 * @returns {string} 5줄 이내 제안
 */
function buildSuggestSummary(diagnosticsStore) {
  if (!Array.isArray(diagnosticsStore) || diagnosticsStore.length === 0) {
    return '누적된 진단이 없어 제안을 생성할 수 없습니다.';
  }

  const text = diagnosticsStore.join(' ').toLowerCase();
  const lines = [];

  if (/rsi|진입\s*점수|entry_score|점수\s*미달/.test(text)) {
    lines.push('• scalpEngine/프로필: entry_score_min을 소폭 낮추면 진입 기회가 늘 수 있습니다. (예: 60 → 55)');
  }
  if (/스프레드|spread/.test(text)) {
    lines.push('• max_spread_pct를 약간 올리면 변동성이 큰 구간에서도 진입이 허용됩니다. 과도한 상향은 슬리피지 리스크를 높입니다.');
  }
  if (/잔고|원화|orderable|부족/.test(text)) {
    lines.push('• 주문 가능 원화를 일정 수준 유지하거나, 한 종목당 투자 비중을 줄여 여러 종목에 분산 진입하는 설정을 권장합니다.');
  }
  if (/김프|kimp/.test(text)) {
    lines.push('• kimp_block_pct를 소폭 상향하면 김프가 높을 때도 진입할 수 있습니다. 김프 리스크는 별도 관리가 필요합니다.');
  }
  if (/엔진|꺼져/.test(text)) {
    lines.push('• 엔진이 꺼져 있는 시간이 많았다면, [🚀 엔진 가동] 후 충분히 데이터를 쌓은 뒤 다시 진단해 보세요.');
  }

  if (lines.length === 0) {
    lines.push('• 진단 요약에서 공통 패턴이 뚜렷하지 않습니다. RSI/체결강도 기준(entry_score_min, strength_threshold)을 단계적으로 조정해 보시고, 변경 후에도 「거래 부재 원인 진단」을 여러 번 실행해 추이를 확인하세요.');
  }

  const header = `누적 진단 ${diagnosticsStore.length}건 기준 제안:\n`;
  return header + lines.slice(0, 5).join('\n');
}

module.exports = {
  buildDiagnoseSummary,
  buildSuggestSummary
};
