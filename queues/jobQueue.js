'use strict';
/**
 * backend/queues/jobQueue.js
 *
 * CHANGES FROM V1 (this version):
 *
 *   FIX 1 — Payload validation before queue.add() (Critical Issue #2)
 *     Previous: addOcrJob({ filePath: undefined }) was accepted silently.
 *     The worker picked it up and crashed with a confusing error.
 *     Fix: Each addXxxJob() validates required fields before calling queue.add().
 *
 *   FIX 2 — Redis TLS support for AWS ElastiCache (Critical Issue #5)
 *     Previous: URL parser ignored protocol — rediss:// (TLS) was treated
 *     the same as redis:// (no TLS) → ElastiCache production connections fail.
 *     Fix: tls: {} added when protocol is 'rediss:'.
 *
 *   FIX 3 — Queue readiness check at startup (Critical Issue #3)
 *     Previous: new Queue() doesn't verify Redis is alive. First job.add()
 *     after Redis crash throws and the user sees a 500.
 *     Fix: waitUntilReady() exported so the server startup sequence can
 *     await it before accepting requests. Non-blocking — Redis failure
 *     logs a warning rather than crashing the server (graceful degradation).
 *
 *   FIX 4 — QueueEvents instances tracked and closed (Critical Issue #4)
 *     Previous: attachQueueEvents() leaked QueueEvents objects on reload.
 *     Fix: _queueEvents Map tracks all instances. closeAll() now closes both
 *     Queue and QueueEvents instances.
 *
 *   FIX 5 — Health check result cached (Issue #6)
 *     Previous: Each k8s health probe fired 15 Redis commands.
 *     Fix: 10-second TTL cache on health results.
 *
 *   FIX 6 — Job idempotency via deduplication key (Issue #7)
 *     Previous: Each addOcrJob() call created a new job regardless of
 *     whether the same file was already queued. Browser refresh → 3 OCR jobs.
 *     Fix: callers can pass opts.deduplicationId (e.g. hash of filePath).
 *     BullMQ will not add a second job with the same deduplication key
 *     while the first is still waiting/active.
 *
 *   FIX 7 — Health response sanitized (Issue #10)
 *     Previous: redisUrl included in health response — exposes infrastructure.
 *     Fix: redisUrl removed from external health response.
 *
 *   FIX 8 — Max waiting jobs per queue (Critical Issue #1)
 *     Large-scale upload storms (1000 users) would fill Redis with waiting jobs.
 *     Fix: MAX_WAITING_JOBS limit per queue type. Additive calls reject fast
 *     with a 429 when the queue is full, rather than consuming Redis memory.
 */

const { Queue, QueueEvents } = require('bullmq');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// FIX 8: Max waiting jobs per queue before rejecting new submissions
const MAX_WAITING = {
  ocr      : parseInt(process.env.QUEUE_MAX_OCR       || '50',  10),
  parse    : parseInt(process.env.QUEUE_MAX_PARSE      || '100', 10),
  reconcile: parseInt(process.env.QUEUE_MAX_RECONCILE  || '50',  10),
  zip      : parseInt(process.env.QUEUE_MAX_ZIP        || '100', 10),
  voice    : parseInt(process.env.QUEUE_MAX_VOICE      || '50',  10),
};

// FIX 2: Parse Redis URL with TLS support
function getRedisConnection() {
  try {
    const url      = new URL(REDIS_URL);
    const isTLS    = url.protocol === 'rediss:';  // FIX 2: rediss:// = TLS
    const conn = {
      host                : url.hostname || 'localhost',
      port                : parseInt(url.port || (isTLS ? '6380' : '6379'), 10),
      password            : url.password || undefined,
      db                  : parseInt(url.pathname?.replace('/', '') || '0', 10) || 0,
      enableReadyCheck    : false,
      maxRetriesPerRequest: null,
      retryStrategy       : (times) => {
        if (times > 10) {
          console.error('[jobQueue] Redis connection failed after 10 retries');
          return null;
        }
        return Math.min(times * 200, 3000);
      },
    };
    // FIX 2: Enable TLS for rediss:// URLs (AWS ElastiCache, Redis Cloud)
    if (isTLS) conn.tls = {};
    return conn;
  } catch (err) {
    console.error('[jobQueue] Invalid REDIS_URL, using defaults:', err.message);
    return {
      host                : 'localhost',
      port                : 6379,
      enableReadyCheck    : false,
      maxRetriesPerRequest: null,
    };
  }
}

