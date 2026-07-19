'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const securityLogger = require('../audit/securityLogger.service');

const today = new Date().toISOString().slice(0, 10);
const LOG_FILE = path.join(__dirname, '../logs', `security-${today}.jsonl`);
let originalContent = null;

describe('securityLogger.service', () => {
  before(() => {
    // Preserve and restore any real log content from today so this test
    // suite doesn't destroy a real day's security log if run in the same
    // environment as the live app.
    if (fs.existsSync(LOG_FILE)) originalContent = fs.readFileSync(LOG_FILE, 'utf8');
  });

  after(async () => {
    await securityLogger.flush();
    if (originalContent !== null) fs.writeFileSync(LOG_FILE, originalContent, 'utf8');
  });

  test('logSecurityEvent redacts sensitive fields', async () => {
    securityLogger.logSecurityEvent('TEST_EVENT_REDACTION', {
      userId: 'user_log_1', password: 'hunter2', token: 'raw-secret-token',
    });
    await securityLogger.flush();

    const events = await securityLogger.getEvents();
    const found = events.filter(e => e.event === 'TEST_EVENT_REDACTION').pop();
    assert.ok(found);
    assert.equal(found.password, '[REDACTED]');
    assert.equal(found.token, '[REDACTED]');
    assert.equal(found.userId, 'user_log_1'); // non-sensitive fields pass through
  });

  test('hash chain is valid after several writes', async () => {
    securityLogger.logSecurityEvent('TEST_EVENT_A', { n: 1 });
    securityLogger.logSecurityEvent('TEST_EVENT_B', { n: 2 });
    securityLogger.logSecurityEvent('TEST_EVENT_C', { n: 3 });
    await securityLogger.flush();

    const integrity = await securityLogger.verifyChainIntegrity();
    assert.equal(integrity.valid, true);
    assert.equal(integrity.brokenAtLine, null);
  });

  test('verifyChainIntegrity detects a tampered line', async () => {
    securityLogger.logSecurityEvent('TEST_EVENT_TAMPER_CHECK', { n: 'original' });
    await securityLogger.flush();

    // Tamper with the last line's content directly on disk, simulating
    // someone editing the log file after the fact.
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
    const lastEntry = JSON.parse(lines[lines.length - 1]);
    lastEntry.n = 'tampered';
    lines[lines.length - 1] = JSON.stringify(lastEntry);
    fs.writeFileSync(LOG_FILE, lines.join('\n') + '\n', 'utf8');

    const integrity = await securityLogger.verifyChainIntegrity();
    assert.equal(integrity.valid, false);
    assert.equal(integrity.brokenAtLine, lines.length);
  });

  test('verifyChainIntegrity on a nonexistent date returns valid (nothing to break)', async () => {
    const integrity = await securityLogger.verifyChainIntegrity('1999-01-01');
    assert.equal(integrity.valid, true);
    assert.equal(integrity.totalLines, 0);
  });
});