import React from 'react';
import './DashboardComponents.css';

/**
 * AIBubble
 * @param {string} question    - the AI question text
 * @param {Array}  options     - quick-pick option strings
 * @param {function} onSelect  - called with the selected option string
 */
export default function AIBubble({ question, options = [], onSelect }) {
  return (
    <div className="ai-bubble-wrap">
      <div className="ai-bubble">
        <div className="ai-bubble__label">AI</div>
        <div className="ai-bubble__text">{question}</div>
      </div>
      {options.length > 0 && (
        <div className="quick-opts">
          {options.map(opt => (
            <button
              key={opt}
              className="quick-opt"
              onClick={() => onSelect && onSelect(opt)}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}