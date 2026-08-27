-- ─────────────────────────────────────────────────────────────────────────────
--  Register the remaining "Add Data" (Agent Setup) catalog routes as governed
--  pages, under the existing AGENTS module (module_id 2 — see page_ids
--  158-162 in config_pages.sql for the sibling rows this follows).
--
--  1. /agents/setup/network-check had NO page_master row at all (unlike its
--     sibling /agents/setup/website, page_code AGENTS_SETUP_WEBSITE) — a real
--     gap where this route was open to every signed-in user regardless of
--     role. This migration closes it.
--
--  2. AgentSetupPage.jsx's APM/Network/Integrations catalog tabs previously
--     had ~50 dead cards (no route at all, or — for Integrations — not even
--     a <button>). They now route to the shared ComingSoonSetup page via
--     three new URL patterns (one page_master row per pattern, same
--     one-row-covers-every-:param convention already used for
--     AGENTS_SETUP_TECH / /agents/setup/:tech):
--       /agents/setup/apm/:itemId          -> AGENTS_SETUP_APM
--       /agents/setup/network/:itemId      -> AGENTS_SETUP_NETWORK_DEVICE
--       /agents/setup/integration/:itemId  -> AGENTS_SETUP_INTEGRATION
--
--  Default grant of View (permission bit 1) to every currently-active role,
--  same as every other page in this module — a Super Admin can restrict per
--  role afterward via Group Role Permissions.
--
--  Safe to re-run: each page insert guarded by page_code, each grant insert
--  guarded by NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.page_master
  (org_id, module_id, parent_id, page_code, page_name, page_url, icon_name, display_order, is_menu, is_active, created_by, created_at)
SELECT 1, 2, 0, v.page_code, v.page_name, v.page_url, NULL,
       (SELECT COALESCE(MAX(display_order), 0) FROM public.page_master WHERE module_id = 2) + v.rn,
       false, true, 1, CURRENT_TIMESTAMP
FROM (VALUES
  ('AGENTS_SETUP_NETWORK_CHECK', 'Network Check', '/agents/setup/network-check', 1),
  ('AGENTS_SETUP_APM', 'Agent Setup APM', '/agents/setup/apm/:itemId', 2),
  ('AGENTS_SETUP_NETWORK_DEVICE', 'Agent Setup Network Device', '/agents/setup/network/:itemId', 3),
  ('AGENTS_SETUP_INTEGRATION', 'Agent Setup Integration', '/agents/setup/integration/:itemId', 4)
) AS v(page_code, page_name, page_url, rn)
WHERE NOT EXISTS (SELECT 1 FROM public.page_master WHERE page_code = v.page_code);

INSERT INTO public.group_role_page_permission
  (org_id, role_id, page_id, permission, permission_description, is_active, created_by, created_at)
SELECT r.org_id, r.role_id, p.page_id, 1, 'View', true, 1, CURRENT_TIMESTAMP
FROM public.role r
CROSS JOIN public.page_master p
WHERE p.page_code IN ('AGENTS_SETUP_NETWORK_CHECK', 'AGENTS_SETUP_APM', 'AGENTS_SETUP_NETWORK_DEVICE', 'AGENTS_SETUP_INTEGRATION')
  AND r.is_active = true
  AND r.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.group_role_page_permission x
    WHERE x.org_id = r.org_id AND x.role_id = r.role_id AND x.page_id = p.page_id AND x.deleted_at IS NULL
  );
