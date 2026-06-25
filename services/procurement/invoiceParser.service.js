'use strict';
/**
 * backend/services/invoiceParser.service.js
 *
 * CHANGES FROM PREVIOUS VERSION (this version):
 *
 *   FIX 1 — Removed 'number' alias (Issue #1)
 *     Previous: 'number' mapped invoiceNumber → matched "Phone Number",
 *     "Vendor Number", "Account Number" columns incorrectly.
 *     Fix: Removed 'number' from the alias list.
 *
 *   FIX 2 — Currency default is now null, not 'USD' (Issue #2)
 *     Previous: currency: get(row, fieldMap.currency) || 'USD'
 *     A Nepali (NPR) or British (GBP) invoice missing a currency column
 *     was silently assigned USD, causing reconciliation mismatches.
 *     Fix: Returns null when currency is not found. Callers should
 *     handle null explicitly rather than assuming USD.
 *
 *   FIX 3 — Duplicate invoice number detection (Issue #3)
 *     New: findDuplicates() function returns groups of rows sharing
 *     the same invoiceNumber. Called by the reconciliation pipeline
 *     to flag duplicates before approval.
 *
 *   All previous fixes (_normaliseColumnNames, c.name crash fix)
 *   preserved exactly.
 */
 
const FIELD_ALIASES = {
  invoiceNumber : ['invoice_number', 'invoice_no', 'inv_no', 'inv_num', 'invoice#'],
  // FIX 1: 'number' removed — too ambiguous (Phone Number, Vendor Number, etc.)
  vendorName    : ['vendor_name', 'vendor', 'supplier', 'supplier_name', 'party_name', 'from'],
  amount        : ['amount', 'total', 'total_amount', 'invoice_amount', 'value', 'net_amount'],
  date          : ['date', 'invoice_date', 'inv_date', 'transaction_date', 'bill_date'],
  poNumber      : ['po_number', 'po_no', 'purchase_order', 'po#', 'po_ref', 'order_number'],
  dueDate       : ['due_date', 'payment_due', 'due'],
  status        : ['status', 'payment_status', 'paid', 'approval_status'],
  currency      : ['currency', 'curr', 'ccy'],
  taxAmount     : ['tax', 'tax_amount', 'gst', 'vat', 'hsn'],
};
 
async function parse(rows, columns) {
  const colNames = _normaliseColumnNames(columns).map(c => c.toLowerCase());
  const fieldMap = buildFieldMap(colNames);
 
  return rows.map((row, i) => ({
    _rowIndex    : i,
    _raw         : row,
    invoiceNumber: get(row, fieldMap.invoiceNumber) || `INV-${i + 1}`,
    vendorName   : normalize(get(row, fieldMap.vendorName)),
    amount       : parseAmount(get(row, fieldMap.amount)),
    date         : get(row, fieldMap.date),
    poNumber     : get(row, fieldMap.poNumber),
    dueDate      : get(row, fieldMap.dueDate),
    status       : get(row, fieldMap.status),
    // FIX 2: null instead of 'USD' — caller must handle missing currency
    currency     : get(row, fieldMap.currency) || null,
    taxAmount    : parseAmount(get(row, fieldMap.taxAmount)),
  }));
}
 
/**
 * FIX 3: Find groups of invoices sharing the same invoice number.
 * Returns an array of duplicate groups (each group has 2+ invoices).
 */
function findDuplicates(invoices) {
  const groups = new Map();
  for (const inv of invoices) {
    const key = String(inv.invoiceNumber || '').trim().toUpperCase();
    if (!key || key.startsWith('INV-')) continue; // skip auto-generated numbers
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(inv);
  }
  const duplicates = [];
  for (const [number, group] of groups.entries()) {
    if (group.length > 1) {
      duplicates.push({ invoiceNumber: number, count: group.length, invoices: group });
    }
  }
  return duplicates;
}
 
function buildFieldMap(colNames) {
  const map = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const found = aliases.find(alias => colNames.includes(alias));
    map[field] = found || null;
  }
  return map;
}
 
function get(row, colName) {
  if (!colName) return null;
  const key = Object.keys(row).find(k => k.toLowerCase() === colName);
  return key ? row[key] : null;
}
 
function normalize(str) {
  if (!str) return '';
  return String(str).trim().toLowerCase().replace(/\s+/g, ' ');
}
 
function parseAmount(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = parseFloat(String(val).replace(/[,$\s]/g, ''));
  return isNaN(n) ? null : n;
}
 
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
 
module.exports = { parse, findDuplicates, _normaliseColumnNames };