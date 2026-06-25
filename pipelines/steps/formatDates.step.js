'use strict';
/**
 * backend/pipelines/steps/formatDates.step.js
 *
 * CHANGES FROM V2 (addressing audit findings):
 *
 *   [AUDIT #1 - HIGH] INVALID DATE VALIDATION: impossible dates now rejected.
 *     Dates like 31/02/2025 or 30/02/2025 passed silently in V2. A new
 *     _isCalendarValid(year, month, day) check runs after parsing and rejects
 *     any date where the day exceeds the real number of days in that month.
 *     Leap years are handled correctly (see [AUDIT #3] below).
 *     Rejected dates are recorded in parseFailures, left unchanged in output.
 *
 *   [AUDIT #2 - HIGH] JS Date() FALLBACK REMOVED.
 *     V2 fell back to new Date(str) for unrecognised strings. The JS Date
 *     constructor is locale- and platform-dependent: "01-02-2025" parses as
 *     Feb 1 on Windows and Jan 2 on some Linux environments. In financial
 *     systems this silently corrupts accounting data. The fallback is removed.
 *     Only the three explicit formats (YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY)
 *     are accepted. Unrecognised strings go to parseFailures unchanged.
 *
 *   [AUDIT #3 - HIGH] LEAP YEAR VALIDATION in _isCalendarValid().
 *     29/02/2023 was accepted in V2. The calendar validity check now uses
 *     _daysInMonth(month, year) which correctly computes February's length
 *     using the proleptic Gregorian leap-year rule (divisible by 4, except
 *     centuries unless also divisible by 400).
 *
 *   [AUDIT #4 - LOW] AMBIGUOUS DATE MESSAGE CORRECTED.
 *     The V2 interpretation1 label was templated as `Feb ${day}` regardless
 *     of which part was the month, which could display the wrong month name.
 *     Both interpretations are now shown as unambiguous date strings built
 *     from the two explicit parse paths (DD/MM and MM/DD).
 *
 *   V2 fixes retained:
 *     - ambiguousDatePolicy: 'flag' | 'assume_dmy' | 'assume_mdy'
 *     - parseFailures / ambiguousDates tracking in columnStats
 *     - Supported formats: YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY
 */

const SUPPORTED_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY'];

/**
 * @param {Array<Object>} rows
 * @param {Object} step — {
 *   column: string,
 *   parameters: {
 *     targetFormat:        'YYYY-MM-DD' | 'DD/MM/YYYY' | 'MM/DD/YYYY',
 *     ambiguousDatePolicy: 'flag' | 'assume_dmy' | 'assume_mdy'  (default 'flag')
 *   }
 * }
 */
