import client from './client';

/**
 * Authentication. Two steps, and the first one deliberately does NOT sign you in:
 * `/auth/login` only validates the credentials and emails a 6-digit code, so a
 * stolen password alone is not enough.
 */

/** Step 1 — validate credentials; the backend emails a 6-digit OTP.
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

/** Returns a REPLACEMENT otp_token — the old one is retired server-side. */
export const resendOtp = async (otp_token) => {
  const res = await client.post('/auth/resend-otp', { otp_token });
  return res.data;
};

export const logout = async () => {
  // The session is stateless, so a failure here is not worth surfacing —
  // clearing the local token is what actually signs the user out.
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

/* ── First-run setup ─────────────────────────────────────────────────────────
   Public on purpose: on a fresh install there is no account to authenticate with.
   The backend guards both endpoints on "no users exist yet", so once an admin is
   created POST /setup/admin returns 409 and cannot be used to escalate. */

/** Whether any admin exists yet, and whether the installer's DB step has run. */
export const getSetupStatus = async () => {
  const res = await client.get('/setup/status');
  return res.data; // { needs_setup, user_count, org_name, db_ready }
};

/** Create the first Super Admin (employee + user). Only works while empty. */
export const createAdmin = async (payload) => {
  const res = await client.post('/setup/admin', payload);
  return res.data; // { status, employee_id, user_id, username, role, message }
};
