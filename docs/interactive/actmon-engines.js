/* ===========================================================================
   Per-engine dashboard sections.

   Every tab list below was read out of that engine's own nav config before
   being written down:

     MySQL       frontend/src/config/mysqlDashboardNav.js
     Oracle      frontend/src/config/oracleDashboardNav.js
     SQL Server  frontend/src/config/mssqlDashboardNav.js
     MongoDB     frontend/src/config/mongodbDashboardNav.js
     ClickHouse  frontend/src/config/clickhouseDashboardNav.js
     Cosmos DB   frontend/src/pages/cosmosdb/CosmosDBDashboard.jsx

   HONESTY NOTE, and it matters: the tab INVENTORY is verified — these are the
   sections each dashboard registers, with the engine's own wording (SQL Server
   says "Logins" and "Always On", not "Users" and "Replication"). What each tab
   DOES is described from the database concept it names and from how that
   engine exposes it, not from tracing every component the way PostgreSQL was
   traced. Where a tab's internal depth was not inspected, `depth: 'inventory'`
   says so on the engine, and the UI repeats it.

   Nothing here claims a capability the nav config does not register.
   =========================================================================== */

const ENGINE_DEPTH_NOTE =
  'Tab inventory verified from this engine\'s nav config. Per-tab internals were traced '
  + 'exhaustively for PostgreSQL only — these descriptions explain what each section is for, '
  + 'not every control inside it.';

/* ── MySQL / MariaDB ─────────────────────────────────────────────────────
   16 tabs. Binary Logs is the one with no PostgreSQL equivalent and is
   genuinely MySQL-shaped: the binlog is replication AND point-in-time
   recovery AND a disk-consumption risk, all at once. */
const MYSQL_TABS = [
  { id: 'overview', label: 'Overview', what: 'Instance health, uptime, connections and throughput at a glance.', why: 'Answers "is the server itself the problem" before anyone opens a query.' },
  { id: 'performance', label: 'Performance', what: 'Throughput, buffer pool efficiency, connection use and I/O over time.', why: 'The InnoDB buffer pool hit rate is MySQL\'s single most telling number; a falling trend predicts trouble before users feel it.' },
  { id: 'queries', label: 'Queries', what: 'Statements MySQL has recorded, aggregated by digest.', why: 'Finds the frequent-and-mediocre statement that costs more in total than any single slow one.' },
  { id: 'databases', label: 'Databases', what: 'Schema inventory with sizes, table counts and accessibility.', why: 'An instance is rarely one schema; this is where growth is attributed.' },
  { id: 'tables', label: 'Tables', what: 'Tables with row estimates, data and index sizes, engine and collation.', why: 'Storage growth and query cost both trace to specific tables.' },
  { id: 'locks', label: 'Locks', what: 'InnoDB locks, waiting transactions and blocking relationships.', why: 'A blocked query burns no CPU and appears in no slow log — it is invisible without this.' },
  { id: 'replication', label: 'Replication', what: 'Primary/replica roles, IO and SQL thread state, and seconds behind.', why: 'Replication lag is a data-loss window, and a stopped replica thread is silent until you need it.' },
  { id: 'users', label: 'Users', what: 'Accounts, host patterns and granted privileges.', why: 'MySQL identity is user@host — the same username from a different host is a different account, which is a common source of surprise.' },
  { id: 'storage', label: 'Storage', what: 'Where the disk went: schemas, tables, indexes and free space.', why: 'Disk exhaustion takes the server down completely, weeks after the first warning sign.' },
  { id: 'indexes', label: 'Indexes', what: 'Index inventory with size, cardinality and usage.', why: 'Every index slows writes and costs disk; one nothing reads is pure overhead.' },
  { id: 'binary-logs', label: 'Binary Logs', what: 'The binlog files: names, sizes, retention and current position.', why: 'The binlog is three things at once — the replication stream, the point-in-time recovery source, and a quiet consumer of disk. Purging it too eagerly breaks recovery; never purging it fills the volume.' },
  { id: 'error-logs', label: 'Error Logs', what: 'The MySQL error log, parsed into severity-classified events.', why: 'Crashes, failed connections and InnoDB complaints appear here first.' },
  { id: 'slow-queries', label: 'Slow Queries', what: 'Entries from the Slow Query Log file, filtered and paginated.', why: 'MySQL reads the log file itself rather than a digest view, so it sees the real statement with its real parameters.' },
  { id: 'reports', label: 'Reports', what: 'Reporting and export over the collected data.', why: 'Evidence for people who will never open a dashboard.' },
  { id: 'diagnose', label: 'Diagnose', what: 'A guided diagnostic view pulling related signals together.', why: 'For when the question is "what is wrong" rather than "show me locks".' },
];

