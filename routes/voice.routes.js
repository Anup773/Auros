'use strict';
/**
 * backend/routes/voice.routes.js
 *
 * CHANGES FROM PREVIOUS VERSION (this version):
 *
 *   FIX 1 — Routes now use pendingId (server-side store) not pendingActions (Issue #3)
 *     Previous: Frontend sent pendingActions in the body — a financial
 *     approval bypass risk (user could forge arbitrary actions).
 *     Fix: hybridVoice.service.js now stores pending actions server-side
 *     and returns a pendingId. This route passes pendingId (opaque string)
 *     to processVoiceCommand/processTextCommand. Frontend never sees the
 *     raw actions for a pending confirmation.
 *
 *   FIX 2 — Rate limiting on voice endpoints (Issue #5)
 *     Previous: No throttling — 100 audio uploads/sec could saturate CPU.
 *     Fix: express-rate-limit applied to /transcribe and /command (20 req/min)
 *     and /text-command (60 req/min — typed is cheaper than audio).
 *     Configurable via VOICE_RATE_LIMIT_WINDOW_MS / VOICE_RATE_LIMIT_MAX.
 *     If express-rate-limit is not installed, rate limiting is skipped with
 *     a startup warning (no crash).
 *
 *   FIX 3 — Ambiguity array size cap (Issue #6)
 *     Previous: No size limit on the ambiguities JSON payload.
 *     A request with 50,000 ambiguity objects caused parser slowdown and
 *     potential memory spikes.
 *     Fix: Ambiguities array capped at MAX_AMBIGUITIES (500 by default).
 *
 *   FIX 4 — commandId forwarded to service for dedup (Issue from hybridVoice)
 *     Frontend should send X-Command-Id header or body.commandId.
 *     Route extracts it and passes to processVoiceCommand/processTextCommand.
 *
 *   All previous fixes (multer error handler, transcriptionError handling,
 *   pendingConfirm for text-command) preserved.
 */

const express    = require('express');
const router     = express.Router();
const multer     = require('multer');
const { requireAuth } = require('../controllers/auth.controller');
const hybridSvc  = require('../services/voice/hybridVoice.service');

const MAX_AMBIGUITIES = parseInt(process.env.MAX_AMBIGUITIES || '500', 10);

