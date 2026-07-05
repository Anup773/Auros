/**
 * hooks/useCopilot.js
 *
 * Connects ProcurementCopilot's onApply callback to the real approval API.
 * Handles optimistic local state updates so the UI responds instantly,
 * with a background API call per item.
 *
 * NOT CURRENTLY WIRED INTO ANY PAGE. ProcurementWorkspace.jsx has its own
 * working handleCopilotApply implemented inline instead of using this hook.
 * This file is kept as a reusable version of that same logic for any future
 * page that needs it — fixed below so it actually works if that happens:
 *
 *   BUG 1: fetch('/api/procurement/jobs/${jobId}/approve/${index}') — that
 *          route does not exist. The real route has no "jobs/" segment:
 *          /api/procurement/:jobId/approve/:approvalId
 *   BUG 2: sent the raw array index as the approval ID. The backend expects
 *          the real approval id (e.g. "appr_<jobId>_<i>"), not a position.
 *   BUG 3: no Authorization header — every call would fail auth.
 *   FIX:   delegate to procurementAPI.approveItem() (services/api.js),
 *          which already has the correct URL, ID handling, and auth header,
 *          tested and confirmed working. Avoids keeping two separate copies
 *          of the same API contract that can drift apart.
 *
 * Usage:
 *   const { ambiguities, handleCopilotApply } = useCopilot({ jobId, token, initialAmbiguities });
 *
 *   <ProcurementCopilot
 *     ambiguities={ambiguities}
 *     jobId={jobId}
 *     onApply={handleCopilotApply}
 *   />
 */

import { useState, useCallback } from 'react';
import { procurementAPI } from '../services/api';

export function useCopilot({ jobId, token, initialAmbiguities = [] }) {
  const [ambiguities, setAmbiguities] = useState(initialAmbiguities);

  /**
   * Receives an array of { index, response, respondedVia } from the copilot,
   * optimistically marks them as answered in local state, then fires API calls.
   *
   * @param {{ index: number, response: string, respondedVia: string }[]} actions
   */
  const handleCopilotApply = useCallback(async (actions) => {
    if (!actions || actions.length === 0) return;

    // ── 1. Optimistic update ────────────────────────────────────────────────
    setAmbiguities(prev =>
      prev.map((item, i) => {
        const match = actions.find(a => a.index === i);
        if (!match) return item;
        return {
          ...item,
          answered    : true,
          response    : match.response,
          respondedVia: match.respondedVia,
          status      : 'approved',
        };
      })
    );

    // ── 2. Fire API calls (batched, non-blocking) ───────────────────────────
    const calls = actions.map(({ index, response }) => {
      const approvalId = ambiguities[index]?.id ?? index;
      return procurementAPI.approveItem(jobId, approvalId, response, token)
        .then(() => ({ index, ok: true }))
        .catch(err => {
          // Roll back this one item on failure
          setAmbiguities(prev =>
            prev.map((item, i) =>
              i === index ? { ...item, answered: false, response: null, status: null } : item
            )
          );
          console.error(`[useCopilot] Failed to save approval for item ${index + 1}:`, err.message);
          return { index, ok: false };
        });
    });

    await Promise.allSettled(calls);
  }, [jobId, token, ambiguities]);

  return { ambiguities, setAmbiguities, handleCopilotApply };
}
