import path from 'path';
import { EventBus } from '../../../packages/core/src/EventBus';
import { EngineStateService } from '../../../packages/core/src/EngineStateService';
import { CircuitBreakerService } from '../../../packages/core/src/CircuitBreakerService';
import { ProfitCalculationService } from '../../../packages/core/src/ProfitCalculationService';
import { HealthReportService } from '../../../packages/core/src/HealthReportService';

const CYCLE_MS = 1000;

// 기존 server.js 실동작: fetchAssets, runScalpCycle, state 연동
const serverPath = path.join(process.cwd(), 'server.js');
let serverModule: any = null;

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
    // FIX: DASHBOARD_EMIT은 socket.io용. Discord 채널에는 보내지 않음 (status는 discord-operator ready 시 1회만).
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

export function syncBotEnabledFromEngine(enabled: boolean): void {
  getServer()
    .then((s) => {
      s.state.botEnabled = enabled;
    })
    .catch(() => {});
}

setInterval(runCycle, CYCLE_MS);
runCycle();

console.log('[trading-engine] cycle started (server.js fetchAssets + runScalpCycle)');
