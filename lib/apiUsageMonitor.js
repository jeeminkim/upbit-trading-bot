/**
 * API 사용량·무료 한도 모니터링 (OpenAI + Gemini)
 * Discord "API 사용량 조회" 버튼에서 사용
 */

try { require('dotenv').config(); } catch (_) {}

const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim() || '';

const OPENAI_USAGE_URL = 'https://api.openai.com/v1/organization/usage/completions';
const OPENAI_DASHBOARD = 'https://platform.openai.com/usage';
const GEMINI_RATE_LIMIT_PAGE = 'https://aistudio.google.com/rate-limit';

/** 이번 달 1일 00:00 UTC Unix (초) */
function getMonthStartUnix() {
  const now = new Date();
  return Math.floor(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).getTime() / 1000);
}

/**
 * OpenAI 사용량 조회 (조직 Usage API — 일반 API 키로는 403 가능, Admin 키 필요 시 대시보드 링크 안내)
 * @returns {{ ok: boolean, summary?: string, error?: string, needsAdmin?: boolean }}
 */
async function getOpenAIUsage() {
  if (!OPENAI_API_KEY) {
    return { ok: false, error: 'OPENAI_API_KEY 미설정', summary: null };
  }
  try {
    const startTime = getMonthStartUnix();
    const res = await axios.get(OPENAI_USAGE_URL, {
      params: { start_time: startTime, bucket_width: '1d', limit: 31 },
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    const data = res.data?.data || res.data;
    const buckets = Array.isArray(data) ? data : [];
    let totalInput = 0;
    let totalOutput = 0;
    let totalRequests = 0;
    for (const b of buckets) {
      const results = b.results || [];
      for (const r of results) {
        totalInput += r.input_tokens || 0;
        totalOutput += r.output_tokens || 0;
        totalRequests += r.num_model_requests || 0;
      }
    }
    const totalTokens = totalInput + totalOutput;
    const summary = `이번 달: 요청 **${totalRequests.toLocaleString()}**건, 입력 **${totalInput.toLocaleString()}** 토큰, 출력 **${totalOutput.toLocaleString()}** 토큰, 합계 **${totalTokens.toLocaleString()}** 토큰`;
    return { ok: true, summary };
  } catch (e) {
    const status = e?.response?.status;
    const msg = e?.response?.data?.error?.message || e?.message || '';
    if (status === 403 || /forbidden|admin|organization/i.test(msg)) {
      return {
        ok: false,
        error: '사용량 조회 권한 없음 (조직 Admin API 키 필요할 수 있음)',
        needsAdmin: true,
        summary: `📊 **OpenAI**\n· API는 기본 **유료**입니다. 무료 상시 티어 없음.\n· 신규/스타트업·연구자 프로그램으로 무료 크레딧 신청 가능.\n· 사용량·잔여 크레딧: ${OPENAI_DASHBOARD}`
      };
    }
    return { ok: false, error: msg || '요청 실패', summary: `📊 **OpenAI**\n· 사용량 직접 확인: ${OPENAI_DASHBOARD}` };
  }
}

/**
 * Gemini 무료 한도 안내 (실시간 잔여량은 Google AI Studio에서만 확인 가능)
 */
function getGeminiFreeTierInfo() {
  if (!GEMINI_API_KEY) {
    return 'GEMINI_API_KEY 미설정';
  }
  return [
    '📊 **Gemini (Google AI)**',
    '· **무료 한도** (Gemini 2.5 Flash 기준): 10 RPM, 250 RPD, 250K TPM',
    '· 잔여량·초과 여부: 아래 링크에서 실시간 확인 (API로는 조회 불가)',
    `· 🔗 ${GEMINI_RATE_LIMIT_PAGE}`
  ].join('\n');
}

/**
 * 통합 보고서 문자열 (Discord 메시지/Embed용)
 */
async function getCombinedReport() {
  const lines = ['**🔌 API 사용량 · 무료 토큰 모니터링**', ''];

  const openai = await getOpenAIUsage();
  if (openai.ok && openai.summary) {
    lines.push('📊 **OpenAI (ChatGPT API)**');
    lines.push(openai.summary);
    lines.push('· OpenAI API는 **기본 유료**. 무료 상시 티어 없음. 신규/스타트업·연구자 프로그램으로 무료 크레딧 신청 가능.');
    lines.push(`· 상세·잔여 크레딧: ${OPENAI_DASHBOARD}`);
  } else if (openai.error) {
    lines.push(`📊 **OpenAI**\n· ${openai.error}\n· 사용량·과금 확인: ${OPENAI_DASHBOARD}`);
  } else if (!OPENAI_API_KEY) {
    lines.push('📊 **OpenAI**\n· OPENAI_API_KEY 미설정. (로그 분석은 Gemini만 사용)');
  }
  lines.push('');

  lines.push(getGeminiFreeTierInfo());
  lines.push('');
  lines.push('_위 링크에서 초과 여부·잔여 한도를 확인하세요._');

  return lines.join('\n');
}

module.exports = {
  getOpenAIUsage,
  getGeminiFreeTierInfo,
  getCombinedReport
};
