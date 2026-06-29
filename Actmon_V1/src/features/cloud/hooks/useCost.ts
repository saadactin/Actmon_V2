import { useQuery } from '@tanstack/react-query';
import { getCostSummary, getCostAnalytics } from '../api/cost.api';
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

