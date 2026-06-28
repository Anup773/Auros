'use strict';
/**
 * backend/pipelines/steps/replaceValues.step.js
 *
 * CHANGES FROM V2:
 *   - NAN HANDLING FIX: NaN can now be used as `find` value.
 *     Old: NaN === NaN → false — replace NaN with 0 never worked.
 *     New: Number.isNaN(val) && Number.isNaN(find) special-cased before
 *          standard type+value comparison. Strict-mode only.
 *
 *   - HASOWNPROPERTY FIX: replaced `column in r` with
 *     Object.prototype.hasOwnProperty.call(r, column).
 *     Prevents false positives from inherited properties.
 *
 *   - SUMMARY FIX: uses JSON.stringify(find) and JSON.stringify(replace)
 *     instead of template-string coercion.
 *     Old: `${find}` → "[object Object]" for objects — unusable audit trail.
 *     New: proper JSON representation for all types.
 *
 *   - OBJECT COMPARISON NOTE (documented): object values are compared by
 *     reference (===), not by structure. {currency:"USD"} !== {currency:"USD"}
 *     unless they are the same object instance. This is intentional — deep
 *     equality at scale is expensive and out of scope for this step.
 *
 * PRESERVED FROM V2:
 *   - strict: true (DEFAULT) — type-aware exact match
 *   - strict: false          — String coercion fallback (legacy, opt-in only)
 */

function execute(rows, step) {
  const { column }                       = step;
  const { find, replace, strict = true } = step.parameters || {};

  if (!column)              throw new Error('replaceValues requires step.column');
  if (find    === undefined) throw new Error('replaceValues requires parameters.find');
  if (replace === undefined) throw new Error('replaceValues requires parameters.replace');

  // FIX: hasOwnProperty — prevents false positives from inherited properties
  if (rows.length > 0 && !rows.some(r =>
    Object.prototype.hasOwnProperty.call(r, column)
  )) {
    throw new Error(`replaceValues: column "${column}" does not exist in dataset`);
  }

  const outputRows      = [];
  const affectedIndices = [];

  for (let i = 0; i < rows.length; i++) {
    const row = { ...rows[i] };
    const val = row[column];

    let isMatch;

    if (strict) {
      // FIX: NaN special case — NaN === NaN is false in JS, use Number.isNaN
      if (Number.isNaN(find) && Number.isNaN(val)) {
        isMatch = true;
      } else {
        // Type must match AND value must match (prevents "0" matching false, etc.)
        isMatch = typeof val === typeof find && val === find;
      }
    } else {
      // Legacy: String coercion fallback (opt-in only via strict: false)
      // NOTE: NaN in legacy mode still won't match via String coercion ("NaN" === "NaN" may
      // produce unexpected results). Use strict mode for reliable NaN replacement.
      if (Number.isNaN(find) && Number.isNaN(val)) {
        isMatch = true;
      } else {
        isMatch = typeof val === typeof find
          ? val === find
          : String(val) === String(find);
      }
    }

    if (isMatch) {
      row[column] = replace;
      affectedIndices.push(i);
    }

    outputRows.push(row);
  }

  // FIX: JSON.stringify for accurate audit trail regardless of value type
  // e.g. objects, null, booleans, numbers all render correctly
  const findStr    = _safeStringify(find);
  const replaceStr = _safeStringify(replace);

  return {
    rows            : outputRows,
    inputRowCount   : rows.length,
    affectedCount   : affectedIndices.length,
    affectedIndices,
    columnStats     : {
      column,
      find,
      replace,
      replacedCount : affectedIndices.length,
      strict,
      // NOTE: object values matched by reference only, not deep equality
      objectMatchNote: (typeof find === 'object' && find !== null)
        ? 'Object find values are compared by reference (===), not by structure.'
        : undefined,
    },
    summary: `Replaced ${affectedIndices.length} occurrence(s) of ${findStr} with ${replaceStr} in "${column}".`,
  };
}

/**
 * Safely stringify any value for human-readable summaries/audit logs.
 * Falls back to String() if JSON.stringify throws (e.g. circular refs).
 */
function _safeStringify(val) {
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

module.exports = { execute };
