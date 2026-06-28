import React, { useState } from 'react';
import './ProcurementComponents.css';

export default function DuplicateInvoiceAlert({ groups = [] }) {
  const [expanded, setExpanded] = useState(false);

  if (groups.length === 0) return null;

  return (
    <div className="dup-alert">
      <div className="dup-alert__header" onClick={() => setExpanded(e => !e)}>
        <span className="dup-alert__icon">⚠</span>
        <div className="dup-alert__info">
          <div className="dup-alert__title">
            {groups.length} duplicate invoice group{groups.length > 1 ? 's' : ''} detected
          </div>
          <div className="dup-alert__sub">
            These will be included in the approval queue below
          </div>
        </div>
        <span className="dup-alert__toggle">{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div className="dup-alert__groups">
          {groups.map((g, i) => (
            <div key={i} className={`dup-group dup-group--${g.severity.toLowerCase()}`}>
              <div className="dup-group__type">{g.type.replace(/_/g, ' ')}</div>
              <div className="dup-group__msg">{g.message}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}