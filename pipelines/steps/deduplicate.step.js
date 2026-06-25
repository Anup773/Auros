'use strict';
/**
 * backend/pipelines/steps/deduplicate.step.js
 *
 * CHANGES FROM V1 (this version):
 *
 *   FIX 1 — Recursive stable stringify (Issue #1 from audit)
 *     Previous: _stableKey() only sorted top-level keys. Nested objects like
 *     { vendor:"ABC", meta:{ po:"456", invoice:"123" } } vs
 *     { vendor:"ABC", meta:{ invoice:"123", po:"456" } } produced different
 *     keys → duplicates with nested objects survived deduplication.
 *     Fix: _stableStringify() recursively sorts keys at all levels.
 *     Consistent with pipelineExecutor.service.js FIX 3.
 *
 *   FIX 2 — Column validation uses rows.some() (Issue #2 from audit)
 *     Previous: Object.keys(rows[0]) — only checked first row.
 *     Fix: rows.some(r => hasOwnProperty(r, col)) for each subset column.
 *
 *   FIX 3 — hasOwnProperty instead of 'in' operator (cross-file pattern)
 *     Prevents inherited prototype properties from matching unexpectedly.
 *
 *   FIX 4 — Empty dataset guard (Issue #3 from audit)
 *     Previous: empty rows array with strategy=subset → validation failed.
 *     Fix: return early with empty result when rows is empty.
 *
 *   Stable key for exact/subset strategies preserved from V1.
 */

function execute(rows, step) {
  const {
    strategy       = 'exact',
    columns: subsetColumns,
  } = step.parameters || {};

  // FIX 4: Empty dataset guard
  if (!rows || rows.length === 0) {
    return {
      rows: [], inputRowCount: 0, affectedCount: 0,
      affectedIndices: [], columnStats: null,
      summary: 'No rows to deduplicate.',
    };
  }

  const keyFn = _buildKeyFn(strategy, subsetColumns, rows);

  const seen            = new Set();
  const keptRows        = [];
  const affectedIndices = [];

  for (let i = 0; i < rows.length; i++) {
    const key = keyFn(rows[i]);
    if (seen.has(key)) {
      affectedIndices.push(i);
    } else {
      seen.add(key);
      keptRows.push(rows[i]);
    }
  }

  return {
    rows            : keptRows,
    inputRowCount   : rows.length,
    affectedCount   : affectedIndices.length,
    affectedIndices,
    columnStats     : null,
    summary         : `Removed ${affectedIndices.length} duplicate row(s) using strategy="${strategy}". ${keptRows.length} unique rows remain.`,
  };
}

function _buildKeyFn(strategy, subsetColumns, rows) {
  if (strategy === 'subset') {
    if (!Array.isArray(subsetColumns) || subsetColumns.length === 0) {
      throw new Error('deduplicate strategy=subset requires a non-empty columns array');
    }

    // FIX 2: rows.some() instead of Object.keys(rows[0])
    // FIX 3: hasOwnProperty instead of 'in'
    subsetColumns.forEach(col => {
      if (!rows.some(r => _hasOwn(r, col))) {
        throw new Error(`deduplicate: column "${col}" not found in dataset`);
      }
    });

    const sortedCols = [...subsetColumns].sort();
    return (row) => sortedCols.map(c => `${c}:${_stableStringify(row[c])}`).join('||');
  }

  // exact strategy — FIX 1: fully recursive stable stringify
  return (row) => _stableStringify(row);
}

/**
 * FIX 1: Recursive stable stringify — sorts keys at ALL nesting levels.
 * Previous version only sorted top-level keys, missing nested object instability.
 */
function _stableStringify(val) {
  if (val === null || val === undefined) return String(val);
  if (typeof val !== 'object')           return JSON.stringify(val);
  if (Array.isArray(val))               return '[' + val.map(_stableStringify).join(',') + ']';

  const sorted = {};
  Object.keys(val).sort().forEach(k => { sorted[k] = _stableStringify(val[k]); });
  return '{' + Object.entries(sorted).map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(',') + '}';
}

// FIX 3: Own-property check
function _hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

module.exports = { execute };
