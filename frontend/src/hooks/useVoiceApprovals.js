/**
 * frontend/src/hooks/useVoiceApprovals.js
 *
 * Converts structured voice actions (from VoiceCommandButton) into
 * actual approval API calls and returns feedback to the UI.
 *
 * NOT CURRENTLY WIRED INTO ANY PAGE — VoiceCommandButton.jsx (its intended
 * partner) is also unused; ProcurementCopilot.jsx handles voice on its own
 * instead. Fixed below in case this pair gets wired up later:
 *
 *   BUG 1: fetch('/api/procurement/jobs/${jobId}/approve/${idx}') — wrong
 *          URL, same "jobs/" segment that doesn't exist on the real route.
 *   BUG 2: sent the raw array index instead of the real approval id.
 *   BUG 3: no Authorization header attached.
 *   BUG 4: no res.ok check — fetch() only rejects on a network failure, not
 *          on an HTTP error status. A 404/500/expired-session response was
 *          being silently counted as a successful approval.
 *   FIX:   delegate to procurementAPI.approveItem() (services/api.js), which
 *          already has the correct URL, ID handling, auth header, and throws
 *          on a bad response — fixes all four at once.
 *
 * Usage:
 *   const { applyVoiceActions, voiceResult } = useVoiceApprovals({
 *     jobId, token,
 *     ambiguities,       // array of ambiguity objects from reconciliation
 *     onItemApproved,    // callback(index, response) — update local state
 *   });
 *
 *   // Wire to VoiceCommandButton:
 *   <VoiceCommandButton totalItems={ambiguities.length} onActions={applyVoiceActions} />
 */

import { useState, useCallback } from 'react';
import { procurementAPI } from '../services/api';

// Map voice action → approval response string (must match backend options)
const ACTION_TO_RESPONSE = {
  approve    : 'Approve for payment',
  reject     : 'Reject invoice',
  hold       : 'Hold for review',
  request_po : 'Request PO number from vendor',
};

export function useVoiceApprovals({ jobId, token, ambiguities = [], onItemApproved }) {
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

        const approvalId = ambiguity.id ?? idx;
        try {
          await procurementAPI.approveItem(jobId, approvalId, response, token);
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
  }, [jobId, token, ambiguities, onItemApproved]);

  return { applyVoiceActions, voiceResult };
}