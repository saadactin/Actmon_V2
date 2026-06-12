import client, { ensureArray } from './client';
export const getPredictions = async (
  agentName,
  metric,
  horizon
) => {
  const response = await client.get(`/ml/${agentName}/predictions`, {
    params: { metric, horizon },
  });
  return ensureArray(response.data);
};

export const getRCA = async (agentName, limit = 10) => {
  const response = await client.get(`/ml/${agentName}/rca`, {
    params: { limit },
  });
  return ensureArray(response.data);
};

export const getRiskTrend = async (
  agentName,
  hours = 48
) => {
  const response = await client.get(`/ml/${agentName}/risk-trend`, {
    params: { hours },
  });
  return ensureArray(response.data);
};
