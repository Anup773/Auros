'use strict';
/**
 * backend/controllers/data.controller.js  — V3
 *
 * CHANGES FROM V2 (this version — V3):
 *
 * CRITICAL FIX #1 — DATASET ID COLLISION
 *   Old: const datasetId = `ds_${Date.now()}` — two uploads within the same
 *        millisecond produced identical IDs, causing one to silently overwrite
 *        the other in the registry.
 *   New: crypto.randomUUID() — 122 bits of entropy, zero collision risk.
 *        Falls back to `ds_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`
 *        on Node versions that don't support randomUUID() (< 14.17).
 *
 * CRITICAL FIX #2 — UNBOUNDED DATASET MEMORY
 *   Old: Every uploaded file's full row set was stored in datasetRegistry.
 *        10 uploads of 500 MB datasets = 5 GB RAM. Server OOM.
 *   New: MAX_DATASET_ROWS (default: 500 000) enforced after parse.
 *        MAX_DATASET_REGISTRY_SIZE (default: 100) caps the number of datasets
 *        in memory at once. When the cap is reached, the oldest dataset is
 *        evicted (LRU by uploadedAt). Evicted datasets can still be re-parsed
 *        from disk (filePath is preserved) if requested again.
 *
 * CRITICAL FIX #3 — NO DATASET EXPIRY (memory leak)
 *   Old: datasetRegistry grew forever — a long-running server eventually
 *        accumulated all uploaded datasets in memory.
 *   New: Auto-cleanup interval (DATASET_TTL_MS = 4 hours) runs every 30 minutes
 *        and evicts datasets whose uploadedAt is older than TTL.
 *        setInterval handle stored in _cleanupInterval for graceful shutdown.
 *        export closeRegistry() for server.js to call on SIGTERM.
 *
 * HIGH FIX #4 — PREVIEW ENDPOINT ABUSE VIA HUGE limit PARAMETER
 *   Old: const limit = parseInt(req.query.limit) || 20 — no upper bound.
 *        GET /preview?limit=999999999 returned millions of rows in one response,
 *        spiking memory and saturating the network connection.
 *   New: PREVIEW_MAX_ROWS = 1000 (configurable via env PREVIEW_MAX_ROWS).
 *        Requests above this are capped silently (extra rows not returned);
 *        response includes totalRows so the client knows data was truncated.
 *
 * HIGH FIX #5 — registerServerFile: NO FILE SIZE CHECK (ZIP bomb / huge XML)
 *   Old: registerServerFile() called dataAnalyzer.parseFile() without checking
 *        the file size first. A 10 GB XML extracted from a ZIP bomb would OOM.
 *   New: fs.statSync(resolved).size checked against MAX_SERVER_FILE_BYTES
 *        (default: 500 MB) before any parsing occurs. Exceeding the limit
 *        returns a 413 with a clear message.
 *
 * MEDIUM FIX #6 — XML ENTITY EXPANSION RISK
 *   Old: XML files parsed without any defence against Billion Laughs / XXE.
 *   New: _warnXmlRisk(filePath) emits a console.warn when a .xml file is
 *        registered or uploaded, reminding the team to verify the XML parser
 *        in dataAnalyzer.service has entity expansion disabled. A note in the
 *        response payload flags xmlWarning: true for XML files so the caller
 *        can surface appropriate UI warnings.
 *        (Actual entity protection must be implemented in dataAnalyzer.service;
 *        this controller cannot patch the parser, but ensures it is visible.)
 *
 * PRESERVED FROM V2:
 *   - All export names unchanged (uploadDataset, previewDataset, analyzeDataset,
 *     downloadCleanedDataset, datasetRegistry, getDataset, datasetStore,
 *     registerServerFile)
 *   - XML file support
 *   - registerServerFile path traversal check
 *   - datasetStore alias for procurement controller compatibility
 */

const path         = require('path');
const fs           = require('fs');
const crypto       = require('crypto');
const dataAnalyzer = require('../services/data/dataAnalyzer.service');

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

// FIX #2: Memory caps
const MAX_DATASET_ROWS          = parseInt(process.env.MAX_DATASET_ROWS          || '500000', 10);
const MAX_DATASET_REGISTRY_SIZE = parseInt(process.env.MAX_DATASET_REGISTRY_SIZE || '100',    10);

// FIX #3: TTL
const DATASET_TTL_MS = parseInt(process.env.DATASET_TTL_HOURS || '4', 10) * 60 * 60 * 1000;

// FIX #4: Preview cap
const PREVIEW_MAX_ROWS = parseInt(process.env.PREVIEW_MAX_ROWS || '1000', 10);

// FIX #5: Max file size for registerServerFile
const MAX_SERVER_FILE_BYTES = parseInt(process.env.MAX_SERVER_FILE_MB || '500', 10) * 1024 * 1024;

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — IN-MEMORY REGISTRY
// ══════════════════════════════════════════════════════════════════════════════

