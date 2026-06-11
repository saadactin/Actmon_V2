import { useState } from 'react';
import { useAuthStore } from '../store/authStore';
import { login as apiLogin, getMe } from '../api/auth';

export const useAuth = () => {
  const { token, user, setToken, clearToken } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const login = async (username, password) => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiLogin(username, password);
      
      // Store token and temporary profile
      // In FastAPI OAuth2, the login response contains token, role, etc.
      // We also do a follow-up request or construct MeResponse from token details.
      // To ensure we get the full database representation (e.g. email, status), we can make a direct call to getMe()
      // using the token we just received (by temporarily saving it or passing it)
      localStorage.setItem('actmon_token', response.access_token);
      
      try {
        const fullUserProfile = await getMe();
        setToken(response.access_token, fullUserProfile);
      } catch (meError) {
        // Fallback profile if getMe() fails
        const fallbackProfile = {
          id: 0,
          username: response.username,
          email: `${response.username}@actmon.local`,
          role: response.role,
          is_active: true,
          is_superuser: response.role === 'Admin',
        };
        setToken(response.access_token, fallbackProfile);
      }
      
      return true;
    } catch (err) {
      setError(err.message || 'Invalid username or password.');
      localStorage.removeItem('actmon_token');
      return false;
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    clearToken();
  };

  return {
    token,
    user,
    isAuthenticated: !!token,
    login,
    logout,
    loading,
    error,
  };
};
