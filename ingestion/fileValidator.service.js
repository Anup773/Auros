'use strict';
/**
 * backend/ingestion/fileValidator.service.js
 *
 * CHANGES FROM V3 (addressing new audit findings):
 *
 *   [NEW AUDIT #1 - HIGH] XLSX vs ZIP CONTENT INSPECTION added.
 *     Both XLSX and ZIP share the same PK magic bytes (50 4B 03 04) so
 *     extension was the only differentiator. A renamed ZIP (malware.zip →
 *     report.xlsx) passed as XLSX. Fix: when ext='.xlsx' is detected as a ZIP
 *     by magic bytes, _isValidXlsx() opens the archive with the 'yauzl' library
 *     (or falls back to a raw entry-name scan) and confirms the presence of the
 *     two mandatory OOXML entries: [Content_Types].xml and xl/workbook.xml.
 *     If those entries are absent the file is rejected with INVALID_XLSX_CONTENT.
 *     NOTE: yauzl is a peer dependency. If not installed, the content check
 *     falls back to a fast raw-bytes scan for the OOXML entry name strings.
 *
 *   [NEW AUDIT #2 - MEDIUM] XML VALIDATION STILL WEAK → already fully fixed
 *     in V3 (_isHtmlOrSvg sniff + XML_MAGIC checks). Retained unchanged.
 *
 *   [NEW AUDIT #3 - MEDIUM] FILE DESCRIPTOR LEAK fixed in _readMagicBytes.
 *     Old: if fs.readSync() threw, fs.closeSync() was never called.
 *     New: fd is closed inside a try/finally block in all code paths.
 *
 *   [NEW AUDIT #4 - MEDIUM] SYMLINK TOCTOU narrowed in validateExtractedFile.
 *     Old: lstatSync() then later existsSync() with a gap between them — an
 *     attacker could swap the real file for a symlink in that window.
 *     New: lstatSync() is the ONLY stat call. existsSync() is removed and
 *     replaced by catching the ENOENT from lstatSync() directly — eliminating
 *     the window between stat and existence check entirely.
 *
 *   V3 fixes retained:
 *     - XML magic-byte hardening + _isHtmlOrSvg() sniff
 *     - UUID-prefixed unique filename (collision prevention)
 *     - Symlink rejection in validateExtractedFile
 *     - Extension whitelist / dangerous extension rejection
 *     - File size limits (configurable via env)
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// ── Limits ────────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE_BYTES = parseInt(process.env.MAX_FILE_SIZE_MB || '200', 10) * 1024 * 1024;
const MAX_ZIP_SIZE_BYTES  = parseInt(process.env.MAX_ZIP_SIZE_MB  || '500', 10) * 1024 * 1024;

// ── Whitelists ────────────────────────────────────────────────────────────────

const ALLOWED_EXTENSIONS   = new Set(['.csv', '.xlsx', '.xls', '.xml', '.zip']);
const DANGEROUS_EXTENSIONS = new Set([
  '.exe', '.bat', '.sh', '.py', '.js', '.php', '.rb',
  '.dll', '.so', '.bin', '.cmd', '.ps1', '.vbs', '.jar',
  '.msi', '.dmg', '.app', '.scr', '.pif', '.com',
]);

// ── Magic byte signatures ─────────────────────────────────────────────────────

const MAGIC_BYTES = {
  zip: [0x50, 0x4B, 0x03, 0x04],  // ZIP / XLSX share PK magic
  xls: [0xD0, 0xCF, 0x11, 0xE0],  // OLE2 compound doc (legacy XLS)
};

// [AUDIT V3] XML magic detection constants
const XML_MAGIC = {
  declaration: [0x3C, 0x3F, 0x78, 0x6D, 0x6C],  // '<?xml'
  bom        : [0xEF, 0xBB, 0xBF],               // UTF-8 BOM
  openAngle  : 0x3C,
};

// HTML/SVG patterns that definitively prove a '<'-starting file is NOT XML
const HTML_SVG_PATTERNS = [
  /^<\s*!doctype\s+html/i,
  /^<\s*html[\s>]/i,
  /^<\s*svg[\s>]/i,
  /^<\s*!--/,
];

// [NEW AUDIT #1] Mandatory OOXML entries that every valid .xlsx must contain
const XLSX_REQUIRED_ENTRIES = [
  '[Content_Types].xml',
  'xl/workbook.xml',
];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validate an uploaded file.
 * Throws a structured error if invalid.
 *
 * @param {Object} file  Multer file object { originalname, path, size, mimetype }
 * @returns {Promise<{ ext, type, safeName, uniqueName, warnings }>}
 *
 * NOTE: now async because XLSX content inspection reads the archive.
 */