/* ── Oracle ─────────────────────────────────────────────────────────────
   The largest tab set, and the only one that CHANGES SHAPE with the
   instance: tabsForTopology() adds RAC, Services, ASM, CDB/PDB and Topology
   only when detection confirms them, and removes Data Guard when it is not
   configured — so a plain standalone never sees a permanently empty section. */
const ORACLE_TABS = [
  { id: 'overview', label: 'Overview', what: 'Instance status, uptime, sessions and load.', why: 'The first screen in any Oracle incident.' },
  { id: 'performance', label: 'Performance', what: 'Throughput, wait classes and resource use over time.', why: 'Oracle performance work is wait-event work; this is where the dominant wait class shows itself.' },
  { id: 'sessions', label: 'Sessions', what: 'Connected sessions with their state, program and current activity.', why: 'Session count and state distribution explain most "the database is slow" reports.' },
  { id: 'sql', label: 'Top SQL', what: 'The heaviest statements from v$sqlarea.', why: 'Ranks statements by real cost so effort goes where it returns most.' },
  { id: 'tablespaces', label: 'Tablespaces', what: 'Tablespace sizes, used space, autoextend and datafile layout.', why: 'A full tablespace stops writes to everything in it — the most common avoidable Oracle outage.' },
  { id: 'maintenance', label: 'Maintenance', what: 'Maintenance jobs, their windows, prerequisites and risks.', why: 'Statistics gathering and segment advisors run in windows that can collide with the business day.' },
  { id: 'objects', label: 'Objects', what: 'Schema objects with status — including anything INVALID.', why: 'An invalid package or view fails at call time, not at deploy time.' },
  { id: 'tables', label: 'Tables', what: 'Tables with row estimates, size and statistics freshness.', why: 'Stale statistics are the usual cause of a plan that changed overnight.' },
  { id: 'dataguard', label: 'Data Guard', what: 'Standby roles, transport and apply lag, and protection mode.', why: 'The disaster-recovery position, in the terms Oracle itself uses.', conditional: 'Shown only when Data Guard is detected.' },
  { id: 'redologs', label: 'Redo Logs', what: 'Redo log groups, members, sizes and switch frequency.', why: 'Switching too often is a throughput problem; a log unable to archive stops the database.' },
  { id: 'processes', label: 'Processes', what: 'Background and server processes with their resource use.', why: 'Separates a database problem from a host problem.' },
  { id: 'users', label: 'Users', what: 'Database users, profiles, roles and privileges.', why: 'Oracle privilege inheritance runs through roles; the effective set is rarely the granted set.' },
  { id: 'systemstats', label: 'Sys Stats', what: 'System statistics from v$sysstat.', why: 'The raw counters behind every derived metric, for when a summary is disputed.' },
  { id: 'slowqueries', label: 'Slow SQL', what: 'Expensive statements with duration, executions and plan access.', why: 'The entry point to plan inspection via v$sql_plan.' },
  { id: 'live', label: 'Live Queries', what: 'What is executing right now.', why: 'A cumulative digest cannot tell you what is running at this instant.' },
  { id: 'locks', label: 'Locks', what: 'Locks, blocking sessions and enqueue waits.', why: 'A blocking chain in Oracle can stall an application while every metric looks healthy.' },
  { id: 'sqlmonitor', label: 'SQL Monitor', what: 'Real-time monitoring of long-running statements.', why: 'Shows where a statement currently is inside its own plan, while it runs.' },
  { id: 'parameters', label: 'Parameters', what: 'Initialisation parameters, values and whether each is default.', why: 'Half of tuning is discovering a parameter is not what everyone assumed.' },
  { id: 'reports', label: 'Reports', what: 'Reporting and export over collected data.', why: 'Evidence for people outside the DBA team.' },
  { id: 'diagnose', label: 'Diagnose', what: 'A guided diagnostic view.', why: 'A starting point when the symptom is vague.' },
];

