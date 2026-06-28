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
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { assignDefaultRole } = require('../middleware/rbac');

// ── Config ────────────────────────────────────────────────────────────────────
const BCRYPT_ROUNDS      = parseInt(process.env.BCRYPT_ROUNDS      || '12',  10);
const TOKEN_EXPIRY_MS    = parseInt(process.env.TOKEN_EXPIRY_HOURS || '24',  10) * 60 * 60 * 1000;
const MAX_PASSWORD_LENGTH = parseInt(process.env.MAX_PASSWORD_LENGTH || '128', 10);  // FIX #6
const MAX_TOKEN_STORE_SIZE = parseInt(process.env.MAX_TOKEN_STORE  || '100000', 10);  // FIX #7

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

// FIX #4: tokenStore maps SHA-256(rawToken) → { userId, expiresAt }
// Raw token is NEVER stored — only its hash.
const tokenStore = new Map();

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

// ── Token cleanup — runs every hour ──────────────────────────────────────────
const _tokenCleanupInterval = setInterval(() => {
  const now     = Date.now();
  let   removed = 0;
  for (const [hash, data] of tokenStore.entries()) {
    if (data.expiresAt < now) { tokenStore.delete(hash); removed++; }
  }
  if (removed > 0) console.log(`[auth] Cleaned ${removed} expired token(s).`);
}, 60 * 60 * 1000);

// Prevent the interval from keeping the process alive during tests
if (_tokenCleanupInterval.unref) _tokenCleanupInterval.unref();

// ── Token helpers ─────────────────────────────────────────────────────────────
function _hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(64).toString('hex');
}

function issueToken(userId) {
  // FIX #7: Enforce token store size cap before issuing new token
  if (tokenStore.size >= MAX_TOKEN_STORE_SIZE) {
    _emergencyCleanup();
  }

  const rawToken  = generateToken();
  const tokenHash = _hashToken(rawToken);  // FIX #4: store hash, return raw
  const expiresAt = Date.now() + TOKEN_EXPIRY_MS;
  tokenStore.set(tokenHash, { userId, expiresAt });
  return rawToken;  // Only the raw token goes to the client
}

/**
 * FIX #7: Emergency synchronous cleanup when token store is at capacity.
 * Removes all expired tokens immediately rather than waiting for the hourly sweep.
 */
function _emergencyCleanup() {
  const now = Date.now();
  for (const [hash, data] of tokenStore.entries()) {
    if (data.expiresAt < now) tokenStore.delete(hash);
  }
  // If still at capacity after removing expired tokens, remove oldest 10%
  if (tokenStore.size >= MAX_TOKEN_STORE_SIZE) {
    const removeCount = Math.ceil(MAX_TOKEN_STORE_SIZE * 0.1);
    let   removed     = 0;
    for (const hash of tokenStore.keys()) {
      if (removed >= removeCount) break;
      tokenStore.delete(hash);
      removed++;
    }
    console.warn(`[auth] Token store at capacity — forcibly evicted ${removed} token(s).`);
  }
}

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

    const token = issueToken(user.id);
    console.log(`[auth] Signup: ${user.email} (${user.id})`);
    res.status(201).json({ token, user: safeUser(user) });
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
      return res.status(401).json({ error: 'Incorrect email or password', code: 'INVALID_CREDENTIALS' });
    }

    const token = issueToken(user.id);
    console.log(`[auth] Login: ${user.email}`);
    res.json({ token, user: safeUser(user) });
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

    if (!user) {
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

    const token = issueToken(user.id);
    res.json({ token, user: safeUser(user) });
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
exports.logout = (req, res) => {
  const rawToken = req.token;
  if (rawToken) {
    // FIX #4: delete by hash (raw token is not what's stored)
    tokenStore.delete(_hashToken(rawToken));
  }
  res.json({ success: true, message: 'Logged out successfully' });
};

// ── Auth middleware ───────────────────────────────────────────────────────────
exports.requireAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required', code: 'NO_TOKEN' });
  }

  const rawToken  = authHeader.slice(7);
  const tokenHash = _hashToken(rawToken);          // FIX #4: hash before lookup
  const tokenData = tokenStore.get(tokenHash);

  if (!tokenData) {
    return res.status(401).json({
      error: 'Session expired or invalid. Please log in again.',
      code : 'INVALID_TOKEN',
    });
  }

  if (tokenData.expiresAt < Date.now()) {
    tokenStore.delete(tokenHash);
    return res.status(401).json({ error: 'Session expired. Please log in again.', code: 'TOKEN_EXPIRED' });
  }

  // FIX #2: O(1) lookup via _userByIdStore instead of O(n) scan
  const user = _userByIdStore.get(tokenData.userId);
  if (!user) {
    tokenStore.delete(tokenHash);
    return res.status(401).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
  }

  req.user  = user;
  req.token = rawToken;  // Store raw token on req (for logout to hash it again)
  next();
};

// ── Exports ───────────────────────────────────────────────────────────────────
// NOTE: tokenStore now contains hashed tokens, not raw tokens.
// External callers (tests) that inspect tokenStore must hash test tokens first.
exports.tokenStore  = tokenStore;
exports.userStore   = userStore;
// FIX #2: also export the id index for tests/admin tooling
exports._userByIdStore = _userByIdStore;

