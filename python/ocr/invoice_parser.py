"""
backend/python/ocr/invoice_parser.py

Deterministic invoice field parser.
Zero AI. Pure regex + rule engine.

CHANGES FROM V1 (this version):

  FIX 1 — Invoice number regex expanded (Bug #5)
    Previous: only matched "invoice no:", "inv:", "bill no:".
    Many real invoices use "Invoice #", "Reference", "Document No",
    "Bill Ref", "Tax Invoice No", "Ref#" — all now matched.

  FIX 2 — Vendor detection is now case-insensitive (Bug #6)
    Previous: required capital first letter [A-Z] — OCR output is rarely
    perfectly capitalized. "amazon web services" would fail entirely.
    Fix: Added case-insensitive flag everywhere vendor patterns are applied,
    and added a row-scan fallback that doesn't require capitalization.

  FIX 3 — Amount extraction now prioritizes Grand Total (Bug #7 — CRITICAL)
    Previous: AMOUNT_PATTERNS found "Total" first, capturing subtotal (100)
    instead of "Grand Total" (113) on typical multi-line invoices.
    Fix: Patterns are now ordered: Grand Total / Amount Due → Total.
    This is a serious accounting bug — wrong amounts cause reconciliation
    mismatches on every invoice with tax lines.

  FIX 4 — Currency uses explicit code before symbol (Bug #8)
    Previous: "$" always mapped to "USD", missing AUD/CAD/NZD/SGD/HKD.
    Fix: Search for explicit currency code (USD, AUD, CAD, etc.) FIRST.
    Only fall back to symbol mapping when no code is found.

  FIX 5 — PO patterns expanded (Bug #5 equivalent for PO)
    Added: "Req#", "Reference", "Order Ref", "PO Ref", "Ref No".

  FIX 6 — _normalize_to_reconciliation_rows() always creates a row (Bug #6)
    Previous: if has_amount_col was False AND fields was empty → no rows.
    Most scanned invoices have no "amount" column header — they just have
    a grand total line. The fix: always emit at least one row when fields
    were extracted, regardless of column structure.

  FIX 7 — Date ambiguity: DD/MM vs MM/DD now configurable
    Added DATE_FORMAT_PREFERENCE env var ('DMY' or 'MDY', default 'DMY').
    DMY = European/Asian (01/02/2025 = 1 Feb). MDY = US (= 2 Jan).
"""

import os
import re
from datetime import datetime
from typing import Any

# ── Date format preference ─────────────────────────────────────────────────────
# Set DATE_FORMAT_PREFERENCE=MDY for US date order (MM/DD/YYYY).
# Default is DMY (DD/MM/YYYY) used in South Asia, Europe, most of the world.
_DATE_PREF = os.environ.get('DATE_FORMAT_PREFERENCE', 'DMY').upper()

# ── Field extraction patterns ──────────────────────────────────────────────────

# FIX 1: Expanded invoice number patterns
INVOICE_NUMBER_PATTERNS = [
    r'(?:invoice\s*(?:no|num|number|#|id|ref)[\s:\.]*)([\w\-/]+)',
    r'(?:inv[\s#:\-\.]*(?:no|num|number|#|id)?[\s:\.]*)([\w\-/]+)',
    r'(?:bill\s*(?:no|number|#|ref)[\s:\.]*)([\w\-/]+)',
    r'(?:tax\s+invoice\s*(?:no|number|#)?[\s:\.]*)([\w\-/]+)',
    r'(?:document\s*(?:no|number|#)[\s:\.]*)([\w\-/]+)',
    r'(?:reference\s*(?:no|number|#)?[\s:\.]*)([\w\-/]+)',
    r'(?:ref\s*(?:no|number|#)?[\s:\.]*)([\w\-/]+)',
    r'(?:\sinvoice[\s:#\.])([\w\-/]+)',
    r'^(INV[\-/\s]?\d+)',
    r'^(BILL[\-/\s]?\d+)',
]

# FIX 2: Case-insensitive, relaxed vendor patterns
VENDOR_PATTERNS = [
    # Explicit label before vendor name
    r'(?:from|vendor|supplier|billed\s*by|sold\s*by|company|bill\s*to\s*vendor)[\s:]+([A-Za-z0-9][A-Za-z0-9\s.,&\-_]{2,60})',
    # Company suffixes as anchor (case-insensitive)
    r'([A-Za-z0-9][A-Za-z0-9\s.,&\-_]{3,55}(?:LLC|Inc|Pvt|Corp|Co|GmbH|PLC|AG|Ltd|Limited|Private|Services|Solutions|Group|Technologies|Enterprises)\.?)\s*$',
    # Fallback: any reasonable company-looking string at start of line
    r'^([A-Za-z][A-Za-z0-9\s.,&\-_]{5,60})\s*$',
]

