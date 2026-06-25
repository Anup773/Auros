'use strict';
/**
 * backend/services/pipeline/pipelineBuilder.service.js
 *
 * CHANGES FROM V1 (this version):
 *
 *   FIX 1 — Invalid action silently accepted (Bug #1)
 *     Previous: action.action || 'custom' accepted any string including
 *     "xyz123" or "DROP_DATABASE". Executor would skip unknown actions
 *     with no error — silent failure.
 *     Fix: Validate action against INTERNAL_ACTIONS before building step.
 *     Unknown actions throw a descriptive error caught by the controller.
 *
 *   FIX 2 — Confidence 0 incorrectly overridden to 80 (Bug #2)
 *     Previous: confidence || 80 — JavaScript's || treats 0 as falsy,
 *     so a legitimate confidence:0 (very uncertain action) became 80.
 *     Fix: confidence ?? 80 — nullish coalescing only replaces null/undefined.
 *
 *   FIX 3 — Risk fallback masks invalid values (Bug #3)
 *     Previous: risk || 'Low' masked invalid risk values (e.g. "EXTREME").
 *     Fix: Validate risk against allowed set; default to 'Medium' (not 'Low')
 *     when missing — unknown risk should not be assumed safe.
 */

const { INTERNAL_ACTIONS } = require('../ai/responseParser');

const VALID_RISKS = new Set(['Low', 'Medium', 'High']);

/**
 * Build a pipeline step from a validated AI action.
 *
 * @param {Object} action — validated action from AI or built-in fallback
 * @returns {Object} pipeline step
 * @throws {Error} if action type is not recognized
 */
function buildStep(action) {
  // FIX 1: Validate action before building step — don't silently accept unknowns
  if (!action || !action.action) {
    throw Object.assign(
      new Error('Cannot build pipeline step: action object is missing or has no action field'),
      { status: 422, code: 'INVALID_ACTION' }
    );
  }

  if (!INTERNAL_ACTIONS.has(action.action)) {
    throw Object.assign(
      new Error(`Cannot build pipeline step: unknown action "${action.action}". Allowed: ${[...INTERNAL_ACTIONS].join(', ')}`),
      { status: 422, code: 'UNKNOWN_ACTION' }
    );
  }

  // FIX 3: Validate risk value; default to 'Medium' for unknown risk (safer than 'Low')
  const risk = VALID_RISKS.has(action.risk) ? action.risk : 'Medium';

  return {
    action     : action.action,
    type       : action.action,            // alias for compatibility
    column     : action.column     || null,
    parameters : action.parameters || {},
    // FIX 2: ?? not || so confidence:0 is preserved
    confidence : action.confidence ?? 80,
    risk,
    explanation: action.explanation || '',
    isDestructive: action.isDestructive || false,
    status     : 'pending',
    addedAt    : new Date().toISOString(),
    confirmedAt: null,
  };
}

module.exports = { buildStep };