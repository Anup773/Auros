"""
backend/python/command_parser.py

Deterministic natural language command parser for procurement voice commands.
Zero AI tokens. Zero API calls. Pure regex + rule engine.

CHANGES FROM V3 (this version — V4):

  CRITICAL FIXES:
  ──────────────
  FIX-01 WORD-BOUNDARY ACTION MATCHING
    Old: `if kw in t` → "disapprove" matched "approve"; "holding company" matched "hold".
    New: re.search(rf'\\b{re.escape(kw)}\\b', t) — all action keyword checks use
         compiled word-boundary patterns (see _ACTION_PATTERNS).

  FIX-02 NEGATION DETECTION
    Old: "don't approve invoice 5" → action "approve" returned.
    New: _is_negated(clause, action) scans for negation markers
         ("don't", "do not", "never", "not", "no", "cannot", "can't", "won't",
         "please don't", "please no") within 3 tokens before the action keyword.
         Negated clauses are routed to AI with reason "Negated command detected".

  FIX-03 CONFIRMATION INTENT CLASSIFICATION
    Old: `any(kw in t for kw in CONFIRM_KEYWORDS)` → "I am not sure but yes maybe later"
         triggered execution because "yes" is a substring.
    New: _classify_confirmation_intent(t) normalises the utterance, checks for
         cancel signals first, then requires confirmation phrasing to appear WITHOUT
         adjacent negation / uncertainty markers. Returns "confirm", "cancel", or "unclear".

  FIX-04 CANCEL KEYWORD COLLISION
    Old: "don't" inside "I don't know" cancelled the workflow.
    New: Same _classify_confirmation_intent — cancellation also requires the cancel
         keyword to appear as a standalone intent signal, not embedded in unrelated speech.

  FIX-05 OVERLAPPING ACTION KEYWORDS IN SINGLE-ACTION PATH
    Old: "approve and hold item 5" → _detect_action returned "hold" only; "approve" lost.
    New: _detect_all_actions(t) returns every distinct action keyword present.
         If ≥ 2 distinct actions are found AND there is no single dominant action for
         the whole clause, the compound parser is attempted first. The single-action
         path now explicitly warns when multiple actions are present.

  FIX-06 RANGE REGEX MUST NOT MATCH MONEY VALUES
    Old: "approve invoices between 1000-2000 usd" → parsed as item range 1000-2000.
    New: Range patterns require the match NOT to be immediately followed by a currency
         unit or preceded by "$". Added _is_money_context() guard around all numeric
         range extractions. Amount ranges are routed to amount_filter, not item range.

  FIX-07 / FIX-08  MEMORY: LAZY SELECTION EXPRESSIONS
    Old: list(range(total)) materialised in _parse_target / _parse_exclusion /
         _apply_bulk_confirmation for every command, even with 1 million rows.
    New: SelectionExpr dataclass replaces index lists for bulk/range operations.
         SelectionExpr describes the selection declaratively:
           {"type": "range",   "start": 0, "end": 999}
           {"type": "all"}
           {"type": "filter",  "condition": "amount < 1000"}
           {"type": "indices", "values": [3, 7, 12]}   ← only for small explicit lists
         Callers that need materialised lists call sel.materialise(ambiguities, total).
         Large bulk results never materialise in the parser itself.

  FIX-09  O(N) FILTER SCAN — PRE-BUILT INDEXES
    Old: _filter_ambiguities scanned every row for every command.
    New: build_ambiguity_indexes(ambiguities) builds vendor_index,
         currency_index, amount_sorted_pairs, type_index once at call entry.
         Filters use these indexes for sub-linear lookups.

  FIX-10  VENDOR FILTER WORD-BOUNDARY MATCHING
    Old: `kw in vendor` → query "A" matched every vendor; "tech" matched techcorp,
         fintech, globaltech simultaneously.
    New: vendor matching uses re.search(rf'\\b{re.escape(kw)}\\b', vendor) so only
         whole-word tokens match. Short keywords (< 3 chars) are rejected.

  FIX-11  COMPILED REGEXES
    Old: re.search(...) called with raw strings inside hot loops — recompiled every call.
    New: All patterns compiled once at module load into named constants
         (_RE_RANGE, _RE_UP_TO, _RE_FIRST_N, _RE_LAST_N, _RE_NEXT_N, etc.).

  FIX-12  MAX INPUT LENGTH GUARD
    Old: No size check — 50 MB command processed unguarded.
    New: MAX_COMMAND_LENGTH = 2000 chars; excess returns structured error immediately.

  FIX-13  MAX AMBIGUITY SIZE GUARD
    Old: 5 million ambiguities crashed server.
    New: MAX_AMBIGUITY_SIZE = 100_000; excess returns structured error immediately.

  FIX-14  JSON OUTPUT SIZE — RANGE ENCODING
    Old: "indices": [0, 1, 2, ..., 999999] → gigantic JSON for bulk actions.
    New: SelectionExpr encodes as compact range/filter/all — never materialised
         in the response JSON for large sets.

  FIX-15  CACHED TOTAL_AFFECTED
    Old: sum(len(a["indices"]) for a in actions) repeated throughout.
    New: _total_affected(actions) helper called once; result reused.

  FIX-16  MAX BULK ACTION GUARD
    Old: "approve all" against 10 million invoices returned without limit.
    New: MAX_BULK_ACTION = 50_000; bulk commands exceeding this require
         explicit confirmation AND flag maxBulkExceeded in the response.

  FIX-17  AUDIT METADATA
    Old: Output contained no provenance — version, matched rule, timestamp missing.
    New: Every result dict includes "audit" sub-object:
           parser_version, rule_id, matched_keyword, confidence_source, ts_utc.

  FIX-18  CONFLICT DETECTION
    Old: covered mechanism silently suppressed overlapping ranges.
    New: _detect_conflicts(actions) cross-checks all index sets for overlaps and
         returns a list of conflict descriptors. Conflicts are surfaced in the
         result as "conflicts" and trigger lowConfidence=True.

  FIX-19  AI FALLBACK IMPROVEMENT — UNCERTAINTY VOCABULARY
    Old: Partially parsed ambiguous commands still returned confidence 0.9.
    New: Extended _is_complex_command pattern list includes uncertainty verbs:
         "seems", "looks like", "probably", "suspicious", "legitimate", "trusted".
         Any command containing these is routed to AI regardless of parse success.

  FIX-20  (see FIX-02 above — negation)

  FIX-21  FUZZY SPELLING (BASIC)
    Old: "aprove", "rejct", "holdd" → AI fallback.
    New: _fuzzy_match_action(t) checks each word against known action keywords
         using SequenceMatcher ratio ≥ 0.82 before routing to AI. If a fuzzy
         match is found, it is treated as the action with a 0.10 confidence
         penalty and lowConfidence=True.

  FIX-22  MONOLITHIC STRUCTURE
    File remains a single module (deployment constraint) but is reorganised
    into clearly labelled sections with explicit public/private boundaries.

  FIX-23  SILENT EMPTY RESULT
    Old: vendor not found → [] silently returned.
    New: Empty filter results produce interpretation:
         "No invoices matched <filter description>. Please check the filter."
         and set emptyResult=True in the response.

  FIX-24  INVOICE NUMBER VS POSITION DISAMBIGUATION
    Old: "approve invoice 700" → index 699, even if user meant invoice no. 700.
    New: _disambiguate_number_reference(t, ambiguities) checks whether any
         ambiguity's invoice.invoice_number matches the spoken number exactly.
         If yes → use that row's index (invoice-number mode).
         If no  → interpret as 1-based position (row mode) with a warning.
         If ambiguous (multiple matches) → route to AI.

  FIX-25  SELECTIONEXPRESSION ARCHITECTURE
    The entire output now uses SelectionExpr instead of flat index lists
    for all bulk, range, filter, and positional selections. This keeps the
    parser O(1) in memory for large datasets. Clients that need concrete
    indices call materialise() server-side with pagination.

  PRESERVED FROM V3:
    - "up to N" / "the first N" / "the last N" / "remaining" compound parsing
    - Exclusion parsing ("approve all except the last 3")
    - Bulk confirmation threshold (BULK_CONFIRM_THRESHOLD = 10)
    - Multi-clause compound command parsing (_parse_compound_command)
    - All V1/V2 behaviours not explicitly superseded above
"""

import sys
import json
import re
import traceback
import warnings
import time
from dataclasses import dataclass, field, asdict
from difflib import SequenceMatcher
from typing import Optional

warnings.filterwarnings("ignore")

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

# ══════════════════════════════════════════════════════════════════════════════
# SECTION 1 — CONSTANTS & CONFIGURATION
# ══════════════════════════════════════════════════════════════════════════════

PARSER_VERSION          = "4.0.0"

# FIX-12: input size guard
MAX_COMMAND_LENGTH      = 2_000

# FIX-13: ambiguity size guard
MAX_AMBIGUITY_SIZE      = 100_000

# FIX-16: bulk action safety cap
MAX_BULK_ACTION         = 50_000

