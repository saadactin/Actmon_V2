/**
 * Pure logic behind the account refresh UI.
 *
 * Lives outside the hooks and components so it can be tested in plain node —
 * the invalidation predicate in particular is the kind of code that fails
 * silently when it is wrong (nothing refetches, and the only symptom is that
 * the user goes back to pressing F5), so it is worth testing directly.
 */

export const TERMINAL_STATUSES = ['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED'];
export const ACTIVE_STATUSES = ['QUEUED', 'RUNNING'];

export const isTerminal = (status) => TERMINAL_STATUSES.includes(status);
export const isActive = (status) => ACTIVE_STATUSES.includes(status);

/**
 * The one name. Every control that re-reads an account from its provider says
 * this, and they all start the same backend refresh — resources, cost,
 * security (with certificates and identity), drift and events in one pass.
 * There used to be six: Refresh Account, Run Discovery Scan, Run, Run
 * assessment, Collect now and Retry, each refreshing a different slice.
 */
export const REFRESH_ALL_LABEL = 'Refresh all';
export const REFRESH_ALL_BUSY_LABEL = 'Refreshing…';
export const REFRESH_ALL_TITLE = 'Re-read this account from the provider — resources, cost, '
  + 'security, certificates, identity, drift and events — and update every tab.';

/** Is the account's data being rewritten right now — by a refresh, or by a
 *  plain discovery scan (onboarding starts those), which rewrites the same
 *  data. Either one makes a second start pointless and is refused. */
export const isBusy = (latest) => !!(latest && (latest.is_busy ?? latest.is_running));

/** What the running work is, for the status line. Stage-based, never a
 *  percentage. `live` is the watched refresh record, fresher than latest. */
export function busyView(latest, live) {
  const current = live && isActive(live.status) ? live : latest?.current;
  if (current && isActive(current.status)) {
    const p = componentProgress(current.components);
    // The refresh's own sweep, while it runs: a count the backend has
    // actually committed, never an estimate of the total.
    const found = latest?.current_scan?.resources_found;
    return {
      kind: 'refresh',
      components: current.components || null,
      text: (p.total
        ? `${p.done} of ${p.total}${p.running ? ` · ${p.running}` : ''}`
        : 'Refreshing this account…')
        + (found ? ` · ${found.toLocaleString()} found so far` : ''),
    };
  }
  const scan = latest?.active_scan;
  if (scan) {
    return {
      kind: 'scan',
      components: null,
      text: scan.resources_found
        ? `Scanning · ${scan.resources_found.toLocaleString()} found so far`
        : 'Scanning this account…',
    };
  }
  return null;
}

/** The "Last refreshed" line, from latest.last_refreshed — the newest data
 *  pull by any route. PARTIAL carries the reason, because "partial" alone
 *  cannot tell someone whether the number they are about to act on is fresh. */
export function lastRefreshedView(latest) {
  const last = latest?.last_refreshed;
  if (!last?.at) return { at: null, partial: false, detail: null };
  const scopes = last.scopes_attempted
    ? `${Number(last.scopes_read ?? 0).toLocaleString()} of `
      + `${Number(last.scopes_attempted).toLocaleString()} scopes read`
    : null;
  return {
    at: last.at,
    partial: last.status === 'PARTIAL',
    detail: [scopes, last.note].filter(Boolean).join(' — ') || null,
  };
}

/**
 * Should this account's tabs re-read, given the data version last acted on
 * and the one just observed?
 *
 * `data_version` is the newest server-side write that changes what the tabs
 * show (a finished refresh, a finished sweep, a security assessment).
 * Comparing two SERVER timestamps is deliberate: comparing one against a
 * query's browser-clock `dataUpdatedAt` would miss a refresh whenever the
 * browser's clock runs ahead of the server's.
 *
 * The first sighting only records it — nothing this session has cached for
 * the account can predate a version it has never seen change.
 */
export function syncDecision(seen, next) {
  const nextMs = next ? Date.parse(next) : NaN;
  if (!Number.isFinite(nextMs)) return { invalidate: false, remember: false };
  if (!seen) return { invalidate: false, remember: true };
  const seenMs = Date.parse(seen);
  if (!Number.isFinite(seenMs) || nextMs > seenMs) return { invalidate: true, remember: true };
  return { invalidate: false, remember: false };
}

/** Why a start was refused, from the 409 body — or null for a real error.
 *  "Busy" is not an error to apologise for: the account IS being refreshed. */
export function busyRefusal(error) {
  const detail = error?.response?.data?.detail;
  if (error?.response?.status !== 409 || !detail) return null;
  if (detail.refresh?.refresh_id) return { kind: 'refresh', refreshId: detail.refresh.refresh_id };
  if (detail.scan?.job_id) return { kind: 'scan', jobId: detail.scan.job_id };
  return null;
}

/**
 * The query-key roots a completed refresh makes stale.
 *
 * Written out rather than inferred, and taken from the hooks that actually
 * build these keys — a prefix guessed wrong invalidates nothing and fails
 * silently, which would quietly reintroduce the F5 this feature exists to
 * remove. Each root below appears verbatim as `queryKey[0]` somewhere in
 * `features/cloud/hooks`.
 */
