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

// ── Capability & quality ─────────────────────────────────────────────────────
// These two answer from the capability registry and the in-process cache, so
// they return in milliseconds and never wait on a billing round trip. That is
// what lets the quality badge and the disabled-control tooltips render with the
// page rather than after it.

export const getCostCapabilities = async (accountId) => {
  const { data } = await cloudAxios.get(`/cost/capabilities/${accountId}`);
  return data;
};

export const getCostQuality = async (accountId) => {
  const { data } = await cloudAxios.get(`/cost/quality/${accountId}`);
  return data;
};

// ── Persisted history & analytics ────────────────────────────────────────────

/**
 * Stored billing history.
 *
 * `startDate`/`endDate` (YYYY-MM-DD) override `days` when BOTH are given — the
 * backend rejects a half-supplied pair rather than silently falling back, so a
 * chart can never cover a different period than its label says.
 *
 * `region` narrows to one region, matching only spend the provider actually
 * tagged with one. Unregioned spend is excluded rather than attributed to
 * whichever region happened to be selected.
 */
export const getCostHistory = async (
  accountId, days = 90, groupBy, { startDate, endDate, region } = {},
) => {
  const custom = startDate && endDate;
  const { data } = await cloudAxios.get(`/cost/history/${accountId}`, {
    params: {
      ...(custom ? { start_date: startDate, end_date: endDate } : { days }),
      ...(groupBy ? { group_by: groupBy } : {}),
      ...(region ? { region } : {}),
    },
  });
  return data;
};

export const getCostCoverage = async (accountId) => {
  const { data } = await cloudAxios.get(`/cost/coverage/${accountId}`);
  return data;
};

export const getCostForecast = async (accountId, days = 90) => {
  const { data } = await cloudAxios.get(`/cost/forecast/${accountId}`, {
    params: { days },
  });
  return data;
};

export const getCostAnomalies = async (accountId, days = 90, options = {}) => {
  const { data } = await cloudAxios.get(`/cost/anomalies/${accountId}`, {
    params: {
      days,
      percent_threshold: options.percentThreshold,
      min_absolute: options.minAbsolute,
    },
  });
  return data;
};

export const getCostTrends = async (accountId, days = 30, dimension = 'service') => {
  const { data } = await cloudAxios.get(`/cost/trends/${accountId}`, {
    params: { days, dimension },
  });
  return data;
};

export const startCostBackfill = async (accountId, days = 90) => {
  const { data } = await cloudAxios.post(`/cost/backfill/${accountId}`, null, {
    params: { days },
  });
  return data;
};

export const getCostBackfillStatus = async (accountId) => {
  const { data } = await cloudAxios.get(`/cost/backfill/status/${accountId}`);
  return data;
};

// ── Budgets & alert policies ─────────────────────────────────────────────────

export const getBudgets = async (accountId) => {
  const { data } = await cloudAxios.get('/cost/budgets', {
    params: { account_id: accountId },
  });
  return data;
};

export const getBudgetStatus = async (accountId) => {
  const { data } = await cloudAxios.get('/cost/budgets/status', {
    params: { account_id: accountId },
  });
  return data;
};

export const createBudget = async (payload) => {
  const { data } = await cloudAxios.post('/cost/budgets', payload);
  return data;
};

export const updateBudget = async (budgetId, payload) => {
  const { data } = await cloudAxios.put(`/cost/budgets/${budgetId}`, payload);
  return data;
};

export const deleteBudget = async (budgetId) => {
  await cloudAxios.delete(`/cost/budgets/${budgetId}`);
};

export const getAlertPolicies = async () => {
  const { data } = await cloudAxios.get('/cost/alert-policies');
  return data;
};

// ── Allocation, governance & reports ─────────────────────────────────────────

export const getCostAllocation = async (accountId, dimension = 'environment') => {
  const { data } = await cloudAxios.get(`/cost/allocation/${accountId}`, {
    params: { dimension },
  });
  return data;
};

export const getCostGovernance = async (accountId) => {
  const { data } = await cloudAxios.get(`/cost/governance/${accountId}`);
  return data;
};

export const getReportTypes = async (accountId) => {
  const { data } = await cloudAxios.get(`/cost/reports/${accountId}`);
  return data;
};

export const getExecutiveReport = async (accountId, days = 30) => {
  const { data } = await cloudAxios.get(`/cost/reports/executive/${accountId}`, {
    params: { days },
  });
  return data;
};

export const getCostMetrics = async () => {
  const { data } = await cloudAxios.get('/cost/metrics');
  return data;
};

export const setRecommendationState = async (fingerprint, payload) => {
  const { data } = await cloudAxios.post(
    `/cost/recommendations/${fingerprint}/state`, payload,
  );
  return data;
};

/** The Cost tab's own refresh: re-query billing and re-ingest the last 30
 *  days. Synchronous — the result says what was written or why the provider
 *  refused. A 409 means a refresh or scan is already doing it. */
export const refreshCost = async (accountId) => {
  const { data } = await cloudAxios.post(`/cost/refresh/${accountId}`, null, {
    // Billing APIs take 30-50s per call and Azure is serialised; the default
    // timeout would report a failure for a refresh that is still running.
    timeout: 300_000,
  });
  return data;
};
