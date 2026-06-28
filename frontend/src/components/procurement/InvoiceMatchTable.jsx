import React from 'react';
import './ProcurementComponents.css';

/**
 * InvoiceMatchTable
 * Shows the list of approval decisions made by the user.
 */
export default function InvoiceMatchTable({ approvals = [] }) {
  if (approvals.length === 0) return null;

  return (
    <div className="match-table-wrap">
      <div className="match-table__header">Approval Decisions</div>
      <div className="match-table">
        {approvals.map((approval, i) => (
          <div key={approval.id || i} className={`match-row match-row--${approval.status}`}>
            <div className="match-row__num">{i + 1}</div>
            <div className="match-row__content">
              <div className="match-row__question">
                {approval.question?.question || 'Approval item'}
              </div>
              <div className="match-row__response">
                {approval.response || '—'}
              </div>
            </div>
            <div className="match-row__meta">
              <span className={`status-pill status-pill--${approval.status}`}>
                {approval.status}
              </span>
              {approval.respondedVia && (
                <span className="match-row__via">via {approval.respondedVia}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}