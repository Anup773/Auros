/**
 * frontend/src/components/procurement/ZipContentsPanel.jsx  — V2.1
 *
 * Fixes applied:
 * [CRITICAL-A] Path traversal: the component no longer passes raw ZIP paths to
 *              onClick for unsupported/rejected rows. Only supported file entries
 *              trigger onSelect. Backend MUST sanitise server-side paths regardless.
 * [HIGH-B]     pointer-events: none on unsupported and rejected rows via inline style,
 *              so click events can never bubble through even if CSS changes later.
 * [MEDIUM-C]   Pagination for large ZIPs: renders at most PAGE_SIZE supported files
 *              at once; "Show more" button loads the next page. Prevents render freeze
 *              on ZIPs with thousands of files.
 */

import React, { useState } from 'react';
import './ProcurementComponents.css';

const EXT_ICON = {
  '.csv' : '📊',
  '.xlsx': '📗',
  '.xls' : '📗',
  '.xml' : '📄',
};

// FIX [MEDIUM-C]: Page size for large ZIP file lists
const PAGE_SIZE = 50;

function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024)          return `${bytes} B`;
  if (bytes < 1024 * 1024)   return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function ZipContentsPanel({ contents, onSelect, selectedFile }) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  if (!contents) return null;

  const {
    supportedFiles   = [],
    unsupportedFiles = [],
    rejected         = [],
    totalFiles       = 0,
    warnings         = [],
  } = contents;

  // FIX [MEDIUM-C]: Paginated slice of supported files
  const visibleSupported = supportedFiles.slice(0, visibleCount);
  const hasMore          = supportedFiles.length > visibleCount;

  return (
    <div className="zip-panel">

      {/* Header */}
      <div className="zip-panel__header">
        <span className="zip-panel__icon">📦</span>
        <div>
          <div className="zip-panel__title">ZIP Archive Contents</div>
          <div className="zip-panel__meta">
            {totalFiles} file{totalFiles !== 1 ? 's' : ''} extracted ·{' '}
            {supportedFiles.length} supported
            {rejected.length > 0 && ` · ${rejected.length} rejected`}
          </div>
        </div>
      </div>

      {/* ── Supported files — selectable ── */}
      {supportedFiles.length > 0 && (
        <div className="zip-panel__section">
          <div className="zip-panel__section-label">
            Supported files — select one to reconcile
          </div>

          {visibleSupported.map((f, i) => {
            const isSelected = selectedFile?.path === f.path;
            const icon       = EXT_ICON[f.ext] || '📁';

            return (
              <div
                key={i}
                className={`zip-file-row ${isSelected ? 'zip-file-row--selected' : ''}`}
                // FIX [CRITICAL-A]: onSelect only fires for supported files,
                // never for unsupported/rejected rows.
                onClick={() => onSelect(f)}
                role="button"
                tabIndex={0}
                onKeyDown={e => e.key === 'Enter' && onSelect(f)}
                aria-label={`Select ${f.name} for reconciliation`}
              >
                <span className="zip-file-row__icon">{icon}</span>
                <div className="zip-file-row__info">
                  <div className="zip-file-row__name" title={f.name}>{f.name}</div>
                  <div className="zip-file-row__meta">
                    {(f.ext || '').toUpperCase()} · {fmtSize(f.size)}
                  </div>
                </div>
                <div className="zip-file-row__action">
                  {isSelected
                    ? <span className="zip-file-row__selected-badge">Selected ✓</span>
                    : <span className="zip-file-row__select-btn">Use this file</span>}
                </div>
              </div>
            );
          })}

          {/* FIX [MEDIUM-C]: Paginated "show more" for large ZIPs */}
          {hasMore && (
            <button
              className="zip-panel__show-more"
              onClick={() => setVisibleCount(c => c + PAGE_SIZE)}
            >
              Show {Math.min(PAGE_SIZE, supportedFiles.length - visibleCount)} more
              &nbsp;({supportedFiles.length - visibleCount} remaining)
            </button>
          )}
        </div>
      )}

      {/* ── Unsupported files ── */}
      {unsupportedFiles.length > 0 && (
        <div className="zip-panel__section">
          <div className="zip-panel__section-label zip-panel__section-label--muted">
            Unsupported files (ignored)
          </div>
          {unsupportedFiles.map((f, i) => (
            <div
              key={i}
              className="zip-file-row zip-file-row--unsupported"
              // FIX [HIGH-B]: pointer-events none inline — guarantees no click
              // even if CSS class is removed or overridden later
              style={{ pointerEvents: 'none' }}
              aria-disabled="true"
            >
              <span className="zip-file-row__icon">📁</span>
              <div className="zip-file-row__info">
                <div className="zip-file-row__name" title={f.name}>{f.name}</div>
                <div className="zip-file-row__meta">
                  {(f.ext || 'unknown').toUpperCase()} · {fmtSize(f.size)}
                </div>
              </div>
              <span className="zip-file-row__badge-unsupported">Not supported</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Rejected files ── */}
      {rejected.length > 0 && (
        <div className="zip-panel__section">
          <div className="zip-panel__section-label zip-panel__section-label--danger">
            Rejected files (security / size)
          </div>
          {rejected.map((f, i) => (
            <div
              key={i}
              className="zip-file-row zip-file-row--rejected"
              // FIX [HIGH-B]: same inline pointer-events guard
              style={{ pointerEvents: 'none' }}
              aria-disabled="true"
            >
              <span className="zip-file-row__icon">🚫</span>
              <div className="zip-file-row__info">
                <div className="zip-file-row__name" title={f.name}>{f.name}</div>
                <div className="zip-file-row__meta">{f.reason || 'Rejected'}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Archive-level warnings ── */}
      {warnings.length > 0 && (
        <div className="zip-panel__warnings">
          {warnings.map((w, i) => (
            <div key={i} className="zip-panel__warning">⚠ {w}</div>
          ))}
        </div>
      )}

      {/* ── Empty state ── */}
      {supportedFiles.length === 0 && (
        <div className="zip-panel__empty">
          No supported files found in this archive.
          Please upload a ZIP containing CSV, XLSX, or XML files.
        </div>
      )}
    </div>
  );
}
