/**
 * frontend/src/components/procurement/IngestionSummary.jsx  — V2.1
 *
 * Fix applied:
 * [MEDIUM]: Deduplicate warnings before rendering.
 *           Backend can emit the same warning string many times (e.g. per bad row).
 *           Showing 400 identical lines is noisy and confusing.
 *           We collapse them to unique strings and show the count if it repeats.
 */

import React, { useState, useMemo } from 'react';
import './ProcurementComponents.css';

export default function IngestionSummary({ warnings = [], title = 'Ingestion Notes' }) {

  // FIX [MEDIUM]: Deduplicate — count occurrences of each unique warning string.
  const deduped = useMemo(() => {
    const counts = new Map();
    for (const w of warnings) {
      const key = String(w).trim();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return Array.from(counts.entries()).map(([msg, count]) => ({ msg, count }));
  }, [warnings]);

  const [expanded, setExpanded] = useState(deduped.length <= 3);

  if (!deduped.length) return null;

  const preview = expanded ? deduped : deduped.slice(0, 3);

  return (
    <div className="ingestion-summary">
      <div className="ingestion-summary__header">
        <span className="ingestion-summary__icon">ℹ</span>
        <span className="ingestion-summary__title">
          {title} ({deduped.length} note{deduped.length !== 1 ? 's' : ''})
        </span>
        {deduped.length > 3 && (
          <button
            className="ingestion-summary__toggle"
            onClick={() => setExpanded(e => !e)}
          >
            {expanded ? 'Show less' : `Show all ${deduped.length}`}
          </button>
        )}
      </div>

      <ul className="ingestion-summary__list">
        {preview.map(({ msg, count }, i) => (
          <li key={i} className="ingestion-summary__item">
            {msg}
            {/* Show repeat count if the same warning fired multiple times */}
            {count > 1 && (
              <span className="ingestion-summary__count"> ×{count}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}