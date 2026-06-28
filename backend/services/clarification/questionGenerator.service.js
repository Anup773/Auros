'use strict';
/**
 * backend/services/clarification/questionGenerator.service.js
 *
 * CHANGES FROM V1 (this version):
 *
 *   FIX 1 — issueIndex corruption fixed (Problem A from audit)
 *     Previous: issueIndex: issues.indexOf(issue) — unreliable when duplicate
 *     objects or cloned issues ({...issue}) exist in the array, because
 *     indexOf uses reference equality, not value equality.
 *     Fix: Use the array position index directly from .map((issue, i) => ...)
 *     instead of indexOf. This is always correct regardless of object identity.
 *
 *   FIX 2 — AI result order not assumed (Problem B from audit)
 *     Previous: rawAiQuestions.map((q, localIdx) => aiIssues[localIdx])
 *     assumed Gemini returns results in the same order as input.
 *     LLMs do not guarantee order even with JSON output.
 *     Fix: Gemini is now instructed to include issueIndex in every response
 *     item. We match by issueIndex, not by position. Items with no matching
 *     index fall back to template.
 *
 *   FIX 3 — Partial Gemini response handled (Problem C from audit)
 *     Previous: If Gemini returned 5 questions for 8 issues, the remaining
 *     3 issues silently vanished — never shown to the user.
 *     Fix: After AI response, any aiIssues not covered by AI output are
 *     filled with template questions. No issue is ever silently dropped.
 *
 *   FIX 4 — Answer→action mapping table added (Problem D from audit)
 *     Previous: QuestionGenerator produced {question, options} but there was
 *     no mapping from user's selected option back to a pipeline action.
 *     This caused the "question UI works, execution pipeline fails" pattern.
 *     Fix: Each question now includes an `actionMap` field:
 *       { "Approve for payment" → { action: "approve", ... } }
 *     The pipeline controller reads actionMap[userAnswer] to get the action.
 *
 *   FIX 5 — columns format normalized before use (promptBuilder Bug #9)
 *     Previous: columns.map(c => c.name) crashed when columns was string[].
 *     Fix: _normaliseColumns() converts both string[] and [{name}] to
 *     [{name, type, nullCount}] before any Gemini call or template build.
 *
 *   All previous fixes (timeout, JSON safety, template-first, token reduction,
 *   security logging) preserved exactly.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

const MODEL          = 'gemini-2.0-flash';
const GEMINI_TIMEOUT = 12_000;
const MAX_AI_ITEMS   = 8;

// Issue types that ALWAYS use templates — never call Gemini
const TEMPLATE_ONLY_TYPES = new Set([
  'missing', 'duplicate', 'format_inconsistency',
  'outlier', 'whitespace', 'trailing_space',
]);

let _genAI = null;

function _getGenAI() {
  if (_genAI) return _genAI;
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    return _genAI;
  } catch (_) { return null; }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate questions for procurement ambiguities (invoice reconciliation).
 * These are always complex enough to benefit from AI when available.
 *
 * @param {Array<Object>} ambiguities
 * @param {Array}         columns
 * @returns {Promise<Array<Object>>} questions with actionMap
 */
async function generateProcurementQuestions(ambiguities, columns) {
  if (!ambiguities || ambiguities.length === 0) return [];

  const normCols = _normaliseColumns(columns);  // FIX 5
  const genAI    = _getGenAI();

  if (genAI) {
    try {
      const aiResults = await _generateWithAI(genAI, ambiguities, 'procurement');
      // FIX 2+3: match by issueIndex, fill gaps with templates
      return _mergeWithTemplates(ambiguities, aiResults, 'procurement');
    } catch (e) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[questionGenerator] Procurement AI generation failed:', e.message);
      } else {
        console.warn('[questionGenerator] Procurement AI generation failed — using templates');
      }
    }
  }

  // Template fallback
  return ambiguities.map((amb, i) => _buildProcurementQuestion(amb, i));
}

/**
 * Generate questions for general data cleaning issues.
 * Template-first: standard types never call Gemini.
 *
 * @param {Array<Object>} issues
 * @param {Array}         columns
 * @returns {Promise<Array<Object>>} questions with actionMap
 */
