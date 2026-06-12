import client from './client';

// ============================================================
// OS SERVERS
// ============================================================

export const getServerSummary = () =>
  client.get('/os-servers/summary').then((r) => r.data);

export const listOsServers = (params = {}) =>
  client.get('/os-servers/', { params }).then((r) => r.data);

export const getOsServer = (id) =>
  client.get(`/os-servers/${id}`).then((r) => r.data);

export const createOsServer = (data) =>
  client.post('/os-servers/', data).then((r) => r.data);

export const updateOsServer = (id, data) =>
  client.put(`/os-servers/${id}`, data).then((r) => r.data);

export const deleteOsServer = (id) =>
  client.delete(`/os-servers/${id}`).then((r) => r.data);

export const testSshConnection = (data) =>
  client.post('/os-servers/test-ssh', data).then((r) => r.data);

export const refreshServerStatus = (id) =>
  client.post(`/os-servers/${id}/refresh`).then((r) => r.data);

export const getLiveStatus = () =>
  client.get('/os-servers/live-status').then((r) => r.data);

export const linkDbInstance = (serverId, instanceId, connectionId) =>
  client
    .post(`/os-servers/${serverId}/instances/${instanceId}/link`, null, {
      params: { connection_id: connectionId },
    })
    .then((r) => r.data);

// ============================================================
// TERMINAL
// ============================================================

export const executeCommand = (serverId, command) =>
  client
    .post('/terminal/execute', { server_id: serverId, command })
    .then((r) => r.data);
