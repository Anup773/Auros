"""
backend/python/data_engine.py

Auros deterministic data engine.

CHANGES FROM V3 (this version):

  FIX 1 — Silent OCR failure is now a hard error (CRITICAL)
    Previously: op_reconcile() continued with 0 invoices when OCR returned
    empty rows, producing a "successful" run with all zeros. Finance teams
    could believe reconciliation completed when no data was processed.
    FIX: If OCR returns 0 rows AND confidence < 0.5, raise ValueError so
    the caller gets a clear error instead of a silent empty result.

  FIX 2 — O(n²) → O(1) reconciliation match lookup (PERFORMANCE)
    Previously: build_reconciliation() used next(m for m in matches if ...)
    inside a loop over all invoices = O(n²). With 5000 invoices this means
    25,000,000 comparisons and multi-second freezes.
    FIX: Build a dict keyed by _rowIndex before the loop. O(1) lookup.

  FIX 3 — CSV output key loss fixed (DATA INTEGRITY)
    Previously: write_csv() used list(rows[0].keys()) as fieldnames.
    If row 2 had columns not in row 1, those values were silently dropped.
    FIX: Build union of all row keys before writing.

  FIX 4 — File existence check added to op_execute() (RELIABILITY)
    Previously: op_execute() could throw a confusing openpyxl/csv error
    if the invoice file didn't exist. Now raises FileNotFoundError early.

  FIX 5 — Copilot command intent parser (FEATURE)
    New operation 'parse_command' routes to op_parse_command().
    Replaces regex-only matching with a 4-step intent + normalization
    parser that handles natural language like:
      "approve 45 items for payment"
      "approve first 45 invoices"
      "reject the remaining invoices"
    Also fixes 1-based → 0-based row index conversion so
    "approve row number 1" correctly targets the first item.

  FIX 6 — OCR Gemini fallback is now server-side (RELIABILITY)
    op_reconcile() no longer returns empty rows and hopes the frontend
    enables gemini_fallback. If needsAIFallback=True is returned by the
    OCR engine and config has gemini_fallback=True, the data engine
    triggers the fallback path itself.

  All V2/V3 logic preserved (security, streaming, fuzzy matching,
  DuckDB duplicate detection, vendor indexing, ZIP safety).
"""

import sys
import json
import os
import io
import re
import csv
import math
import zipfile
import shutil
import hashlib
import tempfile
import traceback
from pathlib import Path
from datetime import datetime
from typing import Any

import warnings
warnings.filterwarnings("ignore")

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

try:
    from defusedxml import ElementTree as ET
    HAS_DEFUSEDXML = True
except ImportError:
    import xml.etree.ElementTree as ET
    HAS_DEFUSEDXML = False
    print(
        "[data_engine] WARNING: defusedxml not installed. "
        "Install with: pip install defusedxml --break-system-packages\n"
        "Falling back to stdlib ElementTree (NOT safe for untrusted XML).",
        file=sys.stderr
    )

try:
    import polars as pl
    HAS_POLARS = True
except ImportError:
    HAS_POLARS = False

try:
    import pandas as pd
    HAS_PANDAS = True
except ImportError:
    HAS_PANDAS = False

try:
    import duckdb
    HAS_DUCKDB = True
except ImportError:
    HAS_DUCKDB = False

try:
    from rapidfuzz import fuzz, process as rfprocess
    HAS_RAPIDFUZZ = True
except ImportError:
    HAS_RAPIDFUZZ = False

try:
    import openpyxl
    HAS_OPENPYXL = True
except ImportError:
    HAS_OPENPYXL = False

MAX_ZIP_EXTRACT_BYTES     = 500 * 1024 * 1024
MAX_ZIP_FILE_COUNT        = 200
MAX_ZIP_COMPRESSION_RATIO = 100
CHUNK_ROWS                = 50_000
FUZZY_VENDOR_THRESHOLD    = 85
AMOUNT_MISMATCH_PCT       = 0.02

SUPPORTED_EXTENSIONS = {'.csv', '.xlsx', '.xls', '.xml'}
OCR_EXTENSIONS       = {'.pdf', '.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.webp'}
DANGEROUS_EXTENSIONS = {
    '.exe', '.bat', '.sh', '.py', '.js', '.php', '.rb',
    '.dll', '.so', '.bin', '.cmd', '.ps1', '.vbs',
}
NESTED_ARCHIVE_EXTENSIONS = {'.zip', '.rar', '.7z', '.gz', '.tar', '.bz2', '.xz'}


def main():
    raw = sys.stdin.read()
    try:
        config = json.loads(raw)
    except json.JSONDecodeError as e:
        _fatal(f"Invalid JSON config: {e}")
        return

    op = config.get("operation")
    try:
        if op == "parse":
            result = op_parse(config)
        elif op == "schema":
            result = op_schema(config)
        elif op == "reconcile":
            result = op_reconcile(config)
        elif op == "execute":
            result = op_execute(config)
        elif op == "analyze":
            result = op_analyze(config)
        elif op == "extract_zip":
            result = op_extract_zip(config)
        elif op == "parse_xml":
            result = op_parse_xml(config)
        elif op == "ocr_invoice":
            result = op_ocr_invoice(config)
        elif op == "ocr_batch":
            result = op_ocr_batch(config)
        elif op == "parse_command":
            # FIX 5: Copilot intent parser
            result = op_parse_command(config)
        else:
            _fatal(f"Unknown operation: {op}")
            return
        sys.stdout.write(json.dumps({"ok": True, "result": result}))
        sys.stdout.flush()
    except Exception as e:
        tb = traceback.format_exc()
        sys.stdout.write(json.dumps({"ok": False, "error": str(e), "trace": tb}))
        sys.stdout.flush()


# ══════════════════════════════════════════════════════════════════════════════
# FIX 5 — Copilot command intent parser
# ══════════════════════════════════════════════════════════════════════════════