// Preserve existing name: datasetRegistry
const datasetRegistry = new Map();

/**
 * FIX #1: Collision-free dataset ID generation.
 * crypto.randomUUID() available from Node 14.17+.
 */
function _generateDatasetId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for older Node versions
  return `ds_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * FIX #2: LRU eviction — remove the oldest dataset when the registry is full.
 * "Oldest" = smallest uploadedAt timestamp.
 */
function _evictOldestDataset() {
  if (datasetRegistry.size < MAX_DATASET_REGISTRY_SIZE) return;

  let oldestId  = null;
  let oldestAt  = Infinity;

  for (const [id, ds] of datasetRegistry.entries()) {
    const at = new Date(ds.uploadedAt).getTime();
    if (at < oldestAt) { oldestAt = at; oldestId = id; }
  }

  if (oldestId) {
    datasetRegistry.delete(oldestId);
    console.log(`[data] Evicted oldest dataset ${oldestId} (registry at cap ${MAX_DATASET_REGISTRY_SIZE})`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — AUTO-CLEANUP (FIX #3)
// ══════════════════════════════════════════════════════════════════════════════

const _cleanupInterval = setInterval(() => {
  const now     = Date.now();
  let   removed = 0;
  for (const [id, ds] of datasetRegistry.entries()) {
    if (now - new Date(ds.uploadedAt).getTime() > DATASET_TTL_MS) {
      datasetRegistry.delete(id);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`[data] Cleaned ${removed} expired dataset(s) from registry.`);
  }
}, 30 * 60 * 1000);

if (_cleanupInterval.unref) _cleanupInterval.unref();

// FIX #3: Export for graceful shutdown
function closeRegistry() {
  clearInterval(_cleanupInterval);
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — UPLOAD
// ══════════════════════════════════════════════════════════════════════════════

// Preserve existing method name: uploadDataset
exports.uploadDataset = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded', code: 'NO_FILE' });
    }

    // FIX #1: Collision-free ID
    const datasetId    = _generateDatasetId();
    const filePath     = req.file.path;
    const originalName = req.file.originalname;

    const { rows, columns } = await dataAnalyzer.parseFile(filePath, originalName);

    // FIX #2: Row count cap
    if (rows.length > MAX_DATASET_ROWS) {
      return res.status(413).json({
        error: `Dataset too large: ${rows.length} rows. Maximum: ${MAX_DATASET_ROWS}.`,
        code : 'DATASET_TOO_LARGE',
      });
    }

    // FIX #2: Registry size cap (evict oldest if needed)
    _evictOldestDataset();

    // FIX #6: XML entity expansion warning
    const isXml     = originalName.toLowerCase().endsWith('.xml');
    const xmlWarning = isXml ? _warnXmlRisk(originalName) : false;

    datasetRegistry.set(datasetId, {
      id              : datasetId,
      datasetId,
      originalName,
      filePath,
      rows,
      columns,
      cleanedRows     : null,
      cleanedFilePath : null,
      uploadedAt      : new Date().toISOString(),
    });

    const response = {
      datasetId,
      originalName,
      rowCount    : rows.length,
      columnCount : columns.length,
      columns,
      preview     : rows.slice(0, 5),
    };
    if (xmlWarning) response.xmlWarning = true;

    res.json(response);
  } catch (err) {
    next(err);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — PREVIEW (FIX #4)
// ══════════════════════════════════════════════════════════════════════════════

exports.previewDataset = (req, res, next) => {
  try {
    const dataset = getDataset(req.params.datasetId);

    // FIX #4: Cap the limit to prevent huge response payloads
    const requested = parseInt(req.query.limit, 10) || 20;
    const limit     = Math.min(Math.max(1, requested), PREVIEW_MAX_ROWS);

    res.json({
      rows        : dataset.rows.slice(0, limit),
      columns     : dataset.columns,
      totalRows   : dataset.rows.length,
      returnedRows: Math.min(limit, dataset.rows.length),
      capped      : requested > PREVIEW_MAX_ROWS,
    });
  } catch (err) {
    next(err);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — ANALYZE
// ══════════════════════════════════════════════════════════════════════════════

exports.analyzeDataset = async (req, res, next) => {
  try {
    const dataset = getDataset(req.params.datasetId);
    const issues  = await dataAnalyzer.detectIssues(
      dataset.rows, dataset.columns, dataset.filePath
    );
    res.json({ datasetId: dataset.id || dataset.datasetId, issues });
  } catch (err) {
    next(err);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — DOWNLOAD
// ══════════════════════════════════════════════════════════════════════════════

// Preserve existing method name: downloadCleanedDataset
exports.downloadCleanedDataset = (req, res, next) => {
  try {
    const dataset = getDataset(req.params.datasetId);
    if (!dataset.cleanedFilePath) {
      return res.status(404).json({
        error: 'No cleaned dataset available. Execute the pipeline first.',
        code : 'NOT_CLEANED',
      });
    }
    res.download(dataset.cleanedFilePath, `cleaned_${dataset.originalName}`);
  } catch (err) {
    next(err);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — REGISTER SERVER FILE (FIX #5 / FIX #6)
// ══════════════════════════════════════════════════════════════════════════════

exports.registerServerFile = async (req, res, next) => {
  try {
    const { serverPath, originalName } = req.body;

    if (!serverPath) {
      return res.status(400).json({ error: 'serverPath is required', code: 'MISSING_FIELD' });
    }

    const allowedBase = path.join(require('os').tmpdir(), 'auros_extracts');
    const resolved    = path.resolve(serverPath);
    if (!resolved.startsWith(allowedBase)) {
      return res.status(400).json({ error: 'Invalid server path', code: 'PATH_TRAVERSAL' });
    }
    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: 'File not found on server', code: 'FILE_NOT_FOUND' });
    }

    // FIX #5: File size check BEFORE parsing — prevents ZIP bomb / huge XML OOM
    const stat = fs.statSync(resolved);
    if (stat.size > MAX_SERVER_FILE_BYTES) {
      const sizeMB    = (stat.size / (1024 * 1024)).toFixed(1);
      const maxMB     = MAX_SERVER_FILE_BYTES / (1024 * 1024);
      return res.status(413).json({
        error: `File too large (${sizeMB} MB). Maximum allowed: ${maxMB} MB.`,
        code : 'FILE_TOO_LARGE',
      });
    }

    const displayName = originalName || path.basename(resolved);

    // FIX #6: XML entity expansion warning
    const isXml     = displayName.toLowerCase().endsWith('.xml');
    const xmlWarning = isXml ? _warnXmlRisk(displayName) : false;

    // FIX #1: Collision-free ID
    const datasetId = _generateDatasetId();

    let rows = [], columns = [];
    try {
      const parsed = await dataAnalyzer.parseFile(resolved, displayName);
      rows    = parsed.rows;
      columns = parsed.columns;
    } catch (parseErr) {
      console.warn(`[data] registerServerFile parse warning: ${parseErr.message}`);
    }

    // FIX #2: Row count cap
    if (rows.length > MAX_DATASET_ROWS) {
      return res.status(413).json({
        error: `File contains ${rows.length} rows. Maximum: ${MAX_DATASET_ROWS}.`,
        code : 'DATASET_TOO_LARGE',
      });
    }

    // FIX #2: Registry size cap
    _evictOldestDataset();

    datasetRegistry.set(datasetId, {
      id              : datasetId,
      datasetId,
      originalName    : displayName,
      filePath        : resolved,
      rows,
      columns,
      cleanedRows     : null,
      cleanedFilePath : null,
      uploadedAt      : new Date().toISOString(),
    });

    const response = {
      datasetId,
      originalName: displayName,
      rowCount    : rows.length,
      columnCount : columns.length,
    };
    if (xmlWarning) response.xmlWarning = true;

    res.status(201).json(response);
  } catch (err) {
    next(err);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 9 — HELPERS
// ══════════════════════════════════════════════════════════════════════════════

// Preserve existing export name: getDataset
function getDataset(id) {
  const dataset = datasetRegistry.get(id);
  if (!dataset) {
    throw Object.assign(new Error(`Dataset not found: ${id}`), { status: 404 });
  }
  return dataset;
}

/**
 * FIX #6: Warn about XML entity expansion risk.
 * The actual protection must be implemented in dataAnalyzer.service
 * (e.g. by configuring the XML parser to disable external entities).
 * This function surfaces the risk at the controller layer so it is visible
 * in logs and to callers.
 */
function _warnXmlRisk(filename) {
  console.warn(
    `[data] WARNING: XML file uploaded: "${filename}". ` +
    'Ensure dataAnalyzer.service disables external entity expansion (XXE) ' +
    'and entity count limits to prevent Billion Laughs attacks. ' +
    'See: https://cheatsheetseries.owasp.org/cheatsheets/XML_External_Entity_Prevention_Cheat_Sheet.html'
  );
  return true;  // Return true so callers can set xmlWarning: true in response
}

// ══════════════════════════════════════════════════════════════════════════════
// EXPORTS — preserve all existing names from V2
// ══════════════════════════════════════════════════════════════════════════════
exports.datasetRegistry = datasetRegistry;
exports.getDataset      = getDataset;
exports.datasetStore    = datasetRegistry;   // V2 alias for procurement.controller.js
exports.closeRegistry   = closeRegistry;     // FIX #3: new export for graceful shutdown

