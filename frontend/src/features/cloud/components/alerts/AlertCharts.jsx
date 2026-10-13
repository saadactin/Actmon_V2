import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import { Panel } from '../overview/OverviewPrimitives';
import { Count, SEVERITY_META, categoryMeta } from './AlertPrimitives';

/**
 * The alert dashboard's charts.
 *
 * Two rules run through all of them.
 *
 * **A zero is only drawn when it is a real zero.** The time series is padded
 * server-side so a quiet day is a genuine zero rather than a missing point —
 * leaving it sparse would compress the axis and make a steady trickle look
 * like a burst. But where a figure could not be READ, the panel says so and
 * draws nothing; the delivery chart in particular renders an explanation
 * rather than an empty pie when the notification ledger is unreadable.
 *
 * **Colour never carries meaning alone.** Every series is labelled, every
 * legend spells out the severity, and the tooltip names what it is showing.
 */

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

// Drawn from the same tokens the badges use, so a CRITICAL bar and a CRITICAL
// badge are the same red rather than two reds that nearly match.
const SEVERITY_FILL = {
  CRITICAL: '#7f1d1d',
  HIGH: '#b45309',
  MEDIUM: '#a16207',
  LOW: '#1d4ed8',
  INFO: '#6b7280',
};

const DELIVERY_FILL = {
  sent: '#166534',
  failed: '#991b1b',
  pending: '#1d4ed8',
};

const AXIS = { stroke: 'var(--color-subtle, #9ca3af)', fontSize: 11 };

const TOOLTIP_STYLE = {
  contentStyle: {
    background: 'var(--color-surface, #fff)',
    border: '1px solid var(--color-border, #e5e7eb)',
    borderRadius: 8,
    fontSize: 12,
  },
};

const shortDate = (iso) => {
  try {
    return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
      day: 'numeric', month: 'short',
    });
  } catch {
    return iso;
  }
};

