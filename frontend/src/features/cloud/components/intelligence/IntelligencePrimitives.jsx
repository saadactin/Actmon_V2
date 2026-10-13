import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';

/** Section heading used inside the finding drawer — the spec's ruled blocks. */
export function DrawerSection({ title, icon, children, action, className }) {
  return (
    <section className={cn('border-t border-border pt-4 first:border-t-0 first:pt-0', className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-meta font-bold uppercase tracking-wider text-muted">
          {icon && <Icon name={icon} size={13} />}
          {title}
        </h4>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Label/value rows. A missing value reads "Not reported", never blank. */
export function KeyValues({ rows, className }) {
  const visible = (rows || []).filter(([label]) => label);
  if (!visible.length) return <p className="text-[12px] text-subtle">Nothing reported.</p>;
  return (
    <dl className={cn('divide-y divide-border overflow-hidden rounded-control border border-border', className)}>
      {visible.map(([label, value, hint]) => (
        <div key={label} className="flex gap-3 px-2.5 py-1.5">
          <dt className="w-40 shrink-0 text-meta text-muted">{label}</dt>
          <dd className="min-w-0 flex-1 break-words text-[12px] text-fg">
            {value === null || value === undefined || value === ''
              ? <span className="text-subtle">Not reported</span>
              : value}
            {hint && <span className="mt-0.5 block text-meta text-subtle">{hint}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** "N/A — reason": the one way an unknown value is written. */
export function NotAvailable({ reason, className }) {
  return (
    <span className={cn('text-muted', className)}>
      N/A
      {reason && <span className="mt-0.5 block text-meta leading-relaxed text-subtle">{reason}</span>}
    </span>
  );
}

/** A compact metric tile: label over value, detail under. */
export function MiniStat({ label, value, detail, tone }) {
  return (
    <div className="min-w-0 rounded-control border border-border bg-surface px-2.5 py-2">
      <div className="truncate-safe text-micro font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className={cn('mt-0.5 truncate-safe text-[14px] font-bold tabular-nums',
        value === 'N/A' ? 'text-muted' : tone || 'text-fg')}
      >
        {value}
      </div>
      {detail && <div className="truncate-safe text-micro text-subtle" title={detail}>{detail}</div>}
    </div>
  );
}
