/**
 * 엔진 수동 lifecycle 제어: 서비스 기동 ≠ 매매 엔진 기동.
 * 기본 상태 STOPPED. startEngine(updatedBy) / stopEngine(updatedBy) 로만 전이.
 * 중복 start/stop 은 no-op.
 */

import { EventBus } from './EventBus';
import { EngineStateService } from './EngineStateService';

export type EngineLifecycleStatus = 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING';

export interface EngineControlState {
  status: EngineLifecycleStatus;
  startedAt: string | null;
  stoppedAt: string | null;
  updatedBy: string;
  lastReason: string;
}

let state: EngineControlState = {
  status: 'STOPPED',
  startedAt: null,
  stoppedAt: null,
  updatedBy: 'system',
  lastReason: 'initial',
};

function logEngineState(tag: string, payload: object) {
  try {
    console.log('[ENGINE_STATE]', tag, payload);
  } catch (_) {}
}
logEngineState('initial state', { status: state.status });

export const EngineControlService = {
  getState(): Readonly<EngineControlState> {
    return { ...state };
  },

  /**
   * @returns { started: boolean, noop?: boolean, message?: string }
   */
  startEngine(updatedBy: string): { started: boolean; noop?: boolean; message?: string } {
    if (state.status === 'RUNNING' || state.status === 'STARTING') {
      logEngineState('start skipped (already running)', { status: state.status });
      return { started: false, noop: true, message: '이미 실행 중입니다.' };
    }
    logEngineState('start requested', { updatedBy });
    state.status = 'STARTING';
    state.updatedBy = updatedBy;
    state.lastReason = 'manual_start';
    EventBus.emit('ENGINE_START_REQUESTED', { status: 'STARTING', updatedBy, at: new Date().toISOString() });

    state.status = 'RUNNING';
    state.startedAt = new Date().toISOString();
    state.stoppedAt = null;
    EngineStateService.setBotEnabled(true);
    EventBus.emit('ENGINE_STARTED', {
      status: 'RUNNING',
      updatedBy,
      at: state.startedAt,
      runtimeMode: null as string | null,
    });
    logEngineState('start success', { startedAt: state.startedAt });
    return { started: true, message: '자동매매 엔진이 시작되었습니다.' };
  },

  /**
   * @returns { stopped: boolean, noop?: boolean, message?: string }
   */
  stopEngine(updatedBy: string): { stopped: boolean; noop?: boolean; message?: string } {
    if (state.status === 'STOPPED' || state.status === 'STOPPING') {
      logEngineState('stop skipped (already stopped)', { status: state.status });
      return { stopped: false, noop: true, message: '이미 중지 상태입니다.' };
    }
    logEngineState('stop requested', { updatedBy });
    state.status = 'STOPPING';
    state.updatedBy = updatedBy;
    state.lastReason = 'manual_stop';
    EventBus.emit('ENGINE_STOP_REQUESTED', { status: 'STOPPING', updatedBy, at: new Date().toISOString() });

    state.status = 'STOPPED';
    state.stoppedAt = new Date().toISOString();
    EngineStateService.setBotEnabled(false);
    EventBus.emit('ENGINE_STOPPED', {
      status: 'STOPPED',
      updatedBy,
      at: state.stoppedAt,
    });
    logEngineState('stop success', { stoppedAt: state.stoppedAt });
    return { stopped: true, message: '자동매매 엔진을 중지했습니다.' };
  },
};
