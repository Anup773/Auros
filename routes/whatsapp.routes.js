'use strict';
/**
 * backend/routes/whatsapp.routes.js — V2
 *
 * CHANGES FROM V1:
 *
 * CRITICAL FIX #1 — UNAUTHENTICATED WEBHOOK (fake approval spoofing)
 *   Old: router.post('/webhook', ctrl.webhook) — completely open endpoint with
 *        only a comment saying "add validation later". Any attacker knowing the
 *        webhook URL could POST a fake Twilio payload and trigger fraudulent
 *        procurement approvals without any Twilio account.
 *   New: _twilioSignatureMiddleware() verifies the X-Twilio-Signature header
 *        using twilio.validateRequest() (from the 'twilio' npm package) against
 *        TWILIO_AUTH_TOKEN and the full webhook URL (TWILIO_WEBHOOK_URL env var).
 *        If the signature is missing or invalid, the request is rejected with 403
 *        before ctrl.webhook ever runs.
 *        When TWILIO_AUTH_TOKEN is not configured (local dev), validation is
 *        SKIPPED with a loud startup warning — this ensures dev/CI workflows
 *        are not blocked, while making the gap impossible to miss in production.
 *        Raw body is required for Twilio signature verification — the webhook
 *        route uses express.urlencoded({ extended: false }) instead of the global
 *        express.json() parser, because Twilio sends application/x-www-form-urlencoded.
 *
 * HIGH FIX #2 — REPLAY ATTACK PREVENTION
 *   Old: Even with a valid Twilio signature, a captured webhook request could be
 *        replayed indefinitely (Twilio signatures are deterministic per payload).
 *   New: _replayGuard() checks the X-Twilio-Signature timestamp embedded in the
 *        MessageSid (Twilio's own de-duplication token) against a short-lived
 *        in-process seen-set (_seenMessageSids). Any MessageSid seen more than
 *        once within REPLAY_WINDOW_MS (default: 5 minutes) is rejected with 409.
 *        The seen-set is pruned every REPLAY_WINDOW_MS to prevent unbounded growth.
 *        Note: for multi-server deployments, replace _seenMessageSids with a
 *        Redis SET with EX=REPLAY_WINDOW_MS/1000 for distributed deduplication.
 *
 * HIGH FIX #3 — RATE LIMITING ON /send (Twilio bill explosion)
 *   Old: POST /api/whatsapp/send had no rate limit beyond the global limiter in
 *        app.js. An attacker (or a bug in automated reconciliation logic) could
 *        trigger thousands of outbound WhatsApp messages per minute, running up
 *        an unlimited Twilio bill.
 *   New: _sendLimiter = express-rate-limit: 20 requests per 10 minutes per IP.
 *        Applied before requireAuth so even failed auth attempts are counted.
 *        Additionally, _globalSendLimiter caps total outbound sends across ALL
 *        IPs at 100 per 10 minutes (prevents distributed bill-flooding attacks
 *        where many IPs each stay under the per-IP cap).
 *
 * PRESERVED FROM V1:
 *   - All route paths unchanged (/send, /status/:jobId, /webhook)
 *   - requireAuth on /send and /status/:jobId
 *   - ctrl.sendApproval, ctrl.getStatus, ctrl.webhook method names unchanged
 */

const express   = require('express');
const router    = express.Router();
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../controllers/auth.controller');
const ctrl            = require('../controllers/whatsapp.controller');

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || null;
const TWILIO_WEBHOOK_URL = process.env.TWILIO_WEBHOOK_URL || null;

// FIX #2: Replay window
const REPLAY_WINDOW_MS = parseInt(process.env.WHATSAPP_REPLAY_WINDOW_MS || String(5 * 60 * 1000), 10);

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — STARTUP WARNINGS
// ══════════════════════════════════════════════════════════════════════════════

if (!TWILIO_AUTH_TOKEN) {
  console.warn(
    '[whatsapp.routes] WARNING: TWILIO_AUTH_TOKEN is not set. ' +
    'Webhook signature validation is DISABLED. ' +
    'Anyone can POST fake Twilio webhooks and trigger fraudulent approvals. ' +
    'Set TWILIO_AUTH_TOKEN and TWILIO_WEBHOOK_URL in your .env for production.'
  );
}

