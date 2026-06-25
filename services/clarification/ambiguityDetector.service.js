'use strict';
/**
 * backend/services/clarification/ambiguityDetector.service.js
 *
 * CHANGES FROM V1 (this version):
 *
 *   FIX 1 — columnMap now handles BOTH string[] and [{name}] formats (Problem A — CRITICAL)
 *     Previous: columnMap = new Map(columns.map(c => [c.name, c]))
 *     When columns arrived as string[] (current standard from dataAnalyzer V5+),
 *     c.name was undefined → Map became { undefined → 'amount' } →
 *     columnMap.get(action.column) always returned undefined →
 *     large_deletion and drop_non_empty_column ambiguities NEVER triggered →
 *     dangerous destructive actions executed without human review.
 *     Fix: Normalize columns to [{name, ...}] shape before building the Map,
 *     or accept schema as a parameter and build the Map from schema keys.
 *
 *   FIX 2 — col.totalCount fallback (Problem B from audit)
 *     Previous: (col.totalCount - col.nullCount) → NaN when totalCount missing.
 *     data_engine.py's infer_schema() did NOT include totalCount.
 *     This batch's dataAnalyzer FIX 1 adds totalCount to JS schema.
 *     Python data_engine.py also needs this (noted in BACK_PROPAGATION_NOTES).
 *     Here: added safe fallback to rowCount when col.totalCount is missing,
 *     so ambiguityDetector works correctly even against old Python engine output.
 *
 *   FIX 3 — issues parameter now used for issue-correlated ambiguities
 *     Previous: issues parameter was accepted but completely ignored.
 *     Now: issues with severity='High' and affectedPercent > 20% generate
 *     a correlated ambiguity warning alongside action-level ambiguities.
 *     This closes the "design gap" noted in the audit.
 *
 *   All previous fixes (O(n²)→O(1) lookup, divide-by-zero, null column guard) preserved.
 */

/**
 * Detect ambiguities in a set of AI-proposed actions.
 *
 * @param {Array<Object>}           actions  — validated AI action objects
 * @param {Array<Object>}           issues   — detected data issues
 * @param {Array<Object>|string[]}  columns  — dataset columns (string[] OR [{name,...}])
 * @param {number}                  rowCount
 * @param {Object}                  [schema] — optional schema from dataAnalyzer
 * @returns {Array<Object>} ambiguities
 */
