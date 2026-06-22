/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  ADMIN MOCK DATA LAYER  (frontend-only — temporary)
 *
 *  This is the SINGLE swap-point for the real backend. Each resource exposes the
 *  same async CRUD surface the API will later provide:
 *      list()         -> GET all          (sp_<entity>_get_all)
 *      get(id)        -> GET by id         (sp_<entity>_get_by_id)
 *      create(row)    -> INSERT            (sp_<entity>_insert)
 *      update(id,row) -> UPDATE            (sp_<entity>_update)
 *      remove(id)     -> soft DELETE       (sp_<entity>_delete)
 *
 *  When the stored procedures are ready, replace makeResource() internals with
 *  axios calls to the endpoints — the UI (AdminResourcePage) won't change.
 *  Seed data mirrors the real table columns in the actmon DB.
 * ─────────────────────────────────────────────────────────────────────────────
 */

let _seq = 1000; // id generator for newly-created mock rows
const nextId = () => ++_seq;
const clone = (o) => JSON.parse(JSON.stringify(o));
const delay = (ms = 120) => new Promise((r) => setTimeout(r, ms));

/** Generic in-memory resource backed by a seed array. */
function makeResource(seed, idKey) {
  let rows = clone(seed);
  return {
    idKey,
    async list() { await delay(); return clone(rows); },
    async get(id) { await delay(); return clone(rows.find((r) => String(r[idKey]) === String(id)) || null); },
    async create(row) {
      await delay();
      const created = { ...row, [idKey]: nextId(), is_active: row.is_active ?? true, created_at: new Date().toISOString() };
      rows.push(created);
      return clone(created);
    },
    async update(id, row) {
      await delay();
      const i = rows.findIndex((r) => String(r[idKey]) === String(id));
      if (i === -1) throw new Error('Not found');
      rows[i] = { ...rows[i], ...row, [idKey]: rows[i][idKey], modified_at: new Date().toISOString() };
      return clone(rows[i]);
    },
    async remove(id) {
      await delay();
      rows = rows.filter((r) => String(r[idKey]) !== String(id));
      return { success: true };
    },
    _raw() { return rows; },
  };
}

/* ── Permission bitmask helpers (View=1, Add=2, Edit=4, Delete=8, …) ── */
export const PERMISSION_BITS = [
  { value: 1, name: 'View' }, { value: 2, name: 'Add' }, { value: 4, name: 'Edit' },
  { value: 8, name: 'Delete' }, { value: 16, name: 'Import' }, { value: 32, name: 'Export' },
  { value: 64, name: 'Execute' }, { value: 128, name: 'Approve' },
];
export const decodePermission = (mask) =>
  PERMISSION_BITS.filter((p) => (Number(mask) & p.value) === p.value).map((p) => p.name);

/* ─────────────── SEED DATA (mirrors real tables) ─────────────── */

// Logos live in /public — referenced by root-relative path.
const SEED_ORGANIZATIONS = [
  { org_id: 1, parent_org_id: 0, org_code: 'ACTIN',   org_name: 'Actin Technologies',        city_name: 'Pune',      logo_path: '/actin logo.png',     is_active: true },
  { org_id: 2, parent_org_id: 1, org_code: 'EMCURE',  org_name: 'Emcure Pharmaceuticals',    city_name: 'Pune',      logo_path: '/Emcure.png',         is_active: true },
  { org_id: 4, parent_org_id: 1, org_code: 'KOEL',    org_name: 'Kirloskar Oil Engines',     city_name: 'Pune',      logo_path: '/kirlsokar logo.png', is_active: true },
  { org_id: 5, parent_org_id: 1, org_code: 'KBL',     org_name: 'Kirloskar Brothers',        city_name: 'Pune',      logo_path: '/kirlsokar logo.png', is_active: true },
  { org_id: 6, parent_org_id: 1, org_code: 'TCS',     org_name: 'Tata Consultancy Services', city_name: 'Mumbai',    logo_path: '/tcs.jpg',            is_active: true },
  { org_id: 7, parent_org_id: 1, org_code: 'INFOSYS', org_name: 'Infosys',                   city_name: 'Bangalore', logo_path: '/infosys.png',        is_active: true },
  { org_id: 8, parent_org_id: 1, org_code: 'HDFC',    org_name: 'HDFC Bank',                 city_name: 'Mumbai',    logo_path: '/hdfc.png',           is_active: true },
];

