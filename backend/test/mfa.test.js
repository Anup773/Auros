'use strict';
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

// mfa.service.js reads MFA_ENCRYPTION_KEY at require-time, so it must be set
// before the first require() anywhere in the process.
process.env.MFA_ENCRYPTION_KEY = process.env.MFA_ENCRYPTION_KEY || 'test-only-mfa-key-do-not-use-in-prod';

const mfaService = require('../services/auth/mfa.service');
const { generate } = require('otplib');
const { closeRedis } = require('../config/redis');

describe('mfa.service', () => {
  test('isConfigured reflects whether MFA_ENCRYPTION_KEY is set', () => {
    assert.equal(mfaService.isConfigured(), true);
  });

  test('encryptSecret/decryptSecret round-trip correctly', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const encrypted = mfaService.encryptSecret(secret);
    assert.notEqual(encrypted, secret);
    assert.equal(mfaService.decryptSecret(encrypted), secret);
  });

  test('full enrollment flow: begin -> generate code -> complete', async () => {
    const enrollment = await mfaService.beginEnrollment('user_mfa_1', 'test@example.com');
    assert.ok(enrollment.secret);
    assert.ok(enrollment.otpauthUrl.startsWith('otpauth://totp/'));
    assert.ok(enrollment.qrCodeDataUrl.startsWith('data:image/png;base64,'));

    const validCode = await generate({ secret: enrollment.secret });
    const result = await mfaService.completeEnrollment('user_mfa_1', validCode);
    assert.equal(result.valid, true);
    assert.equal(result.secret, enrollment.secret);
  });

  test('completeEnrollment rejects a wrong code', async () => {
    await mfaService.beginEnrollment('user_mfa_2', 'test2@example.com');
    const result = await mfaService.completeEnrollment('user_mfa_2', '000000');
    assert.equal(result.valid, false);
  });

  test('completeEnrollment rejects when there is no pending enrollment', async () => {
    const result = await mfaService.completeEnrollment('user_never_started', '123456');
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'NO_PENDING_ENROLLMENT');
  });

  test('verifyTotp accepts a currently-valid code against an encrypted secret', async () => {
    const enrollment = await mfaService.beginEnrollment('user_mfa_3', 'test3@example.com');
    const encrypted = mfaService.encryptSecret(enrollment.secret);
    const code = await generate({ secret: enrollment.secret });
    const result = await mfaService.verifyTotp(encrypted, code);
    assert.equal(result.valid, true);
  });

  test('replay protection: the same code cannot be used twice', async () => {
    const enrollment = await mfaService.beginEnrollment('user_mfa_4', 'test4@example.com');
    const encrypted = mfaService.encryptSecret(enrollment.secret);
    const code = await generate({ secret: enrollment.secret });

    const first = await mfaService.verifyTotp(encrypted, code);
    assert.equal(first.valid, true);

    const second = await mfaService.verifyTotp(encrypted, code, first.timeStep);
    assert.equal(second.valid, false);
  });

  test('login challenge: create -> consume once -> second consume fails', async () => {
    const token = await mfaService.createLoginChallenge('user_mfa_5');
    assert.ok(token);

    const userId = await mfaService.consumeLoginChallenge(token);
    assert.equal(userId, 'user_mfa_5');

    const secondAttempt = await mfaService.consumeLoginChallenge(token);
    assert.equal(secondAttempt, null);
  });

  test('backup codes: generate, hash, find, and case/dash-insensitive matching', () => {
    const codes = mfaService.generateBackupCodes(5);
    assert.equal(codes.length, 5);
    const hashes = codes.map(c => mfaService.hashBackupCode(c));

    assert.equal(mfaService.findBackupCodeIndex(codes[3], hashes), 3);
    assert.equal(mfaService.findBackupCodeIndex(codes[3].toLowerCase().replace('-', ''), hashes), 3);
    assert.equal(mfaService.findBackupCodeIndex('AAAA-AAAA', hashes), -1);
  });

  after(async () => {
    await closeRedis();
  });
});
