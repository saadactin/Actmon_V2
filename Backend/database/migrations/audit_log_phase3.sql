-- ─────────────────────────────────────────────────────────────────────────────
--  PHASE 3 — Automatic audit logging into audit_log (existing table, untouched).
--  Generic AFTER trigger on every master table:
--    • captures old_data / new_data as JSON (password_hash redacted)
--    • action = INSERT / UPDATE / DELETE (soft-delete via deleted_at → DELETE)
--    • user_id / ip / user_agent / org_id read from session vars the app sets
--      (set_config('app.user_id', ...) before each write) — so direct SP calls
--      and app calls are both audited.
--  Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_audit() RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;

-- attach the trigger to each audited table (pk column passed as arg)
DO $$
DECLARE
    t RECORD;
    tables TEXT[][] := ARRAY[
        ['role','role_id'], ['permission','permission_id'], ['module_master','module_id'],
        ['page_master','page_id'], ['group_role_page_permission','page_permission_id'],
        ['organization_master','org_id'], ['department_master','department_id'],
        ['designation_master','designation_id'], ['employee_master','employee_id'],
        ['user_master','user_id']
    ];
BEGIN
    FOR t IN SELECT tables[i][1] AS tbl, tables[i][2] AS pk FROM generate_subscripts(tables, 1) AS i
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_%1$s ON public.%1$s', t.tbl);
        EXECUTE format(
            'CREATE TRIGGER trg_audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON public.%1$s '
            'FOR EACH ROW EXECUTE FUNCTION public.fn_audit(%2$L)', t.tbl, t.pk);
    END LOOP;
END $$;

-- read view for the Audit Logs admin screen
CREATE OR REPLACE VIEW public.vw_audit_log AS
SELECT a.audit_id, a.org_id, o.org_name, a.user_id, u.user_name, a.table_name,
       a.record_id, a.action_type, a.old_data, a.new_data, a.ip_address, a.user_agent, a.created_at
FROM   public.audit_log a
LEFT JOIN public.organization_master o ON o.org_id = a.org_id
LEFT JOIN public.user_master         u ON u.user_id = a.user_id;
