import client from './client';

/** Create a synthetic / external check (website, ping, DNS, TCP, UDP). */
export const createExternalCheck = async (data) => {
  const response = await client.post('/digital-experience/checks', data);
  return response.data;
};

export const getExternalCheck = async (id) => {
  const response = await client.get(`/digital-experience/checks/${id}`);
  return response.data;
};
