'use strict';
/**
 * backend/app.js — Security Hardened V5
 *
 * CHANGES FROM V4:
 *   - CRITICAL: Upload static endpoint REMOVED.
 *     Old: app.use('/uploads', express.static(UPLOADS_DIR))
 *     Invoices, contracts, and sensitive documents were publicly downloadable.
 *     New: uploads are served only via authenticated route in data.routes.js.
 *
 *   - HIGH: Request timeout added via server-level socket timeout.
 *     Prevents slowloris attacks and stalled slow POST/upload connections.
 *     Set via SERVER_TIMEOUT_MS env var (default: 30 000 ms).
 *     Applied in server.js — exported here as TIMEOUT_MS for convenience.
 *
 *   - HIGH: Billing webhook comment clarified.
 *     express.json() IS registered globally before billing route.
 *     billing.routes.js MUST call express.raw() on the webhook sub-path itself
 *     to override the body parser before Stripe signature verification.
 *     Added assertion comment so future maintainers don't remove it.
 *
 *   - MEDIUM: Gzip compression added via the `compression` package.
 *     Reduces response sizes for large OCR / AI / pipeline report payloads.
 *     Excluded for Stripe webhook path to preserve raw body for sig check.
 *
 *   - MEDIUM: CORS origin matching now normalises trailing slashes.
 *     Old: exact string match — "https://app.com/" ≠ "https://app.com"
 *     New: strips trailing slash before comparison on both sides.
 *
 *   - MEDIUM: Dev request logger replaced with structured log object.
 *     Avoids accidental PII/token leakage from raw query-string logging.
 *     Logs method, path, and timestamp only — never query params or body.
 *
 *   - MEDIUM: Directory creation wrapped in try/catch.
 *     Old: fs.mkdirSync throws on read-only containerised filesystems.
 *     New: logs a warning and continues — app stays alive; ops can investigate.
 *
 *   - LOW: Health check no longer exposes uptime or timestamp.
 *     Returns only { status: "ok" } in production.
 *     Uptime + timestamp retained in development for debugging convenience.
 *
 * Security (preserved from V4):
 *   1. Helmet.js — secure HTTP headers
 *   2. Rate limiting per route category
 *   3. Input validation middleware
 *   4. Upload security middleware
 *   5. Parameter sanitisation
 *   6. Request size limits tightened
 *   7. CORS locked down
 *   8. Trust proxy for accurate IP rate limiting
 *   9. BullMQ queue route (/api/queue/*)
 */

const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');  // NEW: gzip responses
const path        = require('path');
const fs          = require('fs');

const {
  globalLimiter,
  authLimiter,
  uploadLimiter,
  voiceLimiter,
  aiLimiter,
} = require('./middleware/rateLimiter');

const { validate, schemas, sanitiseParams } = require('./middleware/validate');

const app = express();

// Exported so server.js can apply it to the HTTP server instance.
// This stays a SHORT default (30s) on purpose — it's the slowloris/stalled-
// connection guard for lightweight routes (auth, health, voice, ai chat, etc.)
// Heavy routes (OCR, uploads, reconcile/execute) get their own longer socket
// timeout below via extendTimeout(), instead of raising this global value.
// Raising the global value would weaken slowloris protection on every fast
// route just to accommodate a handful of slow ones.
const TIMEOUT_MS = parseInt(process.env.SERVER_TIMEOUT_MS || '30000', 10);
app.locals.TIMEOUT_MS = TIMEOUT_MS;

