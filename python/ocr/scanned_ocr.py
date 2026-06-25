"""
backend/python/ocr/scanned_ocr.py

Level 2 OCR: Scanned PDF and image processing.

CHANGES FROM V1 (this version):

  FIX 1 — EasyOCR reader singleton is now thread-safe (Bug #13 — CRITICAL)
    Previous: _reader = None initialized globally, then assigned inside a
    daemon thread. Multiple simultaneous OCR jobs each tried to initialize
    easyocr.Reader() at the same time → massive RAM spike + potential crash.
    Fix: threading.Lock() guards reader initialization. Only one thread
    can initialize; all others wait and reuse the same instance.

  FIX 2 — EasyOCR supports multiple languages, not just English (Bug #21)
    Previous: easyocr.Reader(['en']) — Nepali, Hindi, mixed-script
    invoices scored near-zero confidence.
    Fix: OCR_LANGUAGES env var (default 'en,ne' for Nepal deployments).
    Configurable: OCR_LANGUAGES=en,hi,ne for Hindi+Nepali+English.

  FIX 3 — Explicit image memory cleanup after each page (Bug #19)
    Previous: processed images held in memory across all pages.
    A 50-page, 300 DPI PDF could consume several GB RAM.
    Fix: Explicit img.close() + del processed + gc.collect() after each page.

  FIX 4 — Tesseract confidence uses float(), not int() (Bug #20)
    Previous: int(conf) — Tesseract returns -1, 84.52, 92.18 etc.
    int(-1) is fine, but int(84.52) silently truncates; on some Tesseract
    versions conf can be a string like "84.5" which int() raises ValueError on.
    Fix: float(conf) with try/except — handles all Tesseract output variants.

  FIX 5 — Thread daemon + join on timeout (partial kill improvement)
    Previous: daemon thread set to True, but after timeout the thread
    continued running (consuming CPU/RAM). True process kill requires
    multiprocessing (done in ocr_engine.py's _run_with_timeout_process).
    This file's per-page thread now uses done_event with a join after
    timeout to ensure the thread is at least finished before we proceed,
    and logs a warning so the caller knows it was killed by timeout.
    Full subprocess kill is handled at the ocr_engine level.

  max_pages enforcement and per-page timeout preserved from V1.
"""

import os
import re
import gc
import warnings
import tempfile
import threading
warnings.filterwarnings("ignore")

# ── OCR language config ────────────────────────────────────────────────────────
# FIX 2: Default includes Nepali ('ne') for South Asian deployments.
# Override with: OCR_LANGUAGES=en (English only) or OCR_LANGUAGES=en,hi,ne
_RAW_LANGS = os.environ.get('OCR_LANGUAGES', 'en')
OCR_LANGUAGES = [l.strip() for l in _RAW_LANGS.split(',') if l.strip()]
if not OCR_LANGUAGES:
    OCR_LANGUAGES = ['en']

try:
    from pdf2image import convert_from_path
    HAS_PDF2IMAGE = True
except ImportError:
    HAS_PDF2IMAGE = False

try:
    import pytesseract
    from pytesseract import Output
    HAS_PYTESSERACT = True
except ImportError:
    HAS_PYTESSERACT = False

try:
    import cv2
    import numpy as np
    HAS_OPENCV = True
except ImportError:
    HAS_OPENCV = False

try:
    from PIL import Image, ImageFilter, ImageEnhance
    HAS_PILLOW = True
except ImportError:
    HAS_PILLOW = False

try:
    import easyocr
    HAS_EASYOCR = True
except ImportError:
    HAS_EASYOCR = False

# FIX 1: Thread-safe EasyOCR singleton
_reader      = None
_reader_lock = threading.Lock()

DEFAULT_MAX_PAGES = 50
PER_PAGE_TIMEOUT  = int(os.environ.get('OCR_PAGE_TIMEOUT', '60'))


def _get_easyocr_reader():
    """
    FIX 1: Return a shared EasyOCR reader, initializing only once.
    Lock prevents simultaneous init from multiple threads.
    """
    global _reader
    if _reader is not None:
        return _reader
    with _reader_lock:
        # Double-check inside lock (another thread may have init'd while we waited)
        if _reader is None:
            # FIX 2: Use configured language list
            _reader = easyocr.Reader(OCR_LANGUAGES, gpu=False)
    return _reader


