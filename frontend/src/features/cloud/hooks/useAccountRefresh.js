import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePermissions } from '@/hooks/usePermissions';
import {
  cancelRefresh, getLatestRefresh, getRefresh, getRefreshCapabilities,
  getRefreshHistory, getRefreshSchedule, startRefresh, updateRefreshSchedule,
} from '../api/refresh.api';
import { triggerDiscovery } from '../api/discovery.api';
import { refreshCost } from '../api/cost.api';
import { collectIdentity, runAssessment } from '../api/securityCenter.api';
import { collectCertificates } from '../api/certificates.api';
import { collectEvents } from '../api/events.api';
import { runAnalysis } from '../api/intelligence.api';
import {
  busyRefusal, isBusy, isTerminal, shouldInvalidate, syncDecision,
} from '../utils/refreshModel';
import {
  tabRefreshError, tabRefreshOutcome, tabRefreshPlan,
} from '../utils/tabRefreshModel';

/**
 * Account refresh hooks.
 *
 * Two behaviours here are load-bearing.
 *
 * **Polling starts and stops.** While a refresh is RUNNING the status is
 * polled every 3 seconds; the moment it reaches a terminal state the interval
 * returns false and polling stops. A refresh that runs for four minutes must
 * not leave a timer hammering the API for the rest of the session.
 *
 * **The refresh job does not belong to the component.** It runs on the
 * backend, so navigating away or closing the tab does not stop it. These hooks
 * only observe it — which is why returning to the Overview mid-refresh picks
 * the status back up rather than showing a finished-looking page.
 */

const KEY = 'accountRefresh';

export const refreshKeys = {
  latest: (accountId) => [KEY, 'latest', accountId],
  one: (accountId, refreshId) => [KEY, 'one', accountId, refreshId],
  history: (accountId) => [KEY, 'history', accountId],
  schedule: (accountId) => [KEY, 'schedule', accountId],
  capabilities: (accountId) => [KEY, 'capabilities', accountId],
};

/** Current state for the header. Polls fast only while the account's data is
 *  being rewritten — by a refresh or by a plain discovery scan. */
export const useLatestRefresh = (accountId) => useQuery({
  queryKey: refreshKeys.latest(accountId),
  queryFn: () => getLatestRefresh(accountId),
  enabled: !!accountId,
  staleTime: 10_000,
  refetchInterval: (query) => (isBusy(query.state.data) ? 3_000 : 30_000),
  refetchIntervalInBackground: false,
});

export const useRefreshStatus = (accountId, refreshId) => useQuery({
  queryKey: refreshKeys.one(accountId, refreshId),
  queryFn: () => getRefresh(accountId, refreshId),
  enabled: !!accountId && !!refreshId,
  // Stops the moment the job finishes. Without this the page would poll a
  // completed refresh forever.
  refetchInterval: (query) => (
    isTerminal(query.state.data?.status) ? false : 3_000
  ),
  refetchIntervalInBackground: false,
});

export const useRefreshHistory = (accountId, { limit = 20, enabled = true } = {}) => (
  useQuery({
    queryKey: [...refreshKeys.history(accountId), limit],
    queryFn: () => getRefreshHistory(accountId, { limit }),
    enabled: !!accountId && enabled,
    staleTime: 30_000,
  })
);

export const useRefreshSchedule = (accountId, { enabled = true } = {}) => useQuery({
  queryKey: refreshKeys.schedule(accountId),
  queryFn: () => getRefreshSchedule(accountId),
  enabled: !!accountId && enabled,
  staleTime: 60_000,
});

export const useRefreshCapabilities = (accountId, { enabled = false } = {}) => (
  useQuery({
    queryKey: refreshKeys.capabilities(accountId),
    queryFn: () => getRefreshCapabilities(accountId),
    enabled: !!accountId && enabled,
    staleTime: 5 * 60_000,
  })
);

/**
 * Everything a completed refresh should make stale, and nothing else.
 *
 * Scoped to this account on purpose: refreshing AWS Production must not cause
 * every other account's panels to refetch. `shouldInvalidate` decides — see
 * `utils/refreshModel.js`, where it is tested — and the rule is that a query
 * must both sit under a refreshed root AND name this account in its key.
 */
export const useInvalidateAccountData = (accountId) => {
  const qc = useQueryClient();
  return useCallback(() => {
    if (!accountId) return;
    qc.invalidateQueries({
      predicate: (q) => shouldInvalidate(q.queryKey, accountId),
    });
    // The account list carries last_discovery for every account, so it is
    // refetched wholesale — it is one small request and is not account-scoped.
    qc.invalidateQueries({ queryKey: ['cloudAccounts'] });
  }, [qc, accountId]);
};

export const useStartRefresh = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (opts) => startRefresh(accountId, opts),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: refreshKeys.latest(accountId) });
      qc.invalidateQueries({ queryKey: refreshKeys.history(accountId) });
    },
    // A refusal means something IS running — re-read so the header shows it.
    onError: () => qc.invalidateQueries({ queryKey: refreshKeys.latest(accountId) }),
  });
};

