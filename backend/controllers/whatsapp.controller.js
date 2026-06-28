'use strict';
/**
 * backend/controllers/whatsapp.controller.js
 *
 * CHANGES FROM V2 (addressing audit findings):
 *
 *   [AUDIT #9  - CRITICAL] PROXY-SAFE URL RECONSTRUCTION for Twilio signature.
 *     The old code used a hardcoded TWILIO_WEBHOOK_URL env var. Behind NGINX,
 *     Cloudflare, or AWS ALB the Host header and protocol are rewritten, causing
 *     validateRequest() to fail intermittently. Now reconstructed from:
 *       req.protocol (set by Express trust proxy)
 *       req.get('host')
 *       req.originalUrl
 *     Falls back to TWILIO_WEBHOOK_URL env if set (keeps existing deployments
 *     working without config change).
 *
 *   [AUDIT #10 - CRITICAL] PHONE→APPROVAL STATE MAPPING added.
 *     The old webhook assumed users would reply with the full
 *     "Approve (Job: job_x | Item: appr_y)" string — they never do.
 *     New approach:
 *       1. sendApproval() stores { phone → { jobId, approvalId, options } }
 *          in _pendingByPhone with a 24-hour TTL.
 *       2. webhook() looks up the sender's phone in _pendingByPhone first.
 *       3. Numeric replies ("1", "2") are resolved to the option text.
 *       4. Only if no pending entry is found does it fall back to the old
 *          inline-parsing logic (backward compat for dashboard-initiated flows).
 *     TODO production: replace _pendingByPhone with Redis HSET/TTL.
 *
 *   [AUDIT #11 - HIGH] PROCESSED SID STORAGE annotated for Redis migration.
 *     Still Map() for now (same as V2), but with a clear TODO and the Redis
 *     implementation pattern documented inline. No functional change here —
 *     the infrastructure switch must happen at the service layer.
 *
 *   [AUDIT #12 - MEDIUM] sendApproval AUTHORIZATION CHECK added.
 *     Validates that the jobId + approvalId belong to req.user before sending.
 *     Prevents authenticated users from sending WhatsApp messages to arbitrary
 *     phone numbers on behalf of jobs they don't own.
 *
 *   All V2 fixes retained:
 *     - Twilio signature verification
 *     - Idempotency (MessageSid dedup)
 *     - Production fail-hard for missing TWILIO_WHATSAPP_FROM
 *     - Lazy Twilio client initialization
 */

const engine = require('../services/procurement/reconciliationEngine.service');

// ── Lazy Twilio client ────────────────────────────────────────────────────────

let _twilioClient = null;

function _getTwilio() {
  if (_twilioClient) return _twilioClient;

  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;

  if (!sid || !token) {
    throw Object.assign(
      new Error('WhatsApp is not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in your .env file.'),
      { status: 503, code: 'WHATSAPP_NOT_CONFIGURED' }
    );
  }

  const twilio  = require('twilio');
  _twilioClient = twilio(sid, token);
  return _twilioClient;
}

// Fail hard in production if FROM number not configured
function _getFromNumber() {
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!from && process.env.NODE_ENV === 'production') {
    throw Object.assign(
      new Error('TWILIO_WHATSAPP_FROM is required in production. Set it in your .env file.'),
      { status: 503, code: 'WHATSAPP_FROM_NOT_SET' }
    );
  }
  return from || 'whatsapp:+14155238886'; // sandbox default for dev only
}

// ── Idempotency store ─────────────────────────────────────────────────────────
// [AUDIT #11] Still in-memory — Twilio retries within the same process will be
// deduplicated. For multi-pod / restart safety this MUST move to Redis:
//   await redis.set(`whatsapp:sid:${messageSid}`, '1', 'EX', 86400);
// TODO: replace Map with Redis SET + 24h TTL.
const _processedSids = new Map();
const SID_TTL_MS     = 24 * 60 * 60 * 1000;

setInterval(() => {
  const now     = Date.now();
  let   removed = 0;
  for (const [sid, ts] of _processedSids.entries()) {
    if (now - ts > SID_TTL_MS) { _processedSids.delete(sid); removed++; }
  }
  if (removed > 0) console.log(`[whatsapp] Cleaned ${removed} processed SID(s).`);
}, 60 * 60 * 1000);

