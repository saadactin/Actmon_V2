import { useState } from 'react';
import { Bot, Cloud, ScrollText, ShieldAlert, User, UserCog, Zap } from 'lucide-react';
import Badge from '@/components/ui/Badge';
import { InlineLoading } from '@/components/ui/Loading';
import { useEventsForResource } from '../hooks/useEvents';
import EventDetailDrawer from './EventDetailDrawer';
import { RISK_TONE, STATUS_TONE, formatEventTime, relativeTime } from '../utils/eventFormat';

/**
 * "Who changed this resource?" — the Configuration Drift → Event Log bridge.
 *
 * Drift answers *what changed*; this answers *who changed it and how*. Given a
 * resource and the moment a change was DETECTED, it lists the control-plane
 * events that could account for it.
 *
 * The search window looks BACKWARDS from the detection time, because a
 * configuration change is observed by the discovery scan that follows it — the
 * change itself is always in the past relative to the drift record. Looking
 * forwards would find events that cannot have caused it.
 *
 * The three outcomes are deliberately different messages, because they mean
 * different things and only one of them is "nobody did this":
 *
 *   events found        → here is the actor, the API call and the source.
 *   none, sources OK    → no control-plane event was recorded. A change made
 *                         inside a VM, by a provider-internal process, or
 *                         before collection began leaves nothing to find.
 *   none, sources bad   → collection is degraded, so absence is not evidence.
 */

const ACTOR_ICON = {
  Human: User,
  RootAccount: ShieldAlert,
  IAMRole: UserCog,
  ServicePrincipal: Bot,
  ServiceAccount: Bot,
  CloudService: Cloud,
  AutomatedProcess: Zap,
  Unknown: User,
};

export default function RelatedEventsPanel({
  accountId,
  resourceId,
  resourceName,
  around,
  hours = 72,
  enabled = true,
  compact = false,
}) {
  const [openEventId, setOpenEventId] = useState(null);
  const { data, isLoading, isError, error } = useEventsForResource(
    { accountId, resourceId, resourceName, around, hours }, enabled,
  );

  if (!enabled) return null;

  if (isLoading) {
    return <InlineLoading label="Looking for who made this change…" />;
  }

  if (isError) {
    return (
      <p className="text-meta leading-relaxed text-muted">
        Could not look up related events
        {error?.response?.status ? ` (HTTP ${error.response.status})` : ''}.
        {error?.response?.status === 404
          ? ' The cloud service is running a build without the Event Log endpoints — restart it and reload.'
          : ' This is a request failure, not an absence of events.'}
      </p>
    );
  }

  const events = data?.items || [];
  const degraded = data?.sources?.degraded;

  return (
    <>
      {events.length === 0 ? (
        <div className="space-y-1.5">
          <p className="text-meta font-semibold text-fg">
            {degraded
              ? 'No matching event — but collection is degraded'
              : 'No control-plane event recorded for this change'}
          </p>
          <p className="text-meta leading-relaxed text-muted">
            {degraded
              ? 'One or more audit sources is not collecting, so this absence is not evidence that nobody made the change. Check collection health on the Event Log tab.'
              : 'The audit trail has no management-API call against this resource in the window before the change was detected. That can mean the change was made inside the instance rather than through the cloud API, that a provider-internal process made it, or that it predates audit collection for this account.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="flex flex-wrap items-center gap-1.5 text-meta text-muted">
            <ScrollText size={12} className="shrink-0 text-accent-text" />
            <span className="font-semibold text-fg">
              {events.length} control-plane event{events.length === 1 ? '' : 's'}
            </span>
            against this resource before the change was detected
            {data.matched_on === 'resource_name' && (
              <span className="text-subtle">
                · matched by name, which is a weaker link than a resource id
              </span>
            )}
          </p>

          <ul className={compact ? 'space-y-1' : 'space-y-1.5'}>
            {events.map((e) => {
              const ActorIcon = ACTOR_ICON[e.actor_type] || User;
              return (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => setOpenEventId(e.id)}
                    className="w-full rounded-control border border-border bg-sunken p-2 text-left transition-colors hover:border-accent"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={RISK_TONE[e.risk_level] || 'neutral'} size="xs">
                        {e.risk_level}
                      </Badge>
                      <span className="text-meta font-semibold text-fg">
                        {e.event_name}
                      </span>
                      {e.status !== 'Success' && (
                        <Badge tone={STATUS_TONE[e.status] || 'neutral'} size="xs">
                          {e.status}
                        </Badge>
                      )}
                      <span
                        className="ml-auto text-micro text-subtle"
                        title={formatEventTime(e.timestamp)}
                      >
                        {relativeTime(e.timestamp)}
                      </span>
                    </div>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-meta text-muted">
                      <span className="inline-flex items-center gap-1">
                        <ActorIcon size={10} className="text-subtle" />
                        {e.actor_name || 'Unidentified principal'}
                      </span>
                      {e.source_ip && <span className="font-mono">{e.source_ip}</span>}
                      {e.access_method && <span>via {e.access_method}</span>}
                      <span className="text-subtle">{e.provider}</span>
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>

          <p className="text-micro leading-relaxed text-subtle">
            {data.note}
          </p>
        </div>
      )}

      <EventDetailDrawer
        eventId={openEventId}
        open={!!openEventId}
        onClose={() => setOpenEventId(null)}
        onOpenEvent={(id) => setOpenEventId(id)}
      />
    </>
  );
}
