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

export const getHostInfraDetail = (id) =>
  client.get(`/os-servers/${id}/infra-detail`).then((r) => r.data);

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

// Storage drill-down (file explorer): folders → files → file content.
export const fsList = (serverId, path = '/') =>
  client.get(`/os-servers/${serverId}/fs`, { params: { path } }).then((r) => r.data);
export const fsRead = (serverId, path) =>
  client.get(`/os-servers/${serverId}/fs/file`, { params: { path } }).then((r) => r.data);

// Network configuration + firewall (IP whitelist / blacklist) — via agent (SSH fallback).
export const getNetConfig = (serverId) =>
  client.get(`/os-servers/${serverId}/netconfig`).then((r) => r.data);
export const listFirewall = (serverId) =>
  client.get(`/os-servers/${serverId}/firewall`).then((r) => r.data);
export const addFirewallRule = (serverId, ip, action) =>
  client.post(`/os-servers/${serverId}/firewall`, null, { params: { ip, action } }).then((r) => r.data);
export const deleteFirewallRule = (serverId, handle) =>
  client.delete(`/os-servers/${serverId}/firewall/${handle}`).then((r) => r.data);

// File edit (write) + host actions (list/restart services, reboot) — via agent (SSH fallback).
export const fsWrite = (serverId, path, content) =>
  client.put(`/os-servers/${serverId}/fs/file`, { path, content }).then((r) => r.data);
export const listServices = (serverId) =>
  client.get(`/os-servers/${serverId}/services`).then((r) => r.data);
export const restartService = (serverId, unit, password) =>
  client.post(`/os-servers/${serverId}/restart-service`, { unit, password }).then((r) => r.data);
// start | stop | restart a service (password re-auth enforced server-side).
export const serviceAction = (serverId, unit, action, password) =>
  client.post(`/os-servers/${serverId}/service-action`, { unit, action, password }).then((r) => r.data);
// Force-kill a process by PID (password re-auth enforced server-side).
export const killProcess = (serverId, pid, password) =>
  client.post(`/os-servers/${serverId}/kill-process`, { pid: String(pid), password }).then((r) => r.data);
export const rebootHost = (serverId, password) =>
  client.post(`/os-servers/${serverId}/reboot`, { password }).then((r) => r.data);
// Trigger the Windows agent to self-upgrade to the latest MSI (password re-auth server-side).
export const updateAgent = (serverId, password) =>
  client.post(`/os-servers/${serverId}/update-agent`, { password }).then((r) => r.data);
// Read-only network diagnostics: kind = ping | port | dns.
export const netDiag = (serverId, kind, target, port) =>
  client.get(`/os-servers/${serverId}/net-diag`, { params: { kind, target, port } }).then((r) => r.data);

// Editable network config files + active networking units (for the config editor).
export const getNetFiles = (serverId) =>
  client.get(`/os-servers/${serverId}/net-files`).then((r) => r.data);

// OS Configuration — Windows registry (read + password-gated write) and info commands.
export const regGet = (serverId, key) =>
  client.get(`/os-servers/${serverId}/os-config/registry`, { params: { key } }).then((r) => r.data);
export const regSet = (serverId, key, name, value, password) =>
  client.post(`/os-servers/${serverId}/os-config/registry`, { key, name, value, password }).then((r) => r.data);
export const runCommand = (serverId, key) =>
  client.get(`/os-servers/${serverId}/os-config/command`, { params: { key } }).then((r) => r.data);
