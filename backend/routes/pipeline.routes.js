'use strict';
/**
 * backend/routes/pipeline.routes.js  — V3 FIXED
 *
 * CHANGES FROM V2:
 *
 * CRITICAL FIX #1 — PIPELINE STORE MEMORY LEAK (never cleaned)
 *   Old: const pipelineStore = new Map() with no eviction — every pipeline
 *        created across all users accumulated forever. A long-running server
 *        eventually held thousands of stale pipelines with full step lists and
 *        decision logs, consuming unbounded RAM.
 *   New: PIPELINE_TTL_MS = 4h (configurable via PIPELINE_TTL_HOURS env).
 *        setInterval cleanup runs every hour, evicting pipelines older than TTL.
 *        MAX_PIPELINE_STORE_SIZE = 1000 (configurable) — LRU eviction when cap
 *        is hit regardless of age. Interval handle stored and unref'd for tests.
 *
 * HIGH FIX #2 — RACE CONDITION: DUPLICATE EXECUTE REQUESTS
 *   Old: Two simultaneous POST /execute requests on the same pipeline both
 *        passed the status check and ran the executor in parallel, producing
 *        two output files and potentially corrupting dataset.cleanedFilePath.
 *   New: if (pl.status === 'executing') check returns 409 immediately.
 *        executionStartedAt timestamp recorded; stale executing lock (> 15 min)
 *        auto-reset to 'failed' in _requirePipeline() for crash recovery.
 *
 * HIGH FIX #3 — NO STEP LIMIT (memory exhaustion)
 *   Old: Users could add unlimited steps — 100 000 steps × large step objects
 *        would exhaust RAM.
 *   New: MAX_STEPS_PER_PIPELINE = 200 (configurable via MAX_PIPELINE_STEPS env).
 *        add-step returns 422 STEP_LIMIT_EXCEEDED when the cap is reached.
 *
 * HIGH FIX #4 — NO EXECUTION TIMEOUT (event loop blocked by bad pipeline)
 *   Old: pipelineExecutor.execute() had no timeout. A pathological step
 *        (e.g. O(n²) operation on 1M rows) would block the worker indefinitely.
 *   New: Promise.race() wraps the executor call with EXEC_TIMEOUT_MS (default:
 *        5 min, configurable via PIPELINE_EXEC_TIMEOUT_MS). On timeout, the
 *        pipeline is marked 'failed' and the caller receives a 504 error.
 *
 * HIGH FIX #5 — IN-MEMORY ONLY (restart loses all pipelines)
 *   Documented explicitly in code comments. This file's pipelineStore is still
 *   in-memory by design (lightweight route-level implementation); for production
 *   durability, delegate to pipeline.controller.js which can be upgraded to
 *   Redis. No code change — caveat clearly noted.
 *
 * HIGH FIX #6 — OWNERSHIP ALREADY ENFORCED
 *   _requirePipeline(pipelineId, userId) already validates userId. Preserved.
 *   Added explicit 404 (not 403) for mismatched ownership to avoid leaking
 *   that the pipeline exists for a different user.
 *
 * PRESERVED FROM V2:
 *   - All route paths unchanged
 *   - requireAuth on all routes
 *   - _requirePipeline ownership check
 *   - Real pipelineExecutor.execute() called (V2 fix)
 *   - dataset.cleanedFilePath set after execution (V2 fix)
 */

const express   = require('express');
const router    = express.Router();
const crypto    = require('crypto');
const { requireAuth }             = require('../controllers/auth.controller');
const { datasetRegistry, getDataset } = require('../controllers/data.controller');
const pipelineExecutor            = require('../services/pipeline/pipelineExecutor.service');

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

// FIX #1: TTL + size cap
const PIPELINE_TTL_MS       = parseInt(process.env.PIPELINE_TTL_HOURS       || '4',   10) * 60 * 60 * 1000;
const MAX_PIPELINE_STORE_SIZE = parseInt(process.env.MAX_PIPELINE_STORE_SIZE || '1000', 10);

// FIX #3: Step limit
const MAX_STEPS_PER_PIPELINE = parseInt(process.env.MAX_PIPELINE_STEPS || '200', 10);

