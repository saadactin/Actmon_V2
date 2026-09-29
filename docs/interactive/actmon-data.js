/* Loaded as a CLASSIC script, not a module, on purpose: an ES module cannot be
   imported from a file:// page, and this document has to open by double-click
   with no server and no build step. Everything is published on window.ACTMON. */
/* ===========================================================================
   ACTMON — verified content model for the interactive documentation.

   EVERY entry here was read out of this repository before being written down.
   The `status` field on each node is the honest classification the brief asked
   for, and its meaning is fixed:

     implemented  — the route, service and UI all exist and were read
     partial      — it works through another path, or only some of it is wired
     no-data      — the UI accepts it but the backend cannot supply it yet
     illustrative — a made-up example shown so the page is explorable offline

   Source of each claim is recorded in `src` so a reader can check it.
   Nothing in this file is a live measurement. Sample numbers are labelled.
   =========================================================================== */

const META = {
  title: 'ACTMON',
  subtitle: 'Unified database, cloud and infrastructure monitoring',
  builtFrom: 'Repository inspection — branch actmon_sept22',
  disclaimer:
    'All metrics, hostnames, queries and log lines in this document are illustrative samples. '
    + 'Nothing here is read from a live ACTMON installation.',
};

/* ── Level 0: the platform's own top-level modules ────────────────────────
   Read from frontend/src/config/navigation.js. The order is the order the
   product's own sidebar uses. Sales and Settings are real menu entries but
   are not monitoring domains, so they sit in `support` rather than the 3D
   ring — listing them keeps the inventory honest without implying they are
   part of the monitoring story. */
const MODULES = [
  {
    id: 'database',
    label: 'Database Monitoring',
    route: '/databases',
    icon: 'database',
    color: 0x35c3f3,
    angle: 0,
    status: 'implemented',
    src: 'config/navigation.js · App.jsx engine dashboard routes',
    blurb:
      'Seven database engines, each with its own dashboard built around what that engine '
      + 'actually exposes rather than one lowest-common-denominator view.',
    what:
      'ACTMON connects to a database server, reads its own statistics views, and presents them '
      + 'as a dashboard of tabs — health, performance, queries, locks, replication, roles, '
      + 'storage, configuration and logs.',
    why:
      'A DBA otherwise reads these from a dozen separate catalogue queries typed by hand. '
      + 'Having them in one place, refreshed on a schedule and kept as history, is what turns '
      + '"the database feels slow" into a specific statement about a specific object.',
    children: 'engines',
  },
  {
    id: 'cloud',
    label: 'Cloud Monitoring',
    route: '/cloud',
    icon: 'cloud',
    color: 0x6f7cf7,
    angle: 51,
    status: 'implemented',
    src: 'Backend/cloud/app/providers/{aws,azure,oci}',
    blurb:
      'A separate microservice that authenticates to a cloud account, walks its regions and '
      + 'inventories what is running there.',
    what:
      'Three providers are implemented — AWS, Azure and OCI. Each has its own authentication '
      + 'module, resource scanner and cost-capability declaration.',
    why:
      'Cloud spend and cloud inventory drift faster than anyone tracks by hand. Discovery is '
      + 'the first step: you cannot monitor or cost-control a resource nobody knew existed.',
    children: 'providers',
  },
  {
    id: 'infra',
    label: 'Infrastructure Monitoring',
    route: '/infra',
    icon: 'server',
    color: 0x2fd6a6,
    angle: 103,
    status: 'implemented',
    src: 'App.jsx /infra routes · pages/infra/InfraHostDetail.jsx',
    blurb:
      'The host underneath the database — CPU, memory, disks, processes, ports, services and '
      + 'its actual configuration files.',
    what:
      'Each monitored host has a detail page with nine tabs, plus a file explorer for reading '
      + 'configuration off the machine.',
    why:
      'Most "database problems" are host problems. A query that got slower because the disk got '
      + 'slower is only diagnosable if both are visible from the same tool.',
    children: 'infraTabs',
  },
  {
    id: 'agents',
    label: 'Agents & Collection',
    route: '/agents',
    icon: 'shield',
    color: 0x7cd6f0,
    angle: 154,
    status: 'implemented',
    src: 'services/agent/agent_install_service.py · services/common/db_proxy_service.py',
    blurb:
      'How ACTMON reaches a monitored system. Not every target uses an agent, and the rule for '
      + 'which do is in the source.',
    what:
      'A small collector installed on the monitored host, enrolled with a one-time token. '
      + 'Windows ships as an MSI behind a .bat; Linux as .deb/.rpm behind a shell script.',
    why:
      'An agent can see what a network connection cannot — the host\'s own CPU, its disks, its '
      + 'service state, and a database bound only to localhost.',
    children: 'collection',
  },
  {
    id: 'alerts',
    label: 'Alerts & Notifications',
    route: '/alerts',
    icon: 'alert',
    color: 0xf2b23c,
    angle: 206,
    status: 'partial',
    src: 'config/alertCatalog.js · services/alerts/alert_engine_service.py',
    blurb:
      'Rules over collected metrics, and nine delivery channels. The catalogue is candid about '
      + 'which rules the backend can actually raise.',
    what:
      'Rules are defined per resource and evaluated against collected data. Each rule in the '
      + 'catalogue declares its own evaluation tier.',
    why:
      'Nobody watches a dashboard at 3am. But an alert that silently never fires is worse than '
      + 'no alert, which is why the tier is shown in the product itself.',
    children: 'alertTiers',
  },
  {
    id: 'logs',
    label: 'Logs & Diagnostics',
    route: '/logs',
    icon: 'logs',
    color: 0x9d8df1,
    angle: 257,
    status: 'implemented',
    src: 'config/navigation.js · pages/*/ErrorLogs.jsx (six engines)',
    blurb:
      'The engine\'s own log file, parsed into severity-classified events with the surrounding '
      + 'context a diagnosis needs.',
    what:
      'Each engine has its own log reader. For PostgreSQL that is the CSV log, giving timestamp, '
      + 'severity, database, user, PID, message, detail, hint, context and SQLSTATE.',
    why:
      'Metrics tell you something changed. The log usually tells you what. A checkpoint storm and '
      + 'a deadlock look identical in a graph of transaction latency.',
    children: null,
  },
  {
    id: 'admin',
    label: 'Administration & Access',
    route: '/administration',
    icon: 'lock',
    color: 0xff8fa3,
    angle: 309,
    status: 'implemented',
    src: 'pages/administration/AccessControlPage.jsx · page_master / group_role_page_permission',
    blurb:
      'Who may see and do what, expressed as a permission bitmask per role per page.',
    what:
      'Roles, pages, permissions and role-permission grants, with a per-user role assignment tab '
      + 'and an audit log.',
    why:
      'A monitoring tool holds credentials for every production database in the estate. Access '
      + 'control is not an afterthought here, it is the containment boundary.',
    children: 'rbac',
  },
];

