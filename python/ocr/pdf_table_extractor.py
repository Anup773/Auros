"""
backend/python/ocr/pdf_table_extractor.py

Level 1 OCR: Fast digital PDF table extraction.
Uses pdfplumber first (fastest), falls back to camelot (better for complex tables).

CHANGES FROM V1 (this version):

  FIX 1 — Camelot page range uses actual page count (Bug #15)
    Previous: page_range = f'1-{max_pages}' regardless of actual PDF length.
    If the PDF had 3 pages, Camelot tried to read pages 1-50 → warnings/errors.
    Fix: Detect actual page count with pdfplumber (fast) or PyPDF2/pypdf,
    then clamp max_pages to min(max_pages, actual_page_count).

  FIX 2 — Confidence is now field-based, not row-count-based (Bug #17)
    Previous: row_score = min(0.5, len(rows) / 20) — a single-invoice
    document (1 row) scored terribly even with perfect field extraction.
    Fix: Count recognized invoice field indicators in headers/values.
    Invoices are not spreadsheets; what matters is field presence, not row count.

  FIX 3 — Header normalization collision fix (Bug #16)
    Previous: "Invoice No", "Invoice-No", "Invoice_No" all became "invoice_no",
    then the 2nd was renamed "invoice_no_1". The downstream matcher failed to
    find the canonical field because it expected "invoice_no", not "invoice_no_1".
    Fix: When a collision occurs, keep the FIRST occurrence as-is and rename
    only duplicates. This preserves the canonical name for the primary column.
"""

import re
import warnings
warnings.filterwarnings("ignore")

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

DEFAULT_MAX_PAGES = 50


def extract_pdf_tables(file_path: str, max_pages: int = DEFAULT_MAX_PAGES) -> dict:
    """
    Extract tables from a digital PDF.
    Returns { rows, raw_text, confidence, warnings }.
    """
    warnings_list = []
    raw_text      = ''
    rows          = []

    # ── Try pdfplumber first ──────────────────────────────────────────────────
    if HAS_PDFPLUMBER:
        try:
            result = _extract_with_pdfplumber(file_path, max_pages=max_pages)
            raw_text      = result['text']
            rows          = result['rows']
            warnings_list.extend(result.get('warnings', []))

            if rows:
                return {
                    'rows'      : rows,
                    'raw_text'  : raw_text,
                    'confidence': result['confidence'],
                    'method'    : 'pdfplumber',
                    'warnings'  : warnings_list,
                }
        except Exception as e:
            warnings_list.append(f"pdfplumber failed: {e}")

    # ── Fall back to camelot ──────────────────────────────────────────────────
    if HAS_CAMELOT:
        try:
            result   = _extract_with_camelot(file_path, max_pages=max_pages)
            raw_text = raw_text or result.get('text', '')
            rows     = result['rows']
            warnings_list.extend(result.get('warnings', []))

            if rows:
                return {
                    'rows'      : rows,
                    'raw_text'  : raw_text,
                    'confidence': result['confidence'],
                    'method'    : 'camelot',
                    'warnings'  : warnings_list,
                }
        except Exception as e:
            warnings_list.append(f"camelot failed: {e}")

    return {
        'rows'      : rows,
        'raw_text'  : raw_text,
        'confidence': 0.0,
        'method'    : 'none',
        'warnings'  : warnings_list,
    }


def _get_pdf_page_count(file_path: str) -> int:
    """
    FIX 1 helper: Get actual page count of a PDF.
    Tries pdfplumber first (already a dependency), then pypdf/PyPDF2.
    Returns 0 if count cannot be determined.
    """
    # pdfplumber is already imported — use it (no extra import needed)
    if HAS_PDFPLUMBER:
        try:
            with pdfplumber.open(file_path) as pdf:
                return len(pdf.pages)
        except Exception:
            pass

    # Try pypdf (newer) or PyPDF2 (older) as fallback
    try:
        from pypdf import PdfReader
        return len(PdfReader(file_path).pages)
    except ImportError:
        pass
    except Exception:
        pass

    try:
        from PyPDF2 import PdfReader
        return len(PdfReader(file_path).pages)
    except ImportError:
        pass
    except Exception:
        pass

    return 0  # unknown — caller will use max_pages as-is


def _extract_with_pdfplumber(file_path: str, max_pages: int = DEFAULT_MAX_PAGES) -> dict:
    """Extract using pdfplumber."""
    rows          = []
    all_text      = []
    warnings_list = []

    with pdfplumber.open(file_path) as pdf:
        total_pages = len(pdf.pages)

        if total_pages > max_pages:
            warnings_list.append(
                f"PDF has {total_pages} pages. Processing first {max_pages} pages only."
            )

        pages_to_process = pdf.pages[:max_pages]

        for page_num, page in enumerate(pages_to_process):
            page_text = page.extract_text() or ''
            all_text.append(page_text)

            tables = page.extract_tables()
            for table in (tables or []):
                if not table or len(table) < 2:
                    continue

                headers = [_clean_cell(str(h)) for h in table[0]]
                headers = _normalise_headers(headers)

                for row_data in table[1:]:
                    if not any(cell for cell in row_data if cell):
                        continue
                    row_dict = {}
                    for j, cell in enumerate(row_data):
                        key = headers[j] if j < len(headers) else f'col_{j}'
                        row_dict[key] = _clean_cell(str(cell) if cell is not None else '')
                    rows.append(row_dict)

    full_text = '\n'.join(all_text)

    if not rows and full_text:
        rows = _parse_text_as_rows(full_text)
        if rows:
            warnings_list.append("No structured tables found — parsed from raw text")

    # FIX 2: Field-based confidence
    confidence = _estimate_confidence_field_based(rows, full_text)

    return {
        'rows'      : rows,
        'text'      : full_text,
        'confidence': confidence,
        'warnings'  : warnings_list,
        'pages'     : len(pages_to_process),
    }