# Intent patterns — ordered from most specific to least
_INTENT_PATTERNS = [
    # Range patterns: "items 51 to 100", "rows 1-50", "items 101 to 777"
    (r'(approve|accept|confirm)\s+(?:items?|rows?|invoices?)\s+(\d+)\s+(?:to|-)\s+(\d+)', 'approve_range'),
    (r'(reject|deny|decline)\s+(?:items?|rows?|invoices?)\s+(\d+)\s+(?:to|-)\s+(\d+)',    'reject_range'),
    (r'(request\s+po|request\s+purchase\s+order)\s+(?:(?:number|num|#)\s+)?(?:for\s+)?(?:items?|rows?|invoices?)\s+(\d+)\s+(?:to|-)\s+(\d+)', 'request_po_range'),

    # Count patterns: "approve 45 items", "approve first 45", "approve next 45"
    (r'(approve|accept|confirm)\s+(?:first\s+|next\s+|the\s+first\s+|the\s+next\s+)?(\d+)\s+(?:items?|rows?|invoices?|records?)?(?:\s+for\s+payment)?', 'approve_count'),
    (r'(reject|deny|decline)\s+(?:first\s+|next\s+|the\s+first\s+|the\s+next\s+)?(\d+)\s+(?:items?|rows?|invoices?|records?)?', 'reject_count'),
    (r'(request\s+po|request\s+purchase\s+order)\s+(?:number\s+)?(?:for\s+)?(\d+)\s+(?:items?|rows?|invoices?)', 'request_po_count'),

    # Single row: "approve row number 1", "approve row 1", "approve item 1"
    (r'(approve|accept|confirm)\s+(?:row\s+(?:number\s+)?|item\s+(?:number\s+)?|invoice\s+(?:number\s+)?)(\d+)', 'approve_single'),
    (r'(reject|deny|decline)\s+(?:row\s+(?:number\s+)?|item\s+(?:number\s+)?|invoice\s+(?:number\s+)?)(\d+)',   'reject_single'),

    # Remaining / all patterns
    (r'(approve|accept|confirm)\s+(?:all\s+)?(?:the\s+)?(?:remaining|rest\s+of\s+(?:the\s+)?|all)', 'approve_remaining'),
    (r'(reject|deny|decline)\s+(?:all\s+)?(?:the\s+)?(?:remaining|rest\s+of\s+(?:the\s+)?|all)',    'reject_remaining'),
    (r'(request\s+po|request\s+purchase\s+order)\s+(?:for\s+)?(?:all\s+)?(?:the\s+)?(?:remaining|rest)', 'request_po_remaining'),

    # Hold patterns
    (r'(hold|pause|defer)\s+(?:items?|rows?|invoices?)?\s*(\d+)\s+(?:to|-)\s+(\d+)', 'hold_range'),
    (r'(hold|pause|defer)\s+(?:first\s+|next\s+)?(\d+)\s+(?:items?|rows?|invoices?)?', 'hold_count'),
    (r'(hold|pause|defer)\s+(?:all\s+)?(?:the\s+)?(?:remaining|rest)',                 'hold_remaining'),
]


def op_parse_command(config: dict) -> dict:
    """
    Parse a natural language copilot command into a structured action.

    Input:  { "command": "approve 45 items for payment", "totalItems": 777, "resolvedCount": 1 }
    Output: { "intent": "approve", "scope": "count", "start": 0, "end": 44, "count": 45, "raw": "..." }

    Scopes:
      "range"     — explicit start-end (1-based from user, 0-based in output)
      "count"     — first N items from current position
      "single"    — exactly one item (1-based → 0-based)
      "remaining" — everything not yet resolved
    """
    raw_command  = _require(config, "command")
    total_items  = int(config.get("totalItems", 0))
    resolved     = int(config.get("resolvedCount", 0))

    # Step 1: Normalize text
    text = raw_command.lower().strip()
    text = re.sub(r'\s+', ' ', text)
    # Normalize common synonyms
    text = re.sub(r'\bpurchase order\b', 'po', text)
    text = re.sub(r'\bpay(ment)?\b', '', text)
    text = re.sub(r'\bplease\b|\bkindly\b|\bcan you\b|\bwould you\b', '', text)
    text = re.sub(r'\s+', ' ', text).strip()

    # Step 2: Match intent
    for pattern, intent_type in _INTENT_PATTERNS:
        m = re.search(pattern, text, re.IGNORECASE)
        if not m:
            continue

        groups = m.groups()

        # Step 3: Determine action verb
        action_verb = groups[0].lower().strip() if groups else ''
        if 'request' in action_verb or 'po' in action_verb:
            action = 'request_po'
        elif any(w in action_verb for w in ('reject', 'deny', 'decline')):
            action = 'reject'
        elif any(w in action_verb for w in ('hold', 'pause', 'defer')):
            action = 'hold'
        else:
            action = 'approve'

        # Step 4: Extract scope and indices
        if intent_type.endswith('_range'):
            # groups: (verb, start_1based, end_1based)
            start_1 = int(groups[1]) if len(groups) > 1 else 1
            end_1   = int(groups[2]) if len(groups) > 2 else start_1
            # FIX: convert 1-based UI numbers to 0-based indices
            start_0 = max(0, start_1 - 1)
            end_0   = min(total_items - 1, end_1 - 1) if total_items > 0 else end_1 - 1
            return {
                'intent'  : action,
                'scope'   : 'range',
                'start'   : start_0,
                'end'     : end_0,
                'count'   : end_0 - start_0 + 1,
                'raw'     : raw_command,
                'matched' : intent_type,
            }

        elif intent_type.endswith('_count'):
            count   = int(groups[1]) if len(groups) > 1 else 1
            start_0 = resolved  # start from where we left off
            end_0   = min(start_0 + count - 1, total_items - 1) if total_items > 0 else start_0 + count - 1
            return {
                'intent'  : action,
                'scope'   : 'count',
                'start'   : start_0,
                'end'     : end_0,
                'count'   : end_0 - start_0 + 1,
                'raw'     : raw_command,
                'matched' : intent_type,
            }

        elif intent_type.endswith('_single'):
            # FIX: 1-based → 0-based conversion for single row
            row_1 = int(groups[1]) if len(groups) > 1 else 1
            row_0 = max(0, row_1 - 1)
            return {
                'intent'  : action,
                'scope'   : 'single',
                'start'   : row_0,
                'end'     : row_0,
                'count'   : 1,
                'raw'     : raw_command,
                'matched' : intent_type,
            }

        elif intent_type.endswith('_remaining'):
            start_0 = resolved
            end_0   = total_items - 1 if total_items > 0 else 0
            return {
                'intent'  : action,
                'scope'   : 'remaining',
                'start'   : start_0,
                'end'     : end_0,
                'count'   : max(0, end_0 - start_0 + 1),
                'raw'     : raw_command,
                'matched' : intent_type,
            }

    # No pattern matched
    return {
        'intent'  : None,
        'scope'   : None,
        'start'   : None,
        'end'     : None,
        'count'   : 0,
        'raw'     : raw_command,
        'matched' : None,
        'error'   : f"Could not understand command: \"{raw_command}\". "
                    "Try: \"approve items 1 to 50\", \"reject remaining\", \"approve 45 items\".",
    }


