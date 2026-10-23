/**
 * The report builder's vocabulary and the rules its screens share.
 *
 * Pure functions only (tested in __tests__/reportModel.test.mjs, which also
 * checks every option list here against Backend/cloud/app/schemas/reports.py
 * parsed from source — an option the backend refuses would fail the preview
 * with a 422 and nothing on screen to explain it).
 *
 * Three rules carry the weight:
 * * **The period is honest.** It applies to account spend and spend
 *   anomalies; findings, inventory and per-resource billed cost are the
 *   current state. Day-granular presets only — nothing in the data is hourly.
 * * **NA is not zero.** A resource without a billed cost shows "Not
 *   available", and an empty coverage count shows "—", never 0.
 * * **A draft saved by an older form still loads.** Session drafts outlive a
 *   deploy; a stale preset or detail level is mapped to the nearest valid one
 *   rather than sent and refused.
 */
import { exact, NA } from './costFormat';

export const PERIOD_PRESETS = [
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: '90d', label: 'Last 90 days' },
  { id: 'mtd', label: 'Month to date' },
  { id: 'last_month', label: 'Last month' },
  { id: 'custom', label: 'Custom' },
];

export const DETAIL_LEVELS = [
  { id: 'executive', label: 'Executive', hint: 'Summaries only: executive summary, account spend and data quality. No per-resource rows.' },
  { id: 'standard', label: 'Standard', hint: 'Plus every finding, measurement and billed-cost row. Resources with nothing to report are counted, not listed.' },
  { id: 'detailed', label: 'Detailed', hint: 'Plus, per section, each resource with nothing to report and why, and provider resource IDs in the PDF.' },
];

export const GROUP_BY_OPTIONS = [
  { id: '', label: 'No grouping' },
  { id: 'region', label: 'Region' },
  { id: 'resource_type', label: 'Resource type' },
  { id: 'severity', label: 'Severity' },
];

export const SORT_BY_OPTIONS = [
  { id: '', label: 'Section default' },
  { id: 'severity', label: 'Severity (most severe first)' },
  { id: 'resource_name', label: 'Resource name' },
  { id: 'cost', label: 'Billed cost (highest first)' },
  { id: 'detected_at', label: 'Detected (newest first)' },
];

export const SECTION_LABELS = {
  executive_summary: 'Executive Summary',
  inventory: 'Resource Inventory',
  security: 'Security Assessment',
  utilization: 'Resource Utilization',
  performance: 'Performance Analysis',
  recommendations: 'Recommendations',
  cost: 'Cost',
  cost_summary: 'Account Spend',
  anomalies: 'Spend Anomalies (Account-Wide)',
  posture: 'Security Posture & Compliance',
  identity: 'Identity & Access',
  certificates: 'Expiring Certificates & Secrets',
  changes: 'Configuration Changes',
  activity: 'Account Activity (Event Log)',
  data_quality: 'Data Quality & Coverage',
};

/** The sections whose value is a list of rows, in report order. */
export const ROW_SECTIONS = ['inventory', 'security', 'utilization', 'performance',
  'recommendations', 'cost', 'anomalies', 'certificates', 'changes'];

const LEGACY_DETAIL = { technical: 'detailed' };

/** The viewer's IANA zone, so "Last 7 days" ends on the viewer's today. */
export function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** A draft restored from session storage, made valid for today's backend. */
export function normalizeDraft(draft, { timeZone = browserTimeZone() } = {}) {
  const dateRange = { ...draft.date_range };
  if (!PERIOD_PRESETS.some((p) => p.id === dateRange.preset)) dateRange.preset = '30d';
  // The old form used datetime-local inputs; the period is whole days.
  for (const key of ['start', 'end']) {
    if (typeof dateRange[key] === 'string' && dateRange[key].length > 10) {
      dateRange[key] = dateRange[key].slice(0, 10);
    }
  }
  if (!dateRange.timezone || dateRange.timezone === 'UTC') dateRange.timezone = timeZone;

  const layout = { ...draft.layout };
  layout.detail_level = LEGACY_DETAIL[layout.detail_level] || layout.detail_level;
  if (!DETAIL_LEVELS.some((d) => d.id === layout.detail_level)) layout.detail_level = 'standard';
  if (!GROUP_BY_OPTIONS.some((g) => g.id === (layout.group_by || ''))) layout.group_by = null;
  if (!SORT_BY_OPTIONS.some((o) => o.id === (layout.sort_by || ''))) layout.sort_by = null;
  return { ...draft, date_range: dateRange, layout };
}

