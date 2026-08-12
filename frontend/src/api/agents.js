import client, { ensureArray } from './client';

/** GET /agents/ → every accessible agent with its live metrics. */
export const listAgents = () =>
  client.get('/agents/').then((r) => ensureArray(r.data));

/**
 * POST /agents/register
 * Payload is built by config/agents.js → REGISTRATION.toPayload(), which keeps it
 * byte-identical to what the existing module sends.
 * 409 when the agent name already exists.
 */
export const registerAgent = (payload) =>
  client.post('/agents/register', payload).then((r) => r.data);

/** POST /agents/sync-connections → { created: [], skipped: [] } */
export const syncConnections = () =>
  client.post('/agents/sync-connections').then((r) => r.data);

/** GET /agents/{name}/service-state → is the host's ActMon service running? */
export const getServiceState = (name) =>
  client.get(`/agents/${encodeURIComponent(name)}/service-state`).then((r) => r.data);

/* ══════════════════════════════════════════════════════════════════════════════
   Setup / deploy wizard endpoints.
   Signatures copied from the existing module so the ported wizard pages call the
   API exactly as they do today.
   ══════════════════════════════════════════════════════════════════════════════ */

/** Persist the ingestion token the deploy wizard bakes into the install command. */
export const createInstallToken = async (payload) => {
  const response = await client.post('/agents/install-token', payload);
  return response.data;
};

/** Hand DB credentials to the agent (by token) so it collects the DB locally. */
export const saveAgentDbConfig = async (payload) => {
  const response = await client.post('/agents/db-config', payload);
  return response.data;
};

/**
 * Test a DB connection THROUGH the agent — it connects to localhost on the agent
 * host (which the backend can't reach). Returns { ok, message|error }.
 */
export const testDbViaAgent = async (payload) => {
  const response = await client.post('/agents/db-test', payload);
  return response.data;
};

/**
 * LAN IPs of the ActMon server — used to build install URLs the TARGET host can
 * actually reach (window.location "localhost" would make it dial itself).
 * Returns { primary, ips: [] }.
 */
export const getHostIps = async () => {
  const response = await client.get('/agents/host-ips');
  return response.data;
};

/**
 * GET /agents/{name}/host-overview
 * One call returning { agent, telemetry, host, events } — the agent-monitoring
 * view for a host agent.
 */
export const getHostOverview = (name) =>
  client.get(`/agents/${encodeURIComponent(name)}/host-overview`).then((r) => r.data);

/**
 * GET /agents/{name}/update-status
 * State of the last upgrade pushed to this agent:
 * { has_update: false } | { has_update: true, status, expected_version,
 *   from_version, confirmed_version, detail, issued_at, delivered_at, confirmed_at }
 */
export const getAgentUpdateStatus = (name) =>
  client.get(`/agents/${encodeURIComponent(name)}/update-status`).then((r) => r.data);

/**
 * GET /api/v1/metrics/pipeline/status
 * The TRUE state of the telemetry tiers:
 * { enabled, redis, clickhouse, pending_ch, tables, ring_size, ch_ttl_days }
 *
 * Needed because host-overview's `telemetry.transport.redis` is not a health
 * check — the backend sets it to `bool(ring)`, so an empty ring reads as "Redis
 * down" even when Redis is fine.
 */
export const getPipelineStatus = () =>
  client.get('/metrics/pipeline/status').then((r) => r.data);

/**
 * GET /api/v1/metrics/history/{agent}?minutes=&bucket_seconds=&kind=&tech=
 * ClickHouse history for the range/granularity picker — {agent, source,
 * samples: [{ts, kind, tech, agent, conn_id, host_cpu, host_memory, ...}]}
 * newest-first. `bucketSeconds` server-side averages into that bucket width
 * (see history_bucketed's own docstring for why a long range needs this
 * rather than just a bigger row limit).
 *
 * ALWAYS pass `kind`/`tech` when asking for a HOST's own CPU/Memory/Disk trend
 * (kind: 'infra', tech: 'host') — omitting them merges every ClickHouse table
 * sharing this agent_name, which for a multi-engine host agent includes its
 * own database connections' rows too (whose host_cpu/host_memory are always
 * 0), silently averaging the host's real reading down.
 */
export const getMetricsHistory = (name, { minutes = 60, bucketSeconds, kind, tech, connId } = {}) =>
  client.get(`/metrics/history/${encodeURIComponent(name)}`, {
    params: { minutes, bucket_seconds: bucketSeconds, kind, tech, conn_id: connId },
  }).then((r) => r.data);

/* ══════════════════════════════════════════════════════════════════════════════
   Database Agent Monitoring — the checks catalogue/runner and real-event
   timeline behind a database-type agent's own page. Nothing here executes
   automatically; a check runs only when explicitly POSTed.
   ══════════════════════════════════════════════════════════════════════════════ */

/** GET /agents/db-agent/{connId}/info → { connection_name, db_type, host, port, database_name, instance_name, service_name, sid } */
export const getDbAgentInfo = (connId) =>
  client.get(`/agents/db-agent/${connId}/info`).then((r) => r.data);

/** GET /agents/db-agent/{connId}/checks → { supported, checks: [{id,title,category,command_desc,status,last_run,duration_ms,last_success_at,last_failure_at,failure_count,output,error}] } */
export const getDbAgentChecks = (connId) =>
  client.get(`/agents/db-agent/${connId}/checks`).then((r) => r.data);

/** POST /agents/db-agent/{connId}/checks/{checkId}/run → { check: {...} } — explicit action only */
export const runDbAgentCheck = (connId, checkId) =>
  client.post(`/agents/db-agent/${connId}/checks/${encodeURIComponent(checkId)}/run`).then((r) => r.data);

/** GET /agents/db-agent/{connId}/checks/{checkId}/history → { runs: [{checked_at,status,duration_ms,output,error}] } */
export const getDbAgentCheckHistory = (connId, checkId) =>
  client.get(`/agents/db-agent/${connId}/checks/${encodeURIComponent(checkId)}/history`).then((r) => r.data);

/** GET /agents/db-agent/{connId}/timeline → { events: [{label,timestamp,detail}] } — real events only */
export const getDbAgentTimeline = (connId) =>
  client.get(`/agents/db-agent/${connId}/timeline`).then((r) => r.data);
