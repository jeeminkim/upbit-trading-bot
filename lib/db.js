/**
 * SQLite 거래 기록: 매수/매도 발생 시 timestamp, ticker, side, price, quantity, fee, revenue, net_return, reason
 * node 패키지 'sqlite3' 사용 (설치됨: npm install sqlite3)
 */

const path = require('path');
let sqlite3;
try {
  sqlite3 = require('sqlite3');
} catch (e) {
  console.warn('sqlite3 not installed. DB disabled.');
  sqlite3 = null;
}

const DB_PATH = path.join(__dirname, '..', 'trades.db');
let db = null;

function init() {
  if (!sqlite3) return Promise.resolve();
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        console.error('DB open error:', err.message);
        db = null;
        return reject(err);
      }
      db.run(`
        CREATE TABLE IF NOT EXISTS trades (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          ticker TEXT NOT NULL,
          side TEXT NOT NULL,
          price REAL NOT NULL,
          quantity REAL NOT NULL,
          fee REAL DEFAULT 0,
          revenue REAL DEFAULT 0,
          net_return REAL DEFAULT 0,
          reason TEXT,
          hold_seconds REAL
        )
      `, (err) => {
        if (err) {
          console.error('DB init error:', err.message);
          return reject(err);
        }
        db.run('ALTER TABLE trades ADD COLUMN hold_seconds REAL', () => {
          db.run('ALTER TABLE trades ADD COLUMN mpi_score REAL', () => {
            db.run('ALTER TABLE trades ADD COLUMN applied_multiplier REAL', () => {
              db.run('ALTER TABLE trades ADD COLUMN strategy_id INTEGER', () => {
                db.run('ALTER TABLE trades ADD COLUMN is_test INTEGER DEFAULT 0', () => {
                  db.run(`
                  CREATE TABLE IF NOT EXISTS reject_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    ticker TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    score_at_reject REAL
                  )
                `, () => {
                  db.run(`
                    CREATE TABLE IF NOT EXISTS strategy_history (
                      id INTEGER PRIMARY KEY AUTOINCREMENT,
                      created_at TEXT NOT NULL,
                      profile_json TEXT NOT NULL,
                      take_profit_target_pct REAL,
                      trailing_stop_pct REAL,
                      score_out_threshold REAL,
                      stop_loss_pct REAL,
                      time_stop_sec INTEGER,
                      race_horse_scheduler_enabled INTEGER DEFAULT 0
                    )
                  `, () => { resolve(); });
                });
                });
              });
            });
          });
        });
      });
    });
  });
}

const TRADES_STATS_FILTER = ' (COALESCE(is_test, 0) = 0) ';

