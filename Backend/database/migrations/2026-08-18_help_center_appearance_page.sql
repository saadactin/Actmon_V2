-- ─────────────────────────────────────────────────────────────────────────────
--  Administration → Help Center Appearance — one new page_master row, sibling
--  to AI Chat Sessions / Audit Logs / Login History / User Sessions (same
--  parent: ADMINISTRATION; same module_id 8). Gates write access (PUT/DELETE)
--  to the /api/v1/settings/help-center-appearance backend routes via the
--  'edit' permission bit — GET stays open to any signed-in user.
--
--  Safe to re-run (INSERT is guarded by page_code).
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.page_master
  (org_id, module_id, parent_id, page_code, page_name, page_url, icon_name, display_order, is_menu, is_active, created_by, created_at)
SELECT 1, 8, (SELECT page_id FROM public.page_master WHERE page_code = 'ADMINISTRATION'),
       'HELP_CENTER_APPEARANCE', 'Help Center Appearance', '/help-center-appearance', 'palette',
       (SELECT COALESCE(MAX(display_order), 0) + 1 FROM public.page_master
        WHERE parent_id = (SELECT page_id FROM public.page_master WHERE page_code = 'ADMINISTRATION')),
       true, true, 1, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM public.page_master WHERE page_code = 'HELP_CENTER_APPEARANCE');

-- ─────────────────────────────────────────────────────────────────────────────
--  Grant cascade: every (org, role) that currently holds ANY grant on the
--  Administration hub gets the SAME permission bitmask replicated onto this
--  new page — same pattern as AI_CHAT_SESSIONS' own migration (2026-08-14).
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.group_role_page_permission
  (org_id, role_id, page_id, permission, is_active, created_by, created_at)
SELECT g.org_id, g.role_id, p.page_id, g.permission, true, 1, CURRENT_TIMESTAMP
FROM public.group_role_page_permission g
CROSS JOIN public.page_master p
WHERE g.page_id = (SELECT page_id FROM public.page_master WHERE page_code = 'ADMINISTRATION')
  AND g.deleted_at IS NULL
  AND p.page_code = 'HELP_CENTER_APPEARANCE'
  AND NOT EXISTS (
    SELECT 1 FROM public.group_role_page_permission x
    WHERE x.org_id = g.org_id AND x.role_id = g.role_id AND x.page_id = p.page_id AND x.deleted_at IS NULL
  );
