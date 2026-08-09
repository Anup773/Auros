#!/usr/bin/env node
'use strict';
/**
 * backend/scripts/set-role.js
 *
 * Change a user's role directly in data/users.json, without hand-editing
 * the file or needing an existing admin account to call the admin API.
 *
 * WHY THIS EXISTS: every new signup correctly defaults to the lowest
 * privilege role ('reviewer') — that's the right, secure default for real
 * users. But the very first account (yours, while testing) has no admin
 * account yet to promote it through the normal admin endpoints. This script
 * is the one-time bootstrap for that — and stays useful afterward any time
 * you need to promote a real user without going through the UI.
 *
 * IMPORTANT: stop your running server before using this. The server only
 * reads data/users.json once at startup — if it's running while you edit
 * the file, its next save (e.g. a login, a role change via the admin API)
 * will overwrite your edit with its own in-memory copy. Restart the server
 * after this script finishes so it picks up the change.
 *
 * Usage:
 *   node scripts/set-role.js <email> <role>
 *
 * Example:
 *   node scripts/set-role.js you@example.com admin
 *
 * Valid roles (least → most privileged): viewer, reviewer, finance, admin
 */

const fs   = require('fs');
const path = require('path');
const { isValidRole, ROLE_LEVELS } = require('../middleware/rbac');

const DATA_FILE = path.join(__dirname, '../data/users.json');

function fail(msg) {
  console.error(`[set-role] ${msg}`);
  process.exit(1);
}

const [, , emailArg, roleArg] = process.argv;

if (!emailArg || !roleArg) {
  fail(`Usage: node scripts/set-role.js <email> <role>\nValid roles: ${Object.keys(ROLE_LEVELS).join(', ')}`);
}

if (!isValidRole(roleArg)) {
  fail(`"${roleArg}" is not a valid role. Valid roles: ${Object.keys(ROLE_LEVELS).join(', ')}`);
}

if (!fs.existsSync(DATA_FILE)) {
  fail(`No users file found at ${DATA_FILE} — has anyone signed up yet?`);
}

const emailKey = emailArg.toLowerCase().trim();
const users    = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

if (!users[emailKey]) {
  fail(`No account found for "${emailArg}". Accounts on file: ${Object.keys(users).join(', ') || '(none)'}`);
}

const previousRole   = users[emailKey].role || '(none)';
users[emailKey].role = roleArg;

// Same atomic write pattern used everywhere else in this codebase — a
// crash mid-write leaves the original file intact.
const tmpFile = DATA_FILE + '.tmp';
fs.writeFileSync(tmpFile, JSON.stringify(users, null, 2), 'utf8');
fs.renameSync(tmpFile, DATA_FILE);

console.log(`[set-role] ${emailArg}: "${previousRole}" -> "${roleArg}"`);
console.log('[set-role] Done. Restart your server for this to take effect.');