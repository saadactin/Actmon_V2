import { cloudAxios } from './axios';

/**
 * The Alerts tab's API layer.
 *
 * Every path carries the account id, and the backend resolves the account
 * before anything else — so a rule, recipient or alert belonging to another
 * account is a 404 rather than a leak. That matters more here than elsewhere
 * in the product: an alert rule decides who gets emailed about what, and a
 * rule bleeding across accounts would page the wrong team about the wrong
 * estate.
 *
 * Nothing in this file fetches an inventory, a findings list or a cost ledger.
 * The alert engine reads those server-side with aggregate queries; the browser
 * only ever asks for rules, alert rows and delivery state.
 */

const base = (accountId) => `/alerts/${accountId}`;

/** Repeated keys (`?state=A&state=B`), which is what FastAPI's List[str]
 *  reads. Axios's default serializer would otherwise send `state[]=A`,
 *  which arrives as a different, unread parameter name — the backend's
 *  `state=` filter then reads as unset and every state is returned. Lifted
 *  verbatim from resources.api.js, which carries the same trap. */
const serialize = (params) => {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) {
      value.filter((v) => v !== undefined && v !== null && v !== '')
        .forEach((v) => search.append(key, String(v)));
      return;
    }
    search.append(key, String(value));
  });
  return search.toString();
};

/** What can be alerted on for THIS account.
 *
 *  Support is observed rather than declared: the backend asks the billing,
 *  security, event and drift subsystems whether each condition can actually be
 *  evaluated here. That is why the builder can disable a condition with a real
 *  sentence ("2 days of billed history are stored, a baseline needs two
 *  windows") instead of offering a rule that would sit at UNKNOWN forever. */
export const getCapabilities = async (accountId) => {
  const { data } = await cloudAxios.get(`${base(accountId)}/capabilities`);
  return data;
};

/** The header strip. Carries `rules_inconclusive` alongside the alert counts,
 *  because "14 rules enabled, 0 alerts" reads as healthy and can mean 14 rules
 *  that have not managed to read anything. */
export const getSummary = async (accountId) => {
  const { data } = await cloudAxios.get(`${base(accountId)}/summary`);
  return data;
};

export const getActivity = async (accountId, { days = 30, limit = 100 } = {}) => {
  const { data } = await cloudAxios.get(`${base(accountId)}/activity`, {
    params: { days, limit },
  });
  return data;
};

// ── Rules ────────────────────────────────────────────────────────────────────
/** Rules, filtered server-side. The response carries `facets` — counts per
 *  dimension — so the filter row can offer only what would match something. */
export const listRules = async (accountId, filters = {}) => {
  const {
    category, enabled, severity, conditionType, notifies, q,
  } = filters;
  const { data } = await cloudAxios.get(`${base(accountId)}/rules`, {
    params: {
      ...(category ? { category } : {}),
      ...(enabled === undefined || enabled === null ? {} : { enabled }),
      ...(severity ? { severity } : {}),
      ...(conditionType ? { condition_type: conditionType } : {}),
      ...(notifies === undefined || notifies === null ? {} : { notifies }),
      ...(q ? { q } : {}),
    },
  });
  return data;
};

/** Evaluate an UNSAVED rule against live data.
 *
 *  Writes nothing — no rule, no alert, no notification, no audit row. This is
 *  what answers "what exactly will cause this email to arrive" while the user
 *  is still deciding, so it is safe to call on every keystroke (debounced). */
export const previewRule = async (accountId, payload) => {
  const { data } = await cloudAxios.post(`${base(accountId)}/rules/preview`, payload);
  return data;
};

export const duplicateRule = async (accountId, ruleId) => {
  const { data } = await cloudAxios.post(
    `${base(accountId)}/rules/${ruleId}/duplicate`,
  );
  return data;
};

/** Suppress this rule's mail without stopping it watching. Alerts still open
 *  and resolve, so the tab stays truthful; only notification is silenced. */
export const silenceRule = async (accountId, ruleId, { seconds, reason }) => {
  const { data } = await cloudAxios.post(
    `${base(accountId)}/rules/${ruleId}/silence`, { seconds, reason },
  );
  return data;
};