function insertTrade(row) {
  if (!db) return Promise.resolve();
  return new Promise((resolve) => {
    db.run(
      `INSERT INTO trades (timestamp, ticker, side, price, quantity, fee, revenue, net_return, reason, mpi_score, applied_multiplier, strategy_id, is_test)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.timestamp || new Date().toISOString(),
        row.ticker || '',
        row.side || 'buy',
        row.price ?? 0,
        row.quantity ?? 0,
        row.fee ?? 0,
        row.revenue ?? 0,
        row.net_return ?? 0,
        row.reason ?? null,
        row.mpi_score ?? null,
        row.applied_multiplier ?? null,
        row.strategy_id ?? null,
        row.is_test ? 1 : 0
      ],
      (err) => {
        if (err) console.error('DB insertTrade error:', err.message);
        resolve();
      }
    );
  });
}

function getRecentTrades(limit = 10) {
  if (!db) return Promise.resolve([]);
  return new Promise((resolve) => {
    db.all(
      'SELECT * FROM trades ORDER BY id DESC LIMIT ?',
      [limit],
      (err, rows) => {
        if (err) {
          console.error('DB getRecentTrades error:', err.message);
          return resolve([]);
        }
        const list = (rows || []).map((r) => ({
          id: r.id,
          timestamp: r.timestamp,
          ticker: r.ticker,
          side: r.side,
          price: r.price,
          quantity: r.quantity,
          fee: r.fee,
          revenue: r.revenue,
          net_return: r.net_return,
          reason: r.reason,
          mpi_score: r.mpi_score,
          applied_multiplier: r.applied_multiplier,
          strategy_id: r.strategy_id,
          is_test: r.is_test
        }));
        resolve(list);
      }
    );
  });
}

const EMPTY_STATS = {
  winRate: 0, winCount: 0, totalTrades: 0, cumulativeRevenue: 0, bestReturn: null, worstReturn: null,
  totalFee: 0, mddPct: null, avgHoldSeconds: null, dailyProfits: [],
  hourlyWinRate: [], profitByTicker: [], exitReasonCounts: []
};

/**
 * 수익률 분석용 통계: 승률, MDD, 총 수익/수수료 등. is_test=1(수동/테스트) 거래는 제외하여 순수 자동매매 성과만 반영.
 */
function getStats() {
  if (!db) return Promise.resolve(EMPTY_STATS);
  const where = ' WHERE ' + TRADES_STATS_FILTER;
  return new Promise((resolve) => {
    db.get('SELECT COUNT(*) as total FROM trades' + where, [], (err, r) => {
      if (err) return resolve(EMPTY_STATS);
      const totalTrades = r?.total ?? 0;
      db.get('SELECT COUNT(*) as wins FROM trades WHERE net_return > 0 AND ' + TRADES_STATS_FILTER.trim(), [], (err2, r2) => {
        if (err2) return resolve({ ...EMPTY_STATS, totalTrades });
        const winCount = r2?.wins ?? 0;
        const winRate = totalTrades > 0 ? (winCount / totalTrades) * 100 : 0;
        db.get('SELECT COALESCE(SUM(revenue), 0) as sum_rev, COALESCE(MAX(net_return), 0) as best, COALESCE(MIN(net_return), 0) as worst, COALESCE(SUM(fee), 0) as total_fee FROM trades' + where, [], (err3, r3) => {
          if (err3) return resolve({ ...EMPTY_STATS, winRate, winCount, totalTrades });
          const base = {
            winRate, winCount, totalTrades,
            cumulativeRevenue: r3?.sum_rev ?? 0,
            bestReturn: r3?.best ?? null,
            worstReturn: r3?.worst ?? null,
            totalFee: r3?.total_fee ?? 0
          };
          db.all('SELECT date(timestamp) as day, SUM(revenue) as daily_profit FROM trades' + where + ' GROUP BY day ORDER BY day', [], (err4, rows4) => {
            const dailyProfits = (err4 ? [] : (rows4 || [])).map((row) => ({ day: row.day, daily_profit: row.daily_profit }));
            db.all('SELECT timestamp, net_return FROM trades' + where + ' ORDER BY timestamp', [], (err5, rows5) => {
              let mddPct = null;
              if (!err5 && rows5 && rows5.length > 0) {
                let peak = 0;
                let cum = 0;
                let mdd = 0;
                rows5.forEach((row) => {
                  cum += row.net_return != null ? row.net_return : 0;
                  if (cum > peak) peak = cum;
                  const dd = peak - cum;
                  if (dd > mdd) mdd = dd;
                });
                mddPct = peak > 0 ? (mdd / peak) * 100 : 0;
              }
              db.get('SELECT AVG(hold_seconds) as avg_hold FROM trades WHERE hold_seconds IS NOT NULL AND ' + TRADES_STATS_FILTER.trim(), [], (err6, r6) => {
                const avgHoldSeconds = (err6 || !r6) ? null : r6.avg_hold;
                db.all("SELECT strftime('%H', timestamp) as hour, COUNT(*) as total, SUM(CASE WHEN net_return > 0 THEN 1 ELSE 0 END) as wins FROM trades" + where + " GROUP BY hour ORDER BY hour", [], (err7, rows7) => {
                  const hourMap = {};
                  for (let h = 0; h < 24; h++) hourMap[String(h).padStart(2, '0')] = { hour: h, total: 0, wins: 0, winRate: 0 };
                  (err7 ? [] : (rows7 || [])).forEach((row) => {
                    const hr = row.hour;
                    const total = row.total || 0;
                    const wins = row.wins || 0;
                    hourMap[hr] = { hour: parseInt(hr, 10), total, wins, winRate: total > 0 ? (wins / total) * 100 : 0 };
                  });
                  const hourlyWinRate = Object.keys(hourMap).sort().map((k) => hourMap[k]);
                  db.all('SELECT ticker, SUM(net_return) as profit FROM trades' + where + ' GROUP BY ticker', [], (err8, rows8) => {
                    const profitByTicker = (err8 ? [] : (rows8 || [])).map((row) => ({ ticker: row.ticker, profit: row.profit }));
                    db.all("SELECT reason, COUNT(*) as cnt FROM trades WHERE side='sell' AND reason IS NOT NULL AND reason != '' AND " + TRADES_STATS_FILTER.trim() + " GROUP BY reason", [], (err9, rows9) => {
                      const exitReasonCounts = (err9 ? [] : (rows9 || [])).map((row) => ({ reason: row.reason || '기타', count: row.cnt }));
                      resolve({
                        ...base,
                        mddPct,
                        avgHoldSeconds,
                        dailyProfits,
                        hourlyWinRate,
                        profitByTicker,
                        exitReasonCounts
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}

/**
 * 4시간 단위 데이터 클리닝: 실제 매수/매도(BUY/SELL)가 아닌 로그만 삭제.
 * side가 'buy' 또는 'sell'인 행은 수익 통계용으로 절대 삭제하지 않음.
 * @param {number} cutoffHours - 이 시간(시) 이전 타임스탬프만 삭제 대상
 * @returns {Promise<number>} 삭제된 행 수
 */
function cleanupOldNonTrades(cutoffHours = 4) {
  if (!db) return Promise.resolve(0);
  const cutoff = new Date(Date.now() - cutoffHours * 3600 * 1000).toISOString();
  return new Promise((resolve) => {
    db.run(
      `DELETE FROM trades WHERE timestamp < ? AND (
        side IS NULL OR TRIM(COALESCE(side, '')) = '' OR
        LOWER(TRIM(side)) NOT IN ('buy', 'sell')
      )`,
      [cutoff],
      function (err) {
        if (err) {
          console.error('DB cleanup error:', err.message);
          return resolve(0);
        }
        resolve(this.changes || 0);
      }
    );
  });
}

function insertRejectLog(row) {
  if (!db) return Promise.resolve();
  return new Promise((resolve) => {
    db.run(
      'INSERT INTO reject_logs (timestamp, ticker, reason, score_at_reject) VALUES (?, ?, ?, ?)',
      [
        row.timestamp || new Date().toISOString(),
        row.ticker || '',
        row.reason || '',
        row.score_at_reject ?? null
      ],
      (err) => {
        if (err) console.error('DB insertRejectLog error:', err.message);
        resolve();
      }
    );
  });
}

function getTradesSinceHours(hours = 12) {
  if (!db) return Promise.resolve([]);
  return new Promise((resolve) => {
    db.all(
      "SELECT * FROM trades WHERE datetime(timestamp) >= datetime('now', ?) ORDER BY id DESC",
      ['-' + hours + ' hours'],
      (err, rows) => {
        if (err) {
          console.error('DB getTradesSinceHours error:', err.message);
          return resolve([]);
        }
        resolve((rows || []).map((r) => ({
          id: r.id,
          timestamp: r.timestamp,
          ticker: r.ticker,
          side: r.side,
          price: r.price,
          quantity: r.quantity,
          reason: r.reason,
          net_return: r.net_return
        })));
      }
    );
  });
}

function getRejectLogsSinceHours(hours = 12) {
  if (!db) return Promise.resolve([]);
  return new Promise((resolve) => {
    db.all(
      "SELECT id, timestamp, ticker, reason, score_at_reject FROM reject_logs WHERE datetime(timestamp) >= datetime('now', ?) ORDER BY id DESC",
      ['-' + hours + ' hours'],
      (err, rows) => {
        if (err) {
          console.error('DB getRejectLogsSinceHours error:', err.message);
          return resolve([]);
        }
        resolve((rows || []).map((r) => ({
          id: r.id,
          timestamp: r.timestamp,
          ticker: r.ticker,
          reason: r.reason,
          score_at_reject: r.score_at_reject
        })));
      }
    );
  });
}

function getRecentRejectLogs(limit = 20) {
  if (!db) return Promise.resolve([]);
  return new Promise((resolve) => {
    db.all(
      'SELECT id, timestamp, ticker, reason, score_at_reject FROM reject_logs ORDER BY id DESC LIMIT ?',
      [limit],
      (err, rows) => {
        if (err) {
          console.error('DB getRecentRejectLogs error:', err.message);
          return resolve([]);
        }
        resolve((rows || []).map((r) => ({
          id: r.id,
          timestamp: r.timestamp,
          ticker: r.ticker,
          reason: r.reason,
          score_at_reject: r.score_at_reject
        })));
      }
    );
  });
}

/**
 * 4시간 단위: reject_logs에서 오래된 로그 삭제
 */
function cleanupRejectLogs(cutoffHours = 4) {
  if (!db) return Promise.resolve(0);
  const cutoff = new Date(Date.now() - cutoffHours * 3600 * 1000).toISOString();
  return new Promise((resolve) => {
    db.run('DELETE FROM reject_logs WHERE timestamp < ?', [cutoff], function (err) {
      if (err) {
        console.error('DB cleanupRejectLogs error:', err.message);
        return resolve(0);
      }
      resolve(this.changes || 0);
    });
  });
}

/** 전략 이력: 설정 저장 시마다 strategy_history에 기록 (저장 시각, 가중치, 익절/손절, 경주마 여부) */
function insertStrategyLog(profileSnapshot) {
  if (!db) return Promise.resolve(null);
  const now = new Date().toISOString();
  const profileJson = JSON.stringify(profileSnapshot);
  const p = profileSnapshot;
  return new Promise((resolve) => {
    db.run(
      `INSERT INTO strategy_history (created_at, profile_json, take_profit_target_pct, trailing_stop_pct, score_out_threshold, stop_loss_pct, time_stop_sec, race_horse_scheduler_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        now,
        profileJson,
        p.take_profit_target_pct ?? null,
        p.trailing_stop_pct ?? null,
        p.score_out_threshold ?? null,
        p.stop_loss_pct ?? null,
        p.time_stop_sec ?? null,
        p.race_horse_scheduler_enabled ? 1 : 0
      ],
      function (err) {
        if (err) {
          console.error('DB insertStrategyLog error:', err.message);
          return resolve(null);
        }
        resolve(this.lastID);
      }
    );
  });
}