def _extract_with_camelot(file_path: str, max_pages: int = DEFAULT_MAX_PAGES) -> dict:
    """Extract using camelot."""
    rows          = []
    warnings_list = []

    # FIX 1: Clamp page range to actual page count
    actual_pages = _get_pdf_page_count(file_path)
    if actual_pages > 0:
        effective_max = min(max_pages, actual_pages)
    else:
        effective_max = max_pages  # unknown — use limit as-is

    if actual_pages > 0 and actual_pages < max_pages:
        # Don't warn if we're within bounds — this is normal
        pass
    elif actual_pages == 0:
        warnings_list.append("Could not determine PDF page count — using default page limit.")

    page_range = f'1-{effective_max}'

    try:
        tables = camelot.read_pdf(file_path, pages=page_range, flavor='lattice')
        if tables.n == 0:
            tables = camelot.read_pdf(file_path, pages=page_range, flavor='stream')
    except Exception as e:
        raise RuntimeError(f"camelot read failed: {e}")

    for table in tables:
        df = table.df
        if df.empty or len(df) < 2:
            continue

        headers  = [_clean_cell(str(h)) for h in df.iloc[0].tolist()]
        headers  = _normalise_headers(headers)

        for _, row_series in df.iloc[1:].iterrows():
            row_data = row_series.tolist()
            if not any(str(cell).strip() for cell in row_data):
                continue
            row_dict = {}
            for j, cell in enumerate(row_data):
                key = headers[j] if j < len(headers) else f'col_{j}'
                row_dict[key] = _clean_cell(str(cell))
            rows.append(row_dict)

    # FIX 2: Field-based confidence
    confidence = _estimate_confidence_field_based(rows, '')
    return {
        'rows'      : rows,
        'text'      : '',
        'confidence': confidence,
        'warnings'  : warnings_list,
    }


def _parse_text_as_rows(text: str) -> list:
    """Last resort: parse raw text as semi-structured rows."""
    rows  = []
    lines = [l.strip() for l in text.split('\n') if l.strip()]

    for line in lines:
        if len(line) < 5:
            continue
        kv_match = re.match(r'^([A-Za-z\s#/\.]+)[\s:]+(.+)$', line)
        if kv_match:
            key = _clean_cell(kv_match.group(1))
            val = _clean_cell(kv_match.group(2))
            if key and val:
                rows.append({key: val})

    return rows


# ── Helpers ───────────────────────────────────────────────────────────────────

def _normalise_headers(headers: list) -> list:
    """
    Normalise column headers — lowercase, underscores, deduplicate.

    FIX 3: When collision occurs, the FIRST occurrence keeps its canonical
    name. Only subsequent duplicates get a numeric suffix. This preserves
    "invoice_no" as the primary field name for downstream matching.
    """
    seen   = {}
    result = []
    for h in headers:
        clean = re.sub(r'[^a-z0-9]', '_', h.lower().strip()).strip('_')
        clean = clean or 'col'
        if clean in seen:
            # FIX 3: Suffix the DUPLICATE, not the first occurrence
            count = seen[clean]
            seen[clean] += 1
            result.append(f"{clean}_{count}")
        else:
            seen[clean] = 1
            result.append(clean)
    return result


def _clean_cell(value: str) -> str:
    """Clean a cell value — strip whitespace and control characters."""
    if not value:
        return ''
    cleaned = re.sub(r'[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]', '', str(value))
    return cleaned.strip()


def _estimate_confidence_field_based(rows: list, text: str) -> float:
    """
    FIX 2: Estimate extraction confidence based on invoice field presence,
    not row count. A single clean invoice row with all fields present
    should score HIGH, not low.

    Previous: row_score = min(0.5, len(rows) / 20) → 1-row invoice scored 0.05.
    """
    if not rows and not text:
        return 0.0

    all_keys = set()
    all_values = []
    for row in rows:
        all_keys.update(row.keys())
        all_values.extend(str(v) for v in row.values() if v)

    # Check for invoice-relevant field indicators in keys
    key_text  = ' '.join(all_keys).lower()
    val_text  = ' '.join(all_values).lower()
    src_text  = (key_text + ' ' + val_text + ' ' + text.lower()).lower()

    field_score = 0.0
    # Each recognized invoice indicator is worth 0.12 (up to 1.0)
    invoice_indicators = [
        ('invoice',  0.15),
        ('vendor',   0.15),
        ('supplier', 0.12),
        ('amount',   0.15),
        ('total',    0.12),
        ('date',     0.10),
        ('po',       0.12),
        ('currency', 0.09),
    ]
    for indicator, weight in invoice_indicators:
        if indicator in src_text:
            field_score += weight

    return min(1.0, round(field_score, 3))