const SEED_ROLES = [
  // ── Org 1 · Actin Technologies (parent / super org) ──
  { role_id: 1, org_id: 1, role_name: 'Super Administrator', role_description: 'Full system access', is_active: true },
  { role_id: 2, org_id: 1, role_name: 'Organization Admin', role_description: 'Manage organization', is_active: true },
  { role_id: 3, org_id: 1, role_name: 'Database Administrator', role_description: 'Manage databases & monitoring', is_active: true },
  { role_id: 4, org_id: 1, role_name: 'Developer', role_description: 'Read/write developer access', is_active: true },
  { role_id: 5, org_id: 1, role_name: 'Viewer', role_description: 'Read-only access', is_active: true },
  // ── Org 2 · Emcure Pharmaceuticals ──
  { role_id: 6, org_id: 2, role_name: 'Organization Admin', role_description: 'Manage Emcure', is_active: true },
  { role_id: 7, org_id: 2, role_name: 'Database Administrator', role_description: 'Emcure DBA', is_active: true },
  { role_id: 8, org_id: 2, role_name: 'Viewer', role_description: 'Read-only', is_active: true },
  // ── Org 4 · Kirloskar Oil Engines ──
  { role_id: 9, org_id: 4, role_name: 'Organization Admin', role_description: 'Manage KOEL', is_active: true },
  { role_id: 10, org_id: 4, role_name: 'Database Administrator', role_description: 'KOEL DBA', is_active: true },
  { role_id: 11, org_id: 4, role_name: 'Viewer', role_description: 'Read-only', is_active: true },
  // ── Org 5 · Kirloskar Brothers ──
  { role_id: 12, org_id: 5, role_name: 'Organization Admin', role_description: 'Manage KBL', is_active: true },
  { role_id: 13, org_id: 5, role_name: 'Viewer', role_description: 'Read-only', is_active: true },
  // ── Org 6 · Tata Consultancy Services ──
  { role_id: 14, org_id: 6, role_name: 'Organization Admin', role_description: 'Manage TCS', is_active: true },
  { role_id: 15, org_id: 6, role_name: 'Database Administrator', role_description: 'TCS DBA', is_active: true },
  { role_id: 16, org_id: 6, role_name: 'Viewer', role_description: 'Read-only', is_active: true },
  // ── Org 7 · Infosys ──
  { role_id: 17, org_id: 7, role_name: 'Organization Admin', role_description: 'Manage Infosys', is_active: true },
  { role_id: 18, org_id: 7, role_name: 'Viewer', role_description: 'Read-only', is_active: true },
  // ── Org 8 · HDFC Bank ──
  { role_id: 19, org_id: 8, role_name: 'Organization Admin', role_description: 'Manage HDFC', is_active: true },
  { role_id: 20, org_id: 8, role_name: 'Database Administrator', role_description: 'HDFC DBA', is_active: true },
  { role_id: 21, org_id: 8, role_name: 'Viewer', role_description: 'Read-only', is_active: true },
];

const SEED_PERMISSIONS = [
  { permission_id: 1, permission_value: 1, permission_name: 'View', is_active: true },
  { permission_id: 2, permission_value: 2, permission_name: 'Add', is_active: true },
  { permission_id: 3, permission_value: 4, permission_name: 'Edit', is_active: true },
  { permission_id: 4, permission_value: 8, permission_name: 'Delete', is_active: true },
  { permission_id: 5, permission_value: 16, permission_name: 'Import', is_active: true },
  { permission_id: 6, permission_value: 32, permission_name: 'Export', is_active: true },
  { permission_id: 7, permission_value: 64, permission_name: 'Execute', is_active: true },
  { permission_id: 8, permission_value: 128, permission_name: 'Approve', is_active: true },
];

