# ActMon AI Assistant — Phase 1 Analysis (pre-implementation)

Status: **analysis only** — no query-generation or intent-routing code has been changed.
This document is the input to the Phase 4 design conversation.

---

## 0. Existing AI/Groq implementation — what's actually there today

Everything the app currently calls Groq for, so the gap analysis below is grounded in fact, not assumption.

| Call site | Model | Real LLM call? | Purpose |
|---|---|---|---|
| `services/chatbot/ai_engine.py` (`stream_chat`, `chat_once`) | `llama-3.3-70b-versatile` | Yes | The chat widget — see below, this is "Phase 3"'s current (inadequate) implementation |
| `services/common/diagnose_ai_service.py` | `llama-3.3-70b-versatile`, temp 0.1 | Yes | RCA layer for the Diagnosis page, explicit "Run ActmonAI Analysis" button only |
| `services/mysql/mysql_ai_analysis.py` | `llama-3.3-70b-versatile`, temp 0.1 | Yes | Slow-query analysis + MySQL error-log analysis |
| `services/oracle/oracle_ai_analysis.py` (slow-query fn) | same | Yes | Slow-query analysis |
| `services/mssql/mssql_ai_analysis.py` (slow-query fn) | same | Yes | Slow-query analysis |
| `services/clickhouse/clickhouse_ai_analysis.py` (slow-query fn) | same | Yes | Slow-query analysis |
| `oracle_ai_analysis.py` / `mssql_ai_analysis.py` (**error-log fns**) | — | **No — hardcoded if/elif text templates keyed on error code** | Looks like AI, isn't |
| `clickhouse_ai_analysis.py` (error-log fn) | — | **No — same as above** | Looks like AI, isn't |

**The chat widget today** (`ai_engine.py` + `chatbot_routes.py` + `health_tool.py`):
- System prompt (`build_system_prompt`) frames the assistant as a generic "expert DBA" (MySQL/Postgres/Mongo/MSSQL/Oracle/ClickHouse), lists the org's configured connections by name/host, and instructs it to do SQL generation, schema design, EXPLAIN interpretation, index recommendations, and report-download markers (`[ACTION:report:...]`). **It contains zero ActMon-specific domain knowledge** — no health-band definitions, no metric catalog, no module descriptions, no RBAC awareness, no mention of Infra/Agents/Alerts/Cloud/Diagnosis at all.
- The **only** "understand intent before answering" logic that exists is `health_tool.detect_health_intent()` — a keyword match against 25 words (`health, status, report, how is, overview, performance, metric, utiliz, slow, connection, uptime, cache, doing, check, summary, monitor, load, cpu, memory, ram, disk`). This is a **false-positive machine**: the exact bug the user is asking to fix. Asking *"what is database health?"* (a conceptual question) contains the word "health" → `detect_health_intent()` returns `True` → the code tries to `find_connection()` (fails, no specific server named) → **falls back to whatever connection is selected in the frontend widget's context** → forces the LLM into a rigid "LIVE REAL-TIME DATA... reply as a real-time DB HEALTH REPORT" template using that connection's numbers, regardless of what was actually asked.
- When it *does* find a connection, `get_live_health()` correctly dispatches to each engine's real dashboard service (`mysql_dashboard_service.get_dashboard`, `postgres_connection_service.svc_get_dashboard`, etc.) — so the plumbing for "pull real data for one specific connection" already exists for the 6 DB engines. It does **not** exist for Infra hosts, Agents, Alerts, Cloud, or Cluster/HA specifically — `get_live_health` has no branch for any of those.
- `find_connection()` is a fragile substring/token matcher with no disambiguation — if two connections both loosely match, it silently returns the first one found in DB iteration order.
- `generate_health_summary_csv()` (the "download health report" action) doesn't pull real health at all — it emits `"Configured", "Health data available via monitoring dashboard"` as literal placeholder text for every row.
- No RBAC check anywhere in the chat path. No action-execution capability beyond CSV markers (no restart/kill/acknowledge).

This confirms the user's framing exactly: **today's assistant is architected as "question → (maybe keyword-triggered live data) → SQL/report-flavored answer," not "question → intent → knowledge or data or action."**

---

## 1–20. ActMon Knowledge Structure (Phase 2)

