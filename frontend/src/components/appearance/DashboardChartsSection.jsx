import { lazy, Suspense, useEffect, useState } from 'react';
import { Cpu } from 'lucide-react';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import Button from '@/components/ui/Button';
import { Field, Section, Segmented, Select } from '@/components/ui/Field';
import { Tile, TileGrid, WIDE } from './Tile';
import {
  CHART_STYLES, DISPLAY_MODES, INDICATOR_STYLES, SCOPES, useDashboardAppearance,
} from '@/context/DashboardAppearanceContext';

// Lazy: Gauge pulls in TrendChart (recharts), which every dashboard page
// already loads lazily per-route. This component is reachable eagerly too
// (Settings' quick appearance drawer, mounted in AppShell on every page) —
// importing Gauge directly here would force that whole chart bundle into
// the main eager chunk. Lazy keeps it a one-time, on-demand load instead.
const Gauge = lazy(() => import('@/components/gauges/Gauge'));

// Sample data so the "graph" display mode preview shows a real trend line
// immediately, instead of the "Building history…" state a fresh live gauge
// starts in.
const PREVIEW_HISTORY = [58, 62, 60, 66, 71, 68, 74, 70, 65, 69, 72, 62]
  .map((v, t) => ({ t, v }));

/**
 * Dashboard charts & indicators — the per-technology appearance the engine
 * dashboards read.
 *
 * This is a UI for the EXISTING `DashboardAppearanceContext`, not a second system:
 * every <Gauge> and <TrendChart> already resolves its style from that context via
 * the scope its dashboard sets, and values persist server-side. The picker used to
 * live deep inside SettingsPage; surfacing it here keeps UI configuration in one
 * place.
 *
 * Only the styles the context exposes are offered — those are exactly the ones
 * actually implemented. (SettingsPage also lists unbuilt placeholders and has to
 * guard against saving them; there is nothing to guard against here.)
 */

const INDICATOR_LABELS = { ring: 'Ring', stat: 'Stat', donut: 'Donut', minimal: 'Minimal', dial: 'Dial' };
const INDICATOR_HINTS = {
  ring: 'A filled arc around the value',
  stat: 'A big number with a trend sparkline',
  donut: 'A filled ring around the value',
  minimal: 'Just a coloured dot and the number',
  dial: 'A speedometer with tick marks and a needle',
};

const CHART_LABELS = {
  line: 'Line', area: 'Area', bar: 'Column', barh: 'Bar', pie: 'Pie', donut: 'Donut',
  gauge: 'Gauge', bubble: 'Bubble', scatter: 'Scatter', spark: 'Sparkline', gantt: 'Gantt',
};

const CHART_ICONS = {
  line: 'chart-line', area: 'chart-line', bar: 'chart-column', barh: 'chart-bar',
  pie: 'chart-pie', donut: 'chart-donut', gauge: 'chart-gauge', bubble: 'circle',
  scatter: 'circle', spark: 'trend', gantt: 'rows',
};

/* ── style-picker thumbnails ──────────────────────────────────────────────
   Small, self-contained glyphs — NOT the real dashboard-tile renderers,
   which each carry their own card chrome, sizing and padding sized for a
   full dashboard, not a side-by-side comparison. Every thumbnail sits in
   the exact same card shape here (see GaugeStyleCard), so only the glyph
   differs — the same "one shape, swap the content" pattern as the Theme
   and Chart Palette pickers elsewhere on this page. */
