'use strict';
/**
 * backend/services/procurement/reconciliationEngine.service.js
 *
 * CHANGES FROM V5 (this version — V6):
 *
 * FIX — PUBSUB_FALLBACK_MS reduced from 10 minutes to 30 seconds.
 *
 *   Root cause of the "CSV hangs in Parse & Validate forever" bug:
 *
 *   When a job fails fast — e.g. because pythonBridge._validateConfig() throws
 *   a VALIDATION_ERROR (absolute Windows path rejected) — the worker writes
 *   the failure to Redis under key `bull:result:<bullJobId>` and then exits.
 *
 *   However, _waitForResult() is waiting for a Redis pub/sub message on channel
 *   `auros:job:done:<bullJobId>`. The worker does NOT publish to that channel —
 *   only the result key is written. So _waitForResult() never receives the pub
 *   message, and must fall back to a plain Redis GET after PUBSUB_FALLBACK_MS.
 *
 *   With PUBSUB_FALLBACK_MS = 10 * 60 * 1000 (10 minutes), the frontend spins
 *   for the full 10 minutes before the failure is surfaced. In practice the user
 *   waits 15-20 minutes (worker timeout + fallback) seeing only a loading spinner.
 *
 *   Fix: PUBSUB_FALLBACK_MS = 30 * 1000 (30 seconds).
 *   - Fast failures (path errors, Python crash on startup) are shown within ~30s.
 *   - Slow successful jobs still work: the worker PUBlishes when done, which
 *     arrives via pub/sub immediately — the fallback timer is cancelled.
 *   - The 30s fallback only fires when the pub message is missed or never sent.
 *
 *   All other V5 logic is preserved exactly (Redis-backed job store, pub/sub
 *   subscription, GETDEL, lock heartbeat, bulk approve atomicity, etc.).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * V7 PATCH (applied by Claude — see chat for full explanation):
 *
 *   FIX V7-A — _waitForResult()/_consumeResult() double-consume bug.
 *     The fallback timer's own inline GETDEL and the subsequent call to
 *     _consumeResult() (which does ANOTHER GETDEL on the same key) raced
 *     against each other: whichever ran second always found the key already
 *     deleted, so it silently treated a real "processing" marker exactly the
 *     same as a genuinely missing result. Worse, _cleanup() ran unconditionally
 *     after that second call, permanently cancelling the watcher — so if the
 *     fallback fired while the worker had only written its initial
 *     `{status:'processing'}` marker (which happens on almost every job,
 *     since the worker writes that marker within milliseconds of starting),
 *     the job would be abandoned mid-flight and never updated again, even
 *     though the worker was still correctly running and would later write the
 *     real "completed" result.
 *     Fix: the Redis read now happens exactly once per fallback tick (via the
 *     new _readResultKey() helper), and the parsed entry is handed to the new
 *     _processResultEntry(), which returns whether the outcome was terminal
 *     (completed/failed → true) or not (an interim "processing" marker →
 *     false). Cleanup only happens on a terminal outcome; a non-terminal
 *     outcome re-arms the fallback timer instead of abandoning the job.
 * ────────────────────────────────────────────────────────────────────────────
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
const RECONCILE_TIMEOUT  = 600_000;                 // 10 min — used on BOTH paths

// Queue depth limits (configurable via env)
const MAX_JOBS_PER_USER = parseInt(process.env.MAX_JOBS_PER_USER || '5',   10);
const MAX_QUEUE_DEPTH   = parseInt(process.env.MAX_QUEUE_DEPTH   || '200', 10);

// Lock TTL
const LOCK_TTL_MS = 30_000;

// Local in-memory cache cap (LRU)
const MAX_LOCAL_CACHE_ENTRIES = 500;

// Pub/Sub channel prefix (must match worker.js)
const JOB_DONE_CHANNEL_PREFIX = 'auros:job:done:';   // + bullJobId
const JOB_RESULT_KEY_PREFIX   = 'bull:result:';       // + bullJobId (SET by worker)
const JOB_META_KEY_PREFIX     = 'auros:job:';         // + jobId    (our metadata)

// KEY FIX: Fallback poll timeout reduced from 10 minutes to 30 seconds.
//
// Why 30 seconds?
//   - A fast failure (VALIDATION_ERROR, Python crash) is written to Redis
//     within 1-2 seconds of the job starting. The pub/sub message is never
//     sent by the worker in these cases, so the fallback GET is what surfaces
//     the error. 30 seconds is long enough to avoid spurious fallbacks on
//     heavily loaded systems, but short enough that users see failures quickly.
//   - Successful jobs publish via pub/sub (channel auros:job:done:<id>) which
//     arrives immediately and cancels the fallback timer — so 30s has zero
//     impact on the happy path.
//   - Very fast jobs (small CSV, < 5s) are also caught by pub/sub, not fallback.
//   - If you find 30s is too aggressive for your environment, set env var
//     PUBSUB_FALLBACK_MS to a higher value (e.g. 60000 for 60 seconds).
const PUBSUB_FALLBACK_MS = parseInt(
  process.env.PUBSUB_FALLBACK_MS || String(30 * 1000),  // default: 30 seconds
  10
);

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — REDIS SETUP
// ══════════════════════════════════════════════════════════════════════════════

let _reconcileQueue        = null;
let _redisClient           = null;   // general: job metadata GET/SET/GETDEL
let _subRedis              = null;   // dedicated subscribe client (ioredis requires separate conn)
let _redisAvailable        = false;
// GETDEL was added in Redis 6.2. On Redis 5.x (e.g. 5.0.14 on Windows) calling
// it returns "ERR unknown command 'GETDEL'" even though ioredis exposes the method.
// We detect the version at startup and fall back to GET+DEL on older Redis.
let _redisSupportsGetdel   = false;

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

  _redisClient = new IORedis(SHARED_OPTS);
  _subRedis    = new IORedis(SHARED_OPTS);  // dedicated subscriber

  const _onRedisError = (label) => (err) => {
    if (!err.message.includes('ECONNREFUSED') && !err.message.includes('connect')) {
      console.error(`[reconciliationEngine] Redis (${label}) error:`, err.message);
    }
  };
  _redisClient.on('error', _onRedisError('rw'));
  _subRedis.on('error',    _onRedisError('sub'));

  _redisAvailable = true;

  // Detect Redis version asynchronously — sets _redisSupportsGetdel once connected.
  // GETDEL requires Redis >= 6.2.0. Your current Redis is 5.0.14 on Windows,
  // so this will log a warning and leave the flag false, using GET+DEL instead.
  _redisClient.once('ready', async () => {
    try {
      const info    = await _redisClient.info('server');
      const match   = info.match(/redis_version:([\d.]+)/);
      if (match) {
        const parts   = match[1].split('.').map(Number);
        const major   = parts[0] || 0;
        const minor   = parts[1] || 0;
        _redisSupportsGetdel = (major > 6) || (major === 6 && minor >= 2);
        console.log(
          `[reconciliationEngine] Redis version: ${match[1]} — ` +
          `GETDEL ${_redisSupportsGetdel ? 'supported' : 'not supported (using GET+DEL fallback)'}`
        );
      }
    } catch (err) {
      console.warn('[reconciliationEngine] Could not detect Redis version:', err.message);
    }

    // FIX #10 (NEW) — RECOVER ORPHANED "processing" JOBS ON EVERY RESTART
    //
    //   Root cause of "You already have 5 active reconciliation job(s)" even
    //   when nothing is actually running:
    //
    //   _waitForResult() (below) is a purely IN-MEMORY watcher — a Redis
    //   pub/sub subscription plus a setTimeout fallback, both living only in
    //   this Node process's memory. It is only ever created inside
    //   startReconciliation(), at the moment a job is submitted.
    //
    //   Every time this server process restarts (which happens constantly
    //   during development — e.g. after every code change), ANY job that was
    //   still in the 'processing' state at that instant permanently loses its
    //   watcher. Nothing in the new process re-attaches one. The job's Redis
    //   metadata (auros:job:<jobId>) is untouched and keeps its 4-hour TTL
    //   (JOB_EXPIRY_SEC), so it just sits there reporting status: 'processing'
    //   for up to 4 hours — even though the actual work finished, failed, or
    //   was abandoned long ago.
    //
    //   _checkQueueLimits() counts exactly these entries. Restart the server
    //   5 times while a job happens to be mid-flight each time, and every
    //   future upload gets rejected with "You already have 5 active
    //   reconciliation job(s)" — even on a completely idle system.
    //
    //   Fix: on every startup, once Redis is confirmed ready, scan all
    //   auros:job:* metadata entries. For each one still marked 'processing':
    //     - If it's older than RECONCILE_TIMEOUT (10 min) — it's definitely
    //       orphaned (nothing legitimate runs that long) — mark it 'error' so
    //       it stops counting against MAX_JOBS_PER_USER.
    //     - Otherwise, re-attach a live _waitForResult() watcher for it, in
    //       case the worker is still genuinely processing it and will publish
    //       a real result shortly (handles the common case of restarting the
    //       server seconds after submitting a job).
    await _recoverOrphanedJobs();
  });

} catch (_) {
  console.warn('[reconciliationEngine] Redis not available — running in single-process mode.');
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — JOB STORE (Redis-backed with local L1 cache)
// ══════════════════════════════════════════════════════════════════════════════

const _localJobCache = new Map();

function _evictLocalCache() {
  if (_localJobCache.size >= MAX_LOCAL_CACHE_ENTRIES) {
    const oldest = _localJobCache.keys().next().value;
    _localJobCache.delete(oldest);
  }
}

async function _setJob(job) {
  _evictLocalCache();
  _localJobCache.set(job.jobId, job);

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

// FIX #10 (NEW) — see full explanation where this is called, above.
// Scans every auros:job:* metadata entry once at startup and reconciles any
// still marked 'processing': either re-attaches a live watcher (job is
// young enough that the worker might still legitimately be running) or
// marks it 'error' as orphaned (job is older than RECONCILE_TIMEOUT, so
// nothing legitimate is still working on it).
async function _recoverOrphanedJobs() {
  if (!_redisAvailable) return;

  let cursor    = '0';
  let recovered = 0;
  let reattached = 0;

  try {
    do {
      const [nextCursor, keys] = await _redisClient.scan(
        cursor, 'MATCH', `${JOB_META_KEY_PREFIX}*`, 'COUNT', 100
      );
      cursor = nextCursor;

      for (const key of keys) {
        // Skip pub/sub-style keys that happen to share the prefix
        // (JOB_META_KEY_PREFIX is 'auros:job:', JOB_DONE_CHANNEL_PREFIX is
        // 'auros:job:done:' — a done-channel key would parse as garbage JSON
        // below and be safely skipped by the try/catch, but filter explicitly
        // for clarity).
        if (key.startsWith(JOB_DONE_CHANNEL_PREFIX)) continue;

        let job;
        try {
          const raw = await _redisClient.get(key);
          if (!raw) continue;
          job = JSON.parse(raw);
        } catch (_) {
          continue; // not valid job JSON — ignore
        }

        if (!job || job.status !== 'processing') continue;

        const jobAge = Date.now() - new Date(job.createdAt).getTime();

        if (jobAge > RECONCILE_TIMEOUT) {
          // Orphaned by a previous process — nothing is coming for this job.
          await _updateJob(job.jobId, {
            status: 'error',
            error : 'Job was still processing when the server restarted and ' +
                    'was never resolved by the previous process. Marked as ' +
                    'stale on startup recovery.',
          });
          recovered++;
        } else if (job.bullJobId) {
          // Young enough that the worker might genuinely still be running it —
          // re-attach a live watcher so it can resolve normally instead of
          // sitting untouched until its 4-hour Redis TTL expires.
          const cancelFn = _waitForResult(job.jobId, job.bullJobId);
          const cached = _localJobCache.get(job.jobId);
          if (cached) cached._cancelFn = cancelFn;
          reattached++;
        } else {
          // No bullJobId recorded yet (crashed before the queue.add() callback
          // completed) — there's nothing to re-attach to. Treat as orphaned.
          await _updateJob(job.jobId, {
            status: 'error',
            error : 'Job never received a worker assignment before the ' +
                    'server restarted. Please re-submit.',
          });
          recovered++;
        }
      }
    } while (cursor !== '0');

    if (recovered > 0 || reattached > 0) {
      console.log(
        `[reconciliationEngine] Startup recovery: marked ${recovered} orphaned ` +
        `job(s) as error, re-attached watchers for ${reattached} still-young job(s).`
      );
    }
  } catch (err) {
    console.warn('[reconciliationEngine] Orphaned-job recovery failed:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — CLEANUP
// ══════════════════════════════════════════════════════════════════════════════

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

if (_cleanupInterval.unref) _cleanupInterval.unref();

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — PUBLIC API: startReconciliation
// ══════════════════════════════════════════════════════════════════════════════

async function startReconciliation(invoiceFilePath, poFilePath, userId, opts = {}) {
  const { grnPath = null, contractPath = null } = opts;
  const jobId = `job_${Date.now()}_${crypto.randomBytes(16).toString('hex')}`;

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
    grnFilePath     : grnPath || null,
    contractFilePath: contractPath || null,
    reconciliation  : null,
    pendingApprovals: [],
    createdAt       : new Date().toISOString(),
    completedAt     : null,
    outputPath      : null,
    bullJobId       : null,
    _cancelFn       : null,
  };

  await _setJob(job);

  // ── Try BullMQ async path ─────────────────────────────────────────────────
  if (_reconcileQueue && _redisAvailable) {
    try {
      await _redisClient.ping();

      const bullJob   = await _reconcileQueue.add('reconcile', {
        invoicePath : invoiceFilePath,
        poPath      : poFilePath || undefined,
        grnPath     : grnPath || undefined,
        contractPath: contractPath || undefined,
        userId,
        appJobId    : jobId,
      });

      const bullJobId = String(bullJob.id);
      await _updateJob(jobId, { bullJobId });

      const cancelFn = _waitForResult(jobId, bullJobId);
      _localJobCache.get(jobId)._cancelFn = cancelFn;

      console.log(`[reconciliationEngine] Job ${jobId} queued as BullMQ ${bullJobId} (pub/sub mode, fallback: ${PUBSUB_FALLBACK_MS}ms)`);
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
// SECTION 6 — PUB/SUB WAIT
// ══════════════════════════════════════════════════════════════════════════════

function _waitForResult(jobId, bullJobId) {
  const channel    = `${JOB_DONE_CHANNEL_PREFIX}${bullJobId}`;
  const resultKey  = `${JOB_RESULT_KEY_PREFIX}${bullJobId}`;
  let   cancelled  = false;
  let   fallbackId = null;

  // V7 FIX: onMessage now does exactly ONE read of the result key (via
  // _readResultKey) and hands the raw value to _processResultEntry(), which
  // reports whether the outcome was terminal. Previously this called
  // _consumeResult() (its own separate GETDEL) and then _cleanup()
  // unconditionally — so if the pub/sub message happened to reference a key
  // that had already been drained by a concurrent fallback tick, the watcher
  // was torn down having done nothing, even though the job might still be
  // running. Now a non-terminal read just leaves the existing fallback timer
  // in place instead of tearing anything down.
  const onMessage = async (chan, message) => {
    if (chan !== channel || cancelled) return;
    const raw = await _readResultKey(resultKey);
    if (!raw) {
      // Message arrived but the key was empty/already drained — rely on the
      // fallback timer (still armed) to pick up the eventual result.
      console.log(`[reconciliationEngine] Pub/sub notified for ${jobId} but result key was empty — fallback timer will keep checking`);
      return;
    }
    const terminal = await _processResultEntry(jobId, raw);
    if (terminal) _cleanup();
    // else: interim "processing" marker — keep the fallback timer running.
  };

  _subRedis.subscribe(channel).catch(err => {
    console.warn(`[reconciliationEngine] Subscribe error for ${jobId}:`, err.message);
    _startFallback();
  });
  _subRedis.on('message', onMessage);

  // _scheduleNextFallback — (re)arms the fallback timer.
  // Called once at startup and again whenever the result key is empty OR
  // holds only an interim "processing" marker (worker still running). This
  // keeps checking every PUBSUB_FALLBACK_MS until either:
  //   (a) the pub/sub message arrives (fast path — timer cancelled), or
  //   (b) the result key holds a terminal completed/failed entry (slow path —
  //       picked up on a retry and applied), or
  //   (c) the job age exceeds RECONCILE_TIMEOUT (marked as error).
  function _scheduleNextFallback() {
    if (cancelled) return;
    fallbackId = setTimeout(async () => {
      if (cancelled) return;
      console.warn(`[reconciliationEngine] PubSub fallback fired for ${jobId} after ${PUBSUB_FALLBACK_MS}ms — checking Redis`);

      // V7 FIX: single read via the shared helper — no second, redundant
      // GETDEL later. Whatever we get here IS the value to act on.
      const raw = await _readResultKey(resultKey);

      if (!raw) {
        // Result not ready yet — check job age
        const job = await getJob(jobId);
        const jobAge = job ? Date.now() - new Date(job.createdAt).getTime() : RECONCILE_TIMEOUT + 1;
        if (jobAge > RECONCILE_TIMEOUT) {
          console.error(`[reconciliationEngine] Job ${jobId} timed out after ${Math.round(jobAge/1000)}s with no result`);
          await _updateJob(jobId, {
            status: 'error',
            error : 'Worker result not found in Redis after timeout. The worker may have crashed.',
          });
          _cleanup();
        } else {
          // Re-arm — worker is still running
          console.log(`[reconciliationEngine] Job ${jobId} still processing (age: ${Math.round(jobAge/1000)}s) — will retry in ${PUBSUB_FALLBACK_MS}ms`);
          _scheduleNextFallback();
        }
        return;
      }

      // V7 FIX: process the value we already have in hand. If it's only the
      // worker's interim {status:'processing'} marker (written within
      // milliseconds of the job starting — see worker.js), this is NOT
      // terminal, so we re-arm instead of abandoning the job. Previously this
      // situation was indistinguishable from "no result at all" AND the
      // watcher was torn down regardless, which is the root cause of jobs
      // getting stuck forever in "processing" while the worker was still
      // correctly running.
      const terminal = await _processResultEntry(jobId, raw);
      if (terminal) {
        _cleanup();
      } else {
        console.log(`[reconciliationEngine] Job ${jobId} result key held an interim marker (worker still running) — will retry in ${PUBSUB_FALLBACK_MS}ms`);
        _scheduleNextFallback();
      }
    }, PUBSUB_FALLBACK_MS);
  }

  function _startFallback() {
    if (cancelled) return;
    _scheduleNextFallback();
  }

  // Primary fallback timer — fires if pub/sub message never arrives
  _scheduleNextFallback();

  function _cleanup() {
    cancelled = true;
    if (fallbackId) clearTimeout(fallbackId);
    _subRedis.unsubscribe(channel).catch(() => {});
    _subRedis.removeListener('message', onMessage);
  }

  return function cancel() {
    console.log(`[reconciliationEngine] Cancelling wait for job ${jobId}`);
    _cleanup();
  };
}

// V7 FIX (NEW): performs exactly one destructive read of a result key and
// returns the raw string (or null/undefined if absent). Extracted out of the
// old _consumeResult() so callers never issue two GETDELs against the same
// key for a single observed value.
async function _readResultKey(resultKey) {
  try {
    // Use GETDEL only if Redis >= 6.2 (detected at startup).
    // On Redis 5.x (e.g. 5.0.14 on Windows), GETDEL returns
    // 'ERR unknown command' even though ioredis exposes the method.
    // _redisSupportsGetdel is set by version detection on the 'ready' event.
    if (_redisSupportsGetdel) {
      return await _redisClient.getdel(resultKey);
    }
    const v = await _redisClient.get(resultKey);
    if (v) await _redisClient.del(resultKey);
    return v;
  } catch (err) {
    console.warn(`[reconciliationEngine] Redis read error on ${resultKey}:`, err.message);
    // Last-resort plain GET
    try {
      const v = await _redisClient.get(resultKey);
      if (v) await _redisClient.del(resultKey).catch(() => {});
      return v;
    } catch (err2) {
      console.warn(`[reconciliationEngine] Redis GET fallback also failed for ${resultKey}:`, err2.message);
      return null;
    }
  }
}

// V7 FIX (renamed/refactored from _consumeResult): takes an ALREADY-FETCHED
// raw Redis value (never re-reads Redis itself) and applies it to the job.
// Returns true if the outcome was terminal (completed/failed — the caller
// should stop watching) or false if it was only the worker's interim
// "processing" marker (the caller should keep watching / re-arm).
async function _processResultEntry(jobId, raw) {
  const job = await getJob(jobId);
  if (!job || job.status !== 'processing') return true; // already resolved elsewhere — stop watching

  let entry;
  try {
    entry = JSON.parse(raw);
  } catch {
    await _updateJob(jobId, { status: 'error', error: 'Worker returned invalid JSON.' });
    return true;
  }

  if (entry.status === 'completed') {
    // FIX: Worker stores large results (>100KB) on disk and puts only the
    // file path in Redis as entry.resultFile. Small results are inline as
    // entry.result. We must handle BOTH cases.
    let workerResult = entry.result;

    if (!workerResult && entry.resultFile) {
      // Large result — read from disk
      try {
        const fileContent = fs.readFileSync(entry.resultFile, 'utf8');
        workerResult = JSON.parse(fileContent);
        console.log(`[reconciliationEngine] Loaded large result from disk for ${jobId}: ${entry.resultFile}`);
        // Clean up the result file after reading
        try { fs.unlinkSync(entry.resultFile); } catch (_) {}
      } catch (diskErr) {
        console.error(`[reconciliationEngine] Failed to read result file for ${jobId}:`, diskErr.message);
        await _updateJob(jobId, {
          status: 'error',
          error : `Could not read worker result file: ${diskErr.message}`,
        });
        return true;
      }
    }

    if (!workerResult) {
      await _updateJob(jobId, {
        status: 'error',
        error : 'Worker marked job completed but result is empty (no inline result and no resultFile).',
      });
      return true;
    }

    const schemaError = _validateWorkerResult(workerResult);
    if (schemaError) {
      await _updateJob(jobId, { status: 'error', error: `Worker result schema invalid: ${schemaError}` });
      return true;
    }
    await _applyReconcileResult(jobId, workerResult);
    return true;

  } else if (entry.status === 'failed') {
    console.error(`[reconciliationEngine] Worker failure for ${jobId}: ${entry.error}`);
    await _updateJob(jobId, { status: 'error', error: entry.error || 'Worker failed' });
    return true;
  }

  // entry.status === 'processing' — this is just the worker's interim
  // marker, written the moment the job starts (see worker.js writeResult()).
  // Not terminal — caller must keep watching.
  return false;
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — WORKER RESULT SCHEMA VALIDATION
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
// SECTION 8 — QUEUE DEPTH LIMITS
// ══════════════════════════════════════════════════════════════════════════════

async function _checkQueueLimits(userId) {
  if (_redisAvailable) {
    try {
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
      if (err.status === 429) throw err;
      console.warn('[reconciliationEngine] Queue limit check failed:', err.message);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 9 — RECONCILIATION RUNNER
// ══════════════════════════════════════════════════════════════════════════════

async function _runReconciliation(jobId) {
  const job = await _requireJob(jobId);

  const engineResult = await callEngine({
    operation   : 'reconcile',
    invoicePath : job.invoiceFilePath,
    poPath      : job.poFilePath || undefined,
    grnPath     : job.grnFilePath || undefined,
    contractPath: job.contractFilePath || undefined,
  }, { timeout: RECONCILE_TIMEOUT });

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
    lockedUntil   : null,
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
// SECTION 11 — LOCK MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════

async function lockApprovalItem(jobId, approvalId, userId) {
  const job  = await _requireJob(jobId);
  const item = _requireApproval(job, approvalId);
  const now  = Date.now();

  if (item.status === 'approved' || item.status === 'rejected') {
    return { acquired: false, reason: 'Already resolved' };
  }

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
  item.lockedUntil = new Date(now + LOCK_TTL_MS).toISOString();

  await _updateJob(jobId, { pendingApprovals: job.pendingApprovals });
  return { acquired: true, lockedUntil: item.lockedUntil };
}

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
// SECTION 13 — BULK APPROVE
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
      item.status = 'error';
    }
  }

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
// SECTION 14 — EXECUTE RECONCILIATION
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
  }, { timeout: RECONCILE_TIMEOUT });

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
// SECTION 15 — GRACEFUL SHUTDOWN
// ══════════════════════════════════════════════════════════════════════════════

async function closeConnections() {
  clearInterval(_cleanupInterval);
  const closers = [];
  if (_redisClient) closers.push(_redisClient.quit().catch(() => {}));
  if (_subRedis)    closers.push(_subRedis.quit().catch(() => {}));
  await Promise.all(closers);
  console.log('[reconciliationEngine] Redis connections closed.');
}

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
  renewLock,
  releaseLock,
  executeReconciliation,
  cancelJob,
  closeConnections,
};

