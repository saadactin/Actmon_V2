import { useNavigate } from 'react-router-dom';
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
 * The card matches the height of the chart column beside it (CSS grid stretches
 * this sibling to that height already) and never grows past it — the list scrolls
 * WITHIN the card instead. The header's "More Alerts" button is the way out to
 * the full list; `MAX_ROWS` just keeps this panel itself from scrolling forever
 * on an org with hundreds of alerts.
 */

const MAX_ROWS = 12;

const SEVERITY_TEXT = {
  critical: 'text-danger-fg',
  warning: 'text-warning-fg',
  info: 'text-info-fg',
};

const SEVERITY_ROW = {
  critical: 'border-danger-soft bg-danger-soft',
  warning: 'border-warning-soft bg-warning-soft',
  info: 'border-info-soft bg-info-soft',
};

export default function RecentAlertsPanel({
  alerts = [], counts, loading, onOpenAll, className,
  title = 'Recent Alerts', actionLabel = 'More Alerts',
}) {
  const [filter, setFilter] = useState('all');
  const navigate = useNavigate();

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
  // One row per host + category + severity (e.g. "Dev Db · Disk · Critical" for 16 tablespaces) — the newest
  // alert's message is shown and the rest are counted, so a busy database doesn't fill the panel with
  // look-alike rows. The full list stays on the Alerts page.
  const groups = useMemo(() => {
    const m = new Map();
    const ts = (a) => Date.parse(a.created_at) || 0;
    for (const a of matching) {
      const key = [a.source || a.agent_name || a.server_name || '', a.metric || a.rule_name || '', severityOf(a.severity).id].join('|');
      const g = m.get(key);
      if (!g) m.set(key, { ...a, count: 1, latest: ts(a) });
      else {
        g.count += 1;
        if (ts(a) > g.latest) Object.assign(g, { ...a, count: g.count, latest: ts(a) });
      }
    }
    // Keep the caller's ordering (each group sits where its first alert was); only the row's content is
    // the newest alert of the group. Rule alerts carry their evaluation time, so re-sorting by time here
    // would always float them to the top.
    return [...m.values()];
  }, [matching]);
  const visible = groups.slice(0, MAX_ROWS);

  return (
    <section className={cn('card flex min-h-0 flex-col overflow-hidden', className)}>
      <header className="flex items-center gap-2 px-card pt-card pb-3">
        <h2 className="truncate-safe min-w-0 flex-1 text-[17px] font-bold text-fg">{title}</h2>
        <button
          type="button"
          onClick={onOpenAll}
          className="flex h-8 shrink-0 items-center gap-1 rounded-control bg-inverse px-3 text-[12px] font-semibold text-on-inverse transition-opacity hover:opacity-90"
        >
          {actionLabel}
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

      <div className={cn('min-h-0 flex-1 overflow-y-auto px-card pb-card', loading && 'opacity-55')}>
        {visible.length === 0 ? (
          <Empty filtered={filter !== 'all' && counts.total > 0} />
        ) : (
          <ul className="flex flex-col gap-2">
            {visible.map((alert, i) => <AlertRow key={alert.id ?? i} alert={alert} onOpen={alert.id != null ? () => navigate(`/alerts?alert=${encodeURIComponent(alert.id)}`) : undefined} />)}
          </ul>
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
function AlertRow({ alert, onOpen }) {
  const sev = severityOf(alert.severity);
  const host = alert.source || alert.agent_name || alert.server_name || 'Unknown host';
  const what = alert.metric ? metricShort(alert.metric) : alert.rule_name;

  return (
    <li
      className={cn(
        'flex items-center gap-2 rounded-control border px-3 py-2.5 transition-transform duration-150 hover:translate-x-[3px]',
        SEVERITY_ROW[sev.id] || SEVERITY_ROW.info,
        onOpen && 'cursor-pointer',
      )}
      {...(onOpen ? { role: 'button', tabIndex: 0, onClick: onOpen, onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } } } : {})}
      title={alert.message || undefined}
    >
      <span className="min-w-0 flex-1">
        <span className="truncate-safe block text-[13px] font-bold text-fg">{host}</span>
        {alert.message && <span className="truncate-safe block text-[11.5px] text-muted">{alert.message}</span>}
      </span>
      {what && <span className="truncate-safe max-w-[34%] shrink-0 text-[12px] text-muted">{what}</span>}
      {alert.count > 1 && (
        <span className="shrink-0 rounded-full bg-surface px-1.5 text-[11px] font-bold text-fg" title={`${alert.count} active ${what || ''} alerts on ${host} — newest shown`}>
          ×{alert.count}
        </span>
      )}
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
