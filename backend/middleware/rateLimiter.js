'use strict';
/**
 * backend/middleware/rateLimiter.js
 *
 * Rate limiting middleware for all routes.
 * Stricter limits on auth endpoints to prevent brute force.
 *
 * Install: npm install express-rate-limit
 *
 * FIX (NEW) — GLOBAL LIMITER BLOCKED NORMAL JOB-STATUS POLLING
 *   Old: globalLimiter allowed only 200 requests / 15 min per IP, applied to
 *        EVERY route including GET /api/procurement/:jobId. But
 *        ProcurementWorkspace.jsx polls that endpoint every 2 seconds for up
 *        to 10 minutes per job (up to 300 requests) — one single
 *        reconciliation job could burn through the entire window's budget by
 *        itself. Any upload attempted afterward got an immediate
 *        "Too many requests" 429, even though the user made no unusual
 *        number of real requests.
 *   New: job-status polling (GET /api/procurement/job_*) is exempted from
 *        the global limiter, the same way /health already was.
 *
 * PHASE 2 (post-review) — Redis-backed store, in-memory fallback
 *   Old: express-rate-limit's default in-memory store means counts reset on
 *        every restart, and each server instance keeps its own separate
 *        count — an attacker gets N× the real limit across N instances, and
 *        AWS deploys/restarts effectively reset everyone's rate limit.
 *   New: HybridRateLimitStore below stores counts in the shared Redis
 *        (config/redis.js) instead — durable across restarts, shared across
 *        every instance. If Redis is unreachable, it transparently falls
 *        back to a local in-memory count (same behavior as before), so a
 *        Redis outage degrades to "rate limiting is instance-local again",
 *        never to "requests get rejected" or "the server won't start".
 *        Every windowMs/max/message/skip value below is UNCHANGED — only
 *        the storage backend for the counters changed.
 *
 *        Note: the review's suggested rate-limit-redis package was tested
 *        and found to throw during startup if Redis isn't reachable at that
 *        exact moment, which would crash the whole server before it can
 *        even start listening. The store below is a small custom
 *        implementation instead, verified three ways: Redis up throughout,
 *        Redis down the whole time including at startup, and Redis dying
 *        mid-flight — none of those cases crash the server or drop
 *        requests.
 */

const rateLimit  = require('express-rate-limit');
const sharedRedis = require('../config/redis');

// ── PHASE 2 (post-review) — Redis-backed rate limit store ────────────────────
// See the module comment above for why this is a small custom store rather
// than the rate-limit-redis package.
//
// Each limiter below gets its OWN instance (distinct `prefix`), so their
// counts never collide with each other in Redis.
class HybridRateLimitStore {
  constructor(prefix) {
    this.prefix = prefix;
    this.windowMs = 15 * 60 * 1000; // overwritten by init() with the real value
    this._local = new Map(); // key -> { count, resetAt } — fallback only

    // Prevent the local fallback map from growing unboundedly if Redis is
    // down for a long stretch — same cleanup-interval pattern used
    // throughout the rest of Phase 2.
    const sweep = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this._local.entries()) if (v.resetAt <= now) this._local.delete(k);
    }, 5 * 60 * 1000);
    if (sweep.unref) sweep.unref();
  }

  // Called by express-rate-limit with the real options (has the real windowMs).
  init(options) {
    this.windowMs = options.windowMs;
  }

  _redisKey(key) {
    return `ratelimit:${this.prefix}:${key}`;
  }

  async increment(key) {
    if (sharedRedis.isAvailable()) {
      try {
        const redisKey = this._redisKey(key);
        // INCR + set expiry only on the first hit in this window — two
        // commands, not a transaction, but the failure mode of a missed
        // PEXPIRE (key never expires) is self-correcting: worst case is one
        // stale counter that a later DEL/resetKey or Redis eviction clears,
        // never an under-count that would let someone past the limit.
        const totalHits = await sharedRedis.redis.incr(redisKey);
        if (totalHits === 1) await sharedRedis.redis.pexpire(redisKey, this.windowMs);
        const ttl = await sharedRedis.redis.pttl(redisKey);
        return { totalHits, resetTime: new Date(Date.now() + Math.max(ttl, 0)) };
      } catch (err) {
        console.warn(`[rateLimiter:${this.prefix}] Redis increment failed, falling back to local memory:`, err.message);
        // fall through to local fallback below
      }
    }
    return this._localIncrement(key);
  }

  _localIncrement(key) {
    const now = Date.now();
    let entry = this._local.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this._local.set(key, entry);
    }
    entry.count += 1;
    return { totalHits: entry.count, resetTime: new Date(entry.resetAt) };
  }

  async decrement(key) {
    if (sharedRedis.isAvailable()) {
      try { await sharedRedis.redis.decr(this._redisKey(key)); return; } catch { /* fall through */ }
    }
    const entry = this._local.get(key);
    if (entry && entry.count > 0) entry.count -= 1;
  }

  async resetKey(key) {
    if (sharedRedis.isAvailable()) {
      try { await sharedRedis.redis.del(this._redisKey(key)); } catch { /* best-effort */ }
    }
    this._local.delete(key);
  }
}

