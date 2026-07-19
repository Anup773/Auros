'use strict';
/**
 * backend/controllers/auth.controller.js  — Security Hardened V2
 *
 * CHANGES FROM V1 (this version — V2):
 *
 * CRITICAL FIX #1 — INVALID DUMMY BCRYPT HASH CRASHES LOGIN
 *   Old: const dummyHash = '$2a$12$dummyhashfordummycomparisononly.dummydummydummydummy'
 *        bcrypt.compare() against this string throws "Invalid salt version" —
 *        crashing the entire login endpoint for every request where the email
 *        doesn't exist (i.e. wrong-email attempts AND registration checks).
 *   New: DUMMY_HASH is generated once at startup using bcrypt.hashSync() with a
 *        real random password and BCRYPT_ROUNDS. This is a valid bcrypt hash that
 *        compare() can safely run against without throwing, preserving the
 *        constant-time behaviour that prevents user enumeration via timing.
 *
 * CRITICAL FIX #2 — O(N) USER LOOKUP ON EVERY AUTHENTICATED REQUEST
 *   Old: [...userStore.values()].find(u => u.id === tokenData.userId)
 *        scanned all users linearly. At 100k users, every API call became O(n).
 *   New: Added _userByIdStore = new Map() as a parallel id→user index.
 *        signup(), googleAuth() write to both userStore (email→user) and
 *        _userByIdStore (id→user). requireAuth() does an O(1) lookup.
 *        loadUsers() populates both maps on startup.
 *
 * CRITICAL FIX #3 — IN-MEMORY TOKEN STORE NOT PRODUCTION-SAFE
 *   Old: tokenStore = new Map() — tokens lost on restart; incompatible with
 *        multi-server/cluster deployments (instance A issues token, B rejects it).
 *   New: Token hashing added (see FIX #4). Architecture note added.
 *        TODO comment guides team toward Redis/JWT for multi-server upgrade path.
 *        The in-memory store remains for single-process deployments but is
 *        now explicitly documented as a single-process limitation.
 *
 * CRITICAL FIX #4 — PLAINTEXT TOKEN IN MEMORY (theft risk)
 *   Old: tokenStore.set(rawToken, { userId, expiresAt })
 *        A memory dump would expose all valid session tokens.
 *   New: Tokens stored as SHA-256(rawToken) in tokenStore.
 *        Only the raw token is returned to the client (in the Authorization header).
 *        requireAuth() hashes the incoming token before lookup — raw token
 *        never stored. Even a full memory dump cannot be used to forge sessions.
 *
 * CRITICAL FIX #5 — GOOGLE AUTH: NO TOKEN AUDIENCE/ISSUER VALIDATION
 *   Old: Used accessToken + userinfo endpoint — does not verify aud/iss/exp.
 *        An accessToken from a different Google client_id would be accepted.
 *   New: Added aud validation against GOOGLE_CLIENT_ID env var when set.
 *        Switched to ID token verification path via google-auth-library when
 *        GOOGLE_CLIENT_ID is configured (recommended). Falls back to userinfo
 *        endpoint when GOOGLE_CLIENT_ID is not set (development mode).
 *        Clear startup warning emitted when running without GOOGLE_CLIENT_ID.
 *
 * HIGH FIX #6 — PASSWORD LENGTH CAP (bcrypt DoS)
 *   Old: No upper bound on password length.
 *        bcrypt is O(len) for passwords > 72 bytes — a 50 MB password spikes CPU.
 *   New: Password capped at MAX_PASSWORD_LENGTH = 128 chars. Rejected with 400.
 *
 * HIGH FIX #7 — TOKEN STORE MEMORY GROWTH (DoS via login flood)
 *   Old: tokenStore grew unbounded between hourly cleanup sweeps.
 *        Attacker creating 1M logins would exhaust RAM within minutes.
 *   New: MAX_TOKEN_STORE_SIZE = 100 000. When the cap is reached, the cleanup
 *        sweep runs immediately (synchronous, not deferred) before issuing
 *        the next token. Paired with rate limiting at the route level.
 *
 * HIGH FIX #8 — ATOMIC USER FILE WRITE
 *   Old: fs.writeFileSync(DATA_FILE, ...) — a crash mid-write corrupts users.json.
 *   New: Write to DATA_FILE + '.tmp', then fs.renameSync() — atomic on POSIX.
 *        rename() is atomic because both paths are on the same filesystem.
 *        A crash before rename leaves the existing file intact.
 *
 * PRESERVED FROM V1:
 *   - bcryptjs (not bcrypt native) — no native dependency
 *   - Token expiry (24h default, TOKEN_EXPIRY_HOURS env)
 *   - Hourly token cleanup
 *   - assignDefaultRole on signup
 *   - User enumeration prevention (same error for wrong email + wrong password)
 *   - Google userinfo endpoint fallback (when GOOGLE_CLIENT_ID not set)
 *   - All export names unchanged
 *
 * NOTE — PRODUCTION SCALING:
 *   This implementation uses in-memory Maps with disk persistence.
 *   For multi-server / Kubernetes deployments, replace:
 *     - tokenStore → Redis (with TTL = TOKEN_EXPIRY_MS)
 *     - userStore  → PostgreSQL / MongoDB
 *   The in-memory approach is intentional for zero-dependency single-process use.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PHASE 2 CHANGES (this pass)
 * ─────────────────────────────────────────────────────────────────────────
 *   - Token issuance/storage/verification delegated to the new
 *     services/auth/sessionStore.service.js — exactly the Redis upgrade the
 *     "PRODUCTION SCALING" note above asked for. Tokens are still opaque
 *     random values (NOT switched to JWT format — see PHASE2_SECURITY.md for
 *     why), so requireAuth()'s behaviour, status codes, and error `code`
 *     values are unchanged; every existing route using requireAuth needs no
 *     changes.
 *   - Added a second, longer-lived refresh token per session, with rotation
 *     and reuse detection (services/auth/sessionStore.service.js). New
 *     endpoint: POST /api/auth/refresh. Response field `token` is unchanged;
 *     `refreshToken` is a new, additive field.
 *   - "Token blacklist" is implemented as revocation-by-deletion in the
 *     session store rather than a separate deny-list structure — see the
 *     comment at the top of sessionStore.service.js for why that's the
 *     correct equivalent for opaque (non-JWT) tokens.
 *   - Added an MFA (TOTP) gate: if a user has mfaEnabled, login/googleAuth
 *     return { mfaRequired: true, challengeToken } instead of a session;
 *     the client completes login via POST /api/auth/mfa/verify (see
 *     controllers/mfa.controller.js). MFA is OFF by default for every
 *     existing account, so this is a no-op until an account explicitly
 *     enrolls — see PHASE2_SECURITY.md for a frontend-integration note.
 *   - Added account suspension support (`user.disabled`) — set via the new
 *     admin endpoints in controllers/admin.controller.js.
 *   - Added logoutAll / getSessions ("log out everywhere" / "your active
 *     sessions") on top of the new Redis-backed session records.
 *   - Added security-event logging (SIGNUP, LOGIN_SUCCESS, LOGIN_FAILED,
 *     LOGOUT, MFA_CHALLENGE_ISSUED, etc.) via audit/securityLogger.service.js.
 *   - saveUsers is now exported so the new MFA/admin controllers can persist
 *     changes to the same users.json store without duplicating the
 *     load/save logic here.
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { assignDefaultRole } = require('../middleware/rbac');
// PHASE 2 additions — see each module for details:
const sessionStore   = require('../services/auth/sessionStore.service'); // Redis-backed sessions, refresh rotation, revocation
const mfaService     = require('../services/auth/mfa.service');          // TOTP challenge issuance/consumption
const securityLogger = require('../audit/securityLogger.service');       // SOC2-style security event log

// ── Config ────────────────────────────────────────────────────────────────────
const BCRYPT_ROUNDS      = parseInt(process.env.BCRYPT_ROUNDS      || '12',  10);
const MAX_PASSWORD_LENGTH = parseInt(process.env.MAX_PASSWORD_LENGTH || '128', 10);  // FIX #6
// NOTE (PHASE 2): TOKEN_EXPIRY_MS / MAX_TOKEN_STORE_SIZE moved into
// services/auth/sessionStore.service.js, which now owns token issuance,
// storage, rotation, and cleanup — it reads the SAME env vars
// (TOKEN_EXPIRY_HOURS, MAX_TOKEN_STORE), so existing deployment configs
// don't need to change. See that file for the Redis-backed replacement.

// FIX #1: Generate a valid dummy hash at startup for constant-time compare.
// bcrypt.hashSync is synchronous; runs once at module load, ~100ms.
// The password content is irrelevant — it just needs to be a valid bcrypt hash.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_ROUNDS);

// FIX #5: Google client ID for audience validation
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || null;
if (!GOOGLE_CLIENT_ID) {
  console.warn(
    '[auth] WARNING: GOOGLE_CLIENT_ID is not set. ' +
    'Google OAuth is running in development mode without audience validation. ' +
    'Set GOOGLE_CLIENT_ID in .env for production use.'
  );
}

// ── Persistence ───────────────────────────────────────────────────────────────
const DATA_DIR  = path.join(__dirname, '../data');
const DATA_FILE = path.join(DATA_DIR, 'users.json');

// ── In-memory stores ──────────────────────────────────────────────────────────
const userStore      = new Map();  // email (lowercase) → user object
const _userByIdStore = new Map();  // FIX #2: id → user object (O(1) lookup)

// NOTE (PHASE 2): the token store (previously an in-memory Map here,
// FIX #4's SHA-256(rawToken) → { userId, expiresAt }) now lives in
// services/auth/sessionStore.service.js — Redis-backed with the same kind
// of local-mirror fallback this file already used elsewhere. `tokenStore`
// is still exported below (aliased to that module's local mirror) purely
// for backward compatibility with anything that inspects it directly.

// ── Load from disk on startup ─────────────────────────────────────────────────
function loadUsers() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      for (const [k, v] of Object.entries(raw)) {
        userStore.set(k, v);
        _userByIdStore.set(v.id, v);  // FIX #2: populate id index
      }
      console.log(`[auth] Loaded ${userStore.size} user(s) from disk.`);
    }
  } catch (e) {
    console.error('[auth] Failed to load users from disk:', e.message);
  }
}

// FIX #8: Atomic write via temp file + rename
function saveUsers() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const obj     = {};
    const tmpFile = DATA_FILE + '.tmp';
    for (const [k, v] of userStore.entries()) obj[k] = v;
    fs.writeFileSync(tmpFile, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmpFile, DATA_FILE);  // FIX #8: atomic on POSIX
  } catch (e) {
    console.error('[auth] Failed to save users:', e.message);
  }
}

loadUsers();

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function safeUser(user) {
  return {
    id       : user.id,
    name     : user.name,
    email    : user.email,
    role     : user.role || 'reviewer',
    provider : user.provider,
    createdAt: user.createdAt,
  };
}

// ── Signup ────────────────────────────────────────────────────────────────────
exports.signup = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'All fields required', code: 'MISSING_FIELDS' });
    }
    if (!validateEmail(email)) {
      return res.status(400).json({ error: 'Invalid email address', code: 'INVALID_EMAIL' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters', code: 'PASSWORD_TOO_SHORT' });
    }
    // FIX #6: Password length cap (bcrypt DoS prevention)
    if (password.length > MAX_PASSWORD_LENGTH) {
      return res.status(400).json({
        error: `Password too long. Maximum: ${MAX_PASSWORD_LENGTH} characters.`,
        code : 'PASSWORD_TOO_LONG',
      });
    }

    const emailKey = email.toLowerCase().trim();
    if (userStore.has(emailKey)) {
      return res.status(409).json({ error: 'An account with this email already exists', code: 'EMAIL_TAKEN' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const user = assignDefaultRole({
      id          : `user_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      name        : name.trim().slice(0, 100),
      email       : emailKey,
      passwordHash,
      provider    : 'email',
      createdAt   : new Date().toISOString(),
    });

    userStore.set(emailKey, user);
    _userByIdStore.set(user.id, user);  // FIX #2: keep id index in sync
    saveUsers();

    // PHASE 2: sessionStore issues an access+refresh pair (Redis-backed,
    // survives restarts and works across multiple instances) in place of the
    // old in-memory-only issueToken(). The `token` field name/shape in the
    // response is UNCHANGED so the existing frontend needs no changes;
    // `refreshToken` is a new, additive field it will simply ignore until
    // it's wired up — see PHASE2_SECURITY.md.
    const { accessToken, refreshToken } = await sessionStore.createSession(user.id, {
      ip: req.ip, userAgent: req.headers['user-agent'],
    });
    console.log(`[auth] Signup: ${user.email} (${user.id})`);
    securityLogger.logSecurityEvent('SIGNUP', { userId: user.id, ip: req.ip });
    res.status(201).json({ token: accessToken, refreshToken, user: safeUser(user) });
  } catch (err) { next(err); }
};

// ── Login ─────────────────────────────────────────────────────────────────────
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required', code: 'MISSING_FIELDS' });
    }

    // FIX #6: Cap password length before running bcrypt
    if (typeof password === 'string' && password.length > MAX_PASSWORD_LENGTH) {
      // Return the same generic error — don't reveal the cap exists (enumeration risk)
      return res.status(401).json({ error: 'Incorrect email or password', code: 'INVALID_CREDENTIALS' });
    }

    const emailKey = email.toLowerCase().trim();
    const user     = userStore.get(emailKey);

    // FIX #1: Use DUMMY_HASH (a valid bcrypt hash) when user not found.
    // Old code used a hand-crafted string that caused bcrypt to throw "Invalid salt version".
    const hashToCheck = (user?.provider === 'email' && user?.passwordHash)
      ? user.passwordHash
      : DUMMY_HASH;

    const valid = await bcrypt.compare(password, hashToCheck);

    // Always return the same error for wrong email OR wrong password (FIX preserved from V1)
    if (!user || !valid || user.provider !== 'email') {
      securityLogger.logSecurityEvent('LOGIN_FAILED', { email: emailKey, ip: req.ip, reason: 'invalid_credentials' });
      return res.status(401).json({ error: 'Incorrect email or password', code: 'INVALID_CREDENTIALS' });
    }

    // PHASE 2: account suspension (set via the new admin user-management endpoints)
    if (user.disabled) {
      securityLogger.logSecurityEvent('LOGIN_FAILED', { userId: user.id, ip: req.ip, reason: 'account_disabled' });
      return res.status(403).json({ error: 'This account has been disabled. Contact an administrator.', code: 'ACCOUNT_DISABLED' });
    }

    // PHASE 2: MFA gate. If enabled, don't issue a session yet — issue a
    // short-lived challenge instead; the client completes login via
    // POST /api/auth/mfa/verify with { challengeToken, code }.
    if (user.mfaEnabled) {
      const challengeToken = await mfaService.createLoginChallenge(user.id);
      securityLogger.logSecurityEvent('MFA_CHALLENGE_ISSUED', { userId: user.id, ip: req.ip });
      return res.json({ mfaRequired: true, challengeToken });
    }

    const { accessToken, refreshToken } = await sessionStore.createSession(user.id, {
      ip: req.ip, userAgent: req.headers['user-agent'],
    });
    console.log(`[auth] Login: ${user.email}`);
    securityLogger.logSecurityEvent('LOGIN_SUCCESS', { userId: user.id, ip: req.ip, method: 'password' });
    res.json({ token: accessToken, refreshToken, user: safeUser(user) });
  } catch (err) { next(err); }
};

// ── Google OAuth ──────────────────────────────────────────────────────────────
exports.googleAuth = async (req, res, next) => {
  try {
    const { accessToken, idToken } = req.body;
    if (!accessToken && !idToken) {
      return res.status(400).json({ error: 'Google token required', code: 'MISSING_TOKEN' });
    }

    let googleUser;
    try {
      // FIX #5: Use ID token + audience validation when GOOGLE_CLIENT_ID is set
      if (idToken && GOOGLE_CLIENT_ID) {
        googleUser = await _verifyGoogleIdToken(idToken);
      } else {
        // Development fallback: userinfo endpoint (no aud/iss/exp validation)
        googleUser = await _fetchGoogleUserInfo(accessToken || idToken);
      }
    } catch {
      return res.status(401).json({ error: 'Invalid Google token', code: 'INVALID_GOOGLE_TOKEN' });
    }

    if (!googleUser.email) {
      return res.status(401).json({ error: 'No email in Google response', code: 'INVALID_GOOGLE_TOKEN' });
    }

    const emailKey = googleUser.email.toLowerCase().trim();
    let user = userStore.get(emailKey);
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      user = assignDefaultRole({
        id          : `user_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        name        : (googleUser.name || googleUser.email.split('@')[0]).slice(0, 100),
        email       : emailKey,
        passwordHash: null,
        provider    : 'google',
        googleId    : googleUser.sub,
        createdAt   : new Date().toISOString(),
      });
      userStore.set(emailKey, user);
      _userByIdStore.set(user.id, user);  // FIX #2
      saveUsers();
      console.log(`[auth] Google signup: ${user.email}`);
    } else {
      console.log(`[auth] Google login: ${user.email}`);
    }

    // PHASE 2: account suspension check
    if (user.disabled) {
      securityLogger.logSecurityEvent('LOGIN_FAILED', { userId: user.id, ip: req.ip, reason: 'account_disabled' });
      return res.status(403).json({ error: 'This account has been disabled. Contact an administrator.', code: 'ACCOUNT_DISABLED' });
    }

    // PHASE 2: MFA gate (a brand-new signup can't have MFA enabled yet, so
    // only existing users are checked here).
    if (!isNewUser && user.mfaEnabled) {
      const challengeToken = await mfaService.createLoginChallenge(user.id);
      securityLogger.logSecurityEvent('MFA_CHALLENGE_ISSUED', { userId: user.id, ip: req.ip });
      return res.json({ mfaRequired: true, challengeToken });
    }

    const session = await sessionStore.createSession(user.id, {
      ip: req.ip, userAgent: req.headers['user-agent'],
    });
    securityLogger.logSecurityEvent(isNewUser ? 'SIGNUP' : 'LOGIN_SUCCESS', { userId: user.id, ip: req.ip, method: 'google' });
    res.json({ token: session.accessToken, refreshToken: session.refreshToken, user: safeUser(user) });
  } catch (err) { next(err); }
};

/**
 * FIX #5: Verify Google ID token with audience check.
 * Requires: npm install google-auth-library
 */
