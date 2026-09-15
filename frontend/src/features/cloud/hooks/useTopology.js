import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/topology.api';

/**
 * Topology queries.
 *
 * `staleTime` is 30s, as before. The backend serves a graph it can prove is
 * current — it compares the inventory's high-water marks rather than expiring
 * on a timer — so a short client-side stale window costs one cheap request and
 * never shows a stale graph. What the client cannot know on its own is when a
 * discovery scan landed, which is why the window is short rather than absent.
 */
const STALE = 30_000;

/** The full graph for a scope, with the current view/filter options. */
export const useTopology = (scope, options) => useQuery({
  // The options are part of the key because filtering happens server-side; two
  // different filter sets are two different resources, not one being refetched.
  queryKey: ['topology', scope, api.toParams(options)],
  queryFn: () => api.getTopology(scope, options),
  enabled: !!scope,
  staleTime: STALE,
  // Keep the previous graph on screen while a new filter loads, so changing a
  // dropdown does not blank the canvas and lose the user's place.
  placeholderData: (previous) => previous,
});

export const useGlobalView = (enabled = true) => useQuery({
  queryKey: ['topology', 'global'],
  queryFn: api.getGlobalView,
  enabled,
  staleTime: STALE,
});

/** The relationship vocabulary. Effectively static — it changes when the
    service is redeployed, not while a page is open. */
export const useRelationshipCatalog = () => useQuery({
  queryKey: ['topology', 'relationships'],
  queryFn: api.getRelationshipCatalog,
  staleTime: 60 * 60_000,
});

export const useResourceTopology = (scope, resourceId, options = {}) => useQuery({
  queryKey: ['topology', scope, 'resource', resourceId, options.hops ?? 2, options.view || null, !!options.includeRaw],
  queryFn: () => api.getResourceTopology(scope, resourceId, options),
  enabled: !!scope && !!resourceId,
  staleTime: STALE,
});

export const useNeighbors = (scope, resourceId, options = {}) => useQuery({
  queryKey: ['topology', scope, 'neighbors', resourceId, options.hops ?? 1, options.view || null],
  queryFn: () => api.getNeighbors(scope, resourceId, options),
  enabled: !!scope && !!resourceId,
  staleTime: STALE,
});

export const usePath = (scope, source, target, options = {}) => useQuery({
  queryKey: ['topology', scope, 'path', source, target, options.maxDepth ?? 6, options.view || null],
  queryFn: () => api.getPath(scope, { source, target, ...options }),
  enabled: !!scope && !!source && !!target,
  staleTime: STALE,
});

export const useImpact = (scope, resourceId, options = {}) => useQuery({
  queryKey: ['topology', scope, 'impact', resourceId, options.maxDepth ?? 4],
  queryFn: () => api.getImpact(scope, resourceId, options),
  enabled: !!scope && !!resourceId,
  staleTime: STALE,
});

export const useEdgeDetail = (scope, edgeId) => useQuery({
  queryKey: ['topology', scope, 'edge', edgeId],
  queryFn: () => api.getEdge(scope, edgeId),
  enabled: !!scope && !!edgeId,
  staleTime: STALE,
});

export const useCoverage = (scope, enabled = true) => useQuery({
  queryKey: ['topology', scope, 'coverage'],
  queryFn: () => api.getCoverage(scope),
  enabled: !!scope && enabled,
  staleTime: STALE,
});

export const useUnresolved = (scope, enabled = true) => useQuery({
  queryKey: ['topology', scope, 'unresolved'],
  queryFn: () => api.getUnresolved(scope),
  enabled: !!scope && enabled,
  staleTime: STALE,
});

export const useIsolated = (scope, enabled = true) => useQuery({
  queryKey: ['topology', scope, 'isolated'],
  queryFn: () => api.getIsolated(scope),
  enabled: !!scope && enabled,
  staleTime: STALE,
});

export const useDiagnostics = (scope, enabled = true) => useQuery({
  queryKey: ['topology', scope, 'diagnostics'],
  queryFn: () => api.getDiagnostics(scope),
  enabled: !!scope && enabled,
  staleTime: STALE,
});

export const useTopologySearch = (scope, query, enabled = true) => useQuery({
  queryKey: ['topology', scope, 'search', query],
  queryFn: () => api.searchTopology(scope, query),
  enabled: !!scope && !!query && query.length >= 2 && enabled,
  staleTime: STALE,
});

export const useSnapshots = (scope, enabled = true) => useQuery({
  queryKey: ['topology', 'snapshots', scope || 'all'],
  queryFn: () => api.listSnapshots({ scope }),
  enabled,
  staleTime: STALE,
});

export const useSnapshotDiff = (snapshotId, against, enabled = true) => useQuery({
  queryKey: ['topology', 'snapshots', snapshotId, 'diff', against || 'current'],
  queryFn: () => api.diffSnapshot(snapshotId, { against }),
  enabled: !!snapshotId && enabled,
  // A diff against "current" is a fresh comparison every time it is asked for;
  // caching it would show a diff computed before the last scan.
  staleTime: 0,
});

export const useTakeSnapshot = (scope) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.takeSnapshot(scope, body || {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['topology', 'snapshots'] }),
  });
};

export const useDeleteSnapshot = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (snapshotId) => api.deleteSnapshot(snapshotId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['topology', 'snapshots'] }),
  });
};

export const useExportTopology = (scope) => useMutation({
  mutationFn: (options) => api.exportTopology(scope, options),
});

/** Force the server to rebuild, then refetch everything for this scope. */
export const useRefreshTopology = (scope) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (options) => api.getTopology(scope, { ...(options || {}), refresh: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['topology', scope] }),
  });
};
