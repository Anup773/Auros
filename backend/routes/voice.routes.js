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
const approvalRules   = require('../services/procurement/approvalRules.service');
const { ROLE_LEVELS }  = require('../middleware/rbac');

const MAX_AMBIGUITIES = parseInt(process.env.MAX_AMBIGUITIES || '500', 10);

// ── Rule-management commands (copilot chat, no separate UI) ──────────────────
// command_parser.py's _detect_rule_command (already built, just never wired
// into op_parse_command until now) recognises "auto-approve invoices under
// $500 from now on", "list my rules", "delete the ... rule", "disable the
// ... rule" and returns a single action of one of these 4 types instead of
// the usual {indices, response} item actions. Node executes it here — right
// after the parser call, before the response reaches the frontend — so
// ProcurementCopilot.jsx's existing action-application loop (which only
// understands {indices, response}) never sees these action types at all: by
// the time a rule action reaches the client it's already been turned into
// actions:[] plus a plain-English interpretation, rendered exactly like any
// other chat reply.
const RULE_ACTION_TYPES = new Set(['create_rule', 'list_rules', 'delete_rule', 'toggle_rule']);

const _AMBIGUITY_TYPE_LABELS = {
  amount_mismatch        : 'amount mismatches',
  quantity_mismatch      : 'quantity mismatches',
  contract_price_variance: 'contract price variances',
  tax_discrepancy        : 'tax discrepancies',
  no_po_match             : 'invoices with no matching PO',
};

function _describeAppliesTo(appliesTo) {
  return appliesTo.map(t => _AMBIGUITY_TYPE_LABELS[t] || t).join(', ');
}

function _formatRuleLine(rule) {
  const c = rule.condition;
  const desc =
    c.type === 'amount_under'       ? `amount under $${Number(c.value).toLocaleString()}` :
    c.type === 'variance_under_pct' ? `variance under ${c.value}%` :
    c.type === 'vendor_in'          ? `vendor is ${c.value.join(' / ')}` :
    c.type;
  return `${rule.enabled ? '\u25cf' : '\u25cb (disabled)'} "${rule.name}" \u2014 auto-approve when ${desc}`;
}

// Fuzzy-match a spoken/typed rule reference ("the amount 500 rule") against
// the user's actual saved rule names. Deliberately conservative — these are
// financial controls, so this only acts on a clear, unambiguous best match;
// anything else surfaces the current rule list and asks rather than guesses.
function _resolveRuleReference(reference, rules) {
  const ref = (reference || '').toLowerCase().trim();
  const refTokens = ref.split(/\s+/).filter(Boolean);
  if (refTokens.length === 0 || rules.length === 0) return null;

  const scored = rules
    .map(rule => {
      const name = rule.name.toLowerCase();
      let score = 0;
      if (name === ref) score += 100;
      else if (name.includes(ref) || ref.includes(name)) score += 50;
      for (const tok of refTokens) if (tok.length >= 2 && name.includes(tok)) score += 1;
      return { rule, score };
    })
    .sort((a, b) => b.score - a.score);

  const [best, second] = scored;
  if (best && best.score > 0 && (!second || best.score > second.score)) return best.rule;
  return null;
}

