/**
 * frontend/src/pages/DashboardPage.jsx  — V3
 *
 * Changes from V2:
 *   - Removed the "Data Cleaning" (general) workspace and the "Select
 *     workspace" picker entirely. Auros is now a single-workspace app
 *     (Invoice Reconciliation), so choosing between workspaces no longer
 *     applies — the picker UI, the whole general-cleaning phase flow
 *     (Upload/Analyze/AI Questions/Preview/Execute/Done), its state, and
 *     its helper functions have all been removed.
 *   - ProcurementWorkspace is now the only thing rendered below the top bar.
 *   - The mode/MODES plumbing (DashboardContext) is left in place — only
 *     its General option and the selector UI were removed — in case a
 *     second workspace is ever added back in the future.
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useDashboard, MODES } from '../context/DashboardContext';
import ProcurementWorkspace from '../components/dashboard/ProcurementWorkspace';
import './DashboardPage.css';

export default function DashboardPage() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { mode } = useDashboard();

  function handleLogout() {
    logout();
    navigate('/');
  }

  return (
    <div className="dashboard">

      {/* ── Top bar ── */}
      <header className="dashboard__topbar">
        <div className="dashboard__brand">auros<span className="dashboard__dot">.</span></div>
        <div className="dashboard__topbar-right">
          <span className="dashboard__user">{user?.name || 'My Workspace'}</span>
          <button className="btn-ghost dashboard__logout" onClick={() => navigate('/billing')}>Billing</button>
          <button className="btn-ghost dashboard__logout" onClick={handleLogout}>Log out</button>
        </div>
      </header>

      <main className="dashboard__main">
        {mode === MODES.PROCUREMENT && (
          <ProcurementWorkspace />
        )}
      </main>
    </div>
  );
}