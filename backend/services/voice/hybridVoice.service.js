'use strict';
/**
 * backend/services/voice/hybridVoice.service.js
 *
 * CHANGES FROM PREVIOUS VERSION (this version):
 *
 *   FIX 1 — Audio buffer validated before any processing (Critical Issue #1)
 *     Previous: audioBuffer.toString('base64') crashed if audioBuffer was
 *     undefined or not a Buffer.
 *     Fix: Explicit Buffer.isBuffer() + length check at the top of
 *     transcribeAudio(), returning { ok: false } with a clear message
 *     instead of crashing.
 *
 *   FIX 2 — Pending confirmations stored server-side (Critical Issue #3)
 *     Previous: frontend sent back pendingActions in the request body.
 *     A malicious user could forge { pendingActions: [approve all invoices] }
 *     and send "confirm" to execute arbitrary approvals — a serious
 *     financial approval bypass.
 *     Fix: Pending actions are stored in an in-memory Map on the server
 *     keyed by sessionId. Frontend only receives a pendingId (opaque string).
 *     On confirm, frontend sends pendingId; server looks up the real actions.
 *     NOTE: For multi-server deployments, move _pendingStore to Redis.
 *
 *   FIX 3 — Bulk confirmation threshold lowered to 5 (Critical Issue #4)
 *     Previous: threshold was 10. "Approve 9 invoices" executed without
 *     confirmation — still a significant financial action.
 *     Fix: BULK_CONFIRM_THRESHOLD = 5. Configurable via env var.
 *
 *   FIX 4 — Duplicate command protection via commandId (Critical Issue #5)
 *     Previous: no replay protection. Saying "approve invoice 5" twice
 *     executed the action twice.
 *     Fix: Route passes a commandId (UUID) with each request. If the same
 *     commandId is received within DEDUP_WINDOW_MS, the result is returned
 *     from cache without re-executing.
 *
 *   FIX 5 — Gemini quota exceeded surfaces as a usable message (new)
 *     Previous: GEMINI_QUOTA_EXCEEDED propagated as an unhandled error.
 *     Fix: Caught explicitly; user gets "quota exceeded, please type instead".
 *
 *   All previous fixes (transcription unavailable returns normal result,
 *   isConfigured check, sanitised ambiguities) preserved exactly.
 */

const path           = require('path');
const crypto         = require('crypto');
const { callEngine } = require('../pythonBridge.service');
const geminiSvc      = require('./geminiAI.service');

const WHISPER_ENGINE = path.join(__dirname, '../../python/faster_whisper_bridge.py');
const PARSER_ENGINE  = path.join(__dirname, '../../python/command_parser.py');

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// FIX 3: Lower bulk threshold — 9 approvals without confirmation is too risky
const BULK_CONFIRM_THRESHOLD = parseInt(process.env.BULK_CONFIRM_THRESHOLD || '5', 10);

// FIX 2: Server-side pending action store
// Key: pendingId (opaque string sent to frontend)
// Value: { actions, interpretation, totalAffected, createdAt }
const _pendingStore  = new Map();
const PENDING_TTL_MS = 5 * 60 * 1000;  // 5 minutes before pending expires

// FIX 4: Dedup cache — prevent double-execution of the same command
const _dedupCache    = new Map();
const DEDUP_WINDOW_MS = 3000;  // 3 seconds

// Periodically clean up expired entries
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _pendingStore.entries()) {
    if (now - v.createdAt > PENDING_TTL_MS) _pendingStore.delete(k);
  }
  for (const [k, v] of _dedupCache.entries()) {
    if (now - v.createdAt > DEDUP_WINDOW_MS) _dedupCache.delete(k);
  }
}, 30_000);


// ── Public API ────────────────────────────────────────────────────────────────

