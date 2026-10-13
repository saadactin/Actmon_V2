import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/identity.api';

/**
 * Identity & Access (CIEM) data hooks.
 *
 * Every key starts with ROOT and carries the account id, so a finished
 * "Refresh all" — or this tab's own "Refresh identity & access" — invalidates
 * the whole tab through the same account-scoped predicate the other tabs use.
 *
 * The identity estate changes only when a collection or an analysis runs, so
 * lists cache for a minute. `placeholderData` keeps the previous page on
 * screen while the next one loads, which matters here more than elsewhere: the
 * table is the thing people page through while reading.
 */
const ROOT = ['identity'];
const key = (...parts) => [...ROOT, ...parts];

export const identityKeys = {
  root: ROOT,
  account: (accountId) => key('account', accountId),
};

export const useIdentityMeta = () => useQuery({
  queryKey: key('meta'),
  queryFn: api.getMeta,
  staleTime: Infinity,
  gcTime: Infinity,
});

export const useIdentityOverview = (accountId) => useQuery({
  queryKey: key('overview', accountId),
  queryFn: () => api.getOverview(accountId),
  enabled: !!accountId,
  staleTime: 60_000,
});

export const useIdentityPrincipals = (accountId, filters) => useQuery({
  queryKey: key('principals', accountId, filters),
  queryFn: () => api.getPrincipals(accountId, filters),
  enabled: !!accountId,
  staleTime: 30_000,
  placeholderData: (previous) => previous,
});

export const useIdentityPrincipal = (identityId) => useQuery({
  queryKey: key('principal', identityId),
  queryFn: () => api.getPrincipal(identityId),
  enabled: !!identityId,
  staleTime: 30_000,
});

export const useIdentityPermissions = (identityId, filters) => useQuery({
  queryKey: key('permissions', identityId, filters),
  queryFn: () => api.getPermissions(identityId, filters),
  enabled: !!identityId,
  staleTime: 30_000,
  placeholderData: (previous) => previous,
});

export const useIdentityUsage = (identityId) => useQuery({
  queryKey: key('usage', identityId),
  queryFn: () => api.getUsage(identityId),
  enabled: !!identityId,
  staleTime: 60_000,
});

export const useIdentityBlastRadius = (identityId) => useQuery({
  queryKey: key('blast', identityId),
  queryFn: () => api.getBlastRadius(identityId),
  enabled: !!identityId,
  staleTime: 60_000,
});

export const useIdentityTrust = (identityId) => useQuery({
  queryKey: key('trust', identityId),
  queryFn: () => api.getTrust(identityId),
  enabled: !!identityId,
  staleTime: 60_000,
});

export const useIdentityEvents = (identityId, limit = 100) => useQuery({
  queryKey: key('events', identityId, limit),
  queryFn: () => api.getEvents(identityId, limit),
  enabled: !!identityId,
  staleTime: 30_000,
});

export const useIdentityRecommendations = (identityId) => useQuery({
  queryKey: key('recommendations', identityId),
  queryFn: () => api.getRecommendations(identityId),
  enabled: !!identityId,
  staleTime: 60_000,
});

export const useTrustMap = (accountId, externalOnly = false) => useQuery({
  queryKey: key('trust-map', accountId, externalOnly),
  queryFn: () => api.getTrustMap(accountId, externalOnly),
  enabled: !!accountId,
  staleTime: 60_000,
});

export const useAccessRequests = (accountId, filters) => useQuery({
  queryKey: key('requests', accountId, filters),
  queryFn: () => api.getRequests(accountId, filters),
  enabled: !!accountId,
  staleTime: 15_000,
});

export const useAccessRequest = (requestId) => useQuery({
  queryKey: key('request', requestId),
  queryFn: () => api.getRequest(requestId),
  enabled: !!requestId,
  staleTime: 10_000,
});

export const useJitSessions = (accountId, filters) => useQuery({
  queryKey: key('sessions', accountId, filters),
  queryFn: () => api.getSessions(accountId, filters),
  enabled: !!accountId,
  // Shorter than the rest: a session's remaining time is the point of the row,
  // and a stale one would show access as live after it had been revoked.
  staleTime: 10_000,
  refetchInterval: 30_000,
});

/**
 * The permission explorer. A mutation rather than a query because it is a
 * question the operator ASKS — it should run when they press the button, not
 * when a dependency changes.
 */
export const usePermissionQuery = (accountId) => useMutation({
  mutationFn: (vars) => api.canDo(accountId, vars),
});

export const useWhoCanAccess = (accountId) => useMutation({
  mutationFn: (vars) => api.whoCanAccess(accountId, vars),
});

export const useIdentitySearch = (accountId) => useMutation({
  mutationFn: ({ q, limit }) => api.search(accountId, q, limit),
});

/** Who can reach one resource — called from the Resources tab's drawer. */
export const useResourcePrincipals = (accountId, resourceKey) => useQuery({
  queryKey: key('resource-principals', accountId, resourceKey),
  queryFn: () => api.getResourcePrincipals(accountId, resourceKey),
  enabled: !!accountId && !!resourceKey,
  staleTime: 60_000,
});

// ── Mutations that change something ─────────────────────────────────────────
// Each invalidates the account's whole ROOT, so the tiles, the table and any
// open drawer move together rather than disagreeing until the next refetch.
const useAccountMutation = (accountId, mutationFn) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => qc.invalidateQueries({ queryKey: ROOT }),
  });
};

export const useCreateRequest = (accountId) => useAccountMutation(
  accountId, (body) => api.createRequest(accountId, body),
);

export const useApproveRequest = (accountId) => useAccountMutation(
  accountId, ({ requestId, comment }) => api.approveRequest(requestId, comment),
);

export const useRejectRequest = (accountId) => useAccountMutation(
  accountId, ({ requestId, comment }) => api.rejectRequest(requestId, comment),
);

export const useApplyRequest = (accountId) => useAccountMutation(
  accountId, ({ requestId }) => api.applyRequest(requestId),
);

export const useRevokeSession = (accountId) => useAccountMutation(
  accountId, ({ sessionId, comment }) => api.revokeSession(sessionId, comment),
);

export const useProposeRightsizing = (accountId) => useAccountMutation(
  accountId, ({ identityId }) => api.proposeRightsizing(identityId),
);