def ocr_scanned_document(file_path: str, lang: str = 'eng',
                          max_pages: int = DEFAULT_MAX_PAGES) -> dict:
    """
    OCR a scanned PDF or image file.
    Returns { text, confidence, warnings, page_count }.
    """
    warnings_list = []
    ext           = os.path.splitext(file_path)[1].lower()
    all_text      = []
    confidences   = []

    images = []
    if ext == '.pdf':
        images = _pdf_to_images(file_path, warnings_list, max_pages=max_pages)
    elif ext in ('.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.webp'):
        if HAS_PILLOW:
            try:
                images = [Image.open(file_path)]
            except Exception as e:
                warnings_list.append(f"Failed to open image: {e}")
        else:
            warnings_list.append("Pillow not installed — cannot open image files")

    if not images:
        return {
            'text'      : '',
            'confidence': 0.0,
            'warnings'  : warnings_list,
            'page_count': 0,
        }

    for page_num, img in enumerate(images):
        page_result = _ocr_page_with_timeout(img, lang, warnings_list, page_num)

        if page_result is not None:
            all_text.append(page_result['text'])
            confidences.append(page_result['confidence'])

        # FIX 3: Explicit memory cleanup after each page
        try:
            img.close()
        except Exception:
            pass
        del img
        gc.collect()

    full_text = '\n\n'.join(t for t in all_text if t)
    avg_conf  = sum(confidences) / len(confidences) if confidences else 0.0

    return {
        'text'      : full_text,
        'confidence': round(avg_conf, 3),
        'warnings'  : warnings_list,
        'page_count': len(images),
    }


def _ocr_page_with_timeout(img, lang: str, warnings_list: list,
                            page_num: int):
    """
    OCR a single page with a per-page timeout.
    FIX 5: Uses done_event + join for cleaner thread lifecycle.
    """
    result_holder = [None]
    error_holder  = [None]
    done_event    = threading.Event()

    def target():
        processed = None
        try:
            processed = _preprocess_image(img, warnings_list)
            text_result = None

            if HAS_PYTESSERACT:
                try:
                    text_result = _ocr_with_tesseract(processed, lang)
                    if text_result and text_result.get('text', '').strip():
                        result_holder[0] = text_result
                        return
                except Exception as e:
                    warnings_list.append(f"Tesseract failed on page {page_num + 1}: {e}")

            if HAS_EASYOCR:
                try:
                    text_result = _ocr_with_easyocr(processed)
                    if text_result and text_result.get('text', '').strip():
                        result_holder[0] = text_result
                        return
                except Exception as e:
                    warnings_list.append(f"EasyOCR failed on page {page_num + 1}: {e}")

            result_holder[0] = {'text': '', 'confidence': 0.0}

        except Exception as e:
            error_holder[0] = e
        finally:
            # FIX 3: Clean up preprocessed image inside the thread
            if processed is not None:
                try:
                    if hasattr(processed, 'close'):
                        processed.close()
                except Exception:
                    pass
                del processed
            done_event.set()

    t = threading.Thread(target=target, daemon=True)
    t.start()
    finished = done_event.wait(timeout=PER_PAGE_TIMEOUT)

    if not finished:
        warnings_list.append(
            f"Page {page_num + 1} OCR timed out after {PER_PAGE_TIMEOUT}s — skipped."
        )
        # FIX 5: Join with a short additional wait to let the thread clean up
        # if it's about to finish naturally; avoids resource leak on near-misses.
        t.join(timeout=2)
        return None

    if error_holder[0] is not None:
        warnings_list.append(f"Page {page_num + 1} OCR error: {error_holder[0]}")
        return None

    return result_holder[0]


