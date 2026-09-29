/* ===========================================================================
   SAMPLE MODE — deterministic illustrative records.

   NOTHING here came from a live ACTMON installation, a real database, or any
   customer environment. Every number was chosen by hand to make a teaching
   point, and every value is fixed rather than randomised so the same click
   always shows the same thing — a demo that reshuffles itself is impossible
   to talk over.

   The 3D scenes read these shapes directly: a table's `bytes` drives how big
   its object is, a query's `total_ms` drives how prominent its node is, a
   standby's `lag_ms` drives the speed of the particles along its path. That
   mapping is the point — the geometry means something.
   =========================================================================== */

const SAMPLE_BANNER = 'Illustrative sample — not live data';

/* ── Slow queries (Level 4 → 5) ───────────────────────────────────────────
   total_ms = calls × avg_ms, kept consistent on purpose: the teaching point
   of the Slow Queries environment is that the biggest object is not the
   slowest statement but the most expensive one overall. */
const SAMPLE_QUERIES = [
  {
    id: 'q1',
    sql: 'SELECT customer_id, COUNT(*)\n  FROM orders\n WHERE status = $1\n GROUP BY customer_id\n ORDER BY COUNT(*) DESC;',
    literal: "status = 'pending'",
    db: 'Actin-TicketingTool', user: 'app_rw', type: 'SELECT',
    calls: 4200, avg_ms: 1830, max_ms: 4210, rows: 51000000, severity: 'high',
    cache_hit: 82.4, temp_blocks: 1840,
    plan: [
      { d: 0, node: 'Sort', detail: 'Sort Key: (count(*)) DESC', rows: 8400, cost: 48210.55, method: 'external merge  Disk: 84000kB', bad: true },
      { d: 1, node: 'HashAggregate', detail: 'Group Key: customer_id', rows: 8400, cost: 41880.10 },
      { d: 2, node: 'Seq Scan on orders', detail: "Filter: (status = 'pending'::text)", rows: 250000, cost: 38110.00, bad: true },
    ],
    findings: [
      { sev: 'critical', kind: 'SEQ_SCAN', title: 'Sequential scan on orders',
        evidence: 'Estimated rows 250,000 · table holds ~2.4 M rows · filter on status',
        action: 'Index the filtered column if it is selective enough.',
        sql: 'CREATE INDEX CONCURRENTLY idx_orders_status ON public.orders (status);',
        tradeoff: 'Every index slows INSERT/UPDATE/DELETE and uses disk. "pending" may be a large fraction of the table, in which case the planner will keep choosing the scan.' },
      { sev: 'high', kind: 'SORT_SPILL', title: 'Sort spilled to disk',
        evidence: 'Sort Method: external merge  Disk: 84000kB',
        action: 'Raise work_mem for this workload, or aggregate fewer rows.',
        tradeoff: 'work_mem is per sort per connection — raising it globally multiplies across concurrency.' },
      { sev: 'medium', kind: 'LARGE_RESULT', title: 'Very large cumulative result',
        evidence: '51,000,000 rows returned across 4,200 calls (~12,143 per call)',
        action: 'Add a LIMIT, paginate, or aggregate further in the database.' },
    ],
  },
  {
    id: 'q2',
    sql: 'SELECT *\n  FROM ticket_events\n WHERE created_at > $1\n ORDER BY created_at DESC;',
    literal: "created_at > now() - interval '7 days'",
    db: 'Actin-TicketingTool', user: 'app_rw', type: 'SELECT',
    calls: 18400, avg_ms: 240, max_ms: 980, rows: 22080000, severity: 'high',
    cache_hit: 91.2, temp_blocks: 0,
    plan: [
      { d: 0, node: 'Sort', detail: 'Sort Key: created_at DESC', rows: 120000, cost: 20140.20 },
      { d: 1, node: 'Seq Scan on ticket_events', detail: 'Filter: (created_at > $1)', rows: 120000, cost: 18220.00, bad: true },
    ],
    findings: [
      { sev: 'high', kind: 'MISSING_INDEX', title: 'No index leads with created_at',
        evidence: 'Table holds ~2.4 M rows · existing indexes: ticket_events_pkey',
        action: 'Create an index leading with created_at.',
        sql: 'CREATE INDEX CONCURRENTLY idx_ticket_events_created_at\n  ON public.ticket_events (created_at DESC);',
        tradeoff: 'A descending index matches this ORDER BY and removes the sort as well as the scan.' },
      { sev: 'low', kind: 'SELECT_STAR', title: 'The query selects every column',
        evidence: 'Statement begins with SELECT *',
        action: 'List only the columns the application uses — it also makes an index-only scan possible.' },
    ],
  },
  {
    id: 'q3',
    sql: 'UPDATE tickets\n   SET last_seen_at = now()\n WHERE id = $1;',
    literal: 'id = 918273',
    db: 'Actin-TicketingTool', user: 'app_rw', type: 'UPDATE',
    calls: 96000, avg_ms: 9, max_ms: 310, rows: 96000, severity: 'medium',
    cache_hit: 99.7, temp_blocks: 0,
    plan: [
      { d: 0, node: 'Update on tickets', detail: '', rows: 1, cost: 8.30 },
      { d: 1, node: 'Index Scan using tickets_pkey', detail: 'Index Cond: (id = $1)', rows: 1, cost: 8.29 },
    ],
    findings: [
      { sev: 'medium', kind: 'WRITE_AMPLIFICATION', title: 'A very frequent single-row write',
        evidence: '96,000 calls averaging 9 ms — 14 min 24 s of cumulative time',
        action: 'Consider batching, or writing this timestamp less often. The plan itself is already optimal.' },
    ],
    note: 'This statement WRITES. ACTMON plans it with a plain EXPLAIN, which executes nothing; EXPLAIN ANALYZE is refused for it.',
  },
  {
    id: 'q4',
    sql: 'SELECT count(*)\n  FROM attachments\n WHERE mime_type LIKE $1;',
    literal: "mime_type LIKE '%pdf%'",
    db: 'Actin-TicketingTool', user: 'reporting', type: 'SELECT',
    calls: 310, avg_ms: 3120, max_ms: 6400, rows: 310, severity: 'critical',
    cache_hit: 44.1, temp_blocks: 920,
    plan: [
      { d: 0, node: 'Aggregate', detail: '', rows: 1, cost: 91200.00 },
      { d: 1, node: 'Seq Scan on attachments', detail: "Filter: (mime_type ~~ '%pdf%'::text)", rows: 61000, cost: 91100.00, bad: true },
    ],
    findings: [
      { sev: 'high', kind: 'LEADING_WILDCARD', title: "LIKE pattern starts with '%'",
        evidence: "Filter: (mime_type ~~ '%pdf%')",
        action: 'A B-tree cannot serve a leading wildcard. Use a trigram index, or store the type separately.',
        sql: 'CREATE EXTENSION IF NOT EXISTS pg_trgm;\nCREATE INDEX CONCURRENTLY idx_attachments_mime_trgm\n  ON public.attachments USING gin (mime_type gin_trgm_ops);',
        tradeoff: 'pg_trgm is an extension, and its indexes are considerably larger than a B-tree.' },
      { sev: 'medium', kind: 'LOW_CACHE', title: 'Low cache hit ratio',
        evidence: '44.1 % — most of this table is being read from disk on every call',
        action: 'The table may simply be larger than the available shared_buffers.' },
    ],
  },
];

