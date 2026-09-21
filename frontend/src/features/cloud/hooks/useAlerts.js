import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  acknowledgeInstance, addRecipient, applyTemplates, createRule, deleteRecipient,
  deleteRule, duplicateRule, enableEmailChannel, getActivity, getAlertSettings,
  getAnalytics, getCapabilities, getEmailSettings, getEngineStatus, getInstance,
  getChannels, getNoisyRules, getRelated, getRule, getSummary, getTemplates,
  listInstances, listNotifications, listRules, previewRule, resolveInstance,
  runEngineNow, runPrune, sendTestEmail, setRecipientEnabled, setRuleEnabled,
  silenceAlert, silenceRule, testChannel, testRule, unsilenceAlert,
  unsilenceRule, updateAlertSettings, updateRule,
} from '../api/alerts.api';

/**
 * Alerts data hooks.
 *
 * Every key starts ['cloudAlerts', <kind>, accountId], so switching accounts is
 * a cache miss rather than the previous account's rules shown under a new
 * heading. That is the same discipline the Overview uses, and it matters more
 * here: a rule list is a statement about who gets paged, and showing the wrong
 * account's would be actively dangerous.
 *
 * Each section loads independently. Email settings reach across to the database
 * service's notification tables, and those can be unreadable while rules and
 * history are perfectly fine — so a failure there must not blank the page.
 */

const KEY = 'cloudAlerts';

// Rules and delivery config change only when somebody changes them, so they can
// sit. Alert instances and the summary move on their own as the engine runs.
const CONFIG_STALE = 60_000;
const LIVE_STALE = 15_000;
// The engine ticks every 60s server-side. Polling faster than that only asks
// the database the same question twice for the same answer.
const LIVE_POLL = 60_000;

export const alertKeys = {
  summary: (accountId) => [KEY, 'summary', accountId],
  capabilities: (accountId) => [KEY, 'capabilities', accountId],
  rules: (accountId, filters) => [KEY, 'rules', accountId, filters ?? null],
  rule: (accountId, ruleId) => [KEY, 'rule', accountId, ruleId],
  instances: (accountId, filters) => [KEY, 'instances', accountId, filters ?? null],
  instance: (accountId, alertId) => [KEY, 'instance', accountId, alertId],
  email: (accountId) => [KEY, 'email', accountId],
  activity: (accountId, days) => [KEY, 'activity', accountId, days],
  engine: (accountId) => [KEY, 'engine', accountId],
};

/** Everything a write can invalidate. Kept in one place because a rule change
 *  moves the summary, the rule list and (via the next evaluation) the history,
 *  and forgetting one leaves a stale card next to a fresh one. */
const invalidateAll = (qc, accountId) => {
  [KEY].forEach(() => {
    qc.invalidateQueries({ queryKey: [KEY, 'summary', accountId] });
    qc.invalidateQueries({ queryKey: [KEY, 'rules', accountId] });
    qc.invalidateQueries({ queryKey: [KEY, 'activity', accountId] });
    qc.invalidateQueries({ queryKey: [KEY, 'capabilities', accountId] });
  });
};

// ── Reads ────────────────────────────────────────────────────────────────────
export const useAlertSummary = (accountId) => useQuery({
  queryKey: alertKeys.summary(accountId),
  queryFn: () => getSummary(accountId),
  enabled: !!accountId,
  staleTime: LIVE_STALE,
  refetchInterval: LIVE_POLL,
});

export const useAlertCapabilities = (accountId) => useQuery({
  queryKey: alertKeys.capabilities(accountId),
  queryFn: () => getCapabilities(accountId),
  enabled: !!accountId,
  staleTime: CONFIG_STALE,
});

export const useAlertRules = (accountId, filters) => useQuery({
  queryKey: alertKeys.rules(accountId, filters),
  queryFn: () => listRules(accountId, filters),
  enabled: !!accountId,
  staleTime: CONFIG_STALE,
});

