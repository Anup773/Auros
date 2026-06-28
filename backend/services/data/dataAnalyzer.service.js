'use strict';
/**
 * backend/services/data/dataAnalyzer.service.js — V6
 *
 * CHANGES FROM V5 (this version):
 *
 *   FIX 1 — totalCount added to every schema column (Critical cross-file bug)
 *     ambiguityDetector.service.js uses col.totalCount to calculate
 *     (col.totalCount - col.nullCount) > 0 for dropColumn ambiguities.
 *     V5's _inferSchemaFromRows() did NOT include totalCount → NaN comparison
 *     → dropColumn ambiguity silently never triggered → dangerous actions
 *     could execute without human review.
 *     Fix: totalCount = rows.length added to every column in _inferSchemaFromRows().
 *     NOTE: data_engine.py's infer_schema() also needs this fix (see BACK_PROPAGATION_NOTES).
 *
 *   FIX 2 — Sample values now skip leading nulls/N/A (Problem 4 from audit)
 *     Previous: nonEmpty.slice(0,3) — if first rows were all "N/A", sample
 *     showed ["N/A","N/A","N/A"] which misleads the schema preview.
 *     Fix: Filter out null/"N/A"/"null"/"none" before sampling.
 *
 *   FIX 3 — XLSX memory guard (Problem 2 from audit)
 *     Previous: XLSX.utils.sheet_to_json loaded the entire sheet into memory.
 *     Large files (100k+ rows) caused "JavaScript heap out of memory".
 *     Fix: Read only the first MAX_XLSX_SAMPLE_ROWS rows using sheet_to_json
 *     with the range option. Full analysis delegated to Python engine.
 *
 *   FIX 4 — CSV rowCount excludes error rows (Problem 1 from audit)
 *     Previous: rowCount++ fired even for PapaParse error rows, so
 *     rowCount could exceed actual valid row count.
 *     Fix: Only increment rowCount when result.errors.length === 0.
 *
 *   FIX 5 — detectIssues() source consistency note (Problem 6 from audit)
 *     Python analyzes full dataset; JS fallback analyzes only sampled rows.
 *     This mismatch is now documented with a warning in the return value.
 *     Full fix requires streaming JS analysis — deferred to later.
 *
 *   FIX 6 — XML schema shape safety (Problem 7 from audit)
 *     Previous: result.schema checked for Object.keys().length > 0
 *     but didn't handle schema:null or schema:[] shapes.
 *     Fix: typeof check before Object.keys() call.
 *
 *   FIX 7 — ambiguityDetector column format: _normaliseColumnNames now exported
 *     ambiguityDetector.service.js builds columnMap with c.name but may receive
 *     string[]. Centralizing normalization here ensures consistent shape downstream.
 *
 *   All V5 fixes (schema inference, streaming CSV, large-file guard) preserved.
 */

const path = require('path');
const fs   = require('fs');
const { callEngine } = require('../pythonBridge.service');
const { parseXml }   = require('../../ingestion/xmlParser.service');

const LARGE_FILE_THRESHOLD  = 10 * 1024 * 1024;  // 10 MB
const MAX_XLSX_SAMPLE_ROWS  = 5000;               // FIX 3: XLSX memory guard

// ── Parse file → rows + columns ───────────────────────────────────────────────

async function parseFile(filePath, originalName) {
  try {
    const result = await callEngine({ operation: 'parse', filePath });
    return {
      rows     : result.sampleRows  || [],
      columns  : result.columnNames || [],
      rowCount : result.rowCount,
      schema   : result.schema,
      warnings : result.warnings || [],
      _filePath: filePath,
    };
  } catch (err) {
    const fileSize = _getFileSizeSafe(filePath);
    if (fileSize > LARGE_FILE_THRESHOLD) {
      throw Object.assign(
        new Error(
          `Python engine required for large files (${Math.round(fileSize / 1024 / 1024)} MB). ` +
          `Ensure Python engine is running. Original error: ${err.message}`
        ),
        { status: 503, code: 'PYTHON_REQUIRED' }
      );
    }
    console.warn(`[dataAnalyzer] Python engine failed, using JS fallback: ${err.message}`);
    return _jsFallbackParse(filePath, originalName, err);
  }
}

// ── Detect issues ─────────────────────────────────────────────────────────────

async function detectIssues(rows, columns, filePath) {
  const fp = filePath || rows?._filePath;
  if (fp) {
    try {
      const result = await callEngine({ operation: 'analyze', filePath: fp });
      return {
        issues  : _normaliseIssues(result.issues || []),
        source  : 'python_full_dataset',
      };
    } catch (err) {
      console.warn(`[dataAnalyzer] Python analyze failed, using JS fallback: ${err.message}`);
    }
  }
  const colNames = _normaliseColumnNames(columns);
  // FIX 5: Warn about source mismatch — JS only sees sampled rows
  return {
    issues : _jsDetectIssues(rows, colNames),
    source : 'js_sampled_rows',
    warning: 'Issue counts based on sampled rows only. For full accuracy, ensure Python engine is running.',
  };
}