const ORACLE_CONDITIONAL = [
  { id: 'rac', label: 'RAC', what: 'Cluster instances, interconnect and per-instance load.', when: 'is_rac' },
  { id: 'services', label: 'Services', what: 'Database services and where each is running.', when: 'is_rac' },
  { id: 'asm', label: 'ASM', what: 'Disk groups, members and rebalance state.', when: 'asm_configured' },
  { id: 'multitenant', label: 'CDB/PDB', what: 'Container and pluggable database structure.', when: 'is_cdb' },
  { id: 'topology', label: 'Topology', what: 'A diagram of whatever shape was detected.', when: 'anything beyond plain standalone' },
];

/* ── SQL Server ─────────────────────────────────────────────────────────
   Note the vocabulary: "Logins", "Always On". Using PostgreSQL's words here
   would be wrong, so the product does not, and neither does this. */
const MSSQL_TABS = [
  { id: 'overview', label: 'Overview', what: 'Instance health, connections, and database states.', why: 'Confirms the instance is up and which databases are online before anything else.' },
  { id: 'performance', label: 'Performance', what: 'Batch requests, compilations, page life expectancy and I/O.', why: 'Page life expectancy falling is SQL Server\'s clearest memory-pressure signal.' },
  { id: 'queries', label: 'Queries', what: 'Cached plans and their statistics from sys.dm_exec_query_stats.', why: 'Ranks statements by cumulative cost across the plan cache.' },
  { id: 'slow-queries', label: 'Slow Queries', what: 'The expensive end of the plan cache, with filters.', why: 'The starting point for a latency complaint.', note: 'Execution-plan XML retrieval is not implemented — the engine catalogue records hasExplain as false.' },
  { id: 'databases', label: 'Databases', what: 'Databases with size, recovery model, compatibility level and log size.', why: 'A database in FULL recovery whose log is never backed up will grow until the disk is gone.' },
  { id: 'tables', label: 'Tables', what: 'Tables with row counts, data and index sizes.', why: 'Attributes storage and cost to specific objects.' },
  { id: 'locks', label: 'Locks', what: 'Locks, blocking chains and waiting sessions.', why: 'Blocking is SQL Server\'s most common invisible stall.' },
  { id: 'replication', label: 'Always On', what: 'Availability groups, replica roles, synchronisation state and lag.', why: 'The high-availability position, in SQL Server\'s own terms.' },
  { id: 'users', label: 'Logins', what: 'Server logins, database users and their mappings.', why: 'A login and a database user are different objects; orphaned users after a restore are a classic fault.' },
  { id: 'storage', label: 'Storage', what: 'Data and log file sizes, growth settings and free space.', why: 'Autogrowth in small increments fragments files and stalls writes while it happens.' },
  { id: 'error-logs', label: 'Error Logs', what: 'The SQL Server error log, severity-classified.', why: 'Failed logins, corruption and failover events land here.' },
  { id: 'wait-analysis', label: 'Wait Analysis', what: 'Accumulated wait statistics by type.', why: 'SQL Server tuning is wait-type tuning — the dominant wait names the bottleneck.' },
  { id: 'index-analysis', label: 'Indexes', what: 'Index inventory with usage, and missing-index suggestions.', why: 'Both halves matter: unused indexes cost writes, missing ones cost reads.' },
  { id: 'fragmentation', label: 'Fragmentation', what: 'Index fragmentation levels and page density.', why: 'Heavy fragmentation forces extra reads; rebuilding it is routine but not free.' },
  { id: 'reports', label: 'Reports', what: 'Report generation and export over the collected data.', why: 'Weekly evidence for people who will never open a monitoring tool — capacity trends for a manager, slow-query summaries for the application team.' },
  { id: 'diagnose', label: 'Diagnose', what: 'A guided view that pulls related signals from several sections together.', why: 'An incident rarely respects tab boundaries — this is the starting point when the complaint is "it is slow" rather than "show me locks".' },
];

/* ── MongoDB ────────────────────────────────────────────────────────────
   A document database, and the tabs reflect it — collections not tables,
   oplog not WAL, WiredTiger as its own section. */
