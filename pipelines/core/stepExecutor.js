'use strict';
/**
 * backend/pipelines/core/stepExecutor.js
 *
 * CHANGES FROM V2 (this version):
 *
 *   FIX 1 — Lazy loading prevents startup crash (Critical Bug from audit)
 *     Previous: require('../steps/removeNulls.step') at module load time.
 *     If ONE step file was missing, the entire server failed to start.
 *     Fix: Steps loaded lazily on first use. Missing step = clear error
 *     on that specific operation, not a server-wide startup crash.
 *
 *   FIX 2 — Handler contract validated before calling (High Risk from audit)
 *     Previous: handler.execute(rows, step) crashed with
 *     "handler.execute is not a function" if a step exported {}.
 *     Fix: Explicit typeof check before dispatch.
 *
 *   FIX 3 — Case/format normalization for step type (High Risk from audit)
 *     Previous: 'removenulls', 'RemoveNulls', 'REMOVE_NULLS' all failed.
 *     Registry keys are camelCase. Fix: Normalize incoming type to camelCase
 *     via a comprehensive alias map. Covers snake_case, lowercase, UPPERCASE.
 *
 *   FIX 4 — Registry drift with AI layer fixed (High Risk from audit)
 *     Registry was missing flagForReview, keepAsIs, custom which
 *     ai.service._builtInAction() can return. Now handled via INLINE_HANDLERS.
 *     (Already present from prior batch — confirmed correct.)
 *
 *   FIX 5 — inputRowCount explicitly tracked (cross-file alignment) preserved.
 */

// FIX 1: Lazy loader — loads step file on first use, caches after
const _cache = {};
function _loadStep(name) {
  if (_cache[name]) return _cache[name];
  try {
    _cache[name] = require(`../steps/${name}.step`);
    return _cache[name];
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      throw new Error(`Step file not found: ../steps/${name}.step. Ensure the file exists.`);
    }
    throw err;
  }
}

// FIX 3: Type normalization alias map — covers all common variants
const TYPE_ALIASES = {
  // removeNulls variants
  'removenulls': 'removeNulls', 'remove_nulls': 'removeNulls', 'dropnulls': 'removeNulls',
  'drop_nulls': 'removeNulls', 'removenull': 'removeNulls',
  // fillMissing variants
  'fillmissing': 'fillMissing', 'fill_missing': 'fillMissing', 'fillnulls': 'fillMissing',
  'fill_nulls': 'fillMissing',
  // deduplicate variants
  'deduplicate': 'deduplicate', 'dedup': 'deduplicate', 'removeduplicates': 'deduplicate',
  'remove_duplicates': 'deduplicate',
  // formatDates variants
  'formatdates': 'formatDates', 'format_dates': 'formatDates', 'formatdate': 'formatDates',
  // trimWhitespace variants
  'trimwhitespace': 'trimWhitespace', 'trim_whitespace': 'trimWhitespace', 'trim': 'trimWhitespace',
  // renameColumn variants
  'renamecolumn': 'renameColumn', 'rename_column': 'renameColumn',
  // dropColumn variants
  'dropcolumn': 'dropColumn', 'drop_column': 'dropColumn',
  // filterRows variants
  'filterrows': 'filterRows', 'filter_rows': 'filterRows',
  // standardizeCase variants
  'standardizecase': 'standardizeCase', 'standardize_case': 'standardizeCase',
  'standardisecase': 'standardizeCase', 'standardise_case': 'standardizeCase',
  // replaceValues variants
  'replacevalues': 'replaceValues', 'replace_values': 'replaceValues',
  // internal actions
  'flagforreview': 'flagForReview', 'flag_for_review': 'flagForReview',
  'keepasis': 'keepAsIs',   'keep_as_is': 'keepAsIs',   'skip': 'keepAsIs',
  'custom': 'custom',
};