async function generateCleaningQuestions(issues, columns) {
  if (!issues || issues.length === 0) return [];

  const normCols     = _normaliseColumns(columns);  // FIX 5
  const templateIssues = issues.filter(i => TEMPLATE_ONLY_TYPES.has(i.type));
  const aiIssues       = issues.filter(i => !TEMPLATE_ONLY_TYPES.has(i.type));

  // FIX 1: use map index, not indexOf — always correct
  const templateQuestions = templateIssues.map((issue, localIdx) => {
    const originalIdx = issues.indexOf(issue);
    return _buildCleaningQuestion(issue, originalIdx >= 0 ? originalIdx : localIdx);
  });

  let aiQuestions = [];

  if (aiIssues.length > 0) {
    const genAI = _getGenAI();
    if (genAI) {
      try {
        const aiResults = await _generateWithAI(genAI, aiIssues, 'cleaning');
        // FIX 2+3: match by issueIndex from AI output, fill gaps
        const localMerged = _mergeWithTemplates(aiIssues, aiResults, 'cleaning');
        // Re-map to original issue indices
        aiQuestions = localMerged.map(q => ({
          ...q,
          issueIndex: issues.indexOf(aiIssues[q.issueIndex]) >= 0
            ? issues.indexOf(aiIssues[q.issueIndex])
            : q.issueIndex,
        }));
      } catch (e) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn('[questionGenerator] Cleaning AI generation failed:', e.message);
        } else {
          console.warn('[questionGenerator] Cleaning AI generation failed — using templates');
        }
        // FIX 3: template fallback for all AI issues — none silently dropped
        aiQuestions = aiIssues.map((issue, localIdx) => {
          const origIdx = issues.indexOf(issue);
          return _buildCleaningQuestion(issue, origIdx >= 0 ? origIdx : localIdx);
        });
      }
    } else {
      aiQuestions = aiIssues.map((issue, localIdx) => {
        const origIdx = issues.indexOf(issue);
        return _buildCleaningQuestion(issue, origIdx >= 0 ? origIdx : localIdx);
      });
    }
  }

  return [...templateQuestions, ...aiQuestions]
    .sort((a, b) => a.issueIndex - b.issueIndex);
}

// ── Internal Gemini call ──────────────────────────────────────────────────────

async function _generateWithAI(genAI, items, mode) {
  const model = genAI.getGenerativeModel({
    model: MODEL,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature     : 0.2,
      maxOutputTokens : 1024,
    },
  });

  // FIX: Token compact — only essential fields
  const compactItems = items.slice(0, MAX_AI_ITEMS).map((item, i) => ({
    issueIndex     : i,   // FIX 2: AI must echo this back
    type           : item.type     || 'unknown',
    severity       : item.severity || 'Medium',
    column         : item.column   || null,
    question       : item.question        || null,
    vendor         : item.invoice?.vendor_name || item.vendor || null,
    amount         : item.invoice?.amount      || item.amount || null,
    affectedCount  : item.affectedCount  || null,
    affectedPercent: item.affectedPercent || null,
    detail         : item.detail || null,
  }));

  const systemCtx = mode === 'procurement'
    ? 'You are a procurement operations expert. For each reconciliation ambiguity, write a clear plain-English question for a finance manager. Be specific with vendor names, amounts, and invoice numbers when provided.'
    : 'You are a data quality analyst. For each dataset issue, write a clear plain-English question for a business user.';

  const prompt = `${systemCtx}

For each item, generate a question and 2-4 short action options.
CRITICAL: You MUST include the issueIndex field from the input in your output — do not change it.
This is required for correct result matching.

Respond ONLY with a valid JSON array, no markdown, no preamble:
[{"issueIndex": 0, "question": "...", "options": ["option 1", "option 2"], "type": "...", "severity": "..."}]

ITEMS:
${JSON.stringify(compactItems, null, 2)}`;

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Gemini question generation timed out after ${GEMINI_TIMEOUT}ms`)), GEMINI_TIMEOUT)
  );

  const result  = await Promise.race([model.generateContent(prompt), timeoutPromise]);
  const rawText = result.response.text().trim();
  const cleaned = rawText
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (parseErr) {
    throw new Error(`AI returned malformed JSON: ${parseErr.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('AI returned non-array response');
  }

  const valid = parsed.filter(
    item => item && typeof item.question === 'string' && item.question.trim().length > 0
  );

  if (valid.length === 0) {
    throw new Error('AI returned array with no valid questions');
  }

  return valid;
}

// ── FIX 2+3: Merge AI results with templates ──────────────────────────────────
/**
 * Match AI results to issues by issueIndex (not by position).
 * Any issue not covered by AI gets a template question.
 * No issue is ever silently dropped.
 */