/* Real menu entries that are not monitoring domains. Listed for completeness
   so the inventory is not quietly selective. */
const SUPPORT_MODULES = [
  { label: 'Dashboard', route: '/dashboard', note: 'Cross-module landing page' },
  { label: 'Cloud Dashboard', route: '/cloud-dashboard', note: 'Cloud-specific landing page' },
  { label: 'Settings', route: '/settings', note: 'Appearance, notification channels, preferences' },
  { label: 'Sales', route: '/sales', note: 'Not a monitoring module' },
  { label: 'Help Center', route: '/help-center', note: 'In-product documentation' },
];

/* ── Level 2: database engines ────────────────────────────────────────────
   One entry per dashboard route found in App.jsx. `direct` records whether
   db_proxy_service will attempt a server-direct connection for that engine:
   _DIRECT_CAPABLE is ("mysql", "maria", "postgre", "pg") and direct is
   additionally refused when the host is loopback, because the agent's
   "localhost" is not the ACTMON server's localhost. */
const ENGINES = [
  {
    id: 'postgresql', label: 'PostgreSQL', route: '/postgresql-dashboard/:id',
    color: 0x4a9fd8, angle: 0, status: 'implemented', tabs: 16, direct: true,
    src: 'App.jsx:331 · config/postgresDashboardNav.js',
    note: 'The most fully built engine — 16 dashboard tabs, a query-analysis workspace and a role-privilege inspector.',
  },
  {
    id: 'mysql', label: 'MySQL', route: '/mysql-dashboard/:id',
    color: 0xf2994a, angle: 51, status: 'implemented', tabs: null, direct: true,
    src: 'App.jsx:316 · config/mysqlDashboardNav.js',
    note: 'Slow-query log reader, index analysis, error-log self-heal and its own query-analysis workspace.',
  },
  {
    id: 'mariadb', label: 'MariaDB', route: 'via MySQL', color: 0xc4915c, angle: 103,
    status: 'partial', tabs: null, direct: true,
    src: 'services/common/db_agent_checks.py:30 · agent_collector_service.py:1222',
    note: 'Accepted as a supported tech by the agent collector and the connection checks, and handled through '
        + 'the MySQL code path. There is no separate MariaDB dashboard route.',
  },
  {
    id: 'mssql', label: 'SQL Server', route: '/mssql-dashboard/:id',
    color: 0xd64550, angle: 154, status: 'implemented', tabs: null, direct: false,
    src: 'App.jsx:363 · config/mssqlDashboardNav.js',
    note: 'Slow queries from sys.dm_exec_query_stats. Plan-XML retrieval is not implemented — the engine '
        + 'catalogue marks hasExplain false.',
  },
  {
    id: 'mongodb', label: 'MongoDB', route: '/mongodb-dashboard/:id',
    color: 0x3fa037, angle: 206, status: 'implemented', tabs: null, direct: false,
    src: 'App.jsx:374 · config/mongodbDashboardNav.js',
    note: 'Collection analysis and real .explain() output. Has no stable per-query id, so its detail page '
        + 'cannot be recovered by reload.',
  },
  {
    id: 'oracle', label: 'Oracle', route: '/oracle-dashboard/:id',
    color: 0xe03c31, angle: 257, status: 'implemented', tabs: null, direct: false,
    src: 'App.jsx:343 · config/oracleDashboardNav.js',
    note: 'v$sqlarea slow queries, v$sql_plan execution plans, storage health and a maintenance-job runner.',
  },
  {
    id: 'clickhouse', label: 'ClickHouse', route: '/clickhouse-dashboard/:id',
    color: 0xfbd42c, angle: 309, status: 'implemented', tabs: null, direct: false,
    src: 'App.jsx:383 · config/clickhouseDashboardNav.js',
    note: 'Parts and table analysis. Also used internally as ACTMON\'s own metrics history store.',
  },
  {
    id: 'cosmosdb', label: 'Azure Cosmos DB', route: '/cosmosdb-dashboard/:id',
    color: 0x0078d4, angle: 25, status: 'implemented', tabs: null, direct: false, ring: 2,
    src: 'App.jsx:393 · config/cosmosCatalog.jsx',
    note: 'A cloud-native database with its own dashboard. The catalogue records the RU cost and '
        + 'cross-partition behaviour of every operation ACTMON issues, plus what each HTTP status means.',
  },
];

/* Explicitly NOT a monitored database technology, recorded because the brief
   asked about it and silence would be ambiguous. */
const NOT_ENGINES = [
  {
    label: 'Redis',
    verdict: 'Not a monitored database technology',
    detail:
      'There is no Redis dashboard route and no Redis entry in the engine catalogue. Redis appears twice '
      + 'in the codebase for unrelated reasons: as the hot tier of ACTMON\'s own metrics pipeline '
      + '(services/redis/redis_store_service.py), and as a cloud resource the Azure scanner inventories '
      + '(Azure Cache for Redis). Neither is database monitoring.',
  },
  {
    label: 'Google Cloud Platform',
    verdict: 'Not implemented',
    detail:
      'Backend/cloud/app/providers contains aws, azure and oci only. There is no GCP provider, scanner '
      + 'or authentication module, so Cloud SQL and other GCP services are not discoverable.',
  },
];

/* ── Level 3: PostgreSQL dashboard tabs ───────────────────────────────────
   All sixteen, in the order config/postgresDashboardNav.js declares them.
   Note Reports and Diagnose: both exist in the product. */
