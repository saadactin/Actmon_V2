-- ─────────────────────────────────────────────────────────────────────────────
--  GROUP ROLE PAGE PERMISSION — real CRUD on group_role_page_permission.
--  View (list a role's assigned pages) + JSONB stored procedures. Soft delete.
--  Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.vw_role_page_permission AS
SELECT g.page_permission_id, g.org_id, g.role_id, g.page_id,
       pm.page_name, pm.page_url, pm.module_id, m.module_name,
       g.permission, g.permission_description, g.is_active
FROM   public.group_role_page_permission g
JOIN   public.page_master   pm ON pm.page_id = g.page_id
LEFT JOIN public.module_master m ON m.module_id = pm.module_id
WHERE  g.deleted_at IS NULL AND g.is_active = true;


-- Idempotent grant: UPSERT on (org_id, role_id, page_id). If a row already
-- exists — even a soft-deleted one (deleted_at IS NOT NULL) — it is updated and
-- revived instead of inserting a duplicate (which would violate uk_grpp).
CREATE OR REPLACE PROCEDURE public.sp_insertrolepermission(IN p_json jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    v_org INTEGER; v_role INTEGER; v_page INTEGER; v_perm INTEGER;
    v_desc VARCHAR(255); v_by INTEGER; v_cnt INTEGER;
BEGIN
    v_org  := COALESCE((p_json->>'org_id')::INTEGER, 1);
    v_role := (p_json->>'role_id')::INTEGER;
    v_page := (p_json->>'page_id')::INTEGER;
    v_perm := COALESCE((p_json->>'permission')::INTEGER, 0);
    v_desc := p_json->>'permission_description';
    v_by   := COALESCE((p_json->>'created_by')::INTEGER, 1);
    IF v_role IS NULL THEN RAISE EXCEPTION 'Role is required'; END IF;
    IF v_page IS NULL THEN RAISE EXCEPTION 'Page is required'; END IF;

    -- Try to update an existing row first (active OR soft-deleted) → revive it.
    UPDATE public.group_role_page_permission
      SET permission             = v_perm,
          permission_description = v_desc,
          is_active              = TRUE,
          deleted_at             = NULL,
          deleted_by             = NULL,
          modified_by            = v_by,
          modified_at            = CURRENT_TIMESTAMP
      WHERE org_id = v_org AND role_id = v_role AND page_id = v_page;
    GET DIAGNOSTICS v_cnt = ROW_COUNT;

    -- No existing row → insert a fresh grant.
    IF v_cnt = 0 THEN
        INSERT INTO public.group_role_page_permission
          (org_id, role_id, page_id, permission, permission_description, is_active, created_by, created_at)
        VALUES (v_org, v_role, v_page, v_perm, v_desc, TRUE, v_by, CURRENT_TIMESTAMP);
    END IF;
END; $$;


CREATE OR REPLACE PROCEDURE public.sp_updaterolepermission(IN p_json jsonb)
LANGUAGE plpgsql AS $$
DECLARE v_id INTEGER; v_perm INTEGER; v_desc VARCHAR(255); v_by INTEGER;
BEGIN
    v_id   := (p_json->>'page_permission_id')::INTEGER;
    v_perm := COALESCE((p_json->>'permission')::INTEGER, 0);
    v_desc := p_json->>'permission_description';
    v_by   := COALESCE((p_json->>'modified_by')::INTEGER, 1);
    IF v_id IS NULL THEN RAISE EXCEPTION 'Permission ID is required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.group_role_page_permission WHERE page_permission_id=v_id AND deleted_at IS NULL)
      THEN RAISE EXCEPTION 'Permission record not found'; END IF;
    UPDATE public.group_role_page_permission
      SET permission=v_perm, permission_description=v_desc, modified_by=v_by, modified_at=CURRENT_TIMESTAMP
      WHERE page_permission_id=v_id;
END; $$;


CREATE OR REPLACE PROCEDURE public.sp_deleterolepermission(IN p_json jsonb)
LANGUAGE plpgsql AS $$
DECLARE v_id INTEGER; v_by INTEGER;
BEGIN
    v_id := (p_json->>'page_permission_id')::INTEGER;
    v_by := COALESCE((p_json->>'deleted_by')::INTEGER, 1);
    IF v_id IS NULL THEN RAISE EXCEPTION 'Permission ID is required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.group_role_page_permission WHERE page_permission_id=v_id AND deleted_at IS NULL)
      THEN RAISE EXCEPTION 'Permission record not found'; END IF;
    UPDATE public.group_role_page_permission
      SET is_active=FALSE, deleted_by=v_by, deleted_at=CURRENT_TIMESTAMP
      WHERE page_permission_id=v_id;
END; $$;
