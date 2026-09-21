import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import { Panel } from '../overview/OverviewPrimitives';
import { Count } from './AlertPrimitives';

/**
 * Alert fatigue.
 *
 * The four numbers are shown together because "noisy" has four different
 * causes that need different fixes, and any one of them alone is misleading:
 *
 *   triggers      the condition keeps becoming true → raise the threshold or
 *                 add a minimum duration
 *   notifications how much mail actually went out → lengthen the cooldown
 *   suppressed    how much mail the cooldown already stopped. A big number
 *                 here means the cooldown is WORKING and the threshold is the
 *                 real problem — lengthening the cooldown further would just
 *                 hide more of the same noise
 *   resolution    how often its alerts cleared. A rule that fires constantly
 *                 and never resolves is usually measuring a steady state
 *                 rather than an incident
 *
 * A resolution rate computed from three alerts is not a rate, so below the
 * server's sample floor it renders NA with the reason rather than a confident
 * percentage. Nothing here changes a rule: this reports, the operator decides.
 */
export default function NoisyRulesPanel({
  data, loading, error, days, onOpenRule, onSilence,
}) {
  const rows = data?.rules || [];
  const noisy = rows.filter((r) => r.noisy);
  const quiet = rows.filter((r) => !r.noisy);

  return (
    <Panel
      title="Alert fatigue"
      icon="bell-ring"
      subtitle={`Which rules produce more noise than signal · last ${days} days`}
      loading={loading}
      error={error}
      empty={!loading && !error && rows.length === 0}
      emptyMessage="No rule has raised an alert in this window, so there is nothing to tune."
    >
      {noisy.length === 0 && rows.length > 0 && (
        <p className="mb-3 flex items-start gap-2 rounded-control border border-border bg-sunken px-3 py-2 text-[12px] leading-snug">
          <Icon name="check" size={13} className="mt-0.5 shrink-0 text-success-fg" />
          <span className="text-muted">
            No rule is currently flagged as noisy. {rows.length} rule
            {rows.length === 1 ? '' : 's'} raised alerts in this window.
          </span>
        </p>
      )}

      <ul className="space-y-2">
        {[...noisy, ...quiet].map((r) => (
          <li
            key={r.rule_id}
            className={`rounded-control border p-3 ${
              r.noisy ? 'border-warning bg-warning-soft' : 'border-border'
            }`}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <button
                type="button"
                onClick={() => onOpenRule?.(r.rule_id)}
                className="min-w-0 text-left"
              >
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[12px] font-semibold text-fg">
                    {r.rule_name}
                  </span>
                  {r.noisy && <Badge tone="warning" size="sm">Noisy</Badge>}
                </span>
              </button>
              {r.noisy && onSilence && (
                <Button size="sm" variant="ghost" icon="ban"
                        onClick={() => onSilence(r.rule_id)}
                        title="Suppress this rule's email for a while. It keeps watching.">
                  Silence
                </Button>
              )}
            </div>

            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
              {[
                ['Alerts', <Count key="a" value={r.alerts} />,
                  'Distinct alerts this rule raised.'],
                ['Emails', <Count key="n" value={r.notifications} />,
                  `About ${r.notifications_per_day} a day.`],
                ['Suppressed', <Count key="s" value={r.suppressed} />,
                  'Notifications the cooldown already prevented.'],
                ['Resolved',
                  r.resolution_rate_pct == null
                    ? <span key="r" className="text-subtle">NA</span>
                    : <span key="r">{r.resolution_rate_pct}%</span>,
                  r.resolution_rate_note || 'Share of its alerts that cleared.'],
              ].map(([label, value, help]) => (
                <div key={label} title={help}>
                  <dt className="text-[10px] uppercase tracking-wider text-subtle">
                    {label}
                  </dt>
                  <dd className="text-[13px] font-semibold tabular-nums text-fg">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>

            {!!r.reasons?.length && (
              <ul className="mt-2 space-y-0.5 border-t border-border pt-2">
                {r.reasons.map((reason) => (
                  <li key={reason} className="flex gap-1.5 text-[11px] leading-snug text-muted">
                    <Icon name="info" size={11} className="mt-0.5 shrink-0 text-subtle" />
                    {reason}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>

      {data?.threshold_note && (
        <p className="mt-3 border-t border-border pt-2 text-[11px] leading-snug text-subtle">
          {data.threshold_note}
        </p>
      )}
    </Panel>
  );
}
