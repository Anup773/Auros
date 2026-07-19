'use strict';
/**
 * backend/services/auth/sessionStore.service.js
 *
 * PHASE 2 — Refresh token rotation, token revocation ("blacklist"), and
 * Redis-backed session storage.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS / HOW IT RELATES TO PHASE 1's auth.controller.js
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 1's auth.controller.js issues a single opaque bearer token per login
 * (crypto.randomBytes(64), SHA-256-hashed at rest, looked up in an in-memory
 * Map). That is a perfectly reasonable design — revocation is trivial
 * (delete from the map) — but it has two limitations the code itself already
 * flags in comments: (1) it doesn't survive a restart or work across more
 * than one server instance, and (2) there's no separate short-lived
 * "access" token + long-lived "refresh" token distinction, so there's no
 * safe way to shorten a session's blast radius without forcing re-logins.
 *
 * This module adds that layer on top, WITHOUT changing how Phase 1 tokens
 * behave: it does not replace token FORMAT (still opaque random hex, not
 * JWT — see PHASE2_SECURITY.md for why), it adds a second "refresh" token
 * and moves the session record into Redis so it survives restarts and is
 * visible to every instance.
 *
 * "Token blacklist", as requested, is implemented as revocation-by-deletion
 * (`revokeSession` / `revokeAccessToken` / `revokeAllSessionsForUser`)
 * rather than as a separate deny-list structure. That distinction matters:
 * a deny-list is only a DIFFERENT structure from the primary store when
 * tokens are self-validating (e.g. JWTs, which remain "valid" by signature
 * alone until they naturally expire, so you need a place to explicitly
 * override that). Because these tokens require a positive Redis/in-memory
 * lookup to be accepted at all, deleting the record IS the blacklist — a
 * separate deny-list here would just be the same operation with extra
 * steps. See PHASE2_SECURITY.md for the longer version of this reasoning.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * STORAGE MODEL
 * ─────────────────────────────────────────────────────────────────────────
 *   auth:access:<sha256(accessToken)>   Redis HASH  { userId, sessionId, expiresAt }
 *   auth:refresh:<sha256(refreshToken)> Redis HASH  { userId, sessionId, expiresAt, used }
 *   auth:session:<sessionId>            Redis HASH  { userId, createdAt, ip, userAgent,
 *                                                      revoked, revokedAt, revokedReason,
 *                                                      currentAccessHash, currentRefreshHash }
 *   auth:user-sessions:<userId>         Redis SET   sessionId members (lazily pruned)
 *
 * Every write also goes to a local in-memory mirror (same shape) so:
 *   - a single-instance deployment keeps working exactly as Phase 1 did,
 *     even if Redis has never been configured at all (REDIS_URL unset ->
 *     ioredis will keep retrying in the background; this module just uses
 *     the local mirror until/unless it connects), and
 *   - reads fall back to the local mirror if Redis is temporarily down.
 * Only Redis is visible across instances/restarts, so multi-instance
 * deployments and restart-survival require Redis to actually be reachable —
 * that part cannot be faked locally, by definition.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ROTATION + REUSE DETECTION
 * ─────────────────────────────────────────────────────────────────────────
 * Refresh tokens are single-use. Each call to rotateRefreshToken():
 *   1. Looks up the presented refresh token.
 *   2. If it was already marked `used` -> REUSE DETECTED. This is the
 *      standard signal that a refresh token was stolen (attacker and victim
 *      both eventually try to use the same one-time token). The entire
 *      session is revoked immediately and a security event is logged.
 *   3. Otherwise, marks the old one `used`, mints a new access+refresh pair
 *      under the SAME sessionId, and extends the session's TTL (sliding
 *      window) from now.
 */

const crypto = require('crypto');
const { randomUUID } = crypto;
const sharedRedis = require('../../config/redis');
const securityLogger = require('../../audit/securityLogger.service');

// ── Config ────────────────────────────────────────────────────────────────────
// Reuses the SAME env var Phase 1 already defined for access-token life, so
// default behaviour (24h) is unchanged unless the operator has already set it.
const ACCESS_TOKEN_TTL_MS  = parseInt(process.env.TOKEN_EXPIRY_HOURS || '24', 10) * 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = parseInt(process.env.REFRESH_TOKEN_EXPIRY_DAYS || '30', 10) * 24 * 60 * 60 * 1000;

