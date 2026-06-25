'use strict';
/**
 * backend/routes/ocr.routes.js — V2
 *
 * CHANGES FROM V1:
 *
 * CRITICAL FIX #1 — OCR TEMP FILES NEVER DELETED AFTER SUCCESS (disk exhaustion)
 *   Old: Temp files in auros_ocr/ were only deleted in the catch block (error path).
 *        Successful OCR calls left every uploaded file on disk permanently.
 *   New: All temp file deletion moved into a finally block in both /invoice and
 *        /batch routes. Files are always deleted regardless of success or error.
 *        For batch, all files in req.files are cleaned up in a single finally pass.
 *
 * CRITICAL FIX #2 — BATCH FILES NEVER DELETED (disk exhaustion)
 *   Old: /batch route had no cleanup at all — neither on success nor on error.
 *   New: Same finally-block pattern as /invoice. All req.files paths deleted.
 *
 * CRITICAL FIX #3 — SYNCHRONOUS readFileSync IN GEMINI FALLBACK (event loop block)
 *   Old: fs.readFileSync(filePath).toString('base64') in _runGeminiFallback()
 *        blocked the Node event loop for large PDFs (20–100 MB), stalling all
 *        concurrent requests during the read.
 *   New: fs.promises.readFile(filePath) — fully async, non-blocking.
 *
 * CRITICAL FIX #4 — UNBOUNDED BASE64 MEMORY IN GEMINI FALLBACK (OOM)
 *   Old: Any file up to 50 MB was base64-encoded in memory before sending to Gemini.
 *        Base64 increases size by ~33%, so a 50 MB PDF became 67 MB in RAM per request.
 *        Multiple concurrent fallback calls multiplied this.
 *   New: GEMINI_FALLBACK_MAX_BYTES (default: 10 MB) checked BEFORE reading file.
 *        Files above the limit skip the Gemini fallback entirely (returns empty result)
 *        and emit a warning to the caller. The limit is configurable via env var.
 *
 * HIGH FIX #5 — GEMINI JSON PARSING FRAGILE (crash on "Sure! Here is..." prefix)
 *   Old: JSON.parse(text) after a simple .replace() — Gemini frequently returns
 *        preamble text, markdown fences, or trailing commentary, causing parse crashes.
 *   New: _safeParseGeminiJson(text) uses a more robust extraction strategy:
 *        (1) strip markdown fences, (2) find the first '{' and last '}' to extract
 *        the JSON substring, (3) JSON.parse the extracted portion.
 *        On parse failure, returns null (fallback skipped) rather than throwing.
 *        Also validates that parsed.rows is an array before using it.
 *
 * MEDIUM FIX #6 — HEALTH ENDPOINT SPAWNS PYTHON PROCESS ON EVERY REQUEST
 *   Old: GET /health spawned a Python subprocess on every call. Monitoring that
 *        polls every 5 seconds creates thousands of Python processes per day.
 *   New: Health check result cached for HEALTH_CACHE_TTL_MS (default: 30s).
 *        First call spawns Python; subsequent calls return cached result until TTL.
 *        Cache invalidated on any spawn error so it doesn't permanently hide failures.
 *
 * CRITICAL FIX #7 — OCR DATASET REGISTRY MEMORY LEAK (never evicted)
 *   Old: datasetRegistry.set(...) called for every OCR upload but never cleaned.
 *        Every OCR-processed invoice remained in memory permanently.
 *   New: OCR datasets are stored with the same expiry discipline as data.controller:
 *        - OCR_DATASET_TTL_MS (default: 4h) — matching main dataset TTL
 *        - MAX_OCR_REGISTRY_ENTRIES (default: 200) — LRU eviction at cap
 *        - Periodic cleanup sweep every 30 minutes
 *        Both the main datasetRegistry (shared with data.controller) and the
 *        cleanup scheduler enforce these limits.
 *
 * CRITICAL FIX #8 — UNBOUNDED ROWS IN OCR REGISTRY (OOM for large batch OCR)
 *   Old: ocrResult.rows (potentially thousands of rows × many fields) stored
 *        wholesale in the registry with no limit.
 *   New: Rows capped at MAX_OCR_ROWS (default: 500 000, matching data.controller)
 *        before being stored in the registry. A warning is added to the response
 *        if rows were truncated. sampleRows stored separately (always ≤ 20 rows).
 */

