import cn from '@/lib/cn';
import useCountUp from '@/hooks/useCountUp';

/**
 * A ranked name+count list capped to a "Top N" — the packages-table shape
 * from the dashboard design mockup, repointed at real ACTMON data (top
 * alerting hosts) instead of the mockup's installed-software placeholder,
 * since we monitor databases/infra, not endpoint software inventory.
 */
export default function RankedTable({ title, titleNote, countLabel = 'Count', rows = [], onMore, onRowClick, className }) {
  return (
    <section className={cn('card flex flex-col gap-2 px-card py-card', className)}>
      <h2 className="flex items-baseline gap-2 text-[17px] font-bold text-fg">
        <span className="truncate-safe">{title}</span>
        {titleNote && <span className="shrink-0 text-[13px] font-normal text-subtle">{titleNote}</span>}
      </h2>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between rounded-control bg-inverse px-3 py-2.5 text-[12px] font-semibold text-on-inverse">
          <span>{title}</span>
          <span className="w-20 shrink-0 text-center">{countLabel}</span>
        </div>
        {rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12px] text-subtle">Nothing to show yet.</p>
        ) : rows.map((r) => (
          <div
            key={r.key}
            {...(onRowClick ? { role: 'button', tabIndex: 0, onClick: () => onRowClick(r), onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(r); } } } : {})}
            className={cn('flex items-center justify-between rounded-control bg-surface px-3 py-2 text-[13px] shadow-xs transition-transform hover:translate-x-1', onRowClick && 'cursor-pointer hover:bg-raised')}
          >
            <span className="truncate-safe min-w-0 flex-1 font-medium text-muted">{r.label}</span>
            <Count value={r.value} />
          </div>
        ))}
      </div>

      {onMore && (
        <button
          type="button"
          onClick={onMore}
          className="mt-1 h-9 w-28 self-center rounded-control bg-inverse text-[13px] font-semibold text-on-inverse transition-transform hover:-translate-y-0.5"
        >
          More
        </button>
      )}
    </section>
  );
}

function Count({ value }) {
  const animated = useCountUp(value);
  return <span className="w-20 shrink-0 text-center font-bold text-fg tabular-nums">{Math.round(animated)}</span>;
}
