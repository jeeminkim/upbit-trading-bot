import path from 'path';
import { EventBus } from '../../../packages/core/src/EventBus';
import { EngineStateService } from '../../../packages/core/src/EngineStateService';
import { CircuitBreakerService } from '../../../packages/core/src/CircuitBreakerService';
import { ProfitCalculationService } from '../../../packages/core/src/ProfitCalculationService';
import { HealthReportService } from '../../../packages/core/src/HealthReportService';

const CYCLE_MS = 1000;

const serverPath = path.join(process.cwd(), 'server.js');
let serverModule: any = null;
let cycleTimer: ReturnType<typeof setInterval> | null = null;

async function getServer(): Promise<any> {
  if (!serverModule) {
    serverModule = require(serverPath);
    await serverModule.initPromise;
  }
  return serverModule;
}

async function fetchAssetsFromServer(s: any): Promise<any> {
  return s.fetchAssets();
}

async function runCycle(): Promise<void> {
  try {
    const s = await getServer();
    s.state.botEnabled = EngineStateService.getState().botEnabled;
    const assets = await CircuitBreakerService.execute('upbit', () => fetchAssetsFromServer(s));
    s.state.assets = assets;
    EngineStateService.setAssets(assets);
    HealthReportService.setLastEmitAt(new Date().toISOString());

    await CircuitBreakerService.execute('upbit', () => s.runScalpCycle());

    const summary = ProfitCalculationService.getSummary(s.state.assets);
    const lastEmit = {
      assets: s.state.assets,
      profitSummary: summary,
      botEnabled: s.state.botEnabled,
      lastOrderAt: (s.state as any).lastOrderAt ?? null,
    };
    EventBus.emit('DASHBOARD_EMIT', { lastEmit });
  } catch (e) {
    HealthReportService.recordError();
    if (CircuitBreakerService.getState('upbit') === 'OPEN') {
      EngineStateService.setBotEnabled(false);
      getServer().then((s) => { s.state.botEnabled = false; }).catch(() => {});
      EventBus.emit('ENGINE_STOPPED', {});
    }
  }
}

function startLoop(): void {
  if (cycleTimer != null) return;
  cycleTimer = setInterval(runCycle, CYCLE_MS);
  runCycle();
  console.log('[trading-engine] cycle started (explicit start)');
}

function stopLoop(): void {
  if (cycleTimer != null) {
    clearInterval(cycleTimer);
    cycleTimer = null;
  }
  console.log('[trading-engine] cycle stopped');
}

EventBus.subscribe('ENGINE_STARTED', () => startLoop());
EventBus.subscribe('ENGINE_STOPPED', () => stopLoop());

export function syncBotEnabledFromEngine(enabled: boolean): void {
  getServer()
    .then((s) => {
      s.state.botEnabled = enabled;
    })
    .catch(() => {});
}

console.log('[trading-engine] loaded (cycle starts only on ENGINE_STARTED)');