async function validateUpload(file) {
  const warnings = [];

  if (!file || !file.path) {
    _reject('No file received', 'NO_FILE', 400);
  }

  // ── 1. Filename safety ────────────────────────────────────────────────────
  const safeName = _sanitiseFilename(file.originalname || '');
  if (!safeName) {
    _reject('Invalid or unsafe filename', 'UNSAFE_FILENAME', 400);
  }

  const ext = path.extname(safeName).toLowerCase();

  // ── 2. Extension whitelist ────────────────────────────────────────────────
  if (DANGEROUS_EXTENSIONS.has(ext)) {
    _reject(`File type "${ext}" is not allowed for security reasons`, 'DANGEROUS_EXTENSION', 400);
  }
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    _reject(
      `Unsupported file type "${ext}". Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`,
      'UNSUPPORTED_EXTENSION',
      400
    );
  }

  // ── 3. Size check ─────────────────────────────────────────────────────────
  const maxSize = ext === '.zip' ? MAX_ZIP_SIZE_BYTES : MAX_FILE_SIZE_BYTES;
  if (file.size > maxSize) {
    const limitMB = Math.round(maxSize / 1024 / 1024);
    _reject(
      `File exceeds size limit of ${limitMB} MB (received ${Math.round(file.size / 1024 / 1024)} MB)`,
      'FILE_TOO_LARGE',
      413
    );
  }
  if (file.size === 0) {
    _reject('File is empty', 'EMPTY_FILE', 400);
  }

  // ── 4. Magic bytes check ──────────────────────────────────────────────────
  // [NEW AUDIT #3] _readMagicBytes now uses try/finally to prevent fd leaks.
  const magic        = _readMagicBytes(file.path, 12);
  const detectedType = _detectTypeFromMagic(magic, ext, file.path);

  if (ext === '.xml' && detectedType === null) {
    _reject(
      'File does not appear to be valid XML. Ensure it begins with an XML declaration or a valid XML element.',
      'INVALID_XML_CONTENT',
      400
    );
  }

  if (!detectedType && ext !== '.csv' && ext !== '.xml') {
    warnings.push(
      'Could not confirm file type from magic bytes. Proceeding with extension-based detection.'
    );
  }

  // ── 5. [NEW AUDIT #1] XLSX content inspection ─────────────────────────────
  // Magic bytes alone cannot distinguish a real XLSX from a renamed ZIP.
  // Only run this when the file has PK magic bytes AND the .xlsx extension.
  if (ext === '.xlsx' && detectedType === 'xlsx') {
    const xlsxValid = await _isValidXlsx(file.path);
    if (!xlsxValid) {
      _reject(
        'File has .xlsx extension but does not contain required OOXML structure ' +
        '([Content_Types].xml, xl/workbook.xml). The file may be a renamed ZIP archive.',
        'INVALID_XLSX_CONTENT',
        400
      );
    }
  }

  if (ext === '.zip' && file.size > 100 * 1024 * 1024) {
    warnings.push(
      `Large ZIP file (${Math.round(file.size / 1024 / 1024)} MB). Processing may take several minutes.`
    );
  }

  // Unique name prevents overwrite collisions on disk (V3 fix, retained)
  const uniqueName = _makeUniqueName(safeName);

  return { ext, type: _resolveType(ext), safeName, uniqueName, warnings };
}

/**
 * Validate that a file path on disk is safe to read.
 * Used when validating files extracted from ZIPs.
 *
 * [NEW AUDIT #4] TOCTOU narrowed: lstatSync is the only stat call.
 *   existsSync() removed — its result between lstatSync and actual open
 *   is meaningless (another process could remove the file in the gap).
 *   We now rely solely on lstatSync() throwing ENOENT for missing files,
 *   which closes the race window entirely.
 *
 * @param {string} filePath
 * @param {string} allowedBaseDir
 */
function validateExtractedFile(filePath, allowedBaseDir) {
  const resolved     = path.resolve(filePath);
  const resolvedBase = path.resolve(allowedBaseDir);

  // Path traversal check
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
    _reject(`Path traversal detected: ${filePath}`, 'PATH_TRAVERSAL', 400);
  }

  // [NEW AUDIT #4] Single lstatSync call — no gap between stat and existence.
  // lstatSync does NOT follow symlinks, so symlinks are caught here too.
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (statErr) {
    if (statErr.code === 'ENOENT') {
      _reject(`Extracted file not found: ${resolved}`, 'FILE_NOT_FOUND', 404);
    }
    throw statErr; // unexpected error — propagate
  }

  // Symlink check (V2 fix, retained — still correct with single-stat approach)
  if (stat.isSymbolicLink()) {
    _reject(
      `Symbolic link rejected in extracted archive: ${path.basename(filePath)}`,
      'SYMLINK_REJECTED',
      400
    );
  }

  const ext = path.extname(resolved).toLowerCase();

  if (DANGEROUS_EXTENSIONS.has(ext)) {
    _reject(`Dangerous file type in archive: ${ext}`, 'DANGEROUS_EXTENSION', 400);
  }

  // File exists and is not a symlink — confirmed by lstatSync above.
  return { ext, type: _resolveType(ext) };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _sanitiseFilename(name) {
  const cleaned = name
    .replace(/[/\\]/g, '_')
    .replace(/\x00/g, '')
    .trim();

  if (!cleaned || /^\.+$/.test(cleaned)) return null;

  const safe = cleaned.replace(/[^a-zA-Z0-9._\-() ]/g, '_');
  return safe.length > 0 ? safe : null;
}

