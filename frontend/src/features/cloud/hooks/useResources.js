import {
  keepPreviousData, useMutation, useQuery, useQueryClient,
} from '@tanstack/react-query';
import {
  deleteSavedView, getActionHistory, getAllResources, getAvailableActions,
  getResourceDetail, getResourceFacets,
  getResourceGroups, getResourceReference, getResources,
  previewAction,
  getResourceSummary, listSavedViews, queryResources, saveView,
} from '../api/resources.api';
import { useCloudStore } from '../state/cloudStore';

// While any discovery scan is active, the backend persists resources in batches
// as they are found; poll every 10s so newly-discovered rows appear live. When
// no scan is running the query is not polled (refetchInterval false).
const LIVE_REFETCH_MS = 10_000;

const useIsDiscovering = () => useCloudStore(
  (s) => Object.keys(s.activeDiscoveryJobs).length > 0,
);

/**
 * One page of the inventory.
 *
 * The query key carries the scope, the filters and the paging, so switching
 * from an AWS account to an Azure one — or changing a single facet — is a
 * different cache entry rather than the same entry mutated. That is what stops
 * the table briefly showing the previous account's rows under the new
 * account's totals.
 *
 * `keepPreviousData` holds the current page on screen while the next one
 * loads, which is the difference between a table that updates and a table that
 * blinks white on every keystroke (spec: retain the table during filter
 * changes).
 */
export const useResourceQuery = (scope, filters, options = {}) => {
  const isDiscovering = useIsDiscovering();
  return useQuery({
    queryKey: ['cloudResources', 'query', scope, filters, options],
    queryFn: () => queryResources(scope, filters, options),
    enabled: !!scope,
    placeholderData: keepPreviousData,
    refetchInterval: isDiscovering ? LIVE_REFETCH_MS : false,
  });
};

export const useResourceSummary = (scope, filters) => {
  const isDiscovering = useIsDiscovering();
  return useQuery({
    queryKey: ['cloudResources', 'summary', scope, filters],
    queryFn: () => getResourceSummary(scope, filters),
    enabled: !!scope,
    placeholderData: keepPreviousData,
    refetchInterval: isDiscovering ? LIVE_REFETCH_MS : false,
  });
};

export const useResourceFacets = (scope, filters) => useQuery({
  queryKey: ['cloudResources', 'facets', scope, filters],
  queryFn: () => getResourceFacets(scope, filters),
  enabled: !!scope,
  placeholderData: keepPreviousData,
});

export const useResourceGroups = (scope, groupBy, filters) => useQuery({
  queryKey: ['cloudResources', 'groups', scope, groupBy, filters],
  queryFn: () => getResourceGroups(scope, groupBy, filters),
  enabled: !!scope && !!groupBy,
  placeholderData: keepPreviousData,
});

/** Statuses, categories, risk levels, the type registry, capabilities.
 *  Vocabulary, not data: it only changes when the backend changes, so it is
 *  cached for the session rather than refetched per filter change. */
export const useResourceReference = (scope) => useQuery({
  queryKey: ['cloudResources', 'reference', scope],
  queryFn: () => getResourceReference(scope),
  enabled: !!scope,
  staleTime: 30 * 60_000,
});

/**
 * Resource counts per account and per provider, for the account-listing pages.
 *
 * These pages need integers — "AWS · 227 resources" — and used to get them by
 * downloading every resource in the estate (1,530 rows, 1.7 MB) and calling
 * `.filter().length` on it. The counts now come from the database, keyed by
 * account id rather than name so two accounts sharing a display name cannot
 * collide.
 *
 * `page_size: 1` because no row is wanted at all; only the facets are.
 */
export const useAccountResourceCounts = () => {
  const isDiscovering = useIsDiscovering();
  return useQuery({
    queryKey: ['cloudResources', 'accountCounts'],
    queryFn: () => queryResources('ALL', {}, {
      pageSize: 1, includeSummary: true, includeFacets: true,
    }),
    select: (data) => ({
      total: data?.total ?? null,
      byAccount: Object.fromEntries(
        (data?.facets?.accounts || []).map((f) => [f.value, f.count]),
      ),
      byProvider: Object.fromEntries(
        (data?.facets?.providers || []).map((f) => [String(f.value).toUpperCase(), f.count]),
      ),
    }),
    refetchInterval: isDiscovering ? LIVE_REFETCH_MS : false,
  });
};

// ── Actions ──────────────────────────────────────────────────────────────────
export const useAvailableActions = (provider, enabled = true) => useQuery({
  queryKey: ['cloudResources', 'actions', 'available', provider],
  queryFn: () => getAvailableActions(provider),
  enabled: !!provider && enabled,
  staleTime: 30 * 60_000,
});

/** A preview is a read: it asks what would happen and touches nothing, so it
 *  is a query rather than a mutation and can be cached per resource+action. */
export const useActionPreview = (resourceId, action, enabled = true) => useQuery({
  queryKey: ['cloudResources', 'actions', 'preview', resourceId, action],
  queryFn: () => previewAction(resourceId, action),
  enabled: !!resourceId && !!action && enabled,
  staleTime: 30_000,
  retry: false,
});

export const useActionHistory = (params, enabled = true) => useQuery({
  queryKey: ['cloudResources', 'actions', 'history', params],
  queryFn: () => getActionHistory(params),
  enabled,
  staleTime: 30_000,
});

// ── Saved views ──────────────────────────────────────────────────────────────
export const useSavedViews = (scope) => useQuery({
  queryKey: ['cloudResources', 'views', scope],
  queryFn: () => listSavedViews(scope),
  enabled: !!scope,
});

/** Both mutations invalidate the whole views list rather than patching the
 *  cache: saving by an existing name overwrites that view server-side, so the
 *  list after a save is not always the list plus one. */
export const useSaveView = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: saveView,
    onSuccess: () => client.invalidateQueries({ queryKey: ['cloudResources', 'views'] }),
  });
};

export const useDeleteView = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: deleteSavedView,
    onSuccess: () => client.invalidateQueries({ queryKey: ['cloudResources', 'views'] }),
  });
};

// ── Legacy hooks, unchanged ──────────────────────────────────────────────────
export const useResources = (accountId) => {
  const isDiscovering = useIsDiscovering();
  return useQuery({
    queryKey: ['resources', accountId],
    queryFn: () => (accountId ? getResources(accountId) : Promise.resolve([])),
    enabled: !!accountId,
    refetchInterval: isDiscovering ? LIVE_REFETCH_MS : false,
  });
};

export const useAllResources = () => {
  const isDiscovering = useIsDiscovering();
  return useQuery({
    queryKey: ['allResources'],
    queryFn: () => getAllResources(),
    refetchInterval: isDiscovering ? LIVE_REFETCH_MS : false,
  });
};

export const useResourceDetail = (resourceId) => useQuery({
  queryKey: ['resourceDetail', resourceId],
  queryFn: () => (resourceId ? getResourceDetail(resourceId) : Promise.resolve(null)),
  enabled: !!resourceId,
});