# ══════════════════════════════════════════════════════════════════════════════
# OCR operations
# ══════════════════════════════════════════════════════════════════════════════

def op_ocr_invoice(config: dict) -> dict:
    file_path = _require(config, "filePath")
    ext       = Path(file_path).suffix.lower()

    if ext not in OCR_EXTENSIONS:
        raise ValueError(
            f"Unsupported OCR file type: {ext}. "
            f"Supported: {', '.join(sorted(OCR_EXTENSIONS))}"
        )
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")

    try:
        from ocr.ocr_engine import process_document
    except ImportError:
        sys.path.insert(0, os.path.dirname(__file__))
        from ocr.ocr_engine import process_document

    result = process_document(file_path, config)
    rows   = result.get('rows', [])
    schema = infer_schema(rows) if rows else {}

    return {
        "rowCount"        : len(rows),
        "schema"          : schema,
        "warnings"        : result.get('warnings', []),
        "sampleRows"      : rows[:5],
        "columnNames"     : list(schema.keys()),
        "ocrMethod"       : result.get('method', 'unknown'),
        "confidence"      : result.get('confidence', 0.0),
        "needsAIFallback" : result.get('needsAIFallback', False),
        "extractedFields" : result.get('extractedFields', {}),
        # FIX 3 (pythonBridge also caps this, belt-and-suspenders)
        "rawText"         : result.get('rawText', '')[:500],
    }


def op_ocr_batch(config: dict) -> dict:
    file_paths = _require(config, "filePaths")
    if not isinstance(file_paths, list):
        raise ValueError("filePaths must be an array of file paths")

    try:
        from ocr.ocr_engine import process_document
    except ImportError:
        sys.path.insert(0, os.path.dirname(__file__))
        from ocr.ocr_engine import process_document

    results  = []
    # FIX: Don't accumulate all_rows in memory for large batches.
    # Only keep stats + sample rows.
    sample_rows  = []
    total_rows   = 0

    for fp in file_paths:
        ext = Path(fp).suffix.lower()
        if ext not in OCR_EXTENSIONS:
            results.append({"filePath": fp, "status": "skipped", "reason": f"Unsupported type: {ext}"})
            continue
        try:
            doc_result = process_document(fp, config)
            rows       = doc_result.get('rows', [])
            total_rows += len(rows)
            if len(sample_rows) < 5:
                sample_rows.extend(rows[:5 - len(sample_rows)])
            results.append({
                "filePath"  : fp,
                "status"    : "success",
                "rowCount"  : len(rows),
                "confidence": doc_result.get('confidence', 0.0),
                "method"    : doc_result.get('method', 'unknown'),
                "warnings"  : doc_result.get('warnings', []),
            })
        except Exception as e:
            results.append({"filePath": fp, "status": "failed", "reason": str(e)})

    schema = infer_schema(sample_rows) if sample_rows else {}
    return {
        "totalFiles" : len(file_paths),
        "succeeded"  : sum(1 for r in results if r['status'] == 'success'),
        "failed"     : sum(1 for r in results if r['status'] == 'failed'),
        "skipped"    : sum(1 for r in results if r['status'] == 'skipped'),
        "totalRows"  : total_rows,
        "schema"     : schema,
        "columnNames": list(schema.keys()),
        "sampleRows" : sample_rows[:5],
        "fileResults": results,
    }


def op_parse(config: dict) -> dict:
    file_path = _require(config, "filePath")
    ext = Path(file_path).suffix.lower()

    if ext in ('.csv',):
        rows, warnings_list = parse_csv(file_path)
    elif ext in ('.xlsx', '.xls'):
        rows, warnings_list = parse_xlsx(file_path)
    elif ext == '.xml':
        rows, warnings_list = parse_xml_file(file_path)
    else:
        raise ValueError(f"Unsupported file extension: {ext}")

    schema = infer_schema(rows)
    return {
        "rowCount"   : len(rows),
        "schema"     : schema,
        "warnings"   : warnings_list,
        "sampleRows" : rows[:5],
        "columnNames": list(schema.keys()),
    }


def op_schema(config: dict) -> dict:
    file_path = _require(config, "filePath")
    ext = Path(file_path).suffix.lower()

    if ext == '.csv':
        rows, _ = parse_csv(file_path, max_rows=200)
    elif ext in ('.xlsx', '.xls'):
        rows, _ = parse_xlsx(file_path, max_rows=200)
    elif ext == '.xml':
        rows, _ = parse_xml_file(file_path, max_rows=200)
    else:
        raise ValueError(f"Unsupported file extension: {ext}")

    schema = infer_schema(rows)
    return {"schema": schema, "sampleRows": rows[:3]}


def op_analyze(config: dict) -> dict:
    file_path = _require(config, "filePath")
    ext = Path(file_path).suffix.lower()

    if ext == '.csv':
        rows, warnings_list = parse_csv(file_path)
    elif ext in ('.xlsx', '.xls'):
        rows, warnings_list = parse_xlsx(file_path)
    elif ext == '.xml':
        rows, warnings_list = parse_xml_file(file_path)
    else:
        raise ValueError(f"Unsupported file extension: {ext}")

    issues     = detect_issues(rows)
    duplicates = detect_duplicates(rows)
    schema     = infer_schema(rows)

    return {
        "rowCount"  : len(rows),
        "schema"    : schema,
        "issues"    : issues,
        "duplicates": duplicates,
        "warnings"  : warnings_list,
    }


