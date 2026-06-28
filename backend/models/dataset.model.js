'use strict';
/**
 * backend/models/dataset.model.js
 *
 * CHANGES FROM V2 (this version):
 *
 *   FIX 1 — Required field validation (High Risk from audit)
 *     Previous: createDataset({ id: undefined, filePath: undefined }) silently
 *     created a corrupted dataset object that would crash downstream code.
 *     Fix: id and filePath are required — throw descriptively if missing.
 *
 *   FIX 2 — Row sample cap enforced in model (High Risk from audit)
 *     Previous: comment said "≤5000" but code never enforced it.
 *     A controller passing 1M rows would store them all, causing OOM.
 *     Fix: rows.slice(0, MAX_SAMPLE_ROWS) enforced here unconditionally.
 *
 *   FIX 3 — Columns validated as string[] (Medium Risk from audit)
 *     Previous: columns || [] accepted [1,2,3] or [{}] silently.
 *     Pipeline code downstream expects string[]. Mixed types cause crashes.
 *     Fix: Each element coerced to string; non-string/non-array values
 *     produce an empty array with a console warning.
 *
 *   rowCount, schema fields added in V2 — preserved here.
 *   cleanedRows REMOVED in V1 — preserved here.
 */

const MAX_SAMPLE_ROWS = parseInt(process.env.DATASET_MAX_SAMPLE_ROWS || '5000', 10);

function createDataset({ id, originalName, filePath, rows, columns, rowCount, schema }) {
  // FIX 1: Required field validation
  if (!id) {
    throw new Error('createDataset: id is required');
  }
  if (!filePath) {
    throw new Error('createDataset: filePath is required');
  }

  // FIX 2: Enforce sample cap — never store full dataset in RAM
  const safeRows = Array.isArray(rows)
    ? rows.slice(0, MAX_SAMPLE_ROWS)
    : [];

  if (Array.isArray(rows) && rows.length > MAX_SAMPLE_ROWS) {
    console.warn(
      `[dataset.model] createDataset: rows truncated from ${rows.length} to ${MAX_SAMPLE_ROWS} ` +
      `(MAX_SAMPLE_ROWS). Full dataset stays on disk at filePath.`
    );
  }

  // FIX 3: Validate and normalize columns to string[]
  let safeCols = [];
  if (Array.isArray(columns)) {
    safeCols = columns.map(c => {
      if (typeof c === 'string') return c;
      if (c && typeof c === 'object' && c.name) return String(c.name);
      return String(c);
    }).filter(Boolean);
  } else if (columns != null) {
    console.warn('[dataset.model] createDataset: columns is not an array — defaulting to []');
  }

  return {
    id,
    originalName   : originalName || '',
    filePath,
    rows           : safeRows,
    columns        : safeCols,
    rowCount       : rowCount ?? rows?.length ?? 0,
    schema         : (schema && typeof schema === 'object' && !Array.isArray(schema)) ? schema : {},
    cleanedFilePath: null,
    uploadedAt     : new Date().toISOString(),
  };
}

module.exports = { createDataset, MAX_SAMPLE_ROWS };
