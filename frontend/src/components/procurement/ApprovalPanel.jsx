import React, { useState } from 'react';
import './ProcurementComponents.css';

/**
 * ApprovalPanel
 * Shows each pending approval as an AI question with quick-pick options.
 */
export default function ApprovalPanel({ approvals = [], onApprove, onReject }) {
  const [customInputs, setCustomInputs] = useState({});

  function setInput(id, val) {
    setCustomInputs(prev => ({ ...prev, [id]: val }));
  }

  return (
    <div className="approval-panel">
      {approvals.map((approval, i) => {
        const question = approval.question;
        const opts     = question?.options || [];
        const qText    = question?.question || question || 'Review required';
        const isPending = approval.status === 'pending';

        return (
          <div
            key={approval.id || i}
            className={`approval-item approval-item--${approval.status}`}
          >
            <div className="approval-item__num">{i + 1}</div>
            <div className="approval-item__body">
              <div className="ai-bubble">
                <div className="ai-bubble__label">AI</div>
                <div className="ai-bubble__text">{qText}</div>
              </div>

              {isPending ? (
                <>
                  {opts.length > 0 && (
                    <div className="quick-opts" style={{ marginBottom: 12 }}>
                      {opts.map(opt => (
                        <button
                          key={opt}
                          className="quick-opt"
                          onClick={() => onApprove(approval.id, opt)}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="approval-input-row">
                    <input
                      className="input"
                      placeholder="Or type your decision…"
                      value={customInputs[approval.id] || ''}
                      onChange={e => setInput(approval.id, e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && customInputs[approval.id]?.trim())
                          onApprove(approval.id, customInputs[approval.id]);
                      }}
                    />
                    <button
                      className="btn-confirm"
                      disabled={!customInputs[approval.id]?.trim()}
                      onClick={() => onApprove(approval.id, customInputs[approval.id])}
                    >
                      Approve
                    </button>
                    <button
                      className="btn-reject"
                      onClick={() => onReject(approval.id, 'Rejected by user')}
                    >
                      Reject
                    </button>
                  </div>
                </>
              ) : (
                <div className="approval-item__decided">
                  <span className={`status-pill status-pill--${approval.status}`}>
                    {approval.status}
                  </span>
                  <span className="approval-item__response">{approval.response}</span>
                  {approval.respondedVia && (
                    <span className="approval-item__via">via {approval.respondedVia}</span>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}