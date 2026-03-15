"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfirmFlow = void 0;
const pending = new Map();
const TTL_MS = 5 * 60 * 1000;
function generateToken() {
    return Math.random().toString(36).slice(2, 18);
}
exports.ConfirmFlow = {
    create(userId, command) {
        const token = generateToken();
        pending.set(token, { userId, command, expiresAt: Date.now() + TTL_MS });
        return token;
    },
    consume(token, userId) {
        const p = pending.get(token);
        pending.delete(token);
        if (!p || p.userId !== userId || Date.now() > p.expiresAt)
            return null;
        return { command: p.command };
    },
    cancel(token) {
        pending.delete(token);
    },
};