DATE_PATTERNS = [
    r'(?:invoice\s*date|date\s*of\s*invoice|bill\s*date|issued\s*(?:on|date)?)[\s:]+(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})',
    r'(?:invoice\s*date|date)[\s:]+(\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2})',
    r'(?:date)[\s:]+([A-Za-z]+\s+\d{1,2},?\s+\d{4})',
    r'(?:date)[\s:]+(\d{1,2}\s+[A-Za-z]+\s+\d{4})',
    r'(?:date)[\s:]+(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})',
]

# FIX 5: Expanded PO patterns
PO_NUMBER_PATTERNS = [
    r'(?:p\.?o\.?\s*(?:no|num|number|#|ref)|purchase\s*order[\s#:\.])([\w\-/]+)',
    r'(?:po\s*(?:no|number|#|ref)[\s:\.]*)([\w\-/]+)',
    r'(?:order\s*(?:ref|no|number|#)[\s:\.]*)([\w\-/]+)',
    r'(?:req\s*(?:no|#|number)?[\s:\.]*)([\w\-/]+)',
]

# FIX 3: Amount patterns — Grand Total / Amount Due BEFORE generic Total
AMOUNT_PATTERNS = [
    # Highest priority — final payable amount
    r'(?:grand\s*total|amount\s*(?:due|payable)|balance\s*(?:due|payable)|total\s*amount\s*due|net\s*(?:amount|payable))[\s:$£€₹]*([0-9,]+\.?\d{0,2})',
    # Medium priority — total
    r'(?:total\s*(?:amount\s*)?)[\s:$£€₹]+([0-9,]+\.?\d{0,2})',
    # Lower priority — plain "total" (may be subtotal)
    r'(?:^|\s)total[\s:$£€₹]+([0-9,]+\.?\d{0,2})',
]

TAX_PATTERNS = [
    r'(?:tax|vat|gst|igst|cgst|sgst)[\s:$£€₹%]*([0-9,]+\.?\d{0,2})',
]

# FIX 4: Explicit currency codes searched FIRST, symbols are fallback
CURRENCY_CODE_PATTERN = r'\b(USD|EUR|GBP|AUD|CAD|JPY|INR|NPR|CHF|NZD|SGD|HKD|CNY|AED|SAR|MYR|THB|IDR|PHP|KRW)\b'
CURRENCY_SYMBOL_PATTERN = r'([$£€₹¥₩])'

CURRENCY_SYMBOL_MAP = {
    '$': 'USD',   # ambiguous — only used when no explicit code found
    '£': 'GBP',
    '€': 'EUR',
    '₹': 'INR',
    '¥': 'JPY',
    '₩': 'KRW',
}


def parse_invoice_fields(rows: list, raw_text: str = '') -> dict:
    """
    Extract structured invoice fields from rows + raw text.

    Returns:
      {
        "fields": { invoice_number, vendor_name, date, po_number, amount, currency, ... },
        "rows"  : [ normalized reconciliation rows ]
      }
    """
    combined_text = raw_text or '\n'.join(
        ' '.join(str(v) for v in row.values()) for row in rows
    )

    fields          = _extract_fields(combined_text, rows)
    normalized_rows = _normalize_to_reconciliation_rows(rows, fields)

    return {
        'fields': fields,
        'rows'  : normalized_rows,
    }


