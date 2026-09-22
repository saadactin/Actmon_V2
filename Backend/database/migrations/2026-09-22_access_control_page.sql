-- ─────────────────────────────────────────────────────────────────────────────
--  Register /access-control — the tabbed Access Control screen that now fronts
--  Roles, Pages, Permissions, Role Permissions, User Roles and Audit Logs.
--
--  Why this matters beyond tidiness: usePermissions treats any URL absent from
--  page_master as ungoverned, i.e. reachable by ANY signed-in user. Until this
--  row exists, /access-control is exactly that — an unguarded door to the RBAC
--  administration screen. The tabs' own routes (/roles, /permissions, ...) stay
--  registered and governed as before; this adds the shell that wraps them.
--
--  DELIBERATELY NOT granted to every active role. Other page migrations in this
--  repo default-grant View to all roles, which is right for a dashboard and
--  wrong here: that would hand every role the door to permissions
--  administration. Instead this copies the grant from the page the screen
--  replaces (/role-permissions), so whoever can administer RBAC today can
--  administer it tomorrow, and nobody else gains anything.
--
--  Placed in the same module as the existing /role-permissions page and at the
--  same level, rather than hardcoding a module id, so it lands correctly
--  regardless of how Administration is numbered in a given deployment.
--
--  Safe to re-run: the page insert is guarded by page_code, the grant by
--  NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.page_master
  (org_id, module_id, parent_id, page_code, page_name, page_url, icon_name,
   display_order, is_menu, is_active, created_by, created_at)
SELECT src.org_id, src.module_id, src.parent_id, 'ACCESS_CONTROL', 'Access Control',
       '/access-control', 'shield-check',
       (SELECT COALESCE(MAX(display_order), 0) + 1
          FROM public.page_master
         WHERE module_id = src.module_id AND parent_id = src.parent_id),
       true, true, 1, CURRENT_TIMESTAMP
  FROM public.page_master src
 WHERE src.page_url = '/role-permissions'
   AND src.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.page_master WHERE page_code = 'ACCESS_CONTROL')
 LIMIT 1;

-- Mirror the existing /role-permissions grant, per role, bit for bit.
INSERT INTO public.group_role_page_permission
  (org_id, role_id, page_id, permission, permission_description, is_active, created_by, created_at)
SELECT g.org_id, g.role_id, newp.page_id, g.permission, g.permission_description,
       true, 1, CURRENT_TIMESTAMP
  FROM public.group_role_page_permission g
  JOIN public.page_master oldp
    ON oldp.page_id = g.page_id
   AND oldp.page_url = '/role-permissions'
   AND oldp.deleted_at IS NULL
 CROSS JOIN (SELECT page_id FROM public.page_master WHERE page_code = 'ACCESS_CONTROL') newp
 WHERE g.deleted_at IS NULL
   AND g.is_active = true
   AND NOT EXISTS (
     SELECT 1 FROM public.group_role_page_permission x
      WHERE x.org_id = g.org_id AND x.role_id = g.role_id
        AND x.page_id = newp.page_id AND x.deleted_at IS NULL
   );

-- What landed, for the operator to eyeball before trusting it.
SELECT p.page_id, p.page_code, p.page_url, p.module_id, p.parent_id, p.is_menu,
       (SELECT count(*) FROM public.group_role_page_permission g
         WHERE g.page_id = p.page_id AND g.deleted_at IS NULL) AS roles_granted
  FROM public.page_master p
 WHERE p.page_code = 'ACCESS_CONTROL';