const ARC_START = 135;
const ARC_SWEEP = 270;
function polar(cx, cy, r, deg) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}
function arcPath(cx, cy, r, a0, a1) {
  const p0 = polar(cx, cy, r, a0);
  const p1 = polar(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${p0.x},${p0.y} A ${r},${r} 0 ${large} 1 ${p1.x},${p1.y}`;
}
function RingThumb({ pct, c }) {
  const angle = ARC_START + (pct / 100) * ARC_SWEEP;
  return (
    <svg viewBox="0 0 100 100" className="h-16 w-16">
      <path d={arcPath(50, 50, 40, ARC_START, ARC_START + ARC_SWEEP)} stroke="var(--border)" strokeWidth="9" fill="none" />
      <path d={arcPath(50, 50, 40, ARC_START, angle)} stroke={c} strokeWidth="9" strokeLinecap="round" fill="none" />
    </svg>
  );
}
function DonutThumb({ pct, c }) {
  const r = 34;
  const circ = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 100 100" className="h-16 w-16">
      <circle cx="50" cy="50" r={r} stroke="var(--border)" strokeWidth="10" fill="none" />
      <circle
        cx="50" cy="50" r={r} stroke={c} strokeWidth="10" fill="none" strokeLinecap="round"
        strokeDasharray={`${(pct / 100) * circ} ${circ}`} transform="rotate(-90 50 50)"
      />
    </svg>
  );
}
function DialThumb({ pct, c }) {
  const angle = ARC_START + (pct / 100) * ARC_SWEEP;
  const tip = polar(50, 50, 27, angle);
  return (
    <svg viewBox="0 0 100 100" className="h-16 w-16">
      {[0, 25, 50, 75, 100].map((t) => {
        const a = ARC_START + (t / 100) * ARC_SWEEP;
        const p1 = polar(50, 50, 38, a);
        const p2 = polar(50, 50, 44, a);
        return <line key={t} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="var(--fg-subtle)" strokeWidth="1.5" />;
      })}
      <path d={arcPath(50, 50, 34, ARC_START, ARC_START + ARC_SWEEP)} stroke="var(--border)" strokeWidth="4" fill="none" />
      <path d={arcPath(50, 50, 34, ARC_START, angle)} stroke={c} strokeWidth="4" strokeLinecap="round" fill="none" />
      <line x1="50" y1="50" x2={tip.x} y2={tip.y} stroke={c} strokeWidth="2" strokeLinecap="round" />
      <circle cx="50" cy="50" r="4" fill={c} />
    </svg>
  );
}
function StatThumb({ pct, c }) {
  const bars = [40, 55, 48, 62, 58, 68, pct];
  const max = Math.max(...bars, 1);
  return (
    <svg viewBox="0 0 100 64" className="h-16 w-16">
      {bars.map((v, i) => {
        const h = (v / max) * 48;
        const last = i === bars.length - 1;
        return (
          <rect
            key={i} x={i * 14 + 1} y={58 - h} width="10" height={h} rx="2"
            fill={last ? c : 'var(--border)'}
          />
        );
      })}
    </svg>
  );
}
function MinimalThumb({ c }) {
  return (
    <svg viewBox="0 0 100 100" className="h-16 w-16">
      <circle cx="50" cy="50" r="10" fill={c} />
    </svg>
  );
}
const THUMBS = { ring: RingThumb, donut: DonutThumb, dial: DialThumb, stat: StatThumb, minimal: MinimalThumb };

/* No sample number here on purpose — this card is about picking a LOOK, not
   previewing real data (that's what the Live preview tile below is for).
   Repeating "68%" on both would just read as the same thing shown twice. */
function GaugeStyleCard({ id, active, onSelect }) {
  const c = 'var(--accent)';
  const Thumb = THUMBS[id] || RingThumb;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      title={INDICATOR_HINTS[id]}
      className={cn(
        'relative flex flex-col items-center gap-2 rounded-lg border bg-surface p-4 text-center transition-all duration-150',
        active
          ? 'border-accent bg-accent-soft shadow-[0_4px_16px_-4px_var(--accent)]'
          : 'border-border hover:-translate-y-0.5 hover:border-strong hover:shadow-md',
      )}
    >
      {active && (
        <span className="absolute top-2 right-2 grid h-4 w-4 place-items-center rounded-full bg-accent text-accent-fg">
          <Icon name="check" size={9} strokeWidth={3.5} />
        </span>
      )}
      <Thumb pct={68} c={c} />
      <span className={cn('text-[11.5px] font-semibold', active ? 'text-accent-text' : 'text-fg')}>
        {INDICATOR_LABELS[id] || id}
      </span>
      <span className="text-[10px] leading-snug text-subtle">{INDICATOR_HINTS[id]}</span>
    </button>
  );
}

export default function DashboardChartsSection() {
  const [scope, setScope] = useState('mysql');
  const {
    indicatorStyle, chartStyle, displayMode, isOverridden, loading, saving, saveScope, resetScope,
  } = useDashboardAppearance(scope);

  const [draft, setDraft] = useState({ indicatorStyle, chartStyle, displayMode });
  const [message, setMessage] = useState(null);

  // Re-seed the draft whenever the scope's saved values change.
  useEffect(() => {
    setDraft({ indicatorStyle, chartStyle, displayMode });
    setMessage(null);
  }, [indicatorStyle, chartStyle, displayMode, scope]);

  const dirty = draft.indicatorStyle !== indicatorStyle
    || draft.chartStyle !== chartStyle
    || draft.displayMode !== displayMode;

  const scopeLabel = SCOPES.find((s) => s.key === scope)?.label || scope;

  const save = () => {
    setMessage(null);
    saveScope(scope, draft)
      .then(() => setMessage({ ok: true, text: `Saved - applied to ${scopeLabel}.` }))
      // Persisting needs a signed-in session; say so rather than failing silently.
      .catch((e) => setMessage({
        ok: false,
        text: e?.status === 401 || e?.status === 403
          ? 'Sign in to save dashboard appearance - it is stored per user on the server.'
          : (e?.message || 'Could not save.'),
      }));
  };

  const reset = () => {
    setMessage(null);
    resetScope(scope)
      .then(() => setMessage({ ok: true, text: `${scopeLabel} now inherits All technologies.` }))
      .catch((e) => setMessage({ ok: false, text: e?.message || 'Could not reset.' }));
  };

  return (
    <Section title="Dashboard charts" icon="chart-bar">
      <TileGrid>
        <Tile>
          <Field
            label="Applies to"
            hint="Each technology keeps its own styles; All technologies is the fallback"
          >
            <Select
              value={scope}
              onChange={setScope}
              options={SCOPES.map((s) => ({ id: s.key, label: s.label }))}
            />
            {isOverridden && (
              <p className="mt-1.5 flex items-center gap-1 text-[11px] text-accent-text">
                <Icon name="check" size={11} /> {scopeLabel} has its own settings
              </p>
            )}
          </Field>
        </Tile>

        <Tile>
          <Field label="Display mode" hint="Show those tiles as dials, or as small graphs">
            <Segmented
              columns={2}
              size="sm"
              value={draft.displayMode}
              onChange={(v) => setDraft((d) => ({ ...d, displayMode: v }))}
              options={DISPLAY_MODES.map((m) => ({ id: m, label: m === 'gauge' ? 'Gauge' : 'Graph' }))}
            />
          </Field>
        </Tile>

        {/* Chart style only draws anything in "graph" (trend) mode — showing
            it while "gauge" mode is picked would offer a choice that does
            nothing yet. */}
        {draft.displayMode === 'graph' && (
          <Tile className={WIDE}>
            <Field label="Chart style" hint="Used by every trend panel on that technology's dashboard">
              <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
                {CHART_STYLES.map((s) => {
                  const active = draft.chartStyle === s;
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setDraft((d) => ({ ...d, chartStyle: s }))}
                      aria-pressed={active}
                      className={cn(
                        'flex flex-col items-center gap-1 rounded-control border bg-surface px-1 py-2 transition-colors',
                        active ? 'border-accent-border bg-accent-soft' : 'border-border hover:border-strong',
                      )}
                    >
                      <Icon
                        name={CHART_ICONS[s] || 'chart-bar'}
                        size={15}
                        className={active ? 'text-accent-text' : 'text-subtle'}
                      />
                      <span
                        className={cn(
                          'truncate-safe w-full text-center text-[10px] font-semibold',
                          active ? 'text-accent-text' : 'text-muted',
                        )}
                      >
                        {CHART_LABELS[s] || s}
                      </span>
                    </button>
                  );
                })}
              </div>
            </Field>
          </Tile>
        )}

        {/* Gauge Type — only meaningful in "gauge" display mode. Selecting one
            updates `draft.indicatorStyle` immediately, which the Live
            preview tile below re-renders from on every click. */}
        {draft.displayMode === 'gauge' && (
          <Tile className={WIDE}>
            <div className="mb-3 flex items-center justify-between">
              <p className="text-[12px] font-semibold text-fg">Gauge type</p>
              <p className="text-[11px] text-subtle">Click a style to select it</p>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {INDICATOR_STYLES.map((s) => (
                <GaugeStyleCard
                  key={s}
                  id={s}
                  active={draft.indicatorStyle === s}
                  onSelect={() => setDraft((d) => ({ ...d, indicatorStyle: s }))}
                />
              ))}
            </div>
          </Tile>
        )}

        {/* Live preview — the REAL production <Gauge>, not the simplified
            picker glyphs above, so this is exactly what {scopeLabel}'s
            dashboards will render once Apply is clicked. Re-renders on every
            pick above since it reads straight from `draft`. */}
        <Tile className={WIDE}>
          <div className="mb-3">
            <p className="text-[12px] font-semibold text-fg">Live preview</p>
            <p className="text-[11px] text-subtle">Exactly how {scopeLabel}'s dashboard will render it</p>
          </div>
          <Suspense fallback={<div className="flex h-[220px] items-center justify-center text-[11px] text-subtle">Loading preview…</div>}>
            <div className="mx-auto max-w-xs">
              <Gauge
                pct={68}
                icon={Cpu}
                label="CPU usage"
                sub={`${scopeLabel} · sample data`}
                spark={PREVIEW_HISTORY.map((h) => h.v)}
                styleOverride={draft.indicatorStyle}
                displayModeOverride={draft.displayMode}
                chartStyleOverride={draft.chartStyle}
                historyOverride={PREVIEW_HISTORY}
              />
            </div>
          </Suspense>
        </Tile>
      </TileGrid>

      {message && (
        <p
          className={cn(
            'mt-4 flex items-start gap-2 rounded-control px-3 py-2 text-[12px] font-medium',
            message.ok ? 'bg-success-soft text-success-fg' : 'bg-danger-soft text-danger-fg',
          )}
        >
          <Icon name={message.ok ? 'check' : 'alert'} size={13} className="mt-px shrink-0" />
          {message.text}
        </p>
      )}

      <div className="mt-4 flex items-center gap-2 border-t border-border pt-4">
        <Button
          variant="primary"
          size="sm"
          icon="save"
          loading={saving}
          disabled={!dirty || loading}
          onClick={save}
        >
          {dirty ? 'Apply' : 'Applied'}
        </Button>
        {isOverridden && (
          <Button variant="secondary" size="sm" icon="refresh" onClick={reset}>
            Inherit
          </Button>
        )}
      </div>
    </Section>
  );
}