const SEED_MODULES = [
  { module_id: 1, org_id: 1, module_name: 'Dashboard', module_code: 'DASHBOARD', module_description: 'Dashboard Module', module_route: '/dashboard', module_icon: 'dashboard', display_order: 1, is_active: true },
  { module_id: 2, org_id: 1, module_name: 'Agents', module_code: 'AGENTS', module_description: 'Agent Management', module_route: '/agents', module_icon: 'server', display_order: 2, is_active: true },
  { module_id: 3, org_id: 1, module_name: 'Databases', module_code: 'DATABASES', module_description: 'Database Monitoring', module_route: '/databases', module_icon: 'database', display_order: 3, is_active: true },
  { module_id: 4, org_id: 1, module_name: 'Cloud', module_code: 'CLOUD', module_description: 'Cloud Monitoring', module_route: '/cloud', module_icon: 'cloud', display_order: 4, is_active: true },
  { module_id: 5, org_id: 1, module_name: 'Infrastructure', module_code: 'INFRASTRUCTURE', module_description: 'Infrastructure Monitoring', module_route: '/infra', module_icon: 'desktop', display_order: 5, is_active: true },
  { module_id: 6, org_id: 1, module_name: 'ML / AI', module_code: 'ML_AI', module_description: 'Machine Learning & AI', module_route: '/ml', module_icon: 'brain', display_order: 6, is_active: true },
  { module_id: 7, org_id: 1, module_name: 'Alerts', module_code: 'ALERTS', module_description: 'Alert Management', module_route: '/alerts', module_icon: 'alert', display_order: 7, is_active: true },
  { module_id: 8, org_id: 1, module_name: 'Administration', module_code: 'ADMINISTRATION', module_description: 'Administration', module_route: '/administration', module_icon: 'shield', display_order: 8, is_active: true },
  { module_id: 9, org_id: 1, module_name: 'Settings', module_code: 'SETTINGS', module_description: 'Application Settings', module_route: '/settings', module_icon: 'settings', display_order: 9, is_active: true },
  { module_id: 10, org_id: 1, module_name: 'ChatBot', module_code: 'CHATBOT', module_description: 'AI ChatBot', module_route: '/chatbot', module_icon: 'chat', display_order: 10, is_active: true },
];

const SEED_PAGES = [
  { page_id: 1, module_id: 3, parent_id: 0, page_name: 'Connections', page_url: '/connections', page_code: 'CONNECTIONS', is_menu: true, display_order: 1, is_active: true },
  { page_id: 2, module_id: 3, parent_id: 0, page_name: 'Database Servers', page_url: '/databases', page_code: 'DATABASE_SERVERS', is_menu: true, display_order: 2, is_active: true },
  { page_id: 3, module_id: 3, parent_id: 0, page_name: 'MySQL', page_url: '/mysql-servers', page_code: 'MYSQL', is_menu: true, display_order: 3, is_active: true },
  { page_id: 13, module_id: 3, parent_id: 3, page_name: 'Dashboard', page_url: '/mysql-dashboard/:id', page_code: 'MYSQL_DASHBOARD', is_menu: true, display_order: 1, is_active: true },
  { page_id: 48, module_id: 8, parent_id: 0, page_name: 'Administration', page_url: '', page_code: 'ADMINISTRATION', is_menu: true, display_order: 1, is_active: true },
  { page_id: 54, module_id: 8, parent_id: 48, page_name: 'Roles', page_url: '/roles', page_code: 'ROLES', is_menu: true, display_order: 6, is_active: true },
  { page_id: 63, module_id: 10, parent_id: 0, page_name: 'ChatBot', page_url: '', page_code: 'CHATBOT', is_menu: true, display_order: 1, is_active: true },
];

const SEED_DEPARTMENTS = [
  { department_id: 1, department_code: 'IT', department_name: 'Information Technology' },
  { department_id: 2, department_code: 'DBA', department_name: 'Database Administration' },
  { department_id: 3, department_code: 'DEV', department_name: 'Development' },
  { department_id: 4, department_code: 'QA', department_name: 'Quality Assurance' },
  { department_id: 5, department_code: 'SUPPORT', department_name: 'Technical Support' },
];

const SEED_DESIGNATIONS = [
  { designation_id: 1, designation_code: 'SUPER_ADMIN', designation_name: 'Super Administrator' },
  { designation_id: 2, designation_code: 'ORG_ADMIN', designation_name: 'Organization Administrator' },
  { designation_id: 3, designation_code: 'DB_ADMIN', designation_name: 'Database Administrator' },
  { designation_id: 4, designation_code: 'SR_DB_ADMIN', designation_name: 'Senior Database Administrator' },
  { designation_id: 5, designation_code: 'DEV', designation_name: 'Software Developer' },
  { designation_id: 6, designation_code: 'SR_DEV', designation_name: 'Senior Software Developer' },
  { designation_id: 7, designation_code: 'QA_ENGINEER', designation_name: 'QA Engineer' },
  { designation_id: 8, designation_code: 'SUPPORT_ENGINEER', designation_name: 'Support Engineer' },
];

const SEED_STATUS = [
  { status_id: 1, status_code: 'ACTIVE', status_name: 'Active' },
  { status_id: 2, status_code: 'INACTIVE', status_name: 'Inactive' },
  { status_id: 4, status_code: 'SUSPENDED', status_name: 'Suspended' },
];

