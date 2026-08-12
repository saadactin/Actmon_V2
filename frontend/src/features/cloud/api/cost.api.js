import { cloudAxios } from './axios';

export const getCostSummary = async (accountId) => {
  const { data } = await cloudAxios.get(`/cost/${accountId}`);
  return data;
};

export const getCostEstimate = async (accountId) => {
  const { data } = await cloudAxios.get(`/cost-estimate/${accountId}`);
  return data;
};

export const getCostAnalytics = async (accountId) => {
  const { data } = await cloudAxios.get(`/cost/analytics/${accountId}`);
  return data;
};

export const getCostReport = async (accountId, days, groupBy = 'service') => {
  const { data } = await cloudAxios.get(`/cost/report/${accountId}`, {
    params: { days, group_by: groupBy },
  });
  return data;
};
