'use strict';
/**
 * backend/queues/worker.js
 *
 * CHANGES FROM V2 (this version):
 *
 *   FIX 1 — Large results stored on disk, not Redis (Critical Issues #2, #9)
 *     Previous: JSON.stringify(result) stored directly in Redis.
 *     A 100k-row reconciliation result could be 50-100MB — Redis explosion.
 *     Fix: Results above RESULT_SIZE_THRESHOLD (100KB) are written to a file
 *     in RESULTS_DIR and only the file path stored in Redis.
 *     Small results (< 100KB) remain inline in Redis for speed.
 *     reconciliationEngine.service.js must handle both { result: {...} }
 *     and { resultFile: '/path/to/result.json' } shapes.
 *
 *   FIX 2 — Temp file cleanup in finally blocks (Critical Issues #5, #6)
 *     Previous: fs.unlinkSync(audioPath) only ran on success.
 *     If callEngine() threw, audio files accumulated forever.
 *     Fix: All file cleanup moved to try/finally blocks.
 *     Also: WORKER_TEMP directory is auto-purged of files > TEMP_FILE_MAX_AGE_HOURS.
 *
 *   FIX 3 — Voice worker uses file path, not in-memory buffer (Critical Issues #3, #4)
 *     Previous: fs.readFileSync(audioPath) → base64 → sent to Python.
 *     A 2GB audio file = 2GB in-memory + 2.7GB base64 = ~5GB RAM → OOM.
 *     Fix: audioPath passed directly to faster_whisper_bridge.py as filePath.
 *     Python reads it from disk using streaming — no Node RAM spike.
 *
 *   FIX 4 — writeResult with retry (Critical Issue #1)
 *     Previous: Redis write failure after job completion meant API polled forever.
 *     Fix: writeResult() retries up to 3 times with backoff before giving up.
 *     On all-retry failure, logs critical error — operator must investigate.
 *
 *   FIX 5 — Redis connection eagerly established (Issue #11)
 *     Previous: lazyConnect: true meant first write could fail unexpectedly.
 *     Fix: _redis.connect() called at startup, errors logged non-fatally.
 *
 *   FIX 6 — Lock duration uses separate generous constant (Issue #7)
 *     Previous: lockDuration = timeout + 30s. Python can legitimately run
 *     longer than timeout on slow machines, causing stalled jobs and
 *     duplicate processing.
 *     Fix: LOCK_FACTOR = 2.0 — lock is 2× the timeout, giving enough margin.
 *
 *   FIX 7 — Reconcile timeout raised to 10min (already in V2, preserved)
 *
 *   FIX 8 — Duplicate result write prevented (Issue #10)
 *     Previous: both job complete handler AND failed event handler wrote results.
 *     A race condition could overwrite 'completed' with 'failed'.
 *     Fix: Failed handler only writes if no completed result already exists.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * V3 PATCH (applied by Claude — see chat for full explanation):
 *
 *   FIX V3-A — Worker never published to the pub/sub "done" channel.
 *     reconciliationEngine.service.js's _waitForResult() subscribes to
 *     `auros:job:done:<bullJobId>` expecting an instant notification when a
 *     job finishes. This file wrote the result to `bull:result:<bullJobId>`
 *     via writeResult() but never called `.publish(...)` on that channel —
 *     the string "publish" did not appear anywhere in this file. So the
 *     "instant" path never fired, and every job depended entirely on the
 *     30-second fallback poll on the engine side (and, combined with a
 *     separate bug over there, could get stuck indefinitely).
 *     Fix: writeResult() now publishes to `auros:job:done:<bullJobId>`
 *     immediately after a successful Redis SET, but only for terminal
 *     states ('completed' or 'failed') — never for the interim 'processing'
 *     marker. This is a single choke point, so it automatically covers all
 *     five job types (ocr, parse, reconcile, zip, voice) without touching
 *     each handler individually. Publishing is wrapped in its own try/catch
 *     and is non-fatal: if it fails, the engine's fallback poll still finds
 *     the result via Redis as before, just up to PUBSUB_FALLBACK_MS later.
 * ────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Worker }  = require('bullmq');
const path        = require('path');
const fs          = require('fs');
const IORedis     = require('ioredis');
const { CONNECTION, attachQueueEvents } = require('./jobQueue');
const { callEngine } = require('../services/pythonBridge.service');

// ── Directories ───────────────────────────────────────────────────────────────
const WORKER_TEMP  = path.join(__dirname, '../temp/worker_jobs');
const RESULTS_DIR  = path.join(__dirname, '../temp/job_results');
fs.mkdirSync(WORKER_TEMP,  { recursive: true });
fs.mkdirSync(RESULTS_DIR,  { recursive: true });

// FIX 1: Results larger than this are stored on disk, not in Redis
const RESULT_SIZE_THRESHOLD = 100 * 1024;  // 100 KB
// FIX 2: Temp files older than this are auto-cleaned
const TEMP_FILE_MAX_AGE_MS  = parseInt(process.env.TEMP_FILE_MAX_AGE_HOURS || '4', 10) * 60 * 60 * 1000;

console.log('[worker] Auros BullMQ Worker starting…');
console.log('[worker] Redis:', process.env.REDIS_URL || 'redis://localhost:6379');

// ── Redis client ──────────────────────────────────────────────────────────────
const _redis = new IORedis({
  ...CONNECTION,
  lazyConnect        : false,  // FIX 5: connect eagerly
  enableOfflineQueue : true,
  maxRetriesPerRequest: null,
});

_redis.on('error',   (err) => console.error('[worker] Redis client error:', err.message));
_redis.on('connect', ()    => console.log('[worker] Redis client connected'));

// FIX 5: Connect immediately, log but don't crash if Redis is down at startup
_redis.connect().catch(err => {
  console.warn('[worker] Initial Redis connect failed (will retry):', err.message);
});

const REDIS_RESULT_PREFIX = 'bull:result:';
const REDIS_RESULT_TTL_S  = parseInt(process.env.RESULT_TTL_HOURS || '24', 10) * 3600;  // FIX: 24h default (was 4h)

// V3 FIX: must match JOB_DONE_CHANNEL_PREFIX in reconciliationEngine.service.js
const JOB_DONE_CHANNEL_PREFIX = 'auros:job:done:'; // + bullJobId

// FIX 4: writeResult with retry
async function writeResult(bullJobId, status, resultOrError) {
  const key = `${REDIS_RESULT_PREFIX}${bullJobId}`;

  // FIX 8: Check if completed result already written before overwriting with failed
  if (status === 'failed') {
    try {
      const existing = await _redis.get(key);
      if (existing) {
        const parsed = JSON.parse(existing);
        if (parsed.status === 'completed') {
          console.log(`[worker] Skipping 'failed' write for ${bullJobId} — completed result already exists`);
          return;  // FIX 8: don't overwrite completed with failed
        }
      }
    } catch (_) {}
  }

  const entry = {
    bullJobId,
    status,
    updatedAt: new Date().toISOString(),
  };

  if (status === 'completed') {
    // FIX 1: Large results stored on disk
    const serialized = JSON.stringify(resultOrError || {});
    if (serialized.length > RESULT_SIZE_THRESHOLD) {
      const resultFile = path.join(RESULTS_DIR, `result_${bullJobId}.json`);
      fs.writeFileSync(resultFile, serialized, 'utf8');
      entry.resultFile = resultFile;
      console.log(`[worker] Large result (${Math.round(serialized.length / 1024)}KB) written to disk: ${resultFile}`);
    } else {
      entry.result = resultOrError;
    }
  }

  if (status === 'failed') entry.error = String(resultOrError);

  // FIX 4: Retry up to 3 times
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await _redis.set(key, JSON.stringify(entry), 'EX', REDIS_RESULT_TTL_S);
      console.log(`[worker] Wrote ${status} result to Redis: ${key}`);

      // V3 FIX: notify any waiting reconciliationEngine._waitForResult()
      // subscriber immediately on terminal states only ('completed'/'failed'
      // — never for the interim 'processing' marker, since that isn't done
      // yet). This used to never happen at all, so every job depended
      // entirely on the engine's 30s fallback poll. Publishing with zero
      // subscribers is a harmless no-op in Redis, and a publish failure here
      // is non-fatal — the fallback poll on the engine side will still find
      // the result in Redis regardless.
      if (status === 'completed' || status === 'failed') {
        try {
          await _redis.publish(`${JOB_DONE_CHANNEL_PREFIX}${bullJobId}`, status);
          console.log(`[worker] Published ${status} notification on ${JOB_DONE_CHANNEL_PREFIX}${bullJobId}`);
        } catch (pubErr) {
          console.warn(`[worker] Failed to publish job:done for ${bullJobId} (non-fatal — engine fallback poll will still find it):`, pubErr.message);
        }
      }
      return;
    } catch (err) {
      if (attempt < 2) {
        console.warn(`[worker] Redis write failed (attempt ${attempt + 1}/3): ${err.message}`);
        await _sleep(500 * (attempt + 1));
      } else {
        console.error(`[worker] CRITICAL: Failed to write result to Redis after 3 attempts for job ${bullJobId}: ${err.message}`);
      }
    }
  }
}

// FIX 2: Cleanup old temp files
function _cleanupOldTempFiles(dir) {
  try {
    const now   = Date.now();
    const files = fs.readdirSync(dir);
    let cleaned = 0;
    for (const file of files) {
      const fullPath = path.join(dir, file);
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > TEMP_FILE_MAX_AGE_MS) {
          fs.unlinkSync(fullPath);
          cleaned++;
        }
      } catch (_) {}
    }
    if (cleaned > 0) console.log(`[worker] Cleaned ${cleaned} old temp files from ${dir}`);
  } catch (_) {}
}

// Run cleanup every hour
setInterval(() => {
  _cleanupOldTempFiles(WORKER_TEMP);
  _cleanupOldTempFiles(RESULTS_DIR);
}, 60 * 60 * 1000);

// ── Timeout and lock constants ────────────────────────────────────────────────
const TIMEOUTS = {
  ocr      : 10 * 60 * 1000,
  parse    :  5 * 60 * 1000,
  reconcile: 10 * 60 * 1000,
  zip      :  5 * 60 * 1000,
  voice    :      60 * 1000,
};
// FIX 6: Lock is 2x timeout to prevent stalled job duplicate processing
const LOCK_FACTOR = 2.0;

// ── OCR WORKER ────────────────────────────────────────────────────────────────
const ocrWorker = new Worker(
  'ocr',
  async (job) => {
    const { filePath, gemini_fallback = false } = job.data;
    console.log(`[worker:ocr] Job ${job.id} — ${path.basename(filePath)}`);
    await writeResult(job.id, 'processing', null);
    await job.updateProgress(10);

    try {
      const result = await callEngine(
        { operation: 'ocr_invoice', filePath, gemini_fallback },
        { timeout: TIMEOUTS.ocr }
      );
      await job.updateProgress(100);
      await writeResult(job.id, 'completed', result);
      return result;
    } catch (err) {
      await writeResult(job.id, 'failed', err.message);
      throw err;
    }
  },
  {
    connection  : CONNECTION,
    concurrency : parseInt(process.env.WORKER_OCR_CONCURRENCY || '2', 10),
    lockDuration: Math.round(TIMEOUTS.ocr * LOCK_FACTOR),  // FIX 6
  }
);

ocrWorker.on('failed', async (job, err) => {
  console.error(`[worker:ocr] Job ${job?.id} FAILED:`, err.message);
  // FIX 8: Only write if not already written inside the job handler
  if (job?.id) await writeResult(job.id, 'failed', err.message).catch(() => {});
});

// ── PARSE WORKER ──────────────────────────────────────────────────────────────
const parseWorker = new Worker(
  'parse',
  async (job) => {
    const { filePath, operation = 'parse' } = job.data;
    console.log(`[worker:parse] Job ${job.id} — ${operation}: ${path.basename(filePath)}`);
    await writeResult(job.id, 'processing', null);
    await job.updateProgress(10);

    try {
      const result = await callEngine(
        { operation, filePath },
        { timeout: TIMEOUTS.parse }
      );
      await job.updateProgress(100);
      await writeResult(job.id, 'completed', result);
      return result;
    } catch (err) {
      await writeResult(job.id, 'failed', err.message);
      throw err;
    }
  },
  {
    connection  : CONNECTION,
    concurrency : parseInt(process.env.WORKER_PARSE_CONCURRENCY || '3', 10),
    lockDuration: Math.round(TIMEOUTS.parse * LOCK_FACTOR),
  }
);

parseWorker.on('failed', async (job, err) => {
  console.error(`[worker:parse] Job ${job?.id} FAILED:`, err.message);
  if (job?.id) await writeResult(job.id, 'failed', err.message).catch(() => {});
});

// ── RECONCILE WORKER ──────────────────────────────────────────────────────────
const reconcileWorker = new Worker(
  'reconcile',
  async (job) => {
    const { invoicePath, poPath } = job.data;
    console.log(`[worker:reconcile] Job ${job.id} — ${path.basename(invoicePath)}`);
    await writeResult(job.id, 'processing', null);
    await job.updateProgress(10);

    try {
      const result = await callEngine(
        { operation: 'reconcile', invoicePath, poPath },
        { timeout: TIMEOUTS.reconcile }
      );
      await job.updateProgress(100);
      await writeResult(job.id, 'completed', result);
      return result;
    } catch (err) {
      await writeResult(job.id, 'failed', err.message);
      throw err;
    }
  },
  {
    connection  : CONNECTION,
    concurrency : parseInt(process.env.WORKER_RECONCILE_CONCURRENCY || '2', 10),
    lockDuration: Math.round(TIMEOUTS.reconcile * LOCK_FACTOR),
  }
);

reconcileWorker.on('failed', async (job, err) => {
  console.error(`[worker:reconcile] Job ${job?.id} FAILED:`, err.message);
  if (job?.id) await writeResult(job.id, 'failed', err.message).catch(() => {});
});

// ── ZIP WORKER ────────────────────────────────────────────────────────────────
const zipWorker = new Worker(
  'zip',
  async (job) => {
    const { zipPath, extractTo } = job.data;
    console.log(`[worker:zip] Job ${job.id} — ${path.basename(zipPath)}`);
    await writeResult(job.id, 'processing', null);
    await job.updateProgress(10);

    try {
      const result = await callEngine(
        { operation: 'extract_zip', zipPath, extractTo },
        { timeout: TIMEOUTS.zip }
      );
      await job.updateProgress(100);
      await writeResult(job.id, 'completed', result);
      return result;
    } catch (err) {
      await writeResult(job.id, 'failed', err.message);
      throw err;
    }
  },
  {
    connection  : CONNECTION,
    concurrency : parseInt(process.env.WORKER_ZIP_CONCURRENCY || '3', 10),
    lockDuration: Math.round(TIMEOUTS.zip * LOCK_FACTOR),
  }
);

zipWorker.on('failed', async (job, err) => {
  console.error(`[worker:zip] Job ${job?.id} FAILED:`, err.message);
  if (job?.id) await writeResult(job.id, 'failed', err.message).catch(() => {});
});

// ── VOICE WORKER ──────────────────────────────────────────────────────────────
const voiceWorker = new Worker(
  'voice',
  async (job) => {
    const { audioPath, mimeType, language = 'en' } = job.data;
    console.log(`[worker:voice] Job ${job.id} — transcribing audio`);
    await writeResult(job.id, 'processing', null);
    await job.updateProgress(10);

    const WHISPER_ENGINE = path.join(__dirname, '../python/faster_whisper_bridge.py');

    try {
      // FIX 3: Pass file PATH directly — Python reads from disk, no Node RAM spike
      // Previously: fs.readFileSync → base64 → 5GB RAM for 2GB file
      const result = await callEngine(
        {
          operation : 'transcribe',
          // FIX 3: audioFilePath (on-disk) instead of audioBase64 (in-memory)
          audioFilePath: audioPath,
          mimeType,
          language,
        },
        { enginePath: WHISPER_ENGINE, timeout: TIMEOUTS.voice }
      );

      await job.updateProgress(100);
      await writeResult(job.id, 'completed', result);
      return result;

    } finally {
      // FIX 2: Always clean up audio file regardless of success/failure
      try { fs.unlinkSync(audioPath); } catch (_) {}
    }
  },
  {
    connection  : CONNECTION,
    concurrency : parseInt(process.env.WORKER_VOICE_CONCURRENCY || '2', 10),
    lockDuration: Math.round(TIMEOUTS.voice * LOCK_FACTOR),
  }
);

voiceWorker.on('failed', async (job, err) => {
  console.error(`[worker:voice] Job ${job?.id} FAILED:`, err.message);
  if (job?.id) await writeResult(job.id, 'failed', err.message).catch(() => {});
});

// ── Attach queue event listeners ──────────────────────────────────────────────
['ocr', 'parse', 'reconcile', 'zip', 'voice'].forEach(attachQueueEvents);

// ── Startup log ───────────────────────────────────────────────────────────────
console.log('[worker] Workers active:');
console.log(`  OCR:       concurrency=${process.env.WORKER_OCR_CONCURRENCY       || 2}`);
console.log(`  Parse:     concurrency=${process.env.WORKER_PARSE_CONCURRENCY     || 3}`);
console.log(`  Reconcile: concurrency=${process.env.WORKER_RECONCILE_CONCURRENCY || 2}`);
console.log(`  ZIP:       concurrency=${process.env.WORKER_ZIP_CONCURRENCY       || 3}`);
console.log(`  Voice:     concurrency=${process.env.WORKER_VOICE_CONCURRENCY     || 2}`);
console.log(`[worker] Result TTL: ${REDIS_RESULT_TTL_S / 3600}h`);
console.log(`[worker] Large result threshold: ${RESULT_SIZE_THRESHOLD / 1024}KB → stored on disk`);
console.log(`[worker] Temp cleanup: files older than ${TEMP_FILE_MAX_AGE_MS / 3600000}h`);

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`\n[worker] ${signal} received — draining workers…`);
  // FIX: Use drain timeout to let active jobs finish before closing
  const DRAIN_TIMEOUT_MS = parseInt(process.env.WORKER_DRAIN_TIMEOUT_MS || '30000', 10);
  const closeWithTimeout = (worker, name) =>
    Promise.race([
      worker.close(),
      new Promise(r => setTimeout(() => { console.warn(`[worker] ${name} drain timeout`); r(); }, DRAIN_TIMEOUT_MS)),
    ]);

  await Promise.all([
    closeWithTimeout(ocrWorker,       'ocrWorker'),
    closeWithTimeout(parseWorker,     'parseWorker'),
    closeWithTimeout(reconcileWorker, 'reconcileWorker'),
    closeWithTimeout(zipWorker,       'zipWorker'),
    closeWithTimeout(voiceWorker,     'voiceWorker'),
    _redis.quit().catch(() => {}),
  ]);
  console.log('[worker] All workers stopped cleanly.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('[worker] Unhandled rejection:', reason);
});

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

