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

export const getCostReport = async (accountId, days, groupBy = 'service', options = {}) => {
  const {
    region, service, resourceType, costComponent, status,
    minCost, maxCost, dimensions, page, pageSize,
  } = options;
  const { data } = await cloudAxios.get(`/cost/report/${accountId}`, {
    params: {
      days,
      group_by: groupBy,
      region,
      service,
      resource_type: resourceType,
      cost_component: costComponent,
      status,
      min_cost: minCost,
      max_cost: maxCost,
      dimensions,
      page,
      page_size: pageSize,
    },
  });
  return data;
};
