'use strict';
/**
 * backend/audit/securityLogger.service.js
 *
 * PHASE 2 — "Audit expansion" + "SOC2-style logging".
 *
 * This is a SIBLING to audit/auditLogger.service.js, not a replacement.
 * auditLogger.service.js already does an excellent job of tracking
 * business/reconciliation events per job (JOB_CREATED, FILE_INGESTED,
 * ITEM_APPROVED, etc.) — that file is untouched.
 *
 * What was missing (confirmed by reading it): there was no log of SECURITY
 * events at all — logins, failed logins, permission denials, role changes,
 * MFA enrollment, API key issuance, webhook rejections, token-reuse
 * detection. That's exactly what SOC2 monitoring criteria (and any
 * post-incident investigation) actually need. This module adds that.
 *
 * ── Design ────────────────────────────────────────────────────────────────
 *   - Structured JSON to stdout (same convention as auditLogger.service.js,
 *     so it flows into whatever log aggregator already ingests this app's
 *     console output).
 *   - Append-only JSON-Lines file per day: logs/security-YYYY-MM-DD.jsonl.
 *     Append-only (not rewritten, unlike auditLogger's per-job snapshot
 *     file) because a security log's value is largely in being a durable,
 *     chronological record that isn't quietly rewritten later.
 *   - Hash-chained: every line includes a SHA-256 hash of itself and of the
 *     previous line. Re-running verifyChainIntegrity() over a day's file
 *     detects whether any line was edited, removed, or reordered after the
 *     fact — a concrete, checkable integrity control, which is the kind of
 *     evidence a SOC2 auditor (or an incident responder) actually wants to
 *     see, rather than just a promise that the log is trustworthy.
 *   - Sensitive fields are redacted before anything is written or logged —
 *     defense in depth in case a caller accidentally passes a raw secret.
 *   - Independent retention window from the business audit trail: SOC2
 *     security logs are typically retained far longer than day-to-day job
 *     logs, so this defaults to 365 days (SECURITY_LOG_RETENTION_DAYS),
 *     not the 90-day default auditLogger.service.js uses for job data.
 *
 * Writes are serialized through an internal promise queue so the hash
 * chain can never fork from two concurrent appends racing each other.
 */

const fs  = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const LOGS_DIR = path.join(__dirname, '../logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

const RETENTION_DAYS = parseInt(process.env.SECURITY_LOG_RETENTION_DAYS || '365', 10);
const LOG_REDACT     = process.env.LOG_REDACT !== 'false'; // same flag auditLogger.service.js uses

// Defense in depth: strip these if a caller ever accidentally includes one.
const SENSITIVE_KEYS = new Set([
  'password', 'passwordHash', 'token', 'accessToken', 'refreshToken',
  'code', 'totpCode', 'secret', 'mfaSecret', 'backupCode', 'backupCodes',
  'apiKey', 'authorization',
]);

const GENESIS_HASH = '0'.repeat(64);

function _redact(fields) {
  if (!LOG_REDACT) return fields;
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    out[k] = SENSITIVE_KEYS.has(k) && v != null ? '[REDACTED]' : v;
  }
  return out;
}

function _dateStr(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function _filePathFor(dateStr) {
  return path.join(LOGS_DIR, `security-${dateStr}.jsonl`);
}

function _lineHash(prevHash, entryWithoutHash) {
  return crypto.createHash('sha256')
    .update(prevHash + JSON.stringify(entryWithoutHash))
    .digest('hex');
}

// ── Chain state — last hash written per date, so appends can continue a
//    chain correctly even across process restarts. ───────────────────────────
const _chainState = new Map(); // dateStr -> lastHash

async function _getLastHashForDate(dateStr) {
  if (_chainState.has(dateStr)) return _chainState.get(dateStr);

  const filePath = _filePathFor(dateStr);
  let lastHash = GENESIS_HASH;
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length > 0) {
      const lastEntry = JSON.parse(lines[lines.length - 1]);
      lastHash = lastEntry.hash || GENESIS_HASH;
    }
  } catch {
    // File doesn't exist yet today — start a fresh chain.
  }
  _chainState.set(dateStr, lastHash);
  return lastHash;
}

// Serialize all appends through one promise chain so hash linkage can't race.
let _writeQueue = Promise.resolve();

function _enqueueWrite(fn) {
  _writeQueue = _writeQueue.then(fn, fn); // run even if a previous write failed
  return _writeQueue;
}

/**
 * Log a security event. Fire-and-forget safe — callers do not need to
 * await this (errors are caught and logged, never thrown back at the caller,
 * so a logging failure can never break an auth/security code path).
 *
 * @param {string} event  e.g. 'LOGIN_SUCCESS', 'PERMISSION_DENIED', 'ROLE_CHANGED'
 * @param {object} fields e.g. { userId, ip, userAgent, severity }
 */
