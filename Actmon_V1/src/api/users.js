import client, { ensureArray } from './client';
export const listUsers = async () => {
  const response = await client.get('/users/');
  return ensureArray(response.data);
};

export const createUser = async (data) => {
  const response = await client.post('/users/', data);
  return response.data;
};

export const deleteUser = async (id) => {
  await client.delete(`/users/${id}`);
};

export const updateRole = async (id, role) => {
  const response = await client.put(`/users/${id}/role`, { role });
  return response.data;
};

export const setInstanceAccess = async (id, agentNames) => {
  await client.put(`/users/${id}/instance-access`, { agent_names: agentNames });
};

export const setCloudAccess = async (id, cloudAccountIds) => {
  await client.put(`/users/${id}/cloud-access`, { cloud_account_ids: cloudAccountIds });
};

export const setFeatureAccess = async (
  id,
  toggles
) => {
  await client.put(`/users/${id}/feature-access`, toggles);
};
