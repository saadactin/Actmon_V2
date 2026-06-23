import client from './client';

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
