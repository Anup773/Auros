'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// apiKey.service.js persists to backend/data/apiKeys.json (no configurable
// path). That file does not exist until Phase 2 creates it on first write —
// this test creates/uses/deletes it, and never touches users.json or any
// other pre-existing file.
const REAL_DATA_FILE = path.join(__dirname, '../data/apiKeys.json');

describe('apiKey.service', () => {
  let apiKeyService;

  before(() => {
    if (fs.existsSync(REAL_DATA_FILE)) fs.unlinkSync(REAL_DATA_FILE);
    apiKeyService = require('../services/auth/apiKey.service');
  });

  after(() => {
    if (fs.existsSync(REAL_DATA_FILE)) fs.unlinkSync(REAL_DATA_FILE);
  });

  test('createApiKey returns a full key exactly once, prefixed for recognisability', () => {
    const created = apiKeyService.createApiKey('user_key_1', 'Test Key', { role: 'finance' });
    assert.ok(created.key.startsWith('auros_live_'));
    assert.ok(created.keyPrefix.length < created.key.length);
    assert.equal(created.name, 'Test Key');
  });

  test('verifyApiKey accepts a freshly created key and resolves its owner/role', async () => {
    const created = apiKeyService.createApiKey('user_key_2', 'Another Key', { role: 'reviewer' });
    const result = await apiKeyService.verifyApiKey(created.key);
    assert.equal(result.valid, true);
    assert.equal(result.userId, 'user_key_2');
    assert.equal(result.role, 'reviewer');
  });

  test('verifyApiKey rejects a malformed or unknown key', async () => {
    assert.equal((await apiKeyService.verifyApiKey('not-a-key')).valid, false);
    assert.equal((await apiKeyService.verifyApiKey('auros_live_nonexistent')).valid, false);
  });

  test('listApiKeysForUser never exposes the hash or the full key', () => {
    apiKeyService.createApiKey('user_key_3', 'Listable Key');
    const list = apiKeyService.listApiKeysForUser('user_key_3');
    assert.equal(list.length, 1);
    assert.equal('keyHash' in list[0], false);
    assert.equal('key' in list[0], false);
    assert.ok(list[0].keyPrefix);
  });

  test('revokeApiKey invalidates the key and cannot be done by a different user', async () => {
    const created = apiKeyService.createApiKey('user_key_4', 'Revoke Me');

    const wrongUserResult = apiKeyService.revokeApiKey('someone_else', created.id);
    assert.equal(wrongUserResult, false);

    const correctResult = apiKeyService.revokeApiKey('user_key_4', created.id);
    assert.equal(correctResult, true);

    const verifyAfter = await apiKeyService.verifyApiKey(created.key);
    assert.equal(verifyAfter.valid, false);
    assert.equal(verifyAfter.reason, 'REVOKED');
  });

  test('an expired key is rejected', async () => {
    const created = apiKeyService.createApiKey('user_key_5', 'Expires Immediately', { expiresInDays: 0.0000001 });
    await new Promise(r => setTimeout(r, 50));
    const result = await apiKeyService.verifyApiKey(created.key);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'EXPIRED');
  });
});
