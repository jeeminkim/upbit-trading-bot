/**
 * Critical Signal 저장: /data/meme_history.jsonl, /data/meme_signals.jsonl
 * - history: 매 사이클 MPI 스냅샷 (공부용)
 * - signals: MPI>=70 등 조건 충족 시 저장, 추후 성능검진용
 * - 시스템 실패 시에도 서버가 죽지 않도록 try/catch
 */

const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'meme_history.jsonl');
const SIGNALS_FILE = path.join(DATA_DIR, 'meme_signals.jsonl');

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error('[signalStore] ensureDataDir:', e.message);
  }
}

/**
 * 한 줄 JSON 추가 (append only)
 * @param {string} filePath
 * @param {Object} obj
 */
function appendLine(filePath, obj) {
  try {
    ensureDataDir();
    const line = JSON.stringify(obj) + '\n';
    fs.appendFileSync(filePath, line, 'utf8');
  } catch (e) {
    console.error('[signalStore] appendLine:', e.message);
  }
}

/**
 * history 예시: { symbol, timestamp, price, mpi, mpi_velocity, components, raw }
 */
function appendHistory(record) {
  appendLine(HISTORY_FILE, record);
}

/**
 * signal 예시: { id, symbol, detected_at, price_at_signal, mpi, mpi_velocity, components, evaluation }
 */
function appendSignal(signal) {
  appendLine(SIGNALS_FILE, signal);
}

/**
 * 파일에서 최근 N줄 읽기 (역순으로 파싱)
 */
function readLastLines(filePath, n = 500) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.slice(-n).map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    }).filter(Boolean);
  } catch (e) {
    console.error('[signalStore] readLastLines:', e.message);
    return [];
  }
}

function getHistoryLast(n = 200) {
  return readLastLines(HISTORY_FILE, n);
}

function getSignalsLast(n = 100) {
  return readLastLines(SIGNALS_FILE, n);
}

/** signal id 생성: BTC_1710000000 */
function makeSignalId(symbol, ts) {
  return `${symbol}_${ts}`;
}

module.exports = {
  appendHistory,
  appendSignal,
  getHistoryLast,
  getSignalsLast,
  makeSignalId,
  HISTORY_FILE,
  SIGNALS_FILE
};
