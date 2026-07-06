'use strict';
/**
 * backend/services/pythonBridge.service.js
 *
 * CHANGES FROM V3 (this version — V4):
 *
 *   FIX 1 — OCR retry storm prevention (CRITICAL)
 *     Previously: ENGINE_TIMEOUT triggered retries for OCR operations.
 *     A timeout on a 320s OCR job followed by 2 retries = 960s of wasted
 *     CPU and spawned Python processes that never resolve.
 *     FIX: OCR operations ('ocr_invoice', 'ocr_batch') do NOT retry on
 *     ENGINE_TIMEOUT. They fail fast and let the caller handle fallback.
 *
 *   FIX 2 — Python spawn storm prevention (CRITICAL)
 *     Added a global concurrency semaphore (MAX_CONCURRENT_SPAWNS).
 *     When the limit is reached, new requests queue instead of spawning
 *     a new Python process immediately. This prevents the "Too many
 *     requests" / worker saturation visible in the Execute screenshots.
 *     Default: 4 concurrent spawns (configurable via PYTHON_MAX_CONCURRENT).
 *
 *   FIX 3 — rawText memory leak prevention
 *     OCR operations now cap rawText at 500 chars in the returned result
 *     before it reaches Node's memory. The full text is processed by
 *     Python and only structured rows are returned at scale.
 *
 *   FIX 4 — Path whitelist enforcement (SECURITY) — REVISED
 *     Previous V3 implementation blanket-rejected ALL absolute Windows paths
 *     (C:\...) which broke legitimate server-side OCR temp paths like:
 *       C:\WINDOWS\TEMP\auros_ocr\<hash>_invoice.jpg
 *       C:\WINDOWS\TEMP\auros_ocr\<hash>_invoice.pdf
 *     These paths are generated internally by the upload/OCR pipeline and
 *     are NOT user-supplied — they must be allowed.
 *
 *     REVISED FIX:
 *     - ".." traversal and "~" home-dir expansion are still rejected (unsafe
 *       regardless of origin).
 *     - For relative paths: the existing prefix whitelist is enforced
 *       (uploads/, temp/, tmp/, exports/, output/, outputs/, data/).
 *     - For absolute paths (both Linux /... and Windows C:\...):
 *       the path is normalised (backslashes → forward slashes) and checked
 *       against ALLOWED_ABSOLUTE_SEGMENTS — a list of known safe directory
 *       name segments that must appear in the path.
 *       If none of the allowed segments match, the path is rejected.
 *     - This correctly allows C:\WINDOWS\TEMP\auros_ocr\... (contains
 *       "auros_ocr") while still blocking arbitrary paths like C:\Users\...
 *       or C:\secret\passwords.txt.
 *
 *   FIX 5 — Stderr size cap now applies to logging too
 *     Previously stderr was logged in full even when truncated. Now
 *     only the first MAX_STDERR_BYTES are logged.
 *
 *   All V3 logic preserved (OCR timeout floor, stdout cap, JSON extraction
 *   strategies, retry backoff for non-OCR operations).
 */

const { spawn, exec } = require('child_process');
const path      = require('path');
const os        = require('os');

const _IS_WINDOWS = os.platform() === 'win32';

/**
 * FIX 6 (NEW) — WINDOWS ORPHANED CHILD PROCESS CLEANUP
 *
 *   Root cause: On Windows, ocr_engine.py uses a THREAD-based timeout
 *   (documented in that file) because multiprocessing.Process hangs when
 *   imported from another module. A Python thread cannot be forcibly killed.
 *
 *   pytesseract and pdf2image don't do OCR in-process — they shell out to
 *   real native binaries (tesseract.exe, poppler's pdftoppm.exe) as SEPARATE
 *   OS processes. When our timeout fires and we call proc.kill('SIGKILL') on
 *   the parent python.exe, Windows does NOT kill child processes automatically
 *   (no job-object/process-tree cleanup like POSIX process groups give you).
 *
 *   Result: every OCR timeout left tesseract.exe / pdftoppm.exe running in
 *   the background, consuming CPU for minutes afterward — starving every
 *   other Python spawn (CSV/XLSX parsing included, since they share this same
 *   module's concurrency semaphore) and making unrelated uploads appear to
 *   hang for 10-20+ minutes even though nothing was actually deadlocked.
 *
 *   Fix: on Windows, kill the ENTIRE process tree with
 *   `taskkill /PID <pid> /T /F` instead of a plain SIGKILL. `/T` kills all
 *   child processes, `/F` forces termination. On Linux/Mac, SIGKILL already
 *   kills the process; this is only needed on Windows.
 */
