import client from './client';

/**
 * Azure Cosmos DB.
 *
 * Every call here is a control-plane or metadata read, with two deliberate
 * exceptions that cost RU and are therefore never called automatically:
 * `documentCount` (a cross-partition COUNT) and `runQuery`. The backend logs each
 * call it makes, and `activity` reads that log back — which is why the dashboard
 * can show response times, RU charge and error history without Azure Monitor.
 */

const base = (id) => `/connections/cosmosdb/${id}`;

export const listConnections = () =>
  client.get('/connections/cosmosdb/').then((r) => r.data);

export const getConnection = (id) =>
  client.get(base(id)).then((r) => r.data);

export const testConnection = (id) =>
  client.post(`${base(id)}/test`).then((r) => r.data);

export const listDatabases = (id) =>
  client.get(`${base(id)}/databases`).then((r) => r.data);

/** Metadata only — partition key, indexing policy, TTL and the provisioned offer. */
export const listContainers = (id, database) =>
  client.get(`${base(id)}/containers`, { params: { database } }).then((r) => r.data);

/**
 * Storage, estimated document count, autoscale and the full policy set, read from
 * Cosmos's own `x-ms-resource-usage` header on a single container.read().
 */
export const containerDetails = (id, database, container) =>
  client.get(`${base(id)}/container-details`, { params: { database, container } }).then((r) => r.data);

/** Newest and oldest document, via two TOP-1 queries ordered by the indexed `_ts`. */
export const documentStats = (id, database, container) =>
  client.get(`${base(id)}/document-stats`, { params: { database, container } }).then((r) => r.data);

/** Per-database rollup. Capped at 50 containers — the response says when it capped. */
export const databaseSummary = (id, database) =>
  client.get(`${base(id)}/database-summary`, { params: { database } }).then((r) => r.data);

export const browseItems = (id, database, container, opts = {}) =>
  client.get(`${base(id)}/items`, {
    params: {
      database,
      container,
      limit: opts.limit ?? 25,
      continuation_token: opts.continuationToken || undefined,
      sort_recent: Boolean(opts.sortRecent),
      filter_query: opts.filterQuery || undefined,
    },
  }).then((r) => r.data);

/**
 * An exact count. A cross-partition `SELECT VALUE COUNT(1)` touches every physical
 * partition and has a real RU cost, so this must stay behind an explicit click —
 * never on render, never on a refetch interval.
 */
export const documentCount = (id, database, container) =>
  client.get(`${base(id)}/document-count`, { params: { database, container } }).then((r) => r.data);

/** Ad-hoc SQL. Also RU-charged, also explicit-only. */
export const runQuery = (id, database, container, query, limit = 50) =>
  client.post(`${base(id)}/query`, { database, container, query, limit }).then((r) => r.data);

/** Derived from ActMon's own call log — costs nothing against the account. */
export const activity = (id, limit = 200) =>
  client.get(`${base(id)}/activity`, { params: { limit } }).then((r) => r.data);

export const aiAnalysis = (id, database, container) =>
  client.get(`${base(id)}/ai-analysis`, { params: { database, container } }).then((r) => r.data);

export const errorAnalysis = (id, logId) =>
  client.get(`${base(id)}/error-analysis/${logId}`).then((r) => r.data);