export const useAlertRule = (accountId, ruleId) => useQuery({
  queryKey: alertKeys.rule(accountId, ruleId),
  queryFn: () => getRule(accountId, ruleId),
  enabled: !!accountId && !!ruleId,
  staleTime: CONFIG_STALE,
});

export const useAlertInstances = (accountId, filters) => useQuery({
  queryKey: alertKeys.instances(accountId, filters),
  queryFn: () => listInstances(accountId, filters),
  enabled: !!accountId,
  staleTime: LIVE_STALE,
  refetchInterval: LIVE_POLL,
});

export const useAlertInstance = (accountId, alertId) => useQuery({
  queryKey: alertKeys.instance(accountId, alertId),
  queryFn: () => getInstance(accountId, alertId),
  enabled: !!accountId && !!alertId,
  staleTime: LIVE_STALE,
});

export const useEmailSettings = (accountId) => useQuery({
  queryKey: alertKeys.email(accountId),
  queryFn: () => getEmailSettings(accountId),
  enabled: !!accountId,
  staleTime: CONFIG_STALE,
  // Not retried hard: an unreadable notification table will still be
  // unreadable on the third attempt, and the panel's job is to say so.
  retry: 1,
});

export const useAlertActivity = (accountId, days = 30) => useQuery({
  queryKey: alertKeys.activity(accountId, days),
  queryFn: () => getActivity(accountId, { days }),
  enabled: !!accountId,
  staleTime: LIVE_STALE,
});

export const useAlertEngine = (accountId) => useQuery({
  queryKey: alertKeys.engine(accountId),
  queryFn: () => getEngineStatus(accountId),
  enabled: !!accountId,
  staleTime: LIVE_STALE,
  refetchInterval: LIVE_POLL,
});

// ── Writes ───────────────────────────────────────────────────────────────────
export const useCreateRule = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload) => createRule(accountId, payload),
    onSuccess: () => invalidateAll(qc, accountId),
  });
};

export const useUpdateRule = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, payload }) => updateRule(accountId, ruleId, payload),
    onSuccess: (_data, { ruleId }) => {
      invalidateAll(qc, accountId);
      qc.invalidateQueries({ queryKey: alertKeys.rule(accountId, ruleId) });
    },
  });
};

export const useSetRuleEnabled = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, enabled }) => setRuleEnabled(accountId, ruleId, enabled),
    onSuccess: () => invalidateAll(qc, accountId),
  });
};

export const useDeleteRule = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ruleId) => deleteRule(accountId, ruleId),
    onSuccess: () => {
      invalidateAll(qc, accountId);
      // History is deliberately NOT invalidated away: alerts this rule already
      // raised are retained and stay in the list, labelled as deleted.
      qc.invalidateQueries({ queryKey: [KEY, 'instances', accountId] });
    },
  });
};

/** Test is a mutation rather than a query because it is an action with an audit
 *  record, not a cached read — and because running it twice should genuinely
 *  evaluate twice. */
export const useTestRule = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ruleId) => testRule(accountId, ruleId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY, 'activity', accountId] });
    },
  });
};

export const useAlertAction = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ alertId, action, reason }) => (
      action === 'acknowledge'
        ? acknowledgeInstance(accountId, alertId, reason)
        : resolveInstance(accountId, alertId, reason)
    ),
    onSuccess: (_data, { alertId }) => {
      qc.invalidateQueries({ queryKey: [KEY, 'instances', accountId] });
      qc.invalidateQueries({ queryKey: alertKeys.instance(accountId, alertId) });
      qc.invalidateQueries({ queryKey: alertKeys.summary(accountId) });
      qc.invalidateQueries({ queryKey: [KEY, 'activity', accountId] });
    },
  });
};

const invalidateEmail = (qc, accountId) => {
  qc.invalidateQueries({ queryKey: alertKeys.email(accountId) });
  qc.invalidateQueries({ queryKey: alertKeys.summary(accountId) });
  qc.invalidateQueries({ queryKey: [KEY, 'activity', accountId] });
};

