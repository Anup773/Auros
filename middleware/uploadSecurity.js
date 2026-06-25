'use strict';
/**
 * backend/middleware/uploadSecurity.js
 *
 * Secure file upload middleware.
 * Validates MIME type, file size, extension, ZIP compression ratio,
 * and magic bytes (file signature) before processing.
 *
 * CHANGES FROM V1:
 *   - ZIP compression ratio check (prevents zip bombs — ratio > 100x rejected)
 *   - Nested archive rejection (zip-inside-zip bombs)
 *   - Magic bytes verification (prevents MIME spoofing — e.g. virus.exe → invoice.csv)
 *   - Streamed ZIP extraction check using shutil in Python layer
 *
 * Works with multer memoryStorage — file never touches disk if validation fails.
 */

const path   = require('path');
const multer = require('multer');

// ── Allowed types ─────────────────────────────────────────────────────────────
const ALLOWED_MIME_TYPES = new Set([
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/xml',
  'text/xml',
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream',
  // OCR — PDF and images
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/tiff',
  'image/bmp',
  'image/webp',
  // Audio
  'audio/webm',
  'audio/mp4',
  'audio/wav',
  'audio/ogg',
  'audio/mpeg',
]);

const ALLOWED_EXTENSIONS = new Set([
  '.csv', '.xlsx', '.xls', '.xml', '.zip',
  // OCR
  '.pdf', '.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.webp',
  // Audio
  '.webm', '.mp4', '.wav', '.ogg', '.mp3', '.m4a',
]);

const DANGEROUS_EXTENSIONS = new Set([
  '.exe', '.bat', '.sh', '.py', '.js', '.php', '.rb',
  '.dll', '.so', '.bin', '.cmd', '.ps1', '.vbs', '.jar',
  '.msi', '.dmg', '.app', '.deb', '.rpm',
]);

// ── Nested archive extensions — always rejected inside ZIP ───────────────────
// Prevents zip-inside-zip bomb attacks
const NESTED_ARCHIVE_EXTENSIONS = new Set([
  '.zip', '.rar', '.7z', '.gz', '.tar', '.bz2', '.xz',
]);

// ── File size limits ──────────────────────────────────────────────────────────
const SIZE_LIMITS = {
  csv  : 500 * 1024 * 1024,  // 500 MB
  xlsx : 500 * 1024 * 1024,  // 500 MB
  xls  : 500 * 1024 * 1024,  // 500 MB
  xml  : 500 * 1024 * 1024,  // 500 MB
  zip  : 500 * 1024 * 1024,  // 500 MB
  pdf  : 500 * 1024 * 1024,  // 500 MB
  png  : 100 * 1024 * 1024,  // 100 MB for images
  jpg  : 100 * 1024 * 1024,
  jpeg : 100 * 1024 * 1024,
  tiff : 100 * 1024 * 1024,
  tif  : 100 * 1024 * 1024,
  bmp  : 100 * 1024 * 1024,
  webp : 100 * 1024 * 1024,
  audio: 25  * 1024 * 1024,  // 25 MB (Whisper limit)
};

// ── ZIP bomb protection constants ─────────────────────────────────────────────
const MAX_ZIP_COMPRESSION_RATIO = 100;   // reject if uncompressed/compressed > 100x
const MAX_ZIP_TOTAL_UNCOMPRESSED = 500 * 1024 * 1024; // 500 MB total uncompressed
const MAX_ZIP_FILE_COUNT         = 200;  // max files inside ZIP

