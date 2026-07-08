'use strict';

/**
 * backend/controllers/procurement.controller.js
 *
 * CHANGES FROM V2 (addressing audit findings):
 *
 * [AUDIT #4 - MEDIUM] BULK APPROVE CAP enforced at controller level.
 * approvalIds.length > MAX_BULK_APPROVALS now rejected with 400 before
 * reaching the engine. Comment said 500 but controller never checked it.
 *
 * [AUDIT #5 - MEDIUM] DATASET OWNERSHIP VALIDATION added.
 * _resolveDatasetPath now verifies the entry belongs to req.user.id before
 * returning the path. Cross-user dataset access returns 404 — client learns
 * nothing about whether the ID exists for another user.
 *
 * [AUDIT #2 - HIGH] OWNERSHIP RACE CONDITION MITIGATION.
 * _assertJobOwner is kept at controller level for early rejection, but userId
 * is now forwarded into every engine mutating call (approveItem, rejectItem,
 * bulkApprove, lockApprovalItem) so the engine can re-validate atomically.
 * Engine MUST enforce this internally to close the race window.
 *
 * NOTE — items that require infrastructure changes (not fixable in this layer):
 * [AUDIT #1] In-memory job storage → engine must use PostgreSQL / Redis.
 * [AUDIT #3] In-memory locks → engine must use Redis Redlock.
 * [AUDIT #17] Distributed persistence → entire backend concern.
 * These are documented here but cannot be solved in the controller alone.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * V3 PATCH (applied by Claude — see chat for full explanation):
 *
 *   FIX V3-A — Missing `await` on every engine.* call in this file.
 *     Every exported function in reconciliationEngine.service.js
 *     (getJob, listJobs, approveItem, rejectItem, bulkApprove,
 *     lockApprovalItem, renewLock, releaseLock, executeReconciliation) is
 *     declared `async` and therefore returns a Promise. This controller was
 *     calling almost all of them WITHOUT `await` (only startReconciliation
 *     and the main call inside executeReconciliation were correctly
 *     awaited). Concretely:
 *       - `getJob` compared `job.userId !== req.user.id` where `job` was a
 *         Promise object — `.userId` is undefined on a Promise, so this was
 *         ALWAYS true, meaning GET /api/procurement/:jobId always returned
 *         403 Forbidden, regardless of whether the job existed or who owned
 *         it. This is the endpoint the frontend polls after starting a
 *         reconciliation, so this alone could fully explain a stuck spinner.
 *       - `_assertJobOwner` had the exact same bug (`engine.getJob(jobId)`
 *         unawaited), and is called by lockItem, releaseLock, renewLock,
 *         approveItem, rejectItem, bulkApprove, executeReconciliation,
 *         getSchema, and downloadOutput — so ALL of those 403'd too, before
 *         doing anything else.
 *       - `listJobs` returned `{ jobs: {} }` (an empty Promise-shaped object)
 *         on every call instead of the real array.
 *     Fix: every controller function that calls an engine.* function (or
 *     _assertJobOwner) is now declared `async` and every such call is
 *     `await`ed. _assertJobOwner itself is now `async` and awaits
 *     engine.getJob(). No route paths, status codes, response shapes, or
 *     business logic were changed — only the missing awaits were added.
 * ────────────────────────────────────────────────────────────────────────────
 */

const path   = require('path');
const engine = require('../services/procurement/reconciliationEngine.service');
const audit  = require('../audit/auditLogger.service');

// [AUDIT #4] Controller-level cap — mirrors engine constant, enforced here first.
const MAX_BULK_APPROVALS = 500;

// ── List jobs ────────────────────────────────────────────────────────────────
exports.listJobs = async (req, res, next) => {
  try {
    const jobs = await engine.listJobs(req.user.id);
    res.json({ jobs });
  } catch (err) {
    next(err);
  }
};

// ── Start reconciliation (ASYNC) ─────────────────────────────────────────────
exports.startReconciliation = async (req, res, next) => {
  try {
    const { invoiceDatasetId, poDatasetId } = req.body;

    if (!invoiceDatasetId) {
      return res.status(400).json({ error: 'invoiceDatasetId is required', code: 'MISSING_FIELD' });
    }

    // [AUDIT #5] _resolveDatasetPath validates ownership — returns null if the
    // dataset doesn't exist or belongs to a different user.
    const invoicePath = _resolveDatasetPath(invoiceDatasetId, req);
    if (!invoicePath) {
      return res.status(404).json({ error: 'Invoice dataset not found', code: 'DATASET_NOT_FOUND' });
    }

    // [AUDIT #5] Also validate PO dataset ownership when provided.
    let poPath = null;
    if (poDatasetId) {
      poPath = _resolveDatasetPath(poDatasetId, req);
      if (!poPath) {
        return res.status(404).json({ error: 'PO dataset not found', code: 'DATASET_NOT_FOUND' });
      }
    }

    // Returns immediately — reconciliation runs in background.
    // If BullMQ/Redis available: queued=true, bullJobId provided for polling.
    // If not available: queued=false, synchronous (may be slow on large files).
    const { jobId, bullJobId, queued } = await engine.startReconciliation(
      invoicePath,
      poPath,
      req.user.id
    );

    res.status(202).json({
      jobId,
      bullJobId : bullJobId || null,
      queued,
      status    : 'processing',
      message   : queued
        ? `Reconciliation queued. Poll /api/queue/status/${bullJobId} for progress.`
        : `Reconciliation started. Poll /api/procurement/${jobId} for status.`,
    });
  } catch (err) {
    next(err);
  }
};