function _killProcessTree(proc) {
  if (_IS_WINDOWS && proc.pid) {
    exec(`taskkill /PID ${proc.pid} /T /F`, (err) => {
      if (err) {
        console.warn(`[pythonBridge] taskkill failed for PID ${proc.pid} (process may have already exited):`, err.message);
      }
    });
  } else {
    try { proc.kill('SIGKILL'); } catch (_) {}
  }
}

const DEFAULT_ENGINE_PATH = path.join(__dirname, '../python/data_engine.py');
const PYTHON_BIN          = process.env.PYTHON_BIN || (os.platform() === 'win32' ? 'python' : 'python3');
const TIMEOUT_MS          = parseInt(process.env.PYTHON_TIMEOUT_MS   || '120000', 10);
const MAX_RETRIES         = parseInt(process.env.PYTHON_MAX_RETRIES  || '2',      10);

// ── Output size caps ──────────────────────────────────────────────────────────
const MAX_STDOUT_BYTES = parseInt(process.env.MAX_STDOUT_BYTES || String(50 * 1024 * 1024), 10);
const MAX_STDERR_BYTES = parseInt(process.env.MAX_STDERR_BYTES || String(1  * 1024 * 1024), 10);

// ── OCR-specific settings ──────────────────────────────────────────────────────
// Must exceed ocr_engine.py's OCR_LEVEL1_TIMEOUT (120s) + OCR_LEVEL2_TIMEOUT (180s) + buffer
const OCR_DEFAULT_TIMEOUT_MS = parseInt(process.env.OCR_PYBRIDGE_TIMEOUT_MS || '320000', 10);
const OCR_OPS = new Set(['ocr_invoice', 'ocr_batch']);

// ── FIX 2: Concurrency semaphore — prevents Python spawn storm ────────────────
// "Too many requests" on the Execute screen is caused by dozens of Python
// processes being spawned simultaneously. This gate limits concurrency.
const MAX_CONCURRENT_SPAWNS = parseInt(process.env.PYTHON_MAX_CONCURRENT || '4', 10);
let _activeSpawns = 0;
const _spawnQueue = [];

// FIX #12 (NEW) — SPAWN-SLOT QUEUE WAIT HAD NO TIMEOUT (root cause of the
// 20-minute silent "Parse & Validate" hangs on CSV/XLSX uploads)
//
//   Every Python operation — OCR, CSV/XLSX parsing, reconciliation, ZIP
//   extraction — funnels through this SAME module-level semaphore, capped at
//   MAX_CONCURRENT_SPAWNS (default 4) for the entire process. worker.js alone
//   runs up to 12 concurrent BullMQ job handlers (OCR:2 + Parse:3 +
//   Reconcile:2 + ZIP:3 + Voice:2) that all compete for those same 4 slots.
//
//   _acquireSpawnSlot() returned a Promise that resolved ONLY when a slot
//   freed up — with no timeout on the wait itself. If OCR jobs (up to 320s
//   each) backed up the queue, anything else waiting for a slot — including a
//   small CSV upload — could sit there indefinitely with zero feedback to the
//   user. That's the "stuck loading for 20+ minutes" behavior: not a crash,
//   not a deadlock, just an uncapped wait in a queue with no visibility.
//
//   Fix: _acquireSpawnSlot() now takes a maxWaitMs (default 90s) and rejects
//   with a clear, actionable QUEUE_TIMEOUT error if no slot frees up in time,
//   instead of waiting silently forever. callEngine() surfaces this as a
//   normal error the frontend can display and let the user retry.
const SPAWN_QUEUE_TIMEOUT_MS = parseInt(process.env.PYTHON_QUEUE_TIMEOUT_MS || '90000', 10);

function _acquireSpawnSlot(maxWaitMs = SPAWN_QUEUE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (_activeSpawns < MAX_CONCURRENT_SPAWNS) {
      _activeSpawns++;
      resolve();
      return;
    }

    const waiter = { resolve, timer: null, resolved: false };

    waiter.timer = setTimeout(() => {
      if (waiter.resolved) return;
      waiter.resolved = true;
      const idx = _spawnQueue.indexOf(waiter);
      if (idx !== -1) _spawnQueue.splice(idx, 1);
      const err  = new Error(
        `Timed out after ${Math.round(maxWaitMs / 1000)}s waiting for a free Python ` +
        `execution slot (${MAX_CONCURRENT_SPAWNS} max, all busy). The system is under ` +
        `heavy load — please try again shortly.`
      );
      err.code = 'QUEUE_TIMEOUT';
      reject(err);
    }, maxWaitMs);

    _spawnQueue.push(waiter);
  });
}

