import { useMemo } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ackIdOf, acknowledgeAlerts, createRule, deleteRule, isAckable,
  listActiveAlerts, listRules, toggleRule, updateRule,
} from '@/api/alerts';
import { listAgents, listCloudAccounts, listOsServers } from '@/api/dashboard';
import { QK } from '@/api/queryKeys';
import { severityOf } from '@/components/charts/status';

const ACTIVE_KEY = ['alerts', 'active'];
const RULES_KEY = ['alerts', 'rules'];

/* ── active alerts ────────────────────────────────────────────────────────── */

export function useActiveAlerts() {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ACTIVE_KEY,
    queryFn: listActiveAlerts,
    refetchInterval: 15_000,
    retry: false,
  });

  const ack = useMutation({
    mutationFn: (alerts) => acknowledgeAlerts(alerts.filter(isAckable).map(ackIdOf)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ACTIVE_KEY }),
  });

  const alerts = query.data || [];

  const summary = useMemo(() => {
    const counts = { critical: 0, warning: 0, info: 0 };
    const bySource = {};
    const byMetric = {};

    for (const a of alerts) {
      counts[severityOf(a.severity).id] += 1;
      const src = a.source || 'Unknown';
      bySource[src] = (bySource[src] || 0) + 1;
      const metric = a.metric || 'unknown';
      byMetric[metric] = (byMetric[metric] || 0) + 1;
    }

    const toList = (map) => Object.entries(map)
      .map(([key, value]) => ({ key, label: key, value }))
      .sort((a, b) => b.value - a.value);

    return {
      total: alerts.length,
      ...counts,
      bySource: toList(bySource),
      byMetric: toList(byMetric),
      /** Distinct values for the filter dropdowns, built from what's actually firing. */
      sources: [...new Set(alerts.map((a) => a.source).filter(Boolean))].sort(),
      environments: [...new Set(alerts.map((a) => a.environment).filter(Boolean))].sort(),
      ackableCount: alerts.filter(isAckable).length,
    };
  }, [alerts]);

  return {
    alerts,
    summary,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refresh: () => qc.invalidateQueries({ queryKey: ACTIVE_KEY }),
    acknowledge: ack.mutateAsync,
    isAcknowledging: ack.isPending,
  };
}

/* ── rules ────────────────────────────────────────────────────────────────── */

export function useAlertRules() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: RULES_KEY });
    // A rule change alters what fires, so the live feed is stale too.
    qc.invalidateQueries({ queryKey: ACTIVE_KEY });
  };

  const query = useQuery({ queryKey: RULES_KEY, queryFn: listRules, retry: false });

  const save = useMutation({
    mutationFn: ({ id, ...payload }) => (id ? updateRule(id, payload) : createRule(payload)),
    onSuccess: invalidate,
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }) => toggleRule(id, enabled),
    // Flip the switch immediately, then reconcile — a toggle that lags feels broken.
    onMutate: async ({ id, enabled }) => {
      await qc.cancelQueries({ queryKey: RULES_KEY });
      const previous = qc.getQueryData(RULES_KEY);
      qc.setQueryData(RULES_KEY, (old) =>
        (old || []).map((r) => (r.id === id ? { ...r, enabled } : r)));
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(RULES_KEY, ctx.previous);
    },
    onSettled: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id) => deleteRule(id),
    onSuccess: invalidate,
  });

  const rules = query.data || [];

  const stats = useMemo(() => ({
    total: rules.length,
    enabled: rules.filter((r) => r.enabled).length,
    disabled: rules.filter((r) => !r.enabled).length,
    critical: rules.filter((r) => r.severity === 'critical').length,
    warning: rules.filter((r) => r.severity === 'warning').length,
  }), [rules]);

  return {
    rules,
    stats,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refresh: invalidate,
    saveRule: save.mutateAsync,
    isSaving: save.isPending,
    toggleRule: toggle.mutate,
    deleteRule: remove.mutateAsync,
    isDeleting: remove.isPending,
  };
}

/**
 * Targets for the rule scopes: servers, agents and cloud accounts.
 *
 * Lazy — only the rule editor needs them, and only once it's open. Shares the
 * dashboard's cache keys so opening the editor after visiting the dashboard costs
 * nothing.
 */
export function useScopeTargets(enabled = false) {
  const [servers, agents, accounts] = useQueries({
    queries: [
      { queryKey: QK.osServers(), queryFn: listOsServers, enabled, retry: false, staleTime: 60_000 },
      { queryKey: QK.agents, queryFn: listAgents, enabled, retry: false, staleTime: 60_000 },
      { queryKey: ['dash', 'cloud'], queryFn: listCloudAccounts, enabled, retry: false, staleTime: 60_000 },
    ],
  });

  const uniqueSorted = (list) => [...new Set(list.filter(Boolean).map(String))].sort();

  return {
    server: uniqueSorted((Array.isArray(servers.data) ? servers.data : []).map((s) => s.server_name)),
    agent: uniqueSorted((agents.data || []).map((a) => a.name || a.agent_name)),
    account: uniqueSorted((accounts.data || []).map(
      (a) => a.account_name || a.name || a.provider || a.cloud_provider,
    )),
    isLoading: servers.isLoading || agents.isLoading || accounts.isLoading,
  };
}
