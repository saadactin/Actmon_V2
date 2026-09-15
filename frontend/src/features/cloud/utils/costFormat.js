/**
 * Formatting for cost figures.
 *
 * One rule governs this whole file: **null/undefined is NA, and NA is not zero.**
 * The backend deliberately returns null when a provider did not tell us a value,
 * and 0 only when a provider reported a real zero. Every formatter here keeps
 * that distinction — none of them fall back to 0, and `??` is never used to
 * default an amount.
 *
 * Compact forms exist because a 7-digit rupee figure does not fit a KPI card or
 * a Y-axis tick. But compacting loses precision, so every compact number must be
 * paired with the exact value in a tooltip or title attribute — see `exact()`.
 */

export const NA = 'NA';

const SYMBOLS = { USD: '$', INR: '₹', EUR: '€', GBP: '£', AUD: 'A$', CAD: 'C$', JPY: '¥' };

/** The currency symbol, or the code plus a space when we have no symbol for it.
 *  Empty string when the currency is unknown — never a guessed '$'. */
export function symbolFor(code) {
  if (!code) return '';
  return SYMBOLS[code] ?? `${code} `;
}

export function isMissing(value) {
  return value === null || value === undefined || Number.isNaN(value);
}

/**
 * Exact, fully-precise amount — what tooltips and downloads must show.
 * e.g. "₹45,23,727.04". Returns NA for a missing value.
 */
