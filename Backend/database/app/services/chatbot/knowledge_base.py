"""
ActMon AI — structured knowledge base.

Condensed, per-module slices of `Backend/database/docs/ai_assistant_architecture.md`
(Phase 1-3 analysis), so a conceptual/config-info question can be answered from
ActMon's own domain knowledge without a tool call, and without re-injecting the
entire architecture document on every turn.

`knowledge_for(modules)` returns only the requested slice(s) joined together —
callers pass the `module` field the intent classifier already produced.
"""

DASHBOARD = """### Dashboard ("Monitoring Overview", route /dashboard) — what it is
The single fleet-wide landing page: a live rollup of every OS host, database engine
host, agent, and firing alert this org has — NOT a per-connection dashboard (that is
the separate per-engine "database" module). It answers "what does my whole environment
look like right now," not "how is one specific database doing." Auto-refreshes every
30 seconds; a header button forces an immediate refresh.

### Data sources — every widget is a live client-side rollup of 5 existing reads, not
a separate dashboard backend/table:
1. `GET /os-servers/summary` — authoritative host counts: total / connected / warning /
   disconnected / distinct clusters (org-scoped).
2. `GET /os-servers/` — the full host list: per-host status, cpu_usage/ram_usage/
   disk_usage (the host's last-reported %, not a history), os_type, environment,
   database_services[], and each host's db_instances[] (per-engine status) (org-scoped).
3. `GET /agents/` — every registered agent (the physical host collector) and its
   heartbeat status (NOT org-scoped in the running app today — a pre-existing gap,
   not something Phase 4 introduced).
4. `GET /alerts/active` — every currently-firing alert, evaluated live from enabled
   alert rules against current host state (see the Alerts knowledge slice) (NOT
   org-scoped in the running app today either).
5. `GET /cloud/accounts` — connected cloud accounts, served by the SEPARATE Cloud
   microservice (its own FastAPI app/port). ActMon AI does not yet have a wired path
   into that service (see Limitations) — cloud counts cannot be answered live yet.

No widget's number is stored anywhere as its own row — every one is recomputed from
the 4-5 reads above at request time (or, for the AI, inside one `fleet_dashboard` tool
call that mirrors the same rollup logic the frontend's `useDashboardData` hook runs).

### Widgets (top of page — 5 KPI tiles)
- **Database Server** — count of hosts running at least one monitored DB engine;
  sub-line shows Online vs Offline by that host's own worst/blended db_status.
- **Infra Hosts** — total OS hosts and their overall connectivity health % (good÷total).
- **Cloud Accounts** — connected AWS/Azure/OCI accounts (see Limitations — not live yet
  for the AI).
- **Agents** — total registered agents and how many are Online.
- **Active Alerts** — total firing alerts, split Critical vs Warning.

### Widgets (chart grid)
- **Fleet Health** (donut) — every host bucketed Online/Warning/Offline by raw
  connectivity status (`statusOf`, not the CPU/RAM band scale).
- **Hosts by OS** (donut) — host count grouped by operating system.
- **Engine Distribution** (donut) — host count grouped by which DB engine(s) run there
  (a host with 2 engines counts once per engine here); engines with zero hosts are
  omitted rather than shown as an empty slice.
- **Hosts by Environment** or **Cloud by Provider** (donut) — whichever has data; cloud
  wins if any cloud account exists, else falls back to Production/Staging/Dev/etc.
- **Alerts By Severity** (bar) — firing-alert count split Critical/Warning/Info.
- **Servers By Technology** (stacked bar) — per-engine breakdown of Online/Warning/
  Offline host counts, one row per DB engine (MySQL, PostgreSQL, Oracle, SQL Server,
  MongoDB, ClickHouse).
- **Top Hosts By CPU** (bar, top 5) — the 5 highest-CPU hosts RIGHT NOW, excluding any
  host that is currently offline (an offline host's last cpu_usage is frozen/stale, not
  live, so it is deliberately excluded rather than shown as if current).
- **Average Resource Usage** (gauge) — mean CPU / RAM / Disk % across every host that
  has actually reported a non-zero reading (silent/never-reported hosts are excluded
  from the average, not counted as 0%).
- **Recent Alerts feed** (right rail) — every firing alert, newest first, with its own
  severity filter chips; not just a top-N slice like the chart above it.

### Metrics and how they're computed
- **Infra health %** = round(connected hosts ÷ total hosts × 100). No other formula —
  it is not CPU/RAM/disk-weighted, purely connectivity.
- **CPU / RAM / Disk usage** — each host's own last-reported utilization percentage
  (agent push every ~15s, or SSH poll every ~180s) — a snapshot, not an average over
  time, except on the "Average Resource Usage" gauge which explicitly means the mean
  across all currently-reporting hosts.
- **db_status** (per host) — the host's own worst/blended instance status across all
  its monitored DB engines (Running / Degraded / Stopped / Unknown) — this is the
  actual DATABASE SERVICE state, distinct from the host's own OS-level connectivity
  status (a host can be online while its MySQL service is stopped).

### Statuses used on this page
- Connectivity (`statusOf`): good (online/connected/healthy/up/running/active) /
  warning (warning/degraded) / critical (error/offline/disconnected/down/stopped) /
  unknown — used for Fleet Health, Agents tile, per-engine breakdowns.
- Utilization band (`bandFor`, for any %): Normal <60%, Elevated 60-74%, High 75-89%,
  Critical ≥90% — used for CPU/RAM/Disk anywhere they're shown as a band rather than a
  raw number, and for the "band" column table-view under Top Hosts By CPU / Average
  Resource Usage.
- Alert severity: critical / warning / info — a separate 3-step scale from the above.

### Live vs historical on this page
Every widget on THIS page is LIVE ONLY — a snapshot at the moment of the last refresh
(auto every 30s, or on-demand). The Dashboard itself has no historical/trend view of
its own aggregate numbers (no "environment health over the last 7 days" chart exists
here) — a trend question about the WHOLE fleet cannot be answered from this page's own
data. Historical trend data DOES exist, but only per-INDIVIDUAL host/connection (see
the Infrastructure/Database modules' own history — ClickHouse-backed CPU/RAM/disk
series), not aggregated across the fleet as a whole.

### What this page can answer (current-state / comparison / summary)
- Fleet-wide counts and health: how many hosts/agents/databases/alerts, and their
  online/offline split.
- Which host currently has the highest CPU (from the same Top-5 list the page shows —
  a resource NOT in that top 5 is not necessarily idle, it is simply outside the top 5
  reported here).
- Whether any host/engine is currently in a warning/critical state, and which one.
- A same-moment comparison across many hosts/engines (e.g. "which engine has the most
  offline hosts").

### What this page cannot answer (say so plainly, do not guess or invent)
- A trend for the fleet as a whole over time ("is the environment getting worse") —
  no such aggregate history is computed anywhere; only a per-host trend exists.
- Live cloud account counts/detail — the Cloud microservice isn't wired into ActMon AI
  yet; state this plainly rather than reporting a stale or zero count as current.
- Anything about a metric ActMon doesn't collect at all (see the Metrics knowledge
  slice's live/collector/reserved distinction) — the Dashboard only ever shows what's
  actually live/collector-backed.
- A composite single "environment health score" — the page deliberately shows several
  independent tallies (infra health %, alert counts, per-engine breakdowns) rather than
  one blended number; do not invent one when summarizing."""