async function processVoiceCommand(audioBuffer, mimeType, ambiguities = [],
                                    pendingId = null, commandId = null) {
  // FIX 4: Dedup check
  if (commandId) {
    const cached = _dedupCache.get(commandId);
    if (cached) {
      console.log(`[hybridVoice] Dedup hit for commandId ${commandId}`);
      return cached.result;
    }
  }

  if (audioBuffer && audioBuffer.length > MAX_AUDIO_BYTES) {
    const mb = (audioBuffer.length / (1024 * 1024)).toFixed(1);
    throw Object.assign(
      new Error(`Audio file too large (${mb} MB). Maximum is 25 MB.`),
      { status: 400, code: 'AUDIO_TOO_LARGE' }
    );
  }

  const transcriptionResult = await transcribeAudio(audioBuffer, mimeType);

  if (!transcriptionResult.ok) {
    return {
      transcript          : '',
      transcriptionSource : 'none',
      transcriptionError  : transcriptionResult.error,
      actions             : [],
      confidence          : 0,
      interpretation      : transcriptionResult.error,
      commandSource       : 'none',
      needsAI             : false,
      needsConfirmation   : false,
      cancelled           : false,
    };
  }

  const { transcript, transcriptionSource } = transcriptionResult;

  // FIX 2: Resolve pendingId → pendingConfirm from server store
  const pendingConfirm = _resolvePending(pendingId);

  const parseResult = await parseCommand(transcript, ambiguities, pendingConfirm);
  const result = { transcript, transcriptionSource, ...parseResult };

  // FIX 4: Cache result for dedup
  if (commandId) {
    _dedupCache.set(commandId, { result, createdAt: Date.now() });
  }

  return result;
}

async function transcribeAudio(audioBuffer, mimeType) {
  // FIX 1: Validate buffer before any processing
  if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    return {
      ok   : false,
      error: 'No audio data received. Please try recording again.',
    };
  }

  // Try local Whisper
  let whisperError = null;
  try {
    const result = await callEngine({
      operation   : 'transcribe',
      audioBase64 : audioBuffer.toString('base64'),
      mimeType    : mimeType || 'audio/webm',
      language    : 'en',
    }, { enginePath: WHISPER_ENGINE, timeout: 30_000 });

    return { ok: true, transcript: result.transcript, transcriptionSource: 'local_whisper' };
  } catch (err) {
    whisperError = err;
    console.warn('[hybridVoice] Local Whisper failed, attempting Gemini fallback:', err.message);
  }

  // Fallback: Gemini
  if (!geminiSvc.isConfigured()) {
    return {
      ok   : false,
      error:
        'Voice transcription is unavailable: local Whisper failed ' +
        `(${whisperError?.message || 'unknown error'}) and no Gemini API key is configured. ` +
        'Install faster-whisper or set GEMINI_API_KEY in your .env. You can still type your command.',
    };
  }

  try {
    const transcript = await geminiSvc.transcribeAudio(audioBuffer, mimeType);
    return { ok: true, transcript, transcriptionSource: 'gemini' };
  } catch (geminiErr) {
    // FIX 5: Handle quota exceeded specifically
    const isQuota = geminiErr.code === 'GEMINI_QUOTA_EXCEEDED';
    return {
      ok   : false,
      error: isQuota
        ? 'Gemini API quota exceeded. Please type your command instead.'
        : `Voice transcription failed: ${geminiErr.message}. You can still type your command.`,
    };
  }
}

