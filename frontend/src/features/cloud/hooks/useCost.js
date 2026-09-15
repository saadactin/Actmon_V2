import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createBudget, deleteBudget, getAlertPolicies, getBudgetStatus, getBudgets,
  getCostAnalytics, getCostAnomalies, getCostBackfillStatus, getCostCapabilities,
  getCostCoverage, getCostForecast, getCostHistory, getCostQuality, getCostReport,
  getCostAllocation, getCostGovernance, getCostMetrics, getCostSummary,
  getCostTrends, getExecutiveReport, getReportTypes, startCostBackfill, updateBudget,
} from '../api/cost.api';

export const useCostSummary = (accountId) => useQuery({
  queryKey: ['costSummary', accountId],
  queryFn: () => (accountId ? getCostSummary(accountId) : Promise.resolve(null)),
  enabled: !!accountId,
});

export const useCostAnalytics = (accountId) => useQuery({
  queryKey: ['costAnalytics', accountId],
  queryFn: () => (accountId ? getCostAnalytics(accountId) : Promise.resolve(null)),
  enabled: !!accountId,
  staleTime: 30_000,
});

// enabled defaults to false — the report is opt-in (365-day queries against 3
// billing APIs are slow), fetched only once the user opens/expands the panel.
// `options` carries the server-side filters/dimensions/pagination that
// group_by="resource"|"summary" accept (see cost.api.js) — part of the query
// key so a filter change refetches instead of serving a stale cached page.
export const useCostReport = (accountId, days, enabled, groupBy = 'service', options = {}) => useQuery({
  queryKey: ['costReport', accountId, days, groupBy, options],
  queryFn: () => (accountId ? getCostReport(accountId, days, groupBy, options) : Promise.resolve(null)),
  enabled: !!accountId && enabled,
  staleTime: 5 * 60_000,
});

// ── Capability & quality ─────────────────────────────────────────────────────
// Long staleTime: a provider's capabilities are a property of the integration,
// not of the current request, so they cannot change between page views.
export const useCostCapabilities = (accountId) => useQuery({
  queryKey: ['costCapabilities', accountId],
  queryFn: () => (accountId ? getCostCapabilities(accountId) : Promise.resolve(null)),
  enabled: !!accountId,
  staleTime: 30 * 60_000,
});

// Short staleTime and a poll: this is the freshness/health indicator, so it is
// the one thing that must not itself go stale while the user watches it.
export const useCostQuality = (accountId) => useQuery({
  queryKey: ['costQuality', accountId],
  queryFn: () => (accountId ? getCostQuality(accountId) : Promise.resolve(null)),
  enabled: !!accountId,
  staleTime: 15_000,
  refetchInterval: 60_000,
});

// ── History & analytics ──────────────────────────────────────────────────────

export const useCostHistory = (accountId, days = 90, groupBy) => useQuery({
  queryKey: ['costHistory', accountId, days, groupBy],
  queryFn: () => (accountId ? getCostHistory(accountId, days, groupBy) : Promise.resolve(null)),
  enabled: !!accountId,
  staleTime: 5 * 60_000,
});

export const useCostCoverage = (accountId) => useQuery({
  queryKey: ['costCoverage', accountId],
  queryFn: () => (accountId ? getCostCoverage(accountId) : Promise.resolve(null)),
  enabled: !!accountId,
  staleTime: 60_000,
});

export const useCostForecast = (accountId, days = 90) => useQuery({
  queryKey: ['costForecast', accountId, days],
  queryFn: () => (accountId ? getCostForecast(accountId, days) : Promise.resolve(null)),
  enabled: !!accountId,
  staleTime: 5 * 60_000,
});

export const useCostAnomalies = (accountId, days = 90, options = {}) => useQuery({
  queryKey: ['costAnomalies', accountId, days, options],
  queryFn: () => (accountId ? getCostAnomalies(accountId, days, options) : Promise.resolve(null)),
  enabled: !!accountId,
  staleTime: 5 * 60_000,
});

