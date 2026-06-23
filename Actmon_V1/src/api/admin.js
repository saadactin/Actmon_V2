import client from './client';

/**
 * Real backend CRUD client for Administration resources.
 * Matches the same surface the admin UI expects (list/get/create/update/remove),
 * so an AdminResourcePage config can swap from mock → real with one import change.
 */
const unwrap = (d) => (d && Array.isArray(d.data) ? d.data : d);

export function makeApi(base, idKey) {
  return {
    idKey,
    async list(orgId)       { const q = orgId ? `?org_id=${orgId}` : ''; const r = await client.get(base + q); return unwrap(r.data); },
    async get(id)           { const r = await client.get(`${base}/${id}`);  return r.data; },
    async create(row)       { const r = await client.post(base, row);       return r.data; },
    async update(id, row)   { const r = await client.put(`${base}/${id}`, row); return r.data; },
    async remove(id)        { const r = await client.delete(`${base}/${id}`);  return r.data; },
  };
}

// ── Access-control masters (real backend: views + SPs) ──
export const rolesApi         = makeApi('/admin/roles', 'role_id');
export const permissionsApi   = makeApi('/admin/permissions', 'permission_id');
export const modulesApi       = makeApi('/admin/modules', 'module_id');
export const pagesApi          = makeApi('/admin/pages', 'page_id');
export const organizationsApi = makeApi('/admin/organizations', 'org_id');
export const departmentsApi   = makeApi('/admin/departments', 'department_id');
export const designationsApi  = makeApi('/admin/designations', 'designation_id');
export const employeesApi     = makeApi('/admin/employees', 'employee_id');
export const usersApi          = makeApi('/admin/users', 'user_id');
export const statusesApi       = makeApi('/admin/statuses', 'status_id');  // read-only lookup
export const auditLogsApi        = makeApi('/admin/audit-logs', 'audit_id');         // read-only
export const loginHistoryApi     = makeApi('/admin/login-history', 'login_history_id'); // read-only
export const userSessionsApi     = makeApi('/admin/user-sessions', 'session_id');       // read-only
export const passwordHistoryApi  = makeApi('/admin/password-history', 'password_history_id'); // read-only

// ── Group Role Page Permission (org+role scoped) ──
export const rolePermissionsApi = {
  idKey: 'page_permission_id',
  async list(orgId, roleId) {
    const q = new URLSearchParams();
    if (orgId != null) q.set('org_id', orgId);
    if (roleId != null) q.set('role_id', roleId);
    const r = await client.get(`/admin/role-permissions?${q.toString()}`);
    return unwrap(r.data);
  },
  async create(row)     { const r = await client.post('/admin/role-permissions', row); return r.data; },
  async update(id, row) { const r = await client.put(`/admin/role-permissions/${id}`, row); return r.data; },
  async remove(id)      { const r = await client.delete(`/admin/role-permissions/${id}`); return r.data; },
};

/** Build an async <select> option loader for FK dropdowns; filters by org when given. */
export const optionLoader = (api, valueKey, labelKey) => async (orgId) => {
  const rows = await api.list(orgId);
  return (rows || []).map((r) => ({ value: r[valueKey], label: r[labelKey] }));
};