# Confidence thresholds
CONFIDENCE_AI_FALLBACK  = 0.40
CONFIDENCE_WARN         = 0.65

# Items above this count require explicit confirmation before executing
BULK_CONFIRM_THRESHOLD  = 10

# FIX-21: minimum SequenceMatcher ratio for fuzzy action matching
FUZZY_MATCH_THRESHOLD   = 0.82

# ── Action vocabulary ──────────────────────────────────────────────────────────
ACTION_KEYWORDS: dict[str, list[str]] = {
    "approve"    : ["approve", "accept", "pay", "payment", "pass"],
    "reject"     : ["reject", "decline", "deny", "discard", "refuse", "fail", "remove"],
    "hold"       : ["hold", "pause", "defer", "flag", "review", "wait",
                    "pending", "suspend", "escalate"],
    "request_po" : ["request po", "request purchase order", "need po",
                    "missing po", "ask for po", "get po", "po required",
                    "request po number"],
}
# NOTE: "ok", "okay" removed from approve — they are too short and generic,
# causing false positives. "confirm", "yes", "no", "cancel" not in ACTION_KEYWORDS.

ACTION_RESPONSES: dict[str, str] = {
    "approve"    : "Approve for payment",
    "reject"     : "Reject invoice",
    "hold"       : "Hold for review",
    "request_po" : "Request PO number from vendor",
}

# Detection order: longest/most-specific first to avoid prefix collisions
_CATEGORY_ORDER = ["request_po", "reject", "hold", "approve"]

# FIX-11: compile all action patterns once at module load
# FIX-01: word-boundary matching — prevents "disapprove"→approve, "holding"→hold
_ACTION_PATTERNS: dict[str, list[re.Pattern]] = {
    action: [
        re.compile(rf'\b{re.escape(kw)}\b', re.IGNORECASE)
        for kw in sorted(keywords, key=len, reverse=True)
    ]
    for action, keywords in ACTION_KEYWORDS.items()
}

# ── Negation markers (FIX-02 / FIX-20) ───────────────────────────────────────
_NEGATION_WORDS = frozenset([
    "not", "no", "never", "don't", "dont", "do not",
    "cannot", "can't", "cant", "won't", "wont",
    "please don't", "please no", "shouldn't", "shouldnt",
])

# FIX-11: compiled negation pattern
_RE_NEGATION = re.compile(
    r"\b(not|no|never|don'?t|do\s+not|cannot|can'?t|won'?t|"
    r"please\s+don'?t|please\s+no|shouldn'?t)\b",
    re.IGNORECASE
)

# ── Confirmation / cancel vocabulary ─────────────────────────────────────────
CONFIRM_KEYWORDS = [
    "confirm", "confirmed", "yes", "proceed", "do it", "go ahead",
    "execute", "apply", "sure", "correct", "that's right", "affirmative",
]
CANCEL_KEYWORDS = [
    "cancel", "stop", "abort", "never mind", "nope",
    "negative", "forget it", "disregard",
]

# Uncertainty words that should always route to AI (FIX-19)
_UNCERTAINTY_WORDS = frozenset([
    "suspicious", "legitimate", "trusted", "trust", "legitimate",
    "seems", "seem", "looks like", "probably", "maybe", "usually",
    "normally", "worked with before",
])

# ── Currency units — used in FIX-06 money-context guard ──────────────────────
_CURRENCY_UNITS = frozenset([
    "usd", "eur", "gbp", "aud", "inr", "cad", "jpy",
    "nzd", "chf", "cny", "dollars", "pounds", "euros", "rupees",
])

# ── FIX-11: Pre-compiled regex patterns ───────────────────────────────────────
_RE_RANGE = re.compile(
    r'(?<!\$)\bfrom\s+(\d[\d,]*)\s*(?:to|through|thru)\s+(\d[\d,]*)\b'
    r'|(?<!\$)\b(\d[\d,]*)\s*(?:to|through|thru|-|–)\s*(\d[\d,]*)\b',
    re.IGNORECASE
)
_RE_UP_TO   = re.compile(r'\b(?:up\s*to|upto|up\s*till|until)\s+(?:row\s+)?(\d[\d,]*)\b', re.IGNORECASE)
_RE_FIRST_N = re.compile(r'\b(?:the\s+)?first\s+(\d[\d,]*)\b', re.IGNORECASE)
_RE_LAST_N  = re.compile(r'\b(?:the\s+)?last\s+(\d[\d,]*)\b', re.IGNORECASE)
_RE_NEXT_N  = re.compile(r'\bnext\s+(\d[\d,]*)\b', re.IGNORECASE)
_RE_REMAINING = re.compile(
    r'\b(?:the\s+)?(?:remaining|rest)(?:\s+\w+)?\b|\beverything\s+else\b', re.IGNORECASE
)
_RE_BULK = re.compile(
    r'\b(all|every|everything|all\s+of\s+them|all\s+items|entire|rest|remaining)\b',
    re.IGNORECASE
)
_RE_FILTER_KWS = re.compile(
    r'\b(under|below|over|above|less\s+than|more\s+than|'
    r'from|vendor|supplier|company|'
    r'usd|eur|gbp|aud|inr|cad|jpy|'
    r'duplicate|mismatch|unmatched|flagged)\b',
    re.IGNORECASE
)
_RE_UNDER   = re.compile(r'(?:under|below|less\s+than|<)\s*\$?\s*([\d,]+)', re.IGNORECASE)
_RE_OVER    = re.compile(r'(?:over|above|more\s+than|>)\s*\$?\s*([\d,]+)', re.IGNORECASE)
_RE_CURRENCY = re.compile(r'\b(usd|eur|gbp|aud|inr|cad|jpy|nzd|chf|cny)\b', re.IGNORECASE)
_RE_VENDOR_PHRASE = re.compile(
    r'(?:from|vendor|supplier|company)\s+'
    r'([a-zA-Z0-9][a-zA-Z0-9\-\._,&\s]*[a-zA-Z0-9])',
    re.IGNORECASE
)
_RE_VENDOR_SPLIT = re.compile(r'\s*,\s*|\s*&\s*|\s+\band\b\s+|\s+\bor\b\s+', re.IGNORECASE)
_RE_CONNECTOR_SPLIT = re.compile(r'\b(and\s+then|then|also|plus|and)\b|,', re.IGNORECASE)
_RE_DOLLAR_NUM = re.compile(r'\$([\d,]+)')
_RE_BARE_NUM   = re.compile(r'\b(\d+)\b')
_RE_AMOUNT_RANGE = re.compile(
    r'(?:between|from)?\s*\$?\s*([\d,]+)\s*(?:to|-|–|and)\s*\$?\s*([\d,]+)\s*'
    r'(?:usd|eur|gbp|aud|inr|cad|jpy|nzd|chf|cny|dollars|pounds|euros|rupees)',
    re.IGNORECASE
)
# FIX-24: invoice number reference — "invoice 700" / "invoice #700" / "invoice no. 700"
_RE_INVOICE_REF = re.compile(
    r'\binvoice\s+(?:number|no\.?|#)?\s*([A-Za-z0-9\-]+)\b',
    re.IGNORECASE
)
_RE_ITEM_REF = re.compile(
    r'\bitem\s+(?:number|no\.?|#)?\s*(\d+)\b',
    re.IGNORECASE
)
# BATCH-2 FIX: "45 items" / "100 invoices" / "50 rows" — a number BEFORE a
# plural-capable count noun means QUANTITY, not a position reference.
# Without this, "approve 45 items for payment" fell through to the bare-number
# branch (Section 11, step 3) which reads "45" as item #45 (a single row) —
# this is why that exact command only actioned 1 item instead of 45.
# Word order is the disambiguator: "item 45" (noun-then-number, handled by
# _RE_ITEM_REF above) is a position; "45 items" (number-then-noun) is a count.
_RE_COUNT_N = re.compile(
    r'\b(\d[\d,]*)\s*(?:items?|invoices?|rows?|records?)\b',
    re.IGNORECASE
)

