/**
 * 독립 초단타 스캘프 봇 패널 — dashboard 소켓의 independentScalpStatus로 UI 갱신
 */
(function () {
  'use strict';

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function formatRemainingMs(ms) {
    if (ms == null || ms <= 0) return '00:00:00';
    var totalSec = Math.floor(ms / 1000);
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    return pad2(h) + ':' + pad2(m) + ':' + pad2(s);
  }

  window.updateIndependentScalpPanel = function (status) {
    if (!status) return;
    var statusEl = document.getElementById('scalp-status');
    var timerEl = document.getElementById('scalp-timer');
    var entriesEl = document.getElementById('scalp-entries');
    var pnlEl = document.getElementById('scalp-pnl');
    var priorityEl = document.getElementById('scalp-priority');
    var riskHaltEl = document.getElementById('scalp-risk-halt');

    if (statusEl) statusEl.textContent = status.isRunning ? (status.isRiskHalt ? 'RISK_HALT' : 'RUNNING') : 'STOPPED';
    if (timerEl) timerEl.textContent = formatRemainingMs(status.remainingMs);
    if (entriesEl) entriesEl.textContent = status.dailyEntries != null ? status.dailyEntries : '0';
    if (pnlEl) {
      var pnl = status.dailyPnl != null ? status.dailyPnl : 0;
      pnlEl.textContent = (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '%';
      pnlEl.className = 'font-mono ' + (pnl > 0 ? 'text-red-400' : pnl < 0 ? 'text-blue-400' : 'text-slate-200');
    }
    if (priorityEl) priorityEl.textContent = status.priorityOwner || 'MAIN';
    if (riskHaltEl) {
      if (status.isRiskHalt) {
        riskHaltEl.classList.remove('hidden');
      } else {
        riskHaltEl.classList.add('hidden');
      }
    }
  };
})();
