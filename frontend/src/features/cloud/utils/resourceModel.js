/**
 * Presentation model for the Resources workspace.
 *
 * Two rules shape this file.
 *
 * 1. **The backend owns the vocabulary.** Statuses, categories, risk levels and
 *    the resource-type registry all arrive from /resources/reference. This file
 *    maps them to tones and icons; it does not decide which types exist. The
 *    table this replaces kept its own map of ~60 resource types while the
 *    scanners had grown to 115, so a third of the estate rendered as "generic"
 *    and nobody could see that it had.
 *
 * 2. **Absent is not zero, and unknown is not healthy.** A resource whose state
 *    the provider never reported reads as "Not reported" in a neutral tone —
 *    never green, never counted as running. Cost formatting is delegated to
 *    costFormat.js, which already enforces the same rule for money.
 */
import {
  Activity, BarChart3, Bot, BookOpen, Cable, Cloud, Container, Database,
  FolderOpen, Globe, HardDrive, Inbox, Lock, Megaphone, Milestone, Network,
  Route, Scale, Server, Settings, Shield, ShieldAlert, SquareFunction, User,
  Workflow, Zap,
} from 'lucide-react';
import { exact, isMissing, NA } from './costFormat';

export { NA };

/** Backend icon slug → lucide component. The slugs come from the type registry
 *  in app/services/resource_model.py; anything unmapped falls back to a generic
 *  cloud mark rather than disappearing. */
const ICONS = {
  activity: Activity,
  book: BookOpen,
  brain: Bot,
  cable: Cable,
  chart: BarChart3,
  cloud: Cloud,
  container: Container,
  database: Database,
  folder: FolderOpen,
  function: SquareFunction,
  globe: Globe,
  'hard-drive': HardDrive,
  inbox: Inbox,
  lock: Lock,
  megaphone: Megaphone,
  milestone: Milestone,
  network: Network,
  route: Route,
  scale: Scale,
  server: Server,
  settings: Settings,
  shield: Shield,
  'shield-alert': ShieldAlert,
  user: User,
  workflow: Workflow,
  zap: Zap,
};

/** Tone per category, so a row's icon avatar and its type pill agree. */
const CATEGORY_TONE = {
  COMPUTE: 'info',
  STORAGE: 'warning',
  DATABASE: 'success',
  NETWORK: 'accent',
  SECURITY: 'neutral',
  IDENTITY: 'neutral',
  SERVERLESS: 'info',
  CONTAINER: 'warning',
  ANALYTICS: 'info',
  AI_ML: 'success',
  INTEGRATION: 'neutral',
  MONITORING: 'info',
  MANAGEMENT: 'neutral',
  OTHER: 'neutral',
};

export const typeIcon = (slug) => ICONS[slug] || Cloud;
export const categoryTone = (category) => CATEGORY_TONE[category] || 'neutral';

/**
 * Normalized status → how it reads.
 *
 * PROVISIONING is deliberately not green. Azure's `Succeeded` means ARM
 * finished building the resource and says nothing about whether it is running;
 * 57 of this estate's 75 Azure VMs sit in exactly that state, so treating it as
 * "on" would paint most of the fleet healthy on no evidence.
 *
 * UNKNOWN is neutral with an explicit label, never a hopeful default.
 */
export const STATUS_META = {
  RUNNING: { label: 'Running', tone: 'success', dot: true },
  AVAILABLE: { label: 'Available', tone: 'success', dot: true },
  ATTACHED: { label: 'Attached', tone: 'success', dot: true },
  PROVISIONING: { label: 'Provisioning', tone: 'info', dot: true },
  UNATTACHED: { label: 'Unattached', tone: 'warning', dot: true },
  DEGRADED: { label: 'Degraded', tone: 'warning', dot: true },
  STOPPED: { label: 'Stopped', tone: 'danger', dot: true },
  FAILED: { label: 'Failed', tone: 'danger', dot: true },
  DELETED: { label: 'Deleted', tone: 'neutral', dot: true },
  UNKNOWN: { label: 'Not reported', tone: 'neutral', dot: false },
};

export const statusMeta = (status) => STATUS_META[status]
  || { label: status || 'Not reported', tone: 'neutral', dot: false };

/**
 * Tone for a RAW provider word, where no normalized status is available.
 *
 * Only for places that display a provider string directly — a nested state in a
 * config panel, say. Prefer `statusMeta(normalized_status)`: the backend has the
 * resource type and config, which is what it takes to read these words
 * correctly.
 *
 * The rule here is that an unrecognised word is neutral, never red. The version
 * this replaces returned 'danger' for everything it did not recognise, so
 * Azure's `Succeeded` — which means ARM finished building the resource —
 * rendered as a failure.
 */
