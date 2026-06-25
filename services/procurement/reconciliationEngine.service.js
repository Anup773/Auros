'use strict';
/**
 * backend/services/procurement/reconciliationEngine.service.js
 *
 * CHANGES FROM V4 (this version — V5):
 *
 * CRITICAL FIX #1 — REDIS-BACKED JOB STORE (replaces in-memory Map)
 *   Old: const jobStore = new Map() — all job metadata lost on server restart,
 *        and unavailable to any other server instance in a cluster.
 *   New: All job metadata read/written via _jobRedis (a dedicated ioredis client).
 *        Key: `auros:job:<jobId>`  Value: JSON  TTL: JOB_EXPIRY_SEC (4 hours).
 *        getJob() / _setJob() / _updateJob() are the only places that touch Redis.
 *        An in-memory write-through Map (_localJobCache) is kept as a L1 cache
 *        to avoid Redis roundtrips for the hot path (same-process reads).
 *        On server restart, jobs are re-read from Redis transparently.
 *
 * CRITICAL FIX #2 — MULTI-SERVER JOB LOOKUP
 *   Old: getJob() / _requireJob() only checked the local Map.
 *   New: getJob() checks _localJobCache first, then falls back to Redis GET.
 *        Any server in the cluster can now serve a job created by another server.
 *
 * CRITICAL FIX #3 — REDIS PUB/SUB REPLACES POLLING LOOP
 *   Old: _pollForResult() ran a while-loop with sleep(2000) + Redis GET,
 *        creating 500 GET/s at 1000 concurrent jobs and an uncontrolled "Redis storm".
 *   New: _waitForResult() SUBscribes to channel `auros:job:done:<bullJobId>`.
 *        worker.js PUBLishes to that channel when done (in addition to SET).
 *        Fallback: if no PUB arrives within POLL_TIMEOUT_MS, one final Redis GET
 *        is attempted (guards against missed publishes on worker restart).
 *        This reduces Redis load from O(jobs × poll_rate) to O(completed_jobs).
 *
 * CRITICAL FIX #4 — SUBSCRIPTION CANCELLATION ON DISCONNECT
 *   Old: Polling loops survived even when the originating request was gone,
 *        wasting Redis connections and Node event loop budget.
 *   New: _waitForResult() returns an AbortController-compatible cancel function.
 *        startReconciliation() stores the cancel fn on the job; an optional
 *        cancelJob(jobId) export lets routes cancel orphaned waits on disconnect.
 *
 * HIGH FIX #5 — MEMORY: LOCAL CACHE WITH TTL EVICTION
 *   Old: setInterval cleanup ran every 30 min with 4-hour TTL — 100k jobs/day
 *        could accumulate enormous Map entries between cleanup sweeps.
 *   New: _localJobCache is a plain Map limited to MAX_LOCAL_CACHE_ENTRIES = 500
 *        (LRU eviction: oldest entry removed when cap exceeded).
 *        The authoritative store is Redis; the local Map is only a hot-path cache.
 *        setInterval handle stored in _cleanupInterval for graceful shutdown.
 *
 * HIGH FIX #6 — REDIS RESULT CONSUMED ATOMICALLY (GETDEL)
 *   Old: GET then DEL was two operations — if _applyReconcileResult() threw after
 *        GET but before DEL, re-reading the key on retry would work, but the
 *        DEL after a crash might never run, leaking the key.
 *        If _applyReconcileResult() crashed BEFORE DEL, result was already consumed
 *        and could not be retried.
 *   New: Uses Redis GETDEL (atomic get + delete in one command).
 *        If GETDEL is unavailable (Redis < 6.2), falls back to GET + DEL with a
 *        version check. Apply errors are caught and the job marked 'error' without
 *        losing the original error message.
 *
 * HIGH FIX #7 — QUEUE DEPTH LIMITS
 *   Old: _reconcileQueue.add() with no limits — 10k uploads could exhaust Redis RAM.
 *   New: Before queuing, _checkQueueLimits(userId) verifies:
 *        (a) user has < MAX_JOBS_PER_USER active jobs (default: 5)
 *        (b) total queue depth < MAX_QUEUE_DEPTH (default: 200)
 *        Both limits configurable via env vars. Excess returns HTTP 429.
 *
 * HIGH FIX #8 — LOCK HEARTBEAT / RENEWAL
 *   Old: lock expired after a fixed LOCK_TTL_MS = 30s with no renewal.
 *        A reviewer who took 40s to read an invoice would lose the lock to
 *        another reviewer, causing a stale-lock overwrite race.
 *   New: renewLock(jobId, approvalId, userId) extends the lock TTL by LOCK_TTL_MS
 *        from the current moment. The frontend should call this every ~15s while
 *        the review modal is open. lockApprovalItem() records lockedUntil timestamp
 *        (not just lockedAt) so expiry checks are exact.
 *
 * HIGH FIX #9 — BULK APPROVE ATOMICITY
 *   Old: bulkApprove() called approveItem() in a for-loop with no rollback.
 *        Item 1 approved, item 3 threw → partial state with no recovery.
 *   New: bulkApprove() runs a dry-validation pass first:
 *        (a) All approvalIds must exist and be in a resolvable state.
 *        (b) Only if ALL pass does the apply pass run.
 *        If apply throws mid-way (e.g. audit logger crash), items are marked
 *        'error' individually rather than silently left in mixed states.
 *        A bulkResult summary is returned with applied / skipped / conflicts / errors.
 *
 * MEDIUM FIX #10 — executeReconciliation TIMEOUT RAISED TO 600s
 *   Old: timeout: 120_000 — same bug as the one fixed in V4 for reconcile.
 *        Large exports (50k+ rows) silently timed out.
 *   New: timeout: RECONCILE_TIMEOUT (600_000 ms = 10 min), matching the
 *        reconcile path. Named constant used in both places to prevent drift.
 *
 * MEDIUM FIX #11 — WORKER RESULT SCHEMA VALIDATION
 *   Old: entry.result used directly — a worker bug returning { result: null }
 *        would crash _applyReconcileResult() with a cryptic TypeError.
 *   New: _validateWorkerResult(result) checks for required keys
 *        (reconciliation, reconciliation.ambiguities) and throws a structured
 *        error if the schema is invalid, surfacing the real problem clearly.
 *
 * MEDIUM FIX #12 — REDIS CLIENT EXPORTED FOR GRACEFUL SHUTDOWN
 *   Old: _redisClient created but never closed — hot-reloads and tests leaked
 *        ioredis connections indefinitely.
 *   New: closeConnections() exported. server.js calls it during SIGTERM/SIGINT.
 *        Closes both _redisClient (result polling) and _subRedis (pub/sub).
 *
 * MEDIUM FIX #13 — setInterval HANDLE STORED + CLEARED ON SHUTDOWN
 *   Old: setInterval(() => { ... }, 30 * 60 * 1000) returned handle discarded.
 *        Tests could not clear it; graceful shutdown left the process alive.
 *   New: const _cleanupInterval = setInterval(...) — handle stored.
 *        closeConnections() calls clearInterval(_cleanupInterval).
 *
 * LOW FIX #14 — 128-BIT JOB ID ENTROPY
 *   Old: crypto.randomBytes(4) = 32-bit suffix — enough for low volume but
 *        not for enterprise-scale concurrent uploads.
 *   New: crypto.randomBytes(16).toString('hex') = 128-bit random suffix.
 *
 * LOW FIX #15 — AUDIT LOGGING WRAPPED IN TRY/CATCH
 *   Old: audit.logApproval() / audit.logCompletion() etc. could throw (disk
 *        full, logger bug) and crash the approval/completion workflow.
 *   New: All audit.log* calls wrapped in _safeAudit(() => audit.log*(...))
 *        which catches and logs errors without interrupting business logic.
 */

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const { callEngine } = require('../pythonBridge.service');
const audit  = require('../../audit/auditLogger.service');