def _extract_fields(text: str, rows: list) -> dict:
    """Extract all invoice fields from text."""
    fields = {}

    # ── Invoice number ─────────────────────────────────────────────────────────
    inv_num = _first_match(text, INVOICE_NUMBER_PATTERNS)
    if inv_num:
        fields['invoice_number'] = inv_num.strip()

    # ── Vendor name ────────────────────────────────────────────────────────────
    # FIX 2: re.IGNORECASE applied; also scan individual lines, not just full text
    vendor = _first_match_lines(text, VENDOR_PATTERNS, flags=re.IGNORECASE | re.MULTILINE)
    if vendor and len(vendor.strip()) > 2:
        fields['vendor_name'] = vendor.strip()

    # Row-scan fallback for vendor
    if not fields.get('vendor_name'):
        for row in rows:
            for key, val in row.items():
                if any(k in key.lower() for k in ['vendor', 'supplier', 'from', 'company', 'billed', 'seller']):
                    if val and len(str(val)) > 2:
                        fields['vendor_name'] = str(val).strip()
                        break
            if fields.get('vendor_name'):
                break

    # ── Date ───────────────────────────────────────────────────────────────────
    date_str = _first_match(text, DATE_PATTERNS)
    if date_str:
        fields['date'] = _normalise_date(date_str)

    # ── PO number ──────────────────────────────────────────────────────────────
    po_num = _first_match(text, PO_NUMBER_PATTERNS)
    if po_num:
        fields['po_number'] = po_num.strip()

    # ── Amount (FIX 3: Grand Total first) ─────────────────────────────────────
    amount_str = _first_match(text, AMOUNT_PATTERNS)
    if amount_str:
        cleaned = amount_str.replace(',', '')
        try:
            fields['amount'] = float(cleaned)
        except ValueError:
            pass

    # ── Tax ────────────────────────────────────────────────────────────────────
    tax_str = _first_match(text, TAX_PATTERNS)
    if tax_str:
        cleaned = tax_str.replace(',', '')
        try:
            fields['tax'] = float(cleaned)
        except ValueError:
            pass

    # ── Currency (FIX 4: code before symbol) ──────────────────────────────────
    currency = _extract_currency(text)
    if currency:
        fields['currency'] = currency

    # ── Line items from rows ───────────────────────────────────────────────────
    line_items = _extract_line_items(rows)
    if line_items:
        fields['line_items'] = line_items

        if not fields.get('amount') and line_items:
            total = sum(item.get('total', 0) or 0 for item in line_items)
            if total > 0:
                fields['amount'] = total

    return fields


def _normalize_to_reconciliation_rows(rows: list, fields: dict) -> list:
    """
    Convert extracted data into rows matching the reconciliation engine schema.

    FIX 6: Always emit at least one row when fields were extracted.
    The previous logic required an "amount column" to exist in tabular rows.
    Most scanned invoices only have a grand total line — no amount column.
    """
    normalized = []

    has_amount_col = any(
        any(k in key.lower() for k in ['amount', 'total', 'price', 'value', 'net'])
        for row in rows for key in row.keys()
    )

    if has_amount_col and rows:
        for row in rows:
            norm = {}
            for key, val in row.items():
                k = key.lower()
                if any(x in k for x in ['invoice', 'inv_no', 'inv_num', 'bill_no', 'ref_no']):
                    norm['invoice_number'] = str(val) if val else fields.get('invoice_number', '')
                elif any(x in k for x in ['vendor', 'supplier', 'from', 'company', 'seller']):
                    norm['vendor_name'] = str(val) if val else fields.get('vendor_name', '')
                elif any(x in k for x in ['amount', 'total', 'value', 'net', 'grand']):
                    # FIX 3 also applies here — skip subtotal/tax columns
                    if any(skip in k for skip in ['sub', 'tax', 'discount', 'vat', 'gst']):
                        norm[key] = val  # keep as raw column, don't override amount
                    else:
                        try:
                            norm['amount'] = float(
                                str(val).replace(',', '').replace('$', '')
                                        .replace('₹', '').replace('€', '')
                                        .replace('£', '').strip()
                            )
                        except (ValueError, AttributeError):
                            norm['amount'] = val
                elif any(x in k for x in ['currency', 'cur', 'curr']):
                    norm['currency'] = str(val) if val else fields.get('currency', '')
                elif any(x in k for x in ['date', 'invoice_date']):
                    norm['date'] = _normalise_date(str(val)) if val else fields.get('date', '')
                elif any(x in k for x in ['po', 'purchase_order', 'order_no', 'req']):
                    norm['po_number'] = str(val) if val else fields.get('po_number', '')
                elif any(x in k for x in ['description', 'desc', 'item', 'service']):
                    norm['description'] = str(val) if val else ''
                else:
                    norm[key] = val

            norm.setdefault('invoice_number', fields.get('invoice_number', ''))
            norm.setdefault('vendor_name',    fields.get('vendor_name', ''))
            norm.setdefault('currency',       fields.get('currency', ''))
            norm.setdefault('date',           fields.get('date', ''))
            norm.setdefault('po_number',      fields.get('po_number', ''))

            if norm.get('invoice_number') or norm.get('vendor_name') or norm.get('amount'):
                normalized.append(norm)

    # FIX 6: Always fall through to field-based row if nothing was produced above.
    # This handles scanned invoices where no tabular structure was detected.
    if not normalized and fields:
        normalized.append({
            'invoice_number': fields.get('invoice_number', ''),
            'vendor_name'   : fields.get('vendor_name', ''),
            'amount'        : fields.get('amount', ''),
            'currency'      : fields.get('currency', ''),
            'date'          : fields.get('date', ''),
            'po_number'     : fields.get('po_number', ''),
            'tax'           : fields.get('tax', ''),
        })

    return normalized


