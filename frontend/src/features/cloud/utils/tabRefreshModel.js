/**
 * What each tab's own "Refresh" does.
 *
 * The account header keeps its one "Refresh all", which re-reads everything
 * from the provider in one pass. Each tab also has a refresh of its own, and
 * every one of them is the same button with the same shape of name —
 * "Refresh <tab>" — beside the tab strip. What they must not do again is what
 * the six old buttons did: hide behind different names, or claim more than
 * they did. So each tab's refresh is declared here, once, with the truth about
 * where its data comes from:
 *
 *   provider  re-reads this tab's slice from the cloud provider
 *             (certificates, identity grants, billing, events, the inventory)
 *   assess    re-evaluates the stored inventory — no provider call, seconds
 *   reload    re-reads what ACTMON already stored; nothing is fetched. For
 *             tabs whose data is DERIVED from the last sweep (topology,
 *             drift) there is nothing narrower to re-collect.
 *
 * The caption after a run says which of those happened, so "Refresh topology"
 * can never be read as "the topology was just checked against OCI".
 *
 * Pure, so it is tested in plain node (tabRefreshModel.test.mjs).
 */

export const SOURCE_PROVIDER = 'provider';
export const SOURCE_ASSESS = 'assess';
export const SOURCE_STORED = 'stored';

/** action → where the data comes from, how long it takes, what it says. */
export const TAB_REFRESH_ACTIONS = {
  reload: {
    source: SOURCE_STORED,
    background: false,
    title: 'Re-read this tab from the data ACTMON already holds. Nothing is fetched '
      + 'from the provider — use Refresh all for that.',
  },
  discovery: {
    source: SOURCE_PROVIDER,
    // Minutes, so it runs on the backend and the header shows its progress.
    background: true,
    title: 'Re-read the inventory from the provider (a discovery scan, several minutes). '
      + 'Drift, topology and security update from it when it finishes; progress shows '
      + 'in the header. Event collection is only part of Refresh all.',
  },
  cost: {
    source: SOURCE_PROVIDER,
    background: false,
    title: 'Re-query this account\'s billing from the provider and re-store the last '
      + '30 days. Takes up to a minute.',
  },
  assess: {
    source: SOURCE_ASSESS,
    background: false,
    title: 'Re-evaluate security against the stored inventory — seconds, no provider '
      + 'call. To re-read the inventory itself, use Refresh all.',
  },
  identity: {
    source: SOURCE_PROVIDER,
    background: false,
    title: 'Re-read identity grants from the provider (Azure role assignments; AWS and '
      + 'OCI identities come with the inventory), then re-evaluate security.',
  },
  certificates: {
    source: SOURCE_PROVIDER,
    background: false,
    title: 'Re-read every certificate, secret and key store from the provider, then '
      + 're-evaluate security. Metadata only — never a secret value.',
  },
  events: {
    source: SOURCE_PROVIDER,
    background: false,
    title: 'Collect new audit events from the provider, from where the last collection '
      + 'stopped.',
  },
  analysis: {
    source: SOURCE_PROVIDER,
    background: false,
    title: 'Read 30 days of telemetry from the provider\'s monitoring API, refresh each '
      + 'resource\'s billed cost, and re-analyse. A minute or two on most accounts; the '
      + 'inventory itself is re-read only by Refresh all.',
  },
};

/**
 * Every tab that shows a refresh, keyed as the tab strips key them. Security
 * Center sub-tabs are `security.<id>`; the Security Center's own main-tab slot
 * has none, because its sub-tab strip carries the more specific one — two
 * refresh buttons for one screen is how the old confusion started.
 */
export const TAB_REFRESH = {
  overview: { noun: 'overview', action: 'reload' },
  intelligence: { noun: 'intelligence', action: 'analysis' },
  resources: { noun: 'resources', action: 'discovery' },
  cost: { noun: 'cost', action: 'cost' },
  topology: { noun: 'topology', action: 'reload' },
  drift: { noun: 'drift', action: 'reload' },
  events: { noun: 'events', action: 'events' },
  alerts: { noun: 'alerts', action: 'reload' },

  'security.overview': { noun: 'security', action: 'assess' },
  'security.findings': { noun: 'findings', action: 'assess' },
  'security.alerts': { noun: 'security alerts', action: 'assess' },
  'security.compliance': { noun: 'compliance', action: 'assess' },
  'security.exposure': { noun: 'exposure', action: 'assess' },
  'security.identity': { noun: 'identity', action: 'identity' },
  'security.certificates': { noun: 'certificates', action: 'certificates' },
  'security.coverage': { noun: 'coverage', action: 'assess' },
  'security.trends': { noun: 'trends', action: 'assess' },
};

