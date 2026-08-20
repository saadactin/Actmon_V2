/**
 * Extra route prefixes that belong to a top-nav module WITHOUT physically
 * nesting under that module's own path in the URL — e.g. `/mysql-dashboard/:id`
 * belongs to Database (`/databases`) but doesn't start with `/databases/...`,
 * so the top nav's own prefix check would never keep "Database" lit while
 * viewing it. Cloud/Infrastructure/Agents/Settings don't need an entry here —
 * every one of their sub-routes already nests under their own `to` path, so a
 * plain prefix match already keeps them lit with no extra config.
 *
 * Only list prefixes that DON'T already start with the module's own `to` —
 * those already match without help. Consumed by TopNav (keeps the parent
 * module highlighted) — add an entry here whenever a new module gains a
 * sub-route that lives outside its own path, rather than hardcoding a check
 * into any one page.
 */
export const EXTRA_MODULE_PREFIXES = {
  '/databases': [
    '/connections', '/diagnose',
    '/mysql-servers', '/mysql-dashboard',
    '/postgresql-servers', '/postgresql-dashboard',
    '/oracle-servers', '/oracle-dashboard',
    '/mssql-servers', '/mssql-dashboard',
    '/mongodb-servers', '/mongodb-dashboard',
    '/clickhouse-servers', '/clickhouse-dashboard',
    '/cosmosdb-servers', '/cosmosdb-dashboard', '/cosmosdb-edit',
  ],
  '/administration': [
    '/role-permissions',
    '/roles', '/permissions', '/modules', '/pages', '/organizations',
    '/departments', '/designations', '/employees', '/users',
    '/ai-chat-sessions', '/help-center-appearance',
  ],
  // Moved here from Administration (migrations/2026-08-20_logs_module.sql) —
  // flat routes, not nested under /logs, so they need the same treatment.
  '/logs': [
    '/audit-logs', '/login-history', '/user-sessions', '/password-history',
  ],
};

const startsWithSegment = (pathname, base) => pathname === base || pathname.startsWith(`${base}/`);

/** Does `pathname` belong to the module whose top-nav route is `moduleTo`? */
export function isModuleActive(pathname, moduleTo) {
  if (startsWithSegment(pathname, moduleTo)) return true;
  return (EXTRA_MODULE_PREFIXES[moduleTo] || []).some((prefix) => startsWithSegment(pathname, prefix));
}