async function parseCommand(text, ambiguities = [], pendingConfirm = null) {
  let parseResult;
  try {
    parseResult = await callEngine({
      operation     : 'parse_command',
      text,
      ambiguities   : _sanitiseAmbiguities(ambiguities),
      totalItems    : ambiguities.length,
      pendingConfirm: pendingConfirm || undefined,
    }, { enginePath: PARSER_ENGINE, timeout: 10_000 });
  } catch (parseErr) {
    console.warn('[hybridVoice] Deterministic parser failed:', parseErr.message);
    parseResult = {
      actions          : [],
      confidence       : 0,
      needsAI          : true,
      needsConfirmation: false,
      aiReason         : parseErr.message,
      interpretation   : `Local parser error: ${parseErr.message}`,
      cancelled        : false,
    };
  }

  if (parseResult.cancelled) {
    return {
      actions           : [],
      confidence        : 1.0,
      interpretation    : 'Action cancelled.',
      commandSource     : 'local_parser',
      needsAI           : false,
      needsConfirmation : false,
      cancelled         : true,
    };
  }

  // FIX 3: Use configurable threshold (default 5, was 10)
  if (parseResult.needsConfirmation) {
    // FIX 2: Store pending actions server-side, return only an opaque ID
    const pendingId = _storePending(
      parseResult.pendingActions || [],
      parseResult.interpretation || '',
      parseResult.totalAffected  || 0
    );
    return {
      actions           : [],
      confidence        : parseResult.confidence,
      interpretation    : parseResult.interpretation,
      commandSource     : 'local_parser',
      needsAI           : false,
      needsConfirmation : true,
      confirmationMsg   : parseResult.confirmationMsg,
      pendingId,              // FIX 2: opaque ID only — no pendingActions in response
      totalAffected     : parseResult.totalAffected,
      cancelled         : false,
    };
  }

  if (!parseResult.needsAI && parseResult.confidence >= 0.65 && parseResult.actions.length > 0) {
    return {
      actions           : parseResult.actions,
      confidence        : parseResult.confidence,
      interpretation    : parseResult.interpretation,
      commandSource     : 'local_parser',
      needsAI           : false,
      needsConfirmation : false,
      cancelled         : false,
    };
  }

  if (!geminiSvc.isConfigured()) {
    if (parseResult.actions && parseResult.actions.length > 0) {
      return {
        actions           : parseResult.actions,
        confidence        : parseResult.confidence,
        interpretation    : parseResult.interpretation + ' (AI fallback unavailable)',
        commandSource     : 'local_parser_fallback',
        needsAI           : false,
        needsConfirmation : false,
        warning           : 'AI fallback unavailable (GEMINI_API_KEY not set).',
        cancelled         : false,
      };
    }
    return {
      actions           : [],
      confidence        : parseResult.confidence || 0,
      interpretation    : `Could not understand: "${text}". AI fallback unavailable. Please rephrase.`,
      commandSource     : 'local_parser_fallback',
      needsAI           : false,
      needsConfirmation : false,
      warning           : 'AI fallback unavailable (GEMINI_API_KEY not set).',
      cancelled         : false,
    };
  }

  // Gemini fallback
  console.log('[hybridVoice] Routing to Gemini AI. Reason:', parseResult.aiReason || 'low confidence');
  try {
    const aiResult      = await geminiSvc.interpretCommand(text, ambiguities);
    const totalAffected = (aiResult.actions || []).reduce((s, a) => s + (a.indices || []).length, 0);

    // FIX 3: Lower threshold applies here too
    if (totalAffected >= BULK_CONFIRM_THRESHOLD) {
      // FIX 2: Store server-side
      const pendingId = _storePending(
        aiResult.actions || [],
        aiResult.interpretation || text,
        totalAffected
      );
      return {
        actions           : [],
        confidence        : aiResult.confidence || 0.9,
        interpretation    : aiResult.interpretation || text,
        commandSource     : 'gemini_ai',
        needsAI           : true,
        needsConfirmation : true,
        confirmationMsg   : `AI interpreted: "${aiResult.interpretation}". This will affect ${totalAffected} invoice(s). Say CONFIRM to proceed or CANCEL to abort.`,
        pendingId,
        totalAffected,
        aiReason          : parseResult.aiReason,
        cancelled         : false,
      };
    }

    return {
      actions           : aiResult.actions || [],
      confidence        : aiResult.confidence || 0.9,
      interpretation    : aiResult.interpretation || text,
      commandSource     : 'gemini_ai',
      needsAI           : true,
      needsConfirmation : false,
      aiReason          : parseResult.aiReason,
      cancelled         : false,
    };

  } catch (aiErr) {
    // FIX 5: Quota exceeded message
    const isQuota = aiErr.code === 'GEMINI_QUOTA_EXCEEDED';
    if (isQuota) {
      return {
        actions           : parseResult.actions || [],
        confidence        : parseResult.confidence || 0,
        interpretation    : 'Gemini quota exceeded. Using local parser result. Please type a clearer command.',
        commandSource     : 'local_parser_fallback',
        needsAI           : false,
        needsConfirmation : false,
        warning           : 'Gemini API quota exceeded.',
        cancelled         : false,
      };
    }

    console.error('[hybridVoice] Gemini AI fallback failed:', aiErr.message);
    if (parseResult.actions && parseResult.actions.length > 0) {
      return {
        actions           : parseResult.actions,
        confidence        : parseResult.confidence,
        interpretation    : parseResult.interpretation + ' (low confidence)',
        commandSource     : 'local_parser_fallback',
        needsAI           : false,
        needsConfirmation : false,
        warning           : 'AI fallback unavailable. Using partial match.',
        cancelled         : false,
      };
    }
    return {
      actions           : [],
      confidence        : 0,
      interpretation    : `Could not understand command: "${text}". Please rephrase or try a simpler command.`,
      commandSource     : 'local_parser_fallback',
      needsAI           : false,
      needsConfirmation : false,
      warning           : `AI fallback failed: ${aiErr.message}`,
      cancelled         : false,
    };
  }
}

