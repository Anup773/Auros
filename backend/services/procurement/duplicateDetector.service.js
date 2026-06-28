'use strict';
/**
 * backend/services/procurement/duplicateDetector.service.js
 *
 * CHANGES FROM V2 (addressing new audit findings):
 *
 *   [AUDIT #1 - MEDIUM-HIGH] LARGE-BUCKET NEAR-DUPLICATE EXPLOSION prevented.
 *     V2 fixed the O(n²) global scan by grouping on vendor+amount, but within
 *     a single large bucket (e.g. 500 invoices from the same vendor at the same
 *     amount) we still did 500² = 250,000 comparisons.
 *
 *     Fix: within each bucket, invoices are sorted by date ascending, then a
 *     SLIDING WINDOW of width DATE_WINDOW_DAYS (7) advances through the sorted
 *     list. Only invoices whose dates fall within the window are compared against
 *     each other. Once the earliest invoice in the window is more than 7 days
 *     older than the current invoice, it is dropped from the window.
 *
 *     Worst case: a bucket of n invoices all on the same date → O(n²) for that
 *     bucket, but this is realistic only for truly identical invoices (which are
 *     already caught by exact duplicate detection). Typical case: O(n log n)
 *     sort + O(n·w) where w is the average window width (usually 1-3).
 *
 *   [AUDIT #2 - HIGH] AMOUNT NORMALISATION for bucket key.
 *     Previously amount was used raw as a string. Amounts "100", "100.0", and
 *     "100.00" formed different buckets and near-duplicates were missed.
 *     Fix: _normalizeAmount() parses to float and formats to 2 decimal places.
 *     Non-numeric amounts (e.g. blank) are excluded from near-dup detection.
 *
 *   [AUDIT #3 - MEDIUM] CURRENCY-AWARE BUCKETING.
 *     Fix: bucket key now includes the normalised currency code so that
 *     USD 100 and NPR 100 are never considered duplicates.
 *     Currency is read from inv.currency || inv.currencyCode || inv.Currency.
 *     Invoices with no currency field are bucketed under '__NOCURRENCY__' —
 *     still compared with each other but not with currency-tagged invoices.
 *
 *   [AUDIT #4 - LOW-MEDIUM] VENDOR NORMALISATION STRENGTHENED.
 *     Added: 'pvt', 'private', 'limited', 'incorporated', 'co', 'llp',
 *     'pty', 'gmbh', 'srl', 'bv', 'ag', 'sa', plus period-after-abbreviation
 *     handling so "Pvt. Ltd." and "Pvt Ltd" both reduce to the same key.
 *     Multi-space collapse and leading/trailing whitespace trim retained.
 *
 *   V2 fixes retained:
 *     - Exact invoice number duplicate detection (unchanged, already O(n))
 *     - Bucket-based grouping before comparison (O(n) build + O(k²) per bucket)
 *     - Date diff helper with NaN safety
 *     - Total affected invoice count deduplication
 */

const DATE_WINDOW_DAYS = 7; // sliding window width for near-duplicate date check

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @param {Array<Object>} invoices — parsed invoice objects
 * @returns {{ count: number, affectedInvoices: number, groups: Array }}
 */
function detect(invoices) {
  const groups = [];

  // ── 1. Exact invoice number duplicates — O(n), unchanged ──────────────────
  const byInvNum = {};
  for (const inv of invoices) {
    const key = (inv.invoiceNumber || '').toLowerCase().trim();
    if (!key) continue;
    if (!byInvNum[key]) byInvNum[key] = [];
    byInvNum[key].push(inv);
  }
  for (const [num, group] of Object.entries(byInvNum)) {
    if (group.length > 1) {
      groups.push({
        type         : 'exact_invoice_number',
        severity     : 'High',
        invoiceNumber: num,
        count        : group.length,
        invoices     : group,
        message      : `Invoice number "${num}" appears ${group.length} times.`,
      });
    }
  }

  // ── 2. Near-duplicates: same vendor + same amount + same currency + ≤7 days
  //
  // [AUDIT #2] Amount normalised to 2 dp to collapse "100" / "100.0" / "100.00".
  // [AUDIT #3] Currency included in bucket key: USD 100 ≠ NPR 100.
  // [AUDIT #1] Within each bucket: sort by date, then sliding window comparison.

  const nearDupBuckets = {};

  for (const inv of invoices) {
    if (!inv.vendorName) continue;

    // [AUDIT #2] Normalise amount — skip if non-numeric
    const normAmount = _normalizeAmount(inv.amount);
    if (normAmount === null) continue;

    // [AUDIT #3] Normalise currency
    const currency = _normalizeCurrency(inv.currency || inv.currencyCode || inv.Currency);

    const bucketKey = `${normalizeVendor(inv.vendorName)}::${normAmount}::${currency}`;

    if (!nearDupBuckets[bucketKey]) nearDupBuckets[bucketKey] = [];
    nearDupBuckets[bucketKey].push(inv);
  }

  for (const bucket of Object.values(nearDupBuckets)) {
    if (bucket.length < 2) continue;

    // [AUDIT #1] Sort by date ascending — required for sliding window.
    const sorted = _sortByDate(bucket);

    // Sliding window: maintain a list of invoices within DATE_WINDOW_DAYS of
    // the current invoice. Compare current against every invoice in the window.
    const window = [];  // invoices within the date window

    for (let i = 0; i < sorted.length; i++) {
      const current      = sorted[i];
      const currentDate  = _toDateMs(current.date);

      // Evict invoices that have fallen outside the 7-day window
      let wi = 0;
      while (wi < window.length) {
        const windowDate = _toDateMs(window[wi].date);
        if (
          currentDate !== null &&
          windowDate  !== null &&
          (currentDate - windowDate) / 86_400_000 > DATE_WINDOW_DAYS
        ) {
          window.splice(wi, 1);
        } else {
          wi++;
        }
      }

      // Compare current invoice against every invoice still in the window
      for (const prev of window) {
        const dateDiff = getDateDiffDays(current.date, prev.date);
        if (dateDiff !== null && dateDiff <= DATE_WINDOW_DAYS) {
          groups.push({
            type    : 'near_duplicate',
            severity: 'Medium',
            count   : 2,
            invoices: [prev, current],
            message : (
              `Same vendor "${current.vendorName}", amount ${current.amount}` +
              (current.currency ? ` ${current.currency}` : '') +
              ` within ${dateDiff} day(s).`
            ),
          });
        }
      }

      // Add current to the window for future comparisons
      window.push(current);
    }
  }

  const totalDuplicateInvoices = new Set(
    groups.flatMap(g => g.invoices.map(inv => inv._rowIndex))
  ).size;

  return {
    count           : groups.length,
    affectedInvoices: totalDuplicateInvoices,
    groups,
  };
}