const CONNECTION = getRedisConnection();

const DEFAULT_JOB_OPTIONS = {
  removeOnComplete: { age: 3600,  count: 100 },
  removeOnFail    : { age: 86400, count: 50  },
  attempts        : 3,
  backoff         : { type: 'exponential', delay: 2000 },
};

// FIX 4: Track both Queue and QueueEvents for proper cleanup
let _queues      = {};
let _queueEvents = {};

// FIX 5: Health check cache
let _healthCache    = null;
let _healthCachedAt = 0;
const HEALTH_CACHE_TTL_MS = 10_000;

function getQueue(name) {
  if (!_queues[name]) {
    _queues[name] = new Queue(name, {
      connection       : CONNECTION,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    _queues[name].on('error', (err) => {
      console.error(`[jobQueue] Queue "${name}" error:`, err.message);
    });
  }
  return _queues[name];
}

// ── Queue accessors ───────────────────────────────────────────────────────────
function getOcrQueue()       { return getQueue('ocr');       }
function getParseQueue()     { return getQueue('parse');     }
function getReconcileQueue() { return getQueue('reconcile'); }
function getZipQueue()       { return getQueue('zip');       }
function getVoiceQueue()     { return getQueue('voice');     }

// ── FIX 3: Startup readiness check ───────────────────────────────────────────
/**
 * Verify Redis is reachable before accepting requests.
 * Call in server startup: await jobQueue.waitUntilReady()
 * Non-fatal — logs warning if Redis unavailable (graceful degradation).
 */
async function waitUntilReady(timeoutMs = 5000) {
  const queues     = ['ocr', 'parse', 'reconcile', 'zip', 'voice'];
  const startTime  = Date.now();
  const results    = [];

  for (const name of queues) {
    try {
      const q = getQueue(name);
      // waitUntilReady() resolves when Redis connection is established
      await Promise.race([
        q.waitUntilReady(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
      ]);
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, error: err.message });
      console.warn(`[jobQueue] Queue "${name}" not ready: ${err.message}`);
    }
  }

  const allOk = results.every(r => r.ok);
  if (allOk) {
    console.log(`[jobQueue] All queues ready (${Date.now() - startTime}ms)`);
  } else {
    const failed = results.filter(r => !r.ok).map(r => r.name).join(', ');
    console.warn(`[jobQueue] WARNING: queues not ready: ${failed}. Jobs will be queued and retried when Redis reconnects.`);
  }
  return results;
}

// ── FIX 8: Waiting job limit check ───────────────────────────────────────────
async function _checkQueueCapacity(queueName) {
  const max = MAX_WAITING[queueName];
  if (!max) return;
  const q       = getQueue(queueName);
  const waiting = await q.getWaitingCount();
  if (waiting >= max) {
    throw Object.assign(
      new Error(`Queue "${queueName}" is at capacity (${waiting}/${max} waiting jobs). Please try again later.`),
      { status: 429, code: 'QUEUE_FULL' }
    );
  }
}

// ── Job addition helpers ──────────────────────────────────────────────────────

/**
 * FIX 1: Each helper validates required fields before queuing.
 * FIX 6: opts.deduplicationId enables BullMQ job dedup.
 */
async function addOcrJob(data, opts = {}) {
  // FIX 1: Validate before queuing
  if (!data?.filePath) throw new Error('addOcrJob: data.filePath is required');
  await _checkQueueCapacity('ocr');  // FIX 8

  const queue = getOcrQueue();
  return queue.add('ocr_invoice', data, {
    ...DEFAULT_JOB_OPTIONS,
    attempts: 1,
    // FIX 6: Dedup by filePath hash if caller provides it
    ...(opts.deduplicationId ? { deduplication: { id: opts.deduplicationId } } : {}),
    ...opts,
  });
}

async function addParseJob(data, opts = {}) {
  if (!data?.filePath) throw new Error('addParseJob: data.filePath is required');
  await _checkQueueCapacity('parse');

  const queue = getParseQueue();
  return queue.add('parse_file', data, {
    ...DEFAULT_JOB_OPTIONS,
    ...(opts.deduplicationId ? { deduplication: { id: opts.deduplicationId } } : {}),
    ...opts,
  });
}

async function addReconcileJob(data, opts = {}) {
  if (!data?.invoicePath) throw new Error('addReconcileJob: data.invoicePath is required');
  await _checkQueueCapacity('reconcile');

  const queue = getReconcileQueue();
  return queue.add('reconcile', data, {
    ...DEFAULT_JOB_OPTIONS,
    ...(opts.deduplicationId ? { deduplication: { id: opts.deduplicationId } } : {}),
    ...opts,
  });
}

async function addZipJob(data, opts = {}) {
  if (!data?.zipPath)    throw new Error('addZipJob: data.zipPath is required');
  if (!data?.extractTo)  throw new Error('addZipJob: data.extractTo is required');
  await _checkQueueCapacity('zip');

  const queue = getZipQueue();
  return queue.add('extract_zip', data, {
    ...DEFAULT_JOB_OPTIONS,
    ...(opts.deduplicationId ? { deduplication: { id: opts.deduplicationId } } : {}),
    ...opts,
  });
}

async function addVoiceJob(data, opts = {}) {
  if (!data?.audioPath) throw new Error('addVoiceJob: data.audioPath is required');
  await _checkQueueCapacity('voice');

  const queue = getVoiceQueue();
  return queue.add('transcribe', data, {
    ...DEFAULT_JOB_OPTIONS,
    attempts: 1,
    ...opts,
  });
}

// ── FIX 4: QueueEvents with cleanup tracking ──────────────────────────────────
function attachQueueEvents(queueName) {
  // Prevent duplicate listeners
  if (_queueEvents[queueName]) {
    return _queueEvents[queueName];
  }

  const events = new QueueEvents(queueName, { connection: CONNECTION });

  events.on('completed', ({ jobId }) => {
    console.log(`[jobQueue] [${queueName}] Job ${jobId} completed`);
  });
  events.on('failed', ({ jobId, failedReason }) => {
    console.error(`[jobQueue] [${queueName}] Job ${jobId} FAILED: ${failedReason}`);
  });
  events.on('stalled', ({ jobId }) => {
    console.warn(`[jobQueue] [${queueName}] Job ${jobId} STALLED — worker may have crashed`);
  });
  events.on('progress', ({ jobId, data }) => {
    console.log(`[jobQueue] [${queueName}] Job ${jobId} progress: ${JSON.stringify(data)}`);
  });

  _queueEvents[queueName] = events;  // FIX 4: tracked for closeAll()
  return events;
}

// ── FIX 5: Cached health check ────────────────────────────────────────────────
async function healthCheck() {
  const now = Date.now();
  if (_healthCache && (now - _healthCachedAt) < HEALTH_CACHE_TTL_MS) {
    return _healthCache;
  }

  const queueNames = ['ocr', 'parse', 'reconcile', 'zip', 'voice'];
  // FIX 7: No Redis URL in health response
  const result = { ok: true, queues: {} };

  for (const name of queueNames) {
    try {
      const q       = getQueue(name);
      const waiting = await q.getWaitingCount();
      const active  = await q.getActiveCount();
      const failed  = await q.getFailedCount();
      const maxWait = MAX_WAITING[name] || 'unlimited';
      result.queues[name] = { waiting, active, failed, maxWaiting: maxWait, ok: true };
    } catch (err) {
      result.queues[name] = { ok: false, error: err.message };
      result.ok = false;
    }
  }

  _healthCache    = result;
  _healthCachedAt = now;
  return result;
}

// ── FIX 4: Graceful shutdown closes both Queues and QueueEvents ───────────────
async function closeAll() {
  const closePromises = [
    ...Object.values(_queues).map(q => q.close().catch(() => {})),
    ...Object.values(_queueEvents).map(e => e.close().catch(() => {})),  // FIX 4
  ];
  await Promise.all(closePromises);
  _queues      = {};
  _queueEvents = {};
  console.log('[jobQueue] All queues and QueueEvents closed.');
}

module.exports = {
  getQueue,
  getOcrQueue, getParseQueue, getReconcileQueue, getZipQueue, getVoiceQueue,
  addOcrJob, addParseJob, addReconcileJob, addZipJob, addVoiceJob,
  attachQueueEvents,
  healthCheck,
  waitUntilReady,
  closeAll,
  CONNECTION,
};
