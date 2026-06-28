"""
backend/python/ocr/ocr_engine.py

CHANGES FROM V2 (this version — V3):

  CRITICAL FIX — WINDOWS MULTIPROCESSING HANG
    Previous: _run_with_timeout() tried multiprocessing.Process first.
    On Windows, multiprocessing requires the 'spawn' start method and the
    if __name__ == '__main__' guard. When called from an imported module
    (which is always the case here — data_engine.py imports ocr_engine.py),
    each spawned process re-imports the module and tries to spawn another
    process, causing an infinite spawn loop that never resolves.
    Result: OCR hung for the full 320s timeout on EVERY image/PDF on Windows.

    Fix: Detect the OS at module load time. On Windows, always use the
    threading-based timeout (_run_with_timeout_thread). On Linux/Mac,
    use multiprocessing as before (true kill on timeout).

    This is why your JPG and PNG invoices — perfectly clear, readable images
    that EasyOCR/pytesseract can process in 2-3 seconds — were timing out
    after 320 seconds every single time.

  All V2 fixes preserved exactly:
    - FIX 1: Confidence weighted average (parser 70% + OCR 30%)
    - FIX 2: Parse FIRST, score AFTER
    - FIX 3: Always return partial data, never discard
    - FIX 4: Level 2 condition: HAS_PDF2IMAGE only
    - FIX 5: _text_to_pseudo_rows() semantic rows
    - FIX 6: _run_with_timeout_thread fallback
    - MAX_OCR_PAGES, MAX_OCR_FILE_BYTES, per-level timeouts
"""

import os
import sys
import json
import traceback
import warnings
import threading
import multiprocessing
warnings.filterwarnings("ignore")

# ── WINDOWS FIX: detect platform at import time ───────────────────────────────
# On Windows, multiprocessing.Process cannot be safely used from an imported
# module due to the 'spawn' start method requirement. Always use threading on
# Windows. On Linux/Mac, use multiprocessing for true process kill on timeout.
_IS_WINDOWS = sys.platform.startswith('win')

# ── Limits ────────────────────────────────────────────────────────────────────
MAX_OCR_PAGES      = int(os.environ.get('MAX_OCR_PAGES',     '50'))
MAX_OCR_FILE_BYTES = int(os.environ.get('MAX_OCR_FILE_MB',   '200')) * 1024 * 1024
OCR_PAGE_TIMEOUT   = int(os.environ.get('OCR_PAGE_TIMEOUT',  '60'))
OCR_LEVEL1_TIMEOUT = int(os.environ.get('OCR_LEVEL1_TIMEOUT','120'))
OCR_LEVEL2_TIMEOUT = int(os.environ.get('OCR_LEVEL2_TIMEOUT','180'))

# Confidence blend weights
_PARSER_CONF_WEIGHT = 0.70
_OCR_CONF_WEIGHT    = 0.30

# ── Optional imports ──────────────────────────────────────────────────────────
try:
    import pdfplumber
    HAS_PDFPLUMBER = True
except ImportError:
    HAS_PDFPLUMBER = False

try:
    import camelot
    HAS_CAMELOT = True
except ImportError:
    HAS_CAMELOT = False

try:
    from pdf2image import convert_from_path
    HAS_PDF2IMAGE = True
except ImportError:
    HAS_PDF2IMAGE = False

try:
    import pytesseract
    HAS_PYTESSERACT = True
except ImportError:
    HAS_PYTESSERACT = False

try:
    import cv2
    HAS_OPENCV = True
except ImportError:
    HAS_OPENCV = False

try:
    from PIL import Image
    HAS_PILLOW = True
except ImportError:
    HAS_PILLOW = False

try:
    import easyocr
    HAS_EASYOCR   = True
    _easyocr_reader = None
except ImportError:
    HAS_EASYOCR = False

import re

from .pdf_table_extractor import extract_pdf_tables
from .scanned_ocr         import ocr_scanned_document
from .invoice_parser      import parse_invoice_fields
from .confidence          import score_confidence, should_use_ai_fallback, CONFIDENCE_AI_THRESHOLD


