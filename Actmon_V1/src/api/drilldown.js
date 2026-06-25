import client from './client';

// ── Generic drill-down API (all engines): /drilldown/{tech}/{connId}/... ──
const B = (tech, connId) => `/drilldown/${tech}/${connId}`;
export const ddHostMetrics = (tech, connId) => client.get(`${B(tech, connId)}/host-metrics`).then((r) => r.data);
export const ddProcesses = (tech, connId, sort = 'cpu') => client.get(`${B(tech, connId)}/processes`, { params: { sort } }).then((r) => r.data);
export const ddProcessSessions = (tech, connId, pid) => client.get(`${B(tech, connId)}/process/${pid}/sessions`).then((r) => r.data);
export const ddSessionDetail = (tech, connId, pid) => client.get(`${B(tech, connId)}/session/${pid}/detail`).then((r) => r.data);
export const ddRca = (tech, connId, resource = 'cpu', pid, cmd) =>
  client.get(`${B(tech, connId)}/rca`, { params: { resource, ...(pid ? { pid } : {}), ...(cmd ? { cmd } : {}) } }).then((r) => r.data);
export const ddHistory = (tech, connId, hours = 6) => client.get(`${B(tech, connId)}/history`, { params: { hours } }).then((r) => r.data);
export const ddHistoryDetail = (tech, connId, sampleId) => client.get(`${B(tech, connId)}/history/${sampleId}`).then((r) => r.data);
export const ddHistoryRca = (tech, connId, sampleId, resource = 'cpu') =>
  client.get(`${B(tech, connId)}/history/${sampleId}/rca`, { params: { resource } }).then((r) => r.data);

// SQL Server Windows OS process visibility (opt-in, xp_cmdshell)
export const mssqlOsProcesses = (connId) =>
  client.get(`/drilldown/mssql/${connId}/os-processes`).then((r) => r.data);
export const mssqlEnableOsVisibility = (connId) =>
  client.post(`/drilldown/mssql/${connId}/enable-os-visibility`).then((r) => r.data);
export const mssqlTableDetail = (connId, dbName, schema, table) =>
  client.get(`/drilldown/mssql/${connId}/table-detail`, { params: { db_name: dbName, schema, table } }).then((r) => r.data);

// PostgreSQL SolarWinds-style resource drill-down (on-demand).
export const pgHostMetrics = (connId) =>
  client.get(`/connections/postgresql/${connId}/host-metrics`).then((r) => r.data);

export const pgProcesses = (connId, sort = 'cpu') =>
  client.get(`/connections/postgresql/${connId}/processes`, { params: { sort } }).then((r) => r.data);

export const pgProcessSessions = (connId, pid) =>
  client.get(`/connections/postgresql/${connId}/process/${pid}/sessions`).then((r) => r.data);

export const pgSessionDetail = (connId, pid) =>
  client.get(`/connections/postgresql/${connId}/session/${pid}/detail`).then((r) => r.data);

export const pgRca = (connId, resource = 'cpu', pid, cmd) =>
  client.get(`/connections/postgresql/${connId}/rca`, {
    params: { resource, ...(pid ? { pid } : {}), ...(cmd ? { cmd } : {}) },
  }).then((r) => r.data);

export const pgGrantMonitor = (connId) =>
  client.post(`/connections/postgresql/${connId}/grant-monitor`).then((r) => r.data);

// Historical resource samples (logged over time; spikes carry full evidence).
export const pgHistory = (connId, hours = 6) =>
  client.get(`/connections/postgresql/${connId}/history`, { params: { hours } }).then((r) => r.data);

export const pgHistoryDetail = (connId, sampleId) =>
  client.get(`/connections/postgresql/${connId}/history/${sampleId}`).then((r) => r.data);

export const pgHistoryRca = (connId, sampleId, resource = 'cpu') =>
  client.get(`/connections/postgresql/${connId}/history/${sampleId}/rca`, { params: { resource } }).then((r) => r.data);
