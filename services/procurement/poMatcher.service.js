/**
 * backend/services/poMatcher.service.js
 *
 * CHANGES FROM PREVIOUS VERSION (this version):
 *
 *   FIX 1 — Matching uses BEST match, not first match (Critical Bug)
 *     Previous: poList.find() returned the FIRST vendor+amount match.
 *     "Amazon $1000" and "Amazon $1001" — the invoice "Amazon $1000"
 *     matched "Amazon $1001" if it appeared first in the PO list.
 *     Fix: Score all candidates and return the one with lowest amountDiff.
 *
 *   FIX 2 — Currency must match before amount comparison (Critical Bug)
 *     Previous: 1000 USD and 1000 NPR matched successfully.
 *     1 USD ≈ 133 NPR — a massive financial mismatch silently passed.
 *     Fix: Currency comparison added as a prerequisite for amount matching.
 *     When currency is unknown (null), matching proceeds with a penalty flag.
 *
 *   FIX 3 — Stale PO date flagged (Issue from audit)
 *     Previous: Invoice dated 2026 matched a PO from 2021 with no warning.
 *     Fix: If PO date is more than MAX_PO_AGE_DAYS (730 = 2 years) before
 *     invoice date, match is flagged as 'stale_po'.
 *
 *   All previous fixes (_normaliseColumnNames, c.name crash fix) preserved.
 */
 
const AMOUNT_TOLERANCE  = 0.02;
const MAX_PO_AGE_DAYS   = parseInt(process.env.MAX_PO_AGE_DAYS || '730', 10);
 
async function matchPO(invoices, poRows, poColumns) {
  const poList    = buildPOList(poRows, poColumns);
  const matches   = [];
  const unmatched = [];
 
  for (const invoice of invoices) {
    const match = findBestMatch(invoice, poList);  // FIX 1: best, not first
    if (match) {
      matches.push({
        invoice,
        po           : match.po,
        matchType    : match.type,
        amountDiff   : match.amountDiff,
        amountDiffPct: match.amountDiffPct,
        flagged      : match.amountDiff > 0 || match.stale,
        stalePO      : match.stale || false,
        currencyWarning: match.currencyWarning || false,
      });
    } else {
      unmatched.push({ invoice, reason: 'No matching PO found' });
    }
  }
 
  return { matches, unmatched };
}
 
/**
 * FIX 1: Score all candidates and return best match.
 * FIX 2: Currency check before amount comparison.
 * FIX 3: Flag stale POs.
 */
function findBestMatch(invoice, poList) {
  // Priority 1: Exact PO number match
  if (invoice.poNumber) {
    const po = poList.find(p =>
      p.poNumber &&
      p.poNumber.toLowerCase() === invoice.poNumber.toLowerCase()
    );
    if (po) {
      const diff    = Math.abs((invoice.amount || 0) - (po.amount || 0));
      const diffPct = po.amount ? diff / po.amount : 0;
      return {
        po, type: 'po_number', amountDiff: diff, amountDiffPct: diffPct,
        stale: _isStale(invoice.date, po.date),
        currencyWarning: false,
      };
    }
  }
 
  // Priority 2: Vendor + amount — FIX 1: score all, pick lowest diff
  if (invoice.vendorName && invoice.amount) {
    const normalizedInvVendor = normalizeVendor(invoice.vendorName);
    let bestMatch   = null;
    let bestDiffPct = Infinity;
 
    for (const po of poList) {
      if (!po.vendorName || !po.amount) continue;
      if (normalizeVendor(po.vendorName) !== normalizedInvVendor) continue;
 
      // FIX 2: Currency check
      const currencyWarning = _currencyMismatch(invoice.currency, po.currency);
      if (currencyWarning === 'mismatch') continue; // hard mismatch — skip
 
      const diffPct = Math.abs(invoice.amount - po.amount) / po.amount;
      if (diffPct > AMOUNT_TOLERANCE) continue;
 
      if (diffPct < bestDiffPct) {
        bestDiffPct = diffPct;
        const diff  = Math.abs(invoice.amount - po.amount);
        bestMatch   = {
          po, type: 'vendor_amount', amountDiff: diff, amountDiffPct: diffPct,
          stale: _isStale(invoice.date, po.date),
          currencyWarning: currencyWarning === 'unknown',
        };
      }
    }
 
    if (bestMatch) return bestMatch;
  }
 
  return null;
}
 
/**
 * FIX 2: Currency comparison.
 * Returns: 'ok' | 'unknown' (one or both null) | 'mismatch'
 */
function _currencyMismatch(invCurrency, poCurrency) {
  if (!invCurrency || !poCurrency) return 'unknown';
  return invCurrency.toUpperCase() === poCurrency.toUpperCase() ? 'ok' : 'mismatch';
}
 
/**
 * FIX 3: Check if PO is stale relative to the invoice date.
 */
function _isStale(invoiceDateStr, poDateStr) {
  if (!invoiceDateStr || !poDateStr) return false;
  try {
    const invDate = new Date(invoiceDateStr);
    const poDate  = new Date(poDateStr);
    if (isNaN(invDate) || isNaN(poDate)) return false;
    const diffDays = (invDate - poDate) / (1000 * 60 * 60 * 24);
    return diffDays > MAX_PO_AGE_DAYS;
  } catch {
    return false;
  }
}
 
function buildPOList(rows, columns) {
  const colNames = _normalisePOColumnNames(columns).map(c => c.toLowerCase());
  return rows.map(row => ({
    poNumber  : getCol(row, colNames, ['po_number', 'po_no', 'po#', 'order_number']),
    vendorName: getCol(row, colNames, ['vendor', 'vendor_name', 'supplier']),
    amount    : parseFloat(getCol(row, colNames, ['amount', 'total', 'po_amount', 'value']) || 0),
    currency  : getCol(row, colNames, ['currency', 'curr', 'ccy']) || null,  // FIX 2
    date      : getCol(row, colNames, ['date', 'po_date', 'order_date']),    // FIX 3
    _raw      : row,
  }));
}
 
function getCol(row, colNames, aliases) {
  const found = aliases.find(a => colNames.includes(a));
  if (!found) return null;
  const key = Object.keys(row).find(k => k.toLowerCase() === found);
  return key ? row[key] : null;
}
 
function normalizeVendor(name) {
  return String(name)
    .toLowerCase()
    .replace(/\bpvt\b|\blimited\b|\bltd\b|\binc\b|\bcorp\b|\bllc\b/g, '')
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
 
function _normalisePOColumnNames(columns) {
  if (!columns || !columns.length) return [];
  const first = columns[0];
  if (typeof first === 'string') return columns;
  if (typeof first === 'object' && first !== null && 'name' in first)
    return columns.map(c => c.name).filter(Boolean);
  if (typeof first === 'object' && first !== null && 'column' in first)
    return columns.map(c => c.column).filter(Boolean);
  return columns.map(String).filter(Boolean);
}
 
module.exports = { matchPO, buildPOList, _normalisePOColumnNames };