function execute(rows, step) {
  const { column } = step;
  const {
    targetFormat,
    ambiguousDatePolicy = 'flag',
  } = step.parameters || {};

  if (!column)       throw new Error('formatDates requires step.column');
  if (!targetFormat) throw new Error('formatDates requires parameters.targetFormat');

  if (!SUPPORTED_FORMATS.includes(targetFormat)) {
    throw new Error(
      `formatDates: unsupported targetFormat "${targetFormat}". ` +
      `Supported: ${SUPPORTED_FORMATS.join(', ')}`
    );
  }

  if (!['flag', 'assume_dmy', 'assume_mdy'].includes(ambiguousDatePolicy)) {
    throw new Error(
      `formatDates: invalid ambiguousDatePolicy "${ambiguousDatePolicy}". ` +
      `Must be: 'flag' | 'assume_dmy' | 'assume_mdy'`
    );
  }

  const outputRows      = [];
  const affectedIndices = [];
  const parseFailures   = [];
  const ambiguousDates  = [];

  for (let i = 0; i < rows.length; i++) {
    const row = { ...rows[i] };
    const raw = row[column];

    if (raw === null || raw === undefined || String(raw).trim() === '') {
      outputRows.push(row);
      continue;
    }

    const str         = String(raw).trim();
    const parseResult = _parseDate(str, ambiguousDatePolicy);

    // ── Unparseable ───────────────────────────────────────────────────────────
    if (!parseResult) {
      parseFailures.push({ rowIndex: i, rawValue: raw, reason: 'unrecognised format' });
      outputRows.push(row);
      continue;
    }

    // ── [AUDIT #1 + #3] Calendar validity check ───────────────────────────────
    // Catches impossible dates (31 Feb, 30 Feb, 31 Apr) and invalid leap days.
    if (!parseResult.ambiguous) {
      const yr  = parseInt(parseResult.year,  10);
      const mo  = parseInt(parseResult.month, 10);
      const dy  = parseInt(parseResult.day,   10);

      if (!_isCalendarValid(yr, mo, dy)) {
        parseFailures.push({
          rowIndex: i,
          rawValue: raw,
          reason  : `Invalid date: ${parseResult.day}/${parseResult.month}/${parseResult.year} does not exist in the calendar`,
        });
        outputRows.push(row);
        continue;
      }
    }

    // ── Ambiguous date (policy = 'flag') ──────────────────────────────────────
    if (parseResult.ambiguous) {
      if (ambiguousDatePolicy === 'flag') {
        const p1 = parseResult.part1;
        const p2 = parseResult.part2;
        const yr = parseResult.year;

        // [AUDIT #4] Both interpretations shown as actual dates, not templates.
        ambiguousDates.push({
          rowIndex       : i,
          rawValue       : raw,
          // DD/MM/YYYY interpretation: part1=day, part2=month
          interpretation1: `${String(p1).padStart(2,'0')}/${String(p2).padStart(2,'0')}/${yr} (DD/MM/YYYY → ${_monthName(p2)} ${p1})`,
          // MM/DD/YYYY interpretation: part1=month, part2=day
          interpretation2: `${String(p1).padStart(2,'0')}/${String(p2).padStart(2,'0')}/${yr} (MM/DD/YYYY → ${_monthName(p1)} ${p2})`,
          message: `Date "${raw}" is ambiguous. Set ambiguousDatePolicy to 'assume_dmy' or 'assume_mdy' to convert automatically.`,
        });
        outputRows.push(row);
        continue;
      }

      // Policy forces a specific interpretation — validate after resolution.
      const yr  = parseInt(parseResult.year,  10);
      let   mo, dy;

      if (ambiguousDatePolicy === 'assume_dmy') {
        dy = parseResult.part1; mo = parseResult.part2; // DD/MM
      } else {
        mo = parseResult.part1; dy = parseResult.part2; // MM/DD
      }

      if (!_isCalendarValid(yr, mo, dy)) {
        parseFailures.push({
          rowIndex: i,
          rawValue: raw,
          reason  : `Resolved date (${ambiguousDatePolicy}) is not a valid calendar date`,
        });
        outputRows.push(row);
        continue;
      }

      // Rebuild a concrete (non-ambiguous) parse result for formatting.
      parseResult.month     = String(mo).padStart(2, '0');
      parseResult.day       = String(dy).padStart(2, '0');
      parseResult.ambiguous = false;
    }

    // ── Format and replace ────────────────────────────────────────────────────
    const formatted = _formatDate(parseResult, targetFormat);

    if (formatted !== raw) {
      affectedIndices.push(i);
      row[column] = formatted;
    }

    outputRows.push(row);
  }

  return {
    rows            : outputRows,
    inputRowCount   : rows.length,
    affectedCount   : affectedIndices.length,
    affectedIndices,
    columnStats     : {
      column,
      targetFormat,
      ambiguousDatePolicy,
      formattedCount     : affectedIndices.length,
      parseFailureCount  : parseFailures.length,
      ambiguousCount     : ambiguousDates.length,
      parseFailureSamples: parseFailures.slice(0, 5),
      ambiguousSamples   : ambiguousDates.slice(0, 5),
    },
    summary: [
      `Reformatted ${affectedIndices.length} date(s) in "${column}" to ${targetFormat}.`,
      parseFailures.length  > 0 ? `${parseFailures.length} unparseable/invalid value(s) left unchanged.`  : '',
      ambiguousDates.length > 0 ? `${ambiguousDates.length} ambiguous date(s) flagged for review.` : '',
    ].filter(Boolean).join(' '),
  };
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * Parse a date string into parts.
 *
 * Returns one of:
 *   null                                              — unrecognised format
 *   { year, month, day }                              — unambiguous
 *   { year, part1, part2, ambiguous: true }           — needs policy resolution
 *
 * [AUDIT #2] new Date() fallback is intentionally absent.
 *
 * @param {string} str
 * @param {string} policy
 * @returns {Object|null}
 */
function _parseDate(str, policy) {
  // ── ISO 8601: YYYY-MM-DD — always unambiguous ─────────────────────────────
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    return { year: m[1], month: m[2], day: m[3] };
  }

  // ── DD/MM/YYYY or MM/DD/YYYY (separator: / or -) ──────────────────────────
  m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const part1 = parseInt(m[1], 10);
    const part2 = parseInt(m[2], 10);
    const year  = m[3];

    // Validate both parts are plausible before doing anything else
    if (part1 < 1 || part2 < 1 || part1 > 31 || part2 > 31) return null;

    // Unambiguous: only one valid interpretation
    if (part1 > 12) {
      // part1 can only be a day
      return {
        year,
        month: String(part2).padStart(2, '0'),
        day  : String(part1).padStart(2, '0'),
      };
    }
    if (part2 > 12) {
      // part2 can only be a day
      return {
        year,
        month: String(part1).padStart(2, '0'),
        day  : String(part2).padStart(2, '0'),
      };
    }

    // Both ≤ 12: ambiguous
    if (policy === 'flag') {
      return { year, part1, part2, ambiguous: true };
    }
    if (policy === 'assume_dmy') {
      // part1=day, part2=month
      return {
        year,
        month: String(part2).padStart(2, '0'),
        day  : String(part1).padStart(2, '0'),
      };
    }
    if (policy === 'assume_mdy') {
      // part1=month, part2=day
      return {
        year,
        month: String(part1).padStart(2, '0'),
        day  : String(part2).padStart(2, '0'),
      };
    }
  }

  // [AUDIT #2] No further fallback — caller records as parseFailure.
  return null;
}

