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

  const readJSON = (k, fb) => { try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch { return fb; } };

  return {
    token: initialToken,
    user: null,
    // ── RBAC state (persisted for reloads) ──
    menu: readJSON('actmon_menu', []),
    permissions: readJSON('actmon_perms', []),
    permissionCatalog: readJSON('actmon_perm_catalog', []),
    governedUrls: readJSON('actmon_governed', []),

    setToken: (token, user) => {
      localStorage.setItem('actmon_token', token);
      set({ token, user });
      setupAutoLogout(token);
    },
    setUser: (user) => set({ user }),

    /** Store the full login payload (token + user + role + menu + permissions). */
    setAuth: (token, payload = {}) => {
      const { user, role, menu = [], permissions = [], permission_catalog = [], governed_urls = [] } = payload;
      const mergedUser = { ...(user || {}), role: role?.role_name, role_id: role?.role_id, role_obj: role };
      localStorage.setItem('actmon_token', token);
      localStorage.setItem('actmon_menu', JSON.stringify(menu));
      localStorage.setItem('actmon_perms', JSON.stringify(permissions));
      localStorage.setItem('actmon_perm_catalog', JSON.stringify(permission_catalog));
      localStorage.setItem('actmon_governed', JSON.stringify(governed_urls));
      set({ token, user: mergedUser, menu, permissions, permissionCatalog: permission_catalog, governedUrls: governed_urls });
      setupAutoLogout(token);
    },

    /** Refresh just the RBAC data (menu/permissions) without touching the token. */
    setAccess: ({ menu, permissions, permission_catalog, governed_urls }) => {
      const patch = {};
      if (menu) { patch.menu = menu; localStorage.setItem('actmon_menu', JSON.stringify(menu)); }
      if (permissions) { patch.permissions = permissions; localStorage.setItem('actmon_perms', JSON.stringify(permissions)); }
      if (permission_catalog) { patch.permissionCatalog = permission_catalog; localStorage.setItem('actmon_perm_catalog', JSON.stringify(permission_catalog)); }
      if (governed_urls) { patch.governedUrls = governed_urls; localStorage.setItem('actmon_governed', JSON.stringify(governed_urls)); }
      set(patch);
    },

    clearToken: () => {
      ['actmon_token', 'actmon_menu', 'actmon_perms', 'actmon_perm_catalog', 'actmon_governed'].forEach((k) => localStorage.removeItem(k));
      set({ token: null, user: null, menu: [], permissions: [], permissionCatalog: [], governedUrls: [] });
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