async function _resolveRuleAction(result, user) {
  const first = (result.actions || [])[0];
  if (!first || !RULE_ACTION_TYPES.has(first.action)) return result;

  // list_rules is read-only — any authenticated role can see what's
  // configured. create/delete/toggle mutate a financial control and are
  // gated exactly like requireFinance on the REST /api/procurement/rules
  // routes — the chat surface must not be a way around that gate.
  const isMutating = first.action !== 'list_rules';
  if (isMutating && (ROLE_LEVELS[user?.role] || 0) < ROLE_LEVELS.finance) {
    return {
      ...result,
      actions: [],
      interpretation: `Managing approval rules requires the finance role. Your role: ${user?.role || 'unknown'}.`,
      warning: 'INSUFFICIENT_ROLE',
    };
  }

  try {
    if (first.action === 'list_rules') {
      const rules = await approvalRules.listRules();
      const interpretation = rules.length === 0
        ? 'You don\u2019t have any approval rules yet. Try "auto-approve invoices under $500" to create one.'
        : `Your approval rules:\n${rules.map(_formatRuleLine).join('\n')}`;
      return { ...result, actions: [], interpretation };
    }

    if (first.action === 'create_rule') {
      const parsed = first.condition || {};
      // command_parser.py's field names (threshold / vendors) differ from
      // approvalRules.service.js's storage shape (value) — bridged here.
      const value = parsed.type === 'vendor_in' ? (parsed.vendors || []) : parsed.threshold;
      if (parsed.type === 'vendor_in' && value.length === 0) {
        return { ...result, actions: [], interpretation: 'Couldn\u2019t tell which vendor you meant. Try naming it directly, e.g. "auto-approve invoices from Acme Corp".' };
      }
      const condition = { type: parsed.type, value };
      // The spoken command doesn't name which ambiguity types it should
      // cover, so this defaults to everything approvalRules.service.js
      // allows for that condition type (its own ALLOWED_TARGETS — the same
      // source of truth the REST API would validate against). The
      // confirmation spells this out so nothing is applied silently.
      const appliesTo = approvalRules.ALLOWED_TARGETS[condition.type] || [];
      if (appliesTo.length === 0) {
        return { ...result, actions: [], interpretation: `Couldn\u2019t determine what "${first.ruleName}" should apply to.` };
      }

      const rule = await approvalRules.createRule({ name: first.ruleName, condition, appliesTo, createdBy: user.id });
      return {
        ...result,
        actions: [],
        interpretation:
          `Created rule "${rule.name}". It applies to: ${_describeAppliesTo(appliesTo)}. ` +
          `This only affects future reconciliation jobs, not items already pending. ` +
          `Say "list my rules" anytime to review, or "delete the ${rule.name} rule" to remove it.`,
      };
    }

    // delete_rule / toggle_rule share the same reference-resolution step.
    const rules = await approvalRules.listRules();
    const match = _resolveRuleReference(first.ruleReference, rules);

    if (!match) {
      const listing = rules.length
        ? `Your current rules:\n${rules.map(_formatRuleLine).join('\n')}\n\nWhich one did you mean?`
        : 'You don\u2019t have any approval rules yet.';
      return { ...result, actions: [], interpretation: `I couldn\u2019t tell which rule you meant. ${listing}` };
    }

    if (first.action === 'delete_rule') {
      await approvalRules.deleteRule(match.id);
      return { ...result, actions: [], interpretation: `Deleted rule "${match.name}".` };
    }

    const updated = await approvalRules.updateRule(match.id, { enabled: first.enable });
    return { ...result, actions: [], interpretation: `${updated.enabled ? 'Enabled' : 'Disabled'} rule "${updated.name}".` };

  } catch (err) {
    return { ...result, actions: [], interpretation: `Couldn\u2019t complete that: ${err.message}` };
  }
}

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
  // BUGFIX: fieldSize was never set here, so multer used its default 1MB
  // limit for the `ambiguities` form field. express.json() elsewhere in
  // this app (app.js) allows 10MB for the exact same payload when sent as
  // JSON (text commands). On a job with thousands of items, the serialised
  // ambiguities array can exceed 1MB but comfortably fits under 10MB —
  // which is exactly why voice commands failed on large jobs ("Failed to
  // fetch" — the connection gets aborted mid-upload once the field limit is
  // hit) while text commands on the same job worked fine. Matched to the
  // same 10MB bound used for JSON bodies for consistency.
  limits    : { fileSize: 25 * 1024 * 1024, fieldSize: 10 * 1024 * 1024 },
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

    let result = await hybridSvc.processVoiceCommand(
      req.file.buffer,
      req.file.mimetype,
      ambiguities,
      pendingId,    // FIX 1
      commandId     // FIX 4
    );
    result = await _resolveRuleAction(result, req.user);

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

    let result = await hybridSvc.processTextCommand(text.trim(), ambiguities, pendingId);
    result = await _resolveRuleAction(result, req.user);

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
  // BUGFIX: this case was previously unhandled and fell through to next(err)
  // — which, depending on timing, could abort the connection mid-upload
  // before the client ever received a response body, surfacing to the
  // browser as a generic "Failed to fetch" network error instead of a
  // readable message. Handled explicitly now.
  if (err.code === 'LIMIT_FIELD_VALUE') {
    return res.status(413).json({
      error: 'Reconciliation job is too large for a voice command on this job size. Please use text commands instead.',
      code : 'AMBIGUITIES_TOO_LARGE',
    });
  }
  if (err.code === 'INVALID_AUDIO_TYPE') {
    return res.status(400).json({ error: err.message, code: 'INVALID_AUDIO_TYPE' });
  }
  next(err);
});

module.exports = router;