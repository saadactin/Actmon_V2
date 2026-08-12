import cn from '@/lib/cn';
import Tooltip from '@/components/ui/Tooltip';

/**
 * Vertical bars against a gridded scale.
 *
 * The value is read off the axis rather than printed on every cap: at three or six
 * columns a number over each bar is noise, and the gridlines give a more precise
 * read than a label per mark. Values are still reachable exactly — hover any
 * column, or flip the card to its table.
 *
 * Mark spec: 4px rounded cap at the data end, square at the baseline, no track
 * behind the column (the gridlines already show the space a bar could fill), and
 * the container reserves the x-axis band so tick labels are never cropped.
 *
 *   items  [{ key, label, value, color, sub, onClick }]
 *   mode   'simple'  one value per column
 *          'stacked' segments stacked within each column
 *          'grouped' segments side by side within each column
 */
export default function ColumnChart({
  items,
  max,
  height = 190,
  unit = '',
  format = (v) => v,
  mode = 'simple',
  emptyLabel = 'No data',
  /** Bars never grow wider than this, so three columns don't become slabs. */
  barWidth = 52,
  showAxis = true,
}) {
  if (!items.length) {
    return <p className="py-6 text-center text-[13px] text-subtle">{emptyLabel}</p>;
  }

  const totalOf = (it) =>
    mode === 'simple' ? it.value : (it.segments || []).reduce((s, x) => s + x.value, 0);

  const dataMax = Math.max(...items.map(totalOf), 0);
  const { ceiling, ticks } = scaleFor(max, dataMax);

  return (
    <div className="flex" style={{ minHeight: height + 30 }}>
      {showAxis && (
        <div className="relative mr-2 shrink-0" style={{ height, width: 22 }}>
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute right-0 -translate-y-1/2 text-[11px] text-subtle tabular-nums"
              style={{ bottom: `${(t / ceiling) * 100}%` }}
            >
              {format(t)}
            </span>
          ))}
        </div>
      )}

      <div className="min-w-0 flex-1">
        {/* Plot area — gridlines sit behind the columns, dashed so they stay
            recessive against the marks they are there to measure. */}
        <div className="relative" style={{ height }}>
          {showAxis && ticks.map((t) => (
            <span
              key={t}
              aria-hidden="true"
              className="grid-dash-x absolute inset-x-0"
              style={{ bottom: `${(t / ceiling) * 100}%` }}
            />
          ))}

          <div className="absolute inset-0 flex items-end justify-around gap-2">
            {items.map((item) => {
              const total = totalOf(item);
              const interactive = Boolean(item.onClick);

              return (
                <Tooltip
                  key={item.key}
                  side="top"
                  delay={60}
                  /* h-full is load-bearing. The row is `items-end`, so without an
                     explicit height this anchor sizes to its content — and the bar
                     inside is a PERCENTAGE height, which against an indefinite
                     parent resolves to zero and paints nothing. The plot div above
                     has a definite height, so 100% here has something to bite on. */
                  className="flex h-full min-w-0 flex-1 justify-center"
                  label={
                    <span className="flex flex-col gap-0.5">
                      <b className="text-[13px]">{format(total)}{unit}</b>
                      <span className="opacity-75">{item.label}</span>
                      {mode !== 'simple' && item.segments && (
                        <span className="opacity-60">
                          {item.segments.map((s) => `${s.label} ${s.value}`).join(' · ')}
                        </span>
                      )}
                      {item.sub && <span className="opacity-60">{item.sub}</span>}
                    </span>
                  }
                >
                  <div
                    className={cn('flex h-full w-full items-end justify-center', interactive && 'cursor-pointer')}
                    onClick={item.onClick}
                    role={interactive ? 'button' : undefined}
                    style={{ maxWidth: barWidth }}
                  >
                    {mode === 'grouped' ? (
                      <span className="flex h-full w-full items-end justify-center" style={{ gap: 2 }}>
                        {(item.segments || []).map((s) => (
                          <span
                            key={s.key}
                            className="min-w-[3px] flex-1 transition-[height] duration-[var(--dur-normal)]"
                            style={{
                              height: `${(s.value / ceiling) * 100}%`,
                              background: s.status?.color || s.color,
                              borderRadius: '4px 4px 0 0',
                            }}
                          />
                        ))}
                      </span>
                    ) : (
                      <span
                        className={cn(
                          'flex w-full flex-col-reverse overflow-hidden transition-[height] duration-[var(--dur-normal)] ease-[var(--ease-out)]',
                          interactive && 'hover:opacity-85',
                        )}
                        style={{
                          height: `${ceiling ? (total / ceiling) * 100 : 0}%`,
                          // square at the baseline, 4px rounded at the data end
                          borderRadius: '4px 4px 0 0',
                          gap: mode === 'stacked' ? 2 : 0,
                        }}
                      >
                        {mode === 'stacked'
                          ? (item.segments || [])
                            .filter((s) => s.value > 0)
                            .map((s) => (
                              <span
                                key={s.key}
                                className="w-full"
                                style={{
                                  flexGrow: s.value,
                                  flexBasis: 0,
                                  minHeight: 2,
                                  background: s.status?.color || s.color,
                                }}
                              />
                            ))
                          : <span className="h-full w-full" style={{ background: item.color || 'var(--chart-1)' }} />}
                      </span>
                    )}
                  </div>
                </Tooltip>
              );
            })}
          </div>
        </div>

        <div className="mt-2 flex items-start justify-around gap-2">
          {items.map((item) => (
            <span
              key={item.key}
              className="line-clamp-2 min-w-0 flex-1 text-center text-[11px] leading-tight break-words text-muted"
              title={item.label}
            >
              {item.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * A scale a reader can do arithmetic on.
 *
 * Always four intervals, with the step rounded up to the next 1 / 2 / 5 × 10ⁿ, so
 * the gridlines land on numbers you can halve in your head. Counts stay whole —
 * "2.5 alerts" is not a thing — which is why the step floors at 1.
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