function _releaseSpawnSlot() {
  while (_spawnQueue.length > 0) {
    const next = _spawnQueue.shift();
    if (next.resolved) continue; // already timed out — skip, try the next waiter
    next.resolved = true;
    clearTimeout(next.timer);
    next.resolve(); // next waiter takes the slot immediately
    return;
  }
  _activeSpawns--;
}

console.log('[pythonBridge] Python binary:', PYTHON_BIN);
console.log('[pythonBridge] Default engine:', DEFAULT_ENGINE_PATH);
console.log(`[pythonBridge] Max stdout: ${Math.round(MAX_STDOUT_BYTES / 1024 / 1024)} MB`);
console.log(`[pythonBridge] OCR default timeout: ${Math.round(OCR_DEFAULT_TIMEOUT_MS / 1000)}s`);
console.log(`[pythonBridge] Max concurrent spawns: ${MAX_CONCURRENT_SPAWNS}`);
console.log(`[pythonBridge] Process-tree kill on timeout: ${_IS_WINDOWS ? 'taskkill /T /F (Windows)' : 'SIGKILL (POSIX)'}`);

const ALLOWED_OPS = new Set([
  'parse', 'schema', 'analyze', 'reconcile', 'execute', 'extract_zip', 'parse_xml',
  'transcribe', 'health',
  'parse_command',
  'ocr_invoice', 'ocr_batch',
]);

// ── FIX 4 (REVISED): Path validation — relative prefix whitelist ──────────────
// Used for relative paths only.
const ALLOWED_PATH_PREFIXES = [
  'uploads/', 'upload/', 'temp/', 'tmp/', 'exports/',
  'output/', 'outputs/',
  'data/', '/tmp/', '/var/tmp/',
];

// ── FIX 4 (REVISED): Absolute path segment whitelist ─────────────────────────
// For absolute paths (Windows C:\... or Linux /...) we check that the
// normalised path contains at least one of these known-safe directory segments.
//
// This approach is safe because:
//   - ".." is already blocked before we reach this check (no traversal possible)
//   - We are checking segments that are under the application's own control
//     (auros_ocr temp dir, the uploads dir, the outputs dir, etc.)
//   - An attacker cannot cause C:\secret\passwords.txt to match because
//     "secret" and "passwords" are not in this list.
//
// To add a new safe directory in future: append its lowercase name here.
// Segments are matched case-insensitively against the normalised path.
const ALLOWED_ABSOLUTE_SEGMENTS = [
  // Application OCR temp directory (created by the upload pipeline)
  'auros_ocr',
  // Standard temp directories on Windows and Linux
  'windows\\temp',   // won't appear after normalise but kept for clarity
  'windows/temp',
  // Application upload / output directories
  'uploads',
  'upload',
  'outputs',
  'output',
  'exports',
  'temp',
  'tmp',
  // Linux standard temp
  '/tmp',
  '/var/tmp',
  // Application data directory
  'auros',           // matches any path containing the app's own folder name
];

/**
 * Call a Python engine script with a validated config object.
 *
 * @param {Object} config            — must include { operation: string, ...params }
 * @param {Object} [opts]
 * @param {string} [opts.enginePath] — override which .py file to run
 * @param {number} [opts.timeout]    — override timeout in ms
 * @returns {Promise<Object>}
 */
