/**
 * HTS 스타일 프론트: 체결 플래시(상승=빨강/하락=파랑), 호가 강도 바, ws_lag_ms, 로그 색상 [BUY][BLOCKED][EXIT]
 */

(function () {
  const socket = io();
  const botToggle = document.getElementById('bot-toggle');
  const botLabel = document.getElementById('bot-label');
  const connectionStatus = document.getElementById('connection-status');
  const logContainer = document.getElementById('log-container');
  const tradesContainer = document.getElementById('trades-container');
  const fngFill = document.getElementById('fng-fill');
  const fngValueEl = document.getElementById('fng-value');
  const wsLagEl = document.getElementById('ws-lag-ms');

  const lastPrices = { BTC: null, ETH: null, XRP: null, SOL: null };

  function formatKrw(num) {
    if (num == null) return '—';
    return new Intl.NumberFormat('ko-KR').format(Math.round(num)) + ' 원';
  }

  function formatPct(num) {
    if (num == null) return '—';
    const s = num >= 0 ? '+' : '';
    return s + num.toFixed(2) + ' %';
  }

  function flashPrice(sym, direction) {
    const el = document.getElementById('price-' + sym);
    if (!el) return;
    el.classList.remove('price-flash-up', 'price-flash-down');
    el.offsetHeight;
    el.classList.add(direction === 'up' ? 'price-flash-up' : 'price-flash-down');
    setTimeout(function () {
      el.classList.remove('price-flash-up', 'price-flash-down');
    }, 400);
  }

  function renderAssets(assets) {
    if (!assets) return;
    document.getElementById('asset-buy').textContent = formatKrw(assets.totalBuyKrw);
    document.getElementById('asset-eval').textContent = formatKrw(assets.totalEvaluationKrw);
    document.getElementById('asset-orderable').textContent = formatKrw(assets.orderableKrw);
    const buy = assets.totalBuyKrw || 0;
    const evalKrw = assets.totalEvaluationKrw || 0;
    const pnl = evalKrw - buy;
    const rate = buy > 0 ? (pnl / buy) * 100 : 0;
    const pnlEl = document.getElementById('asset-pnl');
    const rateEl = document.getElementById('asset-rate');
    pnlEl.textContent = formatKrw(pnl);
    rateEl.textContent = formatPct(rate);
    if (rate > 0) {
      pnlEl.className = 'text-lg font-bold mt-1 text-emerald-400';
      rateEl.className = 'text-lg font-bold mt-1 text-emerald-400';
    } else if (rate < 0) {
      pnlEl.className = 'text-lg font-bold mt-1 text-red-400';
      rateEl.className = 'text-lg font-bold mt-1 text-red-400';
    } else {
      pnlEl.className = 'text-lg font-bold mt-1 text-slate-300';
      rateEl.className = 'text-lg font-bold mt-1 text-slate-300';
    }
  }

  function renderPrices(prices) {
    ['BTC', 'ETH', 'XRP', 'SOL'].forEach(function (sym) {
      const m = 'KRW-' + sym;
      const p = prices && prices[m];
      const str = p ? formatKrw(p.tradePrice) : '—';
      const el = document.getElementById('price-' + sym);
      if (el) {
        const prev = lastPrices[sym];
        if (prev != null && p && p.tradePrice !== prev) {
          flashPrice(sym, p.tradePrice > prev ? 'up' : 'down');
        }
        lastPrices[sym] = p?.tradePrice ?? null;
        el.textContent = str;
      }
    });
  }

  function renderScalpState(scalpState) {
    ['BTC', 'ETH', 'XRP', 'SOL'].forEach(function (sym) {
      const m = 'KRW-' + sym;
      const s = scalpState && scalpState[m];
      const el = document.getElementById('scalp-' + sym);
      if (!el) return;
      if (!s) {
        el.innerHTML = '<span class="text-slate-600">—</span><div class="mt-1 h-1.5 bg-slate-700 rounded overflow-hidden"><div class="h-full bg-slate-600 rounded" style="width:0%"></div></div>';
        return;
      }
      const score = s.entryScore != null ? s.entryScore : '—';
      const p0 = s.p0GateStatus || 'OK';
      const p0Class = p0 === 'OK' ? 'text-emerald-500' : 'text-amber-500';
      const strength = (s.strength_proxy_60s != null ? Math.max(0, Math.min(1, s.strength_proxy_60s)) : 0.5) * 100;
      el.innerHTML =
        '<div>Entry Score: <span class="font-medium text-amber-400">' + score + '</span>/7</div>' +
        '<div class="' + p0Class + '">P0: ' + escapeHtml(p0) + '</div>' +
        '<div class="mt-1 text-slate-500 text-xs">Strength</div>' +
        '<div class="mt-0.5 h-1.5 bg-slate-700 rounded overflow-hidden"><div class="h-full bg-emerald-500 rounded transition-all duration-300" style="width:' + strength + '%"></div></div>';
    });
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function colorizeLogLine(line) {
    var tags = [
      { re: /\[BUY\]/g, cls: 'text-emerald-400 font-semibold' },
      { re: /\[BLOCKED\]/g, cls: 'text-yellow-400 font-semibold' },
      { re: /\[EXIT\]/g, cls: 'text-red-400 font-semibold' },
      { re: /\[EXIT.*손절\]/g, cls: 'text-red-400 font-semibold' },
      { re: /\[EXIT.*청산\]/g, cls: 'text-blue-400 font-semibold' },
      { re: /\[매수신호\]/g, cls: 'text-emerald-400 font-semibold' },
      { re: /\[매도완료\]/g, cls: 'text-blue-400 font-semibold' },
      { re: /\[에러\]/g, cls: 'text-red-400 font-semibold' },
      { re: /\[SCALP\]/g, cls: 'text-amber-400 font-semibold' }
    ];
    var html = escapeHtml(line);
    tags.forEach(function (t) {
      html = html.replace(t.re, '<span class="' + t.cls + '">$&</span>');
    });
    return html;
  }

  function renderLogs(logs) {
    if (!Array.isArray(logs)) return;
    logContainer.innerHTML = logs.slice(-80).map(function (l) {
      return '<div>' + colorizeLogLine(l) + '</div>';
    }).join('');
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  function renderTrades(trades) {
    if (!Array.isArray(trades) || trades.length === 0) {
      tradesContainer.innerHTML = '<p class="text-slate-500">거래 내역 없음 (DB)</p>';
      return;
    }
    tradesContainer.innerHTML = trades.map(function (t) {
      var side = (t.side || '').toLowerCase() === 'sell' ? '매도' : '매수';
      var sideCls = side === '매도' ? 'text-blue-400' : 'text-emerald-400';
      var price = t.price != null ? formatKrw(t.price) : '—';
      var qty = t.quantity != null ? t.quantity : '—';
      var time = (t.timestamp || '').slice(0, 19).replace('T', ' ');
      var reason = t.reason ? ' <span class="text-slate-500">' + escapeHtml(t.reason) + '</span>' : '';
      return '<div class="py-2 border-b border-slate-700 last:border-0"><span class="' + sideCls + '">' + side + '</span> ' + escapeHtml(t.ticker || '') + ' ' + price + ' × ' + qty + reason + ' <span class="text-slate-500 text-xs">' + escapeHtml(time) + '</span></div>';
    }).join('');
  }

  function renderFng(fng) {
    if (!fng || fng.value == null) {
      fngValueEl.textContent = '—';
      fngFill.setAttribute('stroke-dashoffset', 97);
      return;
    }
    fngValueEl.textContent = fng.value;
    var pct = fng.value / 100;
    fngFill.setAttribute('stroke-dashoffset', 97 - 97 * pct);
    if (fng.value <= 25) fngFill.setAttribute('class', 'gauge-fill stroke-red-500 fill-none stroke-[8] stroke-linecap-round');
    else if (fng.value >= 75) fngFill.setAttribute('class', 'gauge-fill stroke-emerald-500 fill-none stroke-[8] stroke-linecap-round');
    else fngFill.setAttribute('class', 'gauge-fill stroke-amber-500 fill-none stroke-[8] stroke-linecap-round');
  }

  function setWsLag(ms) {
    if (!wsLagEl) return;
    wsLagEl.textContent = ms != null ? 'ws_lag: ' + ms + ' ms' : 'ws_lag: —';
  }

  function setBotUi(enabled) {
    botToggle.setAttribute('aria-checked', enabled);
    botLabel.textContent = enabled ? 'ON' : 'OFF';
    var thumb = document.getElementById('bot-thumb');
    if (enabled) {
      botToggle.classList.add('bg-emerald-600');
      botToggle.classList.remove('bg-slate-600');
      thumb.classList.add('translate-x-5');
      thumb.classList.remove('translate-x-0.5');
    } else {
      botToggle.classList.remove('bg-emerald-600');
      botToggle.classList.add('bg-slate-600');
      thumb.classList.remove('translate-x-5');
      thumb.classList.add('translate-x-0.5');
    }
  }

  socket.on('dashboard', function (data) {
    if (data.assets) renderAssets(data.assets);
    if (data.prices) renderPrices(data.prices);
    if (data.fng) renderFng(data.fng);
    if (typeof data.botEnabled === 'boolean') setBotUi(data.botEnabled);
    if (data.trades) renderTrades(data.trades);
    if (data.scalpState) renderScalpState(data.scalpState);
    if (data.logs) renderLogs(data.logs);
    if (data.wsLagMs != null) setWsLag(data.wsLagMs);
  });

  botToggle.addEventListener('click', function () {
    var next = botToggle.getAttribute('aria-checked') !== 'true';
    socket.emit('setBot', next);
    setBotUi(next);
  });

  fetch('/api/trades').then(function (r) { return r.json(); }).then(renderTrades).catch(function () {});

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
    connectionStatus.textContent = '연결됨';
    connectionStatus.classList.add('text-emerald-500');
  });
  socket.on('disconnect', function () {
    connectionStatus.textContent = '연결 끊김';
    connectionStatus.classList.remove('text-emerald-500');
  });
})();
