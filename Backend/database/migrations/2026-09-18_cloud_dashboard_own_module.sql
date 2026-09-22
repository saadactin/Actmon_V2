-- ─────────────────────────────────────────────────────────────────────────────
--  Give Cloud Dashboard its OWN module instead of living inside the main
--  "Dashboard" module (module_id 1) — live testing found a real problem with
--  the previous placement, not just a cosmetic one:
--
--  frontend/src/hooks/usePermissions.js's isHub() treats a module's own
--  route as a pass-through "hub" whenever the role holds View on ANY child
--  page inside that module:
--      if (m.route && m.children && m.children.length) urls.push(m.route);
--  That's fine for a module like Cloud, whose own anchor page (/cloud) is a
--  neutral provider-chooser — harmless to expose as a pass-through. But the
--  Dashboard module's anchor route (module_route = '/dashboard') IS the
--  full Admin Dashboard content itself. So granting a role ANY page inside
--  the Dashboard module — even an unrelated one like Cloud Dashboard —
--  accidentally exempted /dashboard from its own permission check via the
--  hub rule, and the role saw the full Admin Dashboard. Confirmed live with
--  a role holding ONLY the Cloud Dashboard grant.
--
--  A dedicated module whose own anchor page IS the content actually being
--  granted has no such side effect, and gives it its own top-nav icon
--  (frontend/src/config/navigation.js is updated separately to place it).
--
--  group_role_page_permission grants are keyed by page_id, not module_id —
--  moving the page to a new module does not touch any existing grants
--  (role 3 "Cloud Engineer", role 11 "Cloud-Testing", or any default-grant
--  from the earlier migration all keep working unchanged).
--
--  Safe to re-run: the module insert is guarded by module_code, the page
--  move is a plain idempotent UPDATE.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.module_master
  (org_id, module_name, module_code, module_description, module_route, module_icon, display_order, is_active, created_by, created_at)
SELECT 1, 'Cloud Dashboard', 'CLOUD_DASHBOARD_MODULE', 'Cross-account cloud KPI overview for Cloud Engineers', '/cloud-dashboard', 'gauge',
       (SELECT COALESCE(MAX(display_order), 0) FROM public.module_master) + 1,
       true, 1, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM public.module_master WHERE module_code = 'CLOUD_DASHBOARD_MODULE');

UPDATE public.page_master
SET module_id = (SELECT module_id FROM public.module_master WHERE module_code = 'CLOUD_DASHBOARD_MODULE')
WHERE page_code = 'CLOUD_DASHBOARD';