// ── Normalisation helpers ─────────────────────────────────────────────────────

/**
 * [AUDIT #4] Strengthened vendor normalisation.
 *
 * Removed suffixes (case-insensitive, whole-word):
 *   pvt, private, limited, ltd, inc, corp, llc, llp, co,
 *   pty, gmbh, srl, bv, ag, sa, incorporated
 *
 * Also strips trailing periods from abbreviations ("Pvt." → "Pvt" → removed)
 * so "ABC Pvt. Ltd." and "ABC Pvt Ltd" both reduce to "abc".
 *
 * @param {string} name
 * @returns {string}
 */
function normalizeVendor(name) {
  return String(name)
    .toLowerCase()
    // Strip trailing periods from individual tokens before word removal
    .replace(/\b(\w+)\./g, '$1')
    // Remove legal-entity suffixes (whole-word match)
    .replace(
      /\b(pvt|private|limited|ltd|inc|corp|llc|llp|co|pty|gmbh|srl|bv|ag|sa|incorporated)\b/g,
      ''
    )
    // Remove punctuation (commas, periods that remain)
    .replace(/[.,]/g, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * [AUDIT #2] Normalise an amount value to a canonical 2-decimal-place string.
 * Returns null for blank / non-numeric values (excluded from near-dup detection).
 *
 * @param {*} amount
 * @returns {string|null}
 */
function _normalizeAmount(amount) {
  if (amount === null || amount === undefined || String(amount).trim() === '') return null;
  const n = parseFloat(String(amount).replace(/,/g, ''));  // handle "1,234.56"
  if (isNaN(n)) return null;
  return n.toFixed(2);
}

/**
 * [AUDIT #3] Normalise a currency code to uppercase trimmed string.
 * Invoices with no currency use a sentinel so they only compare with each other.
 *
 * @param {*} currency
 * @returns {string}
 */
function _normalizeCurrency(currency) {
  if (!currency || String(currency).trim() === '') return '__NOCURRENCY__';
  return String(currency).trim().toUpperCase();
}

/**
 * [AUDIT #1] Sort an array of invoice objects by date ascending.
 * Invoices with unparseable dates are placed at the end.
 *
 * @param {Array<Object>} invoices
 * @returns {Array<Object>}
 */
function _sortByDate(invoices) {
  return [...invoices].sort((a, b) => {
    const ta = _toDateMs(a.date);
    const tb = _toDateMs(b.date);
    if (ta === null && tb === null) return 0;
    if (ta === null) return  1; // nulls to end
    if (tb === null) return -1;
    return ta - tb;
  });
}

/**
 * Convert a date string to a timestamp in ms, or null if unparseable.
 *
 * @param {*} d
 * @returns {number|null}
 */
function _toDateMs(d) {
  if (!d) return null;
  const t = new Date(d).getTime();
  return isNaN(t) ? null : t;
}

/**
 * Return the absolute difference in days between two date strings.
 * Returns null if either date is unparseable.
 *
 * @param {*} d1
 * @param {*} d2
 * @returns {number|null}
 */
function getDateDiffDays(d1, d2) {
  const t1 = _toDateMs(d1);
  const t2 = _toDateMs(d2);
  if (t1 === null || t2 === null) return null;
  return Math.abs(t1 - t2) / 86_400_000;
}

module.exports = { detect, normalizeVendor, getDateDiffDays };
