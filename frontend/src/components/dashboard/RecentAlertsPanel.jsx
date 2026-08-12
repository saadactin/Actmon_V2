import { useMemo, useState } from 'react';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import { severityOf } from '@/components/charts/status';
import { metricShort } from '@/config/alertCatalog';

/**
 * The overview's alert feed — a full-height column beside the charts.
 *
 * Three jobs, in the order a reader needs them:
 *   1. how much is firing, split by severity (the filter tabs double as counts)
 *   2. what is firing, newest first
 *   3. a way out to the full alerts page
 *
 * Filtering is local to this panel. The feed is already in memory — the same array
 * the severity chart and the KPI tile count — so narrowing it costs no request and
 * can't disagree with the numbers shown elsewhere on the page.
 *
 * The list does NOT scroll inside itself: it grows and scrolls with the page, which
 * is what the layout spec asks for. `MAX_ROWS` is the safety valve — a feed of two
 * hundred alerts would otherwise make the page metres long, and the rows past the
 * cap are reported in the footer rather than silently dropped.
 */

const MAX_ROWS = 40;

const SEVERITY_TEXT = {
  critical: 'text-danger-fg',
  warning: 'text-warning-fg',
  info: 'text-info-fg',
};

export default function RecentAlertsPanel({ alerts = [], counts, loading, onOpenAll, className }) {
  const [filter, setFilter] = useState('all');

  // Info only earns a tab when something informational is actually firing —
  // otherwise the strip is the three the design calls for.
  const tabs = useMemo(() => [
    { id: 'all', label: 'ALL', count: counts.total },
    { id: 'critical', label: 'Critical', count: counts.critical },
    { id: 'warning', label: 'Warning', count: counts.warning },
    ...(counts.info ? [{ id: 'info', label: 'Info', count: counts.info }] : []),
  ], [counts.total, counts.critical, counts.warning, counts.info]);

  const matching = useMemo(
    () => (filter === 'all' ? alerts : alerts.filter((a) => severityOf(a.severity).id === filter)),
    [alerts, filter],
  );
  const visible = matching.slice(0, MAX_ROWS);
  const hidden = matching.length - visible.length;

  return (
    <section className={cn('card flex flex-col', className)}>
      <header className="flex items-center gap-2 px-card pt-card pb-3">
        <h2 className="truncate-safe min-w-0 flex-1 text-[17px] font-bold text-fg">Recent Alerts</h2>
        <button
          type="button"
          onClick={onOpenAll}
          className="flex h-8 shrink-0 items-center gap-1 rounded-control bg-inverse px-3 text-[12px] font-semibold text-on-inverse transition-opacity hover:opacity-90"
        >
          More Alerts
        </button>
      </header>

      {/* Tabs carry the counts, so the split is readable without a second chart. */}
      <div className="flex items-center gap-1 px-card pb-3">
        {tabs.map((tab) => {
          const active = filter === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilter(tab.id)}
              aria-pressed={active}
              className={cn(
                'flex h-8 flex-1 items-center justify-center gap-1.5 rounded-control text-[12px] transition-colors',
                active
                  ? 'bg-inverse font-bold text-on-inverse'
                  : 'font-medium text-muted hover:bg-sunken hover:text-fg',
              )}
            >
              {tab.label}
              <span className={cn('tabular-nums', active ? 'opacity-80' : 'font-bold text-fg')}>
                ({tab.count})
              </span>
            </button>
          );
        })}
      </div>

      <div className={cn('flex-1 px-card pb-card', loading && 'opacity-55')}>
        {visible.length === 0 ? (
          <Empty filtered={filter !== 'all' && counts.total > 0} />
        ) : (
          <>
            <ul className="flex flex-col gap-2">
              {visible.map((alert, i) => <AlertRow key={alert.id ?? i} alert={alert} />)}
            </ul>
            {hidden > 0 && (
              <button
                type="button"
                onClick={onOpenAll}
                className="mt-3 w-full text-[12px] font-semibold text-accent-text hover:underline"
              >
                {hidden} more not shown — open alerts
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * One alert: which host, what tripped, how bad.
 *
 * One warm tint for every row, as specified. That means the tint is decoration
 * rather than signal, so the severity word does the work — spelled out, in its own
 * colour, and never the colour alone.
 */
function AlertRow({ alert }) {
  const sev = severityOf(alert.severity);
  const host = alert.source || alert.agent_name || alert.server_name || 'Unknown host';
  const what = alert.metric ? metricShort(alert.metric) : alert.rule_name;

  return (
    <li
      className="flex items-center gap-2 rounded-control border border-warning-soft bg-warning-soft px-3 py-3"
      title={alert.message || undefined}
    >
      <span className="truncate-safe min-w-0 flex-1 text-[13px] font-bold text-fg">{host}</span>
      {what && <span className="truncate-safe max-w-[34%] shrink-0 text-[12px] text-muted">{what}</span>}
      <span className={cn('shrink-0 text-[12px] font-bold', SEVERITY_TEXT[sev.id] || SEVERITY_TEXT.info)}>
        {sev.label}
      </span>
    </li>
  );
}

function Empty({ filtered }) {
  return (
    <div className="grid place-items-center gap-2 py-10 text-center">
      <span className="grid h-10 w-10 place-items-center rounded-full bg-success-soft text-success-fg">
        <Icon name="check" size={20} strokeWidth={2.6} />
      </span>
      <p className="text-[13px] font-semibold text-fg">{filtered ? 'None at this severity' : 'All clear'}</p>
      <p className="text-[11px] text-subtle">
        {filtered ? 'Other alerts are still firing.' : 'No alerts are firing.'}
      </p>
    </div>
  );
}
