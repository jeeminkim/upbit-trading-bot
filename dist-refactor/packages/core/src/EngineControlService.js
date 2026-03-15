"use strict";
/**
 * 엔진 수동 lifecycle 제어: 서비스 기동 ≠ 매매 엔진 기동.
 * 기본 상태 STOPPED. startEngine(updatedBy) / stopEngine(updatedBy) 로만 전이.
 * 중복 start/stop 은 no-op.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EngineControlService = void 0;
const EventBus_1 = require("./EventBus");
const EngineStateService_1 = require("./EngineStateService");
let state = {
    status: 'STOPPED',
    startedAt: null,
    stoppedAt: null,
    updatedBy: 'system',
    lastReason: 'initial',
};
function logEngineState(tag, payload) {
    try {
        console.log('[ENGINE_STATE]', tag, payload);
    }
    catch (_) { }
}
logEngineState('initial state', { status: state.status });
exports.EngineControlService = {
    getState() {
        return { ...state };
    },
    /**
     * @returns { started: boolean, noop?: boolean, message?: string }
     */
    startEngine(updatedBy) {
        if (state.status === 'RUNNING' || state.status === 'STARTING') {
            logEngineState('start skipped (already running)', { status: state.status });
            return { started: false, noop: true, message: '이미 실행 중입니다.' };
        }
        logEngineState('start requested', { updatedBy });
        state.status = 'STARTING';
        state.updatedBy = updatedBy;
        state.lastReason = 'manual_start';
        EventBus_1.EventBus.emit('ENGINE_START_REQUESTED', { status: 'STARTING', updatedBy, at: new Date().toISOString() });
        state.status = 'RUNNING';
        state.startedAt = new Date().toISOString();
        state.stoppedAt = null;
        EngineStateService_1.EngineStateService.setBotEnabled(true);
        EventBus_1.EventBus.emit('ENGINE_STARTED', {
            status: 'RUNNING',
            updatedBy,
            at: state.startedAt,
            runtimeMode: null,
        });
        logEngineState('start success', { startedAt: state.startedAt });
        return { started: true, message: '자동매매 엔진이 시작되었습니다.' };
    },
    /**
     * @returns { stopped: boolean, noop?: boolean, message?: string }
     */
    stopEngine(updatedBy) {
        if (state.status === 'STOPPED' || state.status === 'STOPPING') {
            logEngineState('stop skipped (already stopped)', { status: state.status });
            return { stopped: false, noop: true, message: '이미 중지 상태입니다.' };
        }
        logEngineState('stop requested', { updatedBy });
        state.status = 'STOPPING';
        state.updatedBy = updatedBy;
        state.lastReason = 'manual_stop';
        EventBus_1.EventBus.emit('ENGINE_STOP_REQUESTED', { status: 'STOPPING', updatedBy, at: new Date().toISOString() });
        state.status = 'STOPPED';
        state.stoppedAt = new Date().toISOString();
        EngineStateService_1.EngineStateService.setBotEnabled(false);
        EventBus_1.EventBus.emit('ENGINE_STOPPED', {
            status: 'STOPPED',
            updatedBy,
            at: state.stoppedAt,
        });
        logEngineState('stop success', { stoppedAt: state.stoppedAt });
        return { stopped: true, message: '자동매매 엔진을 중지했습니다.' };
    },
};
