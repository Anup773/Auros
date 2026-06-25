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

  googleAuth: z.object({
    accessToken: z.string().min(10).max(2048),
  }),

  // Procurement
  startReconciliation: z.object({
    invoiceDatasetId: z.string().min(1).max(100),
    poDatasetId     : z.string().max(100).optional(),
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