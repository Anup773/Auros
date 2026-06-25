'use strict';
/**
 * backend/audit/auditLogger.service.js
 *
 * CHANGES FROM V2 (addressing audit findings):
 *
 *   [AUDIT #1 - HIGH] GLOBAL MEMORY CAP added (MAX_JOBS_IN_MEMORY).
 *     V2 capped entries per job at 2000 but never capped the number of jobs
 *     in the Map. At 50k jobs/day the Map grows without bound and the process
 *     OOMs. Fix: when auditStore exceeds MAX_JOBS_IN_MEMORY, the oldest
 *     completed job is evicted before inserting a new one. Active (non-completed)
 *     jobs are never evicted mid-run.
 *
 *   [AUDIT #2 - HIGH] ASYNC DISK WRITES replace fs.writeFileSync.
 *     Completion path previously blocked the event loop while serialising up
 *     to 2000 entries and writing to disk. Under concurrent job completions
 *     this caused visible API latency spikes. All disk I/O is now via
 *     fs.promises (writeFile, readFile, access, readdir, unlink).
 *
 *   [AUDIT #3 - HIGH] LOG RETENTION / DISK CLEANUP added.
 *     audit_*.json files in logs/ were never deleted. After months of operation
 *     the directory fills and the server crashes. A daily retention sweep now
 *     deletes files older than LOG_RETENTION_DAYS (default 90). Runs at startup
 *     and then every 24 hours. Configurable via env.
 *
 *   [AUDIT #4 - MEDIUM] STRUCTURED LOG FIELD REDACTION.
 *     Raw financial values (invoiceAmount, vendorName, approvalResponse) were
 *     emitted to stdout in plain JSON — a compliance risk in environments where
 *     logs are shipped to third-party aggregators. All potentially sensitive
 *     fields are now redacted from console output via _redact(). The full
 *     unredacted data is still written to the on-disk audit JSON (which is
 *     access-controlled at the OS level). Set LOG_REDACT=false to disable
 *     redaction in local dev.
 *
 *   V2 fixes retained:
 *     - Per-job entry cap (MAX_ENTRIES_PER_JOB = 2000)
 *     - TTL-based in-memory eviction of completed jobs (24 h)
 *     - Structured JSON log lines compatible with log aggregators
 */

const fs   = require('fs');
const fsp  = require('fs').promises;
const path = require('path');

// ── Directories ───────────────────────────────────────────────────────────────

const LOGS_DIR = path.join(__dirname, '../logs');

// Create synchronously at startup only — not in any hot path.
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// ── Config ────────────────────────────────────────────────────────────────────

const MAX_ENTRIES_PER_JOB = parseInt(process.env.AUDIT_MAX_ENTRIES  || '2000', 10);
const MAX_JOBS_IN_MEMORY  = parseInt(process.env.AUDIT_MAX_JOBS     || '5000', 10); // [AUDIT #1]
const JOB_AUDIT_TTL_MS   = parseInt(process.env.AUDIT_JOB_TTL_HOURS|| '24',   10) * 60 * 60 * 1000;
const LOG_RETENTION_DAYS  = parseInt(process.env.LOG_RETENTION_DAYS  || '90',   10); // [AUDIT #3]
const LOG_LEVEL           = process.env.LOG_LEVEL   || 'info';
const LOG_REDACT          = process.env.LOG_REDACT  !== 'false';                     // [AUDIT #4]
const LOG_ENABLED         = ['debug', 'info'].includes(LOG_LEVEL);

// Fields whose values are replaced with '[REDACTED]' in console output.
// [AUDIT #4] Prevents financial / PII data leaking into log aggregators.
const SENSITIVE_FIELDS = new Set([
  'previousValue', 'newValue', 'aiExplanation',
  'invoiceAmount', 'vendorName', 'approvalResponse', 'response',
  'question', 'sourceFile',
]);

// ── Structured logger ─────────────────────────────────────────────────────────