function detect(actions, issues, columns, rowCount, schema) {
  const ambiguities = [];

  // ── FIX 1: Normalize columns before building Map ───────────────────────────
  // Build a unified lookup: colName (string) → column metadata object.
  // Handles both string[] and [{name,...}] column formats.
  const columnMap = _buildColumnMap(columns, schema, rowCount);

  // FIX 2: Safe rowCount
  const safeRowCount = rowCount > 0 ? rowCount : 1;

  // ── Action-level ambiguities ───────────────────────────────────────────────
  for (const action of actions) {
    // Low confidence — always flag
    if (action.confidence < 70) {
      ambiguities.push({
        type         : 'low_confidence',
        severity     : 'High',
        actionType   : action.action,
        column       : action.column,
        confidence   : action.confidence,
        description  : `AI confidence is only ${action.confidence}% for "${action.action}" on "${action.column || 'dataset'}". Manual review recommended.`,
        requiresHuman: true,
        context      : { action },
      });
    }

    // High-risk destructive actions
    if (action.isDestructive && action.risk === 'High') {
      ambiguities.push({
        type         : 'high_risk_destructive',
        severity     : 'High',
        actionType   : action.action,
        column       : action.column,
        description  : `"${action.action}" on "${action.column || 'dataset'}" is a HIGH RISK destructive operation.`,
        requiresHuman: true,
        context      : { action },
      });
    }

    // removeNulls on critical columns
    if (action.action === 'removeNulls' && action.column) {
      const col = columnMap.get(action.column);
      if (col && rowCount > 0 && (col.nullCount / safeRowCount) > 0.15) {
        ambiguities.push({
          type         : 'large_deletion',
          severity     : 'High',
          actionType   : 'removeNulls',
          column       : action.column,
          description  : `Removing nulls from "${action.column}" will delete ${col.nullCount} rows (${(col.nullCount / safeRowCount * 100).toFixed(1)}% of dataset).`,
          requiresHuman: true,
          context      : { action, nullCount: col.nullCount, rowCount },
        });
      }
    }

    // dropColumn on column with data
    if (action.action === 'dropColumn' && action.column) {
      const col = columnMap.get(action.column);
      if (col) {
        // FIX 2: Use col.totalCount with fallback to rowCount
        const effectiveTotal = typeof col.totalCount === 'number' ? col.totalCount : rowCount;
        const nonNullCount   = effectiveTotal - (col.nullCount || 0);
        if (nonNullCount > 0) {
          ambiguities.push({
            type         : 'drop_non_empty_column',
            severity     : 'Medium',
            actionType   : 'dropColumn',
            column       : action.column,
            description  : `Dropping "${action.column}" which contains ${nonNullCount} non-empty values.`,
            requiresHuman: true,
            context      : { action, nonNullCount },
          });
        }
      }
    }
  }

  // ── FIX 3: Issue-correlated ambiguities ────────────────────────────────────
  // Previously: issues parameter was accepted but never used.
  // Now: high-severity issues with large impact generate additional warnings.
  if (Array.isArray(issues)) {
    for (const issue of issues) {
      if (
        issue.severity === 'High' &&
        typeof issue.affectedPercent === 'number' &&
        issue.affectedPercent > 20
      ) {
        // Only add if not already flagged by an action-level ambiguity
        const alreadyFlagged = ambiguities.some(
          a => a.column === issue.column && a.actionType !== undefined
        );
        if (!alreadyFlagged) {
          ambiguities.push({
            type         : 'high_impact_issue',
            severity     : 'High',
            actionType   : null,
            column       : issue.column,
            description  : `Issue "${issue.type}" in "${issue.column || 'dataset'}" affects ${issue.affectedPercent}% of rows (${issue.affectedCount} rows). Consider reviewing before any action.`,
            requiresHuman: true,
            context      : { issue },
          });
        }
      }
    }
  }

  return ambiguities;
}

/**
 * FIX 1: Build column metadata Map handling both column formats.
 *
 * When columns = string[], we have no metadata object — use schema instead.
 * When columns = [{name, nullCount, totalCount}], use those objects.
 * When schema is provided, it takes priority for null/total counts.
 *
 * @param {Array<Object>|string[]} columns
 * @param {Object}                 [schema]   — { colName: { nullCount, totalCount, ... } }
 * @param {number}                 [rowCount] — fallback for totalCount when schema absent
 * @returns {Map<string, Object>}  colName → { nullCount, totalCount, ... }
 */
function _buildColumnMap(columns, schema, rowCount) {
  const map = new Map();

  if (!columns || !columns.length) return map;

  if (typeof columns[0] === 'string') {
    // string[] — no embedded metadata, use schema or rowCount as fallback
    for (const colName of columns) {
      if (schema && schema[colName]) {
        map.set(colName, {
          ...schema[colName],
          // Ensure totalCount present (added in dataAnalyzer FIX 1 this batch)
          totalCount: schema[colName].totalCount ?? rowCount ?? 0,
        });
      } else {
        // No schema — minimal stub so callers don't crash
        map.set(colName, { nullCount: 0, totalCount: rowCount ?? 0 });
      }
    }
  } else {
    // [{name, nullCount?, totalCount?}] format
    for (const col of columns) {
      const colName = col.name || col.column || String(col);
      if (!colName) continue;

      // Schema takes priority for accurate counts
      const schemaEntry = schema && schema[colName];
      map.set(colName, {
        ...(schemaEntry || {}),
        ...col,
        // Ensure totalCount is always present
        totalCount: col.totalCount ?? schemaEntry?.totalCount ?? rowCount ?? 0,
        nullCount : col.nullCount  ?? schemaEntry?.nullCount  ?? 0,
      });
    }
  }

  return map;
}

/**
 * Quick check: does this set of actions contain any that require human review?
 */
function hasAmbiguities(actions, issues, columns, rowCount, schema) {
  return detect(actions, issues, columns, rowCount, schema).some(a => a.requiresHuman);
}

module.exports = { detect, hasAmbiguities };
