'use strict';
/**
 * backend/controllers/pipeline.controller.js — V2
 *
 * CHANGES FROM V1 (this version — V2):
 *
 * CRITICAL FIX #1 — STALE 'executing' LOCK AFTER PROCESS CRASH
 *   Old: pipeline.status = 'executing' was set but could never be cleared if
 *        the Node process crashed mid-execution, permanently blocking the pipeline.
 *   New: executionStartedAt timestamp recorded alongside status = 'executing'.
 *        _getPipeline() detects stale locks: if status is 'executing' and
 *        executionStartedAt is older than EXECUTION_STALE_MS (default: 15 min),
 *        status is automatically reset to 'failed' with a stale-lock error message.
 *        This allows re-submission after a crash without manual DB intervention.
 *
 * CRITICAL FIX #2 — CONCURRENT STEP MUTATION DURING EXECUTION (race condition)
 *   Old: While executePipeline() was running, concurrent requests could still
 *        call addStep(), rejectStep(), or confirmStep() — modifying the step list
 *        while the executor was iterating it, causing data corruption.
 *   New: addStep(), rejectStep(), and confirmStep() now check pipeline.status
 *        and return 409 PIPELINE_EXECUTING if status is 'executing'.
 *        This blocks all mutations for the duration of execution.
 *
 * CRITICAL FIX #3 — NO OWNERSHIP VALIDATION
 *   Old: Any caller who knew a pipelineId could read, modify, or execute it.
 *        No user check existed — a multi-user deployment exposed all pipelines
 *        to any authenticated user.
 *   New: _requireOwner(pipeline, userId) checks pipeline.userId === userId.
 *        createPipeline() stores req.user.id as pipeline.userId.
 *        All mutating endpoints (addStep, confirmStep, rejectStep, execute) call
 *        _requireOwner(). Read endpoints (status, log, preview) also validate.
 *        requireAuth middleware must be applied at the route level (unchanged).
 *
 * HIGH FIX #4 — PREVIEW STEP IS EXPENSIVE FOR LONG PIPELINES
 *   Old: previewStep() re-executed all N confirmed steps before previewing step N+1.
 *        For 1000 confirmed steps, this could take minutes and saturate CPU.
 *   New: MAX_PREVIEW_PREREQ_STEPS = 50 (configurable via env). If more than this
 *        many steps precede the target step, previewStep() returns a 422 with
 *        a clear message rather than running an unbounded re-execution.
 *        For pipelines beyond this limit, users should execute the pipeline
 *        and inspect the output file instead of using per-step preview.
 *
 * HIGH FIX #5 — DECISION LOG PAYLOAD SIZE (unbounded memory)
 *   Old: _appendLog() capped entries at 500 but each entry's payload could
 *        contain a full step object including huge sample rows.
 *   New: _sanitiseLogPayload(payload) strips any 'rows', 'data', 'preview',
 *        or 'sample' keys from nested payload objects before logging.
 *        Also caps the JSON serialisation of each entry at MAX_LOG_ENTRY_BYTES
 *        (default: 4 KB) — entries exceeding this are stored with a truncation note.
 *
 * HIGH FIX #6 — INFORMATION DISCLOSURE IN ERROR MESSAGES
 *   Old: throw new Error(`Pipeline not found: ${id}`) — leaks internal ID format.
 *   New: Generic messages: 'Pipeline not found.' / 'Step not found.'
 *        Internal IDs never included in user-facing error strings.
 *
 * MEDIUM FIX #7 — STEP INJECTION VIA buildStep()
 *   Old: pipelineBuilder.buildStep(req.body) accepted arbitrary body fields with
 *        no validation visible at the controller layer.
 *   New: _validateStepInput(body) runs before buildStep(), rejecting bodies that:
 *        - Are missing required 'type' field
 *        - Contain disallowed 'type' values (only whitelisted step types accepted)
 *        - Contain 'column' values with shell-injection characters
 *        - Have deeply nested objects (> 3 levels, likely serialisation attacks)
 *        A 400 error is returned for all validation failures.
 *
 * PRESERVED FROM V1:
 *   - appendLog (now _appendLog — private, not exported)
 *   - Execution lock (now with stale detection)
 *   - Stable step IDs (crypto)
 *   - Pipeline TTL (4h auto-purge)
 *   - previewStep applies confirmed steps first (FIX from V1 preserved)
 *   - All route handler names unchanged
 */