/** Why a custom period cannot be sent yet, or null when it can. */
export function customPeriodProblem(dateRange) {
  if (dateRange?.preset !== 'custom') return null;
  if (!dateRange.start || !dateRange.end) return 'Pick both a start and an end date.';
  if (dateRange.start > dateRange.end) return 'The start date is after the end date.';
  const days = (Date.parse(dateRange.end) - Date.parse(dateRange.start)) / 86_400_000 + 1;
  if (days > 366) return 'A custom period can span at most 366 days.';
  return null;
}

/**
 * The server's own message for a failed request. A download is requested as
 * a Blob, so its error body arrives as a Blob too — reading
 * `err.response.data.detail` off it yields undefined and the operator saw only
 * axios's "Request failed with status code 400".
 */
export async function errorMessage(err) {
  let data = err?.response?.data;
  if (data && typeof data.text === 'function' && !(typeof data === 'string')) {
    try {
      const text = await data.text();
      try { data = JSON.parse(text); } catch { data = text; }
    } catch {
      data = null;
    }
  }
  const detail = data?.detail ?? data;
  if (typeof detail === 'string' && detail) return detail;
  if (detail?.error?.message) return detail.error.message;
  if (Array.isArray(detail) && detail[0]?.msg) return detail.map((d) => d.msg).join('; ');
  return err?.message || 'Unknown error.';
}

// ── Preview tables ───────────────────────────────────────────────────────────

const money = (row) => (row.cost_amount === null || row.cost_amount === undefined
  ? 'Not available' : exact(row.cost_amount, row.currency));
const day = (v) => (v ? String(v).slice(0, 10) : NA);

const FINDING_COLUMNS = [
  { key: 'resource_name', label: 'Resource' },
  { key: 'title', label: 'Title' },
  { key: 'severity', label: 'Severity' },
  { key: 'status', label: 'Status' },
  { key: 'detected_at', label: 'Detected', format: day },
];

export const PREVIEW_COLUMNS = {
  inventory: [
    { key: 'resource_name', label: 'Resource' },
    { key: 'resource_type', label: 'Type' },
    { key: 'region', label: 'Region' },
    { key: 'status', label: 'Status' },
  ],
  security: FINDING_COLUMNS,
  utilization: [
    { key: 'resource_name', label: 'Resource' },
    { key: 'title', label: 'Metric' },
    { key: 'metric_value', label: 'Measurement' },
    { key: 'status', label: 'Status' },
  ],
  performance: FINDING_COLUMNS,
  recommendations: FINDING_COLUMNS,
  cost: [
    { key: 'resource_name', label: 'Resource' },
    { key: 'resource_type', label: 'Type' },
    { key: 'billed_service', label: 'Billed service' },
    { key: 'cost_amount', label: 'Billed cost', format: (_v, row) => money(row), align: 'right' },
  ],
  anomalies: [
    { key: 'title', label: 'Anomaly' },
    { key: 'severity', label: 'Severity' },
    { key: 'metric_value', label: 'Above baseline' },
  ],
  certificates: [
    { key: 'resource_name', label: 'Name' },
    { key: 'resource_type', label: 'Kind' },
    { key: 'expires_at', label: 'Expires', format: day },
    { key: 'days_left', label: 'Days left', format: (v) => daysLeft(v), align: 'right' },
  ],
  changes: [
    { key: 'resource_name', label: 'Resource' },
    { key: 'title', label: 'Change' },
    { key: 'severity', label: 'Severity' },
    { key: 'detected_at', label: 'Detected', format: day },
  ],
};

// ── Templates and schedules ─────────────────────────────────────────────────

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * A saved request (template or schedule) from the builder's draft. A saved
 * request has no account and no hand-picked resources — it must mean the same
 * thing on every account — so "selected resources" cannot be saved.
 */
export function configFromDraft(draft) {
  const { mode, filters } = draft.scope || {};
  return {
    scope: { mode: mode === 'resources' ? 'account' : (mode || 'account'), filters: filters || {} },
    sections: { ...draft.sections },
    date_range: { ...draft.date_range },
    layout: { ...draft.layout },
  };
}

