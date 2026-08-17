/**
 * ALERT CATALOGUE — section-driven, matching the existing Alerts module.
 *
 * Pick a section → only that section's metrics and rules are in play. This is the
 * same structure (and the same metric ids, units, defaults and directions) the
 * current app ships, so rules created in either build mean the same thing.
 *
 * Per metric:
 *   kind        'numeric'  operator + threshold
 *               'event'    fires when it happens (stored as `eq 1`)
 *   unit        suffix shown after the threshold
 *   def         default threshold offered for a new rule
 *   dirLow      true when the alarm is "below" — a new rule defaults to `lt`
 *   desc        for events: completes "Fires when …"
 *   evaluation  whether the backend can currently raise it — see EVALUATION below
 */

/* ── which metrics the backend can actually raise ──────────────────────────
   Read off Backend/database/app/routes/alerts/alert_routes.py:

     'live'      _evaluate() checks it against host state on every poll
     'collector' no host check, but _infer_metric() maps agent messages onto it,
                 and the rule being enabled is what lets those through
     'reserved'  no data source yet — the rule saves and persists, but nothing
                 will raise it until the backend grows one

   This is surfaced in the UI because "I made a rule and it never fired" is
   otherwise impossible to diagnose from the frontend. Keep it in sync when the
   backend's _evaluate/_infer_metric grow. */
export const EVALUATION = {
  live: {
    id: 'live',
    label: 'Live',
    hint: 'Checked against host state on every poll',
    tone: 'success',
  },
  collector: {
    id: 'collector',
    label: 'Agent-reported',
    hint: 'Raised when an agent reports it; this rule is what lets it through',
    tone: 'info',
  },
  reserved: {
    id: 'reserved',
    label: 'No data source yet',
    hint: 'The rule is saved, but the backend cannot raise this metric yet',
    tone: 'warning',
  },
};

