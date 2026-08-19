-- ─────────────────────────────────────────────────────────────────────────────
--  Register /help-center itself as a governed page.
--
--  Only /help-center-appearance (the admin theming sub-page) had a page_master
--  row — the actual Help Center content page had none, so it was open to every
--  signed-in user regardless of role, and useNavigation.js force-showed it in
--  the nav no matter what RBAC said. AppShell now enforces isDeniedHere() on
--  every route (see the RBAC route-guard fix), so this migration is what
--  actually makes Help Center itself restrictable.
--
--  New top-level module (Help Center had no module_master row at all), one
--  page under it, and a default grant of View (permission bit 1) to every
--  currently-active role — so turning enforcement on doesn't silently lock
--  any existing user out of a page they already had open access to. A Super
--  Admin can revoke it per role afterward via Group Role Permissions, same as
--  any other page.
--
--  Safe to re-run: module insert guarded by module_code, page insert by
--  page_code, grant insert by NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.module_master
  (org_id, module_name, module_code, module_description, module_route, module_icon, display_order, is_active, created_by, created_at)
SELECT 1, 'Help Center', 'HELP_CENTER', 'Documentation & Support', '/help-center', 'help',
       (SELECT COALESCE(MAX(display_order), 0) + 1 FROM public.module_master),
       true, 1, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM public.module_master WHERE module_code = 'HELP_CENTER');

INSERT INTO public.page_master
  (org_id, module_id, parent_id, page_code, page_name, page_url, icon_name, display_order, is_menu, is_active, created_by, created_at)
SELECT 1, (SELECT module_id FROM public.module_master WHERE module_code = 'HELP_CENTER'), 0,
       'HELP_CENTER', 'Help Center', '/help-center', 'help', 1, true, true, 1, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM public.page_master WHERE page_code = 'HELP_CENTER');

INSERT INTO public.group_role_page_permission
  (org_id, role_id, page_id, permission, permission_description, is_active, created_by, created_at)
SELECT r.org_id, r.role_id, p.page_id, 1, 'View', true, 1, CURRENT_TIMESTAMP
FROM public.role r
CROSS JOIN public.page_master p
WHERE p.page_code = 'HELP_CENTER'
  AND r.is_active = true
  AND r.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.group_role_page_permission x
    WHERE x.org_id = r.org_id AND x.role_id = r.role_id AND x.page_id = p.page_id AND x.deleted_at IS NULL
  );
