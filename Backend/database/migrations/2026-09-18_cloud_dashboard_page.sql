-- ─────────────────────────────────────────────────────────────────────────────
--  Register a new "Cloud Dashboard" page as a CHILD of the existing main
--  "Dashboard" page (page_id 67, module_id 1) — NOT under the Cloud module
--  (module_id 4, where Cloud Accounts/Resources/Cost/... already live at
--  page_ids 140-147). Its own route, /cloud-dashboard, is a distinct
--  top-level page — a Cloud-Engineer-only role is granted THIS page (and
--  not page 67 itself), so it never sees the Admin Dashboard.
--
--  is_menu=true: it's meant to be a real nav destination a Cloud-Engineer-
--  only role lands on directly (Login.jsx's firstAllowedPath() walks exactly
--  this menu tree after login), not a tab reached from elsewhere.
--
--  Default grant of View (permission bit 1) to every currently-active role,
--  same as every other page in this app — a Super Admin restricts per role
--  afterward via Group Role Permissions (Administration > Access Control >
--  Dashboard), e.g. granting a "Cloud Engineer" role ONLY this page (and
--  revoking page 67 / Database / Infrastructure page views from that role).
--
--  Safe to re-run: the page insert is guarded by page_code, the grant insert
--  by NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.page_master
  (org_id, module_id, parent_id, page_code, page_name, page_url, icon_name, display_order, is_menu, is_active, created_by, created_at)
SELECT 1, 1, 67, 'CLOUD_DASHBOARD', 'Cloud Dashboard', '/cloud-dashboard', 'cloud',
       (SELECT COALESCE(MAX(display_order), 0) FROM public.page_master WHERE module_id = 1 AND parent_id = 67) + 1,
       true, true, 1, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM public.page_master WHERE page_code = 'CLOUD_DASHBOARD');

INSERT INTO public.group_role_page_permission
  (org_id, role_id, page_id, permission, permission_description, is_active, created_by, created_at)
SELECT r.org_id, r.role_id, p.page_id, 1, 'View', true, 1, CURRENT_TIMESTAMP
FROM public.role r
CROSS JOIN public.page_master p
WHERE p.page_code = 'CLOUD_DASHBOARD'
  AND r.is_active = true
  AND r.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.group_role_page_permission x
    WHERE x.org_id = r.org_id AND x.role_id = r.role_id AND x.page_id = p.page_id AND x.deleted_at IS NULL
  );
