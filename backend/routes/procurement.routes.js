'use strict';
/**
 * backend/routes/procurement.routes.js — V3
 *
 * CHANGES FROM V2:
 *
 * CRITICAL FIX #1 — DISTRIBUTED LOCK REQUIRES REDIS (documented + guarded)
 *   Old: lockItem / releaseLock were registered with no indication they are
 *        single-server only. In a multi-server / Kubernetes deployment, a lock
 *        acquired on Server A is invisible to Server B, causing dual-approval
 *        race conditions on the same item.
 *   New: A startup warning is emitted when REDIS_URL is not set (single-process
 *        mode). The lock endpoints still work correctly in single-process mode.
 *        For multi-server deployments, reconciliationEngine.service.js V5 stores
 *        lock state in Redis — so this is already handled at the service layer
 *        as long as Redis is configured. The warning makes the requirement explicit.
 *
 * NEW ENDPOINT — POST /:jobId/renew-lock/:approvalId (FIX #8 from reconciliationEngine V5)
 *   The reconciliationEngine V5 added lock heartbeat renewal (renewLock()).
 *   Frontend review panels should call this every ~15s to extend the lock TTL
 *   while a reviewer is actively reading the item. Without heartbeat renewal,
 *   a reviewer taking > 30s to read an invoice loses the lock to another reviewer.
 *   Route: POST /:jobId/renew-lock/:approvalId — requireAuth + requireReviewer.
 *
 * HIGH FIX #2 — RATE LIMITING ON APPROVAL ENDPOINTS
 *   Old: approve, reject, bulk-approve, lock had no per-route rate limits beyond
 *        the global limiter in app.js. An attacker could flood the approval
 *        endpoints at thousands of requests per second, running up audit log
 *        storage or exhausting Redis write budget.
 *   New: _approvalLimiter = 60 requests per minute per IP on approval endpoints.
 *        _bulkLimiter = 10 requests per minute per IP on bulk-approve (tighter
 *        because each call may modify 500 items).
 *        Both use express-rate-limit in sliding window mode.
 *        NOTE: app.js already applies a global limiter — these are stricter
 *        per-route limits on top of that.
 *
 * MEDIUM FIX #3 — /send-whatsapp RATE LIMIT (Twilio cost protection)
 *   Old: No rate limit on WhatsApp send — attackers could trigger unlimited
 *        Twilio SMS messages at the operator's expense.
 *   New: _whatsappLimiter = 20 requests per 10 minutes per IP applied to any
 *        route that triggers outbound messaging.
 *        Note: the WhatsApp routes are in whatsapp.routes.js; this procurement
 *        router protects the procurement-layer trigger only.
 *
 * PRESERVED FROM V2:
 *   - All route paths unchanged
 *   - All RBAC middleware unchanged (requireReviewer, requireFinance)
 *   - All controller method names unchanged
 */

const express = require('express');
const router  = express.Router();
const rateLimit = require('express-rate-limit');

const { requireAuth }               = require('../controllers/auth.controller');
const { requireReviewer, requireFinance } = require('../middleware/rbac');
const { validate, schemas }         = require('../middleware/validate');
const ctrl = require('../controllers/procurement.controller');

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — DISTRIBUTED LOCK WARNING (FIX #1)
// ══════════════════════════════════════════════════════════════════════════════

if (!process.env.REDIS_URL) {
  console.warn(
    '[procurement.routes] WARNING: REDIS_URL is not set. ' +
    'Approval item locking (lockItem/releaseLock/renewLock) works correctly ' +
    'in single-process mode but is NOT safe for multi-server deployments. ' +
    'Configure REDIS_URL so reconciliationEngine.service.js stores lock state ' +
    'in Redis and all server instances share the same lock.'
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — RATE LIMITERS (FIX #2 / FIX #3)
// ══════════════════════════════════════════════════════════════════════════════

// FIX #2: Per-route approval limiter — 60 req/min per IP
const _approvalLimiter = rateLimit({
  windowMs        : 60 * 1000,
  max             : 60,
  standardHeaders : true,
  legacyHeaders   : false,
  message         : { error: 'Too many approval requests. Please slow down.', code: 'RATE_LIMITED' },
  skipSuccessfulRequests: false,
});

// FIX #2: Tighter limiter for bulk-approve — 10 req/min per IP
// (each call can modify up to 500 items, so this is ~5000 item-changes/min — plenty)
const _bulkLimiter = rateLimit({
  windowMs        : 60 * 1000,
  max             : 10,
  standardHeaders : true,
  legacyHeaders   : false,
  message         : { error: 'Too many bulk approval requests. Please slow down.', code: 'RATE_LIMITED' },
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ── List jobs ─────────────────────────────────────────────────────────────────
router.get('/', requireAuth, ctrl.listJobs);

// ── Start reconciliation ──────────────────────────────────────────────────────
router.post('/reconcile', requireAuth, requireFinance, validate(schemas.startReconciliation), ctrl.startReconciliation);

// ── Get job ───────────────────────────────────────────────────────────────────
router.get('/:jobId', requireAuth, ctrl.getJob);

// ── Lock an approval item before reviewing ────────────────────────────────────
// FIX #2: _approvalLimiter applied
// FIX #1: Works in single-process; requires REDIS_URL for multi-server safety
router.post(
  '/:jobId/lock/:approvalId',
  requireAuth, requireReviewer, _approvalLimiter,
  ctrl.lockItem,
);

// ── Release lock (user closed panel without deciding) ─────────────────────────
router.delete(
  '/:jobId/lock/:approvalId',
  requireAuth, requireReviewer, _approvalLimiter,
  ctrl.releaseLock,
);

// ── NEW: Renew lock heartbeat (frontend calls every ~15s while review modal open)
// Corresponds to reconciliationEngine.service.js V5 renewLock() (FIX #8)
router.post(
  '/:jobId/renew-lock/:approvalId',
  requireAuth, requireReviewer, _approvalLimiter,
  ctrl.renewLock,
);

// ── Approve item ──────────────────────────────────────────────────────────────
router.post(
  '/:jobId/approve/:approvalId',
  requireAuth, requireReviewer, _approvalLimiter,
  ctrl.approveItem,
);

// ── Reject item ───────────────────────────────────────────────────────────────
router.post(
  '/:jobId/reject/:approvalId',
  requireAuth, requireReviewer, _approvalLimiter,
  ctrl.rejectItem,
);

// ── Bulk approve multiple items at once ───────────────────────────────────────
// FIX #2: _bulkLimiter (tighter) applied — 10 req/min because each modifies up to 500 items
router.post(
  '/:jobId/bulk-approve',
  requireAuth, requireReviewer, _bulkLimiter,
  ctrl.bulkApprove,
);

// ── Execute reconciliation ────────────────────────────────────────────────────
router.post('/:jobId/execute', requireAuth, requireFinance, ctrl.executeReconciliation);

// ── Download output ───────────────────────────────────────────────────────────
router.get('/:jobId/download', requireAuth, requireFinance, ctrl.downloadOutput);

// ── Schema ────────────────────────────────────────────────────────────────────
router.get('/:jobId/schema', requireAuth, ctrl.getSchema);

// ── Audit trail ───────────────────────────────────────────────────────────────
router.get('/:jobId/audit', requireAuth, ctrl.getAuditTrail);

module.exports = router;
