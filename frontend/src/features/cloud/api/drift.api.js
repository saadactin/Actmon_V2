import { cloudAxios } from './axios';

/**
 * Configuration-drift (change history) endpoints.
 *
 * Every param is optional — axios drops `undefined` keys, so a caller that
 * only knows the account and window sends exactly those two.
 */
export const getDriftChanges = async (accountId, days = 30, options = {}) => {
  const { data } = await cloudAxios.get('/drift', {
    params: {
      account_id: accountId || undefined,
      days,
      change_type: options.changeType || undefined,
      impact: options.impact || undefined,
      severity: options.severity || undefined,
      resource_type: options.resourceType || undefined,
      provider_resource_id: options.providerResourceId || undefined,
      direction: options.direction || undefined,
      search: options.search || undefined,
      page: options.page || undefined,
      page_size: options.pageSize || undefined,
    },
  });
  return data;
};

export const getDriftSummary = async (accountId, days = 30) => {
  const { data } = await cloudAxios.get('/drift/summary', {
    params: { account_id: accountId || undefined, days },
  });
  return data;
};

export const getDriftFacets = async (accountId, days = 30) => {
  const { data } = await cloudAxios.get('/drift/facets', {
    params: { account_id: accountId || undefined, days },
  });
  return data;
};

/**
 * When each resource was created, from the provider's own timestamp, plus when
 * this system first saw it. Reaches back before drift capture existed.
 */
export const getInventoryHistory = async (accountId, options = {}) => {
  const { data } = await cloudAxios.get('/drift/history', {
    params: {
      account_id: accountId || undefined,
      resource_type: options.resourceType || undefined,
      search: options.search || undefined,
      sort: options.sort || undefined,
      page: options.page || undefined,
      page_size: options.pageSize || undefined,
    },
  });
  return data;
};

/** One resource's full history plus its current state and active alerts. */
export const getResourceDrift = async (resourceId, limit = 200) => {
  const { data } = await cloudAxios.get(`/drift/resource/${resourceId}`, {
    params: { limit },
  });
  return data;
};
