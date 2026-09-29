/**
 * Clients, client reports and the certificate inventory — presentation rules.
 *
 * Pure functions only, so every rule below is testable without a browser
 * (tests/verify_clients_model.mjs). Three rules carry the weight:
 *
 * * **Money is per currency.** A client with an AWS account billed in USD and
 *   an OCI tenancy billed in INR has two totals, never one. Nothing here adds
 *   across currencies or converts between them, and an account with no
 *   billing history is NA, not zero.
 * * **Posture is never averaged.** A group shows its worst published score
 *   and how many accounts have none; an average of a 35 and a withheld score
 *   is a number no account has.
 * * **Queued is not delivered.** A report whose e-mail was handed to the
 *   notification queue says "queued". Whether it left the building is decided
 *   by the database service's dispatcher, and only notification history can
 *   say "sent".
 */
import { compact, exact, NA } from './costFormat';

// ── Money ───────────────────────────────────────────────────────────────────

/** `{INR: 1200, USD: 30}` → `[['INR', 1200], ['USD', 30]]`, sorted by code,
 *  dropping entries whose amount is missing. Never merges currencies. */
export function moneyEntries(byCurrency) {
  if (!byCurrency || typeof byCurrency !== 'object') return [];
  return Object.entries(byCurrency)
    .filter(([, v]) => v !== null && v !== undefined && !Number.isNaN(Number(v)))
    .sort(([a], [b]) => a.localeCompare(b));
}

/** One line per currency, joined with " · ". NA when there is nothing to show
 *  — an empty map means "no billing stored", which is not zero spend. */
export function formatMoneyMap(byCurrency, { style = 'compact' } = {}) {
  const entries = moneyEntries(byCurrency);
  if (!entries.length) return NA;
  const fmt = style === 'exact' ? exact : compact;
  return entries.map(([code, amount]) => fmt(amount, code === 'UNKNOWN' ? null : code))
    .join(' · ');
}

/** The exact per-currency amounts, for a title/tooltip beside a compact figure. */
export function moneyTitle(byCurrency) {
  const entries = moneyEntries(byCurrency);
  if (!entries.length) return 'No billing data is stored for this period.';
  return entries.map(([code, amount]) => `${exact(amount, code === 'UNKNOWN' ? null : code)}${
    code === 'UNKNOWN' ? ' (currency not reported)' : ''}`).join('\n');
}

// ── Posture ─────────────────────────────────────────────────────────────────

const GRADE_TONE = { A: 'success', B: 'success', C: 'warning', D: 'danger', F: 'danger' };

/**
 * One account's published posture (`{score, grade, score_reliable, ...}` or
 * null). A missing assessment or a withheld score is neutral grey — red would
 * say "bad estate" where the truth is "we cannot say".
 */
export function postureLabel(security) {
  if (!security) return { text: 'Not assessed', tone: 'neutral', provisional: false };
  if (security.score === null || security.score === undefined) {
    return { text: security.grade || 'Score withheld', tone: 'neutral', provisional: false };
  }
  const grade = security.grade || '?';
  return {
    text: `${Math.round(security.score)} · ${grade}`,
    tone: GRADE_TONE[grade] || 'neutral',
    // A score published on low coverage is shown, but marked.
    provisional: security.score_reliable === false,
  };
}

/** A group's posture: the worst published score, never an average. */
export function worstPostureLabel(summary) {
  const worst = summary?.worst_posture;
  const unassessed = summary?.accounts_unassessed || 0;
  const accounts = summary?.accounts || 0;
  if (!accounts) return { text: '—', tone: 'neutral', detail: 'No accounts', provisional: false };
  if (!worst) {
    return {
      text: 'Not assessed', tone: 'neutral', provisional: false,
      detail: `None of ${accounts} account${accounts === 1 ? '' : 's'} has a published score`,
    };
  }
  const base = postureLabel(worst);
  const parts = [`Worst: ${worst.account_name}`];
  if (unassessed) parts.push(`${unassessed} not assessed`);
  return { ...base, detail: parts.join(' · ') };
}

// ── Findings ────────────────────────────────────────────────────────────────

/** Confirmed findings only; undetermined checks are a gap, not a risk. */
export function findingCounts(findings) {
  const f = findings || {};
  const n = (k) => Number(f[k] || 0);
  return {
    critical: n('CRITICAL'),
    high: n('HIGH'),
    medium: n('MEDIUM'),
    low: n('LOW'),
    info: n('INFO'),
    total: n('CRITICAL') + n('HIGH') + n('MEDIUM') + n('LOW') + n('INFO'),
  };
}

// ── Certificates (summary shape from the estate summary) ────────────────────

