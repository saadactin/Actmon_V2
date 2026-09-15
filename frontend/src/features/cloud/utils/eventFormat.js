/**
 * Shared presentation helpers for the Event Log.
 *
 * The timezone handling here is the load-bearing part. Events are stored and
 * transported in UTC, always; they are converted for display exactly once, at
 * the point of rendering, and the display always says which zone it is in.
 * Silently mixing the two is how an audit trail ends up quietly an hour wrong,
 * which is worse than being obviously wrong.
 */

/** Risk level → status tone. Five levels collapse onto the four tones the
    design system defines, so HIGH and CRITICAL share `danger` and are
    distinguished by their label rather than by an invented sixth colour. */
export const RISK_TONE = {
  CRITICAL: 'danger',
  HIGH: 'danger',
  MEDIUM: 'warning',
  LOW: 'info',
  INFO: 'neutral',
};

export const RISK_ORDER = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export const STATUS_TONE = {
  Success: 'success',
  Failed: 'danger',
  Denied: 'danger',
  Partial: 'warning',
  Unknown: 'neutral',
};

/** Provider brand colours are pinned (external identity) — the same rationale
    as CloudDashboard's PROVIDER_BADGE_CLASSES. Never tokenized. */
export const PROVIDER_BADGE_CLASSES = {
  AWS: 'bg-orange-50 text-orange-700 border-orange-200',
  Azure: 'bg-sky-50 text-sky-700 border-sky-200',
  OCI: 'bg-red-50 text-red-700 border-red-200',
  Oracle: 'bg-red-50 text-red-700 border-red-200',
};

/** The named time ranges, matching the backend's own vocabulary exactly so a
    UI choice cannot describe a window the API will not honour. */
export const TIME_RANGES = [
  { id: '15m', label: 'Last 15 minutes' },
  { id: '1h', label: 'Last 1 hour' },
  { id: '6h', label: 'Last 6 hours' },
  { id: '12h', label: 'Last 12 hours' },
  { id: '24h', label: 'Last 24 hours' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: '90d', label: 'Last 90 days' },
  { id: '365d', label: 'Last 365 days' },
];

export const DEFAULT_RANGE = '24h';

/**
 * A named range as a whole number of hours — what "Collect now" asks the
 * provider to fetch.
 *
 * This exists because the time-range selector filters events that are ALREADY
 * stored; it does not, on its own, make the collector reach further back. So
 * selecting "7 days" and pressing Collect now used to fetch only new events,
 * and there was no way to back-fill at all. Passing the selected window as the
 * collection lookback makes the button mean what the range says.
 *
 * Rounded UP to the hour, and at least 1: the API takes whole hours, and asking
 * for 0 would be rejected.
 */
export const RANGE_HOURS = {
  '15m': 1,
  '1h': 1,
  '6h': 6,
  '12h': 12,
  '24h': 24,
  '7d': 168,
  '30d': 720,
  '90d': 2160,
  '365d': 8760,
};

/** Hours to ask the collector for, given the current scope selection. */
export function collectionLookbackHours({ range, useCustom, start, end }) {
  if (useCustom && start) {
    const from = new Date(start).getTime();
    const to = end ? new Date(end).getTime() : Date.now();
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
      // The provider is asked for "the last N hours", so a custom window that
      // ends in the past still has to reach back from now to cover it.
      return Math.max(1, Math.ceil((Date.now() - from) / 3_600_000));
    }
  }
  return RANGE_HOURS[range] ?? RANGE_HOURS[DEFAULT_RANGE];
}

/** The categories the chip row offers. `''` is All. */
export const CATEGORY_CHIPS = [
  { id: '', label: 'All' },
  { id: 'Authentication', label: 'Authentication' },
  { id: 'IAM', label: 'IAM' },
  { id: 'Security', label: 'Security' },
  { id: 'Network', label: 'Network' },
  { id: 'Compute', label: 'Compute' },
  { id: 'Storage', label: 'Storage' },
  { id: 'Database', label: 'Database' },
  { id: 'Configuration', label: 'Configuration' },
  { id: 'DataAccess', label: 'Data access' },
  { id: 'Authorization', label: 'Authorization' },
  { id: 'ResourceManagement', label: 'Resource mgmt' },
  { id: 'Monitoring', label: 'Monitoring' },
  { id: 'Logging', label: 'Logging' },
  { id: 'Billing', label: 'Billing' },
  { id: 'Other', label: 'Other' },
];

export const ACTOR_TYPE_OPTIONS = [
  { id: '', label: 'All actor types' },
  { id: 'Human', label: 'Human user' },
  { id: 'RootAccount', label: 'Root / tenancy admin' },
  { id: 'IAMRole', label: 'Assumed IAM role' },
  { id: 'ServicePrincipal', label: 'Service principal' },
  { id: 'ServiceAccount', label: 'Service account' },
  { id: 'CloudService', label: 'Cloud service' },
  { id: 'AutomatedProcess', label: 'Automated process' },
  { id: 'Unknown', label: 'Unidentified' },
];

export const ACTION_OPTIONS = [
  { id: '', label: 'All actions' },
  ...[
    'Create', 'Update', 'Delete', 'Modify', 'Read', 'Login', 'Logout',
    'Attach', 'Detach', 'Start', 'Stop', 'Reboot', 'Authorize', 'Revoke',
    'Enable', 'Disable', 'Associate', 'Disassociate', 'Invoke', 'Deploy',
    'Scale', 'Other',
  ].map((id) => ({ id, label: id })),
];

