'use strict';
/**
 * backend/server.js
 *
 * HTTP server entry point.
 *
 * CHANGES FROM V2:
 *   - HIGH: Graceful shutdown now properly awaits server.close() using a Promise.
 *     Old: server.close(callback) ran asynchronously — queue connections could
 *          close before in-flight requests finished.
 *     New: await _closeServer(server) ensures HTTP is fully drained first,
 *          then queue connections are closed.
 *
 *   - MEDIUM: Forced-exit timeout is now cleared if shutdown completes in time.
 *     Old: setTimeout fired even after clean shutdown, killing the process anyway.
 *     New: timeoutId stored and clearTimeout(timeoutId) called on clean exit.
 *
 *   - MEDIUM: Multi-shutdown race condition prevented with `isShuttingDown` guard.
 *     Old: uncaught exceptions could trigger shutdown() multiple times concurrently.
 *     New: second call to shutdown() returns immediately if already in progress.
 *
 *   - MEDIUM: unhandledRejection now triggers graceful shutdown (not just log).
 *     Old: only logged — production state could become corrupted.
 *     New: calls shutdown('unhandledRejection') to drain and exit cleanly.
 *
 *   - HIGH: Redis/sync fallback risk documented clearly.
 *     If Redis is unavailable, heavy async jobs (OCR, reconciliation, AI) silently
 *     fall back to synchronous execution only if each route handler supports it.
 *     Routes that do NOT support sync fallback will throw — this is now explicitly
 *     logged at startup so ops teams can act before issues hit production.
 *
 *   - Applied SERVER_TIMEOUT_MS to the HTTP server socket to prevent slowloris
 *     and stalled upload connections. Default: 30 000 ms (from app.locals).
 */

require('dotenv').config();

const app    = require('./app');
const PORT   = parseInt(process.env.PORT || '4000', 10);

// ── Request timeout ───────────────────────────────────────────────────────────
// Applied to the server socket level (complements express-level timeouts per route)
const TIMEOUT_MS = app.locals.TIMEOUT_MS || 30_000;

// ── Shutdown state guard ──────────────────────────────────────────────────────
// FIX: prevents multiple concurrent shutdown calls from race conditions
let isShuttingDown = false;

// ── Try to connect to queue on startup (non-fatal if Redis not available) ─────
let jobQueue = null;
try {
  jobQueue = require('./queues/jobQueue');
  console.log('[server] BullMQ queue module loaded. Run worker separately: node queues/worker.js');
  console.log('[server] Redis URL:', process.env.REDIS_URL || 'redis://localhost:6379');
} catch (err) {
  console.warn('[server] BullMQ not available (Redis may be offline):', err.message);
  // FIX: explicit warning about which job types do NOT support sync fallback
  console.warn('[server] WARNING: Heavy jobs (OCR, reconciliation, AI) will attempt');
  console.warn('[server] synchronous execution. Routes without sync fallback will throw.');
  console.warn('[server] Ensure Redis is available in production before processing uploads.');
}

const server = app.listen(PORT, () => {
  console.log(`[server] Auros backend running on port ${PORT}`);
  console.log(`[server] Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[server] Health: http://localhost:${PORT}/health`);
  console.log(`[server] Queue:  http://localhost:${PORT}/api/queue/health`);
  console.log(`[server] Request timeout: ${TIMEOUT_MS}ms`);
});

// FIX: apply socket-level timeout to prevent slowloris / stalled connections
server.setTimeout(TIMEOUT_MS);

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal) {
  // FIX: guard — prevents multiple concurrent shutdown sequences
  if (isShuttingDown) {
    console.warn(`[server] Shutdown already in progress — ignoring signal: ${signal}`);
    return;
  }
  isShuttingDown = true;

  console.log(`\n[server] ${signal} received — shutting down gracefully…`);

  // FIX: forced-exit timer stored so it can be cleared on clean shutdown
  const timeoutId = setTimeout(() => {
    console.error('[server] Forced exit after timeout.');
    process.exit(1);
  }, 15_000);

  try {
    // FIX: await server.close() so in-flight requests finish before queue closes
    await _closeServer(server);
    console.log('[server] HTTP server closed.');

    // Close BullMQ queue connections after HTTP is fully drained
    if (jobQueue) {
      try {
        await jobQueue.closeAll();
        console.log('[server] BullMQ queue connections closed.');
      } catch (err) {
        console.error('[server] Error closing queues:', err.message);
      }
    }

    // FIX: clear the forced-exit timer — shutdown completed cleanly
    clearTimeout(timeoutId);
    console.log('[server] Shutdown complete.');
    process.exit(0);

  } catch (err) {
    console.error('[server] Error during shutdown:', err.message);
    // Forced-exit timer will still fire after 15s if we reach here
  }
}

/**
 * Wraps server.close() in a Promise so it can be properly awaited.
 * Resolves once all existing connections have ended.
 */
function _closeServer(srv) {
  return new Promise((resolve, reject) => {
    srv.close(err => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ── Process signal handlers ───────────────────────────────────────────────────
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// FIX: unhandledRejection triggers graceful shutdown instead of just logging
// Corrupted async state should not be allowed to keep the process alive
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled rejection:', reason);
  shutdown('unhandledRejection');
});

// FIX: multiple uncaught exceptions are handled safely via isShuttingDown guard
process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception:', err);
  shutdown('uncaughtException');
});

module.exports = server;

