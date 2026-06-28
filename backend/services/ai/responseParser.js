'use strict';
/**
 * backend/services/ai/responseParser.js
 *
 * CHANGES FROM V1 (this version):
 *
 *   FIX 1 — ALLOWED_ACTIONS expanded to include internal fallback actions (Architecture Risk #1)
 *     Previous: ai.service._builtInAction() could return flagForReview, keepAsIs, custom
 *     but ALLOWED_ACTIONS didn't include them → if those ever passed through
 *     validateAIResponse(), they'd be rejected.
 *     However: these ARE internal-only actions. The correct fix is a two-tier
 *     approach:
 *       ALLOWED_ACTIONS       = actions Gemini is allowed to return (strict)
 *       INTERNAL_ACTIONS      = actions built-in fallback can return (extended)
 *     validateAIResponse() enforces ALLOWED_ACTIONS for AI output.
 *     A separate validateInternalAction() is exported for pipeline use.
 *     This cleanly separates the "trust AI" vs "trust our own code" paths.
 *
 *   FIX 2 — Column existence validation added (High Risk #2)
 *     Previous: dropColumn on "salaryyyy" passed validation because parser
 *     only checked column is a non-empty string, not that it exists in dataset.
 *     Fix: validateAIResponse() now accepts an optional `knownColumns` array.
 *     When provided, column names are checked against the dataset columns.
 *     Callers (data.controller.js) should pass this from the dataset schema.
 *
 *   FIX 3 — deduplicate subset rejects empty columns array (Medium Risk #3)
 *     Previous: strategy=subset with columns=[] was accepted.
 *     An empty subset deduplicate is a no-op that silently passes.
 *     Fix: columns.length > 0 check added.
 *
 *   FIX 4 — explanation length capped (Low Risk #4)
 *     Previous: no limit on explanation length. Gemini could return 50,000
 *     characters and it would be stored everywhere (DB, logs, frontend state).
 *     Fix: explanation truncated to MAX_EXPLANATION_LENGTH (500 chars).
 */

const MAX_EXPLANATION_LENGTH = 500;

// ── Actions Gemini is ALLOWED to return ──────────────────────────────────────
// Strictly validated — unknown actions from AI are REJECTED.
const ALLOWED_ACTIONS = new Set([
  'removeNulls',
  'fillMissing',
  'deduplicate',
  'formatDates',
  'trimWhitespace',
  'renameColumn',
  'dropColumn',
  'filterRows',
  'standardizeCase',
  'replaceValues',
]);

// ── FIX 1: Internal-only actions (built-in fallback, never from AI) ───────────
// These bypass AI validation — they are trusted because WE generated them.
// pipelineExecutor._applyStep() handles all of these.
const INTERNAL_ACTIONS = new Set([
  ...ALLOWED_ACTIONS,
  'flagForReview',  // safe default — flags rows, never deletes
  'keepAsIs',       // no-op — explicitly does nothing
  'custom',         // user instruction forwarded to executor
]);

const DESTRUCTIVE_ACTIONS = new Set([
  'removeNulls',
  'deduplicate',
  'dropColumn',
  'filterRows',
]);

const ACTION_PARAM_VALIDATORS = {
  removeNulls: (params, column) => {
    if (!column) throw new Error('removeNulls requires a column name');
  },
  fillMissing: (params, column) => {
    if (!column) throw new Error('fillMissing requires a column name');
    const methods = ['mean', 'median', 'mode', 'zero', 'empty_string', 'placeholder', 'custom'];
    if (!params.method || !methods.includes(params.method)) {
      throw new Error(`fillMissing.method must be one of: ${methods.join(', ')}`);
    }
    if (params.method === 'custom' && params.value === undefined) {
      throw new Error('fillMissing with method=custom requires a value');
    }
  },
  deduplicate: (params) => {
    const strategies = ['exact', 'subset'];
    if (!params.strategy || !strategies.includes(params.strategy)) {
      throw new Error(`deduplicate.strategy must be one of: ${strategies.join(', ')}`);
    }
    // FIX 3: Reject empty subset array
    if (params.strategy === 'subset') {
      if (!Array.isArray(params.columns)) {
        throw new Error('deduplicate with strategy=subset requires a columns[] array');
      }
      if (params.columns.length === 0) {
        throw new Error('deduplicate with strategy=subset requires at least one column in columns[]');
      }
    }
  },
  formatDates: (params, column) => {
    if (!column) throw new Error('formatDates requires a column name');
    if (!params.targetFormat) throw new Error('formatDates requires parameters.targetFormat');
  },
  trimWhitespace: (params, column) => {
    if (!column) throw new Error('trimWhitespace requires a column name');
  },
  renameColumn: (params, column) => {
    if (!column) throw new Error('renameColumn requires a column name');
    if (!params.newName) throw new Error('renameColumn requires parameters.newName');
    if (params.newName === column) throw new Error('renameColumn: newName must differ from current column name');
  },
  dropColumn: (params, column) => {
    if (!column) throw new Error('dropColumn requires a column name');
  },
  filterRows: (params) => {
    if (!params.condition) throw new Error('filterRows requires parameters.condition');
  },
  standardizeCase: (params, column) => {
    if (!column) throw new Error('standardizeCase requires a column name');
    const modes = ['lower', 'upper', 'title'];
    if (!params.mode || !modes.includes(params.mode)) {
      throw new Error(`standardizeCase.mode must be one of: ${modes.join(', ')}`);
    }
  },
  replaceValues: (params, column) => {
    if (!column) throw new Error('replaceValues requires a column name');
    if (params.find === undefined) throw new Error('replaceValues requires parameters.find');
    if (params.replace === undefined) throw new Error('replaceValues requires parameters.replace');
  },
};