export const STATUS_OPTIONS = [
  { id: '', label: 'All statuses' },
  { id: 'Success', label: 'Success' },
  { id: 'Failed', label: 'Failed' },
  { id: 'Denied', label: 'Denied' },
  { id: 'Partial', label: 'Partial (in flight)' },
  { id: 'Unknown', label: 'Unknown' },
];

export const RISK_OPTIONS = [
  { id: '', label: 'Any risk' },
  { id: 'CRITICAL', label: 'Critical only' },
  { id: 'HIGH', label: 'High only' },
  { id: 'MEDIUM', label: 'Medium only' },
  { id: 'LOW', label: 'Low only' },
  { id: 'INFO', label: 'Informational only' },
];

export const MIN_RISK_OPTIONS = [
  { id: '', label: 'Any risk' },
  { id: 'CRITICAL', label: 'Critical' },
  { id: 'HIGH', label: 'High and above' },
  { id: 'MEDIUM', label: 'Medium and above' },
  { id: 'LOW', label: 'Low and above' },
];

export const SORT_OPTIONS = [
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'risk', label: 'Highest risk' },
  { id: 'actor', label: 'Actor' },
  { id: 'resource', label: 'Resource' },
  { id: 'provider', label: 'Provider' },
  { id: 'status', label: 'Status' },
  { id: 'event_type', label: 'Event type' },
  { id: 'category', label: 'Category' },
];

export const PAGE_SIZE_OPTIONS = [25, 50, 100, 250, 500]
  .map((n) => ({ id: String(n), label: `${n} per page` }));

/**
 * The viewer's timezone, named.
 *
 * Shown beside every timestamp so nobody has to guess. `resolvedOptions()`
 * gives the IANA name (Asia/Kolkata); the short form (IST) comes from
 * formatting a date, because Intl has no direct accessor for the abbreviation.
 */
export function localZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  } catch {
    return 'local time';
  }
}

export function localZoneAbbrev() {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value || '';
  } catch {
    return '';
  }
}

/**
 * An event timestamp for display, in the viewer's own timezone.
 *
 * `08-Sep-2026 14:32:11` — day-month-year because that is what the rest of this
 * product uses, and seconds included because an audit trail is read at
 * second granularity when correlating two events.
 */
export function formatEventTime(iso, { withZone = true } = {}) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  const day = String(date.getDate()).padStart(2, '0');
  const month = date.toLocaleString('en-GB', { month: 'short' });
  const year = date.getFullYear();
  const time = date.toLocaleTimeString('en-GB', { hour12: false });
  const zone = withZone ? ` ${localZoneAbbrev()}` : '';
  return `${day}-${month}-${year} ${time}${zone}`.trim();
}

/** Just the clock part, for a dense table column. */
export function formatEventClock(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-GB', { hour12: false });
}

export function formatEventDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const day = String(date.getDate()).padStart(2, '0');
  return `${day}-${date.toLocaleString('en-GB', { month: 'short' })}`;
}

/** The same instant in UTC, spelled out — for the tooltip beside a local time,
    so the two are always visible together rather than one being implied. */
export function formatUtc(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

export function relativeTime(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : formatEventDate(iso);
}

/** A count with thousands separators, for the summary cards. */
export function formatCount(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString();
}

/**
 * Collection status → tone and label.
 *
 * "Partial" is its own state on purpose: some scopes working and some failing
 * is neither Connected nor down, and reporting it as either misleads.
 */
export const SOURCE_STATUS_META = {
  Connected: { tone: 'success', label: 'Connected' },
  Syncing: { tone: 'info', label: 'Syncing' },
  Delayed: { tone: 'warning', label: 'Catching up' },
  Partial: { tone: 'warning', label: 'Partially available' },
  AuthenticationFailed: { tone: 'danger', label: 'Authentication failed' },
  PermissionDenied: { tone: 'danger', label: 'Permission denied' },
  Unavailable: { tone: 'danger', label: 'Unavailable' },
  Disabled: { tone: 'neutral', label: 'Disabled' },
  NeverRun: { tone: 'neutral', label: 'Never collected' },
};

/** What an operator should do about a given collection state. Stated because a
    red badge with no next step just tells someone to worry. */
export const SOURCE_STATUS_ADVICE = {
  AuthenticationFailed:
    'The stored credentials were rejected. Rotate or re-enter them on the cloud account.',
  PermissionDenied:
    'The credentials are valid but may not read the audit API. AWS needs '
    + 'cloudtrail:LookupEvents, Azure needs Reader on the subscription, OCI needs '
    + 'an audit-events read policy on the compartment.',
  Unavailable:
    'The provider could not be reached. This says nothing about the credentials — '
    + 'it is a network or provider-side failure, and collection will retry.',
  NeverRun:
    'No collection has run for this source yet. Use "Collect now" to fetch the '
    + 'first window.',
  Delayed:
    'A collection stopped at its per-run page budget and will continue from where '
    + 'it left off. Recent events may not have arrived yet.',
  Partial:
    'Some collection scopes are failing while others succeed, so the feed is '
    + 'incomplete. Open Collection health for the per-scope errors.',
};
