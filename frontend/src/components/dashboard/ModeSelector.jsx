import React from 'react';
import { useDashboard, MODES } from '../../context/DashboardContext';
import './ModeSelector.css';

const MODES_CONFIG = [
  {
    id      : MODES.GENERAL,
    icon    : '⬆',
    label   : 'Data Cleaning',
    desc    : 'Upload any CSV or Excel. AI detects issues, asks questions, and cleans data with your approval.',
    badge   : null,
  },
  {
    id      : MODES.PROCUREMENT,
    icon    : '📋',
    label   : 'Invoice Reconciliation',
    desc    : 'Upload invoices and PO exports. AI matches records, flags duplicates, and routes approvals.',
    badge   : 'New',
  },
];

export default function ModeSelector() {
  const { mode, setMode } = useDashboard();

  return (
    <div className="mode-selector">
      <div className="mode-selector__label">Select workspace</div>
      <div className="mode-selector__grid">
        {MODES_CONFIG.map(m => (
          <button
            key={m.id}
            className={`mode-card ${mode === m.id ? 'mode-card--active' : ''}`}
            onClick={() => setMode(m.id)}
          >
            {m.badge && <span className="mode-card__badge">{m.badge}</span>}
            <div className="mode-card__icon">{m.icon}</div>
            <div className="mode-card__label">{m.label}</div>
            <div className="mode-card__desc">{m.desc}</div>
          </button>
        ))}
      </div>
    </div>
  );
}