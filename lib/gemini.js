/**
 * Gemini API 연동 — 모델명 코드 상 강제: "gemini-2.5-flash" (환경변수 미사용)
 * .env: GEMINI_API_KEY(필수). 사용 가능 모델: node scripts/list-gemini-models.js
 */
console.log('[Gemini] 모듈 로드됨 — 버전: 2025-03-10-gemini-2.5-only | __filename:', __filename);
try { require('dotenv').config(); } catch (_) {}

let GoogleGenerativeAI = null;
try {
  GoogleGenerativeAI = require('@google/generative-ai').GoogleGenerativeAI;
} catch (e) {
  console.warn('[Gemini] @google/generative-ai 미설치:', e?.message);
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim() || '';

/** 코드 상 고정 모델명 (환경변수 미참조) */
const MODEL_STRING = 'gemini-2.5-flash';

const GEMINI_DELAY_MESSAGE = '⚠️ AI 분석 중 오류가 발생했습니다. (잠시 후 다시 시도해 주세요)';

/** 결제 비활성/할당량 초과 감지 — 이 경우 콜백 호출 후 AI 기능 비활성화 */
let onBillingDisabledCallback = null;

function setOnBillingDisabledCallback(fn) {
  onBillingDisabledCallback = typeof fn === 'function' ? fn : null;
}

function isBillingOrQuotaError(error) {
  if (!error) return false;
  const msg = (error?.message || '').toLowerCase();
  const code = (error?.code || error?.status || '').toString();
  if (/billingdisabled|billing\s*disabled|결제\s*비활성/i.test(msg)) return true;
  if (/quotaexceeded|quota\s*exceeded|할당량\s*초과/i.test(msg)) return true;
  if (code === '402' || code === '403') {
    if (/payment|billing|quota|resource_exhausted|리소스\s*소진|결제/i.test(msg)) return true;
  }
  if (error?.response?.status === 402 || error?.response?.status === 403) {
    const body = (error?.response?.data && typeof error.response.data === 'object')
      ? JSON.stringify(error.response.data) : '';
    if (/payment|billing|quota|disabled|리소스/i.test(body.toLowerCase())) return true;
  }
  return false;
}

/** 종료 토큰: 이 문자열이 포함되면 수집 중단 후 해당 위치까지만 반환 */
const END_TOKENS = ['[답변 종료]', '[END]'];

/** 일일 API 호출 수 트래킹 — 매일 00:00 초기화, data/daily_usage.json */
const path = require('path');
const fs = require('fs');
const DAILY_USAGE_DIR = path.join(__dirname, '..', 'data');
const DAILY_USAGE_FILE = path.join(DAILY_USAGE_DIR, 'daily_usage.json');
const DAILY_LIMIT = 1000;

function getTodayDateStr() {
  const now = new Date();
  const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  return kst.getFullYear() + '-' + String(kst.getMonth() + 1).padStart(2, '0') + '-' + String(kst.getDate()).padStart(2, '0');
}

function readDailyUsage() {
  try {
    if (fs.existsSync(DAILY_USAGE_FILE)) {
      const raw = fs.readFileSync(DAILY_USAGE_FILE, 'utf8');
      const data = JSON.parse(raw);
      const today = getTodayDateStr();
      if (data.date === today) return { date: data.date, count: typeof data.count === 'number' ? data.count : 0 };
      return { date: today, count: 0 };
    }
  } catch (_) {}
  return { date: getTodayDateStr(), count: 0 };
}

function writeDailyUsage(data) {
  try {
    if (!fs.existsSync(DAILY_USAGE_DIR)) fs.mkdirSync(DAILY_USAGE_DIR, { recursive: true });
    fs.writeFileSync(DAILY_USAGE_FILE, JSON.stringify({ date: data.date, count: data.count }), 'utf8');
  } catch (e) {
    console.warn('[Gemini] daily_usage.json 쓰기 실패:', e?.message);
  }
}

function recordGeminiUsage() {
  const data = readDailyUsage();
  data.count += 1;
  writeDailyUsage(data);
}

/** [📊 현재 상태] 임베드용 — 오늘 날짜 기준 사용량 / 한도 */
function getDailyUsage() {
  const data = readDailyUsage();
  return { count: data.count, limit: DAILY_LIMIT, date: data.date };
}

function getGeminiDiagnostics() {
  return {
    modulePath: __filename,
    processCwd: process.cwd(),
    modelPassedToAPI: MODEL_STRING,
    nodeVersion: process.version,
    sdkVersion: (function () {
      try {
        const p = require.resolve('@google/generative-ai/package.json');
        const j = require(p);
        return j.version || 'unknown';
      } catch (_) { return 'unknown'; }
    })()
  };
}

let genAI = null;
if (GoogleGenerativeAI && GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const loadDiag = getGeminiDiagnostics();
  console.log('[Gemini] 로드됨 — 모델:', loadDiag.modelPassedToAPI, '| 모듈:', loadDiag.modulePath, '| cwd:', loadDiag.processCwd);
}

/**
 * 프롬프트로 생성 요청. 모델: gemini-2.5-flash (안정/성능 권장. 404 시 list-gemini-models.js로 확인).
 * @param {string} prompt
 * @returns {Promise<string>} 응답 텍스트 또는 에러 시 사용자 안내 문구
 */
async function getGeminiResponse(prompt) {
  if (!genAI || !GEMINI_API_KEY) return GEMINI_DELAY_MESSAGE;
  const diag = getGeminiDiagnostics();
  try {
    const model = genAI.getGenerativeModel({
      model: MODEL_STRING,
      generationConfig: { maxOutputTokens: 2048, temperature: 0.7 },
      systemInstruction: '답변이 너무 길어지지 않게 하되, 문장이 중간에 끊기지 않도록 완결된 문장으로 작성해줘.'
    });
    const result = await model.generateContent(prompt);
    const response = result?.response;
    if (!response) return GEMINI_DELAY_MESSAGE;
    const text = response.text?.()?.trim?.();
    if (text && text !== GEMINI_DELAY_MESSAGE) recordGeminiUsage();
    return text || GEMINI_DELAY_MESSAGE;
  } catch (error) {
    if (isBillingOrQuotaError(error)) {
      console.warn('[Gemini] 결제 비활성/할당량 초과 감지 — AI 기능 비활성화 콜백 호출:', error?.message);
      if (onBillingDisabledCallback) {
        try { onBillingDisabledCallback(); } catch (_) {}
      }
    }
    const errDetail = {
      message: error?.message,
      name: error?.name,
      stack: error?.stack,
      status: error?.status,
      code: error?.code,
      response: error?.response != null ? String(error.response) : undefined
    };
    let errJson = '';
    try {
      errJson = JSON.stringify(errDetail, null, 2);
    } catch (_) {
      errJson = String(error?.message);
    }
    const block = [
      '[Gemini] 실패 원인(예외): ' + (error?.message || ''),
      '[Gemini] 진단(Google AI 문의용) — 우리가 전달한 모델: ' + diag.modelPassedToAPI,
      '[Gemini] 진단 — 로드된 모듈 경로: ' + diag.modulePath,
      '[Gemini] 진단 — process.cwd(): ' + diag.processCwd,
      '[Gemini] 진단 — Node: ' + diag.nodeVersion + ' | @google/generative-ai: ' + diag.sdkVersion,
      '[Gemini] 진단 — 에러 상세(JSON):',
      errJson
    ].join('\n');
    console.error(block);
    try {
      const path = require('path');
      const fs = require('fs');
      const logDir = path.join(process.cwd(), 'logs');
      const logFile = path.join(logDir, 'gemini-error-diagnostic.log');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(logFile, '\n--- ' + new Date().toISOString() + ' ---\n' + block + '\n', 'utf8');
    } catch (_) {}
    return GEMINI_DELAY_MESSAGE;
  }
}

/**
 * 완결 응답 수집 — [답변 종료] 또는 [END] 포함 시 해당 위치까지 반환, 없으면 전체 반환.
 * 긴 분석 리포트가 중간에 잘리지 않도록 Discord 2000자 분할 전송 전에 전체 텍스트를 확보할 때 사용.
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function getGeminiResponseComplete(prompt) {
  if (!genAI || !GEMINI_API_KEY) return GEMINI_DELAY_MESSAGE;
  const trimAtEndToken = (text) => {
    if (!text || typeof text !== 'string') return text || '';
    let idx = -1;
    for (const token of END_TOKENS) {
      const i = text.indexOf(token);
      if (i >= 0 && (idx < 0 || i < idx)) idx = i;
    }
    return idx >= 0 ? text.slice(0, idx).trim() : text.trim();
  };
  try {
    const model = genAI.getGenerativeModel({
      model: MODEL_STRING,
      generationConfig: { maxOutputTokens: 8192, temperature: 0.7 },
      systemInstruction: '답변이 길어도 괜찮으니 완결된 문장으로 작성하고, 답변 마지막에 반드시 [답변 종료]를 출력해줘.'
    });
    const result = await model.generateContent(prompt);
    const text = result?.response?.text?.();
    const out = trimAtEndToken(text || '') || GEMINI_DELAY_MESSAGE;
    if (out !== GEMINI_DELAY_MESSAGE) recordGeminiUsage();
    return out;
  } catch (error) {
    if (isBillingOrQuotaError(error)) {
      console.warn('[Gemini] 결제 비활성/할당량 초과 감지 (Complete):', error?.message);
      if (onBillingDisabledCallback) {
        try { onBillingDisabledCallback(); } catch (_) {}
      }
    }
    console.error('[Gemini] getGeminiResponseComplete:', error?.message);
    return GEMINI_DELAY_MESSAGE;
  }
}

// --- 기존 호출부 호환용 래퍼 (서버·리팩터에서 그대로 사용 가능) ---

async function askGeminiForScalpPoint(data) {
  if (!GEMINI_API_KEY) return GEMINI_DELAY_MESSAGE;
  let dataText = '';
  if (typeof data === 'string' && data.trim()) dataText = data.trim();
  else if (Array.isArray(data) && data.length > 0) {
    dataText = data.map((e) => {
      const sym = e.symbol || '—';
      const price = e.price != null ? Number(e.price).toLocaleString('ko-KR') : '—';
      return `[${sym}] 현재가 ${price}원 | RSI ${e.rsi ?? '—'} | 체결강도 ${e.strength ?? '—'} | 5분봉 추세 ${e.trend5m ?? '—'}`;
    }).join('\n');
  }
  if (!dataText) return GEMINI_DELAY_MESSAGE;
  const prompt = `너는 업비트 전문 스캘퍼야. 다음 실시간 데이터를 바탕으로 1% 수익이 가능한 종목 1개를 골라 진입가, 익절가, 손절가를 포함한 3문단 전략을 작성해.
추천 종목의 티커를 반드시 대괄호 안에 표기해줘. 예: [BTC], [ETH], [SOL], [XRP] (본문 어디든 한 번만 포함하면 됨).
답변 마지막에 반드시 [답변 종료]를 출력해줘.\n\n데이터:\n${dataText}`;
  const text = await getGeminiResponseComplete(prompt);
  return text === GEMINI_DELAY_MESSAGE ? text : text;
}

async function askGeminiForScanVol(enriched) {
  if (!genAI || !GEMINI_API_KEY || !enriched?.length) return null;
  const dataText = enriched.map((e) =>
    `[${e.symbol}] 현재가 ${e.price != null ? Number(e.price).toLocaleString('ko-KR') : '—'}원 | RSI ${e.rsi} | 체결강도 ${e.strength} | 5분봉 거래량 ${e.volumeChange || '—'}`
  ).join('\n');
  const prompt = `다음 업비트 실시간 코인 데이터(상위 10종목)를 분석해서, 현재 가장 유력한 급등 후보 1종목만 선정하고 아래 3줄 형식으로만 출력해줘. 다른 말 없이 3줄만.\n\n1) 🎯 **현재 가장 유력한 급등 후보**: [코인명]\n2) [선정 이유]: [왜 이 종목인지 1문장]\n3) [기술적 근거]: [RSI·체결강도·거래량 등 지표 근거 1문장]\n4) [주의 리스크]: [단기 조정·과매수 등 리스크 1문장]\n\n데이터:\n${dataText}`;
  return await getGeminiResponse(prompt).then((t) => (t === GEMINI_DELAY_MESSAGE ? null : t));
}

async function askGeminiForMarketSummary(ctx) {
  if (!genAI || !GEMINI_API_KEY || !ctx) return null;
  const prompt = `아래 한국 암호화폐 시장 데이터를 바탕으로 반드시 아래 3문단만 출력해줘. 다른 말 없이 3문단만.\n\n1문단: 현재 비트코인 및 글로벌 시장 흐름 (공포·탐욕 지수 포함).\n2문단: 업비트 거래량 상위 중 급등 가능성 높은 추천 종목 1개와 기술적 근거(RSI, 거래량 등).\n3문단: 주인님을 위한 오늘 밤 단기 매매/대응 전략 3줄 요약.\n\n데이터:\n${ctx.fng || '—'}\n${ctx.btcTrend || '—'}\n${ctx.topTickers || '—'}\n${ctx.kimp || '—'}`;
  return await getGeminiResponse(prompt).then((t) => (t === GEMINI_DELAY_MESSAGE ? null : t));
}

async function askGeminiForPick(enriched) {
  if (!genAI || !GEMINI_API_KEY || !enriched?.length) return null;
  const dataText = enriched.map((e) =>
    `[${e.symbol}] 거래량 급증비율 ${Number(e.ratio).toFixed(2)}배, RSI ${e.rsi}, 체결강도(매수비율) ${e.strength}`
  ).join('\n');
  const prompt = `다음은 업비트 5분봉 기준 급등 후보 코인 데이터입니다.\n${dataText}\n\n위 데이터만 보고, 현재 가장 유망한 코인 1개와 진입 사유를 정확히 3문장으로 요약해줘. 다른 설명 없이 요약만 출력.`;
  return await getGeminiResponse(prompt).then((t) => (t === GEMINI_DELAY_MESSAGE ? null : t));
}

async function askGeminiForPortfolioRisk(profitPct, totalEvalKrw) {
  if (!genAI || !GEMINI_API_KEY) return null;
  const ctx = `현재 수익률: ${typeof profitPct === 'number' ? profitPct.toFixed(2) : profitPct}%, 총자산(원화): ${totalEvalKrw != null ? Number(totalEvalKrw).toLocaleString('ko-KR') : '—'}원`;
  const prompt = `다음 암호화폐 포트폴리오 상황을 보고, 위험도나 시장 상황을 **한 줄**로만 요약해줘. 50자 이내. 다른 말 없이 요약 한 줄만 출력.\n\n${ctx}`;
  const text = await getGeminiResponse(prompt);
  if (text === GEMINI_DELAY_MESSAGE) return null;
  return text && text.length > 100 ? text.slice(0, 97) + '…' : text;
}

/** 거래 부재 원인 진단: 12시간 로그를 분석해 3줄 요약 */
async function askGeminiForNoTradeDiagnosis(logDataText) {
  if (!genAI || !GEMINI_API_KEY || !logDataText) return null;
  const prompt = `아래는 업비트 스캘핑 봇의 최근 12시간 매매·거절·상태 로그입니다. 전문가 관점에서 **왜 거래가 체결되지 않았는지** 진단해줘. 답변은 반드시 3줄 요약으로만 제한해. (예: "현재 RSI가 설정값(30)보다 높아 진입 대기 중", "잔고 부족으로 주문 취소" 등 구체적 이유)\n\n[로그 데이터]\n${logDataText}`;
  const text = await getGeminiResponse(prompt);
  return text === GEMINI_DELAY_MESSAGE ? null : (text && text.length > 500 ? text.slice(0, 497) + '…' : text);
}

/** 매매 로직 수정안 제안: 누적 진단 요약을 바탕으로 RSI/전략 수정 제안 */
async function askGeminiForLogicSuggestion(accumulatedDiagnosticsText) {
  if (!genAI || !GEMINI_API_KEY || !accumulatedDiagnosticsText) return null;
  const prompt = `아래는 그동안 수집된 "거래 부재 원인" 진단 요약들입니다. 이를 종합해서 매매 성공률을 높이기 위한 **scalpEngine.js 또는 전략 수정안**을 제안해줘. (예: "현재 변동성에서는 RSI 진입 기준을 35로 상향 조정하는 것이 유리합니다") 구체적 수치·파일명을 포함한 5줄 이내로 제안만 출력.\n\n[누적 진단 요약]\n${accumulatedDiagnosticsText}`;
  const text = await getGeminiResponse(prompt);
  return text === GEMINI_DELAY_MESSAGE ? null : (text && text.length > 800 ? text.slice(0, 797) + '…' : text);
}

/** 하루치 로그 분석: [답변 종료]까지 수집 후 반환. 오류 시 수정 위치·파일명 제안 */
async function askGeminiForLogAnalysis(logText, dbContext) {
  if (!genAI || !GEMINI_API_KEY) return null;
  const dbBlock = (dbContext && dbContext.trim()) ? `\n[당일 DB 요약]\n${dbContext.trim()}\n\n` : '';
  const prompt = `아래는 현재 시스템의 오늘 하루치 로그${dbBlock ? '와 당일 DB 요약' : ''}입니다. 오류(에러, Error, Exception, fail, 오류, 에러 등)가 있다면:
1) 어떤 파일·모듈에서 발생했는지 (파일 경로·함수명)
2) 원인 추정
3) 어디를 어떻게 수정하면 좋을지 (파일명·라인 근처·수정 제안을 구체적으로, Cursor에서 바로 고칠 수 있게)

를 5~10줄 이내로 요약해줘. 오류가 없으면 "오늘자 로그에서 오류 없음"이라고만 출력해줘.
답변 마지막에 반드시 [답변 종료]를 출력해줘.\n\n${dbBlock}[오늘자 로그]\n${(logText || '').slice(0, 28000)}`;
  const text = await getGeminiResponseComplete(prompt);
  return text === GEMINI_DELAY_MESSAGE ? null : text;
}

/**
 * 조언자의 한마디: 최근 거래 3건을 분석해 성공/실패 원인 + 다음 매매 조언 (2,000자 이내)
 * @param {string} tradesText - 최근 거래 JSON 또는 요약 텍스트
 * @param {string} [memoryText] - strategy_memory.txt 내용 (과거 교훈)
 * @returns {{ analysis: string, lesson: string | null }}
 */
async function askGeminiForAdvisorAdvice(tradesText, memoryText) {
  if (!genAI || !GEMINI_API_KEY) {
    return { analysis: 'API 키가 설정되지 않았습니다.', lesson: null };
  }
  const memoryBlock = memoryText ? `\n[과거 교훈]\n${memoryText}\n` : '';
  const prompt = `너는 업비트 스캘핑 전문 조언자야. 아래 최근 거래 데이터를 보고 분석해줘.${memoryBlock}

[최근 거래 데이터]
${tradesText || '거래 이력 없음'}

다음 두 가지를 반드시 포함해줘. 2,000자 이내로 요약해.
1) **성공/실패의 핵심 원인**을 기술적으로 분석해줘. (RSI, 거래량, 진입/청산 타점 등)
2) **다음 매매에서 주의해야 할 한 가지 조언**을 한 문장으로 끝에 반드시 "조언:"으로 시작해서 적어줘. 예: "조언: RSI 70 이상 추격매수 금지."

답변 마지막에 반드시 [답변 종료]를 출력해줘.`;
  try {
    const text = await getGeminiResponseComplete(prompt);
    if (!text || text === GEMINI_DELAY_MESSAGE) {
      return { analysis: '분석을 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.', lesson: null };
    }
    const analysis = text.length > 2000 ? text.slice(0, 1997) + '…' : text;
    let lesson = null;
    const match = text.match(/조언\s*:\s*([^\n]+)/);
    if (match && match[1]) {
      lesson = match[1].trim().slice(0, 300);
    } else {
      const lastLine = text.split('\n').filter((l) => l.trim()).pop();
      if (lastLine && lastLine.length <= 300) lesson = lastLine.trim();
    }
    return { analysis, lesson };
  } catch (e) {
    console.error('[Gemini] askGeminiForAdvisorAdvice:', e?.message);
    return { analysis: '분석 중 오류가 발생했습니다.', lesson: null };
  }
}

/** 런타임에 실제 사용 중인 모델명 확인용 */
function getModelName() {
  return 'gemini-2.5-flash';
}

/** 부팅 시 직렬 초기화용 — 모듈 로드·모델명 확인 후 Discord login 진행 */
async function init() {
  getModelName();
  return Promise.resolve();
}

module.exports = {
  init,
  getModelName,
  setOnBillingDisabledCallback,
  getGeminiResponse,
  getGeminiResponseComplete,
  getDailyUsage,
  askGeminiForScanVol,
  askGeminiForPick,
  askGeminiForMarketSummary,
  askGeminiForScalpPoint,
  askGeminiForPortfolioRisk,
  askGeminiForNoTradeDiagnosis,
  askGeminiForLogicSuggestion,
  askGeminiForLogAnalysis,
  askGeminiForAdvisorAdvice
};