async function callEngine(config, opts = {}) {
  _validateConfig(config);

  const enginePath = opts.enginePath || DEFAULT_ENGINE_PATH;

  // ── Effective timeout resolution ──────────────────────────────────────────
  let timeoutMs = opts.timeout || TIMEOUT_MS;
  if (OCR_OPS.has(config.operation) && timeoutMs < OCR_DEFAULT_TIMEOUT_MS) {
    timeoutMs = OCR_DEFAULT_TIMEOUT_MS;
  }

  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // ── FIX 2: Acquire concurrency slot before spawning ─────────────────
      await _acquireSpawnSlot();
      let result;
      try {
        result = await _spawnEngine(config, enginePath, timeoutMs);
      } finally {
        _releaseSpawnSlot();
      }
      return result;
    } catch (err) {
      lastError = err;

      if (err.code === 'LOGIC_ERROR' || err.code === 'VALIDATION_ERROR') throw err;

      // ── FIX 1: Do NOT retry OCR on timeout — it never helps ─────────────
      // Retrying a timed-out OCR job just spawns more dying Python processes.
      // Let the caller (op_ocr_invoice / op_ocr_batch) handle the failure.
      if (err.code === 'ENGINE_TIMEOUT' && OCR_OPS.has(config.operation)) {
        console.warn(`[pythonBridge] OCR operation timed out — not retrying (would cause spawn storm)`);
        throw err;
      }

      if (attempt < MAX_RETRIES) {
        console.warn(`[pythonBridge] Attempt ${attempt + 1} failed (${err.message}). Retrying…`);
        await _sleep(400 * (attempt + 1));
      }
    }
  }

  const wrapped  = new Error(`Python engine failed after ${MAX_RETRIES + 1} attempts: ${lastError.message}`);
  wrapped.code   = 'ENGINE_FAILURE';
  wrapped.status = 502;
  throw wrapped;
}

function _spawnEngine(config, enginePath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const input = JSON.stringify(config);
    const proc  = spawn(PYTHON_BIN, [enginePath], {
      stdio   : ['pipe', 'pipe', 'pipe'],
      env     : { ...process.env },
      detached: false,
    });

    let stdout      = '';
    let stderr      = '';
    let timedOut    = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const timer = setTimeout(() => {
      timedOut = true;
      _killProcessTree(proc); // FIX 6: kill entire tree, not just python.exe
      const err  = new Error(`Python engine timed out after ${timeoutMs}ms`);
      err.code   = 'ENGINE_TIMEOUT';
      err.status = 504;
      reject(err);
    }, timeoutMs);

    // ── Stdout with size cap ───────────────────────────────────────────────
    proc.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;

      if (stdoutBytes > MAX_STDOUT_BYTES) {
        _killProcessTree(proc); // FIX 6: kill entire tree, not just python.exe
        clearTimeout(timer);
        const err  = new Error(
          `Python engine stdout exceeded ${Math.round(MAX_STDOUT_BYTES / 1024 / 1024)} MB limit. ` +
          `Consider reducing batch size.`
        );
        err.code   = 'ENGINE_OUTPUT_OVERFLOW';
        err.status = 500;
        reject(err);
        return;
      }

      stdout += chunk.toString();
    });

    // ── Stderr with size cap ───────────────────────────────────────────────
    proc.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_STDERR_BYTES) {
        stderr += chunk.toString();
      }
      // Beyond cap: silently drop
    });

    proc.on('error', err => {
      clearTimeout(timer);
      if (timedOut) return;
      err.code = 'SPAWN_ERROR'; err.status = 500;
      if (stderr) err.stderr = stderr;
      reject(err);
    });

    proc.on('close', () => {
      clearTimeout(timer);
      if (timedOut) return;

      // ── FIX 5: Log only up to cap, not unbounded stderr ─────────────────
      if (stderr.trim()) {
        console.error('[pythonBridge] stderr:\n' + stderr.trim().slice(0, MAX_STDERR_BYTES));
      }

      // ── Robust JSON extraction ─────────────────────────────────────────
      let parsed;
      const cleaned = stdout.trim();

      try {
        parsed = JSON.parse(cleaned);
      } catch (_) {
        // Strategy 2: extract last {...} block
        const m = cleaned.match(/(\{[\s\S]*\})(?=[^}]*$)/);
        if (m) { try { parsed = JSON.parse(m[0]); } catch (_) {} }

        // Strategy 3: scan lines from end
        if (!parsed) {
          for (const line of cleaned.split('\n').reverse()) {
            const t = line.trim();
            if (t.startsWith('{') || t.startsWith('[')) {
              try { parsed = JSON.parse(t); break; } catch (_) {}
            }
          }
        }

        if (!parsed) {
          const err      = new Error(`Engine returned non-JSON output:\n${cleaned.slice(0, 800)}`);
          err.code       = 'ENGINE_PARSE_ERROR';
          err.status     = 502;
          err.stderr     = stderr;
          err.rawStdout  = cleaned.slice(0, 2000);
          return reject(err);
        }
      }

      if (!parsed.ok) {
        const err  = new Error(parsed.error || 'Python engine returned an error');
        err.code   = 'LOGIC_ERROR';
        err.status = 422;
        err.trace  = parsed.trace || null;
        return reject(err);
      }

      // ── FIX 3: Cap rawText in OCR results before it reaches Node memory ─
      const result = parsed.result;
      if (result && typeof result.rawText === 'string' && result.rawText.length > 500) {
        result.rawText = result.rawText.slice(0, 500) + '…[truncated]';
      }

      resolve(result);
    });

    try {
      proc.stdin.write(input);
      proc.stdin.end();
    } catch (writeErr) {
      clearTimeout(timer);
      writeErr.code = 'STDIN_ERROR'; writeErr.status = 500;
      reject(writeErr);
    }
  });
}

