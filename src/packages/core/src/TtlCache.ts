const store = new Map<string, { value: unknown; exp: number }>();

export const TtlCache = {
  get<T>(key: string): T | null {
    const e = store.get(key);
    if (!e || Date.now() > e.exp) {
      store.delete(key);
      return null;
    }
    return e.value as T;
  },

  set<T>(key: string, value: T, ttlSec: number): void {
    store.set(key, { value, exp: Date.now() + ttlSec * 1000 });
  },

  invalidate(keyOrPrefix: string): void {
    if (store.has(keyOrPrefix)) store.delete(keyOrPrefix);
    else for (const k of store.keys()) if (k.startsWith(keyOrPrefix)) store.delete(k);
  },
};

export const CACHE_TTL = {
  TOP_TICKERS: 10,
  RSI_STRENGTH: 15,
  MARKET_INDICATORS: 60,
  ACCOUNT_SUMMARY: 5,
  GEMINI_ANALYSIS: 60,
} as const;
