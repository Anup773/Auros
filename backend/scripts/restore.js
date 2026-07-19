#!/usr/bin/env node
'use strict';
/**
 * backend/scripts/restore.js
 *
 * PHASE 2 — companion to backup.js. Decrypts an encrypted backup and
 * extracts it. By default extracts into a NEW sibling directory
 * (restored-<timestamp>/) rather than overwriting backend/data or
 * backend/logs directly — this lets you PROVE a backup is valid and
 * restorable (which an encrypted, never-tested backup is not, in any
 * meaningful sense) without any risk to live data.
 *
 * Usage:
 *   node backend/scripts/restore.js <path-to-backup.tar.gz.enc>              # safe: extracts to a new folder
 *   node backend/scripts/restore.js <path-to-backup.tar.gz.enc> --force-restore  # DANGEROUS: overwrites backend/data, backend/logs, backend/uploads
 *
 * Requires the SAME BACKUP_ENCRYPTION_KEY used to create the backup.
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const BACKEND_ROOT = path.join(__dirname, '..');

function fail(message) {
  console.error(`[restore] ERROR: ${message}`);
  process.exit(1);
}

const [, , inputArg, flag] = process.argv;
if (!inputArg) {
  fail('Usage: node scripts/restore.js <path-to-backup.tar.gz.enc> [--force-restore]');
}
const forceRestore = flag === '--force-restore';

const rawKey = process.env.BACKUP_ENCRYPTION_KEY;
if (!rawKey) fail('BACKUP_ENCRYPTION_KEY is not set — cannot decrypt.');
const encKey = crypto.createHash('sha256').update(rawKey).digest();

function decryptFile(inputPath, outputPath) {
  const data = fs.readFileSync(inputPath);
  const magic = data.subarray(0, 4).toString('utf8');
  if (magic !== 'AUR1') fail('Unrecognized backup file format (bad magic header). Wrong file, or created by a different version of backup.js.');

  const iv        = data.subarray(4, 16);
  const authTag   = data.subarray(16, 32);
  const ciphertext = data.subarray(32);

  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
  decipher.setAuthTag(authTag);
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    fs.writeFileSync(outputPath, plaintext);
  } catch (err) {
    fail(`Decryption failed (${err.message}). Wrong BACKUP_ENCRYPTION_KEY, or the file is corrupted/tampered with — AES-GCM's auth tag check failed.`);
  }
}

function main() {
  if (!fs.existsSync(inputArg)) fail(`File not found: ${inputArg}`);

  const tmpTar = path.join(BACKEND_ROOT, `.restore-tmp-${Date.now()}.tar.gz`);
  console.log('[restore] Decrypting...');
  decryptFile(inputArg, tmpTar);
  console.log('[restore] Decryption OK (auth tag verified — file was not tampered with).');

  if (forceRestore) {
    console.log('[restore] --force-restore passed: extracting DIRECTLY into backend/, overwriting data/logs/uploads if present.');
    execFileSync('tar', ['-xzf', tmpTar, '-C', BACKEND_ROOT]);
    console.log('[restore] Restored in place. Restart the server for it to pick up the restored data/*.json files.');
  } else {
    const outDir = path.join(BACKEND_ROOT, `restored-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(outDir, { recursive: true });
    execFileSync('tar', ['-xzf', tmpTar, '-C', outDir]);
    console.log(`[restore] Extracted to: ${outDir}`);
    console.log('[restore] Nothing live was touched. Inspect the folder above, then either copy files in manually or re-run with --force-restore.');
  }

  fs.unlinkSync(tmpTar);
}

main();