function _log(level, action, fields) {
  if (!LOG_ENABLED && level === 'debug') return;

  const safe = LOG_REDACT ? _redact(fields) : fields; // [AUDIT #4]

  const entry = {
    time   : new Date().toISOString(),
    level,
    service: 'auditLogger',
    action,
    ...safe,
  };
  console.log(JSON.stringify(entry));
}

/**
 * [AUDIT #4] Replace values of sensitive keys with '[REDACTED]' for console output.
 * Non-sensitive fields (jobId, userId, rowCount, counts, etc.) pass through unchanged.
 *
 * @param {Object} fields
 * @returns {Object}
 */
function _redact(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = SENSITIVE_FIELDS.has(k) && v !== null && v !== undefined
      ? '[REDACTED]'
      : v;
  }
  return out;
}

// ── In-memory store ───────────────────────────────────────────────────────────
// Map<jobId, AuditEntry[]>

const auditStore = new Map();

// Track insertion order for LRU-style eviction — Map preserves insertion order.
// When MAX_JOBS_IN_MEMORY is reached we evict the oldest COMPLETED job.

// ── TTL-based eviction of completed jobs (hourly) ─────────────────────────────

setInterval(() => {
  const now     = Date.now();
  let   removed = 0;
  for (const [jobId, entries] of auditStore.entries()) {
    if (!entries.length) continue;
    const lastEntry = entries[entries.length - 1];
    if (
      lastEntry.action === 'JOB_COMPLETED' &&
      now - new Date(lastEntry.timestamp).getTime() > JOB_AUDIT_TTL_MS
    ) {
      auditStore.delete(jobId);
      removed++;
    }
  }
  if (removed > 0) _log('info', 'AUDIT_TTL_EVICTION', { removedJobs: removed });
}, 60 * 60 * 1000).unref?.();

// ── [AUDIT #3] Log retention sweep ───────────────────────────────────────────

async function _runRetentionSweep() {
  try {
    const entries  = await fsp.readdir(LOGS_DIR);
    const cutoffMs = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let   deleted  = 0;
    let   errors   = 0;

    await Promise.all(
      entries
        .filter(f => f.startsWith('audit_') && f.endsWith('.json'))
        .map(async (f) => {
          const fp = path.join(LOGS_DIR, f);
          try {
            const stat = await fsp.stat(fp);
            if (stat.mtimeMs < cutoffMs) {
              await fsp.unlink(fp);
              deleted++;
            }
          } catch {
            errors++;
          }
        })
    );

    if (deleted > 0 || errors > 0) {
      _log('info', 'AUDIT_RETENTION_SWEEP', {
        deleted, errors, retentionDays: LOG_RETENTION_DAYS,
      });
    }
  } catch (err) {
    _log('error', 'AUDIT_RETENTION_SWEEP_FAILED', { error: err.message });
  }
}

// Run at startup (5 s delay to avoid competing with server boot)
setTimeout(() => _runRetentionSweep(), 5_000);

// Run daily
setInterval(() => _runRetentionSweep(), 24 * 60 * 60 * 1000).unref?.();

// ── Public API ────────────────────────────────────────────────────────────────

function initJob(jobId, meta = {}) {
  // [AUDIT #1] Enforce global job cap before inserting.
  _enforceJobCap();

  auditStore.set(jobId, []);
  _append(jobId, {
    action         : 'JOB_CREATED',
    userId         : meta.userId     || 'unknown',
    sourceFile     : meta.sourceFile || null,
    jobType        : meta.jobType    || 'unknown',
    aiExplanation  : null,
    previousValue  : null,
    newValue       : null,
    executionResult: null,
    executionStep  : null,
    issueType      : null,
    respondedVia   : null,
  });

  _log('info', 'JOB_CREATED', {
    jobId,
    userId    : meta.userId,
    sourceFile: meta.sourceFile,  // redacted in console if LOG_REDACT=true
    jobType   : meta.jobType,
  });
}

