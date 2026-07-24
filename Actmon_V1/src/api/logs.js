import client from './client';

export const getLogStatus   = () => client.get('/logs/status').then((r) => r.data);
export const getLogCatalog  = () => client.get('/logs/catalog').then((r) => r.data);
export const getLogMetrics  = (params) => client.get('/logs/metrics', { params }).then((r) => r.data);
export const getLogSnapshot = (db_type) => client.get('/logs/snapshot', { params: db_type ? { db_type } : {} }).then((r) => r.data);
export const getLogHistory  = (db_type, connection_id, hours = 1) =>
  client.get('/logs/history', { params: { db_type, connection_id, hours } }).then((r) => r.data);
export const getLogSpikes   = (db_type, metric, connection_id, hours = 24) =>
  client.get('/logs/spikes', { params: { db_type, metric, connection_id: connection_id || undefined, hours } }).then((r) => r.data);
export const getLogSql      = (connection_id, hours = 24) =>
  client.get('/logs/sql', { params: { connection_id: connection_id || undefined, hours } }).then((r) => r.data);
export const getLogErrors   = (connection_id, hours = 72, severity) =>
  client.get('/logs/errors', { params: { connection_id: connection_id || undefined, hours, severity: severity || undefined } }).then((r) => r.data);
export const getLogTelemetryTable = (params) => client.get('/logs/telemetry-table', { params }).then((r) => r.data);