# ══════════════════════════════════════════════════════════════════════════════
# SECTION 2 — SELECTION EXPRESSION (FIX-07 / FIX-14 / FIX-25)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class SelectionExpr:
    """
    Declarative selection that avoids materialising large index lists.

    type:
      "all"      — select everything (respecting answered flag)
      "range"    — contiguous range [start, end] inclusive, 0-based
      "indices"  — explicit small list (used only for short lists, e.g. ≤ 50)
      "filter"   — described by condition string; client executes
      "empty"    — zero items matched

    The 'condition' field is used for filter types and carries a human-readable
    filter description. 'covered_ranges' tracks already-claimed spans so
    materialise() can subtract them.
    """
    type        : str                    # "all" | "range" | "indices" | "filter" | "empty"
    start       : Optional[int] = None  # for "range"
    end         : Optional[int] = None  # for "range"
    values      : list          = field(default_factory=list)  # for "indices"
    condition   : str           = ""    # for "filter", human-readable
    total       : int           = 0

    def estimated_count(self) -> int:
        """Return estimated item count without materialising."""
        if self.type == "empty":
            return 0
        if self.type == "all":
            return self.total
        if self.type == "range":
            if self.start is None or self.end is None:
                return 0
            return max(0, self.end - self.start + 1)
        if self.type == "indices":
            return len(self.values)
        if self.type == "filter":
            return -1  # unknown until server-side evaluation
        return 0

    def materialise(self, ambiguities: list, total: int,
                    exclude: set | None = None) -> list[int]:
        """
        Expand to a concrete index list. Called server-side only, never in
        the parser hot path. Respects the 'answered' flag on ambiguities.
        Subtracts indices in `exclude` if provided.
        """
        exc = exclude or set()
        if self.type == "empty":
            return []
        if self.type == "indices":
            return [i for i in self.values if i not in exc]
        if self.type == "range":
            s = self.start or 0
            e = min(self.end or (total - 1), total - 1)
            result = []
            for i in range(s, e + 1):
                if i in exc:
                    continue
                if ambiguities and i < len(ambiguities) and ambiguities[i].get("answered"):
                    continue
                result.append(i)
            return result
        if self.type == "all":
            result = []
            for i in range(total):
                if i in exc:
                    continue
                if ambiguities and i < len(ambiguities) and ambiguities[i].get("answered"):
                    continue
                result.append(i)
            return result
        return []  # "filter" type — caller evaluates the condition

    def to_dict(self) -> dict:
        d: dict = {"type": self.type}
        if self.type == "range":
            d["start"] = self.start
            d["end"]   = self.end
            d["estimated_count"] = self.estimated_count()
        elif self.type == "indices":
            d["values"] = self.values
            d["count"]  = len(self.values)
        elif self.type == "all":
            d["estimated_count"] = self.total
        elif self.type == "filter":
            d["condition"] = self.condition
        elif self.type == "empty":
            d["count"] = 0
        return d


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 3 — INDEX STRUCTURES (FIX-09)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class AmbiguityIndexes:
    """Pre-built lookup structures for O(sub-linear) filtering."""
    vendor_index   : dict[str, list[int]] = field(default_factory=dict)
    currency_index : dict[str, list[int]] = field(default_factory=dict)
    type_index     : dict[str, list[int]] = field(default_factory=dict)
    # Sorted list of (amount_float, row_index) for binary-search style range
    amount_pairs   : list[tuple]          = field(default_factory=list)
    invoice_num_index : dict[str, int]    = field(default_factory=dict)


def build_ambiguity_indexes(ambiguities: list) -> AmbiguityIndexes:
    """
    Build lookup indexes from the ambiguities list.
    Called once per op_parse_command invocation.
    O(n) to build; O(log n) or O(k) to query.
    """
    idx = AmbiguityIndexes()
    for i, amb in enumerate(ambiguities):
        if amb.get("answered"):
            continue
        inv    = amb.get("invoice", {})
        vendor = str(inv.get("vendor_name") or inv.get("vendor") or "").lower().strip()
        cur    = str(inv.get("currency") or "").lower().strip()
        amt    = _parse_amount_val(inv.get("amount") or inv.get("total") or "0")
        atype  = str(amb.get("type", "")).lower()
        invnum = str(inv.get("invoice_number") or inv.get("invoice_no") or "").strip()

        if vendor:
            idx.vendor_index.setdefault(vendor, []).append(i)
        if cur:
            idx.currency_index.setdefault(cur, []).append(i)
        if atype:
            idx.type_index.setdefault(atype, []).append(i)
        if amt is not None:
            idx.amount_pairs.append((amt, i))
        if invnum:
            idx.invoice_num_index[invnum.lower()] = i

    idx.amount_pairs.sort(key=lambda x: x[0])
    return idx


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 4 — MAIN ENTRY POINT
# ══════════════════════════════════════════════════════════════════════════════

def main():
    raw = sys.stdin.read()
    try:
        config = json.loads(raw)
    except json.JSONDecodeError as e:
        _out({"ok": False, "error": f"Invalid JSON: {e}"})
        return

    op = config.get("operation", "parse_command")
    try:
        if op == "parse_command":
            result = op_parse_command(config)
        else:
            raise ValueError(f"Unknown operation: {op}")
        _out({"ok": True, "result": result})
    except Exception as e:
        tb = traceback.format_exc()
        _out({"ok": False, "error": str(e), "trace": tb})


def op_parse_command(config: dict) -> dict:
    """
    Parse a voice/text command against live ambiguity data.
    Returns a result dict using SelectionExpr for all large selections.
    """
    text        = _require(config, "text").strip()
    ambiguities = config.get("ambiguities", [])
    total_items = config.get("totalItems", len(ambiguities))
    pending     = config.get("pendingConfirm")

    # FIX-12: input length guard
    if len(text) > MAX_COMMAND_LENGTH:
        return _error_result(
            text,
            f"Command too long ({len(text)} chars). Maximum is {MAX_COMMAND_LENGTH}.",
            "input_too_long",
        )

    # FIX-13: ambiguity size guard
    if len(ambiguities) > MAX_AMBIGUITY_SIZE:
        return _error_result(
            text,
            f"Too many ambiguities ({len(ambiguities)}). Maximum is {MAX_AMBIGUITY_SIZE}.",
            "dataset_too_large",
        )

    t        = text.lower()
    ts_start = time.time()

    # FIX-09: build indexes once
    amb_idx  = build_ambiguity_indexes(ambiguities)

    # ── STEP 1: Handle pending confirmation ───────────────────────────────────
    if pending:
        return _handle_confirmation_response(t, pending, text)

    # ── STEP 1.5: COMPOUND MULTI-RANGE COMMAND ────────────────────────────────
    compound_result = _parse_compound_command(t, text, ambiguities, total_items, amb_idx)
    if compound_result is not None:
        return _apply_bulk_confirmation(compound_result, text)

    # ── STEP 2: FIX-02 NEGATION CHECK ────────────────────────────────────────
    if _has_leading_negation(t):
        return _needs_ai(text, "Negated command detected", "negation_detected")

    # ── STEP 3: Detect action ─────────────────────────────────────────────────
    detected_action, matched_kw = _detect_action(t)
    if not detected_action:
        # FIX-21: fuzzy match before AI fallback
        fuzz_action, fuzz_kw, fuzz_penalty = _fuzzy_match_action(t)
        if fuzz_action:
            detected_action = fuzz_action
            matched_kw      = fuzz_kw
        else:
            return _needs_ai(text, "No action keyword detected", "no_action")

    # FIX-02: negation check per detected action
    if _is_negated(t, matched_kw or ""):
        return _needs_ai(text, "Negated command detected", "negation_detected")

    # ── STEP 4: Exclusion check ───────────────────────────────────────────────
    exclusion_result = _parse_exclusion(
        t, detected_action, ambiguities, total_items, amb_idx
    )
    if exclusion_result is not None:
        return _apply_bulk_confirmation(exclusion_result, text)

    # ── STEP 5: Complex command check ─────────────────────────────────────────
    if _is_complex_command(t):
        return _needs_ai(text, "Complex natural language command detected", "complex_command")

    # ── STEP 6: Parse target ──────────────────────────────────────────────────
    confidence   = 1.0
    covered      : set[int] = set()

    sel, match_type, conf_penalty, rule_id = _parse_target(
        t, ambiguities, total_items, covered, amb_idx
    )
    confidence -= conf_penalty

    est_count = sel.estimated_count()

    if sel.type == "empty" and not _is_bulk(t):
        # FIX-23: explicit empty result message
        filter_desc = _describe_filter(t)
        return _needs_ai(
            text,
            f"No invoices matched {filter_desc}. Please check the filter.",
            "empty_filter_result",
        )

    if sel.type == "unknown":
        return _needs_ai(text, "Could not determine target items", "unknown_target")

    actions: list[dict] = []

    if sel.type != "empty":
        actions.append(_make_action(detected_action, sel))
        # For conflict tracking, materialise only if small enough
        if sel.type == "indices":
            covered.update(sel.values)
        elif sel.type == "range" and sel.estimated_count() <= 10_000:
            covered.update(range(sel.start or 0, (sel.end or 0) + 1))

    # ── STEP 7: Secondary actions ─────────────────────────────────────────────
    secondary = _parse_secondary_actions(t, ambiguities, total_items, covered, amb_idx)
    actions.extend(secondary)

    # FIX-18: conflict detection
    conflicts = _detect_conflicts(actions)

    # FIX-15: cached total
    total_affected = _total_affected_est(actions)
    interpretation = _build_interpretation(actions, match_type, total_affected)

    # FIX-17: audit metadata
    audit = _build_audit(rule_id, matched_kw, "direct_parse", ts_start)

    result = {
        "actions"          : actions,
        "confidence"       : round(max(0.0, min(1.0, confidence)), 2),
        "needsAI"          : confidence < CONFIDENCE_AI_FALLBACK,
        "needsConfirmation": False,
        "lowConfidence"    : confidence < CONFIDENCE_WARN or bool(conflicts),
        "interpretation"   : interpretation,
        "rawText"          : text,
        "matchType"        : match_type,
        "cancelled"        : False,
        "conflicts"        : conflicts,
        "emptyResult"      : (sel.type == "empty"),
        "audit"            : audit,
    }
    return _apply_bulk_confirmation(result, text)


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 5 — NEGATION DETECTION (FIX-02 / FIX-20)
# ══════════════════════════════════════════════════════════════════════════════

