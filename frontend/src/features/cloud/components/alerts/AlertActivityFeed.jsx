import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import { When } from './AlertPrimitives';

/**
 * Recent alerting activity.
 *
 * This reads `cloud_alert_events`, the alerting subsystem's own append-only
 * audit trail — deliberately NOT the Event Log. `cloud_events` is the mirror of
 * the providers' own control-plane audit trails (CloudTrail, Azure Activity
 * Log, OCI Audit); writing Actmon's internal actions into it would claim a
 * provider emitted them and would corrupt the per-provider counts and the
 * collector's health. The Event Log tab stays the answer to "who changed this
 * cloud resource"; this stays the answer to "what did the alerting system do".
 */

const ACTION_META = {
  'rule.created': { icon: 'plus', tone: 'info', label: 'Rule created' },
  'rule.updated': { icon: 'settings', tone: 'info', label: 'Rule updated' },
  'rule.enabled': { icon: 'power', tone: 'success', label: 'Rule enabled' },
  'rule.disabled': { icon: 'ban', tone: 'warning', label: 'Rule disabled' },
  'rule.deleted': { icon: 'trash', tone: 'warning', label: 'Rule deleted' },
  'rule.tested': { icon: 'play', tone: 'neutral', label: 'Rule tested' },
  'alert.triggered': { icon: 'alert', tone: 'danger', label: 'Alert triggered' },
  'alert.resolved': { icon: 'check', tone: 'success', label: 'Alert resolved' },
  'alert.acknowledged': { icon: 'eye', tone: 'warning', label: 'Acknowledged' },
  'alert.escalated': { icon: 'alert', tone: 'danger', label: 'Escalated' },
  'evaluation.unknown': { icon: 'help', tone: 'warning', label: 'Could not evaluate' },
  'evaluation.error': { icon: 'alert', tone: 'danger', label: 'Evaluation error' },
  'notification.queued': { icon: 'send', tone: 'info', label: 'Email queued' },
  'notification.skipped': { icon: 'ban', tone: 'warning', label: 'Email skipped' },
  'notification.test': { icon: 'mail', tone: 'neutral', label: 'Test sent' },
  'recipients.changed': { icon: 'users', tone: 'neutral', label: 'Recipients changed' },
};

const meta = (action) => ACTION_META[action]
  || { icon: 'dot', tone: 'neutral', label: action };

export default function AlertActivityFeed({ data, loading, error, limit }) {
  if (loading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-8 animate-pulse rounded bg-sunken" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <p className="rounded-control border border-dashed border-border px-3 py-4 text-[12px] text-muted">
        Activity could not be loaded.{' '}
        {error?.response?.data?.detail || error?.message || ''}
      </p>
    );
  }

  const rows = (data?.activity || []).slice(0, limit || undefined);

  if (!rows.length) {
    return (
      <p className="rounded-control border border-dashed border-border px-3 py-6 text-center text-[12px] text-muted">
        No alerting activity recorded yet. Creating a rule, an alert firing, and
        every notification attempt all appear here.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {rows.map((e) => {
        const m = meta(e.action);
        return (
          <li key={e.id} className="flex items-start gap-3 py-2">
            <span className="mt-0.5 shrink-0">
              <Icon name={m.icon} size={14} className="text-subtle" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={m.tone} size="sm">{m.label}</Badge>
                {e.rule_name && (
                  <span className="truncate text-meta font-medium text-fg">
                    {e.rule_name}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-meta leading-snug text-muted">{e.summary}</p>
              {/* Who did it, when the actor is known. RBAC is off by default in
                  this build, so an unauthenticated change genuinely has no
                  actor — and saying "unknown" is truer than omitting it. */}
              <p className="mt-0.5 text-micro text-subtle">
                <When iso={e.at} />
                {' · '}
                {e.actor || 'actor not recorded'}
                {e.actor_role && ` (${e.actor_role})`}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
