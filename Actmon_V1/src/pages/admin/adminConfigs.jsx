import { Shield, KeyRound, Boxes, FileText, UserCog, Users, Building2, Network, IdCard, ScrollText, History, MonitorSmartphone, KeySquare } from 'lucide-react';
import {
  rolesApi, permissionsApi, modulesApi, pagesApi,
  organizationsApi, departmentsApi, designationsApi, employeesApi, usersApi,
  statusesApi, auditLogsApi, loginHistoryApi, userSessionsApi, passwordHistoryApi, optionLoader,
} from '../../api/admin';

const fmtTime = (v) => (v ? String(v).slice(0, 19).replace('T', ' ') : '—');
const boolBadge = (v, [on, off] = ['Yes', 'No']) => (
  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md ${v ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{v ? on : off}</span>
);

const ACTION_COLORS = { INSERT: 'bg-emerald-50 text-emerald-700', UPDATE: 'bg-amber-50 text-amber-700', DELETE: 'bg-red-50 text-red-700' };
const actionBadge = (a) => (
  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md ${ACTION_COLORS[a] || 'bg-slate-100 text-slate-600'}`}>{a}</span>
);

const statusCol = (key = 'is_active') => ({ key, label: 'Status', type: 'status', width: '120px' });

/* ── Roles → role ── */
export const rolesConfig = {
  key: 'roles', title: 'Roles', subtitle: 'Define access roles for the organization',
  icon: Shield, api: rolesApi, idKey: 'role_id', searchKeys: ['role_name', 'role_description', 'org_name'],
  columns: [
    { key: 'role_id', label: 'ID', width: '70px' },
    { key: 'role_name', label: 'Role Name' },
    { key: 'role_description', label: 'Description' },
    { key: 'org_name', label: 'Organization' },
    statusCol(),
  ],
  fields: [
    { key: 'role_name', label: 'Role Name', type: 'text', required: true },
    { key: 'role_description', label: 'Description', type: 'textarea' },
    { key: 'is_active', label: 'Active', type: 'checkbox' },
  ],
};

/* ── Permissions → permission ── */
export const permissionsConfig = {
  key: 'permissions', title: 'Permissions', subtitle: 'Master list of permission types (bitmask values)',
  icon: KeyRound, api: permissionsApi, idKey: 'permission_id', searchKeys: ['permission_name'],
  columns: [
    { key: 'permission_id', label: 'ID', width: '70px' },
    { key: 'permission_name', label: 'Permission' },
    { key: 'permission_value', label: 'Bitmask Value' },
    statusCol(),
  ],
  fields: [
    { key: 'permission_name', label: 'Permission Name', type: 'text', required: true },
    {
      key: 'permission_value', label: 'Bitmask Value', type: 'number', readOnly: true,
      autoValue: (rows) => { const max = Math.max(0, ...rows.map((r) => Number(r.permission_value) || 0)); return max < 1 ? 1 : max * 2; },
      help: 'Auto-generated next power of two (1, 2, 4, 8, 16 …)',
    },
    { key: 'is_active', label: 'Active', type: 'checkbox' },
  ],
};

/* ── Modules → module_master ── */
export const modulesConfig = {
  key: 'modules', title: 'Modules', subtitle: 'Top-level application modules',
  icon: Boxes, api: modulesApi, idKey: 'module_id', searchKeys: ['module_name', 'module_code', 'module_route'],
  columns: [
    { key: 'module_id', label: 'ID', width: '70px' },
    { key: 'module_name', label: 'Module' },
    { key: 'module_code', label: 'Code' },
    { key: 'module_route', label: 'Route' },
    { key: 'display_order', label: 'Order', width: '80px' },
    statusCol(),
  ],
  fields: [
    { key: 'module_name', label: 'Module Name', type: 'text', required: true },
    { key: 'module_code', label: 'Module Code', type: 'text', required: true },
    { key: 'module_description', label: 'Description', type: 'text' },
    { key: 'module_route', label: 'Route', type: 'text' },
    { key: 'module_icon', label: 'Icon', type: 'text' },
    { key: 'display_order', label: 'Display Order', type: 'number' },
    { key: 'is_active', label: 'Active', type: 'checkbox' },
  ],
};

/* ── Pages → page_master ── */
export const pagesConfig = {
  key: 'pages', title: 'Pages', subtitle: 'Application pages & menu hierarchy',
  icon: FileText, api: pagesApi, idKey: 'page_id', searchKeys: ['page_name', 'page_url', 'page_code'],
  columns: [
    { key: 'page_id', label: 'ID', width: '70px' },
    { key: 'page_name', label: 'Page' },
    { key: 'page_url', label: 'URL' },
    { key: 'module_id', label: 'Module', render: (r) => r.module_name || r.module_id },
    { key: 'parent_id', label: 'Parent', render: (r) => r.parent_name || (r.parent_id ? `#${r.parent_id}` : '—'), width: '120px' },
    { key: 'is_menu', label: 'Menu', type: 'status', width: '110px' },
    statusCol(),
  ],
  fields: [
    { key: 'module_id', label: 'Module', type: 'select', required: true, loadOptions: optionLoader(modulesApi, 'module_id', 'module_name') },
    { key: 'parent_id', label: 'Parent Page ID (0 = top)', type: 'number' },
    { key: 'page_name', label: 'Page Name', type: 'text', required: true },
    { key: 'page_url', label: 'Page URL', type: 'text' },
    { key: 'page_code', label: 'Page Code', type: 'text', required: true },
    { key: 'page_description', label: 'Description', type: 'text' },
    { key: 'icon_name', label: 'Icon', type: 'text' },
    { key: 'display_order', label: 'Display Order', type: 'number' },
    { key: 'is_menu', label: 'Show in Menu', type: 'checkbox' },
    { key: 'is_active', label: 'Active', type: 'checkbox' },
  ],
};

