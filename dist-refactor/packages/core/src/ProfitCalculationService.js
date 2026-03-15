"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProfitCalculationService = void 0;
const EXCLUDED = ['APENFT', 'PURSE'];
exports.ProfitCalculationService = {
    getSummary(assets) {
        if (!assets)
            return { profitPct: 0, totalEval: 0, totalBuy: 0, krw: 0, profitKrw: 0 };
        const totalEval = assets.totalEvaluationKrw ?? 0;
        const totalBuy = assets.totalBuyKrwForCoins ?? assets.totalBuyKrw ?? 0;
        const krw = assets.orderableKrw ?? 0;
        const denom = totalBuy + krw;
        const profitPct = denom <= 0 ? 0 : (totalEval / denom - 1) * 100;
        const profitKrw = totalEval - denom;
        return { profitPct, totalEval, totalBuy, krw, profitKrw };
    },
    formatPct(profitPct) {
        const sign = profitPct >= 0 ? '+' : '';
        return `${sign}${profitPct.toFixed(2)}%`;
    },
};
