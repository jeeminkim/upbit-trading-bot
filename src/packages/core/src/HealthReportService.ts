import { EngineStateService } from './EngineStateService';
import { CircuitBreakerService } from './CircuitBreakerService';

export interface HealthReport {
  process: string;
  uptimeSec: number;
  lastOrderAt: string | null;
  errorsLast1h: number;
  geminiFailuresLast1h: number;
  upbitAuthOk: boolean;
  discordConnected: boolean;
  lastEmitAt: string | null;
  memoryMb: number;
  cpuPercent: number;
  circuitUpbit: string;
  circuitGemini: string;
  reportedAt: string;
}

let errorsLast1h = 0;
let geminiFailuresLast1h = 0;
let lastEmitAt: string | null = null;

export const HealthReportService = {
  recordError(): void {
    errorsLast1h++;
  },
  recordGeminiFailure(): void {
    geminiFailuresLast1h++;
  },
  setLastEmitAt(iso: string): void {
    lastEmitAt = iso;
  },
  resetHourlyCounters(): void {
    errorsLast1h = 0;
    geminiFailuresLast1h = 0;
  },

  build(processName: string, opts: { upbitAuthOk: boolean; discordConnected: boolean }): HealthReport {
    const state = EngineStateService.getState();
    const mem = process.memoryUsage();
    const memoryMb = Math.round(mem.heapUsed / 1024 / 1024);
    const start = (process as NodeJS.Process).hrtime?.() ? 0 : 0;
    const uptimeSec = Math.floor(process.uptime());
    return {
      process: processName,
      uptimeSec,
      lastOrderAt: state.lastOrderAt,
      errorsLast1h,
      geminiFailuresLast1h,
      upbitAuthOk: opts.upbitAuthOk,
      discordConnected: opts.discordConnected,
      lastEmitAt,
      memoryMb,
      cpuPercent: 0,
      circuitUpbit: CircuitBreakerService.getState('upbit'),
      circuitGemini: CircuitBreakerService.getState('gemini'),
      reportedAt: new Date().toISOString(),
    };
  },
};
