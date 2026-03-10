/**
 * 매매 주기 루프 통합 — 모든 setInterval 소유, 정지 시 clearInterval로 좀비 루프 원천 차단
 * - start(): 메인 폴, FX, 시황분석, persist, rejectLog emit, DB/시스템 클린업 등 스케줄
 * - stop(): 모든 타이머 해제 + serviceStopped 설정
 * - isProcessing 락으로 fetchAssets/runScalpCycle 등 중복 실행 방지
 * - EMERGENCY_PAUSE 시 runOneTick 생략, emitDashboard만 수행 (로그 flood 방지)
 */

const path = require('path');
const ApiAccessPolicy = require(path.join(__dirname, '../../src/domain/state/ApiAccessPolicy'));
const EngineMode = require(path.join(__dirname, '../../src/domain/state/EngineMode'));

class TradingEngine {
  constructor(stateStore, options = {}) {
    this.stateStore = stateStore;
    this.ASSET_POLL_MS = options.ASSET_POLL_MS ?? 1000;
    this.FX_POLL_MS = options.FX_POLL_MS ?? 60000;
    this.MEDIUM_TERM_MS = options.MEDIUM_TERM_MS ?? 60 * 1000;
    this.DAILY_TERM_MS = options.DAILY_TERM_MS ?? 5 * 60 * 1000;
    this.PERSIST_MS = options.PERSIST_MS ?? 60 * 1000;
    this.REJECT_EMIT_MS = options.REJECT_EMIT_MS ?? 1000;
    this.CLEANUP_INTERVAL_MS = options.CLEANUP_INTERVAL_MS ?? 4 * 60 * 60 * 1000;
    this.CLEANUP_HOUR_4AM = options.CLEANUP_HOUR_4AM ?? 4;

    this.intervalIds = [];
    this.timeoutIds = [];
    this.isProcessing = false;
    this._running = false;
    this.abortController = null;
    this._setAbortController = null;
  }

  _clearAll() {
    this.intervalIds.forEach((id) => {
      if (id != null) clearInterval(id);
    });
    this.intervalIds = [];
    this.timeoutIds.forEach((id) => {
      if (id != null) clearTimeout(id);
    });
    this.timeoutIds = [];
    this._running = false;
  }

  /**
   * 정지: 모든 주기 호출 중단, 진행 중인 Upbit fetch 요청 취소, serviceStopped 플래그 설정
   */
  stop() {
    if (this._setAbortController) {
      try {
        this._setAbortController(null);
      } catch (_) {}
    }
    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch (_) {}
    }
    this._clearAll();
    this.stateStore.update({ serviceStopped: true, botEnabled: false });
  }

  /**
   * 주기 작업 가동. 이미 동작 중이면 무시(재시작 안 함)
   * @param {Object} callbacks - { runOneTick, runFx, runMarketAnalyzerMedium, runMarketAnalyzerDaily, runPersist, runRejectEmit, runCleanup, run4AmCheck }
   */
  start(callbacks) {
    if (this._running) return;
    const c = callbacks || {};
    this.stateStore.update({ serviceStopped: false });

    this.abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    this._setAbortController = typeof c.setAbortController === 'function' ? c.setAbortController : null;
    if (this._setAbortController) {
      try {
        this._setAbortController(this.abortController);
      } catch (_) {}
    }

    const runOneTick = typeof c.runOneTick === 'function' ? c.runOneTick : () => {};
    const runFx = typeof c.runFx === 'function' ? c.runFx : () => {};
    const runMarketAnalyzerMedium = typeof c.runMarketAnalyzerMedium === 'function' ? c.runMarketAnalyzerMedium : () => {};
    const runMarketAnalyzerDaily = typeof c.runMarketAnalyzerDaily === 'function' ? c.runMarketAnalyzerDaily : () => {};
    const runPersist = typeof c.runPersist === 'function' ? c.runPersist : () => {};
    const runRejectEmit = typeof c.runRejectEmit === 'function' ? c.runRejectEmit : () => {};
    const runCleanup = typeof c.runCleanup === 'function' ? c.runCleanup : () => {};
    const run4AmCheck = typeof c.run4AmCheck === 'function' ? c.run4AmCheck : () => {};

    const state = this.stateStore.get();

    const mainPoll = () => {
      if (this.isProcessing) return;
      if (state.serviceStopped) {
        if (c.emitDashboard) c.emitDashboard().catch(() => {});
        return;
      }
      const mode = ApiAccessPolicy.refreshEngineMode(this.stateStore);
      if (mode === EngineMode.EMERGENCY_PAUSE) {
        if (c.emitDashboard) c.emitDashboard().catch(() => {});
        return;
      }
      this.isProcessing = true;
      Promise.resolve()
        .then(runOneTick)
        .catch((err) => {
          if (c.onPollError) c.onPollError(err);
          else console.error('poll error:', err?.message);
        })
        .then(() => (c.emitDashboard ? c.emitDashboard().catch(() => {}) : null))
        .finally(() => {
          this.isProcessing = false;
        });
    };

    const idMain = setInterval(mainPoll, this.ASSET_POLL_MS);
    this.intervalIds.push(idMain);

    const idFx = setInterval(() => {
      if (state.serviceStopped) return;
      runFx();
    }, this.FX_POLL_MS);
    this.intervalIds.push(idFx);

    const idMedium = setInterval(() => {
      if (state.serviceStopped) return;
      runMarketAnalyzerMedium();
    }, this.MEDIUM_TERM_MS);
    this.intervalIds.push(idMedium);

    const idDaily = setInterval(() => {
      if (state.serviceStopped) return;
      runMarketAnalyzerDaily();
    }, this.DAILY_TERM_MS);
    this.intervalIds.push(idDaily);

    const idPersist = setInterval(runPersist, this.PERSIST_MS);
    this.intervalIds.push(idPersist);

    const idRejectEmit = setInterval(runRejectEmit, this.REJECT_EMIT_MS);
    this.intervalIds.push(idRejectEmit);

    const idCleanup = setInterval(runCleanup, this.CLEANUP_INTERVAL_MS);
    this.intervalIds.push(idCleanup);

    const id4Am = setInterval(run4AmCheck, 60 * 1000);
    this.intervalIds.push(id4Am);

    this._running = true;
  }

  isRunning() {
    return this._running;
  }
}

module.exports = TradingEngine;