const MONGO_TABS = [
  { id: 'overview', label: 'Overview', what: 'Server status, connections, memory and operation counters.', why: 'The instance-level picture before drilling into a collection.' },
  { id: 'operations', label: 'Operations', what: 'Operations currently executing.', why: 'A long-running operation blocking others shows here and nowhere else.' },
  { id: 'profiler', label: 'Profiler', what: 'The database profiler\'s captured operations.', why: 'MongoDB\'s profiler is opt-in and level-based; it is the closest thing to a slow log.' },
  { id: 'collections', label: 'Collections', what: 'Collections with document counts, storage size and index size.', why: 'Attributes growth and cost to specific collections.' },
  { id: 'indexes', label: 'Indexes', what: 'Index inventory with size and usage.', why: 'An unused index still costs on every write, and MongoDB indexes can be large.' },
  { id: 'slow-queries', label: 'Slow Queries', what: 'Slow operations with duration and shape.', why: 'Feeds the detail page, which shows real .explain() output.' },
  { id: 'replication', label: 'Replication', what: 'Replica set members, roles, health and lag.', why: 'A replica set without a majority cannot elect a primary and stops accepting writes.' },
  { id: 'oplog', label: 'Oplog', what: 'Oplog size, time window and utilisation.', why: 'The oplog window is the recovery budget: a secondary down longer than the window must be resynced from scratch.' },
  { id: 'sharding', label: 'Sharding', what: 'Shards, chunk distribution and balancer state.', why: 'An unbalanced cluster concentrates load on one shard while the others idle.' },
  { id: 'transactions', label: 'Transactions', what: 'Multi-document transaction activity.', why: 'Transactions arrived late to MongoDB and carry costs the document model does not otherwise have.' },
  { id: 'wiredtiger', label: 'WiredTiger', what: 'Storage-engine internals: cache, checkpoints and tickets.', why: 'Exhausted WiredTiger tickets stall every operation while the server looks idle.' },
  { id: 'users', label: 'Users', what: 'Users, roles and authentication database.', why: 'MongoDB roles are per-database and inherit; the effective set is rarely obvious.' },
  { id: 'errorlogs', label: 'Error Logs', what: 'The MongoDB log, severity-classified.', why: 'Elections, connection storms and assertion failures appear here.' },
  { id: 'diagnose', label: 'Diagnose', what: 'A guided view that pulls related signals from several sections together.', why: 'An incident rarely respects tab boundaries — this is the starting point when the complaint is "it is slow" rather than "show me locks".' },
];

/* ── ClickHouse ────────────────────────────────────────────────────────
   Columnar and merge-based, so Parts, Merges and Replicas exist here and
   nowhere else in the product. */
const CLICKHOUSE_TABS = [
  { id: 'overview', label: 'Overview', what: 'Server status, version, uptime and current query rate.', why: 'ClickHouse absorbs enormous insert volume and then falls over quickly when it cannot keep up — the instance-level rate is the first place that shows.' },
  { id: 'queries', label: 'Running', what: 'Queries executing right now, with elapsed time and memory.', why: 'ClickHouse queries can consume enormous memory; a runaway one is visible here first.' },
  { id: 'querylog', label: 'Query Log', what: 'The system.query_log history.', why: 'ClickHouse records every query it ran, with the resources it used — an unusually complete audit trail.' },
  { id: 'slowqueries', label: 'Slow Queries', what: 'The expensive end of the query log.', why: 'Ranks by duration and memory rather than by call count.' },
  { id: 'databases', label: 'Databases', what: 'Database inventory with engine and size.', why: 'ClickHouse databases can use different engines, which changes what they can do.' },
  { id: 'tables', label: 'Tables', what: 'Tables with engine, row count and compressed size.', why: 'The compression ratio is a real operational number here, not a curiosity.' },
  { id: 'partitions', label: 'Partitions', what: 'Parts per partition, sizes and row counts.', why: 'Too many small parts is the classic ClickHouse performance fault, and it is visible only at part level.' },
  { id: 'merges', label: 'Merges', what: 'Background merges in progress and their throughput.', why: 'If merges cannot keep up with inserts, part count grows without bound and queries slow steadily.' },
  { id: 'replicas', label: 'Replicas', what: 'Replicated table state, queue depth and delay.', why: 'A replica whose queue is growing is falling behind in a way row counts will not show.' },
  { id: 'clusters', label: 'Clusters', what: 'Cluster definitions, shards and replicas.', why: 'Distributed queries only make sense against the cluster topology.' },
  { id: 'sysmetrics', label: 'System Metrics', what: 'system.metrics and system.events counters.', why: 'The raw instrumentation, for when a derived number is disputed.' },
  { id: 'settings', label: 'Settings', what: 'Server and profile settings with current values.', why: 'ClickHouse behaviour is unusually setting-dependent; max_memory_usage alone decides whether a query runs.' },
  { id: 'diagnose', label: 'Diagnose', what: 'A guided view that pulls related signals from several sections together.', why: 'An incident rarely respects tab boundaries — this is the starting point when the complaint is "it is slow" rather than "show me locks".' },
];

