"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EngineStateService = void 0;
let state = {
    botEnabled: false,
    currentPosition: {},
    lastOrderAt: null,
    cooldownUntil: null,
    dailyPnL: 0,
    openOrders: [],
    assets: null,
};
exports.EngineStateService = {
    getState() {
        return { ...state };
    },
    setState(partial) {
        state = { ...state, ...partial };
    },
    setBotEnabled(enabled) {
        state.botEnabled = enabled;
    },
    setLastOrderAt(iso) {
        state.lastOrderAt = iso;
    },
    setCooldownUntil(ms) {
        state.cooldownUntil = ms;
    },
    setAssets(assets) {
        state.assets = assets;
    },
    setOpenOrders(orders) {
        state.openOrders = orders;
    },
    addDailyPnL(delta) {
        state.dailyPnL = (state.dailyPnL || 0) + delta;
    },
    isInCooldown() {
        return state.cooldownUntil != null && Date.now() < state.cooldownUntil;
    },
};
