import React from 'react';
import './ErrorMessage.css';

/**
 * ErrorMessage
 * @param {string}   message  - the error text to display
 * @param {function} onRetry  - optional retry callback, shows a Retry button
 * @param {boolean}  inline   - smaller inline style (no box)
 */
export default function ErrorMessage({ message, onRetry, inline = false }) {
  if (!message) return null;

  if (inline) {
    return <span className="error-msg error-msg--inline">⚠ {message}</span>;
  }

  return (
    <div className="error-msg__box" role="alert">
      <span className="error-msg__icon">⚠</span>
      <span className="error-msg__text">{message}</span>
      {onRetry && (
        <button className="error-msg__retry" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