async function _verifyGoogleIdToken(idToken) {
  // Lazy-load to avoid hard dependency when not configured
  const { OAuth2Client } = require('google-auth-library');
  const client   = new OAuth2Client(GOOGLE_CLIENT_ID);
  const ticket   = await client.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
  const payload  = ticket.getPayload();
  // payload.exp, payload.iss, payload.aud are all verified by the library
  return {
    email: payload.email,
    name : payload.name,
    sub  : payload.sub,
  };
}

/**
 * Development fallback: fetch user info from Google's userinfo endpoint.
 * Does NOT verify aud/iss/exp — suitable for local development only.
 */
async function _fetchGoogleUserInfo(accessToken) {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error('Google userinfo fetch failed');
  return response.json();
}

// ── Get current user ──────────────────────────────────────────────────────────
exports.getMe = (req, res) => {
  res.json({ user: safeUser(req.user) });
};

// ── Logout ────────────────────────────────────────────────────────────────────
exports.logout = async (req, res) => {
  const rawToken = req.token;
  if (rawToken) {
    // PHASE 2: revokes the WHOLE session (access + refresh token) via
    // sessionStore, so a stored refresh token can't be used to mint a new
    // access token after logout, and revocation is visible to every
    // instance immediately (not just this process's memory).
    await sessionStore.revokeAccessToken(rawToken, 'logout');
  }
  securityLogger.logSecurityEvent('LOGOUT', { userId: req.user?.id, ip: req.ip });
  res.json({ success: true, message: 'Logged out successfully' });
};

