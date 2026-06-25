'use strict';
/**
 * backend/pipelines/steps/fillMissing.step.js
 *
 * CHANGES FROM V1 (this version):
 *
 *   FIX 1 — Mode preserves original data type (Issue #1 + #3 from audit)
 *     Previous: mode collected .map(v => String(v)) then returned String.
 *     Result: numeric column with mode 100 returned "100" (string) — type corruption.
 *     Same bug for booleans: true → "true".
 *     Fix: mode() keeps values as-is (no String() coercion). Most frequent
 *     raw value is returned, preserving its original type.
 *
 *   FIX 2 — Column validation added (Issue #2 from audit)
 *     Previous: if column has a typo, _numericValues() returns [] → confusing
 *     "no numeric values" error instead of "column not found".
 *     Fix: rows.some(r => hasOwnProperty(r, column)) check up front.
 *
 *   FIX 3 — hasOwnProperty instead of 'in' operator (cross-file pattern)
 *     Prevents inherited prototype properties from matching.
 *
 *   All fill methods (mean, median, mode, zero, empty_string, custom) preserved.
 */

function execute(rows, step) {
  const { column }                     = step;
  const { method, value: customValue } = step.parameters || {};

  if (!column) throw new Error('fillMissing requires step.column');
  if (!method) throw new Error('fillMissing requires parameters.method');

  // FIX 2: Column validation — clearer error than "no numeric values"
  if (rows.length > 0 && !rows.some(r => _hasOwn(r, column))) {
    throw new Error(
      `fillMissing: column "${column}" does not exist in dataset. ` +
      `Available columns: ${Object.keys(rows[0]).slice(0, 10).join(', ')}`
    );
  }

  const fillValue       = _computeFillValue(rows, column, method, customValue);
  const outputRows      = [];
  const affectedIndices = [];

  for (let i = 0; i < rows.length; i++) {
    const row = { ...rows[i] };
    if (_isNullLike(row[column])) {
      row[column] = fillValue;
      affectedIndices.push(i);
    }
    outputRows.push(row);
  }

  return {
    rows            : outputRows,
    inputRowCount   : rows.length,
    affectedCount   : affectedIndices.length,
    affectedIndices,
    columnStats     : {
      column, method, fillValue,
      nullsBefore: affectedIndices.length,
      nullsAfter : 0,
    },
    summary: `Filled ${affectedIndices.length} missing value(s) in "${column}" using method="${method}" → value: ${fillValue}`,
  };
}

function _computeFillValue(rows, column, method, customValue) {
  switch (method) {
    case 'custom':
      if (customValue === undefined) throw new Error('fillMissing method=custom requires parameters.value');
      return customValue;

    case 'zero':         return 0;
    case 'empty_string': return '';

    case 'mean': {
      const nums = _numericValues(rows, column);
      if (nums.length === 0) throw new Error(`fillMissing method=mean: no numeric values in column "${column}"`);
      return _roundTo2(nums.reduce((a, b) => a + b, 0) / nums.length);
    }

    case 'median': {
      const nums = _numericValues(rows, column).sort((a, b) => a - b);
      if (nums.length === 0) throw new Error(`fillMissing method=median: no numeric values in column "${column}"`);
      const mid = Math.floor(nums.length / 2);
      return nums.length % 2 === 0
        ? _roundTo2((nums[mid - 1] + nums[mid]) / 2)
        : nums[mid];
    }

    case 'mode': {
      // FIX 1: No String() coercion — collect raw values to preserve types
      const vals = rows
        .map(r => r[column])
        .filter(v => !_isNullLike(v));  // FIX 1: was .map(v => String(v))
      if (vals.length === 0) throw new Error(`fillMissing method=mode: column "${column}" has no non-null values`);

      // FIX 1: Build frequency map keyed by JSON.stringify for safe comparison
      // but return the ORIGINAL value (not the string key)
      const freq = new Map();
      for (const v of vals) {
        const key = JSON.stringify(v);
        if (!freq.has(key)) freq.set(key, { count: 0, original: v });
        freq.get(key).count++;
      }
      // Return the original value with highest frequency — preserves type
      return [...freq.values()].sort((a, b) => b.count - a.count)[0].original;
    }

    default:
      throw new Error(`fillMissing: unknown method "${method}". Valid: mean, median, mode, zero, empty_string, custom`);
  }
}

function _numericValues(rows, column) {
  return rows.map(r => parseFloat(r[column])).filter(n => !isNaN(n));
}

function _isNullLike(val) {
  if (val === null || val === undefined) return true;
  if (typeof val === 'string' && val.trim() === '') return true;
  return false;
}

function _roundTo2(n) {
  return Math.round(n * 100) / 100;
}

// FIX 3: Own-property check
function _hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

module.exports = { execute };