/* ── Organizations → organization_master ── */
export const organizationsConfig = {
  key: 'organizations', title: 'Organizations', subtitle: 'Companies / tenants',
  icon: Building2, api: organizationsApi, idKey: 'org_id', searchKeys: ['org_name', 'org_code', 'city_name'],
  columns: [
    { key: 'org_id', label: 'ID', width: '70px' },
    { key: 'org_code', label: 'Code' },
    { key: 'org_name', label: 'Organization' },
    { key: 'city_name', label: 'City' },
    { key: 'status_name', label: 'Status' },
    statusCol(),
  ],
  fields: [
    { key: 'org_code', label: 'Org Code', type: 'text', required: true },
    { key: 'org_name', label: 'Organization Name', type: 'text', required: true },
    { key: 'legal_name', label: 'Legal Name', type: 'text' },
    { key: 'email_id', label: 'Email', type: 'text' },
    { key: 'contact_no', label: 'Contact No', type: 'text' },
    { key: 'contact_person_name', label: 'Contact Person', type: 'text' },
    { key: 'gst_number', label: 'GST Number', type: 'text' },
    { key: 'pan_number', label: 'PAN Number', type: 'text' },
    { key: 'website_url', label: 'Website', type: 'text' },
    { key: 'country_name', label: 'Country', type: 'text' },
    { key: 'state_name', label: 'State', type: 'text' },
    { key: 'city_name', label: 'City', type: 'text' },
    { key: 'address_line1', label: 'Address', type: 'textarea' },
    { key: 'pincode', label: 'Pincode', type: 'text' },
    { key: 'status_id', label: 'Status', type: 'select', loadOptions: optionLoader(statusesApi, 'status_id', 'status_name') },
    { key: 'is_active', label: 'Active', type: 'checkbox' },
  ],
};

/* ── Departments → department_master ── */
export const departmentsConfig = {
  key: 'departments', title: 'Departments', subtitle: 'Organization departments',
  icon: Network, api: departmentsApi, idKey: 'department_id', searchKeys: ['department_name', 'department_code'],
  columns: [
    { key: 'department_id', label: 'ID', width: '70px' },
    { key: 'department_code', label: 'Code' },
    { key: 'department_name', label: 'Department' },
    { key: 'org_name', label: 'Organization' },
    statusCol(),
  ],
  fields: [
    { key: 'department_code', label: 'Department Code', type: 'text', required: true },
    { key: 'department_name', label: 'Department Name', type: 'text', required: true },
    { key: 'description', label: 'Description', type: 'textarea' },
    { key: 'is_active', label: 'Active', type: 'checkbox' },
  ],
};

/* ── Designations → designation_master ── */
export const designationsConfig = {
  key: 'designations', title: 'Designations', subtitle: 'Job titles / designations',
  icon: IdCard, api: designationsApi, idKey: 'designation_id', searchKeys: ['designation_name', 'designation_code'],
  columns: [
    { key: 'designation_id', label: 'ID', width: '70px' },
    { key: 'designation_code', label: 'Code' },
    { key: 'designation_name', label: 'Designation' },
    { key: 'org_name', label: 'Organization' },
    statusCol(),
  ],
  fields: [
    { key: 'designation_code', label: 'Designation Code', type: 'text', required: true },
    { key: 'designation_name', label: 'Designation Name', type: 'text', required: true },
    { key: 'description', label: 'Description', type: 'textarea' },
    { key: 'is_active', label: 'Active', type: 'checkbox' },
  ],
};

