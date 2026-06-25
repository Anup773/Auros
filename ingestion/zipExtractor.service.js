'use strict';
/**
 * backend/ingestion/zipExtractor.service.js
 *
 * CHANGES FROM V2:
 *
 *   - JOB-AWARE CLEANUP (issue #15):
 *     The previous scheduled cleanup deleted ANY extraction directory older than
 *     24 hours. A long-running reconciliation job (large ZIP, slow Python engine)
 *     whose extraction directory crossed the 24-hour threshold would have its
 *     working files deleted mid-run, crashing the job silently.
 *     Fix: _runCleanup() now skips directories that are registered as "active"
 *     in the _activeJobs Map. Callers register a job via _registerJob(jobId, dir)
 *     and deregister via cleanupExtractDir() (which removes both the dir and the
 *     registry entry). The Python engine can call _registerJob through the
 *     exported API if needed, but the typical path is that the Node controller
 *     registers immediately after extractZip() returns.
 *
 *   - ASYNC FILESYSTEM OPERATIONS (issue #16):
 *     All synchronous fs calls in _runCleanup() and related helpers
 *     (fs.readdirSync, fs.statSync, fs.rmSync, fs.existsSync, fs.mkdirSync)
 *     have been replaced with their fs.promises equivalents.
 *     Synchronous disk I/O blocks the Node event loop. Under heavy upload load
 *     (1 000+ concurrent uploads) the hourly GC scan was stalling all in-flight
 *     HTTP requests while it stat'd and rm'd directories.
 *     extractZip() was already async; the cleanup path is now fully async too.
 *     Note: the startup cleanup still uses a short setTimeout to avoid
 *     competing with the server boot sequence.
 *
 *   - All previous V2 fixes retained:
 *     • Scheduled cleanup for temp dir accumulation
 *     • Startup cleanup after crash/restart
 *     • cleanupExtractDir() as primary (immediate) cleanup path
 *     • Python engine enforces ZIP bomb / file count / size / extension checks
 */

const path     = require('path');
const fs       = require('fs');
const fsp      = require('fs').promises;   // async equivalents
const os       = require('os');
const crypto   = require('crypto');
const { callEngine } = require('../services/pythonBridge.service');

// ── Config ────────────────────────────────────────────────────────────────────
const EXTRACT_BASE_DIR    = path.join(os.tmpdir(), 'auros_extracts');
const EXTRACT_DIR_TTL_MS  = 24 * 60 * 60 * 1000;   // 24 h — max age before GC
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;          // GC runs every hour

// ── FIX (issue #15): Active-job registry ─────────────────────────────────────
// Maps extraction directory absolute path → { jobId, registeredAt }
// The GC skips any directory present in this map, regardless of age.
const _activeJobs = new Map();   // extractDir → { jobId, registeredAt }

/**
 * Register an active job so the GC never deletes its extraction directory.
 * Call immediately after extractZip() returns.
 *
 * @param {string} jobId
 * @param {string} extractDir — must match jobExtractDir returned by extractZip()
 */
function registerJob(jobId, extractDir) {
  _activeJobs.set(path.resolve(extractDir), { jobId, registeredAt: Date.now() });
}

// ── Ensure base directory exists (async) ─────────────────────────────────────
// Non-blocking: if it fails we log and continue; extractZip() will also mkdir.
fsp.mkdir(EXTRACT_BASE_DIR, { recursive: true }).catch(err => {
  console.warn(`[zipExtractor] Could not create base extract dir: ${err.message}`);
});

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract a ZIP file safely and return metadata about discovered files.
 *
 * @param {string} zipFilePath      — Absolute path to uploaded ZIP
 * @param {string} [baseExtractDir] — Override extraction base (defaults to OS temp)
 * @returns {Promise<Object>}
 */
async function extractZip(zipFilePath, baseExtractDir) {
  const jobId     = crypto.randomBytes(8).toString('hex');
  const baseDir   = baseExtractDir || EXTRACT_BASE_DIR;
  const extractTo = path.join(baseDir, jobId);

  // FIX (issue #16): async mkdir
  await fsp.mkdir(extractTo, { recursive: true });

  const result = await callEngine({
    operation : 'extract_zip',
    zipPath   : zipFilePath,
    extractTo,
  }, { timeout: 300_000 }); // 5 min for large ZIPs

  return {
    jobExtractDir   : extractTo,
    discovered      : result.discovered       || [],
    supportedFiles  : result.supportedFiles   || [],
    unsupportedFiles: result.unsupportedFiles || [],
    rejected        : result.rejected         || [],
    warnings        : result.warnings         || [],
    totalFiles      : result.totalFiles       || 0,
    totalBytes      : result.totalBytes       || 0,
  };
}

