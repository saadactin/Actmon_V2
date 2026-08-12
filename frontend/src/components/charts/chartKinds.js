import { create } from 'zustand';

/**
 * CHART TYPE CHOICE
 *
 * Every chart card offers the forms that are *valid for its data*, and the user
 * picks. Their choice is remembered per card, so one dashboard can mix a donut
 * here and a bar there instead of forcing one look everywhere.
 *
 * Two things are still enforced, because they are correctness rather than taste:
 *   • Only forms that can express the data are offered. A ratio against a limit
 *     can be a meter or a gauge; it is never a pie of two slices.
 *   • One form per family is marked `recommended` — the one that reads most
 *     accurately for that job. It's the default, and it stays labelled so the
 *     trade-off is visible when someone picks a different one.
 */

/* ── families ─────────────────────────────────────────────────────────────
   flat        one value per category (magnitude or part-to-whole)
   breakdown   one category per row, each split into status segments
   ratio       values measured against a fixed limit (0–100%)
   trend       one value per moment in time — a series, not a category       */

export const CHART_KINDS = {
  trend: [
    { id: 'area', label: 'Area', icon: 'chart-line', recommended: true, hint: 'Filled — reads as a single continuous trend' },
    { id: 'line', label: 'Line', icon: 'trend', hint: 'Plain line, no fill' },
    { id: 'column', label: 'Column', icon: 'chart-column', hint: 'One bar per sample' },
    { id: 'step', label: 'Step', icon: 'activity', hint: 'Right-angle steps — for a value that jumps rather than drifts' },
    { id: 'spark', label: 'Sparkline', icon: 'zap', hint: 'Minimal, no axes — for a tight space' },
  ],
  flat: [
    { id: 'bar', label: 'Bar', icon: 'chart-bar', recommended: true, hint: 'Most accurate for comparing values' },
    { id: 'column', label: 'Column', icon: 'chart-column', hint: 'Vertical bars' },
    { id: 'stacked', label: 'Single stack', icon: 'chart-bar-stacked', hint: 'One bar, share of total' },
    { id: 'donut', label: 'Donut', icon: 'chart-donut', hint: 'Share of total at a glance' },
    { id: 'pie', label: 'Pie', icon: 'chart-pie', hint: 'Share of total at a glance' },
  ],
  breakdown: [
    { id: 'stackedBar', label: 'Stacked bar', icon: 'chart-bar-stacked', recommended: true, hint: 'Total and split per row' },
    { id: 'stackedColumn', label: 'Stacked column', icon: 'chart-column-stacked', hint: 'Vertical stacks' },
    { id: 'groupedColumn', label: 'Grouped column', icon: 'chart-column', hint: 'Segments side by side' },
    { id: 'bar', label: 'Totals bar', icon: 'chart-bar', hint: 'Totals only, no split' },
    { id: 'donut', label: 'Donut', icon: 'chart-donut', hint: 'Totals as share' },
    { id: 'pie', label: 'Pie', icon: 'chart-pie', hint: 'Totals as share' },
  ],
  ratio: [
    { id: 'meter', label: 'Meters', icon: 'chart-meter', recommended: true, hint: 'Linear, easiest to compare' },
    { id: 'gauge', label: 'Gauges', icon: 'chart-gauge', hint: 'Radial dials' },
    { id: 'column', label: 'Columns', icon: 'chart-column', hint: 'Vertical bars to 100%' },
    { id: 'bar', label: 'Bars', icon: 'chart-bar', hint: 'Horizontal bars to 100%' },
  ],
};

export const familyDefault = (family) =>
  (CHART_KINDS[family] || []).find((k) => k.recommended)?.id || CHART_KINDS[family]?.[0]?.id;

export const kindsFor = (family) => CHART_KINDS[family] || [];

export const kindMeta = (family, id) =>
  kindsFor(family).find((k) => k.id === id) || kindsFor(family)[0];

/**
 * A global nudge, set in Appearance → Charts. It only applies where the family
 * actually supports that form, so choosing "pie" doesn't turn the meters into
 * pies — it leaves them as meters.
 */
export const CHART_PREFERENCES = [
  { id: 'recommended', label: 'Recommended', hint: 'Best form for each chart' },
  { id: 'bar', label: 'Bars', hint: 'Prefer horizontal bars' },
  { id: 'column', label: 'Columns', hint: 'Prefer vertical bars' },
  { id: 'donut', label: 'Donuts', hint: 'Prefer donuts where valid' },
  { id: 'pie', label: 'Pies', hint: 'Prefer pies where valid' },
];

/* ── per-card persistence ─────────────────────────────────────────────────── */

const KEY = 'actmon.chartKinds';

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export const useChartKindStore = create((set, get) => ({
  /** { [cardId]: kindId } — only cards the user has explicitly changed. */
  chosen: load(),

  setKind: (cardId, kind) => {
    const chosen = { ...get().chosen, [cardId]: kind };
    set({ chosen });
    try { localStorage.setItem(KEY, JSON.stringify(chosen)); } catch { /* non-fatal */ }
  },

  /** Drop one card's override, or all of them, back to the defaults. */
  reset: (cardId) => {
    const chosen = { ...get().chosen };
    if (cardId) delete chosen[cardId];
    const next = cardId ? chosen : {};
    set({ chosen: next });
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* non-fatal */ }
  },
}));

/**
 * Resolve which form a card should render.
 *
 * Precedence: the user's explicit choice for this card → their global
 * preference, if this family supports it → the card's own `defaultKind` → the
 * family's recommended form.
 *
 * `defaultKind` is how a page states the form its layout was designed around
 * (the overview's donuts and gauges, for instance) without taking the choice
 * away: the picker still lists every valid form, and both the per-card override
 * and the global Appearance preference still win over it.
 */
export function resolveKind({ cardId, family, chosen, preference, defaultKind }) {
  const explicit = chosen?.[cardId];
  if (explicit && kindsFor(family).some((k) => k.id === explicit)) return explicit;

  // The card's own default outranks the global nudge. A page that states the form
  // its layout was drawn around must render that form out of the box, or the
  // layout breaks for anyone who once set a global preference. Only an explicit
  // pick on THIS card — a deliberate act — overrides it.
  if (defaultKind && kindsFor(family).some((k) => k.id === defaultKind)) return defaultKind;

  if (preference && preference !== 'recommended'
      && kindsFor(family).some((k) => k.id === preference)) {
    return preference;
  }
  return familyDefault(family);
}
