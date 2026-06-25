'use strict';
/**
 * backend/pipelines/steps/removeNulls.step.js
 *
 * No changes from V1 — confirmed correct by audit.
 * Removes rows where the target column value is null, undefined, or empty string.
 * DESTRUCTIVE step — rows are permanently removed from the working set.
 * The original dataset is never touched; operates on the pipeline's working copy.
 */

function execute(rows, step) {
  const { column } = step;

  if (!column) throw new Error('removeNulls requires step.column');

  const keptRows        = [];
  const affectedIndices = [];

  for (let i = 0; i < rows.length; i++) {
    const val = rows[i][column];
    if (_isNullLike(val)) {
      affectedIndices.push(i);
    } else {
      keptRows.push(rows[i]);
    }
  }

  const nullsBefore = affectedIndices.length;

  return {
    rows            : keptRows,
    inputRowCount   : rows.length,
    affectedCount   : nullsBefore,
    affectedIndices,
    columnStats     : { column, nullsBefore, nullsAfter: 0 },
    summary         : `Removed ${nullsBefore} row(s) where "${column}" was null/empty. ${keptRows.length} rows remain.`,
  };
}

function _isNullLike(val) {
  if (val === null || val === undefined) return true;
  if (typeof val === 'string' && val.trim() === '') return true;
  return false;
}

module.exports = { execute };
