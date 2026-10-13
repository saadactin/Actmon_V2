/**
 * Presentation model for Cloud Resource Intelligence. Pure — tested in plain
 * node (intelligenceModel.test.mjs).
 *
 * The vocabulary itself (categories, thresholds, the rule catalog, what cannot
 * be measured) comes from GET /intelligence/meta. This file only decides how
 * things LOOK, plus the three rules a screen full of numbers can quietly break:
 *
 *   1. Unknown is never zero. A missing saving is "N/A" with the reason the
 *      backend gave, never "₹0"; a missing health score is "N/A", never 0/100.
 *   2. A filter survives the URL. A shared link reopens the same list.
 *   3. A card's count and the list it opens are the same query.
 */
import { compact } from './costFormat';

// ── Categories ───────────────────────────────────────────────────────────────
export const CATEGORY_ORDER = [
  'SECURITY', 'COST', 'RIGHTSIZING', 'PERFORMANCE', 'STORAGE', 'NETWORK', 'DATABASE',
  'RELIABILITY', 'AVAILABILITY', 'CONFIGURATION', 'CLEANUP', 'TAGGING', 'COMPLIANCE',
];

export const CATEGORY_META = {
  SECURITY: { label: 'Security', icon: 'shield', tone: 'danger' },
  COST: { label: 'Cost', icon: 'trend', tone: 'warning' },
  RIGHTSIZING: { label: 'Rightsizing', icon: 'gauge', tone: 'accent' },
  PERFORMANCE: { label: 'Performance', icon: 'activity', tone: 'info' },
  STORAGE: { label: 'Storage', icon: 'desktop', tone: 'info' },
  NETWORK: { label: 'Network', icon: 'network', tone: 'info' },
  DATABASE: { label: 'Database', icon: 'database', tone: 'info' },
  RELIABILITY: { label: 'Reliability', icon: 'shield-check', tone: 'warning' },
  AVAILABILITY: { label: 'Availability', icon: 'layers', tone: 'warning' },
  CONFIGURATION: { label: 'Configuration', icon: 'settings2', tone: 'neutral' },
  CLEANUP: { label: 'Cleanup', icon: 'trash', tone: 'neutral' },
  TAGGING: { label: 'Tagging', icon: 'bookmark', tone: 'neutral' },
  COMPLIANCE: { label: 'Compliance', icon: 'report', tone: 'accent' },
};
export const categoryMeta = (c) => CATEGORY_META[c] || { label: c || '—', icon: 'circle', tone: 'neutral' };

export const SIGNAL_META = {
  UNUSED: { label: 'Unused', tone: 'warning' },
  UNDERUTILIZED: { label: 'Underutilized', tone: 'accent' },
  CONSTRAINED: { label: 'Constrained', tone: 'danger' },
  CONFIGURATION: { label: 'Configuration', tone: 'neutral' },
  RISK: { label: 'Risk', tone: 'danger' },
};

export const STATUS_GROUPS = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'SUPPRESSED'];
export const STATUS_META = {
  OPEN: { label: 'Open', tone: 'danger', icon: 'circle' },
  ACKNOWLEDGED: { label: 'Acknowledged', tone: 'warning', icon: 'eye' },
  RESOLVED: { label: 'Resolved', tone: 'success', icon: 'check' },
  SUPPRESSED: { label: 'Suppressed', tone: 'neutral', icon: 'eye-off' },
};
export const statusMeta = (s) => STATUS_META[s] || { label: s || '—', tone: 'neutral', icon: 'circle' };

export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
export const PROVIDERS = ['AWS', 'AZURE', 'OCI'];
export const PROVIDER_LABEL = { AWS: 'AWS', AZURE: 'Azure', OCI: 'OCI' };

export const SAFETY_META = {
  SAFE: { label: 'Safe to apply', tone: 'success', icon: 'shield-check' },
  WITH_CARE: { label: 'Apply with care', tone: 'warning', icon: 'alert' },
  CONFIRM_FIRST: { label: 'Confirm before applying', tone: 'danger', icon: 'lock' },
  UNKNOWN: { label: 'Cannot be determined', tone: 'neutral', icon: 'help' },
};
export const safetyMeta = (v) => SAFETY_META[v] || SAFETY_META.UNKNOWN;

