/**
 * Development Auto-Login Component
 *
 * Automatically logs in with admin credentials when BYPASS_AUTH is enabled.
 * This bypasses the login screen in development mode.
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';

const DEV_MODE = import.meta.env.DEV; // Vite development mode
const BYPASS_AUTH = import.meta.env.VITE_BYPASS_AUTH === 'true';

export const DevAutoLogin = ({ children }) => {
  const navigate = useNavigate();
  const { token, setToken } = useAuthStore();

  useEffect(() => {
    // Only auto-login in development mode with bypass enabled
    if (DEV_MODE && BYPASS_AUTH && !token) {
      console.log('[DEV] Auto-login enabled - bypassing authentication');

      // Create a fake token that never expires
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

      // Redirect to dashboard if on login page
      if (window.location.pathname === '/login') {
        navigate('/dashboard', { replace: true });
      }
    }
  }, [token, setToken, navigate]);

  return children;
};
