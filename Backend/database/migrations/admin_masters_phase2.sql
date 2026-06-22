-- ─────────────────────────────────────────────────────────────────────────────
--  ADMIN MASTERS — Phase 2: organization, department(view), designation, employee, user
--  Views (reads, with FK names) + JSONB stored procedures (insert/update/delete).
--  Mirrors department/role convention. Soft delete. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- ╔════════════════ DEPARTMENT (SPs already exist — add read view) ════════════════╗
CREATE OR REPLACE VIEW public.vw_department AS
SELECT d.department_id, d.org_id, o.org_name, d.department_code, d.department_name,
       d.description, d.is_active, d.created_by, d.created_at, d.modified_by, d.modified_at
FROM   public.department_master d
LEFT JOIN public.organization_master o ON o.org_id = d.org_id
WHERE  d.deleted_at IS NULL;


-- ╔════════════════ DESIGNATION ════════════════╗
CREATE OR REPLACE VIEW public.vw_designation AS
SELECT dg.designation_id, dg.org_id, o.org_name, dg.designation_code, dg.designation_name,
       dg.description, dg.is_active, dg.created_by, dg.created_at, dg.modified_by, dg.modified_at
FROM   public.designation_master dg
LEFT JOIN public.organization_master o ON o.org_id = dg.org_id
WHERE  dg.deleted_at IS NULL;

CREATE OR REPLACE PROCEDURE public.sp_insertdesignation(IN p_json jsonb)
LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE PROCEDURE public.sp_updatedesignation(IN p_json jsonb)
LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE PROCEDURE public.sp_deletedesignation(IN p_json jsonb)
LANGUAGE plpgsql AS $$
DECLARE v_id INTEGER; v_by INTEGER;
BEGIN
    v_id := (p_json->>'designation_id')::INTEGER; v_by := COALESCE((p_json->>'deleted_by')::INTEGER,1);
    IF v_id IS NULL THEN RAISE EXCEPTION 'Designation ID is required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.designation_master WHERE designation_id=v_id AND deleted_at IS NULL)
      THEN RAISE EXCEPTION 'Designation not found'; END IF;
    UPDATE public.designation_master SET is_active=FALSE, deleted_by=v_by, deleted_at=CURRENT_TIMESTAMP WHERE designation_id=v_id;
END; $$;


-- ╔════════════════ ORGANIZATION ════════════════╗
CREATE OR REPLACE VIEW public.vw_organization AS
SELECT org.org_id, org.parent_org_id, p.org_name AS parent_org_name, org.org_code, org.org_name,
       org.legal_name, org.gst_number, org.pan_number, org.registration_no,
       org.contact_person_name, org.contact_no, org.alternate_contact_no, org.email_id,
       org.website_url, org.logo_path, org.country_name, org.state_name, org.city_name,
       org.address_line1, org.address_line2, org.pincode, org.status_id, s.status_name,
       org.is_active, org.created_by, org.created_at, org.modified_by, org.modified_at
FROM   public.organization_master org
LEFT JOIN public.organization_master p ON p.org_id = org.parent_org_id
LEFT JOIN public.status_master s ON s.status_id = org.status_id
WHERE  org.deleted_at IS NULL;

CREATE OR REPLACE PROCEDURE public.sp_insertorganization(IN p_json jsonb)
LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE PROCEDURE public.sp_updateorganization(IN p_json jsonb)
LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE PROCEDURE public.sp_deleteorganization(IN p_json jsonb)
LANGUAGE plpgsql AS $$
DECLARE v_id INTEGER; v_by INTEGER;
BEGIN
    v_id := (p_json->>'org_id')::INTEGER; v_by := COALESCE((p_json->>'deleted_by')::INTEGER,1);
    IF v_id IS NULL THEN RAISE EXCEPTION 'Organization ID is required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.organization_master WHERE org_id=v_id AND deleted_at IS NULL)
      THEN RAISE EXCEPTION 'Organization not found'; END IF;
    UPDATE public.organization_master SET is_active=FALSE, deleted_by=v_by, deleted_at=CURRENT_TIMESTAMP WHERE org_id=v_id;
END; $$;


-- ╔════════════════ EMPLOYEE ════════════════╗
CREATE OR REPLACE VIEW public.vw_employee AS
SELECT e.employee_id, e.org_id, o.org_name, e.employee_code, e.employee_name, e.email_id, e.mobile_no,
       e.department_id, d.department_name, e.designation_id, dg.designation_name,
       e.joining_date, e.reporting_manager_id, mgr.employee_name AS reporting_manager_name,
       e.employment_status_id, s.status_name AS employment_status_name,
       e.is_active, e.created_by, e.created_at, e.modified_by, e.modified_at
