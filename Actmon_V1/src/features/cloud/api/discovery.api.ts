import { cloudAxios } from './axios';
import { DiscoveryJob } from '../types/cloud';

export const triggerDiscovery = async (accountId: string): Promise<DiscoveryJob> => {
  const { data } = await cloudAxios.post(`/discovery/${accountId}`);
  return data;
};

export const triggerAllDiscovery = async (): Promise<DiscoveryJob[]> => {
  const { data } = await cloudAxios.post(`/discovery/scan-all`);
  return data;
};

export const getDiscoveryStatus = async (jobId: string): Promise<DiscoveryJob> => {
  const { data } = await cloudAxios.get(`/discovery/status/${jobId}`);
  return data;
};
