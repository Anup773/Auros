'use strict';
/**
 * backend/controllers/admin.controller.js
 *
 * PHASE 2 — "Advanced RBAC (admin manages user roles)".
 *
 * middleware/rbac.js already has a solid hierarchical role-check system
 * (viewer < reviewer < finance < admin) — that part of Phase 1 was fine.
 * What was actually missing (confirmed by reading the whole backend): there
 * was no endpoint anywhere for an admin to CHANGE another user's role, or
 * to suspend an account. This file adds exactly that, reusing
 * isValidRole/ROLE_LEVELS already exported from rbac.js.
 *
 * All handlers here are expected to be mounted behind
 * `requireAuth, requireAdmin` in routes/admin.routes.js.
 */

const authController = require('./auth.controller');
const sessionStore   = require('../services/auth/sessionStore.service');
const securityLogger = require('../audit/securityLogger.service');
const { isValidRole } = require('../middleware/rbac');

const { userStore, _userByIdStore, saveUsers } = authController;

function safeUserForAdmin(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    provider: user.provider,
    createdAt: user.createdAt,
    mfaEnabled: !!user.mfaEnabled,
    disabled: !!user.disabled,
  };
}

// ── GET /api/admin/users  ─────────────────────────────────────────────────────
exports.listUsers = (req, res) => {
  const users = [...userStore.values()].map(safeUserForAdmin);
  res.json({ users });
};

// ── PATCH /api/admin/users/:id/role   body: { role } ──────────────────────────
exports.updateUserRole = async (req, res) => {
  const { id } = req.params;
  const { role } = req.body || {};

  if (!role || !isValidRole(role)) {
    return res.status(400).json({ error: 'A valid role is required', code: 'INVALID_ROLE' });
  }
  if (id === req.user.id) {
    // An admin locking themselves out (or accidentally self-demoting) is a
    // classic way to lock an entire org out of admin access. Require a
    // DIFFERENT admin to make this change.
    return res.status(400).json({ error: 'You cannot change your own role. Ask another admin to do this.', code: 'CANNOT_MODIFY_SELF' });
  }

  const user = _userByIdStore.get(id);
  if (!user) return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });

  const previousRole = user.role;
  user.role = role;
  saveUsers();

  // A role change is a permission change — it should take effect
  // immediately, not whenever the user's current token happens to expire.
  const revokedCount = await sessionStore.revokeAllSessionsForUser(user.id, 'role_changed');

  securityLogger.roleChanged({
    targetUserId: user.id, previousRole, newRole: role,
    changedBy: req.user.id, ip: req.ip, sessionsRevoked: revokedCount,
  });

  res.json({ success: true, user: safeUserForAdmin(user), sessionsRevoked: revokedCount });
};

// ── POST /api/admin/users/:id/disable ─────────────────────────────────────────
exports.disableUser = async (req, res) => {
  const { id } = req.params;
  if (id === req.user.id) {
    return res.status(400).json({ error: 'You cannot disable your own account.', code: 'CANNOT_MODIFY_SELF' });
  }

  const user = _userByIdStore.get(id);
  if (!user) return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });

  user.disabled = true;
  saveUsers();
  const revokedCount = await sessionStore.revokeAllSessionsForUser(user.id, 'account_disabled');

  securityLogger.logSecurityEvent('ACCOUNT_DISABLED', {
    targetUserId: user.id, disabledBy: req.user.id, ip: req.ip, severity: 'high', sessionsRevoked: revokedCount,
  });

  res.json({ success: true, user: safeUserForAdmin(user), sessionsRevoked: revokedCount });
};

// ── POST /api/admin/users/:id/enable ──────────────────────────────────────────
exports.enableUser = (req, res) => {
  const { id } = req.params;
  const user = _userByIdStore.get(id);
  if (!user) return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });

  user.disabled = false;
  saveUsers();

  securityLogger.logSecurityEvent('ACCOUNT_ENABLED', { targetUserId: user.id, enabledBy: req.user.id, ip: req.ip, severity: 'medium' });

  res.json({ success: true, user: safeUserForAdmin(user) });
};

// ── GET /api/admin/security-log?date=YYYY-MM-DD ───────────────────────────────
// A small operational nicety on top of the new SOC2-style logging: lets an
// admin pull a day's security events (and confirm the log hasn't been
// tampered with) without shelling into the server.
exports.getSecurityLog = async (req, res) => {
  const dateStr = typeof req.query.date === 'string' ? req.query.date : undefined;
  const [events, integrity] = await Promise.all([
    securityLogger.getEvents(dateStr),
    securityLogger.verifyChainIntegrity(dateStr),
  ]);
  res.json({ events, integrity });
};
