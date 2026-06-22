-- ─────────────────────────────────────────────────────────────────────────────
--  ADMIN MASTERS — Phase 1: permission, module, page
--  Views (reads) + JSONB stored procedures (insert/update/delete, soft delete).
--  Mirrors the existing department/role convention. Safe to re-run.
--  org_id defaults to 1 when not supplied (keeps simple forms working).
-- ─────────────────────────────────────────────────────────────────────────────

-- ╔══════════════════════════ PERMISSION (no org) ══════════════════════════╗
CREATE OR REPLACE VIEW public.vw_permission AS
SELECT permission_id, permission_value, permission_name, is_active,
       created_by, created_at, modified_by, modified_at
FROM   public.permission
WHERE  deleted_at IS NULL;

CREATE OR REPLACE PROCEDURE public.sp_insertpermission(IN p_json jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    v_name  VARCHAR(50);
    v_value INTEGER;
    v_by    INTEGER;
    v_cnt   INTEGER;
BEGIN
    v_name  := TRIM(p_json->>'permission_name');
    v_value := (p_json->>'permission_value')::INTEGER;
    v_by    := COALESCE((p_json->>'created_by')::INTEGER, 1);
    IF v_name IS NULL OR v_name = '' THEN RAISE EXCEPTION 'Permission Name is required'; END IF;
    IF v_value IS NULL THEN RAISE EXCEPTION 'Permission Value is required'; END IF;
    SELECT COUNT(*) INTO v_cnt FROM public.permission
      WHERE lower(permission_name) = lower(v_name) AND deleted_at IS NULL;
    IF v_cnt > 0 THEN RAISE EXCEPTION 'Permission Name already exists'; END IF;
    INSERT INTO public.permission (permission_value, permission_name, is_active, created_by, created_at)
    VALUES (v_value, v_name, TRUE, v_by, CURRENT_TIMESTAMP);
END; $$;

CREATE OR REPLACE PROCEDURE public.sp_updatepermission(IN p_json jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    v_id    INTEGER;
    v_name  VARCHAR(50);
    v_value INTEGER;
    v_active BOOLEAN;
    v_by    INTEGER;
    v_cnt   INTEGER;
BEGIN
    v_id    := (p_json->>'permission_id')::INTEGER;
    v_name  := TRIM(p_json->>'permission_name');
    v_value := (p_json->>'permission_value')::INTEGER;
    v_active:= COALESCE((p_json->>'is_active')::BOOLEAN, TRUE);
    v_by    := COALESCE((p_json->>'modified_by')::INTEGER, 1);
    IF v_id IS NULL THEN RAISE EXCEPTION 'Permission ID is required'; END IF;
    IF v_name IS NULL OR v_name = '' THEN RAISE EXCEPTION 'Permission Name is required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.permission WHERE permission_id = v_id AND deleted_at IS NULL)
      THEN RAISE EXCEPTION 'Permission not found'; END IF;
    SELECT COUNT(*) INTO v_cnt FROM public.permission
      WHERE lower(permission_name) = lower(v_name) AND permission_id <> v_id AND deleted_at IS NULL;
    IF v_cnt > 0 THEN RAISE EXCEPTION 'Permission Name already exists'; END IF;
    UPDATE public.permission
      SET permission_name = v_name, permission_value = COALESCE(v_value, permission_value),
          is_active = v_active, modified_by = v_by, modified_at = CURRENT_TIMESTAMP
      WHERE permission_id = v_id;
END; $$;

CREATE OR REPLACE PROCEDURE public.sp_deletepermission(IN p_json jsonb)
LANGUAGE plpgsql AS $$
DECLARE v_id INTEGER; v_by INTEGER;
BEGIN
    v_id := (p_json->>'permission_id')::INTEGER;
    v_by := COALESCE((p_json->>'deleted_by')::INTEGER, 1);
    IF v_id IS NULL THEN RAISE EXCEPTION 'Permission ID is required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.permission WHERE permission_id = v_id AND deleted_at IS NULL)
      THEN RAISE EXCEPTION 'Permission not found'; END IF;
    UPDATE public.permission SET is_active = FALSE, deleted_by = v_by, deleted_at = CURRENT_TIMESTAMP
      WHERE permission_id = v_id;
END; $$;


-- ╔══════════════════════════ MODULE ══════════════════════════╗
CREATE OR REPLACE VIEW public.vw_module AS
SELECT module_id, org_id, module_name, module_code, module_description,
       module_route, module_icon, display_order, is_active,
       created_by, created_at, modified_by, modified_at
FROM   public.module_master
WHERE  deleted_at IS NULL;

CREATE OR REPLACE PROCEDURE public.sp_insertmodule(IN p_json jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    v_org INTEGER; v_name VARCHAR(100); v_code VARCHAR(50); v_desc VARCHAR(255);
    v_route VARCHAR(150); v_icon VARCHAR(100); v_order INTEGER; v_by INTEGER; v_cnt INTEGER;
BEGIN
    v_org   := COALESCE((p_json->>'org_id')::INTEGER, 1);
    v_name  := TRIM(p_json->>'module_name');
    v_code  := TRIM(p_json->>'module_code');
    v_desc  := p_json->>'module_description';
    v_route := p_json->>'module_route';
    v_icon  := p_json->>'module_icon';
    v_order := COALESCE((p_json->>'display_order')::INTEGER, 1);
    v_by    := COALESCE((p_json->>'created_by')::INTEGER, 1);
    IF v_name IS NULL OR v_name = '' THEN RAISE EXCEPTION 'Module Name is required'; END IF;
    IF v_code IS NULL OR v_code = '' THEN RAISE EXCEPTION 'Module Code is required'; END IF;
    SELECT COUNT(*) INTO v_cnt FROM public.module_master
      WHERE org_id = v_org AND lower(module_code) = lower(v_code) AND deleted_at IS NULL;
    IF v_cnt > 0 THEN RAISE EXCEPTION 'Module Code already exists'; END IF;
    INSERT INTO public.module_master
      (org_id, module_name, module_code, module_description, module_route, module_icon, display_order, is_active, created_by, created_at)
    VALUES (v_org, v_name, v_code, v_desc, v_route, v_icon, v_order, TRUE, v_by, CURRENT_TIMESTAMP);
END; $$;

CREATE OR REPLACE PROCEDURE public.sp_updatemodule(IN p_json jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    v_id INTEGER; v_org INTEGER; v_name VARCHAR(100); v_code VARCHAR(50); v_desc VARCHAR(255);
    v_route VARCHAR(150); v_icon VARCHAR(100); v_order INTEGER; v_active BOOLEAN; v_by INTEGER; v_cnt INTEGER;
BEGIN
    v_id    := (p_json->>'module_id')::INTEGER;
    v_name  := TRIM(p_json->>'module_name');
    v_code  := TRIM(p_json->>'module_code');
    v_desc  := p_json->>'module_description';
    v_route := p_json->>'module_route';
    v_icon  := p_json->>'module_icon';
    v_order := COALESCE((p_json->>'display_order')::INTEGER, 1);
    v_active:= COALESCE((p_json->>'is_active')::BOOLEAN, TRUE);
    v_by    := COALESCE((p_json->>'modified_by')::INTEGER, 1);
    IF v_id IS NULL THEN RAISE EXCEPTION 'Module ID is required'; END IF;
    IF v_name IS NULL OR v_name = '' THEN RAISE EXCEPTION 'Module Name is required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.module_master WHERE module_id = v_id AND deleted_at IS NULL)
      THEN RAISE EXCEPTION 'Module not found'; END IF;
    SELECT org_id INTO v_org FROM public.module_master WHERE module_id = v_id;
    SELECT COUNT(*) INTO v_cnt FROM public.module_master
      WHERE org_id = v_org AND lower(module_code) = lower(v_code) AND module_id <> v_id AND deleted_at IS NULL;
    IF v_cnt > 0 THEN RAISE EXCEPTION 'Module Code already exists'; END IF;
    UPDATE public.module_master
      SET module_name = v_name, module_code = v_code, module_description = v_desc,
          module_route = v_route, module_icon = v_icon, display_order = v_order,
          is_active = v_active, modified_by = v_by, modified_at = CURRENT_TIMESTAMP
      WHERE module_id = v_id;
END; $$;

CREATE OR REPLACE PROCEDURE public.sp_deletemodule(IN p_json jsonb)
LANGUAGE plpgsql AS $$
DECLARE v_id INTEGER; v_by INTEGER;
BEGIN
    v_id := (p_json->>'module_id')::INTEGER;
    v_by := COALESCE((p_json->>'deleted_by')::INTEGER, 1);
    IF v_id IS NULL THEN RAISE EXCEPTION 'Module ID is required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.module_master WHERE module_id = v_id AND deleted_at IS NULL)
      THEN RAISE EXCEPTION 'Module not found'; END IF;
    UPDATE public.module_master SET is_active = FALSE, deleted_by = v_by, deleted_at = CURRENT_TIMESTAMP
      WHERE module_id = v_id;
END; $$;


-- ╔══════════════════════════ PAGE ══════════════════════════╗
CREATE OR REPLACE VIEW public.vw_page AS
SELECT p.page_id, p.org_id, p.module_id, m.module_name, p.parent_id,
       par.page_name AS parent_name, p.page_name, p.page_url, p.page_code,
       p.page_description, p.icon_name, p.display_order, p.is_menu, p.is_active,
       p.created_by, p.created_at, p.modified_by, p.modified_at
FROM   public.page_master p
LEFT JOIN public.module_master m  ON m.module_id = p.module_id
LEFT JOIN public.page_master   par ON par.page_id = p.parent_id
WHERE  p.deleted_at IS NULL;

CREATE OR REPLACE PROCEDURE public.sp_insertpage(IN p_json jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    v_org INTEGER; v_module INTEGER; v_parent INTEGER; v_name VARCHAR(150);
    v_url VARCHAR(255); v_code VARCHAR(100); v_desc VARCHAR(255); v_icon VARCHAR(100);
    v_order INTEGER; v_menu BOOLEAN; v_by INTEGER; v_cnt INTEGER;
BEGIN
    v_org    := COALESCE((p_json->>'org_id')::INTEGER, 1);
    v_module := (p_json->>'module_id')::INTEGER;
    v_parent := COALESCE((p_json->>'parent_id')::INTEGER, 0);
    v_name   := TRIM(p_json->>'page_name');
    v_url    := p_json->>'page_url';
    v_code   := TRIM(p_json->>'page_code');
    v_desc   := p_json->>'page_description';
    v_icon   := p_json->>'icon_name';
    v_order  := COALESCE((p_json->>'display_order')::INTEGER, 0);
    v_menu   := COALESCE((p_json->>'is_menu')::BOOLEAN, TRUE);
    v_by     := COALESCE((p_json->>'created_by')::INTEGER, 1);
    IF v_module IS NULL THEN RAISE EXCEPTION 'Module is required'; END IF;
    IF v_name IS NULL OR v_name = '' THEN RAISE EXCEPTION 'Page Name is required'; END IF;
    IF v_code IS NULL OR v_code = '' THEN RAISE EXCEPTION 'Page Code is required'; END IF;
    SELECT COUNT(*) INTO v_cnt FROM public.page_master
      WHERE lower(page_code) = lower(v_code) AND deleted_at IS NULL;
    IF v_cnt > 0 THEN RAISE EXCEPTION 'Page Code already exists'; END IF;
    INSERT INTO public.page_master
      (org_id, module_id, parent_id, page_name, page_url, page_code, page_description, icon_name, display_order, is_menu, is_active, created_by, created_at)
    VALUES (v_org, v_module, v_parent, v_name, v_url, v_code, v_desc, v_icon, v_order, v_menu, TRUE, v_by, CURRENT_TIMESTAMP);
END; $$;

CREATE OR REPLACE PROCEDURE public.sp_updatepage(IN p_json jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    v_id INTEGER; v_module INTEGER; v_parent INTEGER; v_name VARCHAR(150);
    v_url VARCHAR(255); v_code VARCHAR(100); v_desc VARCHAR(255); v_icon VARCHAR(100);
    v_order INTEGER; v_menu BOOLEAN; v_active BOOLEAN; v_by INTEGER; v_cnt INTEGER;
BEGIN
    v_id     := (p_json->>'page_id')::INTEGER;
    v_module := (p_json->>'module_id')::INTEGER;
    v_parent := COALESCE((p_json->>'parent_id')::INTEGER, 0);
    v_name   := TRIM(p_json->>'page_name');
    v_url    := p_json->>'page_url';
    v_code   := TRIM(p_json->>'page_code');
    v_desc   := p_json->>'page_description';
    v_icon   := p_json->>'icon_name';
    v_order  := COALESCE((p_json->>'display_order')::INTEGER, 0);
    v_menu   := COALESCE((p_json->>'is_menu')::BOOLEAN, TRUE);
    v_active := COALESCE((p_json->>'is_active')::BOOLEAN, TRUE);
    v_by     := COALESCE((p_json->>'modified_by')::INTEGER, 1);
    IF v_id IS NULL THEN RAISE EXCEPTION 'Page ID is required'; END IF;
    IF v_name IS NULL OR v_name = '' THEN RAISE EXCEPTION 'Page Name is required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.page_master WHERE page_id = v_id AND deleted_at IS NULL)
      THEN RAISE EXCEPTION 'Page not found'; END IF;
    SELECT COUNT(*) INTO v_cnt FROM public.page_master
      WHERE lower(page_code) = lower(v_code) AND page_id <> v_id AND deleted_at IS NULL;
    IF v_cnt > 0 THEN RAISE EXCEPTION 'Page Code already exists'; END IF;
    UPDATE public.page_master
      SET module_id = COALESCE(v_module, module_id), parent_id = v_parent, page_name = v_name,
          page_url = v_url, page_code = v_code, page_description = v_desc, icon_name = v_icon,
          display_order = v_order, is_menu = v_menu, is_active = v_active,
          modified_by = v_by, modified_at = CURRENT_TIMESTAMP
      WHERE page_id = v_id;
END; $$;

CREATE OR REPLACE PROCEDURE public.sp_deletepage(IN p_json jsonb)
LANGUAGE plpgsql AS $$
DECLARE v_id INTEGER; v_by INTEGER;
BEGIN
    v_id := (p_json->>'page_id')::INTEGER;
    v_by := COALESCE((p_json->>'deleted_by')::INTEGER, 1);
    IF v_id IS NULL THEN RAISE EXCEPTION 'Page ID is required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.page_master WHERE page_id = v_id AND deleted_at IS NULL)
      THEN RAISE EXCEPTION 'Page not found'; END IF;
    UPDATE public.page_master SET is_active = FALSE, deleted_by = v_by, deleted_at = CURRENT_TIMESTAMP
      WHERE page_id = v_id;
END; $$;
