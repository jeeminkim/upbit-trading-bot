/**
 * 거래 이력 로깅 (trade_history.jsonl) 및 조언자용 조회
 * - 매수/매도 시 RSI, trend_score 등과 함께 JSON Lines 형식으로 append
 * - 조언자의 한마디: 최근 N건 조회
 */

const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TRADE_HISTORY_FILE = path.join(DATA_DIR, 'trade_history.jsonl');
const STRATEGY_MEMORY_FILE = path.join(DATA_DIR, 'strategy_memory.txt');
const MAX_MEMORY_LINES = 100;

function ensureDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (_) {}
}

/**
 * 매수/매도 완료 시 한 줄 append. row: { ticker, side, price, quantity, net_return, reason, timestamp, rsi?, trend_score? }
 */
function appendTradeHistory(row, indicators = {}) {
  ensureDir();
  const entry = {
    ticker: row.ticker || '',
    side: (row.side || '').toLowerCase(),
    timestamp: row.timestamp || new Date().toISOString(),
    price: row.price != null ? row.price : null,
    quantity: row.quantity != null ? row.quantity : null,
    net_return: row.net_return != null ? row.net_return : null,
    reason: row.reason || null,
    rsi: indicators.rsi ?? row.rsi ?? null,
    trend_score: indicators.trend_score ?? row.trend_score ?? null
  };
  const line = JSON.stringify(entry) + '\n';
  try {
    fs.appendFileSync(TRADE_HISTORY_FILE, line, 'utf8');
  } catch (e) {
    console.warn('[tradeHistoryLogger] append 실패:', e?.message);
  }
}

/**
 * 조언자용: 최근 count건의 거래(매도 우선, 없으면 매수 포함) 반환. 각 항목은 문자열로 직렬화 가능한 객체.
 */
function getLastTradesForAdvisor(count = 3) {
  try {
    if (!fs.existsSync(TRADE_HISTORY_FILE)) return [];
    const raw = fs.readFileSync(TRADE_HISTORY_FILE, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    const parsed = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj && (obj.ticker || obj.side)) parsed.push(obj);
      } catch (_) {}
    }
    const sells = parsed.filter((p) => (p.side || '').toLowerCase() === 'sell');
    const forReturn = sells.length >= count ? sells.slice(-count) : parsed.slice(-count);
    return forReturn;
  } catch (e) {
    console.warn('[tradeHistoryLogger] getLastTradesForAdvisor:', e?.message);
    return [];
  }
}

/**
 * 장기 기억: strategy_memory.txt 내용 반환 (매매 엔진·조언자 프롬프트 강화용)
 */
function getStrategyMemory() {
  try {
    if (!fs.existsSync(STRATEGY_MEMORY_FILE)) return '';
    return fs.readFileSync(STRATEGY_MEMORY_FILE, 'utf8').trim();
  } catch (_) {
    return '';
  }
}

/**
 * Gemini 분석 결과에서 추출한 '교훈' 한 줄을 strategy_memory.txt에 append
 */
function appendStrategyMemory(lesson) {
  if (!lesson || typeof lesson !== 'string') return;
  const line = (lesson.trim().slice(0, 500) + '\n').replace(/\n{2,}/g, '\n');
  ensureDir();
  try {
    fs.appendFileSync(STRATEGY_MEMORY_FILE, `[${new Date().toISOString()}] ${line}`, 'utf8');
    const content = fs.readFileSync(STRATEGY_MEMORY_FILE, 'utf8');
    const lines = content.split('\n');
    if (lines.length > MAX_MEMORY_LINES) {
      fs.writeFileSync(STRATEGY_MEMORY_FILE, lines.slice(-MAX_MEMORY_LINES).join('\n') + '\n', 'utf8');
    }
  } catch (e) {
    console.warn('[tradeHistoryLogger] appendStrategyMemory 실패:', e?.message);
  }
}

module.exports = {
  appendTradeHistory,
  getLastTradesForAdvisor,
  getStrategyMemory,
  appendStrategyMemory
};
