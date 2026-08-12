/**
 * NAVIGATION — the sidebar list.
 *
 * This mirrors `module_master` exactly (same names, routes, icons and
 * display_order), because that is what the running app shows. The backend serves
 * the RBAC-filtered version at GET /auth/menu; this list is the fallback used
 * before login and whenever that call hasn't landed yet, so the rail never
 * changes shape between the two.
 *
 * Flat by design — one row per module, no groups, no nested items.
 *
 *   id     module_code, lowercased — stable key
 *   label  module_name
 *   to     module_route
 *   icon   module_icon (resolved through components/ui/Icon.jsx)
 */
export const MENU_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', to: '/dashboard', icon: 'layout-grid' },
  { id: 'agents', label: 'Agents', to: '/agents', icon: 'shield' },
  { id: 'databases', label: 'Database', to: '/databases', icon: 'database' },
  { id: 'cloud', label: 'Cloud', to: '/cloud', icon: 'cloud' },
  { id: 'infrastructure', label: 'Infrastructure', to: '/infra', icon: 'settings' },
  { id: 'ml', label: 'ML/AI', to: '/ml', icon: 'code-xml' },
  { id: 'alerts', label: 'Alerts', to: '/alerts', icon: 'alert' },
  { id: 'administration', label: 'Administration', to: '/administration', icon: 'user-cog' },
  { id: 'settings', label: 'Setting', to: '/settings', icon: 'settings' },
  // `mark` names a full-colour brand mark to use instead of the monochrome nav
  // glyph, where a module has one. The bar still shows `icon`.
  { id: 'chatbot', label: 'ChatBot', to: '/chatbot', icon: 'bot', mark: 'actmon-ai' },
  { id: 'sales', label: 'Sales', to: '/sales', icon: 'chart-trend' },
  { id: 'help-center', label: 'Help Center', to: '/help-center', icon: 'help' },
];

/**
 * Modules that are routed but hold no slot in the bar.
 *
 * The bar has exactly the eleven items the design specifies. Logs still has a
 * page, and App.jsx builds its route from NAV_INDEX, so listing it here keeps
 * /logs reachable instead of turning it into a 404 the moment it leaves the bar.
 */
export const EXTRA_ITEMS = [
  { id: 'logs', label: 'Logs', to: '/logs', icon: 'logs' },
];

/**
 * Bar order, keyed by route.
 *
 * Ordering by ROUTE (not module id) means the same order applies to the server
 * menu after login, so the bar doesn't reshuffle once RBAC data arrives. Routes
 * absent from this list keep their incoming order and sit at the end.
 */
export const MENU_ORDER = MENU_ITEMS.map((i) => i.to);

/**
 * Route → the label and glyph the bar must show.
 *
 * GET /auth/menu returns module_master's own names and icons, which differ from
 * the design ("Databases", a desktop glyph for Infrastructure). Overlaying this
 * map means the bar looks the same before and after login, and changing what an
 * item is called or wears is an edit here rather than a data migration.
 */
export const MENU_PRESENTATION = MENU_ITEMS.reduce(
  (acc, i) => ({ ...acc, [i.to]: { label: i.label, icon: i.icon } }),
  {},
);

/** Everything with a route — feeds generated routes, breadcrumbs and placeholders. */
export const NAV_INDEX = [...MENU_ITEMS, ...EXTRA_ITEMS];

/** Route segment → readable label, for breadcrumbs on paths outside the menu. */
export const ROUTE_LABELS = {
  '': 'Home',
  dashboard: 'Dashboard',
  agents: 'Agents',
  deploy: 'Deploy',
  setup: 'Setup',
  sessions: 'Sessions',
  website: 'Website',
  'network-check': 'Network check',
  connections: 'Connections',
  databases: 'Databases',
  'add-server': 'Add server',
  'add-os-server': 'Add OS server',
  'add-data': 'Add data source',
  diagnose: 'Diagnose',
  server: 'Server',
  'mysql-servers': 'MySQL',
  'postgresql-servers': 'PostgreSQL',
  'oracle-servers': 'Oracle',
  'mssql-servers': 'SQL Server',
  'mongodb-servers': 'MongoDB',
  'clickhouse-servers': 'ClickHouse',
  'cosmosdb-servers': 'Cosmos DB',
  'mysql-dashboard': 'MySQL',
  'postgresql-dashboard': 'PostgreSQL',
  'oracle-dashboard': 'Oracle',
  'mssql-dashboard': 'SQL Server',
  'mongodb-dashboard': 'MongoDB',
  'clickhouse-dashboard': 'ClickHouse',
  'cosmosdb-dashboard': 'Cosmos DB',
  'cosmosdb-edit': 'Edit',
  'slow-queries': 'Slow queries',
  'slow-operations': 'Slow operations',
  'error-logs': 'Error logs',
  'error-analysis': 'Error analysis',
  'index-analysis': 'Index analysis',
  'table-analysis': 'Table analysis',
  'collection-analysis': 'Collection analysis',
  'self-heal': 'Self heal',
  backup: 'Backup',
  detail: 'Detail',
  reports: 'Reports',
  infra: 'Infrastructure',
  files: 'Files',
  cloud: 'Cloud',
  accounts: 'Accounts',
  resources: 'Resources',
  cost: 'Cost',
  topology: 'Topology',
  compliance: 'Compliance',
  security: 'Security',
  'digital-experience': 'Digital Experience',
  ml: 'ML / AI',
  alerts: 'Alerts',
  logs: 'Logs',
  telemetry: 'Telemetry',
  chatbot: 'ChatBot',
  administration: 'Administration',
  roles: 'Roles',
  permissions: 'Permissions',
  modules: 'Modules',
  pages: 'Pages',
  organizations: 'Organizations',
  departments: 'Departments',
  designations: 'Designations',
  'audit-logs': 'Audit logs',
  'login-history': 'Login history',
  'user-sessions': 'User sessions',
  'password-history': 'Password history',
  'role-permissions': 'Role permissions',
  users: 'Users',
  employees: 'Employees',
  settings: 'Settings',
  sales: 'Sales',
  'help-center': 'Help Center',
};

export default MENU_ITEMS;