const crypto           = require('crypto');
const { getDataset }   = require('./data.controller');
const pipelineBuilder  = require('../services/pipeline/pipelineBuilder.service');
const pipelineExecutor = require('../services/pipeline/pipelineExecutor.service');

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

const PIPELINE_TTL_MS       = 4 * 60 * 60 * 1000;    // 4 hours
const EXECUTION_STALE_MS    = parseInt(process.env.EXECUTION_STALE_MS    || String(15 * 60 * 1000), 10); // 15 min
const MAX_PREVIEW_PREREQ_STEPS = parseInt(process.env.MAX_PREVIEW_PREREQ || '50', 10);  // FIX #4
const MAX_LOG_ENTRY_BYTES      = parseInt(process.env.MAX_LOG_ENTRY_BYTES || '4096', 10);  // FIX #5

// FIX #7: Whitelisted step types — reject anything not on this list
const ALLOWED_STEP_TYPES = new Set([
  'removeNulls', 'renameColumn', 'replaceValues', 'standardizeCase',
  'trimWhitespace', 'dropColumn', 'fillMissing', 'deduplicate',
  'formatDates', 'filterRows', 'sortRows', 'custom',
]);

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — PIPELINE STORE
// ══════════════════════════════════════════════════════════════════════════════

const pipelineStore = new Map();

// Auto-cleanup pipelines older than TTL
setInterval(() => {
  const now     = Date.now();
  let   removed = 0;
  for (const [id, pipeline] of pipelineStore.entries()) {
    if (now - new Date(pipeline.createdAt).getTime() > PIPELINE_TTL_MS) {
      pipelineStore.delete(id);
      removed++;
    }
  }
  if (removed > 0) console.log(`[pipeline] Cleaned ${removed} expired pipeline(s).`);
}, 60 * 60 * 1000).unref?.();

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — CREATE PIPELINE
// ══════════════════════════════════════════════════════════════════════════════