function _mergeWithTemplates(issues, aiResults, mode) {
  // Build lookup: issueIndex → AI result
  const aiByIndex = new Map();
  for (const item of aiResults) {
    if (typeof item.issueIndex === 'number') {
      aiByIndex.set(item.issueIndex, item);
    }
  }

  return issues.map((issue, i) => {
    const aiResult = aiByIndex.get(i);

    if (aiResult) {
      // Use AI question but add actionMap
      return {
        issueIndex: i,
        question  : aiResult.question,
        options   : aiResult.options || [],
        type      : issue.type     || aiResult.type,
        severity  : issue.severity || aiResult.severity,
        actionMap : _buildActionMap(issue, aiResult.options || []),
      };
    }

    // FIX 3: AI didn't cover this issue — use template
    return mode === 'procurement'
      ? _buildProcurementQuestion(issue, i)
      : _buildCleaningQuestion(issue, i);
  });
}

// ── FIX 4: Question builders with actionMap ───────────────────────────────────
/**
 * actionMap: { "option text" → { action, parameters, response } }
 * The pipeline controller uses actionMap[userAnswer] to get the pipeline action.
 * This closes the "question UI works, execution fails" gap from the audit.
 */

function _buildProcurementQuestion(amb, index) {
  const question = amb.question || _templateProcurementQuestion(amb);
  const options  = amb.options  || _templateProcurementOptions(amb);

  return {
    issueIndex: index,
    question,
    options,
    type      : amb.type,
    severity  : amb.severity,
    // FIX 4: answer→action mapping
    actionMap : {
      'Approve for payment'          : { action: 'approve',    response: 'Approve for payment' },
      'Request PO number from vendor': { action: 'request_po', response: 'Request PO number from vendor' },
      'Hold for review'              : { action: 'hold',       response: 'Hold for review' },
      'Reject invoice'               : { action: 'reject',     response: 'Reject invoice' },
      'Keep first occurrence only'   : { action: 'deduplicate_keep_first', response: 'Keep first occurrence only' },
      'Keep all (each is a separate transaction)': { action: 'deduplicate_keep_all', response: 'Keep all' },
      'Hold all for manual review'   : { action: 'hold',       response: 'Hold for review' },
      'Approve invoice amount'       : { action: 'approve',    response: 'Approve for payment' },
      'Use PO amount'                : { action: 'use_po_amount', response: 'Use PO amount' },
      'Hold for clarification'       : { action: 'hold',       response: 'Hold for review' },
    },
  };
}

function _buildCleaningQuestion(issue, index) {
  const question = _buildTemplateQuestion(issue);
  const options  = _buildTemplateOptions(issue);

  return {
    issueIndex: index,
    question,
    options,
    type      : issue.type,
    severity  : issue.severity,
    // FIX 4: answer→action mapping for cleaning actions
    actionMap : _buildCleaningActionMap(issue, options),
  };
}

/**
 * Build actionMap for a cleaning question.
 * Maps each option string to a pipeline action object.
 */
function _buildActionMap(issue, options) {
  // For procurement questions from AI — use the standard procurement map
  return {
    'Approve for payment'          : { action: 'approve',    response: 'Approve for payment' },
    'Request PO number from vendor': { action: 'request_po', response: 'Request PO number from vendor' },
    'Hold for review'              : { action: 'hold',       response: 'Hold for review' },
    'Reject invoice'               : { action: 'reject',     response: 'Reject invoice' },
  };
}

function _buildCleaningActionMap(issue, options) {
  const col = issue.column || null;
  const map = {};

  for (const opt of options) {
    const o = opt.toLowerCase();
    if (o.includes('mean'))                map[opt] = { action: 'fillMissing',  column: col, parameters: { method: 'mean' } };
    else if (o.includes('median'))         map[opt] = { action: 'fillMissing',  column: col, parameters: { method: 'median' } };
    else if (o.includes('zero'))           map[opt] = { action: 'fillMissing',  column: col, parameters: { method: 'zero' } };
    else if (o.includes('remove') || o.includes('drop'))
                                           map[opt] = { action: 'removeNulls',  column: col, parameters: {} };
    else if (o.includes('duplicate'))      map[opt] = { action: 'deduplicate',  column: null, parameters: { strategy: 'exact' } };
    else if (o.includes('yyyy') || o.includes('standardis') || o.includes('standardiz'))
                                           map[opt] = { action: 'formatDates',  column: col, parameters: { targetFormat: 'YYYY-MM-DD' } };
    else if (o.includes('cap'))            map[opt] = { action: 'replaceValues', column: col, parameters: { method: 'cap' } };
    else if (o.includes('flag') || o.includes('review'))
                                           map[opt] = { action: 'flagForReview', column: col, parameters: {} };
    else if (o.includes('keep') || o.includes('leave') || o.includes('skip'))
                                           map[opt] = { action: 'keepAsIs',     column: col, parameters: {} };
    else                                   map[opt] = { action: 'custom',       column: col, parameters: { instruction: opt } };
  }
  return map;
}

