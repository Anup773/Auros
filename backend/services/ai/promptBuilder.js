'use strict';
/**
 * backend/services/ai/promptBuilder.js
 *
 * CHANGES FROM V1 (this version):
 *
 *   FIX 1 — Column format normalization (Bug #9 / Architecture Risk)
 *     Previous: columns.map(c => c.name) crashed when columns was string[]
 *     (the current standard from dataAnalyzer V5+). c.name is undefined
 *     for plain strings → "Cannot read properties of undefined".
 *     Fix: _normaliseColumns() converts both string[] and [{name,...}]
 *     to [{name, type, nullCount}] before building any prompt string.
 *
 *   FIX 2 — Issue null guard (Problem C from audit)
 *     Previous: issue.type, issue.detail, issue.column used directly.
 *     If actionPlanner passed null/undefined issue, crash.
 *     Fix: Early return with safe defaults when issue is falsy.
 *
 *   FIX 3 — Large column list truncation (Medium Risk #4)
 *     Previous: 2000 columns → enormous prompt → Gemini context overflow.
 *     Fix: MAX_COLUMNS_IN_PROMPT = 50. When dataset has more columns,
 *     only the most relevant (those matching the issue column + first N)
 *     are included. A note is added to the prompt about the truncation.
 *
 *   FIX 4 — nullCount null safety (Problem C from audit)
 *     Previous: c.nullCount assumed to exist. JS schema fallback didn't
 *     always include nullCount on every column (fixed in dataAnalyzer V6
 *     this batch, but defensive here too).
 *     Fix: c.nullCount || 0 fallback.
 *
 *   FIX 5 — SYSTEM_PROMPT ALLOWED_ACTIONS kept in sync with responseParser
 *     Previous: hardcoded action list in the prompt could drift from
 *     responseParser.ALLOWED_ACTIONS if one was updated without the other.
 *     Fix: Import ALLOWED_ACTIONS from responseParser and build the
 *     system prompt string dynamically from the same source of truth.
 */

const { ALLOWED_ACTIONS } = require('./responseParser');

const MAX_COLUMNS_IN_PROMPT = 50;

// ── FIX 5: Build SYSTEM_PROMPT from the single source of truth ───────────────
const SYSTEM_PROMPT = `You are a data quality analyst. You help users decide how to clean their datasets.
Your job is to interpret the user's instruction and return a structured JSON action object.

RULES:
- Respond ONLY with a valid JSON object. No prose, no markdown fences, no explanation outside the JSON.
- The JSON must follow the exact schema below.
- Never invent column names. Use only the column names provided.
- Never suggest actions outside the allowed list.
- confidence must be 0–100 based on how clearly the user's intent maps to the action.
- risk must be "Low", "Medium", or "High".
- explanation must be a single clear sentence suitable for a non-technical user.
- If the user's intent is ambiguous, return the most conservative (least destructive) interpretation with low confidence.

JSON SCHEMA:
{
  "action": "<one of: ${[...ALLOWED_ACTIONS].join(' | ')}>",
  "column": "<column name or null if not applicable>",
  "parameters": { <action-specific keys> },
  "confidence": <0-100>,
  "risk": "Low" | "Medium" | "High",
  "explanation": "<one sentence for the user>"
}

PARAMETER SHAPES BY ACTION:
- removeNulls: {}
- fillMissing: { "method": "mean"|"median"|"mode"|"zero"|"empty_string"|"placeholder"|"custom", "value": <only if method=custom> }
- deduplicate: { "strategy": "exact"|"subset", "columns": [<only if strategy=subset, must be non-empty>] }
- formatDates: { "targetFormat": "YYYY-MM-DD"|"DD/MM/YYYY"|"MM/DD/YYYY" }
- trimWhitespace: {}
- renameColumn: { "newName": "<string>" }
- dropColumn: {}
- filterRows: { "condition": "<plain english description of the filter>" }
- standardizeCase: { "mode": "lower"|"upper"|"title" }
- replaceValues: { "find": "<value>", "replace": "<value>" }`;

/**
 * Build the prompt for interpreting a user's cleaning instruction.
 *
 * @param {Object} opts
 * @param {Object} opts.issue         — detected issue { type, column, detail }
 * @param {string} opts.userResponse  — what the user said/typed
 * @param {Array}  opts.columns       — dataset columns (string[] OR [{name,...}])
 * @param {number} opts.rowCount      — total rows
 * @returns {{ system: string, user: string }}
 */
