'use strict';
/**
 * backend/middleware/rbac.js
 *
 * Role-Based Access Control middleware.
 *
 * Roles (least → most privileged):
 *   viewer      — read-only: view jobs, audit logs
 *   reviewer    — viewer + approve/reject items
 *   finance     — reviewer + execute reconciliation, download output
 *   admin       — full access including user management
 *
 * Default role for all new users: 'reviewer'
 * (Most Auros users need to approve items — reviewer is the sensible default)
 *
 * Usage in routes:
 *   router.post('/execute', requireAuth, requireRole('finance'), ctrl.execute);
 *   router.get('/audit',    requireAuth, requireRole('viewer'),  ctrl.getAudit);
 */

// ── Role hierarchy ────────────────────────────────────────────────────────────
const ROLE_LEVELS = {
  viewer  : 1,
  reviewer: 2,
  finance : 3,
  admin   : 4,
};

// BUG FIX: this was 'finance' — every new/unrecognised user silently got the
// SECOND-HIGHEST privilege level (can execute reconciliation + download
// financial output), contradicting the file's own documented intent above
// ("Default role for all new users: 'reviewer'"). Also used as the fallback
// in requireRole() below when req.user.role is missing for any reason — a
// malformed user record should fail SAFE to the lower role, not escalate.
const DEFAULT_ROLE = 'reviewer';

// ── Middleware ────────────────────────────────────────────────────────────────

/**
 * Require a minimum role level.
 * Must be used AFTER requireAuth (req.user must exist).
 *
 * @param {string} minRole — 'viewer' | 'reviewer' | 'finance' | 'admin'
 */
function requireRole(minRole) {
  const minLevel = ROLE_LEVELS[minRole];

  if (minLevel === undefined) {
    throw new Error(`[rbac] Unknown role: "${minRole}". Valid: ${Object.keys(ROLE_LEVELS).join(', ')}`);
  }

  return (req, res, next) => {
    const userRole  = req.user?.role || DEFAULT_ROLE;
    const userLevel = ROLE_LEVELS[userRole] || ROLE_LEVELS[DEFAULT_ROLE];

    if (userLevel < minLevel) {
      return res.status(403).json({
        error: `Insufficient permissions. Required role: ${minRole}. Your role: ${userRole}`,
        code : 'INSUFFICIENT_ROLE',
      });
    }

    next();
  };
}

/**
 * Admin-only shorthand.
 */
const requireAdmin = requireRole('admin');

/**
 * Finance or above shorthand (execute, download).
 */
const requireFinance = requireRole('finance');

/**
 * Reviewer or above shorthand (approve/reject).
 */
const requireReviewer = requireRole('reviewer');

/**
 * Assign default role to new users.
 * Call this when creating a user object.
 */
function assignDefaultRole(user) {
  if (!user.role) user.role = DEFAULT_ROLE;
  return user;
}

/**
 * Validate that a role string is known.
 */
function isValidRole(role) {
  return role in ROLE_LEVELS;
}

module.exports = {
  requireRole,
  requireAdmin,
  requireFinance,
  requireReviewer,
  assignDefaultRole,
  isValidRole,
  DEFAULT_ROLE,
  ROLE_LEVELS,
};
