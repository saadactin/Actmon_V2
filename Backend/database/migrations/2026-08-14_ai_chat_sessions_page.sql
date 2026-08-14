-- ─────────────────────────────────────────────────────────────────────────────
--  Super Admin → AI Chat Sessions audit page — one new page_master row,
--  sibling to the existing Audit Logs / Login History / User Sessions pages
--  (same parent: ADMINISTRATION, page_id 48; same module_id 8).
--
--  Safe to re-run (INSERT is guarded by page_code).
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.page_master
  (org_id, module_id, parent_id, page_code, page_name, page_url, icon_name, display_order, is_menu, is_active, created_by, created_at)
SELECT 1, 8, (SELECT page_id FROM public.page_master WHERE page_code = 'ADMINISTRATION'),
       'AI_CHAT_SESSIONS', 'AI Chat Sessions', '/ai-chat-sessions', 'chat', 15, true, true, 1, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM public.page_master WHERE page_code = 'AI_CHAT_SESSIONS');

-- ─────────────────────────────────────────────────────────────────────────────
--  Grant cascade: every (org, role) that currently holds ANY grant on the
--  Administration hub (page_id 48) gets the SAME permission bitmask replicated
--  onto this new page — mirrors exactly how AUDIT_LOG/LOGIN_HISTORY/USER_SESSION
--  are already granted alongside page 48 for every (org, role) in this database
--  (verified: (org 1, role 1) = 511 on all four; (org 4, role 17) = 1 on all
--  four) — so a role that could see Administration's audit pages yesterday
--  sees this one too today, rather than finding it freshly denied.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.group_role_page_permission
  (org_id, role_id, page_id, permission, is_active, created_by, created_at)
SELECT g.org_id, g.role_id, p.page_id, g.permission, true, 1, CURRENT_TIMESTAMP
FROM public.group_role_page_permission g
CROSS JOIN public.page_master p
WHERE g.page_id = (SELECT page_id FROM public.page_master WHERE page_code = 'ADMINISTRATION')
  AND g.deleted_at IS NULL
  AND p.page_code = 'AI_CHAT_SESSIONS'
  AND NOT EXISTS (
    SELECT 1 FROM public.group_role_page_permission x
    WHERE x.org_id = g.org_id AND x.role_id = g.role_id AND x.page_id = p.page_id AND x.deleted_at IS NULL
  );