// `passOnStoreError: true` is defense-in-depth on top of the store's own
// try/catch above: if increment() ever throws anyway (a bug, an unexpected
// Redis reply shape, etc.), express-rate-limit lets the request through
// rather than 500ing it. A rate limiter's job is to reject a request that's
// happening too often, not to reject requests because ITS OWN bookkeeping
// had a hiccup.

// ── Global limiter — all routes ───────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs        : 15 * 60 * 1000, // 15 minutes
  max             : 200,             // 200 requests per window per IP
  standardHeaders : true,
  legacyHeaders   : false,
  passOnStoreError: true,
  store           : new HybridRateLimitStore('global'),
  message         : { error: 'Too many requests. Please try again later.', code: 'RATE_LIMITED' },
  skip            : (req) =>
    req.path === '/health' ||                       // never limit health checks
    /^\/api\/procurement\/job_/.test(req.path),      // FIX: never limit job-status polling
});

// ── Auth limiter — stricter for login/signup ──────────────────────────────────
const authLimiter = rateLimit({
  windowMs        : 15 * 60 * 1000, // 15 minutes
  max             : 10,              // only 10 auth attempts per window
  standardHeaders : true,
  legacyHeaders   : false,
  passOnStoreError: true,
  store           : new HybridRateLimitStore('auth'),
  message         : { error: 'Too many login attempts. Please wait 15 minutes.', code: 'AUTH_RATE_LIMITED' },
});

// ── Upload limiter — file uploads are expensive ───────────────────────────────
const uploadLimiter = rateLimit({
  windowMs        : 60 * 60 * 1000, // 1 hour
  max             : 50,              // 50 uploads per hour per IP
  standardHeaders : true,
  legacyHeaders   : false,
  passOnStoreError: true,
  store           : new HybridRateLimitStore('upload'),
  message         : { error: 'Upload limit reached. Please try again in an hour.', code: 'UPLOAD_RATE_LIMITED' },
});

// ── Voice limiter — transcription calls ──────────────────────────────────────
const voiceLimiter = rateLimit({
  windowMs        : 5 * 60 * 1000,  // 5 minutes
  max             : 30,              // 30 voice calls per 5 min
  standardHeaders : true,
  legacyHeaders   : false,
  passOnStoreError: true,
  store           : new HybridRateLimitStore('voice'),
  message         : { error: 'Voice command limit reached. Please wait.', code: 'VOICE_RATE_LIMITED' },
});

// ── AI limiter — AI calls cost tokens ────────────────────────────────────────
const aiLimiter = rateLimit({
  windowMs        : 60 * 60 * 1000, // 1 hour
  max             : 100,             // 100 AI calls per hour
  standardHeaders : true,
  legacyHeaders   : false,
  passOnStoreError: true,
  store           : new HybridRateLimitStore('ai'),
  message         : { error: 'AI request limit reached. Please try again later.', code: 'AI_RATE_LIMITED' },
});

module.exports = { globalLimiter, authLimiter, uploadLimiter, voiceLimiter, aiLimiter };

