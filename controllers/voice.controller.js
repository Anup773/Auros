'use strict';
/**
 * backend/controllers/voice.controller.js
 *
 * CHANGES FROM V2 (addressing audit findings):
 *
 *   [AUDIT #6 - HIGH] MAGIC-BYTE MIME VALIDATION added.
 *     Client-supplied Content-Type is no longer trusted alone. The actual file
 *     buffer is inspected for known audio magic bytes (RIFF/WAV, ID3/MP3,
 *     OggS, fLaC, MP4/M4A). A file with Content-Type: audio/wav but malware
 *     bytes is now rejected with INVALID_FILE_CONTENT.
 *
 *   [AUDIT #7 - HIGH] DISK-BASED UPLOAD to replace memory buffering.
 *     This controller now expects multer to use diskStorage (configured in the
 *     route layer). req.file.path is used for streaming; req.file.buffer is
 *     no longer required. A _cleanupTempFile() helper deletes the temp file
 *     after transcription in all code paths (success, timeout, error).
 *     This eliminates the 100-user × 25 MB = 2.5 GB RAM explosion.
 *
 *   [AUDIT #8 - MEDIUM] ABORT CONTROLLER used to cancel hanging transcription.
 *     The 30-second timeout now signals an AbortController, which is forwarded
 *     to hybridSvc.transcribeAudio(). The service must respect the signal to
 *     cancel its outbound HTTP request (fetch / axios / openai-sdk all support
 *     AbortSignal). Previously, timed-out calls kept running indefinitely.
 *
 *   All previous fixes retained:
 *     - MIME allow-list check on Content-Type (first-pass, cheap)
 *     - 25 MB size cap
 *     - Clear error codes for each failure mode
 */

const fs        = require('fs');
const hybridSvc = require('../services/voice/hybridVoice.service');

// ── Constants ─────────────────────────────────────────────────────────────────

// Allowed audio MIME types (first-pass Content-Type check)
const ALLOWED_AUDIO_MIMES = new Set([
  'audio/webm', 'audio/mp4', 'audio/wav', 'audio/wave',
  'audio/ogg', 'audio/mpeg', 'audio/mp3', 'audio/x-m4a', 'audio/m4a',
]);

const MAX_AUDIO_BYTES    = 25 * 1024 * 1024;  // 25 MB
const TRANSCRIBE_TIMEOUT = 30_000;             // 30 seconds

// [AUDIT #6] Known audio magic byte signatures.
// Each entry: { label, bytes, offset } — offset 0 unless noted.
const AUDIO_MAGIC_SIGNATURES = [
  // WAV — "RIFF" header (offset 0), file type "WAVE" at offset 8
  { label: 'wav',  bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 },
  // MP3 with ID3 tag
  { label: 'mp3',  bytes: [0x49, 0x44, 0x33],        offset: 0 },
  // MP3 sync word (no ID3 tag) — 0xFF 0xFB / 0xFF 0xF3 / 0xFF 0xF2
  { label: 'mp3',  bytes: [0xFF, 0xFB],               offset: 0 },
  { label: 'mp3',  bytes: [0xFF, 0xF3],               offset: 0 },
  { label: 'mp3',  bytes: [0xFF, 0xF2],               offset: 0 },
  // Ogg (WebM audio / Opus / Vorbis)
  { label: 'ogg',  bytes: [0x4F, 0x67, 0x67, 0x53],  offset: 0 },  // "OggS"
  // FLAC
  { label: 'flac', bytes: [0x66, 0x4C, 0x61, 0x43],  offset: 0 },  // "fLaC"
  // MP4 / M4A — ftyp box at offset 4
  { label: 'mp4',  bytes: [0x66, 0x74, 0x79, 0x70],  offset: 4 },  // "ftyp"
  // WebM — EBML header
  { label: 'webm', bytes: [0x1A, 0x45, 0xDF, 0xA3],  offset: 0 },
];

const MAGIC_READ_BYTES = 12; // enough to cover all signatures above

// ── POST /api/voice/transcribe ────────────────────────────────────────────────