/**
 * `{expired, expiring_soon, tracked, sources_total, sources_failing}` →
 * a label. "Nothing expiring" is only green when every store was read; with
 * an unreadable store it is a statement about the stores we could see.
 */
export function certificateHealth(certs) {
  const c = certs || {};
  const failing = Number(c.sources_failing || 0);
  const total = Number(c.sources_total || 0);
  const failingNote = failing
    ? `${failing} of ${total} store${total === 1 ? '' : 's'} could not be read`
    : null;
  if (!total && !Number(c.tracked || 0)) {
    return { text: 'Not collected', tone: 'neutral', detail: 'No store has been read yet' };
  }
  if (Number(c.expired || 0) > 0) {
    return { text: `${c.expired} expired`, tone: 'danger', detail: failingNote };
  }
  if (Number(c.expiring_soon || 0) > 0) {
    return { text: `${c.expiring_soon} expiring ≤ 30 d`, tone: 'warning', detail: failingNote };
  }
  return {
    text: 'None expiring ≤ 30 d',
    tone: failing ? 'warning' : 'success',
    detail: failingNote || `${c.tracked || 0} tracked`,
  };
}

/** Buckets exactly as the backend files them (credential_service.BUCKETS). */
export const BUCKET_META = {
  expired: { label: 'Expired', tone: 'danger' },
  within_7: { label: '≤ 7 days', tone: 'danger' },
  within_30: { label: '≤ 30 days', tone: 'warning' },
  within_90: { label: '≤ 90 days', tone: 'info' },
  later: { label: 'Later', tone: 'neutral' },
  no_expiry: { label: 'No expiry set', tone: 'neutral' },
};
export const BUCKET_ORDER = ['expired', 'within_7', 'within_30', 'within_90', 'later', 'no_expiry'];
export const bucketMeta = (b) => BUCKET_META[b] || { label: b || '—', tone: 'neutral' };

export const KIND_META = {
  CERTIFICATE: { label: 'Certificate', icon: 'lock' },
  SECRET: { label: 'Secret', icon: 'key' },
  KEY: { label: 'Key', icon: 'key' },
};
export const KIND_ORDER = ['CERTIFICATE', 'SECRET', 'KEY'];
export const kindMeta = (k) => KIND_META[k] || { label: k || '—', icon: 'circle' };

/** Collection states (models/credential_inventory.py COLLECT_*). Only
 *  Collected is green; NotSupported is neutral, never a pass. */
export const COLLECTION_META = {
  Collected: { label: 'Collected', tone: 'success' },
  PermissionDenied: { label: 'Permission denied', tone: 'danger' },
  AuthenticationFailed: { label: 'Credentials rejected', tone: 'danger' },
  BlockedByNetwork: { label: 'Blocked by network rules', tone: 'warning' },
  Unavailable: { label: 'Unavailable', tone: 'warning' },
  NotSupported: { label: 'Not supported', tone: 'neutral' },
  NeverRun: { label: 'Never collected', tone: 'neutral' },
};
export const collectionMeta = (s) => COLLECTION_META[s] || { label: s || 'Unknown', tone: 'neutral' };

/** "in 12 days", "today", "3 days ago" — from the backend's fractional days. */
export function daysLeftLabel(daysLeft) {
  if (daysLeft === null || daysLeft === undefined || Number.isNaN(Number(daysLeft))) {
    return 'No expiry';
  }
  const d = Number(daysLeft);
  if (d < 0) {
    // Whole days elapsed, as a calendar reads it: 3.2 days ago is "3 days ago".
    const ago = Math.floor(-d);
    if (ago < 1) return 'Expired today';
    return `Expired ${ago} day${ago === 1 ? '' : 's'} ago`;
  }
  const whole = Math.floor(d);
  if (whole === 0) return 'Expires today';
  return `in ${whole} day${whole === 1 ? '' : 's'}`;
}

// ── Reports ─────────────────────────────────────────────────────────────────

/** Sections, in the backend's order (models/client.py SECTIONS). */
export const REPORT_SECTIONS = [
  { id: 'cost', label: 'Spend', hint: 'Billed spend per currency, month over month, top services' },
  { id: 'security', label: 'Security posture', hint: 'Published score and confirmed findings' },
  { id: 'compliance', label: 'Compliance', hint: 'Control pass rates per framework' },
  { id: 'certificates', label: 'Certificates & secrets', hint: 'Anything expiring within 60 days' },
  { id: 'changes', label: 'Configuration changes', hint: 'Changes detected in the month' },
  { id: 'alerts', label: 'Alerts', hint: 'Alerts opened and resolved in the month' },
  { id: 'data_gaps', label: 'Data gaps', hint: 'Everything that could make a number above wrong' },
];

