"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PermissionService = void 0;
const types_1 = require("../../shared/src/types");
const COMMAND_MIN_LEVEL = {
    'engine_start': types_1.PermissionLevel.ADMIN,
    'engine_stop': types_1.PermissionLevel.ADMIN,
    'engine_status': types_1.PermissionLevel.VIEWER,
    'sell_all': types_1.PermissionLevel.ADMIN,
    'cancel_all_orders': types_1.PermissionLevel.ADMIN,
    'current_state': types_1.PermissionLevel.VIEWER,
    'current_return': types_1.PermissionLevel.VIEWER,
    'pnl': types_1.PermissionLevel.VIEWER,
    'status': types_1.PermissionLevel.VIEWER,
    'analyst_scan_vol': types_1.PermissionLevel.ANALYST,
    'analyst_scan-vol': types_1.PermissionLevel.ANALYST,
    'analyst_summary': types_1.PermissionLevel.ANALYST,
    'analyst_indicators': types_1.PermissionLevel.ANALYST,
    'analyst_get_prompt': types_1.PermissionLevel.ANALYST,
    'analyst_major_indicators': types_1.PermissionLevel.ANALYST,
    'ai_analysis': types_1.PermissionLevel.ANALYST,
    'health': types_1.PermissionLevel.VIEWER,
    'strategy-mode': types_1.PermissionLevel.ADMIN,
    'strategy_status': types_1.PermissionLevel.VIEWER,
    'strategy-status': types_1.PermissionLevel.VIEWER,
    'strategy_explain_recent': types_1.PermissionLevel.VIEWER,
    'strategy-explain-recent': types_1.PermissionLevel.VIEWER,
    'strategy-skip-top': types_1.PermissionLevel.VIEWER,
};
const userRateCount = new Map();
const RATE_LIMIT_PER_MIN = 15;
const RATE_WINDOW_MS = 60000;
exports.PermissionService = {
    from(userId, channelId, roleOverride) {
        const level = roleOverride ?? this.resolveLevel(userId);
        const allowedChannels = this.getAllowedChannels();
        return { userId, channelId, role: level, allowedChannels };
    },
    resolveLevel(userId) {
        const superAdmin = process.env.ADMIN_ID || process.env.SUPER_ADMIN_ID || '';
        const admins = (process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
        if (superAdmin && userId === superAdmin.trim())
            return types_1.PermissionLevel.SUPER_ADMIN;
        if (admins.includes(userId))
            return types_1.PermissionLevel.ADMIN;
        return types_1.PermissionLevel.VIEWER;
    },
    getAllowedChannels() {
        const raw = process.env.ALLOWED_CHANNEL_IDS || process.env.CHANNEL_ID || '';
        return raw.split(',').map((s) => s.trim()).filter(Boolean);
    },
    can(ctx, command) {
        const minLevel = COMMAND_MIN_LEVEL[command] ?? types_1.PermissionLevel.VIEWER;
        if (ctx.role < minLevel)
            return false;
        if (ctx.allowedChannels.length > 0 && !ctx.allowedChannels.includes(ctx.channelId))
            return false;
        if (!this.checkRateLimit(ctx.userId))
            return false;
        return true;
    },
    checkRateLimit(userId) {
        const now = Date.now();
        let entry = userRateCount.get(userId);
        if (!entry || now > entry.resetAt) {
            entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
            userRateCount.set(userId, entry);
        }
        entry.count++;
        return entry.count <= RATE_LIMIT_PER_MIN;
    },
    isDangerCommand(command) {
        return ['engine_stop', 'sell_all', 'cancel_all_orders'].includes(command);
    },
};