GENERAL = """### What ActMon is
ActMon is a multi-tenant (org_id-scoped) enterprise monitoring platform for databases,
OS hosts, and cloud accounts. A lightweight host agent (or SSH poll, for agentless hosts)
reports into the ActMon backend, which persists metrics through Postgres (durable) →
Redis (hot ring) → ClickHouse (per-tech history tables). The frontend is organized by
module: Dashboard, Agents, Database, Cloud, Infrastructure, Alerts, Administration,
Settings, ChatBot.

Supported database technologies: MySQL/MariaDB, PostgreSQL, Oracle, SQL Server (MSSQL),
MongoDB, ClickHouse — each with its own dashboard, slow-query analysis, error logs, and
(uneven, per-engine) replication/HA view."""

HEALTH = """### Health & status — there is no single universal "health" field
It differs by layer:
- Infra utilization (CPU/RAM/disk %, any percentage metric): one shared scale —
  Normal <60%, Elevated 60-74%, High 75-89%, Critical >=90%.
- Connectivity/service state (host/agent/service up-or-down): normalizes to
  good (online/connected/healthy/up/running/active) / warning (warning/degraded) /
  critical (error/offline/disconnected/down/stopped/inactive) / unknown.
- Alert severity: a separate 3-step scale — critical / warning / info.
- Per-database-engine health: NO consistent backend verdict across engines. Only two
  engines compute a real composite score server-side: MySQL replication health (lag-based:
  0s=in sync, <30s acceptable, <300s warning, >=300s critical) and MSSQL index health
  (100 - unused*3 - missing*4 - duplicate*2). Postgres/Oracle/MongoDB/ClickHouse dashboards
  return raw metrics only — the frontend applies the band scale per-field itself. For these
  engines, "what is X's health right now" has no single backend number — report a rollup of
  individual band checks (connection %, cache-hit %, replication state, etc.), never invent
  one composite score.
- Postgres exception: it does compute real issue flags (slow_queries>5, connection_usage_pct>90,
  replication.state=="UNKNOWN") even though it has no single score.
- Cloud security/compliance: a 0-100 heuristic security risk score (explicitly labeled
  heuristic, not a certified benchmark) and a compliance mapping that reports None/NA for
  overall score rather than fabricate one."""

