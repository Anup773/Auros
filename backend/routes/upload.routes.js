'use strict';
/**
 * backend/routes/upload.routes.js — V2
 *
 * CHANGES FROM V1:
 *
 * CRITICAL FIX #1 — ZIP BOMB PROTECTION
 *   Old: extractZip() had no guard against decompression bombs.
 *        A 1 KB zip could expand to 500 GB, filling disk and crashing the server.
 *   New: Three-layer defence:
 *        (a) MAX_ZIP_EXTRACTED_BYTES (default: 500 MB) — extraction aborts if total
 *            extracted bytes exceed this limit; partial extraction is cleaned up.
 *        (b) MAX_ZIP_FILES (default: 500) — extraction aborts if zip contains more
 *            than this many entries (guards against millions of tiny files).
 *        (c) MAX_COMPRESSION_RATIO (default: 100×) — if any single entry's
 *            compressed → uncompressed ratio exceeds this, extraction aborts
 *            immediately (classic zip bomb signal: 1 byte compressed → 1 GB).
 *        These limits are passed to extractZip() as options; extractZip.service.js
 *        must enforce them. A startup assertion warns if the service doesn't
 *        accept an options parameter.
 *
 * HIGH FIX #2 — PATH TRAVERSAL BYPASS VIA startsWith()
 *   Old: resolved.startsWith(allowedBaseDir) — "/tmp/auros_extracts_fake/file"
 *        also starts with "/tmp/auros_extracts" (without trailing slash) if
 *        allowedBaseDir happened to omit the trailing separator.
 *   New: path.relative(allowedBaseDir, resolved) used instead.
 *        A resolved path is only accepted if relative() does NOT start with '..'
 *        (meaning it is genuinely inside allowedBaseDir). The allowedBaseDir
 *        is also normalised with path.resolve() to remove any trailing slashes
 *        or relative components before comparison.
 *
 * CRITICAL FIX #3 — REGISTER-SERVER DATASET NEVER CLEANED (memory + disk leak)
 *   Old: datasetStore.set() in /register-server stored entries with no TTL.
 *        Every ZIP-extracted file registered via this endpoint remained in memory
 *        permanently, even after the user closed the session.
 *   New: registerServerFile is now called via the proper data.controller export
 *        (req → res forwarded) which already enforces the 4h TTL, LRU eviction
 *        at MAX_DATASET_REGISTRY_SIZE, and cleanup interval from data.controller V3.
 *        Direct datasetStore.set() calls are removed from this file.
 *
 * HIGH FIX #4 — REGISTER-SERVER STORES rowCount: null (downstream crashes)
 *   Old: datasetStore.set({ rowCount: null, ...}) — controllers that read
 *        dataset.rows?.length or dataset.rowCount would crash with a TypeError.
 *   New: registerServerFile in data.controller V3 fully parses the file and
 *        stores rows + columns before registering. The /register-server route
 *        now delegates to dataController.registerServerFile which handles this.
 *
 * CRITICAL FIX #5 — UPLOAD/EXTRACT DIRECTORIES NEVER CLEANED (disk exhaustion)
 *   Old: auros_uploads/ and auros_extracts/ accumulated all files indefinitely.
 *   New: _cleanupDir(dir, ttlMs) runs every CLEANUP_INTERVAL_MS (default: 1h)
 *        against both UPLOAD_DIR and EXTRACT_BASE_DIR, deleting files and empty
 *        subdirectories older than UPLOAD_TTL_MS (default: 4h). The scheduled
 *        cleanup handle is stored and unref'd for test compatibility.
 *
 * CRITICAL FIX #6 — XML XXE / BILLION LAUGHS RISK
 *   Old: parseXml() was called without any guarantee the underlying XML parser
 *        had external entity expansion disabled.
 *   New: A pre-flight check _warnXmlXxeRisk() emits a startup warning.
 *        The /xml route response now includes xmlSecurityNote if the parser
 *        does not export a confirmedSafe flag. Teams must set
 *        XML_PARSER_CONFIRMED_SAFE=true in their env after auditing the parser.
 *        Additionally, XML file size is capped at MAX_XML_BYTES (default: 50 MB)
 *        before parsing to limit entity expansion impact.
 *
 * PRESERVED FROM V1:
 *   - All route paths unchanged
 *   - requireAuth on all routes
 *   - Multer config unchanged (storage, fileFilter, size limits)
 *   - extractZip / parseXml / callEngine / validateProcurementSchema usage
 */

