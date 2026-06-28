'use strict';
/**
 * backend/services/data/dataCleaner.service.js
 *
 * CHANGES FROM V1 (this version):
 *
 *   FIX 1 — Null count now reads from schema, not columns (Problem 1 — CRITICAL)
 *     Previous: _sumNullCells(columns) returned 0 when columns was string[]
 *     (which is the current standard from dataAnalyzer V5+). This meant
 *     nullCells was always 0 and nullPercent was always 0% regardless of
 *     actual data quality. The cleaning summary was completely wrong.
 *     Fix: Accept schema as a third parameter (the inferred schema object
 *     from dataAnalyzer). Sum nullCount from schema[col].nullCount.
 *     Falls back to column-object nullCount for legacy callers.
 *
 *   FIX 2 — readyToClean is now conditional (Problem 3 from audit)
 *     Previous: readyToClean was always true even on empty datasets.
 *     Fix: readyToClean = totalRows > 0 && totalColumns > 0.
 *     An empty file or a file with no columns is not ready to clean.
 *
 *   FIX 3 — schema[col].nullCount path documented and validated
 *     The schema object from data_engine.py and _inferSchemaFromRows()
 *     both now include nullCount per column (confirmed this batch).
 *     _sumNullCells now uses schema[colName].nullCount as primary source.
 */

/**
 * Returns a summary of what cleaning is needed based on detected issues.
 * Does NOT modify any data.
 *
 * @param {Array<Object>}       rows
 * @param {Array<Object>|string[]} columns — column metadata or column names
 * @param {Object}              [schema]  — schema from dataAnalyzer (preferred source for null counts)
 * @returns {Object} cleaningSummary
 */
function getCleaningSummary(rows, columns, schema) {
  const totalRows    = rows    ? rows.length    : 0;
  const totalColumns = columns ? columns.length : 0;
  const totalCells   = totalRows * totalColumns;

  // FIX 1: Sum nulls from schema (accurate) with fallback to column objects (legacy)
  const nullCells = _sumNullCells(columns, schema);

  // Guard against divide-by-zero on empty dataset upload
  const nullPercent = totalCells > 0
    ? parseFloat(((nullCells / totalCells) * 100).toFixed(1))
    : 0;

  // FIX 2: Only ready to clean when there is actually data
  const readyToClean = totalRows > 0 && totalColumns > 0;

  return {
    totalRows,
    totalColumns,
    totalCells,
    nullCells,
    nullPercent,
    readyToClean,
  };
}

/**
 * Sum null cells from the best available source.
 *
 * Priority:
 *   1. schema[colName].nullCount  — most accurate, from infer_schema()
 *   2. col.nullCount on column objects — legacy format
 *   3. 0 — when no null info available (string[] columns, no schema)
 *
 * @param {Array<Object>|string[]} columns
 * @param {Object} [schema]  — { colName: { nullCount, ... } }
 * @returns {number}
 */
function _sumNullCells(columns, schema) {
  if (!columns || !columns.length) return 0;

  // FIX 1a: Use schema as the primary accurate source
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    let total = 0;
    for (const col of columns) {
      const colName  = typeof col === 'string' ? col : (col.name || col.column || '');
      const colSchema = schema[colName];
      if (colSchema && typeof colSchema.nullCount === 'number') {
        total += colSchema.nullCount;
      }
    }
    return total;
  }

  // FIX 1b: Legacy — column objects with nullCount embedded
  if (typeof columns[0] === 'object' && columns[0] !== null && 'nullCount' in columns[0]) {
    return columns.reduce((sum, col) => sum + (col.nullCount || 0), 0);
  }

  // No null info available (string[] columns, no schema passed)
  return 0;
}

module.exports = { getCleaningSummary };