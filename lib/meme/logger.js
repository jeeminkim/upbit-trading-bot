/**
 * MPI 학습용 로거: 콘솔 + 파일( logs/meme_engine.log )
 * 태그: [MPI_FETCH] [MPI_RAW] [MPI_COMP] [MPI_SCORE] [CACHE] [FALLBACK] [ERROR]
 */

const path = require('path');
const fs = require('fs');

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'meme_engine.log');

function ensureDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (e) {}
}

function formatTs() {
  return new Date().toISOString();
}

function write(tag, message, meta = null) {
  const metaStr = meta != null ? ' ' + JSON.stringify(meta) : '';
  const line = `[${formatTs()}] ${tag} ${message}${metaStr}\n`;
  ensureDir();
  try {
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (e) {
    console.error('[MPI LOG FILE]', e.message);
  }
  console.log(tag, message, metaStr.trim() || '');
}

/** [DATA_SOURCE_WARN] 전용 — meme_engine.log + 콘솔. 외부 API 실패 시 크래시 없이 로그만 남김 */
function dataSourceWarn(message, meta = null) {
  const tag = '[DATA_SOURCE_WARN]';
  const metaStr = meta != null ? ' ' + JSON.stringify(meta) : '';
  const line = `[${formatTs()}] ${tag} ${message}${metaStr}\n`;
  ensureDir();
  try {
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (e) {
    console.error('[MPI LOG FILE]', e.message);
  }
  console.warn(tag, message, metaStr.trim() || '');
}

module.exports = {
  fetch: (msg, meta) => write('[MPI_FETCH]', msg, meta),
  raw: (msg, meta) => write('[MPI_RAW]', msg, meta),
  comp: (msg, meta) => write('[MPI_COMP]', msg, meta),
  score: (msg, meta) => write('[MPI_SCORE]', msg, meta),
  signal: (msg, meta) => write('[MPI_SIGNAL]', msg, meta),
  eval: (msg, meta) => write('[MPI_EVAL]', msg, meta),
  diag: (msg, meta) => write('[MPI_DIAG]', msg, meta),
  regime: (msg, meta) => write('[REGIME_DETECT]', msg, meta),
  cache: (msg, meta) => write('[CACHE]', msg, meta),
  fallback: (msg, meta) => write('[FALLBACK]', msg, meta),
  error: (msg, meta) => write('[ERROR]', msg, meta),
  dataSourceWarn
};