/* ── Tables (Level 4 Storage / Tables — object size maps to `bytes`) ────── */
const SAMPLE_TABLES = [
  { name: 'attachments', schema: 'public', rows: 61000, bytes: 4939212390, pretty: '4.6 GB', idx_pretty: '210 MB', dead_pct: 4, seq: 1840, idx: 92000, vacuumed: '3 days ago' },
  { name: 'ticket_events', schema: 'public', rows: 2400000, bytes: 3328599654, pretty: '3.1 GB', idx_pretty: '1.2 GB', dead_pct: 36, seq: 42000, idx: 118000, vacuumed: 'never' },
  { name: 'orders', schema: 'public', rows: 2400000, bytes: 1288490188, pretty: '1.2 GB', idx_pretty: '180 MB', dead_pct: 12, seq: 8400, idx: 640000, vacuumed: '9 hours ago' },
  { name: 'tickets', schema: 'public', rows: 184000, bytes: 431906816, pretty: '412 MB', idx_pretty: '96 MB', dead_pct: 6, seq: 120, idx: 1204882, vacuumed: '2 hours ago' },
  { name: 'users', schema: 'public', rows: 12400, bytes: 25165824, pretty: '24 MB', idx_pretty: '8 MB', dead_pct: 2, seq: 40, idx: 402000, vacuumed: '2 hours ago' },
  { name: 'audit_log', schema: 'public', rows: 880000, bytes: 671088640, pretty: '640 MB', idx_pretty: '210 MB', dead_pct: 18, seq: 12, idx: 8800, vacuumed: '5 days ago' },
];