// ── Issue normalisation ───────────────────────────────────────────────────────

function _normaliseIssues(issues) {
  return issues.map(issue => ({
    type           : issue.type            || 'unknown',
    column         : issue.column          || null,
    severity       : issue.severity        || 'Medium',
    affectedCount  : issue.affectedCount   || 0,
    affectedPercent: issue.affectedPercent || 0,
    detail         : issue.detail          || '',
  }));
}

/**
 * FIX 7: Exported so ambiguityDetector and other callers can normalize
 * columns to string[] before building their own Maps/lookups.
 */
function _normaliseColumnNames(columns) {
  if (!columns || !columns.length) return [];
  if (typeof columns[0] === 'object' && columns[0] !== null && 'name' in columns[0]) {
    return columns.map(c => c.name).filter(Boolean);
  }
  return columns.map(String).filter(Boolean);
}

// ── JS fallback parsers ───────────────────────────────────────────────────────

async function _jsFallbackParse(filePath, originalName, pythonErr) {
  const ext = path.extname(originalName || filePath).toLowerCase();

  if (ext === '.csv')                  return _parseCSV(filePath);
  if (['.xlsx', '.xls'].includes(ext)) return _parseXLSX(filePath);
  if (ext === '.xml')                  return _parseXMLViaEngine(filePath, pythonErr);

  throw new Error(
    `Unsupported file type for JS fallback: ${ext}. Please ensure Python engine is running.`
  );
}

async function _parseXMLViaEngine(filePath, pythonErr) {
  try {
    const result = await parseXml(filePath);
    const rows   = result.sampleRows || [];

    // FIX 6: Safe XML schema shape check (handles null, [], {} all correctly)
    const hasSchema = result.schema !== null &&
                      result.schema !== undefined &&
                      typeof result.schema === 'object' &&
                      !Array.isArray(result.schema) &&
                      Object.keys(result.schema).length > 0;

    return {
      rows,
      columns  : result.columnNames || [],
      rowCount : result.rowCount    || 0,
      schema   : hasSchema ? result.schema : _inferSchemaFromRows(rows),
      warnings : result.warnings    || [],
      _filePath: filePath,
    };
  } catch (xmlErr) {
    const combinedReason = pythonErr
      ? `generic 'parse' op failed (${pythonErr.message}); dedicated 'parse_xml' op also failed (${xmlErr.message})`
      : `'parse_xml' op failed (${xmlErr.message})`;
    throw Object.assign(
      new Error(
        `XML parsing requires the Python engine, which is currently unavailable: ${combinedReason}. ` +
        `Ensure the Python engine (data_engine.py) is running.`
      ),
      { status: 503, code: 'PYTHON_REQUIRED_XML' }
    );
  }
}

/**
 * FIX 4: rowCount only incremented for valid rows (no PapaParse errors).
 * FIX: _inferSchemaFromRows called to populate schema.
 */
async function _parseCSV(filePath) {
  const Papa = require('papaparse');

  return new Promise((resolve, reject) => {
    const rows     = [];
    const warnings = [];
    let   headers  = null;
    let   rowCount = 0;
    const MAX_SAMPLE_ROWS = 5000;

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });

    Papa.parse(stream, {
      header        : true,
      skipEmptyLines: true,
      step          : (result) => {
        if (!headers && result.meta?.fields) {
          headers = result.meta.fields;
        }
        // FIX 4: Only count valid rows
        if (!result.errors || result.errors.length === 0) {
          rowCount++;
          if (rows.length < MAX_SAMPLE_ROWS) rows.push(result.data);
        } else {
          warnings.push(...result.errors.map(e => e.message));
        }
      },
      complete: () => {
        const columns = headers || (rows.length > 0 ? Object.keys(rows[0]) : []);
        resolve({
          rows,
          columns,
          rowCount,
          schema   : _inferSchemaFromRows(rows),
          warnings : warnings.slice(0, 10),
          _filePath: filePath,
        });
      },
      error: (err) => reject(err),
    });
  });
}

/**
 * FIX 3: XLSX memory guard — reads only MAX_XLSX_SAMPLE_ROWS.
 * Large files are delegated to Python engine; JS fallback is safety net only.
 */
async function _parseXLSX(filePath) {
  try {
    const XLSX = require('xlsx');
    const wb   = XLSX.readFile(filePath, {
      // sheetRows limits rows read from disk — prevents memory explosion
      sheetRows: MAX_XLSX_SAMPLE_ROWS + 1,  // +1 to include header row
    });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    const isTruncated = rows.length >= MAX_XLSX_SAMPLE_ROWS;
    const columns     = rows.length > 0 ? Object.keys(rows[0]) : [];

    return {
      rows,
      columns,
      rowCount: rows.length,  // actual count within sample
      schema  : _inferSchemaFromRows(rows),
      warnings: isTruncated
        ? [`XLSX truncated to ${MAX_XLSX_SAMPLE_ROWS} rows for JS fallback. Python engine recommended for full analysis.`]
        : [],
      _filePath: filePath,
    };
  } catch (err) {
    throw new Error(`XLSX parse failed: ${err.message}`);
  }
}

