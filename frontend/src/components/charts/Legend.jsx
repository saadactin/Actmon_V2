import cn from '@/lib/cn';
import { StatusKey } from './status';

/**
 * Identity channel for every chart form.
 *
 * A legend is always present for two or more series — colour matching alone is
 * never the only way to tell series apart. Items carrying a `status` render
 * through StatusKey (swatch + icon + label), because the fixed status steps must
 * never be colour-alone; anything else gets a plain swatch.
 */
export default function Legend({ items, showValues = true, className, format = (v) => v }) {
  if (!items?.length) return null;

  return (
    <div className={cn('flex flex-wrap items-center gap-x-3.5 gap-y-1', className)}>
      {items.map((item) => (item.status ? (
        <StatusKey
          key={item.key ?? item.label}
          status={{ ...item.status, label: item.label }}
          count={showValues ? format(item.value) : undefined}
        />
      ) : (
        <span
          key={item.key ?? item.label}
          className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted"
        >
          <span className="h-2.5 w-2.5 shrink-0 rounded-xs" style={{ background: colorOf(item) }} />
          {item.label}
          {showValues && item.value !== undefined && (
            <b className="text-fg tabular-nums">{format(item.value)}</b>
          )}
        </span>
      )))}
    </div>
  );
}

/** One place that decides a mark's colour: status wins, then explicit, then slot. */
export function colorOf(item, index = 0) {
  return item.status?.color || item.color || `var(--chart-${(index % 8) + 1})`;
}
