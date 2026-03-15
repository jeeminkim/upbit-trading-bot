"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncBotEnabledFromEngine = syncBotEnabledFromEngine;
const path_1 = __importDefault(require("path"));
const EventBus_1 = require("../../../packages/core/src/EventBus");
const EngineStateService_1 = require("../../../packages/core/src/EngineStateService");
const CircuitBreakerService_1 = require("../../../packages/core/src/CircuitBreakerService");
const ProfitCalculationService_1 = require("../../../packages/core/src/ProfitCalculationService");
const HealthReportService_1 = require("../../../packages/core/src/HealthReportService");
const CYCLE_MS = 1000;
const serverPath = path_1.default.join(process.cwd(), 'server.js');
let serverModule = null;
let cycleTimer = null;
async function getServer() {
    if (!serverModule) {
        serverModule = require(serverPath);
        await serverModule.initPromise;
    }
    return serverModule;
}
async function fetchAssetsFromServer(s) {
    return s.fetchAssets();
}
async function runCycle() {
    try {
        const s = await getServer();
        s.state.botEnabled = EngineStateService_1.EngineStateService.getState().botEnabled;
        const assets = await CircuitBreakerService_1.CircuitBreakerService.execute('upbit', () => fetchAssetsFromServer(s));
        s.state.assets = assets;
        EngineStateService_1.EngineStateService.setAssets(assets);
        HealthReportService_1.HealthReportService.setLastEmitAt(new Date().toISOString());
        await CircuitBreakerService_1.CircuitBreakerService.execute('upbit', () => s.runScalpCycle());
        const summary = ProfitCalculationService_1.ProfitCalculationService.getSummary(s.state.assets);
        const lastEmit = {
            assets: s.state.assets,
            profitSummary: summary,
            botEnabled: s.state.botEnabled,
            lastOrderAt: s.state.lastOrderAt ?? null,
        };
        EventBus_1.EventBus.emit('DASHBOARD_EMIT', { lastEmit });
    }
    catch (e) {
        HealthReportService_1.HealthReportService.recordError();
        if (CircuitBreakerService_1.CircuitBreakerService.getState('upbit') === 'OPEN') {
            EngineStateService_1.EngineStateService.setBotEnabled(false);
            getServer().then((s) => { s.state.botEnabled = false; }).catch(() => { });
            EventBus_1.EventBus.emit('ENGINE_STOPPED', {});
        }
    }
}
function startLoop() {
    if (cycleTimer != null)
        return;
    cycleTimer = setInterval(runCycle, CYCLE_MS);
    runCycle();
    console.log('[trading-engine] cycle started (explicit start)');
}
function stopLoop() {
    if (cycleTimer != null) {
        clearInterval(cycleTimer);
        cycleTimer = null;
    }
    console.log('[trading-engine] cycle stopped');
}
EventBus_1.EventBus.subscribe('ENGINE_STARTED', () => startLoop());
EventBus_1.EventBus.subscribe('ENGINE_STOPPED', () => stopLoop());
function syncBotEnabledFromEngine(enabled) {
    getServer()
        .then((s) => {
        s.state.botEnabled = enabled;
    })
        .catch(() => { });
}
console.log('[trading-engine] loaded (cycle starts only on ENGINE_STARTED)');
