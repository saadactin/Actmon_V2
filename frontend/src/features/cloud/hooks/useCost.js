import { useQuery } from '@tanstack/react-query';
import { getCostSummary, getCostAnalytics, getCostReport } from '../api/cost.api';

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
export const useCostReport = (accountId, days, enabled, groupBy = 'service') => useQuery({
  queryKey: ['costReport', accountId, days, groupBy],
  queryFn: () => (accountId ? getCostReport(accountId, days, groupBy) : Promise.resolve(null)),
  enabled: !!accountId && enabled,
  staleTime: 5 * 60_000,
});
