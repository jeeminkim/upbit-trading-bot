/**
 * HTS 스타일 메인 대시보드 앱 (모듈화)
 * - 실시간 가격 플래시(상승=빨강/하락=파랑), 자산 1초 갱신, Entry Score 게이지, P0 뱃지
 * - 로그 [BUY]/[SELL]/[BLOCKED] 색상, 알림 사운드 옵션, WebSocket Lag, MPI 위젯
 */
(function () {
  'use strict';

  var socket = io();
  var lastPrices = { BTC: null, ETH: null, XRP: null, SOL: null };
  var lastLogCount = 0;
  var soundEnabled = false;
  var vibrationEnabled = false;
  var lastRejectLogsSignature = '';
  var lastTradesSignature = '';
  var lastLogsArray = [];
  var logFullscreenOpen = false;

  function isMobile() {
    return window.matchMedia('(max-width: 768px)').matches;
  }

  var el = {
    botToggle: document.getElementById('bot-toggle'),
    botLabel: document.getElementById('bot-label'),
    connectionStatus: document.getElementById('connection-status'),
    logContainer: document.getElementById('log-container'),
    logSection: document.getElementById('log-section'),
    logFullscreen: document.getElementById('log-fullscreen'),
    logFullscreenContainer: document.getElementById('log-fullscreen-container'),
    tradesContainer: document.getElementById('trades-container'),
    rejectLogsContainer: document.getElementById('reject-logs-container'),
    fngFill: document.getElementById('fng-fill'),
    fngValue: document.getElementById('fng-value'),
    wsLag: document.getElementById('ws-lag-ms'),
    soundCheck: document.getElementById('log-sound-check'),
    vibrateCheck: document.getElementById('log-vibrate-check'),
    mpiWidget: document.getElementById('mpi-widget')
  };

  try {
    vibrationEnabled = localStorage.getItem('logVibrate') === '1';
    if (el.vibrateCheck) el.vibrateCheck.checked = vibrationEnabled;
  } catch (e) {}

  function formatKrw(num) {
    if (num == null) return '—';
    return new Intl.NumberFormat('ko-KR').format(Math.round(num)) + ' 원';
  }

  function formatPct(num) {
    if (num == null) return '—';
    var s = num >= 0 ? '+' : '';
    return s + num.toFixed(2) + ' %';
  }

  /** 김프(%) 소수점 둘째 자리 */
  function formatKimpPct(num) {
    if (num == null || num !== num) return null;
    var s = num >= 0 ? '+' : '';
    return s + Number(num).toFixed(2) + '%';
  }

  function escapeHtml(s) {
    var div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  /** 상승=빨강/하락=파랑 플래시 (HTS 직관 강화) */
  function flashPrice(sym, direction) {
    var elPrice = document.getElementById('price-' + sym);
    if (!elPrice) return;
    elPrice.classList.remove('hts-flash-up', 'hts-flash-down');
    elPrice.offsetHeight;
    elPrice.classList.add(direction === 'up' ? 'hts-flash-up' : 'hts-flash-down');
    setTimeout(function () {
      elPrice.classList.remove('hts-flash-up', 'hts-flash-down');
    }, 600);
  }

  /**
   * 자산 카드: 총 매수(avg_buy_price 기준) / 현재 평가, 손익금·수익률 실시간
   * 수익률(%) = (현재 총 평가액 / 총 매수 금액 - 1) * 100
   */
  function renderAssets(assets, fxUsdKrw, profitSummary) {
    if (!assets) return;
    var totalBuy = assets.totalBuyKrw != null ? assets.totalBuyKrw : (assets.totalBuyKrwForCoins || 0);
    var totalEval = assets.totalEvaluationKrw != null ? assets.totalEvaluationKrw : 0;
    var pnl = profitSummary && profitSummary.profitKrw != null ? profitSummary.profitKrw : (totalEval - totalBuy);
    var rate = profitSummary && profitSummary.profitPct != null ? profitSummary.profitPct : (totalBuy > 0 ? (totalEval / totalBuy - 1) * 100 : 0);
    setText('asset-buy', formatKrw(totalBuy));
    setText('asset-eval', formatKrw(totalEval));
    setText('asset-orderable', formatKrw(assets.orderableKrw));
    setText('asset-pnl', (pnl >= 0 ? '+' : '') + formatKrw(pnl));
    setText('asset-rate', rate === 0 ? '+0.00 %' : (rate > 0 ? '+' : '') + formatPct(rate));
    var usdEl = document.getElementById('asset-usd');
    var totalEval = assets.totalEvaluationKrw != null ? assets.totalEvaluationKrw : 0;
    if (usdEl) {
      if (fxUsdKrw != null && fxUsdKrw > 0 && totalEval != null) {
        var usd = totalEval / fxUsdKrw;
        usdEl.textContent = '$' + (usd >= 1000 ? usd.toFixed(0) : usd.toFixed(2));
      } else {
        usdEl.textContent = '—';
      }
    }
    var pnlEl = document.getElementById('asset-pnl');
    var rateEl = document.getElementById('asset-rate');
    var pnlCls = pnl > 0 ? 'text-red-400' : pnl < 0 ? 'text-blue-400' : 'text-slate-300';
    var rateCls = rate > 0 ? 'text-red-400' : rate < 0 ? 'text-blue-400' : 'text-slate-300';
    if (pnlEl) pnlEl.className = 'text-lg font-bold mt-1 ' + pnlCls;
    if (rateEl) rateEl.className = 'text-lg font-bold mt-1 ' + rateCls;
  }

  function setText(id, text) {
    var e = document.getElementById(id);
    if (e) e.textContent = text;
  }

  function renderPrices(prices) {
    ['BTC', 'ETH', 'XRP', 'SOL'].forEach(function (sym) {
      var m = 'KRW-' + sym;
      var p = prices && prices[m];
      var str = p ? formatKrw(p.tradePrice) : '—';
      var elPrice = document.getElementById('price-' + sym);
      if (elPrice) {
        var prev = lastPrices[sym];
        if (prev != null && p && p.tradePrice !== prev) {
          flashPrice(sym, p.tradePrice > prev ? 'up' : 'down');
        }
        lastPrices[sym] = p ? p.tradePrice : null;
        elPrice.textContent = str;
      }
    });
  }

  /** 코인별 실시간 김프 표시 (data.kimpByMarket, 소수점 둘째 자리) */
  function renderKimp(kimpByMarket) {
    if (!kimpByMarket || typeof kimpByMarket !== 'object') return;
    ['BTC', 'ETH', 'XRP', 'SOL'].forEach(function (sym) {
      var m = 'KRW-' + sym;
      var kimp = kimpByMarket[m];
      var el = document.getElementById('kimp-' + sym);
      if (!el) return;
      var str = formatKimpPct(kimp);
      if (str == null) {
        el.textContent = '—';
        el.className = 'text-xs text-slate-400 mt-0.5';
        return;
      }
      el.textContent = '김프 ' + str;
      el.className = 'text-xs mt-0.5 ' + (kimp > 0 ? 'text-red-400' : kimp < 0 ? 'text-blue-400' : 'text-slate-400');
    });
  }

  /**
   * SCALP strength_threshold 0.55 → 100점 만점 기준 55점 (진입 고려 기준선)
   * SCALP_LOGIC_FOR_NODEJS.md / scalpEngine.js DEFAULT_PROFILE.strength_threshold
   */
  var STRENGTH_THRESHOLD_PCT = 55;

  var ENTRY_SCORE_ITEMS = [
    { key: 'priceBreak', label: '가격 돌파 (Price Break): 전고점 돌파' },
    { key: 'volSurge', label: '거래량 급증 (Vol Surge): 직전 평균 대비 폭증' },
    { key: 'obiOk', label: '호가 균형 (OBI): 매수/매도 잔량 비율' },
    { key: 'strengthOk', label: '체결 강도 (Strength): 실시간 매수세' },
    { key: 'spreadOk', label: '스프레드 안정성: 호가 간격 적절성' },
    { key: 'depthOk', label: '호가 깊이: 상위 호가 물량' },
    { key: 'kimpOk', label: '김프 안정성: 김치 프리미엄 범위' }
  ];

  function buildEntryScoreTooltipBody() {
    var list = ENTRY_SCORE_ITEMS.map(function (item, i) {
      return '<li class="flex justify-between gap-2"><span class="text-slate-400">' + (i + 1) + '. ' + escapeHtml(item.label) + '</span><span class="entry-check shrink-0 font-mono" data-item="' + (i + 1) + '">—</span></li>';
    }).join('');
    return '<p class="text-slate-200">진입 판단 점수 (0~7점): 7가지 항목 충족 개수. 4점 이상 시 진입 신호.</p>' +
      '<ul class="mt-2 space-y-0.5 text-[11px]">' + list + '</ul>';
  }

  function buildScalpCardHtml(sym) {
    var tooltipBody = buildEntryScoreTooltipBody();
    return '<div class="scalp-inner">' +
      '<div class="flex items-center justify-between">' +
        '<span class="group relative cursor-help text-slate-400 text-xs underline decoration-dotted decoration-slate-500 entry-score-trigger">Entry Score' +
          '<span class="scalp-tooltip absolute left-0 bottom-full mb-1 hidden group-hover:block w-80 max-w-[95vw] p-3 text-left text-xs rounded-lg bg-slate-800 border border-slate-600 shadow-xl z-50 pointer-events-none">' + tooltipBody + '</span></span>' +
        '<span class="scalp-score-value font-medium text-amber-400">—</span>' +
      '</div>' +
      '<div class="mt-0.5 h-2 bg-slate-700 rounded overflow-hidden"><div class="scalp-score-bar h-full bg-amber-500 rounded transition-all duration-300" style="width:0%"></div></div>' +
      '<div class="mt-1.5 flex items-center gap-1.5 flex-wrap">' +
        '<span class="scalp-p0-badge inline-block px-2 py-0.5 rounded text-xs">P0: —</span>' +
        '<span class="scalp-strength-ok text-emerald-400/90 text-xs" style="display:none">Strength OK</span>' +
      '</div>' +
      '<div class="mt-1 flex items-center justify-between">' +
        '<span class="group relative cursor-help text-slate-500 text-xs underline decoration-dotted decoration-slate-500 strength-trigger">Strength' +
          '<span class="scalp-tooltip absolute left-0 bottom-full mb-1 hidden group-hover:block w-72 max-w-[95vw] p-3 text-left text-xs rounded-lg bg-slate-800 border border-slate-600 shadow-xl z-50 pointer-events-none">시장 참여 강도 (0~100점): 최근 60초 매수/매도 에너지. 100에 가까울수록 매수세 압도·추세 강함.</span></span>' +
        '<span class="scalp-strength-value text-xs tabular-nums">—</span>' +
      '</div>' +
      '<div class="mt-0.5 h-1.5 bg-slate-700 rounded relative overflow-visible">' +
        '<div class="absolute top-0 bottom-0 w-0 border-l border-dashed border-white/50 z-10 pointer-events-none" style="left:' + STRENGTH_THRESHOLD_PCT + '%"></div>' +
        '<div class="scalp-strength-bar h-full rounded transition-all duration-300 relative z-0" style="width:0%"></div>' +
      '</div>' +
      '<div class="mt-1.5 text-slate-500 text-xs">현재 MPI 비중: <span class="scalp-mpi-value">—</span></div>' +
      '</div>';
  }

  function updateScalpCard(container, s, sym) {
    if (!container) return;
    var inner = container.querySelector('.scalp-inner');
    if (!inner) {
      container.innerHTML = s ? buildScalpCardHtml(sym) : '<span class="text-slate-600">—</span>';
      if (s) updateScalpValues(container, s);
      return;
    }
    if (!s) {
      var scoreVal = inner.querySelector('.scalp-score-value');
      if (scoreVal) scoreVal.textContent = '—';
      var scoreBar = inner.querySelector('.scalp-score-bar');
      if (scoreBar) scoreBar.style.width = '0%';
      var p0Badge = inner.querySelector('.scalp-p0-badge');
      if (p0Badge) p0Badge.textContent = 'P0: —';
      var okSpan = inner.querySelector('.scalp-strength-ok');
      if (okSpan) okSpan.style.display = 'none';
      var strengthVal = inner.querySelector('.scalp-strength-value');
      if (strengthVal) strengthVal.textContent = '—';
      var strengthBar = inner.querySelector('.scalp-strength-bar');
      if (strengthBar) { strengthBar.style.width = '0%'; strengthBar.className = 'scalp-strength-bar h-full rounded transition-all duration-300 relative z-0 bg-slate-500'; }
      var mpiVal = inner.querySelector('.scalp-mpi-value');
      if (mpiVal) mpiVal.textContent = '—';
      ENTRY_SCORE_ITEMS.forEach(function (_, i) {
        var el = inner.querySelector('.entry-check[data-item="' + (i + 1) + '"]');
        if (el) { el.textContent = '—'; el.className = 'entry-check shrink-0 font-mono text-slate-500'; }
      });
      return;
    }
    updateScalpValues(container, s);
  }

  function updateScalpValues(container, s) {
    var score = s.entryScore != null ? s.entryScore : 0;
    var scorePct = Math.min(100, (score / 7) * 100);
    var p0 = s.p0GateStatus || 'OK';
    var p0BadgeClass = p0 === 'OK' ? 'bg-emerald-900/80 text-emerald-300' : 'bg-amber-900/80 text-amber-300';
    var strengthRaw = s.strength_proxy_60s != null ? Math.max(0, Math.min(1, s.strength_proxy_60s)) : 0.5;
    var strengthPct = Math.round(strengthRaw * 100);
    var strengthOk = strengthPct >= STRENGTH_THRESHOLD_PCT;
    var strengthLabelCls = strengthPct >= 70 ? 'text-emerald-300 font-medium' : strengthPct >= STRENGTH_THRESHOLD_PCT ? 'text-emerald-400/90' : 'text-slate-500';
    var strengthBarCls = strengthOk ? 'bg-emerald-400' : 'bg-slate-500';
    var mpiPct = s.mpiMultiplier != null ? Math.round(s.mpiMultiplier * 100) + '%' : '—';

    var scoreVal = container.querySelector('.scalp-score-value');
    var entryTrigger = container.querySelector('.entry-score-trigger');
    if (scoreVal && (!entryTrigger || !entryTrigger.classList.contains('is-hovered'))) scoreVal.textContent = score + '/7';
    var scoreBar = container.querySelector('.scalp-score-bar');
    if (scoreBar) scoreBar.style.width = scorePct + '%';
    var p0Badge = container.querySelector('.scalp-p0-badge');
    if (p0Badge) {
      p0Badge.textContent = 'P0: ' + p0;
      p0Badge.className = 'scalp-p0-badge inline-block px-2 py-0.5 rounded text-xs ' + p0BadgeClass;
    }
    var okSpan = container.querySelector('.scalp-strength-ok');
    if (okSpan) okSpan.style.display = strengthOk ? '' : 'none';
    var strengthVal = container.querySelector('.scalp-strength-value');
    var strengthTrigger = container.querySelector('.strength-trigger');
    if (strengthVal && (!strengthTrigger || !strengthTrigger.classList.contains('is-hovered'))) {
      strengthVal.textContent = strengthPct + '/100';
      strengthVal.className = 'scalp-strength-value text-xs tabular-nums ' + strengthLabelCls;
    }
    var strengthBar = container.querySelector('.scalp-strength-bar');
    if (strengthBar) {
      strengthBar.style.width = strengthPct + '%';
      strengthBar.className = 'scalp-strength-bar h-full rounded transition-all duration-300 relative z-0 ' + strengthBarCls;
    }
    var mpiVal = container.querySelector('.scalp-mpi-value');
    if (mpiVal) mpiVal.textContent = mpiPct;

    var p0Reason = s.p0GateStatus || '';
    var spreadOk = p0Reason !== 'BLOCK_SPREAD';
    var depthOk = p0Reason !== 'BLOCK_LIQUIDITY';
    var kimpOk = p0Reason !== 'BLOCK_KIMP';
    var checks = [
      !!s.priceBreak,
      !!s.volSurge,
      !!s.obiOk,
      !!s.strengthOk,
      spreadOk,
      depthOk,
      kimpOk
    ];
    ENTRY_SCORE_ITEMS.forEach(function (_, i) {
      var el = container.querySelector('.entry-check[data-item="' + (i + 1) + '"]');
      if (el) {
        var ok = checks[i];
        el.textContent = ok ? 'O' : 'X';
        el.className = 'entry-check shrink-0 font-mono ' + (ok ? 'text-emerald-400' : 'text-slate-500');
      }
    });
  }

  /** Entry Score 게이지, P0 뱃지, Strength 바 — 부분 업데이트로 툴팁 유지·깜빡임 방지 */
  function renderScalpState(scalpState) {
    ['BTC', 'ETH', 'XRP', 'SOL'].forEach(function (sym) {
      var m = 'KRW-' + sym;
      var s = scalpState && scalpState[m];
      var container = document.getElementById('scalp-' + sym);
      if (!container) return;
      updateScalpCard(container, s, sym);
    });
  }

  (function initScalpTooltipHover() {
    function onEnter(e) {
      var t = e.target.closest('.entry-score-trigger, .strength-trigger');
      if (t) t.classList.add('is-hovered');
    }
    function onLeave(e) {
      var t = e.target.closest('.entry-score-trigger, .strength-trigger');
      if (t) t.classList.remove('is-hovered');
    }
    document.body.addEventListener('mouseenter', onEnter, true);
    document.body.addEventListener('mouseleave', onLeave, true);
  })();

  /** 로그창: [BUY_COMPLETE] 금색 강조, [EXIT] 파랑, [에러] 빨강 */
  function colorizeLogLine(line) {
    var tags = [
      { re: /\[BUY_COMPLETE\]/g, cls: 'text-amber-400 font-bold' },
      { re: /\[EXIT\]/g, cls: 'text-blue-400 font-semibold' },
      { re: /\[에러\]/g, cls: 'text-red-400 font-semibold' },
      { re: /\[ERROR\]/g, cls: 'text-red-400 font-semibold' },
      { re: /\[BUY_SIGNAL\]/g, cls: 'text-emerald-400 font-semibold' },
      { re: /\[BUY\]/g, cls: 'text-emerald-400 font-semibold' },
      { re: /\[SELL\]/g, cls: 'text-blue-400 font-semibold' }
    ];
    var html = escapeHtml(line);
    tags.forEach(function (t) {
      html = html.replace(t.re, '<span class="' + t.cls + '">$&</span>');
    });
    return html;
  }

  function playAlertSound() {
    if (!soundEnabled || !window.AudioContext && !window.webkitAudioContext) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      var ctx = new Ctx();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 800;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.1);
    } catch (e) {}
  }

  function renderLogs(logs) {
    if (!Array.isArray(logs)) return;
    lastLogsArray = logs;
    var prevLen = lastLogCount;
    lastLogCount = logs.length;
    var newLines = prevLen > 0 ? logs.slice(prevLen - 1) : [];
    var hasAlert = newLines.some(function (l) {
      return /\[BUY_SIGNAL\]|\[BUY_COMPLETE\]|\[EXIT\]|\[에러\]/.test(l);
    });
    if (hasAlert) playAlertSound();

    var full = logs.slice(-100);
    var toShow = isMobile() && !logFullscreenOpen ? full.slice(-3) : full;
    if (el.logContainer) {
      var newHtml = toShow.map(function (l) {
        return '<div class="leading-relaxed">' + colorizeLogLine(l) + '</div>';
      }).join('');
      if (el.logContainer.innerHTML !== newHtml) {
        el.logContainer.innerHTML = newHtml;
      }
      el.logContainer.scrollTop = el.logContainer.scrollHeight;
    }
    if (el.logFullscreenContainer && logFullscreenOpen) {
      el.logFullscreenContainer.innerHTML = full.map(function (l) {
        return '<div class="leading-relaxed">' + colorizeLogLine(l) + '</div>';
      }).join('');
      el.logFullscreenContainer.scrollTop = el.logFullscreenContainer.scrollHeight;
    }
  }

  function renderTrades(trades) {
    if (!el.tradesContainer) return;
    var sig = Array.isArray(trades) ? trades.length + (trades[0] ? (trades[0].id || trades[0].timestamp) : '') + (trades.length && trades[trades.length - 1] ? (trades[trades.length - 1].id || trades[trades.length - 1].timestamp) : '') : '';
    if (sig === lastTradesSignature) return;
    lastTradesSignature = sig;
    if (!Array.isArray(trades) || trades.length === 0) {
      el.tradesContainer.innerHTML = '<p class="text-slate-500">거래 내역 없음 (SQLite)</p>';
      return;
    }
    el.tradesContainer.innerHTML = trades.map(function (t) {
      var side = (t.side || '').toLowerCase() === 'sell' ? '매도' : '매수';
      var sideCls = side === '매도' ? 'text-blue-400' : 'text-emerald-400';
      var price = t.price != null ? formatKrw(t.price) : '—';
      var qty = t.quantity != null ? t.quantity : '—';
      var time = (t.timestamp || '').slice(0, 19).replace('T', ' ');
      var reason = t.reason ? ' <span class="text-slate-500 text-xs">' + escapeHtml(t.reason) + '</span>' : '';
      return '<div class="py-2 border-b border-slate-700 last:border-0"><span class="' + sideCls + ' font-medium">' + side + '</span> ' + escapeHtml(t.ticker || '') + ' ' + price + ' × ' + qty + reason + ' <span class="text-slate-500 text-xs">' + escapeHtml(time) + '</span></div>';
    }).join('');
  }

  function renderRejectLogs(logs) {
    if (!el.rejectLogsContainer) return;
    var sig = Array.isArray(logs) ? logs.length + (logs[0] ? (logs[0].timestamp || '') + (logs[0].ticker || '') : '') : '';
    var hadPrevious = lastRejectLogsSignature !== '';
    var isNewReject = hadPrevious && sig !== lastRejectLogsSignature && Array.isArray(logs) && logs.length > 0;
    if (isNewReject && vibrationEnabled && navigator.vibrate) {
      try { navigator.vibrate(200); } catch (e) {}
    }
    lastRejectLogsSignature = sig;
    if (!Array.isArray(logs) || logs.length === 0) {
      if (el.rejectLogsContainer.innerHTML !== '<p class="text-slate-500">최근 거절 기록 없음</p>') {
        el.rejectLogsContainer.innerHTML = '<p class="text-slate-500">최근 거절 기록 없음</p>';
      }
      updateCoinRejectReasons([]);
      return;
    }
    var newHtml = logs.map(function (r) {
      var time = (r.timestamp || '').slice(0, 19).replace('T', ' ');
      var ticker = escapeHtml(r.ticker || '—');
      var reason = escapeHtml(r.reason || '—');
      var score = r.score_at_reject != null ? r.score_at_reject : '—';
      return '<div class="py-2 border-b border-slate-700 last:border-0"><span class="text-amber-400 font-medium">' + reason + '</span> ' + ticker + ' <span class="text-slate-500 text-xs">점수 ' + score + '</span> <span class="text-slate-500 text-xs">' + time + '</span></div>';
    }).join('');
    if (el.rejectLogsContainer.innerHTML !== newHtml) {
      el.rejectLogsContainer.innerHTML = newHtml;
    }
    updateCoinRejectReasons(logs);
  }

  function updateCoinRejectReasons(logs) {
    var byMarket = {};
    if (Array.isArray(logs)) {
      logs.forEach(function (r) {
        var m = r.ticker || '';
        if (m && !byMarket[m]) byMarket[m] = r.reason || '—';
      });
    }
    ['BTC', 'ETH', 'XRP', 'SOL'].forEach(function (sym) {
      var elReject = document.getElementById('reject-' + sym);
      if (!elReject) return;
      var market = 'KRW-' + sym;
      var reason = byMarket[market] || '';
      var text = reason ? '최근 거절: ' + reason : '';
      if (elReject.textContent !== text) elReject.textContent = text;
    });
  }

  function renderFng(fng) {
    if (!el.fngValue || !el.fngFill) return;
    if (!fng || fng.value == null) {
      el.fngValue.textContent = '—';
      el.fngFill.setAttribute('stroke-dashoffset', 97);
      return;
    }
    el.fngValue.textContent = fng.value;
    var pct = fng.value / 100;
    el.fngFill.setAttribute('stroke-dashoffset', 97 - 97 * pct);
    var cls = 'gauge-fill fill-none stroke-[8] stroke-linecap-round ';
    if (fng.value <= 25) cls += 'stroke-red-500';
    else if (fng.value >= 75) cls += 'stroke-emerald-500';
    else cls += 'stroke-amber-500';
    el.fngFill.setAttribute('class', cls);
  }

  function setWsLag(ms) {
    if (el.wsLag) el.wsLag.textContent = ms != null ? 'WS Lag: ' + ms + ' ms' : 'WS Lag: —';
  }

  function setBotUi(enabled) {
    if (!el.botToggle) return;
    el.botToggle.setAttribute('aria-checked', enabled);
    if (el.botLabel) el.botLabel.textContent = enabled ? 'ON' : 'OFF';
    var thumb = document.getElementById('bot-thumb');
    if (thumb) {
      if (enabled) {
        el.botToggle.classList.add('bg-emerald-600');
        el.botToggle.classList.remove('bg-slate-600');
        thumb.classList.add('translate-x-5');
        thumb.classList.remove('translate-x-0.5');
      } else {
        el.botToggle.classList.remove('bg-emerald-600');
        el.botToggle.classList.add('bg-slate-600');
        thumb.classList.remove('translate-x-5');
        thumb.classList.add('translate-x-0.5');
      }
    }
  }

  /** MPI 위젯 (Fear & Greed 근처) */
  function renderMpi(data) {
    if (!el.mpiWidget || !data || !data.list || !data.list.length) return;
    var html = '<div class="text-slate-400 text-xs font-medium mb-1">MPI</div>';
    data.list.forEach(function (item) {
      var v = item.mpi != null ? item.mpi : '—';
      var vel = item.mpi_velocity != null ? (item.mpi_velocity >= 0 ? '+' : '') + item.mpi_velocity.toFixed(1) : '';
      html += '<div class="flex justify-between text-xs"><span>' + (item.symbol || '') + '</span><span class="text-amber-400">' + v + (vel ? ' (' + vel + ')' : '') + '</span></div>';
    });
    el.mpiWidget.innerHTML = html;
  }

  function fetchMpi() {
    fetch('/api/meme/mpi').then(function (r) { return r.json(); }).then(renderMpi).catch(function () {});
  }

  function setHeaderFxKimp(fxUsdKrw, kimpAvg) {
    var fxEl = document.getElementById('header-fx');
    var kimpEl = document.getElementById('header-kimp');
    if (fxEl) fxEl.textContent = fxUsdKrw != null ? 'FX: ' + Number(fxUsdKrw).toLocaleString('ko-KR') : 'FX: —';
    if (kimpEl) kimpEl.textContent = kimpAvg != null ? '김프: ' + (kimpAvg >= 0 ? '+' : '') + Number(kimpAvg).toFixed(2) + '%' : '김프: —';
  }

  function renderMarketContext(ctx) {
    setText('market-score-value', ctx && ctx.marketScore != null ? ctx.marketScore : '—');
    setText('market-multiplier-value', ctx && ctx.recommendedMultiplier != null ? ctx.recommendedMultiplier.toFixed(2) : '—');
  }

  function renderStrategySummary(s) {
    var nameEl = document.getElementById('strategy-name-display');
    var updatedEl = document.getElementById('strategy-updated-at');
    var contentEl = document.getElementById('strategy-summary-content');
    if (!contentEl) return;
    if (!s || !s.created_at) {
      if (nameEl) nameEl.textContent = '—';
      contentEl.textContent = '저장된 전략 없음. 설정에서 저장하면 이곳에 요약이 표시됩니다.';
      if (updatedEl) updatedEl.textContent = '—';
      return;
    }
    if (nameEl) nameEl.textContent = s.strategyName || 'SCALP 기본';
    var parts = [];
    if (s.weights) {
      var w = s.weights;
      parts.push('가중치: 돌파 ' + (w.weight_price_break != null ? w.weight_price_break : '—') + ', Vol ' + (w.weight_vol_surge != null ? w.weight_vol_surge : '—') + ', OBI ' + (w.weight_obi != null ? w.weight_obi : '—') + ', Strength ' + (w.weight_strength != null ? w.weight_strength : '—') + ', 스프레드 ' + (w.weight_spread != null ? w.weight_spread : '—') + ', 깊이 ' + (w.weight_depth != null ? w.weight_depth : '—') + ', 김프 ' + (w.weight_kimp != null ? w.weight_kimp : '—'));
    }
    parts.push('익절 목표 ' + (s.take_profit_target_pct != null ? s.take_profit_target_pct + '%' : '—') + ', 트레일링 ' + (s.trailing_stop_pct != null ? s.trailing_stop_pct + '%' : '—') + ', Score-out ' + (s.score_out_threshold != null ? s.score_out_threshold : '—'));
    parts.push('손절 ' + (s.stop_loss_pct != null ? s.stop_loss_pct + '%' : '—') + ', 타임스탑 ' + (s.time_stop_sec != null ? s.time_stop_sec + '초' : '—'));
    if (s.race_horse_scheduler_enabled) parts.push('경주마 자동 ON');
    contentEl.textContent = parts.join(' · ');
    if (updatedEl) {
      var t = s.created_at;
      if (t.length >= 19) updatedEl.textContent = '마지막 업데이트: ' + t.slice(0, 10) + ' ' + t.slice(11, 19);
      else updatedEl.textContent = '마지막 업데이트: ' + t;
    }
  }

  socket.on('dashboard', function (data) {
    if (data.assets) renderAssets(data.assets, data.fxUsdKrw, data.profitSummary);
    if (data.fxUsdKrw != null || data.kimpAvg != null) setHeaderFxKimp(data.fxUsdKrw, data.kimpAvg);
    if (data.prices) renderPrices(data.prices);
    if (data.kimpByMarket) renderKimp(data.kimpByMarket);
    if (data.fng) renderFng(data.fng);
    if (typeof data.botEnabled === 'boolean') setBotUi(data.botEnabled);
    if (data.trades) renderTrades(data.trades);
    if (data.rejectLogs) renderRejectLogs(data.rejectLogs);
    if (data.marketContext) renderMarketContext(data.marketContext);
    if (data.scalpState) renderScalpState(data.scalpState);
    if (data.logs) renderLogs(data.logs);
    if (data.wsLagMs != null) setWsLag(data.wsLagMs);
    if (data.strategySummary) renderStrategySummary(data.strategySummary);
    if (data.independentScalpStatus && window.updateIndependentScalpPanel) window.updateIndependentScalpPanel(data.independentScalpStatus);
    var banner = document.getElementById('race-horse-banner');
    if (banner) {
      if (data.raceHorseActive) { banner.classList.remove('hidden'); banner.classList.add('flex'); }
      else { banner.classList.add('hidden'); banner.classList.remove('flex'); }
    }
  });

  if (el.botToggle) {
    el.botToggle.addEventListener('click', function () {
      var next = el.botToggle.getAttribute('aria-checked') !== 'true';
      socket.emit('setBot', next);
      setBotUi(next);
    });
  }

  fetch('/api/trades').then(function (r) { return r.json(); }).then(renderTrades).catch(function () {});
  fetch('/api/strategy-current').then(function (r) { return r.json(); }).then(renderStrategySummary).catch(function () {});
  fetchMpi();
  setInterval(fetchMpi, 60000);

  if (el.soundCheck) {
    el.soundCheck.addEventListener('change', function () {
      soundEnabled = el.soundCheck.checked;
    });
    soundEnabled = el.soundCheck.checked;
  }
  if (el.vibrateCheck) {
    el.vibrateCheck.addEventListener('change', function () {
      vibrationEnabled = el.vibrateCheck.checked;
      try { localStorage.setItem('logVibrate', vibrationEnabled ? '1' : '0'); } catch (e) {}
    });
  }

  var logExpandBtn = document.getElementById('log-expand-btn');
  var logFullscreenClose = document.getElementById('log-fullscreen-close');
  if (logExpandBtn && el.logFullscreen) {
    logExpandBtn.addEventListener('click', function () {
      logFullscreenOpen = true;
      el.logFullscreen.classList.remove('hidden');
      el.logFullscreen.classList.add('flex');
      if (el.logFullscreenContainer && lastLogsArray.length) {
        var full = lastLogsArray.slice(-100);
        el.logFullscreenContainer.innerHTML = full.map(function (l) {
          return '<div class="leading-relaxed">' + colorizeLogLine(l) + '</div>';
        }).join('');
        el.logFullscreenContainer.scrollTop = el.logFullscreenContainer.scrollHeight;
      }
    });
  }
  if (logFullscreenClose && el.logFullscreen) {
    logFullscreenClose.addEventListener('click', function () {
      logFullscreenOpen = false;
      el.logFullscreen.classList.add('hidden');
      el.logFullscreen.classList.remove('flex');
      if (el.logContainer && lastLogsArray.length) {
        var toShow = lastLogsArray.slice(-3);
        el.logContainer.innerHTML = toShow.map(function (l) {
          return '<div class="leading-relaxed">' + colorizeLogLine(l) + '</div>';
        }).join('');
      }
    });
  }
  if (el.logFullscreen) {
    el.logFullscreen.addEventListener('click', function (e) {
      if (e.target === el.logFullscreen) {
        logFullscreenOpen = false;
        el.logFullscreen.classList.add('hidden');
        el.logFullscreen.classList.remove('flex');
      }
    });
  }

  var apiPopup = document.getElementById('api-popup-overlay');
  var apiPopupMsg = document.getElementById('api-popup-message');
  var apiPopupSysdate = document.getElementById('api-popup-sysdate');
  document.getElementById('api-check-btn').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    btn.textContent = '확인 중…';
    fetch('/api/check-upbit')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          apiPopupMsg.textContent = '연결완료 : ' + (data.sysdate || '');
          apiPopupMsg.className = 'text-center font-medium text-emerald-400';
          apiPopupSysdate.textContent = '';
        } else {
          apiPopupMsg.textContent = '연결 실패';
          apiPopupMsg.className = 'text-center font-medium text-red-400';
          apiPopupSysdate.textContent = (data.sysdate ? data.sysdate + ' · ' : '') + (data.message || '');
        }
        apiPopup.classList.remove('hidden');
        apiPopup.classList.add('flex');
      })
      .catch(function (err) {
        apiPopupMsg.textContent = '연결 실패';
        apiPopupMsg.className = 'text-center font-medium text-red-400';
        apiPopupSysdate.textContent = err.message || '요청 오류';
        apiPopup.classList.remove('hidden');
        apiPopup.classList.add('flex');
      })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = 'API 연결 확인';
      });
  });
  document.getElementById('api-popup-close').addEventListener('click', function () {
    apiPopup.classList.add('hidden');
    apiPopup.classList.remove('flex');
  });
  apiPopup.addEventListener('click', function (e) {
    if (e.target === apiPopup) {
      apiPopup.classList.add('hidden');
      apiPopup.classList.remove('flex');
    }
  });

  socket.on('connect', function () {
    if (el.connectionStatus) {
      el.connectionStatus.textContent = '연결됨';
      el.connectionStatus.classList.add('text-emerald-500');
    }
  });
  socket.on('disconnect', function () {
    if (el.connectionStatus) {
      el.connectionStatus.textContent = '연결 끊김';
      el.connectionStatus.classList.remove('text-emerald-500');
    }
  });
})();
