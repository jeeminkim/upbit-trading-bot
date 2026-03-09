import path from 'path';

// Use project's sqlite3 (callback API wrapped in Promise)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sqlite3 = require('sqlite3');

let db: any = null;

function open(): Promise<any> {
  return new Promise((resolve, reject) => {
    if (db) return resolve(db);
    const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
    const dbPath = path.join(dataDir, 'audit.db');
    db = new sqlite3.Database(dbPath, (err: Error | null) => {
      if (err) return reject(err);
      resolve(db);
    });
  });
}

function run(db: any, sql: string, params: any[]): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err: Error | null) => (err ? reject(err) : resolve()));
  });
}

function all(db: any, sql: string, params: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err: Error | null, rows: any[]) => (err ? reject(err) : resolve(rows || [])));
  });
}

export async function getDb(): Promise<{ run: (s: string, p: any[]) => Promise<void>; all: (s: string, p: any[]) => Promise<any[]> }> {
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
    run: (sql: string, params: any[]) => run(database, sql, params),
    all: (sql: string, params: any[]) => all(database, sql, params),
  };
}

let dbInstance: Awaited<ReturnType<typeof getDb>> | null = null;

export async function getDbSync(): Promise<Awaited<ReturnType<typeof getDb>>> {
  if (!dbInstance) dbInstance = await getDb();
  return dbInstance;
}

export function closeDb(): void {
  dbInstance = null;
  if (db) {
    db.close();
    db = null;
  }
}