/** What happened to a report's e-mail, from this service's side of the
 *  queue. No label may say sent or delivered: that is earned in
 *  notification history, never here. */
export const DELIVERY_META = {
  QUEUED: {
    label: 'Queued for e-mail', tone: 'info',
    hint: 'Handed to the notification queue. Delivery is recorded in notification history.',
  },
  NOT_REQUESTED: { label: 'Not e-mailed', tone: 'neutral', hint: 'Generated without e-mailing.' },
  DELIVERY_NOT_READY: {
    label: 'E-mail not set up', tone: 'warning',
    hint: 'SMTP or the e-mail channel is not configured, so nothing was queued.',
  },
  NO_RECIPIENTS: {
    label: 'No recipients', tone: 'warning',
    hint: 'The report schedule has no To address.',
  },
  FAILED_TO_QUEUE: { label: 'Could not queue', tone: 'danger', hint: 'The queue refused the message.' },
  TOO_LARGE: { label: 'Too large to e-mail', tone: 'danger', hint: 'The PDF is above the attachment limit.' },
};
export const deliveryMeta = (s) => DELIVERY_META[s] || { label: s || '—', tone: 'neutral', hint: '' };

export const REPORT_STATUS_META = {
  GENERATED: { label: 'Generated', tone: 'success' },
  FAILED: { label: 'Failed', tone: 'danger' },
};
export const reportStatusMeta = (s) => REPORT_STATUS_META[s] || { label: s || '—', tone: 'neutral' };

/** The schedule's last run: a delivery status, or one of the scheduler's own. */
export function scheduleRunMeta(status) {
  if (!status) return { label: 'Never run', tone: 'neutral', hint: '' };
  if (status === 'FAILED') return { label: 'Report failed', tone: 'danger', hint: '' };
  if (status === 'ALREADY_PRODUCED') {
    return { label: 'Already produced', tone: 'neutral', hint: 'That period was not produced twice.' };
  }
  return deliveryMeta(status);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

/** "2026-08" → "August 2026". Anything else is returned as is. */
export function periodLabel(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(period || '');
  if (!m) return period || '—';
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? `${MONTHS[month - 1]} ${m[1]}` : period;
}

/**
 * The last `count` COMPLETE months, newest first — the only periods the
 * backend accepts. Computed in UTC because the backend decides "has this
 * month finished" on its UTC date; a browser east of UTC would otherwise offer
 * a month for a few hours before the backend agrees it is over.
 */
export function periodOptions(now = new Date(), count = 12) {
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth(); // 0-based: this is already "last month" 1-based
  const out = [];
  for (let i = 0; i < count; i += 1) {
    if (month === 0) { year -= 1; month = 12; }
    const id = `${year}-${String(month).padStart(2, '0')}`;
    out.push({ id, label: periodLabel(id) });
    month -= 1;
  }
  return out;
}

export function formatBytes(n) {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Form helpers ────────────────────────────────────────────────────────────

/** The backend's own rule (client_service._CODE_RE). */
export const CLIENT_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

// Deliberately loose: the backend validates properly; this only catches typos
// before a round trip.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Split a free-text list on commas, semicolons and whitespace; trim, and
 *  drop case-insensitive duplicates, keeping the first spelling. */
export function parseEmailList(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || '').split(/[\s,;]+/)) {
    const addr = raw.trim();
    if (!addr || seen.has(addr.toLowerCase())) continue;
    seen.add(addr.toLowerCase());
    out.push(addr);
  }
  return out;
}

export const invalidEmails = (list) => (list || []).filter((a) => !EMAIL_RE.test(a));

// ── Navigation ──────────────────────────────────────────────────────────────

const PROVIDER_SLUG = { AWS: 'aws', AZURE: 'azure', OCI: 'oci', ORACLE: 'oci' };

/** An account's dashboard route, or null for a provider with no dashboard. */
export function accountRoute(provider, accountId) {
  const slug = PROVIDER_SLUG[String(provider || '').toUpperCase()];
  return slug && accountId ? `/cloud/${slug}-accounts/${accountId}` : null;
}

// ── Onboarding ──────────────────────────────────────────────────────────────

export const ONBOARD_OUTCOME_META = {
  created: { label: 'Created', tone: 'success' },
  skipped: { label: 'Already connected', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
  not_found: { label: 'Not in organisation', tone: 'danger' },
};
export const onboardOutcomeMeta = (o) => ONBOARD_OUTCOME_META[o] || { label: o || '—', tone: 'neutral' };

/** Members that can be ticked: never an already-connected one, never one
 *  whose access could not be confirmed. */
export const selectableMemberIds = (members) => (members || [])
  .filter((m) => m.selectable).map((m) => m.member_id);
