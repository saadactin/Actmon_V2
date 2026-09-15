/**
 * Presentation vocabulary for the Security Center.
 *
 * Only *styling* decisions live here. The severity list, category list, rule
 * catalog and control catalog all come from `GET /security-center/meta`,
 * because a duplicated copy in the frontend is how a legend ends up describing
 * behaviour the engine stopped having.
 *
 * The one rule this file enforces on its own is the wording rule (§89). A
 * security tool's vocabulary is part of its correctness: "Secure" over
 * incomplete data is a false statement, and "Compliant" is a claim only an
 * auditor gets to make. So the labels below say Protected / Exposed / Unknown /
 * Not evaluated, and Control passed / Control failed — never Secure, never
 * Compliant.
 */

// ── Severity ────────────────────────────────────────────────────────────────
export const SEVERITY_TONE = {
  CRITICAL: 'danger',
  HIGH: 'danger',
  MEDIUM: 'warning',
  LOW: 'info',
  INFO: 'neutral',
};

// CRITICAL and HIGH share the `danger` badge tone (the palette has one), so the
// left accent bar is what distinguishes them in a list.
export const SEVERITY_ACCENT = {
  CRITICAL: 'border-l-danger',
  HIGH: 'border-l-warning',
  MEDIUM: 'border-l-info',
  LOW: 'border-l-border',
  INFO: 'border-l-border',
};

export const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

export const severityTone = (s) => SEVERITY_TONE[(s || '').toUpperCase()] || 'neutral';
export const severityAccent = (s) => SEVERITY_ACCENT[(s || '').toUpperCase()] || 'border-l-border';
export const severityRank = (s) => {
  const i = SEVERITY_ORDER.indexOf((s || '').toUpperCase());
  return i === -1 ? SEVERITY_ORDER.length : i;
};

// ── Verdict ─────────────────────────────────────────────────────────────────
// The distinction the whole engine is built on: VULNERABLE means we confirmed
// the condition, UNKNOWN means we could not tell. They must never look alike.
export const VERDICT_META = {
  VULNERABLE: {
    label: 'Confirmed',
    tone: 'danger',
    icon: 'shield',
    meaning: 'The provider reported the configuration this check looks for.',
  },
  UNKNOWN: {
    label: 'Not determined',
    tone: 'warning',
    icon: 'help',
    meaning: 'The data this check needs was not available. This is not a pass.',
  },
  NOT_SCANNED: {
    label: 'Not collected',
    tone: 'neutral',
    icon: 'eye-off',
    meaning: 'Nothing in this build collects the data this check needs.',
  },
  SAFE: {
    label: 'Checked — clear',
    tone: 'success',
    icon: 'check',
    meaning: 'The check ran and the condition was absent.',
  },
  NOT_APPLICABLE: {
    label: 'Not applicable',
    tone: 'neutral',
    icon: 'ban',
    meaning: 'This check does not apply to this resource.',
  },
};

export const verdictMeta = (v) => VERDICT_META[v] || {
  label: v || 'Unknown', tone: 'neutral', icon: 'circle', meaning: '',
};

// ── Confidence ──────────────────────────────────────────────────────────────
export const CONFIDENCE_META = {
  HIGH: { label: 'High', tone: 'success' },
  MEDIUM: { label: 'Medium', tone: 'info' },
  LOW: { label: 'Low — indicator', tone: 'warning' },
  UNKNOWN: { label: 'Unknown', tone: 'neutral' },
};

export const confidenceMeta = (c) => CONFIDENCE_META[c] || { label: c || '—', tone: 'neutral' };

// ── Finding status ──────────────────────────────────────────────────────────
export const STATUS_META = {
  OPEN: { label: 'Open', tone: 'danger', icon: 'alert' },
  IN_PROGRESS: { label: 'In progress', tone: 'info', icon: 'wrench' },
  RESOLVED: { label: 'Resolved', tone: 'success', icon: 'check' },
  SUPPRESSED: { label: 'Suppressed', tone: 'neutral', icon: 'eye-off' },
  ACCEPTED_RISK: { label: 'Risk accepted', tone: 'outline', icon: 'shield' },
};

export const statusMeta = (s) => STATUS_META[s] || { label: s || '—', tone: 'neutral', icon: 'circle' };

// The two transitions that need a written reason, and the sentence explaining
// why — shown in the dialog so the requirement does not read as friction.
export const STATUS_NEEDS_REASON = {
  SUPPRESSED: 'Suppressing a real finding stops it counting toward the score and closes '
    + 'its alerts. Record why, so the decision is defensible later.',
  ACCEPTED_RISK: 'Accepting a risk records a deliberate decision to leave it in place. '
    + 'Record the justification and, ideally, who approved it.',
};

