/**
 * frontend/src/components/procurement/SchemaPreview.jsx  — V2.1
 *
 * Fixes applied:
 * [HIGH-A]   Column limit: renders max 100 columns, shows "+N more" notice to
 *            prevent browser freeze on wide datasets (500+ columns).
 * [MEDIUM-B] Safe sample access: Array.isArray() guard before .slice() so a
 *            non-array sample value from the backend never crashes the render.
 */

import React, { useState } from 'react';
import './ProcurementComponents.css';

// FIX [HIGH-A]: Hard limit on rendered schema rows to prevent browser freeze.
const MAX_VISIBLE_COLUMNS = 100;

const TYPE_CLASS = {
  string : 'type-string',
  integer: 'type-number',
  float  : 'type-number',
  date   : 'type-date',
  unknown: 'type-unknown',
};

function qualityColor(nullPct) {
  if (nullPct > 50) return 'var(--danger)';
  if (nullPct > 20) return 'var(--warning)';
  return 'var(--accent)';
}

export default function SchemaPreview({
  schema      = {},
  columnNames = [],
  sampleRows  = [],
  rowCount    = 0,
  validation,
}) {
  const [expanded,   setExpanded]   = useState(false);
  const [showSample, setShowSample] = useState(false);

  const allColumns = columnNames.length > 0 ? columnNames : Object.keys(schema);
  if (!allColumns.length) return null;

  // FIX [HIGH-A]: Limit rendered columns
  const visibleColumns = allColumns.slice(0, MAX_VISIBLE_COLUMNS);
  const hiddenCount    = allColumns.length - visibleColumns.length;

  return (
    <div className="schema-preview">

      {/* ── Header (always visible) ── */}
      <div className="schema-preview__header" onClick={() => setExpanded(e => !e)}>
        <div className="schema-preview__title-row">
          <span className="schema-preview__title">Schema Preview</span>
          <span className="schema-preview__meta">
            {allColumns.length} column{allColumns.length !== 1 ? 's' : ''} ·{' '}
            {rowCount.toLocaleString()} rows
          </span>
        </div>
        <div className="schema-preview__actions">
          {sampleRows.length > 0 && (
            <button
              className="schema-preview__sample-btn"
              onClick={e => { e.stopPropagation(); setShowSample(s => !s); }}
            >
              {showSample ? 'Hide sample' : 'Show sample rows'}
            </button>
          )}
          <span className="schema-preview__toggle">{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* ── Expandable body ── */}
      {expanded && (
        <div className="schema-preview__body">

          {/* FIX [HIGH-A]: Column count warning */}
          {hiddenCount > 0 && (
            <div className="schema-preview__col-limit-notice">
              Showing first {MAX_VISIBLE_COLUMNS} of {allColumns.length} columns.
              <span className="schema-preview__col-limit-more">+{hiddenCount} more not shown</span>
            </div>
          )}

          <div className="schema-grid">
            <div className="schema-grid__header">
              <span>Column</span>
              <span>Type</span>
              <span>Null %</span>
              <span>Unique</span>
              <span>Sample</span>
            </div>

            {visibleColumns.map(col => {
              const info = schema[col] || {};

              // FIX [MEDIUM-B]: guard against non-array sample values
              const sampleValues = Array.isArray(info.sample)
                ? info.sample.slice(0, 2)
                : [];

              return (
                <div key={col} className="schema-grid__row">
                  <span className="schema-col__name" title={col}>{col}</span>

                  <span className={`schema-col__type ${TYPE_CLASS[info.type] || 'type-unknown'}`}>
                    {info.type || '—'}
                  </span>

                  <span
                    className="schema-col__null"
                    style={{ color: qualityColor(info.nullPct || 0) }}
                  >
                    {info.nullPct !== undefined ? `${info.nullPct}%` : '—'}
                  </span>

                  <span className="schema-col__unique">
                    {info.uniqueCount !== undefined
                      ? info.uniqueCount.toLocaleString()
                      : '—'}
                  </span>

                  <span className="schema-col__sample">
                    {sampleValues.length > 0 ? sampleValues.join(', ') : '—'}
                  </span>
                </div>
              );
            })}
          </div>

          {/* ── Sample rows mini-table ── */}
          {showSample && sampleRows.length > 0 && (
            <div className="schema-sample">
              <div className="schema-sample__label">Sample rows (up to 5)</div>
              <div className="schema-sample__scroll">
                <table className="schema-sample__table">
                  <thead>
                    <tr>
                      {/* Cap table at 8 columns to avoid horizontal overflow */}
                      {visibleColumns.slice(0, 8).map(c => <th key={c}>{c}</th>)}
                      {allColumns.length > 8 && (
                        <th>+{allColumns.length - 8} more</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {sampleRows.slice(0, 5).map((row, i) => (
                      <tr key={i}>
                        {visibleColumns.slice(0, 8).map(c => (
                          <td key={c} title={String(row[c] ?? '')}>
                            {String(row[c] ?? '').slice(0, 24) || '—'}
                          </td>
                        ))}
                        {allColumns.length > 8 && <td>…</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Missing column alert — always visible ── */}
      {validation && !validation.valid && validation.missingGroups?.length > 0 && (
        <div className="schema-preview__missing">
          Missing required columns:{' '}
          <strong>{validation.missingGroups.join(', ')}</strong>
        </div>
      )}
    </div>
  );
}