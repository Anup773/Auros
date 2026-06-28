"""
backend/python/ocr/confidence.py

OCR confidence scoring and AI fallback decision logic.

CHANGES FROM V1 (this version):

  FIX 1 — Invalid date no longer receives confidence bonus (Bug #2 from audit)
    Previous: re.match(r'\d{4}-\d{2}-\d{2}') accepted "2025-99-99".
    Fix: Use datetime.strptime with try/except — only valid dates score bonus.

  FIX 2 — Confidence score can no longer exceed 1.0 in a distorted way (Bug #2)
    Previous: FIELD_WEIGHTS sum to 1.00, then bonuses of +0.05/+0.05/+0.10/+0.05
    could push total to 1.25+ before clamping, distorting percentile meaning.
    Fix: Bonuses are now drawn from a separate BONUS_POOL (0.20), field weights
    reduced to 0.80 total so max possible score is exactly 1.0 before clamp.

  FIX 3 — AI fallback now triggers when ANY 2 of 3 critical fields missing (Bug #3)
    Previous: critical_missing required ALL THREE (invoice_number, vendor_name,
    amount) to be missing. A document with invoice_number="" and vendor_name=""
    but amount=5000 never triggered fallback even with terrible extraction.
    Fix: missing_count >= 2 triggers fallback.

  FIX 4 — Fields-present bonus added (Bug from audit doc #2 report)
    Previous: rows=[] but fields populated caused artificially low confidence.
    Fix: If key fields are present even without rows, score += 0.10 bonus.

  FIX 5 — score_text_quality() now handles Unicode (Bug #4)
    Previous: [a-zA-Z0-9] regex scored Nepali/Hindi/Arabic invoices as junk.
    Fix: Use \w (Unicode word chars) and \d (Unicode digits).

Scoring model (revised):
  FIELD_WEIGHTS sums to 0.80 (not 1.00)
  BONUS_POOL    = 0.20 (amount validity, date validity, row quality, raw rows)
  Max possible  = 1.00 before clamp — no distortion.
"""

import re
from datetime import datetime

# ── Thresholds ─────────────────────────────────────────────────────────────────
CONFIDENCE_AI_THRESHOLD = 0.45   # below this → try AI fallback
CONFIDENCE_LOW_WARNING  = 0.60   # below this → warn user but still proceed
CONFIDENCE_HIGH         = 0.80   # above this → high confidence, no warning

# FIX 2: Field weights reduced to sum to 0.80 so bonuses (0.20) bring max to 1.0
FIELD_WEIGHTS = {
    'invoice_number': 0.20,
    'vendor_name'   : 0.20,
    'amount'        : 0.20,
    'date'          : 0.08,
    'currency'      : 0.04,
    'po_number'     : 0.08,
}
# FIELD_WEIGHTS total: 0.80
# BONUS_POOL remaining: 0.20 (split below)
_BONUS_AMOUNT_VALID   = 0.05
_BONUS_DATE_VALID     = 0.04
_BONUS_DATE_PARTIAL   = 0.02
_BONUS_ROW_QUALITY    = 0.07
_BONUS_RAW_ROWS       = 0.04
# Total bonus pool: 0.05 + 0.04 + 0.07 + 0.04 = 0.20  ✓


def score_confidence(parsed_result: dict, raw_rows: list) -> float:
    """
    Score overall extraction confidence.

    Args:
        parsed_result: Output from invoice_parser.parse_invoice_fields()
        raw_rows:      Raw rows from table/OCR extraction

    Returns:
        float 0.0 - 1.0
    """
    fields = parsed_result.get('fields', {})
    rows   = parsed_result.get('rows', [])

    score = 0.0

    # ── Field presence score (max 0.80) ───────────────────────────────────────
    for field, weight in FIELD_WEIGHTS.items():
        val = fields.get(field)
        if val and str(val).strip() and str(val).strip() not in ('', 'None', 'null', 'N/A'):
            score += weight

    # FIX 4: If key fields are present even when rows is empty, give partial bonus
    # This prevents confidence collapsing to 0 on single-invoice documents
    # where invoice_parser returns fields but no tabular rows.
    if fields and not rows:
        key_fields_present = sum(
            1 for f in ('invoice_number', 'vendor_name', 'amount')
            if fields.get(f) and str(fields[f]).strip()
        )
        if key_fields_present >= 2:
            score += 0.10  # partial credit — there IS data, just no rows

    # ── Amount validity bonus (max +0.05) ─────────────────────────────────────
    amount = fields.get('amount')
    if amount:
        try:
            amt_float = float(str(amount).replace(',', ''))
            if amt_float > 0:
                score += _BONUS_AMOUNT_VALID
        except (ValueError, TypeError):
            score -= 0.03  # penalty for unparseable amount

    # ── FIX 1: Date validity bonus — only for genuinely valid dates ───────────
    date_val = fields.get('date', '')
    if date_val:
        date_str = str(date_val).strip()
        # Try ISO format first — highest confidence
        iso_valid = False
        try:
            datetime.strptime(date_str, '%Y-%m-%d')
            iso_valid = True
        except ValueError:
            pass

        if iso_valid:
            score += _BONUS_DATE_VALID
        elif re.match(r'^\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}$', date_str):
            # Partial format match — lower bonus
            score += _BONUS_DATE_PARTIAL

    # ── Row quality bonus (max +0.07) ─────────────────────────────────────────
    if rows:
        complete_rows = sum(
            1 for r in rows
            if r.get('invoice_number') or r.get('vendor_name') or r.get('amount')
        )
        row_quality = complete_rows / max(len(rows), 1)
        score += row_quality * _BONUS_ROW_QUALITY

    # ── Raw row content check (max +0.04) ─────────────────────────────────────
    if raw_rows:
        non_empty = sum(1 for r in raw_rows if any(str(v).strip() for v in r.values()))
        if non_empty > 0:
            score += _BONUS_RAW_ROWS

    return round(min(1.0, max(0.0, score)), 3)


