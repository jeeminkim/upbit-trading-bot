const pending = new Map<string, { userId: string; command: string; expiresAt: number }>();
const TTL_MS = 5 * 60 * 1000;

function generateToken(): string {
  return Math.random().toString(36).slice(2, 18);
}

export const ConfirmFlow = {
  create(userId: string, command: string): string {
    const token = generateToken();
    pending.set(token, { userId, command, expiresAt: Date.now() + TTL_MS });
    return token;
  },

  consume(token: string, userId: string): { command: string } | null {
    const p = pending.get(token);
    pending.delete(token);
    if (!p || p.userId !== userId || Date.now() > p.expiresAt) return null;
    return { command: p.command };
  },

  cancel(token: string): void {
    pending.delete(token);
  },
};