/** Alerts per day, stacked by severity. */
export function AlertsOverTime({ data, loading, error, days }) {
  const series = data?.over_time || [];
  const total = series.reduce((sum, d) => sum + (d.total || 0), 0);

  return (
    <Panel
      title="Alerts over time"
      icon="chart-bar"
      subtitle={`Last ${days} days`}
      loading={loading}
      error={error}
      empty={!loading && !error && total === 0}
      emptyMessage={`No alert has been raised in the last ${days} days. Every day in that window was checked, so this is a real zero rather than missing data.`}
    >
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={series} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false}
                           stroke="var(--color-border, #e5e7eb)" />
            <XAxis dataKey="date" tickFormatter={shortDate} {...AXIS}
                   tickLine={false} axisLine={false} minTickGap={24} />
            <YAxis allowDecimals={false} {...AXIS} tickLine={false} axisLine={false} />
            <Tooltip {...TOOLTIP_STYLE}
                     labelFormatter={(v) => shortDate(v)} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {SEVERITY_ORDER.map((s) => (
              <Bar key={s} dataKey={s} stackId="a" fill={SEVERITY_FILL[s]}
                   name={SEVERITY_META[s]?.label || s} radius={s === 'CRITICAL' ? [3, 3, 0, 0] : 0} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

/** Where alerts come from. Horizontal bars — category names are words, and
 *  words do not fit on a vertical axis. */
export function AlertsByCategory({ data, loading, error, onSelect }) {
  // The server supplies a label for the bucket that has no category of its own
  // (alerts raised by a feature rather than by a rule); everything else maps
  // through the shared category vocabulary.
  const rows = (data?.by_category || []).map((r) => ({
    ...r,
    label: r.label || categoryMeta(r.category).label,
    selectable: r.category !== '_direct',
  }));
  const max = Math.max(1, ...rows.map((r) => r.count));

  return (
    <Panel
      title="Alerts by category"
      icon="layers"
      loading={loading}
      error={error}
      empty={!loading && !error && rows.length === 0}
      emptyMessage="No alerts in this window to categorise."
    >
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.category}>
            <button
              type="button"
              disabled={!r.selectable}
              onClick={() => r.selectable && onSelect?.(r.category)}
              className="group flex w-full items-center gap-2 text-left disabled:cursor-default"
              title={r.selectable ? undefined
                : 'These alerts were raised directly by a feature, so there is no rule category to filter by.'}
            >
              <Icon name={r.selectable ? categoryMeta(r.category).icon : 'dot'}
                    size={13} className="shrink-0 text-subtle" />
              <span className="w-28 shrink-0 truncate text-[12px] text-fg">
                {r.label}
              </span>
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-sunken">
                <span className="block h-full rounded-full bg-accent transition-all"
                      style={{ width: `${(r.count / max) * 100}%` }} />
              </span>
              <span className="w-10 shrink-0 text-right text-[12px] font-semibold tabular-nums text-fg">
                {r.count.toLocaleString()}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** Notification outcomes.
 *
 *  Two blocks, never merged: what the alert engine DECIDED to do, and what the
 *  mail server actually DID. An operator reading one for the other is exactly
 *  how "queued" comes to mean "delivered". */
export function NotificationOutcomes({ data, loading, error }) {
  const outcomes = data?.notifications;
  const delivered = outcomes?.delivered;
  const decided = outcomes?.decided_by_engine || {};
  const ledgerReadable = delivered?.available !== false;

  const pie = ledgerReadable
    ? ['sent', 'failed', 'pending']
      .map((k) => ({ name: k, value: delivered?.[k] || 0 }))
      .filter((d) => d.value > 0)
    : [];

  return (
    <Panel
      title="Notification delivery"
      icon="send"
      loading={loading}
      error={error}
    >
      {!ledgerReadable ? (
        <p className="rounded-control border border-dashed border-border px-3 py-4 text-[12px] leading-snug text-muted">
          The delivery ledger could not be read, so outcomes are unknown — not
          zero. {delivered?.reason}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-4">
          {pie.length > 0 ? (
            <div className="h-32 w-32 shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pie} dataKey="value" nameKey="name"
                       innerRadius={28} outerRadius={56} paddingAngle={2}>
                    {pie.map((d) => (
                      <Cell key={d.name} fill={DELIVERY_FILL[d.name] || '#9ca3af'} />
                    ))}
                  </Pie>
                  <Tooltip {...TOOLTIP_STYLE} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="text-[12px] text-muted">
              No email has been attempted in this window.
            </p>
          )}

          <dl className="min-w-[180px] flex-1 space-y-1.5">
            {[
              ['Delivered', delivered?.sent, 'success'],
              ['Failed', delivered?.failed, 'danger'],
              ['Still queued', delivered?.pending, 'info'],
              ['Average latency',
                delivered?.avg_latency_ms != null
                  ? `${Math.round(delivered.avg_latency_ms)} ms` : null, 'neutral'],
            ].map(([label, value, tone]) => (
              <div key={label} className="flex items-center justify-between gap-3 text-[12px]">
                <dt className="text-muted">{label}</dt>
                <dd>
                  {typeof value === 'string'
                    ? <span className="font-semibold text-fg">{value}</span>
                    : <Badge tone={value ? tone : 'neutral'} size="sm">
                        <Count value={value ?? 0} />
                      </Badge>}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {/* The engine's own decisions, which include the ones that never reached
          the mail server at all — suppressed, no recipient, not configured. */}
      {Object.keys(decided).length > 0 && (
        <div className="mt-3 border-t border-border pt-2">
          <p className="mb-1.5 text-micro font-semibold uppercase tracking-wider text-subtle">
            Decided by the alert engine
          </p>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(decided).map(([status, n]) => (
              <Badge key={status} tone="neutral" size="sm">
                {status.replace(/_/g, ' ').toLowerCase()} · {n}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

/** Which rules fire most. Not a ranking of importance — a ranking of volume,
 *  and the panel says so, because the noisiest rule is often the least useful. */
export function TopRules({ data, loading, error, onSelect }) {
  const rows = data?.top_rules || [];
  const mttr = data?.mean_time_to_resolve_seconds;

  return (
    <Panel
      title="Most active rules"
      icon="list"
      loading={loading}
      error={error}
      empty={!loading && !error && rows.length === 0}
      emptyMessage="No rule has raised an alert in this window."
    >
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.rule_id}>
            <button
              type="button"
              onClick={() => onSelect?.(r.rule_id)}
              className="flex w-full items-center justify-between gap-3 rounded px-1 py-1 text-left hover:bg-sunken"
            >
              <span className="min-w-0 flex-1 truncate text-[12px] text-fg">
                {r.rule_name}
              </span>
              <span className="shrink-0 text-meta text-muted">
                <Count value={r.alerts} /> alert{r.alerts === 1 ? '' : 's'}
                {' · '}
                <Count value={r.notifications} /> email
                {r.notifications === 1 ? '' : 's'}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <p className="mt-3 border-t border-border pt-2 text-meta text-muted">
        Mean time to resolve:{' '}
        <span className="font-semibold text-fg">
          {mttr == null
            ? 'NA — nothing has resolved yet'
            : mttr < 3600
              ? `${Math.round(mttr / 60)} minutes`
              : `${(mttr / 3600).toFixed(1)} hours`}
        </span>
      </p>
    </Panel>
  );
}

/** Provider split. Only rendered when more than one provider is present —
 *  a one-slice pie is furniture. */
export function AlertsByProvider({ data, loading, error }) {
  const rows = data?.by_provider || [];
  if (!loading && rows.length < 2) return null;

  return (
    <Panel title="Alerts by provider" icon="cloud" loading={loading} error={error}>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.provider} className="flex items-center justify-between text-[12px]">
            <span className="text-fg">{r.provider}</span>
            <Badge tone="neutral" size="sm"><Count value={r.count} /></Badge>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