const PG_TABS = [
  {
    id: 'overview', label: 'Overview', status: 'implemented', angle: 0,
    what: 'The instance at a glance — is it up, how hard is it working, and how big is it.',
    why: 'The first question in any incident is whether the database is the problem at all. This tab '
       + 'answers that in one screen before anyone starts reading query plans.',
    monitors: ['Connection state and uptime', 'Active vs idle sessions', 'Database size', 'Transactions per second', 'Cache hit ratio', 'Host CPU and memory where an agent supplies them'],
    sample: [
      ['Health', 'Healthy'], ['Active connections', '18'], ['Cache hit ratio', '99.2 %'],
      ['Transactions / sec', '145'], ['Database size', '8.4 GB'], ['Uptime', '21 d 4 h'],
    ],
    scenario:
      'A support ticket says the ticketing application is slow. Overview shows 18 of 100 connections used, '
      + 'a 99.2 % cache hit ratio and normal transaction throughput. The database is not saturated — which '
      + 'redirects the investigation to a specific statement rather than capacity.',
    dba: 'Read it top to bottom before anything else. If every number is ordinary, the problem is a query or '
       + 'the host, not the instance.',
    related: ['performance', 'slow-queries'],
  },
  {
    id: 'performance', label: 'Performance', status: 'implemented', angle: 22.5,
    what: 'Throughput and efficiency over time rather than at one instant.',
    why: 'A single reading cannot tell you whether 40 % cache hit ratio is a crisis or a nightly batch job. '
       + 'The shape of the line does.',
    monitors: ['Commits and rollbacks', 'Cache hit ratio trend', 'Connection utilisation', 'Tuples read, returned, inserted, updated, deleted', 'Block reads from disk vs from cache', 'Temporary file usage'],
    sample: [
      ['Commits / sec', '141'], ['Rollbacks / sec', '4'], ['Rollback ratio', '2.8 %'],
      ['Blocks from cache', '99.2 %'], ['Temp files written', '3 (last hour)'],
    ],
    scenario:
      'Rollback ratio climbs from under 1 % to 12 % over an afternoon. Nothing else changes. That pattern '
      + 'points at application errors or lock timeouts, not at database capacity.',
    dba: 'Watch ratios, not absolutes. A rising rollback ratio and rising temp-file count are both early '
       + 'signals that arrive before users complain.',
    related: ['overview', 'queries'],
  },
  {
    id: 'queries', label: 'Queries', status: 'implemented', angle: 45,
    what: 'Every statement pg_stat_statements has recorded, aggregated by normalised form.',
    why: 'The statement that is slow once matters less than the statement that is mildly slow ten thousand '
       + 'times an hour. This is where that distinction becomes visible.',
    monitors: ['Execution count', 'Mean, min, max and total execution time', 'Rows returned per call', 'Cache hit percentage per statement', 'Temporary blocks read', 'Query type classification'],
    sample: [
      ['Statement', 'SELECT … FROM tickets WHERE assignee_id = $1'],
      ['Calls', '48,210'], ['Mean time', '38 ms'], ['Total time', '30 min 34 s'],
      ['Rows / call', '12'], ['Cache hit', '99.8 %'],
    ],
    scenario:
      'A statement averaging 38 ms looks harmless until the Total time column shows it has consumed thirty '
      + 'minutes of server time today — more than any single slow query on the instance.',
    dba: 'Sort by Total time, not by Mean. Optimising the frequent-and-mediocre usually returns more than '
       + 'optimising the rare-and-terrible.',
    related: ['slow-queries', 'performance'],
    note: 'Requires the pg_stat_statements extension. The dashboard detects its absence and shows a setup '
        + 'guide with the exact configuration lines rather than an empty table.',
  },
  {
    id: 'slow-queries', label: 'Slow Queries', status: 'implemented', angle: 67.5,
    what: 'The same digest filtered to the expensive end, with severity, filters and a detail page.',
    why: 'It is the entry point to the query-analysis workspace, which is where a statement stops being a '
       + 'row in a table and becomes a diagnosis.',
    monitors: ['Average and maximum duration', 'Execution count', 'Database and user', 'First and last seen', 'Severity derived from duration thresholds', 'Filters by duration, database, user, severity, date and text'],
    sample: [
      ['Query', 'SELECT * FROM ticket_events WHERE created_at > $1'],
      ['Severity', 'High'], ['Avg time', '1,830 ms'], ['Max time', '4,210 ms'],
      ['Executions', '4,200'], ['Database', 'Actin-TicketingTool'],
    ],
    scenario:
      'Four statements cross the threshold. One is a nightly report nobody waits for; one runs 4,200 times a '
      + 'day inside the ticket list. Only the second is worth an index.',
    dba: 'Severity is computed from duration thresholds, not from business impact. Read the execution count '
       + 'before deciding what to fix.',
    related: ['query-analysis', 'indexes'],
    deepDive: 'slowQuery',
  },
  {
    id: 'query-analysis', label: 'Query Analysis', status: 'implemented', angle: 90,
    virtual: true,
    what: 'The detail page behind any slow query: plan, table and index metadata, rule-based findings, and '
        + 'an optional AI pass over that same evidence.',
    why: 'An execution plan on its own tells you a sequential scan happened. It does not tell you whether an '
       + 'index already exists on the filtered column. Checking both is what separates advice from guessing.',
    monitors: ['Execution plan as a node tree', 'Estimated vs actual rows where measured', 'Real index definitions and usage counts for the query\'s own tables', 'Table row estimates, dead tuples and last-analyse time', 'Redundant and unused indexes', 'Rule-based findings, each with its evidence'],
    sample: [
      ['Plan', 'Seq Scan on ticket_events  (rows≈250,000)'],
      ['Finding', 'No index leads with created_at'],
      ['Evidence', 'Table holds ~250,000 rows · existing indexes: ticket_events_pkey'],
      ['Suggestion', 'CREATE INDEX CONCURRENTLY … ON ticket_events (created_at);'],
    ],
    scenario: 'See the guided walkthrough — it follows one statement from the list to a specific recommendation.',
    dba: 'Read the evidence line before the recommendation. Every finding carries the exact number or plan '
       + 'line it came from, so a suggestion you disagree with can be checked rather than argued about.',
    related: ['slow-queries', 'indexes', 'tables'],
    deepDive: 'slowQuery',
    safety:
      'Plain EXPLAIN is the default and executes nothing. EXPLAIN ANALYZE genuinely runs the statement, so it '
      + 'is a separate confirmed action and the server refuses it for anything that is not provably a read — '
      + 'including a CTE that hides a DELETE.',
  },
  {
    id: 'databases', label: 'Databases', status: 'implemented', angle: 112.5,
    what: 'Every database on the instance, its size, owner, encoding and whether it can be read.',
    why: 'An instance is rarely one database. Knowing which of them grew 40 % this month is a capacity '
       + 'question you cannot answer from a single connection.',
    monitors: ['Database name, owner, encoding and collation', 'Size on disk', 'Table count visible to the monitoring user', 'Connection counts', 'Commits and rollbacks per database', 'Accessibility status'],
    sample: [
      ['Actin-TicketingTool', '8.4 GB · Active · 14 connections'],
      ['postgres', '8.2 MB · Idle'],
      ['reporting_archive', '22.1 GB · Read-only'],
    ],
    scenario:
      'A database shows as Inaccessible. That is not always a fault — it can simply mean the monitoring role '
      + 'has no CONNECT privilege, which is a deliberate choice worth confirming rather than an outage.',
    dba: 'Status here reflects what the monitoring user can see, not what exists. An empty database and one '
       + 'you cannot read look different, and the status labels distinguish them.',
    related: ['tables', 'storage'],
  },
  {
    id: 'tables', label: 'Tables', status: 'implemented', angle: 135,
    what: 'Schema and table inventory with sizes, row estimates and activity.',
    why: 'Storage growth and query cost both trace back to specific tables. This is where you find which.',
    monitors: ['Schema and table name', 'Row estimate', 'Table, index and total size', 'Sequential vs index scan counts', 'Last vacuum and analyse', 'Column and index counts'],
    sample: [
      ['ticket_events', '2.4 M rows · 3.1 GB total · 1.2 GB indexes'],
      ['tickets', '184 K rows · 412 MB total'],
      ['attachments', '61 K rows · 4.6 GB total'],
    ],
    scenario:
      'A table with 1.2 GB of indexes on 1.9 GB of data is carrying more index than most workloads need. '
      + 'Whether that is wrong depends on the read pattern — but it is worth asking.',
    dba: 'Row counts are planner estimates from the catalogue, not COUNT(*). On a table that has never been '
       + 'analysed they can be badly wrong, and the dashboard says when that is the case.',
    related: ['indexes', 'storage'],
  },
  {
    id: 'locks', label: 'Locks', status: 'implemented', angle: 157.5,
    what: 'Current locks, which sessions hold them, and which sessions are waiting behind them.',
    why: 'A blocked query consumes no CPU and shows no slow-query entry. Without a lock view it is invisible '
       + 'right up until users complain.',
    monitors: ['Lock type and mode', 'Locked object with its kind', 'Granted, waiting and blocking state', 'Blocking PIDs via pg_blocking_pids()', 'Query age of the holding backend', 'System vs application objects'],
    sample: [
      ['PID 4821', 'Blocking · RowExclusiveLock on tickets · 94 s'],
      ['PID 4903', 'Waiting ← 4821 · ShareLock on tickets'],
      ['PID 4915', 'Waiting ← 4821 · ShareLock on tickets'],
    ],
    scenario:
      'Two sessions wait behind one long-running transaction on tickets. The holder has been open 94 seconds '
      + '— almost always an application that opened a transaction and then went away, not a slow statement.',
    dba: 'Find the holder, not the waiters. Killing a waiter frees nothing. ACTMON shows the blocking PID '
       + 'directly so the chain does not have to be reconstructed by hand.',
    related: ['queries', 'error-logs'],
    note: 'ACTMON excludes its own backend from this view. Its monitoring queries take AccessShareLocks like '
        + 'any other reader, and showing them would bury real contention in noise. A "Show system objects" '
        + 'toggle reveals catalogue locks when they are genuinely wanted.',
  },
  {
    id: 'replication', label: 'Replication', status: 'implemented', angle: 180,
    what: 'Primary and standby roles, WAL sender processes, replication slots, lag and conflicts.',
    why: 'Replication lag is a data-loss window. Nobody notices a broken standby until they need it.',
    monitors: ['Recovery state — primary or standby', 'WAL sender processes and their state', 'Sent, written, flushed and replayed LSN', 'Write, flush and apply lag', 'Byte lag per replica', 'Replication slots and wal_status', 'Per-database conflict counters'],
    sample: [
      ['Role', 'Primary'], ['Standbys connected', '2'],
      ['standby-1', 'streaming · sync · 0 ms apply lag'],
      ['standby-2', 'streaming · async · 240 ms apply lag · 1.2 MB byte lag'],
    ],
    scenario:
      'A slot shows wal_status = lost. That means WAL the standby still needed has already been removed — the '
      + 'standby cannot catch up and must be rebuilt. It is a quiet failure that a lag graph alone would miss.',
    dba: 'Watch the slot state as closely as the lag number. An inactive slot with a growing WAL backlog will '
       + 'eventually fill the primary\'s disk, which is a worse outage than the lag it was protecting against.',
    related: ['storage', 'config'],
    illustrative: 'The primary/standby topology shown is a sample arrangement, not a picture of any real deployment.',
  },
  {
    id: 'users', label: 'Users', status: 'implemented', angle: 202.5,
    what: 'Roles, their attributes, memberships, object ownership, active sessions — and what each role can '
        + 'actually do.',
    why: 'PostgreSQL privileges are cumulative and indirect. What a role can do is rarely what was granted to '
       + 'it directly.',
    monitors: ['Login and superuser attributes', 'CREATEDB, CREATEROLE, REPLICATION, BYPASSRLS, INHERIT', 'Connection limit and password expiry date', 'Role memberships in both directions', 'Database, schema, table, sequence and function privileges', 'Object ownership', 'Active sessions for the role'],
    sample: [
      ['Role', 'migration_user'], ['Can log in', 'Yes'], ['Superuser', 'No'],
      ['Member of', 'app_writer'], ['Owns', '3 tables, 1 sequence'], ['Active sessions', '0'],
    ],
    scenario: 'See the interactive role inspector — it walks through one role\'s effective access.',
    dba: 'Never assume a role\'s direct grants are the whole story. Membership, ownership and PUBLIC all add '
       + 'privileges that no GRANT statement against that role will show.',
    related: ['admin', 'databases'],
    deepDive: 'role',
    safety:
      'The role inspector never displays a password or a password hash. Only metadata PostgreSQL exposes '
      + 'safely — whether a password is set, and when it expires — is shown.',
  },
  {
    id: 'storage', label: 'Storage', status: 'implemented', angle: 225,
    what: 'Where the disk has gone: databases, tables, indexes, TOAST, tablespaces, bloat and vacuum debt.',
    why: 'Disk exhaustion takes a database down completely, and the warning signs are visible weeks earlier.',
    monitors: ['Database and table sizes', 'Index size against table size', 'Dead tuples and dead-row ratio', 'Tables overdue for vacuum and time since last', 'Tablespace locations and sizes', 'TOAST storage per table', 'Autovacuum settings'],
    sample: [
      ['Total tables', '184'], ['Largest', 'attachments · 4.6 GB'],
      ['Bloat candidates', '3 tables over 20 % dead'],
      ['Never vacuumed', '1 table'],
    ],
    scenario:
      'A table shows 36 % dead rows and no autovacuum in thirty days. Every sequential scan on it is reading '
      + 'a third more pages than it needs to — a slow, invisible tax on every query that touches it.',
    dba: 'Sort by dead-row ratio rather than size. A small, heavily-churned table can cost more than a large '
       + 'static one.',
    related: ['tables', 'maintenance'],
  },
  {
    id: 'config', label: 'Config', status: 'implemented', angle: 247.5,
    what: 'The server\'s current settings, their source, and whether changing one needs a restart.',
    why: 'Half of tuning is discovering a setting is not what everyone assumed it was.',
    monitors: ['Parameter name, current value and unit', 'Source — default, configuration file, command line or session', 'Restart requirement', 'Category grouping', 'Short description'],
    sample: [
      ['max_connections', '100 · configuration file · restart required'],
      ['shared_buffers', '2 GB · configuration file · restart required'],
      ['work_mem', '4 MB · default'],
      ['maintenance_work_mem', '64 MB · default'],
      ['wal_level', 'replica · configuration file · restart required'],
    ],
    scenario:
      'A sort keeps spilling to disk. work_mem reads 4 MB and its source is "default" — meaning nobody has '
      + 'ever tuned it on this instance, not that 4 MB was chosen deliberately.',
    dba: 'The source column matters as much as the value. "default" means unconsidered; "configuration file" '
       + 'means somebody decided.',
    related: ['performance', 'maintenance'],
    illustrative: 'The values above are examples of the shape of the data, not recommendations. work_mem is '
                + 'per sort per connection — raising it globally multiplies across concurrency.',
  },
  {
    id: 'maintenance', label: 'Maintenance', status: 'implemented', angle: 270,
    what: 'Housekeeping state — vacuum, analyse, and the WAL archive.',
    why: 'PostgreSQL does not expire an external WAL archive on its own. That is left to the DBA, and a full '
       + 'archive volume stops the primary.',
    monitors: ['Vacuum and analyse recency per table', 'Autovacuum configuration', 'WAL archive state where configured'],
    sample: [['Tables needing vacuum', '3'], ['Oldest un-analysed table', '31 days']],
    scenario:
      'The archive directory has grown past its volume. Cleaning it requires knowing which WAL files every '
      + 'replication slot and standby still needs — deleting past that point breaks replication permanently.',
    dba: 'Treat archive cleanup as a safety-checked operation, never a scheduled rm. The boundary has to be '
       + 'recomputed at the moment of deletion, because a slot\'s requirement changes minute by minute.',
    related: ['storage', 'replication'],
    safety: 'Potentially destructive maintenance is not executed automatically. Actions of this kind are '
          + 'explicit, confirmed, and re-validated server-side before anything is removed.',
  },
  {
    id: 'error-logs', label: 'Error Logs', status: 'implemented', angle: 292.5,
    what: 'The PostgreSQL log, parsed into structured, severity-classified events.',
    why: 'The log carries the detail, hint and context fields that say what actually failed. A metric never will.',
    monitors: ['Timestamp and severity', 'Database, user and PID', 'Message, detail, hint and context', 'SQLSTATE', 'Application name and session id', 'Offending statement where logged'],
    sample: [
      ['2026-09-29 10:54:46', 'LOG', 'checkpoint complete: wrote 3 buffers'],
      ['2026-09-29 09:12:03', 'ERROR', 'deadlock detected · SQLSTATE 40P01'],
      ['2026-09-29 08:44:57', 'FATAL', 'remaining connection slots are reserved · SQLSTATE 53300'],
    ],
    scenario:
      'A burst of 53300 errors at 08:44 says the instance ran out of connection slots. That is a pool sizing '
      + 'problem in the application, not a database capacity problem — and only the log distinguishes them.',
    dba: 'Filter to ERROR and FATAL first. LOG-level checkpoint lines are normal and will drown everything '
       + 'else if left in.',
    related: ['locks', 'alerts'],
    note: 'Needs PostgreSQL to be logging in CSV format with logging_collector on. Without it the page falls '
        + 'back to pg_stat_activity, which is far more limited, and says so.',
  },
  {
    id: 'indexes', label: 'Indexes', status: 'implemented', angle: 315,
    what: 'Index inventory with size and usage, including indexes that appear unused.',
    why: 'Every index slows every write and occupies disk. An index nothing reads is pure cost.',
    monitors: ['Index name, definition and columns', 'Size on disk', 'Scan count from pg_stat_user_indexes', 'Unique and primary flags', 'Validity', 'Redundancy — indexes whose columns prefix another\'s'],
    sample: [
      ['tickets_pkey', 'unique · 8.2 MB · 1,204,882 scans'],
      ['idx_tickets_status', '14 MB · 0 scans'],
      ['idx_tickets_status_assignee', '22 MB · 88,140 scans'],
    ],
    scenario:
      'idx_tickets_status shows zero scans and its columns are a prefix of idx_tickets_status_assignee — the '
      + 'longer index already serves everything the shorter one could.',
    dba: 'Zero scans means unused since statistics were last reset, which is not the same as never used. '
       + 'Check the reset time, and check for a quarterly job, before dropping anything.',
    related: ['tables', 'query-analysis'],
    note: 'ACTMON states the reset caveat in the product rather than presenting a zero as proof.',
  },
  {
    id: 'reports', label: 'Reports', status: 'implemented', angle: 337.5,
    what: 'Scheduled and on-demand reporting over collected data.',
    why: 'Weekly evidence for people who will never open a dashboard.',
    monitors: ['Report generation and export', 'Scheduled delivery where configured'],
    sample: [['Export', 'CSV']],
    scenario: 'A weekly slow-query summary sent to the application team without anyone logging in.',
    dba: 'Useful for trend conversations with people outside the database team.',
    related: ['slow-queries'],
    note: 'Present as a dashboard tab. Its per-engine depth varies; the PostgreSQL and MySQL slow-query '
        + 'exports were the ones verified during this inspection.',
  },
  {
    id: 'diagnose', label: 'Diagnose', status: 'implemented', angle: 11.25,
    what: 'A guided diagnostic view that pulls related signals together.',
    why: 'An incident rarely respects tab boundaries.',
    monitors: ['Cross-tab diagnostic signals'],
    sample: [['Entry point', 'PostgreSQL dashboard → Diagnose']],
    scenario: 'Used when the question is "what is wrong" rather than "show me locks".',
    dba: 'A starting point when the symptom is vague.',
    related: ['overview', 'locks'],
    note: 'Confirmed as a registered dashboard tab in config/postgresDashboardNav.js. Its internal depth was '
        + 'not exhaustively traced during this inspection.',
  },
];

