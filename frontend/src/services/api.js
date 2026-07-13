/**
 * frontend/src/services/api.js — V4
 *
 * CHANGES FROM V3 (this version — V4):
 *
 *   FIX 1 — Per-endpoint timeout overrides (CRITICAL)
 *     Old: FETCH_TIMEOUT_MS (30s) applied to every request including OCR.
 *     OCR can legitimately take 320+ seconds (5+ minutes) for scanned PDFs.
 *     The 30s abort fired before OCR completed, showing "Request timed out
 *     after 30s. Is the backend running on http://localhost:4000?" even
 *     though the backend was running perfectly.
 *     Fix: request() accepts opts.timeoutMs to override per-call.
 *     ocrAPI.invoice() and ocrAPI.batch() use OCR_TIMEOUT_MS (360s).
 *     procurementAPI.startReconciliation() uses RECONCILE_TIMEOUT_MS (660s).
 *     procurementAPI.execute() uses EXECUTE_TIMEOUT_MS (660s).
 *     All other calls keep the default 30s timeout.
 *
 *   FIX 2 — procurementAPI.getJob uses no timeout cap during polling
 *     Old: getJob() shared the 30s default, fine individually but if the
 *     server ever stalled responding, the poll would silently skip it
 *     (continue on fetchErr) and keep trying.
 *     Fix: getJob() uses POLL_TIMEOUT_MS (10s) — short enough to recover
 *     quickly from a stalled response, long enough not to false-alarm.
 *
 *   All V3 fixes preserved:
 *     - AbortController timeout (FIX 1 V3)
 *     - Binary/streaming download support (FIX 2 V3)
 *     - Auth token for download URLs (FIX 3 V3)
 *     - Error message field fallback (FIX 4 V3)
 *     - Retry on transient server errors (FIX 5 V3)
 *     - BASE_URL fallback warning (FIX 6 V3)
 */

const BASE_URL           = process.env.REACT_APP_API_URL         || 'http://localhost:4000';
const FETCH_TIMEOUT_MS   = parseInt(process.env.REACT_APP_API_TIMEOUT_MS || '30000',  10);
const MAX_RETRIES        = 2;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

// Per-endpoint timeout overrides (FIX 1)
// OCR can take up to 320s server-side (OCR_PYBRIDGE_TIMEOUT_MS).
// Add 40s buffer so the frontend never aborts before the server does.
const OCR_TIMEOUT_MS        = parseInt(process.env.REACT_APP_OCR_TIMEOUT_MS        || '360000', 10); // 6 min
const RECONCILE_TIMEOUT_MS  = parseInt(process.env.REACT_APP_RECONCILE_TIMEOUT_MS  || '660000', 10); // 11 min
const EXECUTE_TIMEOUT_MS    = parseInt(process.env.REACT_APP_EXECUTE_TIMEOUT_MS    || '660000', 10); // 11 min
const POLL_TIMEOUT_MS       = parseInt(process.env.REACT_APP_POLL_TIMEOUT_MS       || '10000',  10); // 10s
// FIX: plain CSV/XLSX/ZIP/XML uploads (dataAPI.upload, uploadAPI.*) were still
// stuck on the 30s FETCH_TIMEOUT_MS default even though the dropzone advertises
// files up to 500MB. Matches the backend's new UPLOAD_ROUTE_TIMEOUT_MS (app.js).
const UPLOAD_TIMEOUT_MS     = parseInt(process.env.REACT_APP_UPLOAD_TIMEOUT_MS     || '300000', 10); // 5 min

// FIX 6 (V3): Warn if localhost in production build
if (process.env.NODE_ENV === 'production' && BASE_URL.includes('localhost')) {
  console.warn('[api.js] WARNING: REACT_APP_API_URL is localhost in a production build. Set it to your backend URL.');
}

