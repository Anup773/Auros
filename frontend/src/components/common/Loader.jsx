
import React from 'react';
import './Loader.css';

/**
 * Loader
 * @param {boolean} fullscreen - centers in the full viewport
 * @param {string}  message    - optional text below spinner
 * @param {boolean} inline     - small inline spinner (no wrapping)
 */
export default function Loader({ fullscreen = false, message = '', inline = false }) {
  if (inline) {
    return <span className="loader loader--inline" aria-label="Loading" />;
  }

  return (
    <div className={`loader__wrap ${fullscreen ? 'loader__wrap--fullscreen' : ''}`}>
      <span className="loader" aria-label="Loading" />
      {message && <p className="loader__message">{message}</p>}
    </div>
  );
}
