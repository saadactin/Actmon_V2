import Badge from '@/components/ui/Badge';
import {
  rolesApi, permissionsApi, modulesApi, pagesApi, organizationsApi,
  departmentsApi, designationsApi, employeesApi, usersApi,
  auditLogsApi, loginHistoryApi, userSessionsApi, passwordHistoryApi,
} from '@/api/admin';

/**
 * ADMINISTRATION — one config object per sub-page, consumed by the generic
 * `AdminResourcePage` engine (src/pages/administration/_shared/).
 *
 * Shape (mirrors the production reference's adminConfigs.jsx, adapted to
 * this app's Icon-name-string convention and Table/Dialog components):
 *
 *   key          route slug, also the React Query cache namespace
 *   title        page heading ("Roles"); the modal derives "Add {Role}" by
 *                stripping a trailing "s"
 *   subtitle     header description
 *   icon         name from components/ui/Icon.jsx's registry
 *   api          one of the clients from @/api/admin
 *   idKey        primary key field
 *   searchKeys   fields the search box matches (defaults to all column keys)
 *   orgScoped    true → the page needs an org context (?org=&orgName= from
 *                the Administration hub) and stamps org_id on create
 *   readOnly     true → no Add/Edit/Delete, used by the 4 log/history pages
 *   autoCreateLogin true → Employees only; offers to create a linked User
 *                after a successful create (handled in EmployeesPage, not
 *                the generic engine, to keep the engine itself config-only)
 *   columns      [{ key, label, width?, align?, type?('status'|'json'), render?(row) }]
 *   fields       [{ key, label, type('text'|'textarea'|'number'|'date'|'checkbox'|'select'|'json'),
 *                    required?, readOnly?, options?:[{id,label}], loadOptions?(orgId):[{id,label}],
 *                    autoValue?(rows), help? }]
 */

const statusCol = { key: 'is_active', label: 'Status', width: 100, type: 'status' };
const statusField = { key: 'is_active', label: 'Active', type: 'checkbox' };

/** Same 16px/500/18px-lh pill text as AdminResourcePage's own Status column
    and the Agents list's Status badge — set via inline style since Badge's
    size classes are same-specificity Tailwind utilities that a plain
    className override isn't guaranteed to beat. Used by every hand-rolled
    status-like Badge below (Account lock, Action type, Login/Session status)
    so they read as the same system as the generic Status column. */
const PILL_STYLE = { paddingTop: '0.25rem', paddingRight: '0.5rem', paddingBottom: '0.25rem', paddingLeft: '0.5rem', fontSize: '1rem', lineHeight: '1.125rem', fontWeight: 500 };

const orgOptions = async () => (await organizationsApi.list())
  .map((o) => ({ id: o.org_id, label: o.org_name }));

const dt = (v) => (v ? new Date(v).toLocaleString() : '—');