export const useCostTrends = (accountId, days = 30, dimension = 'service') => useQuery({
  queryKey: ['costTrends', accountId, days, dimension],
  queryFn: () => (accountId ? getCostTrends(accountId, days, dimension) : Promise.resolve(null)),
  enabled: !!accountId,
  staleTime: 5 * 60_000,
});

// Polls only while a backfill is actually running, so an idle page does not
// hold open a request every few seconds forever.
export const useCostBackfillStatus = (accountId, enabled = true) => useQuery({
  queryKey: ['costBackfill', accountId],
  queryFn: () => (accountId ? getCostBackfillStatus(accountId) : Promise.resolve(null)),
  enabled: !!accountId && enabled,
  refetchInterval: (query) => (
    query.state.data?.job?.status === 'RUNNING' ? 3_000 : false
  ),
});

export const useStartBackfill = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (days) => startCostBackfill(accountId, days),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['costBackfill', accountId] });
      qc.invalidateQueries({ queryKey: ['costCoverage', accountId] });
    },
  });
};

// ── Budgets ──────────────────────────────────────────────────────────────────

export const useBudgets = (accountId) => useQuery({
  queryKey: ['costBudgets', accountId],
  queryFn: () => getBudgets(accountId),
  staleTime: 60_000,
});

export const useBudgetStatus = (accountId) => useQuery({
  queryKey: ['costBudgetStatus', accountId],
  queryFn: () => getBudgetStatus(accountId),
  staleTime: 60_000,
});

export const useAlertPolicies = () => useQuery({
  queryKey: ['costAlertPolicies'],
  queryFn: getAlertPolicies,
  staleTime: 60_000,
});

/** Budget writes all invalidate both the list and its evaluated status, since
 *  changing an amount or a threshold changes utilisation immediately. */
const budgetKeys = (qc, accountId) => {
  qc.invalidateQueries({ queryKey: ['costBudgets', accountId] });
  qc.invalidateQueries({ queryKey: ['costBudgetStatus', accountId] });
};

export const useCreateBudget = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createBudget,
    onSuccess: () => budgetKeys(qc, accountId),
  });
};

export const useUpdateBudget = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }) => updateBudget(id, payload),
    onSuccess: () => budgetKeys(qc, accountId),
  });
};

export const useDeleteBudget = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteBudget,
    onSuccess: () => budgetKeys(qc, accountId),
  });
};

// ── Allocation, governance & reports ─────────────────────────────────────────

export const useCostAllocation = (accountId, dimension = 'environment') => useQuery({
  queryKey: ['costAllocation', accountId, dimension],
  queryFn: () => (accountId ? getCostAllocation(accountId, dimension) : Promise.resolve(null)),
  enabled: !!accountId,
  staleTime: 5 * 60_000,
});

export const useCostGovernance = (accountId) => useQuery({
  queryKey: ['costGovernance', accountId],
  queryFn: () => (accountId ? getCostGovernance(accountId) : Promise.resolve(null)),
  enabled: !!accountId,
  staleTime: 5 * 60_000,
});

export const useReportTypes = (accountId) => useQuery({
  queryKey: ['costReportTypes', accountId],
  queryFn: () => (accountId ? getReportTypes(accountId) : Promise.resolve(null)),
  enabled: !!accountId,
  staleTime: 30 * 60_000,
});

// Opt-in: the executive report fans out across analytics, trends, forecast and
// anomalies, so it is fetched only when its tab is actually open.
export const useExecutiveReport = (accountId, days, enabled) => useQuery({
  queryKey: ['costExecutiveReport', accountId, days],
  queryFn: () => (accountId ? getExecutiveReport(accountId, days) : Promise.resolve(null)),
  enabled: !!accountId && enabled,
  staleTime: 5 * 60_000,
});

export const useCostMetrics = (enabled = false) => useQuery({
  queryKey: ['costMetrics'],
  queryFn: getCostMetrics,
  enabled,
  refetchInterval: enabled ? 30_000 : false,
});
