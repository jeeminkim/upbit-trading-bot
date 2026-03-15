import type { AuditLogEntry } from '../../shared/src/types';
import { getDbSync } from './AuditLogDb';

export const AuditLogService = {
  async log(entry: AuditLogEntry): Promise<void> {
    const db = await getDbSync();
    await db.run(
      `INSERT INTO audit_log (user_id, command, timestamp, success, error_code, approved, order_created)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.userId,
        entry.command,
        entry.timestamp,
        entry.success ? 1 : 0,
        entry.errorCode ?? null,
        entry.approved != null ? (entry.approved ? 1 : 0) : null,
        entry.orderCreated != null ? (entry.orderCreated ? 1 : 0) : null,
      ]
    );
  },

  async getRecent(limit: number): Promise<AuditLogEntry[]> {
    const db = await getDbSync();
    const rows = await db.all(
      `SELECT user_id as userId, command, timestamp, success, error_code as errorCode, approved, order_created as orderCreated
       FROM audit_log ORDER BY timestamp DESC LIMIT ?`,
      [limit]
    );
    return rows.map((r: any) => ({
      userId: r.userId,
      command: r.command,
      timestamp: r.timestamp,
      success: !!r.success,
      errorCode: r.errorCode ?? undefined,
      approved: r.approved != null ? !!r.approved : undefined,
      orderCreated: r.orderCreated != null ? !!r.orderCreated : undefined,
    }));
  },
};