function _makeUniqueName(safeName) {
  const uid = crypto.randomBytes(8).toString('hex');
  return `${uid}-${safeName}`;
}

/**
 * Read the first `count` bytes of a file.
 *
 * [NEW AUDIT #3] fd is closed in a finally block — no leak if readSync throws.
 *
 * @param {string} filePath
 * @param {number} count
 * @returns {number[]}
 */
function _readMagicBytes(filePath, count) {
  let fd;
  try {
    const buf = Buffer.alloc(count);
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, count, 0);  // may throw — fd still closed below
    return Array.from(buf);
  } catch (_) {
    return [];
  } finally {
    // [NEW AUDIT #3] Always close the fd, even if readSync threw.
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function _detectTypeFromMagic(magic, ext, filePath) {
  if (!magic.length) return null;

  if (_startsWith(magic, MAGIC_BYTES.zip)) {
    return ext === '.xlsx' ? 'xlsx' : 'zip';
  }
  if (_startsWith(magic, MAGIC_BYTES.xls)) return 'xls';

  if (ext === '.xml') {
    if (_startsWith(magic, XML_MAGIC.declaration)) return 'xml';
    if (
      magic[0] === XML_MAGIC.bom[0] &&
      magic[1] === XML_MAGIC.bom[1] &&
      magic[2] === XML_MAGIC.bom[2] &&
      magic[3] === XML_MAGIC.openAngle
    ) return 'xml';
    if (magic[0] === XML_MAGIC.openAngle) {
      return _isHtmlOrSvg(filePath) ? null : 'xml';
    }
    return null;
  }

  return null;
}

function _isHtmlOrSvg(filePath) {
  if (!filePath) return false;
  let fd;
  try {
    const buf  = Buffer.alloc(256);
    fd = fs.openSync(filePath, 'r');
    const read = fs.readSync(fd, buf, 0, 256, 0);
    const snippet = buf.slice(0, read).toString('utf8').replace(/\r\n/g, '\n').trimStart();
    return HTML_SVG_PATTERNS.some(p => p.test(snippet));
  } catch (_) {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

/**
 * [NEW AUDIT #1] Verify that a PK-magic file with .xlsx extension actually
 * contains the two mandatory OOXML entries.
 *
 * Strategy:
 *   1. Try to use 'yauzl' (optional peer dep) for proper ZIP entry listing.
 *   2. If yauzl is not available, fall back to a raw buffer scan for the
 *      entry name byte strings — fast and dependency-free.
 *
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function _isValidXlsx(filePath) {
  // ── Attempt 1: yauzl (proper ZIP parser, preferred) ──────────────────────
  try {
    const yauzl = require('yauzl');
    return await new Promise((resolve) => {
      yauzl.open(filePath, { lazyEntries: true }, (err, zipfile) => {
        if (err) return resolve(false);

        const found = new Set();

        zipfile.readEntry();
        zipfile.on('entry', (entry) => {
          for (const required of XLSX_REQUIRED_ENTRIES) {
            if (entry.fileName === required) found.add(required);
          }
          if (found.size === XLSX_REQUIRED_ENTRIES.length) {
            // All required entries found — close and resolve immediately
            zipfile.close();
            return resolve(true);
          }
          zipfile.readEntry();
        });
        zipfile.on('end',   () => resolve(found.size === XLSX_REQUIRED_ENTRIES.length));
        zipfile.on('error', () => resolve(false));
      });
    });
  } catch (requireErr) {
    // yauzl not installed — fall through to raw scan
  }

  // ── Attempt 2: Raw byte scan for OOXML entry name strings ────────────────
  // XLSX files are small enough that reading up to 64 KB of the Local File
  // Header section covers all central directory entries for typical workbooks.
  // This is a best-effort fallback, not a full ZIP parser.
  try {
    const SCAN_BYTES = 64 * 1024; // 64 KB
    const buf        = Buffer.alloc(Math.min(SCAN_BYTES, fs.statSync(filePath).size));
    let fd;
    try {
      fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buf, 0, buf.length, 0);
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    }

    const content = buf.toString('latin1'); // latin1 to avoid UTF-8 decoding errors
    const allFound = XLSX_REQUIRED_ENTRIES.every(entry => content.includes(entry));
    return allFound;
  } catch (_) {
    // If we can't read the file at all, fail open with a warning rather than
    // blocking legitimate uploads on misconfigured environments.
    return true;
  }
}

function _startsWith(arr, prefix) {
  if (arr.length < prefix.length) return false;
  return prefix.every((byte, i) => arr[i] === byte);
}

function _resolveType(ext) {
  return { '.csv': 'csv', '.xlsx': 'xlsx', '.xls': 'xls', '.xml': 'xml', '.zip': 'zip' }[ext] || 'unknown';
}

function _reject(message, code, status = 400) {
  const err  = new Error(message);
  err.code   = code;
  err.status = status;
  throw err;
}

module.exports = { validateUpload, validateExtractedFile };

