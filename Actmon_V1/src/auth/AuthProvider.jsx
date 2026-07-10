import React, { createContext, useEffect, useState } from 'react';
import { useAuthStore } from '../store/authStore';
import { getMe, getMenu, getPermissions } from '../api/auth';
import { Spinner } from '@fluentui/react-components';

// DEVELOPMENT: Set to true to bypass authentication (DEV ONLY - REMOVE IN PRODUCTION)
const DEV_BYPASS_AUTH = true;

export const AuthContext = createContext({ isLoading: true });

export const AuthProvider = ({ children }) => {
  const { token, setUser, setAccess, checkTokenExpiry } = useAuthStore();
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const initAuth = async () => {
      // Development bypass - skip all auth checks
      if (DEV_BYPASS_AUTH) {
        setIsLoading(false);
        return;
      }

      if (!token) { setIsLoading(false); return; }
      if (checkTokenExpiry()) { setIsLoading(false); return; }
      try {
        // Rehydrate profile + RBAC (menu/permissions) from the DB on reload.
        const [profile, menu, perms] = await Promise.all([
          getMe(),
          getMenu().catch(() => null),
          getPermissions().catch(() => null),
        ]);
        setUser(profile);
        setAccess({
          menu: menu || undefined,
          permissions: perms?.permissions,
          permission_catalog: perms?.permission_catalog,
          governed_urls: perms?.governed_urls,
        });
      } catch (err) {
        console.error('Failed to load session:', err);
      } finally {
        setIsLoading(false);
      }
    };
    initAuth();
  }, [token, setUser, setAccess, checkTokenExpiry]);

  if (isLoading) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-[#F3F2F1]">
        <Spinner size="huge" label="Loading application..." />
      </div>
    );
  }
  return <AuthContext.Provider value={{ isLoading }}>{children}</AuthContext.Provider>;
};