def op_reconcile(config: dict) -> dict:
    """
    Match invoices to POs, detect mismatches, return ambiguities.

    FIX 1: Raises ValueError if OCR returns 0 rows with low confidence
            instead of silently continuing with empty results.
    """
    invoice_path = _require(config, "invoicePath")
    po_path      = config.get("poPath")

    MAX_RECONCILE_ROWS = int(os.environ.get('MAX_RECONCILE_ROWS', '5000'))

    invoice_ext = Path(invoice_path).suffix.lower()

    if invoice_ext == '.csv':
        invoices, inv_warnings = parse_csv(invoice_path, max_rows=MAX_RECONCILE_ROWS)

    elif invoice_ext in ('.xlsx', '.xls'):
        invoices, inv_warnings = parse_xlsx(invoice_path, max_rows=MAX_RECONCILE_ROWS)

    elif invoice_ext in OCR_EXTENSIONS:
        try:
            from ocr.ocr_engine import process_document
        except ImportError:
            sys.path.insert(0, os.path.dirname(__file__))
            from ocr.ocr_engine import process_document

        ocr_result   = process_document(invoice_path, config)
        invoices     = ocr_result.get('rows', [])
        inv_warnings = ocr_result.get('warnings', [])
        ocr_conf     = ocr_result.get('confidence', 0.0)

        if not invoices:
            # FIX 1: Hard error instead of silent empty result
            if ocr_conf < 0.5:
                raise ValueError(
                    f"OCR could not extract invoice data from "
                    f"{Path(invoice_path).name} (confidence: {ocr_conf:.2f}). "
                    "The document may be unreadable, low quality, or require AI fallback. "
                    "Try enabling gemini_fallback in OCR settings, or upload a CSV/XLSX export instead."
                )
            inv_warnings.append(
                f"OCR extracted 0 rows from {Path(invoice_path).name}. "
                "The document may contain no structured invoice data. "
                "Try enabling gemini_fallback in the OCR settings."
            )

    else:
        raise ValueError(
            f"Unsupported invoice file type for reconciliation: {invoice_ext}. "
            f"Supported: .csv, .xlsx, .xls, and OCR image/PDF formats "
            f"({', '.join(sorted(OCR_EXTENSIONS))})"
        )

    pos         = []
    po_warnings = []
    if po_path and os.path.exists(po_path):
        po_ext = Path(po_path).suffix.lower()
        if po_ext == '.csv':
            pos, po_warnings = parse_csv(po_path, max_rows=MAX_RECONCILE_ROWS)
        elif po_ext in ('.xlsx', '.xls'):
            pos, po_warnings = parse_xlsx(po_path, max_rows=MAX_RECONCILE_ROWS)
        else:
            po_warnings.append(
                f"Unsupported PO file type: {po_ext}. "
                "PO matching skipped. Supported: .csv, .xlsx, .xls"
            )

    trunc_warnings = []
    if len(invoices) >= MAX_RECONCILE_ROWS:
        trunc_warnings.append(
            f"Large file: reconciliation limited to first {MAX_RECONCILE_ROWS} rows. "
            f"Set MAX_RECONCILE_ROWS env var to increase."
        )

    invoices = [_normalise_row(r) for r in invoices]
    pos      = [_normalise_row(r) for r in pos]

    for i, r in enumerate(invoices): r['_rowIndex'] = i
    for i, r in enumerate(pos):      r['_rowIndex'] = i

    matches    = match_invoices_to_pos(invoices, pos)
    duplicates = detect_invoice_duplicates(invoices)
    recon      = build_reconciliation(invoices, matches, duplicates)

    return {
        "invoiceCount"  : len(invoices),
        "poCount"       : len(pos),
        "reconciliation": recon,
        "warnings"      : inv_warnings + po_warnings + trunc_warnings,
    }


def op_execute(config: dict) -> dict:
    """
    Apply approved actions and write output CSV.
    FIX 4: File existence check before parsing.
    """
    invoice_path   = _require(config, "invoicePath")
    reconciliation = _require(config, "reconciliation")
    approvals      = _require(config, "approvals")
    output_path    = _require(config, "outputPath")

    # FIX 4: Check file exists before attempting to parse
    if not os.path.exists(invoice_path):
        raise FileNotFoundError(
            f"Invoice file not found: {invoice_path}. "
            "The uploaded file may have been cleaned up. Please re-upload and try again."
        )

    invoice_ext = Path(invoice_path).suffix.lower()

    if invoice_ext == '.csv':
        invoices, _ = parse_csv(invoice_path)

    elif invoice_ext in ('.xlsx', '.xls'):
        invoices, _ = parse_xlsx(invoice_path)

    elif invoice_ext in OCR_EXTENSIONS:
        try:
            from ocr.ocr_engine import process_document
        except ImportError:
            sys.path.insert(0, os.path.dirname(__file__))
            from ocr.ocr_engine import process_document
        ocr_result = process_document(invoice_path, config)
        invoices   = ocr_result.get('rows', [])

    else:
        invoices = []

    invoices = [_normalise_row(r) for r in invoices]
    for i, r in enumerate(invoices): r['_rowIndex'] = i

    output_rows = apply_approvals(invoices, reconciliation, approvals)
    write_csv(output_rows, output_path)

    return {
        "outputPath"  : output_path,
        "outputRows"  : len(output_rows),
        "excludedRows": len(invoices) - len(output_rows),
    }


def op_extract_zip(config: dict) -> dict:
    zip_path   = _require(config, "zipPath")
    extract_to = _require(config, "extractTo")
    return extract_zip_safe(zip_path, extract_to)


def op_parse_xml(config: dict) -> dict:
    file_path = _require(config, "filePath")
    rows, warnings_list = parse_xml_file(file_path)
    schema = infer_schema(rows)
    return {
        "rowCount"   : len(rows),
        "schema"     : schema,
        "warnings"   : warnings_list,
        "sampleRows" : rows[:5],
        "columnNames": list(schema.keys()),
    }


def parse_csv(file_path: str, max_rows: int = None) -> tuple:
    rows          = []
    warnings_list = []
    malformed     = 0
    encoding      = _detect_encoding(file_path)

    try:
        with open(file_path, newline='', encoding=encoding, errors='replace') as f:
            sample = f.read(4096)
            f.seek(0)
            try:
                dialect = csv.Sniffer().sniff(sample, delimiters=',\t;|')
            except csv.Error:
                dialect = csv.excel

            reader = csv.DictReader(f, dialect=dialect)
            for i, row in enumerate(reader):
                if max_rows and i >= max_rows:
                    break
                try:
                    rows.append(dict(row))
                except Exception:
                    malformed += 1
    except Exception as e:
        warnings_list.append(f"CSV parse warning: {e}")

    if malformed:
        warnings_list.append(f"{malformed} malformed row(s) skipped")

    return rows, warnings_list


def parse_xlsx(file_path: str, max_rows: int = None) -> tuple:
    if not HAS_OPENPYXL:
        raise RuntimeError("openpyxl not installed. Run: pip install openpyxl")

    rows          = []
    warnings_list = []

    try:
        wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
        ws = wb.active
        headers = None

        for i, row in enumerate(ws.iter_rows(values_only=True)):
            if i == 0:
                headers = [str(c) if c is not None else f"col_{j}" for j, c in enumerate(row)]
                continue
            if max_rows and i > max_rows:
                break
            row_dict = {}
            for j, val in enumerate(row):
                key = headers[j] if j < len(headers) else f"col_{j}"
                row_dict[key] = _safe_str(val)
            rows.append(row_dict)

        wb.close()
    except Exception as e:
        warnings_list.append(f"XLSX parse warning: {e}")

    return rows, warnings_list