/**
 * Validate a raw AI action object.
 *
 * FIX 2: Optional knownColumns parameter for column existence check.
 *
 * @param {Object}   raw
 * @param {string[]} [knownColumns] — dataset column names for existence validation
 * @returns {Object} validated action
 */
function validateAIResponse(raw, knownColumns) {
  if (!raw || typeof raw !== 'object') {
    throw Object.assign(new Error('AI response must be a JSON object'), { status: 422 });
  }

  // ── action ────────────────────────────────────────────────────────────────
  if (!raw.action || typeof raw.action !== 'string') {
    throw Object.assign(new Error('AI response missing required field: action'), { status: 422 });
  }
  if (!ALLOWED_ACTIONS.has(raw.action)) {
    throw Object.assign(
      new Error(`AI returned unknown action: "${raw.action}". Allowed: ${[...ALLOWED_ACTIONS].join(', ')}`),
      { status: 422 }
    );
  }

  // ── column ────────────────────────────────────────────────────────────────
  const column = raw.column || null;

  // FIX 2: Validate column exists in dataset when knownColumns provided
  if (column && knownColumns && Array.isArray(knownColumns) && knownColumns.length > 0) {
    const colLower   = column.toLowerCase();
    const knownLower = knownColumns.map(c => String(c).toLowerCase());
    if (!knownLower.includes(colLower)) {
      throw Object.assign(
        new Error(`AI referenced column "${column}" which does not exist in the dataset. Known columns: ${knownColumns.slice(0, 10).join(', ')}`),
        { status: 422 }
      );
    }
  }

  // ── parameters ────────────────────────────────────────────────────────────
  const parameters = raw.parameters && typeof raw.parameters === 'object' ? raw.parameters : {};
  const paramValidator = ACTION_PARAM_VALIDATORS[raw.action];
  if (paramValidator) paramValidator(parameters, column);

  // ── confidence ────────────────────────────────────────────────────────────
  const confidence = parseFloat(raw.confidence);
  if (isNaN(confidence) || confidence < 0 || confidence > 100) {
    throw Object.assign(
      new Error('AI response field "confidence" must be a number between 0 and 100'),
      { status: 422 }
    );
  }

  // ── risk ──────────────────────────────────────────────────────────────────
  const VALID_RISKS = ['Low', 'Medium', 'High'];
  if (!VALID_RISKS.includes(raw.risk)) {
    throw Object.assign(
      new Error(`AI response field "risk" must be one of: ${VALID_RISKS.join(', ')}`),
      { status: 422 }
    );
  }

  // ── explanation ───────────────────────────────────────────────────────────
  if (!raw.explanation || typeof raw.explanation !== 'string' || !raw.explanation.trim()) {
    throw Object.assign(
      new Error('AI response missing required field: explanation'),
      { status: 422 }
    );
  }

  // FIX 4: Cap explanation length
  const explanation = raw.explanation.trim().slice(0, MAX_EXPLANATION_LENGTH);

  return {
    action      : raw.action,
    column,
    parameters,
    confidence  : Math.round(confidence),
    risk        : raw.risk,
    explanation,
    isDestructive: DESTRUCTIVE_ACTIONS.has(raw.action),
  };
}

/**
 * FIX 1: Validate internal (built-in fallback) actions.
 * More permissive than validateAIResponse — allows flagForReview, keepAsIs, custom.
 * Used by pipeline controller when processing _builtInAction() output.
 */
function validateInternalAction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.action || !INTERNAL_ACTIONS.has(raw.action)) return null;
  return {
    action      : raw.action,
    column      : raw.column      || null,
    parameters  : raw.parameters  || {},
    confidence  : typeof raw.confidence === 'number' ? raw.confidence : 80,
    risk        : raw.risk        || 'Low',
    explanation : (raw.explanation || '').slice(0, MAX_EXPLANATION_LENGTH),
    isDestructive: DESTRUCTIVE_ACTIONS.has(raw.action),
  };
}

/**
 * Parse raw AI text then validate.
 * FIX 2: knownColumns passed through for column existence check.
 */
function parseAndValidate(rawText, knownColumns) {
  let jsonText = rawText.trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');

  // Try extracting first JSON object if there's surrounding text
  const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
  if (jsonMatch) jsonText = jsonMatch[0];

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw Object.assign(
      new Error(`AI returned invalid JSON: ${e.message}`),
      { status: 422, code: 'AI_INVALID_JSON' }
    );
  }

  return validateAIResponse(parsed, knownColumns);
}

module.exports = {
  validateAIResponse,
  validateInternalAction,
  parseAndValidate,
  ALLOWED_ACTIONS,
  INTERNAL_ACTIONS,
  DESTRUCTIVE_ACTIONS,
};