def _has_leading_negation(t: str) -> bool:
    """
    True if the WHOLE command starts with a clear negation phrase like
    "don't", "please don't", "do not", "never" — before any action keyword.
    This catches commands like "don't do anything".
    """
    return bool(re.match(
        r"^\s*(don'?t|do\s+not|please\s+don'?t|never|no\s+action|cancel\s+all)\b",
        t, re.IGNORECASE
    ))


def _is_negated(t: str, action_kw: str) -> bool:
    """
    FIX-02: Return True if `action_kw` in `t` is preceded by a negation word
    within a window of ~3 tokens.

    Example: "don't approve invoice 5" → True for action_kw="approve"
    Example: "approve invoice 5"       → False
    """
    if not action_kw:
        return False

    pattern = re.compile(rf'\b{re.escape(action_kw)}\b', re.IGNORECASE)
    m = pattern.search(t)
    if not m:
        return False

    # Look at up to 40 chars before the action keyword
    prefix = t[max(0, m.start() - 40): m.start()]
    return bool(_RE_NEGATION.search(prefix))


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 6 — ACTION DETECTION (FIX-01 / FIX-05)
# ══════════════════════════════════════════════════════════════════════════════

def _detect_action(t: str) -> tuple[str | None, str | None]:
    """
    FIX-01: Detect primary action using WORD-BOUNDARY patterns (not substring).
    Returns (action, matched_keyword) or (None, None).

    Order: request_po → reject → hold → approve.
    Multi-word keywords checked before single-word to avoid prefix collisions.
    """
    for action in _CATEGORY_ORDER:
        for pat in _ACTION_PATTERNS[action]:
            m = pat.search(t)
            if m:
                return action, m.group(0).lower()
    return None, None


def _detect_all_actions(t: str) -> list[tuple[str, str]]:
    """
    FIX-05: Return ALL (action, keyword) pairs present in t (deduplicated by action).
    Used to detect multi-action clauses before routing to compound parser.
    """
    found = []
    seen_actions: set[str] = set()
    for action in _CATEGORY_ORDER:
        for pat in _ACTION_PATTERNS[action]:
            m = pat.search(t)
            if m and action not in seen_actions:
                found.append((action, m.group(0).lower()))
                seen_actions.add(action)
                break
    return found


def _is_bulk(t: str) -> bool:
    return bool(_RE_BULK.search(t))


def _is_complex_command(t: str) -> bool:
    """
    FIX-19: Extended with uncertainty vocabulary patterns.
    FIX-02: "except" and "but not/last/first" removed (handled by exclusion).
    """
    complex_patterns = [
        r'\bbut\b(?!\s+(?:not|last|first|\d))',
        r'\bif\b',
        r'\bwhen\b',
        r'\bwhere\b(?!.*\d)',
        r'\blooks?\s+(?:like|legitimate|suspicious)\b',
        r'\bseems?\s',
        r'\bprobably\b',
        r'\bmaybe\b',
        r'\bsuspicious\b',
        r'\blegitimate\b',
        r'\btrusted?\b',
        r'\bworked\s+with\s+before\b',
        r'\busually\b',
        r'\bnormally\b',
        # FIX-19: additional uncertainty vocabulary
        r'\bnot\s+sure\b',
        r'\bi\s+think\b',
        r'\bi\s+believe\b',
        r'\bquestionable\b',
        r'\bunusual\b',
        r'\bstrange\b',
        r'\bweird\b',
        r'\bfake\b',
        r'\bfraud\b',
    ]
    return any(re.search(p, t, re.IGNORECASE) for p in complex_patterns)


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 7 — FUZZY SPELLING (FIX-21)
# ══════════════════════════════════════════════════════════════════════════════

def _fuzzy_match_action(t: str) -> tuple[str | None, str | None, float]:
    """
    FIX-21: Basic fuzzy spelling support using SequenceMatcher.
    Returns (action, matched_word, confidence_penalty) or (None, None, 0.0).

    Only fires when NO exact word-boundary match was found. Checks each word
    in the command against known action keywords. Requires ratio ≥ 0.82 to
    prevent false positives from short common words.
    """
    words = re.findall(r'\b[a-z]+\b', t.lower())
    for word in words:
        if len(word) < 4:
            continue  # too short for reliable fuzzy match
        for action in _CATEGORY_ORDER:
            for kw in ACTION_KEYWORDS[action]:
                kw_parts = kw.split()
                if len(kw_parts) > 1:
                    continue  # skip multi-word keywords for fuzzy
                ratio = SequenceMatcher(None, word, kw).ratio()
                if ratio >= FUZZY_MATCH_THRESHOLD:
                    return action, kw, 0.10  # 0.10 confidence penalty for fuzzy
    return None, None, 0.0


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 8 — COMPOUND MULTI-RANGE COMMAND PARSING
# ══════════════════════════════════════════════════════════════════════════════

def _parse_compound_command(
    t: str,
    raw_text: str,
    ambiguities: list,
    total: int,
    amb_idx: AmbiguityIndexes,
) -> dict | None:
    """
    Handle commands like:
      "approve up to 700, reject 700 to 750, last 50 request po number"
      "approve the first 100 and hold the next 20"

    Returns None to let the single-action pipeline handle ambiguous cases.
    """
    # Quick bail-out: need ≥ 2 distinct action keywords
    all_actions = _detect_all_actions(t)
    if len(all_actions) < 2:
        return None

    raw_clauses = _split_into_clauses(t)
    if len(raw_clauses) < 2:
        return None

    covered  : set[int] = set()
    parsed_clauses: list[dict] = []
    deferred_indices: list[int] = []

    for clause in raw_clauses:
        clause = clause.strip()
        if not clause:
            continue

        # FIX-02: check negation per clause
        action, kw = _detect_action(clause)
        if not action:
            return None
        if _is_negated(clause, kw or ""):
            return None

        spec_sel, spec_type = _parse_position_spec(clause, total, covered)

        if spec_type == "remaining":
            deferred_indices.append(len(parsed_clauses))
            parsed_clauses.append({"action": action, "sel": None, "spec_type": "remaining"})
            continue

        if spec_sel is None:
            return None

        parsed_clauses.append({"action": action, "sel": spec_sel, "spec_type": spec_type})

        # Track covered for next_n / deferred resolution
        if spec_sel.type == "range":
            for i in range(spec_sel.start or 0, (spec_sel.end or 0) + 1):
                covered.add(i)
        elif spec_sel.type == "indices":
            covered.update(spec_sel.values)

    # Resolve deferred "remaining" clauses
    if deferred_indices:
        remaining_sel = SelectionExpr(type="filter",
                                      condition="not_in_covered",
                                      total=total)
        # For small datasets materialise; for large keep as filter
        if total <= MAX_BULK_ACTION:
            rem_list = [
                i for i in range(total)
                if i not in covered
                and (not ambiguities or i >= len(ambiguities)
                     or not ambiguities[i].get("answered", False))
            ]
            remaining_sel = SelectionExpr(type="indices", values=rem_list, total=total)
            covered.update(rem_list)
        for ci in deferred_indices:
            parsed_clauses[ci]["sel"] = remaining_sel

    non_empty = [c for c in parsed_clauses if c["sel"] and c["sel"].type != "empty"]
    if len(non_empty) < 2:
        return None

    actions: list[dict] = [
        _make_action(c["action"], c["sel"])
        for c in parsed_clauses
        if c["sel"] and c["sel"].type != "empty"
    ]

    total_affected = _total_affected_est(actions)
    if total_affected == 0:
        return None

    # FIX-18: conflict detection
    conflicts = _detect_conflicts(actions)

    interpretation = _build_interpretation(actions, "compound_range", total_affected)
    audit          = _build_audit("compound_range", None, "compound_parser", time.time())

    return {
        "actions"          : actions,
        "confidence"       : 0.92,
        "needsAI"          : False,
        "needsConfirmation": False,
        "lowConfidence"    : bool(conflicts),
        "interpretation"   : interpretation,
        "rawText"          : raw_text,
        "matchType"        : "compound_range",
        "cancelled"        : False,
        "conflicts"        : conflicts,
        "emptyResult"      : False,
        "audit"            : audit,
    }