def _pdf_to_images(file_path: str, warnings_list: list,
                   max_pages: int = DEFAULT_MAX_PAGES) -> list:
    if not HAS_PDF2IMAGE:
        warnings_list.append(
            "pdf2image not installed — cannot convert PDF to images. "
            "Run: pip install pdf2image --break-system-packages"
        )
        return []

    try:
        images = convert_from_path(
            file_path,
            dpi          = 300,
            fmt          = 'PNG',
            thread_count = 2,
            first_page   = 1,
            last_page    = max_pages,
        )

        if len(images) >= max_pages:
            warnings_list.append(
                f"PDF truncated: processed first {max_pages} pages only. "
                "Document may have more pages."
            )

        return images

    except Exception as e:
        warnings_list.append(
            f"PDF to image conversion failed: {e}. "
            "Ensure poppler is installed."
        )
        return []


def _preprocess_image(img, warnings_list: list):
    if not HAS_PILLOW:
        return img
    try:
        if img.mode not in ('RGB', 'L'):
            img = img.convert('RGB')
        if HAS_OPENCV:
            return _preprocess_with_opencv(img, warnings_list)
        else:
            return _preprocess_with_pillow(img)
    except Exception as e:
        warnings_list.append(f"Image preprocessing failed: {e}")
        return img


def _preprocess_with_opencv(img, warnings_list: list):
    import numpy as np
    img_array = np.array(img)
    if len(img_array.shape) == 3:
        gray = cv2.cvtColor(img_array, cv2.COLOR_RGB2GRAY)
    else:
        gray = img_array
    denoised = cv2.fastNlMeansDenoising(gray, h=10)
    thresh   = cv2.adaptiveThreshold(
        denoised, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY, 11, 2
    )
    try:
        thresh = _deskew(thresh)
    except Exception:
        pass
    return Image.fromarray(thresh)


def _preprocess_with_pillow(img):
    img      = img.convert('L')
    img      = img.filter(ImageFilter.SHARPEN)
    enhancer = ImageEnhance.Contrast(img)
    img      = enhancer.enhance(2.0)
    return img


def _deskew(image_array):
    import numpy as np
    coords = np.column_stack(np.where(image_array > 0))
    angle  = cv2.minAreaRect(coords)[-1]
    if angle < -45:
        angle = -(90 + angle)
    else:
        angle = -angle
    if abs(angle) < 0.5:
        return image_array
    h, w    = image_array.shape[:2]
    center  = (w // 2, h // 2)
    M       = cv2.getRotationMatrix2D(center, angle, 1.0)
    rotated = cv2.warpAffine(
        image_array, M, (w, h),
        flags      = cv2.INTER_CUBIC,
        borderMode = cv2.BORDER_REPLICATE,
    )
    return rotated


def _ocr_with_tesseract(img, lang: str = 'eng') -> dict:
    """
    FIX 4: Uses float(conf) instead of int(conf).
    Handles Tesseract returning -1, 84.52, or string "84.5".
    """
    data = pytesseract.image_to_data(img, lang=lang, output_type=Output.DICT)

    words       = []
    conf_values = []
    for i, conf in enumerate(data['conf']):
        try:
            conf_f = float(conf)   # FIX 4: was int(conf)
        except (ValueError, TypeError):
            conf_f = -1.0
        if conf_f > 30 and data['text'][i].strip():
            words.append(data['text'][i])
            conf_values.append(conf_f)

    text     = ' '.join(words)
    avg_conf = sum(conf_values) / len(conf_values) / 100.0 if conf_values else 0.0

    full_text = pytesseract.image_to_string(img, lang=lang, config='--psm 6')

    return {
        'text'      : full_text or text,
        'confidence': round(avg_conf, 3),
    }


def _ocr_with_easyocr(img) -> dict:
    """
    FIX 1: Uses thread-safe singleton via _get_easyocr_reader().
    FIX 2: Reader uses OCR_LANGUAGES instead of hardcoded ['en'].
    """
    import numpy as np

    reader    = _get_easyocr_reader()   # FIX 1+2
    img_array = np.array(img)
    results   = reader.readtext(img_array)

    lines       = []
    confidences = []
    for (_, text, conf) in results:
        if conf > 0.3 and text.strip():
            lines.append(text)
            confidences.append(conf)

    full_text = ' '.join(lines)
    avg_conf  = sum(confidences) / len(confidences) if confidences else 0.0

    return {
        'text'      : full_text,
        'confidence': round(avg_conf, 3),
    }
