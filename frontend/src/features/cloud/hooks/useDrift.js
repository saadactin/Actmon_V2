import { useQuery } from '@tanstack/react-query';
import {
  getDriftChanges,
  getDriftSummary,
  getDriftFacets,
  getInventoryHistory,
  getResourceDrift,
} from '../api/drift.api';

// The change log only moves when a discovery scan lands, so it is far less
// volatile than cost or alert data — a 60s stale time avoids refetching a
// table that cannot have changed in between.
const STALE = 60_000;

export const useDriftChanges = (accountId, days = 30, options = {}) => useQuery({
  queryKey: ['driftChanges', accountId, days, options],
  queryFn: () => getDriftChanges(accountId, days, options),
  enabled: !!accountId,
  staleTime: STALE,
  // Keep the previous page's rows on screen while the next one loads, so
  // paging/filtering does not blank the table out.
  placeholderData: (prev) => prev,
});

export const useDriftSummary = (accountId, days = 30) => useQuery({
  queryKey: ['driftSummary', accountId, days],
  queryFn: () => getDriftSummary(accountId, days),
  enabled: !!accountId,
  staleTime: STALE,
});

export const useDriftFacets = (accountId, days = 30) => useQuery({
  queryKey: ['driftFacets', accountId, days],
  queryFn: () => getDriftFacets(accountId, days),
  enabled: !!accountId,
  staleTime: STALE,
});

// Derived from inventory that only moves on a scan, so it is as stable as the
// change log — same stale time.
export const useInventoryHistory = (accountId, options = {}) => useQuery({
  queryKey: ['inventoryHistory', accountId, options],
  queryFn: () => getInventoryHistory(accountId, options),
  enabled: !!accountId,
  staleTime: STALE,
  placeholderData: (prev) => prev,
});

export const useResourceDrift = (resourceId, limit = 200) => useQuery({
  queryKey: ['resourceDrift', resourceId, limit],
  queryFn: () => getResourceDrift(resourceId, limit),
  enabled: !!resourceId,
  staleTime: STALE,
});