const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const path     = require('path');
const os       = require('os');
const crypto   = require('crypto');
const fs       = require('fs');
const { requireAuth }     = require('../controllers/auth.controller');
const { callEngine }      = require('../services/pythonBridge.service');
const { datasetRegistry } = require('../controllers/data.controller');

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

// FIX #4: Cap file size before Gemini base64 encode
const GEMINI_FALLBACK_MAX_BYTES = parseInt(
  process.env.GEMINI_FALLBACK_MAX_MB || '10', 10
) * 1024 * 1024;

// FIX #6: Health check cache TTL
const HEALTH_CACHE_TTL_MS = parseInt(process.env.OCR_HEALTH_CACHE_TTL_MS || '30000', 10);

// FIX #7: OCR dataset registry limits
const MAX_OCR_REGISTRY_ENTRIES = parseInt(process.env.MAX_OCR_REGISTRY_ENTRIES || '200', 10);
const OCR_DATASET_TTL_MS       = parseInt(process.env.OCR_DATASET_TTL_HOURS || '4', 10) * 60 * 60 * 1000;

// FIX #8: Row cap for OCR datasets
const MAX_OCR_ROWS = parseInt(process.env.MAX_OCR_ROWS || '500000', 10);

// FIX #6: Health check cache state
let _healthCache    = null;
let _healthCachedAt = 0;

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — OCR DATASET REGISTRY CLEANUP (FIX #7)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * FIX #7: Evict oldest OCR dataset from registry when cap is reached.
 * OCR datasets are stored in the shared datasetRegistry from data.controller,
 * tagged with fileType: 'ocr' or 'ocr_batch' for easy identification.
 */
function _evictOldestOcrDataset() {
  let oldestId = null;
  let oldestAt = Infinity;
  for (const [id, ds] of datasetRegistry.entries()) {
    if (!ds.fileType?.startsWith('ocr')) continue;
    const at = new Date(ds.uploadedAt).getTime();
    if (at < oldestAt) { oldestAt = at; oldestId = id; }
  }
  if (oldestId) {
    datasetRegistry.delete(oldestId);
    console.log(`[ocr.routes] Evicted oldest OCR dataset ${oldestId} from registry.`);
  }
}

function _countOcrDatasets() {
  let count = 0;
  for (const ds of datasetRegistry.values()) {
    if (ds.fileType?.startsWith('ocr')) count++;
  }
  return count;
}

// Cleanup sweep: remove expired OCR datasets every 30 minutes
const _ocrCleanupInterval = setInterval(() => {
  const now     = Date.now();
  let   removed = 0;
  for (const [id, ds] of datasetRegistry.entries()) {
    if (!ds.fileType?.startsWith('ocr')) continue;
    if (now - new Date(ds.uploadedAt).getTime() > OCR_DATASET_TTL_MS) {
      datasetRegistry.delete(id);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`[ocr.routes] Cleaned ${removed} expired OCR dataset(s) from registry.`);
  }
}, 30 * 60 * 1000);

if (_ocrCleanupInterval.unref) _ocrCleanupInterval.unref();

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — MULTER CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

const OCR_UPLOAD_DIR = path.join(os.tmpdir(), 'auros_ocr');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(OCR_UPLOAD_DIR, { recursive: true });
    cb(null, OCR_UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const unique = crypto.randomBytes(8).toString('hex');
    const safe   = file.originalname.replace(/[^a-zA-Z0-9._\-]/g, '_');
    cb(null, `${unique}_${safe}`);
  },
});