export const useAddRecipient = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload) => addRecipient(accountId, payload),
    onSuccess: () => invalidateEmail(qc, accountId),
  });
};

export const useSetRecipientEnabled = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ recipientId, enabled }) => (
      setRecipientEnabled(accountId, recipientId, enabled)
    ),
    onSuccess: () => invalidateEmail(qc, accountId),
  });
};

export const useDeleteRecipient = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (recipientId) => deleteRecipient(accountId, recipientId),
    onSuccess: () => invalidateEmail(qc, accountId),
  });
};

export const useEnableEmailChannel = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => enableEmailChannel(accountId),
    onSuccess: () => invalidateEmail(qc, accountId),
  });
};

export const useSendTestEmail = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (recipients) => sendTestEmail(accountId, recipients),
    onSuccess: () => {
      // Invalidated on a delay as well as immediately: the dispatcher polls
      // every 10s, so the delivery result does not exist yet at the moment
      // this resolves. Refreshing only now would show an empty ledger and
      // teach the operator that the test did nothing.
      invalidateEmail(qc, accountId);
      setTimeout(() => invalidateEmail(qc, accountId), 12_000);
    },
  });
};

export const useRunEngineNow = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => runEngineNow(accountId),
    onSuccess: () => {
      invalidateAll(qc, accountId);
      qc.invalidateQueries({ queryKey: [KEY, 'instances', accountId] });
      qc.invalidateQueries({ queryKey: alertKeys.engine(accountId) });
      qc.invalidateQueries({ queryKey: [KEY, 'analytics', accountId] });
    },
  });
};

// ── Preview ──────────────────────────────────────────────────────────────────
/**
 * Live preview of an unsaved rule.
 *
 * A query rather than a mutation even though the endpoint is a POST: it is a
 * pure read that writes nothing, and modelling it as a query gives caching and
 * de-duplication for free while the user edits. The draft is serialized into
 * the key so each distinct configuration is fetched once.
 *
 * `enabled` gates on having a condition type — previewing an empty form would
 * fire a request on every render of step one.
 */
export const useRulePreview = (accountId, draft, { enabled = true } = {}) => {
  const body = draft?.condition_type ? {
    name: draft.name || 'preview',
    condition_type: draft.condition_type,
    condition_config: draft.condition_config,
    scope_config: draft.scope_config,
    severity: draft.severity,
    notification_config: draft.notification_config,
    cooldown_seconds: draft.cooldown_seconds,
    min_duration_seconds: draft.min_duration_seconds,
    consecutive_breaches_required: draft.consecutive_breaches_required,
    notify_on_resolution: draft.notify_on_resolution,
  } : null;

  return useQuery({
    queryKey: [KEY, 'preview', accountId, body && JSON.stringify(body)],
    queryFn: () => previewRule(accountId, body),
    enabled: !!accountId && !!body && enabled,
    // Evaluating against live data is not free. Hold the answer while the user
    // is still typing elsewhere in the form rather than re-running it.
    staleTime: 30_000,
    retry: false,
    // Keeps the previous answer on screen while the next one loads, so the
    // panel does not flicker to empty on every keystroke.
    placeholderData: (previous) => previous,
  });
};

// ── Templates ────────────────────────────────────────────────────────────────
export const useAlertTemplates = (accountId) => useQuery({
  queryKey: [KEY, 'templates', accountId],
  queryFn: () => getTemplates(accountId),
  enabled: !!accountId,
  staleTime: CONFIG_STALE,
});

export const useApplyTemplates = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keys) => applyTemplates(accountId, keys),
    onSuccess: () => invalidateAll(qc, accountId),
  });
};

export const useDuplicateRule = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ruleId) => duplicateRule(accountId, ruleId),
    onSuccess: () => invalidateAll(qc, accountId),
  });
};