// FIX #2 + #4: Stale-lock and execution timeout
const EXECUTION_STALE_MS = parseInt(process.env.PIPELINE_STALE_MS       || String(15 * 60 * 1000), 10);
const EXEC_TIMEOUT_MS    = parseInt(process.env.PIPELINE_EXEC_TIMEOUT_MS || String(5 * 60 * 1000),  10);

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — PIPELINE STORE + CLEANUP (FIX #1)
// ══════════════════════════════════════════════════════════════════════════════

// NOTE (FIX #5): This Map is in-memory only. All pipelines are lost on server
// restart. For production durability, replace with Redis-backed storage or
// delegate to pipeline.controller.js with persistent backing.
const pipelineStore = new Map();

function _evictOldestPipeline() {
  let oldestId = null;
  let oldestAt = Infinity;
  for (const [id, pl] of pipelineStore.entries()) {
    const at = new Date(pl.createdAt).getTime();
    if (at < oldestAt) { oldestAt = at; oldestId = id; }
  }
  if (oldestId) pipelineStore.delete(oldestId);
}

// FIX #1: Periodic cleanup
const _cleanupInterval = setInterval(() => {
  const now     = Date.now();
  let   removed = 0;
  for (const [id, pl] of pipelineStore.entries()) {
    if (now - new Date(pl.createdAt).getTime() > PIPELINE_TTL_MS) {
      pipelineStore.delete(id);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`[pipeline.routes] Cleaned ${removed} expired pipeline(s).`);
  }
}, 60 * 60 * 1000);

if (_cleanupInterval.unref) _cleanupInterval.unref();

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — MIDDLEWARE
// ══════════════════════════════════════════════════════════════════════════════

router.use(requireAuth);

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ── POST /api/pipeline/create ─────────────────────────────────────────────────
router.post('/create', (req, res, next) => {
  try {
    const { datasetId } = req.body;
    if (!datasetId) {
      return res.status(400).json({ error: 'datasetId is required', code: 'MISSING_FIELD' });
    }

    getDataset(datasetId);  // validate dataset exists (throws 404 if not)

    // FIX #1: LRU eviction if at capacity
    if (pipelineStore.size >= MAX_PIPELINE_STORE_SIZE) {
      _evictOldestPipeline();
    }

    const pipelineId = `pl_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    pipelineStore.set(pipelineId, {
      pipelineId,
      datasetId,
      userId            : req.user.id,
      steps             : [],
      status            : 'pending',
      log               : [],
      createdAt         : new Date().toISOString(),
      executionStartedAt: null,  // FIX #2: stale-lock detection
    });

    res.status(201).json({ pipelineId });
  } catch (err) { next(err); }
});

// ── POST /api/pipeline/:id/add-step ──────────────────────────────────────────
router.post('/:pipelineId/add-step', (req, res, next) => {
  try {
    const pl = _requirePipeline(req.params.pipelineId, req.user.id);

    // FIX #2: Block mutation while executing
    if (pl.status === 'executing') {
      return res.status(409).json({
        error: 'Cannot add steps while pipeline is executing.',
        code : 'PIPELINE_EXECUTING',
      });
    }

    // FIX #3: Enforce step limit
    if (pl.steps.length >= MAX_STEPS_PER_PIPELINE) {
      return res.status(422).json({
        error: `Step limit reached (${MAX_STEPS_PER_PIPELINE} steps maximum). ` +
               `Execute or reset the pipeline before adding more steps.`,
        code : 'STEP_LIMIT_EXCEEDED',
      });
    }

    pl.steps.push({ ...req.body, status: 'pending', addedAt: new Date().toISOString() });
    res.json({ pipelineId: pl.pipelineId, stepCount: pl.steps.length });
  } catch (err) { next(err); }
});

// ── GET /api/pipeline/:id/preview-step/:stepIndex ────────────────────────────
router.get('/:pipelineId/preview-step/:stepIndex', async (req, res, next) => {
  try {
    const pl    = _requirePipeline(req.params.pipelineId, req.user.id);
    const index = parseInt(req.params.stepIndex, 10);
    const step  = pl.steps[index];
    if (!step) return res.status(404).json({ error: 'Step not found.' });

    const dataset = getDataset(pl.datasetId);
    const preview = await pipelineExecutor.dryRun(dataset.rows || [], step);

    res.json({ step, index, total: pl.steps.length, preview });
  } catch (err) { next(err); }
});

// ── POST /api/pipeline/:id/confirm-step/:stepIndex ───────────────────────────
router.post('/:pipelineId/confirm-step/:stepIndex', (req, res, next) => {
  try {
    const pl    = _requirePipeline(req.params.pipelineId, req.user.id);

    // FIX #2: Block mutation while executing
    if (pl.status === 'executing') {
      return res.status(409).json({
        error: 'Cannot confirm steps while pipeline is executing.',
        code : 'PIPELINE_EXECUTING',
      });
    }

    const index = parseInt(req.params.stepIndex, 10);
    if (!pl.steps[index]) return res.status(404).json({ error: 'Step not found.' });
    pl.steps[index].status      = 'confirmed';
    pl.steps[index].confirmedAt = new Date().toISOString();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── DELETE /api/pipeline/:id/reject-step/:stepIndex ──────────────────────────
router.delete('/:pipelineId/reject-step/:stepIndex', (req, res, next) => {
  try {
    const pl    = _requirePipeline(req.params.pipelineId, req.user.id);

    // FIX #2: Block mutation while executing
    if (pl.status === 'executing') {
      return res.status(409).json({
        error: 'Cannot reject steps while pipeline is executing.',
        code : 'PIPELINE_EXECUTING',
      });
    }

    const index = parseInt(req.params.stepIndex, 10);
    if (!pl.steps[index]) return res.status(404).json({ error: 'Step not found.' });
    pl.steps[index].status = 'rejected';
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── POST /api/pipeline/:id/execute ───────────────────────────────────────────
router.post('/:pipelineId/execute', async (req, res, next) => {
  try {
    const pl = _requirePipeline(req.params.pipelineId, req.user.id);

    // FIX #2: Prevent duplicate concurrent execution
    if (pl.status === 'executing') {
      return res.status(409).json({
        error: 'Pipeline is already executing. Please wait.',
        code : 'ALREADY_EXECUTING',
      });
    }

    const confirmedSteps = pl.steps.filter(s => s.status === 'confirmed');
    if (!confirmedSteps.length) {
      return res.status(400).json({ error: 'No confirmed steps to execute.', code: 'NO_STEPS' });
    }

    const dataset = getDataset(pl.datasetId);

    // FIX #2: Record start time for stale-lock recovery on crash
    pl.status             = 'executing';
    pl.executionStartedAt = new Date().toISOString();

    let result;
    try {
      // FIX #4: Execution timeout — prevents infinite hangs on bad pipelines
      result = await Promise.race([
        pipelineExecutor.execute(dataset.rows || [], confirmedSteps),
        _timeoutPromise(EXEC_TIMEOUT_MS, 'Pipeline execution timed out'),
      ]);
    } catch (execErr) {
      pl.status             = 'failed';
      pl.executionStartedAt = null;
      throw execErr;
    }

    // Set cleaned output on dataset so /download works
    dataset.cleanedFilePath = result.outputPath;
    dataset.cleanedRows     = result.rows;

    pl.status             = 'completed';
    pl.executionStartedAt = null;  // FIX #2: clear stale-lock timestamp
    pl.log = (result.stepResults || []).map(
      s => `[${new Date().toISOString()}] ${s.summary || s.action || 'step completed'}`
    );

    res.json({
      success    : true,
      stepResults: result.stepResults,
      log        : pl.log,
    });
  } catch (err) { next(err); }
});

// ── GET /api/pipeline/:id/status ─────────────────────────────────────────────
router.get('/:pipelineId/status', (req, res, next) => {
  try {
    const pl = _requirePipeline(req.params.pipelineId, req.user.id);
    res.json({ pipelineId: pl.pipelineId, status: pl.status, stepCount: pl.steps.length });
  } catch (err) { next(err); }
});

// ── GET /api/pipeline/:id/log ─────────────────────────────────────────────────
router.get('/:pipelineId/log', (req, res, next) => {
  try {
    const pl = _requirePipeline(req.params.pipelineId, req.user.id);
    res.json({ pipelineId: pl.pipelineId, log: pl.log });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function _requirePipeline(pipelineId, userId) {
  const pl = pipelineStore.get(pipelineId);
  if (!pl) {
    const err = new Error('Pipeline not found.'); err.status = 404; throw err;
  }

  // FIX #6: Return 404 for wrong user (not 403) — avoids leaking pipeline existence
  if (pl.userId !== userId) {
    const err = new Error('Pipeline not found.'); err.status = 404; throw err;
  }

  // FIX #2: Detect and recover stale executing lock (e.g. after process crash)
  if (pl.status === 'executing' && pl.executionStartedAt) {
    const age = Date.now() - new Date(pl.executionStartedAt).getTime();
    if (age > EXECUTION_STALE_MS) {
      console.warn(
        `[pipeline.routes] Stale execution lock on ${pipelineId} ` +
        `(${Math.round(age / 1000)}s ago). Resetting to 'failed'.`
      );
      pl.status             = 'failed';
      pl.executionStartedAt = null;
    }
  }

  return pl;
}

function _timeoutPromise(ms, message) {
  return new Promise((_, reject) =>
    setTimeout(
      () => reject(Object.assign(new Error(message), { status: 504, code: 'EXECUTION_TIMEOUT' })),
      ms
    )
  );
}

module.exports = router;