// ── Calendar validation ───────────────────────────────────────────────────────

/**
 * [AUDIT #1 + #3] Returns true only if (year, month, day) is a real calendar date.
 * Handles varying month lengths and leap years correctly.
 *
 * @param {number} year
 * @param {number} month  1-based
 * @param {number} day    1-based
 * @returns {boolean}
 */
function _isCalendarValid(year, month, day) {
  if (month < 1 || month > 12) return false;
  if (day   < 1)               return false;
  return day <= _daysInMonth(month, year);
}

/**
 * [AUDIT #3] Return the number of days in a given month, accounting for leap years.
 *
 * Leap year rule (proleptic Gregorian):
 *   Divisible by 4 → leap, UNLESS divisible by 100, UNLESS also divisible by 400.
 *
 * @param {number} month  1-based
 * @param {number} year
 * @returns {number}
 */
function _daysInMonth(month, year) {
  const DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2) {
    const isLeap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
    return isLeap ? 29 : 28;
  }
  return DAYS[month] || 0;
}

// ── Formatting ────────────────────────────────────────────────────────────────

function _formatDate({ year, month, day }, targetFormat) {
  switch (targetFormat) {
    case 'YYYY-MM-DD': return `${year}-${month}-${day}`;
    case 'DD/MM/YYYY': return `${day}/${month}/${year}`;
    case 'MM/DD/YYYY': return `${month}/${day}/${year}`;
    default: throw new Error(`Unknown targetFormat: ${targetFormat}`);
  }
}

// ── [AUDIT #4] Human-readable month names for ambiguity messages ──────────────

const MONTH_NAMES = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function _monthName(m) {
  return MONTH_NAMES[parseInt(m, 10)] || `month ${m}`;
}

module.exports = { execute };