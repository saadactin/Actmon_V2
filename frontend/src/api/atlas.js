import client from './client';

/**
 * MongoDB Atlas. Everything goes through the ActMon backend — the browser never holds the URI, the database
 * password or the API private key, and never talks to Atlas itself. Responses for an unconfigured source come back
 * as `{ available: false, reason, requires }`, which the dashboard renders as an explained empty state.
 */
const base = (id) => `/connections/mongoatlas/${id}`;
const get = (id, path, params) => client.get(`${base(id)}/${path}`, { params }).then((r) => r.data);

export const listAtlasConnections = () => client.get('/connections/mongoatlas/').then((r) => r.data);
export const getAtlasConnection = (id) => client.get(base(id)).then((r) => r.data);
export const testAtlasDraft = (body, existingId) =>
  client.post('/connections/mongoatlas/test', body, { params: existingId ? { existing_id: existingId } : undefined }).then((r) => r.data);
export const createAtlasConnection = (body) => client.post('/connections/mongoatlas/', body).then((r) => r.data);
export const updateAtlasConnection = (id, body) => client.put(base(id), body).then((r) => r.data);
export const deleteAtlasConnection = (id) => client.delete(base(id)).then((r) => r.data);
export const retestAtlasConnection = (id) => client.post(`${base(id)}/test`).then((r) => r.data);

export const atlasOverview = (id) => get(id, 'overview');
export const atlasClusters = (id) => get(id, 'clusters');
export const atlasMeasurements = (id, process, period) => get(id, 'measurements', { process, period });
export const atlasSampled = (id) => get(id, 'sampled');
export const atlasDatabases = (id) => get(id, 'databases');
export const atlasCollections = (id, database) => get(id, 'collections', { database });
export const atlasIndexes = (id, database, collection) => get(id, 'indexes', { database, collection });
export const atlasReplication = (id) => get(id, 'replication');
export const atlasCurrentOps = (id, minSecs = 0) => get(id, 'current-ops', { min_secs: minSecs });
export const atlasSlowQueries = (id, process, hours) => get(id, 'slow-queries', { process, hours });
export const atlasAlerts = (id, status = 'OPEN') => get(id, 'alerts', { status });
export const atlasAckAlert = (id, alertId, hours) => client.post(`${base(id)}/alerts/${alertId}/ack`, { hours }).then((r) => r.data);
export const atlasClusterUsage = (id) => get(id, 'cluster-usage');
export const atlasStorageTrend = (id, process, period) => get(id, 'storage-trend', { process, period });
export const atlasNodes = (id) => get(id, 'nodes');
export const atlasCost = (id) => get(id, 'cost');
export const atlasBackups = (id) => get(id, 'backups');
export const atlasSecurity = (id) => get(id, 'security');

/** FastAPI error detail → readable text (field lists from 422, test results from 400). */
export function atlasErrorText(err) {
  const d = err?.response?.data?.detail;
  if (!d) return err?.message || 'The request failed.';
  if (typeof d === 'string') return d;
  if (Array.isArray(d.errors)) return d.errors.join(' ');
  if (d.results) return Object.values(d.results).filter((r) => !r.ok).map((r) => r.message).join(' ') || d.message;
  if (Array.isArray(d)) return d.map((x) => x.msg).join(' ');
  return d.message || 'The request failed.';
}