/* ── Indexes ───────────────────────────────────────────────────────────── */
const SAMPLE_INDEXES = [
  { name: 'tickets_pkey', table: 'tickets', cols: ['id'], unique: true, primary: true, scans: 1204882, pretty: '8.2 MB' },
  { name: 'idx_tickets_status', table: 'tickets', cols: ['status'], unique: false, primary: false, scans: 0, pretty: '14 MB', redundant: 'idx_tickets_status_assignee' },
  { name: 'idx_tickets_status_assignee', table: 'tickets', cols: ['status', 'assignee_id'], unique: false, primary: false, scans: 88140, pretty: '22 MB' },
  { name: 'orders_pkey', table: 'orders', cols: ['id'], unique: true, primary: true, scans: 640000, pretty: '52 MB' },
  { name: 'ticket_events_pkey', table: 'ticket_events', cols: ['id'], unique: true, primary: true, scans: 118000, pretty: '92 MB' },
  { name: 'idx_audit_log_actor', table: 'audit_log', cols: ['actor_id'], unique: false, primary: false, scans: 0, pretty: '46 MB' },
];

/* ── Locks: one holder, two waiters (Level 4 → 5) ─────────────────────── */
const SAMPLE_LOCKS = {
  holder: { pid: 4821, user: 'app_rw', db: 'Actin-TicketingTool', mode: 'RowExclusiveLock', object: 'public.tickets', age_s: 94, state: 'idle in transaction', query: 'UPDATE tickets SET status = $1 WHERE id = $2;' },
  waiters: [
    { pid: 4903, user: 'app_rw', db: 'Actin-TicketingTool', mode: 'ShareLock', object: 'public.tickets', age_s: 61, state: 'active', query: 'SELECT * FROM tickets WHERE id = $1 FOR UPDATE;' },
    { pid: 4915, user: 'reporting', db: 'Actin-TicketingTool', mode: 'ShareLock', object: 'public.tickets', age_s: 22, state: 'active', query: 'SELECT count(*) FROM tickets WHERE status = $1;' },
  ],
  lesson: 'Both waiters are blocked by one holder that is idle in transaction — an application that opened a transaction and then stopped. Terminating a waiter frees nothing; the holder is the problem.',
};

/* ── Replication topology ─────────────────────────────────────────────── */
const SAMPLE_REPLICATION = {
  primary: { name: 'pg-prod-01', role: 'Primary', wal: '0/9A3F21C8', connections: 18, version: 'PostgreSQL 16.2' },
  standbys: [
    { name: 'pg-standby-01', state: 'streaming', sync: 'sync', lag_ms: 0, byte_lag: 0, byte_pretty: '0 B', slot: 'standby_01', wal_status: 'reserved' },
    { name: 'pg-standby-02', state: 'streaming', sync: 'async', lag_ms: 240, byte_lag: 1258291, byte_pretty: '1.2 MB', slot: 'standby_02', wal_status: 'reserved' },
    { name: 'pg-standby-03', state: 'disconnected', sync: 'async', lag_ms: null, byte_lag: 4294967296, byte_pretty: '4.0 GB', slot: 'standby_03', wal_status: 'lost' },
  ],
  lesson: 'standby-03\'s slot reads wal_status = lost: WAL it still needed has already been removed, so it cannot catch up and must be rebuilt. An inactive slot also pins WAL on the primary — left alone, that fills the primary\'s disk, which is a worse outage than the lag it was protecting against.',
};

