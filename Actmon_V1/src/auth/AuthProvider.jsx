import React, { createContext, useEffect, useState } from 'react';
import { useAuthStore } from '../store/authStore';
import { getMe } from '../api/auth';
import { Spinner } from '@fluentui/react-components';
import { jwtDecode } from 'jwt-decode';

export const AuthContext = createContext({ isLoading: true });

export const AuthProvider = ({ children }) => {
  const { token, clearToken, setUser, checkTokenExpiry } = useAuthStore();
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const initAuth = async () => {
      if (!token) {
        setIsLoading(false);
        return;
      }

      // Check if expired
      const isExpired = checkTokenExpiry();
      if (isExpired) {
        setIsLoading(false);
        return;
      }

      try {
        const user = await getMe();
        setUser(user);
      } catch (err) {
        console.error('Failed to load current user:', err);
        // If the token was removed (e.g. by 401 interceptor), don't set fallback
        if (!localStorage.getItem('actmon_token')) {
          return;
        }

        // Construct fallback user profile from token if possible, or use default
        let fallbackUser = {
          id: 0,
          username: 'User',
          email: 'user@actmon.local',
          role: 'Viewer',
          is_active: true,
          is_superuser: false,
        };

        try {
          const decoded = jwtDecode(token);
          const username = decoded.sub || decoded.username || 'User';
          const role = decoded.role || 'Viewer';
          fallbackUser = {
            id: 0,
            username,
            email: `${username}@actmon.local`,
            role,
            is_active: true,
            is_superuser: role === 'Admin',
          };
        } catch (e) {
          console.warn('Could not decode token for fallback user details:', e);
        }

        setUser(fallbackUser);
      } finally {
        setIsLoading(false);
      }
    };

    initAuth();
  }, [token, setUser, clearToken, checkTokenExpiry]);

  if (isLoading) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-[#F3F2F1]">
        <Spinner size="huge" label="Loading application..." />
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ isLoading }}>
      {children}
    </AuthContext.Provider>
  );
};
