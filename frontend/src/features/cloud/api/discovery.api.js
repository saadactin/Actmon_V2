import { cloudAxios } from './axios';

export const triggerDiscovery = async (accountId) => {
  const { data } = await cloudAxios.post(`/discovery/${accountId}`);
  return data;
};

export const triggerAllDiscovery = async () => {
  const { data } = await cloudAxios.post('/discovery/scan-all');
  return data;
};

export const getDiscoveryStatus = async (jobId) => {
  const { data } = await cloudAxios.get(`/discovery/status/${jobId}`);
  return data;
};