/* ── Cloud providers ──────────────────────────────────────────────────────
   Resource types are the _scan_* methods actually present in each scanner. */
const PROVIDERS = [
  {
    id: 'aws', label: 'Amazon Web Services', color: 0xff9900, angle: 0, status: 'implemented',
    src: 'Backend/cloud/app/providers/aws/aws_scanner.py',
    auth: 'aws_auth.py, with iam_policy.py declaring the read-only permissions the scan needs.',
    resources: ['EC2 instances', 'EBS volumes', 'RDS instances', 'RDS / Aurora clusters', 'ElastiCache',
                'Redshift', 'Lambda functions', 'EKS clusters', 'DynamoDB tables', 'Elastic Load Balancers',
                'VPCs', 'Subnets', 'Security groups', 'IAM roles', 'API Gateway', 'Bedrock'],
    cost: 'Cost Explorer integration with declared capabilities. The Budgets API is explicitly not integrated '
        + '— the capability module names that as an unsupported reason rather than failing silently.',
    note: 'Regions are enumerated and scanners run per region. Access-denied responses are caught per '
        + 'resource type, so one missing permission does not abort the whole scan.',
  },
  {
    id: 'azure', label: 'Microsoft Azure', color: 0x0078d4, angle: 120, status: 'implemented',
    src: 'Backend/cloud/app/providers/azure/azure_scanner.py',
    auth: 'azure_auth.py, with azure_rbac.py covering role assignments.',
    resources: ['Virtual machines', 'Managed disks', 'Storage accounts', 'Azure SQL', 'Azure Database for PostgreSQL',
                'Azure Database for MySQL', 'Cosmos DB', 'Azure Cache for Redis', 'AKS clusters', 'Networking'],
    cost: 'Consumption cost data with declared capabilities. The Consumption Budgets API is not integrated.',
    note: 'Cosmos DB appears twice in ACTMON and the distinction matters: here as an inventoried cloud '
        + 'resource, and separately as a first-class database dashboard reached through the Database module.',
  },
  {
    id: 'oci', label: 'Oracle Cloud Infrastructure', color: 0xc74634, angle: 240, status: 'implemented',
    src: 'Backend/cloud/app/providers/oci/oci_scanner.py',
    auth: 'oci_auth.py. Scans walk subscribed regions and then compartments within each.',
    resources: ['Compute instances', 'Block volumes', 'Boot volumes', 'Object storage', 'File systems',
                'Analytics instances', 'WAF', 'Virtual circuits', 'DRG attachments', 'Databases',
                'DB systems', 'MySQL DB systems', 'NoSQL tables', 'VCNs', 'Subnets', 'Security lists'],
    cost: 'Usage and cost data with declared capabilities. The OCI Budgets API is not integrated.',
    note: 'OCI\'s compartment hierarchy means a resource is identified by region and compartment together, '
        + 'which the event model encodes explicitly.',
  },
];

