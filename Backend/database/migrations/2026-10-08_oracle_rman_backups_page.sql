-- ─────────────────────────────────────────────────────────────────────────────
--  Register /oracle-dashboard/:id/backups — the RMAN backup monitoring tab.
--
--  Why this is not optional: usePermissions treats any URL absent from
--  page_master as ungoverned, i.e. reachable by ANY signed-in user. Until this
--  row exists, the new tab is exactly that. It is read-only, but it still
--  discloses datafile paths, backup device types and the instance's recovery
--  posture — which is precisely the information you would want before
--  attacking one.
--
--  The grant is copied from the Redo Logs tab rather than default-granted to
--  every role. Redo Logs is the closest sibling: same parent, same module,
--  same read-only "recovery plumbing" nature. Whoever can see one should see
--  the other, and nobody gains anything they did not already have.
--
--  Module and parent are taken from that sibling row rather than hardcoded, so
--  this lands correctly regardless of how the Oracle pages are numbered in a
--  given deployment. page_id is left to the sequence for the same reason.
--
--  Safe to re-run: the page insert is guarded by page_code, the grant by
--  NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.page_master
  (org_id, module_id, parent_id, page_code, page_name, page_url, icon_name,
   display_order, is_menu, is_active, created_by, created_at)
SELECT src.org_id, src.module_id, src.parent_id, 'ORACLE_TAB_BACKUPS', 'RMAN Backups',
       '/oracle-dashboard/:id/backups', 'archive',
       (SELECT COALESCE(MAX(display_order), 0) + 1
          FROM public.page_master
         WHERE module_id = src.module_id AND parent_id = src.parent_id),
       true, true, 1, CURRENT_TIMESTAMP
  FROM public.page_master src
 WHERE src.page_url = '/oracle-dashboard/:id/redologs'
   AND src.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.page_master WHERE page_code = 'ORACLE_TAB_BACKUPS')
 LIMIT 1;

-- Mirror the Redo Logs grant, per role, bit for bit.
INSERT INTO public.group_role_page_permission
  (org_id, role_id, page_id, permission, permission_description, is_active, created_by, created_at)
SELECT g.org_id, g.role_id, newp.page_id, g.permission, g.permission_description,
       true, 1, CURRENT_TIMESTAMP
  FROM public.group_role_page_permission g
  JOIN public.page_master oldp
    ON oldp.page_id = g.page_id
   AND oldp.page_url = '/oracle-dashboard/:id/redologs'
   AND oldp.deleted_at IS NULL
 CROSS JOIN (SELECT page_id FROM public.page_master WHERE page_code = 'ORACLE_TAB_BACKUPS') newp
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
 WHERE p.page_code = 'ORACLE_TAB_BACKUPS';
