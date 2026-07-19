'use strict';
/**
 * backend/services/auth/mfa.service.js
 *
 * PHASE 2 — Multi-factor authentication (TOTP, RFC 6238 / Google-Authenticator
 * compatible), with encrypted-at-rest secrets and single-use backup codes.
 *
 * This module is intentionally self-contained: it has NO dependency on
 * auth.controller.js or users.json. It only knows about TOTP secrets, backup
 * codes, and a short-lived "pending enrollment" Redis entry. The controller
 * layer (controllers/mfa.controller.js) is what reads/writes the actual user
 * record (mfaEnabled, encrypted secret, backup-code hashes) via the existing
 * userStore/_userByIdStore/saveUsers already exported from auth.controller.js.
 * That keeps this file testable in isolation and avoids any circular require
 * between auth.controller.js and this service.
 *
 * ── Secret storage ────────────────────────────────────────────────────────
 * A TOTP secret is a durable shared secret — equivalent in sensitivity to a
 * password, and unlike a password it can't be hashed (the server needs the
 * plaintext to compute the expected code), so it's encrypted at rest instead,
 * with AES-256-GCM under a key derived from MFA_ENCRYPTION_KEY.
 *
 * ── Replay protection ─────────────────────────────────────────────────────
 * A TOTP code stays valid for the entire ~30s step (plus tolerance either
 * side), so without extra care the SAME code could be accepted twice inside
 * that window. verifyTotp() accepts an `afterTimeStep` cursor (the last
 * timeStep that was successfully used for this user) and passes it straight
 * through to otplib, which rejects any code at or before that step. Callers
 * are expected to persist the returned `timeStep` and pass it back in as
 * `afterTimeStep` on the next call.
 */

const crypto = require('crypto');
const { generateSecret, generate, verify, generateURI } = require('otplib');
const QRCode = require('qrcode');
const sharedRedis = require('../../config/redis');

const ISSUER = process.env.MFA_ISSUER || 'Auros';
const EPOCH_TOLERANCE_SEC = parseInt(process.env.MFA_EPOCH_TOLERANCE_SEC || '30', 10);
const PENDING_TTL_SEC = 10 * 60; // 10 minutes to complete enrollment after scanning the QR code

// ── Encryption key setup ──────────────────────────────────────────────────────
// Operators can set MFA_ENCRYPTION_KEY to any sufficiently random string
// (e.g. `openssl rand -hex 32`) — it's run through SHA-256 to derive a fixed
// 32-byte AES-256 key, so the env var itself doesn't need to be exactly the
// right length/format.
const _rawKey = process.env.MFA_ENCRYPTION_KEY || null;
if (!_rawKey) {
  console.warn(
    '[mfa] WARNING: MFA_ENCRYPTION_KEY is not set. MFA enrollment will be ' +
    'unavailable until it is configured — set it to a long random value ' +
    '(e.g. `openssl rand -hex 32`) before enabling MFA in production.'
  );
}
const _encKey = _rawKey ? crypto.createHash('sha256').update(_rawKey).digest() : null;

function isConfigured() {
  return _encKey !== null;
}

// ── Local fallback for pending-enrollment state (mirrors the rest of the
//    Phase 2 codebase's graceful-degradation pattern). ────────────────────────
const _localPending = new Map(); // userId -> { secret, expiresAt }
setInterval(() => {
  const now = Date.now();
  for (const [id, v] of _localPending.entries()) if (v.expiresAt < now) _localPending.delete(id);
  for (const [t, v] of _localChallenges.entries()) if (v.expiresAt < now) _localChallenges.delete(t);
}, 5 * 60 * 1000).unref?.();

// ── Encryption ────────────────────────────────────────────────────────────────

