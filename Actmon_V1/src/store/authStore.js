import { create } from 'zustand';
import { jwtDecode } from 'jwt-decode';

let logoutTimer = null;

export const useAuthStore = create((set, get) => {
  const setupAutoLogout = (token) => {
    if (logoutTimer) {
      clearTimeout(logoutTimer);
      logoutTimer = null;
    }

    try {
      const decoded = jwtDecode(token);
      if (decoded.exp) {
        const expTimeMs = decoded.exp * 1000;
        const now = Date.now();
        // Allow a 5-minute clock skew window before considering it expired immediately.
        // E.g., if client clock is 2 minutes ahead of server clock, expTimeMs - now could be -120000ms.
        // Adding 300000ms (5 mins) keeps it positive so we schedule a timeout rather than clear immediately.
        const timeToExpiryWithSkew = (expTimeMs + 300000) - now;
        const actualTimeToExpiry = expTimeMs - now;

        if (timeToExpiryWithSkew <= 0) {
          console.warn('Token has fully expired (including 5-minute clock skew window). Clearing session.');
          get().clearToken();
        } else {
          // Schedule logout based on actual expiration or a safe positive delay
          const delay = Math.max(1000, actualTimeToExpiry);
          logoutTimer = setTimeout(() => {
            get().clearToken();
            window.location.href = '/login?expired=true';
          }, delay);
        }
      }
    } catch (e) {
      console.warn('Could not decode token for auto-logout scheduling:', e);
      // Do NOT clear token. Let the backend validate it.
    }
  };

  // Run on initial load if token exists in localStorage
  const initialToken = localStorage.getItem('actmon_token');
  if (initialToken) {
    // We defer scheduling to prevent rendering side-effects during import
    setTimeout(() => {
      setupAutoLogout(initialToken);
    }, 0);
  }

  return {
    token: initialToken,
    user: null,
    setToken: (token, user) => {
      localStorage.setItem('actmon_token', token);
      set({ token, user });
      setupAutoLogout(token);
    },
    setUser: (user) => {
      set({ user });
    },
    clearToken: () => {
      localStorage.removeItem('actmon_token');
      set({ token: null, user: null });
      if (logoutTimer) {
        clearTimeout(logoutTimer);
        logoutTimer = null;
      }
    },
    checkTokenExpiry: () => {
      const { token } = get();
      if (!token) return true;
      try {
        const decoded = jwtDecode(token);
        // Allow a 5-minute clock skew window
        if (decoded.exp && (decoded.exp * 1000 + 300000) < Date.now()) {
          console.warn('Token expired beyond 5-minute clock skew window. Clearing session.');
          get().clearToken();
          return true;
        }
        return false;
      } catch (e) {
        console.warn('Could not decode token for expiration check:', e);
        // Do NOT clear token. Assume valid and let the backend validate it.
        return false;
      }
    },
  };
});