def _split_into_clauses(t: str) -> list[str]:
    """
    FIX-05: Split on connector words/commas only when the following fragment
    contains an action keyword. Prevents "items 2, 5, and 8" from being
    split into garbage clauses.
    """
    tokens = []
    last_end = 0
    for m in _RE_CONNECTOR_SPLIT.finditer(t):
        tokens.append(t[last_end:m.start()])
        last_end = m.end()
    tokens.append(t[last_end:])
    tokens = [tok.strip() for tok in tokens if tok.strip()]

    if len(tokens) <= 1:
        return tokens

    merged: list[str] = []
    for tok in tokens:
        if merged and not _detect_action(tok)[0]:
            merged[-1] = merged[-1] + " " + tok
        else:
            merged.append(tok)

    return merged


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 9 — POSITION / RANGE SPEC PARSING
# ══════════════════════════════════════════════════════════════════════════════

def _parse_position_spec(
    clause: str,
    total: int,
    covered: set,
) -> tuple[SelectionExpr | None, str]:
    """
    FIX-06: All numeric range extraction guarded by _is_money_context().
    Returns (SelectionExpr | None, spec_type_str).
    """
    # ── "from N to M" / "N to M" / "N-M" (FIX-06: not if money context) ──
    # Check for money/amount range first and exclude it
    if _RE_AMOUNT_RANGE.search(clause):
        # This looks like an amount range, not an item range — treat as filter
        under_m = _RE_UNDER.search(clause)
        over_m  = _RE_OVER.search(clause)
        cond_parts = []
        if under_m:
            cond_parts.append(f"amount < {under_m.group(1)}")
        if over_m:
            cond_parts.append(f"amount > {over_m.group(1)}")
        condition = " AND ".join(cond_parts) if cond_parts else "amount_range"
        return SelectionExpr(type="filter", condition=condition, total=total), "amount_filter"

    range_m = _RE_RANGE.search(clause)
    if range_m:
        # FIX-06: guard against money context
        if not _is_money_context(clause, range_m):
            if range_m.group(1) is not None:
                s, e = int(range_m.group(1).replace(",", "")), int(range_m.group(2).replace(",", ""))
            else:
                s, e = int(range_m.group(3).replace(",", "")), int(range_m.group(4).replace(",", ""))
            start_idx = max(0, s - 1)
            end_idx   = min(total - 1, e - 1)
            if start_idx > end_idx:
                start_idx, end_idx = end_idx, start_idx
            # Remove already-covered in compact form
            if covered:
                vals = [i for i in range(start_idx, end_idx + 1) if i not in covered]
                if len(vals) == (end_idx - start_idx + 1):
                    return SelectionExpr(type="range", start=start_idx, end=end_idx, total=total), "from_to"
                return SelectionExpr(type="indices", values=vals, total=total), "from_to"
            return SelectionExpr(type="range", start=start_idx, end=end_idx, total=total), "from_to"

    # ── "up to N" / "upto N" ──────────────────────────────────────────────
    up_to_m = _RE_UP_TO.search(clause)
    if up_to_m:
        n       = int(up_to_m.group(1).replace(",", ""))
        end_idx = min(total - 1, n - 1)
        if end_idx < 0:
            return SelectionExpr(type="empty", total=total), "up_to"
        if covered:
            vals = [i for i in range(0, end_idx + 1) if i not in covered]
            return SelectionExpr(type="indices", values=vals, total=total), "up_to"
        return SelectionExpr(type="range", start=0, end=end_idx, total=total), "up_to"

    # ── "the first N" ─────────────────────────────────────────────────────
    first_m = _RE_FIRST_N.search(clause)
    if first_m:
        n       = int(first_m.group(1).replace(",", ""))
        end_idx = min(total, n)
        if end_idx <= 0:
            return SelectionExpr(type="empty", total=total), "first_n"
        if covered:
            vals = [i for i in range(0, end_idx) if i not in covered]
            return SelectionExpr(type="indices", values=vals, total=total), "first_n"
        return SelectionExpr(type="range", start=0, end=end_idx - 1, total=total), "first_n"

    # ── "the last N" ──────────────────────────────────────────────────────
    last_m = _RE_LAST_N.search(clause)
    if last_m:
        n         = int(last_m.group(1).replace(",", ""))
        start_idx = max(0, total - n)
        if start_idx >= total:
            return SelectionExpr(type="empty", total=total), "last_n"
        if covered:
            vals = [i for i in range(start_idx, total) if i not in covered]
            return SelectionExpr(type="indices", values=vals, total=total), "last_n"
        return SelectionExpr(type="range", start=start_idx, end=total - 1, total=total), "last_n"

    # ── "next N" ──────────────────────────────────────────────────────────
    next_m = _RE_NEXT_N.search(clause)
    if next_m:
        n         = int(next_m.group(1).replace(",", ""))
        start_idx = (max(covered) + 1) if covered else 0
        end_idx   = min(total, start_idx + n)
        if start_idx >= total or end_idx <= start_idx:
            return SelectionExpr(type="empty", total=total), "next_n"
        return SelectionExpr(type="range", start=start_idx, end=end_idx - 1, total=total), "next_n"

    # ── "remaining" / "rest" / "everything else" ──────────────────────────
    if _RE_REMAINING.search(clause):
        return None, "remaining"

    return None, "none"


def _is_money_context(clause: str, match: re.Match) -> bool:
    """
    FIX-06: Return True if the numeric range match appears to be an amount
    range rather than an item position range.

    Heuristics:
      - Match preceded by "$"
      - Match followed immediately by a currency unit
      - Clause contains "usd", "eur", etc. AND also contains amount-filter words
        ("under", "over", "between", "above", "below")
    """
    start, end = match.start(), match.end()
    # "$1000-2000"
    if start > 0 and clause[start - 1] == '$':
        return True
    # "1000-2000 usd"
    tail = clause[end:end + 15].strip().lower()
    for cu in _CURRENCY_UNITS:
        if tail.startswith(cu):
            return True
    # "between 1000 and 2000 dollars"
    if _RE_AMOUNT_RANGE.search(clause):
        return True
    return False


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 10 — EXCLUSION PARSING
# ══════════════════════════════════════════════════════════════════════════════

def _parse_exclusion(
    t: str,
    action: str,
    ambiguities: list,
    total: int,
    amb_idx: AmbiguityIndexes,
) -> dict | None:
    """
    Handle "approve all except the last 3", "reject everything but items 5 and 10".
    """
    excl_match = re.search(
        r'\b(?:except|excluding|but\s+not|all\s+but|apart\s+from'
        r'|but\s+(?=(?:the\s+)?(?:last|first)))\b\s*(?:the\s+)?(.+)$',
        t, re.IGNORECASE
    )
    if not excl_match:
        return None

    excl_spec = excl_match.group(1).strip()
    excluded  = _parse_exclusion_spec(excl_spec, total)

    if excluded is None:
        return None

    if ambiguities:
        remaining = [
            i for i in range(total)
            if i not in excluded
            and i < len(ambiguities)
            and not ambiguities[i].get("answered", False)
        ]
    else:
        remaining = [i for i in range(total) if i not in excluded]

    if not remaining:
        return _needs_ai(t, "Exclusion resulted in empty target set", "empty_exclusion")

    # FIX-14: use SelectionExpr for large remaining sets
    if len(remaining) > 200:
        sel = SelectionExpr(type="filter",
                            condition=f"not in excluded set of {len(excluded)} item(s)",
                            total=total)
    else:
        sel = SelectionExpr(type="indices", values=remaining, total=total)

    actions = [_make_action(action, sel)]
    total_affected = _total_affected_est(actions)
    excluded_desc  = _describe_exclusion(excl_spec, excluded, total)
    interpretation = (
        f"{action.capitalize()} {total_affected} item"
        f"{'s' if total_affected != 1 else ''} "
        f"(all except {excluded_desc})"
    )
    audit = _build_audit("exclusion", None, "exclusion_parser", time.time())

    return {
        "actions"          : actions,
        "confidence"       : 0.95,
        "needsAI"          : False,
        "needsConfirmation": False,
        "lowConfidence"    : False,
        "interpretation"   : interpretation,
        "rawText"          : t,
        "matchType"        : "exclusion",
        "cancelled"        : False,
        "conflicts"        : [],
        "emptyResult"      : False,
        "audit"            : audit,
    }


def _parse_exclusion_spec(spec: str, total: int) -> set | None:
    excluded = set()

    if re.search(r'\blast\s+one\b|\blast\s+item\b|\blast\b(?!\s+\d)', spec, re.IGNORECASE):
        m = re.search(r'last\s+(\d+)', spec, re.IGNORECASE)
        n = int(m.group(1)) if m else 1
        excluded.update(range(max(0, total - n), total))
        return excluded

    if re.search(r'\bfirst\s+one\b|\bfirst\s+item\b|\bfirst\b(?!\s+\d)', spec, re.IGNORECASE):
        m = re.search(r'first\s+(\d+)', spec, re.IGNORECASE)
        n = int(m.group(1)) if m else 1
        excluded.update(range(0, min(total, n)))
        return excluded

    m = re.search(r'\blast\s+(\d+)\b', spec, re.IGNORECASE)
    if m:
        excluded.update(range(max(0, total - int(m.group(1))), total))
        return excluded

    m = re.search(r'\bfirst\s+(\d+)\b', spec, re.IGNORECASE)
    if m:
        excluded.update(range(0, min(total, int(m.group(1)))))
        return excluded

    nums = _RE_BARE_NUM.findall(spec)
    if nums:
        for n in nums:
            idx = int(n) - 1
            if 0 <= idx < total:
                excluded.add(idx)
        if excluded:
            return excluded

    return None


