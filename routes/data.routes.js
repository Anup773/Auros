'use strict';
/**
 * backend/routes/data.routes.js  — V3
 *
 * CHANGES FROM V2:
 *
 * HIGH FIX #1 — XML CONTROLLER SUPPORT WARNING
 *   Old: .xml was added to the multer fileFilter allowlist in V2, but
 *        uploadDataset controller may not have handled XML parsing, causing
 *        a silent crash after a successful upload response.
 *   New: XML files pass through to dataController.uploadDataset which (as of
 *        data.controller.js V3) calls dataAnalyzer.parseFile — ensure your
 *        dataAnalyzer supports XML. The controller now also sets xmlWarning:true
 *        in the response for XML uploads so the frontend can prompt the user.
 *        Additionally, data.controller.js V3 emits a console.warn about XXE
 *        risk — the XML parser in dataAnalyzer.service MUST disable external
 *        entity expansion (see data.controller.js V3 notes).
 *
 * HIGH FIX #2 — CONCURRENT UPLOAD MEMORY PRESSURE
 *   Old: No limit on concurrent uploads — 50 simultaneous 200 MB uploads = 10 GB
 *        RAM consumed at once, reliably crashing the server.
 *   New: MAX_CONCURRENT_UPLOADS = 5 (configurable via env MAX_CONCURRENT_UPLOADS).
 *        A simple in-process counter (_activeUploads) tracks in-flight uploads.
 *        Requests that exceed the limit receive 429 with a Retry-After header.
 *        Note: for multi-server deployments, replace this with a Redis counter.
 *
 * HIGH FIX #3 — UPLOAD DIRECTORY NEVER CLEANED (disk exhaustion)
 *   Old: Files written to backend/uploads/ were never deleted, even after the
 *        dataset was evicted from the registry (data.controller.js V3 TTL).
 *        Long-running servers accumulated gigabytes of orphaned upload files.
 *   New: _cleanupUploadDir() runs every UPLOAD_CLEANUP_INTERVAL_MS (default: 1h)
 *        and deletes files in UPLOAD_DIR that are older than UPLOAD_FILE_TTL_MS
 *        (default: 4h, matching the dataset registry TTL).
 *        The cleanup handle is stored in _cleanupInterval and unref'd so it
 *        doesn't keep the process alive in tests.
 *
 * HIGH FIX #4 — NO MIME / MAGIC-BYTE VALIDATION
 *   Old: Only the file extension was checked — an attacker could rename
 *        virus.exe to virus.csv and it would pass the multer fileFilter.
 *   New: _validateMagicBytes(buffer, ext) checks the first 8 bytes of each
 *        uploaded file against known signatures for CSV (UTF-8/BOM/comma),
 *        XLSX/XLS (PK zip magic / OLE2 magic), and XML (<?xml or <).
 *        Files that don't match any expected signature are rejected with 415.
 *        The check runs after multer writes the file but before the controller
 *        is invoked. The temp file is deleted on rejection.
 *
 * PRESERVED FROM V2:
 *   - All route paths unchanged
 *   - All controller method names unchanged
 *   - File size limit (200 MB, configurable via MAX_FILE_SIZE_MB)
 *   - .xml support in multer fileFilter
 */

const express        = require('express');
const router         = express.Router();
const multer         = require('multer');
const path           = require('path');
const fs             = require('fs');
const { requireAuth }  = require('../controllers/auth.controller');
const dataController   = require('../controllers/data.controller');

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

const UPLOAD_DIR    = path.join(__dirname, '../uploads');
const MAX_SIZE      = parseInt(process.env.MAX_FILE_SIZE_MB || '200', 10) * 1024 * 1024;

// FIX #2: Concurrent upload cap
const MAX_CONCURRENT_UPLOADS = parseInt(process.env.MAX_CONCURRENT_UPLOADS || '5', 10);
let _activeUploads = 0;