def process_document(file_path: str, config: dict) -> dict:
    """
    Main entry point. Routes document through the pipeline.
    """
    warnings_list = []
    ext           = os.path.splitext(file_path)[1].lower()
    is_pdf        = ext == '.pdf'
    is_image      = ext in ('.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.webp')

    if not os.path.exists(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")

    file_size = os.path.getsize(file_path)
    if file_size > MAX_OCR_FILE_BYTES:
        size_mb  = file_size / (1024 * 1024)
        limit_mb = MAX_OCR_FILE_BYTES / (1024 * 1024)
        raise ValueError(
            f"File too large for OCR: {size_mb:.1f} MB. "
            f"Maximum: {limit_mb:.0f} MB. "
            "Please split the document into smaller files."
        )

    if file_size > 50 * 1024 * 1024:
        warnings_list.append(
            f"Large file ({file_size / (1024*1024):.1f} MB) — OCR may take several minutes."
        )

    best_rows    = []
    best_text    = ''
    best_fields  = {}
    best_conf    = 0.0
    best_method  = 'failed'

    # ── LEVEL 1: Digital PDF table extraction ─────────────────────────────────
    if is_pdf and (HAS_PDFPLUMBER or HAS_CAMELOT):
        result = _run_with_timeout(
            fn      = lambda: extract_pdf_tables(file_path, max_pages=MAX_OCR_PAGES),
            timeout = OCR_LEVEL1_TIMEOUT,
            label   = "Level 1 (PDF table extraction)",
        )

        if result is None:
            warnings_list.append(f"Level 1 timed out after {OCR_LEVEL1_TIMEOUT}s — trying Level 2")
        elif isinstance(result, Exception):
            warnings_list.append(f"Level 1 failed: {result}")
        elif result.get('rows') or result.get('raw_text'):
            raw_rows = result.get('rows', [])
            raw_text = result.get('raw_text', '')

            if raw_rows or raw_text:
                parsed      = parse_invoice_fields(raw_rows, raw_text)
                parser_conf = score_confidence(parsed, raw_rows)
                ocr_conf    = result.get('confidence', 0.8)
                confidence  = round(parser_conf * _PARSER_CONF_WEIGHT + ocr_conf * _OCR_CONF_WEIGHT, 3)

                if confidence > best_conf or (parsed['rows'] and not best_rows):
                    best_rows   = parsed['rows']
                    best_text   = raw_text
                    best_fields = parsed['fields']
                    best_conf   = confidence
                    best_method = 'pdf_table_extraction'

                if confidence >= CONFIDENCE_AI_THRESHOLD:
                    return _build_result(
                        rows=parsed['rows'], text=raw_text, conf=confidence,
                        method='pdf_table_extraction', fields=parsed['fields'],
                        warnings=warnings_list + result.get('warnings', []),
                        needs_ai=False,
                    )

            warnings_list.append(
                f"Level 1 confidence too low ({best_conf:.2f}), trying Level 2"
            )

    # ── LEVEL 2: Scanned OCR ──────────────────────────────────────────────────
    if (is_pdf and HAS_PDF2IMAGE) or is_image:
        if HAS_PYTESSERACT or HAS_EASYOCR:
            result = _run_with_timeout(
                fn      = lambda: ocr_scanned_document(file_path, max_pages=MAX_OCR_PAGES),
                timeout = OCR_LEVEL2_TIMEOUT,
                label   = "Level 2 (scanned OCR)",
            )

            if result is None:
                warnings_list.append(f"Level 2 timed out after {OCR_LEVEL2_TIMEOUT}s")
            elif isinstance(result, Exception):
                warnings_list.append(f"Level 2 failed: {result}")
            elif result.get('text') or result.get('pages', 0) > 0:
                pseudo_rows = _text_to_pseudo_rows(result.get('text', ''))
                parsed      = parse_invoice_fields(pseudo_rows, result.get('text', ''))
                parser_conf = score_confidence(parsed, pseudo_rows)
                ocr_conf    = result.get('confidence', 0.8)
                confidence  = round(parser_conf * _PARSER_CONF_WEIGHT + ocr_conf * _OCR_CONF_WEIGHT, 3)

                if confidence > best_conf or (parsed['rows'] and not best_rows):
                    best_rows   = parsed['rows']
                    best_text   = result.get('text', '')
                    best_fields = parsed['fields']
                    best_conf   = confidence
                    best_method = 'scanned_ocr'

                if confidence >= CONFIDENCE_AI_THRESHOLD:
                    return _build_result(
                        rows=parsed['rows'], text=result.get('text', ''),
                        conf=confidence, method='scanned_ocr',
                        fields=parsed['fields'],
                        warnings=warnings_list + result.get('warnings', []),
                        needs_ai=False,
                    )

                warnings_list.append(f"Level 2 confidence too low ({confidence:.2f})")

    # ── LEVEL 3: AI fallback decision ─────────────────────────────────────────
    allow_ai = config.get('gemini_fallback', False)
    needs_ai = allow_ai and should_use_ai_fallback(best_conf, best_fields, config)

    if needs_ai:
        return _build_result(
            rows=[], text=best_text, conf=0.0,
            method='needs_ai_fallback', fields=best_fields,
            warnings=warnings_list, needs_ai=True,
        )

    # Always return best partial result — never discard
    if best_rows or best_fields:
        warnings_list.append(
            f"OCR confidence below threshold ({best_conf:.2f}). "
            "Results may be incomplete. "
            "Enable gemini_fallback for better accuracy on complex documents."
        )
        return _build_result(
            rows=best_rows, text=best_text, conf=best_conf,
            method=best_method or 'partial', fields=best_fields,
            warnings=warnings_list, needs_ai=False,
        )

    warnings_list.append(
        "OCR could not extract any data from this document. "
        "Try a higher quality scan, or enable gemini_fallback."
    )
    return _build_result(
        rows=[], text='', conf=0.0,
        method='failed', fields={},
        warnings=warnings_list, needs_ai=False,
    )


def _build_result(rows, text, conf, method, fields, warnings, needs_ai) -> dict:
    return {
        'rows'           : rows,
        'rawText'        : text[:500] if text else '',
        'confidence'     : conf,
        'method'         : method,
        'warnings'       : warnings,
        'needsAIFallback': needs_ai,
        'extractedFields': fields,
    }


def _run_with_timeout(fn, timeout: int, label: str):
    """
    Run fn() with a hard timeout.

    WINDOWS FIX: On Windows, always use threading (_run_with_timeout_thread).
    Multiprocessing on Windows requires the 'spawn' start method and the
    if __name__ == '__main__' guard. When called from an imported module
    (as is always the case here), spawning a new process re-imports this
    module in the child, which tries to spawn another process, causing
    an infinite recursive spawn loop that hangs for the entire timeout period.

    On Linux/Mac: use multiprocessing for true kill on timeout (preferred).
    On Windows: use threading (cannot truly kill, but does not hang).
    """
    if _IS_WINDOWS:
        # Always use threading on Windows — multiprocessing hangs here
        return _run_with_timeout_thread(fn, timeout, label)
    else:
        # Use multiprocessing on Linux/Mac — true kill on timeout
        try:
            return _run_with_timeout_process(fn, timeout, label)
        except Exception:
            return _run_with_timeout_thread(fn, timeout, label)


def _run_with_timeout_process(fn, timeout: int, label: str):
    """Multiprocessing-based timeout — Linux/Mac only. True kill on timeout."""
    result_queue = multiprocessing.Queue()
    error_queue  = multiprocessing.Queue()

    def target():
        try:
            result_queue.put(fn())
        except Exception as e:
            error_queue.put(e)

    proc = multiprocessing.Process(target=target, daemon=True)
    proc.start()
    proc.join(timeout=timeout)

    if proc.is_alive():
        proc.terminate()
        proc.join(timeout=5)
        if proc.is_alive():
            proc.kill()
            proc.join(timeout=2)
        return None  # timeout

    if not error_queue.empty():
        return error_queue.get()

    if not result_queue.empty():
        return result_queue.get()

    return None


def _run_with_timeout_thread(fn, timeout: int, label: str):
    """Thread-based timeout — used on Windows and as fallback."""
    result_holder = [None]
    error_holder  = [None]
    done_event    = threading.Event()

    def target():
        try:
            result_holder[0] = fn()
        except Exception as e:
            error_holder[0] = e
        finally:
            done_event.set()

    t = threading.Thread(target=target, daemon=True)
    t.start()
    finished = done_event.wait(timeout=timeout)

    if not finished:
        return None  # timeout — thread eventually dies with the process

    if error_holder[0] is not None:
        return error_holder[0]

    return result_holder[0]


def _text_to_pseudo_rows(text: str) -> list:
    """
    Convert flat OCR text into pseudo-rows for the invoice parser.
    Each line is scanned for key-value patterns and stored under
    field names the parser recognizes.
    """
    lines = [l.strip() for l in text.split('\n') if l.strip()]
    rows  = []

    _KV_PATTERNS = [
        (r'invoice\s*(?:no|num|number|#|id|ref)[\s:\.]+(.+)', 'invoice_number'),
        (r'vendor|supplier|from|billed\s*by[\s:]+(.+)',        'vendor_name'),
        (r'(?:grand\s+total|total\s+amount\s+due|amount\s+due|balance\s+due)[\s:$£€₹]+(.+)', 'amount'),
        (r'total[\s:$£€₹]+(.+)',                               'amount_raw'),
        (r'(?:p\.?o\.?|purchase\s*order)[\s#:\.]+(.+)',        'po_number'),
        (r'date[\s:]+(.+)',                                     'date'),
    ]

    for i, line in enumerate(lines):
        row = {'raw_line': line, 'line_index': i}

        for pattern, field_name in _KV_PATTERNS:
            m = re.search(pattern, line, re.IGNORECASE)
            if m:
                val = m.group(1).strip() if m.lastindex >= 1 else ''
                if val:
                    if field_name == 'amount_raw' and 'amount' not in row:
                        row['amount'] = val
                    elif field_name != 'amount_raw':
                        row[field_name] = val
                break

        rows.append(row)

    return rows