export function exact(amount, currency) {
  if (isMissing(amount)) return NA;
  const locale = currency === 'INR' ? 'en-IN' : 'en-US';
  return `${symbolFor(currency)}${Number(amount).toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Compact amount for cards and axes — "₹45.23L", "$1.42K", "₹4.52Cr".
 *
 * INR uses lakh/crore because that is how the figure is read by the people
 * paying it; everything else uses K/M/B. A real zero formats as "0", never NA.
 */
export function compact(amount, currency) {
  if (isMissing(amount)) return NA;
  const n = Number(amount);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const sym = symbolFor(currency);

  const scale = (value, suffix, digits = 2) =>
    `${sign}${sym}${value.toFixed(digits).replace(/\.00$/, '')}${suffix}`;

  if (currency === 'INR') {
    if (abs >= 1e7) return scale(abs / 1e7, 'Cr');
    if (abs >= 1e5) return scale(abs / 1e5, 'L');
    if (abs >= 1e3) return scale(abs / 1e3, 'K');
  } else {
    if (abs >= 1e9) return scale(abs / 1e9, 'B');
    if (abs >= 1e6) return scale(abs / 1e6, 'M');
    if (abs >= 1e3) return scale(abs / 1e3, 'K');
  }
  return `${sign}${sym}${abs.toFixed(2).replace(/\.00$/, '')}`;
}

/** Axis ticks: no currency symbol (the axis label carries it), no decimals. */
export function axisTick(value, currency) {
  if (isMissing(value)) return '';
  const abs = Math.abs(value);
  if (currency === 'INR') {
    if (abs >= 1e7) return `${(value / 1e7).toFixed(1)}Cr`;
    if (abs >= 1e5) return `${(value / 1e5).toFixed(1)}L`;
    if (abs >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
  } else {
    if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
    if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
  }
  return `${value}`;
}

export function percent(value, digits = 1) {
  if (isMissing(value)) return NA;
  return `${Number(value).toFixed(digits)}%`;
}

/**
 * A period-over-period change, rendered without ever producing "∞%".
 *
 * Accepts the backend's Change shape ({kind, percent, label}) or a bare number.
 * A jump from zero is "New", not an infinite increase — the backend already
 * makes that distinction and this preserves it.
 */
export function changeLabel(change) {
  if (!change) return { text: NA, direction: 'flat', tone: 'neutral' };
  if (typeof change === 'number') {
    return {
      text: `${change > 0 ? '+' : ''}${change.toFixed(1)}%`,
      direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
      // Rising cost is bad, falling cost is good — the opposite of most metrics.
      tone: change > 0 ? 'danger' : change < 0 ? 'success' : 'neutral',
    };
  }
  if (isMissing(change.percent)) {
    return {
      text: change.label || NA,
      direction: 'flat',
      tone: change.kind === 'new' ? 'warning' : 'neutral',
      reason: change.reason,
    };
  }
  const p = Number(change.percent);
  return {
    text: `${p > 0 ? '+' : ''}${p.toFixed(1)}%`,
    direction: p > 0 ? 'up' : p < 0 ? 'down' : 'flat',
    tone: p > 0 ? 'danger' : p < 0 ? 'success' : 'neutral',
    reason: change.reason,
  };
}

/** Human label for a provenance source. Never calls list pricing "actual spend". */
export const SOURCE_LABELS = {
  provider_billing: 'Billing API',
  provider_price_list: 'Price List API',
  provider_estimate: 'Provider estimate',
  calculated: 'Calculated',
  unknown: 'Unknown source',
  not_available: 'Unavailable',
  cloud_cost_facts: 'Stored billing history',
  billing_api: 'Billing API',
};

export function sourceLabel(source) {
  if (!source) return 'Unknown source';
  return SOURCE_LABELS[source] || source;
}

/** Data-status → badge tone + label. `partial` must never read as success. */
export const STATUS_META = {
  complete: { label: 'Complete', tone: 'success' },
  no_data: { label: 'No billing data', tone: 'neutral' },
  partial: { label: 'Partial', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
  permission_denied: { label: 'Permission denied', tone: 'danger' },
  rate_limited: { label: 'Rate limited', tone: 'warning' },
  not_supported: { label: 'Not supported', tone: 'neutral' },
};

export const QUALITY_META = {
  good: { label: 'Good', tone: 'success' },
  partial: { label: 'Partial', tone: 'warning' },
  limited: { label: 'Limited', tone: 'info' },
  unavailable: { label: 'Unavailable', tone: 'danger' },
};

/** "8 minutes ago" from an ISO timestamp, or NA. Never "just now" for unknown. */
export function relativeTime(iso) {
  if (!iso) return NA;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return NA;
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** "01 Aug 2026" — the unambiguous form, never 08/01 which reverses by locale. */
export function formatDate(iso) {
  if (!iso) return NA;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return NA;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatDateShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

/**
 * The fixed categorical series order. Assigned by index and NEVER cycled: a
 * ninth series folds into "Other" rather than reusing series 1's colour, which
 * would make two different things look like the same thing.
 */
export const SERIES_VARS = [
  'var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)',
  'var(--chart-5)', 'var(--chart-6)', 'var(--chart-7)', 'var(--chart-8)',
];
export const MAX_SERIES = SERIES_VARS.length;

export function seriesColor(index) {
  return SERIES_VARS[index] ?? 'var(--chart-track)';
}

/**
 * Collapse a ranked list to the top N plus a single "Other" bucket, so the
 * categorical palette is never exhausted. Returns {items, other}.
 */
export function topNWithOther(rows, n = MAX_SERIES - 1, valueKey = 'amount') {
  const sorted = [...rows].sort(
    (a, b) => (Number(b[valueKey]) || 0) - (Number(a[valueKey]) || 0),
  );
  if (sorted.length <= n + 1) return { items: sorted, other: null };
  const items = sorted.slice(0, n);
  const rest = sorted.slice(n);
  const knownTotal = rest.reduce(
    (sum, r) => (isMissing(r[valueKey]) ? sum : sum + Number(r[valueKey])), 0,
  );
  return {
    items,
    other: { name: 'Other', [valueKey]: knownTotal, count: rest.length },
  };
}

/**
 * Group per-currency rows by currency. Multi-cloud estates bill in more than
 * one, and a single combined total across them is not a number — the UI shows
 * one block per currency instead.
 */
export function groupByCurrency(rows) {
  const out = new Map();
  (rows || []).forEach((row) => {
    const key = row.currency || 'UNKNOWN';
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(row);
  });
  return [...out.entries()].map(([currency, items]) => ({ currency, items }));
}
