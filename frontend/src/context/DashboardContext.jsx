import React, { createContext, useContext, useState } from 'react';

/**
 * DashboardContext
 * Manages which mode the dashboard is in:
 *   - 'general'     : General AI data cleaning
 *   - 'procurement' : Invoice reconciliation
 */
const DashboardContext = createContext(null);

export const MODES = {
  GENERAL     : 'general',
  PROCUREMENT : 'procurement',
};

export function DashboardProvider({ children }) {
  const [mode, setMode] = useState(MODES.GENERAL);

  return (
    <DashboardContext.Provider value={{ mode, setMode, MODES }}>
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboard() {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error('useDashboard must be used inside <DashboardProvider>');
  return ctx;
}