export const ADMIN_RESOURCES = {
  roles: {
    key: 'roles',
    title: 'Roles',
    subtitle: 'Define the access roles available to each organization.',
    icon: 'shield',
    api: rolesApi,
    idKey: 'role_id',
    orgScoped: true,
    searchKeys: ['role_name', 'role_description', 'org_name'],
    columns: [
      { key: 'role_id', label: 'ID', width: 70 },
      { key: 'role_name', label: 'Role Name' },
      { key: 'org_name', label: 'Organization' },
      { key: 'role_description', label: 'Description' },
      statusCol,
    ],
    fields: [
      { key: 'role_name', label: 'Role Name', type: 'text', required: true },
      { key: 'role_description', label: 'Description', type: 'textarea' },
      {
        key: 'org_id', label: 'Organization', type: 'select', loadOptions: orgOptions,
        help: 'Only needed for a super-admin creating a role outside their own organization.',
      },
      statusField,
    ],
  },

  permissions: {
    key: 'permissions',
    title: 'Permissions',
    subtitle: 'The bit-flag catalog every role’s page access is built from.',
    icon: 'key',
    api: permissionsApi,
    idKey: 'permission_id',
    searchKeys: ['permission_name'],
    columns: [
      { key: 'permission_id', label: 'ID', width: 70 },
      { key: 'permission_name', label: 'Name' },
      { key: 'permission_value', label: 'Bit Value', align: 'right', width: 110 },
      statusCol,
    ],
    fields: [
      { key: 'permission_name', label: 'Name', type: 'text', required: true },
      {
        key: 'permission_value', label: 'Bit Value', type: 'number', required: true,
        autoValue: (rows) => {
          const used = new Set(rows.map((r) => Number(r.permission_value)));
          let bit = 1;
          while (used.has(bit)) bit *= 2;
          return bit;
        },
        help: 'Must be a distinct power of two (1, 2, 4, 8…) so it combines cleanly into a bitmask.',
      },
      statusField,
    ],
  },

  modules: {
    key: 'modules',
    title: 'Modules',
    subtitle: 'The top-level areas of the app that pages belong to.',
    icon: 'boxes',
    api: modulesApi,
    idKey: 'module_id',
    searchKeys: ['module_name', 'module_code', 'module_route'],
    columns: [
      { key: 'module_id', label: 'ID', width: 70 },
      { key: 'module_name', label: 'Name' },
      { key: 'module_code', label: 'Code' },
      { key: 'module_route', label: 'Route' },
      { key: 'display_order', label: 'Order', align: 'right', width: 90 },
      statusCol,
    ],
    fields: [
      { key: 'module_name', label: 'Name', type: 'text', required: true },
      { key: 'module_code', label: 'Code', type: 'text' },
      { key: 'module_description', label: 'Description', type: 'textarea' },
      { key: 'module_route', label: 'Route', type: 'text', help: 'e.g. /roles' },
      { key: 'module_icon', label: 'Icon name', type: 'text' },
      { key: 'display_order', label: 'Display Order', type: 'number' },
      statusField,
    ],
  },

  pages: {
    key: 'pages',
    title: 'Pages',
    subtitle: 'Every routable page/menu entry, grouped by module and parent.',
    icon: 'route',
    api: pagesApi,
    idKey: 'page_id',
    searchKeys: ['page_name', 'page_url', 'module_name'],
    columns: [
      { key: 'page_id', label: 'ID', width: 70 },
      { key: 'page_name', label: 'Name' },
      { key: 'module_name', label: 'Module' },
      { key: 'parent_name', label: 'Parent' },
      { key: 'page_url', label: 'URL' },
      { key: 'is_menu', label: 'In Menu', width: 90, render: (row) => (row.is_menu ? 'Yes' : 'No') },
      statusCol,
    ],
    fields: [
      {
        key: 'module_id', label: 'Module', type: 'select', required: true,
        loadOptions: async () => (await modulesApi.list())
          .map((m) => ({ id: m.module_id, label: m.module_name })),
      },
      {
        key: 'parent_id', label: 'Parent Page', type: 'select',
        loadOptions: async () => (await pagesApi.list())
          .map((p) => ({ id: p.page_id, label: p.page_name })),
        help: 'Leave unset for a top-level page.',
      },
      { key: 'page_name', label: 'Name', type: 'text', required: true },
      { key: 'page_url', label: 'URL', type: 'text' },
      { key: 'page_code', label: 'Code', type: 'text' },
      { key: 'page_description', label: 'Description', type: 'textarea' },
      { key: 'icon_name', label: 'Icon name', type: 'text' },
      { key: 'display_order', label: 'Display Order', type: 'number' },
      { key: 'is_menu', label: 'Show in menu', type: 'checkbox' },
      statusField,
    ],
  },

  organizations: {
    key: 'organizations',
    title: 'Organizations',
    subtitle: 'The companies/tenants this install manages access for.',
    icon: 'building',
    api: organizationsApi,
    idKey: 'org_id',
    searchKeys: ['org_name', 'org_code', 'city_name', 'contact_person_name'],
    columns: [
      { key: 'org_id', label: 'ID', width: 70 },
      { key: 'org_name', label: 'Name' },
      { key: 'org_code', label: 'Code' },
      { key: 'city_name', label: 'City' },
      { key: 'contact_person_name', label: 'Contact' },
      statusCol,
    ],
    fields: [
      { key: 'org_name', label: 'Organization Name', type: 'text', required: true },
      { key: 'org_code', label: 'Code', type: 'text' },
      { key: 'legal_name', label: 'Legal Name', type: 'text' },
      { key: 'gst_number', label: 'GST Number', type: 'text' },
      { key: 'pan_number', label: 'PAN Number', type: 'text' },
      { key: 'registration_no', label: 'Registration No.', type: 'text' },
      { key: 'contact_person_name', label: 'Contact Person', type: 'text' },
      { key: 'contact_no', label: 'Contact No.', type: 'text' },
      { key: 'alternate_contact_no', label: 'Alternate Contact No.', type: 'text' },
      { key: 'email_id', label: 'Email', type: 'text' },
      { key: 'website_url', label: 'Website', type: 'text' },
      { key: 'logo_path', label: 'Logo URL', type: 'text' },
      { key: 'country_name', label: 'Country', type: 'text' },
      { key: 'state_name', label: 'State', type: 'text' },
      { key: 'city_name', label: 'City', type: 'text' },
      { key: 'address_line1', label: 'Address Line 1', type: 'text' },
      { key: 'address_line2', label: 'Address Line 2', type: 'text' },
      { key: 'pincode', label: 'Pincode', type: 'text' },
      statusField,
    ],
  },

  departments: {
    key: 'departments',
    title: 'Departments',
    subtitle: 'The departments employees are organized into, per organization.',
    icon: 'layers',
    api: departmentsApi,
    idKey: 'department_id',
    orgScoped: true,
    searchKeys: ['department_name', 'department_code', 'org_name'],
    columns: [
      { key: 'department_id', label: 'ID', width: 70 },
      { key: 'department_name', label: 'Name' },
      { key: 'department_code', label: 'Code' },
      { key: 'org_name', label: 'Organization' },
      statusCol,
    ],
    fields: [
      { key: 'department_name', label: 'Name', type: 'text', required: true },
      { key: 'department_code', label: 'Code', type: 'text' },
      { key: 'description', label: 'Description', type: 'textarea' },
      { key: 'org_id', label: 'Organization', type: 'select', loadOptions: orgOptions },
      statusField,
    ],
  },

  designations: {
    key: 'designations',
    title: 'Designations',
    subtitle: 'Job titles employees hold, per organization.',
    icon: 'id-card',
    api: designationsApi,
    idKey: 'designation_id',
    orgScoped: true,
    searchKeys: ['designation_name', 'designation_code', 'org_name'],
    columns: [
      { key: 'designation_id', label: 'ID', width: 70 },
      { key: 'designation_name', label: 'Name' },
      { key: 'designation_code', label: 'Code' },
      { key: 'org_name', label: 'Organization' },
      statusCol,
    ],
    fields: [
      { key: 'designation_name', label: 'Name', type: 'text', required: true },
      { key: 'designation_code', label: 'Code', type: 'text' },
      { key: 'description', label: 'Description', type: 'textarea' },
      { key: 'org_id', label: 'Organization', type: 'select', loadOptions: orgOptions },
      statusField,
    ],
  },

  employees: {
    key: 'employees',
    title: 'Employees',
    subtitle: 'The people who can be linked to a login (a User Master row).',
    icon: 'users',
    api: employeesApi,
    idKey: 'employee_id',
    orgScoped: true,
    autoCreateLogin: true,
    searchKeys: ['employee_name', 'employee_code', 'email_id'],
    columns: [
      { key: 'employee_id', label: 'ID', width: 70 },
      { key: 'employee_name', label: 'Name' },
      { key: 'employee_code', label: 'Code' },
      { key: 'department_name', label: 'Department' },
      { key: 'designation_name', label: 'Designation' },
      statusCol,
    ],
    fields: [
      { key: 'employee_name', label: 'Name', type: 'text', required: true },
      { key: 'employee_code', label: 'Code', type: 'text', help: 'Leave blank to auto-generate.' },
      { key: 'email_id', label: 'Email', type: 'text' },
      { key: 'mobile_no', label: 'Mobile No.', type: 'text' },
      {
        key: 'department_id', label: 'Department', type: 'select',
        loadOptions: async (orgId) => (await departmentsApi.list(orgId))
          .map((d) => ({ id: d.department_id, label: d.department_name })),
      },
      {
        key: 'designation_id', label: 'Designation', type: 'select',
        loadOptions: async (orgId) => (await designationsApi.list(orgId))
          .map((d) => ({ id: d.designation_id, label: d.designation_name })),
      },
      { key: 'joining_date', label: 'Joining Date', type: 'date' },
      {
        key: 'reporting_manager_id', label: 'Reporting Manager', type: 'select',
        loadOptions: async (orgId) => (await employeesApi.list(orgId))
          .map((e) => ({ id: e.employee_id, label: e.employee_name })),
      },
      { key: 'org_id', label: 'Organization', type: 'select', loadOptions: orgOptions },
      statusField,
    ],
  },

  users: {
    key: 'users',
    title: 'User Master',
    subtitle: 'The logins linked to employees, and the role each one has.',
    icon: 'user-cog',
    api: usersApi,
    idKey: 'user_id',
    orgScoped: true,
    searchKeys: ['user_name', 'employee_name', 'role_name'],
    columns: [
      { key: 'user_id', label: 'ID', width: 70 },
      { key: 'user_name', label: 'Username' },
      { key: 'employee_name', label: 'Employee' },
      { key: 'role_name', label: 'Role' },
      {
        key: 'account_locked', label: 'Account', width: 100,
        render: (row) => (row.account_locked
          ? <Badge tone="danger" style={PILL_STYLE}>Locked</Badge>
          : <Badge tone="success" style={PILL_STYLE}>OK</Badge>),
      },
      statusCol,
    ],
    fields: [
      { key: 'user_name', label: 'Username', type: 'text', required: true },
      {
        key: 'role_id', label: 'Role', type: 'select', required: true,
        loadOptions: async (orgId) => (await rolesApi.list(orgId))
          .map((r) => ({ id: r.role_id, label: r.role_name })),
      },
      {
        key: 'employee_id', label: 'Employee', type: 'select', required: true,
        loadOptions: async (orgId) => (await employeesApi.list(orgId))
          .map((e) => ({ id: e.employee_id, label: e.employee_name })),
      },
      { key: 'password_hash', label: 'Password', type: 'text', help: 'Leave blank to default to "Admin@123".' },
      { key: 'org_id', label: 'Organization', type: 'select', loadOptions: orgOptions },
      statusField,
    ],
  },

  'audit-logs': {
    key: 'audit-logs',
    title: 'Audit Logs',
    subtitle: 'Every insert/update/delete the app has made, with before/after data.',
    icon: 'logs',
    api: auditLogsApi,
    idKey: 'audit_id',
    readOnly: true,
    searchKeys: ['table_name', 'action_type', 'user_name'],
    columns: [
      { key: 'audit_id', label: 'ID', width: 80 },
      { key: 'table_name', label: 'Table' },
      {
        key: 'action_type', label: 'Action', width: 100,
        render: (row) => (
          <Badge tone={row.action_type === 'INSERT' ? 'success' : row.action_type === 'DELETE' ? 'danger' : 'warning'} style={PILL_STYLE}>
            {row.action_type}
          </Badge>
        ),
      },
      { key: 'user_name', label: 'User' },
      { key: 'created_at', label: 'When', render: (row) => dt(row.created_at) },
    ],
    fields: [
      { key: 'table_name', label: 'Table', type: 'text', readOnly: true },
      { key: 'action_type', label: 'Action', type: 'text', readOnly: true },
      { key: 'record_id', label: 'Record ID', type: 'text', readOnly: true },
      { key: 'user_name', label: 'User', type: 'text', readOnly: true },
      { key: 'ip_address', label: 'IP Address', type: 'text', readOnly: true },
      { key: 'old_data', label: 'Old Data', type: 'json', readOnly: true },
      { key: 'new_data', label: 'New Data', type: 'json', readOnly: true },
    ],
  },

  'login-history': {
    key: 'login-history',
    title: 'Login History',
    subtitle: 'Every sign-in attempt, successful or not.',
    icon: 'history',
    api: loginHistoryApi,
    idKey: 'login_history_id',
    readOnly: true,
    searchKeys: ['user_name', 'employee_name', 'ip_address'],
    columns: [
      { key: 'login_history_id', label: 'ID', width: 80 },
      { key: 'user_name', label: 'User' },
      { key: 'employee_name', label: 'Employee' },
      { key: 'login_time', label: 'Login', render: (row) => dt(row.login_time) },
      { key: 'logout_time', label: 'Logout', render: (row) => dt(row.logout_time) },
      {
        key: 'login_status', label: 'Status', width: 100,
        render: (row) => (
          <Badge tone={row.login_status === 'Success' ? 'success' : 'danger'} style={PILL_STYLE}>{row.login_status}</Badge>
        ),
      },
      { key: 'ip_address', label: 'IP Address' },
    ],
    fields: [
      { key: 'user_name', label: 'User', type: 'text', readOnly: true },
      { key: 'employee_name', label: 'Employee', type: 'text', readOnly: true },
      { key: 'login_status', label: 'Status', type: 'text', readOnly: true },
      { key: 'ip_address', label: 'IP Address', type: 'text', readOnly: true },
      { key: 'device_name', label: 'Device', type: 'text', readOnly: true },
      { key: 'browser_name', label: 'Browser', type: 'text', readOnly: true },
      { key: 'operating_system', label: 'OS', type: 'text', readOnly: true },
    ],
  },

  'user-sessions': {
    key: 'user-sessions',
    title: 'User Sessions',
    subtitle: 'Active and expired sessions issued to signed-in users.',
    icon: 'activity',
    api: userSessionsApi,
    idKey: 'session_id',
    readOnly: true,
    searchKeys: ['user_name', 'employee_name', 'ip_address'],
    columns: [
      { key: 'session_id', label: 'ID', width: 80 },
      { key: 'user_name', label: 'User' },
      { key: 'employee_name', label: 'Employee' },
      { key: 'login_time', label: 'Started', render: (row) => dt(row.login_time) },
      { key: 'expiry_time', label: 'Expires', render: (row) => dt(row.expiry_time) },
      {
        key: 'is_live', label: 'Status', width: 90,
        render: (row) => <Badge tone={row.is_live ? 'success' : 'neutral'} style={PILL_STYLE}>{row.is_live ? 'Live' : 'Ended'}</Badge>,
      },
      { key: 'ip_address', label: 'IP Address' },
    ],
    fields: [
      { key: 'user_name', label: 'User', type: 'text', readOnly: true },
      { key: 'employee_name', label: 'Employee', type: 'text', readOnly: true },
      { key: 'ip_address', label: 'IP Address', type: 'text', readOnly: true },
      { key: 'device_name', label: 'Device', type: 'text', readOnly: true },
    ],
  },

  'password-history': {
    key: 'password-history',
    title: 'Password History',
    subtitle: 'When each user’s password was last changed.',
    icon: 'lock',
    api: passwordHistoryApi,
    idKey: 'password_history_id',
    readOnly: true,
    searchKeys: ['user_name', 'employee_name'],
    columns: [
      { key: 'password_history_id', label: 'ID', width: 80 },
      { key: 'user_name', label: 'User' },
      { key: 'employee_name', label: 'Employee' },
      { key: 'created_at', label: 'Changed At', render: (row) => dt(row.created_at) },
    ],
    fields: [
      { key: 'user_name', label: 'User', type: 'text', readOnly: true },
      { key: 'employee_name', label: 'Employee', type: 'text', readOnly: true },
    ],
  },
};

export default ADMIN_RESOURCES;