// ── Per-route socket timeout override ─────────────────────────────────────────
// FIX: server.setTimeout(TIMEOUT_MS) in server.js applies a 30s socket-idle
// timeout to EVERY connection by default. The frontend (api.js V4) was fixed
// to wait up to 660s for reconcile/execute and 360s for OCR — but the server
// socket was still killing those same connections at 30s, before the
// patient frontend timeout ever got a chance to fire. This produced
// "Network error: Failed to fetch" (a raw connection reset) even though the
// backend was still working correctly, just slower than 30s.
// req.setTimeout()/res.setTimeout() override the default for that one
// request's socket only — every other route keeps the fast 30s default.
function extendTimeout(ms) {
  return (req, res, next) => {
    req.setTimeout(ms);
    res.setTimeout(ms);
    next();
  };
}
const OCR_ROUTE_TIMEOUT_MS         = parseInt(process.env.OCR_ROUTE_TIMEOUT_MS         || '360000', 10); // 6 min — matches frontend OCR_TIMEOUT_MS
const UPLOAD_ROUTE_TIMEOUT_MS      = parseInt(process.env.UPLOAD_ROUTE_TIMEOUT_MS      || '300000', 10); // 5 min — large CSV/XLSX/ZIP parsing
const PROCUREMENT_ROUTE_TIMEOUT_MS = parseInt(process.env.PROCUREMENT_ROUTE_TIMEOUT_MS || '660000', 10); // 11 min — matches frontend RECONCILE/EXECUTE_TIMEOUT_MS

// ── Trust proxy ───────────────────────────────────────────────────────────────
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// ── Ensure required directories exist (non-fatal on read-only FS) ─────────────
const OUTPUTS_DIR = path.join(__dirname, '../outputs');
const LOGS_DIR    = path.join(__dirname, 'logs');
const TEMP_DIR    = path.join(__dirname, 'temp');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const WORKER_TEMP = path.join(__dirname, 'temp/worker_jobs');

for (const dir of [OUTPUTS_DIR, LOGS_DIR, TEMP_DIR, UPLOADS_DIR, WORKER_TEMP]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    // FIX: non-fatal — containerised read-only filesystems should not crash the app
    console.warn(`[app] Could not create directory "${dir}": ${err.message}`);
  }
}

// ── SECURITY: Helmet ──────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc : ["'self'"],
      scriptSrc  : ["'self'"],
      styleSrc   : ["'self'", "'unsafe-inline'"],
      imgSrc     : ["'self'", 'data:', 'https:'],
      connectSrc : ["'self'", 'https://www.googleapis.com'],
      fontSrc    : ["'self'"],
      objectSrc  : ["'none'"],
      mediaSrc   : ["'self'"],
      frameSrc   : ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: process.env.NODE_ENV === 'production'
    ? { maxAge: 31536000, includeSubDomains: true, preload: true }
    : false,
}));

// ── SECURITY: CORS ────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL || 'http://localhost:3000',
  process.env.CORS_ORIGIN,
].filter(Boolean);

// FIX: normalise trailing slashes before comparison
// "https://app.com/" and "https://app.com" now both match "https://app.com"
function _normaliseOrigin(o) {
  return o ? o.replace(/\/$/, '') : '';
}

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const normOrigin   = _normaliseOrigin(origin);
    const isAllowed    = ALLOWED_ORIGINS.some(
      allowed => _normaliseOrigin(allowed) === normOrigin
    );
    if (isAllowed) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials   : true,
  methods       : ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── SECURITY: Global rate limiter ─────────────────────────────────────────────
app.use(globalLimiter);

// ── Compression (gzip) ────────────────────────────────────────────────────────
// FIX: exclude Stripe webhook path — raw body must be preserved for sig verification
app.use(compression({
  filter: (req) => {
    if (req.path && req.path.startsWith('/api/billing/webhook')) return false;
    return compression.filter(req, req.res);
  },
}));

// ── Body parsing ──────────────────────────────────────────────────────────────
// NOTE FOR MAINTAINERS: express.json() is intentionally registered globally here.
// The Stripe billing webhook at /api/billing/webhook MUST override this with
// express.raw({ type: 'application/json' }) in billing.routes.js BEFORE the
// signature verification middleware — otherwise Stripe sig checks will fail.
// Do NOT move or remove this global parser thinking it will "fix" billing.
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── REMOVED: Public static upload endpoint ────────────────────────────────────
// FIX (CRITICAL): The previous line below was removed:
//   app.use('/uploads', express.static(UPLOADS_DIR))
// This exposed ALL uploaded files (invoices, contracts, passports) publicly.
// Files are now served only through the authenticated endpoint in data.routes.js.
// To serve a file, use: GET /api/data/files/:filename  (auth required)