export const REFRESHED_ROOTS = [
  // Overview panels: inventory, posture, cost total/series, changes, events,
  // topology, discovery, recent resources, top cost.
  'cloudOverview',
  // Resources workspace.
  'cloudResources', 'resources', 'resourceDetail', 'resourceDrift',
  'inventoryHistory',
  // Security Center (ROOT = ['securityCenter']) plus the standalone analyses.
  'securityCenter', 'internetExposure', 'iamReview',
  // Certificates / secrets / keys: every discovery re-reads the stores, so an
  // account's inventory (keyed certificates / account / id) is stale after one.
  'certificates',
  // Cost Intelligence.
  'costSummary', 'costAnalytics', 'costHistory', 'costTrends', 'costAnomalies',
  'costAllocation', 'costForecast', 'costCoverage', 'costQuality', 'costReport',
  'costReportTypes', 'costGovernance', 'costExecutiveReport', 'costCapabilities',
  'costBudgetStatus',
  // Config drift.
  'driftChanges', 'driftSummary', 'driftFacets',
  // Event log.
  'cloudEvents', 'cloudEventStats', 'cloudEventFacets', 'cloudEventTimeline',
  'cloudEventSources', 'cloudEventCollection', 'cloudEventsForResource',
  // Topology and alerts.
  'topology', 'cloudAlerts',
  // Per-account diagnostics.
  'accountDiagnostics',
  // Resource Intelligence: every refresh ends with an analysis.
  'intelligence',
];

const ROOT_SET = new Set(REFRESHED_ROOTS);

/**
 * Does this value mention the account, at any depth?
 *
 * Keys are built inconsistently across the feature — sometimes the id is a
 * bare element (`['cloudOverview', 'posture', id]`), sometimes it sits inside
 * a filter object (`['cloudEvents', { account_id: id }, …]`) — so the check
 * has to look inside objects rather than only at top-level parts.
 */
export function mentionsAccount(value, accountId, depth = 0) {
  if (!accountId || depth > 4 || value === null || value === undefined) return false;
  if (typeof value === 'string') return value === accountId;
  if (Array.isArray(value)) {
    return value.some((v) => mentionsAccount(v, accountId, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.values(value).some((v) => mentionsAccount(v, accountId, depth + 1));
  }
  return false;
}

/**
 * Should a completed refresh of `accountId` invalidate this query?
 *
 * Both conditions matter. The root check keeps unrelated caches (settings,
 * saved queries, the app shell) alive. The account check is what stops
 * refreshing AWS Production from making every other account refetch — which
 * on an estate with a dozen accounts would turn one refresh into a dozen
 * rounds of provider-backed requests.
 */
export function shouldInvalidate(queryKey, accountId) {
  if (!Array.isArray(queryKey) || !accountId) return false;
  if (!ROOT_SET.has(queryKey[0])) return false;
  return mentionsAccount(queryKey.slice(1), accountId);
}

/** Per-component counts for a refresh record, for a stage-based progress
 *  line. Deliberately returns counts and names — never a percentage, because
 *  the backend does not know how far through a provider sweep it is. */
export function componentProgress(components) {
  const entries = Object.entries(components || {});
  const done = entries.filter(([, c]) => (
    ['SUCCEEDED', 'FAILED', 'SKIPPED'].includes(c.status)
  ));
  const running = entries.find(([, c]) => c.status === 'RUNNING');
  return {
    total: entries.length,
    done: done.length,
    running: running ? (running[1].label || running[0]) : null,
    failed: entries.filter(([, c]) => c.status === 'FAILED')
      .map(([, c]) => c.label),
    skipped: entries.filter(([, c]) => c.status === 'SKIPPED')
      .map(([, c]) => c.label),
    // Ran, but read only part of the account (a sweep of 218 of 272 scopes).
    incomplete: entries.filter(([, c]) => c.status === 'SUCCEEDED' && c.incomplete)
      .map(([, c]) => c.label),
  };
}

/**
 * The sentence shown when a refresh finishes.
 *
 * PARTIAL names what could not be refreshed, because "partially successful" on
 * its own leaves the user unable to tell whether the number they are about to
 * act on was updated. FAILED says the old data was kept, because the most
 * common fear at that moment is that the failure destroyed something.
 */
export function outcomeMessage(refresh) {
  if (!refresh) return null;
  const { failed, skipped, incomplete } = componentProgress(refresh.components);
  const names = [...failed, ...skipped];
  switch (refresh.status) {
    case 'SUCCEEDED':
      return 'Account refresh completed.';
    case 'PARTIAL':
      if (incomplete.length) {
        return `Refreshed, but ${[
          names.length ? `${list(names)} could not be updated` : null,
          `${list(incomplete)} read only part of the account`,
        ].filter(Boolean).join(', and ')}. Previous data was kept for what was not read.`;
      }
      return names.length
        ? `Refreshed, but ${list(names)} could not be updated. Previous data was kept.`
        : 'Refreshed, but some components could not be updated. Previous data was kept.';
    case 'FAILED':
      return refresh.error
        ? `Account refresh failed: ${refresh.error} Existing data was kept.`
        : 'Account refresh failed. Existing data was kept.';
    case 'CANCELLED':
      return 'Account refresh was cancelled. Existing data was kept.';
    default:
      return null;
  }
}

const list = (items) => (
  items.length <= 1 ? (items[0] || '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
);
