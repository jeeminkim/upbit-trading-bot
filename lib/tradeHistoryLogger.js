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
const TRADE_HISTORY_RETENTION_DAYS = 30;

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
 * 최대 100줄 엄격 유지, 중복·빈 줄 제거 후 저장
 */
function appendStrategyMemory(lesson) {
  if (!lesson || typeof lesson !== 'string') return;
  const trimmed = lesson.trim().slice(0, 500).replace(/\n{2,}/g, '\n');
  if (!trimmed) return;
  ensureDir();
  try {
    fs.appendFileSync(STRATEGY_MEMORY_FILE, `[${new Date().toISOString()}] ${trimmed}\n`, 'utf8');
    const content = fs.readFileSync(STRATEGY_MEMORY_FILE, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    const seen = new Set();
    const deduped = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const key = lines[i].replace(/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*/, '').trim();
      if (key && !seen.has(key)) {
        seen.add(key);
        deduped.unshift(lines[i]);
      }
    }
    const kept = deduped.slice(-MAX_MEMORY_LINES);
    fs.writeFileSync(STRATEGY_MEMORY_FILE, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
  } catch (e) {
    console.warn('[tradeHistoryLogger] appendStrategyMemory 실패:', e?.message);
  }
}

/**
 * strategy_memory.txt: 최대 100줄, 빈 줄·중복 제거 후 저장 (저장 시점 정제 강화)
 * append 외 경로로 파일이 비대해졌을 때 일일 청소에서 호출 가능
 * @returns {number} 제거된 줄 수 (0이면 변경 없음)
 */
function trimStrategyMemoryToMax() {
  try {
    if (!fs.existsSync(STRATEGY_MEMORY_FILE)) return 0;
    const content = fs.readFileSync(STRATEGY_MEMORY_FILE, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length <= MAX_MEMORY_LINES) return 0;
    const seen = new Set();
    const deduped = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const key = lines[i].replace(/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*/, '').trim();
      if (key && !seen.has(key)) {
        seen.add(key);
        deduped.unshift(lines[i]);
      }
    }
    const kept = deduped.slice(-MAX_MEMORY_LINES);
    fs.writeFileSync(STRATEGY_MEMORY_FILE, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
    return lines.length - kept.length;
  } catch (e) {
    console.warn('[tradeHistoryLogger] trimStrategyMemoryToMax:', e?.message);
    return 0;
  }
}

/**
 * trade_history.jsonl: 최근 30일 이내 거래만 유지, 나머지 삭제
 * @returns {number} 삭제된 라인 수
 */
function trimTradeHistoryOlderThanDays(days = TRADE_HISTORY_RETENTION_DAYS) {
  try {
    if (!fs.existsSync(TRADE_HISTORY_FILE)) return 0;
    const raw = fs.readFileSync(TRADE_HISTORY_FILE, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const kept = [];
    let removed = 0;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const ts = obj?.timestamp ? Date.parse(obj.timestamp) : NaN;
        if (Number.isFinite(ts) && ts >= cutoff) kept.push(line);
        else removed++;
      } catch (_) {
        kept.push(line);
      }
    }
    if (removed > 0) {
      fs.writeFileSync(TRADE_HISTORY_FILE, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
    }
    return removed;
  } catch (e) {
    console.warn('[tradeHistoryLogger] trimTradeHistoryOlderThanDays:', e?.message);
    return 0;
  }
}

/**
 * 분석용 임시 라벨: 체결되지 않은 진입 시도/계산 데이터는 24시간 후 삭제
 * meme_signals.jsonl에서 evaluation.label === 'PENDING' 이고 24시간 초과 항목 제거
 */
function cleanupTemporaryLabelsOlderThanHours(hours = 24) {
  const SIGNALS_FILE = path.join(DATA_DIR, 'meme_signals.jsonl');
  try {
    if (!fs.existsSync(SIGNALS_FILE)) return 0;
    const raw = fs.readFileSync(SIGNALS_FILE, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const kept = [];
    let removed = 0;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const ts = obj?.detected_at ? Date.parse(obj.detected_at) : (obj?.timestamp ? Date.parse(obj.timestamp) : NaN);
        const label = obj?.evaluation?.label;
        const isPendingOrUnset = label === 'PENDING' || !label;
        if (Number.isFinite(ts) && isPendingOrUnset && ts < cutoff) {
          removed++;
          continue;
        }
        kept.push(line);
      } catch (_) {
        kept.push(line);
      }
    }
    if (removed > 0) {
      fs.writeFileSync(SIGNALS_FILE, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
    }
    return removed;
  } catch (e) {
    console.warn('[tradeHistoryLogger] cleanupTemporaryLabelsOlderThanHours:', e?.message);
    return 0;
  }
}

module.exports = {
  appendTradeHistory,
  getLastTradesForAdvisor,
  getStrategyMemory,
  appendStrategyMemory,
  trimStrategyMemoryToMax,
  trimTradeHistoryOlderThanDays,
  cleanupTemporaryLabelsOlderThanHours,
  TRADE_HISTORY_FILE,
  STRATEGY_MEMORY_FILE
};