// ── Structured request logger (dev only) ──────────────────────────────────────
// FIX: structured log object — never logs query strings, body, or tokens
if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => {
    const entry = {
      ts    : new Date().toISOString(),
      method: req.method,
      path  : req.path,
      // deliberately omit: req.query, req.body, req.headers (PII risk)
    };
    console.log('[req]', JSON.stringify(entry));
    next();
  });
}

// ── Health check ──────────────────────────────────────────────────────────────
// FIX: production returns minimal { status } — no uptime/timestamp information leakage
app.get('/health', (_req, res) => {
  const isProd = process.env.NODE_ENV === 'production';
  res.json({
    status: 'ok',
    ...(!isProd && {
      uptime   : process.uptime(),
      timestamp: new Date().toISOString(),
    }),
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// Auth
app.use('/api/auth/signup', authLimiter, validate(schemas.signup));
app.use('/api/auth/login',  authLimiter, validate(schemas.login));
app.use('/api/auth/google', authLimiter, validate(schemas.googleAuth));
app.use('/api/auth',        require('./routes/auth.routes'));

// Data (includes authenticated file-serving endpoint — replaces public /uploads)
// FIX: extendTimeout — large CSV/XLSX/ZIP uploads (up to 500MB) need more than 30s
app.use('/api/data',        uploadLimiter, extendTimeout(UPLOAD_ROUTE_TIMEOUT_MS), require('./routes/data.routes'));

// AI
app.use('/api/ai',          aiLimiter, require('./routes/ai.routes'));

// Voice
app.use('/api/voice',       voiceLimiter, require('./routes/voice.routes'));

// Pipeline
app.use('/api/pipeline',    require('./routes/pipeline.routes'));

// Upload
// FIX: extendTimeout — same reasoning as /api/data above
app.use('/api/upload',      uploadLimiter, extendTimeout(UPLOAD_ROUTE_TIMEOUT_MS), require('./routes/upload.routes'));

// Procurement
// FIX: extendTimeout — reconcile/execute can legitimately run for minutes on large invoice sets
app.use('/api/procurement', sanitiseParams, extendTimeout(PROCUREMENT_ROUTE_TIMEOUT_MS), require('./routes/procurement.routes'));

// WhatsApp
app.use('/api/whatsapp',    require('./routes/whatsapp.routes'));

// OCR
// FIX: extendTimeout — OCR can legitimately take up to OCR_PYBRIDGE_TIMEOUT_MS (320s) server-side
app.use('/api/ocr',         uploadLimiter, extendTimeout(OCR_ROUTE_TIMEOUT_MS), require('./routes/ocr.routes'));

// Billing — webhook sub-route MUST internally override body parser with express.raw()
// See NOTE above in body-parsing section for details.
app.use('/api/billing',     require('./routes/billing.routes'));

// Queue status + health routes (async job polling for upload/OCR/reconcile)
app.use('/api/queue',       require('./routes/queue.routes'));

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found', code: 'NOT_FOUND' });
});

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const isProd  = process.env.NODE_ENV === 'production';
  const status  = err.status || err.statusCode || 500;

  // Structured error log — avoids leaking full request details in production
  console.error(JSON.stringify({
    ts    : new Date().toISOString(),
    level : 'error',
    method: req.method,
    path  : req.path,
    status,
    message: err.message,
    ...(err.trace && !isProd && { trace: err.trace }),
  }));

  if (err.message && err.message.startsWith('CORS:')) {
    return res.status(403).json({ error: 'CORS policy violation', code: 'CORS_ERROR' });
  }

  res.status(status).json({
    error: isProd && status >= 500 ? 'Something went wrong' : err.message,
    code : err.code || 'INTERNAL_ERROR',
    ...(err.partialResults && { partialResults: err.partialResults }),
    ...(!isProd && err.stack && { stack: err.stack }),
  });
});

module.exports = app;