/** Main tabs whose refresh lives in their own sub-tab strip instead. */
export const DELEGATED_TABS = ['security', 'compliance'];

export const tabRefreshLabel = (noun) => `Refresh ${noun}`;

/**
 * The refresh a tab offers this viewer, right now.
 *
 * `canExecute` — may this person start provider work? Someone who may only
 * view still gets a refresh: the stored-data reload, which changes nothing.
 * `busy` — is a Refresh all or a discovery scan rewriting the account? Then
 * provider and assess work is held (the backend would refuse or race it),
 * while a reload still works: it is how you see what the running refresh has
 * written so far.
 *
 * Returns null for a tab with no refresh of its own.
 */
export function tabRefreshPlan(tabKey, { canExecute = false, busy = false } = {}) {
  const entry = TAB_REFRESH[tabKey];
  if (!entry) return null;
  const action = canExecute ? entry.action : 'reload';
  const meta = TAB_REFRESH_ACTIONS[action];
  const held = busy && action !== 'reload';
  return {
    tabKey,
    action,
    label: tabRefreshLabel(entry.noun),
    source: meta.source,
    background: meta.background,
    disabled: held,
    title: held
      ? 'Refresh all (or a discovery scan) is running for this account and already '
        + 're-reading this tab. It updates when that finishes.'
      : meta.title,
  };
}

/** The caption shown after a tab refresh finishes. Says WHERE the data came
 *  from, and never reports more than the response confirmed. */
export function tabRefreshOutcome(action, result) {
  const r = result || {};
  switch (action) {
    case 'reload':
      return 'Re-read stored data';
    case 'discovery':
      return 'Scan started — progress is in the header';
    case 'assess':
      return typeof r.findings === 'number'
        ? `Re-evaluated · ${r.findings.toLocaleString()} findings`
        : 'Re-evaluated stored inventory';
    case 'identity': {
      const status = r.identity?.status;
      if (status === 'Collected') return `Read ${Number(r.identity.grants || 0).toLocaleString()} grants from the provider`;
      if (status === 'NotSupported') return 'Re-evaluated · identities come with the inventory';
      if (status) return `Provider refused (${status}) · kept last known grants`;
      return 'Re-read from the provider';
    }
    case 'certificates':
      return typeof r.objects === 'number'
        ? `Read ${r.objects.toLocaleString()} objects from the provider`
          + (r.scopes_failed ? ` · ${r.scopes_failed} stores could not be read` : '')
        : 'Re-read from the provider';
    case 'events':
      return typeof r.events_stored === 'number'
        ? `Collected ${r.events_stored.toLocaleString()} new events`
          + (r.scopes_failed ? ` · ${r.scopes_failed} scopes failed` : '')
        : 'Collected from the provider';
    case 'analysis': {
      if (typeof r.open !== 'number') return 'Re-analysed from provider telemetry';
      const bits = [`${r.open.toLocaleString()} open`];
      if (r.findings?.new) bits.push(`${r.findings.new} new`);
      if (r.findings?.resolved) bits.push(`${r.findings.resolved} resolved`);
      return `Re-analysed · ${bits.join(' · ')}${r.outcome === 'PARTIAL' ? ' · partial' : ''}`;
    }
    case 'cost': {
      const ing = r.ingestion;
      if (ing && ing.ok === false) {
        const msg = typeof ing.error === 'object' ? ing.error?.message : ing.error;
        return `Provider refused billing · kept last known cost${msg ? ` (${String(msg).slice(0, 80)})` : ''}`;
      }
      if (ing && ing.ok) {
        return `Re-read billing · ${Number(ing.inserted || 0).toLocaleString()} written, `
          + `${Number(ing.updated || 0).toLocaleString()} corrected`;
      }
      return 'Re-read billing from the provider';
    }
    default:
      return 'Refreshed';
  }
}

/** A failed tab refresh, as one line. A 409 is not a failure: something is
 *  already doing the work. */
export function tabRefreshError(error) {
  const status = error?.response?.status;
  const detail = error?.response?.data?.detail;
  if (status === 409) {
    return 'Already running for this account — this tab updates when it finishes';
  }
  const msg = (typeof detail === 'object' ? detail?.message : detail) || error?.message;
  return msg ? `Refresh failed · ${String(msg).slice(0, 140)}` : 'Refresh failed';
}
