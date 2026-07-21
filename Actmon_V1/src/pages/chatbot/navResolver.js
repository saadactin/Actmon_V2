/**
 * ActMon AI — natural-language navigation resolver.
 *
 * resolveNavigation(text, connections) → { path, title, conn?, subPage?, confidence } | null
 *
 * Understands free-form phrases ("please open the mysql database", "take me to
 * cloud cost", "show login history") and maps them to a real app route. It is
 * deliberately conservative: genuine questions ("how do I open slow queries?")
 * are NOT treated as navigation so they still reach the AI.
 */

/* verbs that signal the user wants to GO somewhere */
const NAV_VERBS = [
  'navigate to', 'take me to', 'bring up', 'jump to', 'switch to', 'go to', 'goto',
  'open up', 'open', 'show me', 'show', 'launch', 'view', 'visit', 'display', 'goto',
];
/* words that signal a QUESTION (never navigate on these) */
const QUESTION_WORDS = ['how', 'what', 'why', 'when', 'which', 'who', 'should', 'explain',
  'tell me', 'can you tell', 'difference', 'compare', 'best practice', 'recommend'];

/* per-engine dashboard route base */
const DB_ROUTE = {
  mysql: 'mysql-dashboard', mariadb: 'mysql-dashboard',
  postgresql: 'postgresql-dashboard', postgres: 'postgresql-dashboard', pg: 'postgresql-dashboard',
  oracle: 'oracle-dashboard', mssql: 'mssql-dashboard', 'sql server': 'mssql-dashboard',
  mongodb: 'mongodb-dashboard', mongo: 'mongodb-dashboard', clickhouse: 'clickhouse-dashboard',
};
const DB_TYPE_KEYWORDS = {
  mysql: ['mysql', 'mariadb', 'maria'],
  postgresql: ['postgresql', 'postgres', 'psql', 'pg'],
  mongodb: ['mongodb', 'mongo'],
  mssql: ['mssql', 'sql server', 'sqlserver', 'microsoft sql'],
  oracle: ['oracle', 'ora'],
  clickhouse: ['clickhouse', 'click house'],
};
/* dashboard sub-pages (relative to /{engine}-dashboard/:id) */
const SUBPAGES = [
  { seg: 'slow-queries',        kw: ['slow queries', 'slow query', 'slow sql', 'top queries'] },
  { seg: 'error-logs',          kw: ['error logs', 'error log', 'errors'] },
  { seg: 'index-analysis',      kw: ['index analysis', 'indexes', 'indices', 'index'] },
  { seg: 'reports',             kw: ['reports', 'report'] },
  { seg: 'slow-operations',     kw: ['slow operations', 'slow operation', 'slow ops'] },
  { seg: 'collection-analysis', kw: ['collection analysis', 'collections', 'collection'] },
  { seg: 'table-analysis',      kw: ['table analysis', 'tables'] },
  { seg: 'backup',              kw: ['backup', 'backups'] },
  { seg: 'self-heal',           kw: ['self heal', 'self-heal', 'auto heal'] },
];

