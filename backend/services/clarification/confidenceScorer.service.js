'use strict';
/**
 * backend/services/clarification/confidenceScorer.service.js
 *
 * CHANGES FROM V1 (this version):
 *
 *   FIX 1 — issue null guard (Problem B from audit — CRITICAL)
 *     Previous: clearIssueTypes.includes(issue.type) crashed with
 *     "Cannot read properties of undefined (reading 'type')" when
 *     actionPlanner passed a null/undefined issue.
 *     This was identified as a real pattern: action generation can succeed
 *     while issue lookup fails, leaving issue=undefined.
 *     Fix: Early return with a safe default score when issue is falsy.
 *
 *   FIX 2 — columnStats schema path validation (Problem C from audit)
 *     Previous: columnStats.nullCount assumed callers passed the right shape.
 *     But callers may pass schema[column] (nested object) OR the column
 *     metadata object directly. Both shapes now handled explicitly.
 *     If columnStats is undefined/null, factor 2 is skipped entirely
 *     (no crash, no inaccurate penalty).
 *
 *   FIX 3 — bonus cap preserved across all factor applications
 *     Previous cap: Math.min(baseScore + delta, 85) was applied correctly
 *     in V1 but only for 2 of 5 factors. FIX: all additive factors now
 *     go through _cappedAdd() to ensure the 85 ceiling is never exceeded.
 *
 *   All previous fixes (AI confidence cap at 85, divide-by-zero guards) preserved.
 */

const MAX_AI_CONFIDENCE = 85;  // AI can never self-certify above this

/**
 * @param {Object}  action       — validated AI action (may have confidence 0-100)
 * @param {Object}  [issue]      — the data issue this action addresses (may be null)
 * @param {Object}  [columnStats] — stats for the target column (from schema[col] or col object)
 * @param {number}  rowCount     — total dataset rows
 * @returns {Object} { score, factors, recommendation }
 */
function score(action, issue, columnStats, rowCount) {
  // FIX 1: Guard against undefined/null issue — real occurrence in action pipelines
  if (!issue || typeof issue !== 'object') {
    const baseScore = Math.min(action?.confidence || 50, MAX_AI_CONFIDENCE);
    return {
      score         : baseScore,
      factors       : [{ name: 'no_issue_context', delta: 0 }],
      recommendation: baseScore >= 80 ? 'auto_suggest' : baseScore >= 60 ? 'warn_confirm' : 'require_review',
    };
  }

  // Cap AI confidence — prevents self-certification of dangerous actions
  let baseScore = Math.min(action?.confidence || 50, MAX_AI_CONFIDENCE);
  const factors = [];

  // FIX 2: Safe rowCount
  const safeRowCount = rowCount > 0 ? rowCount : 1;

  // FIX 2: Normalize columnStats — handle both schema[col] and column-object shapes
  const stats = _normaliseColumnStats(columnStats, rowCount);

  // ── Factor 1: Clear issue type → small bonus ──────────────────────────────
  const clearIssueTypes = ['missing', 'duplicate', 'format_inconsistency'];
  if (clearIssueTypes.includes(issue.type)) {
    baseScore = _cappedAdd(baseScore, 5);
    factors.push({ name: 'clear_issue_type', delta: +5 });
  }

  // ── Factor 2: High null rate → uncertainty penalty ────────────────────────
  // FIX 2: Only apply when stats are available and rowCount > 0
  if (stats && rowCount > 0 && (stats.nullCount / safeRowCount) > 0.3) {
    baseScore = Math.max(baseScore - 10, 0);
    factors.push({ name: 'high_null_rate', delta: -10 });
  }

  // ── Factor 3: Destructive action on large portion of data ─────────────────
  if (action?.isDestructive) {
    const affectedPct = rowCount > 0
      ? (issue.affectedCount || 0) / safeRowCount
      : 0;
    if (affectedPct > 0.2) {
      baseScore = Math.max(baseScore - 15, 0);
      factors.push({ name: 'large_destructive', delta: -15 });
    }
  }

  // ── Factor 4: Safe fill method (mean/median on numeric) → bonus ───────────
  if (
    action?.action === 'fillMissing' &&
    ['mean', 'median'].includes(action.parameters?.method)
  ) {
    baseScore = _cappedAdd(baseScore, 8);
    factors.push({ name: 'safe_fill_method', delta: +8 });
  }

  // ── Factor 5: Custom fill value → uncertainty penalty ────────────────────
  if (
    action?.action === 'fillMissing' &&
    action.parameters?.method === 'custom'
  ) {
    baseScore = Math.max(baseScore - 10, 0);
    factors.push({ name: 'custom_fill_value', delta: -10 });
  }

  const finalScore = Math.round(baseScore);

  return {
    score         : finalScore,
    factors,
    recommendation: finalScore >= 80
      ? 'auto_suggest'
      : finalScore >= 60
        ? 'warn_confirm'
        : 'require_review',
  };
}

/**
 * FIX 3: Apply bonus while enforcing the MAX_AI_CONFIDENCE ceiling.
 */
function _cappedAdd(score, delta) {
  return Math.min(score + delta, MAX_AI_CONFIDENCE);
}

/**
 * FIX 2: Normalize columnStats to a consistent shape.
 * Callers may pass:
 *   schema[colName]                    → { type, nullCount, nullPct, uniqueCount, totalCount }
 *   a column metadata object           → { name, nullCount, totalCount }
 *   undefined / null                   → return null (caller skips stat-based factors)
 *
 * @param {Object|undefined} columnStats
 * @param {number} rowCount — fallback for totalCount
 * @returns {{ nullCount: number, totalCount: number } | null}
 */
function _normaliseColumnStats(columnStats, rowCount) {
  if (!columnStats || typeof columnStats !== 'object') return null;

  return {
    nullCount : typeof columnStats.nullCount  === 'number' ? columnStats.nullCount  : 0,
    totalCount: typeof columnStats.totalCount === 'number' ? columnStats.totalCount : (rowCount || 0),
    ...columnStats,
  };
}

module.exports = { score };