/** Why the current draft cannot be saved as a template/schedule, or null. */
export function saveProblem(draft) {
  if (draft?.scope?.mode === 'resources') {
    return 'Hand-picked resources belong to one account, so they cannot be saved. Use a filter or the whole account.';
  }
  if (!Object.values(draft?.sections || {}).some(Boolean)) return 'Choose at least one section.';
  return null;
}

/**
 * The builder's draft from a saved config: the template's choices over the
 * defaults, with the viewer's own time zone when the template did not fix one.
 */
export function draftFromConfig(config, defaults, { timeZone = browserTimeZone() } = {}) {
  const cfg = config || {};
  return normalizeDraft({
    ...defaults,
    scope: { ...defaults.scope, ...(cfg.scope || {}), resource_ids: [] },
    sections: { ...defaults.sections, ...(cfg.sections || {}) },
    date_range: { ...defaults.date_range, ...(cfg.date_range || {}) },
    layout: {
      ...defaults.layout,
      ...(cfg.layout || {}),
      metadata: { ...defaults.layout.metadata, ...((cfg.layout || {}).metadata || {}) },
    },
  }, { timeZone });
}

/** "Every Monday at 09:00 (Asia/Kolkata)" / "On day 3 of every month at 09:00 (...)". */
export function describeSchedule(s) {
  if (!s) return NA;
  const when = s.frequency === 'weekly'
    ? `Every ${WEEKDAYS[s.day_of_week ?? 0]}`
    : `On day ${s.day_of_month ?? 3} of every month`;
  return `${when} at ${s.send_time || '09:00'} (${s.timezone || 'UTC'})`;
}

/** "907 days ago" for an expired item, "12" for one still valid, NA unknown. */
export function daysLeft(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return NA;
  const n = Math.round(Number(value));
  return n < 0 ? `${Math.abs(n)} days ago` : String(n);
}

/** One line for a spend change entry, never an infinite or invented percent. */
export function changeText(entry, currency) {
  if (!entry) return NA;
  if (entry.percent === null || entry.percent === undefined) {
    return `${entry.label || NA}${entry.reason ? ` — ${entry.reason}` : ''}`;
  }
  const sign = entry.percent > 0 ? '+' : '';
  return `${sign}${entry.percent.toFixed(1)}% (${exact(entry.previous, currency)} → ${exact(entry.current, currency)})`;
}

/** The posture line: a withheld score is never shown as its raw number. */
export function postureText(p) {
  if (!p) return NA;
  if (p.status === 'unavailable') return 'Could not be read';
  if (p.status === 'not_assessed') return 'Not assessed';
  if (!p.reliable) return `Withheld (grade ${p.grade || NA})`;
  return `${p.score}/100 · grade ${p.grade}`;
}

export function cellText(row, column) {
  const value = row?.[column.key];
  if (column.format) return column.format(value, row);
  return value === null || value === undefined || value === '' ? NA : String(value);
}

/** One sentence on what a section's coverage says, or null. */
export function coverageSentence(section, coverage) {
  if (!coverage) return null;
  if (coverage.status === 'unavailable') return `Could not be read: ${coverage.error}`;
  if (section === 'certificates') {
    const failing = coverage.resources_without_data;
    return failing
      ? `${failing} of ${coverage.resources_checked} credential store(s) could not be read — anything in them is missing.`
      : null;
  }
  if (section === 'changes') {
    const parts = Object.entries(coverage.by_change_type || {})
      .sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${n} ${k.toLowerCase()}`);
    return parts.length ? parts.join(', ') : null;
  }
  const parts = [];
  const without = coverage.resources_without_data;
  if (without) {
    const noun = {
      security: 'no open security findings',
      utilization: 'no telemetry collected',
      performance: 'no open performance findings',
      recommendations: 'no open recommendations',
      cost: 'no billed cost reported (unknown, not zero)',
    }[section] || 'nothing to report';
    parts.push(`${without} of ${coverage.resources_checked} resource(s) have ${noun}.`);
  }
  if (section === 'security' && coverage.account_level_findings) {
    parts.push(`${coverage.account_level_findings} account-level finding(s) ${
      coverage.account_level_included ? 'included' : 'left out of this scoped report'}.`);
  }
  return parts.join(' ') || null;
}