/**
 * Core request function with timeout, retry, and binary support.
 *
 * @param {string}  method
 * @param {string}  path
 * @param {*}       [body]
 * @param {string}  [token]
 * @param {boolean} [isFormData]
 * @param {Object}  [opts]
 * @param {boolean} [opts.returnRaw]  — return raw Response (for binary downloads)
 * @param {number}  [opts.timeoutMs]  — override timeout for this call (FIX 1)
 */
async function request(method, path, body = null, token = null, isFormData = false, opts = {}) {
  const headers = {};
  if (!isFormData) headers['Content-Type'] = 'application/json';
  if (token)       headers['Authorization'] = `Bearer ${token}`;

  const config = {
    method,
    headers,
    body: isFormData ? body : body ? JSON.stringify(body) : null,
  };

  // FIX 1: Use per-call timeout if provided, otherwise global default
  const timeoutMs   = opts.timeoutMs != null ? opts.timeoutMs : FETCH_TIMEOUT_MS;
  const isIdempotent = method === 'GET' || method === 'HEAD';
  let lastError;

  for (let attempt = 0; attempt <= (isIdempotent ? MAX_RETRIES : 0); attempt++) {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let res;
      try {
        res = await fetch(`${BASE_URL}${path}`, { ...config, signal: controller.signal });
      } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
          throw new Error(
            `Request timed out after ${Math.round(timeoutMs / 1000)}s. ` +
            `Is the backend running on ${BASE_URL}?`
          );
        }
        throw new Error(`Network error: ${err.message}. Is the backend running on ${BASE_URL}?`);
      }
      clearTimeout(timer);

      // FIX 5 (V3): Retry on transient server errors (GET only)
      if (isIdempotent && RETRYABLE_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
        const delay = Math.pow(2, attempt) * 500;
        console.warn(`[api.js] ${res.status} on ${path} — retrying in ${delay}ms (attempt ${attempt + 1})`);
        await _sleep(delay);
        lastError = new Error(`Server returned ${res.status}`);
        continue;
      }

      // FIX 2 (V3): Binary/non-JSON response handling
      const contentType = res.headers.get('Content-Type') || '';
      if (opts.returnRaw || (!contentType.includes('application/json') && res.ok)) {
        return res;
      }

      // FIX 4 (V3): Error message field fallback
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || data.message || `Request failed with status ${res.status}`);
      }
      return data;

    } catch (err) {
      clearTimeout(timer);
      if (attempt >= (isIdempotent ? MAX_RETRIES : 0)) throw err;
      lastError = err;
      const delay = Math.pow(2, attempt) * 500;
      console.warn(`[api.js] Request failed, retrying: ${err.message}`);
      await _sleep(delay);
    }
  }

  throw lastError || new Error('Request failed');
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * FIX 3 (V3): Authenticated download — fetches with token and returns blob URL.
 */
