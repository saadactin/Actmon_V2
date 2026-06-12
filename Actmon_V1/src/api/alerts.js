import client, { ensureArray } from './client';
export const getConfig = async () => {
  const response = await client.get('/alerts/config');
  return response.data;
};

export const upsertConfig = async (
  data
) => {
  const response = await client.put('/alerts/config', data);
  return response.data;
};

export const listRecipients = async () => {
  const response = await client.get('/alerts/recipients');
  return ensureArray(response.data);
};

export const addRecipient = async (email) => {
  const response = await client.post('/alerts/recipients', { email });
  return response.data;
};

export const deleteRecipient = async (id) => {
  await client.delete(`/alerts/recipients/${id}`);
};

export const getAgentScope = async (agentName) => {
  const response = await client.get(`/alerts/agents/${agentName}/scope`);
  return response.data;
};

export const updateAgentScope = async (
  agentName,
  data
) => {
  const response = await client.put(`/alerts/agents/${agentName}/scope`, data);
  return response.data;
};

export const sendTestEmail = async (email) => {
  await client.post('/alerts/test-email', { email });
};
