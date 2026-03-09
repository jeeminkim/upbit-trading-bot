import type { EventType } from '../../shared/src/types';

type Listener<T = unknown> = (payload: T) => void | Promise<void>;

const listeners = new Map<EventType, Set<Listener>>();

export const EventBus = {
  emit<T>(type: EventType, payload: T): void {
    const set = listeners.get(type);
    if (!set) return;
    set.forEach((fn) => {
      try {
        const r = fn(payload);
        if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch((e) => console.error('[EventBus]', type, e));
      } catch (e) {
        console.error('[EventBus]', type, e);
      }
    });
  },

  subscribe<T>(type: EventType, fn: Listener<T>): () => void {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(fn as Listener);
    return () => listeners.get(type)?.delete(fn as Listener);
  },
};