function encryptSecret(plaintext) {
  if (!_encKey) throw new Error('MFA_ENCRYPTION_KEY is not configured — cannot encrypt MFA secret.');
  const iv = crypto.randomBytes(12); // GCM standard IV size
  const cipher = crypto.createCipheriv('aes-256-gcm', _encKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function decryptSecret(encoded) {
  if (!_encKey) throw new Error('MFA_ENCRYPTION_KEY is not configured — cannot decrypt MFA secret.');
  const buf = Buffer.from(encoded, 'base64');
  const iv        = buf.subarray(0, 12);
  const authTag   = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', _encKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ── Enrollment (setup) ────────────────────────────────────────────────────────

/**
 * Start MFA enrollment: generates a new secret, stashes it server-side
 * (Redis, with local fallback) for PENDING_TTL_SEC, and returns everything
 * the frontend needs to render a QR code + manual-entry key.
 */
async function beginEnrollment(userId, email) {
  if (!isConfigured()) {
    throw Object.assign(new Error('MFA is not configured on this server.'), { code: 'MFA_NOT_CONFIGURED' });
  }
  const secret = generateSecret();
  const expiresAt = Date.now() + PENDING_TTL_SEC * 1000;

  _localPending.set(userId, { secret, expiresAt });
  if (sharedRedis.isAvailable()) {
    try {
      await sharedRedis.redis.set(`mfa:pending:${userId}`, secret, 'EX', PENDING_TTL_SEC);
    } catch (err) {
      console.warn('[mfa] Redis write failed for pending enrollment, using local fallback only:', err.message);
    }
  }

  const otpauthUrl = generateURI({ issuer: ISSUER, label: email, secret });
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);
  return { secret, otpauthUrl, qrCodeDataUrl };
}

async function _getPendingSecret(userId) {
  const local = _localPending.get(userId);
  if (local && local.expiresAt > Date.now()) return local.secret;

  if (sharedRedis.isAvailable()) {
    try {
      const secret = await sharedRedis.redis.get(`mfa:pending:${userId}`);
      if (secret) return secret;
    } catch (err) {
      console.warn('[mfa] Redis read failed for pending enrollment:', err.message);
    }
  }
  return null;
}

async function _clearPendingSecret(userId) {
  _localPending.delete(userId);
  if (sharedRedis.isAvailable()) {
    try { await sharedRedis.redis.del(`mfa:pending:${userId}`); } catch { /* best-effort */ }
  }
}

/**
 * Complete enrollment: verify the code against the pending secret.
 * On success, returns the plaintext secret so the caller can encrypt and
 * persist it on the user record — this function does NOT touch users.json.
 */
async function completeEnrollment(userId, code) {
  const secret = await _getPendingSecret(userId);
  if (!secret) return { valid: false, reason: 'NO_PENDING_ENROLLMENT' };

  const result = await verify({ secret, token: code, epochTolerance: EPOCH_TOLERANCE_SEC });
  if (!result.valid) return { valid: false, reason: 'INVALID_CODE' };

  await _clearPendingSecret(userId);
  return { valid: true, secret, timeStep: result.timeStep };
}

// ── Login-time verification ───────────────────────────────────────────────────

/**
 * Verify a TOTP code against an already-enrolled (encrypted) secret.
 * `afterTimeStep`, if provided, blocks re-use of a code at or before that step.
 */
async function verifyTotp(encryptedSecret, code, afterTimeStep) {
  const secret = decryptSecret(encryptedSecret);
  const opts = { secret, token: code, epochTolerance: EPOCH_TOLERANCE_SEC };
  if (afterTimeStep) opts.afterTimeStep = afterTimeStep;
  const result = await verify(opts);
  return result; // { valid, timeStep, ... }
}

// ── Backup codes ──────────────────────────────────────────────────────────────

const _BACKUP_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L ambiguity

function _randomBackupCode() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += _BACKUP_CODE_ALPHABET[bytes[i] % _BACKUP_CODE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

function generateBackupCodes(count = 10) {
  return Array.from({ length: count }, _randomBackupCode);
}

function _normalizeBackupCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Backup codes are high-entropy and single-use, so SHA-256 (not bcrypt) is fine. */
function hashBackupCode(code) {
  return crypto.createHash('sha256').update(_normalizeBackupCode(code)).digest('hex');
}

/**
 * @param {string} code           the code the user typed
 * @param {string[]} hashedCodes  the user's stored (hashed) backup codes
 * @returns {number} index of the matching hash, or -1 if none matched.
 *                   Caller MUST remove that index from storage (single-use).
 */
function findBackupCodeIndex(code, hashedCodes) {
  const target = hashBackupCode(code);
  return (hashedCodes || []).findIndex(h => {
    try {
      return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(target, 'hex'));
    } catch {
      return false;
    }
  });
}

// ── Login-time MFA challenge ──────────────────────────────────────────────────
// Issued after password/Google credentials check out for an MFA-enabled
// account, but before a real session is granted. Single-use, short TTL.
const CHALLENGE_TTL_SEC = 5 * 60;
const _localChallenges = new Map(); // challengeToken -> { userId, expiresAt }

async function createLoginChallenge(userId) {
  const challengeToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + CHALLENGE_TTL_SEC * 1000;
  _localChallenges.set(challengeToken, { userId, expiresAt });

  if (sharedRedis.isAvailable()) {
    try {
      await sharedRedis.redis.set(`mfa:challenge:${challengeToken}`, userId, 'EX', CHALLENGE_TTL_SEC);
    } catch (err) {
      console.warn('[mfa] Redis write failed for login challenge, using local fallback only:', err.message);
    }
  }
  return challengeToken;
}

/** Single-use: consuming a challenge token invalidates it immediately. */
async function consumeLoginChallenge(challengeToken) {
  const local = _localChallenges.get(challengeToken);
  if (local) {
    _localChallenges.delete(challengeToken);
    if (sharedRedis.isAvailable()) {
      try { await sharedRedis.redis.del(`mfa:challenge:${challengeToken}`); } catch { /* best-effort */ }
    }
    return local.expiresAt > Date.now() ? local.userId : null;
  }

  if (sharedRedis.isAvailable()) {
    try {
      const userId = await sharedRedis.redis.get(`mfa:challenge:${challengeToken}`);
      if (userId) await sharedRedis.redis.del(`mfa:challenge:${challengeToken}`);
      return userId || null;
    } catch (err) {
      console.warn('[mfa] Redis read failed for login challenge:', err.message);
    }
  }
  return null;
}

module.exports = {
  isConfigured,
  encryptSecret,
  decryptSecret,
  beginEnrollment,
  completeEnrollment,
  verifyTotp,
  generateBackupCodes,
  hashBackupCode,
  findBackupCodeIndex,
  createLoginChallenge,
  consumeLoginChallenge,
};
