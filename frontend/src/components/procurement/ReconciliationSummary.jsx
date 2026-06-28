import React from 'react';
import './ProcurementComponents.css';

export default function ReconciliationSummary({ summary }) {
  if (!summary) return null;

  const stats = [
    { label: 'Total Invoices',  value: summary.total,         color: 'neutral' },
    { label: 'Matched',         value: summary.matched,       color: 'green' },
    { label: 'Flagged',         value: summary.flagged,       color: 'yellow' },
    { label: 'Duplicates',      value: summary.duplicates,    color: 'red' },
    { label: 'Need Approval',   value: summary.ambiguities,   color: 'yellow' },
  ];

  return (
    <div className="rec-summary">
      <div className="rec-summary__title">Reconciliation Analysis</div>
      <div className="rec-summary__grid">
        {stats.map(s => (
          <div key={s.label} className={`rec-stat rec-stat--${s.color}`}>
            <span className="rec-stat__val">{s.value ?? 0}</span>
            <span className="rec-stat__label">{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}