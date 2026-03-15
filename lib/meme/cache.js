/**
 * TTL 캐시: 소스별 호출 감소, hit/miss/ttl 로그
 */

const logger = require('./logger');

const stores = new Map();

function get(key, ttlMs) {
  const entry = stores.get(key);
  if (!entry) {
    logger.cache(`key=${key} miss (no entry)`, { key });
    return null;
  }
  const now = Date.now();
  const remaining = entry.expiresAt - now;
  if (remaining <= 0) {
    stores.delete(key);
    logger.cache(`key=${key} miss (expired) ttl_was_ms=${entry.ttlMs}`, { key });
    return null;
  }
  logger.cache(`key=${key} hit ttl_remaining_ms=${Math.round(remaining)}`, { key });
  return entry.value;
}

function set(key, value, ttlMs) {
  stores.set(key, {
    value,
    ttlMs,
    expiresAt: Date.now() + ttlMs
  });
  logger.cache(`key=${key} set ttl_ms=${ttlMs}`, { key });
}

module.exports = { get, set };