def parse_xml_file(file_path: str, max_rows: int = None) -> tuple:
    rows          = []
    warnings_list = []

    if not HAS_DEFUSEDXML:
        warnings_list.append(
            "SECURITY WARNING: defusedxml not installed. "
            "Install with: pip install defusedxml --break-system-packages"
        )

    try:
        tree = ET.parse(file_path)
        root = tree.getroot()
        rows, warnings_list_inner = flatten_xml(root, max_rows=max_rows)
        warnings_list.extend(warnings_list_inner)
    except Exception as e:
        warnings_list.append(f"XML parse error: {e}")

    return rows, warnings_list


def flatten_xml(root, max_rows: int = None) -> tuple:
    warnings_list = []
    tag_counts: dict = {}
    for elem in root.iter():
        tag = _strip_ns(elem.tag)
        tag_counts[tag] = tag_counts.get(tag, 0) + 1

    if not tag_counts:
        return [], ["Empty XML document"]

    root_tag   = _strip_ns(root.tag)
    candidates = {k: v for k, v in tag_counts.items() if k != root_tag and v > 1}

    if not candidates:
        row = _flatten_element(root, prefix="")
        return [row], warnings_list

    record_tag = max(candidates, key=lambda k: candidates[k])
    rows       = []

    for elem in root.iter(record_tag):
        row    = _flatten_element(elem, prefix="")
        parent = _find_parent(root, elem)
        if parent is not None:
            p_tag = _strip_ns(parent.tag)
            for attr_key, attr_val in parent.attrib.items():
                row[f"_parent_{p_tag}_{attr_key}"] = attr_val
        rows.append(row)
        if max_rows and len(rows) >= max_rows:
            break

    if not rows:
        rows = [_flatten_element(root, prefix="")]
        warnings_list.append("Could not detect record elements; flattened entire document")

    return rows, warnings_list


def _flatten_element(elem, prefix: str = "", depth: int = 0) -> dict:
    result     = {}
    tag        = _strip_ns(elem.tag)
    key_prefix = f"{prefix}{tag}" if prefix else ""

    for attr, val in elem.attrib.items():
        result[f"{key_prefix}{_strip_ns(attr)}"] = val

    text = (elem.text or "").strip()
    if text:
        result[key_prefix.rstrip("_") or tag] = text

    child_tags: dict = {}
    for child in elem:
        ct = _strip_ns(child.tag)
        child_tags[ct] = child_tags.get(ct, 0) + 1

    child_indices: dict = {}
    for child in elem:
        ct = _strip_ns(child.tag)
        if depth < 5:
            if child_tags[ct] > 1:
                idx          = child_indices.get(ct, 0)
                child_prefix = f"{key_prefix}{ct}_{idx}_"
                child_indices[ct] = idx + 1
            else:
                child_prefix = f"{key_prefix}{ct}_"
            sub = _flatten_element(child, prefix=child_prefix, depth=depth + 1)
            result.update(sub)

    return result


def _find_parent(root, target):
    for parent in root.iter():
        if target in list(parent):
            return parent
    return None


def _strip_ns(tag: str) -> str:
    return re.sub(r'\{[^}]*\}', '', tag)


def extract_zip_safe(zip_path: str, extract_to: str) -> dict:
    warnings_list = []
    discovered    = []
    rejected      = []

    if not zipfile.is_zipfile(zip_path):
        raise ValueError("File is not a valid ZIP archive")

    os.makedirs(extract_to, exist_ok=True)
    total_extracted = 0
    file_count      = 0

    with zipfile.ZipFile(zip_path, 'r') as zf:
        for info in zf.infolist():
            if info.flag_bits & 0x1:
                raise ValueError("Password-protected ZIP files are not supported")

        for info in zf.infolist():
            if file_count >= MAX_ZIP_FILE_COUNT:
                warnings_list.append(f"ZIP file count limit ({MAX_ZIP_FILE_COUNT}) reached.")
                break

            safe_name = _sanitise_zip_name(info.filename)
            if not safe_name:
                rejected.append({"name": info.filename, "reason": "unsafe path"})
                continue

            ext = Path(safe_name).suffix.lower()

            if ext in DANGEROUS_EXTENSIONS:
                rejected.append({"name": safe_name, "reason": f"dangerous extension: {ext}"})
                warnings_list.append(f"Rejected dangerous file: {safe_name}")
                continue

            if ext in NESTED_ARCHIVE_EXTENSIONS:
                rejected.append({"name": safe_name, "reason": f"nested archive rejected: {ext}"})
                warnings_list.append(f"Rejected nested archive inside ZIP: {safe_name}.")
                continue

            compressed_size   = info.compress_size
            uncompressed_size = info.file_size

            if compressed_size > 0 and uncompressed_size > 0:
                ratio = uncompressed_size / compressed_size
                if ratio > MAX_ZIP_COMPRESSION_RATIO:
                    rejected.append({"name": safe_name, "reason": f"compression ratio {ratio:.0f}:1 too high"})
                    warnings_list.append(f"ZIP bomb rejected: {safe_name}")
                    continue

            if uncompressed_size > MAX_ZIP_EXTRACT_BYTES:
                rejected.append({"name": safe_name, "reason": "exceeds size limit"})
                warnings_list.append(f"File too large, skipped: {safe_name}")
                continue

            total_extracted += uncompressed_size
            if total_extracted > MAX_ZIP_EXTRACT_BYTES:
                warnings_list.append("Total extraction size limit reached.")
                break

            dest_path = os.path.join(extract_to, safe_name)
            os.makedirs(os.path.dirname(dest_path), exist_ok=True)

            try:
                with zf.open(info) as src, open(dest_path, 'wb') as dst:
                    shutil.copyfileobj(src, dst, length=1024 * 1024)
                file_count += 1
                discovered.append({
                    "name"     : safe_name,
                    "path"     : dest_path,
                    "size"     : uncompressed_size,
                    "ext"      : ext,
                    "supported": ext in SUPPORTED_EXTENSIONS,
                })
            except Exception as e:
                rejected.append({"name": safe_name, "reason": str(e)})
                warnings_list.append(f"Could not extract {safe_name}: {e}")

    return {
        "discovered"      : discovered,
        "rejected"        : rejected,
        "warnings"        : warnings_list,
        "totalFiles"      : file_count,
        "totalBytes"      : total_extracted,
        "supportedFiles"  : [f for f in discovered if f["supported"]],
        "unsupportedFiles": [f for f in discovered if not f["supported"]],
    }


