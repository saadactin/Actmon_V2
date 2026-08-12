import cn from '@/lib/cn';
import Tooltip from '@/components/ui/Tooltip';
import Legend, { colorOf } from './Legend';

/**
 * Part-to-whole as a single horizontal stacked bar.
 *
 * Segments are separated by a 2px gap in the surface colour — never a stroke
 * around each fill — so neighbouring segments read as distinct without extra ink.
 * The legend carries the values, so a 1-of-200 segment is still readable even
 * though its mark is only a few pixels wide.
 */
export default function StackedBar({
  segments,
  height = 12,
  showLegend = true,
  unit = '',
  emptyLabel = 'No data',
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);

  if (!total) {
    return (
      <div className="space-y-2.5">
        <div className="rounded-sm bg-chart-track" style={{ height }} />
        <p className="text-[12px] text-subtle">{emptyLabel}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {/* `gap` is the surface separator; the track shows through it */}
      <div className="flex overflow-hidden rounded-sm bg-chart-track" style={{ height, gap: 2 }}>
        {segments.map((s, i) => (s.value > 0 ? (
          <Tooltip
            key={s.key}
            side="top"
            delay={60}
            /* Sizing goes on the Tooltip, not the inner span: the wrapper is the
               flex item here, so flex-grow on a child would size against nothing. */
            style={{ flexGrow: s.value, flexBasis: 0, minWidth: 3 }}
            label={
              <span className="flex flex-col gap-0.5">
                <b className="text-[13px]">{s.value}{unit} ({Math.round((s.value / total) * 100)}%)</b>
                <span className="opacity-75">{s.label}</span>
              </span>
            }
          >
            <span className="h-full w-full" style={{ background: colorOf(s, i) }} />
          </Tooltip>
        ) : null))}
      </div>

      {showLegend && <Legend items={segments} />}
    </div>
  );
}

/**
 * A list of stacked bars — one per category, each broken down into segments.
 * One shared scale across rows, so lengths are comparable between categories.
 *
 *   rows [{ key, label, total, segments: [...], onClick }]
 */
export function StackedBarList({ rows, labelWidth = 96, emptyLabel = 'No data' }) {
  if (!rows.length) {
    return <p className="py-6 text-center text-[13px] text-subtle">{emptyLabel}</p>;
  }

  const ceiling = Math.max(...rows.map((r) => r.total), 1);

  return (
    <ul className="space-y-2">
      {rows.map((row) => {
        const interactive = Boolean(row.onClick);
        const body = (
          <div
            className={cn(
              'flex items-center gap-2.5 rounded-sm py-0.5',
              interactive && 'cursor-pointer transition-colors hover:bg-sunken',
            )}
          >
            <span
              className="shrink-0 truncate text-[11px] font-medium text-muted"
              style={{ width: labelWidth }}
              title={row.label}
            >
              {row.label}
            </span>

            <span className="relative h-2.5 min-w-0 flex-1 rounded-sm bg-chart-track">
              <span
                className="absolute inset-y-0 left-0 flex overflow-hidden rounded-r-[4px]"
                style={{ width: `${(row.total / ceiling) * 100}%`, gap: 2 }}
              >
                {row.segments
                  .filter((s) => s.value > 0)
                  .map((s, i) => (
                    <span
                      key={s.key}
                      className="h-full"
                      style={{ flexGrow: s.value, flexBasis: 0, minWidth: 2, background: colorOf(s, i) }}
                    />
                  ))}
              </span>
            </span>

            <span className="w-8 shrink-0 text-right text-[11px] font-bold text-fg tabular-nums">
              {row.total}
            </span>
          </div>
        );

        return (
          <li key={row.key}>
            <Tooltip
              side="top"
              delay={60}
              className="w-full"
              label={
                <span className="flex flex-col gap-0.5">
                  <b className="text-[13px]">{row.total} total</b>
                  <span className="opacity-75">{row.label}</span>
                  <span className="opacity-60">
                    {row.segments.map((s) => `${s.label} ${s.value}`).join(' · ')}
                  </span>
                </span>
              }
            >
              {interactive
                ? <button type="button" onClick={row.onClick} className="block w-full text-left">{body}</button>
                : body}
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}