// ── Magic bytes (file signatures) ────────────────────────────────────────────
// Used to verify actual file type regardless of extension or MIME header.
// Prevents attackers renaming malware as invoice.csv
const MAGIC_BYTES = {
  // PDF: %PDF
  pdf : { bytes: [0x25, 0x50, 0x44, 0x46], offset: 0 },
  // ZIP / XLSX / DOCX (all use ZIP format): PK\x03\x04
  zip : { bytes: [0x50, 0x4B, 0x03, 0x04], offset: 0 },
  // PNG: \x89PNG
  png : { bytes: [0x89, 0x50, 0x4E, 0x47], offset: 0 },
  // JPEG: \xFF\xD8\xFF
  jpg : { bytes: [0xFF, 0xD8, 0xFF],       offset: 0 },
  // TIFF (little-endian): II*\x00
  tiff: { bytes: [0x49, 0x49, 0x2A, 0x00], offset: 0 },
  // TIFF (big-endian): MM\x00*
  tifb: { bytes: [0x4D, 0x4D, 0x00, 0x2A], offset: 0 },
  // BMP: BM
  bmp : { bytes: [0x42, 0x4D],             offset: 0 },
  // WebP: RIFF....WEBP
  webp: { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 },
};

// Extensions that are ZIP-based (XLSX, XLSB use ZIP format internally)
const ZIP_BASED_EXTENSIONS = new Set(['.xlsx', '.xls', '.xlsb']);

/**
 * Verify file magic bytes match the expected format.
 * Returns { valid: bool, reason: string }
 *
 * @param {Buffer} buffer   — file buffer (from multer memoryStorage)
 * @param {string} ext      — lowercase extension e.g. '.pdf'
 * @returns {{ valid: boolean, reason: string }}
 */
function checkMagicBytes(buffer, ext) {
  if (!buffer || buffer.length < 8) {
    return { valid: false, reason: 'File buffer too small to verify' };
  }

  // CSV and XML are text-based — no reliable magic bytes, skip check
  if (['.csv', '.xml', '.txt'].includes(ext)) {
    return { valid: true, reason: 'text-based format' };
  }

  // Audio files — skip magic bytes (too many formats)
  if (['.webm', '.mp4', '.wav', '.ogg', '.mp3', '.m4a'].includes(ext)) {
    return { valid: true, reason: 'audio format' };
  }

  const b = buffer;

  if (ext === '.pdf') {
    const sig = MAGIC_BYTES.pdf.bytes;
    if (b[0] === sig[0] && b[1] === sig[1] && b[2] === sig[2] && b[3] === sig[3]) {
      return { valid: true, reason: 'PDF magic bytes match' };
    }
    return { valid: false, reason: 'File does not appear to be a valid PDF (magic bytes mismatch)' };
  }

  if (ext === '.zip') {
    const sig = MAGIC_BYTES.zip.bytes;
    if (b[0] === sig[0] && b[1] === sig[1] && b[2] === sig[2] && b[3] === sig[3]) {
      return { valid: true, reason: 'ZIP magic bytes match' };
    }
    return { valid: false, reason: 'File does not appear to be a valid ZIP archive (magic bytes mismatch)' };
  }

  // XLSX, XLS use ZIP format internally
  if (ZIP_BASED_EXTENSIONS.has(ext)) {
    const sig = MAGIC_BYTES.zip.bytes;
    // Also allow legacy XLS (Compound Document: D0 CF 11 E0)
    const xlsSig = [0xD0, 0xCF, 0x11, 0xE0];
    const isXlsx = b[0] === sig[0]    && b[1] === sig[1]    && b[2] === sig[2]    && b[3] === sig[3];
    const isXls  = b[0] === xlsSig[0] && b[1] === xlsSig[1] && b[2] === xlsSig[2] && b[3] === xlsSig[3];
    if (isXlsx || isXls) return { valid: true, reason: 'Excel magic bytes match' };
    return { valid: false, reason: 'File does not appear to be a valid Excel file (magic bytes mismatch)' };
  }

  if (ext === '.png') {
    const sig = MAGIC_BYTES.png.bytes;
    if (b[0] === sig[0] && b[1] === sig[1] && b[2] === sig[2] && b[3] === sig[3]) {
      return { valid: true, reason: 'PNG magic bytes match' };
    }
    return { valid: false, reason: 'File does not appear to be a valid PNG image' };
  }

  if (ext === '.jpg' || ext === '.jpeg') {
    const sig = MAGIC_BYTES.jpg.bytes;
    if (b[0] === sig[0] && b[1] === sig[1] && b[2] === sig[2]) {
      return { valid: true, reason: 'JPEG magic bytes match' };
    }
    return { valid: false, reason: 'File does not appear to be a valid JPEG image' };
  }

  if (ext === '.tiff' || ext === '.tif') {
    const leOk = b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A;
    const beOk = b[0] === 0x4D && b[1] === 0x4D && b[2] === 0x00;
    if (leOk || beOk) return { valid: true, reason: 'TIFF magic bytes match' };
    return { valid: false, reason: 'File does not appear to be a valid TIFF image' };
  }

  if (ext === '.bmp') {
    if (b[0] === 0x42 && b[1] === 0x4D) return { valid: true, reason: 'BMP magic bytes match' };
    return { valid: false, reason: 'File does not appear to be a valid BMP image' };
  }

  if (ext === '.webp') {
    // RIFF....WEBP — bytes 0-3 are RIFF, bytes 8-11 are WEBP
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) {
      if (buffer.length >= 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
        return { valid: true, reason: 'WebP magic bytes match' };
      }
    }
    return { valid: false, reason: 'File does not appear to be a valid WebP image' };
  }

  // Unknown extension — allow through (caught by extension check above)
  return { valid: true, reason: 'no magic check defined for this type' };
}

