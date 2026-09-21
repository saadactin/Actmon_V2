import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import { Kpi } from '../overview/OverviewPrimitives';
import { When } from './AlertPrimitives';

/**
 * The header strip.
 *
 * `Could not evaluate` is a first-class tile, beside the alert count, and that
 * is the point of this component. "14 rules enabled, 0 active alerts" reads as
 * a healthy estate and can equally mean fourteen rules that have not managed to
 * read anything for a week. A dashboard that cannot tell those apart is worse
 * than no dashboard.
 *
 * Every tile shows NA rather than 0 when the underlying figure is genuinely
 * unknown — the delivery counters in particular, which come from a ledger owned
 * by another service and can be unreadable.
 */

const SYSTEM_META = {
  healthy: { tone: 'success', label: 'Healthy', icon: 'check' },
  degraded: { tone: 'warning', label: 'Degraded', icon: 'alert' },
  configuration_required: {
    tone: 'warning', label: 'Configuration required', icon: 'settings',
  },
};

export default function AlertSummaryStrip({ summary, loading, error, onFilter }) {
  if (error) {
    return (
      <div className="rounded-control border border-dashed border-border px-4 py-3">
        <p className="flex items-center gap-2 text-[12px] font-semibold text-fg">
          <Icon name="alert" size={14} className="text-warning-fg" />
          The alert summary could not be loaded
        </p>
        <p className="mt-0.5 text-[11px] leading-snug text-muted">
          {error?.response?.data?.detail || error?.message
            || 'This figure could not be read.'}{' '}
          The rules and history below load separately and may still be fine.
        </p>
      </div>
    );
  }

  const s = summary || {};
  const bySeverity = s.alerts_by_severity || {};
  const critical = (bySeverity.CRITICAL || 0) + (bySeverity.HIGH || 0);
  const notifications = s.notifications || {};
  const ledgerReadable = notifications.available !== false;
  const system = SYSTEM_META[s.system_status] || SYSTEM_META.configuration_required;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Kpi
          label="Active alerts"
          icon="bell-ring"
          loading={loading}
          value={typeof s.active_alerts === 'number' ? s.active_alerts.toLocaleString() : 'NA'}
          tone={s.active_alerts ? 'danger' : 'neutral'}
          sub={critical ? `${critical} critical or high` : 'Open and acknowledged'}
          onClick={onFilter ? () => onFilter('active') : undefined}
          title="Alert instances still open or acknowledged. Not the number of rules."
        />
        <Kpi
          label="Rules enabled"
          icon="bell"
          loading={loading}
          value={typeof s.rules?.enabled === 'number' ? s.rules.enabled.toLocaleString() : 'NA'}
          sub={s.rules?.disabled ? `${s.rules.disabled} disabled` : 'Being evaluated'}
          onClick={onFilter ? () => onFilter('rules') : undefined}
        />
        {/* The tile that stops a quiet page from reading as a safe one. */}
        <Kpi
          label="Could not evaluate"
          icon="help"
          loading={loading}
          value={typeof s.rules_inconclusive === 'number'
            ? s.rules_inconclusive.toLocaleString() : 'NA'}
          tone={s.rules_inconclusive ? 'warning' : 'neutral'}
          unavailable={!s.rules_inconclusive}
          sub={s.rules_inconclusive
            ? 'Rules whose data source could not be read'
            : 'Every enabled rule read its data'}
          onClick={onFilter ? () => onFilter('inconclusive') : undefined}
          title="Rules whose last evaluation was UNKNOWN, ERROR or UNSUPPORTED. These neither fired nor cleared anything."
        />
        <Kpi
          label="Emails sent"
          icon="mail"
          loading={loading}
          // NA, not 0, when the ledger owned by the database service cannot be
          // read — "nothing was sent" and "we cannot tell" are different facts.
          value={ledgerReadable
            ? (notifications.sent ?? 0).toLocaleString()
            : 'NA'}
          unavailable={!ledgerReadable}
          sub={ledgerReadable
            ? `Last ${notifications.window_days || 7} days`
            : 'Delivery ledger unreadable'}
          onClick={onFilter ? () => onFilter('email') : undefined}
        />
        <Kpi
          label="Delivery failures"
          icon="alert"
          loading={loading}
          value={ledgerReadable ? (notifications.failed ?? 0).toLocaleString() : 'NA'}
          tone={notifications.failed ? 'danger' : 'neutral'}
          unavailable={!ledgerReadable || !notifications.failed}
          sub={notifications.pending
            ? `${notifications.pending} still queued`
            : 'An alert can fire while its email fails'}
          onClick={onFilter ? () => onFilter('email') : undefined}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-control border border-border bg-sunken px-3 py-2">
        <span className="flex items-center gap-1.5 text-[11px]">
          <Icon name={system.icon} size={12} className="text-subtle" />
          <span className="text-muted">System</span>
          <Badge tone={system.tone} size="sm">{system.label}</Badge>
        </span>
        <span className="text-[11px] text-muted">
          Last evaluation{' '}
          <span className="font-medium text-fg">
            <When iso={s.last_evaluation_at} never="never — no rule has run yet" />
          </span>
        </span>
        {typeof s.rules_never_evaluated === 'number' && s.rules_never_evaluated > 0 && (
          <span className="text-[11px] text-muted">
            <span className="font-medium text-fg">{s.rules_never_evaluated}</span>{' '}
            rule(s) awaiting their first run
          </span>
        )}
        {s.engine && !s.engine.enabled && (
          <Badge tone="danger" size="sm">
            Alert engine disabled — nothing is being evaluated
          </Badge>
        )}
        {s.system_detail && (
          <span className="w-full text-[11px] leading-snug text-muted">
            {s.system_detail}
          </span>
        )}
      </div>
    </div>
  );
}
