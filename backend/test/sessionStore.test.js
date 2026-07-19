'use strict';
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const sessionStore = require('../services/auth/sessionStore.service');
const { closeRedis } = require('../config/redis');

describe('sessionStore.service', () => {
  test('createSession issues a working access+refresh pair', async () => {
    const session = await sessionStore.createSession('user_test_1', { ip: '1.1.1.1', userAgent: 'test' });
    assert.ok(session.accessToken);
    assert.ok(session.refreshToken);
    assert.notEqual(session.accessToken, session.refreshToken);

    const verified = await sessionStore.verifyAccessToken(session.accessToken);
    assert.equal(verified.userId, 'user_test_1');
    assert.equal(verified.sessionId, session.sessionId);
  });

  test('verifyAccessToken rejects a garbage token', async () => {
    const result = await sessionStore.verifyAccessToken('not-a-real-token');
    assert.equal(result, null);
  });

  test('verifyAccessToken rejects an empty/undefined token', async () => {
    assert.equal(await sessionStore.verifyAccessToken(undefined), null);
    assert.equal(await sessionStore.verifyAccessToken(''), null);
  });

  test('rotateRefreshToken issues a new pair and invalidates the old refresh token', async () => {
    const session = await sessionStore.createSession('user_test_2', {});
    const rotated = await sessionStore.rotateRefreshToken(session.refreshToken);

    assert.ok(rotated.accessToken);
    assert.ok(rotated.refreshToken);
    assert.equal(rotated.sessionId, session.sessionId);
    assert.notEqual(rotated.refreshToken, session.refreshToken);

    // The NEW access token should verify fine.
    const verified = await sessionStore.verifyAccessToken(rotated.accessToken);
    assert.equal(verified.userId, 'user_test_2');
  });

  test('reusing an already-rotated refresh token is detected and revokes the session', async () => {
    const session = await sessionStore.createSession('user_test_3', {});
    const rotated = await sessionStore.rotateRefreshToken(session.refreshToken);
    assert.ok(rotated.accessToken); // first rotation succeeds

    // Reusing the OLD refresh token a second time must be rejected...
    const reuse = await sessionStore.rotateRefreshToken(session.refreshToken);
    assert.equal(reuse.error, 'REUSE_DETECTED');

    // ...and must have revoked the whole session, including the token
    // issued by the legitimate first rotation.
    const verifiedAfter = await sessionStore.verifyAccessToken(rotated.accessToken);
    assert.equal(verifiedAfter, null);
  });

  test('rotateRefreshToken rejects an unknown refresh token', async () => {
    const result = await sessionStore.rotateRefreshToken('totally-unknown-refresh-token');
    assert.equal(result.error, 'INVALID');
  });

  test('revokeAccessToken invalidates the session immediately', async () => {
    const session = await sessionStore.createSession('user_test_4', {});
    await sessionStore.revokeAccessToken(session.accessToken, 'test_logout');
    const verified = await sessionStore.verifyAccessToken(session.accessToken);
    assert.equal(verified, null);
  });

  test('revokeAllSessionsForUser revokes every session for that user only', async () => {
    const s1 = await sessionStore.createSession('user_test_5', {});
    const s2 = await sessionStore.createSession('user_test_5', {});
    const otherUser = await sessionStore.createSession('user_test_6', {});

    const count = await sessionStore.revokeAllSessionsForUser('user_test_5', 'test_logout_all');
    assert.equal(count, 2);

    assert.equal(await sessionStore.verifyAccessToken(s1.accessToken), null);
    assert.equal(await sessionStore.verifyAccessToken(s2.accessToken), null);
    // A different user's session must be untouched.
    assert.notEqual(await sessionStore.verifyAccessToken(otherUser.accessToken), null);
  });

  test('listSessions reflects active sessions and excludes revoked ones', async () => {
    const s1 = await sessionStore.createSession('user_test_7', {});
    const s2 = await sessionStore.createSession('user_test_7', {});
    let sessions = await sessionStore.listSessions('user_test_7');
    assert.equal(sessions.length, 2);

    await sessionStore.revokeSession(s1.sessionId, 'test');
    sessions = await sessionStore.listSessions('user_test_7');
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, s2.sessionId);
  });

  after(async () => {
    await closeRedis();
  });
});