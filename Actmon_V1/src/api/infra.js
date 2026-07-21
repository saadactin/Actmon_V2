import client, { ensureArray } from './client';
export const listInstances = async () => {
  const response = await client.get('/infra/instances');
  return ensureArray(response.data);
};

export const registerInstance = async (
  data
) => {
  const response = await client.post('/infra/instances', data);
  return response.data;
};

export const getInfraDetail = async (id) => {
  const response = await client.get(`/infra/instances/${id}`);
  return response.data;
};
