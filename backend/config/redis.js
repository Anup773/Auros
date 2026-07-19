'use strict';
/**
 * backend/config/redis.js
 *
 * Shared Redis client for the Phase 2 security subsystem:
 *   - sessionStore.service.js  (access/refresh tokens, session revocation)
 *   - mfa.service.js           (MFA login-challenge state)
 *   - apiKey.service.js        (rate/usage counters — the keys themselves live on disk, see apiKey.service.js)
 *   - securityLogger.service.js (nothing stored here — stdout/disk only — but shares the module for consistency)
 *   - whatsapp.routes.js       (Redis-backed replay guard, replacing the in-memory Map)
 *
 * This intentionally does NOT touch queues/jobQueue.js, services/payments/paddle.service.js,
 * or services/procurement/reconciliationEngine.service.js — those already each own a working
 * Redis connection and are left exactly as they are. This module gives new Phase 2 code a
 * single shared connection instead of yet another bespoke `new IORedis(...)` per file.
 *
 * Same env var as the rest of the app: REDIS_URL (default redis://localhost:6379).
 * ioredis natively understands `rediss://` (TLS) URLs, so no manual URL parsing is needed
 * here the way jobQueue.js does it for BullMQ's connection-options object format.
 *
 * Design: fail OPEN, never fail CLOSED.
 * If Redis is down, every function in this module resolves to a safe default
 * (isAvailable() === false) instead of throwing, so a Redis outage degrades
 * security features (e.g. cross-instance session revocation) rather than
 * taking the whole API down. Callers combine this with an in-memory fallback
 * where one already exists (matching the pattern already used by
 * services/payments/paddle.service.js).
 */

const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let _available = false;
let _hasLoggedUnavailable = false;

const redis = new Redis(REDIS_URL, {
  // Don't crash the process or block startup if Redis isn't reachable yet.
  lazyConnect: false,
  enableOfflineQueue: true,
  maxRetriesPerRequest: 2,       // fail fast on individual commands rather than hanging requests
  retryStrategy(times) {
    if (times > 20) {
      // Stop hammering — back off to a slow, steady retry so logs don't flood.
      return 10_000;
    }
    return Math.min(times * 200, 3000);
  },
});

redis.on('ready', () => {
  _available = true;
  _hasLoggedUnavailable = false;
  console.log('[redis] Connected — Phase 2 security features (sessions, MFA, idempotency) are fully active.');
});

redis.on('error', (err) => {
  _available = false;
  // ioredis fires 'error' repeatedly while retrying — only log the first one per outage
  // to avoid flooding logs (mirrors the console.error filtering already used in
  // services/payments/paddle.service.js for the same reason).
  if (!_hasLoggedUnavailable) {
    console.error(
      '[redis] Connection error — Phase 2 features will run in degraded/local-only mode ' +
      'until Redis is reachable again:', err.message,
    );
    _hasLoggedUnavailable = true;
  }
});

redis.on('close', () => {
  _available = false;
});

/**
 * @returns {boolean} true if Redis is currently connected and usable.
 * Callers should treat `false` as "degrade gracefully", not "throw".
 */
function isAvailable() {
  return _available;
}

/**
 * Await Redis readiness at startup (non-fatal — resolves either way).
 * Call this once during server boot if you want a log line confirming
 * Redis is ready before accepting traffic; do NOT block server.listen() on it.
 */
function waitUntilReady(timeoutMs = 3000) {
  if (_available) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    redis.once('ready', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function closeRedis() {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}

module.exports = { redis, isAvailable, waitUntilReady, closeRedis, REDIS_URL };
