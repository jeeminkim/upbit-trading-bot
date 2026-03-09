"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CACHE_TTL = exports.TtlCache = void 0;
const store = new Map();
exports.TtlCache = {
    get(key) {
        const e = store.get(key);
        if (!e || Date.now() > e.exp) {
            store.delete(key);
            return null;
        }
        return e.value;
    },
    set(key, value, ttlSec) {
        store.set(key, { value, exp: Date.now() + ttlSec * 1000 });
    },
    invalidate(keyOrPrefix) {
        if (store.has(keyOrPrefix))
            store.delete(keyOrPrefix);
        else
            for (const k of store.keys())
                if (k.startsWith(keyOrPrefix))
                    store.delete(k);
    },
};
exports.CACHE_TTL = {
    TOP_TICKERS: 10,
    RSI_STRENGTH: 15,
    MARKET_INDICATORS: 60,
    ACCOUNT_SUMMARY: 5,
    GEMINI_ANALYSIS: 60,
};
