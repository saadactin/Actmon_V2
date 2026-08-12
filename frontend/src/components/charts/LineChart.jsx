import { useMemo, useRef, useState } from 'react';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import { UTILISATION_BANDS } from '@/components/charts/status';

/**
 * Utilisation band boundaries (60/75/90 — see components/charts/status.js's
 * `bandFor`), drawn as dashed reference lines when a caller opts in via
 * `thresholds`. Dashed on purpose, unlike this chart's solid gridlines: a
 * threshold is a semantic marker ("this is where it gets bad"), not part of
 * the neutral grid, and the house rule against dashed lines is about not
 * blurring that distinction — not a blanket ban.
 */
const THRESHOLD_LINES = [
  { value: 60, color: UTILISATION_BANDS[1].color },
  { value: 75, color: UTILISATION_BANDS[2].color },
  { value: 90, color: UTILISATION_BANDS[3].color },
];

/**
 * Time-series chart — the `trend` family in chartKinds.js: area (default),
 * line, column, step or sparkline, picked from the same ⋮ menu every other
 * ChartCard offers, with the choice remembered per card.
 *
 * Hand-rolled SVG for the same reasons as the other charts here: exact control
 * over the mark specs, and it themes from tokens with no library.
 *
 * Follows the house rules:
 *   • 2px line, round join and cap; area fill is the same hue at ~10%
 *   • gridlines are solid hairlines one step off the surface — never dashed
 *   • one y-axis, always (a second scale invents correlations that aren't there)
 *   • a crosshair snaps to the nearest sample, so the reader aims at a time and
 *     not at a 2px line; the hit area is the whole plot (sparkline excepted —
 *     it is deliberately chrome-free, the point of reaching for it at all)
 *   • the last value is direct-labelled, so the number is readable without hover
 *   • single series → no legend box; the card title says what is plotted
 *
 *   data   [{ label, value }] in chronological order
 *   unit   appended to every rendered value
 *   domain [min, max] — omit for auto (0 → nice max)
 *   kind   'area' | 'line' | 'column' | 'step' | 'spark'
 */
/** Plot insets — left leaves room for y labels, bottom for the time labels. */
const PAD = { top: 10, right: 12, bottom: 22, left: 40 };

