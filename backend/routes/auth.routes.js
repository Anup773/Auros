'use strict';
/**
 * backend/routes/auth.routes.js — Security Hardened
 *
 * Added: POST /logout endpoint
 * Note: validate() and authLimiter are applied in app.js before this router,
 * so no need to add them again here.
 */

const express  = require('express');
const router   = express.Router();
const authCtrl = require('../controllers/auth.controller');
const mfaCtrl     = require('../controllers/mfa.controller');
const apiKeyCtrl  = require('../controllers/apiKey.controller');
const { validate, schemas } = require('../middleware/validate');

router.post('/signup', authCtrl.signup);
router.post('/login',  authCtrl.login);
router.post('/google', authCtrl.googleAuth);
router.get ('/me',     authCtrl.requireAuth, authCtrl.getMe);
router.post('/logout', authCtrl.requireAuth, authCtrl.logout);

// ── PHASE 2 — sessions / refresh ──────────────────────────────────────────────
// Note: authLimiter is applied to these paths in app.js, the same way it's
// already applied to /api/auth/login etc. above.
router.post('/refresh',     validate(schemas.refreshToken), authCtrl.refresh);
router.post('/logout-all',  authCtrl.requireAuth, authCtrl.logoutAll);
router.get ('/sessions',    authCtrl.requireAuth, authCtrl.getSessions);

// ── PHASE 2 — MFA ──────────────────────────────────────────────────────────────
router.post('/mfa/setup',        authCtrl.requireAuth, mfaCtrl.setup);
router.post('/mfa/verify-setup', authCtrl.requireAuth, validate(schemas.mfaVerifySetup),    mfaCtrl.verifySetup);
router.post('/mfa/disable',      authCtrl.requireAuth, validate(schemas.mfaDisable),        mfaCtrl.disable);
router.post('/mfa/verify',       validate(schemas.mfaVerifyChallenge),                      mfaCtrl.verifyChallenge);

// ── PHASE 2 — API key management ──────────────────────────────────────────────
router.post  ('/api-keys',     authCtrl.requireAuth, validate(schemas.createApiKey), apiKeyCtrl.createApiKey);
router.get   ('/api-keys',     authCtrl.requireAuth, apiKeyCtrl.listApiKeys);
router.delete('/api-keys/:id', authCtrl.requireAuth, apiKeyCtrl.revokeApiKey);

module.exports = router;