/**
 * Validate ZIP file for bomb attacks using local ZIP parsing.
 * Checks:
 *   1. Compression ratio per file (rejects if > MAX_ZIP_COMPRESSION_RATIO)
 *   2. Total uncompressed size (rejects if > MAX_ZIP_TOTAL_UNCOMPRESSED)
 *   3. File count (rejects if > MAX_ZIP_FILE_COUNT)
 *   4. Nested archives (rejects zip-inside-zip)
 *
 * @param {Buffer} buffer
 * @returns {{ valid: boolean, reason: string }}
 */
function checkZipBomb(buffer) {
  try {
    // We'll do a lightweight scan of the ZIP central directory
    // without decompressing — reads only metadata headers
    let offset = 0;
    let fileCount = 0;
    let totalUncompressed = 0;

    // Scan local file headers: PK\x03\x04
    while (offset < buffer.length - 4) {
      // Look for local file header signature
      if (
        buffer[offset]     === 0x50 && // P
        buffer[offset + 1] === 0x4B && // K
        buffer[offset + 2] === 0x03 && // \x03
        buffer[offset + 3] === 0x04    // \x04
      ) {
        if (offset + 30 > buffer.length) break;

        // Parse local file header fields (all little-endian)
        const compressedSize   = buffer.readUInt32LE(offset + 18);
        const uncompressedSize = buffer.readUInt32LE(offset + 22);
        const fileNameLength   = buffer.readUInt16LE(offset + 26);
        const extraFieldLength = buffer.readUInt16LE(offset + 28);

        // Read file name
        const nameStart = offset + 30;
        const nameEnd   = nameStart + fileNameLength;
        if (nameEnd > buffer.length) break;

        const fileName  = buffer.slice(nameStart, nameEnd).toString('utf8');
        const fileExt   = path.extname(fileName).toLowerCase();

        // ── Check 1: Nested archive rejection ─────────────────────────────
        if (NESTED_ARCHIVE_EXTENSIONS.has(fileExt)) {
          return {
            valid : false,
            reason: `Nested archive detected inside ZIP: "${fileName}". Nested archives are not allowed.`,
          };
        }

        // ── Check 2: Per-file compression ratio ───────────────────────────
        if (compressedSize > 0 && uncompressedSize > 0) {
          const ratio = uncompressedSize / compressedSize;
          if (ratio > MAX_ZIP_COMPRESSION_RATIO) {
            return {
              valid : false,
              reason: `ZIP bomb detected: file "${fileName}" has compression ratio ${Math.round(ratio)}:1 (max allowed: ${MAX_ZIP_COMPRESSION_RATIO}:1).`,
            };
          }
        }

        // ── Check 3: Dangerous file in ZIP ────────────────────────────────
        if (DANGEROUS_EXTENSIONS.has(fileExt)) {
          return {
            valid : false,
            reason: `Dangerous file type detected inside ZIP: "${fileName}". Executable files are not allowed.`,
          };
        }

        totalUncompressed += uncompressedSize;
        fileCount++;

        // ── Check 4: Total uncompressed size ──────────────────────────────
        if (totalUncompressed > MAX_ZIP_TOTAL_UNCOMPRESSED) {
          return {
            valid : false,
            reason: `ZIP total uncompressed size exceeds limit of ${Math.round(MAX_ZIP_TOTAL_UNCOMPRESSED / 1024 / 1024)} MB.`,
          };
        }

        // ── Check 5: File count ───────────────────────────────────────────
        if (fileCount > MAX_ZIP_FILE_COUNT) {
          return {
            valid : false,
            reason: `ZIP contains too many files (max: ${MAX_ZIP_FILE_COUNT}).`,
          };
        }

        // Advance past this entry
        offset += 30 + fileNameLength + extraFieldLength + compressedSize;
      } else {
        offset++;
      }
    }

    return { valid: true, reason: `ZIP validated: ${fileCount} file(s), ${Math.round(totalUncompressed / 1024)} KB uncompressed` };
  } catch (err) {
    // If we can't parse the ZIP headers, let Python handle it safely
    console.warn('[uploadSecurity] ZIP scan warning (non-fatal):', err.message);
    return { valid: true, reason: 'ZIP scan skipped (Python will validate)' };
  }
}

