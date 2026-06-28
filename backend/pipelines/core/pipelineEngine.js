'use strict';
/**
 * backend/pipelines/core/pipelineEngine.js
 *
 * CHANGES FROM V2 (this version):
 *
 *   FIX 1 — onStepComplete callback wrapped in try/catch (High Risk from audit)
 *     Previous: if callback threw, entire pipeline crashed mid-run.
 *     Fix: callback errors logged but never propagate to pipeline executor.
 *
 *   FIX 2 — Per-step execution timeout (High Risk from audit)
 *     Previous: a hanging step would freeze the pipeline forever.
 *     Fix: Each step raced against STEP_TIMEOUT_MS (default 60s).
 *
 *   FIX 3 — Large dataset OOM warning + hard limit (Critical Bug from audit)
 *     structuredClone(1M rows) doubles RAM. Hard limit above HARD_ROW_LIMIT
 *     redirects to pipelineExecutor.service.js Python path.
 *
 *   FIX 4 — type/action normalization (from prior batch) preserved.
 *   FIX 5 — dryRun sample cap (from prior batch) preserved.
 *   stopOnError=true, structuredClone fallback all preserved.
 */

const stepExecutor = require('./stepExecutor');

const DRY_RUN_SAMPLE    = 1000;
const STEP_TIMEOUT_MS   = parseInt(process.env.PIPELINE_STEP_TIMEOUT_MS   || '60000',  10);
const LARGE_ROW_WARNING = parseInt(process.env.PIPELINE_LARGE_ROW_WARNING || '10000',  10);
const HARD_ROW_LIMIT    = parseInt(process.env.PIPELINE_HARD_ROW_LIMIT    || '100000', 10);

function _deepCopy(obj) {
  return typeof structuredClone === 'function'
    ? structuredClone(obj)
    : JSON.parse(JSON.stringify(obj));
}

function _withTimeout(promise, ms, stepType) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(
        new Error(`Step "${stepType}" timed out after ${ms}ms`),
        { code: 'STEP_TIMEOUT', status: 504 }
      )), ms)
    ),
  ]);
}

async function execute(originalRows, steps, options = {}) {
  const stopOnError = options.stopOnError !== false;

  // FIX 3: Hard limit — must use Python path for large datasets
  if (originalRows.length > HARD_ROW_LIMIT) {
    throw Object.assign(
      new Error(
        `Dataset has ${originalRows.length} rows, exceeding in-memory limit (${HARD_ROW_LIMIT}). ` +
        'Use pipelineExecutor.service.js with filePath for Python routing.'
      ),
      { code: 'DATASET_TOO_LARGE', status: 400 }
    );
  }

  if (originalRows.length > LARGE_ROW_WARNING) {
    console.warn(
      `[pipelineEngine] WARNING: ${originalRows.length} rows cloned in RAM. ` +
      `Consider Python routing for datasets over ${LARGE_ROW_WARNING} rows.`
    );
  }

  let workingRows   = _deepCopy(originalRows);
  const stepResults = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // FIX 4: Normalize type/action
    if (!step.type && step.action)  step.type   = step.action;
    if (!step.action && step.type)  step.action = step.type;

    if (step.status !== 'confirmed') {
      throw new Error(`Step ${i} (${step.type}) is not confirmed. All steps must be confirmed before execution.`);
    }

    const startTime = Date.now();
    let result;

    try {
      // FIX 2: Per-step timeout
      result = await _withTimeout(
        stepExecutor.execute(workingRows, step),
        STEP_TIMEOUT_MS,
        step.type
      );
    } catch (err) {
      const stepError = Object.assign(
        new Error(`Step ${i} (${step.type}) failed: ${err.message}`),
        { stepIndex: i, stepType: step.type, partialResults: stepResults, code: err.code || 'STEP_EXECUTION_ERROR' }
      );

      if (stopOnError) throw stepError;

      stepResults.push({
        stepIndex : i, stepType: step.type, column: step.column || null,
        status: 'failed', error: err.message, durationMs: Date.now() - startTime,
        summary: `Step ${i} (${step.type}) failed: ${err.message}`,
      });
      console.warn(`[pipelineEngine] Step ${i} (${step.type}) failed (continuing): ${err.message}`);
      continue;
    }

    if (!result || !Array.isArray(result.rows)) {
      throw new Error(`Step ${i} (${step.type}) returned invalid output — expected { rows: [] }`);
    }

    workingRows = result.rows;

    const stepResult = {
      stepIndex: i, stepType: step.type, column: step.column || null,
      inputRowCount: result.inputRowCount, outputRowCount: result.rows.length,
      affectedCount: result.affectedCount, durationMs: Date.now() - startTime,
      summary: result.summary, status: 'ok',
    };

    stepResults.push(stepResult);
    console.log(`[pipelineEngine] Step ${i} (${step.type}) — ${stepResult.summary}`);

    // FIX 1: Callback errors must never crash the pipeline
    if (options.onStepComplete) {
      try { options.onStepComplete(i, stepResult); }
      catch (cbErr) { console.warn(`[pipelineEngine] onStepComplete threw (ignored): ${cbErr.message}`); }
    }
  }

  return { rows: workingRows, stepResults };
}

async function dryRun(rows, step) {
  if (!step.type && step.action) step.type = step.action;

  const sample      = rows.slice(0, DRY_RUN_SAMPLE);
  const workingRows = _deepCopy(sample);

  const result = await _withTimeout(stepExecutor.execute(workingRows, step), STEP_TIMEOUT_MS, step.type);

  const isDestructive     = result.affectedCount > 0 &&
    ['removeNulls', 'deduplicate', 'dropColumn', 'filterRows'].includes(step.type);
  const affectedIndices   = result.affectedIndices || [];
  const sampleBefore      = affectedIndices.slice(0,5).map(i => rows[i] || null).filter(Boolean);
  const sampleAfter       = affectedIndices.slice(0,5).map(i => result.rows[i] || '[row removed]').filter(Boolean);
  const sampleRemoveRatio = sample.length > 0 ? (sample.length - result.rows.length) / sample.length : 0;
  const estimatedTotal    = Math.round(rows.length * (1 - sampleRemoveRatio));

  return {
    affectedRowCount: result.affectedCount,
    totalInputRows  : rows.length,
    totalOutputRows : estimatedTotal,
    sampleBefore, sampleAfter,
    columnStats    : result.columnStats || null,
    isDestructive,
    warningMessage : isDestructive ? `This will remove ~${rows.length - estimatedTotal} row(s). Requires confirmation.` : null,
    summary        : result.summary,
    note           : rows.length > DRY_RUN_SAMPLE ? `Preview based on first ${DRY_RUN_SAMPLE} rows` : undefined,
  };
}

module.exports = { execute, dryRun };