/* ── Role graph (Level 4 Users → Level 5) ─────────────────────────────── */
const SAMPLE_ROLE = {
  name: 'migration_user',
  attrs: [
    ['Can log in', 'Yes', true], ['Superuser', 'No', false], ['Create DB', 'No', false],
    ['Create role', 'No', false], ['Replication', 'No', false], ['Bypass RLS', 'No', false],
    ['Inherit', 'Yes', true], ['Connection limit', 'Unlimited', null],
    ['Password set', 'Yes — never displayed', null], ['Valid until', 'No expiry', null],
  ],
  memberOf: [{ name: 'app_writer', inherit: true }],
  members: [],
  privileges: [
    { kind: 'database', object: 'Actin-TicketingTool', grants: ['CONNECT', 'TEMPORARY'], via: 'direct' },
    { kind: 'database', object: 'reporting_archive', grants: ['CONNECT'], via: 'PUBLIC' },
    { kind: 'schema', object: 'public', grants: ['USAGE', 'CREATE'], via: 'direct' },
    { kind: 'schema', object: 'audit', grants: ['USAGE'], via: 'app_writer' },
    { kind: 'table', object: 'public.tickets', grants: ['SELECT', 'INSERT', 'UPDATE'], via: 'app_writer' },
    { kind: 'table', object: 'public.orders', grants: ['SELECT'], via: 'app_writer' },
    { kind: 'table', object: 'public.schema_migrations', grants: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], via: 'owner' },
    { kind: 'sequence', object: 'public.schema_migrations_id_seq', grants: ['USAGE', 'SELECT', 'UPDATE'], via: 'owner' },
    { kind: 'function', object: 'public.apply_migration(text)', grants: ['EXECUTE'], via: 'PUBLIC' },
  ],
  owns: ['public.schema_migrations', 'public.migration_locks', 'public.migration_audit', 'public.schema_migrations_id_seq'],
  sessions: [],
  lesson: 'Only two of these nine privileges were granted to migration_user directly. The rest arrive through app_writer membership, through PUBLIC, or through ownership — which is why ACTMON computes effective access with PostgreSQL\'s own has_*_privilege() functions rather than reading the grant tables.',
  viaLegend: {
    direct: 'Granted to this role by name',
    app_writer: 'Inherited through membership of app_writer',
    PUBLIC: 'Held by PUBLIC, so every role has it',
    owner: 'Implied by ownership — an owner may ALTER and DROP regardless of any GRANT',
  },
};

/* ── Error log timeline ───────────────────────────────────────────────── */
const SAMPLE_LOGS = [
  { t: '10:54:46.359', sev: 'LOG', pid: 1521374, db: null, user: null, msg: 'checkpoint complete: wrote 3 buffers (0.0%); 0 WAL file(s) added', state: null },
  { t: '10:51:02.118', sev: 'WARNING', pid: 1520901, db: 'Actin-TicketingTool', user: 'app_rw', msg: 'there is already a transaction in progress', state: '25001' },
  { t: '09:12:03.774', sev: 'ERROR', pid: 1519442, db: 'Actin-TicketingTool', user: 'app_rw', msg: 'deadlock detected', state: '40P01',
    detail: 'Process 4821 waits for ShareLock on transaction 918273; blocked by process 4903.\nProcess 4903 waits for ShareLock on transaction 918270; blocked by process 4821.',
    hint: 'See server log for query details.',
    ctx: 'while updating tuple (14,3) in relation "tickets"',
    stmt: 'UPDATE tickets SET status = $1 WHERE id = $2;' },
  { t: '08:44:57.002', sev: 'FATAL', pid: 1518330, db: 'Actin-TicketingTool', user: 'app_rw', msg: 'remaining connection slots are reserved for non-replication superuser connections', state: '53300',
    hint: 'Increase max_connections, or reduce the application pool size.' },
  { t: '08:44:56.980', sev: 'FATAL', pid: 1518329, db: 'Actin-TicketingTool', user: 'app_rw', msg: 'remaining connection slots are reserved for non-replication superuser connections', state: '53300' },
  { t: '08:02:11.640', sev: 'LOG', pid: 1517001, db: null, user: null, msg: 'automatic vacuum of table "public.orders": index scans: 1', state: null },
];

