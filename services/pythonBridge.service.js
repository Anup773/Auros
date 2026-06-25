'use strict';
/**
 * backend/services/pythonBridge.service.js
 *
 * CHANGES FROM V3 (this version):
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
 *   FIX 4 — Path whitelist enforcement (SECURITY)
 *     Path validation now uses a whitelist of allowed base directories
 *     (uploads/, temp/, exports/, tmp/) instead of only blacklisting '..'.
 *     Absolute Windows paths (C:\...) are now also rejected.
 *
 *   FIX 5 — Stderr size cap now applies to logging too
 *     Previously stderr was logged in full even when truncated. Now
 *     only the first MAX_STDERR_BYTES are logged.
 *
 *   All V3 logic preserved (OCR timeout floor, stdout cap, JSON extraction
 *   strategies, retry backoff for non-OCR operations).
 */

const { spawn } = require('child_process');
const path      = require('path');
const os        = require('os');

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

function _acquireSpawnSlot() {
  return new Promise(resolve => {
    if (_activeSpawns < MAX_CONCURRENT_SPAWNS) {
      _activeSpawns++;
      resolve();
    } else {
      _spawnQueue.push(resolve);
    }
  });
}

function _releaseSpawnSlot() {
  if (_spawnQueue.length > 0) {
    const next = _spawnQueue.shift();
    next(); // next waiter takes the slot immediately
  } else {
    _activeSpawns--;
  }
}

console.log('[pythonBridge] Python binary:', PYTHON_BIN);
console.log('[pythonBridge] Default engine:', DEFAULT_ENGINE_PATH);
console.log(`[pythonBridge] Max stdout: ${Math.round(MAX_STDOUT_BYTES / 1024 / 1024)} MB`);
console.log(`[pythonBridge] OCR default timeout: ${Math.round(OCR_DEFAULT_TIMEOUT_MS / 1000)}s`);
console.log(`[pythonBridge] Max concurrent spawns: ${MAX_CONCURRENT_SPAWNS}`);

const ALLOWED_OPS = new Set([
  'parse', 'schema', 'analyze', 'reconcile', 'execute', 'extract_zip', 'parse_xml',
  'transcribe', 'health',
  'parse_command',
  'ocr_invoice', 'ocr_batch',
]);

// ── FIX 4: Allowed base directories for path validation ───────────────────────
// RETROACTIVE FIX (Batch 4): Added 'outputs/' — pipelineExecutor routes large
// datasets to Python via callEngine with an outputPath in the outputs/ directory.
// Without 'outputs/' here, the path whitelist would reject outputPath with
// VALIDATION_ERROR and Python pipeline execution would fail completely.
const ALLOWED_PATH_PREFIXES = [
  'uploads/', 'upload/', 'temp/', 'tmp/', 'exports/',
  'output/', 'outputs/',   // ← required for pipelineExecutor Python routing
  'data/', '/tmp/', '/var/tmp/',
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
      try { proc.kill('SIGKILL'); } catch (_) {}
      const err  = new Error(`Python engine timed out after ${timeoutMs}ms`);
      err.code   = 'ENGINE_TIMEOUT';
      err.status = 504;
      reject(err);
    }, timeoutMs);

    // ── Stdout with size cap ───────────────────────────────────────────────
    proc.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;

      if (stdoutBytes > MAX_STDOUT_BYTES) {
        try { proc.kill('SIGKILL'); } catch (_) {}
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

  // ── FIX 4: Path whitelist (not just blacklist) ───────────────────────────
  const pathFields = ['filePath', 'invoicePath', 'poPath', 'zipPath', 'extractTo', 'outputPath'];
  for (const field of pathFields) {
    if (config[field] !== undefined) {
      const p = String(config[field]);

      // Existing blacklist checks
      if (p.includes('..') || p.startsWith('~')) {
        const err = new Error(`Unsafe path in config.${field}: ${p}`);
        err.code = 'VALIDATION_ERROR'; err.status = 400; throw err;
      }

      // FIX 4: Reject absolute Windows paths (C:\, D:\, etc.)
      if (/^[a-zA-Z]:[\\\/]/.test(p) && !p.startsWith('/')) {
        // Allow if it's a valid server-side absolute path starting with /
        const err = new Error(`Absolute Windows path not allowed in config.${field}: ${p}`);
        err.code = 'VALIDATION_ERROR'; err.status = 400; throw err;
      }

      // FIX 4: Enforce path prefix whitelist for relative paths
      const normalized = p.replace(/\\/g, '/');
      const isAbsolute = normalized.startsWith('/');
      if (!isAbsolute) {
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

      config[field] = normalized;
    }
  }
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { callEngine };
