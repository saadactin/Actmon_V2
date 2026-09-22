import { useEffect, useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Drawer from '@/components/ui/Drawer';
import Icon from '@/components/ui/Icon';
import Textarea from '@/components/ui/Textarea';
import {
  Count, NotificationBadge, SeverityBadge, StateBadge, WhyPanel, When,
  categoryMeta, humanDuration,
} from './AlertPrimitives';

/**
 * One alert, in full.
 *
 * The "Why this fired" panel renders the snapshot taken at the moment the
 * condition was met — NOT a fresh evaluation. Re-running would answer "is this
 * true now", which is a different and much less useful question when you are
 * reading an email from three hours ago and trying to work out what happened.
 */
/**
 * "Possible contributing factor" vs "Related".
 *
 * The backend decides which, and this renders the distinction rather than
 * softening it: contributing means the signal also touches the same resource,
 * related means only that it happened on the same account in the same window.
 * Neither is a causal claim, and the disclaimer at the bottom of the section
 * says so in the product's own words rather than leaving the reader to infer.
 */
const STRENGTH_META = {
  possible_contributing_factor: {
    tone: 'warning', label: 'Possible contributing factor',
  },
  related: { tone: 'neutral', label: 'Related' },
};

function RelatedSignals({ data, loading, error, onOpenTab }) {
  if (loading) {
    return (
      <div className="space-y-2">
        {[0, 1].map((i) => (
          <div key={i} className="h-10 animate-pulse rounded bg-sunken" />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <p className="text-[11px] leading-snug text-muted">
        Related signals could not be loaded. The alert itself is unaffected.
      </p>
    );
  }
  if (!data) return null;

  if (!data.total) {
    return (
      <p className="rounded-control border border-dashed border-border px-3 py-3 text-[11px] leading-snug text-muted">
        {data.empty_note || 'Nothing else was recorded in the surrounding window.'}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {data.groups.map((group) => (
        <div key={group.kind}>
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold text-fg">{group.label}</p>
            {group.link_tab && (
              <button
                type="button"
                onClick={() => onOpenTab?.(group.link_tab)}
                className="text-[10px] font-semibold text-accent-text hover:underline"
              >
                Open {group.link_tab}
                <Icon name="arrow-right" size={10} className="ml-0.5 inline" />
              </button>
            )}
          </div>
          <ul className="space-y-1">
            {group.items.map((item) => {
              const meta = STRENGTH_META[item.strength] || STRENGTH_META.related;
              return (
                <li key={item.id}
                    className="rounded-control border border-border px-2.5 py-1.5">
                  <div className="flex flex-wrap items-start justify-between gap-1.5">
                    <span className="min-w-0 text-[12px] font-medium text-fg">
                      {item.title}
                    </span>
                    <Badge tone={meta.tone} size="sm">{meta.label}</Badge>
                  </div>
                  {item.detail && (
                    <p className="mt-0.5 text-[11px] leading-snug text-muted">
                      {item.detail}
                    </p>
                  )}
                  <p className="mt-0.5 text-[10px] text-subtle">
                    <When iso={item.at} />
                    {item.severity && ` · ${item.severity}`}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      <p className="flex gap-1.5 rounded-control border border-border bg-sunken px-2.5 py-2 text-[10px] leading-snug text-muted">
        <Icon name="info" size={11} className="mt-0.5 shrink-0 text-subtle" />
        {data.disclaimer}
      </p>
    </div>
  );
}

export default function AlertDetailDrawer({
  open, onClose, alert, loading, canTriage, onAction, acting, actionNote,
  related, relatedLoading, relatedError, onLoadRelated, onOpenTab, onSilence,
}) {
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState(null);
  const [showRelated, setShowRelated] = useState(false);

  // The drawer is one component instance reused for every alert, so this state
  // has to be reset explicitly. Without it, opening a second alert after
  // expanding the first would show the previous alert's related signals under
  // the new alert's heading.
  useEffect(() => {
    setShowRelated(false);
    setMode(null);
    setReason('');
  }, [alert?.id]);

  const cat = categoryMeta(alert?.category
    || (alert?.anomaly_type || '').split(':')[0]?.toLowerCase());
  const rule = alert?.rule;

  const act = (action) => {
    onAction?.({ alertId: alert.id, action, reason: reason.trim() || undefined });
    setReason('');
    setMode(null);
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      icon={cat.icon}
      title={alert?.resource_name || rule?.name || 'Alert'}
      subtitle={alert ? `${cat.label} · ${alert.anomaly_type}` : undefined}
      width={560}
      footer={canTriage && alert && alert.state !== 'RESOLVED' ? (
        <div className="space-y-2">
          {mode && (
            <Textarea
              rows={2}
              autoFocus
              placeholder={mode === 'resolve'
                ? 'Why is this resolved? (optional)'
                : 'Note for the team (optional)'}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
          <div className="flex items-center justify-end gap-2">
            {mode ? (
              <>
                <Button variant="secondary" onClick={() => { setMode(null); setReason(''); }}>
                  Cancel
                </Button>
                <Button variant="primary" loading={acting} onClick={() => act(mode)}>
                  {mode === 'resolve' ? 'Resolve alert' : 'Acknowledge'}
                </Button>
              </>
            ) : (
              <>
                {alert.state === 'OPEN' && (
                  <Button variant="secondary" icon="check"
                          onClick={() => setMode('acknowledge')}>
                    Acknowledge
                  </Button>
                )}
                {/* Silencing ONE alert, not its rule. The alert stays open and
                    still counts as active — only its email stops. */}
                <Button
                  variant="ghost"
                  icon={alert.is_silenced ? 'bell' : 'ban'}
                  onClick={() => onSilence?.({
                    alertId: alert.id,
                    seconds: 21600,
                    silence: !alert.is_silenced,
                  })}
                  title={alert.is_silenced
                    ? 'Stop suppressing this alert’s email'
                    : 'Stop emailing about this one alert for 6 hours. It stays open.'}
                >
                  {alert.is_silenced ? 'Unsilence' : 'Silence'}
                </Button>
                <Button variant="primary" icon="check"
                        onClick={() => setMode('resolve')}>
                  Resolve
                </Button>
              </>
            )}
          </div>
        </div>
      ) : undefined}
    >
      {loading && (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-6 animate-pulse rounded bg-sunken" />
          ))}
        </div>
      )}

      {!loading && alert && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <SeverityBadge severity={alert.severity} />
            <StateBadge state={alert.state} />
            <NotificationBadge status={alert.notification_status} />
            {alert.is_silenced && (
              <Badge tone="warning" size="sm" title={alert.silence_reason || undefined}>
                Silenced until <When iso={alert.silenced_until} />
              </Badge>
            )}
            {alert.escalated_at && (
              <Badge tone="danger" size="sm">Escalated</Badge>
            )}
            {alert.simulated && <Badge tone="warning" size="sm">Simulated</Badge>}
          </div>

          {/* Stated separately, always. An alert being correctly OPEN while its
              email failed to leave the building is a real and common state,
              and one badge cannot express it. */}
          <p className="rounded-control border border-border bg-sunken px-3 py-2 text-[11px] leading-snug text-muted">
            <strong className="text-fg">Alert status</strong> is whether the
            condition is still a problem.{' '}
            <strong className="text-fg">Notification</strong> is whether an email
            got out. They are tracked separately and one does not imply the
            other.
          </p>

          {actionNote && (
            <p className="flex gap-1.5 rounded-control border border-warning bg-warning-soft px-2.5 py-2 text-[11px] leading-snug text-fg">
              <Icon name="info" size={12} className="mt-0.5 shrink-0 text-warning-fg" />
              {actionNote}
            </p>
          )}

          <p className="text-[13px] leading-relaxed text-fg">{alert.details}</p>

          <section>
            <h4 className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-subtle">
              Why this fired
            </h4>
            <WhyPanel explain={alert.explain} />
          </section>

          <section>
            <h4 className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-subtle">
              Timeline
            </h4>
            <dl className="space-y-1.5">
              {[
                ['First detected', <When key="c" iso={alert.created_at} />],
                ['Last observed', <When key="l" iso={alert.last_seen_at} />],
                ['Occurrences', <Count key="o" value={alert.occurrence_count} />],
                ['Acknowledged', alert.acknowledged_at
                  ? <><When key="a" iso={alert.acknowledged_at} />
                    {alert.acknowledged_by && <span className="text-subtle"> by {alert.acknowledged_by}</span>}</>
                  : <span key="an" className="text-subtle">Not acknowledged</span>],
                ['Resolved', alert.resolved_at
                  ? <><When key="r" iso={alert.resolved_at} />
                    {alert.resolved_by && <span className="text-subtle"> by {alert.resolved_by}</span>}</>
                  : <span key="rn" className="text-subtle">Still active</span>],
                ['Notifications sent', <Count key="n" value={alert.notification_count} />],
                ['Last notified', <When key="ln" iso={alert.last_notified_at} never="Never" />],
              ].map(([k, v]) => (
                <div key={k} className="flex gap-3 text-[12px]">
                  <dt className="w-32 shrink-0 text-muted">{k}</dt>
                  <dd className="min-w-0 font-medium text-fg">{v}</dd>
                </div>
              ))}
            </dl>
            {alert.resolution_reason && (
              <p className="mt-2 rounded-control border border-border px-2.5 py-2 text-[11px] leading-snug text-muted">
                {alert.resolution_reason}
              </p>
            )}
          </section>

          {rule && (
            <section>
              <h4 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-subtle">
                Rule
                {alert.rule_deleted && <Badge tone="warning" size="sm">Deleted</Badge>}
              </h4>
              <div className="rounded-control border border-border p-3">
                <p className="text-[12px] font-semibold text-fg">{rule.name}</p>
                <p className="mt-0.5 text-[12px] leading-snug text-muted">
                  {rule.condition_human}
                </p>
                <dl className="mt-2 space-y-1">
                  {[
                    ['Evaluated', `Every ${humanDuration(rule.evaluation_interval_seconds)}`],
                    ['Cooldown', humanDuration(rule.cooldown_seconds, { zero: 'None' })],
                    ['Repeats', rule.repeat_interval_seconds
                      ? `Every ${humanDuration(rule.repeat_interval_seconds)}`
                      : 'Notify once'],
                  ].map(([k, v]) => (
                    <div key={k} className="flex gap-3 text-[11px]">
                      <dt className="w-24 shrink-0 text-subtle">{k}</dt>
                      <dd className="text-muted">{v}</dd>
                    </div>
                  ))}
                </dl>
                {alert.rule_deleted && (
                  <p className="mt-2 text-[11px] leading-snug text-muted">
                    This rule has been deleted, so it will not fire again. The
                    alert is kept because history outlives its rule.
                  </p>
                )}
              </div>
            </section>
          )}

          {/* Loaded on demand: it queries five subsystems, and doing that for
              every row in a 200-alert list would be an API storm for data
              nobody asked to see. */}
          <section>
            <h4 className="mb-1.5 flex items-center justify-between gap-2 text-[11px] font-bold uppercase tracking-wider text-subtle">
              What else was happening
              {!showRelated && (
                <Button
                  size="sm" variant="ghost" icon="search"
                  onClick={() => { setShowRelated(true); onLoadRelated?.(); }}
                >
                  Look
                </Button>
              )}
            </h4>
            {showRelated ? (
              <RelatedSignals data={related} loading={relatedLoading}
                              error={relatedError} onOpenTab={onOpenTab} />
            ) : (
              <p className="text-[11px] leading-snug text-muted">
                Other alerts, configuration changes, cloud activity, new security
                findings and billed-spend movement around this alert. Shown so
                you can investigate together — not as a claim that any of them
                caused it.
              </p>
            )}
          </section>

          {!!alert.activity?.length && (
            <section>
              <h4 className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-subtle">
                Activity
              </h4>
              <ul className="space-y-1.5">
                {alert.activity.map((e) => (
                  <li key={e.id} className="flex gap-2 text-[11px] leading-snug">
                    <span className="w-20 shrink-0 text-subtle">
                      <When iso={e.at} />
                    </span>
                    <span className="min-w-0 text-muted">
                      {e.summary}
                      {e.actor && <span className="text-subtle"> · {e.actor}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}