/* ── Employees → employee_master ── */
export const employeesConfig = {
  key: 'employees', title: 'Employees', subtitle: 'Organization employee records',
  icon: Users, api: employeesApi, idKey: 'employee_id', searchKeys: ['employee_code', 'employee_name', 'email_id'],
  columns: [
    { key: 'employee_id', label: 'ID', width: '70px' },
    { key: 'employee_code', label: 'Code' },
    { key: 'employee_name', label: 'Name' },
    { key: 'email_id', label: 'Email' },
    { key: 'department_id', label: 'Department', render: (r) => r.department_name || '—' },
    { key: 'designation_id', label: 'Designation', render: (r) => r.designation_name || '—' },
    statusCol(),
  ],
  fields: [
    { key: 'employee_code', label: 'Employee Code', type: 'text', required: true },
    { key: 'employee_name', label: 'Full Name', type: 'text', required: true },
    { key: 'email_id', label: 'Email', type: 'text' },
    { key: 'mobile_no', label: 'Mobile No', type: 'text' },
    { key: 'department_id', label: 'Department', type: 'select', loadOptions: optionLoader(departmentsApi, 'department_id', 'department_name') },
    { key: 'designation_id', label: 'Designation', type: 'select', loadOptions: optionLoader(designationsApi, 'designation_id', 'designation_name') },
    { key: 'joining_date', label: 'Joining Date', type: 'date' },
    { key: 'reporting_manager_id', label: 'Reporting Manager', type: 'select', loadOptions: optionLoader(employeesApi, 'employee_id', 'employee_name') },
    { key: 'employment_status_id', label: 'Employment Status', type: 'select', loadOptions: optionLoader(statusesApi, 'status_id', 'status_name') },
    { key: 'is_active', label: 'Active', type: 'checkbox' },
  ],
};

/* ── User Master → user_master ── */
export const usersConfig = {
  key: 'users', title: 'User Master', subtitle: 'Application user accounts',
  icon: UserCog, api: usersApi, idKey: 'user_id', searchKeys: ['user_name'],
  columns: [
    { key: 'user_id', label: 'ID', width: '70px' },
    { key: 'user_name', label: 'Username' },
    { key: 'role_id', label: 'Role', render: (r) => r.role_name || r.role_id },
    { key: 'employee_id', label: 'Employee', render: (r) => r.employee_name || r.employee_id },
    { key: 'account_locked', label: 'Locked', render: (r) => r.account_locked
        ? <span className="text-[11px] font-bold text-red-600">Locked</span>
        : <span className="text-[11px] text-slate-400">No</span> },
    statusCol(),
  ],
  fields: [
    { key: 'user_name', label: 'Username', type: 'text', required: true },
    { key: 'password_hash', label: 'Password', type: 'text', help: 'Leave blank to keep existing (edit mode)' },
    { key: 'role_id', label: 'Role', type: 'select', required: true, loadOptions: optionLoader(rolesApi, 'role_id', 'role_name') },
    { key: 'employee_id', label: 'Employee', type: 'select', required: true, loadOptions: optionLoader(employeesApi, 'employee_id', 'employee_name') },
    { key: 'account_locked', label: 'Account Locked', type: 'checkbox' },
    { key: 'is_active', label: 'Active', type: 'checkbox' },
  ],
};

/* ── Audit Logs → audit_log (read-only) ── */
export const auditLogsConfig = {
  key: 'audit-logs', title: 'Audit Logs', subtitle: 'Every insert / update / delete across master data',
  icon: ScrollText, api: auditLogsApi, idKey: 'audit_id', readOnly: true,
  searchKeys: ['table_name', 'action_type', 'user_name', 'ip_address'],
  columns: [
    { key: 'audit_id', label: 'ID', width: '70px' },
    { key: 'created_at', label: 'When', render: (r) => (r.created_at || '').toString().slice(0, 19).replace('T', ' ') },
    { key: 'table_name', label: 'Table' },
    { key: 'action_type', label: 'Action', render: (r) => actionBadge(r.action_type) },
    { key: 'record_id', label: 'Record', width: '90px' },
    { key: 'user_name', label: 'User', render: (r) => r.user_name || `#${r.user_id || '—'}` },
    { key: 'ip_address', label: 'IP' },
  ],
  fields: [
    { key: 'table_name', label: 'Table', type: 'text', readOnly: true },
    { key: 'action_type', label: 'Action', type: 'text', readOnly: true },
    { key: 'record_id', label: 'Record ID', type: 'text', readOnly: true },
    { key: 'user_name', label: 'User', type: 'text', readOnly: true },
    { key: 'ip_address', label: 'IP Address', type: 'text', readOnly: true },
    { key: 'created_at', label: 'Timestamp', type: 'text', readOnly: true },
    { key: 'old_data', label: 'Old Data', type: 'json' },
    { key: 'new_data', label: 'New Data', type: 'json' },
  ],
};

