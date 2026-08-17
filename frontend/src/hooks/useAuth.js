import { useState } from 'react';
import { useAuthStore } from '@/store/authStore';
import {
  login as apiLogin,
  logout as apiLogout,
  resendOtp as apiResendOtp,
  verifyOtp as apiVerifyOtp,
} from '@/api/auth';

/**
 * The sign-in flow. Ported from the existing module, which is the working one.
 *
 * `login()` returns OTP context rather than a session — the backend never hands
 * back a token at that step. `verifyOtp()` is what establishes the session, and
 * its payload carries the RBAC menu the caller uses to decide where to land.
 */
export const useAuth = () => {
  // Selectors, not a bare `useAuthStore()` destructure — this hook is used
  // widely (login flow, header, guards), and a whole-store subscription
  // re-renders every caller whenever ANY auth field changes, not just the
  // ones actually read here.
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const setAuth = useAuthStore((s) => s.setAuth);
  const clearToken = useAuthStore((s) => s.clearToken);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  /** Step 1: validate credentials → triggers the OTP email. Returns OTP context. */
  const login = async (username, password) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiLogin(username, password);
      return {
        otpRequired: !!res.otp_required,
        otpToken: res.otp_token,
        email: res.email_masked,
        expiresIn: res.expires_in,
        devOtp: res.dev_otp, // present only when the backend has OTP_DEBUG on
      };
    } catch (err) {
      const msg = err?.response?.data?.detail || err.message || 'Invalid username or password.';
      setError(msg);
      return { error: msg };
    } finally {
      setLoading(false);
    }
  };

  /** Step 2: verify the OTP → establishes the session. */
  const verifyOtp = async (otpToken, otp) => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiVerifyOtp(otpToken, otp);
      setAuth(data.access_token, data);
      return data; // the caller reads data.menu to land on the first allowed page
    } catch (err) {
      setError(err?.response?.data?.detail || err.message || 'Incorrect OTP.');
      return null;
    } finally {
      setLoading(false);
    }
  };

  const resendOtp = async (otpToken) => {
    try {
      return await apiResendOtp(otpToken);
    } catch (err) {
      setError(err?.response?.data?.detail || err.message);
      return null;
    }
  };

  const logout = async () => {
    await apiLogout();
    clearToken();
  };

  return {
    token, user, isAuthenticated: !!token,
    login, verifyOtp, resendOtp, logout,
    loading, error, setError,
  };
};

export default useAuth;
