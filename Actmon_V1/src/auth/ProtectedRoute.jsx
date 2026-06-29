import React, { useEffect } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';

// Development mode bypass
const DEV_MODE = import.meta.env.DEV;
const BYPASS_AUTH = import.meta.env.VITE_BYPASS_AUTH === 'true';

export const ProtectedRoute = ({ children, adminOnly = false }) => {
  const { token, user, setToken, setUser } = useAuthStore();
  const location = useLocation();

  // Auto-login in development mode
  useEffect(() => {
    if (DEV_MODE && BYPASS_AUTH && !token) {
      console.log('[DEV] Auto-login: Bypassing authentication');

      // Create a long-lived fake token
      const fakeToken = btoa(JSON.stringify({
        sub: 'admin',
        role: 'Admin',
        exp: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60), // 1 year
      }));

      const fakeUser = {
        id: 1,
        username: 'admin',
        email: 'admin@actmon.local',
        role: 'Admin',
        is_active: true,
        is_superuser: true,
      };

      setToken(fakeToken, fakeUser);
      setUser(fakeUser);
    }
  }, [token, setToken, setUser]);

  // Skip auth check in development bypass mode
  if (DEV_MODE && BYPASS_AUTH) {
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
