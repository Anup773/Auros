/**
 * hooks/useCopilot.js
 *
 * Connects ProcurementCopilot's onApply callback to the real approval API.
 * Handles optimistic local state updates so the UI responds instantly,
 * with a background API call per item.
 *
 * Usage:
 *   const { ambiguities, handleCopilotApply } = useCopilot({ jobId, initialAmbiguities });
 *
 *   <ProcurementCopilot
 *     ambiguities={ambiguities}
 *     jobId={jobId}
 *     onApply={handleCopilotApply}
 *   />
 */

'use client';

import { useState, useCallback } from 'react';

export function useCopilot({ jobId, initialAmbiguities = [] }) {
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
    const calls = actions.map(({ index, response, respondedVia }) =>
      fetch(`/api/procurement/jobs/${jobId}/approve/${index}`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ response, respondedVia }),
      }).then(async res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { index, ok: true };
      }).catch(err => {
        // Roll back this one item on failure
        setAmbiguities(prev =>
          prev.map((item, i) =>
            i === index ? { ...item, answered: false, response: null, status: null } : item
          )
        );
        console.error(`[useCopilot] Failed to save approval for item ${index + 1}:`, err.message);
        return { index, ok: false };
      })
    );

    await Promise.allSettled(calls);
  }, [jobId]);

  return { ambiguities, setAmbiguities, handleCopilotApply };
}