/** 현재 적용 중인 전략 = strategy_history 최근 1건 */
function getLatestStrategyLog() {
  if (!db) return Promise.resolve(null);
  return new Promise((resolve) => {
    db.get(
      'SELECT id, created_at, profile_json, take_profit_target_pct, trailing_stop_pct, score_out_threshold, stop_loss_pct, time_stop_sec, race_horse_scheduler_enabled FROM strategy_history ORDER BY id DESC LIMIT 1',
      [],
      (err, row) => {
        if (err || !row) return resolve(null);
        let profile = null;
        try {
          profile = JSON.parse(row.profile_json || '{}');
        } catch (_) {}
        resolve({
          id: row.id,
          created_at: row.created_at,
          profile,
          take_profit_target_pct: row.take_profit_target_pct,
          trailing_stop_pct: row.trailing_stop_pct,
          score_out_threshold: row.score_out_threshold,
          stop_loss_pct: row.stop_loss_pct,
          time_stop_sec: row.time_stop_sec,
          race_horse_scheduler_enabled: !!row.race_horse_scheduler_enabled
        });
      }
    );
  });
}

/** 전략별 성과: 승률, 평균 수익률, MDD (매도만 집계) */
function getStrategyStats() {
  if (!db) return Promise.resolve([]);
  return new Promise((resolve) => {
    db.all(
      `SELECT strategy_id, COUNT(*) as total, SUM(CASE WHEN net_return > 0 THEN 1 ELSE 0 END) as wins,
       AVG(net_return) as avg_return, SUM(net_return) as sum_return
       FROM trades WHERE side = 'sell' AND strategy_id IS NOT NULL GROUP BY strategy_id`,
      [],
      (err, rows) => {
        if (err) return resolve([]);
        db.all(
          'SELECT strategy_id, net_return FROM trades WHERE side = ? AND strategy_id IS NOT NULL ORDER BY strategy_id, timestamp',
          ['sell'],
          (e2, series) => {
            const mddByStrategy = {};
            if (!e2 && series && series.length > 0) {
              let curId = null;
              let peak = 0;
              let cum = 0;
              let mdd = 0;
              series.forEach((row) => {
                if (row.strategy_id !== curId) {
                  if (curId != null) mddByStrategy[curId] = peak > 0 ? (mdd / peak) * 100 : 0;
                  curId = row.strategy_id;
                  peak = 0;
                  cum = 0;
                  mdd = 0;
                }
                cum += row.net_return != null ? row.net_return : 0;
                if (cum > peak) peak = cum;
                const dd = peak - cum;
                if (dd > mdd) mdd = dd;
              });
              if (curId != null) mddByStrategy[curId] = peak > 0 ? (mdd / peak) * 100 : 0;
            }
            const out = (rows || []).map((r) => ({
              strategy_id: r.strategy_id,
              total: r.total || 0,
              wins: r.wins || 0,
              winRate: r.total > 0 ? (r.wins / r.total) * 100 : 0,
              avgReturn: r.avg_return != null ? r.avg_return : null,
              sumReturn: r.sum_return != null ? r.sum_return : 0,
              mddPct: mddByStrategy[r.strategy_id] ?? null
            }));
            resolve(out);
          }
        );
      }
    );
  });
}

