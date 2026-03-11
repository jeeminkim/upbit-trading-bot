import { PermissionLevel, type PermissionContext } from '../../shared/src/types';

const COMMAND_MIN_LEVEL: Record<string, PermissionLevel> = {
  'engine_start': PermissionLevel.ADMIN,
  'engine_stop': PermissionLevel.ADMIN,
  'engine_status': PermissionLevel.VIEWER,
  'sell_all': PermissionLevel.ADMIN,
  'cancel_all_orders': PermissionLevel.ADMIN,
  'current_state': PermissionLevel.VIEWER,
  'current_return': PermissionLevel.VIEWER,
  'pnl': PermissionLevel.VIEWER,
  'status': PermissionLevel.VIEWER,
  'analyst_scan_vol': PermissionLevel.ANALYST,
  'analyst_scan-vol': PermissionLevel.ANALYST,
  'analyst_summary': PermissionLevel.ANALYST,
  'analyst_indicators': PermissionLevel.ANALYST,
  'analyst_get_prompt': PermissionLevel.ANALYST,
  'analyst_major_indicators': PermissionLevel.ANALYST,
  'ai_analysis': PermissionLevel.ANALYST,
  'health': PermissionLevel.VIEWER,
  'strategy-mode': PermissionLevel.ADMIN,
  'strategy_status': PermissionLevel.VIEWER,
  'strategy-status': PermissionLevel.VIEWER,
  'strategy_explain_recent': PermissionLevel.VIEWER,
  'strategy-explain-recent': PermissionLevel.VIEWER,
  'strategy-skip-top': PermissionLevel.VIEWER,
};

const userRateCount = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_PER_MIN = 15;
const RATE_WINDOW_MS = 60_000;

export const PermissionService = {
  from(userId: string, channelId: string, roleOverride?: PermissionLevel): PermissionContext {
    const level = roleOverride ?? this.resolveLevel(userId);
    const allowedChannels = this.getAllowedChannels();
    return { userId, channelId, role: level, allowedChannels };
  },

  resolveLevel(userId: string): PermissionLevel {
    const superAdmin = process.env.ADMIN_ID || process.env.SUPER_ADMIN_ID || '';
    const admins = (process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (superAdmin && userId === superAdmin.trim()) return PermissionLevel.SUPER_ADMIN;
    if (admins.includes(userId)) return PermissionLevel.ADMIN;
    return PermissionLevel.VIEWER;
  },

  getAllowedChannels(): string[] {
    const raw = process.env.ALLOWED_CHANNEL_IDS || process.env.CHANNEL_ID || '';
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  },

  can(ctx: PermissionContext, command: string): boolean {
    const minLevel = COMMAND_MIN_LEVEL[command] ?? PermissionLevel.VIEWER;
    if (ctx.role < minLevel) return false;
    if (ctx.allowedChannels.length > 0 && !ctx.allowedChannels.includes(ctx.channelId)) return false;
    if (!this.checkRateLimit(ctx.userId)) return false;
    return true;
  },

  checkRateLimit(userId: string): boolean {
    const now = Date.now();
    let entry = userRateCount.get(userId);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
      userRateCount.set(userId, entry);
    }
    entry.count++;
    return entry.count <= RATE_LIMIT_PER_MIN;
  },

  isDangerCommand(command: string): boolean {
    return ['engine_stop', 'sell_all', 'cancel_all_orders'].includes(command);
  },
};
