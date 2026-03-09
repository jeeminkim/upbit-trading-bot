import type { AssetSummary, EngineStateSnapshot, OpenOrder } from '../../shared/src/types';

let state: EngineStateSnapshot = {
  botEnabled: false,
  currentPosition: {},
  lastOrderAt: null,
  cooldownUntil: null,
  dailyPnL: 0,
  openOrders: [],
  assets: null,
};

export const EngineStateService = {
  getState(): Readonly<EngineStateSnapshot> {
    return { ...state };
  },

  setState(partial: Partial<EngineStateSnapshot>): void {
    state = { ...state, ...partial };
  },

  setBotEnabled(enabled: boolean): void {
    state.botEnabled = enabled;
  },

  setLastOrderAt(iso: string): void {
    state.lastOrderAt = iso;
  },

  setCooldownUntil(ms: number): void {
    state.cooldownUntil = ms;
  },

  setAssets(assets: AssetSummary | null): void {
    state.assets = assets;
  },

  setOpenOrders(orders: OpenOrder[]): void {
    state.openOrders = orders;
  },

  addDailyPnL(delta: number): void {
    state.dailyPnL = (state.dailyPnL || 0) + delta;
  },

  isInCooldown(): boolean {
    return state.cooldownUntil != null && Date.now() < state.cooldownUntil;
  },
};
