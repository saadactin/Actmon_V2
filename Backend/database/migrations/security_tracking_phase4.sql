-- ─────────────────────────────────────────────────────────────────────────────
--  PHASE 4 — read views for login_history, user_session, password_history.
--  Inserts happen in the auth service during login/logout/change-password.
--  Tables are untouched. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.vw_login_history AS
SELECT lh.login_history_id, lh.org_id, o.org_name, lh.user_id, u.user_name,
       e.employee_name, lh.login_time, lh.logout_time, lh.login_status,
       lh.ip_address, lh.device_name, lh.browser_name, lh.operating_system
FROM   public.login_history lh
LEFT JOIN public.organization_master o ON o.org_id = lh.org_id
LEFT JOIN public.user_master         u ON u.user_id = lh.user_id
LEFT JOIN public.employee_master     e ON e.employee_id = u.employee_id;

CREATE OR REPLACE VIEW public.vw_user_session AS
SELECT s.session_id, s.user_id, u.user_name, e.employee_name,
       s.login_time, s.expiry_time, s.ip_address, s.device_name, s.is_active,
       (s.is_active AND s.expiry_time > now()) AS is_live
FROM   public.user_session s
LEFT JOIN public.user_master     u ON u.user_id = s.user_id
LEFT JOIN public.employee_master e ON e.employee_id = u.employee_id;

-- password_history view masks the hash (never expose it)
CREATE OR REPLACE VIEW public.vw_password_history AS
SELECT ph.password_history_id, ph.user_id, u.user_name, e.employee_name, ph.created_at
FROM   public.password_history ph
LEFT JOIN public.user_master     u ON u.user_id = ph.user_id
LEFT JOIN public.employee_master e ON e.employee_id = u.employee_id;
