import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/intelligence.api';

/**
 * Resource Intelligence data hooks.
 *
 * Every key starts with ROOT and carries the account id, so a finished
 * "Refresh all" (or an analysis) invalidates this tab through the same
 * account-scoped predicate the other tabs use — see REFRESHED_ROOTS.
 *
 * Findings change only when an analysis or an assessment runs, so they cache
 * for minutes; a status change invalidates the account's whole ROOT at once,
 * so the card counts, the list and the open drawer move together.
 */
const ROOT = ['intelligence'];
const key = (...parts) => [...ROOT, ...parts];

export const intelligenceKeys = { root: ROOT, account: (accountId) => key('account', accountId) };

export const useIntelligenceMeta = () => useQuery({
  queryKey: key('meta'),
  queryFn: api.getMeta,
  staleTime: Infinity,
  gcTime: Infinity,
});

export const useIntelligenceSummary = (accountId) => useQuery({
  queryKey: key('summary', accountId),
  queryFn: () => api.getSummary(accountId),
  enabled: !!accountId,
  staleTime: 60_000,
});

export const useIntelligenceFindings = (accountId, filters) => useQuery({
  queryKey: key('findings', accountId, filters),
  queryFn: () => api.getFindings(accountId, filters),
  enabled: !!accountId,
  staleTime: 30_000,
  placeholderData: (previous) => previous,
});

export const useIntelligenceFinding = (accountId, source, findingKey) => useQuery({
  queryKey: key('finding', accountId, source, findingKey),
  queryFn: () => api.getFinding(accountId, source, findingKey),
  enabled: !!accountId && !!source && !!findingKey,
  staleTime: 30_000,
});

export const useIntelligenceCoverage = (accountId, enabled = true) => useQuery({
  queryKey: key('coverage', accountId),
  queryFn: () => api.getCoverage(accountId),
  enabled: !!accountId && enabled,
  staleTime: 60_000,
});

export const useResourceHealth = (accountId, resourceId) => useQuery({
  queryKey: key('health', accountId, resourceId),
  queryFn: () => api.getResourceHealth(accountId, resourceId),
  enabled: !!accountId && !!resourceId,
  staleTime: 60_000,
});

export const useSetIntelligenceStatus = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ source, key: findingKey, status, reason }) => api.setFindingStatus(
      accountId, source, findingKey, { status, reason },
    ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ROOT });
      // A security finding's status is the Security Center's too.
      qc.invalidateQueries({ queryKey: ['securityCenter'] });
    },
  });
};
