'use strict';
/**
 * backend/middleware/validate.js
 *
 * Input validation middleware using Zod.
 * Validates request body before it reaches controllers.
 *
 * Install: npm install zod
 *
 * Usage:
 *   router.post('/login', validate(schemas.login), authCtrl.login);
 */

const { z } = require('zod');

// ── Validation schemas ────────────────────────────────────────────────────────

const schemas = {

  // Auth
  signup: z.object({
    name    : z.string().min(2).max(100).trim(),
    email   : z.string().email().max(254).toLowerCase(),
    password: z.string().min(8).max(128),
  }),

  login: z.object({
    email   : z.string().email().max(254).toLowerCase(),
    password: z.string().min(1).max(128),
  }),

  // PHASE 2 FIX: this schema previously only defined `accessToken`, which
  // meant a request containing only `idToken` (the more secure,
  // audience-validated path — see auth.controller.js's _verifyGoogleIdToken)
  // was either rejected outright (accessToken is required) or had `idToken`
  // silently stripped by Zod's default "strip unknown keys" behaviour before
  // it ever reached the controller. The controller's own
  // `if (!accessToken && !idToken)` guard already enforces that at least one
  // is present, so both are optional here.
  googleAuth: z.object({
    accessToken: z.string().min(10).max(2048).optional(),
    idToken    : z.string().min(10).max(4096).optional(),
  }),

  // PHASE 2 — session/refresh
  refreshToken: z.object({
    refreshToken: z.string().min(10).max(512),
  }),

  // PHASE 2 — MFA
  mfaVerifySetup: z.object({
    code: z.string().min(6).max(10),
  }),

  mfaDisable: z.object({
    password: z.string().min(1).max(128).optional(),
    code    : z.string().min(6).max(10).optional(),
  }).refine(d => d.password || d.code, { message: 'Either password or code is required' }),

  mfaVerifyChallenge: z.object({
    challengeToken: z.string().min(10).max(256),
    code          : z.string().min(6).max(10).optional(),
    backupCode    : z.string().min(6).max(20).optional(),
  }).refine(d => d.code || d.backupCode, { message: 'Either code or backupCode is required' }),

  // PHASE 2 — admin role management
  updateUserRole: z.object({
    role: z.string().min(1).max(50),
  }),

  // PHASE 2 — API key management
  createApiKey: z.object({
    name         : z.string().min(1).max(100),
    role         : z.string().min(1).max(50).optional(),
    expiresInDays: z.number().positive().max(3650).optional(),
  }),

  // Procurement
  startReconciliation: z.object({
    invoiceDatasetId : z.string().min(1).max(100),
    // BUGFIX (regression from Batch 3): .optional() alone only accepts
    // `undefined`, not `null`. The frontend's React state defaults these
    // to `null` when a file hasn't been uploaded, and JSON.stringify keeps
    // `null` keys (it only drops `undefined` ones) — so this validation
    // was rejecting EVERY reconciliation request the moment it was wired
    // in, regardless of which files were actually uploaded. .nullable()
    // accepts both null and undefined.
    poDatasetId      : z.string().max(100).nullable().optional(),
    grnDatasetId     : z.string().max(100).nullable().optional(),
    contractDatasetId: z.string().max(100).nullable().optional(),
  }),

  approveItem: z.object({
    response    : z.string().min(1).max(500),
    respondedVia: z.string().max(50).optional(),
  }),

  rejectItem: z.object({
    reason: z.string().max(500).optional(),
  }),

  // Pipeline
  createPipeline: z.object({
    datasetId: z.string().min(1).max(100),
  }),

  addStep: z.object({
    type      : z.string().min(1).max(50),
    column    : z.string().max(200).optional(),
    parameters: z.record(z.unknown()).optional(),
  }),

  // Voice text command
  textCommand: z.object({
    text        : z.string().min(1).max(1000).trim(),
    ambiguities : z.array(z.object({
      type    : z.string().optional(),
      answered: z.boolean().optional(),
      invoice : z.object({
        vendor_name   : z.string().max(200).optional(),
        amount        : z.union([z.string(), z.number()]).optional(),
        currency      : z.string().max(10).optional(),
        invoice_number: z.string().max(100).optional(),
      }).optional(),
    })).max(2000).optional(),
  }),

  // Register server file
  registerServerFile: z.object({
    serverPath  : z.string().min(1).max(500).refine(
      p => !p.includes('..') && !p.startsWith('~'),
      { message: 'Invalid file path' }
    ),
    originalName: z.string().min(1).max(255),
  }),

  // WhatsApp
  sendWhatsApp: z.object({
    toPhone    : z.string().min(7).max(20).regex(/^\+?[\d\s\-()]+$/),
    jobId      : z.string().min(1).max(100),
    approvalId : z.string().min(1).max(100),
    question   : z.string().min(1).max(1000),
    options    : z.array(z.string().max(200)).max(10),
  }),
};

// ── Middleware factory ────────────────────────────────────────────────────────
/**
 * Returns an Express middleware that validates req.body against the given schema.
 * On failure: 400 with field-level error details.
 * On success: passes sanitised/coerced data as req.body.
 *
 * @param {z.ZodSchema} schema
 */
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const errors = result.error.errors.map(e => ({
        field  : e.path.join('.'),
        message: e.message,
      }));
      return res.status(400).json({
        error  : 'Validation failed',
        code   : 'VALIDATION_ERROR',
        details: errors,
      });
    }

    // Replace req.body with sanitised/coerced data
    req.body = result.data;
    next();
  };
}

// ── Query param validator ─────────────────────────────────────────────────────
function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const errors = result.error.errors.map(e => ({
        field  : e.path.join('.'),
        message: e.message,
      }));
      return res.status(400).json({
        error  : 'Invalid query parameters',
        code   : 'VALIDATION_ERROR',
        details: errors,
      });
    }
    req.query = result.data;
    next();
  };
}

// ── Param sanitiser ───────────────────────────────────────────────────────────
function sanitiseParams(req, res, next) {
  for (const [key, val] of Object.entries(req.params)) {
    if (typeof val === 'string') {
      if (!/^[a-zA-Z0-9_\-]+$/.test(val)) {
        return res.status(400).json({
          error: `Invalid parameter: ${key}`,
          code : 'INVALID_PARAM',
        });
      }
    }
  }
  next();
}

module.exports = { validate, validateQuery, sanitiseParams, schemas };
