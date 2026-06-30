import { cloudAxios } from './axios';
import { CloudResource, CloudResourceDetail } from '../types/resource';

export const getResources = async (accountId: string): Promise<CloudResource[]> => {
  const { data } = await cloudAxios.get(`/resources/${accountId}`);
  return data;
};

export const getAllResources = async (): Promise<CloudResource[]> => {
  const { data } = await cloudAxios.get('/resources');
  return data;
};

export const getResourceDetail = async (resourceId: string): Promise<CloudResourceDetail> => {
  const { data } = await cloudAxios.get(`/resources/detail/${resourceId}`);
  return data;
};

export const getResourceMetrics = async (resourceId: string): Promise<any> => {
  const { data } = await cloudAxios.get(`/resources/detail/${resourceId}/metrics`);
  return data;
};