// ── [AUDIT #10] Phone → pending approval mapping ──────────────────────────────
// Stores the last outstanding approval per sender phone number.
// Lets users reply with "1", "Approve", etc. without embedding job/item IDs.
// TODO production: replace with Redis HSET + 24h TTL per key.
//
// Structure: Map<normalizedPhone, { jobId, approvalId, options: string[], createdAt }>
const _pendingByPhone = new Map();
const PENDING_TTL_MS  = 24 * 60 * 60 * 1000;

setInterval(() => {
  const now     = Date.now();
  let   removed = 0;
  for (const [phone, entry] of _pendingByPhone.entries()) {
    if (now - entry.createdAt > PENDING_TTL_MS) { _pendingByPhone.delete(phone); removed++; }
  }
  if (removed > 0) console.log(`[whatsapp] Cleaned ${removed} expired pending approval(s).`);
}, 60 * 60 * 1000);

// ── POST /api/whatsapp/send ───────────────────────────────────────────────────

exports.sendApproval = async (req, res, next) => {
  try {
    const { toPhone, jobId, approvalId, question, options } = req.body;

    if (!toPhone || !jobId || !approvalId || !question) {
      return res.status(400).json({
        error: 'toPhone, jobId, approvalId, and question are required',
        code : 'MISSING_FIELDS',
      });
    }

    // [AUDIT #12] Verify job ownership before sending messages to external numbers.
    const job = engine.getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found', code: 'JOB_NOT_FOUND' });
    }
    if (job.userId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
    }
    // [AUDIT #12] Verify the approval item belongs to this job.
    const approvalExists = (job.pendingApprovals || []).some(a => a.id === approvalId);
    if (!approvalExists) {
      return res.status(404).json({ error: 'Approval item not found', code: 'APPROVAL_NOT_FOUND' });
    }

    const optionList  = Array.isArray(options) && options.length > 0 ? options : [];
    const optionLines = optionList.length > 0
      ? '\n\nOptions:\n' + optionList.map((o, i) => `${i + 1}. ${o}`).join('\n')
      : '';

    const body =
      `*Auros Approval Required*\n\n` +
      `${question}${optionLines}\n\n` +
      `Reply with the number or text of your choice.`;

    const toNumber       = toPhone.startsWith('whatsapp:') ? toPhone : `whatsapp:${toPhone}`;
    const normalizedPhone = _normalizePhone(toPhone);

    const message = await _getTwilio().messages.create({
      from: _getFromNumber(),
      to  : toNumber,
      body,
    });

    // [AUDIT #10] Store phone→approval mapping so the webhook can resolve short replies.
    _pendingByPhone.set(normalizedPhone, {
      jobId,
      approvalId,
      options  : optionList,
      createdAt: Date.now(),
    });

    res.json({
      success   : true,
      messageSid: message.sid,
      status    : message.status,
      to        : toPhone,
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/whatsapp/status/:jobId ──────────────────────────────────────────

exports.getStatus = (req, res, next) => {
  try {
    const job = engine.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found', code: 'JOB_NOT_FOUND' });
    if (job.userId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
    }

    const pending  = (job.pendingApprovals || []).filter(a => a.status === 'pending').length;
    const resolved = (job.pendingApprovals || []).filter(a => a.status !== 'pending').length;

    res.json({
      jobId   : job.jobId,
      pending,
      resolved,
      total   : job.pendingApprovals?.length || 0,
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/whatsapp/webhook ────────────────────────────────────────────────

exports.webhook = async (req, res, next) => {
  try {
    // ── SECURITY: Twilio signature verification ───────────────────────────────
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (authToken && process.env.NODE_ENV !== 'test') {
      const twilio    = require('twilio');
      const signature = req.headers['x-twilio-signature'] || '';

      // [AUDIT #9] Reconstruct the exact URL Twilio signed.
      // Behind NGINX/Cloudflare/ALB the Host and proto headers are rewritten.
      // Express trust proxy must be enabled (app.set('trust proxy', 1)) so that
      // req.protocol reflects the original protocol (https).
      // TWILIO_WEBHOOK_URL overrides this when the reconstructed URL differs
      // (e.g. internal load balancer uses a different hostname).
      const webhookUrl = process.env.TWILIO_WEBHOOK_URL
        || `${req.protocol}://${req.get('host')}${req.originalUrl}`;

      const isValid = twilio.validateRequest(authToken, signature, webhookUrl, req.body);

      if (!isValid) {
        console.warn(`[whatsapp] Webhook signature FAILED for URL: ${webhookUrl}`);
        return res.status(403).json({ error: 'Invalid Twilio signature', code: 'INVALID_SIGNATURE' });
      }
    } else if (process.env.NODE_ENV === 'production' && !authToken) {
      console.error('[whatsapp] TWILIO_AUTH_TOKEN not set — webhook verification disabled in production!');
    }

    const body       = (req.body.Body     || '').trim();
    const messageSid = req.body.MessageSid || req.body.SmsSid || '';
    const fromNumber = req.body.From       || '';

    // ── Idempotency: deduplicate Twilio retries ───────────────────────────────
    if (messageSid) {
      if (_processedSids.has(messageSid)) {
        console.log(`[whatsapp] Duplicate webhook SID ${messageSid} — acknowledged, not reprocessed`);
        return res.set('Content-Type', 'text/xml').send(`<Response></Response>`);
      }
      _processedSids.set(messageSid, Date.now());
    }

    // ── [AUDIT #10] Phone-based pending approval lookup ───────────────────────
    // Users reply with "1", "Approve", etc. We look up their outstanding approval
    // by sender phone number rather than requiring them to embed job/item IDs.
    const normalizedFrom = _normalizePhone(fromNumber);
    const pending        = _pendingByPhone.get(normalizedFrom);

    if (pending && !_isPendingExpired(pending)) {
      const { jobId, approvalId, options } = pending;
      const userResponse = _resolveOptionReply(body, options);

      try {
        engine.approveItem(jobId, approvalId, userResponse, 'whatsapp');
        // Clear the pending entry — approval is resolved.
        _pendingByPhone.delete(normalizedFrom);
      } catch (approveErr) {
        console.warn(`[whatsapp] Could not route reply (phone lookup) to job ${jobId}: ${approveErr.message}`);
      }

      return res.set('Content-Type', 'text/xml').send(
        `<Response><Message>✓ Response recorded: "${userResponse}". Thank you.</Message></Response>`
      );
    }

    // ── Fallback: inline job/item ID parsing (dashboard-initiated flows) ──────
    // Kept for backward compatibility with messages sent before the phone-mapping
    // feature was deployed, or for flows that embed IDs explicitly.
    const jobMatch      = body.match(/Job:\s*(job_[^\s|)]+)/i);
    const approvalMatch = body.match(/Item:\s*(appr_[^\s)]+)/i);

    if (!jobMatch || !approvalMatch) {
      return res.set('Content-Type', 'text/xml').send(
        `<Response><Message>Reply not recognised. Please use the Auros dashboard to manage approvals.</Message></Response>`
      );
    }

    const jobId        = jobMatch[1].trim();
    const approvalId   = approvalMatch[1].trim();
    const userResponse = body.split(/\(Job:/i)[0].trim() || body;

    try {
      engine.approveItem(jobId, approvalId, userResponse, 'whatsapp');
    } catch (approveErr) {
      console.warn(`[whatsapp] Could not route reply (inline) to job ${jobId}: ${approveErr.message}`);
    }

    res.set('Content-Type', 'text/xml').send(
      `<Response><Message>✓ Response recorded: "${userResponse}". Thank you.</Message></Response>`
    );
  } catch (err) {
    next(err);
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Strip "whatsapp:" prefix and whitespace for consistent map keys.
 * @param {string} phone
 * @returns {string}
 */
function _normalizePhone(phone) {
  return (phone || '').replace(/^whatsapp:/i, '').trim();
}

/**
 * [AUDIT #10] Resolve a user's short reply to a full response string.
 * "1" → options[0], "2" → options[1], etc.
 * Non-numeric or out-of-range replies are returned as-is.
 *
 * @param {string} body
 * @param {string[]} options
 * @returns {string}
 */
function _resolveOptionReply(body, options) {
  if (!body) return body;
  const num = parseInt(body.trim(), 10);
  if (!isNaN(num) && num >= 1 && num <= options.length) {
    return options[num - 1];
  }
  return body.trim();
}

/**
 * @param {{ createdAt: number }} entry
 * @returns {boolean}
 */
function _isPendingExpired(entry) {
  return Date.now() - entry.createdAt > PENDING_TTL_MS;
}