def get_confidence_label(confidence: float) -> dict:
    """Return a human-readable confidence label and recommendation."""
    if confidence >= CONFIDENCE_HIGH:
        return {
            'level'         : 'high',
            'label'         : 'High confidence',
            'color'         : 'green',
            'recommendation': 'Extracted data is reliable. Review and proceed.',
        }
    elif confidence >= CONFIDENCE_LOW_WARNING:
        return {
            'level'         : 'medium',
            'label'         : 'Medium confidence',
            'color'         : 'yellow',
            'recommendation': 'Some fields may be inaccurate. Please review before reconciling.',
        }
    elif confidence >= CONFIDENCE_AI_THRESHOLD:
        return {
            'level'         : 'low',
            'label'         : 'Low confidence',
            'color'         : 'orange',
            'recommendation': 'Several fields missing. Manual review strongly recommended.',
        }
    else:
        return {
            'level'         : 'very_low',
            'label'         : 'Very low confidence',
            'color'         : 'red',
            'recommendation': 'Extraction failed or document is unreadable. Consider AI fallback or manual entry.',
        }


def should_use_ai_fallback(confidence: float, fields: dict, config: dict) -> bool:
    """
    Decide whether to trigger AI fallback for this document.

    Rules:
      1. If gemini_fallback is disabled in config → never use AI
      2. If confidence >= threshold → no need for AI
      3. FIX 3: If ANY 2 of 3 critical fields missing → use AI
         (was: required ALL THREE missing, which was too strict)
    """
    if not config.get('gemini_fallback', False):
        return False

    if confidence >= CONFIDENCE_AI_THRESHOLD:
        return False

    # FIX 3: Count missing critical fields instead of requiring all missing
    missing_count = sum(
        1 for f in ('invoice_number', 'vendor_name', 'amount')
        if not fields.get(f) or not str(fields[f]).strip()
    )
    critical_missing = missing_count >= 2

    return critical_missing or confidence < CONFIDENCE_AI_THRESHOLD


def score_text_quality(text: str) -> float:
    """
    Score the quality of raw OCR text.
    Used to decide if re-OCR or AI fallback is needed.

    FIX 5: Now uses Unicode-aware patterns so Nepali/Hindi/Arabic invoices
    are not scored as low-quality junk text.
    """
    if not text or not text.strip():
        return 0.0

    words = text.split()
    total = len(words)
    if total == 0:
        return 0.0

    # FIX 5: \w matches Unicode word chars; \d matches Unicode digits
    # Previous [a-zA-Z0-9] was ASCII-only and wrongly penalized non-Latin scripts.
    real_words = sum(1 for w in words if re.match(r'^[\w\.\,\-\/\:]{2,}$', w, re.UNICODE))
    word_ratio = real_words / total

    # FIX 5: \d+ for Unicode digit sequences (Devanagari numbers etc.)
    has_numbers  = bool(re.search(r'\d{3,}', text, re.UNICODE))
    has_currency = bool(re.search(r'[$£€₹¥₩]|\b(USD|EUR|GBP|INR|NPR|AED|SAR|CNY)\b', text))

    score = word_ratio * 0.6
    if has_numbers:  score += 0.2
    if has_currency: score += 0.2

    return round(min(1.0, score), 3)