export const unsilenceRule = async (accountId, ruleId) => {
  const { data } = await cloudAxios.delete(
    `${base(accountId)}/rules/${ruleId}/silence`,
  );
  return data;
};

// ── Templates ────────────────────────────────────────────────────────────────
export const getTemplates = async (accountId) => {
  const { data } = await cloudAxios.get(`${base(accountId)}/templates`);
  return data;
};

/** Creates the recommended rules DISABLED and with no recipients, so an
 *  upgrade can never produce a surprise email flood. */
export const applyTemplates = async (accountId, keys) => {
  const { data } = await cloudAxios.post(`${base(accountId)}/templates/apply`, {
    keys: keys?.length ? keys : null,
  });
  return data;
};

// ── Analytics ────────────────────────────────────────────────────────────────
export const getAnalytics = async (accountId, days = 30) => {
  const { data } = await cloudAxios.get(`${base(accountId)}/analytics`, {
    params: { days },
  });
  return data;
};

export const getNoisyRules = async (accountId, days = 7) => {
  const { data } = await cloudAxios.get(`${base(accountId)}/noisy-rules`, {
    params: { days },
  });
  return data;
};

/** Co-occurring signals around an alert. Correlation only — the payload
 *  carries its own disclaimer and this layer does not soften it. */
export const getRelated = async (accountId, alertId) => {
  const { data } = await cloudAxios.get(
    `${base(accountId)}/instances/${alertId}/related`,
  );
  return data;
};

/** Silence ONE alert rather than its whole rule. The alert stays open and
 *  still counts as active; only its email is suppressed. */
export const silenceAlert = async (accountId, alertId, { seconds, reason }) => {
  const { data } = await cloudAxios.post(
    `${base(accountId)}/instances/${alertId}/silence`, { seconds, reason },
  );
  return data;
};

export const unsilenceAlert = async (accountId, alertId) => {
  const { data } = await cloudAxios.delete(
    `${base(accountId)}/instances/${alertId}/silence`,
  );
  return data;
};

// ── Channels and delivery ledger ─────────────────────────────────────────────
/** All nine channels, eight marked not implemented. Listed rather than hidden,
 *  because "no integration exists" and "configured but off" are different
 *  answers. */
export const getChannels = async (accountId) => {
  const { data } = await cloudAxios.get(`${base(accountId)}/channels`);
  return data;
};

/** Tests the TRANSPORT. Distinct from testing a rule, which tests detection. */
export const testChannel = async (accountId, channelType, recipients) => {
  const { data } = await cloudAxios.post(
    `${base(accountId)}/channels/${channelType}/test`,
    { recipients: recipients?.length ? recipients : null },
  );
  return data;
};

/** `available: false` means the ledger could not be read — which is NOT an
 *  empty list of deliveries. The caller must keep those apart. */
export const listNotifications = async (accountId, { status, days = 30, limit = 100 } = {}) => {
  const { data } = await cloudAxios.get(`${base(accountId)}/notifications`, {
    params: { ...(status ? { status } : {}), days, limit },
  });
  return data;
};

export const getNotification = async (accountId, notificationId) => {
  const { data } = await cloudAxios.get(
    `${base(accountId)}/notifications/${notificationId}`,
  );
  return data;
};

// ── Settings / retention ─────────────────────────────────────────────────────
export const getAlertSettings = async (accountId) => {
  const { data } = await cloudAxios.get(`${base(accountId)}/settings`);
  return data;
};

export const updateAlertSettings = async (accountId, payload) => {
  const { data } = await cloudAxios.put(`${base(accountId)}/settings`, payload);
  return data;
};

/** Defaults to a dry run. Deletion cannot be undone, so the destructive call
 *  has to be asked for explicitly. */
export const runPrune = async (accountId, dryRun = true) => {
  const { data } = await cloudAxios.post(`${base(accountId)}/settings/prune`, null, {
    params: { dry_run: dryRun },
  });
  return data;
};

export const getRule = async (accountId, ruleId) => {
  const { data } = await cloudAxios.get(`${base(accountId)}/rules/${ruleId}`);
  return data;
};

export const createRule = async (accountId, payload) => {
  const { data } = await cloudAxios.post(`${base(accountId)}/rules`, payload);
  return data;
};

