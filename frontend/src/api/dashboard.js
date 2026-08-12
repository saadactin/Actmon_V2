import client, { ensureArray } from './client';

/**
 * The four feeds the dashboard reads. Endpoints match the existing backend
 * exactly — nothing new is required server-side.
 */

/** GET /os-servers/summary → { total, connected, warning, disconnected } */
export const getServerSummary = () =>
  client.get('/os-servers/summary').then((r) => r.data || {});

/** GET /os-servers/ → hosts with status + cpu/ram/disk + database_services[] */
export const listOsServers = () =>
  client.get('/os-servers/').then((r) => ensureArray(r.data));

/** GET /agents/ → registered collectors with their heartbeat status */
export const listAgents = () =>
  client.get('/agents/').then((r) => ensureArray(r.data));

/** GET /alerts/active → currently firing alerts */
export const listActiveAlerts = () =>
  client.get('/alerts/active').then((r) => ensureArray(r.data));

/** GET /cloud/accounts → connected cloud accounts (separate microservice on :8001) */
export const listCloudAccounts = () =>
  client.get('/cloud/accounts').then((r) => ensureArray(r.data));
