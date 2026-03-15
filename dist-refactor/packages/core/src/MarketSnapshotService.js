"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MarketSnapshotService = void 0;
const path_1 = __importDefault(require("path"));
const TtlCache_1 = require("./TtlCache");
const upbit = require(path_1.default.join(process.cwd(), 'lib', 'upbit'));
const SCALP_MARKETS = ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL'];
const FNG_URL = 'https://api.alternative.me/fng/';
const BINANCE_URL = 'https://api.binance.com/api/v3/ticker/price';
const FX_URL = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json';
async function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
exports.MarketSnapshotService = {
    async getTopTickersByTradePrice(limit) {
        const cacheKey = `top_tickers_${limit}`;
        const cached = TtlCache_1.TtlCache.get(cacheKey);
        if (cached)
            return cached;
        try {
            const list = await upbit.getTopKrwTickersByTradePrice(limit);
            const out = (list || []).slice(0, limit).map((t) => ({
                market: t.market,
                symbol: (t.market || '').replace('KRW-', ''),
                trade_price: t.trade_price,
                acc_trade_price_24h: t.acc_trade_price_24h,
            }));
            TtlCache_1.TtlCache.set(cacheKey, out, TtlCache_1.CACHE_TTL.TOP_TICKERS);
            return out;
        }
        catch (e) {
            const stale = TtlCache_1.TtlCache.get(cacheKey);
            if (stale)
                return stale;
            return [];
        }
    },
    async getEnrichedTopN(limit) {
        const cacheKey = `enriched_top_${limit}`;
        const cached = TtlCache_1.TtlCache.get(cacheKey);
        if (cached)
            return cached;
        const tickers = await this.getTopTickersByTradePrice(limit);
        const out = [];
        for (const t of tickers.slice(0, limit)) {
            let rsi = '—';
            let strength = '—';
            let trend5m = '—';
            try {
                const candles = await upbit.getCandlesMinutes(5, t.market, 15);
                await delay(250);
                if (Array.isArray(candles) && candles.length >= 15) {
                    const closes = candles.slice(0, 15).map((c) => Number(c.trade_price)).filter((n) => !isNaN(n));
                    if (closes.length >= 15) {
                        let gains = 0, losses = 0;
                        for (let i = 0; i < 14; i++) {
                            const d = closes[i] - closes[i + 1];
                            if (d > 0)
                                gains += d;
                            else
                                losses -= d;
                        }
                        const avgLoss = losses / 14;
                        if (avgLoss > 0)
                            rsi = (100 - 100 / (1 + (gains / 14) / avgLoss)).toFixed(1);
                        else
                            rsi = gains > 0 ? '100' : '50';
                        const last3 = candles.slice(0, 3).map((c) => Number(c.trade_price));
                        if (last3.length === 3)
                            trend5m = last3[0] > last3[2] ? '상승' : '하락';
                    }
                }
            }
            catch (_) { }
            try {
                const orderbooks = await upbit.getOrderbook([t.market]);
                await delay(250);
                const ob = Array.isArray(orderbooks) ? orderbooks[0] : orderbooks;
                if (ob?.orderbook_units?.length > 0) {
                    let bidVol = 0, askVol = 0;
                    ob.orderbook_units.forEach((u) => {
                        bidVol += (Number(u.bid_size) || 0) * (Number(u.bid_price) || 0);
                        askVol += (Number(u.ask_size) || 0) * (Number(u.ask_price) || 0);
                    });
                    const total = bidVol + askVol;
                    strength = total > 0 ? ((bidVol / total) * 100).toFixed(1) + '%' : '—';
                }
            }
            catch (_) { }
            out.push({
                symbol: t.symbol,
                market: t.market,
                price: t.trade_price,
                rsi,
                strength,
                trend5m,
            });
        }
        TtlCache_1.TtlCache.set(cacheKey, out, TtlCache_1.CACHE_TTL.RSI_STRENGTH);
        return out;
    },
    async getMarketIndicators() {
        const cacheKey = 'market_indicators';
        const cached = TtlCache_1.TtlCache.get(cacheKey);
        if (cached)
            return cached;
        let fng = null;
        let btcTrend = '—';
        let kimpAvg = null;
        const kimpByMarket = {};
        let topTickersText = '—';
        try {
            const ax = require('axios');
            const [fngRes, fxRes, binanceRes] = await Promise.all([
                ax.get(FNG_URL, { timeout: 5000 }).catch(() => ({ data: null })),
                ax.get(FX_URL, { timeout: 8000 }).catch(() => ({ data: null })),
                ax.get(BINANCE_URL, { timeout: 5000 }).catch(() => ({ data: [] })),
            ]);
            const fngData = fngRes?.data?.data?.[0];
            if (fngData)
                fng = { value: parseInt(fngData.value, 10), classification: fngData.value_classification || '' };
            const fx = fxRes?.data?.usd?.krw;
            const binanceList = Array.isArray(binanceRes?.data) ? binanceRes.data : [];
            const btcBinance = binanceList.find((x) => x.symbol === 'BTCUSDT');
            if (fx && btcBinance?.price) {
                const upbitTickers = await upbit.getTickers(SCALP_MARKETS);
                const btcTicker = (upbitTickers || []).find((t) => t.market === 'KRW-BTC');
                if (btcTicker?.trade_price) {
                    const fairKrw = Number(btcBinance.price) * fx;
                    kimpByMarket['KRW-BTC'] = (btcTicker.trade_price / fairKrw - 1) * 100;
                    kimpAvg = kimpByMarket['KRW-BTC'];
                }
                btcTrend = `BTC ${btcBinance.price} USD, FX ${fx} KRW`;
            }
            const top = await this.getTopTickersByTradePrice(5);
            topTickersText = top.map((t) => `${t.symbol}: ${Number(t.trade_price).toLocaleString('ko-KR')}원`).join(' | ');
        }
        catch (_) { }
        const out = { fng, btcTrend, kimpAvg, kimpByMarket, topTickersText };
        TtlCache_1.TtlCache.set(cacheKey, out, TtlCache_1.CACHE_TTL.MARKET_INDICATORS);
        return out;
    },
    getScalpPointDataLines(enriched) {
        return enriched
            .map((e) => `[${e.symbol}] 현재가 ${Number(e.price).toLocaleString('ko-KR')}원 | RSI(14) ${e.rsi} | 체결강도(매수비율) ${e.strength} | 5분봉 추세 ${e.trend5m || '—'}`)
            .join('\n');
    },
};
