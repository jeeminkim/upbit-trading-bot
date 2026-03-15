"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeminiAnalysisService = void 0;
const path_1 = __importDefault(require("path"));
const errors_1 = require("../../shared/src/errors");
const gemini = require(path_1.default.join(process.cwd(), 'lib', 'gemini'));
/** 표시용. 실제 호출은 lib/gemini (gemini-2.5-flash) 사용 */
const MODEL = 'gemini-2.5-flash';
exports.GeminiAnalysisService = {
    async scanVolAnalysis(enriched) {
        try {
            const text = await gemini.askGeminiForScanVol(enriched);
            if (text)
                return { ok: true, data: text };
            return { ok: false, error: { code: errors_1.AppErrorCode.GEMINI_UNAVAILABLE, message: '분석 결과 없음' } };
        }
        catch (e) {
            return { ok: false, error: { code: errors_1.AppErrorCode.GEMINI_UNAVAILABLE, message: e.message } };
        }
    },
    async marketSummaryAnalysis(ctx) {
        try {
            const text = await gemini.askGeminiForMarketSummary(ctx);
            if (text)
                return { ok: true, data: text };
            return { ok: false, error: { code: errors_1.AppErrorCode.GEMINI_UNAVAILABLE, message: '시황 요약 없음' } };
        }
        catch (e) {
            return { ok: false, error: { code: errors_1.AppErrorCode.GEMINI_UNAVAILABLE, message: e.message } };
        }
    },
    async scalpPointAnalysis(dataText) {
        try {
            const text = await gemini.askGeminiForScalpPoint(dataText);
            if (text)
                return { ok: true, data: text.length > 1900 ? text.slice(0, 1897) + '…' : text };
            return { ok: false, error: { code: errors_1.AppErrorCode.GEMINI_UNAVAILABLE, message: '스캘핑 타점 분석 없음' } };
        }
        catch (e) {
            return { ok: false, error: { code: errors_1.AppErrorCode.GEMINI_UNAVAILABLE, message: e.message } };
        }
    },
    async portfolioRiskAnalysis(profitPct, totalEvalKrw) {
        try {
            const text = await gemini.askGeminiForPortfolioRisk(profitPct, totalEvalKrw);
            if (text)
                return { ok: true, data: text.length > 100 ? text.slice(0, 97) + '…' : text };
            return { ok: false, error: { code: errors_1.AppErrorCode.GEMINI_UNAVAILABLE, message: '포트폴리오 위험 요약 없음' } };
        }
        catch (e) {
            return { ok: false, error: { code: errors_1.AppErrorCode.GEMINI_UNAVAILABLE, message: e.message } };
        }
    },
    getModelName() {
        return MODEL;
    },
};