/* Static app destinations — most specific first (ties resolve to the earlier one). */
export const NAV_DESTINATIONS = [
  // Databases
  { path: '/databases',               title: 'Databases',            kw: ['databases', 'database servers', 'db servers', 'all databases', 'database'] },
  { path: '/databases/add-data',      title: 'Add Database',         kw: ['add database', 'new database', 'monitor database', 'register database', 'add db'] },
  { path: '/databases/add-os-server', title: 'Add OS Server',        kw: ['add os server', 'add server', 'new server'] },
  { path: '/connections',             title: 'Connections',          kw: ['connections', 'database connections', 'connection list'] },
  { path: '/connections/add',         title: 'Add Connection',       kw: ['add connection', 'new connection'] },
  // Agents
  { path: '/agents',                  title: 'Agents',               kw: ['agents', 'agent list', 'all agents'] },
  { path: '/agents/setup',            title: 'Add Agent',            kw: ['add agent', 'new agent', 'agent setup', 'setup agent', 'install agent'] },
  { path: '/agents/deploy',           title: 'Deploy Agent',         kw: ['deploy agent', 'agent deploy'] },
  // Cloud
  { path: '/cloud',                   title: 'Cloud',                kw: ['cloud', 'cloud dashboard', 'cloud overview'] },
  { path: '/cloud/accounts',          title: 'Cloud Accounts',       kw: ['cloud accounts', 'cloud account'] },
  { path: '/cloud/resources',         title: 'Cloud Resources',      kw: ['cloud resources', 'cloud resource'] },
  { path: '/cloud/cost',              title: 'Cloud Cost',           kw: ['cloud cost', 'cloud billing', 'cloud spend', 'billing', 'cost'] },
  { path: '/cloud/security',          title: 'Cloud Security',       kw: ['cloud security'] },
  { path: '/cloud/topology',          title: 'Cloud Topology',       kw: ['cloud topology', 'topology'] },
  { path: '/cloud/compliance',        title: 'Cloud Compliance',     kw: ['cloud compliance', 'compliance'] },
  { path: '/cloud/alerts',            title: 'Cloud Alerts',         kw: ['cloud alerts'] },
  // Infra
  { path: '/infra',                   title: 'Infrastructure',       kw: ['infrastructure', 'infra', 'hosts', 'host list', 'servers'] },
  // ML / AI
  { path: '/ml',                      title: 'ML / AI',              kw: ['ml', 'ai', 'machine learning', 'ml / ai', 'ml ai', 'anomaly'] },
  // Alerts / Logs
  { path: '/alerts',                  title: 'Alerts',               kw: ['alerts', 'alerting', 'notifications', 'incidents'] },
  { path: '/logs',                    title: 'Logs',                 kw: ['logs', 'log viewer', 'system logs'] },
  // Administration
  { path: '/administration',          title: 'Administration',       kw: ['administration', 'admin', 'admin panel'] },
  { path: '/roles',                   title: 'Roles',                kw: ['roles', 'role master'] },
  { path: '/permissions',             title: 'Permissions',          kw: ['permissions', 'permission master'] },
  { path: '/role-permissions',        title: 'Role Permissions',     kw: ['role permissions', 'access control', 'role permission'] },
  { path: '/modules',                 title: 'Modules',              kw: ['modules', 'module master'] },
  { path: '/pages',                   title: 'Pages',                kw: ['pages', 'page master'] },
  { path: '/organizations',           title: 'Organizations',        kw: ['organizations', 'orgs', 'organization', 'org master', 'tenants'] },
  { path: '/departments',             title: 'Departments',          kw: ['departments', 'department'] },
  { path: '/designations',            title: 'Designations',         kw: ['designations', 'designation'] },
  { path: '/users',                   title: 'Users',                kw: ['users', 'user master', 'user accounts'] },
  { path: '/employees',               title: 'Employees',            kw: ['employees', 'employee master', 'staff'] },
  { path: '/audit-logs',              title: 'Audit Logs',           kw: ['audit logs', 'audit log', 'audit trail'] },
  { path: '/login-history',           title: 'Login History',        kw: ['login history', 'logins', 'sign in history'] },
  { path: '/user-sessions',           title: 'User Sessions',        kw: ['user sessions', 'active sessions', 'sessions'] },
  { path: '/password-history',        title: 'Password History',     kw: ['password history', 'passwords'] },
  // Misc
  { path: '/settings',                title: 'Settings',             kw: ['settings', 'preferences', 'appearance', 'configuration', 'config'] },
  { path: '/chatbot',                 title: 'ActMon AI',            kw: ['chatbot', 'ai assistant', 'actmon ai', 'chat'] },
  { path: '/dashboard',               title: 'Dashboard',            kw: ['dashboard', 'home', 'overview', 'monitoring overview'] },
];