/* ── Overview / performance metrics ───────────────────────────────────── */
const SAMPLE_HEALTH = {
  instance: 'pg-prod-01', host: 'localhost', port: 5432, db: 'Actin-TicketingTool',
  version: 'PostgreSQL 16.2', uptime: '21 d 4 h',
  metrics: [
    { id: 'conns', label: 'Active connections', value: 18, max: 100, unit: '', tone: 'ok' },
    { id: 'cache', label: 'Cache hit ratio', value: 99.2, max: 100, unit: '%', tone: 'ok' },
    { id: 'tps', label: 'Transactions / sec', value: 145, max: 400, unit: '', tone: 'ok' },
    { id: 'slow', label: 'Slow queries', value: 4, max: 20, unit: '', tone: 'warn' },
    { id: 'size', label: 'Database size', value: 8.4, max: 20, unit: ' GB', tone: 'ok' },
    { id: 'rollback', label: 'Rollback ratio', value: 2.8, max: 100, unit: '%', tone: 'ok' },
  ],
  series: {
    // 24 deterministic hourly points, so the same chart is drawn every time.
    tps: [120,118,110,96,88,84,90,128,168,182,176,170,165,172,180,188,192,176,160,148,140,134,128,124],
    cache: [99.4,99.4,99.5,99.5,99.6,99.6,99.5,99.3,99.1,98.9,98.8,99.0,99.1,99.2,99.2,99.0,98.7,98.9,99.1,99.2,99.3,99.3,99.4,99.2],
    latency: [12,11,10,9,8,8,9,14,22,31,28,24,21,23,27,34,41,29,20,17,15,14,13,12],
  },
};

/* ── Infrastructure host ──────────────────────────────────────────────── */
const SAMPLE_HOST = {
  name: 'pg-prod-01', os: 'Ubuntu 22.04 LTS', kind: 'Linux host',
  gauges: [
    { id: 'cpu', label: 'CPU', value: 34, unit: '%', tone: 'ok' },
    { id: 'mem', label: 'Memory', value: 71, unit: '%', tone: 'warn' },
    { id: 'disk', label: 'Disk', value: 62, unit: '%', tone: 'ok' },
    { id: 'io', label: 'Disk I/O wait', value: 28, unit: '%', tone: 'warn' },
  ],
  note: 'Disk I/O wait rose in the same window as the slow-query spike. Both facts are visible in one tool — but a correlation in time is not proof of cause.',
};

/* ── Cloud sample resources ───────────────────────────────────────────── */
const SAMPLE_CLOUD = {
  aws: [
    { name: 'prod-api-01', type: 'EC2 instance', region: 'ap-south-1', state: 'running' },
    { name: 'actin-tickets-db', type: 'RDS PostgreSQL', region: 'ap-south-1', state: 'available' },
    { name: 'ticket-attachments', type: 'S3 bucket', region: 'ap-south-1', state: 'active' },
    { name: 'sessions', type: 'DynamoDB table', region: 'ap-south-1', state: 'active' },
  ],
  azure: [
    { name: 'vm-report-01', type: 'Virtual machine', region: 'centralindia', state: 'running' },
    { name: 'actin-cosmos', type: 'Cosmos DB account', region: 'centralindia', state: 'online' },
    { name: 'actin-pg-flex', type: 'Azure Database for PostgreSQL', region: 'centralindia', state: 'ready' },
  ],
  oci: [
    { name: 'oci-compute-01', type: 'Compute instance', region: 'ap-mumbai-1', state: 'running' },
    { name: 'oci-mysql-01', type: 'MySQL DB system', region: 'ap-mumbai-1', state: 'active' },
  ],
};

/* ── Sample alerts ────────────────────────────────────────────────────── */
const SAMPLE_ALERTS = [
  { sev: 'critical', title: 'Disk usage above 90 %', res: 'pg-prod-01', t: '09:14', tier: 'live' },
  { sev: 'high', title: 'Slow queries above threshold', res: 'Actin-TicketingTool', t: '09:02', tier: 'collector' },
  { sev: 'medium', title: 'Active connections above 80', res: 'Actin-TicketingTool', t: '08:45', tier: 'collector' },
];

window.ACTMON_SAMPLES = {
  SAMPLE_BANNER, SAMPLE_QUERIES, SAMPLE_TABLES, SAMPLE_INDEXES, SAMPLE_LOCKS,
  SAMPLE_REPLICATION, SAMPLE_ROLE, SAMPLE_LOGS, SAMPLE_HEALTH, SAMPLE_HOST,
  SAMPLE_CLOUD, SAMPLE_ALERTS,
};
