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
exports.EngineControlService = {
    getState() {
        return { ...state };
    },
    /**
     * @returns { started: boolean, noop?: boolean, message?: string }
     */
    startEngine(updatedBy) {
        if (state.status === 'RUNNING' || state.status === 'STARTING') {
            return { started: false, noop: true, message: '이미 실행 중입니다.' };
        }
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
        return { started: true, message: '매매 엔진을 시작합니다.' };
    },
    /**
     * @returns { stopped: boolean, noop?: boolean, message?: string }
     */
    stopEngine(updatedBy) {
        if (state.status === 'STOPPED' || state.status === 'STOPPING') {
            return { stopped: false, noop: true, message: '이미 정지 상태입니다.' };
        }
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
        return { stopped: true, message: '매매 엔진을 정지했습니다.' };
    },
};