/* per-tech server list pages (/{tech}-servers) */
const TECH_SERVER_PAGES = Object.keys(DB_TYPE_KEYWORDS).map((tech) => ({
  path: `/${tech}-servers`, title: `${tech} servers`, tech,
}));

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (text, phrase) => new RegExp(`(?:^|\\W)${esc(phrase)}(?:\\W|$)`, 'i').test(text);
const hasNavVerb = (text) => NAV_VERBS.some((v) => hasWord(text, v));
// a command-like opener: "open …", "please open …", "can you show …", "i want to view …"
const PREFIXES = ['', 'please ', 'can you ', 'could you ', 'i want to ', 'i would like to ', 'lets ', "let's ", 'pls '];
const startsWithNavVerb = (text) => NAV_VERBS.some((v) => PREFIXES.some((p) => text.startsWith(p + v + ' ')));
const looksLikeQuestion = (text) => text.trim().endsWith('?') || QUESTION_WORDS.some((q) => hasWord(text, q));

function dashboardPath(conn) {
  const base = DB_ROUTE[(conn.db_type || '').toLowerCase()] || 'mysql-dashboard';
  return `/${base}/${conn.id}`;
}
function detectSubPage(text) {
  for (const s of SUBPAGES) if (s.kw.some((k) => hasWord(text, k))) return s;
  return null;
}

/**
 * @param {string} text        raw user message
 * @param {Array}  connections [{ id, connection_name, host, db_type }]
 */
export function resolveNavigation(text, connections = []) {
  const lower = String(text || '').toLowerCase().trim();
  if (!lower) return null;

  const navVerb = hasNavVerb(lower);
  const cmdLike = startsWithNavVerb(lower);
  // Questions are answered by the AI — unless the message clearly STARTS as a
  // navigation command ("open …", "take me to …"), which wins over a stray "how".
  if (looksLikeQuestion(lower) && !cmdLike) return null;

  // 1) Match a specific DB connection by its name or host (highest priority).
  let best = null;
  for (const c of connections) {
    for (const key of [c.connection_name, c.host]) {
      if (key && hasWord(lower, String(key).toLowerCase())) {
        const sub = detectSubPage(lower);
        const base = dashboardPath(c);
        best = {
          path: sub ? `${base}/${sub.seg}` : base,
          title: `${c.connection_name || c.host}${sub ? ' · ' + sub.seg.replace('-', ' ') : ''}`,
          conn: c, subPage: sub?.seg || null, confidence: 0.95,
        };
        break;
      }
    }
    if (best) break;
  }

  // 2) Match a DB engine keyword → that engine's server list (or a connection of that type).
  if (!best) {
    for (const [tech, kws] of Object.entries(DB_TYPE_KEYWORDS)) {
      if (kws.some((k) => hasWord(lower, k))) {
        const sub = detectSubPage(lower);
        const conn = connections.find((c) => {
          const t = (c.db_type || '').toLowerCase();
          return t === tech || kws.some((k) => t.includes(k));
        });
        if (conn && sub) {
          best = { path: `${dashboardPath(conn)}/${sub.seg}`, title: `${conn.connection_name || conn.host} · ${sub.seg.replace('-', ' ')}`, conn, subPage: sub.seg, confidence: 0.9 };
        } else {
          best = { path: `/${tech}-servers`, title: `${tech.toUpperCase()} servers`, confidence: 0.8 };
        }
        break;
      }
    }
  }

  // 3) Score static app destinations — prefer the longest / most-specific keyword hit.
  if (!best) {
    let bestScore = 0, bestDest = null;
    for (const d of NAV_DESTINATIONS) {
      for (const kw of d.kw) {
        if (hasWord(lower, kw)) {
          const score = kw.split(/\s+/).length * 100 + kw.length;   // multi-word > single-word > short
          if (score > bestScore) { bestScore = score; bestDest = d; }
        }
      }
    }
    if (bestDest) {
      // require a clear intent: a nav verb, OR the message is essentially just the page name.
      const wordCount = lower.split(/\s+/).length;
      const strong = bestScore >= 200;          // matched a 2+ word phrase
      if (navVerb || strong || wordCount <= 3) {
        best = { path: bestDest.path, title: bestDest.title, confidence: navVerb ? 0.85 : 0.6 };
      }
    }
  }

  return best;
}
