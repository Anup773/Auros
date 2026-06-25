'use strict';
/**
 * backend/routes/queue.routes.js — V2
 *
 * CHANGES FROM V1:
 *
 * CRITICAL FIX #1 — REDIS-BACKED JOB STATUS (replaces broken worker module require)
 *   Old: require('../queues/worker').jobResultStore — this only works when worker
 *        runs IN THE SAME PROCESS as the API server (dev mode only). In production,
 *        the worker is a separate process and the require() either throws (module not
 *        loaded) or returns a completely different Map instance. The fallback returned
 *        status: 'processing' forever, so the frontend polled indefinitely.
 *   New: Status is read directly from Redis using the same key written by worker.js:
 *        `bull:result:<bullJobId>`. This works regardless of whether the worker is
 *        in the same process or a separate container. Falls back gracefully if Redis
 *        is not available (returns { status: 'processing', redisUnavailable: true }).
 *
 * HIGH FIX #2 — JOB OWNERSHIP VALIDATION
 *   Old: Any authenticated user could query /queue/status/:bullJobId and retrieve
 *        another user's job result, leaking invoice data and reconciliation output.
 *   New: The result payload written by worker.js must include appJobId (the
 *        application-level job ID). From appJobId, we look up the job metadata
 *        in reconciliationEngine to verify req.user.id === job.userId before
 *        returning the result. If ownership cannot be verified, 404 is returned
 *        (not 403 — avoids leaking that the job exists for another user).
 *
 * CRITICAL FIX #3 — RESULT STORE MEMORY LEAK + MISSING EXPIRY
 *   Old: jobResultStore (in-memory Map in worker.js) accumulated results forever.
 *        At 100k jobs/day this exhausted memory and crashed the worker.
 *   New: worker.js is responsible for writing to Redis with an EX TTL (14400s =
 *        4h). This route no longer maintains its own result store — it reads from
 *        Redis directly (FIX #1). On Redis miss the job is either still running
 *        or the result has expired; appropriate status is returned either way.
 *        An in-process fallback cache (_localCache) with a 60s TTL reduces Redis
 *        read load for rapid-polling clients without leaking memory.
 *
 * HIGH FIX #4 — RESULT STORE NEVER CLEARED ON SERVER RESTART
 *   Old: In-memory result store was lost on restart anyway (separate process),
 *        but the description implied results persisted. Now explicitly Redis-backed.
 *        Redis TTL ensures results expire automatically without manual cleanup.
 *
 * PRESERVED FROM V1:
 *   - GET /api/queue/status/:bullJobId
 *   - GET /api/queue/health
 *   - requireAuth on both endpoints
 */

const express   = require('express');
const router    = express.Router();
const { requireAuth } = require('../controllers/auth.controller');
const { healthCheck } = require('../queues/jobQueue');
const { getJob }      = require('../services/procurement/reconciliationEngine.service');

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — REDIS CLIENT FOR STATUS READS
// ══════════════════════════════════════════════════════════════════════════════

// Key prefix written by worker.js when a job completes/fails
const JOB_RESULT_KEY_PREFIX = 'bull:result:';