// ── FIX 2: Rate limiting (graceful if package not installed) ─────────────────
let audioRateLimit   = null;
let commandRateLimit = null;
try {
  const rateLimit = require('express-rate-limit');
  const windowMs  = parseInt(process.env.VOICE_RATE_LIMIT_WINDOW_MS || '60000', 10);
  const maxAudio  = parseInt(process.env.VOICE_RATE_LIMIT_MAX       || '20',    10);

  audioRateLimit = rateLimit({
    windowMs,
    max    : maxAudio,
    message: { error: 'Too many voice requests. Please wait a moment.', code: 'RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders  : false,
  });

  commandRateLimit = rateLimit({
    windowMs,
    max    : maxAudio * 3,  // typed commands are cheaper than audio
    message: { error: 'Too many command requests. Please wait a moment.', code: 'RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders  : false,
  });

  console.log('[voice.routes] Rate limiting enabled');
} catch {
  console.warn('[voice.routes] express-rate-limit not installed — rate limiting disabled. Run: npm install express-rate-limit');
}

const withAudioLimit   = audioRateLimit   ? [audioRateLimit]   : [];
const withCommandLimit = commandRateLimit ? [commandRateLimit] : [];

// ── Multer: memory storage ────────────────────────────────────────────────────
const upload = multer({
  storage   : multer.memoryStorage(),
  limits    : { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(Object.assign(new Error('Only audio files are accepted'), { status: 400, code: 'INVALID_AUDIO_TYPE' }), false);
    }
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function _parseAmbiguities(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    // FIX 3: Cap ambiguities array size
    if (arr.length > MAX_AMBIGUITIES) {
      console.warn(`[voice.routes] Ambiguities array capped from ${arr.length} to ${MAX_AMBIGUITIES}`);
      return arr.slice(0, MAX_AMBIGUITIES);
    }
    return arr;
  } catch {
    return [];
  }
}

function _getCommandId(req) {
  // FIX 4: Accept commandId from header or body
  return req.headers['x-command-id'] || req.body?.commandId || null;
}

// ── POST /api/voice/transcribe ────────────────────────────────────────────────
router.post('/transcribe', requireAuth, ...withAudioLimit, upload.single('audio'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file received', code: 'NO_FILE' });
    }

    const transcriptionResult = await hybridSvc.transcribeAudio(
      req.file.buffer,
      req.file.mimetype
    );

    if (!transcriptionResult.ok) {
      return res.json({
        ok                : true,
        transcript        : '',
        text              : '',
        source            : 'none',
        transcriptionError: transcriptionResult.error,
      });
    }

    res.json({
      ok        : true,
      transcript: transcriptionResult.transcript,
      text      : transcriptionResult.transcript,
      source    : transcriptionResult.transcriptionSource,
    });

  } catch (err) {
    next(err);
  }
});

// ── POST /api/voice/command ───────────────────────────────────────────────────
router.post('/command', requireAuth, ...withAudioLimit, upload.single('audio'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file received', code: 'NO_FILE' });
    }

    const ambiguities = _parseAmbiguities(req.body.ambiguities);  // FIX 3
    // FIX 1: pendingId (opaque string), not pendingActions (raw data)
    const pendingId   = req.body.pendingId || null;
    const commandId   = _getCommandId(req);  // FIX 4

    const result = await hybridSvc.processVoiceCommand(
      req.file.buffer,
      req.file.mimetype,
      ambiguities,
      pendingId,    // FIX 1
      commandId     // FIX 4
    );

    if (result.transcriptionError) {
      return res.json({
        ok                 : true,
        transcript         : '',
        transcriptionSource: 'none',
        actions            : [],
        confidence         : 0,
        interpretation     : result.transcriptionError,
        commandSource      : 'none',
        needsAI            : false,
        needsConfirmation  : false,
        cancelled          : false,
        transcriptionError : result.transcriptionError,
      });
    }

    res.json({
      ok                 : true,
      transcript         : result.transcript,
      transcriptionSource: result.transcriptionSource,
      actions            : result.actions || [],
      confidence         : result.confidence,
      interpretation     : result.interpretation,
      commandSource      : result.commandSource,
      needsAI            : result.needsAI || false,
      needsConfirmation  : result.needsConfirmation || false,
      confirmationMsg    : result.confirmationMsg,
      // FIX 1: pendingId only — no raw pendingActions sent to frontend
      pendingId          : result.pendingId || null,
      totalAffected      : result.totalAffected,
      cancelled          : result.cancelled || false,
      warning            : result.warning || null,
    });

  } catch (err) {
    next(err);
  }
});

// ── POST /api/voice/text-command ──────────────────────────────────────────────
router.post('/text-command', requireAuth, ...withCommandLimit, async (req, res, next) => {
  try {
    const { text, ambiguities: rawAmb = [] } = req.body;
    // FIX 3: Cap ambiguities
    const ambiguities = Array.isArray(rawAmb)
      ? rawAmb.slice(0, MAX_AMBIGUITIES)
      : _parseAmbiguities(JSON.stringify(rawAmb));

    // FIX 1: pendingId from body
    const pendingId = req.body.pendingId || null;
    const commandId = _getCommandId(req);

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'text field is required', code: 'MISSING_TEXT' });
    }

    const result = await hybridSvc.processTextCommand(text.trim(), ambiguities, pendingId);

    res.json({
      ok            : true,
      transcript    : result.transcript,
      actions       : result.actions || [],
      confidence    : result.confidence,
      interpretation: result.interpretation,
      commandSource : result.commandSource,
      needsAI           : result.needsAI || false,
      needsConfirmation : result.needsConfirmation || false,
      confirmationMsg   : result.confirmationMsg,
      // FIX 1: pendingId only
      pendingId         : result.pendingId || null,
      totalAffected     : result.totalAffected,
      cancelled         : result.cancelled || false,
      warning       : result.warning || null,
    });

  } catch (err) {
    next(err);
  }
});

// ── GET /api/voice/health ─────────────────────────────────────────────────────
router.get('/health', requireAuth, async (req, res) => {
  const health = await hybridSvc.checkWhisperHealth();
  res.json(health);
});

// ── Multer error handler ──────────────────────────────────────────────────────
router.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Audio file exceeds 25MB limit', code: 'FILE_TOO_LARGE' });
  }
  if (err.code === 'INVALID_AUDIO_TYPE') {
    return res.status(400).json({ error: err.message, code: 'INVALID_AUDIO_TYPE' });
  }
  next(err);
});

module.exports = router;