// The data version each account's tabs last re-read at, this session.
// Module-level on purpose: it must outlive the header, so leaving the account
// and coming back after a refresh finished still re-reads every tab.
const syncedVersions = new Map();

/**
 * Re-read every tab of the account whenever its data version moves.
 *
 * Keyed on the server's `data_version`, not on this component having watched
 * a refresh to the end. The old header only invalidated when the same mounted
 * instance saw its own refresh finish — start one, switch tabs, and nothing
 * re-read when it completed. This fires for a refresh started on any tab, in
 * another browser, by the schedule, or for a plain scan.
 */
export const useAccountDataSync = (accountId, dataVersion) => {
  const invalidate = useInvalidateAccountData(accountId);
  useEffect(() => {
    if (!accountId) return;
    const { invalidate: stale, remember } = syncDecision(
      syncedVersions.get(accountId), dataVersion);
    if (remember) syncedVersions.set(accountId, dataVersion);
    if (stale) invalidate();
  }, [accountId, dataVersion, invalidate]);
};

/**
 * Everything a "Refresh all" button needs: whether the account is busy, and a
 * start that treats "already running" as the answer rather than an error.
 */
export const useRefreshAll = (accountId) => {
  const latest = useLatestRefresh(accountId);
  const { mutate, isPending } = useStartRefresh(accountId);
  useAccountDataSync(accountId, latest.data?.data_version);

  const run = useCallback(({ onStarted, onBusy, onError } = {}) => {
    mutate({}, {
      onSuccess: (data) => onStarted?.(data?.refresh_id),
      onError: (err) => {
        const refusal = busyRefusal(err);
        if (refusal) onBusy?.(refusal);
        else onError?.(err);
      },
    });
  }, [mutate]);

  return {
    latest,
    busy: isBusy(latest.data) || isPending,
    scanRunning: !!latest.data?.active_scan && !latest.data?.is_running,
    run,
  };
};

export const useCancelRefresh = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (refreshId) => cancelRefresh(accountId, refreshId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: refreshKeys.latest(accountId) });
      qc.invalidateQueries({ queryKey: refreshKeys.history(accountId) });
    },
  });
};

export const useUpdateRefreshSchedule = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload) => updateRefreshSchedule(accountId, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: refreshKeys.schedule(accountId) });
      qc.invalidateQueries({ queryKey: refreshKeys.latest(accountId) });
    },
  });
};

/**
 * One tab's own refresh — the narrow counterpart of "Refresh all".
 *
 * What it does for each tab is declared in `utils/tabRefreshModel.js`, not
 * here, so the button can never do more (or less) than its caption says.
 * Provider work that finishes in a request (certificates, identity, billing,
 * events, an assessment) is awaited and then this account's data is re-read.
 * The inventory scan runs for minutes, so it is started and handed to the
 * header, whose data-version sync re-reads every tab when it lands.
 */
export const useTabRefresh = (accountId, tabKey) => {
  const qc = useQueryClient();
  const { canHere } = usePermissions();
  const latest = useLatestRefresh(accountId);
  const plan = tabRefreshPlan(tabKey, {
    canExecute: canHere('execute'),
    busy: isBusy(latest.data),
  });
  const [outcome, setOutcome] = useState(null);

  // A caption belongs to the tab it was earned on.
  useEffect(() => { setOutcome(null); }, [accountId, tabKey]);

  const reread = useCallback(() => Promise.all([
    qc.invalidateQueries({ predicate: (q) => shouldInvalidate(q.queryKey, accountId) }),
    qc.invalidateQueries({ queryKey: refreshKeys.latest(accountId) }),
  ]), [qc, accountId]);

  const { mutate, isPending } = useMutation({
    mutationFn: async (action) => {
      switch (action) {
        case 'reload': return {};
        case 'discovery': return triggerDiscovery(accountId);
        case 'cost': return refreshCost(accountId);
        case 'assess': return runAssessment(accountId);
        case 'identity': {
          const identity = await collectIdentity(accountId);
          return { identity, ...(await runAssessment(accountId)) };
        }
        case 'certificates': return collectCertificates(accountId);
        case 'events': return collectEvents(accountId);
        case 'analysis': return runAnalysis(accountId);
        default: throw new Error(`No refresh is defined for ${action}`);
      }
    },
  });

  const run = useCallback(() => {
    if (!plan || plan.disabled || !accountId) return;
    const { action } = plan;
    setOutcome(null);
    mutate(action, {
      onSuccess: async (result) => {
        await reread();
        setOutcome({ ok: true, text: tabRefreshOutcome(action, result), at: Date.now() });
      },
      onError: async (err) => {
        // A 409 means other work is rewriting the account — show it.
        await qc.invalidateQueries({ queryKey: refreshKeys.latest(accountId) });
        setOutcome({
          ok: err?.response?.status === 409,
          text: tabRefreshError(err),
          at: Date.now(),
        });
      },
    });
  }, [plan, accountId, mutate, reread, qc]);

  return { plan, run, pending: isPending, outcome };
};