function logIngestion(jobId, userId, { sourceFile, rowCount, warnings = [], schema = {} }) {
  _append(jobId, {
    action         : 'FILE_INGESTED',
    userId,
    sourceFile,
    previousValue  : null,
    newValue       : { rowCount, columnCount: Object.keys(schema).length },
    aiExplanation  : null,
    executionStep  : 'ingestion',
    issueType      : null,
    respondedVia   : null,
    executionResult: warnings.length > 0
      ? `Ingested with ${warnings.length} warning(s)`
      : 'Ingested successfully',
  });

  _log('info', 'FILE_INGESTED', {
    jobId, userId,
    sourceFile,       // redacted in console
    rowCount,
    warnings: warnings.length,
  });
}

function logAiQuestion(jobId, userId, { issueType, question, aiExplanation, affectedRows }) {
  _append(jobId, {
    action         : 'AI_QUESTION_GENERATED',
    userId,
    issueType,
    sourceFile     : null,
    previousValue  : null,
    newValue       : { question },
    aiExplanation  : aiExplanation || question,
    executionStep  : 'ai_review',
    respondedVia   : null,
    executionResult: null,
    meta           : { affectedRows },
  });

  // [AUDIT #4] question/aiExplanation omitted from log — may contain invoice detail
  _log('debug', 'AI_QUESTION_GENERATED', { jobId, userId, issueType, affectedRows });
}

function logApproval(jobId, userId, {
  approvalId, issueType, question, response,
  status, respondedVia, affectedRows, riskLevel,
}) {
  _append(jobId, {
    action         : status === 'approved' ? 'ITEM_APPROVED' : 'ITEM_REJECTED',
    userId,
    issueType,
    sourceFile     : null,
    previousValue  : { question },
    newValue       : { response },
    aiExplanation  : null,
    executionStep  : 'approval',
    respondedVia   : respondedVia || 'dashboard',
    executionResult: `${status} — ${response}`,
    meta           : { approvalId, affectedRows, riskLevel },
  });

  // [AUDIT #4] response/question omitted — may contain financial data
  _log('info', status === 'approved' ? 'ITEM_APPROVED' : 'ITEM_REJECTED', {
    jobId, userId, approvalId, issueType,
    respondedVia, riskLevel, affectedRows,
  });
}

function logExecution(jobId, userId, {
  stepIndex, stepAction, rowsAffected,
  outputPath, success, error,
}) {
  _append(jobId, {
    action         : success ? 'STEP_EXECUTED' : 'STEP_FAILED',
    userId,
    issueType      : null,
    sourceFile     : null,
    previousValue  : null,
    newValue       : { outputPath, rowsAffected },
    aiExplanation  : null,
    executionStep  : `step_${stepIndex}`,
    respondedVia   : null,
    executionResult: success
      ? `Step ${stepIndex} executed: ${stepAction} — ${rowsAffected} rows affected`
      : `Step ${stepIndex} failed: ${error}`,
  });

  _log(success ? 'info' : 'error', success ? 'STEP_EXECUTED' : 'STEP_FAILED', {
    jobId, userId, stepIndex, stepAction, rowsAffected, error: error || null,
  });
}

function logCompletion(jobId, userId, { outputPath, outputRows, excludedRows }) {
  _append(jobId, {
    action         : 'JOB_COMPLETED',
    userId,
    issueType      : null,
    sourceFile     : null,
    previousValue  : null,
    newValue       : { outputPath, outputRows, excludedRows },
    aiExplanation  : null,
    executionStep  : 'completion',
    respondedVia   : null,
    executionResult: `Output: ${outputRows} rows written, ${excludedRows} excluded`,
  });

  _log('info', 'JOB_COMPLETED', {
    jobId, userId, outputRows, excludedRows,
    // [AUDIT #4] Only log basename, not full path (may expose internal fs structure)
    outputFile: path.basename(outputPath || ''),
  });

  // [AUDIT #2] Async disk write — does NOT block the event loop.
  _persistToDiskAsync(jobId).catch(err => {
    _log('error', 'AUDIT_PERSIST_FAILED', { jobId, error: err.message });
  });
}