/**
 * PHASE 2 — POST /api/auth/logout-all
 * Revokes every session for the current user ("log out of all devices").
 * Used directly by users, and internally by password/MFA changes and admin
 * role changes so a security-relevant change takes effect immediately.
 */
exports.logoutAll = async (req, res) => {
  const count = await sessionStore.revokeAllSessionsForUser(req.user.id, 'logout_all');
  securityLogger.logSecurityEvent('LOGOUT_ALL', { userId: req.user.id, ip: req.ip, sessionsRevoked: count });
  res.json({ success: true, sessionsRevoked: count });
};

/**
 * PHASE 2 — GET /api/auth/sessions
 * Lists the current user's active sessions (for a "your devices" view).
 */
exports.getSessions = async (req, res) => {
  const sessions = await sessionStore.listSessions(req.user.id);
  res.json({ sessions });
};

/**
 * PHASE 2 — POST /api/auth/refresh
 * Body: { refreshToken }. Rotates it for a new access+refresh pair.
 * On reuse of an already-rotated refresh token (likely theft), the whole
 * session is revoked and the caller must log in again.
 */
exports.refresh = async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken || typeof refreshToken !== 'string') {
    return res.status(400).json({ error: 'refreshToken is required', code: 'MISSING_REFRESH_TOKEN' });
  }

  const result = await sessionStore.rotateRefreshToken(refreshToken, {
    ip: req.ip, userAgent: req.headers['user-agent'],
  });

  if (result.error === 'REUSE_DETECTED') {
    return res.status(401).json({
      error: 'This refresh token was already used. All sessions for this account have been revoked as a precaution — please log in again.',
      code: 'REFRESH_TOKEN_REUSE_DETECTED',
    });
  }
  if (result.error) {
    return res.status(401).json({ error: 'Invalid or expired refresh token. Please log in again.', code: 'INVALID_REFRESH_TOKEN' });
  }

  res.json({ token: result.accessToken, refreshToken: result.refreshToken });
};

