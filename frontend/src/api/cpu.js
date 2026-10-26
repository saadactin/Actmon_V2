import client from './client';

// ============================================================
// CPU Performance history — ClickHouse host_cpu_metrics / host_process_cpu. Org-scoped server-side.
// Timestamps are epoch milliseconds (UTC instants).
// ============================================================

/** CPU time split (user / system / iowait / irq / steal / idle %) per bucket. */
export const getCpuCategories = (id, { minutes, bucket }) =>
  client.get(`/cpu/${id}/categories`, { params: { minutes, bucket } }).then((r) => r.data);

/** The stored top-CPU process set nearest `at` (epoch ms); `{ ts: null, processes: [] }` when none was stored. */
export const getCpuProcessesAt = (id, at) =>
  client.get(`/cpu/${id}/processes`, { params: { at: Math.round(at) } }).then((r) => r.data);

/** One process's CPU / memory over time — only the collections where it was in the top 15. */
export const getCpuProcessTrend = (id, { pid, minutes, bucket }) =>
  client.get(`/cpu/${id}/process-trend`, { params: { pid, minutes, bucket } }).then((r) => r.data);

/** Live, read-only details for one process (parent PID, executable, command line, cwd, CPU time, context switches,
    open files). The full command line and file list come back only for users with Infrastructure "execute". */
export const getCpuProcessDetail = (id, pid) =>
  client.get(`/cpu/${id}/process-detail`, { params: { pid } }).then((r) => r.data);