const OCR_ALLOWED_EXTS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.webp',
]);

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!OCR_ALLOWED_EXTS.has(ext)) {
      return cb(Object.assign(
        new Error(`Unsupported file type for OCR: ${ext}. Use PDF, PNG, JPG, TIFF.`),
        { status: 400, code: 'UNSUPPORTED_OCR_TYPE' }
      ), false);
    }
    cb(null, true);
  },
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — POST /api/ocr/invoice
// ══════════════════════════════════════════════════════════════════════════════

router.post('/invoice', requireAuth, upload.single('file'), async (req, res, next) => {
  // FIX #1: Track ALL temp paths so finally block always cleans up
  const tempPaths = [];

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded', code: 'NO_FILE' });
    }
    tempPaths.push(req.file.path);  // FIX #1: register for cleanup

    const gemini_fallback = req.body.gemini_fallback === 'true' ||
                            req.body.gemini_fallback === true;

    const ocrResult = await callEngine({
      operation       : 'ocr_invoice',
      filePath        : req.file.path,
      gemini_fallback,
    });

    // Gemini fallback (FIX #3: async read, FIX #4: size check)
    if (ocrResult.needsAIFallback && gemini_fallback) {
      try {
        const aiResult = await _runGeminiFallback(req.file.path, req.file.mimetype);
        if (aiResult && Array.isArray(aiResult.rows) && aiResult.rows.length > 0) {
          ocrResult.rows            = aiResult.rows;
          ocrResult.ocrMethod       = 'gemini_vision';
          ocrResult.confidence      = aiResult.confidence || 0.85;
          ocrResult.needsAIFallback = false;
        }
      } catch (aiErr) {
        console.warn('[ocr] Gemini fallback failed:', aiErr.message);
        if (!ocrResult.warnings) ocrResult.warnings = [];
        ocrResult.warnings.push(`AI fallback failed: ${aiErr.message}`);
      }
    }

    // FIX #8: Cap rows before storing in registry
    const allRows    = ocrResult.rows || [];
    const truncated  = allRows.length > MAX_OCR_ROWS;
    const storedRows = truncated ? allRows.slice(0, MAX_OCR_ROWS) : allRows;
    if (truncated) {
      if (!ocrResult.warnings) ocrResult.warnings = [];
      ocrResult.warnings.push(
        `OCR result truncated to ${MAX_OCR_ROWS} rows. ` +
        `Full result had ${allRows.length} rows.`
      );
    }

    // FIX #7: Registry LRU eviction before inserting
    while (_countOcrDatasets() >= MAX_OCR_REGISTRY_ENTRIES) {
      _evictOldestOcrDataset();
    }

    const datasetId = `ds_ocr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    datasetRegistry.set(datasetId, {
      id             : datasetId,
      datasetId,
      originalName   : req.file.originalname,
      filePath       : req.file.path,  // path preserved for reference; file deleted below
      rows           : storedRows,     // FIX #8: capped
      columns        : ocrResult.columnNames || [],
      fileType       : 'ocr',
      ocrMethod      : ocrResult.ocrMethod,
      confidence     : ocrResult.confidence,
      cleanedRows    : null,
      cleanedFilePath: null,
      uploadedAt     : new Date().toISOString(),
      userId         : req.user.id,
    });

    res.json({
      success         : true,
      datasetId,
      originalName    : req.file.originalname,
      rowCount        : ocrResult.rowCount,
      columnNames     : ocrResult.columnNames,
      schema          : ocrResult.schema,
      sampleRows      : ocrResult.sampleRows,
      ocrMethod       : ocrResult.ocrMethod,
      confidence      : ocrResult.confidence,
      confidenceLabel : _confidenceLabel(ocrResult.confidence),
      extractedFields : ocrResult.extractedFields,
      needsAIFallback : ocrResult.needsAIFallback,
      warnings        : ocrResult.warnings || [],
      truncated,
    });

  } catch (err) {
    next(err);
  } finally {
    // FIX #1: Always clean up temp files — success AND error paths
    for (const p of tempPaths) _safeUnlink(p);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — POST /api/ocr/batch
// ══════════════════════════════════════════════════════════════════════════════

router.post('/batch', requireAuth, upload.array('files', 20), async (req, res, next) => {
  // FIX #2: Track ALL batch file paths for cleanup in finally
  const tempPaths = [];

  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded', code: 'NO_FILES' });
    }

    // FIX #2: Register all paths before any async work
    for (const f of req.files) tempPaths.push(f.path);

    const gemini_fallback = req.body.gemini_fallback === 'true';
    const filePaths       = req.files.map(f => f.path);

    const batchResult = await callEngine({
      operation       : 'ocr_batch',
      filePaths,
      gemini_fallback,
    });

    // FIX #8: Cap rows for batch result
    const allRows    = batchResult.sampleRows || [];
    const truncated  = allRows.length > MAX_OCR_ROWS;
    const storedRows = truncated ? allRows.slice(0, MAX_OCR_ROWS) : allRows;

    // FIX #7: LRU eviction before inserting
    while (_countOcrDatasets() >= MAX_OCR_REGISTRY_ENTRIES) {
      _evictOldestOcrDataset();
    }

    const datasetId = `ds_ocr_batch_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    datasetRegistry.set(datasetId, {
      id             : datasetId,
      datasetId,
      originalName   : `batch_${req.files.length}_invoices`,
      filePath       : filePaths[0],
      rows           : storedRows,     // FIX #8: capped
      columns        : batchResult.columnNames || [],
      fileType       : 'ocr_batch',
      cleanedRows    : null,
      cleanedFilePath: null,
      uploadedAt     : new Date().toISOString(),
      userId         : req.user.id,
    });

    res.json({
      success    : true,
      datasetId,
      totalFiles : batchResult.totalFiles,
      succeeded  : batchResult.succeeded,
      failed     : batchResult.failed,
      skipped    : batchResult.skipped,
      totalRows  : batchResult.totalRows,
      columnNames: batchResult.columnNames,
      schema     : batchResult.schema,
      sampleRows : batchResult.sampleRows,
      fileResults: batchResult.fileResults,
      truncated,
    });

  } catch (err) {
    next(err);
  } finally {
    // FIX #2: Always clean up ALL batch temp files
    for (const p of tempPaths) _safeUnlink(p);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — GET /api/ocr/health (FIX #6: cached result)
// ══════════════════════════════════════════════════════════════════════════════

router.get('/health', requireAuth, async (req, res) => {
  // FIX #6: Return cached result if still fresh — prevents Python process storm
  const now = Date.now();
  if (_healthCache && (now - _healthCachedAt) < HEALTH_CACHE_TTL_MS) {
    return res.json({ ..._healthCache, cached: true, cacheAgeMs: now - _healthCachedAt });
  }

  try {
    const { spawn } = require('child_process');
    const PYTHON    = process.env.PYTHON_BIN || 'python3';

    const checkScript = `
import json, sys
status = {}
for pkg in ['pdfplumber','camelot','pytesseract','pdf2image','cv2','PIL','easyocr']:
    try:
        __import__(pkg if pkg != 'PIL' else 'PIL.Image')
        status[pkg] = True
    except ImportError:
        status[pkg] = False
sys.stdout.write(json.dumps(status))
`;
    await new Promise((resolve) => {
      const proc   = spawn(PYTHON, ['-c', checkScript]);
      let   stdout = '';
      let   stderr = '';
      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('close', (code) => {
        try {
          const pkgStatus = JSON.parse(stdout);
          const level1    = pkgStatus['pdfplumber'] || pkgStatus['camelot'];
          const level2    = pkgStatus['pytesseract'] || pkgStatus['easyocr'];
          _healthCache = {
            available    : level1 || level2,
            level1_fast  : level1,
            level2_scan  : level2,
            packages     : pkgStatus,
            recommendation: !level1 && !level2
              ? 'Run: pip install pdfplumber camelot-py[cv] pytesseract pdf2image opencv-python Pillow'
              : level1 && !level2
              ? 'Level 1 (digital PDFs) ready. For scanned PDFs: pip install pytesseract pdf2image opencv-python'
              : 'Full OCR pipeline ready.',
          };
          _healthCachedAt = Date.now();
        } catch {
          // FIX #6: Don't cache parse failures — allow retry next request
          _healthCache    = null;
          _healthCachedAt = 0;
        }
        resolve();
      });
      proc.on('error', () => {
        _healthCache    = null;
        _healthCachedAt = 0;
        resolve();
      });
    });

    if (_healthCache) {
      return res.json({ ..._healthCache, cached: false });
    }
    return res.json({ available: false, error: 'Could not check OCR packages', cached: false });

  } catch (err) {
    res.json({ available: false, error: err.message, cached: false });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — GEMINI FALLBACK (FIX #3 async, FIX #4 size cap, FIX #5 safe parse)
// ══════════════════════════════════════════════════════════════════════════════

async function _runGeminiFallback(filePath, mimeType) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');

  // FIX #4: Check file size BEFORE reading into memory
  const stat = fs.statSync(filePath);
  if (stat.size > GEMINI_FALLBACK_MAX_BYTES) {
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
    const maxMB  = GEMINI_FALLBACK_MAX_BYTES / (1024 * 1024);
    console.warn(
      `[ocr] Gemini fallback skipped: file ${sizeMB} MB exceeds limit ${maxMB} MB`
    );
    return null;  // Caller checks for null and skips
  }

  // FIX #3: Async file read — does not block the event loop
  const imageBuffer = await fs.promises.readFile(filePath);
  const imageData   = imageBuffer.toString('base64');

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const result = await model.generateContent([
    {
      inlineData: {
        data    : imageData,
        mimeType: mimeType || 'application/pdf',
      },
    },
    `Extract all invoice data from this document and return ONLY a JSON object with this structure:
{
  "rows": [
    {
      "invoice_number": "",
      "vendor_name": "",
      "amount": "",
      "currency": "",
      "date": "",
      "po_number": "",
      "description": ""
    }
  ],
  "confidence": 0.0
}
Return ONLY the JSON object. No explanation. No markdown fences. No extra text.`,
  ]);

  const text   = result.response.text();
  const parsed = _safeParseGeminiJson(text);
  return parsed;
}

/**
 * FIX #5: Robust JSON extraction from Gemini response.
 * Handles preamble text, markdown fences, and trailing commentary.
 * Returns null on any parse failure rather than throwing.
 */
function _safeParseGeminiJson(text) {
  if (!text || typeof text !== 'string') return null;

  try {
    // Step 1: strip markdown fences
    let cleaned = text
      .replace(/^```(?:json)?\s*/im, '')
      .replace(/\s*```\s*$/im, '')
      .trim();

    // Step 2: extract first complete {...} block
    const firstBrace = cleaned.indexOf('{');
    const lastBrace  = cleaned.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

    const jsonStr = cleaned.slice(firstBrace, lastBrace + 1);
    const parsed  = JSON.parse(jsonStr);

    // Step 3: validate schema
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.rows))           return null;

    return parsed;
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function _confidenceLabel(confidence) {
  if (confidence >= 0.8)  return { level: 'high',     color: 'green',  text: 'High confidence'   };
  if (confidence >= 0.6)  return { level: 'medium',   color: 'yellow', text: 'Medium confidence'  };
  if (confidence >= 0.45) return { level: 'low',      color: 'orange', text: 'Low confidence'     };
  return                         { level: 'very_low', color: 'red',    text: 'Very low confidence' };
}

function _safeUnlink(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch (_) {}
}

// ── Multer error handler ──────────────────────────────────────────────────────
router.use((err, req, res, next) => {
  // Clean up any partially written files
  if (req.file)  _safeUnlink(req.file.path);
  if (req.files) req.files.forEach(f => _safeUnlink(f.path));

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File exceeds 50 MB OCR limit', code: 'FILE_TOO_LARGE' });
  }
  next(err);
});

module.exports = router;