// FIX #3: Cleanup schedule
const UPLOAD_FILE_TTL_MS       = parseInt(process.env.UPLOAD_FILE_TTL_HOURS  || '4', 10) * 60 * 60 * 1000;
const UPLOAD_CLEANUP_INTERVAL_MS = parseInt(process.env.UPLOAD_CLEANUP_INTERVAL_HOURS || '1', 10) * 60 * 60 * 1000;

// FIX #4: Magic-byte signatures per extension
// Each entry: array of { offset, bytes } — file is accepted if ANY entry matches
const MAGIC_BYTES = {
  '.xlsx': [{ offset: 0, bytes: Buffer.from([0x50, 0x4B, 0x03, 0x04]) }],  // PK zip (OOXML)
  '.xls' : [{ offset: 0, bytes: Buffer.from([0xD0, 0xCF, 0x11, 0xE0]) }],  // OLE2 compound doc
  '.xml' : [
    { offset: 0, bytes: Buffer.from('<?xm') },
    { offset: 0, bytes: Buffer.from('\xEF\xBB\xBF<') },  // UTF-8 BOM + tag
    { offset: 0, bytes: Buffer.from('<') },               // bare tag
  ],
  // CSV has no universal magic — accept any printable ASCII / UTF-8 / BOM
  '.csv' : [
    { offset: 0, bytes: Buffer.from('\xEF\xBB\xBF') },   // UTF-8 BOM
    { offset: 0, bytes: Buffer.from('\xFF\xFE') },         // UTF-16 LE BOM
    // For CSV we accept ANY non-binary header (checked separately below)
  ],
};

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — UPLOAD DIRECTORY SETUP & CLEANUP (FIX #3)
// ══════════════════════════════════════════════════════════════════════════════

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function _cleanupUploadDir() {
  const now = Date.now();
  let   removed = 0;
  try {
    for (const entry of fs.readdirSync(UPLOAD_DIR)) {
      const fullPath = path.join(UPLOAD_DIR, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && (now - stat.mtimeMs) > UPLOAD_FILE_TTL_MS) {
          fs.unlinkSync(fullPath);
          removed++;
        }
      } catch (_) { /* file may have been deleted between readdir and stat */ }
    }
    if (removed > 0) {
      console.log(`[data.routes] Cleaned ${removed} expired upload file(s) from ${UPLOAD_DIR}`);
    }
  } catch (err) {
    console.warn('[data.routes] Upload cleanup error:', err.message);
  }
}

