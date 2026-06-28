import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider }      from './context/AuthContext';
import { DashboardProvider } from './context/DashboardContext';
import PrivateRoute          from './routes/PrivateRoute';
import LandingPage           from './pages/LandingPage';
import LoginPage             from './pages/LoginPage';
import SignupPage            from './pages/SignupPage';
import DashboardPage         from './pages/DashboardPage';

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
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </DashboardProvider>
    </AuthProvider>
  );
}