import client from './client';

export const cosmosApi = {
  listDatabases: (id) =>
    client.get(`/connections/cosmosdb/${id}/databases`).then((r) => r.data),

  listContainers: (id, database) =>
    client.get(`/connections/cosmosdb/${id}/containers`, { params: { database } }).then((r) => r.data),

  browseItems: (id, database, container, { limit = 25, continuation_token, sort_recent, filter_query } = {}) =>
    client.get(`/connections/cosmosdb/${id}/items`, {
      params: {
        database, container, limit,
        continuation_token: continuation_token || undefined,
        sort_recent: !!sort_recent,
        filter_query: filter_query || undefined,
      },
    }).then((r) => r.data),

  testSaved: (id) =>
    client.post(`/connections/cosmosdb/${id}/test`).then((r) => r.data),

  runQuery: (id, database, container, query, limit = 50) =>
    client.post(`/connections/cosmosdb/${id}/query`, { database, container, query, limit }).then((r) => r.data),

  documentCount: (id, database, container) =>
    client.get(`/connections/cosmosdb/${id}/document-count`, { params: { database, container } }).then((r) => r.data),

  activity: (id, limit = 200) =>
    client.get(`/connections/cosmosdb/${id}/activity`, { params: { limit } }).then((r) => r.data),

  containerDetails: (id, database, container) =>
    client.get(`/connections/cosmosdb/${id}/container-details`, { params: { database, container } }).then((r) => r.data),

  documentStats: (id, database, container) =>
    client.get(`/connections/cosmosdb/${id}/document-stats`, { params: { database, container } }).then((r) => r.data),

  databaseSummary: (id, database) =>
    client.get(`/connections/cosmosdb/${id}/database-summary`, { params: { database } }).then((r) => r.data),

  aiAnalysis: (id, database, container) =>
    client.get(`/connections/cosmosdb/${id}/ai-analysis`, { params: { database, container } }).then((r) => r.data),

  errorAnalysis: (id, logId) =>
    client.get(`/connections/cosmosdb/${id}/error-analysis/${logId}`).then((r) => r.data),
};
