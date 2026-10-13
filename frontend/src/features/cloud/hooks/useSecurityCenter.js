import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/securityCenter.api';

/**
 * Security Center data hooks.
 *
 * All TanStack Query, deliberately. The previous AlertsPage used raw `fetch`
 * with `setInterval(…, 10000)`, so its data lived outside the cache: an
 * assessment that resolved 80 alerts could not invalidate it, and the page kept
 * showing them until its next tick.
 *
 * Cache times reflect how the data is produced, not a uniform default:
 *
 * - Findings and the overview are recomputed only when an assessment runs, so
 *   they can be cached for minutes.
 * - Alerts are a live feed and poll.
 * - `meta` is the rule catalog and changes only on deploy, so it is cached for
 *   the session.
 */

const ROOT = ['securityCenter'];
const key = (...parts) => [...ROOT, ...parts];

// Every read that an assessment can change. Invalidated as one group after a
// write, so a suppressed finding disappears from the findings list, the score
// tile, the compliance tab and the alert feed together rather than in
// whichever order each happened to refetch.
const ASSESSMENT_SCOPED = [
  'overview', 'findings', 'finding', 'compliance', 'control', 'exposure',
  'identity', 'coverage', 'trends', 'score', 'diagnostics', 'alerts',
  'multiCloud', 'attackPaths', 'vulnerabilities', 'threats', 'incidents',
  'ransomware',
];

export const useSecurityMeta = () => useQuery({
  queryKey: key('meta'),
  queryFn: api.getMeta,
  staleTime: Infinity,
  gcTime: Infinity,
});

export const useMultiCloudSecurity = (enabled = true) => useQuery({
  queryKey: key('multiCloud'),
  queryFn: api.getMultiCloudOverview,
  enabled,
  staleTime: 60_000,
});

export const useSecurityOverview = (accountId) => useQuery({
  queryKey: key('overview', accountId),
  queryFn: () => api.getOverview(accountId),
  enabled: !!accountId,
  staleTime: 60_000,
});

export const useFindings = (accountId, filters, enabled = true) => useQuery({
  // The filter object is part of the key, so each filter combination caches
  // separately and going back to a previous filter is instant.
  queryKey: key('findings', accountId, filters),
  queryFn: () => api.getFindings(accountId, filters),
  enabled: !!accountId && enabled,
  staleTime: 30_000,
  // Keeps the previous page visible while the next one loads, instead of
  // collapsing the table to a spinner on every page change.
  placeholderData: (previous) => previous,
});

export const useFinding = (accountId, findingKey) => useQuery({
  queryKey: key('finding', accountId, findingKey),
  queryFn: () => api.getFinding(accountId, findingKey),
  enabled: !!accountId && !!findingKey,
  staleTime: 30_000,
});

export const useCompliance = (accountId, framework, enabled = true) => useQuery({
  queryKey: key('compliance', accountId, framework ?? 'all'),
  queryFn: () => api.getCompliance(accountId, framework),
  enabled: !!accountId && enabled,
  staleTime: 60_000,
});

export const useControl = (accountId, framework, controlId) => useQuery({
  queryKey: key('control', accountId, framework, controlId),
  queryFn: () => api.getControl(accountId, framework, controlId),
  enabled: !!accountId && !!framework && !!controlId,
  staleTime: 60_000,
});

export const useExposure = (accountId, enabled = true) => useQuery({
  queryKey: key('exposure', accountId),
  queryFn: () => api.getExposure(accountId),
  enabled: !!accountId && enabled,
  staleTime: 60_000,
});

export const useIdentity = (accountId, enabled = true) => useQuery({
  queryKey: key('identity', accountId),
  queryFn: () => api.getIdentity(accountId),
  enabled: !!accountId && enabled,
  staleTime: 60_000,
});

// Attack paths are derived from the topology graph, which is itself cached
// behind an inventory fingerprint, so a repeat view inside one generation
// costs nothing. The longer staleTime reflects that the answer cannot change
// until discovery runs again.
export const useAttackPaths = (accountId, options = {}, enabled = true) => useQuery({
  queryKey: key('attackPaths', accountId, options.maxDepth ?? 6, options.limit ?? 100),
  queryFn: () => api.getAttackPaths(accountId, options),
  enabled: !!accountId && enabled,
  staleTime: 120_000,
});