/* ── Azure Cosmos DB ───────────────────────────────────────────────────
   A cloud-native database reached through the Database module. Its cost
   model is Request Units, which is why the catalogue records the RU cost and
   cross-partition behaviour of every operation ACTMON issues. */
const COSMOS_TABS = [
  { id: 'overview', label: 'Overview', what: 'Account status, regions and throughput configuration.', why: 'Cosmos charges by provisioned or consumed throughput; this is where that is visible.' },
  { id: 'databases', label: 'Databases', what: 'Databases in the account, with throughput settings.', why: 'Throughput can be set per database or per container, and the difference matters for cost.' },
  { id: 'containers', label: 'Containers', what: 'Containers with partition key, throughput and size.', why: 'The partition key choice decides whether the container scales or hot-spots, and it cannot be changed later.' },
  { id: 'documents', label: 'Documents', what: 'Browsing and querying documents.', why: 'Reading a document by id and partition key is cheap; a cross-partition query is not.' },
  { id: 'indexing', label: 'Indexing', what: 'The indexing policy: included and excluded paths.', why: 'Cosmos indexes everything by default, and that default is charged for on every write.' },
  { id: 'slow-queries', label: 'Slow Calls', what: 'Operations with high latency or RU consumption.', why: 'In Cosmos, expensive and slow are different problems — RU charge and latency both matter.' },
  { id: 'error-logs', label: 'Errors', what: 'Failed operations with their HTTP status.', why: 'Cosmos status codes are specific and actionable — 429 is throttling, 403 can be a firewall rule, 408 is usually a cross-partition query.' },
  { id: 'ai', label: 'Actmon AI', what: 'AI assistance over the collected Cosmos data.', why: 'Generated by a language model; treat its output as a starting point.' },
  { id: 'diagnose', label: 'Diagnose', what: 'A guided view that pulls related signals from several sections together.', why: 'An incident rarely respects tab boundaries — this is the starting point when the complaint is "it is slow" rather than "show me locks".' },
];

/* Per engine: its tabs, how deeply it was inspected, and anything
   structurally unusual about it. */
const ENGINE_TABS = {
  mysql: { tabs: MYSQL_TABS, depth: 'inventory' },
  mariadb: {
    tabs: MYSQL_TABS, depth: 'inventory',
    shared: 'MariaDB is handled through the MySQL code path and has no dashboard route of its own, so it '
          + 'presents the MySQL sections. That is why it is marked partial rather than implemented.',
  },
  oracle: {
    tabs: ORACLE_TABS, depth: 'inventory', conditional: ORACLE_CONDITIONAL,
    note: 'Oracle is the only engine whose tab set CHANGES with the instance. RAC, Services, ASM and CDB/PDB '
        + 'appear only when detection confirms them, Topology appears once anything beyond plain standalone is '
        + 'found, and Data Guard is removed when it is not configured — so a standalone instance never sees a '
        + 'permanently empty section.',
  },
  mssql: {
    tabs: MSSQL_TABS, depth: 'inventory',
    note: 'The vocabulary is SQL Server\'s own: Logins rather than Users, Always On rather than Replication. '
        + 'Renaming them to match PostgreSQL would be wrong, so the product does not.',
  },
  mongodb: { tabs: MONGO_TABS, depth: 'inventory' },
  clickhouse: {
    tabs: CLICKHOUSE_TABS, depth: 'inventory',
    note: 'ClickHouse is also ACTMON\'s own metrics history store — it appears in this document twice, once as '
        + 'a monitored engine and once as infrastructure.',
  },
  cosmosdb: {
    tabs: COSMOS_TABS, depth: 'inventory',
    note: 'A cloud-native database with its own dashboard, reached through the Database module rather than '
        + 'through Cloud. The Azure scanner separately inventories Cosmos accounts as cloud resources — the '
        + 'two views answer different questions.',
  },
};

window.ACTMON_ENGINES = { ENGINE_TABS, ENGINE_DEPTH_NOTE, ORACLE_CONDITIONAL };
