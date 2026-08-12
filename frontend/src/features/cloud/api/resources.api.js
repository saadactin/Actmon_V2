import { cloudAxios } from './axios';

export const getResources = async (accountId) => {
  const { data } = await cloudAxios.get(`/resources/${accountId}`);
  return data;
};

export const getAllResources = async () => {
  const { data } = await cloudAxios.get('/resources');
  return data;
};

export const getResourceDetail = async (resourceId) => {
  const { data } = await cloudAxios.get(`/resources/detail/${resourceId}`);
  return data;
};

export const getResourceMetrics = async (resourceId) => {
  const { data } = await cloudAxios.get(`/resources/detail/${resourceId}/metrics`);
  return data;
};
