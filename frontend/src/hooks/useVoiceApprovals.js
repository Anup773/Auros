/**
 * frontend/src/hooks/useVoiceApprovals.js
 *
 * Converts structured voice actions (from VoiceCommandButton) into
 * actual approval API calls and returns feedback to the UI.
 *
 * Usage:
 *   const { applyVoiceActions, voiceResult } = useVoiceApprovals({
 *     jobId,
 *     ambiguities,       // array of ambiguity objects from reconciliation
 *     onItemApproved,    // callback(index, response) — update local state
 *   });
 *
 *   // Wire to VoiceCommandButton:
 *   <VoiceCommandButton totalItems={ambiguities.length} onActions={applyVoiceActions} />
 */

import { useState, useCallback } from 'react';

// Map voice action → approval response string (must match backend options)
const ACTION_TO_RESPONSE = {
  approve    : 'Approve for payment',
  reject     : 'Reject invoice',
  hold       : 'Hold for review',
  request_po : 'Request PO number from vendor',
};

export function useVoiceApprovals({ jobId, ambiguities = [], onItemApproved }) {
  const [voiceResult, setVoiceResult] = useState(null);
  // { applied: number, failed: number, skipped: number, details: string[] }

  const applyVoiceActions = useCallback(async (actions) => {
    if (!actions || actions.length === 0) return;

    let applied = 0, failed = 0, skipped = 0;
    const details = [];

    for (const { action, indices } of actions) {
      const response = ACTION_TO_RESPONSE[action];
      if (!response) { skipped += indices.length; continue; }

      for (const idx of indices) {
        const ambiguity = ambiguities[idx];
        if (!ambiguity) { skipped++; continue; }

        // Skip already-answered items
        if (ambiguity.answered) { skipped++; continue; }

        try {
          await fetch(`/api/procurement/jobs/${jobId}/approve/${idx}`, {
            method : 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              response,
              respondedVia: 'voice',
            }),
          });

          applied++;
          if (onItemApproved) onItemApproved(idx, response);
        } catch (err) {
          failed++;
          details.push(`Item #${idx + 1}: ${err.message}`);
        }
      }
    }

    setVoiceResult({ applied, failed, skipped, details });

    // Auto-clear after 5 seconds
    setTimeout(() => setVoiceResult(null), 5000);
  }, [jobId, ambiguities, onItemApproved]);

  return { applyVoiceActions, voiceResult };
}