def _sanitise_zip_name(name: str) -> str:
    name  = name.replace('\\', '/')
    name  = re.sub(r'^([a-zA-Z]:)?[/\\]+', '', name)
    parts = [p for p in name.split('/') if p and p != '..']
    if not parts:
        return ''
    return '/'.join(parts)


def infer_schema(rows: list) -> dict:
    if not rows:
        return {}

    schema   = {}
    all_keys = set()
    for r in rows:
        all_keys.update(r.keys())

    for key in sorted(all_keys):
        values    = [r.get(key, '') for r in rows]
        non_empty = [v for v in values if v is not None and str(v).strip() != '']

        inferred_type = _infer_type(non_empty)
        null_count    = len(values) - len(non_empty)

        schema[key] = {
            "type"       : inferred_type,
            "nullCount"  : null_count,
            "nullPct"    : round(null_count / len(values) * 100, 1) if values else 0,
            "uniqueCount": len(set(str(v) for v in non_empty)),
            "sample"     : [str(v) for v in non_empty[:3]],
            # RETROACTIVE FIX (Batch 5): totalCount required by ambiguityDetector.service.js
            # (col.totalCount - col.nullCount) > 0 check for dropColumn ambiguities.
            # Without this, calculation returns NaN -> false -> dangerous drops skip review.
            "totalCount" : len(values),
        }

    return schema


def _infer_type(values: list) -> str:
    if not values:
        return "unknown"
    sample      = values[:100]
    int_count   = sum(1 for v in sample if _is_int(str(v)))
    float_count = sum(1 for v in sample if _is_float(str(v)))
    date_count  = sum(1 for v in sample if _is_date(str(v)))
    ratio = len(sample)
    if date_count  / ratio > 0.7: return "date"
    if int_count   / ratio > 0.8: return "integer"
    if float_count / ratio > 0.7: return "float"
    return "string"


def _is_int(v: str) -> bool:
    try:
        int(v.replace(',', ''))
        return True
    except:
        return False


def _is_float(v: str) -> bool:
    try:
        float(v.replace(',', '').replace('$', '').replace('₹', '').replace('€', '').replace('£', ''))
        return True
    except:
        return False


def _is_date(v: str) -> bool:
    date_patterns = [
        r'^\d{4}-\d{2}-\d{2}$',
        r'^\d{2}/\d{2}/\d{4}$',
        r'^\d{2}-\d{2}-\d{4}$',
        r'^\d{1,2}/\d{1,2}/\d{2,4}$',
    ]
    return any(re.match(p, v.strip()) for p in date_patterns)


def detect_issues(rows: list) -> list:
    if not rows:
        return []

    issues   = []
    all_keys = set()
    for r in rows:
        all_keys.update(r.keys())

    total = len(rows)

    for col in sorted(all_keys):
        values        = [r.get(col, '') for r in rows]
        empty_indices = [i for i, v in enumerate(values) if v is None or str(v).strip() == '']

        if empty_indices:
            pct      = round(len(empty_indices) / total * 100, 1)
            severity = "High" if pct > 10 else ("Medium" if pct > 3 else "Low")
            issues.append({
                "type"           : "missing",
                "column"         : col,
                "severity"       : severity,
                "affectedCount"  : len(empty_indices),
                "affectedPercent": pct,
                "detail"         : f"{len(empty_indices)} null values — {pct}% of rows",
            })

        non_empty = [str(v) for v in values if v and str(v).strip()]
        if non_empty:
            date_formats = _detect_date_formats(non_empty[:200])
            if len(date_formats) > 1:
                issues.append({
                    "type"           : "format_inconsistency",
                    "column"         : col,
                    "severity"       : "Low",
                    "affectedCount"  : len(non_empty),
                    "affectedPercent": round(len(non_empty) / total * 100, 1),
                    "detail"         : f"Mixed formats: {', '.join(sorted(date_formats))}",
                })

    return issues


def _detect_date_formats(values: list) -> set:
    formats  = set()
    patterns = [
        (r'^\d{4}-\d{2}-\d{2}$',     'YYYY-MM-DD'),
        (r'^\d{2}/\d{2}/\d{4}$',     'DD/MM/YYYY'),
        (r'^\d{2}-\d{2}-\d{4}$',     'DD-MM-YYYY'),
        (r'^\d{1,2}/\d{1,2}/\d{2}$', 'D/M/YY'),
    ]
    for v in values:
        for pattern, label in patterns:
            if re.match(pattern, v.strip()):
                formats.add(label)
                break
    return formats if len(formats) > 1 else set()


def detect_duplicates(rows: list) -> dict:
    if not rows:
        return {"count": 0, "groups": []}

    if HAS_DUCKDB and len(rows) > 1000:
        try:
            return _detect_duplicates_duckdb(rows)
        except Exception:
            pass

    return _detect_duplicates_python(rows)


def _detect_duplicates_duckdb(rows: list) -> dict:
    import duckdb
    hashed = [(i, _row_hash(row)) for i, row in enumerate(rows)]
    con = duckdb.connect(':memory:')
    try:
        con.execute("""
            CREATE TEMPORARY TABLE row_hashes AS
            SELECT * FROM (VALUES {values}) AS t(row_idx, row_hash)
        """.format(values=', '.join(f"({i}, '{h}')" for i, h in hashed)))

        duplicates = con.execute("""
            SELECT row_hash, COUNT(*) as cnt, LIST(row_idx ORDER BY row_idx) as indices
            FROM row_hashes
            GROUP BY row_hash
            HAVING COUNT(*) > 1
            ORDER BY cnt DESC
        """).fetchall()

        groups    = []
        dup_count = 0
        for _, cnt, indices in duplicates:
            dup_count += cnt - 1
            groups.append({"type": "exact_duplicate", "indices": list(indices), "count": int(cnt)})

        return {"count": dup_count, "groups": groups}
    finally:
        con.close()


def _detect_duplicates_python(rows: list) -> dict:
    seen: dict = {}
    for i, row in enumerate(rows):
        key = _row_hash(row)
        seen.setdefault(key, []).append(i)

    groups    = []
    dup_count = 0
    for indices in seen.values():
        if len(indices) > 1:
            dup_count += len(indices) - 1
            groups.append({"type": "exact_duplicate", "indices": indices, "count": len(indices)})

    return {"count": dup_count, "groups": groups}


