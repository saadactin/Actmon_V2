import cn from '@/lib/cn';
import Tooltip from '@/components/ui/Tooltip';

/**
 * Horizontal bars against a gridded scale.
 *
 * Horizontal because the categories are long-named (hostnames, engine names) — a
 * column chart would need angled tick labels to fit them.
 *
 * With the axis shown the value is read off the scale rather than printed at each
 * tip, which keeps a row of long hostnames from ending in a column of numbers. The
 * exact figure is still one hover away, and every card can flip to its table. With
 * the axis hidden the tip label comes back, so no form leaves a value
 * tooltip-only.
 *
 * Mark spec: square at the baseline, 4px rounded at the data end, no track behind
 * (the gridlines already show the space a bar could fill).
 *
 *   items  [{ key, label, value, color, sub, onClick }]
 *   max    axis maximum (defaults to a nice ceiling above the largest value)
 *   format value → display string
 */
export default function BarList({
  items,
  max,
  format = (v) => v,
  unit = '',
  labelWidth = 110,
  emptyLabel = 'No data',
  thickness = 34,
  showAxis = true,
}) {
  if (!items.length) {
    return <p className="py-6 text-center text-[13px] text-subtle">{emptyLabel}</p>;
  }

  const dataMax = Math.max(...items.map((i) => i.value), 0);
  const { ceiling, ticks } = scaleFor(max, dataMax);

  return (
    <div>
      <ul className="flex flex-col gap-2.5">
        {items.map((item) => {
          const width = ceiling > 0 ? Math.max((item.value / ceiling) * 100, item.value > 0 ? 1.5 : 0) : 0;
          const interactive = Boolean(item.onClick);

          const row = (
            <div
              className={cn(
                // w-full is load-bearing: Tooltip's anchor is inline-flex, so without
                // it this row shrinks to max-content — and the plot below is flex-1
                // with a 0 basis, so it contributes nothing and collapses to zero
                // width. The bar then renders 50% of nothing. Interactive rows got
                // away with it because their <button> wrapper is already w-full.
                'flex w-full items-center gap-2.5 rounded-sm',
                // Hit target spans the whole row, not just the painted bar.
                interactive && 'cursor-pointer transition-colors hover:bg-sunken',
              )}
            >
              <span
                className="truncate-safe shrink-0 text-[11px] font-medium text-muted"
                style={{ width: labelWidth }}
                title={item.label}
              >
                {item.label}
              </span>

              {/* Gridlines repeat per row rather than sitting on one plot area, so a
                  row's bar and the lines it crosses can never drift apart. */}
              <span className="relative min-w-0 flex-1" style={{ height: thickness }}>
                {showAxis && ticks.map((t) => (
                  <span
                    key={t}
                    aria-hidden="true"
                    className="grid-dash-y absolute inset-y-0"
                    style={{ left: `${(t / ceiling) * 100}%` }}
                  />
                ))}
                <span
                  className="absolute inset-y-0 left-0 transition-[width] duration-[var(--dur-normal)] ease-[var(--ease-out)]"
                  style={{
                    width: `${width}%`,
                    background: item.color || 'var(--chart-1)',
                    // square at the baseline, 4px rounded at the data end
                    borderRadius: '0 4px 4px 0',
                  }}
                />
              </span>

              {!showAxis && (
                <span className="w-14 shrink-0 text-right text-[11px] font-bold text-fg tabular-nums">
                  {format(item.value)}{unit}
                </span>
              )}
            </div>
          );

          const content = interactive
            ? <button type="button" onClick={item.onClick} className="block w-full text-left">{row}</button>
            : row;

          return (
            <li key={item.key}>
              <Tooltip
                side="top"
                delay={60}
                className="w-full"
                label={
                  <span className="flex flex-col gap-0.5">
                    {/* value leads, label follows — the reader already has the row */}
                    <b className="text-[13px]">{format(item.value)}{unit}</b>
                    <span className="opacity-75">{item.label}</span>
                    {item.sub && <span className="opacity-60">{item.sub}</span>}
                  </span>
                }
              >
                {content}
              </Tooltip>
            </li>
          );
        })}
      </ul>

      {showAxis && (
        <div className="mt-2 flex" aria-hidden="true">
          <span className="shrink-0" style={{ width: labelWidth }} />
          <span className="relative ml-2.5 min-w-0 flex-1">
            {ticks.map((t) => (
              <span
                key={t}
                className="absolute -translate-x-1/2 text-[11px] text-subtle tabular-nums"
                style={{ left: `${(t / ceiling) * 100}%` }}
              >
                {format(t)}{unit}
              </span>
            ))}
            {/* reserves the line the absolutely-placed ticks sit on */}
            <span className="block h-4" />
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * A scale a reader can do arithmetic on — four intervals, step rounded up to the
 * next 1 / 2 / 5 × 10ⁿ so the gridlines land on halvable numbers.
 */
function scaleFor(max, dataMax) {
  const INTERVALS = 4;
  if (max) {
    const step = max / INTERVALS;
    return { ceiling: max, ticks: Array.from({ length: INTERVALS + 1 }, (_, i) => i * step) };
  }

  const rough = Math.max(dataMax, 1) / INTERVALS;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / pow;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  const step = Math.max(1, nice * pow);

  const ceiling = step * INTERVALS;
  return { ceiling, ticks: Array.from({ length: INTERVALS + 1 }, (_, i) => i * step) };
}
