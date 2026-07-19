'use strict';
/**
 * backend/controllers/mfa.controller.js
 *
 * PHASE 2 — MFA (TOTP) HTTP handlers.
 *
 * Enrollment endpoints (setup/verifySetup/disable) require an existing
 * session (mounted with requireAuth in routes/auth.routes.js). The
 * login-time challenge endpoint (verifyChallenge) does NOT — it's how a
 * user with MFA already enabled finishes logging in, so by definition
 * there's no session yet at that point.
 *
 * IMPORTANT — FRONTEND INTEGRATION NOTE (see PHASE2_SECURITY.md for the
 * full version): enabling MFA for an account makes login/googleAuth return
 * `{ mfaRequired: true, challengeToken }` instead of a normal session. The
 * current frontend has no UI to prompt for a code in that case. Per the
 * instruction not to modify frontend files, that UI was intentionally NOT
 * built here — enable MFA on a real account only once that UI exists, or
 * the account will be unable to complete login through the current app.
 */

const authController = require('./auth.controller');
const mfaService      = require('../services/auth/mfa.service');
const sessionStore    = require('../services/auth/sessionStore.service');
const securityLogger  = require('../audit/securityLogger.service');

const { _userByIdStore, saveUsers } = authController;

function safeUser(user) {
  const { passwordHash, mfaSecretEncrypted, mfaBackupCodeHashes, ...safe } = user;
  return { ...safe, mfaEnabled: !!user.mfaEnabled };
}

// ── POST /api/auth/mfa/setup  (requireAuth) ───────────────────────────────────
exports.setup = async (req, res, next) => {
  try {
    if (!mfaService.isConfigured()) {
      return res.status(503).json({ error: 'MFA is not configured on this server.', code: 'MFA_NOT_CONFIGURED' });
    }
    const enrollment = await mfaService.beginEnrollment(req.user.id, req.user.email);
    res.json({
      otpauthUrl: enrollment.otpauthUrl,
      qrCodeDataUrl: enrollment.qrCodeDataUrl,
      manualEntryKey: enrollment.secret, // for "can't scan? enter this code manually"
    });
  } catch (err) { next(err); }
};

// ── POST /api/auth/mfa/verify-setup  (requireAuth)  body: { code } ───────────
exports.verifySetup = async (req, res, next) => {
  try {
    const { code } = req.body || {};
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'code is required', code: 'MISSING_CODE' });
    }

    const result = await mfaService.completeEnrollment(req.user.id, code);
    if (!result.valid) {
      securityLogger.logSecurityEvent('MFA_ENROLLMENT_FAILED', { userId: req.user.id, ip: req.ip, reason: result.reason });
      return res.status(400).json({ error: 'Invalid or expired code. Please restart MFA setup.', code: 'INVALID_MFA_CODE' });
    }

    const backupCodes = mfaService.generateBackupCodes(10);
    const user = _userByIdStore.get(req.user.id);
    user.mfaEnabled = true;
    user.mfaSecretEncrypted = mfaService.encryptSecret(result.secret);
    user.mfaBackupCodeHashes = backupCodes.map(c => mfaService.hashBackupCode(c));
    user.mfaEnabledAt = new Date().toISOString();
    user.mfaLastTimeStep = result.timeStep;
    saveUsers();

    securityLogger.logSecurityEvent('MFA_ENABLED', { userId: user.id, ip: req.ip, severity: 'high' });

    // Backup codes are shown ONCE, here, in full — never retrievable again.
    res.json({ success: true, backupCodes });
  } catch (err) { next(err); }
};