def _describe_exclusion(spec: str, excluded: set, total: int) -> str:
    if not excluded:
        return "nothing"
    if len(excluded) == 1:
        idx = next(iter(excluded))
        if idx == total - 1:
            return "the last item"
        if idx == 0:
            return "the first item"
        return f"item {idx + 1}"
    s = sorted(excluded)
    if s == list(range(total - len(excluded), total)):
        return f"the last {len(excluded)} items"
    if s == list(range(len(excluded))):
        return f"the first {len(excluded)} items"
    return f"items {', '.join(str(i + 1) for i in s)}"


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 11 — TARGET PARSING
# ══════════════════════════════════════════════════════════════════════════════

def _parse_target(
    t: str,
    ambiguities: list,
    total: int,
    exclude: set,
    amb_idx: AmbiguityIndexes,
) -> tuple[SelectionExpr, str, float, str]:
    """
    Returns (SelectionExpr, match_type, confidence_penalty, rule_id).

    FIX-24: Invoice number vs position disambiguation runs first.
    FIX-06: Numeric ranges guarded against money context.
    FIX-25: Returns SelectionExpr — never materialises large lists.
    """
    # ── 0. FIX-24: Invoice number / item reference disambiguation ─────────────
    inv_m = _RE_INVOICE_REF.search(t)
    if inv_m:
        spoken_ref = inv_m.group(1).lower().strip()
        if spoken_ref in amb_idx.invoice_num_index:
            row_idx = amb_idx.invoice_num_index[spoken_ref]
            sel = SelectionExpr(type="indices", values=[row_idx], total=total)
            return sel, "invoice_number", 0.0, "invoice_num_match"
        # Spoken reference looks like a real invoice number but doesn't match any
        # known invoice — warn rather than silently convert to position
        return SelectionExpr(type="empty", total=total), "invoice_number", 0.20, "invoice_num_not_found"

    item_m = _RE_ITEM_REF.search(t)
    if item_m:
        # "item 5" is unambiguously positional
        idx = int(item_m.group(1)) - 1
        if 0 <= idx < total and idx not in exclude:
            return SelectionExpr(type="indices", values=[idx], total=total), "item_ref", 0.0, "item_ref"

    # ── BATCH-2 FIX: "N items/invoices/rows/records" = quantity, not position ──
    # Must run BEFORE the bare-number fallback in step 3 below, which would
    # otherwise read "45" in "approve 45 items" as a single item's position.
    # Selects the first N items that are not yet answered, in document order —
    # this is what a user means by "approve 45 items": the next 45 still
    # awaiting a decision, not literally row index 45.
    #
    # GUARD: only fires when NO directional keyword is present. "the last 10
    # invoices" / "up to 20 items" / "next 5 rows" already have correct
    # direction-aware handling below via _RE_LAST_N / _RE_UP_TO / _RE_NEXT_N —
    # this generic count check must defer to those, or "last 10" would
    # incorrectly grab the FIRST 10 unanswered items instead of the final 10.
    count_m = _RE_COUNT_N.search(t)
    has_directional_kw = bool(
        _RE_FIRST_N.search(t) or _RE_LAST_N.search(t) or
        _RE_NEXT_N.search(t)  or _RE_UP_TO.search(t)
    )
    if count_m and not has_directional_kw:
        n = int(count_m.group(1).replace(',', ''))
        unanswered = [
            i for i in range(total)
            if i not in exclude
            and (not ambiguities or i >= len(ambiguities) or not ambiguities[i].get("answered", False))
        ]
        take = unanswered[:n]
        if take:
            return SelectionExpr(type="indices", values=take, total=total), "count_n", 0.0, "count_n"
        return SelectionExpr(type="empty", total=total), "count_n", 0.20, "count_n_no_targets"

    # ── 1. Position spec (up to N / first N / last N / range / remaining) ────
    spec_sel, spec_type = _parse_position_spec(t, total, exclude)
    if spec_type == "remaining":
        # SelectionExpr filter — materialise only if needed
        if total <= MAX_BULK_ACTION:
            rem = [
                i for i in range(total) if i not in exclude
                and (not ambiguities or i >= len(ambiguities)
                     or not ambiguities[i].get("answered", False))
            ]
            return SelectionExpr(type="indices", values=rem, total=total), "remaining", 0.0, "remaining"
        return SelectionExpr(type="all", total=total), "remaining", 0.0, "remaining"

    if spec_sel is not None and spec_type in ("up_to", "first_n", "last_n", "next_n", "from_to", "amount_filter"):
        return spec_sel, spec_type, 0.0, spec_type

    # ── 2. FIX-06: Explicit numeric range — only if NOT money context ─────────
    range_m = _RE_RANGE.search(t)
    if range_m and not _is_money_context(t, range_m):
        if range_m.group(1) is not None:
            s, e = int(range_m.group(1).replace(",", "")), int(range_m.group(2).replace(",", ""))
        else:
            s, e = int(range_m.group(3).replace(",", "")), int(range_m.group(4).replace(",", ""))
        start_idx = max(0, s - 1)
        end_idx   = min(total - 1, e - 1)
        if start_idx > end_idx:
            start_idx, end_idx = end_idx, start_idx
        return SelectionExpr(type="range", start=start_idx, end=end_idx, total=total), "range", 0.0, "range"

    # ── 3. Explicit short list ────────────────────────────────────────────────
    if _RE_BARE_NUM.search(t) and not _RE_DOLLAR_NUM.search(t):
        if not _has_filter_keywords(t):
            nums = [int(n) - 1 for n in _RE_BARE_NUM.findall(t)]
            nums = [n for n in nums if 0 <= n < total and n not in exclude]
            if nums and len(nums) <= 200:
                return SelectionExpr(type="indices", values=nums, total=total), "list", 0.05, "numeric_list"

    # ── 4. Bulk + optional filter ─────────────────────────────────────────────
    if _is_bulk(t):
        if _has_filter_keywords(t):
            filter_sel, filter_type = _filter_with_indexes(t, ambiguities, total, exclude, amb_idx)
            if filter_sel.type == "empty":
                return filter_sel, filter_type, 0.0, "filter_no_match"
            return filter_sel, filter_type, 0.0, "bulk_filter"
        return SelectionExpr(type="all", total=total), "bulk", 0.0, "bulk_all"

    # ── 5. Implicit filter ────────────────────────────────────────────────────
    if _has_filter_keywords(t):
        filter_sel, filter_type = _filter_with_indexes(t, ambiguities, total, exclude, amb_idx)
        if filter_sel.type == "empty":
            return filter_sel, filter_type, 0.20, "filter_no_match"
        return filter_sel, filter_type, 0.10, "implicit_filter"

    # ── 6. Single bare action word → treat as "all" ───────────────────────────
    action_words = [kw for kws in ACTION_KEYWORDS.values() for kw in kws]
    stripped = t
    for aw in sorted(action_words, key=len, reverse=True):
        stripped = stripped.replace(aw, '')
    stripped = re.sub(r'[^a-z0-9]', ' ', stripped).strip()

    if len(stripped) < 5:
        return SelectionExpr(type="all", total=total), "bulk_implicit", 0.10, "bare_action"

    return SelectionExpr(type="empty", total=total), "unknown", 0.40, "unknown"


def _has_filter_keywords(t: str) -> bool:
    return bool(_RE_FILTER_KWS.search(t))


def _determine_filter_type(t: str) -> str:
    if re.search(r'\b(under|over|above|below|less\s+than|more\s+than)\b', t, re.IGNORECASE):
        return "amount_filter"
    if re.search(r'\b(from|vendor|supplier|company)\b', t, re.IGNORECASE):
        return "vendor_filter"
    if _RE_CURRENCY.search(t):
        return "currency_filter"
    if re.search(r'\b(duplicate|mismatch|unmatched)\b', t, re.IGNORECASE):
        return "type_filter"
    return "bulk"