### 1. What ActMon is
A multi-tenant (`org_id`-scoped) enterprise monitoring platform for databases, OS hosts, and cloud accounts. Centralized agent architecture: a lightweight host agent (or SSH poll, for agentless hosts) reports into a FastAPI backend, which persists to Postgres (durable) → Redis (hot ring) → ClickHouse (per-tech history tables) for the metrics pipeline, and exposes a React frontend organized by module (Dashboard, Agents, Database, Cloud, Infrastructure, Alerts, Administration, Settings, ChatBot).

### 2–3. What it monitors / supported DB technologies
MySQL/MariaDB, PostgreSQL, Oracle, SQL Server (MSSQL), MongoDB, ClickHouse — each with its own dashboard, slow-query analysis, error logs, and (per-engine, uneven) replication/HA view. CosmosDB has a dashboard too (not covered by this pass's research, flagged as a gap to fold in later).

### 4. Supported OS/infrastructure monitoring
Linux and Windows hosts, via either the ActMon agent (push, ~15s cadence) or SSH polling (pull, 3-minute scheduler tick — `os_server_refresh_scheduler.py`, `TICK_SECONDS = 180`). Both collectors feed the *same* `AgentMetric` table (`kind='infra', tech='host'`) since this session's fix, so both get real persisted CPU/RAM/disk history, not just a live snapshot. Infra detail page tracks: Overview, Ports, Processes, Storage (filesystems), Network (14 sub-views: interfaces, real-time traffic, connection stats, errors, DNS, gateway, TCP/UDP, open ports, bandwidth, Wi-Fi, routing, ARP, processes-by-port), Services (start/stop/restart), Diagnostics (ping/port-test/DNS-lookup), IP Configuration (interface/IPv4/IPv6/DNS/advanced/conflict-detection/validation/export/edit-network-config/firewall), Config Files (19 modules: OS, hardware, CPU, memory, disk, storage, filesystem, partition, network, IP, DNS, routing, firewall, SSH, service, process, NTP, power, database).

### 5. Agent architecture
Agent registers via an enroll/token flow (per-deployment token or a universal MSI token), pushes heartbeats + metrics on a fixed interval (default 15s, configurable), and is marked OFFLINE after `offline_after_sec` (default 180s) of silence by a background reaper (`agent_reaper_service.py`) — with hysteresis (`error_streak`, default 3 consecutive bad readings) before a DB-service status flips, specifically to avoid flapping. The **Agents page shows only the physical host agent** — per-connection "agents" the backend auto-creates to track DB↔agent mapping are filtered out of that list (they still power each database's own dashboard).

### 6. SSH architecture
For hosts without the agent installed: paramiko-based SSH session per poll, running a fixed set of shell commands (top/free/df/systemctl status per engine) to populate the same `OsServer` fields the agent would push. As of this session, SSH-collected samples also get an `AgentMetric` row written on every scheduler tick, so SSH hosts have the same persisted history and range/granularity picker as agent hosts (previously SSH hosts only had a client-side, session-local, resets-on-reload buffer).

### 7. Database connection architecture
`ConnectionMaster` is the org-scoped record of a monitored DB connection (host/port/credentials/db_type/environment). Each of the 6 engines has its own connection-add flow, its own dashboard/monitoring service, its own slow-query and error-log routes, all namespaced under `/connections/{engine}/{id}/...`.

### 8. Dashboard functionality
Two levels: the cross-module **Monitoring Overview** (`/dashboard`) — KPI row (Database Servers, Infra Hosts, Cloud Accounts, Agents, Active Alerts), then donut/chart grid (Fleet Health, Hosts by OS, Engine Distribution, Cloud/Environment split, Alerts by Severity, Servers by Technology, Top Hosts by CPU, Average Resource Usage) with a live alert feed running down the right — and each **module's own dashboard** (per DB engine, per Infra host, per Cloud account).

### 9. Health calculation — the single most important (and most inconsistent) concept
There is **no one universal "health" field**. It differs by layer:
- **Infra-level utilization** (CPU/RAM/disk %, any percentage metric): one shared scale, `frontend/src/components/charts/status.jsx`'s `bandFor(pct)` — **Normal <60%, Elevated 60–74%, High 75–89%, Critical ≥90%**. This is the canonical, reusable definition.
- **Connectivity/service state** (host/agent/service up-or-down): `statusOf(raw)` normalizes many backend string spellings onto **good (online/connected/healthy/up/running/active) / warning (warning/degraded) / critical (error/offline/disconnected/down/stopped/inactive) / unknown**.
- **Alert severity**: separate 3-step scale, **critical / warning / info**.
- **Per-database-engine health**: **no consistent backend verdict across engines.** Only two engines compute one server-side: MySQL's replication `_compute_health()` (lag 0s=in sync, <30s acceptable, <300s warning, ≥300s critical → healthy/warning/critical) and MSSQL's index `health_score = 100 − unused×3 − missing×4 − duplicate×2`. Everything else (Postgres, Oracle, MongoDB, ClickHouse dashboards) returns **raw metrics only**; the frontend applies `bandFor`/`statusOf` per-field itself. **This means "what is PostgreSQL's health right now" has no single backend number to report — the honest answer is a rollup of several individual band checks (connection %, cache-hit %, replication state, etc.), not one verdict.** The AI must not invent a single score where none exists.
- **Postgres does have one real exception**: `svc_analyze`/`svc_analyze_error` in `postgres_connection_service.py` compute actual issue flags (slow_queries>5, connection_usage_pct>90, replication.state=="UNKNOWN").
- **Cloud security/compliance**: the only other genuine composite scores in the app — a 0-100 security risk score (severity-weighted: critical=25, high=15, medium=8, low=3, info=1 penalty, converted to an A–F grade, explicitly labeled "heuristic" not a certified benchmark) and a compliance mapping that explicitly reports `None`/NA for overall score rather than fabricate one (SOC2/HIPAA/PCI-DSS cross-walked from only 4 security categories — explicitly partial).

### 10. Metrics and their meanings
Full canonical metric catalog lives in `frontend/src/config/alertCatalog.js`, organized into 4 sections (Infrastructure, Database, Replication & HA, Cloud) each with groups and metrics — **and, critically, each metric is tagged with an `evaluation` field the AI must respect**:
- `live` — the backend genuinely evaluates this every poll (only: `cpu`, `memory`, `disk`, `host_down`, `service_down`).
- `collector` — only fires if an agent message happens to mention it (`connections`, `slow_queries`, `cache_hit`, `deadlocks`, `replication_lag` — mapped via keyword-sniffing `infer_metric()`, not a real check).
- `reserved` — **the rule can be created in the UI but nothing in the backend can ever raise it** (`swap`, `load`, `disk_io`, `connections_pct`, `aborted_connections`, `query_latency`, `blocking_sessions`, `long_query`, `db_size`, `tablespace`, `binlog_disk`, `error_spike`, `critical_error`, `replication_broken`, `replica_down`, `cluster_node_down`, every `cloud_*` metric). **The AI must never claim a "reserved" metric is being monitored or has a current value** — it isn't and doesn't.

### 11. Alerts and statuses
Two evaluation surfaces sharing one pure logic module (`alert_engine_service.py`): the live `GET /alerts/active` read, and a persistent background evaluator (`alert_evaluator_service.py`, 30s tick) that tracks per-(rule, host) breach duration and enforces `duration_seconds` (must sustain before firing) and `cooldown_seconds` (must elapse before re-notifying) — otherwise every poll would re-notify. Channel resolution: a rule's own explicit channel picks win; if none are set, it falls back to the org's severity-based routing (Settings → Notifications → Severity Routing). Of 9 notification channel types, **only Email actually sends** (`channel_dispatch.py`'s `SEND_DISPATCH` — Teams/Slack/Telegram/WhatsApp/Webhook/PagerDuty/Jira/ServiceNow are all connection-test-only stubs returning "not yet connected"). Email has **no org-wide default recipient by design** — a rule/route pointing at Email with nobody configured to receive it is now (this session's fix) skipped at enqueue time rather than attempted-and-failed forever.

### 12. Logs
Per-engine Error Logs pages/services. MySQL's is the most real (reads `performance_schema.error_log` and/or tails the error-log file over SSH, classifies each line's severity by regex, builds a status timeline). Postgres's "error logs" is actually a `pg_stat_activity` session-state read, not a true log tail. Each engine has an `analyze-groq`/AI-analysis hook — **only MySQL's genuinely calls Groq**; Oracle/MSSQL/ClickHouse's are hardcoded if/elif templates keyed on error-code substrings (e.g. Oracle ORA-1/54/1017 handled specifically, else a generic message) with **no model call at all**. The AI must not claim these three engines' error analysis is "AI-generated."

### 13. Slow query analysis
One normalized shape across all 6 engines (`slow_query_normalize.py`): query_id/text, database/schema/user/host, execution_count, total/average/min/max execution time, rows_affected/returned, first/last_seen, status, severity, source — plus a `capabilities` map per engine (not every engine can populate every field). Severity is time-based and shared: **>10000ms=critical, >2000ms=high, >500ms=medium, else low**. Per-engine data source: Postgres=`pg_stat_statements` (falls back to live `pg_stat_activity` if the extension isn't enabled), MySQL=`performance_schema`, MSSQL=`sys.dm_exec_query_stats`, Oracle=`v$sqlarea`, ClickHouse=`system.query_log`, MongoDB=`currentOp`/`system.profile` (point-in-time only, no aggregation, no stable ID — same for ClickHouse). MSSQL has no EXPLAIN capability yet. No kill-query action exists anywhere in this flow today.

### 14. Performance monitoring
Covered per-engine inside each dashboard (buffer/cache hit ratios, connection counts, query stats, lock waits, table/tablespace sizes) — see §9's per-engine table for exact fields; there is no cross-engine "performance score."

### 15. Cluster/HA monitoring — uneven maturity, the AI must represent this honestly per engine
- **MySQL**: strongest — real computed health verdict (see §9), handles both Galera and classic replication.
- **PostgreSQL**: richest raw topology (per-replica sync_state, write/flush/replay lag in both time and bytes, replication slots with inactive-reason diagnosis, logical pub/sub, conflicts) but **no single computed verdict** — only aggregate counts.
- **MongoDB**: full `rs.status()` parse with per-member state and computed lag; anomaly detection is **client-side only**, not a backend field.
- **MSSQL**: AlwaysOn only exposes an aggregate `synchronization_health_desc` string per availability group — **no per-replica lag/send-queue metric**; a frontend code comment explicitly notes an expected `always_on.replicas` array is never populated by the backend.
- **Oracle**: weakest — Data Guard is a raw `v$dataguard_status`/`v$standby_log` viewer with a bare `configured: bool`; **no primary/standby role, no lag, no health verdict at all.**

### 16. RBAC and available actions
Page-scoped bitmask model (not per-module dotted permission names): a small shared verb catalog — `view=1, add=2, edit=4, delete=8, import=16, export=32, execute=64, approve=128, restart=256` (Full Access sentinel = 511, sum of all bits). A grant is `(org_id, role_id, page_id) → bitmask`. Frontend: `usePermissions.js`'s `canHere(action)`/`can(pageUrl, action)`. Backend: `permission_guard.py`'s `require_permission(page_url, action)` FastAPI dependency / `check_permission()` for body-dependent actions, enforced on every mutating Infra route (service start/stop/restart, kill process, reboot, update agent, firewall add/delete, file write, registry write) as of this session's work — this is the enforcement pattern any AI-triggered action must reuse, not bypass.

### 17. Configuration options
Settings module: Appearance (theme, fonts, layout, breadcrumbs, rows-per-page), Notifications (SMTP config, per-channel setup, severity-based routing), monitoring thresholds (`error_streak`, `collector_interval_sec`, `offline_after_sec` — live-editable, cache-invalidated on save, not just env vars).

### 18. Available APIs/data sources
Enumerated in full in §"Available Data Sources" below.

### 19–20. Real-time vs historical
See the dedicated section below — this distinction is central to the intent model the user asked for.

---

## AI Intent Categories

| Category | Example | Needs live data? | Needs RBAC check? |
|---|---|---|---|
| **Conceptual** | "What is database health?" | No | No |
| **Current-state** | "What is PostgreSQL's health right now?" | Yes — live dashboard call | View-level only |
| **Historical** | "What was PostgreSQL's health yesterday?" | Yes — ClickHouse `metrics_history` / `notification_history` / audit log | View-level only |
| **Analytical / troubleshooting** | "Why is PostgreSQL unhealthy?" | Yes — live data + the engine's own diagnostic logic (reuse `diagnose_ai_service`/RCA pattern, don't re-derive) | View-level only |
| **Comparison** | "Compare CPU across all Postgres servers" | Yes — multiple live pulls | View-level only |
| **Recommendation** | "How should I fix this slow query?" | Sometimes (needs the query's real stats) | View-level only |
| **Configuration info** | "What's my alert severity routing?" | Yes, but it's config, not monitoring data | View-level only |
| **Action request** | "Restart PostgreSQL" | N/A | **execute/restart bit required, confirmation required** |
| **Ambiguous** | "How's it doing?" (no resource named) | Unknown | Ask, don't guess |

## Response Rules (the decision process, concretely)

1. **Classify intent** before anything else. A keyword appearing in the message ("health", "cpu", etc.) is not sufficient signal by itself — `detect_health_intent()`'s current approach is exactly the failure mode to replace.
2. **Conceptual questions get a knowledge answer, zero tool calls, zero SQL, zero live-data fetch.** The knowledge to draw from is §1–20 above (or a Phase-4 structured version of it), not general internet DBA knowledge dressed up as ActMon-specific.
3. **Current-state / historical / analytical / comparison questions require a *named or resolvable* resource.** If the message doesn't name one and no resource is in the active page context, ask a short clarifying question — do not silently default to whatever connection happens to be open (today's bug).
4. **Only call the specific existing backend service function for that resource+engine** — never construct or run ad-hoc SQL against a monitored database on the AI's own initiative. Every engine already has a real `get_dashboard`/`svc_get_dashboard`/etc. — reuse it, don't reinvent a query path.
5. **Never state a metric's value or status if that metric's `evaluation` is `reserved`.** Say plainly that ActMon doesn't have a live source for it yet.
6. **Never claim a composite "health score" exists for an engine that doesn't compute one** (only MySQL replication and MSSQL index health are real scores; report a rollup of individual bands for everything else, or say so).
7. **Action requests always go through the same RBAC dependency the UI button would use** — resolve the page/action pair, check the bit, and require an explicit confirmation step before calling the mutating route. Never perform a destructive action from a single ambiguous sentence.
8. **If live data is unavailable** (connection unreachable, RBAC denies view, engine not supported), say so plainly — never fabricate a plausible-looking number.

## Available Data Sources (what "tools" the AI can call, Phase 4 candidates)

- Per-engine dashboard services (6): `mysql_dashboard_service.get_dashboard`, `postgres_connection_service.svc_get_dashboard` / `postgres_monitoring_service.svc_monitoring_dashboard`, `oracle_monitoring_service.oracle_dashboard`, `mssql_monitoring_service.get_monitoring_dashboard`, `mongo_monitoring_service.get_dashboard`, `clickhouse_monitoring_service.get_dashboard` — already dispatched by `health_tool.get_live_health`, just needs the same pattern extended.
- Per-engine replication/HA services (5, uneven — see §15).
- Per-engine slow-query + error-log services (normalized shape, §12–13).
- `alert_engine_service.evaluate()`/`applies()` — live alert state; `notification_history` table — historical delivery record; `alert_fired_state` — current breach-duration tracking.
- Infra: `infra_detail_service` (host snapshot), `metrics_pipeline.history()`/`history_bucketed()` (ClickHouse-backed historical CPU/RAM/disk for both agent and SSH hosts as of this session).
- Agent state: `Agent`/`AgentMetric` tables, reaper thresholds (`monitoring_settings_service.get_settings()`).
- Cloud: separate microservice (`Backend/cloud/app`) — resource scanners (AWS/Azure/OCI), cost service (real billing-API pulls only), security service (real condition-based findings + heuristic score), compliance service (explicitly partial, NA-safe), topology service, and a minimal in-memory alerting service (one real rule, everything else placeholder — must not be represented as a full alerting engine).
- Diagnosis: `diagnose_orchestrate_service` (rule-based RCA + evidence bundle) + `diagnose_ai_service.analyze()` (the Groq reasoning layer over that evidence — this is the closest existing precedent for "analytical" intent and should likely be reused/generalized rather than rebuilt).
- RBAC: `access_control_service.validate_access()` / `permission_guard.check_permission()`.

## Live vs Historical Classification

- **Live/real-time**: anything read directly from the target engine or host at request time (dashboard calls, `/alerts/active`, agent's last-reported row). Freshness bound by the collector's own interval (15s agent, 180s SSH scheduler, 30s alert evaluator tick).
- **Historical**: ClickHouse `metrics_infra`/per-tech tables (via `metrics_pipeline.history()`), `notification_history` (delivery record — includes the failed/spam rows from before this session's fix), `alert_fired_state` (breach timeline), audit_log, login_history, password_history, user_sessions, Diagnosis "History" tab runs.
- **Config, not monitoring data**: connection records, alert rules, severity routing, RBAC grants, appearance settings — these answer "what is configured," not "what is happening now."

## Supported Actions (and their RBAC verb)

| Action | Verb | Notes |
|---|---|---|
| Start/stop/restart a service | `execute` / `restart` | Password re-auth required on the existing route |
| Kill a process | `execute` | |
| Reboot a host | `restart` | |
| Update agent | `execute` | |
| Add/remove a firewall rule | `add` / `delete` | |
| Write a config file / registry value | `edit` | |
| Acknowledge an alert | *(not yet RBAC-gated — flag as a gap)* | |
| Run a diagnosis check | *(gated by Diagnosis page's own permission, not yet cross-checked this session)* | |
| Kill a slow query | **Does not exist in the app today** — do not imply the AI can do this |
| Arbitrary SQL execution against a monitored DB | **Not supported, should not be offered as an action** | |

## Required Context Per Module

- **Any DB engine page**: `db_type`, `connection_id` (already passed today via chat `context`).
- **Infra pages**: host `id` (`server_id`), `collector` type (agent vs ssh — changes which historical query path/freshness caveat applies).
- **Alerts**: `org_id`/role for severity-routing questions; rule `id` for a specific-rule question.
- **Cloud**: `provider` + `account_id` (separate microservice, separate auth).
- **All modules**: `org_id`, `role_id` from the authenticated session, for every RBAC check and every historical query (multi-tenant scoping is not optional).

## Gaps in the Current AI Implementation (summary)

1. No real intent classification — one keyword-triggered boolean flag, prone to false positives on conceptual questions (the reported bug).
2. Zero ActMon domain knowledge in the system prompt — the model has to guess at ActMon's own concepts from a generic "you are a DBA" framing.
3. Live grounding only covers 6 DB engines' health, nothing for Infra/Agents/Alerts/Cloud/Cluster-HA specifically, and no historical retrieval at all.
4. No RBAC integration in the chat path whatsoever.
5. No action-execution capability beyond fake CSV report markers, and the health-report CSV doesn't even pull real data.
6. `find_connection()` has no disambiguation and silently guesses.
7. Inconsistent "is this really AI" honesty: 3 of 6 engines' error-log "analysis" is a hardcoded template, not a Groq call — if the assistant is ever asked to explain an error, it must not present these as AI-derived insight.
8. No representation anywhere of which metrics are `reserved` (fake) vs `live`/`collector` (real) — a real risk of the assistant confidently reporting on a metric ActMon cannot actually see.
9. No representation of per-engine HA/replication maturity differences (§15) — a naive implementation would treat Oracle Data Guard as equally monitored as MySQL replication, which it is not.

## Recommended Architecture for Phase 4

```
User Question
   → Intent Classifier (cheap first pass: rule/keyword-assisted candidate + LLM confirms among the 9 categories above — not a single boolean)
   → ActMon Knowledge Injection (only the relevant module's slice of the structured knowledge above, not the whole document every turn — token budget)
   → Resource Resolution (named entity → connection/host/rule id; ask for clarification if ambiguous or missing, never guess)
   → Branch:
        • Conceptual        → answer from knowledge, no tool call
        • Current-state     → call the one matching existing dashboard/service function for that engine+resource
        • Historical        → query metrics_pipeline.history() / notification_history / alert_fired_state
        • Analytical        → live data + reuse diagnose_ai_service's evidence-bundle pattern
        • Action            → RBAC check (permission_guard) → explicit confirmation → call the existing mutating route
   → Reasoning/synthesis over whatever was retrieved
   → Natural-language response (state plainly when data is unavailable, a metric is unmonitored, or a capability doesn't exist)
```

Key design decisions this implies for Phase 4, not yet built:
- A real intent-classification step, replacing `detect_health_intent()`.
- A structured, filterable knowledge base (this document, or its structured-data equivalent) injected *selectively* per turn.
- A resource-resolution step with disambiguation, replacing `find_connection()`'s silent-first-match behavior.
- A tool-dispatch layer wrapping the *already-existing* dashboard/history/alert functions — no new SQL-generation surface against monitored databases.
- RBAC enforcement wired into the chat path for both data visibility and, especially, any action the assistant is ever allowed to trigger.
