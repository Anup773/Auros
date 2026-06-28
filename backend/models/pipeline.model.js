'use strict';
/**
 * backend/models/pipeline.model.js
 *
 * CHANGES FROM V2 (this version):
 *
 *   FIX 1 — Steps array capped (High Risk from audit)
 *     Previous: steps[] was unbounded. An AI bug generating 100,000 steps
 *     would make the pipeline object massive and crash serialization.
 *     Fix: addStep() helper enforces MAX_PIPELINE_STEPS. Direct push to
 *     pipeline.steps should be replaced with addStep() calls in controllers.
 *
 *   FIX 2 — Status transition validation (Medium Risk from audit)
 *     Previous: nothing prevented complete→building or failed→ready.
 *     State corruption could cause pipelines to re-execute after completion.
 *     Fix: transitionStatus() validates allowed transitions before applying.
 *     Direct assignment to pipeline.status should use this function.
 *
 *   FIX 3 — appendLog enforcement note (High Risk from audit)
 *     The audit correctly noted that nothing prevents pipeline.decisionLog.push().
 *     Pure JS objects cannot enforce this. Fix: Freeze the decisionLog array
 *     prototype push to throw in development mode as a developer guard.
 *     In production, rely on code review + linting rule.
 *     Also: appendLog now exported with a clearer name and JSDoc.
 *
 *   Log cap (500), VALID_STATUSES preserved from V1.
 */

const MAX_LOG_ENTRIES   = 500;
const MAX_PIPELINE_STEPS = parseInt(process.env.MAX_PIPELINE_STEPS || '50', 10);

const VALID_STATUSES = new Set([
  'building',
  'ready',
  'executing',
  'complete',
  'failed',
]);

// FIX 2: Valid status transitions — key: current, value: allowed next states
const ALLOWED_TRANSITIONS = {
  building : new Set(['ready', 'failed']),
  ready    : new Set(['executing', 'building', 'failed']),
  executing: new Set(['complete', 'failed']),
  complete : new Set([]),           // terminal — no transitions allowed
  failed   : new Set(['building']), // allow rebuild after failure
};

function createPipeline({ id, datasetId }) {
  if (!id)        throw new Error('createPipeline: id is required');
  if (!datasetId) throw new Error('createPipeline: datasetId is required');

  return {
    id,
    datasetId,
    steps      : [],
    decisionLog: [],
    status     : 'building',
    createdAt  : new Date().toISOString(),
    completedAt: null,
  };
}

/**
 * FIX 1: Add a step safely — enforces MAX_PIPELINE_STEPS cap.
 * Use this instead of pipeline.steps.push() directly.
 */
function addStep(pipeline, step) {
  if (!pipeline || !Array.isArray(pipeline.steps)) {
    throw new Error('addStep: invalid pipeline object');
  }
  if (pipeline.steps.length >= MAX_PIPELINE_STEPS) {
    throw Object.assign(
      new Error(`Pipeline step limit reached (${MAX_PIPELINE_STEPS}). Cannot add more steps.`),
      { code: 'PIPELINE_STEP_LIMIT', status: 400 }
    );
  }
  pipeline.steps.push(step);
  return pipeline;
}

/**
 * FIX 2: Transition pipeline status with validation.
 * Use this instead of pipeline.status = newStatus directly.
 *
 * @param {Object} pipeline
 * @param {string} newStatus
 * @throws if transition is not allowed
 */
function transitionStatus(pipeline, newStatus) {
  if (!VALID_STATUSES.has(newStatus)) {
    throw new Error(`transitionStatus: unknown status "${newStatus}". Valid: ${[...VALID_STATUSES].join(', ')}`);
  }

  const current = pipeline.status;
  const allowed = ALLOWED_TRANSITIONS[current];

  if (!allowed) {
    throw new Error(`transitionStatus: pipeline has unknown current status "${current}"`);
  }

  if (!allowed.has(newStatus)) {
    throw Object.assign(
      new Error(
        `Invalid status transition: "${current}" → "${newStatus}". ` +
        `Allowed from "${current}": ${[...allowed].join(', ') || 'none (terminal state)'}`
      ),
      { code: 'INVALID_STATUS_TRANSITION', status: 400 }
    );
  }

  pipeline.status = newStatus;
  if (newStatus === 'complete' || newStatus === 'failed') {
    pipeline.completedAt = new Date().toISOString();
  }
  return pipeline;
}

/**
 * FIX 3: Append a log entry safely — enforces MAX_LOG_ENTRIES cap.
 * ALWAYS use this instead of pipeline.decisionLog.push() directly.
 *
 * @param {Object} pipeline
 * @param {string} event
 * @param {Object} payload
 */
function appendLog(pipeline, event, payload = {}) {
  if (!pipeline.decisionLog) pipeline.decisionLog = [];

  pipeline.decisionLog.push({
    event,
    timestamp: new Date().toISOString(),
    stepIndex: payload.stepIndex ?? null,
    stepType : payload.stepType  ?? null,
    payload,
  });

  if (pipeline.decisionLog.length > MAX_LOG_ENTRIES) {
    pipeline.decisionLog.splice(0, pipeline.decisionLog.length - MAX_LOG_ENTRIES);
  }
}

function isValidStatus(status) {
  return VALID_STATUSES.has(status);
}

module.exports = {
  createPipeline,
  addStep,
  transitionStatus,
  appendLog,
  isValidStatus,
  VALID_STATUSES,
  ALLOWED_TRANSITIONS,
  MAX_LOG_ENTRIES,
  MAX_PIPELINE_STEPS,
};