exports.createPipeline = (req, res, next) => {
  try {
    const { datasetId } = req.body;
    getDataset(datasetId); // validates dataset exists

    const pipelineId = `pl_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

    // FIX #3: Store userId so ownership can be verified on subsequent requests
    const userId = req.user?.id || req.userId || null;

    pipelineStore.set(pipelineId, {
      id                : pipelineId,
      userId,               // FIX #3: ownership
      datasetId,
      steps             : [],
      decisionLog       : [],
      status            : 'building',
      createdAt         : new Date().toISOString(),
      completedAt       : null,
      executionStartedAt: null,  // FIX #1: stale-lock detection
    });

    res.json({ pipelineId, status: 'building' });
  } catch (err) { next(err); }
};

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — ADD STEP
// ══════════════════════════════════════════════════════════════════════════════

exports.addStep = (req, res, next) => {
  try {
    const pipeline = _getPipeline(req.params.pipelineId);
    const userId   = req.user?.id || req.userId || null;

    // FIX #3: Ownership check
    _requireOwner(pipeline, userId);

    // FIX #2: Block mutation while executing
    if (pipeline.status === 'executing') {
      return res.status(409).json({
        error: 'Cannot add steps while the pipeline is executing.',
        code : 'PIPELINE_EXECUTING',
      });
    }

    // FIX #7: Validate step input before passing to builder
    const validationError = _validateStepInput(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError, code: 'INVALID_STEP' });
    }

    const step   = pipelineBuilder.buildStep(req.body);
    step.id      = `step_${crypto.randomBytes(4).toString('hex')}`;

    pipeline.steps.push(step);
    _appendLog(pipeline, 'STEP_STAGED', {
      stepIndex: pipeline.steps.length - 1,
      stepType : step.type,
      stepId   : step.id,
    });

    res.json({ steps: pipeline.steps });
  } catch (err) { next(err); }
};

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — PREVIEW STEP (FIX #4)
// ══════════════════════════════════════════════════════════════════════════════

exports.previewStep = async (req, res, next) => {
  try {
    const pipeline  = _getPipeline(req.params.pipelineId);
    const userId    = req.user?.id || req.userId || null;
    _requireOwner(pipeline, userId);  // FIX #3

    const dataset   = getDataset(pipeline.datasetId);
    const stepIndex = parseInt(req.params.stepIndex, 10);

    if (stepIndex < 0 || stepIndex >= pipeline.steps.length) {
      return res.status(400).json({ error: `Step index out of range: ${stepIndex}` });
    }

    const confirmedBefore = pipeline.steps.slice(0, stepIndex).filter(s => s.status === 'confirmed');

    // FIX #4: Reject excessively expensive previews
    if (confirmedBefore.length > MAX_PREVIEW_PREREQ_STEPS) {
      return res.status(422).json({
        error: (
          `Preview requires re-running ${confirmedBefore.length} confirmed steps, ` +
          `which exceeds the limit of ${MAX_PREVIEW_PREREQ_STEPS}. ` +
          `Execute the pipeline and inspect the output file instead.`
        ),
        code: 'PREVIEW_TOO_EXPENSIVE',
      });
    }

    let workingRows = dataset.rows;
    if (confirmedBefore.length > 0) {
      const { execute } = require('../pipelines/core/pipelineEngine');
      const result = await execute(workingRows, confirmedBefore, { stopOnError: false });
      workingRows  = result.rows;
    }

    const preview = await pipelineExecutor.dryRun(workingRows, pipeline.steps[stepIndex]);
    res.json({ stepIndex, step: pipeline.steps[stepIndex], preview });

  } catch (err) { next(err); }
};

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — CONFIRM / REJECT STEP
// ══════════════════════════════════════════════════════════════════════════════

exports.confirmStep = (req, res, next) => {
  try {
    const pipeline  = _getPipeline(req.params.pipelineId);
    const userId    = req.user?.id || req.userId || null;
    _requireOwner(pipeline, userId);  // FIX #3

    // FIX #2: Block mutation while executing
    if (pipeline.status === 'executing') {
      return res.status(409).json({
        error: 'Cannot confirm steps while the pipeline is executing.',
        code : 'PIPELINE_EXECUTING',
      });
    }

    const stepIndex = parseInt(req.params.stepIndex, 10);
    const step      = _getStep(pipeline, stepIndex);

    if (step.status === 'confirmed') {
      return res.json({ message: 'Already confirmed', steps: pipeline.steps });
    }

    step.status      = 'confirmed';
    step.confirmedAt = new Date().toISOString();
    _appendLog(pipeline, 'STEP_CONFIRMED', { stepIndex, stepType: step.type, stepId: step.id });

    res.json({ steps: pipeline.steps });
  } catch (err) { next(err); }
};

exports.rejectStep = (req, res, next) => {
  try {
    const pipeline  = _getPipeline(req.params.pipelineId);
    const userId    = req.user?.id || req.userId || null;
    _requireOwner(pipeline, userId);  // FIX #3

    // FIX #2: Block mutation while executing
    if (pipeline.status === 'executing') {
      return res.status(409).json({
        error: 'Cannot reject steps while the pipeline is executing.',
        code : 'PIPELINE_EXECUTING',
      });
    }

    const stepIndex = parseInt(req.params.stepIndex, 10);
    const step      = _getStep(pipeline, stepIndex);

    if (step.status === 'executed') {
      return res.status(409).json({
        error: 'Cannot reject an already-executed step.',
        code : 'STEP_ALREADY_EXECUTED',
      });
    }

    pipeline.steps.splice(stepIndex, 1);
    _appendLog(pipeline, 'STEP_REJECTED', { stepIndex, stepType: step.type, stepId: step.id });

    res.json({ steps: pipeline.steps });
  } catch (err) { next(err); }
};

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — EXECUTE PIPELINE (FIX #1 stale lock)
// ══════════════════════════════════════════════════════════════════════════════

exports.executePipeline = async (req, res, next) => {
  try {
    const pipeline = _getPipeline(req.params.pipelineId);
    const userId   = req.user?.id || req.userId || null;
    _requireOwner(pipeline, userId);  // FIX #3

    if (pipeline.status === 'executing') {
      return res.status(409).json({
        error: 'Pipeline is already executing. Please wait.',
        code : 'ALREADY_EXECUTING',
      });
    }

    const unconfirmed = pipeline.steps.filter(s => s.status !== 'confirmed');
    if (unconfirmed.length > 0) {
      return res.status(422).json({
        error: `${unconfirmed.length} step(s) not yet confirmed.`,
        code : 'STEPS_NOT_CONFIRMED',
      });
    }
    if (pipeline.steps.length === 0) {
      return res.status(400).json({ error: 'Pipeline has no steps.', code: 'NO_STEPS' });
    }

    const dataset = getDataset(pipeline.datasetId);

    // FIX #1: Record when execution started for stale-lock detection
    pipeline.status             = 'executing';
    pipeline.executionStartedAt = new Date().toISOString();

    _appendLog(pipeline, 'EXECUTION_STARTED', { stepCount: pipeline.steps.length });

    const result = await pipelineExecutor.execute(
      dataset.rows,
      pipeline.steps,
      dataset._filePath || dataset.filePath || null,
      { stopOnError: true }
    );

    dataset.cleanedRows     = result.rows;
    dataset.cleanedFilePath = result.outputPath;

    pipeline.steps.forEach(s => { s.status = 'executed'; });
    pipeline.status             = 'complete';
    pipeline.completedAt        = new Date().toISOString();
    pipeline.executionStartedAt = null;  // FIX #1: clear stale-lock timestamp

    _appendLog(pipeline, 'EXECUTION_COMPLETE', {
      inputRows  : dataset.rows.length,
      outputRows : result.rows.length,
    });

    res.json({
      status        : 'complete',
      inputRowCount : dataset.rows.length,
      outputRowCount: result.rows.length,
      stepResults   : result.stepResults,
      downloadUrl   : `/api/data/${pipeline.datasetId}/download`,
    });

  } catch (err) {
    const pipeline = pipelineStore.get(req.params.pipelineId);
    if (pipeline) {
      pipeline.status             = 'failed';
      pipeline.executionStartedAt = null;  // FIX #1: always clear on failure
    }
    next(err);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — STATUS & DECISION LOG
// ══════════════════════════════════════════════════════════════════════════════

exports.getPipelineStatus = (req, res, next) => {
  try {
    const pipeline = _getPipeline(req.params.pipelineId);
    const userId   = req.user?.id || req.userId || null;
    _requireOwner(pipeline, userId);  // FIX #3

    res.json({
      id         : pipeline.id,
      datasetId  : pipeline.datasetId,
      status     : pipeline.status,
      steps      : pipeline.steps,
      createdAt  : pipeline.createdAt,
      completedAt: pipeline.completedAt || null,
    });
  } catch (err) { next(err); }
};

exports.getDecisionLog = (req, res, next) => {
  try {
    const pipeline = _getPipeline(req.params.pipelineId);
    const userId   = req.user?.id || req.userId || null;
    _requireOwner(pipeline, userId);  // FIX #3

    res.json({ log: pipeline.decisionLog });
  } catch (err) { next(err); }
};

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 9 — HELPERS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * FIX #1: Stale-lock detection inside _getPipeline.
 * If a pipeline was left in 'executing' state longer than EXECUTION_STALE_MS,
 * it is automatically transitioned to 'failed' so it can be re-submitted.
 */
function _getPipeline(id) {
  const p = pipelineStore.get(id);
  if (!p) {
    // FIX #6: Generic message — no internal ID in user-facing error
    throw Object.assign(new Error('Pipeline not found.'), { status: 404 });
  }

  // FIX #1: Detect and clear stale executing lock
  if (p.status === 'executing' && p.executionStartedAt) {
    const age = Date.now() - new Date(p.executionStartedAt).getTime();
    if (age > EXECUTION_STALE_MS) {
      console.warn(
        `[pipeline] Stale execution lock detected on ${id} ` +
        `(started ${Math.round(age / 1000)}s ago). Resetting to 'failed'.`
      );
      p.status             = 'failed';
      p.executionStartedAt = null;
      _appendLog(p, 'STALE_LOCK_CLEARED', {
        staleDurationMs: age,
        thresholdMs    : EXECUTION_STALE_MS,
      });
    }
  }

  return p;
}

function _getStep(pipeline, index) {
  const step = pipeline.steps[index];
  if (!step) {
    // FIX #6: Generic message
    throw Object.assign(new Error('Step not found.'), { status: 404 });
  }
  return step;
}

/**
 * FIX #3: Verify the requesting user owns this pipeline.
 * Throws 403 if userId doesn't match (or if pipeline has no userId — legacy).
 */
function _requireOwner(pipeline, userId) {
  // If pipeline has no userId (created before FIX #3), skip check
  if (!pipeline.userId) return;
  if (!userId) {
    throw Object.assign(
      new Error('Authentication required to access this pipeline.'),
      { status: 401, code: 'UNAUTHENTICATED' }
    );
  }
  if (pipeline.userId !== userId) {
    // FIX #6: Don't reveal the pipeline exists to the wrong user
    throw Object.assign(new Error('Pipeline not found.'), { status: 404 });
  }
}

/**
 * FIX #7: Validate step input before passing to pipelineBuilder.
 * Returns an error message string, or null if valid.
 */
function _validateStepInput(body) {
  if (!body || typeof body !== 'object') {
    return 'Step body must be a JSON object.';
  }
  if (!body.type || typeof body.type !== 'string') {
    return 'Step must include a "type" field.';
  }
  if (!ALLOWED_STEP_TYPES.has(body.type)) {
    return `Unknown step type "${body.type}". Allowed: ${[...ALLOWED_STEP_TYPES].join(', ')}.`;
  }
  // Reject column values with shell-injection characters
  if (body.column && typeof body.column === 'string') {
    if (/[;`$(){}[\]<>|&]/.test(body.column)) {
      return `Step column contains disallowed characters.`;
    }
  }
  // Reject deeply nested objects (> 3 levels of nesting)
  if (_nestingDepth(body) > 4) {
    return 'Step object is too deeply nested (maximum: 4 levels).';
  }
  return null;
}