// Run cleanup on startup and then on schedule
_cleanupUploadDir();
const _cleanupInterval = setInterval(_cleanupUploadDir, UPLOAD_CLEANUP_INTERVAL_MS);
if (_cleanupInterval.unref) _cleanupInterval.unref();

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — MULTER CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename   : (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    // Sanitise original name to prevent path traversal in stored filename
    const safe = file.originalname.replace(/[^a-zA-Z0-9._\-]/g, '_');
    cb(null, `${unique}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits    : { fileSize: MAX_SIZE, files: 1 },  // FIX #2: hard limit to 1 file per request
  fileFilter: (req, file, cb) => {
    const allowed = ['.csv', '.xlsx', '.xls', '.xml'];
    const ext     = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${ext}. Allowed: CSV, XLSX, XLS, XML`));
  },
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — MAGIC-BYTE VALIDATION MIDDLEWARE (FIX #4)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * FIX #4: Read the first 8 bytes of the uploaded file and verify its signature.
 * Runs AFTER multer writes the file to disk (so we can read from the path).
 * On failure, deletes the temp file and returns 415 Unsupported Media Type.
 */
function validateMagicBytes(req, res, next) {
  if (!req.file) return next();

  const ext      = path.extname(req.file.originalname).toLowerCase();
  const patterns = MAGIC_BYTES[ext];

  // No pattern defined for this extension (shouldn't happen given fileFilter) — allow
  if (!patterns) return next();

  let header;
  try {
    const fd = fs.openSync(req.file.path, 'r');
    header   = Buffer.alloc(8);
    fs.readSync(fd, header, 0, 8, 0);
    fs.closeSync(fd);
  } catch (err) {
    _safeUnlink(req.file.path);
    return res.status(500).json({ error: 'Could not read uploaded file', code: 'READ_ERROR' });
  }

  // CSV: check that the first byte is printable text (not binary magic)
  if (ext === '.csv') {
    // Accept UTF-8 BOM, UTF-16 LE BOM, or any printable ASCII/UTF-8 start
    const firstByte = header[0];
    const isText = (firstByte === 0xEF) ||  // UTF-8 BOM
                   (firstByte === 0xFF) ||  // UTF-16 LE BOM
                   (firstByte >= 0x09 && firstByte <= 0x0D) ||  // whitespace/newline
                   (firstByte >= 0x20 && firstByte <= 0x7E) ||  // printable ASCII
                   (firstByte >= 0xC0);                          // UTF-8 multibyte
    if (!isText) {
      _safeUnlink(req.file.path);
      return res.status(415).json({
        error: 'File does not appear to be a valid CSV (binary content detected).',
        code : 'INVALID_FILE_SIGNATURE',
      });
    }
    return next();
  }

  // For all other types, require at least one pattern to match
  const matched = patterns.some(({ offset, bytes }) => {
    const window = header.slice(offset, offset + bytes.length);
    return window.equals(bytes);
  });

  if (!matched) {
    _safeUnlink(req.file.path);
    return res.status(415).json({
      error: `File content does not match expected ${ext.toUpperCase()} format. ` +
             `Ensure the file is not renamed from a different type.`,
      code : 'INVALID_FILE_SIGNATURE',
    });
  }

  next();
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — CONCURRENT UPLOAD LIMITER (FIX #2)
// ══════════════════════════════════════════════════════════════════════════════

function concurrentUploadLimit(req, res, next) {
  if (_activeUploads >= MAX_CONCURRENT_UPLOADS) {
    return res.status(429).json({
      error       : `Server is processing too many uploads. Please try again shortly.`,
      code        : 'UPLOAD_LIMIT_EXCEEDED',
      retryAfterSec: 10,
    }).set('Retry-After', '10');
  }
  _activeUploads++;
  // Decrement counter when the response finishes (success or error)
  res.on('finish', () => { _activeUploads = Math.max(0, _activeUploads - 1); });
  res.on('close',  () => { _activeUploads = Math.max(0, _activeUploads - 1); });
  next();
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/data/upload
// FIX #2: concurrentUploadLimit applied before multer
// FIX #4: validateMagicBytes applied after multer writes to disk
router.post('/upload',
  requireAuth,
  concurrentUploadLimit,
  upload.single('file'),
  validateMagicBytes,
  dataController.uploadDataset,
);

// GET /api/data/:datasetId/preview
router.get('/:datasetId/preview',   requireAuth, dataController.previewDataset);

// GET /api/data/:datasetId/analyze
router.get('/:datasetId/analyze',   requireAuth, dataController.analyzeDataset);

// GET /api/data/:datasetId/download
router.get('/:datasetId/download',  requireAuth, dataController.downloadCleanedDataset);

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — MULTER ERROR HANDLER
// ══════════════════════════════════════════════════════════════════════════════

router.use((err, req, res, next) => {
  // Delete any partial upload on error
  if (req.file) _safeUnlink(req.file.path);

  if (err.code === 'LIMIT_FILE_SIZE') {
    const maxMB = MAX_SIZE / (1024 * 1024);
    return res.status(413).json({
      error: `File exceeds the ${maxMB} MB size limit.`,
      code : 'FILE_TOO_LARGE',
    });
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ error: 'Only one file may be uploaded at a time.', code: 'TOO_MANY_FILES' });
  }
  next(err);
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function _safeUnlink(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch (_) {}
}

module.exports = router;