'use strict';
/**
 * backend/ingestion/schemaDetector.service.js
 *
 * CHANGES FROM V3 (addressing new audit finding):
 *
 *   [NEW AUDIT #1 - LOW] PYTHON ENGINE RESPONSE VALIDATION added.
 *     Previously callEngine() result was used directly with no success check.
 *     If the Python process crashed mid-operation it could return:
 *       { success: false, error: "...", schema: undefined }
 *     The Node layer would silently return {} and the frontend would render
 *     an empty schema with no error surfaced to the user.
 *
 *     Fix: detectSchema() now checks result.success explicitly. If false (or
 *     missing), it throws an Error with the engine's error message so the
 *     controller's error handler returns a proper 500 to the client.
 *     result.schema is also validated to be a non-null object before use.
 */

const { callEngine } = require('../services/pythonBridge.service');

/**
 * Detect schema of a file without loading all rows into memory.
 * Delegates to the Python engine's "schema" operation.
 *
 * @param {string} filePath — Absolute path to the file to inspect
 * @returns {Promise<{ schema: Object, sampleRows: Object[] }>}
 * @throws {Error} if the engine returns a failure response
 */
async function detectSchema(filePath) {
  const result = await callEngine({ operation: 'schema', filePath });

  // [NEW AUDIT #1] Validate engine response before using it.
  // A partial crash returns { success: false } with no schema — we must
  // surface this as an error, not silently return an empty schema object.
  if (result.success === false) {
    const engineMsg = result.error || result.message || 'Unknown engine error';
    throw Object.assign(
      new Error(`Schema detection failed: ${engineMsg}`),
      { code: 'ENGINE_SCHEMA_FAILED', status: 500 }
    );
  }

  // Guard against a malformed (but non-false) response where schema is absent
  if (!result.schema || typeof result.schema !== 'object') {
    throw Object.assign(
      new Error('Schema detection returned an unexpected response structure from the engine.'),
      { code: 'ENGINE_SCHEMA_MALFORMED', status: 500 }
    );
  }

  return {
    schema    : result.schema,
    sampleRows: Array.isArray(result.sampleRows) ? result.sampleRows : [],
  };
}

/**
 * Map inferred schema to a simpler display format for the frontend.
 * Pure transform — no I/O, no side-effects.
 *
 * @param {Object} schema — Raw schema object returned by detectSchema()
 * @returns {Array<{ column, type, nullPct, uniqueCount, sample, hasNulls }>}
 */
function formatSchemaForUI(schema) {
  return Object.entries(schema).map(([column, info]) => ({
    column     : column,
    type       : info.type        || 'unknown',
    nullPct    : info.nullPct     || 0,
    uniqueCount: info.uniqueCount || 0,
    sample     : info.sample      || [],
    hasNulls   : (info.nullCount  || 0) > 0,
  }));
}

module.exports = { detectSchema, formatSchemaForUI };
