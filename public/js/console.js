(function () {
  'use strict';

  const socket = io();
  const $ = (id) => document.getElementById(id);
  const statusEl = $('ws-status');

  socket.on('connect', function () {
    if (statusEl) {
      statusEl.textContent = '연결됨';
      statusEl.className = 'text-emerald-500 text-sm';
    }
  });
  socket.on('disconnect', function () {
    if (statusEl) {
      statusEl.textContent = '연결 끊김';
      statusEl.className = 'text-red-400 text-sm';
    }
  });

  socket.on('console:system_status', function (d) {
    if (!d) return;
    setText('sys-engine', d.engine ?? '—');
    setText('sys-market', d.marketData ?? '—');
    setText('sys-exchange', d.exchange ?? '—');
    setText('sys-latency', d.latencyMs != null ? d.latencyMs + 'ms' : '—');
    setText('sys-circuit', d.circuitBreaker ?? '—');
    setText('sys-uptime', d.uptimeSec != null ? d.uptimeSec + 's' : '—');
  });

  socket.on('console:market_state', function (d) {
    if (!d) return;
    setText('mkt-mode', d.mode ?? '—');
    setText('mkt-vol', d.volatility ?? '—');
    setText('mkt-spread', d.spreadBps != null ? d.spreadBps + 'bps' : (d.spread ?? '—'));
    setText('mkt-liq', d.liquidity ?? '—');
  });

  socket.on('console:strategy_signals', function (arr) {
    const el = $('strategy-signals');
    if (!el) return;
    if (!Array.isArray(arr) || arr.length === 0) {
      el.innerHTML = '<div class="text-slate-500">—</div>';
      return;
    }
    el.innerHTML = arr.map(function (s) {
      const edge = s.edgeBps != null ? s.edgeBps + 'bps' : '—';
      const rot = s.rotationCandidate ? ' <span class="text-amber-400">ROTATION</span>' : '';
      return '<div class="flex justify-between gap-2">' +
        '<span>' + (s.coin || '—') + '</span>' +
        '<span>' + (s.signalType || 'HOLD') + ' edge ' + edge + rot + '</span>' +
        '</div>';
    }).join('');
  });

  socket.on('console:positions', function (arr) {
    const el = $('positions');
    if (!el) return;
    if (!Array.isArray(arr) || arr.length === 0) {
      el.innerHTML = '<div class="text-slate-500">—</div>';
      return;
    }
    el.innerHTML = arr.map(function (p) {
      const pnlClass = (p.pnlPct || 0) >= 0 ? 'text-emerald-400' : 'text-red-400';
      const pnlStr = (p.pnlPct != null ? (p.pnlPct >= 0 ? '+' : '') + p.pnlPct.toFixed(2) + '%' : '—');
      return '<div class="border-b border-slate-700/50 pb-1">' +
        '<div class="font-medium">' + (p.coin || '—') + '</div>' +
        '<div class="text-slate-400 text-xs">entry ' + formatNum(p.entryPrice) + ' · size ' + (p.size != null ? p.size : '—') + '</div>' +
        '<div class="' + pnlClass + '">pnl ' + pnlStr + ' · ' + (p.holdTimeMin != null ? p.holdTimeMin + ' min' : '—') + '</div>' +
        '</div>';
    }).join('');
  });

  socket.on('console:execution_log', function (arr) {
    const el = $('execution-log');
    if (!el) return;
    if (!Array.isArray(arr) || arr.length === 0) {
      el.innerHTML = '<div class="text-slate-500">—</div>';
      return;
    }
    el.innerHTML = '<div class="text-slate-500 text-xs mb-1">symbol | strategy | raw | norm | final | threshold | action | skip_reason</div>' +
      arr.slice(0, 50).map(function (e) {
        const t = (e.time || '').slice(11, 19) || '—';
        const action = (e.action || e.decision || '—').toUpperCase();
        const sideClass = action === 'BUY' ? 'text-emerald-400' : action === 'SELL' ? 'text-red-400' : 'text-slate-400';
        const sym = e.symbol || e.coin || '—';
        const strat = e.source_strategy || '—';
        const raw = e.raw_entry_score != null ? e.raw_entry_score : '—';
        const norm = e.normalized_score != null ? Number(e.normalized_score).toFixed(2) : '—';
        const final = e.final_orchestrator_score != null ? Number(e.final_orchestrator_score).toFixed(2) : '—';
        const thresh = e.threshold_entry != null ? Number(e.threshold_entry).toFixed(2) : '—';
        const skip = e.skip_reason ? 'SKIP(' + e.skip_reason + ')' : action;
        const reason = e.reason_summary || e.reason || '';
        return '<div class="flex flex-wrap gap-x-2 gap-y-0 items-baseline">' +
          '<span class="text-slate-500 shrink-0">' + t + '</span>' +
          '<span class="font-medium">' + sym + '</span>' +
          '<span class="text-slate-500">' + strat + '</span>' +
          '<span class="text-slate-400">raw ' + raw + '</span>' +
          '<span class="text-slate-400">norm ' + norm + '</span>' +
          '<span class="text-slate-400">final ' + final + '</span>' +
          '<span class="text-slate-400">thr ' + thresh + '</span>' +
          '<span class="' + sideClass + '">' + skip + '</span>' +
          (reason ? '<span class="text-slate-500 truncate max-w-[12rem]" title="' + escapeHtml(reason) + '">' + escapeHtml(reason) + '</span>' : '') +
          '</div>';
      }).join('');
    el.scrollTop = 0;
  });

  socket.on('console:risk_monitor', function (d) {
    if (!d) return;
    setText('risk-exposure', d.exposurePct != null ? d.exposurePct.toFixed(1) + '%' : '—');
    const dailyClass = (d.dailyPnlPct || 0) >= 0 ? 'text-emerald-400' : 'text-red-400';
    setText('risk-daily', d.dailyPnlPct != null ? (d.dailyPnlPct >= 0 ? '+' : '') + d.dailyPnlPct.toFixed(2) + '%' : '—', dailyClass);
    setText('risk-drawdown', d.drawdownPct != null ? d.drawdownPct + '%' : '—');
    setText('risk-limit', d.riskLimit ?? '—');
  });

  socket.on('console:circuit_breaker', function (d) {
    if (!d) return;
    const el = $('sys-circuit');
    if (el) el.textContent = (d.upbit || '—') + ' / ' + (d.gemini || '—');
  });

  socket.on('console:strategy_config', function (d) {
    if (!d) return;
    setText('strat-mode', d.mode ?? '—');
    setText('strat-desc', d.description ? ' · ' + d.description : '');
    setText('strat-threshold', d.thresholdEntry != null ? d.thresholdEntry : '—');
    setText('strat-min-score', d.minOrchestratorScore != null ? d.minOrchestratorScore : '—');
    setText('strat-updated-at', d.updatedAt ? (d.updatedAt.slice(0, 19).replace('T', ' ')) : '—');
    setText('strat-updated-by', d.updatedBy ?? '—');
    setText('strat-trade-count', d.tradeCountLast30m != null ? d.tradeCountLast30m : '—');
    setText('strat-decision-count', d.decisionCountLast30m != null ? d.decisionCountLast30m : '—');
    const distEl = $('strat-skip-dist');
    if (distEl && d.skipReasonDistribution && typeof d.skipReasonDistribution === 'object') {
      const parts = Object.entries(d.skipReasonDistribution).map(function (kv) { return kv[0] + ': ' + kv[1]; });
      distEl.textContent = 'skip(30m): ' + (parts.length ? parts.join(', ') : '—');
    }
  });

  (function setupStrategyModeButtons() {
    document.querySelectorAll('.strategy-mode-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const mode = this.getAttribute('data-mode');
        if (!mode) return;
        fetch('/api/strategy-mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: mode, updatedBy: 'dashboard' }),
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.ok) {
              setText('strat-mode', data.mode);
              setText('strat-threshold', data.thresholdEntry);
              setText('strat-min-score', data.minOrchestratorScore);
              setText('strat-updated-at', data.updatedAt ? data.updatedAt.slice(0, 19).replace('T', ' ') : '—');
              setText('strat-updated-by', data.updatedBy || 'dashboard');
            }
          })
          .catch(function () {});
      });
    });
  })();

  function setText(id, text, className) {
    const el = $(id);
    if (!el) return;
    el.textContent = text != null ? String(text) : '—';
    if (className) el.className = className;
  }

  function formatNum(n) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString('ko-KR');
  }

  function escapeHtml(s) {
    if (typeof s !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }
})();
