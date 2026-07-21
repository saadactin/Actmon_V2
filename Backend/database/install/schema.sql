--
-- PostgreSQL database dump
--

\restrict xq2jbzebJI9iCM4Ek5E8GaKT37ffTATQVNZATdKoCbTCat68IlBR25go29GMNhH

-- Dumped from database version 17.9
-- Dumped by pg_dump version 17.9

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pg_stat_statements; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public;


--
-- Name: EXTENSION pg_stat_statements; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_stat_statements IS 'track planning and execution statistics of all SQL statements executed';


--
-- Name: fn_audit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_pk     TEXT := TG_ARGV[0];
    v_user   INTEGER := NULLIF(current_setting('app.user_id', true), '')::INTEGER;
    v_ip     TEXT    := NULLIF(current_setting('app.ip', true), '');
    v_ua     TEXT    := NULLIF(current_setting('app.user_agent', true), '');
    v_old    JSONB;
    v_new    JSONB;
    v_rec    BIGINT;
    v_org    INTEGER;
    v_action TEXT := TG_OP;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_old := to_jsonb(OLD) - 'password_hash';
        v_rec := (to_jsonb(OLD) ->> v_pk)::BIGINT;
    ELSIF TG_OP = 'UPDATE' THEN
        v_old := to_jsonb(OLD) - 'password_hash';
        v_new := to_jsonb(NEW) - 'password_hash';
        v_rec := (to_jsonb(NEW) ->> v_pk)::BIGINT;
        IF (to_jsonb(OLD) ->> 'deleted_at') IS NULL AND (to_jsonb(NEW) ->> 'deleted_at') IS NOT NULL THEN
            v_action := 'DELETE';   -- soft delete
        END IF;
    ELSE  -- INSERT
        v_new := to_jsonb(NEW) - 'password_hash';
        v_rec := (to_jsonb(NEW) ->> v_pk)::BIGINT;
    END IF;

    v_org := COALESCE((to_jsonb(COALESCE(NEW, OLD)) ->> 'org_id')::INTEGER,
                      NULLIF(current_setting('app.org_id', true), '')::INTEGER);

    INSERT INTO public.audit_log
        (org_id, user_id, table_name, record_id, action_type, old_data, new_data, ip_address, user_agent, created_at)
    VALUES
        (v_org, v_user, TG_TABLE_NAME, v_rec, v_action, v_old, v_new, v_ip, v_ua, CURRENT_TIMESTAMP);

    RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: sp_deletedepartment(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_deletedepartment(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_department_id   INTEGER;
    v_deleted_by      INTEGER;
    v_deleted_at      TIMESTAMP;
BEGIN

    -- Read JSON

    v_department_id := (p_json->>'department_id')::INTEGER;
    v_deleted_by    := (p_json->>'deleted_by')::INTEGER;
    v_deleted_at    := COALESCE(
                          (p_json->>'deleted_at')::TIMESTAMP,
                          CURRENT_TIMESTAMP
                       );

    -- Validation

    IF v_department_id IS NULL THEN
        RAISE EXCEPTION 'Department ID is required';
    END IF;

    IF NOT EXISTS
    (
        SELECT 1
        FROM department_master
        WHERE department_id = v_department_id
          AND is_active = TRUE
    )
    THEN
        RAISE EXCEPTION 'Department not found';
    END IF;

    -- Soft Delete

    UPDATE department_master
    SET
        is_active = FALSE,
        deleted_by = v_deleted_by,
        deleted_at = v_deleted_at
    WHERE department_id = v_department_id;

    -- Success

    SELECT
        TRUE AS status,
        'Department deleted successfully.' AS message;

END;
$$;


--
-- Name: sp_deletedesignation(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_deletedesignation(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
DECLARE v_id INTEGER; v_by INTEGER;
BEGIN
    v_id := (p_json->>'designation_id')::INTEGER; v_by := COALESCE((p_json->>'deleted_by')::INTEGER,1);
    IF v_id IS NULL THEN RAISE EXCEPTION 'Designation ID is required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.designation_master WHERE designation_id=v_id AND deleted_at IS NULL)
      THEN RAISE EXCEPTION 'Designation not found'; END IF;
    UPDATE public.designation_master SET is_active=FALSE, deleted_by=v_by, deleted_at=CURRENT_TIMESTAMP WHERE designation_id=v_id;
END; $$;


--
-- Name: sp_deleteemployee(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_deleteemployee(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
DECLARE v_id INTEGER; v_by INTEGER;
BEGIN
    v_id := (p_json->>'employee_id')::INTEGER; v_by := COALESCE((p_json->>'deleted_by')::INTEGER,1);
    IF v_id IS NULL THEN RAISE EXCEPTION 'Employee ID is required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.employee_master WHERE employee_id=v_id AND deleted_at IS NULL)
      THEN RAISE EXCEPTION 'Employee not found'; END IF;
    UPDATE public.employee_master SET is_active=FALSE, deleted_by=v_by, deleted_at=CURRENT_TIMESTAMP WHERE employee_id=v_id;
END; $$;


--
-- Name: sp_deletemodule(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_deletemodule(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: sp_deleteorganization(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_deleteorganization(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
DECLARE v_id INTEGER; v_by INTEGER;
BEGIN
    v_id := (p_json->>'org_id')::INTEGER; v_by := COALESCE((p_json->>'deleted_by')::INTEGER,1);
    IF v_id IS NULL THEN RAISE EXCEPTION 'Organization ID is required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.organization_master WHERE org_id=v_id AND deleted_at IS NULL)
      THEN RAISE EXCEPTION 'Organization not found'; END IF;
    UPDATE public.organization_master SET is_active=FALSE, deleted_by=v_by, deleted_at=CURRENT_TIMESTAMP WHERE org_id=v_id;
END; $$;


--
-- Name: sp_deletepage(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_deletepage(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: sp_deletepermission(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_deletepermission(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: sp_deleterole(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_deleterole(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: sp_deleterolepermission(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_deleterolepermission(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: sp_deleteuser(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_deleteuser(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
DECLARE v_id INTEGER; v_by INTEGER;
BEGIN
    v_id := (p_json->>'user_id')::INTEGER; v_by := COALESCE((p_json->>'deleted_by')::INTEGER,1);
    IF v_id IS NULL THEN RAISE EXCEPTION 'User ID is required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.user_master WHERE user_id=v_id AND deleted_at IS NULL)
      THEN RAISE EXCEPTION 'User not found'; END IF;
    UPDATE public.user_master SET is_active=FALSE, deleted_by=v_by, deleted_at=CURRENT_TIMESTAMP WHERE user_id=v_id;
END; $$;


--
-- Name: sp_getdepartment(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_getdepartment(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_org_id INTEGER;
BEGIN

    v_org_id := (p_json->>'org_id')::INTEGER;

    SELECT
        department_id,
        org_id,
        department_code,
        department_name,
        description,
        is_active,
        created_by,
        created_at,
        modified_by,
        modified_at
    FROM department_master
    WHERE org_id = v_org_id
      AND is_active = TRUE
    ORDER BY department_name;

END;
$$;


--
-- Name: sp_getdepartmentbyid(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_getdepartmentbyid(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_department_id INTEGER;
BEGIN

    v_department_id := (p_json->>'department_id')::INTEGER;

    SELECT
        json_build_object
        (
            'department_id', department_id,
            'org_id', org_id,
            'department_code', department_code,
            'department_name', department_name,
            'description', description,
            'is_active', is_active,
            'created_by', created_by,
            'created_at', created_at,
            'modified_by', modified_by,
            'modified_at', modified_at
        ) AS department
    FROM department_master
    WHERE department_id = v_department_id
      AND is_active = TRUE;

END;
$$;


--
-- Name: sp_insertdepartment(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_insertdepartment(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_org_id            INTEGER;
    v_department_code   VARCHAR(50);
    v_department_name   VARCHAR(150);
    v_description       VARCHAR(250);
    v_created_by        INTEGER;
    v_created_at        TIMESTAMP;
    v_count             INTEGER;
BEGIN

    -- Read JSON

    v_org_id          := (p_json->>'org_id')::INTEGER;
    v_department_code := TRIM(p_json->>'department_code');
    v_department_name := TRIM(p_json->>'department_name');
    v_description     := p_json->>'description';
    v_created_by      := (p_json->>'created_by')::INTEGER;
    v_created_at      := COALESCE(
                            (p_json->>'created_at')::TIMESTAMP,
                            CURRENT_TIMESTAMP
                         );

    -- Validation

    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'Organization is required';
    END IF;

    IF v_department_code IS NULL OR v_department_code='' THEN
        RAISE EXCEPTION 'Department Code is required';
    END IF;

    IF v_department_name IS NULL OR v_department_name='' THEN
        RAISE EXCEPTION 'Department Name is required';
    END IF;

    -- Duplicate Code

    SELECT COUNT(*)
    INTO v_count
    FROM department_master
    WHERE org_id = v_org_id
      AND department_code = v_department_code
      AND deleted_at IS NULL;

    IF v_count > 0 THEN
        RAISE EXCEPTION 'Department Code already exists';
    END IF;

    -- Insert

    INSERT INTO department_master
    (
        org_id,
        department_code,
        department_name,
        description,
        is_active,
        created_by,
        created_at
    )
    VALUES
    (
        v_org_id,
        v_department_code,
        v_department_name,
        v_description,
        TRUE,
        v_created_by,
        v_created_at
    );

END;
$$;


--
-- Name: sp_insertdesignation(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_insertdesignation(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
DECLARE v_org INTEGER; v_code VARCHAR(50); v_name VARCHAR(100); v_desc VARCHAR(255); v_by INTEGER; v_cnt INTEGER;
BEGIN
    v_org := COALESCE((p_json->>'org_id')::INTEGER, 1);
    v_code := TRIM(p_json->>'designation_code');
    v_name := TRIM(p_json->>'designation_name');
    v_desc := p_json->>'description';
    v_by := COALESCE((p_json->>'created_by')::INTEGER, 1);
    IF v_code IS NULL OR v_code='' THEN RAISE EXCEPTION 'Designation Code is required'; END IF;
    IF v_name IS NULL OR v_name='' THEN RAISE EXCEPTION 'Designation Name is required'; END IF;
    SELECT COUNT(*) INTO v_cnt FROM public.designation_master
      WHERE org_id=v_org AND lower(designation_code)=lower(v_code) AND deleted_at IS NULL;
    IF v_cnt>0 THEN RAISE EXCEPTION 'Designation Code already exists'; END IF;
    INSERT INTO public.designation_master (org_id, designation_code, designation_name, description, is_active, created_by, created_at)
    VALUES (v_org, v_code, v_name, v_desc, TRUE, v_by, CURRENT_TIMESTAMP);
END; $$;


--
-- Name: sp_insertemployee(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_insertemployee(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $_$
DECLARE v_org INTEGER; v_code VARCHAR(50); v_name VARCHAR(150); v_by INTEGER; v_cnt INTEGER;
        v_prefix TEXT; v_num INTEGER;
BEGIN
    v_org := COALESCE((p_json->>'org_id')::INTEGER, 1);
    v_code := TRIM(p_json->>'employee_code');
    v_name := TRIM(p_json->>'employee_name');
    v_by := COALESCE((p_json->>'created_by')::INTEGER, 1);
    IF v_name IS NULL OR v_name='' THEN RAISE EXCEPTION 'Employee Name is required'; END IF;
    IF v_code IS NULL OR v_code = '' THEN
        SELECT (regexp_match(employee_code, '^([A-Za-z]+)'))[1] INTO v_prefix
          FROM public.employee_master
         WHERE org_id = v_org AND employee_code ~ '^[A-Za-z]+[0-9]+$'
         ORDER BY created_at DESC NULLS LAST, employee_id DESC LIMIT 1;
        v_prefix := COALESCE(v_prefix, 'ACT');
        -- MAX over ALL rows (incl. soft-deleted): uk_employee_org_code spans deleted rows
        -- too, so regenerating a soft-deleted code would violate the constraint.
        SELECT COALESCE(MAX((regexp_match(employee_code, '([0-9]+)$'))[1]::INTEGER), 0) + 1 INTO v_num
          FROM public.employee_master
         WHERE org_id = v_org AND employee_code ~ ('^' || v_prefix || '[0-9]+$');
        v_code := v_prefix || LPAD(v_num::TEXT, 3, '0');
        -- Defensive: skip any lingering code (incl. soft-deleted) so INSERT never trips uk_employee_org_code.
        WHILE EXISTS (SELECT 1 FROM public.employee_master
                       WHERE org_id=v_org AND lower(employee_code)=lower(v_code)) LOOP
            v_num := v_num + 1;
            v_code := v_prefix || LPAD(v_num::TEXT, 3, '0');
        END LOOP;
    END IF;
    -- Check against ALL rows — the unique constraint counts soft-deleted rows, so a
    -- NULL-only check would pass here and then fail hard at INSERT.
    SELECT COUNT(*) INTO v_cnt FROM public.employee_master WHERE org_id=v_org AND lower(employee_code)=lower(v_code);
    IF v_cnt>0 THEN RAISE EXCEPTION 'Employee Code already exists'; END IF;
    INSERT INTO public.employee_master
      (org_id, employee_code, employee_name, email_id, mobile_no, department_id, designation_id,
       joining_date, reporting_manager_id, employment_status_id, is_active, created_by, created_at)
    VALUES (v_org, v_code, v_name, p_json->>'email_id', p_json->>'mobile_no',
       (p_json->>'department_id')::INTEGER, (p_json->>'designation_id')::INTEGER,
       (p_json->>'joining_date')::DATE, (p_json->>'reporting_manager_id')::INTEGER,
       COALESCE((p_json->>'employment_status_id')::INTEGER, 1), TRUE, v_by, CURRENT_TIMESTAMP);
END; $_$;


--
-- Name: sp_insertmodule(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_insertmodule(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: sp_insertorganization(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_insertorganization(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
DECLARE v_code VARCHAR(50); v_name VARCHAR(150); v_by INTEGER; v_cnt INTEGER;
BEGIN
    v_code := TRIM(p_json->>'org_code');
    v_name := TRIM(p_json->>'org_name');
    v_by   := COALESCE((p_json->>'created_by')::INTEGER, 1);
    IF v_code IS NULL OR v_code='' THEN RAISE EXCEPTION 'Organization Code is required'; END IF;
    IF v_name IS NULL OR v_name='' THEN RAISE EXCEPTION 'Organization Name is required'; END IF;
    SELECT COUNT(*) INTO v_cnt FROM public.organization_master WHERE lower(org_code)=lower(v_code) AND deleted_at IS NULL;
    IF v_cnt>0 THEN RAISE EXCEPTION 'Organization Code already exists'; END IF;
    INSERT INTO public.organization_master
      (parent_org_id, org_code, org_name, legal_name, gst_number, pan_number, registration_no,
       contact_person_name, contact_no, alternate_contact_no, email_id, website_url, logo_path,
       country_name, state_name, city_name, address_line1, address_line2, pincode, status_id, is_active, created_by, created_at)
    VALUES
      (COALESCE((p_json->>'parent_org_id')::INTEGER, 1), v_code, v_name,
       COALESCE(NULLIF(TRIM(p_json->>'legal_name'),''), v_name),
       p_json->>'gst_number', p_json->>'pan_number', p_json->>'registration_no',
       p_json->>'contact_person_name', COALESCE(p_json->>'contact_no',''), p_json->>'alternate_contact_no',
       COALESCE(p_json->>'email_id',''), p_json->>'website_url', p_json->>'logo_path',
       COALESCE(p_json->>'country_name','India'), COALESCE(p_json->>'state_name',''), COALESCE(p_json->>'city_name',''),
       p_json->>'address_line1', p_json->>'address_line2', p_json->>'pincode',
       COALESCE((p_json->>'status_id')::INTEGER, 1), TRUE, v_by, CURRENT_TIMESTAMP);
END; $$;


--
-- Name: sp_insertpage(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_insertpage(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: sp_insertpermission(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_insertpermission(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: sp_insertrole(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_insertrole(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: sp_insertrolepermission(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_insertrolepermission(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: sp_insertuser(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_insertuser(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
DECLARE v_org INTEGER; v_role INTEGER; v_emp INTEGER; v_uname VARCHAR(100); v_pwd VARCHAR(255); v_by INTEGER; v_cnt INTEGER;
BEGIN
    v_org   := COALESCE((p_json->>'org_id')::INTEGER, 1);
    v_role  := (p_json->>'role_id')::INTEGER;
    v_emp   := (p_json->>'employee_id')::INTEGER;
    v_uname := TRIM(p_json->>'user_name');
    v_pwd   := COALESCE(NULLIF(TRIM(p_json->>'password_hash'),''), 'Admin@123');
    v_by    := COALESCE((p_json->>'created_by')::INTEGER, 1);
    IF v_uname IS NULL OR v_uname='' THEN RAISE EXCEPTION 'Username is required'; END IF;
    IF v_role IS NULL THEN RAISE EXCEPTION 'Role is required'; END IF;
    IF v_emp  IS NULL THEN RAISE EXCEPTION 'Employee is required'; END IF;
    SELECT COUNT(*) INTO v_cnt FROM public.user_master WHERE lower(user_name)=lower(v_uname) AND deleted_at IS NULL;
    IF v_cnt>0 THEN RAISE EXCEPTION 'Username already exists'; END IF;
    INSERT INTO public.user_master (org_id, role_id, user_name, password_hash, employee_id, is_active, account_locked, created_by, created_at)
    VALUES (v_org, v_role, v_uname, v_pwd, v_emp, TRUE, FALSE, v_by, CURRENT_TIMESTAMP);
END; $$;


--
-- Name: sp_updatedepartment(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_updatedepartment(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_department_id     INTEGER;
    v_org_id            INTEGER;
    v_department_code   VARCHAR(50);
    v_department_name   VARCHAR(150);
    v_description       VARCHAR(250);
    v_modified_by       INTEGER;
    v_modified_at       TIMESTAMP;
    v_count             INTEGER;
BEGIN

    -- Read JSON

    v_department_id   := (p_json->>'department_id')::INTEGER;
    v_org_id          := (p_json->>'org_id')::INTEGER;
    v_department_code := TRIM(p_json->>'department_code');
    v_department_name := TRIM(p_json->>'department_name');
    v_description     := p_json->>'description';
    v_modified_by     := (p_json->>'modified_by')::INTEGER;
    v_modified_at     := COALESCE(
                            (p_json->>'modified_at')::TIMESTAMP,
                            CURRENT_TIMESTAMP
                         );

    -- Validation

    IF v_department_id IS NULL THEN
        RAISE EXCEPTION 'Department ID is required';
    END IF;

    IF v_department_code IS NULL OR v_department_code = '' THEN
        RAISE EXCEPTION 'Department Code is required';
    END IF;

    IF v_department_name IS NULL OR v_department_name = '' THEN
        RAISE EXCEPTION 'Department Name is required';
    END IF;

    -- Department Exists

    IF NOT EXISTS
    (
        SELECT 1
        FROM department_master
        WHERE department_id = v_department_id
          AND is_active = TRUE
    )
    THEN
        RAISE EXCEPTION 'Department not found';
    END IF;

    -- Duplicate Code

    SELECT COUNT(*)
    INTO v_count
    FROM department_master
    WHERE org_id = v_org_id
      AND department_code = v_department_code
      AND department_id <> v_department_id
      AND deleted_at IS NULL;

    IF v_count > 0 THEN
        RAISE EXCEPTION 'Department Code already exists';
    END IF;

    -- Duplicate Name

    SELECT COUNT(*)
    INTO v_count
    FROM department_master
    WHERE org_id = v_org_id
      AND department_name = v_department_name
      AND department_id <> v_department_id
      AND deleted_at IS NULL;

    IF v_count > 0 THEN
        RAISE EXCEPTION 'Department Name already exists';
    END IF;

    -- Update

    UPDATE department_master
    SET
        department_code = v_department_code,
        department_name = v_department_name,
        description     = v_description,
        modified_by     = v_modified_by,
        modified_at     = v_modified_at
    WHERE department_id = v_department_id;

    -- Success

    SELECT
        TRUE AS status,
        'Department updated successfully.' AS message;

END;
$$;


--
-- Name: sp_updatedesignation(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_updatedesignation(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
DECLARE v_id INTEGER; v_org INTEGER; v_code VARCHAR(50); v_name VARCHAR(100); v_desc VARCHAR(255); v_active BOOLEAN; v_by INTEGER; v_cnt INTEGER;
BEGIN
    v_id := (p_json->>'designation_id')::INTEGER;
    v_code := TRIM(p_json->>'designation_code');
    v_name := TRIM(p_json->>'designation_name');
    v_desc := p_json->>'description';
    v_active := COALESCE((p_json->>'is_active')::BOOLEAN, TRUE);
    v_by := COALESCE((p_json->>'modified_by')::INTEGER, 1);
    IF v_id IS NULL THEN RAISE EXCEPTION 'Designation ID is required'; END IF;
    IF v_name IS NULL OR v_name='' THEN RAISE EXCEPTION 'Designation Name is required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.designation_master WHERE designation_id=v_id AND deleted_at IS NULL)
      THEN RAISE EXCEPTION 'Designation not found'; END IF;
    SELECT org_id INTO v_org FROM public.designation_master WHERE designation_id=v_id;
    SELECT COUNT(*) INTO v_cnt FROM public.designation_master
      WHERE org_id=v_org AND lower(designation_code)=lower(v_code) AND designation_id<>v_id AND deleted_at IS NULL;
    IF v_cnt>0 THEN RAISE EXCEPTION 'Designation Code already exists'; END IF;
    UPDATE public.designation_master
      SET designation_code=v_code, designation_name=v_name, description=v_desc,
          is_active=v_active, modified_by=v_by, modified_at=CURRENT_TIMESTAMP
      WHERE designation_id=v_id;
END; $$;


--
-- Name: sp_updateemployee(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_updateemployee(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
DECLARE v_id INTEGER; v_org INTEGER; v_code VARCHAR(50); v_name VARCHAR(150); v_active BOOLEAN; v_by INTEGER; v_cnt INTEGER;
BEGIN
    v_id := (p_json->>'employee_id')::INTEGER;
    v_code := TRIM(p_json->>'employee_code');
    v_name := TRIM(p_json->>'employee_name');
    v_active := COALESCE((p_json->>'is_active')::BOOLEAN, TRUE);
    v_by := COALESCE((p_json->>'modified_by')::INTEGER, 1);
    IF v_id IS NULL THEN RAISE EXCEPTION 'Employee ID is required'; END IF;
    IF v_name IS NULL OR v_name='' THEN RAISE EXCEPTION 'Employee Name is required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.employee_master WHERE employee_id=v_id AND deleted_at IS NULL)
      THEN RAISE EXCEPTION 'Employee not found'; END IF;
    SELECT org_id INTO v_org FROM public.employee_master WHERE employee_id=v_id;
    SELECT COUNT(*) INTO v_cnt FROM public.employee_master
      WHERE org_id=v_org AND lower(employee_code)=lower(v_code) AND employee_id<>v_id AND deleted_at IS NULL;
    IF v_cnt>0 THEN RAISE EXCEPTION 'Employee Code already exists'; END IF;
    UPDATE public.employee_master SET
       employee_code=v_code, employee_name=v_name, email_id=p_json->>'email_id', mobile_no=p_json->>'mobile_no',
       department_id=(p_json->>'department_id')::INTEGER, designation_id=(p_json->>'designation_id')::INTEGER,
       joining_date=(p_json->>'joining_date')::DATE, reporting_manager_id=(p_json->>'reporting_manager_id')::INTEGER,
       employment_status_id=COALESCE((p_json->>'employment_status_id')::INTEGER, employment_status_id),
       is_active=v_active, modified_by=v_by, modified_at=CURRENT_TIMESTAMP
      WHERE employee_id=v_id;
END; $$;


--
-- Name: sp_updatemodule(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_updatemodule(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: sp_updateorganization(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_updateorganization(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
DECLARE v_id INTEGER; v_code VARCHAR(50); v_name VARCHAR(150); v_active BOOLEAN; v_by INTEGER; v_cnt INTEGER;
BEGIN
    v_id := (p_json->>'org_id')::INTEGER;
    v_code := TRIM(p_json->>'org_code');
    v_name := TRIM(p_json->>'org_name');
    v_active := COALESCE((p_json->>'is_active')::BOOLEAN, TRUE);
    v_by := COALESCE((p_json->>'modified_by')::INTEGER, 1);
    IF v_id IS NULL THEN RAISE EXCEPTION 'Organization ID is required'; END IF;
    IF v_name IS NULL OR v_name='' THEN RAISE EXCEPTION 'Organization Name is required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.organization_master WHERE org_id=v_id AND deleted_at IS NULL)
      THEN RAISE EXCEPTION 'Organization not found'; END IF;
    SELECT COUNT(*) INTO v_cnt FROM public.organization_master
      WHERE lower(org_code)=lower(v_code) AND org_id<>v_id AND deleted_at IS NULL;
    IF v_cnt>0 THEN RAISE EXCEPTION 'Organization Code already exists'; END IF;
    UPDATE public.organization_master SET
       org_code=v_code, org_name=v_name,
       legal_name=COALESCE(NULLIF(TRIM(p_json->>'legal_name'),''), legal_name),
       gst_number=p_json->>'gst_number', pan_number=p_json->>'pan_number', registration_no=p_json->>'registration_no',
       contact_person_name=p_json->>'contact_person_name', contact_no=COALESCE(p_json->>'contact_no', contact_no),
       alternate_contact_no=p_json->>'alternate_contact_no', email_id=COALESCE(p_json->>'email_id', email_id),
       website_url=p_json->>'website_url', logo_path=COALESCE(p_json->>'logo_path', logo_path),
       country_name=COALESCE(p_json->>'country_name', country_name), state_name=COALESCE(p_json->>'state_name', state_name),
       city_name=COALESCE(p_json->>'city_name', city_name), address_line1=p_json->>'address_line1',
       address_line2=p_json->>'address_line2', pincode=p_json->>'pincode',
       status_id=COALESCE((p_json->>'status_id')::INTEGER, status_id), is_active=v_active,
       modified_by=v_by, modified_at=CURRENT_TIMESTAMP
      WHERE org_id=v_id;
END; $$;


--
-- Name: sp_updatepage(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_updatepage(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: sp_updatepermission(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_updatepermission(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: sp_updaterole(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_updaterole(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: sp_updaterolepermission(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_updaterolepermission(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: sp_updateuser(jsonb); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.sp_updateuser(IN p_json jsonb)
    LANGUAGE plpgsql
    AS $$
DECLARE v_id INTEGER; v_role INTEGER; v_emp INTEGER; v_uname VARCHAR(100); v_active BOOLEAN; v_locked BOOLEAN; v_by INTEGER; v_cnt INTEGER;
BEGIN
    v_id := (p_json->>'user_id')::INTEGER;
    v_role := (p_json->>'role_id')::INTEGER;
    v_emp := (p_json->>'employee_id')::INTEGER;
    v_uname := TRIM(p_json->>'user_name');
    v_active := COALESCE((p_json->>'is_active')::BOOLEAN, TRUE);
    v_locked := COALESCE((p_json->>'account_locked')::BOOLEAN, FALSE);
    v_by := COALESCE((p_json->>'modified_by')::INTEGER, 1);
    IF v_id IS NULL THEN RAISE EXCEPTION 'User ID is required'; END IF;
    IF v_uname IS NULL OR v_uname='' THEN RAISE EXCEPTION 'Username is required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.user_master WHERE user_id=v_id AND deleted_at IS NULL)
      THEN RAISE EXCEPTION 'User not found'; END IF;
    SELECT COUNT(*) INTO v_cnt FROM public.user_master WHERE lower(user_name)=lower(v_uname) AND user_id<>v_id AND deleted_at IS NULL;
    IF v_cnt>0 THEN RAISE EXCEPTION 'Username already exists'; END IF;
    UPDATE public.user_master SET
       user_name=v_uname, role_id=COALESCE(v_role, role_id), employee_id=COALESCE(v_emp, employee_id),
       is_active=v_active, account_locked=v_locked,
       password_hash=COALESCE(NULLIF(TRIM(p_json->>'password_hash'),''), password_hash),
       modified_by=v_by, modified_at=CURRENT_TIMESTAMP
      WHERE user_id=v_id;
END; $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_db_targets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_db_targets (
    id integer NOT NULL,
    token character varying(128) NOT NULL,
    db_type character varying(50) NOT NULL,
    connection_name character varying(255),
    host character varying(255),
    port integer,
    username character varying(255),
    password character varying(500),
    database_name character varying(255),
    environment character varying(100),
    enabled boolean,
    created_at timestamp with time zone DEFAULT now(),
    connection_id integer
);


--
-- Name: agent_db_targets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_db_targets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_db_targets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_db_targets_id_seq OWNED BY public.agent_db_targets.id;


--
-- Name: agent_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_metrics (
    id integer NOT NULL,
    agent_name character varying(255) NOT NULL,
    "timestamp" timestamp with time zone DEFAULT now(),
    host_cpu double precision,
    host_memory double precision,
    db_cpu double precision,
    active_sessions integer,
    connections_used integer,
    connections_max integer,
    cache_hit_pct double precision,
    qps double precision,
    tps double precision,
    uptime_seconds bigint,
    org_id integer DEFAULT 1 NOT NULL
);


--
-- Name: agent_metrics_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_metrics_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_metrics_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_metrics_id_seq OWNED BY public.agent_metrics.id;


--
-- Name: agent_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_notifications (
    id integer NOT NULL,
    agent_name character varying(255) NOT NULL,
    message text NOT NULL,
    severity character varying(50),
    is_read boolean,
    created_at timestamp with time zone DEFAULT now(),
    org_id integer DEFAULT 1 NOT NULL
);


--
-- Name: agent_notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_notifications_id_seq OWNED BY public.agent_notifications.id;


--
-- Name: agent_oracle_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_oracle_snapshots (
    id integer NOT NULL,
    agent_name character varying(255) NOT NULL,
    captured_at timestamp with time zone DEFAULT now(),
    version character varying(500),
    instance_name character varying(255),
    startup_time character varying(255),
    sga_size_bytes bigint,
    pga_size_bytes bigint,
    log_mode character varying(100),
    archiver character varying(100),
    status character varying(100),
    open_mode character varying(100),
    database_status character varying(100),
    instance_role character varying(100),
    org_id integer DEFAULT 1 NOT NULL
);


--
-- Name: agent_oracle_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_oracle_snapshots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_oracle_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_oracle_snapshots_id_seq OWNED BY public.agent_oracle_snapshots.id;


--
-- Name: agent_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_sessions (
    id integer NOT NULL,
    agent_name character varying(255) NOT NULL,
    captured_at timestamp with time zone DEFAULT now(),
    session_id character varying(64),
    username character varying(255),
    db_name character varying(255),
    client_host character varying(255),
    state character varying(100),
    command character varying(255),
    duration_ms double precision,
    query text
);


--
-- Name: agent_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_sessions_id_seq OWNED BY public.agent_sessions.id;


--
-- Name: agent_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_snapshots (
    id integer NOT NULL,
    agent_name character varying(255) NOT NULL,
    connection_id integer,
    snapshot_type character varying(100) NOT NULL,
    captured_at timestamp with time zone DEFAULT now(),
    payload text NOT NULL,
    org_id integer DEFAULT 1 NOT NULL
);


--
-- Name: agent_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_snapshots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_snapshots_id_seq OWNED BY public.agent_snapshots.id;


--
-- Name: agent_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_tokens (
    id integer NOT NULL,
    token character varying(128) NOT NULL,
    token_name character varying(255),
    agent_name character varying(255),
    os_type character varying(50),
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: agent_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_tokens_id_seq OWNED BY public.agent_tokens.id;


--
-- Name: agent_top_sql; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_top_sql (
    id integer NOT NULL,
    agent_name character varying(255) NOT NULL,
    captured_at timestamp with time zone DEFAULT now(),
    sql_id character varying(64),
    sql_text text,
    executions integer,
    avg_elapsed_ms double precision,
    cpu_time_ms double precision,
    buffer_gets bigint,
    total_ms double precision,
    max_ms double precision,
    rows_examined double precision,
    rows_sent double precision,
    org_id integer DEFAULT 1 NOT NULL
);


--
-- Name: agent_top_sql_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_top_sql_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_top_sql_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_top_sql_id_seq OWNED BY public.agent_top_sql.id;


--
-- Name: agent_wait_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_wait_events (
    id integer NOT NULL,
    agent_name character varying(255) NOT NULL,
    captured_at timestamp with time zone DEFAULT now(),
    event_name character varying(500),
    wait_class character varying(255),
    time_waited_ms double precision,
    avg_ms double precision,
    count integer,
    org_id integer DEFAULT 1 NOT NULL
);


--
-- Name: agent_wait_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_wait_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_wait_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_wait_events_id_seq OWNED BY public.agent_wait_events.id;


--
-- Name: agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agents (
    id integer NOT NULL,
    agent_name character varying(255) NOT NULL,
    db_connection_id integer,
    db_type character varying(100) NOT NULL,
    hostname character varying(500),
    ip_address character varying(100),
    os_type character varying(100),
    description text,
    environment character varying(100),
    status character varying(50),
    last_error text,
    last_heartbeat timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    collection_interval_sec integer,
    org_id integer DEFAULT 1 NOT NULL
);


--
-- Name: agents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agents_id_seq OWNED BY public.agents.id;


--
-- Name: alert_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alert_rules (
    id integer NOT NULL,
    org_id integer,
    name character varying(200) NOT NULL,
    description text,
    metric character varying(50) NOT NULL,
    operator character varying(10),
    threshold double precision,
    scope_type character varying(20),
    scope_value character varying(200),
    severity character varying(20),
    duration_seconds integer,
    cooldown_seconds integer,
    enabled boolean,
    created_at timestamp without time zone,
    updated_at timestamp without time zone
);


--
-- Name: alert_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.alert_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: alert_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.alert_rules_id_seq OWNED BY public.alert_rules.id;


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    audit_id bigint NOT NULL,
    org_id integer,
    user_id integer,
    table_name character varying(150) NOT NULL,
    record_id bigint,
    action_type character varying(20) NOT NULL,
    old_data jsonb,
    new_data jsonb,
    ip_address character varying(50),
    user_agent text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: audit_log_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.audit_log ALTER COLUMN audit_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.audit_log_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: backup_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backup_jobs (
    id integer NOT NULL,
    uuid character varying(36) NOT NULL,
    connection_id integer NOT NULL,
    db_host character varying(255),
    db_port integer,
    db_name character varying(255),
    backup_type character varying(30),
    compress character varying(5),
    status character varying(20),
    size_bytes bigint,
    file_path character varying(1000),
    binlog_file character varying(255),
    binlog_pos bigint,
    backup_start timestamp without time zone,
    backup_end timestamp without time zone,
    error_msg text,
    notes text,
    created_at timestamp without time zone DEFAULT now(),
    org_id integer DEFAULT 1 NOT NULL
);


--
-- Name: backup_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.backup_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: backup_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.backup_jobs_id_seq OWNED BY public.backup_jobs.id;


--
-- Name: backup_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backup_schedules (
    id integer NOT NULL,
    conn_id integer NOT NULL,
    name character varying(200) NOT NULL,
    backup_type character varying(20),
    databases character varying(500),
    compress boolean,
    custom_storage_path character varying(500),
    retain_days integer,
    notes character varying(500),
    schedule_type character varying(20),
    interval_minutes integer,
    minute integer,
    hour integer,
    day_of_week character varying(20),
    day_of_month integer,
    enabled boolean,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    last_run_at timestamp without time zone,
    next_run_at timestamp without time zone,
    last_job_id integer,
    last_status character varying(20),
    org_id integer DEFAULT 1 NOT NULL
);


--
-- Name: backup_schedules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.backup_schedules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: backup_schedules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.backup_schedules_id_seq OWNED BY public.backup_schedules.id;


--
-- Name: cloud_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_accounts (
    id uuid NOT NULL,
    account_name character varying(255) NOT NULL,
    provider character varying(50) NOT NULL,
    environment character varying(50) NOT NULL,
    tenant_or_region character varying(255) NOT NULL,
    auth_mode character varying(50) NOT NULL,
    auto_discovery boolean NOT NULL,
    credentials_enc text NOT NULL,
    last_discovery timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: cloud_resources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_resources (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    provider_resource_id character varying(512) NOT NULL,
    resource_type character varying(100) NOT NULL,
    resource_name character varying(512) NOT NULL,
    region_or_zone character varying(100) NOT NULL,
    status character varying(50),
    ip_address character varying(100),
    config jsonb,
    metadata jsonb,
    cost_monthly double precision,
    tags jsonb,
    raw_data jsonb,
    discovered_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: connection_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connection_master (
    id integer NOT NULL,
    connection_name character varying(255),
    db_type character varying(100),
    registration_mode character varying(100),
    environment character varying(100),
    host character varying(500),
    port integer,
    username character varying(255),
    password character varying(500),
    database_name character varying(255),
    connection_uri text,
    service_name character varying(255),
    sid character varying(255),
    tns_descriptor text,
    oracle_connect_string text,
    windows_authentication boolean,
    instance_name character varying(255),
    ssl_mode character varying(100),
    mongo_protocol character varying(100),
    auth_source character varying(255),
    replica_set character varying(255),
    clickhouse_protocol character varying(100),
    ssh_host character varying(500),
    ssh_port integer,
    ssh_user character varying(255),
    ssh_password character varying(500),
    org_id integer DEFAULT 1 NOT NULL
);


--
-- Name: connection_master_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.connection_master_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: connection_master_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.connection_master_id_seq OWNED BY public.connection_master.id;


--
-- Name: database_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.database_instances (
    id integer NOT NULL,
    server_id integer NOT NULL,
    db_type character varying(100),
    db_version character varying(100),
    port integer,
    status character varying(50),
    connection_id integer,
    created_at timestamp without time zone,
    org_id integer DEFAULT 1 NOT NULL
);


--
-- Name: database_instances_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.database_instances_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: database_instances_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.database_instances_id_seq OWNED BY public.database_instances.id;


--
-- Name: department_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.department_master (
    department_id integer NOT NULL,
    org_id integer NOT NULL,
    department_code character varying(50) NOT NULL,
    department_name character varying(150) NOT NULL,
    description character varying(250),
    is_active boolean DEFAULT true NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    modified_by integer,
    modified_at timestamp without time zone,
    deleted_by integer,
    deleted_at timestamp without time zone
);


--
-- Name: department_master_department_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.department_master ALTER COLUMN department_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.department_master_department_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: designation_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.designation_master (
    designation_id integer NOT NULL,
    org_id integer NOT NULL,
    designation_code character varying(50) NOT NULL,
    designation_name character varying(150) NOT NULL,
    description character varying(250),
    is_active boolean DEFAULT true NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    modified_by integer,
    modified_at timestamp without time zone,
    deleted_by integer,
    deleted_at timestamp without time zone
);


--
-- Name: designation_master_designation_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.designation_master ALTER COLUMN designation_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.designation_master_designation_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: discovery_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discovery_jobs (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    celery_task_id character varying(255),
    status character varying(50) NOT NULL,
    resources_found integer,
    error_detail text,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: employee_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employee_master (
    employee_id integer NOT NULL,
    org_id integer NOT NULL,
    employee_code character varying(50) NOT NULL,
    employee_name character varying(150) NOT NULL,
    email_id character varying(200),
    mobile_no character varying(20),
    department_id integer,
    designation_id integer,
    joining_date date,
    reporting_manager_id integer,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    modified_by integer,
    modified_at timestamp without time zone,
    deleted_by integer,
    deleted_at timestamp without time zone,
    employment_status_id integer
);


--
-- Name: employee_master_employee_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.employee_master ALTER COLUMN employee_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.employee_master_employee_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: group_role_page_permission; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_role_page_permission (
    page_permission_id integer NOT NULL,
    org_id integer NOT NULL,
    role_id integer NOT NULL,
    page_id integer NOT NULL,
    permission integer NOT NULL,
    permission_description character varying(500),
    is_active boolean DEFAULT true NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    modified_by integer,
    modified_at timestamp without time zone,
    deleted_by integer,
    deleted_at timestamp without time zone,
    CONSTRAINT chk_grpp_permission CHECK ((permission >= 0))
);


--
-- Name: group_role_page_permission_page_permission_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.group_role_page_permission ALTER COLUMN page_permission_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.group_role_page_permission_page_permission_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: login_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.login_history (
    login_history_id bigint NOT NULL,
    org_id integer,
    user_id integer,
    login_time timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    logout_time timestamp without time zone,
    login_status boolean,
    ip_address character varying(50),
    device_name character varying(150),
    browser_name character varying(150),
    operating_system character varying(150)
);


--
-- Name: login_history_login_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.login_history ALTER COLUMN login_history_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.login_history_login_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: module_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.module_master (
    module_id integer NOT NULL,
    org_id integer NOT NULL,
    module_name character varying(100) NOT NULL,
    module_code character varying(50) NOT NULL,
    module_description character varying(300),
    module_route character varying(200),
    module_icon character varying(100),
    display_order integer DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    modified_by integer,
    modified_at timestamp without time zone,
    deleted_by integer,
    deleted_at timestamp without time zone
);


--
-- Name: module_master_module_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.module_master ALTER COLUMN module_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.module_master_module_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: mssql_report_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mssql_report_schedules (
    id integer NOT NULL,
    conn_id integer NOT NULL,
    schedule_name character varying(200) NOT NULL,
    frequency character varying(20),
    hour integer,
    minute integer,
    day_of_week character varying(20),
    day_of_month integer,
    recipient_emails text NOT NULL,
    smtp_host character varying(200) NOT NULL,
    smtp_port integer,
    smtp_user character varying(200),
    smtp_password character varying(500),
    smtp_tls boolean,
    sender_email character varying(200) NOT NULL,
    sender_name character varying(200),
    report_period character varying(20),
    include_sections text,
    enabled boolean,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    last_sent_at timestamp without time zone,
    next_run_at timestamp without time zone,
    last_status character varying(20)
);


--
-- Name: mssql_report_schedules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mssql_report_schedules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mssql_report_schedules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mssql_report_schedules_id_seq OWNED BY public.mssql_report_schedules.id;


--
-- Name: mysql_report_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mysql_report_schedules (
    id integer NOT NULL,
    conn_id integer NOT NULL,
    schedule_name character varying(200) NOT NULL,
    frequency character varying(20),
    hour integer,
    minute integer,
    day_of_week character varying(20),
    day_of_month integer,
    recipient_emails text NOT NULL,
    smtp_host character varying(200) NOT NULL,
    smtp_port integer,
    smtp_user character varying(200),
    smtp_password character varying(500),
    smtp_tls boolean,
    sender_email character varying(200) NOT NULL,
    sender_name character varying(200),
    report_period character varying(20),
    include_sections text,
    enabled boolean,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    last_sent_at timestamp without time zone,
    next_run_at timestamp without time zone,
    last_status character varying(20),
    org_id integer DEFAULT 1 NOT NULL
);


--
-- Name: mysql_report_schedules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mysql_report_schedules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mysql_report_schedules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mysql_report_schedules_id_seq OWNED BY public.mysql_report_schedules.id;


--
-- Name: oracle_report_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oracle_report_schedules (
    id integer NOT NULL,
    conn_id integer NOT NULL,
    schedule_name character varying(200) NOT NULL,
    frequency character varying(20),
    hour integer,
    minute integer,
    day_of_week character varying(20),
    day_of_month integer,
    recipient_emails text NOT NULL,
    smtp_host character varying(200) NOT NULL,
    smtp_port integer,
    smtp_user character varying(200),
    smtp_password character varying(500),
    smtp_tls boolean,
    sender_email character varying(200) NOT NULL,
    sender_name character varying(200),
    report_period character varying(20),
    include_sections text,
    enabled boolean,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    last_sent_at timestamp without time zone,
    next_run_at timestamp without time zone,
    last_status character varying(20),
    org_id integer DEFAULT 1 NOT NULL
);


--
-- Name: oracle_report_schedules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.oracle_report_schedules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: oracle_report_schedules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.oracle_report_schedules_id_seq OWNED BY public.oracle_report_schedules.id;


--
-- Name: organization_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_master (
    org_id integer NOT NULL,
    parent_org_id integer,
    org_code character varying(50) NOT NULL,
    org_name character varying(120) NOT NULL,
    legal_name character varying(150) NOT NULL,
    cin_number character varying(50),
    gst_number character varying(30),
    pan_number character varying(20),
    registration_no character varying(50),
    industry character varying(255),
    contact_person_name character varying(120),
    contact_person_designation character varying(255),
    contact_person_email character varying(255),
    contact_person_no character varying(50),
    contact_no character varying(25) NOT NULL,
    alternate_contact_no character varying(25),
    email_id character varying(200) NOT NULL,
    website_url character varying(200),
    logo_path character varying(300),
    country_name character varying(150) NOT NULL,
    state_name character varying(150) NOT NULL,
    city_name character varying(150) NOT NULL,
    address_line1 character varying(250),
    address_line2 character varying(250),
    pincode character varying(15),
    status_id integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    modified_by integer,
    modified_at timestamp without time zone,
    deleted_by integer,
    deleted_at timestamp without time zone
);


--
-- Name: organization_master_org_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.organization_master ALTER COLUMN org_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.organization_master_org_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: os_servers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.os_servers (
    id integer NOT NULL,
    server_name character varying(255) NOT NULL,
    hostname character varying(500),
    ip_address character varying(100) NOT NULL,
    os_type character varying(100),
    environment character varying(100),
    node_type character varying(100),
    cluster_name character varying(255),
    ssh_port integer,
    ssh_username character varying(255),
    ssh_password character varying(500),
    database_services json,
    status character varying(50),
    monitoring_enabled boolean,
    auto_discovery boolean,
    cpu_usage character varying(20),
    ram_usage character varying(20),
    disk_usage character varying(20),
    uptime character varying(100),
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    org_id integer DEFAULT 1 NOT NULL,
    collector character varying(20) DEFAULT 'ssh'::character varying,
    agent_token character varying(128),
    last_infra_json text,
    last_infra_at timestamp without time zone
);


--
-- Name: os_servers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.os_servers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: os_servers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.os_servers_id_seq OWNED BY public.os_servers.id;


--
-- Name: page_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.page_master (
    page_id integer NOT NULL,
    page_name character varying(150) NOT NULL,
    page_url character varying(250),
    mobile_url character varying(250),
    icon_name character varying(100),
    display_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    modified_by integer,
    modified_at timestamp without time zone,
    deleted_by integer,
    deleted_at timestamp without time zone,
    org_id integer NOT NULL,
    module_id integer NOT NULL,
    parent_id integer DEFAULT 0 NOT NULL,
    page_code character varying(100) NOT NULL,
    page_description character varying(300),
    is_menu boolean DEFAULT true NOT NULL
);


--
-- Name: page_page_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.page_master ALTER COLUMN page_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.page_page_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: password_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_history (
    password_history_id bigint NOT NULL,
    user_id integer NOT NULL,
    password_hash character varying(255) NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    org_id integer DEFAULT 1 NOT NULL
);


--
-- Name: password_history_password_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.password_history ALTER COLUMN password_history_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.password_history_password_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: permission; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.permission (
    permission_id integer NOT NULL,
    permission_value integer NOT NULL,
    permission_name character varying(150) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    modified_by integer,
    modified_at timestamp without time zone,
    deleted_by integer,
    deleted_at timestamp without time zone,
    org_id integer DEFAULT 1 NOT NULL
);


--
-- Name: permission_permission_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.permission ALTER COLUMN permission_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.permission_permission_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: postgres_report_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.postgres_report_schedules (
    id integer NOT NULL,
    conn_id integer NOT NULL,
    schedule_name character varying(200) NOT NULL,
    frequency character varying(20),
    hour integer,
    minute integer,
    day_of_week character varying(20),
    day_of_month integer,
    recipient_emails text NOT NULL,
    smtp_host character varying(200) NOT NULL,
    smtp_port integer,
    smtp_user character varying(200),
    smtp_password character varying(500),
    smtp_tls boolean,
    sender_email character varying(200) NOT NULL,
    sender_name character varying(200),
    report_period character varying(20),
    include_sections text,
    enabled boolean,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    last_sent_at timestamp without time zone,
    next_run_at timestamp without time zone,
    last_status character varying(20),
    org_id integer DEFAULT 1 NOT NULL
);


--
-- Name: postgres_report_schedules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.postgres_report_schedules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: postgres_report_schedules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.postgres_report_schedules_id_seq OWNED BY public.postgres_report_schedules.id;


--
-- Name: resource_samples; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_samples (
    id bigint NOT NULL,
    org_id integer DEFAULT 1 NOT NULL,
    connection_id integer NOT NULL,
    db_type character varying(50) DEFAULT 'postgresql'::character varying,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    cpu_pct numeric,
    ram_pct numeric,
    disk_pct numeric,
    is_event boolean DEFAULT false NOT NULL,
    evidence jsonb
);


--
-- Name: resource_samples_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.resource_samples_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: resource_samples_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.resource_samples_id_seq OWNED BY public.resource_samples.id;


--
-- Name: role; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role (
    role_id integer NOT NULL,
    org_id integer NOT NULL,
    role_name character varying(120) NOT NULL,
    role_description character varying(250),
    is_active boolean DEFAULT true NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    modified_by integer,
    modified_at timestamp without time zone,
    deleted_by integer,
    deleted_at timestamp without time zone
);


--
-- Name: role_role_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.role ALTER COLUMN role_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.role_role_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: smtp_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.smtp_configs (
    id integer NOT NULL,
    name character varying(200) NOT NULL,
    smtp_host character varying(300) NOT NULL,
    smtp_port integer,
    smtp_user character varying(300),
    smtp_password character varying(500),
    smtp_tls boolean,
    sender_email character varying(300) NOT NULL,
    sender_name character varying(200),
    is_default boolean,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    last_test_at timestamp without time zone,
    last_test_ok boolean,
    last_test_msg character varying(500),
    org_id integer DEFAULT 1 NOT NULL
);


--
-- Name: smtp_configs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.smtp_configs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: smtp_configs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.smtp_configs_id_seq OWNED BY public.smtp_configs.id;


--
-- Name: status_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.status_master (
    status_id integer NOT NULL,
    status_code character varying(50) NOT NULL,
    status_name character varying(100) NOT NULL,
    status_description character varying(250),
    is_active boolean DEFAULT true NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    modified_by integer,
    modified_at timestamp without time zone,
    deleted_by integer,
    deleted_at timestamp without time zone,
    org_id integer DEFAULT 1 NOT NULL
);


--
-- Name: status_master_status_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.status_master ALTER COLUMN status_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.status_master_status_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: user_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_master (
    user_id integer NOT NULL,
    org_id integer NOT NULL,
    role_id integer NOT NULL,
    user_name character varying(100) NOT NULL,
    password_hash character varying(255) NOT NULL,
    employee_id integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    modified_by integer,
    modified_at timestamp without time zone,
    deleted_by integer,
    deleted_at timestamp without time zone,
    failed_login_attempts integer DEFAULT 0 NOT NULL,
    account_locked boolean DEFAULT false NOT NULL,
    last_login_at timestamp without time zone
);


--
-- Name: user_master_user_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.user_master ALTER COLUMN user_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.user_master_user_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: user_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_session (
    session_id bigint NOT NULL,
    user_id integer NOT NULL,
    session_token character varying(500) NOT NULL,
    login_time timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    expiry_time timestamp without time zone NOT NULL,
    ip_address character varying(50),
    device_name character varying(150),
    is_active boolean DEFAULT true NOT NULL,
    org_id integer DEFAULT 1 NOT NULL
);


--
-- Name: user_session_session_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.user_session ALTER COLUMN session_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.user_session_session_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: vw_access_control; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_access_control AS
 SELECT o.org_name,
    r.role_name,
    m.module_name,
    p.page_name,
    p.page_url,
    string_agg((pm.permission_name)::text, ', '::text ORDER BY pm.permission_value) AS permissions
   FROM (((((public.group_role_page_permission grpp
     JOIN public.organization_master o ON ((o.org_id = grpp.org_id)))
     JOIN public.role r ON ((r.role_id = grpp.role_id)))
     JOIN public.page_master p ON ((p.page_id = grpp.page_id)))
     LEFT JOIN public.module_master m ON ((m.module_id = p.module_id)))
     JOIN public.permission pm ON (((grpp.permission & pm.permission_value) = pm.permission_value)))
  WHERE (grpp.is_active = true)
  GROUP BY o.org_name, r.role_name, m.module_name, p.page_name, p.page_url;


--
-- Name: vw_access_control_json; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_access_control_json AS
 SELECT o.org_id,
    r.role_id,
    p.page_id,
    json_agg(pm.permission_name ORDER BY pm.permission_value) AS permissions
   FROM ((((public.group_role_page_permission grpp
     JOIN public.organization_master o ON ((o.org_id = grpp.org_id)))
     JOIN public.role r ON ((r.role_id = grpp.role_id)))
     JOIN public.page_master p ON ((p.page_id = grpp.page_id)))
     JOIN public.permission pm ON (((grpp.permission & pm.permission_value) = pm.permission_value)))
  GROUP BY o.org_id, r.role_id, p.page_id;


--
-- Name: vw_access_control_page_permission; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_access_control_page_permission AS
 SELECT o.org_id,
    o.org_name,
    r.role_id,
    r.role_name,
    p.page_id,
    p.page_name,
    string_agg((pm.permission_name)::text, ', '::text ORDER BY pm.permission_value) AS permissions,
    grpp.permission,
    grpp.permission_description
   FROM ((((public.group_role_page_permission grpp
     JOIN public.organization_master o ON ((o.org_id = grpp.org_id)))
     JOIN public.role r ON ((r.role_id = grpp.role_id)))
     JOIN public.page_master p ON ((p.page_id = grpp.page_id)))
     JOIN public.permission pm ON (((grpp.permission & pm.permission_value) = pm.permission_value)))
  WHERE (grpp.is_active = true)
  GROUP BY o.org_id, o.org_name, r.role_id, r.role_name, p.page_id, p.page_name, grpp.permission, grpp.permission_description;


--
-- Name: vw_access_control_permission; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_access_control_permission AS
 SELECT grpp.page_permission_id,
    o.org_id,
    o.org_name,
    r.role_id,
    r.role_name,
    p.page_id,
    p.page_name,
    p.page_url,
    pm.permission_id,
    pm.permission_name,
    pm.permission_value,
    grpp.permission AS total_permission_value,
    grpp.permission_description,
    grpp.is_active,
    grpp.created_by,
    grpp.created_at
   FROM ((((public.group_role_page_permission grpp
     JOIN public.organization_master o ON ((o.org_id = grpp.org_id)))
     JOIN public.role r ON ((r.role_id = grpp.role_id)))
     JOIN public.page_master p ON ((p.page_id = grpp.page_id)))
     JOIN public.permission pm ON (((grpp.permission & pm.permission_value) = pm.permission_value)))
  WHERE (grpp.is_active = true);


--
-- Name: vw_audit_log; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_audit_log AS
 SELECT a.audit_id,
    a.org_id,
    o.org_name,
    a.user_id,
    u.user_name,
    a.table_name,
    a.record_id,
    a.action_type,
    a.old_data,
    a.new_data,
    a.ip_address,
    a.user_agent,
    a.created_at
   FROM ((public.audit_log a
     LEFT JOIN public.organization_master o ON ((o.org_id = a.org_id)))
     LEFT JOIN public.user_master u ON ((u.user_id = a.user_id)));


--
-- Name: vw_department; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_department AS
 SELECT d.department_id,
    d.org_id,
    o.org_name,
    d.department_code,
    d.department_name,
    d.description,
    d.is_active,
    d.created_by,
    d.created_at,
    d.modified_by,
    d.modified_at
   FROM (public.department_master d
     LEFT JOIN public.organization_master o ON ((o.org_id = d.org_id)))
  WHERE (d.deleted_at IS NULL);


--
-- Name: vw_designation; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_designation AS
 SELECT dg.designation_id,
    dg.org_id,
    o.org_name,
    dg.designation_code,
    dg.designation_name,
    dg.description,
    dg.is_active,
    dg.created_by,
    dg.created_at,
    dg.modified_by,
    dg.modified_at
   FROM (public.designation_master dg
     LEFT JOIN public.organization_master o ON ((o.org_id = dg.org_id)))
  WHERE (dg.deleted_at IS NULL);


--
-- Name: vw_employee; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_employee AS
 SELECT e.employee_id,
    e.org_id,
    o.org_name,
    e.employee_code,
    e.employee_name,
    e.email_id,
    e.mobile_no,
    e.department_id,
    d.department_name,
    e.designation_id,
    dg.designation_name,
    e.joining_date,
    e.reporting_manager_id,
    mgr.employee_name AS reporting_manager_name,
    e.employment_status_id,
    s.status_name AS employment_status_name,
    e.is_active,
    e.created_by,
    e.created_at,
    e.modified_by,
    e.modified_at
   FROM (((((public.employee_master e
     LEFT JOIN public.organization_master o ON ((o.org_id = e.org_id)))
     LEFT JOIN public.department_master d ON ((d.department_id = e.department_id)))
     LEFT JOIN public.designation_master dg ON ((dg.designation_id = e.designation_id)))
     LEFT JOIN public.employee_master mgr ON ((mgr.employee_id = e.reporting_manager_id)))
     LEFT JOIN public.status_master s ON ((s.status_id = e.employment_status_id)))
  WHERE (e.deleted_at IS NULL);


--
-- Name: vw_login_history; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_login_history AS
 SELECT lh.login_history_id,
    lh.org_id,
    o.org_name,
    lh.user_id,
    u.user_name,
    e.employee_name,
    lh.login_time,
    lh.logout_time,
    lh.login_status,
    lh.ip_address,
    lh.device_name,
    lh.browser_name,
    lh.operating_system
   FROM (((public.login_history lh
     LEFT JOIN public.organization_master o ON ((o.org_id = lh.org_id)))
     LEFT JOIN public.user_master u ON ((u.user_id = lh.user_id)))
     LEFT JOIN public.employee_master e ON ((e.employee_id = u.employee_id)));


--
-- Name: vw_module; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_module AS
 SELECT module_id,
    org_id,
    module_name,
    module_code,
    module_description,
    module_route,
    module_icon,
    display_order,
    is_active,
    created_by,
    created_at,
    modified_by,
    modified_at
   FROM public.module_master
  WHERE (deleted_at IS NULL);


--
-- Name: vw_organization; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_organization AS
 SELECT org.org_id,
    org.parent_org_id,
    p.org_name AS parent_org_name,
    org.org_code,
    org.org_name,
    org.legal_name,
    org.gst_number,
    org.pan_number,
    org.registration_no,
    org.contact_person_name,
    org.contact_no,
    org.alternate_contact_no,
    org.email_id,
    org.website_url,
    org.logo_path,
    org.country_name,
    org.state_name,
    org.city_name,
    org.address_line1,
    org.address_line2,
    org.pincode,
    org.status_id,
    s.status_name,
    org.is_active,
    org.created_by,
    org.created_at,
    org.modified_by,
    org.modified_at
   FROM ((public.organization_master org
     LEFT JOIN public.organization_master p ON ((p.org_id = org.parent_org_id)))
     LEFT JOIN public.status_master s ON ((s.status_id = org.status_id)))
  WHERE (org.deleted_at IS NULL);


--
-- Name: vw_page; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_page AS
 SELECT p.page_id,
    p.org_id,
    p.module_id,
    m.module_name,
    p.parent_id,
    par.page_name AS parent_name,
    p.page_name,
    p.page_url,
    p.page_code,
    p.page_description,
    p.icon_name,
    p.display_order,
    p.is_menu,
    p.is_active,
    p.created_by,
    p.created_at,
    p.modified_by,
    p.modified_at
   FROM ((public.page_master p
     LEFT JOIN public.module_master m ON ((m.module_id = p.module_id)))
     LEFT JOIN public.page_master par ON ((par.page_id = p.parent_id)))
  WHERE (p.deleted_at IS NULL);


--
-- Name: vw_password_history; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_password_history AS
 SELECT ph.password_history_id,
    ph.user_id,
    u.user_name,
    e.employee_name,
    ph.created_at
   FROM ((public.password_history ph
     LEFT JOIN public.user_master u ON ((u.user_id = ph.user_id)))
     LEFT JOIN public.employee_master e ON ((e.employee_id = u.employee_id)));


--
-- Name: vw_permission; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_permission AS
 SELECT permission_id,
    permission_value,
    permission_name,
    is_active,
    created_by,
    created_at,
    modified_by,
    modified_at
   FROM public.permission
  WHERE (deleted_at IS NULL);


--
-- Name: vw_role; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_role AS
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
   FROM (public.role r
     LEFT JOIN public.organization_master o ON ((o.org_id = r.org_id)))
  WHERE (r.deleted_at IS NULL);


--
-- Name: vw_role_page_permission; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_role_page_permission AS
 SELECT g.page_permission_id,
    g.org_id,
    g.role_id,
    g.page_id,
    pm.page_name,
    pm.page_url,
    pm.module_id,
    m.module_name,
    g.permission,
    g.permission_description,
    g.is_active
   FROM ((public.group_role_page_permission g
     JOIN public.page_master pm ON ((pm.page_id = g.page_id)))
     LEFT JOIN public.module_master m ON ((m.module_id = pm.module_id)))
  WHERE ((g.deleted_at IS NULL) AND (g.is_active = true));


--
-- Name: vw_user; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_user AS
 SELECT u.user_id,
    u.org_id,
    o.org_name,
    u.role_id,
    r.role_name,
    u.user_name,
    u.employee_id,
    e.employee_name,
    e.email_id,
    u.is_active,
    u.account_locked,
    u.failed_login_attempts,
    u.last_login_at,
    u.created_by,
    u.created_at,
    u.modified_by,
    u.modified_at
   FROM (((public.user_master u
     LEFT JOIN public.organization_master o ON ((o.org_id = u.org_id)))
     LEFT JOIN public.role r ON ((r.role_id = u.role_id)))
     LEFT JOIN public.employee_master e ON ((e.employee_id = u.employee_id)))
  WHERE (u.deleted_at IS NULL);


--
-- Name: vw_user_session; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_user_session AS
 SELECT s.session_id,
    s.user_id,
    u.user_name,
    e.employee_name,
    s.login_time,
    s.expiry_time,
    s.ip_address,
    s.device_name,
    s.is_active,
    (s.is_active AND (s.expiry_time > now())) AS is_live
   FROM ((public.user_session s
     LEFT JOIN public.user_master u ON ((u.user_id = s.user_id)))
     LEFT JOIN public.employee_master e ON ((e.employee_id = u.employee_id)));


--
-- Name: agent_db_targets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_db_targets ALTER COLUMN id SET DEFAULT nextval('public.agent_db_targets_id_seq'::regclass);


--
-- Name: agent_metrics id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_metrics ALTER COLUMN id SET DEFAULT nextval('public.agent_metrics_id_seq'::regclass);


--
-- Name: agent_notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_notifications ALTER COLUMN id SET DEFAULT nextval('public.agent_notifications_id_seq'::regclass);


--
-- Name: agent_oracle_snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_oracle_snapshots ALTER COLUMN id SET DEFAULT nextval('public.agent_oracle_snapshots_id_seq'::regclass);


--
-- Name: agent_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_sessions ALTER COLUMN id SET DEFAULT nextval('public.agent_sessions_id_seq'::regclass);


--
-- Name: agent_snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_snapshots ALTER COLUMN id SET DEFAULT nextval('public.agent_snapshots_id_seq'::regclass);


--
-- Name: agent_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tokens ALTER COLUMN id SET DEFAULT nextval('public.agent_tokens_id_seq'::regclass);


--
-- Name: agent_top_sql id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_top_sql ALTER COLUMN id SET DEFAULT nextval('public.agent_top_sql_id_seq'::regclass);


--
-- Name: agent_wait_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_wait_events ALTER COLUMN id SET DEFAULT nextval('public.agent_wait_events_id_seq'::regclass);


--
-- Name: agents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents ALTER COLUMN id SET DEFAULT nextval('public.agents_id_seq'::regclass);


--
-- Name: alert_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_rules ALTER COLUMN id SET DEFAULT nextval('public.alert_rules_id_seq'::regclass);


--
-- Name: backup_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_jobs ALTER COLUMN id SET DEFAULT nextval('public.backup_jobs_id_seq'::regclass);


--
-- Name: backup_schedules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_schedules ALTER COLUMN id SET DEFAULT nextval('public.backup_schedules_id_seq'::regclass);


--
-- Name: connection_master id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connection_master ALTER COLUMN id SET DEFAULT nextval('public.connection_master_id_seq'::regclass);


--
-- Name: database_instances id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_instances ALTER COLUMN id SET DEFAULT nextval('public.database_instances_id_seq'::regclass);


--
-- Name: mssql_report_schedules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mssql_report_schedules ALTER COLUMN id SET DEFAULT nextval('public.mssql_report_schedules_id_seq'::regclass);


--
-- Name: mysql_report_schedules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mysql_report_schedules ALTER COLUMN id SET DEFAULT nextval('public.mysql_report_schedules_id_seq'::regclass);


--
-- Name: oracle_report_schedules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oracle_report_schedules ALTER COLUMN id SET DEFAULT nextval('public.oracle_report_schedules_id_seq'::regclass);


--
-- Name: os_servers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.os_servers ALTER COLUMN id SET DEFAULT nextval('public.os_servers_id_seq'::regclass);


--
-- Name: postgres_report_schedules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.postgres_report_schedules ALTER COLUMN id SET DEFAULT nextval('public.postgres_report_schedules_id_seq'::regclass);


--
-- Name: resource_samples id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_samples ALTER COLUMN id SET DEFAULT nextval('public.resource_samples_id_seq'::regclass);


--
-- Name: smtp_configs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.smtp_configs ALTER COLUMN id SET DEFAULT nextval('public.smtp_configs_id_seq'::regclass);


--
-- Name: agent_db_targets agent_db_targets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_db_targets
    ADD CONSTRAINT agent_db_targets_pkey PRIMARY KEY (id);


--
-- Name: agent_metrics agent_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_metrics
    ADD CONSTRAINT agent_metrics_pkey PRIMARY KEY (id);


--
-- Name: agent_notifications agent_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_notifications
    ADD CONSTRAINT agent_notifications_pkey PRIMARY KEY (id);


--
-- Name: agent_oracle_snapshots agent_oracle_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_oracle_snapshots
    ADD CONSTRAINT agent_oracle_snapshots_pkey PRIMARY KEY (id);


--
-- Name: agent_sessions agent_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_sessions
    ADD CONSTRAINT agent_sessions_pkey PRIMARY KEY (id);


--
-- Name: agent_snapshots agent_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_snapshots
    ADD CONSTRAINT agent_snapshots_pkey PRIMARY KEY (id);


--
-- Name: agent_tokens agent_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tokens
    ADD CONSTRAINT agent_tokens_pkey PRIMARY KEY (id);


--
-- Name: agent_top_sql agent_top_sql_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_top_sql
    ADD CONSTRAINT agent_top_sql_pkey PRIMARY KEY (id);


--
-- Name: agent_wait_events agent_wait_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_wait_events
    ADD CONSTRAINT agent_wait_events_pkey PRIMARY KEY (id);


--
-- Name: agents agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);


--
-- Name: alert_rules alert_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_rules
    ADD CONSTRAINT alert_rules_pkey PRIMARY KEY (id);


--
-- Name: backup_jobs backup_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_jobs
    ADD CONSTRAINT backup_jobs_pkey PRIMARY KEY (id);


--
-- Name: backup_jobs backup_jobs_uuid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_jobs
    ADD CONSTRAINT backup_jobs_uuid_key UNIQUE (uuid);


--
-- Name: backup_schedules backup_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_schedules
    ADD CONSTRAINT backup_schedules_pkey PRIMARY KEY (id);


--
-- Name: cloud_accounts cloud_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_accounts
    ADD CONSTRAINT cloud_accounts_pkey PRIMARY KEY (id);


--
-- Name: cloud_resources cloud_resources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_resources
    ADD CONSTRAINT cloud_resources_pkey PRIMARY KEY (id);


--
-- Name: connection_master connection_master_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connection_master
    ADD CONSTRAINT connection_master_pkey PRIMARY KEY (id);


--
-- Name: database_instances database_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_instances
    ADD CONSTRAINT database_instances_pkey PRIMARY KEY (id);


--
-- Name: discovery_jobs discovery_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discovery_jobs
    ADD CONSTRAINT discovery_jobs_pkey PRIMARY KEY (id);


--
-- Name: mssql_report_schedules mssql_report_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mssql_report_schedules
    ADD CONSTRAINT mssql_report_schedules_pkey PRIMARY KEY (id);


--
-- Name: mysql_report_schedules mysql_report_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mysql_report_schedules
    ADD CONSTRAINT mysql_report_schedules_pkey PRIMARY KEY (id);


--
-- Name: oracle_report_schedules oracle_report_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oracle_report_schedules
    ADD CONSTRAINT oracle_report_schedules_pkey PRIMARY KEY (id);


--
-- Name: os_servers os_servers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.os_servers
    ADD CONSTRAINT os_servers_pkey PRIMARY KEY (id);


--
-- Name: audit_log pk_audit_log; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT pk_audit_log PRIMARY KEY (audit_id);


--
-- Name: department_master pk_department_master; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.department_master
    ADD CONSTRAINT pk_department_master PRIMARY KEY (department_id);


--
-- Name: designation_master pk_designation_master; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.designation_master
    ADD CONSTRAINT pk_designation_master PRIMARY KEY (designation_id);


--
-- Name: employee_master pk_employee_master; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_master
    ADD CONSTRAINT pk_employee_master PRIMARY KEY (employee_id);


--
-- Name: group_role_page_permission pk_group_role_page_permission; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_role_page_permission
    ADD CONSTRAINT pk_group_role_page_permission PRIMARY KEY (page_permission_id);


--
-- Name: login_history pk_login_history; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_history
    ADD CONSTRAINT pk_login_history PRIMARY KEY (login_history_id);


--
-- Name: module_master pk_module_master; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.module_master
    ADD CONSTRAINT pk_module_master PRIMARY KEY (module_id);


--
-- Name: organization_master pk_organization_master; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_master
    ADD CONSTRAINT pk_organization_master PRIMARY KEY (org_id);


--
-- Name: page_master pk_page; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.page_master
    ADD CONSTRAINT pk_page PRIMARY KEY (page_id);


--
-- Name: password_history pk_password_history; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_history
    ADD CONSTRAINT pk_password_history PRIMARY KEY (password_history_id);


--
-- Name: permission pk_permission; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permission
    ADD CONSTRAINT pk_permission PRIMARY KEY (permission_id);


--
-- Name: role pk_role; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role
    ADD CONSTRAINT pk_role PRIMARY KEY (role_id);


--
-- Name: status_master pk_status_master; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.status_master
    ADD CONSTRAINT pk_status_master PRIMARY KEY (status_id);


--
-- Name: user_master pk_user_master; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_master
    ADD CONSTRAINT pk_user_master PRIMARY KEY (user_id);


--
-- Name: user_session pk_user_session; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_session
    ADD CONSTRAINT pk_user_session PRIMARY KEY (session_id);


--
-- Name: postgres_report_schedules postgres_report_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.postgres_report_schedules
    ADD CONSTRAINT postgres_report_schedules_pkey PRIMARY KEY (id);


--
-- Name: resource_samples resource_samples_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_samples
    ADD CONSTRAINT resource_samples_pkey PRIMARY KEY (id);


--
-- Name: smtp_configs smtp_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.smtp_configs
    ADD CONSTRAINT smtp_configs_pkey PRIMARY KEY (id);


--
-- Name: department_master uk_department_org_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.department_master
    ADD CONSTRAINT uk_department_org_code UNIQUE (org_id, department_code);


--
-- Name: designation_master uk_designation_org_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.designation_master
    ADD CONSTRAINT uk_designation_org_code UNIQUE (org_id, designation_code);


--
-- Name: employee_master uk_employee_email; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_master
    ADD CONSTRAINT uk_employee_email UNIQUE (email_id);


--
-- Name: employee_master uk_employee_mobile; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_master
    ADD CONSTRAINT uk_employee_mobile UNIQUE (mobile_no);


--
-- Name: employee_master uk_employee_org_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_master
    ADD CONSTRAINT uk_employee_org_code UNIQUE (org_id, employee_code);


--
-- Name: group_role_page_permission uk_grpp_org_role_page; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_role_page_permission
    ADD CONSTRAINT uk_grpp_org_role_page UNIQUE (org_id, role_id, page_id);


--
-- Name: module_master uk_module_org_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.module_master
    ADD CONSTRAINT uk_module_org_code UNIQUE (org_id, module_code);


--
-- Name: module_master uk_module_org_name; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.module_master
    ADD CONSTRAINT uk_module_org_name UNIQUE (org_id, module_name);


--
-- Name: module_master uk_module_org_route; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.module_master
    ADD CONSTRAINT uk_module_org_route UNIQUE (org_id, module_route);


--
-- Name: organization_master uk_organization_master_gst; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_master
    ADD CONSTRAINT uk_organization_master_gst UNIQUE (gst_number);


--
-- Name: organization_master uk_organization_master_org_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_master
    ADD CONSTRAINT uk_organization_master_org_code UNIQUE (org_code);


--
-- Name: organization_master uk_organization_master_pan; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_master
    ADD CONSTRAINT uk_organization_master_pan UNIQUE (pan_number);


--
-- Name: page_master uk_page_org_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.page_master
    ADD CONSTRAINT uk_page_org_code UNIQUE (org_id, page_code);


--
-- Name: page_master uk_page_org_url; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.page_master
    ADD CONSTRAINT uk_page_org_url UNIQUE (org_id, page_url);


--
-- Name: permission uk_permission_name; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permission
    ADD CONSTRAINT uk_permission_name UNIQUE (permission_name);


--
-- Name: permission uk_permission_value; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permission
    ADD CONSTRAINT uk_permission_value UNIQUE (permission_value);


--
-- Name: role uk_role_org_name; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role
    ADD CONSTRAINT uk_role_org_name UNIQUE (org_id, role_name);


--
-- Name: status_master uk_status_master_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.status_master
    ADD CONSTRAINT uk_status_master_code UNIQUE (status_code);


--
-- Name: status_master uk_status_master_name; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.status_master
    ADD CONSTRAINT uk_status_master_name UNIQUE (status_name);


--
-- Name: user_master uk_user_master_org_username; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_master
    ADD CONSTRAINT uk_user_master_org_username UNIQUE (org_id, user_name);


--
-- Name: idx_agents_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agents_org_id ON public.agents USING btree (org_id);


--
-- Name: idx_connection_master_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connection_master_org_id ON public.connection_master USING btree (org_id);


--
-- Name: idx_database_instances_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_database_instances_org_id ON public.database_instances USING btree (org_id);


--
-- Name: idx_employee_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employee_active ON public.employee_master USING btree (is_active);


--
-- Name: idx_employee_department; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employee_department ON public.employee_master USING btree (department_id);


--
-- Name: idx_employee_designation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employee_designation ON public.employee_master USING btree (designation_id);


--
-- Name: idx_employee_manager; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employee_manager ON public.employee_master USING btree (reporting_manager_id);


--
-- Name: idx_employee_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employee_org ON public.employee_master USING btree (org_id);


--
-- Name: idx_employee_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employee_status ON public.employee_master USING btree (employment_status_id);


--
-- Name: idx_grpp_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grpp_active ON public.group_role_page_permission USING btree (is_active);


--
-- Name: idx_grpp_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grpp_org ON public.group_role_page_permission USING btree (org_id);


--
-- Name: idx_grpp_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grpp_page ON public.group_role_page_permission USING btree (page_id);


--
-- Name: idx_grpp_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grpp_role ON public.group_role_page_permission USING btree (role_id);


--
-- Name: idx_module_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_module_active ON public.module_master USING btree (is_active);


--
-- Name: idx_module_display_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_module_display_order ON public.module_master USING btree (display_order);


--
-- Name: idx_module_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_module_org ON public.module_master USING btree (org_id);


--
-- Name: idx_module_route; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_module_route ON public.module_master USING btree (module_route);


--
-- Name: idx_organization_master_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_organization_master_active ON public.organization_master USING btree (is_active);


--
-- Name: idx_organization_master_parent_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_organization_master_parent_org ON public.organization_master USING btree (parent_org_id);


--
-- Name: idx_organization_master_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_organization_master_status ON public.organization_master USING btree (status_id);


--
-- Name: idx_os_servers_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_os_servers_org_id ON public.os_servers USING btree (org_id);


--
-- Name: idx_page_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_page_active ON public.page_master USING btree (is_active);


--
-- Name: idx_page_display_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_page_display_order ON public.page_master USING btree (display_order);


--
-- Name: idx_page_menu; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_page_menu ON public.page_master USING btree (is_menu);


--
-- Name: idx_page_module_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_page_module_id ON public.page_master USING btree (module_id);


--
-- Name: idx_page_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_page_org ON public.page_master USING btree (org_id);


--
-- Name: idx_page_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_page_parent ON public.page_master USING btree (parent_id);


--
-- Name: idx_permission_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_permission_active ON public.permission USING btree (is_active);


--
-- Name: idx_resource_samples_conn_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_resource_samples_conn_time ON public.resource_samples USING btree (connection_id, captured_at DESC);


--
-- Name: idx_role_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_role_active ON public.role USING btree (is_active);


--
-- Name: idx_role_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_role_org ON public.role USING btree (org_id);


--
-- Name: idx_user_master_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_master_active ON public.user_master USING btree (is_active);


--
-- Name: idx_user_master_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_master_employee ON public.user_master USING btree (employee_id);


--
-- Name: idx_user_master_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_master_org ON public.user_master USING btree (org_id);


--
-- Name: idx_user_master_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_master_role ON public.user_master USING btree (role_id);


--
-- Name: ix_agent_db_targets_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_db_targets_id ON public.agent_db_targets USING btree (id);


--
-- Name: ix_agent_db_targets_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_db_targets_token ON public.agent_db_targets USING btree (token);


--
-- Name: ix_agent_metrics_agent_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_metrics_agent_name ON public.agent_metrics USING btree (agent_name);


--
-- Name: ix_agent_metrics_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_metrics_id ON public.agent_metrics USING btree (id);


--
-- Name: ix_agent_metrics_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_metrics_timestamp ON public.agent_metrics USING btree ("timestamp");


--
-- Name: ix_agent_notifications_agent_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_notifications_agent_name ON public.agent_notifications USING btree (agent_name);


--
-- Name: ix_agent_notifications_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_notifications_id ON public.agent_notifications USING btree (id);


--
-- Name: ix_agent_oracle_snapshots_agent_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_oracle_snapshots_agent_name ON public.agent_oracle_snapshots USING btree (agent_name);


--
-- Name: ix_agent_oracle_snapshots_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_oracle_snapshots_id ON public.agent_oracle_snapshots USING btree (id);


--
-- Name: ix_agent_sessions_agent_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_sessions_agent_name ON public.agent_sessions USING btree (agent_name);


--
-- Name: ix_agent_sessions_captured_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_sessions_captured_at ON public.agent_sessions USING btree (captured_at);


--
-- Name: ix_agent_sessions_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_sessions_id ON public.agent_sessions USING btree (id);


--
-- Name: ix_agent_snapshots_agent_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_snapshots_agent_name ON public.agent_snapshots USING btree (agent_name);


--
-- Name: ix_agent_snapshots_captured_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_snapshots_captured_at ON public.agent_snapshots USING btree (captured_at);


--
-- Name: ix_agent_snapshots_connection_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_snapshots_connection_id ON public.agent_snapshots USING btree (connection_id);


--
-- Name: ix_agent_snapshots_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_snapshots_id ON public.agent_snapshots USING btree (id);


--
-- Name: ix_agent_snapshots_snapshot_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_snapshots_snapshot_type ON public.agent_snapshots USING btree (snapshot_type);


--
-- Name: ix_agent_tokens_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_tokens_id ON public.agent_tokens USING btree (id);


--
-- Name: ix_agent_tokens_token; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_agent_tokens_token ON public.agent_tokens USING btree (token);


--
-- Name: ix_agent_top_sql_agent_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_top_sql_agent_name ON public.agent_top_sql USING btree (agent_name);


--
-- Name: ix_agent_top_sql_captured_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_top_sql_captured_at ON public.agent_top_sql USING btree (captured_at);


--
-- Name: ix_agent_top_sql_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_top_sql_id ON public.agent_top_sql USING btree (id);


--
-- Name: ix_agent_wait_events_agent_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_wait_events_agent_name ON public.agent_wait_events USING btree (agent_name);


--
-- Name: ix_agent_wait_events_captured_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_wait_events_captured_at ON public.agent_wait_events USING btree (captured_at);


--
-- Name: ix_agent_wait_events_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_wait_events_id ON public.agent_wait_events USING btree (id);


--
-- Name: ix_agents_agent_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_agents_agent_name ON public.agents USING btree (agent_name);


--
-- Name: ix_agents_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agents_id ON public.agents USING btree (id);


--
-- Name: ix_alert_rules_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_alert_rules_org_id ON public.alert_rules USING btree (org_id);


--
-- Name: ix_backup_jobs_connection_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_backup_jobs_connection_id ON public.backup_jobs USING btree (connection_id);


--
-- Name: ix_backup_jobs_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_backup_jobs_id ON public.backup_jobs USING btree (id);


--
-- Name: ix_backup_schedules_conn_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_backup_schedules_conn_id ON public.backup_schedules USING btree (conn_id);


--
-- Name: ix_cloud_accounts_account_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_cloud_accounts_account_name ON public.cloud_accounts USING btree (account_name);


--
-- Name: ix_cloud_accounts_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_cloud_accounts_provider ON public.cloud_accounts USING btree (provider);


--
-- Name: ix_cloud_resources_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_cloud_resources_account_id ON public.cloud_resources USING btree (account_id);


--
-- Name: ix_cloud_resources_provider_resource_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_cloud_resources_provider_resource_id ON public.cloud_resources USING btree (provider_resource_id);


--
-- Name: ix_cloud_resources_resource_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_cloud_resources_resource_type ON public.cloud_resources USING btree (resource_type);


--
-- Name: ix_connection_master_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_connection_master_id ON public.connection_master USING btree (id);


--
-- Name: ix_database_instances_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_database_instances_id ON public.database_instances USING btree (id);


--
-- Name: ix_discovery_jobs_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_discovery_jobs_account_id ON public.discovery_jobs USING btree (account_id);


--
-- Name: ix_mssql_report_schedules_conn_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_mssql_report_schedules_conn_id ON public.mssql_report_schedules USING btree (conn_id);


--
-- Name: ix_mysql_report_schedules_conn_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_mysql_report_schedules_conn_id ON public.mysql_report_schedules USING btree (conn_id);


--
-- Name: ix_oracle_report_schedules_conn_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_oracle_report_schedules_conn_id ON public.oracle_report_schedules USING btree (conn_id);


--
-- Name: ix_os_servers_agent_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_os_servers_agent_token ON public.os_servers USING btree (agent_token);


--
-- Name: ix_os_servers_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_os_servers_id ON public.os_servers USING btree (id);


--
-- Name: ix_postgres_report_schedules_conn_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_postgres_report_schedules_conn_id ON public.postgres_report_schedules USING btree (conn_id);


--
-- Name: department_master trg_audit_department_master; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_department_master AFTER INSERT OR DELETE OR UPDATE ON public.department_master FOR EACH ROW EXECUTE FUNCTION public.fn_audit('department_id');


--
-- Name: designation_master trg_audit_designation_master; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_designation_master AFTER INSERT OR DELETE OR UPDATE ON public.designation_master FOR EACH ROW EXECUTE FUNCTION public.fn_audit('designation_id');


--
-- Name: employee_master trg_audit_employee_master; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_employee_master AFTER INSERT OR DELETE OR UPDATE ON public.employee_master FOR EACH ROW EXECUTE FUNCTION public.fn_audit('employee_id');


--
-- Name: group_role_page_permission trg_audit_group_role_page_permission; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_group_role_page_permission AFTER INSERT OR DELETE OR UPDATE ON public.group_role_page_permission FOR EACH ROW EXECUTE FUNCTION public.fn_audit('page_permission_id');


--
-- Name: module_master trg_audit_module_master; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_module_master AFTER INSERT OR DELETE OR UPDATE ON public.module_master FOR EACH ROW EXECUTE FUNCTION public.fn_audit('module_id');


--
-- Name: organization_master trg_audit_organization_master; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_organization_master AFTER INSERT OR DELETE OR UPDATE ON public.organization_master FOR EACH ROW EXECUTE FUNCTION public.fn_audit('org_id');


--
-- Name: page_master trg_audit_page_master; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_page_master AFTER INSERT OR DELETE OR UPDATE ON public.page_master FOR EACH ROW EXECUTE FUNCTION public.fn_audit('page_id');


--
-- Name: permission trg_audit_permission; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_permission AFTER INSERT OR DELETE OR UPDATE ON public.permission FOR EACH ROW EXECUTE FUNCTION public.fn_audit('permission_id');


--
-- Name: role trg_audit_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_role AFTER INSERT OR DELETE OR UPDATE ON public.role FOR EACH ROW EXECUTE FUNCTION public.fn_audit('role_id');


--
-- Name: user_master trg_audit_user_master; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_user_master AFTER INSERT OR DELETE OR UPDATE ON public.user_master FOR EACH ROW EXECUTE FUNCTION public.fn_audit('user_id');


--
-- Name: cloud_resources cloud_resources_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_resources
    ADD CONSTRAINT cloud_resources_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.cloud_accounts(id) ON DELETE CASCADE;


--
-- Name: database_instances database_instances_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_instances
    ADD CONSTRAINT database_instances_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.os_servers(id);


--
-- Name: discovery_jobs discovery_jobs_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discovery_jobs
    ADD CONSTRAINT discovery_jobs_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.cloud_accounts(id) ON DELETE CASCADE;


--
-- Name: audit_log fk_audit_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT fk_audit_org FOREIGN KEY (org_id) REFERENCES public.organization_master(org_id);


--
-- Name: audit_log fk_audit_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES public.user_master(user_id);


--
-- Name: department_master fk_department_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.department_master
    ADD CONSTRAINT fk_department_org FOREIGN KEY (org_id) REFERENCES public.organization_master(org_id);


--
-- Name: designation_master fk_designation_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.designation_master
    ADD CONSTRAINT fk_designation_org FOREIGN KEY (org_id) REFERENCES public.organization_master(org_id);


--
-- Name: employee_master fk_employee_department; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_master
    ADD CONSTRAINT fk_employee_department FOREIGN KEY (department_id) REFERENCES public.department_master(department_id);


--
-- Name: employee_master fk_employee_designation; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_master
    ADD CONSTRAINT fk_employee_designation FOREIGN KEY (designation_id) REFERENCES public.designation_master(designation_id);


--
-- Name: employee_master fk_employee_manager; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_master
    ADD CONSTRAINT fk_employee_manager FOREIGN KEY (reporting_manager_id) REFERENCES public.employee_master(employee_id);


--
-- Name: employee_master fk_employee_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_master
    ADD CONSTRAINT fk_employee_org FOREIGN KEY (org_id) REFERENCES public.organization_master(org_id);


--
-- Name: employee_master fk_employee_status; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_master
    ADD CONSTRAINT fk_employee_status FOREIGN KEY (employment_status_id) REFERENCES public.status_master(status_id);


--
-- Name: group_role_page_permission fk_grpp_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_role_page_permission
    ADD CONSTRAINT fk_grpp_org FOREIGN KEY (org_id) REFERENCES public.organization_master(org_id);


--
-- Name: group_role_page_permission fk_grpp_page; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_role_page_permission
    ADD CONSTRAINT fk_grpp_page FOREIGN KEY (page_id) REFERENCES public.page_master(page_id);


--
-- Name: group_role_page_permission fk_grpp_role; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_role_page_permission
    ADD CONSTRAINT fk_grpp_role FOREIGN KEY (role_id) REFERENCES public.role(role_id);


--
-- Name: login_history fk_login_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_history
    ADD CONSTRAINT fk_login_org FOREIGN KEY (org_id) REFERENCES public.organization_master(org_id);


--
-- Name: login_history fk_login_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_history
    ADD CONSTRAINT fk_login_user FOREIGN KEY (user_id) REFERENCES public.user_master(user_id);


--
-- Name: module_master fk_module_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.module_master
    ADD CONSTRAINT fk_module_org FOREIGN KEY (org_id) REFERENCES public.organization_master(org_id);


--
-- Name: organization_master fk_organization_status; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_master
    ADD CONSTRAINT fk_organization_status FOREIGN KEY (status_id) REFERENCES public.status_master(status_id);


--
-- Name: page_master fk_page_module; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.page_master
    ADD CONSTRAINT fk_page_module FOREIGN KEY (module_id) REFERENCES public.module_master(module_id);


--
-- Name: page_master fk_page_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.page_master
    ADD CONSTRAINT fk_page_org FOREIGN KEY (org_id) REFERENCES public.organization_master(org_id);


--
-- Name: password_history fk_password_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_history
    ADD CONSTRAINT fk_password_user FOREIGN KEY (user_id) REFERENCES public.user_master(user_id);


--
-- Name: role fk_role_organization; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role
    ADD CONSTRAINT fk_role_organization FOREIGN KEY (org_id) REFERENCES public.organization_master(org_id);


--
-- Name: user_session fk_session_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_session
    ADD CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES public.user_master(user_id);


--
-- Name: user_master fk_user_master_employee; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_master
    ADD CONSTRAINT fk_user_master_employee FOREIGN KEY (employee_id) REFERENCES public.employee_master(employee_id);


--
-- Name: user_master fk_user_master_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_master
    ADD CONSTRAINT fk_user_master_org FOREIGN KEY (org_id) REFERENCES public.organization_master(org_id);


--
-- Name: user_master fk_user_master_role; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_master
    ADD CONSTRAINT fk_user_master_role FOREIGN KEY (role_id) REFERENCES public.role(role_id);


--
-- PostgreSQL database dump complete
--

\unrestrict xq2jbzebJI9iCM4Ek5E8GaKT37ffTATQVNZATdKoCbTCat68IlBR25go29GMNhH

