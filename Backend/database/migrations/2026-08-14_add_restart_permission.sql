-- ─────────────────────────────────────────────────────────────────────────────
--  Add the 'Restart' permission to the shared, page-scoped RBAC catalog, and
--  fix a pre-existing inconsistency found while wiring RBAC into the
--  Infrastructure module: 'Execute' (permission_value=64) has deleted_at set
--  even though is_active=true — vw_permission (used by the Administration
--  → Role/Page Permissions screen) filters on deleted_at IS NULL, so no admin
--  could actually see/grant 'Execute' going forward, even though it still
--  works at runtime (get_permission_catalog() only checks is_active).
--  Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- Un-delete 'Execute' so it's visible/grantable in the admin UI again.
UPDATE public.permission
   SET deleted_at = NULL, deleted_by = NULL
 WHERE lower(permission_name) = 'execute';

-- Add 'Restart' — next free power-of-two bit after 128 ('Approve').
INSERT INTO public.permission (permission_value, permission_name, is_active, created_by, created_at)
SELECT 256, 'Restart', TRUE, 1, CURRENT_TIMESTAMP
 WHERE NOT EXISTS (
   SELECT 1 FROM public.permission WHERE lower(permission_name) = 'restart' AND deleted_at IS NULL
 );

-- 'Full Access' is the sentinel sum of every real bit — bump it so it still
-- means "everything" now that Restart (256) exists (1+2+4+8+16+32+64+128+256=511).
UPDATE public.permission
   SET permission_value = 511
 WHERE lower(permission_name) = 'full access';