async function _authenticatedDownload(path, token) {
  const res  = await request('GET', path, null, token, false, { returnRaw: true });
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

// ── API modules ───────────────────────────────────────────────────────────────

export const authAPI = {
  signup     : (name, email, password) => request('POST', '/api/auth/signup', { name, email, password }),
  login      : (email, password)       => request('POST', '/api/auth/login',  { email, password }),
  googleLogin: (accessToken)           => request('POST', '/api/auth/google', { accessToken }),
  getMe      : (token)                 => request('GET',  '/api/auth/me', null, token),
  logout     : (token)                 => request('POST', '/api/auth/logout', {}, token),
};

export const dataAPI = {
  // FIX: was missing timeoutMs override — 500MB uploads were aborting at the 30s default
  upload: (file, token) => {
    const formData = new FormData();
    formData.append('file', file);
    return request('POST', '/api/data/upload', formData, token, true, { timeoutMs: UPLOAD_TIMEOUT_MS });
  },
  preview : (datasetId, token) => request('GET', `/api/data/${datasetId}/preview`, null, token),
  analyze : (datasetId, token) => request('GET', `/api/data/${datasetId}/analyze`, null, token),

  download   : (datasetId, token) => _authenticatedDownload(`/api/data/${datasetId}/download`, token),
  downloadUrl: (datasetId)        => `${BASE_URL}/api/data/${datasetId}/download`,

  registerServerFile: (serverPath, originalName, token) =>
    request('POST', '/api/upload/register-server', { serverPath, originalName }, token),
};

// FIX: all file-accepting functions below were missing timeoutMs — same 30s bug as dataAPI.upload
export const uploadAPI = {
  zip: (file, token) => {
    const fd = new FormData();
    fd.append('file', file);
    return request('POST', '/api/upload/zip', fd, token, true, { timeoutMs: UPLOAD_TIMEOUT_MS });
  },
  xml: (file, token) => {
    const fd = new FormData();
    fd.append('file', file);
    return request('POST', '/api/upload/xml', fd, token, true, { timeoutMs: UPLOAD_TIMEOUT_MS });
  },
  parse: (file, token) => {
    const fd = new FormData();
    fd.append('file', file);
    return request('POST', '/api/upload/parse', fd, token, true, { timeoutMs: UPLOAD_TIMEOUT_MS });
  },
  parseServerPath: (serverPath, token) =>
    request('POST', '/api/upload/parse-server', { serverPath }, token),
  multi: (files, token) => {
    const fd = new FormData();
    files.forEach(f => fd.append('files', f));
    return request('POST', '/api/upload/multi', fd, token, true, { timeoutMs: UPLOAD_TIMEOUT_MS });
  },
};

export const ocrAPI = {
  // FIX 1: OCR needs up to 360s — the server-side OCR timeout is 320s
  invoice: (file, token, gemini_fallback = false) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('gemini_fallback', String(gemini_fallback));
    return request('POST', '/api/ocr/invoice', fd, token, true, { timeoutMs: OCR_TIMEOUT_MS });
  },
  batch: (files, token, gemini_fallback = false) => {
    const fd = new FormData();
    files.forEach(f => fd.append('files', f));
    fd.append('gemini_fallback', String(gemini_fallback));
    return request('POST', '/api/ocr/batch', fd, token, true, { timeoutMs: OCR_TIMEOUT_MS });
  },
  health: (token) => request('GET', '/api/ocr/health', null, token),
};

export const aiAPI = {
  interpret        : (datasetId, issue, userResponse, token) =>
    request('POST', '/api/ai/interpret',          { datasetId, issue, userResponse }, token),
  generateQuestions: (datasetId, issues, token) =>
    request('POST', '/api/ai/generate-questions', { datasetId, issues },             token),
};

export const voiceAPI = {
  transcribe: (audioBlob, token) => {
    const formData = new FormData();
    formData.append('audio', audioBlob, 'recording.webm');
    return request('POST', '/api/voice/transcribe', formData, token, true);
  },

  command: (audioBlob, ambiguities, pendingId, commandId, token) => {
    const formData = new FormData();
    formData.append('audio', audioBlob, 'recording.webm');
    formData.append('ambiguities', JSON.stringify(ambiguities || []));
    if (pendingId)   formData.append('pendingId',  pendingId);
    if (commandId)   formData.append('commandId',  commandId);
    return request('POST', '/api/voice/command', formData, token, true);
  },

  textCommand: (text, ambiguities, pendingId, token) =>
    request('POST', '/api/voice/text-command', {
      text,
      ambiguities: ambiguities || [],
      pendingId  : pendingId || null,
    }, token),
};