export const SECTIONS = [
  {
    id: 'infrastructure',
    label: 'Infrastructure',
    icon: 'server',
    color: 'var(--chart-1)',
    desc: 'Hosts, CPU, memory, disk & availability',
    groups: [
      {
        group: 'Availability',
        metrics: [
          { id: 'host_down', label: 'Host down / unreachable', kind: 'event', desc: 'the host stops responding', evaluation: 'live' },
        ],
      },
      {
        group: 'Host resources',
        metrics: [
          { id: 'cpu', label: 'CPU usage', unit: '%', kind: 'numeric', def: 80, evaluation: 'live' },
          { id: 'memory', label: 'Memory usage', unit: '%', kind: 'numeric', def: 85, evaluation: 'live' },
          { id: 'disk', label: 'Disk usage', unit: '%', kind: 'numeric', def: 90, evaluation: 'live' },
          { id: 'swap', label: 'Swap usage', unit: '%', kind: 'numeric', def: 50, evaluation: 'reserved' },
          { id: 'load', label: 'Load average', unit: '', kind: 'numeric', def: 8, evaluation: 'reserved' },
          { id: 'disk_io', label: 'Disk I/O wait', unit: '%', kind: 'numeric', def: 40, evaluation: 'reserved' },
        ],
      },
    ],
  },
  {
    id: 'database',
    label: 'Database',
    icon: 'database',
    color: 'var(--chart-2)',
    desc: 'Service health, connections, queries & storage',
    groups: [
      {
        group: 'Availability',
        metrics: [
          { id: 'service_down', label: 'Database service stopped', kind: 'event', desc: 'the database service is not running', evaluation: 'live' },
          { id: 'db_unreachable', label: 'Database not responding', kind: 'event', desc: 'the database is not accepting connections', evaluation: 'reserved' },
          { id: 'db_crash', label: 'Database crash / unexpected restart', kind: 'event', desc: 'the database crashes or restarts unexpectedly', evaluation: 'reserved' },
        ],
      },
      {
        group: 'Connections',
        metrics: [
          { id: 'connections', label: 'Active connections', unit: '', kind: 'numeric', def: 500, evaluation: 'collector' },
          { id: 'connections_pct', label: 'Connection usage', unit: '%', kind: 'numeric', def: 90, evaluation: 'reserved' },
          { id: 'aborted_connections', label: 'Aborted connections', unit: '/min', kind: 'numeric', def: 20, evaluation: 'reserved' },
        ],
      },
      {
        group: 'Performance',
        metrics: [
          { id: 'slow_queries', label: 'Slow queries', unit: '/min', kind: 'numeric', def: 50, evaluation: 'collector' },
          { id: 'query_latency', label: 'Avg query latency', unit: 'ms', kind: 'numeric', def: 500, evaluation: 'reserved' },
          { id: 'cache_hit', label: 'Cache / buffer hit ratio', unit: '%', kind: 'numeric', def: 90, dirLow: true, evaluation: 'collector' },
          { id: 'blocking_sessions', label: 'Blocking / locked sessions', unit: '', kind: 'numeric', def: 5, evaluation: 'reserved' },
          { id: 'long_query', label: 'Long-running query', unit: 's', kind: 'numeric', def: 300, evaluation: 'reserved' },
          { id: 'deadlocks', label: 'Deadlocks detected', kind: 'event', desc: 'a deadlock is detected', evaluation: 'collector' },
        ],
      },
      {
        group: 'Storage',
        metrics: [
          { id: 'db_size', label: 'Database size', unit: 'GB', kind: 'numeric', def: 500, evaluation: 'reserved' },
          { id: 'tablespace', label: 'Tablespace usage', unit: '%', kind: 'numeric', def: 90, evaluation: 'reserved' },
          { id: 'binlog_disk', label: 'Binlog / WAL disk use', unit: '%', kind: 'numeric', def: 80, evaluation: 'reserved' },
        ],
      },
      {
        group: 'Errors',
        metrics: [
          { id: 'error_spike', label: 'Error-log spike', unit: '/min', kind: 'numeric', def: 10, evaluation: 'reserved' },
          { id: 'critical_error', label: 'Critical error in log', kind: 'event', desc: 'a critical error appears in the log', evaluation: 'reserved' },
        ],
      },
    ],
  },
  {
    id: 'replication',
    label: 'Replication & HA',
    icon: 'history',
    color: 'var(--chart-3)',
    desc: 'Lag, broken replication & cluster health',
    groups: [
      {
        group: 'Replication & HA',
        metrics: [
          { id: 'replication_lag', label: 'Replication lag', unit: 's', kind: 'numeric', def: 30, evaluation: 'collector' },
          { id: 'replication_broken', label: 'Replication stopped / broken', kind: 'event', desc: 'replication stops or breaks', evaluation: 'reserved' },
          { id: 'replica_down', label: 'Replica not connected', kind: 'event', desc: 'a replica disconnects', evaluation: 'reserved' },
          { id: 'cluster_node_down', label: 'Cluster node down', kind: 'event', desc: 'a cluster node goes down', evaluation: 'reserved' },
        ],
      },
      {
        group: 'Oracle RAC',
        metrics: [
          { id: 'rac_node_down', label: 'RAC node/instance down', kind: 'event', desc: 'a RAC instance is no longer OPEN', evaluation: 'collector' },
          { id: 'service_down', label: 'Oracle Service unavailable', kind: 'event', desc: 'an Oracle service goes offline on one or more instances', evaluation: 'collector' },
        ],
      },
      {
        group: 'Oracle Data Guard',
        metrics: [
          { id: 'dg_transport_failure', label: 'Data Guard transport failure', kind: 'event', desc: 'redo transport to a standby fails', evaluation: 'collector' },
          { id: 'dg_apply_failure', label: 'Data Guard apply stopped', kind: 'event', desc: 'redo apply (MRP) stops on a standby', evaluation: 'collector' },
          { id: 'dg_transport_lag', label: 'Data Guard transport lag', unit: 's', kind: 'numeric', def: 60, evaluation: 'collector' },
          { id: 'dg_apply_lag', label: 'Data Guard apply lag', unit: 's', kind: 'numeric', def: 60, evaluation: 'collector' },
          { id: 'dg_archive_gap', label: 'Data Guard archive gap', kind: 'event', desc: 'a standby is missing archived log sequences', evaluation: 'collector' },
        ],
      },
      {
        group: 'Oracle ASM',
        metrics: [
          { id: 'asm_diskgroup_critical', label: 'ASM disk group critical', kind: 'event', desc: 'an ASM disk group is unmounted, has offline disks, or is nearly full', evaluation: 'collector' },
        ],
      },
    ],
  },
  {
    id: 'cloud',
    label: 'Cloud',
    icon: 'cloud',
    color: 'var(--chart-5)',
    desc: 'AWS / Azure / OCI resources & cost',
    groups: [
      {
        group: 'Cloud availability',
        metrics: [
          { id: 'cloud_instance_stopped', label: 'Instance stopped / terminated', kind: 'event', desc: 'a cloud instance stops or is terminated', evaluation: 'reserved' },
          { id: 'cloud_resource_unhealthy', label: 'Resource health check failing', kind: 'event', desc: 'a cloud resource health check fails', evaluation: 'reserved' },
        ],
      },
      {
        group: 'Cloud resources',
        metrics: [
          { id: 'cloud_cpu', label: 'Instance CPU', unit: '%', kind: 'numeric', def: 80, evaluation: 'reserved' },
          { id: 'cloud_storage', label: 'Cloud storage usage', unit: '%', kind: 'numeric', def: 85, evaluation: 'reserved' },
        ],
      },
      {
        group: 'Cloud cost',
        metrics: [
          { id: 'cloud_cost_budget', label: 'Monthly cost vs budget', unit: '%', kind: 'numeric', def: 90, evaluation: 'reserved' },
          { id: 'cloud_cost_spike', label: 'Unusual cost spike', kind: 'event', desc: 'an unusual cost spike is detected', evaluation: 'reserved' },
        ],
      },
    ],
  },
];