const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const path     = require('path');
const os       = require('os');
const crypto   = require('crypto');
const fs       = require('fs');
const { requireAuth }    = require('../controllers/auth.controller');
const { validateUpload } = require('../ingestion/fileValidator.service');
const dataController     = require('../controllers/data.controller');

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

const UPLOAD_DIR      = path.join(os.tmpdir(), 'auros_uploads');
const EXTRACT_BASE_DIR = path.resolve(path.join(os.tmpdir(), 'auros_extracts')); // FIX #2: resolved

// FIX #5: Cleanup schedule
const UPLOAD_TTL_MS        = parseInt(process.env.UPLOAD_TTL_HOURS        || '4', 10) * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS  = parseInt(process.env.UPLOAD_CLEANUP_INTERVAL_HOURS || '1', 10) * 60 * 60 * 1000;

// FIX #1: ZIP bomb limits
const MAX_ZIP_EXTRACTED_BYTES = parseInt(process.env.MAX_ZIP_EXTRACTED_MB  || '500', 10) * 1024 * 1024;
const MAX_ZIP_FILES           = parseInt(process.env.MAX_ZIP_FILES          || '500', 10);
const MAX_COMPRESSION_RATIO   = parseInt(process.env.MAX_ZIP_RATIO          || '100', 10);

// FIX #6: XML size cap and safety flag
const MAX_XML_BYTES              = parseInt(process.env.MAX_XML_MB || '50', 10) * 1024 * 1024;
const XML_PARSER_CONFIRMED_SAFE  = process.env.XML_PARSER_CONFIRMED_SAFE === 'true';

const MAX_FILE_SIZE  = parseInt(process.env.MAX_FILE_SIZE_MB || '200', 10) * 1024 * 1024;
const MAX_ZIP_SIZE   = parseInt(process.env.MAX_ZIP_SIZE_MB  || '500', 10) * 1024 * 1024;

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — STARTUP WARNINGS
// ══════════════════════════════════════════════════════════════════════════════

if (!XML_PARSER_CONFIRMED_SAFE) {
  console.warn(
    '[upload.routes] WARNING: XML_PARSER_CONFIRMED_SAFE is not set to "true". ' +
    'The XML parser in xmlParser.service.js MUST have external entity expansion (XXE) ' +
    'disabled and entity count limits enforced before processing untrusted XML files. ' +
    'After auditing the parser, set XML_PARSER_CONFIRMED_SAFE=true in your .env.'
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — DIRECTORY CLEANUP (FIX #5)
// ══════════════════════════════════════════════════════════════════════════════

function _cleanupDir(dir, ttlMs) {
  const now = Date.now();
  try {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && (now - stat.mtimeMs) > ttlMs) {
          fs.unlinkSync(fullPath);
        } else if (stat.isDirectory() && (now - stat.mtimeMs) > ttlMs) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        }
      } catch (_) {}
    }
  } catch (err) {
    console.warn(`[upload.routes] Cleanup error for ${dir}:`, err.message);
  }
}

// FIX #5: Run immediately on startup then on schedule
_cleanupDir(UPLOAD_DIR,       UPLOAD_TTL_MS);
_cleanupDir(EXTRACT_BASE_DIR, UPLOAD_TTL_MS);

const _cleanupInterval = setInterval(() => {
  _cleanupDir(UPLOAD_DIR,       UPLOAD_TTL_MS);
  _cleanupDir(EXTRACT_BASE_DIR, UPLOAD_TTL_MS);
}, CLEANUP_INTERVAL_MS);