export const useSilenceRule = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, seconds, reason, silence = true }) => (
      silence
        ? silenceRule(accountId, ruleId, { seconds, reason })
        : unsilenceRule(accountId, ruleId)
    ),
    onSuccess: () => invalidateAll(qc, accountId),
  });
};

// ── Analytics ────────────────────────────────────────────────────────────────
export const useAlertAnalytics = (accountId, days = 30) => useQuery({
  queryKey: [KEY, 'analytics', accountId, days],
  queryFn: () => getAnalytics(accountId, days),
  enabled: !!accountId,
  staleTime: LIVE_STALE,
});

export const useNoisyRules = (accountId, days = 7) => useQuery({
  queryKey: [KEY, 'noisy', accountId, days],
  queryFn: () => getNoisyRules(accountId, days),
  enabled: !!accountId,
  staleTime: CONFIG_STALE,
});

/** Fetched only when the drawer's Related section is actually opened — it
 *  queries five subsystems, and an alert list of 200 must not fan that out. */
export const useRelatedSignals = (accountId, alertId, { enabled = false } = {}) => (
  useQuery({
    queryKey: [KEY, 'related', accountId, alertId],
    queryFn: () => getRelated(accountId, alertId),
    enabled: !!accountId && !!alertId && enabled,
    staleTime: CONFIG_STALE,
  })
);

export const useSilenceAlert = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ alertId, seconds, reason, silence = true }) => (
      silence
        ? silenceAlert(accountId, alertId, { seconds, reason })
        : unsilenceAlert(accountId, alertId)
    ),
    onSuccess: (_data, { alertId }) => {
      qc.invalidateQueries({ queryKey: [KEY, 'instances', accountId] });
      qc.invalidateQueries({ queryKey: alertKeys.instance(accountId, alertId) });
      qc.invalidateQueries({ queryKey: [KEY, 'activity', accountId] });
    },
  });
};

// ── Channels and delivery ledger ─────────────────────────────────────────────
export const useChannels = (accountId) => useQuery({
  queryKey: [KEY, 'channels', accountId],
  queryFn: () => getChannels(accountId),
  enabled: !!accountId,
  staleTime: CONFIG_STALE,
  retry: 1,
});

export const useTestChannel = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ channelType, recipients }) => (
      testChannel(accountId, channelType, recipients)
    ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY, 'channels', accountId] });
      qc.invalidateQueries({ queryKey: [KEY, 'notifications', accountId] });
      // The dispatcher polls every 10s, so the delivery result does not exist
      // yet when this resolves. Refreshing only now would show an empty ledger
      // and teach the operator the test did nothing.
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: [KEY, 'notifications', accountId] });
      }, 12_000);
    },
  });
};

export const useNotifications = (accountId, filters = {}) => useQuery({
  queryKey: [KEY, 'notifications', accountId, filters],
  queryFn: () => listNotifications(accountId, filters),
  enabled: !!accountId,
  staleTime: LIVE_STALE,
  retry: 1,
});

// ── Settings ─────────────────────────────────────────────────────────────────
export const useAlertSettings = (accountId) => useQuery({
  queryKey: [KEY, 'settings', accountId],
  queryFn: () => getAlertSettings(accountId),
  enabled: !!accountId,
  staleTime: CONFIG_STALE,
});

export const useUpdateAlertSettings = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload) => updateAlertSettings(accountId, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY, 'settings', accountId] });
      qc.invalidateQueries({ queryKey: [KEY, 'activity', accountId] });
    },
  });
};

export const useRunPrune = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dryRun) => runPrune(accountId, dryRun),
    onSuccess: (_data, dryRun) => {
      if (dryRun) return;
      qc.invalidateQueries({ queryKey: [KEY, 'settings', accountId] });
      qc.invalidateQueries({ queryKey: [KEY, 'instances', accountId] });
      qc.invalidateQueries({ queryKey: [KEY, 'summary', accountId] });
    },
  });
};