/* ── Login History → login_history (read-only) ── */
export const loginHistoryConfig = {
  key: 'login-history', title: 'Login History', subtitle: 'User login / logout activity',
  icon: History, api: loginHistoryApi, idKey: 'login_history_id', readOnly: true,
  searchKeys: ['user_name', 'ip_address', 'browser_name', 'operating_system'],
  columns: [
    { key: 'login_history_id', label: 'ID', width: '70px' },
    { key: 'user_name', label: 'User', render: (r) => r.user_name || `#${r.user_id || '—'}` },
    { key: 'login_status', label: 'Status', render: (r) => boolBadge(r.login_status, ['Success', 'Failed']) },
    { key: 'login_time', label: 'Login', render: (r) => fmtTime(r.login_time) },
    { key: 'logout_time', label: 'Logout', render: (r) => fmtTime(r.logout_time) },
    { key: 'ip_address', label: 'IP' },
    { key: 'browser_name', label: 'Browser' },
    { key: 'operating_system', label: 'OS' },
  ],
  fields: [
    { key: 'user_name', label: 'User', type: 'text', readOnly: true },
    { key: 'login_time', label: 'Login Time', type: 'text', readOnly: true },
    { key: 'logout_time', label: 'Logout Time', type: 'text', readOnly: true },
    { key: 'ip_address', label: 'IP Address', type: 'text', readOnly: true },
    { key: 'device_name', label: 'Device', type: 'text', readOnly: true },
    { key: 'browser_name', label: 'Browser', type: 'text', readOnly: true },
    { key: 'operating_system', label: 'Operating System', type: 'text', readOnly: true },
  ],
};

/* ── User Sessions → user_session (read-only) ── */
export const userSessionsConfig = {
  key: 'user-sessions', title: 'User Sessions', subtitle: 'Active & past login sessions',
  icon: MonitorSmartphone, api: userSessionsApi, idKey: 'session_id', readOnly: true,
  searchKeys: ['user_name', 'ip_address', 'device_name'],
  columns: [
    { key: 'session_id', label: 'ID', width: '70px' },
    { key: 'user_name', label: 'User', render: (r) => r.user_name || `#${r.user_id || '—'}` },
    { key: 'is_live', label: 'Live', render: (r) => boolBadge(r.is_live, ['Live', 'Ended']) },
    { key: 'login_time', label: 'Started', render: (r) => fmtTime(r.login_time) },
    { key: 'expiry_time', label: 'Expires', render: (r) => fmtTime(r.expiry_time) },
    { key: 'ip_address', label: 'IP' },
    { key: 'device_name', label: 'Device' },
  ],
  fields: [
    { key: 'user_name', label: 'User', type: 'text', readOnly: true },
    { key: 'login_time', label: 'Login Time', type: 'text', readOnly: true },
    { key: 'expiry_time', label: 'Expiry Time', type: 'text', readOnly: true },
    { key: 'ip_address', label: 'IP Address', type: 'text', readOnly: true },
    { key: 'device_name', label: 'Device', type: 'text', readOnly: true },
  ],
};

/* ── Password History → password_history (read-only, hash masked) ── */
export const passwordHistoryConfig = {
  key: 'password-history', title: 'Password History', subtitle: 'When users changed passwords',
  icon: KeySquare, api: passwordHistoryApi, idKey: 'password_history_id', readOnly: true,
  searchKeys: ['user_name'],
  columns: [
    { key: 'password_history_id', label: 'ID', width: '70px' },
    { key: 'user_name', label: 'User', render: (r) => r.user_name || `#${r.user_id || '—'}` },
    { key: 'employee_name', label: 'Employee' },
    { key: 'created_at', label: 'Changed At', render: (r) => fmtTime(r.created_at) },
  ],
  fields: [
    { key: 'user_name', label: 'User', type: 'text', readOnly: true },
    { key: 'created_at', label: 'Changed At', type: 'text', readOnly: true },
  ],
};

export const ADMIN_CONFIGS = {
  roles: rolesConfig,
  'audit-logs': auditLogsConfig,
  'login-history': loginHistoryConfig,
  'user-sessions': userSessionsConfig,
  'password-history': passwordHistoryConfig,
  permissions: permissionsConfig,
  modules: modulesConfig,
  pages: pagesConfig,
  organizations: organizationsConfig,
  departments: departmentsConfig,
  designations: designationsConfig,
  employees: employeesConfig,
  users: usersConfig,
};
