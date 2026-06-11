import client, { ensureArray } from './client';

export const listServers = async () => {
  const response = await client.get('/servers/');
  return ensureArray(response.data);
};

export const createServer = async (data) => {
  const response = await client.post('/servers/', data);
  return response.data;
};

export const getServer = async (id) => {
  const response = await client.get(`/servers/${id}/`);
  return response.data;
};

export const updateServer = async (id, data) => {
  const response = await client.put(`/servers/${id}/`, data);
  return response.data;
};

export const deleteServer = async (id) => {
  await client.delete(`/servers/${id}/`);
};

export default {
  listServers,
  createServer,
  getServer,
  updateServer,
  deleteServer,
};