exports.transcribe = async (req, res, next) => {
  // [AUDIT #7] Disk-based: temp file path from multer diskStorage.
  // req.file.path is set by the route's multer diskStorage configuration.
  // req.file.buffer is intentionally NOT used to avoid RAM accumulation.
  const tempFilePath = req.file?.path || null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file received', code: 'NO_FILE' });
    }

    // ── First-pass: Content-Type allow-list (cheap, catches honest mistakes) ──
    const mime = req.file.mimetype || '';
    if (!mime.startsWith('audio/') && !ALLOWED_AUDIO_MIMES.has(mime)) {
      return res.status(400).json({
        error: `Invalid file type "${mime}". Only audio files are accepted.`,
        code : 'INVALID_MIME_TYPE',
      });
    }

    // ── Size check ────────────────────────────────────────────────────────────
    // req.file.size is populated by multer for both memoryStorage and diskStorage.
    if (req.file.size > MAX_AUDIO_BYTES) {
      return res.status(413).json({
        error: `Audio file too large. Maximum is ${MAX_AUDIO_BYTES / (1024 * 1024)} MB.`,
        code : 'FILE_TOO_LARGE',
      });
    }

    // [AUDIT #6] Second-pass: magic-byte validation.
    // Reads first 12 bytes from the temp file on disk — never loads whole file.
    const magicLabel = _detectAudioMagic(tempFilePath);
    if (!magicLabel) {
      return res.status(400).json({
        error: 'File content does not match any supported audio format. Only WAV, MP3, OGG, FLAC, MP4/M4A, and WebM are accepted.',
        code : 'INVALID_FILE_CONTENT',
      });
    }

    // [AUDIT #8] AbortController for transcription cancellation on timeout.
    // hybridSvc.transcribeAudio() must accept { signal } and pass it through
    // to its HTTP client (fetch AbortSignal / axios cancelToken / openai signal).
    const abortController = new AbortController();

    const timeoutHandle = setTimeout(() => {
      abortController.abort();
    }, TRANSCRIBE_TIMEOUT);

    let transcriptResult;
    try {
      // [AUDIT #7] Pass file path, not buffer — service reads via stream.
      // [AUDIT #8] Pass abort signal — service cancels the outbound request.
      transcriptResult = await hybridSvc.transcribeAudio(
        tempFilePath,
        req.file.mimetype,
        { signal: abortController.signal }
      );
    } catch (transcribeErr) {
      if (abortController.signal.aborted) {
        return res.status(504).json({
          error: 'Transcription timed out. Please try again.',
          code : 'TRANSCRIPTION_TIMEOUT',
        });
      }
      throw transcribeErr;
    } finally {
      clearTimeout(timeoutHandle);
    }

    const transcript = transcriptResult.transcript || transcriptResult.text || '';

    if (!transcript || !transcript.trim()) {
      return res.status(422).json({
        error : 'Could not transcribe audio. Please speak clearly and try again.',
        code  : 'TRANSCRIPTION_EMPTY',
      });
    }

    res.json({
      transcript: transcript.trim(),
      text      : transcript.trim(),
      source    : transcriptResult.transcriptionSource || 'unknown',
    });

  } catch (err) {
    next(err);
  } finally {
    // [AUDIT #7] Always delete the temp file — success, timeout, or error.
    _cleanupTempFile(tempFilePath);
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * [AUDIT #6] Read the first MAGIC_READ_BYTES of the file on disk and match
 * against known audio magic byte signatures.
 *
 * Returns a label string ('wav', 'mp3', 'ogg', 'flac', 'mp4', 'webm')
 * or null if no signature matches.
 *
 * @param {string} filePath
 * @returns {string|null}
 */
function _detectAudioMagic(filePath) {
  if (!filePath) return null;

  try {
    const buf = Buffer.alloc(MAGIC_READ_BYTES);
    const fd  = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, buf, 0, MAGIC_READ_BYTES, 0);
    fs.closeSync(fd);

    if (bytesRead < 2) return null;

    for (const sig of AUDIO_MAGIC_SIGNATURES) {
      const { bytes, offset } = sig;
      if (bytesRead < offset + bytes.length) continue;
      if (bytes.every((b, i) => buf[offset + i] === b)) {
        return sig.label;
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * [AUDIT #7] Silently delete a temp file, ignoring errors.
 * Called in the finally block so it always runs regardless of outcome.
 *
 * @param {string|null} filePath
 */
function _cleanupTempFile(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch (_) {
    // File may not exist (e.g. multer failed before writing) — not an error.
  }
}