/* ── flattened lookups ────────────────────────────────────────────────────── */

export const METRICS = SECTIONS.flatMap((s) =>
  s.groups.flatMap((g) => g.metrics.map((m) => ({ ...m, section: s.id, group: g.group }))));

const BY_ID = METRICS.reduce((acc, m) => ({ ...acc, [m.id]: m }), {});

/** Unknown ids still render, so a rule from a newer backend never breaks the page. */
export const metricOf = (id) => BY_ID[id] || {
  id,
  label: String(id || 'unknown').replace(/_/g, ' '),
  kind: 'numeric',
  unit: '',
  section: 'infrastructure',
  group: 'Other',
  evaluation: 'reserved',
};

/* ── compact labels ────────────────────────────────────────────────────────
   The full labels are written to be unambiguous in a rule editor ("CPU usage",
   "Host down / unreachable"). In a dense list — the overview's alert feed — that
   length wins nothing and costs the hostname its room, so these are the same
   metrics named in one or two words. Anything not listed falls back to its full
   label, so a metric added to the catalog still reads correctly here. */
const SHORT_LABELS = {
  cpu: 'CPU',
  memory: 'Memory',
  disk: 'Disk',
  swap: 'Swap',
  load: 'Load',
  disk_io: 'Disk I/O',
  host_down: 'Host',
  service_down: 'Service',
  db_unreachable: 'Database',
  db_crash: 'Crash',
  connections: 'Connections',
  connections_pct: 'Connections',
  aborted_connections: 'Connections',
  slow_queries: 'Slow queries',
  query_latency: 'Latency',
  cache_hit: 'Cache hit',
  blocking_sessions: 'Blocking',
  long_query: 'Long query',
  deadlocks: 'Deadlocks',
  db_size: 'DB size',
  tablespace: 'Tablespace',
  error_spike: 'Errors',
  critical_error: 'Errors',
  replication_lag: 'Replication',
  replication_broken: 'Replication',
  replica_down: 'Replica',
  cluster_node_down: 'Cluster',
  rac_node_down: 'RAC Node',
  service_down: 'Service',
  dg_transport_failure: 'DG Transport',
  dg_apply_failure: 'DG Apply',
  dg_transport_lag: 'DG Lag',
  dg_apply_lag: 'DG Apply Lag',
  dg_archive_gap: 'DG Gap',
  asm_diskgroup_critical: 'ASM',
};

