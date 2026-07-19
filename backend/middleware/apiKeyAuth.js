'use strict';
/**
 * backend/middleware/apiKeyAuth.js
 *
 * PHASE 2 — "API key management".
 *
 * Alternative auth path for programmatic/machine callers (e.g. a CI job or
 * an external system triggering reconciliation without a human logging in).
 * Reads the `X-API-Key` header, verifies it via apiKey.service, and — like
 * requireAuth — populates req.user so downstream middleware.rbac's
 * requireRole()/requireAdmin() work completely unchanged with either auth
 * method.
 *
 * NOT mounted on any existing route by default: the existing routes were
 * all built (and are working) around requireAuth's session-cookie-style
 * bearer token, and deciding which specific business endpoints should also
 * accept API keys is a product decision, not a security one. Attach it the
 * same way requireAuth is used, e.g.:
 *
 *   const { requireApiKey } = require('../middleware/apiKeyAuth');
 *   router.post('/some-route', requireApiKey, requireRole('finance'), ctrl.fn);
 *
 * Or, to accept EITHER a user session OR an API key on the same route, use
 * requireAuthOrApiKey below.
 */

const apiKeyService = require('../services/auth/apiKey.service');
const securityLogger = require('../audit/securityLogger.service');

/**
 * Resolve the effective role for an API-key-authenticated request.
 * A key's `role` field (set at creation) is a CEILING, never a grant beyond
 * what its owning user actually has right now — so if the owner's role was
 * downgraded after the key was created, the key is downgraded too.
 */
function _resolveRole(record, ownerUser) {
  const ownerRole = ownerUser?.role || 'reviewer';
  if (!record.role) return ownerRole;

  const { ROLE_LEVELS } = require('../middleware/rbac');
  const ownerLevel = ROLE_LEVELS[ownerRole] ?? ROLE_LEVELS.reviewer;
  const keyLevel    = ROLE_LEVELS[record.role] ?? ROLE_LEVELS.reviewer;
  return keyLevel <= ownerLevel ? record.role : ownerRole;
}

async function requireApiKey(req, res, next) {
  const rawKey = req.headers['x-api-key'];
  if (!rawKey) {
    return res.status(401).json({ error: 'API key required', code: 'NO_API_KEY' });
  }

  const result = await apiKeyService.verifyApiKey(rawKey);
  if (!result.valid) {
    securityLogger.logSecurityEvent('API_KEY_REJECTED', {
      reason: result.reason, ip: req.ip, path: req.path, severity: 'medium',
    });
    return res.status(401).json({ error: 'Invalid or expired API key', code: 'INVALID_API_KEY' });
  }

  // Lazy require to avoid a hard circular dependency at module-load time —
  // auth.controller.js doesn't require this file, only the other way round.
  const { _userByIdStore } = require('../controllers/auth.controller');
  const ownerUser = _userByIdStore.get(result.userId);
  if (!ownerUser) {
    return res.status(401).json({ error: 'API key owner no longer exists', code: 'OWNER_NOT_FOUND' });
  }

  req.user = {
    id: ownerUser.id,
    name: ownerUser.name,
    email: ownerUser.email,
    role: _resolveRole(result, ownerUser),
  };
  req.apiKeyId = result.keyId;
  req.authMethod = 'apiKey';
  next();
}

/** Accept either a normal user session OR an API key on the same route. */
function requireAuthOrApiKey(req, res, next) {
  const { requireAuth } = require('../controllers/auth.controller');
  if (req.headers['x-api-key']) return requireApiKey(req, res, next);
  return requireAuth(req, res, next);
}

module.exports = { requireApiKey, requireAuthOrApiKey };