/* ── Infrastructure host tabs ─────────────────────────────────────────────
   From pages/infra/InfraHostDetail.jsx TAB_ICONS / SLUG_FOR_TAB. */
const INFRA_TABS = [
  { id: 'overview', label: 'Overview', what: 'CPU, memory, load and host availability at a glance.' },
  { id: 'ports', label: 'Ports', what: 'Listening ports, with a count badge on the tab.' },
  { id: 'processes', label: 'Processes', what: 'Running processes and their resource consumption.' },
  { id: 'storage', label: 'Storage', what: 'Filesystems, capacity and utilisation.' },
  { id: 'network', label: 'Network', what: 'Interfaces and network activity.' },
  { id: 'services', label: 'Services', what: 'Service state on the host.' },
  { id: 'diagnostics', label: 'Diagnostics', what: 'Host-level diagnostic checks.' },
  { id: 'ip-configuration', label: 'IP Configuration', what: 'Addressing and routing detail.' },
  { id: 'config-files', label: 'Config Files', what: 'Reads configuration files from the host.' },
];

const INFRA_EXTRA = {
  fileExplorer: '/infra/:id/files — a file explorer for the monitored host.',
  ranges: 'History windows of 1 hour, 4 hours, 24 hours, 3 days, 7 days or a custom range, at per-minute, '
        + '15-minute, 30-minute or hourly granularity.',
  correlation:
    'Infrastructure and database health are deliberately reachable from one another. If PostgreSQL query '
    + 'times rise and the same host shows elevated disk latency in the same window, both are visible in one '
    + 'tool — but a correlation in time is not proof of cause, and neither the product nor this document '
    + 'claims otherwise.',
};