/** One- or two-word name for a metric, for dense lists. */
export const metricShort = (id) => SHORT_LABELS[id] || metricOf(id).label;

export const sectionMeta = (id) => SECTIONS.find((s) => s.id === id) || SECTIONS[0];
export const sectionOf = (metricId) => metricOf(metricId).section;
export const groupsForSection = (id) => sectionMeta(id).groups;
export const firstMetricOfSection = (id) => groupsForSection(id)[0].metrics[0].id;
export const evaluationOf = (metricId) => EVALUATION[metricOf(metricId).evaluation] || EVALUATION.reserved;

/* ── operators ────────────────────────────────────────────────────────────── */
export const OPERATORS = [
  { id: 'gt', symbol: '>', label: 'is above' },
  { id: 'gte', symbol: '≥', label: 'is at or above' },
  { id: 'lt', symbol: '<', label: 'is below' },
  { id: 'lte', symbol: '≤', label: 'is at or below' },
  { id: 'eq', symbol: '=', label: 'equals' },
];
export const operatorOf = (id) => OPERATORS.find((o) => o.id === id) || OPERATORS[0];

/** `eq` is reserved for events, so the numeric picker excludes it. */
export const NUMERIC_OPERATORS = OPERATORS.filter((o) => o.id !== 'eq');

/* ── scopes (they differ by section, as in the existing module) ───────────── */
export const TECHNOLOGIES = [
  { id: 'mysql', label: 'MySQL / MariaDB' },
  { id: 'postgresql', label: 'PostgreSQL' },
  { id: 'oracle', label: 'Oracle' },
  { id: 'mssql', label: 'SQL Server' },
  { id: 'mongodb', label: 'MongoDB' },
  { id: 'clickhouse', label: 'ClickHouse' },
];

const SCOPES_DEFAULT = [
  { id: 'all', label: 'All servers' },
  { id: 'technology', label: 'By technology' },
  { id: 'server', label: 'Specific server' },
  { id: 'agent', label: 'Specific agent' },
];
const SCOPES_CLOUD = [
  { id: 'all', label: 'All accounts' },
  { id: 'account', label: 'Specific account' },
];

export const scopesForSection = (id) => (id === 'cloud' ? SCOPES_CLOUD : SCOPES_DEFAULT);

export const SCOPE_LABELS = {
  technology: 'Technology',
  server: 'Server',
  agent: 'Agent',
  account: 'Account',
};

/** Editor offers the two severities the existing module offers; `info` still displays. */
export const SEVERITY_CHOICES = [
  { id: 'warning', label: 'Warning' },
  { id: 'critical', label: 'Critical' },
];

/* ── phrasing (one place, so table / editor / preview always agree) ───────── */

/** "CPU usage > 90%" or, for an event, just its label. */
export function describeCondition(rule) {
  const m = metricOf(rule.metric);
  if (m.kind === 'event') return m.label;
  const threshold = Number(rule.threshold);
  const value = Number.isFinite(threshold)
    ? (Number.isInteger(threshold) ? threshold : threshold.toFixed(1))
    : rule.threshold;
  return `${m.label} ${operatorOf(rule.operator).symbol} ${value}${m.unit || ''}`;
}

/** "All servers" / "Technology: mysql" / "Server: db-01" */
export function describeScope(rule) {
  if (rule.scope_type === 'all' || !rule.scope_value) {
    return sectionOf(rule.metric) === 'cloud' ? 'All accounts' : 'All servers';
  }
  const prefix = SCOPE_LABELS[rule.scope_type] || 'Scope';
  return `${prefix}: ${rule.scope_value}`;
}

/** Sensible starting operator/threshold when a metric is picked. */
export function defaultsForMetric(id) {
  const m = metricOf(id);
  if (m.kind === 'event') return { operator: 'eq', threshold: 1 };
  return { operator: m.dirLow ? 'lt' : 'gt', threshold: m.def ?? 0 };
}