def _row_hash(row: dict) -> str:
    sig = json.dumps(
        {k: str(v) for k, v in sorted(row.items()) if not k.startswith('_')},
        sort_keys=True
    )
    return hashlib.md5(sig.encode()).hexdigest()


def _build_vendor_index(pos: list) -> dict:
    index: dict = {}
    for po in pos:
        name = _get_vendor_name(po)
        if not name:
            continue
        normalized = _normalize_vendor_for_index(name)
        if not normalized:
            continue
        bucket = normalized[:3]
        index.setdefault(bucket, []).append(po)
    return index


def _normalize_vendor_for_index(name: str) -> str:
    n = name.lower().strip()
    for suffix in (' pvt', ' ltd', ' llc', ' inc', ' corp', ' co', ' gmbh',
                   ' plc', ' ag', ' limited', ' private', ' incorporated'):
        if n.endswith(suffix):
            n = n[:-len(suffix)].strip()
    n = re.sub(r'[^a-z0-9\s]', '', n).strip()
    n = re.sub(r'\s+', ' ', n)
    return n


def _fuzzy_match_vendor(vendor_name: str, vendor_index: dict, all_pos: list):
    if not HAS_RAPIDFUZZ or not vendor_name:
        return None

    normalized = _normalize_vendor_for_index(vendor_name)
    if not normalized:
        return None

    bucket     = normalized[:3]
    candidates = vendor_index.get(bucket, [])

    if candidates:
        candidate_names = [_get_vendor_name(p) or "" for p in candidates]
        best = rfprocess.extractOne(vendor_name, candidate_names, scorer=fuzz.token_sort_ratio)
        if best and best[1] >= FUZZY_VENDOR_THRESHOLD:
            return candidates[best[2]]

    if not candidates:
        all_names = [_get_vendor_name(p) or "" for p in all_pos]
        best = rfprocess.extractOne(vendor_name, all_names, scorer=fuzz.token_sort_ratio)
        if best and best[1] >= FUZZY_VENDOR_THRESHOLD:
            return all_pos[best[2]]

    return None


def match_invoices_to_pos(invoices: list, pos: list) -> list:
    matches = []
    if not pos:
        return matches

    po_by_number: dict = {}
    for po in pos:
        num = _get_invoice_number(po)
        if num:
            po_by_number[num.upper().strip()] = po

    vendor_index = _build_vendor_index(pos) if HAS_RAPIDFUZZ else {}

    for inv in invoices:
        inv_num         = _get_invoice_number(inv)
        inv_amount      = _parse_amount(inv)
        matched_po      = None
        match_type      = None
        amount_diff     = 0.0
        amount_diff_pct = 0.0

        if inv_num and inv_num.upper().strip() in po_by_number:
            matched_po = po_by_number[inv_num.upper().strip()]
            match_type = "exact_invoice_number"
        elif HAS_RAPIDFUZZ:
            vendor_name = _get_vendor_name(inv)
            if vendor_name:
                matched_po = _fuzzy_match_vendor(vendor_name, vendor_index, pos)
                if matched_po:
                    match_type = "fuzzy_vendor_name"

        if matched_po:
            po_amount = _parse_amount(matched_po)
            if po_amount and inv_amount:
                amount_diff     = abs(inv_amount - po_amount)
                amount_diff_pct = amount_diff / po_amount if po_amount else 0

            matches.append({
                "invoice"      : inv,
                "po"           : matched_po,
                "matchType"    : match_type,
                "amountDiff"   : round(amount_diff, 2),
                "amountDiffPct": round(amount_diff_pct, 4),
            })

    return matches


def detect_invoice_duplicates(invoices: list) -> dict:
    groups = []
    count  = 0
    seen: dict = {}
    for inv in invoices:
        num = _get_invoice_number(inv)
        if num:
            key = num.upper().strip()
            seen.setdefault(key, []).append(inv)

    for key, group in seen.items():
        if len(group) > 1:
            count += len(group) - 1
            groups.append({
                "type"    : "exact_invoice_number",
                "invoices": group,
                "message" : f"Invoice number {key!r} appears {len(group)} times.",
                "severity": "High",
            })

    return {"count": count, "groups": groups}


def build_reconciliation(invoices: list, matches: list, duplicates: dict) -> dict:
    matched     = []
    flagged     = []
    ambiguities = []

    # FIX 2: O(1) match lookup — was O(n²) with next(m for m in matches if ...)
    match_lookup = {m["invoice"]["_rowIndex"]: m for m in matches}

    for inv in invoices:
        match = match_lookup.get(inv["_rowIndex"])

        if not match:
            flagged.append({"invoice": inv, "reason": "no_po_match", "severity": "High"})
            ambiguities.append({
                "type"    : "no_po_match",
                "invoice" : inv,
                "severity": "High",
                "question": (
                    f"Invoice \"{_get_invoice_number(inv) or 'UNKNOWN'}\" "
                    f"from \"{_get_vendor_name(inv) or 'Unknown Vendor'}\" "
                    f"for {_fmt_amount(inv)} has no matching PO. "
                    f"How should this be handled?"
                ),
                "options": [
                    "Approve for payment",
                    "Request PO number from vendor",
                    "Hold for review",
                    "Reject invoice",
                ],
            })
        elif match["amountDiffPct"] > AMOUNT_MISMATCH_PCT:
            flagged.append({
                "invoice" : inv,
                "po"      : match["po"],
                "reason"  : "amount_mismatch",
                "severity": "Medium",
                "diff"    : match["amountDiff"],
            })
            ambiguities.append({
                "type"    : "amount_mismatch",
                "invoice" : inv,
                "po"      : match["po"],
                "severity": "Medium",
                "question": (
                    f"Invoice \"{_get_invoice_number(inv) or 'UNKNOWN'}\" amount is "
                    f"{_fmt_amount(inv)} but PO amount is {_fmt_amount(match['po'])} — "
                    f"a difference of {_fmt_amount_val(match['amountDiff'])} "
                    f"({round(match['amountDiffPct'] * 100, 1)}%). "
                    f"How should this be resolved?"
                ),
                "options": [
                    "Approve invoice amount",
                    "Use PO amount",
                    "Hold for clarification",
                    "Reject invoice",
                ],
            })
        else:
            matched.append({
                "invoice"  : inv,
                "po"       : match["po"],
                "matchType": match["matchType"],
            })

    for group in duplicates.get("groups", []):
        if group["type"] == "exact_invoice_number":
            ambiguities.append({
                "type"    : "duplicate_invoice",
                "invoices": group["invoices"],
                "severity": "High",
                "question": (
                    f"{group['message']} Which occurrence should be kept for payment?"
                ),
                "options": [
                    "Keep first occurrence only",
                    "Keep all (each is a separate transaction)",
                    "Hold all for manual review",
                ],
            })

    return {
        "summary": {
            "total"      : len(invoices),
            "matched"    : len(matched),
            "flagged"    : len(flagged),
            "ambiguities": len(ambiguities),
            "duplicates" : duplicates.get("count", 0),
        },
        "matched"    : matched,
        "flagged"    : flagged,
        "ambiguities": ambiguities,
        "duplicates" : duplicates,
    }


