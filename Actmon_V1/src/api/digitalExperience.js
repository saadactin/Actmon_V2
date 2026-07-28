import client, { ensureArray } from './client';

export const listExternalChecks = async () => {
  const response = await client.get('/digital-experience/checks');
  return ensureArray(response.data);
};

export const createExternalCheck = async (data) => {
  const response = await client.post('/digital-experience/checks', data);
  return response.data;
};

export const getExternalCheck = async (id) => {
  const response = await client.get(`/digital-experience/checks/${id}`);
  return response.data;
};

export const getExternalCheckResults = async (id, hours = 24) => {
  const response = await client.get(`/digital-experience/checks/${id}/results`, { params: { hours } });
  return response.data;
};

export const updateExternalCheck = async (id, data) => {
  const response = await client.patch(`/digital-experience/checks/${id}`, data);
  return response.data;
};

export const deleteExternalCheck = async (id) => {
  await client.delete(`/digital-experience/checks/${id}`);
};

export const testExternalCheck = async (id) => {
  const response = await client.post(`/digital-experience/checks/${id}/test`);
  return response.data;
};
