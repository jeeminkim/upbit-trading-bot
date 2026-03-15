"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CircuitBreakerService = void 0;
const THRESHOLD = 5;
const HALF_OPEN_AFTER_MS = 60000;
const breakers = {};
function getBreaker(name) {
    if (!breakers[name])
        breakers[name] = { state: 'CLOSED', failures: 0, lastFailureAt: null };
    return breakers[name];
}
exports.CircuitBreakerService = {
    async execute(name, fn) {
        const b = getBreaker(name);
        if (b.state === 'OPEN') {
            if (Date.now() - (b.lastFailureAt ?? 0) > HALF_OPEN_AFTER_MS)
                b.state = 'HALF_OPEN';
            else
                throw new Error(`CIRCUIT_OPEN_${name.toUpperCase()}`);
        }
        try {
            const r = await fn();
            b.failures = 0;
            b.state = 'CLOSED';
            return r;
        }
        catch (e) {
            b.failures++;
            b.lastFailureAt = Date.now();
            if (b.failures >= THRESHOLD)
                b.state = 'OPEN';
            throw e;
        }
    },
    getState(name) {
        return getBreaker(name).state;
    },
    reset(name) {
        const b = getBreaker(name);
        b.state = 'CLOSED';
        b.failures = 0;
        b.lastFailureAt = null;
    },
};
