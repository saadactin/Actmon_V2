-- ─────────────────────────────────────────────────────────────────────────────
--  ROLE module — stored procedures (insert/update/delete) + read view
--  Mirrors the existing department_master convention (JSONB param, soft delete).
--  Safe to re-run (CREATE OR REPLACE).
-- ─────────────────────────────────────────────────────────────────────────────

-- READ: list view (joins org name; excludes soft-deleted)
CREATE OR REPLACE VIEW public.vw_role AS
SELECT r.role_id,
       r.org_id,
       o.org_name,
       r.role_name,
       r.role_description,
       r.is_active,
       r.created_by,
       r.created_at,
       r.modified_by,
       r.modified_at
FROM   public.role r
LEFT JOIN public.organization_master o ON o.org_id = r.org_id
WHERE  r.deleted_at IS NULL;


-- INSERT
CREATE OR REPLACE PROCEDURE public.sp_insertrole(IN p_json jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    v_org_id           INTEGER;
    v_role_name        VARCHAR(100);
    v_role_description VARCHAR(255);
    v_created_by       INTEGER;
    v_created_at       TIMESTAMP;
    v_count            INTEGER;
BEGIN
    v_org_id           := (p_json->>'org_id')::INTEGER;
    v_role_name        := TRIM(p_json->>'role_name');
    v_role_description := p_json->>'role_description';
    v_created_by       := COALESCE((p_json->>'created_by')::INTEGER, 1);
    v_created_at       := COALESCE((p_json->>'created_at')::TIMESTAMP, CURRENT_TIMESTAMP);

    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'Organization is required';
    END IF;
    IF v_role_name IS NULL OR v_role_name = '' THEN
        RAISE EXCEPTION 'Role Name is required';
    END IF;

    SELECT COUNT(*) INTO v_count
    FROM public.role
    WHERE org_id = v_org_id
      AND lower(role_name) = lower(v_role_name)
      AND deleted_at IS NULL;
    IF v_count > 0 THEN
        RAISE EXCEPTION 'Role Name already exists';
    END IF;

    INSERT INTO public.role (org_id, role_name, role_description, is_active, created_by, created_at)
    VALUES (v_org_id, v_role_name, v_role_description, TRUE, v_created_by, v_created_at);
END;
$$;


-- UPDATE
CREATE OR REPLACE PROCEDURE public.sp_updaterole(IN p_json jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    v_role_id          INTEGER;
    v_org_id           INTEGER;
    v_role_name        VARCHAR(100);
    v_role_description VARCHAR(255);
    v_is_active        BOOLEAN;
    v_modified_by      INTEGER;
    v_modified_at      TIMESTAMP;
    v_count            INTEGER;
BEGIN
    v_role_id          := (p_json->>'role_id')::INTEGER;
    v_org_id           := (p_json->>'org_id')::INTEGER;
    v_role_name        := TRIM(p_json->>'role_name');
    v_role_description := p_json->>'role_description';
    v_is_active        := COALESCE((p_json->>'is_active')::BOOLEAN, TRUE);
    v_modified_by      := COALESCE((p_json->>'modified_by')::INTEGER, 1);
    v_modified_at      := COALESCE((p_json->>'modified_at')::TIMESTAMP, CURRENT_TIMESTAMP);

    IF v_role_id IS NULL THEN
        RAISE EXCEPTION 'Role ID is required';
    END IF;
    IF v_role_name IS NULL OR v_role_name = '' THEN
        RAISE EXCEPTION 'Role Name is required';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.role WHERE role_id = v_role_id AND deleted_at IS NULL) THEN
        RAISE EXCEPTION 'Role not found';
    END IF;

    -- resolve org from existing row when not supplied
    IF v_org_id IS NULL THEN
        SELECT org_id INTO v_org_id FROM public.role WHERE role_id = v_role_id;
    END IF;

    SELECT COUNT(*) INTO v_count
    FROM public.role
    WHERE org_id = v_org_id
      AND lower(role_name) = lower(v_role_name)
      AND role_id <> v_role_id
      AND deleted_at IS NULL;
    IF v_count > 0 THEN
        RAISE EXCEPTION 'Role Name already exists';
    END IF;

    UPDATE public.role
    SET role_name        = v_role_name,
        role_description  = v_role_description,
        is_active         = v_is_active,
        modified_by       = v_modified_by,
        modified_at       = v_modified_at
    WHERE role_id = v_role_id;
END;
$$;


-- DELETE (soft)
CREATE OR REPLACE PROCEDURE public.sp_deleterole(IN p_json jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    v_role_id    INTEGER;
    v_deleted_by INTEGER;
    v_deleted_at TIMESTAMP;
BEGIN
    v_role_id    := (p_json->>'role_id')::INTEGER;
    v_deleted_by := COALESCE((p_json->>'deleted_by')::INTEGER, 1);
    v_deleted_at := COALESCE((p_json->>'deleted_at')::TIMESTAMP, CURRENT_TIMESTAMP);

    IF v_role_id IS NULL THEN
        RAISE EXCEPTION 'Role ID is required';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.role WHERE role_id = v_role_id AND deleted_at IS NULL) THEN
        RAISE EXCEPTION 'Role not found';
    END IF;

    UPDATE public.role
    SET is_active  = FALSE,
        deleted_by = v_deleted_by,
        deleted_at = v_deleted_at
    WHERE role_id = v_role_id;
END;
$$;