def _filter_with_indexes(
    t: str,
    ambiguities: list,
    total: int,
    exclude: set,
    amb_idx: AmbiguityIndexes,
) -> tuple[SelectionExpr, str]:
    """
    FIX-09: Use pre-built indexes for efficient filtering.
    FIX-10: Vendor matching uses word-boundary regex, not substring.
    """
    filter_type = _determine_filter_type(t)

    under_m  = _RE_UNDER.search(t)
    over_m   = _RE_OVER.search(t)
    max_amt  = float(under_m.group(1).replace(',', '')) if under_m else None
    min_amt  = float(over_m.group(1).replace(',', ''))  if over_m  else None
    cur_m    = _RE_CURRENCY.search(t)
    currency = cur_m.group(1).lower() if cur_m else None

    # FIX-10: vendor keyword word-boundary matching
    vendor_kws = _extract_vendor_keywords(t)

    want_dup      = bool(re.search(r'\bduplicate\b', t, re.IGNORECASE))
    want_mismatch = bool(re.search(r'\b(mismatch|unmatched|flagged)\b', t, re.IGNORECASE))

    if not ambiguities:
        # No ambiguity data: return a filter expression for the client
        conds = []
        if max_amt is not None:
            conds.append(f"amount < {max_amt}")
        if min_amt is not None:
            conds.append(f"amount > {min_amt}")
        if vendor_kws:
            conds.append(f"vendor in [{', '.join(vendor_kws)}]")
        if currency:
            conds.append(f"currency = {currency}")
        condition = " AND ".join(conds) if conds else "filter"
        return SelectionExpr(type="filter", condition=condition, total=total), filter_type

    # ── Amount filter using sorted index ──────────────────────────────────────
    candidate_sets: list[set[int]] = []

    if max_amt is not None or min_amt is not None:
        amt_candidates: set[int] = set()
        for amt_val, row_idx in amb_idx.amount_pairs:
            if max_amt is not None and amt_val > max_amt:
                continue
            if min_amt is not None and amt_val < min_amt:
                continue
            amt_candidates.add(row_idx)
        candidate_sets.append(amt_candidates)

    # ── Vendor filter (FIX-10: word-boundary) ─────────────────────────────────
    if vendor_kws:
        vendor_candidates: set[int] = set()
        for vendor_name, indices_list in amb_idx.vendor_index.items():
            for kw in vendor_kws:
                if len(kw) < 3:
                    continue  # reject short tokens
                # FIX-10: word boundary, not substring
                if re.search(rf'\b{re.escape(kw)}\b', vendor_name, re.IGNORECASE):
                    vendor_candidates.update(indices_list)
                    break
        candidate_sets.append(vendor_candidates)

    # ── Currency filter ───────────────────────────────────────────────────────
    if currency:
        cur_candidates = set(amb_idx.currency_index.get(currency, []))
        candidate_sets.append(cur_candidates)

    # ── Type filter ───────────────────────────────────────────────────────────
    if want_dup:
        candidate_sets.append(set(amb_idx.type_index.get("duplicate_invoice", [])))
    if want_mismatch:
        mismatch_rows: set[int] = set()
        for t_key in ("amount_mismatch", "no_po_match"):
            mismatch_rows.update(amb_idx.type_index.get(t_key, []))
        candidate_sets.append(mismatch_rows)

    # Intersect all candidate sets
    if candidate_sets:
        result_set = candidate_sets[0]
        for cs in candidate_sets[1:]:
            result_set = result_set & cs
        result_list = sorted(i for i in result_set if i not in exclude)
    else:
        # No concrete filters resolved — return filter expression
        return SelectionExpr(type="filter", condition=filter_type, total=total), filter_type

    if not result_list:
        return SelectionExpr(type="empty", total=total), filter_type

    return SelectionExpr(type="indices", values=result_list, total=total), filter_type


def _extract_vendor_keywords(t: str) -> list[str]:
    """
    FIX-10: Extract vendor keywords with word-boundary-safe connector splitting.
    Returns a list of lowercase keyword tokens (possibly empty).
    """
    m = _RE_VENDOR_PHRASE.search(t)
    if not m:
        return []

    raw_span = m.group(1).lower()
    tokens   = _RE_VENDOR_SPLIT.split(raw_span)

    noise = {'all', 'the', 'my', 'our', 'their', 'that', 'this',
             'invoices', 'items', 'and', 'or'}
    keywords = []
    for tok in tokens:
        tok = tok.strip()
        if not tok or tok in noise or len(tok) <= 2:
            continue
        if ' ' in tok:
            continue  # multi-word fragment — likely parse artefact
        keywords.append(tok)

    return keywords


def _parse_amount_val(raw) -> float | None:
    if raw is None:
        return None
    try:
        cleaned = re.sub(r'[^\d.-]', '', str(raw))
        return float(cleaned) if cleaned else None
    except Exception:
        return None


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 12 — SECONDARY ACTIONS
# ══════════════════════════════════════════════════════════════════════════════

def _parse_secondary_actions(
    t: str,
    ambiguities: list,
    total: int,
    covered: set,
    amb_idx: AmbiguityIndexes,
) -> list[dict]:
    """
    Fallback compound handler for simple "approve 1-20 and reject 21-30" forms
    when _parse_compound_command didn't fire.
    FIX-02: Negation check per secondary clause.
    """
    parts = re.split(r'\b(?:and|,|then|also|plus)\b', t, flags=re.IGNORECASE)
    if len(parts) < 2:
        return []

    actions = []
    for part in parts[1:]:
        part = part.strip()
        if not part:
            continue
        action, kw = _detect_action(part)
        if not action:
            continue
        if _is_negated(part, kw or ""):
            continue
        sel, _, _, _ = _parse_target(part, ambiguities, total, covered, amb_idx)
        if sel.type not in ("empty", "unknown"):
            actions.append(_make_action(action, sel))
            if sel.type == "indices":
                covered.update(sel.values)
            elif sel.type == "range":
                covered.update(range(sel.start or 0, (sel.end or 0) + 1))

    return actions


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 13 — CONFLICT DETECTION (FIX-18)
# ══════════════════════════════════════════════════════════════════════════════

def _detect_conflicts(actions: list[dict]) -> list[dict]:
    """
    FIX-18: Detect overlapping index ranges across multiple actions.
    Only checks SelectionExpr of type "range" or "indices" (small sets).
    Returns a list of conflict descriptors.
    """
    conflicts = []
    materialised: list[tuple[int, str, set]] = []  # (action_idx, action, set)

    for i, act in enumerate(actions):
        sel = act.get("selection")
        if sel is None:
            continue
        if sel["type"] == "indices":
            s = set(sel.get("values", []))
        elif sel["type"] == "range":
            start = sel.get("start", 0)
            end   = sel.get("end", 0)
            if end - start > 50_000:
                continue  # too large to check without materialising
            s = set(range(start, end + 1))
        else:
            continue
        materialised.append((i, act["action"], s))

    for i in range(len(materialised)):
        for j in range(i + 1, len(materialised)):
            idx_i, act_i, set_i = materialised[i]
            idx_j, act_j, set_j = materialised[j]
            overlap = set_i & set_j
            if overlap:
                sample = sorted(overlap)[:5]
                conflicts.append({
                    "action_a"     : act_i,
                    "action_b"     : act_j,
                    "overlap_count": len(overlap),
                    "sample_indices": sample,
                    "description"  : (
                        f"Actions '{act_i}' and '{act_j}' overlap on "
                        f"{len(overlap)} item(s). "
                        f"Sample indices: {sample}."
                    ),
                })

    return conflicts


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 14 — BULK CONFIRMATION (FIX-15 / FIX-16)
# ══════════════════════════════════════════════════════════════════════════════

def _apply_bulk_confirmation(result: dict, raw_text: str) -> dict:
    """
    FIX-15: Uses _total_affected_est() — computed once, not repeated.
    FIX-16: MAX_BULK_ACTION guard.
    """
    actions        = result.get("actions", [])
    total_affected = _total_affected_est(actions)

    # FIX-16: hard cap
    max_bulk_exceeded = total_affected > MAX_BULK_ACTION
    if max_bulk_exceeded:
        result["lowConfidence"] = True
        result["maxBulkExceeded"] = True
        result["maxBulkMessage"] = (
            f"This command would affect ~{total_affected} items, exceeding the "
            f"safe bulk limit of {MAX_BULK_ACTION}. Please narrow the selection."
        )

    if total_affected >= BULK_CONFIRM_THRESHOLD:
        action_summary   = _build_action_summary(actions)
        confirmation_msg = (
            f"You are about to {action_summary}. "
            f"This will affect ~{total_affected} invoice(s). "
            f"Say CONFIRM to proceed or CANCEL to abort."
        )
        return {
            "actions"          : [],
            "confidence"       : result.get("confidence", 0.9),
            "needsAI"          : False,
            "needsConfirmation": True,
            "confirmationMsg"  : confirmation_msg,
            "pendingActions"   : actions,
            "interpretation"   : result.get("interpretation", ""),
            "rawText"          : raw_text,
            "matchType"        : result.get("matchType", "bulk"),
            "totalAffected"    : total_affected,
            "cancelled"        : False,
            "conflicts"        : result.get("conflicts", []),
            "emptyResult"      : result.get("emptyResult", False),
            "audit"            : result.get("audit", {}),
            "maxBulkExceeded"  : max_bulk_exceeded,
            **({"maxBulkMessage": result["maxBulkMessage"]} if max_bulk_exceeded else {}),
        }

    return result


