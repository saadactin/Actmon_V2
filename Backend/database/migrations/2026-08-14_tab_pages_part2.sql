-- ─────────────────────────────────────────────────────────────────────────────
--  Part 2 of the tab-as-route audit (see 2026-08-14_infra_tab_pages.sql for
--  part 1 / Infrastructure). Gives the remaining offending pages found in the
--  same audit their own page_master row per tab, and cascades the parent's
--  existing grants onto each — same rationale as part 1: a page is denied by
--  default the moment it exists in page_master, so every existing (org, role)
--  grant on the parent must be replicated onto the new children or access
--  silently narrows on rollout.
--
--  DiagnosisPage.jsx (/diagnose/:connId) is deliberately NOT included here —
--  it has no page_master row today (ungoverned), and adding one as a side
--  effect of a routing cleanup would newly RBAC-gate a page that's currently
--  open to everyone. Its tabs were still converted to real routes in the
--  frontend, just without any backing page_master/permission rows.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── /infra/hosts, parent = INFRASTRUCTURE (71) ─────────────────────────────
INSERT INTO public.page_master
  (org_id, module_id, parent_id, page_code, page_name, page_url, icon_name, display_order, is_menu, is_active, created_by, created_at)
SELECT 1, 5, (SELECT page_id FROM public.page_master WHERE page_code = 'INFRASTRUCTURE'),
  'INFRA_HOSTS', 'Hosts', '/infra/hosts', 'server', 2, false, true, 1, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM public.page_master WHERE page_code = 'INFRA_HOSTS');

-- ── /settings/notifications, parent = SETTINGS (74) ────────────────────────
INSERT INTO public.page_master
  (org_id, module_id, parent_id, page_code, page_name, page_url, icon_name, display_order, is_menu, is_active, created_by, created_at)
SELECT 1, 9, (SELECT page_id FROM public.page_master WHERE page_code = 'SETTINGS'),
  'SETTINGS_NOTIFICATIONS', 'Notifications', '/settings/notifications', 'bell', 2, false, true, 1, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM public.page_master WHERE page_code = 'SETTINGS_NOTIFICATIONS');

-- ── 6 ResourceDetail tabs, parent = CLOUD_RESOURCE_DETAIL (142) ────────────
INSERT INTO public.page_master
  (org_id, module_id, parent_id, page_code, page_name, page_url, display_order, is_menu, is_active, created_by, created_at)
SELECT 1, 4, (SELECT page_id FROM public.page_master WHERE page_code = 'CLOUD_RESOURCE_DETAIL'), v.code, v.name, v.url, v.ord, false, true, 1, CURRENT_TIMESTAMP
FROM (VALUES
  ('CLOUD_RESOURCE_MONITORING',   'Resource Monitoring',    '/cloud/resources/:resourceId/monitoring',    1),
  ('CLOUD_RESOURCE_CONFIGURATION','Resource Configuration', '/cloud/resources/:resourceId/configuration', 2),
  ('CLOUD_RESOURCE_METADATA',     'Resource Metadata',      '/cloud/resources/:resourceId/metadata',      3),
  ('CLOUD_RESOURCE_TAGS',         'Resource Tags',          '/cloud/resources/:resourceId/tags',          4),
  ('CLOUD_RESOURCE_RAW_JSON',     'Resource Raw JSON',      '/cloud/resources/:resourceId/raw-json',      5)
) AS v(code, name, url, ord)
WHERE NOT EXISTS (SELECT 1 FROM public.page_master WHERE page_code = v.code);

-- ── Grant cascade: replicate every existing grant on each parent page onto
--    its new children (mirrors the same-named block in part 1) ─────────────
INSERT INTO public.group_role_page_permission
  (org_id, role_id, page_id, permission, is_active, created_by, created_at)
SELECT g.org_id, g.role_id, p.page_id, g.permission, true, 1, CURRENT_TIMESTAMP
FROM public.group_role_page_permission g
CROSS JOIN public.page_master p
WHERE g.deleted_at IS NULL
  AND (
    (g.page_id = (SELECT page_id FROM public.page_master WHERE page_code = 'INFRASTRUCTURE')
       AND p.page_code = 'INFRA_HOSTS')
    OR (g.page_id = (SELECT page_id FROM public.page_master WHERE page_code = 'SETTINGS')
       AND p.page_code = 'SETTINGS_NOTIFICATIONS')
    OR (g.page_id = (SELECT page_id FROM public.page_master WHERE page_code = 'CLOUD_RESOURCE_DETAIL')
       AND p.page_code IN ('CLOUD_RESOURCE_MONITORING', 'CLOUD_RESOURCE_CONFIGURATION',
                            'CLOUD_RESOURCE_METADATA', 'CLOUD_RESOURCE_TAGS', 'CLOUD_RESOURCE_RAW_JSON'))
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.group_role_page_permission x
    WHERE x.org_id = g.org_id AND x.role_id = g.role_id AND x.page_id = p.page_id AND x.deleted_at IS NULL
  );
