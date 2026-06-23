import client from './client';

/** Step 1 — validate credentials; backend emails a 6-digit OTP.
 *  Returns { otp_required, otp_token, email_masked, expires_in, dev_otp? } */
export const login = async (username, password) => {
  const res = await client.post('/auth/login', { username, password });
  return res.data;
};

/** Step 2 — verify the OTP; returns { access_token, user, role, menu, permissions }. */
export const verifyOtp = async (otp_token, otp) => {
  const res = await client.post('/auth/verify-otp', { otp_token, otp });
  return res.data;
};

export const resendOtp = async (otp_token) => {
  const res = await client.post('/auth/resend-otp', { otp_token });
  return res.data;
};

export const logout = async () => {
  try { await client.post('/auth/logout'); } catch { /* stateless */ }
};

export const getMe = async () => {
  const res = await client.get('/auth/me');
  return res.data;
};

export const getMenu = async () => {
  const res = await client.get('/auth/menu');
  return res.data.menu || [];
};

export const getPermissions = async () => {
  const res = await client.get('/auth/permissions');
  return res.data; // { permissions, permission_catalog }
};

export const changePassword = async (old_password, new_password) => {
  const res = await client.post('/auth/change-password', { old_password, new_password });
  return res.data;
};
