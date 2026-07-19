#!/usr/bin/env node
'use strict';
/**
 * backend/scripts/backup.js
 *
 * PHASE 2 — "Encrypted backups".
 *
 * WHY THIS MATTERS MORE THAN IT MIGHT LOOK: this app has no traditional
 * database (confirmed by reading the whole backend — no Mongoose/Prisma/pg/
 * MongoClient anywhere). User accounts, API keys, and now MFA secrets all
 * live in JSON files under backend/data/, and the new security event log
 * lives under backend/logs/. Those files ARE the durable state. Losing the
 * disk they're on (or an unencrypted copy of them leaking) is equivalent to
 * losing/leaking a database.
 *
 * This is a STANDALONE script — it is never imported by app.js/server.js
 * and has zero effect on the running application. Run it manually or from
 * cron:
 *
 *   node backend/scripts/backup.js
 *
 * Suggested crontab entry (daily at 02:00):
 *   0 2 * * * cd /path/to/Auros/backend && BACKUP_ENCRYPTION_KEY=... node scripts/backup.js >> logs/backup.log 2>&1
 *
 * A deliberate design choice not made here: an in-process scheduler
 * (e.g. node-cron) was NOT added to server.js for this. Embedding a
 * scheduler into the long-running app process is one more thing that can
 * go wrong inside the process you're trying to keep stable and working —
 * an external scheduler (cron, an ECS scheduled task, a k8s CronJob) is the
 * standard, safer place for this, and keeps this entirely out of the
 * request-handling code path you asked not to be disturbed.
 *
 * WHAT'S BACKED UP:
 *   - backend/data/*.json           (users, API keys — the "database")
 *   - backend/logs/security-*.jsonl (SOC2-style security event log)
 *   - backend/uploads/              (only if STORAGE_BACKEND=local, i.e.
 *                                    files aren't already mirrored to S3)
 *
 * PROCESS: tar (via the system `tar` binary — present on essentially every
 * Linux server/container image, so no new dependency) -> AES-256-GCM
 * encrypt with Node's built-in crypto -> optionally upload to S3 -> delete
 * the unencrypted intermediate tarball so no plaintext copy is left on disk.
 *
 * REQUIRES: BACKUP_ENCRYPTION_KEY to be set. This script deliberately
 * REFUSES to create an unencrypted backup rather than silently falling back
 * — "encrypted backups" was the actual ask, so an unencrypted one isn't a
 * degraded version of that, it's a different (and unwanted) thing.
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const BACKEND_ROOT = path.join(__dirname, '..');
const BACKUP_DIR   = path.join(BACKEND_ROOT, 'backups');
const STORAGE_BACKEND = process.env.STORAGE_BACKEND || 'local';

function fail(message) {
  console.error(`[backup] ERROR: ${message}`);
  process.exit(1);
}

const rawKey = process.env.BACKUP_ENCRYPTION_KEY;
if (!rawKey) {
  fail('BACKUP_ENCRYPTION_KEY is not set. Refusing to create an unencrypted backup. ' +
       'Set it to a long random value, e.g.: openssl rand -hex 32');
}
const encKey = crypto.createHash('sha256').update(rawKey).digest();

function collectBackupPaths() {
  const paths = [];
  const dataDir = path.join(BACKEND_ROOT, 'data');
  const logsDir = path.join(BACKEND_ROOT, 'logs');
  const uploadsDir = path.join(BACKEND_ROOT, 'uploads');

  if (fs.existsSync(dataDir)) paths.push('data');
  if (fs.existsSync(logsDir)) paths.push('logs');
  if (STORAGE_BACKEND === 'local' && fs.existsSync(uploadsDir)) {
    paths.push('uploads');
  } else if (STORAGE_BACKEND !== 'local') {
    console.log('[backup] STORAGE_BACKEND is not "local" — skipping backend/uploads/ (files are expected to already be mirrored to S3, which has its own backup/versioning story).');
  }
  return paths;
}

function encryptFile(inputPath, outputPath) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const input = fs.readFileSync(inputPath);
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Layout: [4 bytes magic][12 bytes IV][16 bytes authTag][ciphertext]
  const magic = Buffer.from('AUR1', 'utf8');
  fs.writeFileSync(outputPath, Buffer.concat([magic, iv, authTag, ciphertext]));
}

async function main() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const paths = collectBackupPaths();
  if (paths.length === 0) {
    console.log('[backup] Nothing to back up yet (no data/logs/uploads directories found). Exiting.');
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tarPath = path.join(BACKUP_DIR, `auros-backup-${timestamp}.tar.gz`);
  const encPath = `${tarPath}.enc`;

  console.log(`[backup] Archiving: ${paths.join(', ')}`);
  execFileSync('tar', ['-czf', tarPath, '-C', BACKEND_ROOT, ...paths]);

  const sizeMb = (fs.statSync(tarPath).size / (1024 * 1024)).toFixed(2);
  console.log(`[backup] Archive created (${sizeMb} MB). Encrypting...`);

  encryptFile(tarPath, encPath);
  fs.unlinkSync(tarPath); // never leave an unencrypted copy on disk

  console.log(`[backup] Encrypted backup written to: ${encPath}`);

  if (STORAGE_BACKEND === 's3' || process.env.BACKUP_S3_UPLOAD === 'true') {
    const s3Storage = require('../services/storage/s3Storage.service');
    if (s3Storage.isEnabled()) {
      const key = `backups/${path.basename(encPath)}`;
      await s3Storage.uploadFile(encPath, key, 'application/octet-stream');
      console.log(`[backup] Uploaded to s3://${process.env.S3_BUCKET}/${key}`);
    } else {
      console.warn('[backup] BACKUP_S3_UPLOAD/STORAGE_BACKEND requested S3 upload, but S3 storage is not enabled/configured — backup remains local only.');
    }
  }

  // Local retention: keep the last N encrypted backups, delete older ones.
  const retainCount = parseInt(process.env.BACKUP_LOCAL_RETAIN_COUNT || '14', 10);
  const existing = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.tar.gz.enc'))
    .map(f => ({ f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { f } of existing.slice(retainCount)) {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
    console.log(`[backup] Pruned old local backup: ${f}`);
  }

  console.log('[backup] Done.');
}

main().catch(err => fail(err.message));
