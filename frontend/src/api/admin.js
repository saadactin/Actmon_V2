import client, { ensureArray } from './client';

/**
 * Generic Administration CRUD client — one instance per entity, all hitting
 * the same `/api/v1/admin/{path}` shape the backend's admin_crud_routes.py
 * exposes for every master resource:
 *   GET    {base}?org_id=      → { data: [...] }
 *   GET    {base}/{id}         → the row
 *   POST   {base}              → { status, message, id?, row? }  (no full
 *                                 row is guaranteed back except for a few
 *                                 entities with a unique key — always
 *                                 refetch the list after a mutation)
 *   PUT    {base}/{id}         → { status, message }
 *   DELETE {base}/{id}         → { status, message }
 */
export function makeApi(base) {
  return {
    list: (orgId) => client
      .get(base, { params: orgId ? { org_id: orgId } : undefined })
      .then((r) => ensureArray(r.data)),
    get: (id) => client.get(`${base}/${id}`).then((r) => r.data),
    create: (row) => client.post(base, row).then((r) => r.data),
    update: (id, row) => client.put(`${base}/${id}`, row).then((r) => r.data),
    remove: (id) => client.delete(`${base}/${id}`).then((r) => r.data),
  };
}

export const rolesApi = makeApi('/admin/roles');
export const permissionsApi = makeApi('/admin/permissions');
export const modulesApi = makeApi('/admin/modules');
export const pagesApi = makeApi('/admin/pages');
export const organizationsApi = makeApi('/admin/organizations');
export const departmentsApi = makeApi('/admin/departments');
export const designationsApi = makeApi('/admin/designations');
export const employeesApi = makeApi('/admin/employees');
export const usersApi = makeApi('/admin/users');
export const auditLogsApi = makeApi('/admin/audit-logs');
export const loginHistoryApi = makeApi('/admin/login-history');
export const userSessionsApi = makeApi('/admin/user-sessions');
export const passwordHistoryApi = makeApi('/admin/password-history');

/** Read-only status_master lookup, for status-dropdown fields. */
export const statusesApi = {
  list: () => client.get('/admin/statuses').then((r) => ensureArray(r.data)),
};

/** Uploads an image (organization logo) and returns the URL to store on the
    record — the backend saves the file and hands back a served path, it
    never gets embedded as base64. */
export const uploadsApi = {
  logo: (file) => {
    const form = new FormData();
    form.append('file', file);
    return client.post('/admin/uploads/logo', form, { headers: { 'Content-Type': 'multipart/form-data' } })
      .then((r) => r.data.logo_path);
  },
};

/**
 * Role → Page permission grants (`group_role_page_permission`). Distinct
 * from the generic factory: `list` takes org_id AND an optional role_id
 * filter, and there's a bespoke clone endpoint for copying one role's
 * grants onto another.
 */
export const rolePermissionsApi = {
  list: (orgId, roleId) => client
    .get('/admin/role-permissions', { params: { org_id: orgId, role_id: roleId } })
    .then((r) => ensureArray(r.data)),
  create: (row) => client.post('/admin/role-permissions', row).then((r) => r.data),
  update: (id, row) => client.put(`/admin/role-permissions/${id}`, row).then((r) => r.data),
  remove: (id) => client.delete(`/admin/role-permissions/${id}`).then((r) => r.data),
  clone: (payload) => client.post('/admin/role-permissions/clone', payload).then((r) => r.data),
};

/** Username suggestion for the "auto-create a login" flow off a new employee. */
export const suggestUsername = (base) => client
  .get('/admin/suggest-username', { params: { base } })
  .then((r) => r.data?.username || '');