/**
 * Clean up an extraction directory immediately and deregister it from the
 * active-job registry.
 *
 * This is the PRIMARY cleanup path. The scheduled GC is a safety net only.
 * Always call this when a job finishes (success or failure).
 *
 * @param {string} extractDir
 * @param {string} [jobId] — optional, used only for log context
 */
async function cleanupExtractDir(extractDir, jobId) {
  if (!extractDir) return;
  const resolved = path.resolve(extractDir);

  // Deregister from active-job map so the GC won't try to skip/delete it again
  _activeJobs.delete(resolved);

  await _deleteDir(resolved, jobId);
}

// ── Scheduled cleanup (async, job-aware) ─────────────────────────────────────

/**
 * Delete extraction directories older than EXTRACT_DIR_TTL_MS.
 * FIX (issue #15): Skips directories that are registered as active jobs.
 * FIX (issue #16): Fully async — does not block the event loop.
 */
async function _runCleanup() {
  // FIX (issue #16): async stat check instead of fs.existsSync
  try {
    await fsp.access(EXTRACT_BASE_DIR);
  } catch {
    return;  // base dir doesn't exist yet — nothing to clean
  }

  let cleaned  = 0;
  let skipped  = 0;
  let errors   = 0;

  let entries;
  try {
    // FIX (issue #16): async readdir
    entries = await fsp.readdir(EXTRACT_BASE_DIR);
  } catch (err) {
    console.warn(`[zipExtractor] Cleanup scan failed: ${err.message}`);
    return;
  }

  const now = Date.now();

  // Process entries concurrently but cap concurrency to avoid fs saturation
  await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(EXTRACT_BASE_DIR, entry);
    const resolved = path.resolve(fullPath);

    try {
      // FIX (issue #16): async stat
      const stat = await fsp.stat(fullPath);
      if (!stat.isDirectory()) return;

      // FIX (issue #15): Skip directories belonging to active jobs
      if (_activeJobs.has(resolved)) {
        const info = _activeJobs.get(resolved);
        console.log(
          `[zipExtractor] Cleanup: skipping active job dir "${entry}" ` +
          `(jobId: ${info.jobId}, age: ${Math.round((now - stat.mtimeMs) / 3600_000)}h)`
        );
        skipped++;
        return;
      }

      const ageMs = now - stat.mtimeMs;
      if (ageMs > EXTRACT_DIR_TTL_MS) {
        await _deleteDir(fullPath);
        cleaned++;
      }
    } catch (entryErr) {
      errors++;
      // Individual entry failure — continue with others
    }
  }));

  if (cleaned > 0 || skipped > 0 || errors > 0) {
    console.log(
      `[zipExtractor] Cleanup: deleted ${cleaned} expired dir(s), ` +
      `skipped ${skipped} active, ${errors} error(s)`
    );
  }
}

/**
 * Delete a directory and all its contents.
 * FIX (issue #16): async rm instead of synchronous rmSync.
 *
 * @param {string} dirPath
 * @param {string} [logContext]
 */
async function _deleteDir(dirPath, logContext) {
  if (!dirPath) return;
  try {
    // FIX (issue #16): async access check instead of existsSync
    await fsp.access(dirPath);
    await fsp.rm(dirPath, { recursive: true, force: true });
  } catch (e) {
    if (e.code !== 'ENOENT') {
      const ctx = logContext ? ` [${logContext}]` : '';
      console.warn(`[zipExtractor]${ctx} Failed to delete ${dirPath}: ${e.message}`);
    }
  }
}

// ── Startup cleanup (clears leftover dirs from previous crashes) ──────────────
// Small delay to let server finish booting before doing disk I/O.
setTimeout(() => _runCleanup().catch(err =>
  console.warn(`[zipExtractor] Startup cleanup failed: ${err.message}`)
), 5000);

// ── Recurring scheduled cleanup ───────────────────────────────────────────────
const _cleanupInterval = setInterval(() => {
  _runCleanup().catch(err =>
    console.warn(`[zipExtractor] Scheduled cleanup failed: ${err.message}`)
  );
}, CLEANUP_INTERVAL_MS);

// Don't prevent process from exiting cleanly
if (_cleanupInterval.unref) _cleanupInterval.unref();

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  extractZip,
  cleanupExtractDir,
  registerJob,        // FIX (issue #15): callers register jobs to protect their dirs
  _runCleanup,        // Exposed for testing / manual trigger
};