function getAuditTrail(jobId) {
  if (auditStore.has(jobId)) return auditStore.get(jobId);
  // Async load is not possible here (sync API surface) — keep sync disk read
  // as a fallback for the GET /audit endpoint only.
  return _loadFromDiskSync(jobId) || [];
}

function exportAsCsv(jobId) {
  const entries = getAuditTrail(jobId);
  if (!entries.length) return '';

  const headers = [
    'timestamp', 'jobId', 'action', 'userId', 'issueType',
    'executionStep', 'respondedVia', 'executionResult', 'aiExplanation',
  ];

  const rows = entries.map(e =>
    headers.map(h => {
      const val = h === 'jobId' ? jobId : (e[h] ?? '');
      const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
      return str.includes(',') || str.includes('"') || str.includes('\n')
        ? `"${str.replace(/"/g, '""')}"`
        : str;
    }).join(',')
  );

  return [headers.join(','), ...rows].join('\n');
}

function exportAsJson(jobId) {
  const entries = getAuditTrail(jobId);
  return JSON.stringify({ jobId, generatedAt: new Date().toISOString(), entries }, null, 2);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _append(jobId, fields) {
  if (!auditStore.has(jobId)) auditStore.set(jobId, []);

  const entries = auditStore.get(jobId);
  entries.push({ timestamp: new Date().toISOString(), ...fields });

  // Per-job entry cap — prune oldest when exceeded
  if (entries.length > MAX_ENTRIES_PER_JOB) {
    entries.splice(0, entries.length - MAX_ENTRIES_PER_JOB);
  }
}

/**
 * [AUDIT #1] Enforce global job count cap.
 *
 * When the store is at capacity, evict the oldest COMPLETED job.
 * If no completed jobs exist (all active), log a warning and do nothing —
 * we never evict a running job.
 */
function _enforceJobCap() {
  if (auditStore.size < MAX_JOBS_IN_MEMORY) return;

  // Walk Map in insertion order — first completed job found is the oldest.
  for (const [jobId, entries] of auditStore.entries()) {
    const last = entries[entries.length - 1];
    if (last && last.action === 'JOB_COMPLETED') {
      auditStore.delete(jobId);
      _log('debug', 'AUDIT_JOB_EVICTED', { jobId, reason: 'job_cap_reached' });
      return;
    }
  }

  // All jobs in memory are still active — can't safely evict. Log a warning.
  _log('warn', 'AUDIT_JOB_CAP_FULL', {
    size : auditStore.size,
    cap  : MAX_JOBS_IN_MEMORY,
    note : 'All in-memory jobs are still active. Consider raising AUDIT_MAX_JOBS or adding persistent storage.',
  });
}

/**
 * [AUDIT #2] Async disk persistence — does not block the event loop.
 *
 * @param {string} jobId
 */
async function _persistToDiskAsync(jobId) {
  const filePath = path.join(LOGS_DIR, `audit_${jobId}.json`);
  const data     = exportAsJson(jobId);
  await fsp.writeFile(filePath, data, 'utf8');
  _log('debug', 'AUDIT_PERSISTED', { jobId });
}

/**
 * Synchronous disk fallback used only in getAuditTrail() when the job
 * is not in memory. This is a read path called by the audit export endpoint,
 * not the hot completion path, so sync is acceptable here.
 *
 * @param {string} jobId
 * @returns {Array|null}
 */
function _loadFromDiskSync(jobId) {
  try {
    const filePath = path.join(LOGS_DIR, `audit_${jobId}.json`);
    if (!fs.existsSync(filePath)) return null;
    const raw  = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    return data.entries || [];
  } catch (_) {
    return null;
  }
}

module.exports = {
  initJob,
  logIngestion,
  logAiQuestion,
  logApproval,
  logExecution,
  logCompletion,
  getAuditTrail,
  exportAsCsv,
  exportAsJson,
};
