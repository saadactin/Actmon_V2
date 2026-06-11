import client, { ensureArray } from './client';
export const listAgents = async () => {
  const response = await client.get('/agents/');
  return ensureArray(response.data);
};

export const getAgentDashboard = async (
  agentName,
  hours = 6
) => {
  const response = await client.get(`/agents/${agentName}/dashboard`, {
    params: { hours },
  });
  return response.data;
};

export const getAgentMetrics = async (
  agentName,
  hours = 24
) => {
  const response = await client.get(`/agents/${agentName}/metrics`, {
    params: { hours },
  });
  return ensureArray(response.data);
};

export const getAgentSQL = async (
  agentName,
  hours = 6,
  limit = 50
) => {
  const response = await client.get(`/agents/${agentName}/sql`, {
    params: { hours, limit },
  });
  return ensureArray(response.data);
};

export const getWaitEvents = async (
  agentName,
  hours = 6
) => {
  const response = await client.get(`/agents/${agentName}/wait-events`, {
    params: { hours },
  });
  return ensureArray(response.data);
};

export const getOracleSnapshot = async (agentName) => {
  const response = await client.get(`/agents/${agentName}/oracle-snapshot`);
  return response.data;
};

export const getNotifications = async (limit = 50) => {
  const response = await client.get('/agents/notifications/', {
    params: { limit },
  });
  return ensureArray(response.data);
};

export const markNotificationsRead = async (ids) => {
  // Support both passing raw array or { ids } based on FastAPI requirements
  await client.post('/agents/notifications/read', ids);
};

export const exportCSV = (agentName, hours = 24) => {
  // To trigger a browser download for a GET endpoint, we can open a new window or create a link
  // The authorization token is in localStorage, so using a standard window.open might result in 401 if backend checks headers.
  // However, we can fetch it via axios as a blob and download it locally, which is more secure and includes headers.
  client.get(`/agents/${agentName}/export/csv`, {
    params: { hours },
    responseType: 'blob',
  })
  .then((response) => {
    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `${agentName}_metrics_${hours}h.csv`);
    document.body.appendChild(link);
    link.click();
    link.remove();
  })
  .catch((err) => {
    console.error('Error exporting CSV:', err);
    alert('Failed to export CSV: ' + err.message);
  });
};

export const registerAgent = async (payload) => {
  // Best-effort registration endpoint — backend may implement '/agents/register'
  const response = await client.post('/agents/register', payload);
  return response.data;
};