def _extract_line_items(rows: list) -> list:
    """Extract line item details from table rows."""
    items = []
    for row in rows:
        item = {}
        for key, val in row.items():
            k = key.lower()
            if 'qty' in k or 'quantity' in k:
                try:
                    item['quantity'] = float(str(val).replace(',', ''))
                except (ValueError, AttributeError):
                    pass
            elif 'unit' in k and ('price' in k or 'rate' in k or 'cost' in k):
                try:
                    item['unit_price'] = float(str(val).replace(',', '').replace('$', ''))
                except (ValueError, AttributeError):
                    pass
            elif ('total' in k or 'amount' in k) and not any(s in k for s in ('sub', 'tax', 'discount')):
                try:
                    item['total'] = float(str(val).replace(',', '').replace('$', ''))
                except (ValueError, AttributeError):
                    pass
            elif 'desc' in k or 'item' in k or 'product' in k or 'service' in k:
                item['description'] = str(val)
        if item:
            items.append(item)
    return items


def _extract_currency(text: str) -> str:
    """
    Extract currency.
    FIX 4: Search for explicit ISO code FIRST, then fall back to symbol.
    This prevents $ → USD when the invoice is actually AUD or CAD.
    """
    # Priority 1: explicit ISO currency code
    match = re.search(CURRENCY_CODE_PATTERN, text, re.IGNORECASE)
    if match:
        return match.group(1).upper()

    # Priority 2: currency symbol (ambiguous, last resort)
    match = re.search(CURRENCY_SYMBOL_PATTERN, text)
    if match:
        symbol = match.group(1)
        return CURRENCY_SYMBOL_MAP.get(symbol, symbol)

    return ''


def _first_match(text: str, patterns: list, flags: int = re.IGNORECASE | re.MULTILINE) -> str:
    """Return the first capture group match from any pattern."""
    for pattern in patterns:
        match = re.search(pattern, text, flags)
        if match:
            return match.group(1)
    return ''


def _first_match_lines(text: str, patterns: list, flags: int = re.IGNORECASE | re.MULTILINE) -> str:
    """
    Try each pattern against the full text.
    For vendor, this is better than line-by-line because company names
    can span context from the surrounding line.
    """
    for pattern in patterns:
        match = re.search(pattern, text, flags)
        if match:
            result = match.group(1).strip()
            # Sanity check: reject matches that look like junk
            if len(result) >= 3 and not re.match(r'^[\d\s\-\.\/]+$', result):
                return result
    return ''


def _normalise_date(date_str: str) -> str:
    """
    Normalise a date string to YYYY-MM-DD.
    FIX 7: Respects DATE_FORMAT_PREFERENCE env var for ambiguous formats.
    """
    if not date_str:
        return ''
    date_str = date_str.strip()

    # Unambiguous formats first
    unambiguous_formats = [
        '%Y-%m-%d', '%Y/%m/%d',           # ISO — always unambiguous
        '%d %B %Y', '%d %b %Y',           # "15 January 2025"
        '%B %d, %Y', '%b %d, %Y',         # "January 15, 2025"
        '%d-%m-%Y', '%d.%m.%Y',           # European with explicit separator
    ]
    for fmt in unambiguous_formats:
        try:
            return datetime.strptime(date_str, fmt).strftime('%Y-%m-%d')
        except ValueError:
            continue

    # Ambiguous: DD/MM/YYYY vs MM/DD/YYYY — use preference
    ambiguous_formats_dmy = ['%d/%m/%Y', '%d/%m/%y']
    ambiguous_formats_mdy = ['%m/%d/%Y', '%m/%d/%y']

    if _DATE_PREF == 'MDY':
        ordered = ambiguous_formats_mdy + ambiguous_formats_dmy
    else:
        ordered = ambiguous_formats_dmy + ambiguous_formats_mdy

    for fmt in ordered:
        try:
            return datetime.strptime(date_str, fmt).strftime('%Y-%m-%d')
        except ValueError:
            continue

    return date_str  # return as-is if we can't parse
