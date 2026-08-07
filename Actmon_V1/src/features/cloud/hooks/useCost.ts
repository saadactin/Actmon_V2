import { useQuery } from '@tanstack/react-query';
import { getCostSummary, getCostAnalytics, getCostReport } from '../api/cost.api';
import { CostSummary } from '../types/cloud';

export const useCostSummary = (accountId: string | null) => {
  return useQuery<CostSummary | null>({
    queryKey: ['costSummary', accountId],
    queryFn: () => (accountId ? getCostSummary(accountId) : Promise.resolve(null)),
    enabled: !!accountId,
  });
};

export const useCostAnalytics = (accountId: string | null) => {
  return useQuery<any>({
    queryKey: ['costAnalytics', accountId],
    queryFn: () => (accountId ? getCostAnalytics(accountId) : Promise.resolve(null)),
    enabled: !!accountId,
    staleTime: 30_000,
  });
};

// enabled defaults to false — the report is opt-in (365-day queries against 3
// billing APIs are slow), fetched only once the user opens/expands the panel.
export const useCostReport = (accountId: string | null, days: number, enabled: boolean) => {
  return useQuery<any>({
    queryKey: ['costReport', accountId, days],
    queryFn: () => (accountId ? getCostReport(accountId, days) : Promise.resolve(null)),
    enabled: !!accountId && enabled,
    staleTime: 5 * 60_000,
  });
};

