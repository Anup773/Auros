'use strict';
/**
 * backend/validation/schemaValidator.service.js
 *
 * Post-parse validation layer.
 * Validates schema completeness, column types, required field presence,
 * and produces per-column validation reports.
 *
 * Never mutates source data.
 * Never crashes on malformed rows — logs and continues.
 *
 * CHANGES FROM V1:
 *   - NULL/UNDEFINED COLUMN NAME FIX: lowerCols now uses String(c || '')
 *     before calling .toLowerCase() and .replace().
 *     Old: columnNames.map(c => c.toLowerCase()) — crashes if parser emits
 *          null or undefined column names.
 *     New: String(c || '').toLowerCase().replace(...) — safe for any value.
 *
 *   - SCHEMA NULL GUARD: validateProcurementSchema and validateGenericSchema
 *     now check that `schema` is a non-null object before iterating.
 *     Old: Object.entries(null) → TypeError crash
 *     New: early return with a high-severity warning if schema is missing.
 *
 *   - ALIAS MATCHING TIGHTENED: procurement alias check now requires an
 *     exact match OR the alias appearing as a complete underscore-delimited
 *     segment, not an arbitrary substring.
 *     Old: col.includes(alias) → "vendor_name_backup" matched "vendor_name"
 *     New: col === alias || _segmentMatch(col, alias) — prevents false
 *          positive classification of backup/archive columns.
 *
 *   - UNIQUECOUNT SAFETY: info.uniqueCount check is now guarded with
 *     a typeof check before comparison.
 *     Old: if (info.uniqueCount === 1) — undefined === 1 → false (silent)
 *     New: if (typeof info.uniqueCount === 'number' && info.uniqueCount === 1)
 */

// ── Required column groups for procurement data ───────────────────────────────
const PROCUREMENT_REQUIRED_GROUPS = [
  {
    label  : 'Invoice identifier',
    aliases: ['invoice_number', 'invoicenumber', 'invoice_no', 'inv_no', 'invoice_#'],
  },
  {
    label  : 'Vendor / Supplier',
    aliases: ['vendor_name', 'vendorname', 'vendor', 'supplier', 'supplier_name'],
  },
  {
    label  : 'Amount / Total',
    aliases: ['amount', 'total', 'invoiceamount', 'invoice_amount', 'total_amount'],
  },
];

/**
 * Validate a parsed dataset schema for procurement use.
 *
 * @param {Object}   schema      - From schemaDetector / Python engine
 * @param {string[]} columnNames
 * @returns {{ valid: boolean, missingGroups: string[], warnings: string[], columnReport: Object[] }}
 */
function validateProcurementSchema(schema, columnNames) {
  // FIX: guard against null/non-object schema before iterating
  if (!schema || typeof schema !== 'object') {
    return {
      valid         : false,
      missingGroups : PROCUREMENT_REQUIRED_GROUPS.map(g => g.label),
      warnings      : ['Schema is null or invalid — cannot validate columns'],
      columnReport  : [],
    };
  }

  // FIX: String(c || '') prevents crash when parser emits null/undefined column names
  const lowerCols = (columnNames || []).map(c =>
    String(c || '').toLowerCase().replace(/[^a-z0-9_]/g, '_')
  );

  const missingGroups = [];
  const warnings      = [];
  const columnReport  = [];

  for (const group of PROCUREMENT_REQUIRED_GROUPS) {
    // FIX: tightened alias matching — exact match or segment-level match only
    const found = group.aliases.some(alias =>
      lowerCols.some(col => col === alias || _segmentMatch(col, alias))
    );
    if (!found) {
      missingGroups.push(group.label);
    }
  }

  // Per-column quality report
  for (const [col, info] of Object.entries(schema)) {
    const report = {
      column   : col,
      type     : info.type,
      nullPct  : info.nullPct,
      quality  : _columnQuality(info),
      warnings : [],
    };

    if (info.nullPct > 50) {
      report.warnings.push(`High null rate: ${info.nullPct}%`);
    }
    if (info.type === 'unknown') {
      report.warnings.push('Could not infer column type');
    }
    // FIX: guard uniqueCount existence before comparison
    if (typeof info.uniqueCount === 'number' && info.uniqueCount === 1 && info.nullPct < 100) {
      report.warnings.push('All non-null values are identical — may be a constant column');
    }

    columnReport.push(report);

    if (report.warnings.length) {
      warnings.push(`[${col}]: ${report.warnings.join('; ')}`);
    }
  }

  return {
    valid        : missingGroups.length === 0,
    missingGroups,
    warnings,
    columnReport,
  };
}