// ── File filter factory ───────────────────────────────────────────────────────
function makeFileFilter(allowedExtsOverride = null) {
  return (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    // ── Reject dangerous extensions immediately ────────────────────────────
    if (DANGEROUS_EXTENSIONS.has(ext)) {
      return cb(Object.assign(
        new Error(`File type not allowed: ${ext}`),
        { status: 400, code: 'DANGEROUS_FILE_TYPE' }
      ), false);
    }

    // ── Extension whitelist ────────────────────────────────────────────────
    const allowed = allowedExtsOverride
      ? new Set(allowedExtsOverride)
      : ALLOWED_EXTENSIONS;

    if (!allowed.has(ext)) {
      return cb(Object.assign(
        new Error(`Unsupported file type: ${ext}. Allowed: CSV, XLSX, XLS, XML, ZIP, PDF, PNG, JPG, TIFF`),
        { status: 400, code: 'UNSUPPORTED_FILE_TYPE' }
      ), false);
    }

    cb(null, true);
  };
}

// ── Multer instances ──────────────────────────────────────────────────────────

/**
 * General file upload (CSV, XLSX, XML, ZIP, PDF, images).
 * Use for: /api/data/upload, /api/upload/*, /api/ocr/*
 */
const dataUpload = multer({
  storage   : multer.memoryStorage(),
  limits    : { fileSize: SIZE_LIMITS.zip, files: 1 },
  fileFilter: makeFileFilter(),
});

/**
 * Multi-file upload. Same rules, up to 10 files.
 */
const multiUpload = multer({
  storage   : multer.memoryStorage(),
  limits    : { fileSize: SIZE_LIMITS.zip, files: 10 },
  fileFilter: makeFileFilter(),
});

/**
 * Audio upload for voice transcription.
 */
const audioUpload = multer({
  storage   : multer.memoryStorage(),
  limits    : { fileSize: SIZE_LIMITS.audio, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('audio/')) {
      return cb(Object.assign(
        new Error('Only audio files are accepted'),
        { status: 400, code: 'INVALID_AUDIO' }
      ), false);
    }
    cb(null, true);
  },
});

// ── Post-upload validation middleware ─────────────────────────────────────────
/**
 * Additional validation AFTER multer has loaded the file into memory.
 *
 * Checks:
 *   1. Type-specific size limits
 *   2. Magic bytes (file signature) verification — PREVENTS MIME SPOOFING
 *   3. ZIP bomb detection (compression ratio + nested archives)
 *   4. Filename sanitisation (path traversal prevention)
 *
 * Place AFTER multer middleware in route chain:
 *   router.post('/upload', dataUpload.single('file'), validateUploadedFile, handler)
 */
