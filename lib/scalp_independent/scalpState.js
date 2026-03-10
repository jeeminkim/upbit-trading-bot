/**
 * 독립 초단타 스캘프 봇 — 상태·타이머·우선권·연속손실 halt 관리
 * - priorityOwner: 'MAIN' | 'SCALP' (SCALP 시 메인 오케스트레이터 진입 차단)
 * - 3시간 시한부, 1시간 미만 시 연장 가능
 * - 연속 3회 손실 시 30분 RISK_HALT
 */

const fs = require('fs');
const path = require('path');

class ScalpState {
  constructor() {
    this.isRunning = false;
    this.isRaceHorseMode = false; // 초공격 모드
    this.endTime = null; // 종료 예정 시각 (ms)
    this.priorityOwner = 'MAIN'; // 'MAIN' | 'SCALP'
    this.dailyEntries = 0;
    this.dailyPnl = 0;
    this.consecutiveLosses = 0;
    this.lastEntryTime = null;
    this.activePosition = null; // { symbol, entryPrice, entryTime, strategy, quantityKrw }
    this.riskHaltUntil = 0; // 연속 손실 후 30분 진입 금지 종료 시각 (ms)
    this.config = {
      duration: 3 * 60 * 60 * 1000, // 3시간
      extendThreshold: 1 * 60 * 60 * 1000, // 1시간 미만 시 연장 가능
      haltAfterConsecutiveLosses: 3,
      haltDurationMs: 30 * 60 * 1000 // 30분
    };
  }

  activate(mode = 'NORMAL') {
    const now = Date.now();
    this.isRunning = true;
    this.endTime = now + this.config.duration;
    this.priorityOwner = 'SCALP';
    if (mode === 'SUPER_AGGRESSIVE') this.isRaceHorseMode = true;
  }

  /** 서버 재기동 시 system_state.json 복구용. endTime(ms)만 복원 */
  restoreFromPersistence(endTime) {
    if (endTime == null || typeof endTime !== 'number') return;
    if (Date.now() >= endTime) return;
    this.isRunning = true;
    this.endTime = endTime;
    this.priorityOwner = 'SCALP';
  }

  /** 1시간 미만일 때만 연장. expiryTime에 3시간(ms) 추가. 남은 시간 = (expiryTime - Date.now()) / (1000*60) 분 */
  extend() {
    const now = Date.now();
    const remain = this.endTime != null ? this.endTime - now : 0;
    if (remain > 0 && remain < this.config.extendThreshold) {
      this.endTime += this.config.duration; // 3 * 60 * 60 * 1000
      return true;
    }
    return false;
  }

  checkExpiry() {
    if (this.isRunning && this.endTime != null && Date.now() > this.endTime) {
      this.stop();
    }
  }

  /** 연속 손실 시 RISK_HALT 설정 */
  recordLoss() {
    this.consecutiveLosses += 1;
    if (this.consecutiveLosses >= this.config.haltAfterConsecutiveLosses) {
      this.riskHaltUntil = Date.now() + this.config.haltDurationMs;
    }
  }

  recordWin() {
    this.consecutiveLosses = 0;
  }

  /** 현재 RISK_HALT 중인지 */
  isRiskHalt() {
    return Date.now() < this.riskHaltUntil;
  }

  stop() {
    this.isRunning = false;
    this.isRaceHorseMode = false;
    this.endTime = null;
    this.priorityOwner = 'MAIN';
    this.activePosition = null; // 만료/정지 후 메인 runExitPipeline이 해당 마켓 청산 담당하도록 정리
  }

  getRemainingMs() {
    if (!this.endTime || !this.isRunning) return 0;
    const r = this.endTime - Date.now();
    return r > 0 ? r : 0;
  }
}

module.exports = new ScalpState();
