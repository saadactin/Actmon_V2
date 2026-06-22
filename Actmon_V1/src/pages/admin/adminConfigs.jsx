import { Shield, KeyRound, Boxes, FileText, Lock, UserCog, Users } from 'lucide-react';
import {
  rolesApi, permissionsApi, modulesApi, pagesApi, grppApi, usersApi, employeesApi,
  lookups, nameFromOptions,
} from './_shared/mockDb';

const statusCol = (key = 'is_active') => ({ key, label: 'Status', type: 'status', width: '120px' });

/* ── Roles → role ── */
export const rolesConfig = {
  key: 'roles', title: 'Roles', subtitle: 'Define access roles for the organization',
  icon: Shield, api: rolesApi, idKey: 'role_id', searchKeys: ['role_name', 'role_description'],
  columns: [
    { key: 'role_id', label: 'ID', width: '70px' },
    { key: 'role_name', label: 'Role Name' },
    { key: 'role_description', label: 'Description' },
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
      // Auto-generate the next power-of-two from existing rows (non-editable).
      autoValue: (rows) => {
        const max = Math.max(0, ...rows.map((r) => Number(r.permission_value) || 0));
        return max < 1 ? 1 : max * 2;
      },
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
    { key: 'module_id', label: 'Module', render: (r) => nameFromOptions(lookups.modules(), r.module_id) },
    { key: 'parent_id', label: 'Parent', width: '80px' },
    { key: 'is_menu', label: 'Menu', type: 'status', width: '110px' },
    statusCol(),
  ],
  fields: [
    { key: 'module_id', label: 'Module', type: 'select', required: true, options: lookups.modules() },
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

/* ── Group Role Page Permissions → group_role_page_permission ── */
export const grppConfig = {
  key: 'role-permissions', title: 'Group Role Page Permissions',
  subtitle: 'Assign permission bitmasks per role & page',
  icon: Lock, api: grppApi, idKey: 'page_permission_id', searchKeys: ['permission_description'],
  columns: [
    { key: 'page_permission_id', label: 'ID', width: '70px' },
    { key: 'role_id', label: 'Role', render: (r) => nameFromOptions(lookups.roles(), r.role_id) },
    { key: 'page_id', label: 'Page', render: (r) => nameFromOptions(lookups.pages(), r.page_id) },
    { key: 'permission', label: 'Permissions', type: 'permissions' },
    statusCol(),
  ],
  fields: [
    { key: 'role_id', label: 'Role', type: 'select', required: true, options: lookups.roles() },
    { key: 'page_id', label: 'Page', type: 'select', required: true, options: lookups.pages() },
    { key: 'permission', label: 'Permissions', type: 'permissions' },
    { key: 'permission_description', label: 'Description', type: 'text' },
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
    { key: 'role_id', label: 'Role', render: (r) => nameFromOptions(lookups.roles(), r.role_id) },
    { key: 'employee_id', label: 'Employee', render: (r) => nameFromOptions(lookups.employees(), r.employee_id) },
    { key: 'account_locked', label: 'Locked', render: (r) => r.account_locked
        ? <span className="text-[11px] font-bold text-red-600">Locked</span>
        : <span className="text-[11px] text-slate-400">No</span> },
    statusCol(),
  ],
  fields: [
    { key: 'user_name', label: 'Username', type: 'text', required: true },
    { key: 'password_hash', label: 'Password', type: 'text' },
    { key: 'role_id', label: 'Role', type: 'select', required: true, options: lookups.roles() },
    { key: 'employee_id', label: 'Employee', type: 'select', required: true, options: lookups.employees() },
    { key: 'account_locked', label: 'Account Locked', type: 'checkbox' },
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
    { key: 'department_id', label: 'Department', render: (r) => nameFromOptions(lookups.departments(), r.department_id) },
    { key: 'designation_id', label: 'Designation', render: (r) => nameFromOptions(lookups.designations(), r.designation_id) },
    statusCol(),
  ],
  fields: [
    { key: 'employee_code', label: 'Employee Code', type: 'text', required: true },
    { key: 'employee_name', label: 'Full Name', type: 'text', required: true },
    { key: 'email_id', label: 'Email', type: 'text' },
    { key: 'mobile_no', label: 'Mobile No', type: 'text' },
    { key: 'department_id', label: 'Department', type: 'select', options: lookups.departments() },
    { key: 'designation_id', label: 'Designation', type: 'select', options: lookups.designations() },
    { key: 'joining_date', label: 'Joining Date', type: 'date' },
    { key: 'reporting_manager_id', label: 'Reporting Manager', type: 'select', options: lookups.employees() },
    { key: 'employment_status_id', label: 'Employment Status', type: 'select', options: lookups.statuses() },
    { key: 'is_active', label: 'Active', type: 'checkbox' },
  ],
};

export const ADMIN_CONFIGS = {
  roles: rolesConfig,
  permissions: permissionsConfig,
  modules: modulesConfig,
  pages: pagesConfig,
  'role-permissions': grppConfig,
  users: usersConfig,
  employees: employeesConfig,
};