export const CHECK_META = {
  PASS: { label: 'Verified', tone: 'success', icon: 'check' },
  FAIL: { label: 'Failed', tone: 'danger', icon: 'close' },
  UNKNOWN: { label: 'Not verifiable here', tone: 'neutral', icon: 'help' },
};
export const checkMeta = (s) => CHECK_META[s] || CHECK_META.UNKNOWN;

export const CONFIDENCE_META = {
  HIGH: { label: 'High', tone: 'success' },
  MEDIUM: { label: 'Medium', tone: 'warning' },
  LOW: { label: 'Low', tone: 'neutral' },
};
export const confidenceMeta = (c) => CONFIDENCE_META[c] || { label: c || '—', tone: 'neutral' };

// ── Filters ↔ URL ────────────────────────────────────────────────────────────
export const DEFAULT_STATUS = ['OPEN', 'ACKNOWLEDGED'];
const LIST_KEYS = ['category', 'severity', 'provider', 'status', 'source', 'signal'];

export const emptyFilters = () => ({
  category: [], severity: [], provider: [], status: [...DEFAULT_STATUS], source: [],
  signal: [], search: '', has_savings: false, sort: 'severity',
});

/** URLSearchParams → filter state. Unknown values are dropped, not guessed. */
export function parseFilters(params) {
  const get = (k) => (params && typeof params.get === 'function' ? params.get(k) : params?.[k]);
  const out = emptyFilters();
  const allowed = {
    category: CATEGORY_ORDER, severity: SEVERITIES, provider: PROVIDERS, status: STATUS_GROUPS,
    source: ['optimization', 'security'], signal: Object.keys(SIGNAL_META),
  };
  LIST_KEYS.forEach((k) => {
    const raw = get(k);
    if (raw === null || raw === undefined) return;
    out[k] = String(raw).split(',').map((v) => v.trim()).filter((v) => allowed[k].includes(v));
  });
  if (get('status') === 'all') out.status = [...STATUS_GROUPS];
  out.search = get('q') || '';
  out.has_savings = get('savings') === '1';
  const sort = get('sort');
  out.sort = ['severity', 'savings', 'newest', 'resource'].includes(sort) ? sort : 'severity';
  return out;
}

/** Filter state → {param: value} for the URL (defaults omitted). */
export function filtersToParams(f) {
  const out = {};
  LIST_KEYS.forEach((k) => {
    const v = f[k] || [];
    if (k === 'status') {
      const same = v.length === DEFAULT_STATUS.length && DEFAULT_STATUS.every((s) => v.includes(s));
      if (!same) out.status = v.length === STATUS_GROUPS.length ? 'all' : v.join(',');
      return;
    }
    if (v.length) out[k] = v.join(',');
  });
  if (f.search) out.q = f.search;
  if (f.has_savings) out.savings = '1';
  if (f.sort && f.sort !== 'severity') out.sort = f.sort;
  return out;
}

/** Filter state → the API's query params. */
export function toApiFilters(f, { limit = 50, offset = 0 } = {}) {
  return {
    category: f.category, severity: f.severity, provider: f.provider,
    status: f.status?.length ? f.status : DEFAULT_STATUS, source: f.source, signal: f.signal,
    search: f.search?.trim() || undefined, has_savings: f.has_savings || undefined,
    sort: f.sort, limit, offset,
  };
}

/** A summary card's filter, applied as the WHOLE filter (plus the default
 *  status), so the list shows exactly what the card counted. */
export function cardFilters(card) {
  const f = emptyFilters();
  const spec = card?.filter;
  if (!spec) return null;
  LIST_KEYS.forEach((k) => { if (Array.isArray(spec[k])) f[k] = [...spec[k]]; });
  if (spec.has_savings) f.has_savings = true;
  return f;
}

export const toggleIn = (list, value) => (
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
);

// ── Savings ──────────────────────────────────────────────────────────────────
export const SAVINGS_METHOD_LABEL = {
  BILLED: 'billed cost it ends',
  LIST_PRICE: 'provider list price',
};