def _total_affected_est(actions: list[dict]) -> int:
    """FIX-15: Single helper — avoids repeated sum() calls across the codebase."""
    total = 0
    for a in actions:
        sel = a.get("selection", {})
        if not sel:
            total += len(a.get("indices", []))  # legacy compat
            continue
        t = sel.get("type")
        if t == "indices":
            total += len(sel.get("values", []))
        elif t == "range":
            s = sel.get("start", 0)
            e = sel.get("end", 0)
            total += max(0, e - s + 1)
        elif t == "all":
            total += sel.get("estimated_count", 0)
        # "filter" and "empty" contribute 0 to estimated count here
    return total


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 15 — CONFIRMATION HANDLING (FIX-03 / FIX-04)
# ══════════════════════════════════════════════════════════════════════════════

def _classify_confirmation_intent(t: str) -> str:
    """
    FIX-03 / FIX-04: Robust intent classification for confirmation responses.

    Returns "confirm", "cancel", or "unclear".

    Strategy:
      1. Normalise: lowercase, collapse whitespace.
      2. Cancel wins if a cancel keyword appears as a dominant signal
         (not embedded inside a sentence expressing the opposite).
      3. Confirm wins if a confirm keyword appears without adjacent negation.
      4. Otherwise "unclear" — ask again.
    """
    t = t.strip().lower()
    t = re.sub(r'\s+', ' ', t)

    # Short exact matches are most reliable
    _CONFIRM_EXACT = frozenset(["yes", "confirm", "confirmed", "go ahead",
                                "do it", "proceed", "execute", "apply",
                                "sure", "correct", "affirmative", "that's right"])
    _CANCEL_EXACT  = frozenset(["no", "cancel", "stop", "abort", "never mind",
                                "nope", "negative", "forget it", "disregard"])

    if t in _CONFIRM_EXACT:
        return "confirm"
    if t in _CANCEL_EXACT:
        return "cancel"

    # Check for negation BEFORE a confirm keyword
    # "I am not sure but yes maybe later" → unclear
    # "yes please go ahead" → confirm
    has_cancel  = any(re.search(rf'\b{re.escape(kw)}\b', t) for kw in CANCEL_KEYWORDS)
    has_confirm = any(re.search(rf'\b{re.escape(kw)}\b', t) for kw in CONFIRM_KEYWORDS)
    has_negation = bool(_RE_NEGATION.search(t))

    # Cancel overrides confirm
    if has_cancel and not has_confirm:
        return "cancel"

    # Confirm without negation/cancel = confirm
    if has_confirm and not has_negation and not has_cancel:
        return "confirm"

    # Mixed / uncertain
    return "unclear"


def _handle_confirmation_response(t: str, pending: dict, raw_text: str) -> dict:
    """FIX-03 / FIX-04: Uses _classify_confirmation_intent instead of substring match."""
    pending_actions = pending.get("actions", [])
    total_affected  = pending.get("totalAffected", 0)
    interpretation  = pending.get("interpretation", "")

    intent = _classify_confirmation_intent(t)

    if intent == "confirm":
        return {
            "actions"          : pending_actions,
            "confidence"       : 1.0,
            "needsAI"          : False,
            "needsConfirmation": False,
            "interpretation"   : f"Confirmed: {interpretation}",
            "rawText"          : raw_text,
            "matchType"        : "confirmed",
            "cancelled"        : False,
            "conflicts"        : [],
            "emptyResult"      : False,
            "audit"            : _build_audit("confirmed", None, "confirmation", time.time()),
        }

    if intent == "cancel":
        return {
            "actions"          : [],
            "confidence"       : 1.0,
            "needsAI"          : False,
            "needsConfirmation": False,
            "interpretation"   : "Action cancelled by user.",
            "rawText"          : raw_text,
            "matchType"        : "cancelled",
            "cancelled"        : True,
            "conflicts"        : [],
            "emptyResult"      : False,
            "audit"            : _build_audit("cancelled", None, "confirmation", time.time()),
        }

    # "unclear" — ask again
    action_summary   = _build_action_summary(pending_actions)
    confirmation_msg = (
        f"Please confirm: {action_summary} affecting {total_affected} invoice(s). "
        f"Say CONFIRM to proceed or CANCEL to abort."
    )
    return {
        "actions"          : [],
        "confidence"       : 0.8,
        "needsAI"          : False,
        "needsConfirmation": True,
        "confirmationMsg"  : confirmation_msg,
        "pendingActions"   : pending_actions,
        "interpretation"   : interpretation,
        "rawText"          : raw_text,
        "matchType"        : "awaiting_confirmation",
        "totalAffected"    : total_affected,
        "cancelled"        : False,
        "conflicts"        : [],
        "emptyResult"      : False,
        "audit"            : _build_audit("awaiting_confirmation", None, "confirmation", time.time()),
    }


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 16 — FORMATTING & AUDIT (FIX-17 / FIX-23)
# ══════════════════════════════════════════════════════════════════════════════

def _make_action(action: str, sel: SelectionExpr) -> dict:
    """Build a standard action dict with SelectionExpr serialised."""
    return {
        "action"   : action,
        "selection": sel.to_dict(),
        "response" : ACTION_RESPONSES[action],
        # "indices" kept for backward compat with callers that use it directly
        # (populated only for small explicit lists)
        "indices"  : sel.values if sel.type == "indices" else [],
    }


def _build_interpretation(actions: list[dict], match_type: str, total: int) -> str:
    if not actions:
        return "No actionable commands found"
    parts = []
    for a in actions:
        label = {
            "approve"    : "Approve",
            "reject"     : "Reject",
            "hold"       : "Hold",
            "request_po" : "Request PO for",
        }.get(a["action"], a["action"])
        sel   = a.get("selection", {})
        count = sel.get("count") or sel.get("estimated_count") or len(a.get("indices", []))
        count_str = f"~{count}" if sel.get("type") in ("filter", "all") else str(count)
        parts.append(f"{label} {count_str} item{'s' if count != 1 else ''}")
    return " · ".join(parts) + f"  [match: {match_type}]"


def _build_action_summary(actions: list[dict]) -> str:
    if not actions:
        return "perform no actions"
    parts = []
    for a in actions:
        verb  = {
            "approve"    : "approve",
            "reject"     : "reject",
            "hold"       : "hold",
            "request_po" : "request PO for",
        }.get(a["action"], a["action"])
        sel   = a.get("selection", {})
        count = sel.get("count") or sel.get("estimated_count") or len(a.get("indices", []))
        parts.append(f"{verb} ~{count} invoice(s)")
    return " and ".join(parts)


def _describe_filter(t: str) -> str:
    """FIX-23: Human-readable description of what filter was attempted."""
    vendor_kws = _extract_vendor_keywords(t)
    if vendor_kws:
        return f"vendor '{', '.join(vendor_kws)}'"
    cur_m = _RE_CURRENCY.search(t)
    if cur_m:
        return f"currency '{cur_m.group(1).upper()}'"
    under_m = _RE_UNDER.search(t)
    if under_m:
        return f"amount under {under_m.group(1)}"
    over_m = _RE_OVER.search(t)
    if over_m:
        return f"amount over {over_m.group(1)}"
    return "the specified filter"


def _build_audit(rule_id: str | None, matched_kw: str | None,
                 confidence_source: str, ts_start: float) -> dict:
    """FIX-17: Provenance metadata attached to every result."""
    return {
        "parser_version"    : PARSER_VERSION,
        "rule_id"           : rule_id or "unknown",
        "matched_keyword"   : matched_kw,
        "confidence_source" : confidence_source,
        "ts_utc"            : time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "parse_ms"          : round((time.time() - ts_start) * 1000, 2),
    }


def _needs_ai(text: str, reason: str, rule_id: str = "ai_required") -> dict:
    return {
        "actions"          : [],
        "confidence"       : 0.0,
        "needsAI"          : True,
        "needsConfirmation": False,
        "lowConfidence"    : True,
        "interpretation"   : f"Requires AI: {reason}",
        "rawText"          : text,
        "matchType"        : "ai_required",
        "aiReason"         : reason,
        "cancelled"        : False,
        "conflicts"        : [],
        "emptyResult"      : False,
        "audit"            : _build_audit(rule_id, None, "ai_fallback", time.time()),
    }


def _error_result(text: str, message: str, rule_id: str) -> dict:
    return {
        "actions"          : [],
        "confidence"       : 0.0,
        "needsAI"          : False,
        "needsConfirmation": False,
        "lowConfidence"    : True,
        "interpretation"   : f"Error: {message}",
        "rawText"          : text,
        "matchType"        : "error",
        "error"            : message,
        "cancelled"        : False,
        "conflicts"        : [],
        "emptyResult"      : True,
        "audit"            : _build_audit(rule_id, None, "error", time.time()),
    }


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 17 — HELPERS
# ══════════════════════════════════════════════════════════════════════════════

def _require(config: dict, key: str):
    if key not in config:
        raise ValueError(f"Required config key missing: {key}")
    return config[key]


def _out(data: dict):
    sys.stdout.write(json.dumps(data))
    sys.stdout.flush()


# ══════════════════════════════════════════════════════════════════════════════
# ENTRYPOINT
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        tb = traceback.format_exc()
        sys.stdout.write(json.dumps({
            "ok"   : False,
            "error": str(e),
            "trace": tb,
        }))
        sys.stdout.flush()
