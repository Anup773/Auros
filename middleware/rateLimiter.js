'use strict';
/**
 * backend/middleware/rateLimiter.js
 *
 * Rate limiting middleware for all routes.
 * Stricter limits on auth endpoints to prevent brute force.
 *
 * Install: npm install express-rate-limit
 */

const rateLimit = require('express-rate-limit');

// ── Global limiter — all routes ───────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs        : 15 * 60 * 1000, // 15 minutes
  max             : 200,             // 200 requests per window per IP
  standardHeaders : true,
  legacyHeaders   : false,
  message         : { error: 'Too many requests. Please try again later.', code: 'RATE_LIMITED' },
  skip            : (req) => req.path === '/health', // never limit health checks
});

// ── Auth limiter — stricter for login/signup ──────────────────────────────────
const authLimiter = rateLimit({
  windowMs        : 15 * 60 * 1000, // 15 minutes
  max             : 10,              // only 10 auth attempts per window
  standardHeaders : true,
  legacyHeaders   : false,
  message         : { error: 'Too many login attempts. Please wait 15 minutes.', code: 'AUTH_RATE_LIMITED' },
});

// ── Upload limiter — file uploads are expensive ───────────────────────────────
const uploadLimiter = rateLimit({
  windowMs        : 60 * 60 * 1000, // 1 hour
  max             : 50,              // 50 uploads per hour per IP
  standardHeaders : true,
  legacyHeaders   : false,
  message         : { error: 'Upload limit reached. Please try again in an hour.', code: 'UPLOAD_RATE_LIMITED' },
});

// ── Voice limiter — transcription calls ──────────────────────────────────────
const voiceLimiter = rateLimit({
  windowMs        : 5 * 60 * 1000,  // 5 minutes
  max             : 30,              // 30 voice calls per 5 min
  standardHeaders : true,
  legacyHeaders   : false,
  message         : { error: 'Voice command limit reached. Please wait.', code: 'VOICE_RATE_LIMITED' },
});

// ── AI limiter — AI calls cost tokens ────────────────────────────────────────
const aiLimiter = rateLimit({
  windowMs        : 60 * 60 * 1000, // 1 hour
  max             : 100,             // 100 AI calls per hour
  standardHeaders : true,
  legacyHeaders   : false,
  message         : { error: 'AI request limit reached. Please try again later.', code: 'AI_RATE_LIMITED' },
});

module.exports = { globalLimiter, authLimiter, uploadLimiter, voiceLimiter, aiLimiter };
