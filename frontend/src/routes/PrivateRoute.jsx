import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Loader from '../components/common/Loader';

export default function PrivateRoute({ children }) {
  const { isLoggedIn, loading } = useAuth();
  const location = useLocation();

  if (loading) return <Loader fullscreen message="Restoring session…" />;

  if (!isLoggedIn)
    return <Navigate to="/login" state={{ from: location }} replace />;

  return children;
}