// ── Exposure verdict ────────────────────────────────────────────────────────
export const EXPOSURE_META = {
  EXPOSED: { label: 'Exposed', tone: 'danger', icon: 'globe' },
  PROTECTED: { label: 'Protected', tone: 'success', icon: 'shield-check' },
  UNKNOWN: { label: 'Unknown', tone: 'warning', icon: 'help' },
  NOT_APPLICABLE: { label: 'No public address', tone: 'neutral', icon: 'ban' },
};

export const exposureMeta = (v) => EXPOSURE_META[v] || { label: v || '—', tone: 'neutral', icon: 'circle' };

// ── Compliance control state ────────────────────────────────────────────────
// Note the wording: "Control passed", never "Compliant".
export const CONTROL_STATE_META = {
  FAIL: { label: 'Control failed', tone: 'danger', icon: 'alert' },
  PARTIAL: { label: 'Partially failed', tone: 'warning', icon: 'alert' },
  UNKNOWN: { label: 'Evidence unavailable', tone: 'warning', icon: 'help' },
  PASS: { label: 'Control passed', tone: 'success', icon: 'check' },
  NOT_APPLICABLE: { label: 'Not applicable', tone: 'neutral', icon: 'ban' },
  NOT_EVALUATED: { label: 'Not evaluated', tone: 'outline', icon: 'eye-off' },
};

export const controlStateMeta = (s) => CONTROL_STATE_META[s] || { label: s || '—', tone: 'neutral', icon: 'circle' };

export const CONTROL_STATE_ORDER = ['FAIL', 'PARTIAL', 'UNKNOWN', 'PASS', 'NOT_APPLICABLE', 'NOT_EVALUATED'];

// ── Category icons ──────────────────────────────────────────────────────────
export const CATEGORY_ICON = {
  'Identity & Access': 'key',
  Networking: 'network',
  Exposure: 'globe',
  Encryption: 'lock',
  'Data Protection': 'database',
  Configuration: 'settings',
  'Logging & Monitoring': 'logs',
  Resilience: 'refresh',
  Governance: 'id-card',
  Performance: 'gauge',
  Maintenance: 'wrench',
  Cost: 'chart-bar',
};

export const categoryIcon = (c) => CATEGORY_ICON[c] || 'circle';

// Categories that never affect the security score. Surfaced in the UI so the
// exclusion is visible rather than something a user has to deduce from a
// discrepancy between a finding count and a score.
export const NON_SECURITY_CATEGORIES = new Set(['Performance', 'Cost']);

// ── Grade ───────────────────────────────────────────────────────────────────
// Grade colour is a computed data value, like the score itself, so it stays a
// direct hex scale rather than a chrome token — the same call the old
// SecurityPosturePage made.
export const GRADE_COLOR = {
  A: '#22c55e',
  B: '#10b981',
  C: '#eab308',
  D: '#f97316',
  F: '#ef4444',
};

export const gradeColor = (grade) => {
  if (!grade) return '#94a3b8';
  const direct = GRADE_COLOR[grade];
  if (direct) return direct;
  // "Insufficient data" and "Not assessed" are deliberately grey, not red.
  // Red would read as a bad estate; the point is that we cannot say.
  return '#94a3b8';
};

export const isRealGrade = (grade) => Object.hasOwn(GRADE_COLOR, grade || '');

// ── Formatting ──────────────────────────────────────────────────────────────

/** Percentages that may legitimately be null. `null` means "no denominator",
 *  which is not the same as 0 and must not render as it. */
export const formatPct = (value, { nullLabel = 'Not applicable' } = {}) => {
  if (value === null || value === undefined) return nullLabel;
  return `${Number(value).toFixed(Number.isInteger(value) ? 0 : 1)}%`;
};

export const formatCount = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');

export const formatDateTime = (iso) => {
  if (!iso) return 'Never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'Unknown' : d.toLocaleString();
};

/** Relative age, for freshness lines. Distinguishes "just now" from a number
 *  of seconds, which reads as machine output. */
export const formatAge = (seconds) => {
  if (seconds === null || seconds === undefined) return 'never';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  const days = Math.floor(seconds / 86400);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

/** Coverage tone. Deliberately not a smooth gradient: the interesting
 *  threshold is where a score stops being reported at all (40%), and the tone
 *  should change there. */
export const coverageTone = (pct) => {
  if (pct === null || pct === undefined) return 'neutral';
  if (pct >= 90) return 'success';
  if (pct >= 70) return 'info';
  if (pct >= 40) return 'warning';
  return 'danger';
};

export const PROVIDER_LABEL = { AWS: 'AWS', AZURE: 'Azure', OCI: 'OCI' };
export const providerLabel = (p) => PROVIDER_LABEL[(p || '').toUpperCase()] || p || '—';
