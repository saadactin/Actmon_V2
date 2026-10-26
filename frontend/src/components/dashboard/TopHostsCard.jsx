import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import IconButton from '@/components/ui/IconButton';
import { bandFor } from '@/components/charts/status';

/**
 * One "Top N hosts by a utilisation metric" ranking: # · Host Name · OS · bar + %.
 *
 * `data` is useDashboardData's topBy() result: { rows:[{id,name,ip,os,value}],
 * noReading, offline, total }. Rows arrive sorted high → low. Nothing is
 * invented: a host without a reading never gets a bar, and the footer says how
 * many hosts were left out and why.
 */
export default function TopHostsCard({
  title, metricLabel, icon, data, loading, error, onHost, onMore, className, fetchedAt,
}) {
  const { rows = [], noReading = 0, offline = 0 } = data || {};

  let body;
  if (error) {
    body = <State icon="alert" text="Host metrics could not be loaded." tone="danger" />;
  } else if (loading && !rows.length) {
    body = <Skeleton />;
  } else if (!rows.length) {
    body = <State icon="server" text="No host metrics available" />;
  } else {
    body = (
      <table className="w-full table-fixed text-[12.5px]">
        <colgroup>
          <col className="w-7" />
          <col />
          <col className="w-9" />
          <col className="w-[42%]" />
        </colgroup>
        <thead>
          <tr className="border-b border-border text-left text-[11.5px] font-semibold text-muted">
            <th className="py-1.5 font-semibold">#</th>
            <th className="py-1.5 font-semibold">Host Name</th>
            <th className="py-1.5 text-center font-semibold">OS</th>
            <th className="py-1.5 text-right font-semibold">{metricLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const band = bandFor(r.value);
            return (
              <tr key={r.id ?? r.name} className="border-b border-border/60 last:border-0">
                <td className="py-2 text-muted tabular-nums">{i + 1}</td>
                <td className="truncate py-2 pr-2">
                  <button
                    type="button"
                    onClick={() => onHost(r)}
                    title={r.ip ? `${r.name} · ${r.ip}` : r.name}
                    className="max-w-full truncate rounded-sm text-left font-medium text-accent-text underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    {r.name}
                  </button>
                </td>
                <td className="py-2 text-center"><OsMark os={r.os} /></td>
                <td className="py-2">
                  <span className="flex items-center gap-2" title={`${r.value.toFixed(1)}% — ${band.label}`}>
                    <span className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-sunken" aria-hidden="true">
                      <span className="block h-full rounded-full" style={{ width: `${Math.max(2, r.value)}%`, background: band.color }} />
                    </span>
                    <span className="w-10 shrink-0 text-right font-bold text-fg tabular-nums">{Math.round(r.value)}%</span>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

  const notes = [
    noReading > 0 && `${noReading} with no reading (N/A)`,
    offline > 0 && `${offline} offline, not ranked`,
  ].filter(Boolean);

  return (
    <section className={cn('card flex flex-col px-card py-card', className)}>
      <header className="mb-2 flex items-center gap-2">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent-soft text-accent-text">
          <Icon name={icon} size={16} />
        </span>
        <h2 className="min-w-0 flex-1 truncate text-[16px] font-bold text-fg">
          {title} <span className="text-[12px] font-normal text-muted">(Top 5)</span>
        </h2>
        {onMore && <IconButton icon="arrow-right" label={`Open all hosts — ${title}`} size="sm" onClick={onMore} />}
      </header>
      <div className={cn('min-h-0 flex-1', loading && rows.length > 0 && 'opacity-70')}>{body}</div>
      {(notes.length > 0 || fetchedAt) && !error && (
        <p className="mt-2 text-[11px] text-subtle">
          {[fetchedAt && `Latest reading per host · updated ${new Date(fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, ...notes].filter(Boolean).join(' · ')}
        </p>
      )}
    </section>
  );
}

function State({ icon, text, tone }) {
  return (
    <div className="grid h-full min-h-[180px] place-items-center text-center">
      <span>
        <span className={cn('mx-auto mb-2 grid h-9 w-9 place-items-center rounded-full', tone === 'danger' ? 'bg-danger-soft text-danger-fg' : 'bg-sunken text-muted')}>
          <Icon name={icon} size={16} />
        </span>
        <span className="text-[12.5px] text-muted">{text}</span>
      </span>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-3 py-2" aria-label="Loading host metrics" role="status">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-3">
          <span className="h-3 w-4 animate-pulse rounded bg-sunken" />
          <span className="h-3 flex-1 animate-pulse rounded bg-sunken" />
          <span className="h-3 w-[42%] animate-pulse rounded bg-sunken" />
        </div>
      ))}
    </div>
  );
}

/** Small OS mark from the host's reported os_type. Unknown OS → its text, never a guess. */
export function OsMark({ os, size = 15 }) {
  const v = String(os || '').toLowerCase();
  if (v.includes('win')) {
    return (
      <span title={os} aria-label="Windows" className="inline-flex">
        <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
          <path fill="#1e88e5" d="M0 2.3 6.5 1.4v6.1H0zM7.3 1.3 16 0v7.5H7.3zM0 8.3h6.5v6.2L0 13.6zM7.3 8.3H16V16l-8.7-1.2z" />
        </svg>
      </span>
    );
  }
  if (/linux|ubuntu|rhel|red hat|cent|debian|oracle linux|suse|rocky|alma|fedora|amazon/.test(v)) {
    return (
      <span title={os} aria-label="Linux" className="inline-flex">
        <svg width={size} height={Math.round(size * 1.1)} viewBox="0 0 16 18" aria-hidden="true">
          <ellipse cx="8" cy="9.5" rx="5.6" ry="7.2" fill="#1f2937" />
          <ellipse cx="8" cy="11" rx="3.6" ry="5" fill="#f9fafb" />
          <circle cx="6.4" cy="5.2" r="1" fill="#fff" /><circle cx="9.6" cy="5.2" r="1" fill="#fff" />
          <path d="M6.6 7 8 8.4 9.4 7z" fill="#f59e0b" />
          <ellipse cx="5" cy="17" rx="2.2" ry="1" fill="#f59e0b" /><ellipse cx="11" cy="17" rx="2.2" ry="1" fill="#f59e0b" />
        </svg>
      </span>
    );
  }
  return <span className="text-[10.5px] text-subtle" title={os || 'Not reported'}>{os ? os.slice(0, 6) : 'N/A'}</span>;
}
