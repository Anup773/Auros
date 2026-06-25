'use strict';
/**
 * backend/services/data/dataValidate.js
 *
 * CHANGES FROM V1 (this version):
 *
 *   FIX 1 — rows null safety (Problem 1 from audit)
 *     Previous: rows.length crashed if caller passed undefined or null.
 *     Fix: rows = rows || [] defensive default at the top of validate().
 *
 *   FIX 2 — Object-to-string trim guard (Problem 2 from audit)
 *     Previous: String(v).trim() converted { amount: 100 } to "[object Object]"
 *     which is non-empty, so malformed nested objects silently passed
 *     null detection. Fix: Added instanceof Object check — object values
 *     are treated as null/malformed for validation purposes.
 *
 *   FIX 3 — Expanded validation: duplicate rows, invalid numbers, invalid dates
 *     Previous: only checked remaining_nulls. A dataset could pass validation
 *     with duplicate rows, corrupted amounts, or broken date formats.
 *     This is a "design gap" from the audit — now addressed with three new
 *     checks that run after null check:
 *       - duplicate_rows: exact duplicate detection (same as JS issue detector)
 *       - invalid_number: numeric columns containing non-numeric values
 *       - invalid_date: date columns with values that don't parse as dates
 *     Schema is now an optional third parameter to enable type-aware validation.
 *
 *   All previous fixes (_normaliseColumnNames, string[]/object[] both handled) preserved.
 */

/**
 * Validate cleaned dataset.
 *
 * @param {Array<Object>}          rows
 * @param {string[]|Object[]}      columns — accepts both string[] and [{name}] formats
 * @param {Object}                 [schema] — optional: { colName: { type, ... } }
 *                                            enables type-aware validation
 * @returns {Object} validationReport
 */
function validate(rows, columns, schema) {
  // FIX 1: null safety — never crash on missing rows
  rows = rows || [];

  const colNames = _normaliseColumnNames(columns);

  const report = {
    valid      : true,
    issues     : [],
    rowCount   : rows.length,
    columnCount: colNames.length,
  };

  if (rows.length === 0) {
    report.issues.push({
      column : null,
      type   : 'empty_dataset',
      count  : 0,
      message: 'Dataset is empty — no rows to validate.',
    });
    report.valid = false;
    return report;
  }

  // ── Check 1: Remaining nulls ───────────────────────────────────────────────
  for (const colName of colNames) {
    const vals      = rows.map(r => r[colName]);
    const nullCount = vals.filter(v => _isNullLike(v)).length;

    if (nullCount > 0) {
      report.issues.push({
        column : colName,
        type   : 'remaining_nulls',
        count  : nullCount,
        message: `${nullCount} null value(s) remain in "${colName}" after cleaning`,
      });
      report.valid = false;
    }
  }

  // ── Check 2: Duplicate rows ────────────────────────────────────────────────
  const seen  = new Set();
  let   dupes = 0;
  for (const row of rows) {
    const key = _stableStringify(row);
    if (seen.has(key)) dupes++;
    else seen.add(key);
  }
  if (dupes > 0) {
    report.issues.push({
      column : null,
      type   : 'duplicate_rows',
      count  : dupes,
      message: `${dupes} duplicate row(s) remain after cleaning`,
    });
    report.valid = false;
  }

  // ── Check 3: Type-aware validation (only when schema provided) ─────────────
  if (schema && typeof schema === 'object') {
    for (const colName of colNames) {
      const colSchema = schema[colName];
      if (!colSchema) continue;

      const vals = rows.map(r => r[colName]).filter(v => !_isNullLike(v));

      // FIX 3a: Invalid numbers in numeric columns
      if (colSchema.type === 'integer' || colSchema.type === 'float') {
        const badNums = vals.filter(v => {
          const cleaned = String(v).replace(/[,$\s]/g, '').trim();
          return isNaN(Number(cleaned));
        });
        if (badNums.length > 0) {
          report.issues.push({
            column : colName,
            type   : 'invalid_number',
            count  : badNums.length,
            message: `${badNums.length} non-numeric value(s) in numeric column "${colName}"`,
            sample : badNums.slice(0, 3).map(String),
          });
          report.valid = false;
        }
      }

      // FIX 3b: Invalid dates in date columns
      if (colSchema.type === 'date') {
        const badDates = vals.filter(v => {
          const d = new Date(String(v));
          return isNaN(d.getTime());
        });
        if (badDates.length > 0) {
          report.issues.push({
            column : colName,
            type   : 'invalid_date',
            count  : badDates.length,
            message: `${badDates.length} invalid date value(s) in date column "${colName}"`,
            sample : badDates.slice(0, 3).map(String),
          });
          report.valid = false;
        }
      }
    }
  }

  return report;
}

/**
 * FIX 2: Treat plain objects as null-like (malformed cell values).
 * String(v).trim() on { amount: 100 } gives "[object Object]" which
 * is non-empty — this hides malformed nested data from null detection.
 */
function _isNullLike(v) {
  if (v === null || v === undefined) return true;
  // FIX 2: plain objects are malformed cell values
  if (typeof v === 'object') return true;
  return String(v).trim() === '';
}

function _stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  const sorted = {};
  Object.keys(obj).sort().forEach(k => { sorted[k] = obj[k]; });
  return JSON.stringify(sorted);
}

/**
 * Normalize columns to string[] regardless of input format.
 * Exported for use by other services.
 *
 * Accepts:
 *   ['id', 'amount', 'vendor']          → returns as-is
 *   [{name:'id'}, {name:'amount'}]       → extracts names
 *   [{column:'id'}, {column:'amount'}]   → extracts column property
 */
function _normaliseColumnNames(columns) {
  if (!columns || !columns.length) return [];
  const first = columns[0];
  if (typeof first === 'string') return columns;
  if (typeof first === 'object' && first !== null && 'name' in first)
    return columns.map(c => c.name).filter(Boolean);
  if (typeof first === 'object' && first !== null && 'column' in first)
    return columns.map(c => c.column).filter(Boolean);
  return columns.map(String).filter(Boolean);
}

module.exports = { validate, _normaliseColumnNames };