async function processTextCommand(text, ambiguities = [], pendingId = null) {
  const pendingConfirm = _resolvePending(pendingId);
  const parseResult    = await parseCommand(text, ambiguities, pendingConfirm);
  return {
    transcript          : text,
    transcriptionSource : 'typed',
    ...parseResult,
  };
}

async function checkWhisperHealth() {
  try {
    const result = await callEngine(
      { operation: 'health' },
      { enginePath: WHISPER_ENGINE, timeout: 8_000 }
    );
    return {
      ...result,
      // Enhanced health: also report Gemini availability
      geminiConfigured: geminiSvc.isConfigured(),
    };
  } catch {
    return {
      available       : false,
      reason          : 'Bridge not reachable',
      geminiConfigured: geminiSvc.isConfigured(),
    };
  }
}

// ── FIX 2: Server-side pending store helpers ──────────────────────────────────
function _storePending(actions, interpretation, totalAffected) {
  const pendingId = crypto.randomBytes(16).toString('hex');
  _pendingStore.set(pendingId, {
    actions,
    interpretation,
    totalAffected,
    createdAt: Date.now(),
  });
  return pendingId;
}

function _resolvePending(pendingId) {
  if (!pendingId) return null;
  const entry = _pendingStore.get(pendingId);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > PENDING_TTL_MS) {
    _pendingStore.delete(pendingId);
    return null;
  }
  return {
    actions        : entry.actions,
    interpretation : entry.interpretation,
    totalAffected  : entry.totalAffected,
  };
}

function _sanitiseAmbiguities(ambiguities) {
  if (!Array.isArray(ambiguities)) return [];
  return ambiguities.map(amb => ({
    type    : amb.type,
    answered: amb.answered || false,
    invoice : {
      vendor_name   : amb.invoice?.vendor_name    || amb.invoice?.vendor || '',
      amount        : amb.invoice?.amount          || amb.invoice?.total  || '',
      currency      : amb.invoice?.currency        || '',
      invoice_number: amb.invoice?.invoice_number  || '',
    },
  }));
}

module.exports = {
  processVoiceCommand,
  processTextCommand,
  transcribeAudio,
  parseCommand,
  checkWhisperHealth,
};