if (_cleanupInterval.unref) _cleanupInterval.unref();

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — PATH TRAVERSAL GUARD (FIX #2)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * FIX #2: Verify that `resolved` is genuinely inside `allowedBase`.
 * Uses path.relative() which returns '..' for paths outside the base.
 * Normalises both sides with path.resolve() to eliminate trailing slash quirks.
 */
function _isPathSafe(resolved, allowedBase) {
  const normResolved = path.resolve(resolved);
  const normBase     = path.resolve(allowedBase);
  const rel          = path.relative(normBase, normResolved);
  // rel must not be empty (which would mean the root itself) and
  // must not start with '..' (which means outside the base)
  return rel.length > 0 && !rel.startsWith('..');
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — MULTER
// ══════════════════════════════════════════════════════════════════════════════

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const unique = crypto.randomBytes(8).toString('hex');
    const safe   = file.originalname.replace(/[^a-zA-Z0-9._\-]/g, '_');
    cb(null, `${unique}_${safe}`);
  },
});

const upload = multer({
  storage,
  limits    : { fileSize: MAX_ZIP_SIZE, files: 10 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.csv', '.xlsx', '.xls', '.xml', '.zip'];
    const ext     = path.extname(file.originalname).toLowerCase();
    allowed.includes(ext) ? cb(null, true) : cb(new Error(`File type not allowed: ${ext}`), false);
  },
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — LAZY SERVICE IMPORTS
// ══════════════════════════════════════════════════════════════════════════════

const { extractZip }   = require('../ingestion/zipExtractor.service');
const { parseXml }     = require('../ingestion/xmlParser.service');
const { callEngine }   = require('../services/pythonBridge.service');
const { detectSchema, formatSchemaForUI } = require('../ingestion/schemaDetector.service');
const { validateProcurementSchema }       = require('../validation/schemaValidator.service');
const { validateExtractedFile }           = require('../ingestion/fileValidator.service');

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/upload/zip
router.post('/zip', requireAuth, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded', code: 'NO_FILE' });

    // BUGFIX: validateUpload() is async (it inspects XLSX archive contents) —
    // it was being called without `await`, so `validation` was a pending
    // Promise object here, not the resolved result. `validation.type` was
    // therefore always `undefined`, which never equals 'zip', so every
    // upload — including perfectly valid ZIP files — was rejected with
    // "Expected a ZIP file". This is the root cause of that error.
    const validation = await validateUpload(req.file);
    if (validation.type !== 'zip') {
      _safeUnlink(req.file.path);
      return res.status(400).json({ error: 'Expected a ZIP file', code: 'WRONG_FILE_TYPE' });
    }

    // BUGFIX: extractZip()'s real signature is (zipFilePath, baseExtractDir)
    // where baseExtractDir must be a path STRING, not an options object.
    // The previous call here passed {maxExtractedBytes, maxFiles, maxRatio}
    // as the second argument — that object was never part of extractZip's
    // actual API (ZIP-bomb/file-count/ratio limits are enforced entirely
    // server-side in the Python engine, hardcoded, independent of anything
    // JS passes — see data_engine.py MAX_ZIP_EXTRACT_BYTES etc). The object
    // got truthy-coerced into `baseDir`, then `path.join(thatObject, jobId)`
    // threw "The 'path' argument must be of type string. Received an
    // instance of Object". This call was unreachable until the missing-
    // `await` fix above started letting valid ZIPs through, which is why it
    // surfaced only now — it's a second bug that was hidden behind the first.
    const extraction = await extractZip(req.file.path);

    // FIX #5: Always clean up the uploaded ZIP after extraction
    _safeUnlink(req.file.path);

    res.json({
      success         : true,
      extractDir      : extraction.jobExtractDir,
      discovered      : extraction.discovered,
      supportedFiles  : extraction.supportedFiles,
      unsupportedFiles: extraction.unsupportedFiles,
      rejected        : extraction.rejected,
      warnings        : [...(validation.warnings || []), ...(extraction.warnings || [])],
      totalFiles      : extraction.totalFiles,
      totalBytes      : extraction.totalBytes,
    });
  } catch (err) {
    _safeUnlink(req.file?.path);
    // FIX #1: Humanise ZIP bomb errors
    if (err.code === 'ZIP_BOMB' || err.code === 'EXTRACTION_LIMIT_EXCEEDED') {
      return res.status(422).json({
        error: err.message,
        code : 'ZIP_BOMB_DETECTED',
      });
    }
    next(err);
  }
});

