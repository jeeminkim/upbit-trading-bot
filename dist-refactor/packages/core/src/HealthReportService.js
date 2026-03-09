"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HealthReportService = void 0;
const EngineStateService_1 = require("./EngineStateService");
const CircuitBreakerService_1 = require("./CircuitBreakerService");
let errorsLast1h = 0;
let geminiFailuresLast1h = 0;
let lastEmitAt = null;
exports.HealthReportService = {
    recordError() {
        errorsLast1h++;
    },
    recordGeminiFailure() {
        geminiFailuresLast1h++;
    },
    setLastEmitAt(iso) {
        lastEmitAt = iso;
    },
    resetHourlyCounters() {
        errorsLast1h = 0;
        geminiFailuresLast1h = 0;
    },
    build(processName, opts) {
        const state = EngineStateService_1.EngineStateService.getState();
        const mem = process.memoryUsage();
        const memoryMb = Math.round(mem.heapUsed / 1024 / 1024);
        const start = process.hrtime?.() ? 0 : 0;
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
            circuitUpbit: CircuitBreakerService_1.CircuitBreakerService.getState('upbit'),
            circuitGemini: CircuitBreakerService_1.CircuitBreakerService.getState('gemini'),
            reportedAt: new Date().toISOString(),
        };
    },
};
