import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider }      from './context/AuthContext';
import { DashboardProvider } from './context/DashboardContext';
import PrivateRoute          from './routes/PrivateRoute';
import LandingPage           from './pages/LandingPage';
import LoginPage             from './pages/LoginPage';
import SignupPage            from './pages/SignupPage';
import DashboardPage         from './pages/DashboardPage';
import BillingPage           from './pages/BillingPage';

export default function App() {
  return (
    <AuthProvider>
      <DashboardProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/"          element={<LandingPage />} />
            <Route path="/login"     element={<LoginPage />} />
            <Route path="/signup"    element={<SignupPage />} />
            <Route path="/dashboard" element={
              <PrivateRoute>
                <DashboardPage />
              </PrivateRoute>
            } />
            {/* BUGFIX: BillingPage.jsx existed as a real, working component
                but had no route pointing to it anywhere in the app — it was
                completely unreachable. Wrapped in PrivateRoute like
                /dashboard since it shows the signed-in user's own
                subscription. */}
            <Route path="/billing" element={
              <PrivateRoute>
                <BillingPage />
              </PrivateRoute>
            } />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </DashboardProvider>
    </AuthProvider>
  );
}