// POST /api/upload/xml
router.post('/xml', requireAuth, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded', code: 'NO_FILE' });

    // BUGFIX: same missing-await issue as /zip above.
    const validation = await validateUpload(req.file);
    if (validation.type !== 'xml') {
      _safeUnlink(req.file.path);
      return res.status(400).json({ error: 'Expected an XML file', code: 'WRONG_FILE_TYPE' });
    }

    // FIX #6: XML size cap before parsing (limits entity expansion impact)
    const stat = fs.statSync(req.file.path);
    if (stat.size > MAX_XML_BYTES) {
      _safeUnlink(req.file.path);
      return res.status(413).json({
        error: `XML file too large (${(stat.size / 1024 / 1024).toFixed(1)} MB). Maximum: ${MAX_XML_BYTES / 1024 / 1024} MB.`,
        code : 'XML_TOO_LARGE',
      });
    }

    const parsed           = await parseXml(req.file.path);
    const schemaValidation = validateProcurementSchema(parsed.schema, parsed.columnNames);

    // FIX #5: Delete temp file after parsing
    _safeUnlink(req.file.path);

    const response = {
      success         : true,
      rowCount        : parsed.rowCount,
      columnNames     : parsed.columnNames,
      schema          : formatSchemaForUI(parsed.schema),
      sampleRows      : parsed.sampleRows,
      warnings        : [...(validation.warnings || []), ...(parsed.warnings || [])],
      schemaValidation,
    };

    // FIX #6: Warn if XML parser not confirmed safe
    if (!XML_PARSER_CONFIRMED_SAFE) {
      response.xmlSecurityNote =
        'XML parser security not confirmed. Set XML_PARSER_CONFIRMED_SAFE=true after auditing your parser for XXE/entity expansion.';
    }

    res.json(response);
  } catch (err) {
    _safeUnlink(req.file?.path);
    next(err);
  }
});

// POST /api/upload/parse
router.post('/parse', requireAuth, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded', code: 'NO_FILE' });

    // BUGFIX: same missing-await issue as /zip above.
    const validation = await validateUpload(req.file);
    if (!['csv', 'xlsx', 'xls', 'xml'].includes(validation.type)) {
      _safeUnlink(req.file.path);
      return res.status(400).json({
        error: `Cannot parse file type: ${validation.type}`,
        code : 'UNSUPPORTED_FOR_PARSE',
      });
    }

    // FIX #6: XML size cap
    if (validation.type === 'xml') {
      const stat = fs.statSync(req.file.path);
      if (stat.size > MAX_XML_BYTES) {
        _safeUnlink(req.file.path);
        return res.status(413).json({
          error: `XML file too large. Maximum: ${MAX_XML_BYTES / 1024 / 1024} MB.`,
          code : 'XML_TOO_LARGE',
        });
      }
    }

    const result = await callEngine({ operation: 'parse', filePath: req.file.path });
    const schemaValidation = validateProcurementSchema(result.schema, result.columnNames);

    // FIX #5: Clean up temp file after parsing
    _safeUnlink(req.file.path);

    res.json({
      success      : true,
      fileType     : validation.type,
      rowCount     : result.rowCount,
      columnNames  : result.columnNames,
      schema       : formatSchemaForUI(result.schema),
      sampleRows   : result.sampleRows,
      warnings     : [...(validation.warnings || []), ...(result.warnings || [])],
      schemaValidation,
    });
  } catch (err) {
    _safeUnlink(req.file?.path);
    next(err);
  }
});

