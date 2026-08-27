-- ─────────────────────────────────────────────────────────────────────────────
--  Nest the catalog cards that already have a real, working setup flow under
--  their own tab's URL, same as every ComingSoon card added by
--  2026-08-21_agents_setup_hierarchy.sql — instead of living at a flat
--  /agents/setup/<name> URL that doesn't say which tab it belongs to.
--
--    /agents/setup/website              -> /agents/setup/digital-experience/website-availability
--    /agents/setup/network-check?type=  -> one literal route per check type:
--                                          /agents/setup/digital-experience/{tcp-port,ping,dns,udp-port}
--                                          (previously one shared page, since a
--                                          query string can't be matched by
--                                          page_master — now four independent
--                                          pages, each individually revocable)
--    /agents/setup/:tech                -> /agents/setup/databases/:tech
--
--  The old routes still work in the frontend (kept as fallbacks), but
--  page_master now reflects the real, current URL each catalog card actually
--  links to — a stale page_url would otherwise leave that card's real
--  destination permanently ungoverned.
--
--  Safe to re-run: UPDATEs are no-ops on a second run, inserts guarded by
--  page_code via NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE public.page_master SET page_url = '/agents/setup/digital-experience/website-availability'
WHERE page_code = 'AGENTS_SETUP_WEBSITE';

UPDATE public.page_master SET page_url = '/agents/setup/databases/:tech'
WHERE page_code = 'AGENTS_SETUP_TECH';

UPDATE public.page_master SET page_url = '/agents/setup/databases/mysql' WHERE page_code = 'AGENTS_SETUP_DB_MYSQL';
UPDATE public.page_master SET page_url = '/agents/setup/databases/postgresql' WHERE page_code = 'AGENTS_SETUP_DB_POSTGRESQL';
UPDATE public.page_master SET page_url = '/agents/setup/databases/mssql' WHERE page_code = 'AGENTS_SETUP_DB_MSSQL';
UPDATE public.page_master SET page_url = '/agents/setup/databases/oracle' WHERE page_code = 'AGENTS_SETUP_DB_ORACLE';
UPDATE public.page_master SET page_url = '/agents/setup/databases/mongodb' WHERE page_code = 'AGENTS_SETUP_DB_MONGODB';
UPDATE public.page_master SET page_url = '/agents/setup/databases/clickhouse' WHERE page_code = 'AGENTS_SETUP_DB_CLICKHOUSE';

-- The old shared network-check page is superseded by four literal ones below.
UPDATE public.page_master SET is_active = false WHERE page_code = 'AGENTS_SETUP_NETWORK_CHECK';

INSERT INTO public.page_master
  (org_id, module_id, parent_id, page_code, page_name, page_url, icon_name, display_order, is_menu, is_active, created_by, created_at)
SELECT 1, 2, (SELECT page_id FROM public.page_master WHERE page_code = 'AGENTS_SETUP_TAB_DX'),
       v.page_code, v.page_name, v.page_url, NULL, v.rn, false, true, 1, CURRENT_TIMESTAMP
FROM (VALUES
  ('AGENTS_SETUP_DX_TCP_PORT', 'TCP Port', '/agents/setup/digital-experience/tcp-port', 4),
  ('AGENTS_SETUP_DX_PING', 'Ping', '/agents/setup/digital-experience/ping', 5),
  ('AGENTS_SETUP_DX_DNS', 'DNS', '/agents/setup/digital-experience/dns', 6),
  ('AGENTS_SETUP_DX_UDP_PORT', 'UDP Port', '/agents/setup/digital-experience/udp-port', 7)
) AS v(page_code, page_name, page_url, rn)
WHERE NOT EXISTS (SELECT 1 FROM public.page_master WHERE page_code = v.page_code);

INSERT INTO public.group_role_page_permission
  (org_id, role_id, page_id, permission, permission_description, is_active, created_by, created_at)
SELECT r.org_id, r.role_id, p.page_id, 1, 'View', true, 1, CURRENT_TIMESTAMP
FROM public.role r
CROSS JOIN public.page_master p
WHERE p.page_code IN ('AGENTS_SETUP_DX_TCP_PORT', 'AGENTS_SETUP_DX_PING', 'AGENTS_SETUP_DX_DNS', 'AGENTS_SETUP_DX_UDP_PORT')
  AND r.is_active = true
  AND r.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.group_role_page_permission x
    WHERE x.org_id = r.org_id AND x.role_id = r.role_id AND x.page_id = p.page_id
  );