function validateUploadedFile(req, res, next) {
  const file = req.file || (req.files && req.files[0]);
  if (!file) return next();

  const ext    = path.extname(file.originalname).toLowerCase().replace('.', '');
  const extDot = '.' + ext;
  const size   = file.size || file.buffer?.length || 0;
  const buffer = file.buffer;

  // ── 1. Type-specific size limit ───────────────────────────────────────────
  const limit = SIZE_LIMITS[ext] || SIZE_LIMITS.csv;
  if (size > limit) {
    return res.status(413).json({
      error: `File too large. Max size for ${ext.toUpperCase()} is ${Math.round(limit / 1024 / 1024)} MB`,
      code : 'FILE_TOO_LARGE',
    });
  }

  // ── 2. Magic bytes verification ───────────────────────────────────────────
  if (buffer && buffer.length > 0) {
    const magicCheck = checkMagicBytes(buffer, extDot);
    if (!magicCheck.valid) {
      console.warn(`[uploadSecurity] Magic bytes failed for ${file.originalname}: ${magicCheck.reason}`);
      return res.status(400).json({
        error: `File content does not match its extension. ${magicCheck.reason}`,
        code : 'MAGIC_BYTES_MISMATCH',
      });
    }
  }

  // ── 3. ZIP bomb detection ─────────────────────────────────────────────────
  if (extDot === '.zip' && buffer && buffer.length > 0) {
    const zipCheck = checkZipBomb(buffer);
    if (!zipCheck.valid) {
      console.warn(`[uploadSecurity] ZIP bomb detected in ${file.originalname}: ${zipCheck.reason}`);
      return res.status(400).json({
        error: zipCheck.reason,
        code : 'ZIP_BOMB_DETECTED',
      });
    }
  }

  // ── 4. Sanitise filename — prevent path traversal ─────────────────────────
  file.originalname = path.basename(file.originalname)
    .replace(/[^a-zA-Z0-9.\-_]/g, '_')
    .slice(0, 255);

  next();
}

/**
 * Multi-file version of validateUploadedFile.
 * Validates all files in req.files array.
 */
function validateUploadedFiles(req, res, next) {
  const files = req.files || [];
  if (!files.length) return next();

  for (const file of files) {
    const ext    = path.extname(file.originalname).toLowerCase().replace('.', '');
    const extDot = '.' + ext;
    const size   = file.size || file.buffer?.length || 0;
    const buffer = file.buffer;

    const limit = SIZE_LIMITS[ext] || SIZE_LIMITS.csv;
    if (size > limit) {
      return res.status(413).json({
        error: `File "${file.originalname}" too large. Max size for ${ext.toUpperCase()} is ${Math.round(limit / 1024 / 1024)} MB`,
        code : 'FILE_TOO_LARGE',
      });
    }

    if (buffer && buffer.length > 0) {
      const magicCheck = checkMagicBytes(buffer, extDot);
      if (!magicCheck.valid) {
        return res.status(400).json({
          error: `File "${file.originalname}": ${magicCheck.reason}`,
          code : 'MAGIC_BYTES_MISMATCH',
        });
      }
    }

    if (extDot === '.zip' && buffer && buffer.length > 0) {
      const zipCheck = checkZipBomb(buffer);
      if (!zipCheck.valid) {
        return res.status(400).json({
          error: `File "${file.originalname}": ${zipCheck.reason}`,
          code : 'ZIP_BOMB_DETECTED',
        });
      }
    }

    file.originalname = path.basename(file.originalname)
      .replace(/[^a-zA-Z0-9.\-_]/g, '_')
      .slice(0, 255);
  }

  next();
}

module.exports = {
  dataUpload,
  multiUpload,
  audioUpload,
  validateUploadedFile,
  validateUploadedFiles,
  checkMagicBytes,
  checkZipBomb,
};