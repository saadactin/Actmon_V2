-- ─────────────────────────────────────────────────────────────────────────────
--  Backfill the 'Restart' permission bit (256, added by
--  2026-08-14_add_restart_permission.sql) onto existing role grants for the
--  Infrastructure Detail page.
--
--  2026-08-14_add_restart_permission.sql only added 256 to the `permission`
--  catalog and bumped the 'Full Access' sentinel to 511 — it never touched
--  any `group_role_page_permission` row. 2026-08-14_infra_tab_pages.sql's
--  grant cascade only replicated each role's EXISTING bitmask onto the 51
--  new child pages; it never OR'd bit 256 into anything. Net effect: no role
--  anywhere holds bit 256 on /infra/:id, so the newly RBAC-gated
--  restart-service / reboot / service-action(restart) endpoints in
--  os_server_routes.py return 403 for every user, including roles that had
--  Full Access before this deploy.
--
--  Fix: any (org, role) that already holds 'Execute' (64) on the Infra
--  Detail page — the sibling bit already gating the same endpoint's
--  start/stop/kill-process/update-agent actions — also gets 'Restart' (256)
--  OR'd in. This restores Full Access roles (which already included 64) to
--  full parity, and extends Restart to any other role already trusted with
--  Execute-level host control, without granting it to view-only roles that
--  never had operational access to Infra.
--
--  Safe to re-run (bitwise OR of an already-set bit is a no-op).
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE public.group_role_page_permission g
SET permission = g.permission | 256
FROM public.page_master p
WHERE g.page_id = p.page_id
  AND p.page_code = 'INFRA_ID'
  AND g.deleted_at IS NULL
  AND (g.permission & 64) = 64
  AND (g.permission & 256) = 0;