// ── Schema inference (JS-side) ────────────────────────────────────────────────
/**
 * Infer schema from rows, matching the structure that data_engine.py's
 * infer_schema() produces. MUST include totalCount for ambiguityDetector.
 *
 * Contract (every column entry):
 *   { type, nullCount, nullPct, uniqueCount, sample, totalCount }
 *
 * FIX 1: totalCount added — without it, ambiguityDetector's
 *   (col.totalCount - col.nullCount) > 0 evaluates to NaN → false →
 *   dropColumn ambiguity never triggers → dangerous column drops execute
 *   without human review.
 *
 * FIX 2: sample now skips null/N/A values so preview is meaningful.
 */
function _inferSchemaFromRows(rows) {
  if (!rows || rows.length === 0) return {};

  const schema  = {};
  const allKeys = new Set();
  for (const r of rows) Object.keys(r).forEach(k => allKeys.add(k));

  const total = rows.length;

  // Values that look like "no data" — excluded from sample
  const NULL_LIKE = new Set(['', 'null', 'none', 'n/a', 'na', 'undefined', '-', '--']);

  for (const key of [...allKeys].sort()) {
    const values    = rows.map(r => r[key]);
    const nonEmpty  = values.filter(v =>
      v !== null && v !== undefined &&
      !NULL_LIKE.has(String(v).trim().toLowerCase())
    );
    const nullCount = total - nonEmpty.length;

    // FIX 2: Sample from meaningful values, not from the raw top-3
    const sample = nonEmpty.slice(0, 3).map(String);

    // Basic type inference
    let type = 'string';
    if (nonEmpty.length > 0) {
      const s        = nonEmpty.slice(0, 50).map(String);
      const dateRe   = /^\d{4}-\d{2}-\d{2}$|^\d{2}[\/\-]\d{2}[\/\-]\d{2,4}$/;
      const intRe    = /^-?\d{1,15}$/;
      const floatRe  = /^-?[\d,]+\.?\d*$/;

      const datePct  = s.filter(v => dateRe.test(v.trim())).length / s.length;
      const intPct   = s.filter(v => intRe.test(v.replace(/,/g, '').trim())).length / s.length;
      const floatPct = s.filter(v => floatRe.test(v.replace(/,/g, '').trim())).length / s.length;

      if      (datePct  > 0.7) type = 'date';
      else if (intPct   > 0.8) type = 'integer';
      else if (floatPct > 0.7) type = 'float';
    }

    schema[key] = {
      type,
      nullCount,
      nullPct    : total > 0 ? Math.round((nullCount / total) * 1000) / 10 : 0,
      uniqueCount: new Set(nonEmpty.map(String)).size,
      sample,
      // FIX 1: totalCount required by ambiguityDetector.service.js
      totalCount : total,
    };
  }

  return schema;
}

// ── JS issue detection ────────────────────────────────────────────────────────

function _jsDetectIssues(rows, columns) {
  if (!rows || !rows.length || !columns || !columns.length) return [];

  const issues = [];
  const total  = rows.length;

  for (const col of columns) {
    const values = rows.map(r => r[col]);
    const empty  = values.filter(
      v => v === null || v === undefined || String(v).trim() === ''
    ).length;
    const pct = total > 0 ? Math.round((empty / total) * 1000) / 10 : 0;

    if (empty > 0) {
      issues.push({
        type           : 'missing',
        column         : col,
        severity       : pct > 10 ? 'High' : pct > 3 ? 'Medium' : 'Low',
        affectedCount  : empty,
        affectedPercent: pct,
        detail         : `${empty} null values — ${pct}% of rows`,
      });
    }
  }

  const seen  = new Set();
  let   dupes = 0;
  for (const row of rows) {
    const key = _stableStringify(row);
    if (seen.has(key)) dupes++;
    else seen.add(key);
  }

  if (dupes > 0) {
    issues.push({
      type           : 'duplicate',
      column         : null,
      severity       : 'Medium',
      affectedCount  : dupes,
      affectedPercent: total > 0 ? Math.round((dupes / total) * 1000) / 10 : 0,
      detail         : `${dupes} exact duplicate rows`,
    });
  }

  return issues;
}

function _stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  const sorted = {};
  Object.keys(obj).sort().forEach(k => { sorted[k] = obj[k]; });
  return JSON.stringify(sorted);
}

function _getFileSizeSafe(filePath) {
  try { return fs.statSync(filePath).size; } catch (_) { return 0; }
}

module.exports = { parseFile, detectIssues, _normaliseColumnNames, _inferSchemaFromRows };