METRICS = """### Metrics and their evaluation tags
The canonical metric catalog (frontend `alertCatalog.js`) covers 4 sections — Infrastructure,
Database, Replication & HA, Cloud — and every metric is tagged with how real its evaluation is:
- live — the backend genuinely evaluates this every poll: cpu, memory, disk, host_down,
  service_down. ONLY these five are truly live-monitored end to end.
- collector — only fires if an agent message happens to mention it via keyword-sniffing
  (not a real check): connections, slow_queries, cache_hit, deadlocks, replication_lag.
- reserved — the rule can be created in the alert-rule UI but nothing in the backend can
  ever raise it: swap, load, disk_io, connections_pct, aborted_connections, query_latency,
  blocking_sessions, long_query, db_size, tablespace, binlog_disk, error_spike, critical_error,
  replication_broken, replica_down, cluster_node_down, every cloud_* metric.
Never state a current value or "being monitored" status for a reserved metric — ActMon has
no live source for it. Say so plainly instead."""

ALERTS = """### Alerts
One pure evaluation module backs both the live `/alerts/active` read and a background
evaluator (30s tick) that tracks how long a (rule, host) breach has been continuous and
enforces duration_seconds (must sustain before firing) and cooldown_seconds (must elapse
before re-notifying) — otherwise every poll would re-notify. Channel resolution: a rule's
own explicit channel picks win; otherwise it falls back to the org's severity-based routing
(Settings -> Notifications -> Severity Routing). Of the notification channel types, only
Email actually sends today — Teams/Slack/Telegram/WhatsApp/Webhook/PagerDuty/Jira/ServiceNow
are connection-test-only stubs. Email is never enqueued if nobody is configured to receive it
(no org-wide default mailbox by design)."""

LOGS = """### Logs
Per-engine Error Logs pages. MySQL's is the most real (reads performance_schema.error_log
and/or tails the error-log file over SSH, classifies severity by regex). Postgres's "error
logs" is actually a pg_stat_activity session-state read, not a true log tail. Each engine has
an "AI analysis" hook but only MySQL's genuinely calls an LLM — Oracle/MSSQL/ClickHouse's are
hardcoded if/elif templates keyed on error-code substrings, with no model call at all. Never
present those three engines' error analysis as AI-generated insight."""

SLOW_QUERY = """### Slow query analysis
One normalized shape across all 6 engines: query text, database/schema/user/host, execution
count, total/average/min/max execution time, rows affected/returned, first/last seen, status,
severity, source. Severity is time-based and shared: >10000ms=critical, >2000ms=high,
>500ms=medium, else low. Data source per engine: Postgres=pg_stat_statements (falls back to
live pg_stat_activity if the extension isn't enabled), MySQL=performance_schema,
MSSQL=sys.dm_exec_query_stats, Oracle=v$sqlarea, ClickHouse=system.query_log,
MongoDB=currentOp/system.profile (point-in-time only). MSSQL has no EXPLAIN capability yet.
There is no kill-query action anywhere in the app today — never imply one exists."""

CLUSTER_HA = """### Cluster/HA monitoring — uneven maturity, represent this honestly per engine
- MySQL: strongest — a real computed health verdict, handles both Galera and classic replication.
- PostgreSQL: richest raw topology (per-replica sync_state, write/flush/replay lag, replication
  slots, logical pub/sub, conflicts) but no single computed verdict — only aggregate counts.
- MongoDB: full rs.status() parse with per-member state and computed lag; anomaly detection is
  client-side only, not a backend field.
- MSSQL: AlwaysOn only exposes an aggregate synchronization_health_desc string per availability
  group — no per-replica lag/send-queue metric.
- Oracle: weakest — Data Guard is a raw viewer with a bare configured:bool; no primary/standby
  role, no lag, no health verdict at all.
Never represent Oracle Data Guard's thin data as equivalently monitored to MySQL replication."""