// Canonical step names that have dedicated step files
const REGISTERED_STEPS = new Set([
  'removeNulls', 'fillMissing', 'deduplicate', 'formatDates',
  'trimWhitespace', 'renameColumn', 'dropColumn', 'filterRows',
  'standardizeCase', 'replaceValues',
]);

// FIX 4: Internal actions handled inline — no step file needed
const INLINE_HANDLERS = {
  flagForReview: (rows, step) => {
    const col     = step.column;
    const flagged = rows.map(row => {
      const val     = col ? row[col] : null;
      const isEmpty = val === null || val === undefined || String(val).trim() === '';
      return isEmpty ? { ...row, __auros_review_flag__: 'FLAGGED', __auros_review_column__: col } : row;
    });
    const affected = flagged.filter(r => r.__auros_review_flag__ === 'FLAGGED').length;
    return { rows: flagged, affectedCount: affected, inputRowCount: rows.length,
             summary: `Flagged ${affected} row(s) in "${col || 'dataset'}" for review` };
  },
  keepAsIs: (rows, step) => ({
    rows, affectedCount: 0, inputRowCount: rows.length,
    summary: `No changes made to "${step.column || 'dataset'}"`,
  }),
  custom: (rows, step) => {
    const instruction = step.parameters?.instruction || step.explanation || 'custom';
    return { rows: rows.map(r => ({ ...r, __auros_custom_instruction__: instruction })),
             affectedCount: rows.length, inputRowCount: rows.length,
             summary: `Custom instruction applied to ${rows.length} rows` };
  },
};

async function execute(rows, step) {
  if (!Array.isArray(rows)) {
    throw new Error(`stepExecutor: rows must be an array, got ${typeof rows}`);
  }

  // FIX 4 (prior): Normalize type/action
  if (!step.type && step.action)  step.type   = step.action;
  if (!step.action && step.type)  step.action = step.type;

  // FIX 3: Normalize step type to canonical camelCase
  const rawType   = (step.type || '').trim();
  const canonical = TYPE_ALIASES[rawType.toLowerCase()] || rawType;
  step.type = canonical;

  // FIX 4: Inline handlers first (flagForReview, keepAsIs, custom)
  if (INLINE_HANDLERS[canonical]) {
    const result = INLINE_HANDLERS[canonical](rows, step);
    return _validateStepResult(result, canonical, rows.length);
  }

  // Registered step files
  if (!REGISTERED_STEPS.has(canonical)) {
    throw new Error(
      `Unknown step type: "${rawType}" (normalized: "${canonical}"). ` +
      `Registered: ${[...REGISTERED_STEPS].join(', ')}, flagForReview, keepAsIs, custom`
    );
  }

  // FIX 1: Lazy load
  const handler = _loadStep(canonical);

  // FIX 2: Validate handler contract before calling
  if (!handler || typeof handler.execute !== 'function') {
    throw new Error(
      `Step module "${canonical}.step" does not export an execute() function. ` +
      `Ensure it exports: module.exports = { execute: async (rows, step) => ({rows, affectedCount, summary}) }`
    );
  }

  const result = await handler.execute(rows, step);
  return _validateStepResult(result, canonical, rows.length);
}

function _validateStepResult(result, stepType, inputRowCount) {
  if (!result || typeof result !== 'object') {
    throw new Error(`Step "${stepType}" returned invalid result: expected an object`);
  }
  if (!Array.isArray(result.rows)) {
    throw new Error(`Step "${stepType}" result missing required field: rows (Array)`);
  }
  if (typeof result.affectedCount !== 'number') {
    throw new Error(`Step "${stepType}" result missing required field: affectedCount (number)`);
  }
  if (typeof result.summary !== 'string') {
    throw new Error(`Step "${stepType}" result missing required field: summary (string)`);
  }
  return {
    ...result,
    inputRowCount  : result.inputRowCount   ?? inputRowCount ?? result.rows.length,
    affectedIndices: result.affectedIndices ?? [],
    columnStats    : result.columnStats     ?? null,
  };
}

module.exports = { execute };