/** One finding's saving, for a card or the drawer. N/A always has a reason. */
export function savingsView(savings) {
  const s = savings || {};
  if (s.priced && typeof s.amount === 'number') {
    return {
      priced: true,
      text: `${compact(s.amount, s.currency)}/mo`,
      sub: SAVINGS_METHOD_LABEL[s.method] || 'priced',
      reason: null,
    };
  }
  return { priced: false, text: 'N/A', sub: 'not quantified', reason: s.reason || 'No saving is quantified.' };
}

/** The savings card: one line per currency, never summed across them. */
export function savingsTotalView(byCurrency) {
  const entries = Object.entries(byCurrency || {}).filter(([, v]) => typeof v === 'number');
  if (!entries.length) return { text: 'N/A', parts: [] };
  const parts = entries.map(([code, v]) => compact(v, code));
  return { text: parts.join(' · '), parts };
}

// ── Values ───────────────────────────────────────────────────────────────────
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
export function formatBytes(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return 'N/A';
  let n = Number(v);
  let i = 0;
  while (Math.abs(n) >= 1024 && i < BYTE_UNITS.length - 1) { n /= 1024; i += 1; }
  return i === 0 ? `${Math.round(n)} B` : `${n.toFixed(1)} ${BYTE_UNITS[i]}`;
}

/** A y-axis tick: the same value as formatMetric, short enough for the axis
 *  (100%, 3.3G, 26K) so a label is never clipped into a different number. */
export function formatAxisTick(value, unit) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '';
  const n = Number(value);
  const short = (x) => (Math.abs(x) >= 10 || Number.isInteger(x) ? Math.round(x) : x.toFixed(1));
  switch (unit) {
    case 'percent': return `${Math.round(n)}%`;
    case 'bytes': {
      let v = n;
      let i = 0;
      while (Math.abs(v) >= 1024 && i < BYTE_UNITS.length - 1) { v /= 1024; i += 1; }
      return i === 0 ? `${Math.round(v)}B` : `${short(v)}${BYTE_UNITS[i][0]}`;
    }
    case 'ms': return Math.abs(n) >= 1000 ? `${short(n / 1000)}s` : `${Math.round(n)}ms`;
    default:
      if (Math.abs(n) >= 1e6) return `${short(n / 1e6)}M`;
      if (Math.abs(n) >= 1e3) return `${short(n / 1e3)}K`;
      return String(short(n));
  }
}

/** A metric value for a tooltip or a stat. null/undefined is 'N/A', never 0. */
export function formatMetric(value, unit) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'N/A';
  const n = Number(value);
  switch (unit) {
    case 'percent': return `${n.toFixed(1)}%`;
    case 'bytes': return formatBytes(n);
    case 'ms': return `${Math.round(n).toLocaleString()} ms`;
    default: return Math.abs(n) >= 100 || Number.isInteger(n)
      ? Math.round(n).toLocaleString() : n.toFixed(2);
  }
}

// ── Telemetry charts ─────────────────────────────────────────────────────────
// The metrics a drawer charts, in this order, when the resource has them.
export const CHART_ORDER = [
  'cpu_percent', 'memory_percent', 'network_in', 'network_out', 'disk_read_ops',
  'disk_write_ops', 'volume_read_ops', 'volume_write_ops', 'storage_percent', 'dtu_percent',
  'connections', 'connections_opened', 'invocations', 'errors', 'duration_ms', 'throttles',
  'lb_connections', 'lb_requests', 'lb_bytes_in', 'stored_bytes', 'object_count', 'transactions',
  'nat_bytes', 'consumed_rcu', 'consumed_wcu', 'uncommitted_parts',
];

/** [[epoch_s, v], …] → [{t: ms, v}] for recharts, sorted, with the peak
 *  series merged in by timestamp when it was collected. */
export function chartSeries(row) {
  const peaks = new Map((row?.peak_series || []).map(([t, v]) => [t, v]));
  return (row?.series || [])
    .filter((p) => Array.isArray(p) && p.length === 2 && p[1] !== null)
    .map(([t, v]) => ({ t: t * 1000, v, ...(peaks.has(t) ? { peak: peaks.get(t) } : {}) }))
    .sort((a, b) => a.t - b.t);
}

