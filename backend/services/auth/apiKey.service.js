'use strict';
/**
 * backend/services/auth/apiKey.service.js
 *
 * PHASE 2 — API key management for programmatic access (e.g. triggering a
 * reconciliation job from an external system without a human logging in).
 *
 * STORAGE CHOICE: this deliberately follows the SAME pattern as users.json /
 * auth.controller.js's userStore (in-memory Map + atomic tmp-file-then-rename
 * writes to data/apiKeys.json) rather than Redis. Sessions and refresh tokens
 * (sessionStore.service.js) are appropriately ephemeral — losing them on a
 * Redis restart just means affected users log in again. API keys are closer
 * to user accounts: they're long-lived credentials that external systems
 * depend on, often unattended, so losing them on a cache restart would be a
 * real outage for whoever integrated with them. Durable-by-default storage
 * (disk) is the safer default here; Redis is layered on top only for the
 * cheap "don't hit disk on every single request" read cache below.
 *
 * A key is shown in full exactly once, at creation. Only its SHA-256 hash is
 * ever stored, plus a short human-visible prefix (e.g. `auros_live_8f2a…`) so
 * a key can be identified in a list without exposing enough to reconstruct
 * or use it — the same principle Stripe/GitHub/AWS use for their tokens,
 * which also has the side benefit of being greppable by secret scanners if a
 * key is ever accidentally committed.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const DATA_DIR  = path.join(__dirname, '../../data');
const DATA_FILE = path.join(DATA_DIR, 'apiKeys.json');

const KEY_PREFIX = process.env.API_KEY_PREFIX || 'auros_live_';
const READ_CACHE_TTL_MS = 5000; // avoids a Redis/disk round trip on every single API-key-authenticated request

// ── In-memory store: id -> record ─────────────────────────────────────────────
const keyStore = new Map();
// Secondary index for O(1) verification lookups: keyHash -> id
const _hashIndex = new Map();

function _load() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      for (const record of Object.values(raw)) {
        keyStore.set(record.id, record);
        _hashIndex.set(record.keyHash, record.id);
      }
      console.log(`[apiKey] Loaded ${keyStore.size} API key record(s) from disk.`);
    }
  } catch (err) {
    console.error('[apiKey] Failed to load API keys from disk:', err.message);
  }
}

function _save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const obj = {};
    for (const [id, record] of keyStore.entries()) obj[id] = record;
    const tmpFile = DATA_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmpFile, DATA_FILE); // atomic on POSIX, same pattern as auth.controller.js's saveUsers()
  } catch (err) {
    console.error('[apiKey] Failed to save API keys:', err.message);
  }
}

_load();

function _hash(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function _generateId() {
  return `key_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * @param {string} userId  owning user
 * @param {string} name    human label, e.g. "CI pipeline"
 * @param {object} opts    { role, expiresInDays }
 *                         `role` is a CEILING, not a grant — requireApiKey
 *                         middleware still composes with requireRole/requireAdmin
 *                         downstream, so a key can never exceed its owner's
 *                         actual permissions even if a caller requests a
 *                         higher role here.
 * @returns {{ id, key, keyPrefix, name, role, createdAt, expiresAt }}
 *          `key` (the full plaintext value) is ONLY ever returned here —
 *          it cannot be retrieved again after this call returns.
 */
function createApiKey(userId, name, opts = {}) {
  const secret = crypto.randomBytes(24).toString('base64url');
  const fullKey = `${KEY_PREFIX}${secret}`;
  const keyHash = _hash(fullKey);
  const id = _generateId();
  const createdAt = new Date().toISOString();
  const expiresAt = opts.expiresInDays
    ? new Date(Date.now() + opts.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const record = {
    id, userId,
    name: (name || 'Unnamed key').slice(0, 100),
    keyHash,
    keyPrefix: fullKey.slice(0, KEY_PREFIX.length + 6), // e.g. "auros_live_8f2aQ1" — enough to recognise, not enough to use
    role: opts.role || null, // null = "whatever the owning user's role is at request time"
    createdAt, expiresAt,
    lastUsedAt: null,
    revoked: false, revokedAt: null,
  };

  keyStore.set(id, record);
  _hashIndex.set(keyHash, id);
  _save();

  return { id, key: fullKey, keyPrefix: record.keyPrefix, name: record.name, role: record.role, createdAt, expiresAt };
}

/** Safe-for-display list — never includes keyHash or the full key. */
function listApiKeysForUser(userId) {
  return [...keyStore.values()]
    .filter(k => k.userId === userId)
    .map(({ id, name, keyPrefix, role, createdAt, expiresAt, lastUsedAt, revoked, revokedAt }) =>
      ({ id, name, keyPrefix, role, createdAt, expiresAt, lastUsedAt, revoked, revokedAt }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function revokeApiKey(userId, keyId) {
  const record = keyStore.get(keyId);
  if (!record || record.userId !== userId) return false;
  record.revoked = true;
  record.revokedAt = new Date().toISOString();
  _save();
  return true;
}

// ── Verification (hot path — called on every API-key-authenticated request) ──
const _readCache = new Map(); // keyHash -> { record, cachedAt }

/**
 * @returns {{ valid:true, userId, role, keyId } | { valid:false, reason }}
 */
async function verifyApiKey(rawKey) {
  if (!rawKey || !rawKey.startsWith(KEY_PREFIX)) return { valid: false, reason: 'MALFORMED' };
  const keyHash = _hash(rawKey);

  const cached = _readCache.get(keyHash);
  let record;
  if (cached && (Date.now() - cached.cachedAt) < READ_CACHE_TTL_MS) {
    record = cached.record;
  } else {
    const id = _hashIndex.get(keyHash);
    record = id ? keyStore.get(id) : null;
    if (record) _readCache.set(keyHash, { record, cachedAt: Date.now() });
  }

  if (!record) return { valid: false, reason: 'NOT_FOUND' };
  if (record.revoked) return { valid: false, reason: 'REVOKED' };
  if (record.expiresAt && new Date(record.expiresAt).getTime() < Date.now()) return { valid: false, reason: 'EXPIRED' };

  // Best-effort, non-blocking last-used timestamp update — never delays the
  // request and never fails the auth check if the write has trouble.
  record.lastUsedAt = new Date().toISOString();
  setImmediate(() => { try { _save(); } catch { /* best-effort */ } });

  return { valid: true, userId: record.userId, role: record.role, keyId: record.id };
}

module.exports = {
  createApiKey,
  listApiKeysForUser,
  revokeApiKey,
  verifyApiKey,
  keyStore, // exported for tests, same convention as auth.controller.js's tokenStore/userStore
};
