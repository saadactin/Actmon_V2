import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listAgents, registerAgent, syncConnections } from '@/api/agents';
import { TIMING, statusLevel } from '@/config/agents';

const KEY = ['agents', 'list'];

/**
 * The agents list, its derived counts and filter options, plus the register and
 * sync mutations.
 *
 * Poll interval comes from config/agents.js (TIMING.refreshSeconds) rather than a
 * literal, so it's one edit to change everywhere.
 */
export default function useAgents() {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: KEY,
    queryFn: listAgents,
    refetchInterval: TIMING.refreshSeconds * 1000,
    retry: false,
  });

  const agents = query.data || [];

  const register = useMutation({
    mutationFn: registerAgent,
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });

  /* ── sync from saved DB connections ──────────────────────────────────────
     Message wording matches the existing module, including the "already
     registered" and long-error cases. */
  const [syncMessage, setSyncMessage] = useState(null);

  const sync = useMutation({
    mutationFn: syncConnections,
    onSuccess: (res) => {
      const created = res?.created?.length ?? 0;
      const skipped = res?.skipped?.length ?? 0;
      const text = created > 0
        ? `${created} agent${created !== 1 ? 's' : ''} created${skipped > 0 ? `, ${skipped} already existed` : ''}.`
        : skipped > 0
          ? `All ${skipped} connection${skipped !== 1 ? 's' : ''} already registered — nothing new to add.`
          : 'No connections found to sync.';
      setSyncMessage({ tone: 'success', text });
      qc.invalidateQueries({ queryKey: KEY });
      setTimeout(() => setSyncMessage(null), TIMING.syncMessageMs);
    },
    onError: (err) => {
      // Raw DB errors are unreadable and enormous — collapse them.
      const raw = err?.message || '';
      const text = raw.length > 120
        ? 'Sync failed. Check backend logs for details.'
        : (raw || 'Sync failed. Please try again.');
      setSyncMessage({ tone: 'danger', text });
      setTimeout(() => setSyncMessage(null), TIMING.syncMessageMs);
    },
  });

  const counts = useMemo(() => {
    const level = (a) => statusLevel(a.status);
    return {
      all: agents.length,
      online: agents.filter((a) => level(a) === 'online').length,
      offline: agents.filter((a) => level(a) === 'offline').length,
      issues: agents.filter((a) => ['warning', 'critical'].includes(level(a))).length,
    };
  }, [agents]);

  /** Filter dropdown options built from the data actually present. */
  const options = useMemo(() => ({
    dbTypes: ['all', ...[...new Set(agents.map((a) => a.db_type).filter(Boolean))].sort()],
    environments: ['all', ...[...new Set(agents.map((a) => a.environment).filter(Boolean))].sort()],
  }), [agents]);

  return {
    agents,
    counts,
    options,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refresh: useCallback(() => qc.invalidateQueries({ queryKey: KEY }), [qc]),

    registerAgent: register.mutateAsync,
    isRegistering: register.isPending,

    sync: sync.mutate,
    isSyncing: sync.isPending,
    syncMessage,
  };
}

/**
 * Search / filter / sort, matching the existing list's behaviour exactly:
 * search covers name, hostname, ip and description; 'issues' means warning or
 * critical; sorting is numeric when both sides are numbers, case-insensitive
 * string compare otherwise.
 */
export function filterAgents(agents, { search, dbType, status, environment, sortKey, sortDir }) {
  let list = agents;

  const q = search?.trim().toLowerCase();
  if (q) {
    list = list.filter((a) => a.name?.toLowerCase().includes(q)
      || a.hostname?.toLowerCase().includes(q)
      || a.ip_address?.includes(q)
      || a.description?.toLowerCase().includes(q));
  }

  if (dbType && dbType !== 'all') {
    list = list.filter((a) => a.db_type?.toLowerCase() === dbType.toLowerCase());
  }

  if (status === 'issues') {
    list = list.filter((a) => ['warning', 'critical'].includes(statusLevel(a.status)));
  } else if (status && status !== 'all') {
    list = list.filter((a) => statusLevel(a.status) === status);
  }

  if (environment && environment !== 'all') {
    list = list.filter((a) => a.environment?.toLowerCase() === environment.toLowerCase());
  }

  return [...list].sort((a, b) => {
    let va = a[sortKey] ?? '';
    let vb = b[sortKey] ?? '';
    if (typeof va === 'number' && typeof vb === 'number') {
      return sortDir === 'asc' ? va - vb : vb - va;
    }
    va = String(va).toLowerCase();
    vb = String(vb).toLowerCase();
    if (va < vb) return sortDir === 'asc' ? -1 : 1;
    if (va > vb) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });
}