function logSecurityEvent(event, fields = {}) {
  const safeFields = _redact(fields);
  const time = new Date().toISOString();

  const stdoutEntry = { time, level: fields.severity === 'high' || fields.severity === 'critical' ? 'warn' : 'info', service: 'security', event, ...safeFields };
  console.log(JSON.stringify(stdoutEntry));

  return _enqueueWrite(async () => {
    try {
      const dateStr = _dateStr();
      const prevHash = await _getLastHashForDate(dateStr);
      const entryWithoutHash = { time, event, ...safeFields, prevHash };
      const hash = _lineHash(prevHash, entryWithoutHash);
      const entry = { ...entryWithoutHash, hash };

      await fsp.appendFile(_filePathFor(dateStr), JSON.stringify(entry) + '\n', 'utf8');
      _chainState.set(dateStr, hash);
    } catch (err) {
      console.error('[securityLogger] Failed to persist security event (stdout log above is still valid):', err.message);
    }
  }).catch(() => {}); // guarantee this never becomes an unhandled rejection for fire-and-forget callers
}

// ── Convenience wrappers for the most common events ──────────────────────────
const loginSuccess     = (fields) => logSecurityEvent('LOGIN_SUCCESS', fields);
const loginFailed      = (fields) => logSecurityEvent('LOGIN_FAILED', { severity: 'medium', ...fields });
const logout           = (fields) => logSecurityEvent('LOGOUT', fields);
const permissionDenied = (fields) => logSecurityEvent('PERMISSION_DENIED', { severity: 'medium', ...fields });
const roleChanged      = (fields) => logSecurityEvent('ROLE_CHANGED', { severity: 'high', ...fields });

/**
 * Re-walk a day's log file and confirm the hash chain is unbroken.
 * Returns { valid, totalLines, brokenAtLine } — brokenAtLine is 1-indexed,
 * null if the file is fully intact (or doesn't exist / is empty).
 */
async function verifyChainIntegrity(dateStr = _dateStr()) {
  const filePath = _filePathFor(dateStr);
  let raw;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch {
    return { valid: true, totalLines: 0, brokenAtLine: null, note: 'No log file for this date.' };
  }

  const lines = raw.split('\n').filter(Boolean);
  let prevHash = GENESIS_HASH;

  for (let i = 0; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      return { valid: false, totalLines: lines.length, brokenAtLine: i + 1, reason: 'Unparseable line (possible truncation/corruption).' };
    }
    const { hash, ...rest } = entry;
    if (rest.prevHash !== prevHash) {
      return { valid: false, totalLines: lines.length, brokenAtLine: i + 1, reason: 'prevHash does not match preceding line (line removed, reordered, or edited).' };
    }
    const recomputed = _lineHash(prevHash, rest);
    if (recomputed !== hash) {
      return { valid: false, totalLines: lines.length, brokenAtLine: i + 1, reason: 'Stored hash does not match recomputed hash (line contents were edited).' };
    }
    prevHash = hash;
  }

  return { valid: true, totalLines: lines.length, brokenAtLine: null };
}

/** Read back a day's events (for an admin "security log" view / export). */
async function getEvents(dateStr = _dateStr()) {
  const filePath = _filePathFor(dateStr);
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

// ── Retention sweep (same pattern as audit/auditLogger.service.js) ───────────
async function _runRetentionSweep() {
  try {
    const entries  = await fsp.readdir(LOGS_DIR);
    const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let deleted = 0;

    await Promise.all(
      entries
        .filter(f => f.startsWith('security-') && f.endsWith('.jsonl'))
        .map(async (f) => {
          const fp = path.join(LOGS_DIR, f);
          try {
            const stat = await fsp.stat(fp);
            if (stat.mtimeMs < cutoffMs) { await fsp.unlink(fp); deleted++; }
          } catch { /* ignore races with concurrent cleanup */ }
        })
    );
    if (deleted > 0) console.log(`[securityLogger] Retention sweep: deleted ${deleted} file(s) older than ${RETENTION_DAYS} days.`);
  } catch (err) {
    console.error('[securityLogger] Retention sweep failed:', err.message);
  }
}
const _initialSweepTimer = setTimeout(() => _runRetentionSweep(), 10_000); // stagger slightly after auditLogger's own 5s sweep
if (_initialSweepTimer.unref) _initialSweepTimer.unref();
const _sweepInterval = setInterval(() => _runRetentionSweep(), 24 * 60 * 60 * 1000);
if (_sweepInterval.unref) _sweepInterval.unref();

/** Resolves once every write enqueued so far has finished (success or failure). */
function flush() {
  return _writeQueue.catch(() => {});
}

module.exports = {
  logSecurityEvent,
  loginSuccess,
  loginFailed,
  logout,
  permissionDenied,
  roleChanged,
  verifyChainIntegrity,
  getEvents,
  flush,
};