const SEED_EMPLOYEES = [
  { employee_id: 1, org_id: 1, employee_code: 'EMP001', employee_name: 'Suyash Gaikwad', email_id: 'suyash.gaikwad@actin.co.in', mobile_no: '9876543210', department_id: 2, designation_id: 4, joining_date: '2024-01-15', reporting_manager_id: null, employment_status_id: 1, is_active: true },
  { employee_id: 2, org_id: 1, employee_code: 'EMP002', employee_name: 'Rahul Sharma', email_id: 'rahul.sharma@actin.co.in', mobile_no: '9876500002', department_id: 3, designation_id: 6, joining_date: '2024-03-01', reporting_manager_id: 1, employment_status_id: 1, is_active: true },
  { employee_id: 3, org_id: 1, employee_code: 'EMP003', employee_name: 'Priya Nair', email_id: 'priya.nair@actin.co.in', mobile_no: '9876500003', department_id: 4, designation_id: 7, joining_date: '2024-05-10', reporting_manager_id: 1, employment_status_id: 1, is_active: true },
];

const SEED_USERS = [
  { user_id: 1, org_id: 1, role_id: 1, user_name: 'admin', employee_id: 1, is_active: true, account_locked: false, failed_login_attempts: 0, last_login_at: '2026-06-22T09:25:00' },
  { user_id: 2, org_id: 1, role_id: 3, user_name: 'rahul', employee_id: 2, is_active: true, account_locked: false, failed_login_attempts: 0, last_login_at: '2026-06-21T14:10:00' },
  { user_id: 3, org_id: 1, role_id: 5, user_name: 'priya', employee_id: 3, is_active: true, account_locked: false, failed_login_attempts: 1, last_login_at: '2026-06-20T11:05:00' },
];

const SEED_GRPP = [
  { page_permission_id: 1, org_id: 1, role_id: 1, page_id: 1, permission: 255, permission_description: 'Full access', is_active: true },
  { page_permission_id: 2, org_id: 1, role_id: 3, page_id: 13, permission: 15, permission_description: 'View/Add/Edit/Delete', is_active: true },
  { page_permission_id: 3, org_id: 1, role_id: 5, page_id: 1, permission: 1, permission_description: 'View only', is_active: true },
  { page_permission_id: 4, org_id: 2, role_id: 6, page_id: 1, permission: 15, permission_description: 'View/Add/Edit/Delete', is_active: true },
  { page_permission_id: 5, org_id: 2, role_id: 7, page_id: 13, permission: 7, permission_description: 'View/Add/Edit', is_active: true },
];

/* ── Exported resources ── */
export const organizationsApi = makeResource(SEED_ORGANIZATIONS, 'org_id');
export const rolesApi       = makeResource(SEED_ROLES, 'role_id');
export const permissionsApi = makeResource(SEED_PERMISSIONS, 'permission_id');
export const modulesApi     = makeResource(SEED_MODULES, 'module_id');
export const pagesApi        = makeResource(SEED_PAGES, 'page_id');
export const grppApi         = makeResource(SEED_GRPP, 'page_permission_id');
export const usersApi        = makeResource(SEED_USERS, 'user_id');
export const employeesApi    = makeResource(SEED_EMPLOYEES, 'employee_id');

/* ── Lookup option builders (for select fields / FK display) ── */
export const lookups = {
  organizations: () => SEED_ORGANIZATIONS.map((o) => ({ value: o.org_id, label: o.org_name })),
  roles:        () => SEED_ROLES.map((r) => ({ value: r.role_id, label: r.role_name })),
  modules:      () => SEED_MODULES.map((m) => ({ value: m.module_id, label: m.module_name })),
  pages:        () => modulesApi._raw() && pagesApi._raw().map((p) => ({ value: p.page_id, label: `${p.page_name} (${p.page_url || 'menu'})` })),
  departments:  () => SEED_DEPARTMENTS.map((d) => ({ value: d.department_id, label: d.department_name })),
  designations: () => SEED_DESIGNATIONS.map((d) => ({ value: d.designation_id, label: d.designation_name })),
  statuses:     () => SEED_STATUS.map((s) => ({ value: s.status_id, label: s.status_name })),
  employees:    () => SEED_EMPLOYEES.map((e) => ({ value: e.employee_id, label: `${e.employee_name} (${e.employee_code})` })),
};

export const nameFromOptions = (options, value) => {
  const o = options.find((x) => String(x.value) === String(value));
  return o ? o.label : value ?? '—';
};
