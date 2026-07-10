import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';

// DEVELOPMENT: Set to true to bypass login (DEV ONLY - REMOVE IN PRODUCTION)
const DEV_BYPASS_AUTH = true;

export const ProtectedRoute = ({ children, adminOnly = false }) => {
  const { token, user } = useAuthStore();
  const location = useLocation();

  // Development bypass - skip authentication check
  if (DEV_BYPASS_AUTH) {
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