INFRA = """### Infrastructure / OS host monitoring
Linux and Windows hosts, via either the ActMon agent (push, ~15s cadence) or SSH polling
(pull, 3-minute scheduler tick). Both collectors feed the same metrics table, so both get
real persisted CPU/RAM/disk history and the range/granularity picker. Infra detail page
covers: Overview, Ports, Processes, Storage, Network, Services (start/stop/restart),
Diagnostics, IP Configuration, Config Files (19 modules)."""

AGENT = """### Agent architecture
The agent registers via an enroll/token flow, pushes heartbeats and metrics on a fixed
interval (default 15s, configurable in Settings), and is marked OFFLINE after
offline_after_sec (default 180s) of silence by a background reaper — with hysteresis
(error_streak, default 3 consecutive bad readings) before a status actually flips, to avoid
flapping. The Agents page shows only the physical host agent; per-connection "agents" the
backend auto-creates to track DB<->agent mapping are filtered out of that list."""

RBAC = """### RBAC and available actions
Page-scoped bitmask model: view=1, add=2, edit=4, delete=8, import=16, export=32,
execute=64, approve=128, restart=256 (Full Access = 511, sum of all bits). A grant is
(org_id, role_id, page_id) -> bitmask. Every action the assistant can trigger must go through
the same backend permission check the corresponding UI button already uses — never a
parallel/looser check. Actions ActMon supports today: start/stop/restart a service
(execute/restart), kill a process (execute), reboot a host (restart), update an agent
(execute), add/remove a firewall rule (add/delete), write a config file or registry value
(edit). Killing a slow query and running arbitrary SQL against a monitored database are NOT
supported anywhere in the app — never imply the assistant can do either."""

CONFIG = """### Configuration options
Settings module covers: Appearance (theme, fonts, layout, breadcrumbs, rows-per-page),
Notifications (SMTP config, per-channel setup, severity-based routing), and monitoring
thresholds (error_streak, collector_interval_sec, offline_after_sec — live-editable, not
just env vars). These are configuration facts, not monitoring data — "what is configured"
differs from "what is happening now"."""

CLOUD = """### Cloud module
A separate microservice with its own resource scanners (AWS/Azure/OCI), a cost service that
pulls only real billing-API data, a security service with a real heuristic 0-100 risk score,
a compliance service that explicitly reports None/NA rather than fabricate an overall score,
and a minimal alerting capability — exactly one real detection rule today, the rest are
placeholders. Never represent the cloud alerting service as a full alerting engine."""

REALTIME = """### Real-time vs historical data
Live/real-time: anything read directly from the target engine or host at request time
(dashboard calls, /alerts/active, an agent's last-reported row) — freshness is bound by the
collector's own interval (15s agent, 180s SSH scheduler, 30s alert evaluator tick).
Historical: ClickHouse-backed per-tech metric history, notification history (delivery
record), alert breach timeline, audit/login history. Config (connection records, alert
rules, severity routing, RBAC grants, appearance settings) answers "what is configured," not
"what is happening now"."""

_MODULES = {
    "general": GENERAL,
    "dashboard": DASHBOARD,
    "database": HEALTH + "\n\n" + METRICS,
    "health": HEALTH,
    "metrics": METRICS,
    "alerts": ALERTS,
    "logs": LOGS,
    "slow_query": SLOW_QUERY,
    "cluster_ha": CLUSTER_HA,
    "infra": INFRA,
    "agent": AGENT,
    "rbac": RBAC,
    "config": CONFIG,
    "cloud": CLOUD,
    "realtime": REALTIME,
}


def knowledge_for(modules: list) -> str:
    """Return only the requested module slices, joined. Unknown module names are
    ignored rather than raising, since this is fed by an LLM's own classification
    of the module name and must degrade gracefully. Falls back to GENERAL + HEALTH
    (the two most commonly needed slices) if nothing recognizable was requested."""
    picked = [_MODULES[m] for m in (modules or []) if m in _MODULES]
    if not picked:
        picked = [GENERAL, HEALTH]
    return "\n\n".join(picked)