// ── Get job ──────────────────────────────────────────────────────────────────
exports.getJob = async (req, res, next) => {
  try {
    const job = await engine.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found', code: 'JOB_NOT_FOUND' });
    }
    if (job.userId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
    }
    res.json(job);
  } catch (err) {
    next(err);
  }
};

// ── Lock item (acquire review lock) ──────────────────────────────────────────
// Call before showing the review UI to the user.
// Prevents another reviewer grabbing the same item simultaneously.
// NOTE [AUDIT #3]: locks must be backed by Redis Redlock in the engine,
// not an in-memory Map, for this to survive pod restarts and horizontal scaling.
exports.lockItem = async (req, res, next) => {
  try {
    const { jobId, approvalId } = req.params;
    await _assertJobOwner(jobId, req);

    // [AUDIT #2] userId forwarded — engine must re-validate atomically.
    const result = await engine.lockApprovalItem(jobId, approvalId, req.user.id);
    if (!result.acquired) {
      return res.status(409).json({
        error    : result.reason,
        code     : 'LOCK_CONFLICT',
        lockedBy : result.lockedBy,
      });
    }
    res.json({ locked: true, approvalId });
  } catch (err) {
    next(err);
  }
};

// ── Release lock (user closed review panel without deciding) ─────────────────
exports.releaseLock = async (req, res, next) => {
  try {
    const { jobId, approvalId } = req.params;
    await _assertJobOwner(jobId, req);
    await engine.releaseLock(jobId, approvalId, req.user.id);
    res.json({ released: true, approvalId });
  } catch (err) {
    next(err);
  }
};

// ── Renew lock (extend TTL while user is still actively reviewing) ────────────
// Call periodically from the review UI (e.g. every 30 s) to prevent the lock
// from expiring while the reviewer is still working on the item.
// NOTE [AUDIT #3]: effective only once engine.renewLock() is backed by
// Redis Redlock — in-memory locks don't expire so renewal is a no-op there.
exports.renewLock = async (req, res, next) => {
  try {
    const { jobId, approvalId } = req.params;
    await _assertJobOwner(jobId, req);

    // [AUDIT #2] userId forwarded — engine must verify the caller still holds
    // the lock before extending it (prevents a different user from renewing).
    const result = await engine.renewLock(jobId, approvalId, req.user.id);

    res.json({
      success    : true,
      approvalId,
      ...result,
    });
  } catch (err) {
    next(err);
  }
};

// ── Approve item ─────────────────────────────────────────────────────────────
exports.approveItem = async (req, res, next) => {
  try {
    const { jobId, approvalId } = req.params;
    const { response, respondedVia } = req.body;

    if (!response) {
      return res.status(400).json({ error: 'response is required', code: 'MISSING_FIELD' });
    }

    await _assertJobOwner(jobId, req);

    // [AUDIT #2] userId forwarded — engine must re-validate ownership atomically.
    await engine.approveItem(jobId, approvalId, response, respondedVia || 'dashboard', req.user.id);

    const updated = await engine.getJob(jobId);
    res.json({ success: true, job: updated });
  } catch (err) {
    // 409 conflict (already resolved or lock conflict) → pass through
    next(err);
  }
};

// ── Reject item ──────────────────────────────────────────────────────────────
exports.rejectItem = async (req, res, next) => {
  try {
    const { jobId, approvalId } = req.params;
    const { reason } = req.body;

    await _assertJobOwner(jobId, req);

    // [AUDIT #2] userId forwarded — engine must re-validate ownership atomically.
    await engine.rejectItem(jobId, approvalId, reason || 'Rejected by user', req.user.id);

    const updated = await engine.getJob(jobId);
    res.json({ success: true, job: updated });
  } catch (err) {
    next(err);
  }
};

