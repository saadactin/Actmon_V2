import client from './client';

// GET /api/v1/cost-analytics/account/{account_id}/summary
export const getCostSummary = async (accountId) => {
  const response = await client.get(`/cost-analytics/account/${accountId}/summary`);
  return response.data;
};

// GET /api/v1/cost-analytics/account/{account_id}/trends
export const getCostTrends = async (accountId, days = 30) => {
  const response = await client.get(`/cost-analytics/account/${accountId}/trends`, {
    params: { days }
  });
  return response.data;
};
