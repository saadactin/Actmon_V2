import client from './client';

// ============================================================
// MEMORY (Memory Analysis / Memory Pressure) — ClickHouse-backed history.
// All org-scoped server-side: another organisation's host is a 404.
// Timestamps are epoch milliseconds (UTC instants).
// ============================================================

export const getMemoryHistory = (id, { minutes, bucket }) =>
  client.get(`/memory/${id}/history`, { params: { minutes, bucket } }).then((r) => r.data);

/** Stored collection nearest `at` (epoch ms) within the server's tolerance; empty when none — never the live list. */
export const getMemorySnapshot = (id, at) =>
  client.get(`/memory/${id}/snapshot`, { params: { at: Math.round(at) } }).then((r) => r.data);

export const getProcessMemoryHistory = (id, { pid, name, start, minutes, bucket }) =>
  client.get(`/memory/${id}/process-history`, { params: { pid, name, start: start || undefined, minutes, bucket } }).then((r) => r.data);

export const getTopProcessTimeline = (id, { minutes, bucket, n = 5 }) =>
  client.get(`/memory/${id}/top-processes`, { params: { minutes, bucket, n } }).then((r) => r.data);

export const getMemoryAnalysis = (id, { minutes, bucket, threshold }) =>
  client.get(`/memory/${id}/analysis`, { params: { minutes, bucket, threshold } }).then((r) => r.data);

// ============================================================
// DISK (Disk Consumption) — ClickHouse host_fs_usage
// ============================================================
export const getDiskHistory = (id, { minutes, bucket }) =>
  client.get(`/disk/${id}/history`, { params: { minutes, bucket } }).then((r) => r.data);

export const getDiskMountHistory = (id, { mount, minutes, bucket }) =>
  client.get(`/disk/${id}/mount-history`, { params: { mount, minutes, bucket } }).then((r) => r.data);

export const getNetworkHistory = (id, { minutes, bucket }) =>
  client.get(`/disk/${id}/network-history`, { params: { minutes, bucket } }).then((r) => r.data);

/** Fleet-wide average CPU / memory / disk over time (each host averaged first). serverId narrows to one host. */
export const getFleetHistory = ({ minutes = 60, bucket = 60, serverId } = {}) =>
  client.get('/infra-fleet/history', { params: { minutes, bucket, server_id: serverId } }).then((r) => r.data);