function buildInterpretPrompt({ issue, userResponse, columns, rowCount }) {
  // FIX 2: Guard against null/undefined issue
  const safeIssue = issue || { type: 'unknown', column: null, detail: 'No issue details provided' };

  // FIX 1: Normalize columns to [{name, type, nullCount}]
  const normCols = _normaliseColumns(columns);

  // FIX 3: Truncate large column lists
  const { displayCols, truncated } = _truncateColumns(normCols, safeIssue.column);

  // FIX 4: nullCount fallback
  const colSummary = displayCols
    .map(c => `  - ${c.name} (type: ${c.type || 'string'}, nulls: ${(c.nullCount || 0)}/${rowCount || 0})`)
    .join('\n');

  const truncationNote = truncated
    ? `\n(Note: dataset has ${normCols.length} columns total; showing ${displayCols.length} most relevant)`
    : '';

  const userMessage = `
DATASET CONTEXT:
Total rows: ${rowCount || 0}
Columns:
${colSummary}${truncationNote}

DETECTED ISSUE:
Type: ${safeIssue.type}
Column: ${safeIssue.column || 'N/A'}
Detail: ${safeIssue.detail || 'No detail provided'}

USER INSTRUCTION:
"${userResponse}"

Return the JSON action object.`.trim();

  return { system: SYSTEM_PROMPT, user: userMessage };
}

/**
 * Build the prompt for generating structured questions for issues.
 *
 * @param {Array}  issues   — array of issue objects
 * @param {Array}  columns  — column metadata (string[] OR [{name,...}])
 * @returns {{ system: string, user: string }}
 */
function buildQuestionsPrompt(issues, columns) {
  // FIX 1: Normalize columns
  const normCols = _normaliseColumns(columns);
  const colNames = normCols.slice(0, MAX_COLUMNS_IN_PROMPT).map(c => c.name).join(', ');
  const truncNote = normCols.length > MAX_COLUMNS_IN_PROMPT
    ? ` (and ${normCols.length - MAX_COLUMNS_IN_PROMPT} more)`
    : '';

  const system = `You are a data quality analyst. For each dataset issue, write a clear, concise question for a non-technical user.
The question must:
- Describe the issue in simple terms
- Offer 2–4 concrete options as suggestions
- Be one paragraph maximum

Respond with a JSON array: [{ "issueIndex": 0, "question": "..." }]
CRITICAL: Preserve the issueIndex from each input item exactly.
No markdown, no prose outside the array.`;

  const user = `
COLUMNS: ${colNames}${truncNote}

ISSUES:
${(issues || []).map((iss, i) => {
  // FIX 2: Guard against null/undefined issue items
  if (!iss) return `${i}. (null issue)`;
  return `${i}. Type: ${iss.type || 'unknown'}, Column: ${iss.column || 'N/A'}, Detail: ${iss.detail || ''}`;
}).join('\n')}

Return the questions array.`.trim();

  return { system, user };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * FIX 1: Normalize columns to [{name, type, nullCount}] regardless of input format.
 */
function _normaliseColumns(columns) {
  if (!columns || !columns.length) return [];
  if (typeof columns[0] === 'string') {
    return columns.map(name => ({ name, type: 'string', nullCount: 0 }));
  }
  return columns.map(c => ({
    name     : c.name || c.column || String(c),
    type     : c.type      || 'string',
    nullCount: c.nullCount || 0,   // FIX 4: nullCount fallback
  })).filter(c => c.name);
}

/**
 * FIX 3: Truncate columns to MAX_COLUMNS_IN_PROMPT, prioritizing the issue column.
 */
function _truncateColumns(cols, issueColumn) {
  if (cols.length <= MAX_COLUMNS_IN_PROMPT) {
    return { displayCols: cols, truncated: false };
  }

  // Always include the issue column if specified
  const issueCols  = issueColumn ? cols.filter(c => c.name === issueColumn) : [];
  const otherCols  = issueColumn ? cols.filter(c => c.name !== issueColumn) : cols;
  const remaining  = MAX_COLUMNS_IN_PROMPT - issueCols.length;
  const displayCols = [...issueCols, ...otherCols.slice(0, remaining)];

  return { displayCols, truncated: true };
}

module.exports = { buildInterpretPrompt, buildQuestionsPrompt, SYSTEM_PROMPT };