export function orderTelemetry(rows) {
  const rank = (m) => { const i = CHART_ORDER.indexOf(m); return i === -1 ? 99 : i; };
  return [...(rows || [])].sort((a, b) => rank(a.metric) - rank(b.metric));
}

// ── Health ───────────────────────────────────────────────────────────────────
export const healthTone = (score) => {
  if (score === null || score === undefined) return 'neutral';
  if (score >= 80) return 'success';
  if (score >= 50) return 'warning';
  return 'danger';
};
export const healthText = (score) => (score === null || score === undefined ? 'N/A' : `${score}`);

// ── Actions ──────────────────────────────────────────────────────────────────
/** Status changes a finding offers from where it is now. */
export function statusActions(status) {
  switch (status) {
    case 'OPEN':
      return ['ACKNOWLEDGED', 'SUPPRESSED', 'RESOLVED'];
    case 'ACKNOWLEDGED':
      return ['OPEN', 'SUPPRESSED', 'RESOLVED'];
    case 'SUPPRESSED':
    case 'RESOLVED':
      return ['OPEN'];
    default:
      return [];
  }
}
export const ACTION_LABEL = {
  ACKNOWLEDGED: 'Acknowledge', SUPPRESSED: 'Suppress', RESOLVED: 'Mark resolved', OPEN: 'Reopen',
};
export const ACTION_ICON = { ACKNOWLEDGED: 'eye', SUPPRESSED: 'eye-off', RESOLVED: 'check', OPEN: 'restart' };
export const needsReason = (status) => status === 'SUPPRESSED';

/** A card's status group — security findings carry the Security Center's own
 *  status too, which is what the card prints. */
export const statusGroupOf = (card) => card?.status_group || card?.status;

// ── Links ────────────────────────────────────────────────────────────────────
/** Resolve the backend's hand-off links against this account's route. */
export function resolveLinks(links, accountRoute) {
  if (!links) return {};
  const tab = (l) => (l && accountRoute ? `${accountRoute}/${l.tab}${l.query || ''}` : null);
  const alert = links.alert && accountRoute
    ? `${accountRoute}/alerts?newRule=${encodeURIComponent(links.alert.condition)}`
      + `&config=${encodeURIComponent(JSON.stringify(links.alert.config || {}))}`
    : null;
  return {
    resource: links.resource || null,
    monitoring: links.monitoring || null,
    cost: tab(links.cost),
    drift: tab(links.drift),
    events: tab(links.events),
    topology: tab(links.topology),
    alert,
  };
}

// ── History ──────────────────────────────────────────────────────────────────
export const EVENT_LABEL = {
  detected: 'Detected',
  severity_changed: 'Severity changed',
  acknowledged: 'Acknowledged',
  suppressed: 'Suppressed',
  marked_resolved: 'Marked resolved',
  reopened: 'Reopened',
  resolved: 'Resolved',
};

export function timelineView(history) {
  return [...(history || [])]
    .filter((e) => e && e.at)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .map((e) => ({
      at: e.at,
      label: EVENT_LABEL[e.event] || String(e.event || '').replace(/_/g, ' '),
      by: e.by && e.by !== 'analysis' ? e.by : (e.by === 'analysis' ? 'Analysis' : null),
      detail: e.detail || null,
    }));
}

export const RESOLUTION_LABEL = {
  condition_cleared: 'Re-checked: the condition is no longer present',
  resource_removed: 'The resource no longer exists',
  marked_by_user: 'Marked resolved by a person',
};

/** The "last re-check" line for an open finding. */
export function lastCheckText(lastCheck) {
  if (!lastCheck?.verdict) return null;
  switch (lastCheck.verdict) {
    case 'FINDING': return 'Re-confirmed by the latest analysis.';
    case 'INSUFFICIENT_DATA':
      return `The latest analysis could not re-check it${lastCheck.reason ? `: ${lastCheck.reason}` : '.'}`
        + ' It stays open until a re-check decides.';
    case 'NOT_EVALUATED':
      return 'The latest analysis did not reach this resource (an incomplete sweep, or it was not '
        + 'in the inventory). It stays open until a re-check decides.';
    default:
      return null;
  }
}