const RAW_GOOD = /^(running|active|available|succeeded|ready|online|healthy|attached|provisioned|in[-_ ]?service)$/i;
const RAW_BAD = /^(failed|error|terminated|deleting|deleted|unhealthy|degraded)$/i;
const RAW_BUSY = /^(pending|starting|stopping|creating|provisioning|updating|deallocating)$/i;
const RAW_OFF = /^(stopped|deallocated|suspended|inactive|unattached)$/i;

export function rawStatusTone(raw) {
  const value = (raw || '').trim();
  if (!value) return 'neutral';
  if (RAW_GOOD.test(value)) return 'success';
  if (RAW_BAD.test(value)) return 'danger';
  if (RAW_BUSY.test(value)) return 'warning';
  if (RAW_OFF.test(value)) return 'warning';
  return 'neutral';
}

/** Risk level → how it reads. UNKNOWN means nobody has assessed the account,
 *  which is a different statement from NONE ("assessed, nothing found") and
 *  must never render as the reassuring one. */
export const RISK_META = {
  CRITICAL: { label: 'Critical', tone: 'danger', rank: 0 },
  HIGH: { label: 'High', tone: 'danger', rank: 1 },
  MEDIUM: { label: 'Medium', tone: 'warning', rank: 2 },
  LOW: { label: 'Low', tone: 'info', rank: 3 },
  INFO: { label: 'Info', tone: 'neutral', rank: 4 },
  NONE: { label: 'No findings', tone: 'success', rank: 5 },
  UNKNOWN: { label: 'Not assessed', tone: 'neutral', rank: 6 },
};

export const riskMeta = (level) => RISK_META[level] || RISK_META.UNKNOWN;

/** Freshness severity → how it reads. Stale inventory must not look like fresh
 *  inventory; that is the whole point of carrying the severity at all. */
export const FRESHNESS_META = {
  FRESH: { label: 'Fresh', tone: 'success' },
  AGING: { label: 'Aging', tone: 'info' },
  STALE: { label: 'Stale', tone: 'warning' },
  CRITICALLY_STALE: { label: 'Critically stale', tone: 'danger' },
  NEVER_SEEN: { label: 'Never observed', tone: 'neutral' },
};

export const freshnessMeta = (severity) => FRESHNESS_META[severity]
  || { label: severity || 'Unknown', tone: 'neutral' };

export const PROVIDER_LABEL = { AWS: 'AWS', AZURE: 'Azure', OCI: 'OCI' };
export const providerLabel = (p) => PROVIDER_LABEL[(p || '').toUpperCase()] || p || '—';

/**
 * A resource's cost as text plus the tooltip that justifies it.
 *
 * Returns NA — never "₹0" — when the provider did not bill this resource
 * individually, and carries the backend's own explanation of why, so the
 * tooltip states a reason rather than shrugging.
 */
export function costText(cost) {
  if (!cost || !cost.available || isMissing(cost.amount)) {
    return { text: NA, title: cost?.reason || 'No cost reported for this resource.', available: false };
  }
  const period = cost.period_days ? `Last ${cost.period_days} days` : null;
  const fetched = cost.fetched_at ? `Fetched ${relativeTime(cost.fetched_at)}` : null;
  const source = cost.source ? `Source: ${cost.source}` : null;
  return {
    text: exact(cost.amount, cost.currency),
    title: [exact(cost.amount, cost.currency), source, period, fetched,
      cost.billed_service ? `Billed as: ${cost.billed_service}` : null]
      .filter(Boolean).join('\n'),
    available: true,
  };
}

/** "3 minutes ago" / "9 days ago". Empty input gives null, not "just now" — an
 *  absent timestamp is not a recent one. */
export function relativeTime(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 0) return 'in the future';
  if (seconds < 60) return 'just now';
  const units = [
    ['minute', 60], ['hour', 60], ['day', 24], ['month', 30.44], ['year', 12],
  ];
  let value = seconds / 60;
  let unit = 'minute';
  for (let i = 0; i < units.length; i += 1) {
    const [name, next] = units[i];
    if (value < next || i === units.length - 1) { unit = name; break; }
    value /= next;
  }
  const n = Math.round(value);
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

export const formatCount = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');

/** Percentage for coverage readouts. null means "nothing to divide by", which
 *  prints as "Not applicable" rather than 0%. */
export const formatPct = (value) => (
  typeof value === 'number' ? `${value.toFixed(value % 1 === 0 ? 0 : 1)}%` : 'Not applicable'
);

export const coverageTone = (pct) => {
  if (typeof pct !== 'number') return 'neutral';
  if (pct >= 90) return 'success';
  if (pct >= 60) return 'info';
  if (pct >= 30) return 'warning';
  return 'danger';
};

/** Absolute timestamp for tooltips and detail rows. */
export const formatDateTime = (iso) => {
  if (!iso) return 'Not reported';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'Not reported' : d.toLocaleString();
};