// ── POST /api/auth/mfa/disable  (requireAuth)  body: { password? , code? } ──
exports.disable = async (req, res, next) => {
  try {
    const user = _userByIdStore.get(req.user.id);
    if (!user.mfaEnabled) {
      return res.status(400).json({ error: 'MFA is not enabled on this account.', code: 'MFA_NOT_ENABLED' });
    }

    // Re-verify identity before disabling a security control: either the
    // account password (email/password accounts) or a current TOTP code.
    const { password, code } = req.body || {};
    let verified = false;

    if (code) {
      const result = await mfaService.verifyTotp(user.mfaSecretEncrypted, code, user.mfaLastTimeStep);
      verified = result.valid;
      if (verified) user.mfaLastTimeStep = result.timeStep;
    } else if (password && user.provider === 'email' && user.passwordHash) {
      const bcrypt = require('bcryptjs');
      verified = await bcrypt.compare(password, user.passwordHash);
    }

    if (!verified) {
      securityLogger.logSecurityEvent('MFA_DISABLE_FAILED', { userId: user.id, ip: req.ip, severity: 'medium' });
      return res.status(401).json({ error: 'Re-verification failed. Provide your current password or a valid MFA code.', code: 'REVERIFICATION_FAILED' });
    }

    user.mfaEnabled = false;
    user.mfaSecretEncrypted = null;
    user.mfaBackupCodeHashes = null;
    user.mfaLastTimeStep = null;
    saveUsers();

    // Disabling a security control is exactly the moment to make sure no
    // OTHER already-open session (e.g. from a device the real owner no
    // longer controls) survives the change.
    const revokedCount = await sessionStore.revokeAllSessionsForUser(user.id, 'mfa_disabled');
    securityLogger.logSecurityEvent('MFA_DISABLED', { userId: user.id, ip: req.ip, severity: 'high', sessionsRevoked: revokedCount });

    // Re-issue a session for the very request that just disabled MFA,
    // so the user isn't immediately logged out by the line above.
    const session = await sessionStore.createSession(user.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
    res.json({ success: true, token: session.accessToken, refreshToken: session.refreshToken });
  } catch (err) { next(err); }
};

// ── POST /api/auth/mfa/verify  (NO auth — completes login)  ──────────────────
// body: { challengeToken, code } OR { challengeToken, backupCode }
exports.verifyChallenge = async (req, res, next) => {
  try {
    const { challengeToken, code, backupCode } = req.body || {};
    if (!challengeToken || (!code && !backupCode)) {
      return res.status(400).json({ error: 'challengeToken and (code or backupCode) are required', code: 'MISSING_FIELDS' });
    }

    const userId = await mfaService.consumeLoginChallenge(challengeToken);
    if (!userId) {
      return res.status(401).json({ error: 'Challenge expired or invalid. Please log in again.', code: 'INVALID_CHALLENGE' });
    }

    const user = _userByIdStore.get(userId);
    if (!user || !user.mfaEnabled) {
      return res.status(401).json({ error: 'Invalid challenge.', code: 'INVALID_CHALLENGE' });
    }

    let verified = false;

    if (code) {
      const result = await mfaService.verifyTotp(user.mfaSecretEncrypted, code, user.mfaLastTimeStep);
      verified = result.valid;
      if (verified) { user.mfaLastTimeStep = result.timeStep; saveUsers(); }
    } else if (backupCode) {
      const idx = mfaService.findBackupCodeIndex(backupCode, user.mfaBackupCodeHashes || []);
      if (idx !== -1) {
        verified = true;
        user.mfaBackupCodeHashes.splice(idx, 1); // single-use
        saveUsers();
        securityLogger.logSecurityEvent('MFA_BACKUP_CODE_USED', {
          userId: user.id, ip: req.ip, remainingCodes: user.mfaBackupCodeHashes.length, severity: 'medium',
        });
      }
    }

    if (!verified) {
      securityLogger.logSecurityEvent('MFA_CHALLENGE_FAILED', { userId: user.id, ip: req.ip, severity: 'medium' });
      return res.status(401).json({ error: 'Invalid code.', code: 'INVALID_MFA_CODE' });
    }

    const session = await sessionStore.createSession(user.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
    securityLogger.logSecurityEvent('LOGIN_SUCCESS', { userId: user.id, ip: req.ip, method: 'mfa' });
    res.json({ token: session.accessToken, refreshToken: session.refreshToken, user: safeUser(user) });
  } catch (err) { next(err); }
};