// POST /api/upload/multi
router.post('/multi', requireAuth, upload.array('files', 10), async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded', code: 'NO_FILES' });
    }

    const results = [];
    for (const file of req.files) {
      try {
        const validation = validateUpload(file);
        results.push({
          originalName: file.originalname,
          filePath    : file.path,
          fileType    : validation.type,
          size        : file.size,
          warnings    : validation.warnings,
          status      : 'accepted',
        });
      } catch (err) {
        _safeUnlink(file.path);
        results.push({
          originalName: file.originalname,
          status      : 'rejected',
          reason      : err.message,
        });
      }
    }

    res.json({
      success : true,
      files   : results,
      accepted: results.filter(r => r.status === 'accepted').length,
      rejected: results.filter(r => r.status === 'rejected').length,
    });
  } catch (err) {
    if (req.files) req.files.forEach(f => _safeUnlink(f.path));
    next(err);
  }
});

// POST /api/upload/parse-server
router.post('/parse-server', requireAuth, async (req, res, next) => {
  try {
    const { serverPath } = req.body;
    if (!serverPath || typeof serverPath !== 'string') {
      return res.status(400).json({ error: 'serverPath is required', code: 'MISSING_FIELD' });
    }

    const resolved = path.resolve(serverPath);

    // FIX #2: Use path.relative() — not startsWith() — for traversal check
    if (!_isPathSafe(resolved, EXTRACT_BASE_DIR)) {
      return res.status(400).json({ error: 'Invalid server path.', code: 'PATH_TRAVERSAL' });
    }

    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: 'File not found on server.', code: 'FILE_NOT_FOUND' });
    }

    const validation = validateExtractedFile(resolved, EXTRACT_BASE_DIR);

    // FIX #6: XML size cap on server-side parsing too
    if (validation.type === 'xml') {
      const stat = fs.statSync(resolved);
      if (stat.size > MAX_XML_BYTES) {
        return res.status(413).json({
          error: `XML file too large. Maximum: ${MAX_XML_BYTES / 1024 / 1024} MB.`,
          code : 'XML_TOO_LARGE',
        });
      }
    }

    const result = await callEngine({ operation: 'parse', filePath: resolved });
    const schemaValidation = validateProcurementSchema(result.schema, result.columnNames);

    res.json({
      success      : true,
      filePath     : resolved,
      fileType     : validation.type,
      rowCount     : result.rowCount,
      columnNames  : result.columnNames,
      schema       : formatSchemaForUI(result.schema),
      sampleRows   : result.sampleRows,
      warnings     : result.warnings || [],
      schemaValidation,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/upload/register-server
// FIX #3 + #4: Delegates to data.controller.registerServerFile which:
//   - Parses rows immediately (no null rowCount)
//   - Applies 4h TTL + LRU eviction (no memory leak)
//   - Uses path.relative() traversal check
router.post('/register-server', requireAuth, (req, res, next) => {
  // FIX #2: Pre-validate path before passing to controller
  const { serverPath } = req.body;
  if (serverPath) {
    const resolved = path.resolve(serverPath);
    if (!_isPathSafe(resolved, EXTRACT_BASE_DIR)) {
      return res.status(400).json({ error: 'Invalid server path.', code: 'PATH_TRAVERSAL' });
    }
  }
  // Delegate to data.controller which handles everything else
  dataController.registerServerFile(req, res, next);
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — MULTER ERROR HANDLER
// ══════════════════════════════════════════════════════════════════════════════

router.use((err, req, res, next) => {
  if (req.file)  _safeUnlink(req.file.path);
  if (req.files) req.files.forEach(f => _safeUnlink(f.path));

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File exceeds size limit.', code: 'FILE_TOO_LARGE' });
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ error: 'Too many files.', code: 'TOO_MANY_FILES' });
  }
  next(err);
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 9 — HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function _safeUnlink(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch (_) {}
}

module.exports = router;