export const pipelineAPI = {
  create     : (datasetId, token)             => request('POST',   '/api/pipeline/create',                                  { datasetId }, token),
  addStep    : (pipelineId, action, token)    => request('POST',   `/api/pipeline/${pipelineId}/add-step`,                   action,        token),
  previewStep: (pipelineId, stepIndex, token) => request('GET',    `/api/pipeline/${pipelineId}/preview-step/${stepIndex}`,  null,          token),
  confirmStep: (pipelineId, stepIndex, token) => request('POST',   `/api/pipeline/${pipelineId}/confirm-step/${stepIndex}`,  {},            token),
  rejectStep : (pipelineId, stepIndex, token) => request('DELETE', `/api/pipeline/${pipelineId}/reject-step/${stepIndex}`,   null,          token),
  execute    : (pipelineId, token)            => request('POST',   `/api/pipeline/${pipelineId}/execute`,                    {},            token),
  getStatus  : (pipelineId, token)            => request('GET',    `/api/pipeline/${pipelineId}/status`,                     null,          token),
  getLog     : (pipelineId, token)            => request('GET',    `/api/pipeline/${pipelineId}/log`,                        null,          token),
};

export const procurementAPI = {
  listJobs: (token) =>
    request('GET', '/api/procurement', null, token),

  // FIX 1: startReconciliation queues the job and returns 202 almost
  // immediately — but give it 660s in case Redis is slow or the sync
  // fallback path runs (which blocks until Python finishes).
  // Batch 3: grnDatasetId/contractDatasetId are optional and appended at
  // the end — existing 3-arg callers (invoiceDatasetId, poDatasetId, token)
  // keep working unchanged; they just become `undefined`, which the backend
  // already treats as "not supplied."
  startReconciliation: (invoiceDatasetId, poDatasetId, token, grnDatasetId, contractDatasetId) =>
    request('POST', '/api/procurement/reconcile',
      { invoiceDatasetId, poDatasetId, grnDatasetId, contractDatasetId },
      token, false,
      { timeoutMs: RECONCILE_TIMEOUT_MS }
    ),

  // FIX 2: getJob is called in a polling loop every 2s.
  // Use a short 10s timeout so stalled responses are detected quickly
  // without burning the full 30s default before the loop retries.
  getJob: (jobId, token) =>
    request('GET', `/api/procurement/${jobId}`, null, token, false,
      { timeoutMs: POLL_TIMEOUT_MS }
    ),

  approveItem: (jobId, approvalId, response, token) =>
    request('POST', `/api/procurement/${jobId}/approve/${approvalId}`, { response }, token),

  rejectItem: (jobId, approvalId, reason, token) =>
    request('POST', `/api/procurement/${jobId}/reject/${approvalId}`, { reason }, token),

  // FIX 1: execute() calls Python synchronously and can take up to 10 min
  execute: (jobId, token) =>
    request('POST', `/api/procurement/${jobId}/execute`, {}, token, false,
      { timeoutMs: EXECUTE_TIMEOUT_MS }
    ),

  downloadOutput   : (jobId, token)          => _authenticatedDownload(`/api/procurement/${jobId}/download`, token),
  downloadOutputUrl: (jobId)                 => `${BASE_URL}/api/procurement/${jobId}/download`,

  getSchema    : (jobId, token)              => request('GET', `/api/procurement/${jobId}/schema`,            null, token),
  getAuditTrail: (jobId, format = 'json', token) =>
    request('GET', `/api/procurement/${jobId}/audit?format=${format}`, null, token),
};

export const whatsappAPI = {
  sendApproval: (toPhone, jobId, approvalId, question, options, token) =>
    request('POST', '/api/whatsapp/send', { toPhone, jobId, approvalId, question, options }, token),
  getStatus: (jobId, token) =>
    request('GET', `/api/whatsapp/status/${jobId}`, null, token),
};

export const billingAPI = {
  getPlans          : (token)         => request('GET',  '/api/billing/plans',        null,      token),
  createCheckout    : (planId, token) => request('POST', '/api/billing/checkout',      { planId }, token),
  getSubscription   : (token)         => request('GET',  '/api/billing/subscription',  null,      token),
  cancelSubscription: (token)         => request('POST', '/api/billing/cancel',        {},        token),
  getPortalUrl      : (token)         => request('GET',  '/api/billing/portal',        null,      token),
};
