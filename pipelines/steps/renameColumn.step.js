'use strict';
/**
 * backend/pipelines/steps/renameColumn.step.js
 *
 * CHANGES FROM V2:
 *   - HASOWNPROPERTY FIX: replaced `column in r` with
 *     Object.prototype.hasOwnProperty.call(r, column) everywhere.
 *     Prevents false positives from inherited properties like
 *     "constructor", "toString", "__proto__", etc.
 *
 *   - AFFECTEDCOUNT FIX: now counts only rows that were actually modified
 *     (i.e. rows that contained the source column).
 *     Old: affectedCount = rows.length (always — even if column missing in some rows)
 *     New: affectedCount = number of rows where column was actually renamed
 *
 *   - PARTIAL-SCHEMA WARNING: emits a warning in columnStats when the source
 *     column exists in only a subset of rows, alerting downstream steps.
 */

function execute(rows, step) {
  const { column }  = step;
  const { newName } = step.parameters || {};

  if (!column)  throw new Error('renameColumn requires step.column');
  if (!newName) throw new Error('renameColumn requires parameters.newName');

  if (column === newName) {
    return {
      rows,
      inputRowCount   : rows.length,
      affectedCount   : 0,
      affectedIndices : [],
      columnStats     : { oldName: column, newName },
      summary         : 'Column name unchanged.',
    };
  }

  if (rows.length > 0) {
    // FIX: hasOwnProperty — prevents false positives from inherited properties
    const sourceExists = rows.some(r =>
      Object.prototype.hasOwnProperty.call(r, column)
    );
    if (!sourceExists) {
      throw new Error(`renameColumn: source column "${column}" does not exist in dataset`);
    }

    // FIX: hasOwnProperty — prevents overwriting existing column with same name
    const targetExists = rows.some(r =>
      Object.prototype.hasOwnProperty.call(r, newName)
    );
    if (targetExists) {
      throw new Error(
        `renameColumn: target column "${newName}" already exists. ` +
        `Renaming "${column}" to "${newName}" would overwrite existing data.`
      );
    }
  }

  const outputRows      = [];
  const affectedIndices = [];

  for (let i = 0; i < rows.length; i++) {
    const row    = rows[i];
    const newRow = {};

    let wasModified = false;

    for (const key of Object.keys(row)) {
      if (key === column) {
        newRow[newName] = row[key];
        wasModified = true;
      } else {
        newRow[key] = row[key];
      }
    }

    // FIX: only record as affected if this row actually contained the column
    if (wasModified) {
      affectedIndices.push(i);
    }

    outputRows.push(newRow);
  }

  // PARTIAL-SCHEMA WARNING: column was not present in every row
  const partialSchema = affectedIndices.length < rows.length;

  return {
    rows            : outputRows,
    inputRowCount   : rows.length,
    affectedCount   : affectedIndices.length,   // FIX: actual modifications only
    affectedIndices,
    columnStats     : {
      oldName      : column,
      newName,
      partialSchema,                            // true when column missing from some rows
      ...(partialSchema && {
        partialSchemaWarning:
          `Column "${column}" was only present in ${affectedIndices.length} of ${rows.length} rows. ` +
          `Downstream steps may behave unexpectedly on rows missing "${newName}".`,
      }),
    },
    summary: `Renamed column "${column}" to "${newName}" in ${affectedIndices.length} of ${rows.length} rows.`,
  };
}

module.exports = { execute };