/* ── Collection methods ───────────────────────────────────────────────── */
const COLLECTION = {
  agent: {
    label: 'Host agent',
    detail: 'A collector installed on the monitored machine, enrolled with a one-time token. It reports host '
          + 'metrics and proxies database queries from the host itself.',
    platforms: ['Windows — MSI, installed by a generated .bat', 'Linux — .deb / .rpm, installed by a generated shell script'],
    enrol: 'The installer posts a token plus the hostname and os_type to the enrolment endpoint. The token is '
         + 'single-use; the agent then holds its own credential.',
    src: 'services/agent/agent_install_service.py',
  },
  direct: {
    label: 'Server-direct connection',
    detail: 'ACTMON connects straight to the database from its own server, with no agent on the target.',
    rule: 'Attempted only for MySQL, MariaDB and PostgreSQL — and refused when the configured host is loopback.',
    why: 'On a loopback host, "localhost" means the agent machine, which is a different computer from the '
       + 'ACTMON server. A direct attempt there can only mislead: at best it fails with an unrelated error, '
       + 'at worst it silently monitors the wrong database.',
    src: 'services/common/db_proxy_service.py — _DIRECT_CAPABLE and _can_go_direct',
  },
  note: 'Not every integration uses an agent. Cloud monitoring uses provider APIs with cloud credentials and '
      + 'installs nothing. SQL Server, Oracle, MongoDB and ClickHouse are reached through the agent path.',
};

