import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { AUTH_DISABLED } from './devAuthBypass';

export const ProtectedRoute = ({ children, adminOnly = false }) => {
  const { token, user } = useAuthStore();
  const location = useLocation();

  // Dev bypass: render the app without a session. See devAuthBypass.js.
  if (AUTH_DISABLED) {
    return children;
  }

  if (!token) {
    // Redirect to login page and save the state to return back
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (adminOnly && user && user.role !== 'Admin') {
    // Viewer trying to access admin page: show Access Denied page/banner or redirect
    return <Navigate to="/dashboard" replace />;
  }

  return children;
};
