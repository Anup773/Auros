'use strict';
/**
 * backend/pipelines/steps/trimWhitespace.step.js
 *
 * CHANGES FROM V2:
 *   - HASOWNPROPERTY FIX: replaced `column in r` with
 *     Object.prototype.hasOwnProperty.call(r, column).
 *     Prevents false positives from inherited properties like
 *     "constructor", "toString", "__proto__", etc.
 *
 *   - COLLAPSE INTERNAL WHITESPACE (opt-in): new parameter
 *     collapseInternalWhitespace: true normalises repeated internal spaces.
 *     Example: "Vendor     Name" → "Vendor Name"
 *     Default: false — preserves existing behaviour exactly.
 *     Rationale: internal collapse is a separate concern from edge trimming
 *     and should be opt-in to avoid unexpected data changes.
 *
 * PRESERVED FROM V2:
 *   - Column existence validation via rows.some()
 *   - Only string values are processed; other types pass through untouched
 *   - affectedCount counts only rows where the value actually changed
 */

function execute(rows, step) {
  const { column }                               = step;
  const { collapseInternalWhitespace = false }   = step.parameters || {};

  if (!column) throw new Error('trimWhitespace requires step.column');

  // FIX: hasOwnProperty — prevents false positives from inherited properties
  if (rows.length > 0 && !rows.some(r =>
    Object.prototype.hasOwnProperty.call(r, column)
  )) {
    throw new Error(`trimWhitespace: column "${column}" does not exist in dataset`);
  }

  const outputRows      = [];
  const affectedIndices = [];

  for (let i = 0; i < rows.length; i++) {
    const row = { ...rows[i] };
    const val = row[column];

    if (typeof val === 'string') {
      let processed = val.trim();

      // OPT-IN: collapse repeated internal whitespace to single space
      if (collapseInternalWhitespace) {
        processed = processed.replace(/\s+/g, ' ');
      }

      if (processed !== val) {
        row[column] = processed;
        affectedIndices.push(i);
      }
    }

    outputRows.push(row);
  }

  const collapseNote = collapseInternalWhitespace
    ? ' Internal whitespace collapsed.'
    : '';

  return {
    rows            : outputRows,
    inputRowCount   : rows.length,
    affectedCount   : affectedIndices.length,
    affectedIndices,
    columnStats     : {
      column,
      trimmedCount               : affectedIndices.length,
      collapseInternalWhitespace,
    },
    summary: `Trimmed whitespace in ${affectedIndices.length} value(s) in "${column}".${collapseNote}`,
  };
}

module.exports = { execute };
