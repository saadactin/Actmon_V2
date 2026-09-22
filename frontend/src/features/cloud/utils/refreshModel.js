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
  const { failed, skipped } = componentProgress(refresh.components);
  const names = [...failed, ...skipped];
  switch (refresh.status) {
    case 'SUCCEEDED':
      return 'Account refresh completed.';
    case 'PARTIAL':
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
