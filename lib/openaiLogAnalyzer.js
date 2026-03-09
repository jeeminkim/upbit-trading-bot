/**
 * 로그 분석 전용 — ChatGPT(OpenAI API) 호출
 * .env에 OPENAI_API_KEY가 있으면 하루치 로그 분석 시 Gemini 대신 여기서 처리
 * API 키 발급: https://platform.openai.com/api-keys (본인 계정 로그인 후 생성)
 */

try { require('dotenv').config(); } catch (_) {}

const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() || '';
const OPENAI_MODEL = process.env.OPENAI_LOG_MODEL || 'gpt-4o-mini';

/**
 * 오늘자 로그 텍스트를 ChatGPT에 보내 오류·수정 제안 요약 받기
 * @param {string} logText
 * @returns {Promise<string|null>} 분석 결과 또는 키 미설정/오류 시 null
 */
async function askChatGPTForLogAnalysis(logText) {
  if (!OPENAI_API_KEY) return null;
  const prompt = `아래는 현재 시스템에서 생성한 오늘 하루치 로그입니다. 오류(에러, Error, Exception, fail, 오류, 에러 등)가 있다면:
1) 어떤 파일·모듈에서 발생했는지
2) 원인 추정
3) 어디를 어떻게 수정하면 좋을지 (파일명·함수명·수정 제안을 구체적으로)

를 5~10줄 이내로 요약해줘. 오류가 없으면 "오늘자 로그에서 오류 없음"이라고만 출력해줘.

[오늘자 로그]
${(logText || '').slice(0, 30000)}`;

  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1024,
        temperature: 0.3
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENAI_API_KEY}`
        },
        timeout: 60000
      }
    );
    const text = res.data?.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch (e) {
    console.warn('[OpenAI] 로그 분석 요청 실패:', e?.response?.data?.error?.message || e?.message);
    return null;
  }
}

/** OPENAI_API_KEY 설정 여부 */
function isConfigured() {
  return !!OPENAI_API_KEY;
}

module.exports = {
  askChatGPTForLogAnalysis,
  isConfigured
};