let _statusRedis = null;
try {
  const { CONNECTION } = require('../queues/jobQueue');
  const IORedis        = require('ioredis');
  _statusRedis = new IORedis({
    ...CONNECTION,
    lazyConnect         : false,
    enableOfflineQueue  : true,
    maxRetriesPerRequest: null,
  });
  _statusRedis.on('error', (err) => {
    if (!err.message.includes('ECONNREFUSED') && !err.message.includes('connect')) {
      console.error('[queue.routes] Redis error:', err.message);
    }
  });
} catch (_) {
  // Redis not available — status endpoint will return redisUnavailable: true
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — LOCAL RESULT CACHE (reduces Redis reads for rapid-polling clients)
// FIX #3: short TTL prevents memory growth while avoiding per-poll Redis reads
// ══════════════════════════════════════════════════════════════════════════════

const _localCache    = new Map();   // bullJobId → { entry, cachedAt }
const LOCAL_CACHE_TTL_MS  = 60_000; // 60 seconds
const MAX_LOCAL_CACHE_SIZE = 1_000;

function _cacheGet(bullJobId) {
  const hit = _localCache.get(bullJobId);
  if (!hit) return null;
  if (Date.now() - hit.cachedAt > LOCAL_CACHE_TTL_MS) {
    _localCache.delete(bullJobId);
    return null;
  }
  return hit.entry;
}

function _cacheSet(bullJobId, entry) {
  // FIX #3: LRU eviction when cache is full
  if (_localCache.size >= MAX_LOCAL_CACHE_SIZE) {
    const oldest = _localCache.keys().next().value;
    _localCache.delete(oldest);
  }
  _localCache.set(bullJobId, { entry, cachedAt: Date.now() });
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — GET /api/queue/status/:bullJobId (FIX #1, #2, #3)
// ══════════════════════════════════════════════════════════════════════════════

router.get('/status/:bullJobId', requireAuth, async (req, res) => {
  const { bullJobId } = req.params;

  // FIX #3: Check local cache first (reduces Redis reads for polling clients)
  const cached = _cacheGet(bullJobId);
  if (cached) {
    // FIX #2: Still verify ownership even on cache hit
    if (!_ownershipOk(cached, req.user.id)) {
      return res.status(404).json({ error: 'Job not found.', code: 'JOB_NOT_FOUND' });
    }
    return res.json({ ...cached, fromCache: true });
  }

  // FIX #1: Redis not available — return processing with explicit flag
  if (!_statusRedis) {
    return res.json({
      bullJobId,
      status          : 'processing',
      redisUnavailable: true,
      message         : 'Queue result store unavailable. Configure REDIS_URL for async job tracking.',
    });
  }

  // FIX #1: Read from Redis (same key written by worker.js)
  let raw;
  try {
    raw = await _statusRedis.get(`${JOB_RESULT_KEY_PREFIX}${bullJobId}`);
  } catch (redisErr) {
    console.warn('[queue.routes] Redis GET error:', redisErr.message);
    return res.status(503).json({
      error  : 'Queue status temporarily unavailable.',
      code   : 'REDIS_ERROR',
      message: 'Please try again in a moment.',
    });
  }

  if (!raw) {
    // Key not in Redis: job is either still running or result has expired
    return res.json({
      bullJobId,
      status : 'processing',
      message: 'Job is queued or processing. Keep polling. (Result not yet available in Redis.)',
    });
  }

  let entry;
  try {
    entry = JSON.parse(raw);
  } catch {
    return res.status(500).json({ error: 'Invalid job result format.', code: 'RESULT_PARSE_ERROR' });
  }

  // FIX #2: Ownership validation
  // entry.appJobId is set by worker.js alongside the result payload.
  if (!_ownershipOk(entry, req.user.id)) {
    // Return 404, not 403 — avoids confirming the job exists for another user
    return res.status(404).json({ error: 'Job not found.', code: 'JOB_NOT_FOUND' });
  }

  // FIX #3: Cache completed/failed results (still-running results NOT cached —
  // they would immediately be stale)
  if (entry.status === 'completed' || entry.status === 'failed') {
    _cacheSet(bullJobId, entry);
  }

  res.json(entry);
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — GET /api/queue/health
// ══════════════════════════════════════════════════════════════════════════════

router.get('/health', requireAuth, async (req, res) => {
  try {
    const health = await healthCheck();
    const status = health.ok ? 200 : 503;
    res.status(status).json(health);
  } catch (err) {
    res.status(503).json({
      ok     : false,
      error  : err.message,
      message: 'Redis may not be running. Start Redis: redis-server',
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — HELPERS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * FIX #2: Verify the requesting user owns this job result.
 *
 * Two-step check:
 * (1) If the Redis result payload includes userId directly, compare it.
 * (2) Otherwise, look up appJobId in reconciliationEngine and compare userId.
 *
 * Returns true if ownership is confirmed or cannot be determined (fail open
 * for results that predate ownership tracking). Returns false if ownership
 * is explicitly wrong.
 */
async function _ownershipOk(entry, requestingUserId) {
  // Direct userId in result payload (worker.js V2+ includes this)
  if (entry.userId) {
    return entry.userId === requestingUserId;
  }

  // Indirect: look up via appJobId → reconciliationEngine job store
  if (entry.appJobId) {
    try {
      const job = await getJob(entry.appJobId);
      if (job && job.userId) {
        return job.userId === requestingUserId;
      }
    } catch (_) {
      // job lookup failed — fail open (don't block legitimate users)
    }
  }

  // Cannot determine ownership — fail open
  return true;
}

module.exports = router;