FROM   public.employee_master e
LEFT JOIN public.organization_master o ON o.org_id = e.org_id
LEFT JOIN public.department_master   d ON d.department_id = e.department_id
LEFT JOIN public.designation_master dg ON dg.designation_id = e.designation_id
LEFT JOIN public.employee_master   mgr ON mgr.employee_id = e.reporting_manager_id
LEFT JOIN public.status_master       s ON s.status_id = e.employment_status_id
WHERE  e.deleted_at IS NULL;

CREATE OR REPLACE PROCEDURE public.sp_insertemployee(IN p_json jsonb)
LANGUAGE plpgsql AS $$
DECLARE v_org INTEGER; v_code VARCHAR(50); v_name VARCHAR(150); v_by INTEGER; v_cnt INTEGER;
BEGIN
    v_org := COALESCE((p_json->>'org_id')::INTEGER, 1);
    v_code := TRIM(p_json->>'employee_code');
    v_name := TRIM(p_json->>'employee_name');
    v_by := COALESCE((p_json->>'created_by')::INTEGER, 1);
    IF v_code IS NULL OR v_code='' THEN RAISE EXCEPTION 'Employee Code is required'; END IF;
    IF v_name IS NULL OR v_name='' THEN RAISE EXCEPTION 'Employee Name is required'; END IF;
    SELECT COUNT(*) INTO v_cnt FROM public.employee_master WHERE org_id=v_org AND lower(employee_code)=lower(v_code) AND deleted_at IS NULL;
    IF v_cnt>0 THEN RAISE EXCEPTION 'Employee Code already exists'; END IF;
    INSERT INTO public.employee_master
      (org_id, employee_code, employee_name, email_id, mobile_no, department_id, designation_id,
       joining_date, reporting_manager_id, employment_status_id, is_active, created_by, created_at)
    VALUES (v_org, v_code, v_name, p_json->>'email_id', p_json->>'mobile_no',
       (p_json->>'department_id')::INTEGER, (p_json->>'designation_id')::INTEGER,
       (p_json->>'joining_date')::DATE, (p_json->>'reporting_manager_id')::INTEGER,
       COALESCE((p_json->>'employment_status_id')::INTEGER, 1), TRUE, v_by, CURRENT_TIMESTAMP);
END; $$;

CREATE OR REPLACE PROCEDURE public.sp_updateemployee(IN p_json jsonb)
LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE PROCEDURE public.sp_deleteemployee(IN p_json jsonb)
LANGUAGE plpgsql AS $$
DECLARE v_id INTEGER; v_by INTEGER;
BEGIN
    v_id := (p_json->>'employee_id')::INTEGER; v_by := COALESCE((p_json->>'deleted_by')::INTEGER,1);
    IF v_id IS NULL THEN RAISE EXCEPTION 'Employee ID is required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.employee_master WHERE employee_id=v_id AND deleted_at IS NULL)
      THEN RAISE EXCEPTION 'Employee not found'; END IF;
    UPDATE public.employee_master SET is_active=FALSE, deleted_by=v_by, deleted_at=CURRENT_TIMESTAMP WHERE employee_id=v_id;
END; $$;


-- ╔════════════════ USER ════════════════╗
CREATE OR REPLACE VIEW public.vw_user AS
SELECT u.user_id, u.org_id, o.org_name, u.role_id, r.role_name, u.user_name,
       u.employee_id, e.employee_name, e.email_id, u.is_active, u.account_locked,
       u.failed_login_attempts, u.last_login_at, u.created_by, u.created_at, u.modified_by, u.modified_at
FROM   public.user_master u
LEFT JOIN public.organization_master o ON o.org_id = u.org_id
LEFT JOIN public.role               r ON r.role_id = u.role_id
LEFT JOIN public.employee_master    e ON e.employee_id = u.employee_id
WHERE  u.deleted_at IS NULL;

CREATE OR REPLACE PROCEDURE public.sp_insertuser(IN p_json jsonb)
LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE PROCEDURE public.sp_updateuser(IN p_json jsonb)
LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE PROCEDURE public.sp_deleteuser(IN p_json jsonb)
LANGUAGE plpgsql AS $$
DECLARE v_id INTEGER; v_by INTEGER;
BEGIN
    v_id := (p_json->>'user_id')::INTEGER; v_by := COALESCE((p_json->>'deleted_by')::INTEGER,1);
    IF v_id IS NULL THEN RAISE EXCEPTION 'User ID is required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.user_master WHERE user_id=v_id AND deleted_at IS NULL)
      THEN RAISE EXCEPTION 'User not found'; END IF;
    UPDATE public.user_master SET is_active=FALSE, deleted_by=v_by, deleted_at=CURRENT_TIMESTAMP WHERE user_id=v_id;
END; $$;