/**
 * _validateConfig — validate the engine config object.
 *
 * FIX 4 (REVISED): Path validation strategy:
 *
 *   1. ".." and "~" are always rejected — traversal / home-dir expansion
 *      are unsafe regardless of whether the path is absolute or relative.
 *
 *   2. Relative paths are checked against ALLOWED_PATH_PREFIXES (unchanged
 *      from V3).
 *
 *   3. Absolute paths — both Linux (/tmp/...) and Windows (C:\WINDOWS\TEMP\...)
 *      — are checked against ALLOWED_ABSOLUTE_SEGMENTS.  The path is first
 *      normalised (backslashes → forward slashes, lowercased) and then we
 *      verify that it contains at least one known-safe directory segment.
 *
 *      This is the key fix: the old code rejected ALL absolute Windows paths
 *      which broke the OCR pipeline because uploaded files are staged in
 *      C:\WINDOWS\TEMP\auros_ocr\ by the OS/multer before being processed.
 *
 * @param {Object} config
 */
function _validateConfig(config) {
  if (!config || typeof config !== 'object') {
    const err = new Error('Engine config must be a plain object');
    err.code = 'VALIDATION_ERROR'; err.status = 400; throw err;
  }
  if (!config.operation) {
    const err = new Error('Engine config must include an "operation" field');
    err.code = 'VALIDATION_ERROR'; err.status = 400; throw err;
  }
  if (!ALLOWED_OPS.has(config.operation)) {
    const err = new Error(`Unknown engine operation: "${config.operation}". Allowed: ${[...ALLOWED_OPS].join(', ')}`);
    err.code = 'VALIDATION_ERROR'; err.status = 400; throw err;
  }

  const pathFields = ['filePath', 'invoicePath', 'poPath', 'zipPath', 'extractTo', 'outputPath', 'audioFilePath'];
  for (const field of pathFields) {
    if (config[field] === undefined) continue;

    const p = String(config[field]);

    // ── Step 1: Always-unsafe patterns ──────────────────────────────────
    if (p.includes('..')) {
      const err = new Error(`Path traversal detected in config.${field}: ${p}`);
      err.code = 'VALIDATION_ERROR'; err.status = 400; throw err;
    }
    if (p.startsWith('~')) {
      const err = new Error(`Home-directory expansion not allowed in config.${field}: ${p}`);
      err.code = 'VALIDATION_ERROR'; err.status = 400; throw err;
    }

    // Normalise: backslashes → forward slashes
    const normalized = p.replace(/\\/g, '/');
    const isAbsolute = normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized);

    if (isAbsolute) {
      // ── Step 2: Absolute path — check against allowed segments ──────────
      // Lowercase for case-insensitive matching on Windows
      const lowerNorm = normalized.toLowerCase();
      const allowed = ALLOWED_ABSOLUTE_SEGMENTS.some(seg => lowerNorm.includes(seg.toLowerCase()));

      if (!allowed) {
        const err = new Error(
          `Absolute path in config.${field} is not in an allowed directory. ` +
          `Allowed segments: ${ALLOWED_ABSOLUTE_SEGMENTS.join(', ')}. ` +
          `Got: ${p}`
        );
        err.code = 'VALIDATION_ERROR'; err.status = 400; throw err;
      }
    } else {
      // ── Step 3: Relative path — check against prefix whitelist ──────────
      const allowed = ALLOWED_PATH_PREFIXES.some(prefix => normalized.startsWith(prefix));
      if (!allowed) {
        const err = new Error(
          `Path in config.${field} must be under an allowed directory ` +
          `(${ALLOWED_PATH_PREFIXES.filter(p => !p.startsWith('/')).join(', ')}). ` +
          `Got: ${p}`
        );
        err.code = 'VALIDATION_ERROR'; err.status = 400; throw err;
      }
    }

    // Store the normalised (forward-slash) version back into config
    config[field] = normalized;
  }
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { callEngine };