function _nestingDepth(obj, depth = 0) {
  if (depth > 5) return depth;  // short-circuit
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return depth;
  return Math.max(...Object.values(obj).map(v => _nestingDepth(v, depth + 1)), depth);
}

/**
 * FIX #5: Strip large fields from log payloads and cap entry size.
 */
function _sanitiseLogPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const STRIP_KEYS = new Set(['rows', 'data', 'preview', 'sample', 'cleanedRows', 'outputRows']);
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    if (STRIP_KEYS.has(k)) continue;
    out[k] = (typeof v === 'object' && v !== null) ? '[object]' : v;
  }
  // Cap serialised size
  const json = JSON.stringify(out);
  if (json.length > MAX_LOG_ENTRY_BYTES) {
    return { _truncated: true, _originalSize: json.length };
  }
  return out;
}

/**
 * Append-only decision log entry. FIX #5: payload sanitised before storage.
 */
function _appendLog(pipeline, event, payload = {}) {
  if (!pipeline.decisionLog) pipeline.decisionLog = [];

  // Cap at 500 entries
  if (pipeline.decisionLog.length >= 500) {
    pipeline.decisionLog.splice(0, pipeline.decisionLog.length - 499);
  }

  pipeline.decisionLog.push({
    event,
    timestamp: new Date().toISOString(),
    stepIndex: payload.stepIndex ?? null,
    stepType : payload.stepType  ?? null,
    payload  : _sanitiseLogPayload(payload),  // FIX #5
  });
}


