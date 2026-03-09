"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventBus = void 0;
const listeners = new Map();
exports.EventBus = {
    emit(type, payload) {
        const set = listeners.get(type);
        if (!set)
            return;
        set.forEach((fn) => {
            try {
                const r = fn(payload);
                if (r && typeof r.catch === 'function')
                    r.catch((e) => console.error('[EventBus]', type, e));
            }
            catch (e) {
                console.error('[EventBus]', type, e);
            }
        });
    },
    subscribe(type, fn) {
        if (!listeners.has(type))
            listeners.set(type, new Set());
        listeners.get(type).add(fn);
        return () => listeners.get(type)?.delete(fn);
    },
};
