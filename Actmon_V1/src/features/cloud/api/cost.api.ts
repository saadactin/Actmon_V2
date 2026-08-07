import { cloudAxios } from './axios';
import { CostSummary } from '../types/cloud';

export const getCostSummary = async (accountId: string): Promise<CostSummary> => {
  const { data } = await cloudAxios.get(`/cost/${accountId}`);
  return data;
};

export const getCostEstimate = async (accountId: string): Promise<any> => {
  const { data } = await cloudAxios.get(`/cost-estimate/${accountId}`);
  return data;
};

export const getCostAnalytics = async (accountId: string): Promise<any> => {
  const { data } = await cloudAxios.get(`/cost/analytics/${accountId}`);
  return data;
};

export const getCostReport = async (accountId: string, days: number): Promise<any> => {
  const { data } = await cloudAxios.get(`/cost/report/${accountId}`, { params: { days } });
  return data;
};


