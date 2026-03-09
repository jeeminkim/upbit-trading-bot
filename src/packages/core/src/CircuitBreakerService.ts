const THRESHOLD = 5;
const HALF_OPEN_AFTER_MS = 60_000;

type State = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface Breaker {
  state: State;
  failures: number;
  lastFailureAt: number | null;
}

const breakers: Record<string, Breaker> = {};

function getBreaker(name: string): Breaker {
  if (!breakers[name]) breakers[name] = { state: 'CLOSED', failures: 0, lastFailureAt: null };
  return breakers[name];
}

export const CircuitBreakerService = {
  async execute<T>(name: 'upbit' | 'gemini' | 'network', fn: () => Promise<T>): Promise<T> {
    const b = getBreaker(name);
    if (b.state === 'OPEN') {
      if (Date.now() - (b.lastFailureAt ?? 0) > HALF_OPEN_AFTER_MS) b.state = 'HALF_OPEN';
      else throw new Error(`CIRCUIT_OPEN_${name.toUpperCase()}`);
    }
    try {
      const r = await fn();
      b.failures = 0;
      b.state = 'CLOSED';
      return r;
    } catch (e) {
      b.failures++;
      b.lastFailureAt = Date.now();
      if (b.failures >= THRESHOLD) b.state = 'OPEN';
      throw e;
    }
  },

  getState(name: string): State {
    return getBreaker(name).state;
  },

  reset(name: string): void {
    const b = getBreaker(name);
    b.state = 'CLOSED';
    b.failures = 0;
    b.lastFailureAt = null;
  },
};
