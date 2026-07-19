'use strict';
/**
 * backend/controllers/apiKey.controller.js
 *
 * PHASE 2 — "API key management". Thin HTTP layer over
 * services/auth/apiKey.service.js. All handlers expect requireAuth to have
 * already populated req.user.
 */

const apiKeyService  = require('../services/auth/apiKey.service');
const securityLogger = require('../audit/securityLogger.service');
const { ROLE_LEVELS } = require('../middleware/rbac');

// ── POST /api/auth/api-keys   body: { name, role?, expiresInDays? } ──────────
exports.createApiKey = (req, res) => {
  const { name, role, expiresInDays } = req.body || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name is required', code: 'MISSING_NAME' });
  }
  if (role && !(role in ROLE_LEVELS)) {
    return res.status(400).json({ error: 'Invalid role', code: 'INVALID_ROLE' });
  }
  if (role && ROLE_LEVELS[role] > ROLE_LEVELS[req.user.role]) {
    return res.status(403).json({ error: 'Cannot create a key with a role higher than your own', code: 'ROLE_TOO_HIGH' });
  }
  if (expiresInDays != null && (typeof expiresInDays !== 'number' || expiresInDays <= 0 || expiresInDays > 3650)) {
    return res.status(400).json({ error: 'expiresInDays must be a positive number (max 3650)', code: 'INVALID_EXPIRY' });
  }

  const created = apiKeyService.createApiKey(req.user.id, name, { role, expiresInDays });
  securityLogger.logSecurityEvent('API_KEY_CREATED', { userId: req.user.id, keyId: created.id, ip: req.ip });

  // `key` (the full plaintext value) is returned ONLY in this response —
  // make sure the caller knows to save it now.
  res.status(201).json({ ...created, warning: 'Save this key now — it will not be shown again.' });
};

// ── GET /api/auth/api-keys ────────────────────────────────────────────────────
exports.listApiKeys = (req, res) => {
  res.json({ keys: apiKeyService.listApiKeysForUser(req.user.id) });
};

// ── DELETE /api/auth/api-keys/:id ─────────────────────────────────────────────
exports.revokeApiKey = (req, res) => {
  const ok = apiKeyService.revokeApiKey(req.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'API key not found', code: 'KEY_NOT_FOUND' });

  securityLogger.logSecurityEvent('API_KEY_REVOKED', { userId: req.user.id, keyId: req.params.id, ip: req.ip });
  res.json({ success: true });
};