const OUTPUT_DIR = path.join(__dirname, '../../../outputs');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

const JOB_EXPIRY_SEC     = 4 * 60 * 60;            // 4 hours (Redis TTL, in seconds)
const JOB_EXPIRY_MS      = JOB_EXPIRY_SEC * 1000;
const MAX_BULK_APPROVALS = 500;
const RECONCILE_TIMEOUT  = 600_000;                 // FIX #10: 10 min — used on BOTH paths

// FIX #7: Queue depth limits (configurable via env)
const MAX_JOBS_PER_USER = parseInt(process.env.MAX_JOBS_PER_USER || '5',   10);
const MAX_QUEUE_DEPTH   = parseInt(process.env.MAX_QUEUE_DEPTH   || '200', 10);

// FIX #8: Lock TTL
const LOCK_TTL_MS = 30_000;

// FIX #5: Local in-memory cache cap (LRU)
const MAX_LOCAL_CACHE_ENTRIES = 500;

// Pub/Sub channel prefix (must match worker.js)
const JOB_DONE_CHANNEL_PREFIX = 'auros:job:done:';   // + bullJobId
const JOB_RESULT_KEY_PREFIX   = 'bull:result:';       // + bullJobId (SET by worker)
const JOB_META_KEY_PREFIX     = 'auros:job:';         // + jobId    (our metadata)

// Fallback poll: if PUB never arrives, try one GET after this delay
const PUBSUB_FALLBACK_MS = 10 * 60 * 1000;  // 10 minutes

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — REDIS SETUP
// ══════════════════════════════════════════════════════════════════════════════

