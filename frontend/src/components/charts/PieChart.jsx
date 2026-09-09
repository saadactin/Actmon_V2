import { useMemo, useState } from 'react';
import cn from '@/lib/cn';

/**
 * Pie / donut — part-to-whole at a glance.
 *
 * `donut` just sets an inner radius, so both forms share one implementation.
 *
 * Guardrails that stay on whichever form the user picks:
 *   • the tail past `maxSlices` folds into "Other" — past ~6 wedges adjacent
 *     angles stop being distinguishable, and generating more hues would break
 *     the palette's colourblind ordering
 *   • the legend always lists every category, so no wedge is angle-only
 *   • slices are separated by a 2px stroke in the surface colour — the radial
 *     equivalent of the surface gap, not a border drawn around each mark
 *
 * `legend`
 *   'side'   the reading list sits beside the ring: label, value and share.
 *            Right for a narrow card where the ring can only be small.
 *   'below'  a centred single row under the ring: swatch, label, value. Right
 *            for a square card where the ring should be the whole width.
 *
 * A category with a value of zero cannot be drawn — but it is still a fact worth
 * reading ("Warning 0" is the good news on a fleet-health card), so the legend is
 * built from the INPUT list, not from the drawn slices.
 */
export default function PieChart({
  items,
  donut = true,
  size = 168,
  maxSlices = 6,
  unit = '',
  format = (v) => v,
  emptyLabel = 'No data',
  legend = 'side',
  centerLabel,
}) {
  const [active, setActive] = useState(null);

  const { slices, total } = useMemo(() => {
    const positive = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
    let list = positive;

    if (positive.length > maxSlices) {
      const head = positive.slice(0, maxSlices - 1);
      const tail = positive.slice(maxSlices - 1);
      list = [
        ...head,
        {
          key: '__other__',
          label: `Other (${tail.length})`,
          value: tail.reduce((s, i) => s + i.value, 0),
          color: 'var(--status-unknown)',
          sub: tail.map((t) => t.label).join(', '),
        },
      ];
    }

    const sum = list.reduce((s, i) => s + i.value, 0);
    let angle = -90; // start at 12 o'clock
    return {
      total: sum,
      slices: list.map((item, i) => {
        const sweep = sum ? (item.value / sum) * 360 : 0;
        const slice = {
          ...item,
          color: item.color || `var(--chart-${(i % 8) + 1})`,
          start: angle,
          end: angle + sweep,
          share: sum ? (item.value / sum) * 100 : 0,
        };
        angle += sweep;
        return slice;
      }),
    };
  }, [items, maxSlices]);

  if (!total) return <p className="py-6 text-center text-[13px] text-subtle">{emptyLabel}</p>;

  const r = size / 2;
  const inner = donut ? r * 0.58 : 0;

  /* A slice's colour is assigned by its rank, so the legend has to read it back
     off the slice rather than recompute it — otherwise a zero-value row and its
     ring would disagree the moment the sort order changed. */
  const colorFor = (item, i) => slices.find((s) => s.key === item.key)?.color
    || item.status?.color
    || item.color
    || `var(--chart-${(i % 8) + 1})`;

  const ring = (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Share of total">
        {slices.map((s) => (
          <path
            key={s.key}
            d={arcPath(r, r, r - 1, inner, s.start, s.end)}
            fill={s.color}
            /* 2px surface stroke = the surface gap, radially */
            stroke="var(--surface)"
            strokeWidth={2}
            className="cursor-default transition-opacity duration-[var(--dur-fast)]"
            style={{ opacity: active && active !== s.key ? 0.45 : 1 }}
            onMouseEnter={() => setActive(s.key)}
            onMouseLeave={() => setActive(null)}
          >
            <title>{`${s.label}: ${format(s.value)}${unit} (${Math.round(s.share)}%)`}</title>
          </path>
        ))}
      </svg>

      {donut && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center px-6 text-center">
          {active ? (
            <span>
              <span className="block text-xl leading-none font-bold text-fg">
                {Math.round(slices.find((s) => s.key === active)?.share ?? 0)}%
              </span>
              <span className="mt-1 block max-w-[92px] truncate text-[10px] font-semibold text-subtle">
                {slices.find((s) => s.key === active)?.label}
              </span>
            </span>
          ) : legend === 'below' ? (
            /* Only what the card asked for. An unexplained big number in the hole
               competes with the ring it sits inside. */
            centerLabel ? <span className="text-[12px] font-medium text-muted">{centerLabel}</span> : null
          ) : (
            <span>
              <span className="block text-2xl leading-none font-bold text-fg">{format(total)}</span>
              <span className="mt-1 block text-[10px] font-semibold text-subtle">total</span>
            </span>
          )}
        </div>
      )}
    </div>
  );

  if (legend === 'below') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        {ring}
        <ul className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
          {items.map((item, i) => {
            const tint = colorFor(item, i);
            return (
              <li
                key={item.key}
                onMouseEnter={() => setActive(item.key)}
                onMouseLeave={() => setActive(null)}
                className={cn('flex items-center gap-1.5 text-[12px]', item.onClick && 'cursor-pointer')}
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: tint }} />
                <button
                  type="button"
                  onClick={item.onClick}
                  disabled={!item.onClick}
                  className={cn('flex items-center gap-1.5', item.onClick && 'hover:underline')}
                >
                  <span className="font-medium text-muted">{item.label}</span>
                  <span className="font-bold text-fg tabular-nums">{format(item.value)}{unit}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-3">
      {ring}

      {/* Legend is not optional on a pie — it is how values are actually read. */}
      <ul className="min-w-[130px] flex-1 space-y-1.5">
        {slices.map((s) => {
          const row = (
            <>
              <span className="h-2.5 w-2.5 shrink-0 rounded-xs" style={{ background: s.color }} />
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted" title={s.sub || s.label}>
                {s.label}
              </span>
              <span className="shrink-0 text-[11px] font-bold text-fg tabular-nums">{format(s.value)}{unit}</span>
              <span className="w-8 shrink-0 text-right text-[10px] text-subtle tabular-nums">
                {Math.round(s.share)}%
              </span>
            </>
          );
          return (
            <li
              key={s.key}
              onMouseEnter={() => setActive(s.key)}
              onMouseLeave={() => setActive(null)}
              className={cn(
                'flex items-center gap-2 rounded-sm px-1 py-0.5 transition-colors',
                active === s.key && 'bg-sunken',
                s.onClick && 'cursor-pointer',
              )}
            >
              {s.onClick
                ? <button type="button" onClick={s.onClick} className="flex w-full items-center gap-2">{row}</button>
                : row}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * SVG path for one wedge (or ring segment when innerR > 0).
 * Angles are degrees clockwise from 12 o'clock.
 */
function arcPath(cx, cy, outerR, innerR, startDeg, endDeg) {
  // A full circle can't be drawn as a single arc — close it as two halves.
  const sweep = endDeg - startDeg;
  if (sweep >= 359.999) {
    const mid = startDeg + 180;
    return `${arcPath(cx, cy, outerR, innerR, startDeg, mid)} ${arcPath(cx, cy, outerR, innerR, mid, endDeg - 0.001)}`;
  }

  const p = (deg, rad) => {
    const a = (deg * Math.PI) / 180;
    return [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
  };
  const large = sweep > 180 ? 1 : 0;
  const [x1, y1] = p(startDeg, outerR);
  const [x2, y2] = p(endDeg, outerR);

  if (innerR <= 0) {
    return `M ${cx} ${cy} L ${x1} ${y1} A ${outerR} ${outerR} 0 ${large} 1 ${x2} ${y2} Z`;
  }
  const [x3, y3] = p(endDeg, innerR);
  const [x4, y4] = p(startDeg, innerR);
  return `M ${x1} ${y1} A ${outerR} ${outerR} 0 ${large} 1 ${x2} ${y2} `
    + `L ${x3} ${y3} A ${innerR} ${innerR} 0 ${large} 0 ${x4} ${y4} Z`;
}
