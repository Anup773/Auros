import React from 'react';
import './DashboardComponents.css';

const SEVERITY_COLOR = { High: '#ff5f5f', Medium: '#ffb347', Low: '#7fff6e' };

/**
 * IssueList
 * @param {Array} issues - array of issue objects from dataAnalyzer
 */
export default function IssueList({ issues = [] }) {
  if (issues.length === 0) {
    return (
      <div className="issue-list issue-list--empty">
        No issues detected — your dataset looks clean!
      </div>
    );
  }

  return (
    <div className="issue-list">
      {issues.map((issue, i) => (
        <div className="issue-item" key={i}>
          <span
            className="issue-item__dot"
            style={{ background: SEVERITY_COLOR[issue.severity] || '#888' }}
          />
          <div className="issue-item__content">
            <div className="issue-item__title">
              {issue.column
                ? <><strong>{issue.column}</strong> — {issue.type}</>
                : <>{issue.type}</>
              }
            </div>
            <div className="issue-item__detail">{issue.detail}</div>
          </div>
          <span className={`issue-item__badge severity-${(issue.severity || '').toLowerCase()}`}>
            {issue.severity}
          </span>
        </div>
      ))}
    </div>
  );
}