import { useQuery } from '@tanstack/react-query';
import {
  getChangeSummary, getCostSeries, getCostTotal, getLatestDiscovery,
  getOverviewInventory, getRecentChanges, getRecentEvents, getRecentResources,
  getSecurityPostureCanonical, getTopCostResources, getTopologySummary,
} from '../api/overview.api';
import { useCloudStore } from '../state/cloudStore';

/**
 * Overview data hooks.
 *
 * Each widget gets its own query on purpose. The Overview reads seven different
 * subsystems, and some of them talk to provider APIs that rate-limit, time out
 * or lack permission — so a shared query would mean one throttled billing call
 * blanking the inventory, the posture and the scan status along with the cost
 * card. Separate queries let each widget fail, retry and refresh alone.
 *
 * Every key carries the account id, so switching accounts is a cache miss
 * rather than the previous account's numbers under a new heading.
 */

// Inventory is database-backed and cheap; posture and spend are expensive and
// change slowly. Their stale times differ accordingly rather than all sharing
// one arbitrary number.
const INVENTORY_STALE = 30_000;
const SLOW_STALE = 5 * 60_000;

// Provider-backed calls are not retried hard: a 403 from Cost Management will
// still be a 403 on the third attempt, and the widget's job is to say so.
const PROVIDER_QUERY = { retry: 1, staleTime: SLOW_STALE };

const useIsDiscovering = (accountId) => useCloudStore(
  (s) => !!s.activeDiscoveryJobs[accountId],
);

/** Totals, facets and coverage for one account, in one request.
 *  `region` is part of the key: narrowing the scope is a different question,
 *  not the same answer filtered. */
export const useOverviewInventory = (accountId, region = null) => {
  const discovering = useIsDiscovering(accountId);
  return useQuery({
    queryKey: ['cloudOverview', 'inventory', accountId, region],
    queryFn: () => getOverviewInventory(accountId, region),
    enabled: !!accountId,
    staleTime: INVENTORY_STALE,
    // Only the inventory follows a running scan — that is the thing a scan
    // actually changes. Polling posture or billing on the same timer would
    // hammer provider APIs for data that cannot have moved.
    refetchInterval: discovering ? 10_000 : false,
  });
};

export const useRecentResources = (accountId, limit = 6) => useQuery({
  queryKey: ['cloudOverview', 'recentResources', accountId, limit],
  queryFn: () => getRecentResources(accountId, limit),
  enabled: !!accountId,
  staleTime: INVENTORY_STALE,
});

export const useTopCostResources = (accountId, limit = 5) => useQuery({
  queryKey: ['cloudOverview', 'topCost', accountId, limit],
  queryFn: () => getTopCostResources(accountId, limit),
  enabled: !!accountId,
  staleTime: SLOW_STALE,
});

/** The canonical posture — the Security Center's own endpoint. */
export const useSecurityPosture = (accountId) => useQuery({
  queryKey: ['cloudOverview', 'posture', accountId],
  queryFn: () => getSecurityPostureCanonical(accountId),
  enabled: !!accountId,
  ...PROVIDER_QUERY,
});

export const useCostTotal = (accountId) => useQuery({
  queryKey: ['cloudOverview', 'costTotal', accountId],
  queryFn: () => getCostTotal(accountId),
  enabled: !!accountId,
  ...PROVIDER_QUERY,
});

export const useCostSeries = (accountId, days = 30) => useQuery({
  queryKey: ['cloudOverview', 'costSeries', accountId, days],
  queryFn: () => getCostSeries(accountId, days),
  enabled: !!accountId,
  ...PROVIDER_QUERY,
});

export const useChangeSummary = (accountId, days = 30) => useQuery({
  queryKey: ['cloudOverview', 'changes', accountId, days],
  queryFn: () => getChangeSummary(accountId, days),
  enabled: !!accountId,
  staleTime: SLOW_STALE,
});

export const useRecentChanges = (accountId, limit = 5) => useQuery({
  queryKey: ['cloudOverview', 'recentChanges', accountId, limit],
  queryFn: () => getRecentChanges(accountId, limit),
  enabled: !!accountId,
  staleTime: SLOW_STALE,
});

export const useRecentEvents = (accountId, range = '7d') => useQuery({
  queryKey: ['cloudOverview', 'events', accountId, range],
  queryFn: () => getRecentEvents(accountId, range),
  enabled: !!accountId,
  staleTime: SLOW_STALE,
});

export const useTopologySummary = (accountId) => useQuery({
  queryKey: ['cloudOverview', 'topology', accountId],
  queryFn: () => getTopologySummary(accountId),
  enabled: !!accountId,
  staleTime: SLOW_STALE,
});

/** Scan state. Polls while a scan is running so the panel tracks it live. */
export const useLatestDiscovery = (accountId) => {
  const discovering = useIsDiscovering(accountId);
  return useQuery({
    queryKey: ['cloudOverview', 'discovery', accountId],
    queryFn: () => getLatestDiscovery(accountId),
    enabled: !!accountId,
    staleTime: INVENTORY_STALE,
    refetchInterval: discovering ? 10_000 : false,
  });
};