export default function LineChart({
  data = [],
  color = 'var(--chart-1)',
  unit = '%',
  domain,
  height = 200,
  kind = 'area',
  emptyLabel = 'No samples yet',
  emptyHint,
  /** Draw the Normal/Elevated/High/Critical utilisation bands (60/75/90) —
      only meaningful for a 0–100 percentage metric like CPU/memory/disk. */
  thresholds = false,
}) {
  const [hover, setHover] = useState(null);
  const wrapRef = useRef(null);
  const compact = kind === 'spark';

  // Fixed viewBox; the SVG scales to its container, so no resize observer needed.
  const W = 600;
  const H = height;

  const plot = useMemo(() => {
    const points = data.filter((d) => Number.isFinite(Number(d.value)));
    if (points.length === 0) return null;

    const values = points.map((d) => Number(d.value));
    const lo = domain?.[0] ?? 0;
    const hi = domain?.[1] ?? niceMax(Math.max(...values, 1));

    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const baseY = PAD.top + innerH;
    const x = (i) => PAD.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
    const y = (v) => PAD.top + innerH - ((Math.min(Math.max(v, lo), hi) - lo) / (hi - lo || 1)) * innerH;

    // Diagonal (area/line) path — straight segment sample to sample.
    const diagonal = points.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(Number(d.value)).toFixed(1)}`).join(' ');

    // Step path — holds each value flat until the NEXT sample, then jumps.
    // Reads as "this held steady, then changed" rather than a drift between
    // two readings that were never actually measured in between.
    const step = points.map((d, i) => {
      const yi = y(Number(d.value)).toFixed(1);
      if (i === 0) return `M ${x(0).toFixed(1)} ${yi}`;
      return `L ${x(i).toFixed(1)} ${y(Number(points[i - 1].value)).toFixed(1)} L ${x(i).toFixed(1)} ${yi}`;
    }).join(' ');

    const line = kind === 'step' ? step : diagonal;
    const fill = `${line} L ${x(points.length - 1).toFixed(1)} ${baseY.toFixed(1)} L ${x(0).toFixed(1)} ${baseY.toFixed(1)} Z`;

    // 4 gridlines at clean fractions of the domain
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const v = lo + (hi - lo) * f;
      return { v, y: y(v) };
    });

    // Evenly-spaced x labels (not just the two endpoints) so the axis reads
    // against the selected range/granularity instead of only "start…end".
    const xTickN = Math.min(6, points.length);
    const xTicks = points.length <= 1
      ? [0]
      : Array.from({ length: xTickN }, (_, i) => Math.round((i * (points.length - 1)) / (xTickN - 1)));

    return { points, x, y, line, fill, ticks, xTicks, lo, hi, innerW, innerH, baseY };
  }, [data, domain, H, kind]);

  if (!plot) {
    return (
      <div className="grid place-items-center gap-1.5 text-center" style={{ height }}>
        <Icon name="trend" size={20} className="text-subtle" />
        <p className="text-[12px] font-medium text-muted">{emptyLabel}</p>
        {emptyHint && <p className="max-w-xs text-[11px] text-subtle">{emptyHint}</p>}
      </div>
    );
  }

  const { points, x, y, line, fill, ticks, xTicks, baseY } = plot;
  const last = points[points.length - 1];
  const active = hover !== null ? points[hover] : null;
  const showArea = kind === 'area' || kind === 'step' || kind === 'spark';

  /** Nearest sample to the pointer — the reader only has to be closest. */
  const onMove = (e) => {
    const box = wrapRef.current?.getBoundingClientRect();
    if (!box) return;
    const ratio = (e.clientX - box.left) / box.width; // → viewBox space
    const px = ratio * W;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i += 1) {
      const d = Math.abs(x(i) - px);
      if (d < bestD) { bestD = d; best = i; }
    }
    setHover(best);
  };

  const fmt = (v) => `${Math.round(Number(v) * 10) / 10}${unit}`;
  // Column width: the gap between samples, minus a hairline so bars don't touch.
  const colW = points.length > 1 ? Math.max(2, (plot.innerW / (points.length - 1)) * 0.6) : 24;

  return (
    <div>
      <div ref={wrapRef} className="relative" style={{ height }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="h-full w-full touch-none"
          onMouseMove={compact ? undefined : onMove}
          onMouseLeave={compact ? undefined : () => setHover(null)}
          role="img"
          aria-label="Time series"
        >
          {/* gridlines + y ticks — omitted entirely for a sparkline */}
          {!compact && ticks.map((t) => (
            <g key={t.v}>
              <line
                x1={PAD.left} x2={W - PAD.right} y1={t.y} y2={t.y}
                stroke="var(--chart-grid)" strokeWidth="1" vectorEffect="non-scaling-stroke"
              />
              <text
                x={PAD.left - 6} y={t.y + 3} textAnchor="end"
                fill="var(--chart-axis)" style={{ fontSize: 9 }}
              >
                {Math.round(t.v)}{unit}
              </text>
            </g>
          ))}

          {kind === 'column' ? (
            points.map((d, i) => (
              <rect
                key={i}
                x={x(i) - colW / 2} y={y(Number(d.value))}
                width={colW} height={Math.max(0, baseY - y(Number(d.value)))}
                fill={color} opacity={hover === i ? 1 : 0.85} rx="1.5"
              />
            ))
          ) : (
            <>
              {showArea && <path d={fill} fill={color} opacity="0.1" />}

              {/* utilisation thresholds — drawn ABOVE the area fill so they stay
                  visible over it, dashed to read as markers rather than data */}
              {thresholds && !compact && THRESHOLD_LINES.filter((t) => t.value > plot.lo && t.value < plot.hi).map((t) => (
                <line
                  key={t.value}
                  x1={PAD.left} x2={W - PAD.right} y1={y(t.value)} y2={y(t.value)}
                  stroke={t.color} strokeWidth="1.5" strokeDasharray="5 4"
                  opacity="0.55" vectorEffect="non-scaling-stroke"
                />
              ))}

              <path
                d={line} fill="none" stroke={color} strokeWidth={compact ? 1.5 : 2}
                strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"
              />
            </>
          )}

          {/* end marker — ≥8px with a 2px surface ring so it reads over the line */}
          {!compact && (
            <circle
              cx={x(points.length - 1)} cy={y(Number(last.value))} r="4"
              fill={color} stroke="var(--surface)" strokeWidth="2" vectorEffect="non-scaling-stroke"
            />
          )}

          {/* crosshair */}
          {active && !compact && (
            <g>
              <line
                x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={H - PAD.bottom}
                stroke="var(--chart-axis)" strokeWidth="1" vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={x(hover)} cy={y(Number(active.value))} r="4.5"
                fill={color} stroke="var(--surface)" strokeWidth="2" vectorEffect="non-scaling-stroke"
              />
            </g>
          )}

          {/* evenly-spaced x labels, per the selected range/granularity —
              edges anchor outward so they don't clip past the plot area */}
          {!compact && xTicks.map((i, ti) => (
            <text
              key={i}
              x={x(i)}
              y={H - 6}
              textAnchor={ti === 0 ? 'start' : ti === xTicks.length - 1 ? 'end' : 'middle'}
              fill="var(--chart-axis)"
              style={{ fontSize: 9 }}
            >
              {points[i].label}
            </text>
          ))}
        </svg>

        {/* current / hovered value, always visible — never tooltip-gated */}
        {!compact && (
          <div className="pointer-events-none absolute top-0 right-0 text-right">
            <span className="block text-[17px] leading-none font-bold text-fg">
              {fmt(active ? active.value : last.value)}
            </span>
            <span className="mt-0.5 block text-[10px] text-subtle">
              {active ? active.label : 'latest'}
            </span>
          </div>
        )}

        {/* floating tooltip pinned to the crosshair — the top-right readout
            covers "what's the latest", this covers "what's under my cursor" */}
        {active && !compact && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-control border border-border bg-surface px-2 py-1 shadow-md"
            style={{
              left: `${(x(hover) / W) * 100}%`,
              top: `${Math.max((y(Number(active.value)) / H) * 100 - 4, 2)}%`,
            }}
          >
            <div className="text-[12px] font-bold text-fg">{fmt(active.value)}</div>
            <div className="text-[10px] text-subtle">{active.label}</div>
          </div>
        )}
      </div>
      {thresholds && !compact && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {UTILISATION_BANDS.map((b) => (
            <span key={b.id} className="inline-flex items-center gap-1.5 text-[10px] font-medium text-subtle">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: b.color }} aria-hidden="true" />
              {b.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Round a max up to something a reader can divide by eye. */
function niceMax(v) {
  if (v <= 1) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / mag) * mag;
}