/** 오늘 하루 매도 기준 PNL·승률 (is_test 제외) */
function getTodayStats() {
  if (!db) return Promise.resolve({ totalTrades: 0, winCount: 0, winRate: 0, pnl: 0 });
  return new Promise((resolve) => {
    db.get(
      `SELECT COUNT(*) as total, SUM(CASE WHEN net_return > 0 THEN 1 ELSE 0 END) as wins, COALESCE(SUM(revenue), 0) as pnl
       FROM trades WHERE side = 'sell' AND (COALESCE(is_test, 0) = 0) AND date(timestamp) = date('now', 'localtime')`,
      [],
      (err, row) => {
        if (err) return resolve({ totalTrades: 0, winCount: 0, winRate: 0, pnl: 0 });
        const total = row?.total ?? 0;
        const wins = row?.wins ?? 0;
        resolve({
          totalTrades: total,
          winCount: wins,
          winRate: total > 0 ? (wins / total) * 100 : 0,
          pnl: row?.pnl ?? 0
        });
      }
    );
  });
}

module.exports = {
  init, insertTrade, getRecentTrades, getTradesSinceHours, getStats, getTodayStats, cleanupOldNonTrades,
  insertRejectLog, getRecentRejectLogs, getRejectLogsSinceHours, cleanupRejectLogs,
  insertStrategyLog, getLatestStrategyLog, getStrategyStats
};