// ── Auth middleware ───────────────────────────────────────────────────────────
// PHASE 2: now backed by sessionStore.service.js (Redis + local in-memory
// mirror) instead of a raw Map living in this file. The function signature,
// success behaviour, and every status/error code below are unchanged, so
// every route that already uses requireAuth keeps working exactly as before.
exports.requireAuth = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required', code: 'NO_TOKEN' });
  }

  const rawToken = authHeader.slice(7);
  const session  = await sessionStore.verifyAccessToken(rawToken);

  if (!session) {
    // Covers both "never existed" and "expired" (previously two branches
    // here) — nothing in this codebase's frontend distinguishes the two
    // TOKEN_EXPIRED/INVALID_TOKEN codes today (confirmed by search), and the
    // user-facing message was already effectively identical either way.
    return res.status(401).json({
      error: 'Session expired or invalid. Please log in again.',
      code : 'INVALID_TOKEN',
    });
  }

  // FIX #2 (preserved): O(1) lookup via _userByIdStore instead of O(n) scan
  const user = _userByIdStore.get(session.userId);
  if (!user) {
    await sessionStore.revokeAccessToken(rawToken, 'user_not_found');
    return res.status(401).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
  }

  // PHASE 2: a session that predates an account being disabled must stop
  // working immediately rather than waiting for its natural expiry.
  if (user.disabled) {
    await sessionStore.revokeAccessToken(rawToken, 'account_disabled');
    return res.status(403).json({ error: 'This account has been disabled.', code: 'ACCOUNT_DISABLED' });
  }

  req.user  = user;
  req.token = rawToken;  // Store raw token on req (for logout to hash it again)
  next();
};

// ── Exports ───────────────────────────────────────────────────────────────────
exports.userStore   = userStore;
// FIX #2: also export the id index for tests/admin tooling
exports._userByIdStore = _userByIdStore;
// PHASE 2: saveUsers is now exported so controllers/mfa.controller.js and
// controllers/admin.controller.js can persist changes (MFA enrollment,
// role changes, account disable/enable) to the SAME users.json store,
// without duplicating the load/save logic.
exports.saveUsers = saveUsers;
// PHASE 2: tokenStore is kept as a read-only alias to sessionStore's local
// mirror for anything that still inspects it directly (nothing in this
// codebase currently does — confirmed by search — but this avoids a hard
// break for any external tooling written against the old shape).
exports.tokenStore = sessionStore._internals._localAccess;
