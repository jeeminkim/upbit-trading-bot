"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDb = getDb;
exports.getDbSync = getDbSync;
exports.closeDb = closeDb;
const path_1 = __importDefault(require("path"));
// Use project's sqlite3 (callback API wrapped in Promise)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sqlite3 = require('sqlite3');
let db = null;
function open() {
    return new Promise((resolve, reject) => {
        if (db)
            return resolve(db);
        const dataDir = process.env.DATA_DIR || path_1.default.join(process.cwd(), 'data');
        const dbPath = path_1.default.join(dataDir, 'audit.db');
        db = new sqlite3.Database(dbPath, (err) => {
            if (err)
                return reject(err);
            resolve(db);
        });
    });
}
function run(db, sql, params) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, (err) => (err ? reject(err) : resolve()));
    });
}
function all(db, sql, params) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}
async function getDb() {
    const database = await open();
    await run(database, `
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      command TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      success INTEGER NOT NULL,
      error_code TEXT,
      approved INTEGER,
      order_created INTEGER
    )
  `, []);
    await run(database, 'CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)', []);
    return {
        run: (sql, params) => run(database, sql, params),
        all: (sql, params) => all(database, sql, params),
    };
}
let dbInstance = null;
async function getDbSync() {
    if (!dbInstance)
        dbInstance = await getDb();
    return dbInstance;
}
function closeDb() {
    dbInstance = null;
    if (db) {
        db.close();
        db = null;
    }
}
