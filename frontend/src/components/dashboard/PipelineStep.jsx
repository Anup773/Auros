import React from 'react';
import './DashboardComponents.css';

const STATUS_LABEL = {
  staged:    'Pending confirm',
  confirmed: '✓ Confirmed',
  executed:  '✓ Executed',
  rejected:  '✗ Rejected',
};

/**
 * PipelineStep
 * @param {Object}   step        - pipeline step object
 * @param {number}   index       - step number (1-based display)
 * @param {boolean}  showActions - show confirm/reject buttons
 * @param {function} onConfirm   - called when user confirms
 * @param {function} onReject    - called when user rejects
 */
export default function PipelineStep({ step, index, showActions = false, onConfirm, onReject }) {
  return (
    <div className={`pipeline-step pipeline-step--${step.status}`}>
      <span className="pipeline-step__num">{index}</span>
      <div className="pipeline-step__info">
        <div className="pipeline-step__name">{step.action || step.type}</div>
        {step.explanation && (
          <div className="pipeline-step__explanation">{step.explanation}</div>
        )}
      </div>
      {showActions ? (
        <div className="pipeline-step__actions">
          <button className="btn-confirm btn-confirm--small" onClick={onConfirm}>Confirm</button>
          <button className="btn-reject btn-reject--small"   onClick={onReject}>Reject</button>
        </div>
      ) : (
        <span className="pipeline-step__check">
          {STATUS_LABEL[step.status] || step.status}
        </span>
      )}
    </div>
  );
}