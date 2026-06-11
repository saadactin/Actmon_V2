import client, { ensureArray } from './client';
export const listConnections = async (dbType) => {
  // Translate DB type tab titles to matching endpoint paths
  const typePath = dbType.toLowerCase();
  const response = await client.get(`/connections/${typePath}`);
  return ensureArray(response.data);
};

export const createConnection = async (dbType, data) => {
  const typePath = dbType.toLowerCase();
  const response = await client.post(`/connections/${typePath}`, data);
  return response.data;
};

export const deleteConnection = async (dbType, id) => {
  const typePath = dbType.toLowerCase();
  await client.delete(`/connections/${typePath}/${id}`);
};

export const testConnection = async (
  dbType,
  data
) => {
  const typePath = dbType.toLowerCase();
  const response = await client.post(`/connections/test/${typePath}`, data);
  return response.data;
};