// Local-mirror size cap, mirroring the philosophy (and even the env var name)
// of auth.controller.js's MAX_TOKEN_STORE_SIZE — prevents unbounded growth if
// Redis is unreachable for a long stretch.
const MAX_LOCAL_ENTRIES = parseInt(process.env.MAX_TOKEN_STORE || '100000', 10);

// Short positive-verification cache. This app's frontend polls some endpoints
// every ~2s (see ProcurementWorkspace job-status polling) — without this,
// every one of those requests would do a Redis round-trip just to re-confirm
// a token it already confirmed two seconds ago. Kept deliberately short so a
// revocation is never "invisible" for more than a few seconds.
const POSITIVE_CACHE_TTL_MS = parseInt(process.env.SESSION_CACHE_TTL_MS || '5000', 10);

// ── Local mirrors ─────────────────────────────────────────────────────────────
const _localAccess    = new Map(); // accessHash  -> { userId, sessionId, expiresAt }
const _localRefresh   = new Map(); // refreshHash -> { userId, sessionId, expiresAt, used }
const _localSessions  = new Map(); // sessionId   -> { userId, createdAt, ip, userAgent, revoked, revokedAt, revokedReason, currentAccessHash, currentRefreshHash }
const _localUserIndex = new Map(); // userId      -> Set<sessionId>
const _positiveCache  = new Map(); // accessHash  -> { userId, sessionId, cachedAt }

function _hash(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function _redisUp() {
  return sharedRedis.isAvailable();
}

// ── Local-mirror cleanup (hourly, same cadence as auth.controller.js) ────────
const _cleanupInterval = setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [h, d] of _localAccess.entries())  if (d.expiresAt < now) { _localAccess.delete(h); removed++; }
  for (const [h, d] of _localRefresh.entries()) if (d.expiresAt < now) { _localRefresh.delete(h); removed++; }
  for (const [id, s] of _localSessions.entries()) {
    if (s.expiresAt < now) {
      _localSessions.delete(id);
      _localUserIndex.get(s.userId)?.delete(id);
    }
  }
  for (const [h, c] of _positiveCache.entries()) if (now - c.cachedAt > POSITIVE_CACHE_TTL_MS) _positiveCache.delete(h);
  if (removed > 0) console.log(`[sessionStore] Local-mirror cleanup: removed ${removed} expired entr(y/ies).`);
}, 60 * 60 * 1000);
if (_cleanupInterval.unref) _cleanupInterval.unref();

function _enforceLocalCap(map) {
  if (map.size < MAX_LOCAL_ENTRIES) return;
  // Evict oldest ~10% (Map preserves insertion order) rather than the whole map.
  const toRemove = Math.ceil(MAX_LOCAL_ENTRIES * 0.1);
  let removed = 0;
  for (const key of map.keys()) {
    if (removed >= toRemove) break;
    map.delete(key);
    removed++;
  }
}