export const updateRule = async (accountId, ruleId, payload) => {
  const { data } = await cloudAxios.patch(
    `${base(accountId)}/rules/${ruleId}`, payload,
  );
  return data;
};

/** Its own endpoint rather than a PATCH, so the audit trail records
 *  "disabled" rather than "updated" — the single most important alerting
 *  change to be able to find again later. */
export const setRuleEnabled = async (accountId, ruleId, enabled) => {
  const { data } = await cloudAxios.post(
    `${base(accountId)}/rules/${ruleId}/enabled`, { enabled },
  );
  return data;
};

export const deleteRule = async (accountId, ruleId) => {
  const { data } = await cloudAxios.delete(`${base(accountId)}/rules/${ruleId}`);
  return data;
};

/** Evaluate against live data and report the real answer. Creates no alert and
 *  sends no email, even when the condition is met. */
export const testRule = async (accountId, ruleId) => {
  const { data } = await cloudAxios.post(`${base(accountId)}/rules/${ruleId}/test`);
  return data;
};

// ── Alert instances ──────────────────────────────────────────────────────────
export const listInstances = async (accountId, filters = {}) => {
  const {
    state, severity, category, ruleId, days, q, limit = 200,
  } = filters;
  const { data } = await cloudAxios.get(`${base(accountId)}/instances`, {
    params: {
      ...(state?.length ? { state } : {}),
      ...(severity ? { severity } : {}),
      ...(category ? { category } : {}),
      ...(ruleId ? { rule_id: ruleId } : {}),
      ...(days ? { days } : {}),
      ...(q ? { q } : {}),
      limit,
    },
    paramsSerializer: { serialize },
  });
  return data;
};

export const getInstance = async (accountId, alertId) => {
  const { data } = await cloudAxios.get(`${base(accountId)}/instances/${alertId}`);
  return data;
};

export const acknowledgeInstance = async (accountId, alertId, reason) => {
  const { data } = await cloudAxios.post(
    `${base(accountId)}/instances/${alertId}/acknowledge`, { reason },
  );
  return data;
};

export const resolveInstance = async (accountId, alertId, reason) => {
  const { data } = await cloudAxios.post(
    `${base(accountId)}/instances/${alertId}/resolve`, { reason },
  );
  return data;
};

// ── Email ────────────────────────────────────────────────────────────────────
/** Delivery readiness, recipients and the real send ledger. Never returns an
 *  SMTP username or password — only host, port, TLS and the sender identity. */
export const getEmailSettings = async (accountId) => {
  const { data } = await cloudAxios.get(`${base(accountId)}/email`);
  return data;
};

export const addRecipient = async (accountId, payload) => {
  const { data } = await cloudAxios.post(`${base(accountId)}/recipients`, payload);
  return data;
};

export const setRecipientEnabled = async (accountId, recipientId, enabled) => {
  const { data } = await cloudAxios.post(
    `${base(accountId)}/recipients/${recipientId}/enabled`, { enabled },
  );
  return data;
};

export const deleteRecipient = async (accountId, recipientId) => {
  const { data } = await cloudAxios.delete(
    `${base(accountId)}/recipients/${recipientId}`,
  );
  return data;
};

/** Switches on the shared email delivery channel. Installation-wide, not
 *  account-scoped — the UI says so before calling this. */
export const enableEmailChannel = async (accountId) => {
  const { data } = await cloudAxios.post(`${base(accountId)}/email/enable-channel`);
  return data;
};

/** Queues a clearly-labelled [TEST] message. The response says `queued`, never
 *  `sent`; the delivery outcome arrives in the history table once the
 *  dispatcher has actually tried. */
export const sendTestEmail = async (accountId, recipients) => {
  const { data } = await cloudAxios.post(`${base(accountId)}/email/test`, {
    recipients: recipients?.length ? recipients : null,
  });
  return data;
};

// ── Engine ───────────────────────────────────────────────────────────────────
export const getEngineStatus = async (accountId) => {
  const { data } = await cloudAxios.get(`${base(accountId)}/engine`);
  return data;
};

export const runEngineNow = async (accountId) => {
  const { data } = await cloudAxios.post(`${base(accountId)}/engine/run`);
  return data;
};
