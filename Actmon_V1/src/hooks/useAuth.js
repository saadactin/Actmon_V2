import { useState } from 'react';
import { useAuthStore } from '../store/authStore';
import { login as apiLogin, verifyOtp as apiVerifyOtp, resendOtp as apiResendOtp, logout as apiLogout } from '../api/auth';

export const useAuth = () => {
  const { token, user, setAuth, clearToken } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  /** Step 1: validate credentials → triggers OTP email. Returns OTP context. */
  const login = async (username, password) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiLogin(username, password);
      // 2-step: never a token here, only OTP context
      return {
        otpRequired: !!res.otp_required,
        otpToken: res.otp_token,
        email: res.email_masked,
        expiresIn: res.expires_in,
        devOtp: res.dev_otp,   // present only when backend OTP_DEBUG is on
      };
    } catch (err) {
      setError(err.message || 'Invalid username or password.');
      return { error: err.message || 'Invalid username or password.' };
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
      // store token + user + role + menu + permissions (RBAC)
      setAuth(data.access_token, data);
      return data; // caller uses data.menu to land on the first accessible page
    } catch (err) {
      setError(err.message || 'Incorrect OTP.');
      return null;
    } finally {
      setLoading(false);
    }
  };

  const resendOtp = async (otpToken) => {
    try { return await apiResendOtp(otpToken); }
    catch (err) { setError(err.message); return null; }
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