// ── Internal: write a session's three records everywhere ─────────────────────
async function _persistSession({ sessionId, userId, accessToken, refreshToken, ip, userAgent, createdAt, replacesRefreshHash }) {
  const accessHash  = _hash(accessToken);
  const refreshHash = _hash(refreshToken);
  const accessExpiresAt  = createdAt + ACCESS_TOKEN_TTL_MS;
  const refreshExpiresAt = createdAt + REFRESH_TOKEN_TTL_MS;

  // Local mirror (always — this is what keeps single-instance behaviour
  // working even when Redis is never configured).
  _enforceLocalCap(_localAccess);
  _enforceLocalCap(_localRefresh);
  _localAccess.set(accessHash,  { userId, sessionId, expiresAt: accessExpiresAt });
  _localRefresh.set(refreshHash, { userId, sessionId, expiresAt: refreshExpiresAt, used: false });

  const sessionRecord = {
    userId, createdAt, ip: ip || 'unknown', userAgent: userAgent || 'unknown',
    revoked: false, revokedAt: null, revokedReason: null,
    currentAccessHash: accessHash, currentRefreshHash: refreshHash,
    expiresAt: refreshExpiresAt,
  };
  _localSessions.set(sessionId, sessionRecord);
  if (!_localUserIndex.has(userId)) _localUserIndex.set(userId, new Set());
  _localUserIndex.get(userId).add(sessionId);

  // Best-effort Redis mirror (source of truth across instances/restarts).
  if (_redisUp()) {
    try {
      const r = sharedRedis.redis;
      const accessSec  = Math.max(1, Math.ceil(ACCESS_TOKEN_TTL_MS  / 1000));
      const refreshSec = Math.max(1, Math.ceil(REFRESH_TOKEN_TTL_MS / 1000));

      const pipeline = r.pipeline();
      pipeline.hset(`auth:access:${accessHash}`, { userId, sessionId, expiresAt: accessExpiresAt });
      pipeline.expire(`auth:access:${accessHash}`, accessSec);
      pipeline.hset(`auth:refresh:${refreshHash}`, { userId, sessionId, expiresAt: refreshExpiresAt, used: '0' });
      pipeline.expire(`auth:refresh:${refreshHash}`, refreshSec);
      pipeline.hset(`auth:session:${sessionId}`, {
        userId, createdAt, ip: ip || 'unknown', userAgent: userAgent || 'unknown',
        revoked: '0', currentAccessHash: accessHash, currentRefreshHash: refreshHash,
      });
      pipeline.expire(`auth:session:${sessionId}`, refreshSec);
      pipeline.sadd(`auth:user-sessions:${userId}`, sessionId);
      // If this call is a rotation, drop the OLD refresh key immediately —
      // it's already flagged `used` by the caller before we get here, but
      // removing it outright frees memory sooner than waiting for its TTL.
      if (replacesRefreshHash) {
        // Keep it, don't delete: a lingering `used=1` record is exactly what
        // lets us detect reuse if the old token is presented again. Do NOT
        // delete replacesRefreshHash here — that would defeat reuse detection.
      }
      await pipeline.exec();
    } catch (err) {
      console.warn('[sessionStore] Redis write failed, session remains valid via local mirror only:', err.message);
    }
  }

  return { accessToken, refreshToken, sessionId, expiresAt: accessExpiresAt };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a brand-new session (login/signup/Google auth).
 * @returns {{accessToken:string, refreshToken:string, sessionId:string, expiresAt:number}}
 */
async function createSession(userId, meta = {}) {
  const sessionId    = randomUUID();
  const accessToken  = crypto.randomBytes(64).toString('hex');
  const refreshToken = crypto.randomBytes(64).toString('hex');
  const createdAt    = Date.now();

  return _persistSession({
    sessionId, userId, accessToken, refreshToken,
    ip: meta.ip, userAgent: meta.userAgent, createdAt,
  });
}

/**
 * Verify an access token. Returns { userId, sessionId } if valid, else null.
 * Checks (in order): positive cache -> local mirror -> Redis -> session-level revocation.
 */
async function verifyAccessToken(rawToken) {
  if (!rawToken) return null;
  const hash = _hash(rawToken);
  const now  = Date.now();

  const cached = _positiveCache.get(hash);
  if (cached && (now - cached.cachedAt) < POSITIVE_CACHE_TTL_MS) {
    return { userId: cached.userId, sessionId: cached.sessionId };
  }

  let record = _localAccess.get(hash);
  if (record && record.expiresAt < now) {
    _localAccess.delete(hash);
    record = null;
  }

  if (!record && _redisUp()) {
    try {
      const data = await sharedRedis.redis.hgetall(`auth:access:${hash}`);
      if (data && data.userId) {
        record = { userId: data.userId, sessionId: data.sessionId, expiresAt: parseInt(data.expiresAt, 10) };
        if (record.expiresAt < now) record = null;
        else _localAccess.set(hash, record); // warm the local mirror
      }
    } catch (err) {
      console.warn('[sessionStore] Redis read failed during verifyAccessToken, using local mirror only:', err.message);
    }
  }

  if (!record) return null;

  // A valid-looking token can still belong to a revoked session (e.g. logout
  // from another device, admin force-logout, password change). Check that
  // even when the access-token record itself was found in the fast path.
  const session = await _getSession(record.sessionId);
  if (!session || session.revoked) return null;

  _positiveCache.set(hash, { userId: record.userId, sessionId: record.sessionId, cachedAt: now });
  return { userId: record.userId, sessionId: record.sessionId };
}

async function _getSession(sessionId) {
  let session = _localSessions.get(sessionId);
  if (session) return session;

  if (_redisUp()) {
    try {
      const data = await sharedRedis.redis.hgetall(`auth:session:${sessionId}`);
      if (data && data.userId) {
        session = {
          userId: data.userId,
          createdAt: parseInt(data.createdAt, 10),
          ip: data.ip, userAgent: data.userAgent,
          revoked: data.revoked === '1',
          revokedAt: data.revokedAt || null,
          revokedReason: data.revokedReason || null,
          currentAccessHash: data.currentAccessHash,
          currentRefreshHash: data.currentRefreshHash,
        };
        return session;
      }
    } catch (err) {
      console.warn('[sessionStore] Redis read failed during _getSession:', err.message);
    }
  }
  return null;
}

/**
 * Rotate a refresh token: validates it, and if valid + unused, issues a new
 * access+refresh pair under the same session. If the token was already used
 * once before, this is treated as reuse (likely theft) and the WHOLE session
 * is revoked.
 *
 * @returns {{accessToken, refreshToken, sessionId, expiresAt}
 *           | {error: 'INVALID'|'EXPIRED'|'REUSE_DETECTED'|'SESSION_REVOKED'}}
 */
async function rotateRefreshToken(rawRefreshToken, meta = {}) {
  if (!rawRefreshToken) return { error: 'INVALID' };
  const hash = _hash(rawRefreshToken);
  const now  = Date.now();

  let record = _localRefresh.get(hash);

  if (!record && _redisUp()) {
    try {
      const data = await sharedRedis.redis.hgetall(`auth:refresh:${hash}`);
      if (data && data.userId) {
        record = { userId: data.userId, sessionId: data.sessionId, expiresAt: parseInt(data.expiresAt, 10), used: data.used === '1' };
      }
    } catch (err) {
      console.warn('[sessionStore] Redis read failed during rotateRefreshToken:', err.message);
    }
  }

  if (!record) return { error: 'INVALID' };
  if (record.expiresAt < now) return { error: 'EXPIRED' };

  if (record.used) {
    // REUSE DETECTED — someone presented a refresh token that was already
    // rotated away. Kill the whole session and log it as a security event.
    await revokeSession(record.sessionId, 'refresh_token_reuse_detected');
    securityLogger.logSecurityEvent('TOKEN_REUSE_DETECTED', {
      userId: record.userId, sessionId: record.sessionId,
      ip: meta.ip, userAgent: meta.userAgent,
      severity: 'high',
    });
    return { error: 'REUSE_DETECTED' };
  }

  const session = await _getSession(record.sessionId);
  if (!session || session.revoked) return { error: 'SESSION_REVOKED' };

  // Mark old refresh token used (kept until its TTL — this is what makes
  // reuse-detection possible if it's presented again).
  record.used = true;
  _localRefresh.set(hash, record);
  if (_redisUp()) {
    try {
      await sharedRedis.redis.hset(`auth:refresh:${hash}`, { used: '1' });
    } catch (err) {
      console.warn('[sessionStore] Redis write failed marking refresh token used:', err.message);
    }
  }

  const newAccessToken  = crypto.randomBytes(64).toString('hex');
  const newRefreshToken = crypto.randomBytes(64).toString('hex');

  const result = await _persistSession({
    sessionId: record.sessionId, userId: record.userId,
    accessToken: newAccessToken, refreshToken: newRefreshToken,
    ip: meta.ip || session.ip, userAgent: meta.userAgent || session.userAgent,
    createdAt: now, replacesRefreshHash: hash,
  });

  // Invalidate any positive-cache entry for the OLD access token tied to this
  // session so it can't be used again during the cache window.
  if (session.currentAccessHash) _positiveCache.delete(session.currentAccessHash);

  securityLogger.logSecurityEvent('TOKEN_REFRESHED', {
    userId: record.userId, sessionId: record.sessionId,
  });

  return result;
}

/**
 * Revoke a single session (e.g. logout from one device). This is the
 * "blacklist" operation — see the module-level comment for why it's
 * implemented as deletion/marking rather than a separate deny-list.
 */
async function revokeSession(sessionId, reason = 'logout') {
  const session = _localSessions.get(sessionId) || await _getSession(sessionId);
  if (session) {
    if (session.currentAccessHash)  { _localAccess.delete(session.currentAccessHash); _positiveCache.delete(session.currentAccessHash); }
    if (session.currentRefreshHash) _localRefresh.delete(session.currentRefreshHash);
  }
  _localSessions.delete(sessionId);
  if (session?.userId) _localUserIndex.get(session.userId)?.delete(sessionId);

  if (_redisUp()) {
    try {
      const r = sharedRedis.redis;
      if (session?.currentAccessHash)  await r.del(`auth:access:${session.currentAccessHash}`);
      if (session?.currentRefreshHash) await r.del(`auth:refresh:${session.currentRefreshHash}`);
      // Keep the session hash itself (marked revoked) rather than deleting it
      // outright — this preserves an audit trail of "this session existed and
      // was revoked for X reason at Y time" instead of erasing the evidence.
      await r.hset(`auth:session:${sessionId}`, {
        revoked: '1', revokedAt: Date.now(), revokedReason: reason,
      });
      if (session?.userId) await r.srem(`auth:user-sessions:${session.userId}`, sessionId);
    } catch (err) {
      console.warn('[sessionStore] Redis write failed during revokeSession:', err.message);
    }
  }
}

/** Convenience wrapper: revoke whichever session owns this access token. */
async function revokeAccessToken(rawToken, reason = 'logout') {
  if (!rawToken) return;
  const hash = _hash(rawToken);
  const record = _localAccess.get(hash) || (await verifyAccessToken(rawToken));
  const sessionId = record?.sessionId;
  _positiveCache.delete(hash);
  if (sessionId) await revokeSession(sessionId, reason);
}

/**
 * Revoke every session belonging to a user — "log out everywhere".
 * Used for logout-all, password changes, MFA enable/disable, and admin
 * role changes (so a privilege change takes effect immediately rather than
 * waiting for the old token to expire naturally).
 */
async function revokeAllSessionsForUser(userId, reason = 'logout_all') {
  const ids = new Set(_localUserIndex.get(userId) || []);

  if (_redisUp()) {
    try {
      const remoteIds = await sharedRedis.redis.smembers(`auth:user-sessions:${userId}`);
      remoteIds.forEach(id => ids.add(id));
    } catch (err) {
      console.warn('[sessionStore] Redis read failed during revokeAllSessionsForUser:', err.message);
    }
  }

  for (const id of ids) await revokeSession(id, reason);
  return ids.size;
}

/** List active (non-revoked) sessions for a user — for a "your devices" view. */
async function listSessions(userId) {
  const ids = new Set(_localUserIndex.get(userId) || []);
  if (_redisUp()) {
    try {
      const remoteIds = await sharedRedis.redis.smembers(`auth:user-sessions:${userId}`);
      remoteIds.forEach(id => ids.add(id));
    } catch (err) {
      console.warn('[sessionStore] Redis read failed during listSessions:', err.message);
    }
  }

  const sessions = [];
  for (const id of ids) {
    const s = await _getSession(id);
    if (s && !s.revoked) {
      sessions.push({ sessionId: id, createdAt: s.createdAt, ip: s.ip, userAgent: s.userAgent });
    }
  }
  return sessions.sort((a, b) => b.createdAt - a.createdAt);
}

module.exports = {
  createSession,
  verifyAccessToken,
  rotateRefreshToken,
  revokeSession,
  revokeAccessToken,
  revokeAllSessionsForUser,
  listSessions,
  // Exposed for tests only:
  _internals: { _hash, _localAccess, _localRefresh, _localSessions },
};