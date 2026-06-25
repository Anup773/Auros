'use strict';
/**
 * backend/pipelines/steps/filterRows.step.js
 *
 * CHANGES FROM V2 (addressing audit findings):
 *
 *   [AUDIT #1 - HIGH] NUMERIC CONVERSION NO LONGER CRASHES THE PIPELINE.
 *     Previously _toNumber() threw on any non-numeric cell value, killing the
 *     entire pipeline for a single bad cell (e.g. "ABC" in an amount column).
 *     Fix: behaviour is now controlled by the 'strictNumeric' parameter:
 *
 *       strictNumeric: true  (DEFAULT) — original throw behaviour.
 *         Use when bad data should halt processing (financial totals, etc.)
 *       strictNumeric: false — skip the row and record it in parseErrors.
 *         Use when bad rows should be excluded rather than crashing the job.
 *
 *     parseErrors are returned in columnStats so the user can see exactly
 *     which rows were skipped and why.
 *
 *   [AUDIT #2 - LOW] CASE-INSENSITIVE 'eq' / 'neq' OPTION added.
 *     New 'ieq' and 'ineq' operators perform case-insensitive string equality.
 *     Existing 'eq' / 'neq' remain byte-exact for callers that depend on the
 *     current behaviour. 'contains' was already case-insensitive (unchanged).
 *
 *   V2 fixes retained:
 *     - rows.some() column existence check (not rows[0])
 *     - NaN-safe numeric comparisons
 *     - Full affectedIndices / summary in return value
 */

/**
 * @param {Array<Object>} rows
 * @param {Object} step — {
 *   parameters: {
 *     column:        string,
 *     operator:      string,
 *     value:         any,
 *     strictNumeric: boolean  (default true)
 *   }
 * }
 */
function execute(rows, step) {
  const {
    column,
    operator,
    value,
    strictNumeric = true,   // [AUDIT #1] default: throw on bad numeric data
  } = step.parameters || {};

  if (!column || !operator) {
    throw new Error('filterRows requires parameters.column and parameters.operator.');
  }

  if (rows.length > 0 && !rows.some(r => column in r)) {
    throw new Error(`filterRows: column "${column}" does not exist in dataset`);
  }

  const keptRows        = [];
  const affectedIndices = [];   // indices of REMOVED rows
  const parseErrors     = [];   // [AUDIT #1] rows skipped due to numeric parse failure

  for (let i = 0; i < rows.length; i++) {
    const cellVal = rows[i][column];
    let   keep;

    try {
      keep = _matchesCondition(cellVal, operator, value);
    } catch (err) {
      if (!strictNumeric) {
        // [AUDIT #1] Record and skip — don't crash the pipeline.
        parseErrors.push({
          rowIndex: i,
          column,
          cellVal,
          reason : err.message,
        });
        affectedIndices.push(i);   // treat as "removed" so caller is aware
        continue;
      }
      // strictNumeric=true: propagate as before
      throw new Error(`filterRows: row ${i} — ${err.message}`);
    }

    if (keep) {
      keptRows.push(rows[i]);
    } else {
      affectedIndices.push(i);
    }
  }

  return {
    rows            : keptRows,
    inputRowCount   : rows.length,
    affectedCount   : affectedIndices.length,
    affectedIndices,
    columnStats     : {
      column,
      operator,
      value,
      strictNumeric,
      parseErrorCount  : parseErrors.length,
      parseErrorSamples: parseErrors.slice(0, 5),   // first 5 for user review
    },
    summary: [
      `Filtered rows: kept ${keptRows.length}, removed ${affectedIndices.length - parseErrors.length}`,
      `(column="${column}" operator="${operator}" value="${value}").`,
      parseErrors.length > 0
        ? `${parseErrors.length} row(s) skipped due to non-numeric values — see columnStats.parseErrorSamples.`
        : '',
    ].filter(Boolean).join(' '),
  };
}

// ── Condition matching ────────────────────────────────────────────────────────

/**
 * NaN-safe numeric coercion — throws a descriptive error instead of returning NaN.
 * Called only for numeric operators (gt, gte, lt, lte).
 */
function _toNumber(val, label) {
  const n = parseFloat(val);
  if (isNaN(n)) {
    throw new Error(
      `Non-numeric value "${val}" encountered for numeric operator "${label}". ` +
      `Use 'contains', 'eq', or 'ieq' for string comparisons.`
    );
  }
  return n;
}

function _matchesCondition(cellVal, operator, filterVal) {
  switch (operator) {
    // ── Exact string equality (case-sensitive, unchanged) ──────────────────
    case 'eq':       return String(cellVal) === String(filterVal);
    case 'neq':      return String(cellVal) !== String(filterVal);

    // ── [AUDIT #2] Case-insensitive equality (new operators) ───────────────
    case 'ieq':      return String(cellVal).toLowerCase() === String(filterVal).toLowerCase();
    case 'ineq':     return String(cellVal).toLowerCase() !== String(filterVal).toLowerCase();

    // ── Numeric comparisons ────────────────────────────────────────────────
    case 'gt':       return _toNumber(cellVal, 'gt')  >  _toNumber(filterVal, 'gt');
    case 'gte':      return _toNumber(cellVal, 'gte') >= _toNumber(filterVal, 'gte');
    case 'lt':       return _toNumber(cellVal, 'lt')  <  _toNumber(filterVal, 'lt');
    case 'lte':      return _toNumber(cellVal, 'lte') <= _toNumber(filterVal, 'lte');

    // ── String containment (already case-insensitive, unchanged) ──────────
    case 'contains': return String(cellVal).toLowerCase().includes(String(filterVal).toLowerCase());

    // ── Null / empty checks ────────────────────────────────────────────────
    case 'not_null': return cellVal !== null && cellVal !== undefined && String(cellVal).trim() !== '';
    case 'is_null':  return cellVal === null  || cellVal === undefined || String(cellVal).trim() === '';

    default:         throw new Error(`filterRows: unknown operator "${operator}"`);
  }
}

module.exports = { execute };
