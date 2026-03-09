import path from 'path';
import { AppErrorCode } from '../../shared/src/errors';
import type { AppResult } from '../../shared/src/types';

const gemini = require(path.join(process.cwd(), 'lib', 'gemini'));

/** 표시용. 실제 호출은 lib/gemini (gemini-2.5-flash) 사용 */
const MODEL = 'gemini-2.5-flash';

export const GeminiAnalysisService = {
  async scanVolAnalysis(enriched: Array<{ symbol: string; price: number; rsi: string; strength: string; volumeChange?: string }>): Promise<AppResult<string>> {
    try {
      const text = await gemini.askGeminiForScanVol(enriched);
      if (text) return { ok: true, data: text };
      return { ok: false, error: { code: AppErrorCode.GEMINI_UNAVAILABLE, message: '분석 결과 없음' } };
    } catch (e) {
      return { ok: false, error: { code: AppErrorCode.GEMINI_UNAVAILABLE, message: (e as Error).message } };
    }
  },

  async marketSummaryAnalysis(ctx: { fng?: string; btcTrend?: string; topTickers?: string; kimp?: string }): Promise<AppResult<string>> {
    try {
      const text = await gemini.askGeminiForMarketSummary(ctx);
      if (text) return { ok: true, data: text };
      return { ok: false, error: { code: AppErrorCode.GEMINI_UNAVAILABLE, message: '시황 요약 없음' } };
    } catch (e) {
      return { ok: false, error: { code: AppErrorCode.GEMINI_UNAVAILABLE, message: (e as Error).message } };
    }
  },

  async scalpPointAnalysis(dataText: string): Promise<AppResult<string>> {
    try {
      const text = await gemini.askGeminiForScalpPoint(dataText);
      if (text) return { ok: true, data: text.length > 1900 ? text.slice(0, 1897) + '…' : text };
      return { ok: false, error: { code: AppErrorCode.GEMINI_UNAVAILABLE, message: '스캘핑 타점 분석 없음' } };
    } catch (e) {
      return { ok: false, error: { code: AppErrorCode.GEMINI_UNAVAILABLE, message: (e as Error).message } };
    }
  },

  async portfolioRiskAnalysis(profitPct: number, totalEvalKrw: number): Promise<AppResult<string>> {
    try {
      const text = await gemini.askGeminiForPortfolioRisk(profitPct, totalEvalKrw);
      if (text) return { ok: true, data: text.length > 100 ? text.slice(0, 97) + '…' : text };
      return { ok: false, error: { code: AppErrorCode.GEMINI_UNAVAILABLE, message: '포트폴리오 위험 요약 없음' } };
    } catch (e) {
      return { ok: false, error: { code: AppErrorCode.GEMINI_UNAVAILABLE, message: (e as Error).message } };
    }
  },

  getModelName(): string {
    return MODEL;
  },
};
