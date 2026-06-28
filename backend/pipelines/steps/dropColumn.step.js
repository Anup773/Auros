'use strict';
/**
 * backend/pipelines/steps/dropColumn.step.js
 *
 * CHANGES FROM V1 (this version):
 *
 *   FIX 1 — hasOwnProperty instead of 'in' operator (cross-file pattern fix)
 *     Previous: column in r — returns true for inherited properties like
 *     "constructor", "toString", "__proto__". A column named "toString"
 *     would pass validation but cause strange behavior during deletion.
 *     Fix: Object.prototype.hasOwnProperty.call(r, column) everywhere.
 *
 *   rows.some() validation pattern preserved from V1 (already correct).
 *   No mutation bug — { ...row } spread preserved.
 */

function execute(rows, step) {
  const { column } = step;

  if (!column) throw new Error('dropColumn requires step.column');

  // FIX 1: hasOwnProperty instead of 'column in r'
  if (rows.length > 0 && !rows.some(r => _hasOwn(r, column))) {
    throw new Error(
      `dropColumn: column "${column}" does not exist in dataset. ` +
      `Available columns: ${Object.keys(rows[0]).slice(0, 10).join(', ')}`
    );
  }

  const outputRows = rows.map(row => {
    const newRow = { ...row };
    delete newRow[column];
    return newRow;
  });

  return {
    rows            : outputRows,
    inputRowCount   : rows.length,
    affectedCount   : rows.length,
    affectedIndices : rows.map((_, i) => i),
    columnStats     : { droppedColumn: column },
    summary         : `Dropped column "${column}" from all ${rows.length} rows.`,
  };
}

// FIX 1: Own-property check — avoids inherited prototype properties
function _hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

module.exports = { execute };