export const useVulnerabilities = (accountId, enabled = true) => useQuery({
  queryKey: key('vulnerabilities', accountId),
  queryFn: () => api.getVulnerabilities(accountId),
  enabled: !!accountId && enabled,
  staleTime: 120_000,
});

export const useThreats = (accountId, days = 30, enabled = true) => useQuery({
  queryKey: key('threats', accountId, days),
  queryFn: () => api.getThreats(accountId, { days }),
  enabled: !!accountId && enabled,
  staleTime: 120_000,
});

export const useIncidents = (accountId, days = 30, enabled = true) => useQuery({
  queryKey: key('incidents', accountId, days),
  queryFn: () => api.getIncidents(accountId, { days }),
  enabled: !!accountId && enabled,
  staleTime: 120_000,
});

export const useRansomware = (accountId, enabled = true) => useQuery({
  queryKey: key('ransomware', accountId),
  queryFn: () => api.getRansomware(accountId),
  enabled: !!accountId && enabled,
  staleTime: 120_000,
});

export const useCoverage = (accountId, enabled = true) => useQuery({
  queryKey: key('coverage', accountId),
  queryFn: () => api.getCoverage(accountId),
  enabled: !!accountId && enabled,
  staleTime: 60_000,
});

export const useTrends = (accountId, limit = 60, enabled = true) => useQuery({
  queryKey: key('trends', accountId, limit),
  queryFn: () => api.getTrends(accountId, limit),
  enabled: !!accountId && enabled,
  staleTime: 60_000,
});

export const useScoreExplanation = (accountId, enabled = true) => useQuery({
  queryKey: key('score', accountId),
  queryFn: () => api.getScoreExplanation(accountId),
  enabled: !!accountId && enabled,
  staleTime: 60_000,
});

export const useDiagnostics = (accountId, enabled = true) => useQuery({
  queryKey: key('diagnostics', accountId),
  queryFn: () => api.getDiagnostics(accountId),
  enabled: !!accountId && enabled,
  staleTime: 60_000,
});

export const useSecurityAlerts = (accountId, includeResolved = false) => useQuery({
  queryKey: key('alerts', accountId ?? 'all', includeResolved),
  queryFn: () => api.getAlerts({ account_id: accountId, include_resolved: includeResolved }),
  // The one genuinely live view: an alert can appear between two page loads
  // because a scan finished.
  refetchInterval: 15_000,
  staleTime: 10_000,
});

export const usePolicies = (accountId, enabled = true) => useQuery({
  queryKey: key('policies', accountId ?? 'all'),
  queryFn: () => api.getPolicies(accountId),
  enabled,
  staleTime: 60_000,
});

// ── Mutations ───────────────────────────────────────────────────────────────

const useInvalidateAssessment = () => {
  const qc = useQueryClient();
  return () => ASSESSMENT_SCOPED.forEach(
    (scope) => qc.invalidateQueries({ queryKey: key(scope) }),
  );
};

export const useRunAssessment = () => {
  const invalidate = useInvalidateAssessment();
  return useMutation({
    mutationFn: (accountId) => api.runAssessment(accountId),
    onSuccess: invalidate,
  });
};

export const useCollectIdentity = () => {
  const invalidate = useInvalidateAssessment();
  return useMutation({
    mutationFn: (accountId) => api.collectIdentity(accountId),
    onSuccess: invalidate,
  });
};

export const useSetFindingStatus = () => {
  const invalidate = useInvalidateAssessment();
  return useMutation({
    mutationFn: ({ accountId, key: findingKey, ...payload }) =>
      api.setFindingStatus(accountId, findingKey, payload),
    onSuccess: invalidate,
  });
};

export const useAlertAction = () => {
  const invalidate = useInvalidateAssessment();
  return useMutation({
    mutationFn: ({ alertId, action, reason }) => api.actOnAlert(alertId, action, reason),
    onSuccess: invalidate,
  });
};

export const usePolicyMutation = () => {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: key('policies') });
    // A policy change alters what will alert on the next assessment, not what
    // is already alerting — so the alert feed is refreshed but nothing else is.
    qc.invalidateQueries({ queryKey: key('alerts') });
  };
  return {
    create: useMutation({ mutationFn: api.createPolicy, onSuccess: invalidate }),
    update: useMutation({
      mutationFn: ({ policyId, ...payload }) => api.updatePolicy(policyId, payload),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: api.deletePolicy, onSuccess: invalidate }),
  };
};