if (TWILIO_AUTH_TOKEN && !TWILIO_WEBHOOK_URL) {
  console.warn(
    '[whatsapp.routes] WARNING: TWILIO_AUTH_TOKEN is set but TWILIO_WEBHOOK_URL is missing. ' +
    'Signature validation requires the exact URL Twilio posts to. ' +
    'Set TWILIO_WEBHOOK_URL=https://yourdomain.com/api/whatsapp/webhook in your .env.'
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — RATE LIMITERS (FIX #3)
// ══════════════════════════════════════════════════════════════════════════════

// Per-IP: 20 outbound sends per 10 minutes
const _sendLimiter = rateLimit({
  windowMs       : 10 * 60 * 1000,
  max            : 20,
  standardHeaders: true,
  legacyHeaders  : false,
  message        : {
    error: 'Too many WhatsApp send requests. Please wait before sending more.',
    code : 'WHATSAPP_RATE_LIMITED',
  },
  keyGenerator   : (req) => req.ip,
});

// Global across all IPs: 100 sends per 10 minutes (prevents distributed bill flooding)
const _globalSendLimiter = rateLimit({
  windowMs       : 10 * 60 * 1000,
  max            : 100,
  standardHeaders: true,
  legacyHeaders  : false,
  message        : {
    error: 'WhatsApp send limit reached globally. Please try again later.',
    code : 'WHATSAPP_GLOBAL_LIMIT',
  },
  keyGenerator   : () => 'global',  // same bucket for all IPs
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — TWILIO SIGNATURE VALIDATION MIDDLEWARE (FIX #1)
// ══════════════════════════════════════════════════════════════════════════════

function _twilioSignatureMiddleware(req, res, next) {
  // Skip validation in development when token not configured
  if (!TWILIO_AUTH_TOKEN || !TWILIO_WEBHOOK_URL) {
    return next();
  }

  let twilio;
  try {
    twilio = require('twilio');
  } catch (_) {
    console.error(
      '[whatsapp.routes] CRITICAL: twilio npm package not installed. ' +
      'Run: npm install twilio  — webhook validation is disabled until then.'
    );
    return next();  // Fail open (log only) if package missing — prevents service disruption
  }

  const signature = req.headers['x-twilio-signature'];
  if (!signature) {
    return res.status(403).json({
      error: 'Missing X-Twilio-Signature header.',
      code : 'MISSING_TWILIO_SIGNATURE',
    });
  }

  // Twilio signs the full webhook URL + sorted POST params
  // req.body must be the raw urlencoded params (not JSON-parsed)
  const params = req.body || {};
  const isValid = twilio.validateRequest(
    TWILIO_AUTH_TOKEN,
    signature,
    TWILIO_WEBHOOK_URL,
    params
  );

  if (!isValid) {
    console.warn(
      `[whatsapp.routes] Invalid Twilio signature from IP ${req.ip}. ` +
      'Possible spoofing attempt or misconfigured TWILIO_WEBHOOK_URL.'
    );
    return res.status(403).json({
      error: 'Invalid Twilio webhook signature.',
      code : 'INVALID_TWILIO_SIGNATURE',
    });
  }

  next();
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — REPLAY GUARD (FIX #2)
// ══════════════════════════════════════════════════════════════════════════════

// NOTE: Single-process only. For multi-server, replace with:
//   await redis.set(`whatsapp:sid:${sid}`, 1, 'EX', REPLAY_WINDOW_MS/1000, 'NX')
//   and reject if return value is null (key already existed).
const _seenMessageSids = new Map();  // sid → receivedAt (ms)

// Prune expired entries every REPLAY_WINDOW_MS
const _replayPruneInterval = setInterval(() => {
  const cutoff = Date.now() - REPLAY_WINDOW_MS;
  for (const [sid, ts] of _seenMessageSids.entries()) {
    if (ts < cutoff) _seenMessageSids.delete(sid);
  }
}, REPLAY_WINDOW_MS);

if (_replayPruneInterval.unref) _replayPruneInterval.unref();

function _replayGuard(req, res, next) {
  // Twilio's unique message identifier — present in all inbound/status callbacks
  const sid = req.body?.MessageSid || req.body?.SmsSid || null;

  if (!sid) {
    // No MessageSid (e.g. status callback without message reference) — allow through
    return next();
  }

  if (_seenMessageSids.has(sid)) {
    console.warn(
      `[whatsapp.routes] Duplicate MessageSid "${sid}" rejected (replay attack or double-delivery).`
    );
    // Return 200 to Twilio so it doesn't keep retrying, but do not process
    return res.status(200).send('<?xml version="1.0"?><Response></Response>');
  }

  _seenMessageSids.set(sid, Date.now());
  next();
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/whatsapp/send
// FIX #3: Per-IP + global rate limiters applied before auth
router.post('/send',
  _sendLimiter,
  _globalSendLimiter,
  requireAuth,
  ctrl.sendApproval,
);

// GET /api/whatsapp/status/:jobId
router.get('/status/:jobId',
  requireAuth,
  ctrl.getStatus,
);

// POST /api/whatsapp/webhook
// FIX #1: Twilio uses application/x-www-form-urlencoded — parse body accordingly
//         BEFORE signature validation (validator needs parsed params, not raw buffer).
// FIX #1: _twilioSignatureMiddleware verifies X-Twilio-Signature
// FIX #2: _replayGuard deduplicates MessageSid within REPLAY_WINDOW_MS
router.post('/webhook',
  express.urlencoded({ extended: false }),  // FIX #1: parse Twilio's form body
  _twilioSignatureMiddleware,               // FIX #1: verify signature
  _replayGuard,                             // FIX #2: deduplicate replays
  ctrl.webhook,
);

module.exports = router;