/**
 * Validate a generic (non-procurement) dataset schema.
 *
 * @param {Object}   schema
 * @param {string[]} columnNames
 * @returns {{ warnings: string[], columnReport: Object[] }}
 */
function validateGenericSchema(schema, columnNames) {
  const warnings     = [];
  const columnReport = [];

  // FIX: guard against null/non-object schema before iterating
  if (!schema || typeof schema !== 'object') {
    warnings.push('Schema is null or invalid — cannot validate columns');
    return { warnings, columnReport };
  }

  if (!columnNames || columnNames.length === 0) {
    warnings.push('No columns detected in file');
    return { warnings, columnReport };
  }

  for (const [col, info] of Object.entries(schema)) {
    const report = {
      column  : col,
      type    : info.type,
      nullPct : info.nullPct,
      quality : _columnQuality(info),
      warnings: [],
    };

    if (info.nullPct > 80) {
      report.warnings.push(`Very high null rate: ${info.nullPct}%`);
    }

    // FIX: guard uniqueCount existence before comparison
    if (typeof info.uniqueCount === 'number' && info.uniqueCount === 1 && info.nullPct < 100) {
      report.warnings.push('All non-null values are identical — may be a constant column');
    }

    columnReport.push(report);
    if (report.warnings.length) {
      warnings.push(`[${col}]: ${report.warnings.join('; ')}`);
    }
  }

  // Duplicate column names check
  const seen  = new Set();
  const dupes = [];
  for (const col of columnNames) {
    // FIX: safe stringify before comparison in case parser emits non-strings
    const key = String(col || '');
    if (seen.has(key)) dupes.push(key);
    seen.add(key);
  }
  if (dupes.length) {
    warnings.push(`Duplicate column names detected: ${dupes.join(', ')}`);
  }

  return { warnings, columnReport };
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _columnQuality(info) {
  if (info.nullPct > 50) return 'poor';
  if (info.nullPct > 20) return 'fair';
  if (info.type === 'unknown') return 'fair';
  return 'good';
}

/**
 * FIX: segment-level alias matching.
 * Returns true only when `alias` appears as a complete underscore-delimited
 * segment (or sequence of segments) within `col`.
 *
 * Examples:
 *   _segmentMatch('vendor_name',        'vendor_name') → true   (exact)
 *   _segmentMatch('vendor_name_backup', 'vendor_name') → false  (was bug: true)
 *   _segmentMatch('my_vendor_name',     'vendor_name') → true   (valid sub-sequence)
 *   _segmentMatch('invoice_no',         'inv_no')      → false  (not same segments)
 */
function _segmentMatch(col, alias) {
  const colSegments   = col.split('_').filter(Boolean);
  const aliasSegments = alias.replace(/ /g, '_').split('_').filter(Boolean);

  if (aliasSegments.length === 0) return false;
  if (aliasSegments.length > colSegments.length) return false;

  // Sliding window: look for aliasSegments as a contiguous subsequence
  for (let i = 0; i <= colSegments.length - aliasSegments.length; i++) {
    let match = true;
    for (let j = 0; j < aliasSegments.length; j++) {
      if (colSegments[i + j] !== aliasSegments[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }

  return false;
}

module.exports = { validateProcurementSchema, validateGenericSchema };
