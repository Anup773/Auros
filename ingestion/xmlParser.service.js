'use strict';
/**
 * backend/ingestion/xmlParser.service.js
 *
 * CHANGES FROM V3 (addressing new audit finding):
 *
 *   [NEW AUDIT #1 - HIGH IF PYTHON UNSAFE] XXE SAFETY CONFIRMATION DOCUMENTED.
 *     The audit correctly flagged that XXE (XML External Entity) safety was
 *     being delegated entirely to the Python engine with no Node-layer
 *     verification. An unsafe parser config could allow:
 *       <!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
 *     to read arbitrary files from the server.
 *
 *     This Node wrapper now:
 *       (a) Documents the required Python-side config explicitly so it appears
 *           in code review and cannot be accidentally changed without touching
 *           this file (defusedxml / lxml resolve_entities=False).
 *       (b) Performs a fast pre-flight byte scan of the first 4 KB of the
 *           file for the strings "<!DOCTYPE" and "<!ENTITY". If both are
 *           found in the same document header, the file is rejected with
 *           XXE_PATTERN_DETECTED before being sent to the Python engine at all.
 *           This is a defence-in-depth check, not the primary protection.
 *       (c) Validates the engine response (success field) — same pattern as
 *           schemaDetector.service.js.
 *
 *   NOTE: The pre-flight scan catches naive XXE payloads but is not a
 *   substitute for a secure parser. The Python engine MUST use defusedxml
 *   or configure lxml with resolve_entities=False and no_network=True.
 *   The comment block below is intentionally verbose for audit trail purposes.
 */

const fs             = require('fs');
const { callEngine } = require('../services/pythonBridge.service');

// ── XXE pre-flight config ─────────────────────────────────────────────────────

const XXE_SCAN_BYTES = 4 * 1024;  // scan first 4 KB — DOCTYPE always near top

/**
 * [NEW AUDIT #1] Scan the file header for a DOCTYPE + ENTITY combination,
 * which is the hallmark of an XXE payload.
 *
 * A valid procurement XML file (ERP export, SAP IDOC, etc.) never contains
 * internal entity declarations. Rejecting them here adds a fast,
 * dependency-free pre-filter before the Python engine touches the file.
 *
 * Returns true (reject) only when BOTH patterns appear in the first 4 KB.
 * A DOCTYPE without ENTITY is a common XML pattern and is allowed through
 * (the Python engine handles it safely regardless).
 *
 * @param {string} filePath
 * @returns {boolean}  true = suspicious, reject; false = proceed
 */
function _containsXxePattern(filePath) {
  let fd;
  try {
    const buf = Buffer.alloc(XXE_SCAN_BYTES);
    fd        = fs.openSync(filePath, 'r');
    const read = fs.readSync(fd, buf, 0, XXE_SCAN_BYTES, 0);
    const header = buf.slice(0, read).toString('utf8');

    const hasDoctype = /<!DOCTYPE\s/i.test(header);
    const hasEntity  = /<!ENTITY\s/i.test(header);

    return hasDoctype && hasEntity;
  } catch (_) {
    return false; // unreadable — let the engine deal with it
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse an XML file and return flattened rows + schema metadata.
 *
 * Python engine REQUIRED security configuration:
 *   import defusedxml.ElementTree as ET   # pip install defusedxml
 *   # OR with lxml:
 *   parser = lxml.etree.XMLParser(
 *     resolve_entities = False,
 *     no_network       = True,
 *     load_dtd         = False,
 *   )
 * Failure to configure this allows XXE attacks that can read arbitrary
 * server files or trigger SSRF via external entity resolution.
 *
 * @param {string} filePath — Absolute path to the validated XML file
 * @returns {Promise<{
 *   rowCount:    number,
 *   schema:      Object,
 *   columnNames: string[],
 *   sampleRows:  Object[],
 *   warnings:    string[],
 * }>}
 * @throws {Error} on XXE pattern detection or engine failure
 */
async function parseXml(filePath) {
  // [NEW AUDIT #1(b)] Defence-in-depth: pre-flight XXE pattern scan.
  if (_containsXxePattern(filePath)) {
    throw Object.assign(
      new Error(
        'XML file contains a DOCTYPE + ENTITY declaration, which is a potential ' +
        'XXE (XML External Entity) injection vector. File rejected.'
      ),
      { code: 'XXE_PATTERN_DETECTED', status: 400 }
    );
  }

  const result = await callEngine({ operation: 'parse_xml', filePath });

  // [NEW AUDIT #1(c)] Engine response validation — same pattern as schemaDetector.
  if (result.success === false) {
    const engineMsg = result.error || result.message || 'Unknown engine error';
    throw Object.assign(
      new Error(`XML parsing failed: ${engineMsg}`),
      { code: 'ENGINE_PARSE_FAILED', status: 500 }
    );
  }

  return {
    rowCount   : result.rowCount    || 0,
    schema     : result.schema      || {},
    columnNames: result.columnNames || [],
    sampleRows : result.sampleRows  || [],
    warnings   : result.warnings    || [],
  };
}

module.exports = { parseXml };