// ── Bulk approve ─────────────────────────────────────────────────────────────
// Apply same response to multiple approval items at once.
// [AUDIT #4] Hard-capped at MAX_BULK_APPROVALS (500) per call — enforced here.
exports.bulkApprove = async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const { approvalIds, response, respondedVia } = req.body;

    if (!approvalIds || !Array.isArray(approvalIds)) {
      return res.status(400).json({ error: 'approvalIds array is required', code: 'MISSING_FIELD' });
    }
    if (!response) {
      return res.status(400).json({ error: 'response is required', code: 'MISSING_FIELD' });
    }

    // [AUDIT #4] Enforce cap before any engine work — prevents DoS via huge arrays.
    if (approvalIds.length > MAX_BULK_APPROVALS) {
      return res.status(400).json({
        error    : `approvalIds exceeds maximum of ${MAX_BULK_APPROVALS} items per call`,
        code     : 'BULK_LIMIT_EXCEEDED',
        limit    : MAX_BULK_APPROVALS,
        received : approvalIds.length,
      });
    }

    await _assertJobOwner(jobId, req);

    // [AUDIT #2] userId forwarded — engine must re-validate ownership atomically.
    const result = await engine.bulkApprove(
      jobId,
      approvalIds,
      response,
      respondedVia || 'dashboard',
      req.user.id
    );

    res.json({
      success   : true,
      applied   : result.applied,
      skipped   : result.skipped,
      conflicts : result.conflicts,
      message   : `Applied to ${result.applied} items. ${result.conflicts} conflicts skipped.`,
    });
  } catch (err) {
    next(err);
  }
};

// ── Execute ──────────────────────────────────────────────────────────────────
exports.executeReconciliation = async (req, res, next) => {
  try {
    const { jobId } = req.params;
    await _assertJobOwner(jobId, req);
    const result = await engine.executeReconciliation(jobId);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
};

// ── Audit trail ──────────────────────────────────────────────────────────────
exports.getAuditTrail = async (req, res, next) => {
  try {
    const { jobId } = req.params;
    await _assertJobOwner(jobId, req);

    const format = req.query.format || 'json';

    if (format === 'csv') {
      const csv = audit.exportAsCsv(jobId);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="audit_${jobId}.csv"`);
      return res.send(csv);
    }

    const json = audit.exportAsJson(jobId);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="audit_${jobId}.json"`);
    res.send(json);
  } catch (err) {
    next(err);
  }
};

// ── Schema endpoint ──────────────────────────────────────────────────────────
exports.getSchema = async (req, res, next) => {
  try {
    const { jobId } = req.params;
    await _assertJobOwner(jobId, req);

    const job = await engine.getJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const { detectSchema, formatSchemaForUI } = require('../ingestion/schemaDetector.service');
    const { schema, sampleRows } = await detectSchema(job.invoiceFilePath);

    res.json({
      schema     : formatSchemaForUI(schema),
      sampleRows : sampleRows.slice(0, 5),
    });
  } catch (err) {
    next(err);
  }
};

// ── Download output ──────────────────────────────────────────────────────────
exports.downloadOutput = async (req, res, next) => {
  try {
    const { jobId } = req.params;
    await _assertJobOwner(jobId, req);

    const job = await engine.getJob(jobId);
    if (!job || !job.outputPath) {
      return res.status(404).json({ error: 'Output not ready yet', code: 'OUTPUT_NOT_READY' });
    }

    res.download(job.outputPath, path.basename(job.outputPath));
  } catch (err) {
    next(err);
  }
};

// ── Helpers ──────────────────────────────────────────────────────────────────
async function _assertJobOwner(jobId, req) {
  const job = await engine.getJob(jobId);
  if (!job) {
    const err = new Error('Job not found');
    err.status = 404;
    throw err;
  }
  if (job.userId !== req.user.id) {
    const err = new Error('Forbidden');
    err.status = 403;
    throw err;
  }
}

/**
 * Resolve a datasetId to an absolute file path.
 *
 * [AUDIT #5] Ownership validation: returns null if the dataset does not exist
 * OR if it belongs to a different user. Callers treat null as 404 — the client
 * learns nothing about whether the ID exists for another user (no info leak).
 *
 * @param {string}                        datasetId
 * @param {import('express').Request}     req
 * @returns {string|null}
 */
function _resolveDatasetPath(datasetId, req) {
  try {
    const { datasetStore } = require('./data.controller');
    const entry = datasetStore.get(datasetId);
    if (!entry) return null;

    // [AUDIT #5] Reject cross-user access — treat as not-found to avoid
    // leaking existence of another user's dataset.
    if (entry.userId && entry.userId !== req.user.id) {
      return null;
    }

    return entry.filePath || null;
  } catch (err) {
    // data.controller not loaded yet or datasetId not found
    return null;
  }
}
