'use strict';
/**
 * backend/models/decisionLog.model.js
 *
 * CHANGES FROM V1 (this version):
 *
 *   FIX 1 — Event validated against known values (Low Risk from audit)
 *     Previous: createLogEntry("RANDOM") or createLogEntry(null) accepted silently.
 *     Fix: VALID_EVENTS set. Unknown events are accepted but logged as warnings
 *     (not thrown — logging must never crash the pipeline).
 *
 *   FIX 2 — Payload size cap (Medium Risk from audit)
 *     Previous: payload could contain entire datasets or millions of rows,
 *     making the audit log a memory bomb.
 *     Fix: payload is shallow-cloned and any array field is capped at
 *     MAX_PAYLOAD_ARRAY_LENGTH items. Large string values are truncated.
 *     Only references/IDs should be stored in logs, never raw data.
 *
 *   FIX 3 — Circular reference guard (Medium Risk from audit)
 *     Previous: payload.pipeline = pipeline → JSON.stringify(log) crash.
 *     Fix: Safe serialization test at creation time. If payload has circular
 *     references, store a sanitized summary instead of crashing.
 */

const VALID_EVENTS = new Set([
  'STEP_STAGED',
  'STEP_CONFIRMED',
  'STEP_REJECTED',
  'STEP_EXECUTED',
  'EXECUTION_STARTED',
  'EXECUTION_COMPLETE',
  'EXECUTION_FAILED',
  'PIPELINE_CREATED',
  'PIPELINE_RESET',
  'AMBIGUITY_RESOLVED',
  'AI_QUESTION_GENERATED',
  'AI_INTERPRETATION',
]);

const MAX_PAYLOAD_ARRAY_LENGTH = 10;   // never log full row arrays
const MAX_PAYLOAD_STRING_LENGTH = 500; // truncate large string values

function createLogEntry(event, payload = {}) {
  // FIX 1: Validate event
  if (!VALID_EVENTS.has(event)) {
    console.warn(`[decisionLog] Unknown event type: "${event}". Consider adding to VALID_EVENTS.`);
  }

  // FIX 2+3: Sanitize payload — cap arrays, truncate strings, guard circular refs
  const safePayload = _sanitizePayload(payload);

  return {
    event,
    timestamp: new Date().toISOString(),
    stepIndex: payload?.stepIndex ?? null,
    stepType : payload?.stepType  ?? null,
    payload  : safePayload,
  };
}

function _sanitizePayload(payload) {
  if (!payload || typeof payload !== 'object') return payload || {};

  // FIX 3: Test for circular references first
  try {
    JSON.stringify(payload);
  } catch (_) {
    // Circular reference detected — store a safe summary instead
    return {
      _sanitized: true,
      _reason   : 'Circular reference detected in original payload',
      stepIndex : payload.stepIndex ?? null,
      stepType  : payload.stepType  ?? null,
    };
  }

  // FIX 2: Shallow clone and cap oversized fields
  const safe = {};
  for (const [key, val] of Object.entries(payload)) {
    if (Array.isArray(val)) {
      // Cap arrays — never store full row arrays in logs
      safe[key] = val.length > MAX_PAYLOAD_ARRAY_LENGTH
        ? [...val.slice(0, MAX_PAYLOAD_ARRAY_LENGTH), `...and ${val.length - MAX_PAYLOAD_ARRAY_LENGTH} more`]
        : val;
    } else if (typeof val === 'string' && val.length > MAX_PAYLOAD_STRING_LENGTH) {
      // Truncate large strings
      safe[key] = val.slice(0, MAX_PAYLOAD_STRING_LENGTH) + `…[truncated ${val.length} chars]`;
    } else {
      safe[key] = val;
    }
  }
  return safe;
}

module.exports = { createLogEntry, VALID_EVENTS };