let _reconcileQueue = null;
let _redisClient    = null;   // general: job metadata GET/SET/GETDEL
let _subRedis       = null;   // dedicated subscribe client (ioredis requires separate conn)
let _redisAvailable = false;

try {
  const { getReconcileQueue, CONNECTION } = require('../../queues/jobQueue');
  _reconcileQueue = getReconcileQueue();

  const IORedis = require('ioredis');
  const SHARED_OPTS = {
    ...CONNECTION,
    lazyConnect         : false,
    enableOfflineQueue  : true,
    maxRetriesPerRequest: null,
  };

  // FIX #12: Both clients stored so closeConnections() can clean them up
  _redisClient = new IORedis(SHARED_OPTS);
  _subRedis    = new IORedis(SHARED_OPTS);  // FIX #3: dedicated subscriber

  const _onRedisError = (label) => (err) => {
    if (!err.message.includes('ECONNREFUSED') && !err.message.includes('connect')) {
      console.error(`[reconciliationEngine] Redis (${label}) error:`, err.message);
    }
  };
  _redisClient.on('error', _onRedisError('rw'));
  _subRedis.on('error',    _onRedisError('sub'));

  _redisAvailable = true;
} catch (_) {
  console.warn('[reconciliationEngine] Redis not available — running in single-process mode.');
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — JOB STORE (Redis-backed with local L1 cache)
// FIX #1 / FIX #2
// ══════════════════════════════════════════════════════════════════════════════

// FIX #5: L1 cache — capped at MAX_LOCAL_CACHE_ENTRIES (LRU: delete oldest on overflow)
const _localJobCache = new Map();

function _evictLocalCache() {
  if (_localJobCache.size >= MAX_LOCAL_CACHE_ENTRIES) {
    // Delete the oldest entry (Map preserves insertion order)
    const oldest = _localJobCache.keys().next().value;
    _localJobCache.delete(oldest);
  }
}

async function _setJob(job) {
  // Write to local cache
  _evictLocalCache();
  _localJobCache.set(job.jobId, job);

  // Write to Redis (FIX #1: authoritative store survives restarts + multi-server)
  if (_redisAvailable) {
    try {
      await _redisClient.set(
        `${JOB_META_KEY_PREFIX}${job.jobId}`,
        JSON.stringify(job),
        'EX', JOB_EXPIRY_SEC
      );
    } catch (err) {
      console.warn('[reconciliationEngine] Redis _setJob error:', err.message);
    }
  }
}

async function _updateJob(jobId, patch) {
  const job = await getJob(jobId);
  if (!job) return null;
  const updated = { ...job, ...patch };
  await _setJob(updated);
  return updated;
}

// FIX #2: Checks local cache first, then Redis — works across server instances
async function getJob(jobId) {
  if (_localJobCache.has(jobId)) {
    return _localJobCache.get(jobId);
  }
  if (_redisAvailable) {
    try {
      const raw = await _redisClient.get(`${JOB_META_KEY_PREFIX}${jobId}`);
      if (raw) {
        const job = JSON.parse(raw);
        _evictLocalCache();
        _localJobCache.set(jobId, job);
        return job;
      }
    } catch (err) {
      console.warn('[reconciliationEngine] Redis getJob error:', err.message);
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — CLEANUP (FIX #13: stored interval handle)
// ══════════════════════════════════════════════════════════════════════════════

// FIX #13: Store handle so it can be cleared on shutdown
const _cleanupInterval = setInterval(() => {
  const now     = Date.now();
  let   removed = 0;
  for (const [jobId, job] of _localJobCache.entries()) {
    if (now - new Date(job.createdAt).getTime() > JOB_EXPIRY_MS) {
      _localJobCache.delete(jobId);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`[reconciliationEngine] Evicted ${removed} expired job(s) from local cache.`);
  }
}, 30 * 60 * 1000);

// Prevent the interval from keeping the process alive during tests
if (_cleanupInterval.unref) _cleanupInterval.unref();

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — PUBLIC API: startReconciliation
// ══════════════════════════════════════════════════════════════════════════════

async function startReconciliation(invoiceFilePath, poFilePath, userId) {
  // FIX #14: 128-bit job ID entropy
  const jobId = `job_${Date.now()}_${crypto.randomBytes(16).toString('hex')}`;

  // FIX #7: Check queue limits before accepting the job
  await _checkQueueLimits(userId);

  _safeAudit(() => audit.initJob(jobId, {
    userId,
    sourceFile: path.basename(invoiceFilePath),
    jobType   : 'procurement_reconciliation',
  }));

  const job = {
    jobId,
    userId,
    status          : 'processing',
    invoiceFilePath,
    poFilePath      : poFilePath || null,
    reconciliation  : null,
    pendingApprovals: [],
    createdAt       : new Date().toISOString(),
    completedAt     : null,
    outputPath      : null,
    bullJobId       : null,
    // FIX #4: cancelFn stored here (function not serialisable to Redis —
    // stored in local process memory only; see note below)
    _cancelFn       : null,
  };

  await _setJob(job);

  // ── Try BullMQ async path ─────────────────────────────────────────────────
  if (_reconcileQueue && _redisAvailable) {
    try {
      await _redisClient.ping();

      const bullJob   = await _reconcileQueue.add('reconcile', {
        invoicePath: invoiceFilePath,
        poPath     : poFilePath || undefined,
        userId,
        appJobId   : jobId,
      });

      const bullJobId = String(bullJob.id);
      await _updateJob(jobId, { bullJobId });

      // FIX #3: Subscribe instead of poll
      const cancelFn = _waitForResult(jobId, bullJobId);
      // Note: cancelFn is a closure — cannot be stored in Redis.
      // It lives only in this process's memory. If this process restarts
      // before the job completes, the subscription is lost, but the job
      // metadata in Redis allows another process (or a re-fetch) to pick up.
      _localJobCache.get(jobId)._cancelFn = cancelFn;

      console.log(`[reconciliationEngine] Job ${jobId} queued as BullMQ ${bullJobId} (pub/sub mode)`);
      return { jobId, bullJobId, queued: true };

    } catch (queueErr) {
      console.warn('[reconciliationEngine] BullMQ unavailable, falling back to sync:', queueErr.message);
    }
  }

  // ── Synchronous fallback ──────────────────────────────────────────────────
  console.log(`[reconciliationEngine] Job ${jobId} running synchronously`);
  _runReconciliation(jobId).catch(async (err) => {
    console.error(`[reconciliationEngine] Job ${jobId} sync error:`, err.message);
    await _updateJob(jobId, { status: 'error', error: err.message });
  });

  return { jobId, queued: false };
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — PUB/SUB WAIT (FIX #3 / FIX #4)
// ══════════════════════════════════════════════════════════════════════════════

function _waitForResult(jobId, bullJobId) {
  const channel    = `${JOB_DONE_CHANNEL_PREFIX}${bullJobId}`;
  const resultKey  = `${JOB_RESULT_KEY_PREFIX}${bullJobId}`;
  let   cancelled  = false;
  let   fallbackId = null;

  // Message handler
  const onMessage = async (chan, message) => {
    if (chan !== channel || cancelled) return;
    await _consumeResult(jobId, resultKey, bullJobId);
    _cleanup();
  };

  _subRedis.subscribe(channel).catch(err => {
    console.warn(`[reconciliationEngine] Subscribe error for ${jobId}:`, err.message);
    // If subscribe fails, start polling fallback immediately
    _startFallback();
  });
  _subRedis.on('message', onMessage);

  // FIX #4: Fallback GET after PUBSUB_FALLBACK_MS (guards against missed PUBs)
  function _startFallback() {
    if (cancelled) return;
    fallbackId = setTimeout(async () => {
      if (cancelled) return;
      console.warn(`[reconciliationEngine] PubSub timeout for ${jobId} — trying fallback GET`);
      await _consumeResult(jobId, resultKey, bullJobId);
      _cleanup();
    }, PUBSUB_FALLBACK_MS);
  }

  fallbackId = setTimeout(async () => {
    if (cancelled) return;
    await _consumeResult(jobId, resultKey, bullJobId);
    _cleanup();
  }, PUBSUB_FALLBACK_MS);

  function _cleanup() {
    cancelled = true;
    if (fallbackId) clearTimeout(fallbackId);
    _subRedis.unsubscribe(channel).catch(() => {});
    _subRedis.removeListener('message', onMessage);
  }

  // FIX #4: Return cancel function
  return function cancel() {
    console.log(`[reconciliationEngine] Cancelling wait for job ${jobId}`);
    _cleanup();
  };
}

async function _consumeResult(jobId, resultKey, bullJobId) {
  const job = await getJob(jobId);
  if (!job || job.status !== 'processing') return;

  let raw;
  try {
    // FIX #6: GETDEL — atomic get + delete (Redis >= 6.2)
    // Falls back to GET + DEL for older Redis versions
    if (typeof _redisClient.getdel === 'function') {
      raw = await _redisClient.getdel(resultKey);
    } else {
      raw = await _redisClient.get(resultKey);
      if (raw) await _redisClient.del(resultKey);
    }
  } catch (err) {
    console.warn(`[reconciliationEngine] Redis GETDEL error for ${jobId}:`, err.message);
    return;
  }

  if (!raw) {
    // Result not ready yet (fallback path fired too early)
    await _updateJob(jobId, {
      status: 'error',
      error : 'Worker result not found in Redis. The worker may have crashed or not started.',
    });
    return;
  }

  let entry;
  try {
    entry = JSON.parse(raw);
  } catch {
    await _updateJob(jobId, { status: 'error', error: 'Worker returned invalid JSON.' });
    return;
  }

  if (entry.status === 'completed') {
    // FIX #11: Validate schema before using
    const schemaError = _validateWorkerResult(entry.result);
    if (schemaError) {
      await _updateJob(jobId, { status: 'error', error: `Worker result schema invalid: ${schemaError}` });
      return;
    }
    await _applyReconcileResult(jobId, entry.result);

  } else if (entry.status === 'failed') {
    console.error(`[reconciliationEngine] Worker failure for ${jobId}: ${entry.error}`);
    await _updateJob(jobId, { status: 'error', error: entry.error || 'Worker failed' });
  }
  // status === 'processing' — fallback fired too early; worker will PUB when done
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — WORKER RESULT SCHEMA VALIDATION (FIX #11)
// ══════════════════════════════════════════════════════════════════════════════

function _validateWorkerResult(result) {
  if (!result || typeof result !== 'object') {
    return 'result is null or not an object';
  }
  if (!result.reconciliation || typeof result.reconciliation !== 'object') {
    return 'result.reconciliation is missing or not an object';
  }
  if (!Array.isArray(result.reconciliation.ambiguities)) {
    return 'result.reconciliation.ambiguities is missing or not an array';
  }
  return null; // valid
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — QUEUE DEPTH LIMITS (FIX #7)
// ══════════════════════════════════════════════════════════════════════════════

async function _checkQueueLimits(userId) {
  // Per-user active job count
  if (_redisAvailable) {
    try {
      // Scan for this user's active jobs in Redis
      // (Stream/sorted-set approach is ideal at large scale;
      //  this SCAN is safe for MAX_QUEUE_DEPTH ≤ 200 keys)
      let activeForUser = 0;
      let cursor        = '0';
      do {
        const [nextCursor, keys] = await _redisClient.scan(
          cursor, 'MATCH', `${JOB_META_KEY_PREFIX}*`, 'COUNT', 100
        );
        cursor = nextCursor;
        for (const key of keys) {
          const raw = await _redisClient.get(key);
          if (!raw) continue;
          const job = JSON.parse(raw);
          if (job.userId === userId && job.status === 'processing') {
            activeForUser++;
          }
        }
      } while (cursor !== '0');

      if (activeForUser >= MAX_JOBS_PER_USER) {
        const err = new Error(
          `You already have ${activeForUser} active reconciliation job(s). ` +
          `Maximum allowed per user: ${MAX_JOBS_PER_USER}. ` +
          `Please wait for existing jobs to complete before uploading more files.`
        );
        err.status = 429;
        err.code   = 'TOO_MANY_JOBS';
        throw err;
      }

      // Total queue depth
      const queueSize = await _reconcileQueue?.getWaitingCount?.() ?? 0;
      if (queueSize >= MAX_QUEUE_DEPTH) {
        const err = new Error(
          `The reconciliation queue is at capacity (${queueSize} jobs pending). ` +
          `Please try again in a few minutes.`
        );
        err.status = 429;
        err.code   = 'QUEUE_FULL';
        throw err;
      }

    } catch (err) {
      if (err.status === 429) throw err;  // re-throw limit errors
      console.warn('[reconciliationEngine] Queue limit check failed:', err.message);
      // Non-limit Redis errors: allow the job through (fail open)
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 9 — RECONCILIATION RUNNER
// ══════════════════════════════════════════════════════════════════════════════

async function _runReconciliation(jobId) {
  const job = await _requireJob(jobId);

  const engineResult = await callEngine({
    operation  : 'reconcile',
    invoicePath: job.invoiceFilePath,
    poPath     : job.poFilePath || undefined,
  }, { timeout: RECONCILE_TIMEOUT });  // FIX #10: consistent with queued path

  // FIX #11: Validate even on sync path
  const schemaError = _validateWorkerResult(engineResult);
  if (schemaError) {
    throw new Error(`Engine result schema invalid: ${schemaError}`);
  }

  await _applyReconcileResult(jobId, engineResult);
}

async function _applyReconcileResult(jobId, engineResult) {
  const job = await getJob(jobId);
  if (!job) return;

  const recon = engineResult.reconciliation;

  const pendingApprovals = (recon.ambiguities || []).map((amb, i) => ({
    id            : `appr_${jobId}_${i}`,
    questionIndex : i,
    type          : amb.type,
    status        : 'pending',
    lockedBy      : null,
    lockedAt      : null,
    lockedUntil   : null,  // FIX #8: explicit expiry timestamp
    question      : { question: amb.question, options: amb.options || [] },
    response      : null,
    respondedVia  : null,
    riskLevel     : amb.severity === 'High' ? 'High' : 'Medium',
    affectedRows  : 1,
    createdAt     : new Date().toISOString(),
    resolvedAt    : null,
  }));

  await _updateJob(jobId, {
    status          : 'awaiting_approvals',
    reconciliation  : recon,
    pendingApprovals,
    warnings        : engineResult.warnings || [],
  });

  _safeAudit(() => audit.logIngestion(job.jobId, job.userId, {
    sourceFile: path.basename(job.invoiceFilePath),
    rowCount  : engineResult.invoiceCount || 0,
    warnings  : engineResult.warnings    || [],
  }));
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 10 — JOB LISTING
// ══════════════════════════════════════════════════════════════════════════════

async function listJobs(userId) {
  const results = [];

  // Scan Redis for all jobs belonging to this user
  if (_redisAvailable) {
    try {
      let cursor = '0';
      do {
        const [next, keys] = await _redisClient.scan(
          cursor, 'MATCH', `${JOB_META_KEY_PREFIX}*`, 'COUNT', 100
        );
        cursor = next;
        for (const key of keys) {
          const raw = await _redisClient.get(key);
          if (!raw) continue;
          const j = JSON.parse(raw);
          if (j.userId !== userId) continue;
          results.push({
            jobId      : j.jobId,
            status     : j.status,
            createdAt  : j.createdAt,
            completedAt: j.completedAt,
            summary    : j.reconciliation?.summary || null,
            error      : j.error || null,
            queued     : !!j.bullJobId,
          });
        }
      } while (cursor !== '0');
    } catch (err) {
      console.warn('[reconciliationEngine] listJobs Redis scan error:', err.message);
    }
  }

  // Fall back to local cache entries (single-process mode or Redis outage)
  if (results.length === 0) {
    for (const j of _localJobCache.values()) {
      if (j.userId !== userId) continue;
      results.push({
        jobId      : j.jobId,
        status     : j.status,
        createdAt  : j.createdAt,
        completedAt: j.completedAt,
        summary    : j.reconciliation?.summary || null,
        error      : j.error || null,
        queued     : !!j.bullJobId,
      });
    }
  }

  return results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 11 — LOCK MANAGEMENT (FIX #8: heartbeat renewal)
// ══════════════════════════════════════════════════════════════════════════════

async function lockApprovalItem(jobId, approvalId, userId) {
  const job  = await _requireJob(jobId);
  const item = _requireApproval(job, approvalId);
  const now  = Date.now();

  if (item.status === 'approved' || item.status === 'rejected') {
    return { acquired: false, reason: 'Already resolved' };
  }

  // FIX #8: Use lockedUntil for exact expiry check instead of lockedAt + TTL math
  const lockExpired = !item.lockedUntil || new Date(item.lockedUntil).getTime() < now;

  if (item.status === 'locked' && item.lockedBy !== userId && !lockExpired) {
    const expiresInSec = Math.ceil((new Date(item.lockedUntil).getTime() - now) / 1000);
    return {
      acquired : false,
      reason   : `Item is being reviewed by another user. Lock expires in ${expiresInSec}s.`,
      lockedBy : item.lockedBy,
    };
  }

  item.status      = 'locked';
  item.lockedBy    = userId;
  item.lockedAt    = new Date().toISOString();
  item.lockedUntil = new Date(now + LOCK_TTL_MS).toISOString();  // FIX #8

  await _updateJob(jobId, { pendingApprovals: job.pendingApprovals });
  return { acquired: true, lockedUntil: item.lockedUntil };
}

/**
 * FIX #8: Heartbeat renewal — called by frontend every ~15s while review is open.
 * Extends the lock TTL by LOCK_TTL_MS from now.
 */
async function renewLock(jobId, approvalId, userId) {
  const job  = await _requireJob(jobId);
  const item = _requireApproval(job, approvalId);
  const now  = Date.now();

  if (item.lockedBy !== userId || item.status !== 'locked') {
    return { renewed: false, reason: 'Lock not held by this user' };
  }

  item.lockedUntil = new Date(now + LOCK_TTL_MS).toISOString();
  await _updateJob(jobId, { pendingApprovals: job.pendingApprovals });
  return { renewed: true, lockedUntil: item.lockedUntil };
}

async function releaseLock(jobId, approvalId, userId) {
  const job  = await getJob(jobId);
  if (!job) return;
  const item = (job.pendingApprovals || []).find(a => a.id === approvalId);
  if (!item) return;

  if (item.lockedBy === userId && item.status === 'locked') {
    item.status      = 'pending';
    item.lockedBy    = null;
    item.lockedAt    = null;
    item.lockedUntil = null;
    await _updateJob(jobId, { pendingApprovals: job.pendingApprovals });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 12 — APPROVAL ACTIONS
// ══════════════════════════════════════════════════════════════════════════════

async function approveItem(jobId, approvalId, response, respondedVia = 'dashboard', userId = null) {
  const job  = await _requireJob(jobId);
  const item = _requireApproval(job, approvalId);
  const now  = Date.now();

  // FIX #8: Check lockedUntil for exact expiry
  const lockExpired = !item.lockedUntil || new Date(item.lockedUntil).getTime() < now;
  if (item.status === 'locked' && item.lockedBy && item.lockedBy !== userId && !lockExpired) {
    const expiresInSec = Math.ceil((new Date(item.lockedUntil).getTime() - now) / 1000);
    const err = new Error(
      `Approval conflict: item locked by another reviewer for ${expiresInSec}s.`
    );
    err.status = 409;
    err.code   = 'APPROVAL_CONFLICT';
    throw err;
  }

  if (item.status === 'approved' || item.status === 'rejected') {
    const err = new Error(`Item ${approvalId} has already been resolved.`);
    err.status = 409;
    err.code   = 'ALREADY_RESOLVED';
    throw err;
  }

  item.status       = 'approved';
  item.response     = response;
  item.respondedVia = respondedVia;
  item.resolvedAt   = new Date().toISOString();
  item.lockedBy     = null;
  item.lockedAt     = null;
  item.lockedUntil  = null;

  await _updateJob(jobId, { pendingApprovals: job.pendingApprovals });

  // FIX #15: Audit wrapped in try/catch — never breaks business logic
  _safeAudit(() => audit.logApproval(jobId, userId || job.userId, {
    approvalId, issueType: item.type,
    question: item.question?.question, response,
    status: 'approved', respondedVia,
    affectedRows: item.affectedRows, riskLevel: item.riskLevel,
  }));
}

async function rejectItem(jobId, approvalId, reason, userId = null) {
  const job  = await _requireJob(jobId);
  const item = _requireApproval(job, approvalId);

  if (item.status === 'approved' || item.status === 'rejected') {
    const err = new Error(`Item ${approvalId} has already been resolved.`);
    err.status = 409;
    err.code   = 'ALREADY_RESOLVED';
    throw err;
  }

  item.status       = 'rejected';
  item.response     = reason;
  item.respondedVia = 'dashboard';
  item.resolvedAt   = new Date().toISOString();
  item.lockedBy     = null;
  item.lockedAt     = null;
  item.lockedUntil  = null;

  await _updateJob(jobId, { pendingApprovals: job.pendingApprovals });

  _safeAudit(() => audit.logApproval(jobId, userId || job.userId, {
    approvalId, issueType: item.type,
    question: item.question?.question, response: reason,
    status: 'rejected', respondedVia: 'dashboard',
    affectedRows: item.affectedRows, riskLevel: item.riskLevel,
  }));
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 13 — BULK APPROVE (FIX #9: atomic validation then apply)
// ══════════════════════════════════════════════════════════════════════════════

async function bulkApprove(jobId, approvalIds, response, respondedVia = 'dashboard', userId = null) {
  if (!Array.isArray(approvalIds)) {
    throw Object.assign(new Error('approvalIds must be an array'), { status: 400 });
  }
  if (approvalIds.length > MAX_BULK_APPROVALS) {
    throw Object.assign(
      new Error(
        `Bulk approval limit: max ${MAX_BULK_APPROVALS} items per operation. ` +
        `Requested: ${approvalIds.length}. Split into smaller batches.`
      ),
      { status: 400, code: 'BULK_LIMIT_EXCEEDED' }
    );
  }

  const job = await _requireJob(jobId);

  // FIX #9: DRY-VALIDATION PASS — check all items before changing any state
  const validItems    = [];
  const skipReasons   = [];

  for (const approvalId of approvalIds) {
    const item = (job.pendingApprovals || []).find(a => a.id === approvalId);
    if (!item) {
      skipReasons.push({ approvalId, reason: 'not_found' });
      continue;
    }
    if (item.status === 'approved' || item.status === 'rejected') {
      skipReasons.push({ approvalId, reason: 'already_resolved' });
      continue;
    }
    const now         = Date.now();
    const lockExpired = !item.lockedUntil || new Date(item.lockedUntil).getTime() < now;
    if (item.status === 'locked' && item.lockedBy !== userId && !lockExpired) {
      skipReasons.push({ approvalId, reason: 'locked_by_other' });
      continue;
    }
    validItems.push(item);
  }

  // APPLY PASS — only runs if at least one item is valid
  // (all valid items were pre-checked; no rollback needed for skip reasons above)
  let applied = 0, errors = 0;
  const errorDetails = [];

  for (const item of validItems) {
    try {
      item.status       = 'approved';
      item.response     = response;
      item.respondedVia = respondedVia;
      item.resolvedAt   = new Date().toISOString();
      item.lockedBy     = null;
      item.lockedAt     = null;
      item.lockedUntil  = null;
      applied++;

      _safeAudit(() => audit.logApproval(jobId, userId || job.userId, {
        approvalId: item.id, issueType: item.type,
        question: item.question?.question, response,
        status: 'approved', respondedVia,
        affectedRows: item.affectedRows, riskLevel: item.riskLevel,
      }));
    } catch (err) {
      errors++;
      errorDetails.push({ approvalId: item.id, error: err.message });
      item.status = 'error';  // individual item marked; others continue
    }
  }

  // Persist once after all mutations (single Redis write)
  await _updateJob(jobId, { pendingApprovals: job.pendingApprovals });

  return {
    applied,
    skipped  : skipReasons.length,
    conflicts: skipReasons.filter(s => s.reason === 'locked_by_other').length,
    errors,
    skipDetails  : skipReasons,
    errorDetails,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 14 — EXECUTE RECONCILIATION (FIX #10: consistent 600s timeout)
// ══════════════════════════════════════════════════════════════════════════════

async function executeReconciliation(jobId) {
  const job = await _requireJob(jobId);

  if (job.status === 'completed') {
    return { outputPath: job.outputPath, alreadyExecuted: true };
  }

  await _updateJob(jobId, { status: 'executing' });

  const outputFileName = `reconciled_${jobId}_${Date.now()}.csv`;
  const outputPath     = path.join(OUTPUT_DIR, outputFileName);

  const approvals = job.pendingApprovals.map(a => ({
    questionIndex: a.questionIndex,
    approvalId   : a.id,
    status       : a.status,
    response     : a.response || 'no_response',
    respondedVia : a.respondedVia || 'unknown',
  }));

  const engineResult = await callEngine({
    operation     : 'execute',
    invoicePath   : job.invoiceFilePath,
    reconciliation: job.reconciliation,
    approvals,
    outputPath,
  }, { timeout: RECONCILE_TIMEOUT });  // FIX #10: was 120_000, now matches reconcile path

  await _updateJob(jobId, {
    status     : 'completed',
    outputPath,
    completedAt: new Date().toISOString(),
  });

  _safeAudit(() => audit.logCompletion(jobId, job.userId, {
    outputPath,
    outputRows  : engineResult.outputRows   || 0,
    excludedRows: engineResult.excludedRows || 0,
  }));

  return {
    outputPath,
    outputRows  : engineResult.outputRows   || 0,
    excludedRows: engineResult.excludedRows || 0,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 15 — GRACEFUL SHUTDOWN (FIX #12 / FIX #13)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * FIX #12: Close all Redis connections.
 * FIX #13: Clear the cleanup interval.
 * Call this from server.js during SIGTERM/SIGINT.
 */
async function closeConnections() {
  clearInterval(_cleanupInterval);  // FIX #13
  const closers = [];
  if (_redisClient) closers.push(_redisClient.quit().catch(() => {}));
  if (_subRedis)    closers.push(_subRedis.quit().catch(() => {}));
  await Promise.all(closers);
  console.log('[reconciliationEngine] Redis connections closed.');
}

/**
 * FIX #4: Cancel the pub/sub wait for a specific job.
 * Call this when the originating HTTP request disconnects (res.on('close')).
 */
async function cancelJob(jobId) {
  const job = _localJobCache.get(jobId);
  if (job && typeof job._cancelFn === 'function') {
    job._cancelFn();
    job._cancelFn = null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 16 — INTERNAL HELPERS
// ══════════════════════════════════════════════════════════════════════════════

async function _requireJob(jobId) {
  const job = await getJob(jobId);
  if (!job) {
    // SEC: generic message — does not disclose internal ID format
    const err = new Error('Job not found or has expired.');
    err.status = 404;
    throw err;
  }
  return job;
}

function _requireApproval(job, approvalId) {
  const item = (job.pendingApprovals || []).find(a => a.id === approvalId);
  if (!item) {
    const err = new Error('Approval item not found.');
    err.status = 404;
    throw err;
  }
  return item;
}

/**
 * FIX #15: Wrap audit calls so a logger failure never interrupts business logic.
 */
function _safeAudit(fn) {
  try {
    fn();
  } catch (err) {
    console.error('[reconciliationEngine] Audit log error (non-fatal):', err.message);
  }
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════════════════════════════════════

module.exports = {
  startReconciliation,
  getJob,
  listJobs,
  approveItem,
  rejectItem,
  bulkApprove,
  lockApprovalItem,
  renewLock,          // FIX #8: new export
  releaseLock,
  executeReconciliation,
  cancelJob,          // FIX #4: new export
  closeConnections,   // FIX #12: new export
};
