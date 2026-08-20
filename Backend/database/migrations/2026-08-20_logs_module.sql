-- ─────────────────────────────────────────────────────────────────────────────
--  Move Audit Logs / Login History / Password History / User Sessions out of
--  Administration and under the top-nav Logs module (module_id 13) — Logs
--  had zero pages of its own, so its top-nav route (/logs) rendered nothing
--  but the generic "not built yet" placeholder.
--
--  Existing grants are untouched: group_role_page_permission is keyed by
--  page_id, not module_id, so every role's current access to these 4 pages
--  carries over unchanged — this only changes which module they're grouped
--  under for the nav/menu and for Administration's own module list.
--
--  parent_id -> 0: these become Logs' own top-level pages (Logs has no
--  existing hub page to nest under, unlike Administration's parent_id=48).
--
--  Safe to re-run: UPDATE is a no-op once module_id already reads 13.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE public.page_master
SET module_id = 13, parent_id = 0, modified_by = 1, modified_at = CURRENT_TIMESTAMP
WHERE page_code IN ('AUDIT_LOG', 'LOGIN_HISTORY', 'PASSWORD_HISTORY', 'USER_SESSION')
  AND module_id <> 13;