/* ── Metrics pipeline ─────────────────────────────────────────────────── */
const PIPELINE = {
  src: 'services/common/metrics_pipeline.py',
  tiers: [
    { id: 'collect', label: 'Collection', detail: 'An agent or a direct connection produces a metric sample.' },
    { id: 'classify', label: 'Classification', detail: 'The pipeline tags each sample with its kind (infrastructure or database), its technology, and the connection it belongs to.' },
    { id: 'hot', label: 'Hot tier — Redis', detail: 'Latest value plus a one-hour ring and lookup indexes. This is what a live dashboard reads.' },
    { id: 'cold', label: 'History tier — ClickHouse', detail: 'Per-module, per-technology tables. A sample displaced from the hot ring lands here.' },
    { id: 'durable', label: 'Configuration — PostgreSQL', detail: 'Connections, roles, permissions, alert rules and audit records live in ACTMON\'s own PostgreSQL database.' },
  ],
  note: 'The whole pipeline is behind a METRICS_PIPELINE_ENABLED switch. Storage is deliberately split: '
      + 'Redis answers "what is it now", ClickHouse answers "what was it last Tuesday", and PostgreSQL holds '
      + 'the things that must survive regardless.',
};

/* ── Alerts ──────────────────────────────────────────────────────────────
   The tier labels and counts come from config/alertCatalog.js, which
   classifies every rule it offers. This is the product's own honesty about
   what it can and cannot raise, not an external assessment. */
const ALERT_TIERS = [
  {
    id: 'live', label: 'Live', count: 5, tone: 'ok',
    detail: 'Checked against host state on every poll. These fire reliably.',
    examples: ['Host down / unreachable', 'CPU usage', 'Memory usage', 'Disk usage', 'Database service stopped'],
  },
  {
    id: 'collector', label: 'Agent-reported', count: 13, tone: 'info',
    detail: 'Raised when an agent reports the condition; the rule is what lets it through.',
    examples: ['Active connections', 'Slow queries'],
  },
  {
    id: 'reserved', label: 'No data source yet', count: 25, tone: 'warn',
    detail: 'The rule can be saved and looks configured, but the backend cannot raise it yet.',
    examples: ['Swap usage', 'Load average', 'Disk I/O wait', 'Database not responding', 'Connection usage %', 'Average query latency'],
  },
];

const ALERT_NOTE =
  'The catalogue surfaces this tier in the product itself. The comment in the source explains why: '
  + '"I made a rule and it never fired" is otherwise impossible to diagnose from the frontend. '
  + 'Twenty-five of forty-three rule types currently have no data source — that is a real limitation, '
  + 'stated by the product rather than discovered by a customer.';

const CHANNELS = [
  { id: 'email', label: 'Email', detail: 'Templated subject line with alert, severity and server placeholders.' },
  { id: 'teams', label: 'Microsoft Teams', detail: 'Incoming webhook, with a default channel.' },
  { id: 'slack', label: 'Slack', detail: 'Webhook, with channel, bot username and icon.' },
  { id: 'telegram', label: 'Telegram', detail: 'Bot token and one or more chat ids.' },
  { id: 'whatsapp', label: 'WhatsApp', detail: 'Business Cloud API — phone number id, business account id, access token.' },
  { id: 'webhook', label: 'Generic webhook', detail: 'POST or PUT, custom headers, none / basic / bearer auth.' },
  { id: 'pagerduty', label: 'PagerDuty', detail: 'Integration key.' },
  { id: 'jira', label: 'Jira Service Management', detail: 'Ticket creation.' },
  { id: 'servicenow', label: 'ServiceNow', detail: 'Incident creation.' },
];

/* ── RBAC ────────────────────────────────────────────────────────────── */
const RBAC = {
  model: 'Permissions are a bitmask held per role, per page. A page is a row in page_master with a URL, a '
       + 'module, a parent and a display order; a grant is a row in group_role_page_permission.',
  bits: [
    { label: 'View', value: 1 }, { label: 'Add', value: 2 }, { label: 'Edit', value: 4 },
    { label: 'Delete', value: 8 }, { label: 'Print', value: 16 }, { label: 'Export', value: 32 },
    { label: 'Execute', value: 64 }, { label: 'Approve', value: 128 }, { label: 'Restart', value: 256 },
  ],
  composite: 'Full Access is the composite value 511 — every individual bit set.',
  ungoverned:
    'A URL absent from page_master is treated as ungoverned, meaning any signed-in user can reach it. That '
    + 'is why registering a new page is part of shipping it, not an afterthought.',
  credentials:
    'Monitored-system credentials are encrypted at rest and never returned to the browser. No password, '
    + 'token or connection string appears in any API response or in this document.',
  audit: 'Configuration changes are written to an audit log alongside the operational data.',
};