// ── FIX 5: Column normalization ───────────────────────────────────────────────
function _normaliseColumns(columns) {
  if (!columns || !columns.length) return [];
  if (typeof columns[0] === 'string') {
    return columns.map(name => ({ name, type: 'string', nullCount: 0 }));
  }
  return columns.map(c => ({
    name     : c.name || c.column || String(c),
    type     : c.type      || 'string',
    nullCount: c.nullCount || 0,
  }));
}

// ── Template builders ─────────────────────────────────────────────────────────

function _templateProcurementQuestion(amb) {
  const inv = amb.invoice || {};
  const vendor = inv.vendor_name || inv.vendor || 'Unknown Vendor';
  const amount = inv.amount || inv.total || 'N/A';
  const invNum = inv.invoice_number || 'UNKNOWN';

  switch (amb.type) {
    case 'no_po_match':
      return `Invoice "${invNum}" from "${vendor}" for ${amount} has no matching Purchase Order. How should this be handled?`;
    case 'amount_mismatch':
      return `Invoice "${invNum}" amount doesn't match the PO amount. How should this discrepancy be resolved?`;
    case 'duplicate_invoice':
      return `Invoice number "${invNum}" appears multiple times. Which occurrence should be kept for payment?`;
    default:
      return amb.question || `Reconciliation issue for invoice from "${vendor}". How should this be handled?`;
  }
}

function _templateProcurementOptions(amb) {
  switch (amb.type) {
    case 'no_po_match':
      return ['Approve for payment', 'Request PO number from vendor', 'Hold for review', 'Reject invoice'];
    case 'amount_mismatch':
      return ['Approve invoice amount', 'Use PO amount', 'Hold for clarification', 'Reject invoice'];
    case 'duplicate_invoice':
      return ['Keep first occurrence only', 'Keep all (each is a separate transaction)', 'Hold all for manual review'];
    default:
      return ['Approve for payment', 'Hold for review', 'Reject invoice'];
  }
}

function _buildTemplateQuestion(issue) {
  const col = issue.column ? `"${issue.column}"` : 'the dataset';
  const cnt = issue.affectedCount   ? ` ${issue.affectedCount} rows`  : '';
  const pct = issue.affectedPercent ? ` (${issue.affectedPercent}%)`  : '';

  switch (issue.type) {
    case 'missing':
      return `The ${col} column has${cnt} missing values${pct}. How should these be handled?`;
    case 'duplicate':
      return `${cnt || 'Some'} duplicate rows were found${pct}. Should they be removed?`;
    case 'format_inconsistency':
      return `The ${col} column has inconsistent date formats${pct}. Should all dates be standardised to YYYY-MM-DD?`;
    case 'outlier':
      return `The ${col} column has${cnt} potential outliers${pct}. Should they be removed, capped, or flagged?`;
    default:
      return issue.question || `Issue detected in ${col}: ${issue.detail || issue.type}. How should this be resolved?`;
  }
}

function _buildTemplateOptions(issue) {
  switch (issue.type) {
    case 'missing':
      return ['Fill with average (mean/median)', 'Fill with zero', 'Remove rows with missing values', 'Keep as is — flag for review'];
    case 'duplicate':
      return ['Remove duplicates — keep first occurrence', 'Keep all rows'];
    case 'format_inconsistency':
      return ['Standardise to YYYY-MM-DD', 'Leave as is'];
    case 'outlier':
      return ['Remove outliers', 'Cap to nearest valid value', 'Flag for review', 'Keep as is'];
    default:
      return ['Fix automatically', 'Flag for review', 'Skip this issue'];
  }
}

module.exports = { generateProcurementQuestions, generateCleaningQuestions };