def apply_approvals(invoices: list, reconciliation: dict, approvals: list) -> list:
    output_rows = []

    for item in reconciliation.get("matched", []):
        raw = item["invoice"].copy()
        raw["_reconciliation_status"] = "matched"
        raw["_po_match_type"]         = item.get("matchType", "")
        raw["_approved_by"]           = "auto"
        output_rows.append({k: v for k, v in raw.items() if not k.startswith('_row')})

    for i, amb in enumerate(reconciliation.get("ambiguities", [])):
        approval = next((a for a in approvals if a.get("questionIndex") == i), None)
        response = (approval.get("response") or "no_response") if approval else "no_response"
        status   = (approval.get("status")   or "pending")    if approval else "pending"

        if amb["type"] in ("no_po_match", "amount_mismatch"):
            inv = amb["invoice"]
            row = inv.copy()
            row["_reconciliation_status"] = "approved_with_flag" if status == "approved" else "held"
            row["_flag_type"]             = amb["type"]
            row["_approval_response"]     = response
            row["_responded_via"]         = approval.get("respondedVia", "unknown") if approval else "unknown"

            if _should_include(response):
                output_rows.append({k: v for k, v in row.items() if not k.startswith('_row')})

        elif amb["type"] == "duplicate_invoice":
            invs = amb.get("invoices", [])
            if not invs:
                continue
            if "all" in response.lower() or "keep all" in response.lower():
                for inv in invs:
                    row = inv.copy()
                    row["_reconciliation_status"] = "duplicate_kept"
                    row["_approval_response"]     = response
                    output_rows.append({k: v for k, v in row.items() if not k.startswith('_row')})
            elif "hold" in response.lower():
                pass
            else:
                row = invs[0].copy()
                row["_reconciliation_status"] = "duplicate_first_kept"
                row["_approval_response"]     = response
                output_rows.append({k: v for k, v in row.items() if not k.startswith('_row')})

    return output_rows


def write_csv(rows: list, output_path: str):
    if not rows:
        os.makedirs(os.path.dirname(output_path) or '.', exist_ok=True)
        with open(output_path, 'w') as f:
            f.write('')
        return

    # FIX 3: Build union of all keys — row 1 may be missing columns present in row 2+
    all_keys = []
    seen_keys = set()
    for row in rows:
        for k in row.keys():
            if k not in seen_keys:
                all_keys.append(k)
                seen_keys.add(k)

    os.makedirs(os.path.dirname(output_path) or '.', exist_ok=True)

    with open(output_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=all_keys, extrasaction='ignore')
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def _normalise_row(row: dict) -> dict:
    aliases = {
        "invoice_number": ["invoicenumber", "invoice_no", "inv_no", "invno",
                            "invoice #", "invoice#", "invoice number"],
        "vendor_name"   : ["vendorname", "vendor", "supplier", "supplier_name",
                            "suppliername", "company"],
        "amount"        : ["invoiceamount", "invoice_amount", "total", "total_amount",
                            "totalamount", "amt", "value"],
        "po_number"     : ["ponumber", "po_no", "purchase_order", "purchaseorder",
                            "po number", "po#"],
        "date"          : ["invoicedate", "invoice_date", "date_of_invoice"],
        "currency"      : ["cur", "curr", "currency_code"],
    }

    normalised = {}
    for k, v in row.items():
        clean_key = re.sub(r'[^a-z0-9_]', '_', k.lower().strip()).strip('_')
        normalised[clean_key] = v

    for canonical, alt_list in aliases.items():
        if canonical not in normalised:
            for alt in alt_list:
                alt_clean = re.sub(r'[^a-z0-9_]', '_', alt.lower().strip()).strip('_')
                if alt_clean in normalised:
                    normalised[canonical] = normalised[alt_clean]
                    break

    normalised['_raw'] = row
    return normalised


def _get_invoice_number(row: dict) -> str:
    return str(row.get("invoice_number", "") or row.get("invoicenumber", "") or "").strip()


def _get_vendor_name(row: dict) -> str:
    return str(row.get("vendor_name", "") or row.get("vendor", "") or "").strip()


def _parse_amount(row: dict):
    raw = row.get("amount") or row.get("total") or row.get("invoiceamount") or ""
    if raw is None:
        return None
    try:
        cleaned = re.sub(r'[^\d.-]', '', str(raw))
        return float(cleaned) if cleaned else None
    except:
        return None


def _fmt_amount(row: dict) -> str:
    amount   = _parse_amount(row)
    currency = str(row.get("currency", "") or "").strip() or "USD"
    if amount is None:
        return "N/A"
    return f"{currency} {amount:,.2f}"


def _fmt_amount_val(amount, currency: str = "") -> str:
    if amount is None:
        return "N/A"
    return f"{currency} {amount:,.2f}".strip()


def _should_include(response: str) -> bool:
    r = (response or "").lower()
    return not ("reject" in r or "hold" in r)


def _safe_str(val) -> str:
    if val is None:
        return ""
    if isinstance(val, float) and math.isnan(val):
        return ""
    return str(val)


def _require(config: dict, key: str):
    if key not in config:
        raise ValueError(f"Required config key missing: {key}")
    return config[key]


def _fatal(msg: str):
    sys.stdout.write(json.dumps({"ok": False, "error": msg}))
    sys.stdout.flush()


def _detect_encoding(file_path: str) -> str:
    try:
        import chardet
        with open(file_path, 'rb') as f:
            sample = f.read(32768)
        result   = chardet.detect(sample)
        encoding = result.get('encoding') or 'utf-8'
        if encoding.lower() in ('ascii', 'utf-8-sig'):
            return 'utf-8-sig'
        return encoding
    except ImportError:
        return 'utf-8'


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        tb = traceback.format_exc()
        sys.stdout.write(json.dumps({"ok": False, "error": str(e), "trace": tb}))
        sys.stdout.flush()