// ── Filter plumbing ──────────────────────────────────────────────────────────

/** The empty filter. Every field is present so a reset clears everything, and
 *  so the object's shape is a single documented thing rather than whatever the
 *  last component happened to set. */
export const EMPTY_FILTERS = {
  q: '',
  providers: [],
  types: [],
  categories: [],
  regions: [],
  statuses: [],
  risk: [],
  environments: [],
  owners: [],
  resourceGroups: [],
  compartments: [],
  attachment: null,
  hasTags: null,
  tagKey: null,
  tagValue: null,
  missingTag: null,
  hasCost: null,
  costMin: null,
  costMax: null,
  hasFindings: null,
  stale: null,
  includeDefaults: true,
};

const ARRAY_KEYS = [
  'providers', 'types', 'categories', 'regions', 'statuses', 'risk',
  'environments', 'owners', 'resourceGroups', 'compartments',
];

export const isArrayFilter = (key) => ARRAY_KEYS.includes(key);

/** How many filters are actually narrowing the view — drives the "Clear
 *  filters" affordance and the count beside it. */
export function activeFilterCount(filters) {
  let count = 0;
  ARRAY_KEYS.forEach((key) => { count += (filters[key] || []).length; });
  if (filters.q) count += 1;
  ['attachment', 'tagKey', 'tagValue', 'missingTag'].forEach((key) => {
    if (filters[key]) count += 1;
  });
  ['hasTags', 'hasCost', 'hasFindings', 'stale'].forEach((key) => {
    if (typeof filters[key] === 'boolean') count += 1;
  });
  if (typeof filters.costMin === 'number' || typeof filters.costMax === 'number') count += 1;
  if (filters.includeDefaults === false) count += 1;
  return count;
}

/** Toggle one value inside a multi-select facet. */
export function toggleFacet(filters, key, value) {
  const current = filters[key] || [];
  const next = current.includes(value)
    ? current.filter((v) => v !== value)
    : [...current, value];
  return { ...filters, [key]: next };
}

// ── URL <-> filters ──────────────────────────────────────────────────────────
// Filters live in the URL so a view can be shared, bookmarked, reached with the
// browser's back button, and linked to from Security, Cost, Drift and Topology.

const URL_KEYS = {
  q: 'q',
  providers: 'provider',
  types: 'type',
  categories: 'category',
  regions: 'region',
  statuses: 'status',
  risk: 'risk',
  environments: 'environment',
  owners: 'owner',
  resourceGroups: 'resource_group',
  compartments: 'compartment',
  attachment: 'attachment',
  tagKey: 'tag_key',
  tagValue: 'tag_value',
  missingTag: 'missing_tag',
};

const BOOL_KEYS = {
  hasTags: 'has_tags',
  hasCost: 'has_cost',
  hasFindings: 'has_findings',
  stale: 'stale',
};

export function filtersFromSearchParams(params) {
  const filters = { ...EMPTY_FILTERS };
  Object.entries(URL_KEYS).forEach(([key, param]) => {
    if (isArrayFilter(key)) {
      const values = params.getAll(param);
      if (values.length) filters[key] = values;
      return;
    }
    const value = params.get(param);
    if (value !== null && value !== '') filters[key] = value;
  });
  Object.entries(BOOL_KEYS).forEach(([key, param]) => {
    const value = params.get(param);
    if (value === 'true') filters[key] = true;
    else if (value === 'false') filters[key] = false;
  });
  const costMin = params.get('cost_min');
  const costMax = params.get('cost_max');
  if (costMin !== null && costMin !== '') filters.costMin = Number(costMin);
  if (costMax !== null && costMax !== '') filters.costMax = Number(costMax);
  if (params.get('include_defaults') === 'false') filters.includeDefaults = false;
  return filters;
}

/** Filters → URLSearchParams entries. Only non-default values are written, so
 *  an unfiltered workspace has a clean URL. */
export function filtersToSearchParams(filters, extra = {}) {
  const params = new URLSearchParams();
  Object.entries(URL_KEYS).forEach(([key, param]) => {
    const value = filters[key];
    if (isArrayFilter(key)) {
      (value || []).forEach((v) => params.append(param, v));
      return;
    }
    if (value) params.set(param, String(value));
  });
  Object.entries(BOOL_KEYS).forEach(([key, param]) => {
    if (typeof filters[key] === 'boolean') params.set(param, String(filters[key]));
  });
  if (typeof filters.costMin === 'number') params.set('cost_min', String(filters.costMin));
  if (typeof filters.costMax === 'number') params.set('cost_max', String(filters.costMax));
  if (filters.includeDefaults === false) params.set('include_defaults', 'false');
  Object.entries(extra).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  });
  return params;
}
