import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listActiveAlerts } from '@/api/alerts';
import { severityOf } from '@/components/charts/status';

const REFRESH_MS = 15_000;

/**
 * Live alerts scoped to one database connection's host(s) — the same feed and
 * shape Dashboard.jsx's overview builds (`{list, counts}`), just filtered
 * server-side to this connection instead of the whole estate. Feeds
 * RecentAlertsPanel on each engine dashboard's Overview tab.
 */
export default function useConnectionAlerts(connId) {
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['alerts', 'active', connId],
    queryFn: () => listActiveAlerts(connId),
    enabled: connId != null,
    refetchInterval: REFRESH_MS,
    retry: false,
  });

  const alerts = data || [];

  return useMemo(() => {
    const bySeverity = { critical: 0, warning: 0, info: 0 };
    for (const a of alerts) bySeverity[severityOf(a.severity).id] += 1;
    const list = [...alerts].sort(
      (a, b) => new Date(b.timestamp || b.created_at || 0) - new Date(a.timestamp || a.created_at || 0),
    );
    return {
      list,
      counts: { total: alerts.length, ...bySeverity },
      isLoading,
      isFetching,
    };
  }, [alerts, isLoading, isFetching]);
}