/* ── Guided walkthroughs — clearly illustrative ──────────────────────── */
const WALKTHROUGHS = {
  slowQuery: {
    title: 'Investigating a slow query',
    subtitle: 'Illustrative — a worked example, not a recording of a real incident',
    steps: [
      {
        t: 'The symptom', tab: 'overview',
        b: 'The ticket list feels slow. Overview shows 18 of 100 connections in use, 99.2 % cache hit ratio, '
         + '145 transactions per second. The instance is not saturated, so capacity is not the answer.',
      },
      {
        t: 'Find the statement', tab: 'slow-queries',
        b: 'Slow Queries lists four statements over the threshold. One averages 1,830 ms and has run 4,200 '
         + 'times today — 2 hours 8 minutes of cumulative server time. That is the one.',
      },
      {
        t: 'Read the plan', tab: 'query-analysis',
        b: 'Opening it runs a plain EXPLAIN — which computes a plan without executing anything. The plan is a '
         + 'sequential scan over ticket_events with a filter on created_at.',
        code: 'Sort\n  └─ Seq Scan on ticket_events\n       Filter: (created_at > $1)\n       Estimated rows: 250,000',
      },
      {
        t: 'Check what already exists', tab: 'query-analysis',
        b: 'Before claiming an index is missing, ACTMON reads the table\'s real indexes. ticket_events has '
         + 'only its primary key. No index leads with created_at — so this is a genuine gap, not a planner '
         + 'choosing badly between existing options.',
      },
      {
        t: 'The finding, with its evidence', tab: 'query-analysis',
        b: 'Each finding carries the number it came from, so it can be checked rather than trusted.',
        code: '[high] MISSING_INDEX  No index leads with created_at on public.ticket_events\n'
            + '  evidence: Table holds ~250,000 rows · existing indexes: ticket_events_pkey\n'
            + '  suggestion: CREATE INDEX CONCURRENTLY idx_ticket_events_created_at\n'
            + '                ON public.ticket_events (created_at);\n'
            + '  trade-off: every index slows INSERT/UPDATE/DELETE and uses disk.',
      },
      {
        t: 'Look at the host too', tab: null,
        b: 'The Infrastructure tab for the same host shows disk latency also rose in that window. Both facts '
         + 'are now visible — but a correlation in time is not proof of cause, and the sequential scan is '
         + 'sufficient to explain the query on its own.',
      },
      {
        t: 'Decide, do not auto-apply', tab: null,
        b: 'ACTMON does not create the index. It presents the evidence, the suggested statement and the '
         + 'trade-off; a human decides whether the filter is selective enough to be worth it. The original '
         + 'statement is never rewritten or replaced.',
      },
    ],
  },

  role: {
    title: 'What can this role actually do?',
    subtitle: 'Illustrative sample role — migration_user',
    steps: [
      {
        t: 'The attributes', tab: 'users',
        b: 'migration_user can log in and is not a superuser. INHERIT is on, so it automatically receives the '
         + 'privileges of roles it belongs to.',
        rows: [['Can log in', 'Yes'], ['Superuser', 'No'], ['Create DB', 'No'], ['Create role', 'No'],
               ['Replication', 'No'], ['Inherit', 'Yes'], ['Connection limit', 'Unlimited'],
               ['Password set', 'Yes — never displayed'], ['Valid until', 'No expiry']],
      },
      {
        t: 'Membership changes everything', tab: 'users',
        b: 'It is a member of app_writer. Because INHERIT is on, every privilege app_writer holds is also '
         + 'migration_user\'s — without a single GRANT naming migration_user.',
      },
      {
        t: 'Direct grants are not effective access', tab: 'users',
        b: 'ACTMON computes effective access with PostgreSQL\'s own has_*_privilege() functions rather than '
         + 'reading the grant tables. Those functions account for direct grants, inherited grants, privileges '
         + 'held by PUBLIC, and superuser status all at once — which is the only way to answer the question '
         + 'correctly.',
      },
      {
        t: 'Ownership is a privilege too', tab: 'users',
        b: 'migration_user owns three tables and a sequence. An owner can ALTER and DROP what it owns '
         + 'regardless of any GRANT, so ownership is listed separately rather than folded into the privilege '
         + 'totals.',
      },
      {
        t: 'What is never shown', tab: 'users',
        b: 'No password. No password hash or verifier. Only the metadata PostgreSQL exposes safely: that a '
         + 'password exists, and when it expires.',
      },
    ],
  },

  incident: {
    title: 'From metric to resolution',
    subtitle: 'Illustrative workflow — ACTMON does not diagnose incidents automatically',
    steps: [
      { t: '1 · Collect', tab: null, b: 'An agent reports host and database metrics. Samples land in the Redis hot tier and roll into ClickHouse history.' },
      { t: '2 · Detect', tab: null, b: 'An alert rule evaluates the sample. Whether it can fire at all depends on its tier — five rule types are checked live, thirteen are agent-reported, twenty-five have no data source yet.' },
      { t: '3 · Notify', tab: null, b: 'A firing alert is delivered through the configured channels — email, Teams, Slack, Telegram, WhatsApp, a generic webhook, PagerDuty, Jira or ServiceNow.' },
      { t: '4 · Investigate', tab: 'slow-queries', b: 'The operator opens the affected resource: slow queries for a latency complaint, locks for a stall, storage for a disk warning.' },
      { t: '5 · Correlate', tab: null, b: 'Host metrics and database metrics for the same window sit in the same tool. Relating them is the operator\'s judgement, not an automatic conclusion.' },
      { t: '6 · Read the log', tab: 'error-logs', b: 'The engine log supplies detail, hint, context and SQLSTATE — the fields that say what actually failed.' },
      { t: '7 · Resolve', tab: null, b: 'A human decides and acts. ACTMON presents evidence and suggestions; it does not apply schema changes or restart services on its own.' },
    ],
  },
};

/* ── Presentation chapters ───────────────────────────────────────────── */
const CHAPTERS = [
  { id: 'intro', title: 'Introducing ACTMON', level: { type: 'overview' },
    body: 'One tool for the database, the host it runs on, and the cloud account that pays for it. Built for '
        + 'DBAs and infrastructure engineers who currently hold three tools and a terminal.' },
  { id: 'arch', title: 'Platform architecture', level: { type: 'module', id: 'agents' },
    body: 'Collection by agent or direct connection, a two-tier metrics pipeline, and configuration in '
        + 'ACTMON\'s own PostgreSQL database.' },
  { id: 'db', title: 'Database monitoring', level: { type: 'module', id: 'database' },
    body: 'Seven engines, each with a dashboard shaped around what that engine actually exposes.' },
  { id: 'engines', title: 'Technology explorer', level: { type: 'module', id: 'database' },
    body: 'What is fully implemented, what rides another engine\'s path, and what is not supported at all.' },
  { id: 'pg', title: 'PostgreSQL deep dive', level: { type: 'engine', id: 'postgresql' },
    body: 'Sixteen tabs, from a health summary to an evidence-based query analyser.' },
  { id: 'cloud', title: 'Cloud monitoring', level: { type: 'module', id: 'cloud' },
    body: 'AWS, Azure and OCI — discovery, inventory and cost capability, with the gaps named.' },
  { id: 'infra', title: 'Infrastructure monitoring', level: { type: 'module', id: 'infra' },
    body: 'Nine host tabs and a file explorer, so a database problem that is really a disk problem is visible.' },
  { id: 'agentsch', title: 'Agents and collection', level: { type: 'module', id: 'agents' },
    body: 'Not everything uses an agent. The rule for what does is in the source, and so is the reason.' },
  { id: 'alertsch', title: 'Alerts and diagnostics', level: { type: 'module', id: 'alerts' },
    body: 'Nine notification channels, and a catalogue candid about which rules can actually fire.' },
  { id: 'sec', title: 'Security and administration', level: { type: 'module', id: 'admin' },
    body: 'A permission bitmask per role per page, encrypted credentials, and an audit log.' },
  { id: 'flow', title: 'An example workflow', level: { type: 'walkthrough', id: 'slowQuery' },
    body: 'One slow query, followed from the symptom to a specific, checkable recommendation.' },
];


window.ACTMON = { META, MODULES, SUPPORT_MODULES, ENGINES, NOT_ENGINES, PG_TABS, PROVIDERS, INFRA_TABS, INFRA_EXTRA, COLLECTION, PIPELINE, ALERT_TIERS, ALERT_NOTE, CHANNELS, RBAC, WALKTHROUGHS, CHAPTERS };
