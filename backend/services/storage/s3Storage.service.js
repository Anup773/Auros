'use strict';
/**
 * backend/services/storage/s3Storage.service.js
 *
 * PHASE 2 — "S3 private storage".
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SCOPE OF THIS CHANGE (read this before wiring it into more places)
 * ─────────────────────────────────────────────────────────────────────────
 * This service is a complete, working S3 client wrapper. Where it's
 * actually WIRED IN, though, is deliberately narrow: as an ADDITIVE mirror
 * on the dataset upload path in data.controller.js (uploads are written to
 * S3 in addition to local disk, never instead of), and as an OPTIONAL
 * presigned-URL download path.
 *
 * What this does NOT do: replace local-disk paths throughout the ingestion
 * pipeline, the Python bridge, or the reconciliation engine. Those systems
 * pass `filePath` (a local disk path) between each other in many places —
 * rewriting all of that to work against S3 keys instead would touch the
 * ingestion/pipeline/reconciliation subsystem you specifically asked not to
 * touch, and would need the Python subprocess layer to download-to-temp/
 * upload-after for every operation, which is a real architecture change
 * with its own failure modes, not a security fix. See PHASE2_SECURITY.md
 * for the longer version of this reasoning and what a full migration would
 * involve if you want it later.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * FEATURE FLAG
 * ─────────────────────────────────────────────────────────────────────────
 * STORAGE_BACKEND=local (default) — this module is inert; nothing changes.
 * STORAGE_BACKEND=s3              — requires S3_BUCKET + AWS credentials
 *                                    (standard AWS SDK credential chain:
 *                                    env vars, shared config file, or an
 *                                    instance/task role in production).
 */

const fs = require('fs');
const {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const STORAGE_BACKEND = process.env.STORAGE_BACKEND || 'local';
const BUCKET  = process.env.S3_BUCKET || null;
const REGION  = process.env.AWS_REGION || 'us-east-1';
const SSE     = process.env.S3_SSE_ALGORITHM || 'AES256'; // or 'aws:kms'
const KMS_KEY = process.env.S3_KMS_KEY_ID || undefined;    // only used if SSE === 'aws:kms'
const DEFAULT_PRESIGN_EXPIRY_SEC = parseInt(process.env.S3_PRESIGN_EXPIRY_SEC || '300', 10);

function isEnabled() {
  return STORAGE_BACKEND === 's3' && !!BUCKET;
}

let _client = null;
function _getClient() {
  if (!_client) _client = new S3Client({ region: REGION });
  return _client;
}

if (STORAGE_BACKEND === 's3' && !BUCKET) {
  console.warn('[s3Storage] STORAGE_BACKEND=s3 but S3_BUCKET is not set — S3 storage will be disabled until it is.');
}

/**
 * Upload a buffer as a private, encrypted object. No-op (returns null) if
 * S3 storage isn't enabled — callers should treat that as "not mirrored",
 * not as an error, since local disk remains the source of truth either way.
 */
async function uploadBuffer(buffer, key, contentType) {
  if (!isEnabled()) return null;
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
    ServerSideEncryption: SSE,
    ...(SSE === 'aws:kms' && KMS_KEY ? { SSEKMSKeyId: KMS_KEY } : {}),
    // Deliberately no ACL parameter — the bucket should be fully private
    // (block-all-public-access at the bucket policy level, set once during
    // AWS setup — that's an infrastructure setting, not something this
    // application code can enforce from here).
  });
  await _getClient().send(command);
  return { bucket: BUCKET, key };
}

async function uploadFile(localPath, key, contentType) {
  if (!isEnabled()) return null;
  const buffer = await fs.promises.readFile(localPath);
  return uploadBuffer(buffer, key, contentType);
}

/** Presigned, time-limited GET URL — the only intended way to read a private object back. */
async function getSignedDownloadUrl(key, expiresInSec = DEFAULT_PRESIGN_EXPIRY_SEC) {
  if (!isEnabled()) return null;
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(_getClient(), command, { expiresIn: expiresInSec });
}

async function objectExists(key) {
  if (!isEnabled()) return false;
  try {
    await _getClient().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

async function deleteObject(key) {
  if (!isEnabled()) return null;
  await _getClient().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  return true;
}

module.exports = {
  isEnabled,
  uploadBuffer,
  uploadFile,
  getSignedDownloadUrl,
  objectExists,
  deleteObject,
};
