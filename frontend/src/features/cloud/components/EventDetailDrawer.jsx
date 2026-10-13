import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, Bot, ChevronDown, ChevronRight, Cloud, Copy, Check, Download,
  ExternalLink, GitCompareArrows, Globe, KeyRound, Server, ShieldAlert, User,
  UserCog, Workflow,
} from 'lucide-react';
import Badge from '@/components/ui/Badge';
import CopyButton from '@/components/ui/CopyButton';
import Drawer from '@/components/ui/Drawer';
import { InlineLoading } from '@/components/ui/Loading';
import { useEvent, useEventRaw, useRelatedEvents } from '../hooks/useEvents';
import ProviderLogo from './ProviderLogo';
import { providerTileStyle } from '../utils/providerTheme';
import { RISK_TONE, STATUS_TONE, formatEventTime, relativeTime } from '../utils/eventFormat';

/**
 * The event detail view — the part of the Event Log that has to answer
 * who / what / when / where / how / what changed / what was the result.
 *
 * Structured into named sections rather than presented as one JSON blob, and
 * every field that the provider did not supply renders as an explicit
 * "Not available" rather than a blank or a plausible-looking substitute. That
 * distinction is the whole point: a blank reads as "nothing", while
 * "Not available" reads as "this provider does not report it", and those are
 * different facts.
 *
 * The raw payload is fetched only when its section is expanded. Two reasons:
 * a CloudTrail record is large, and reading it is audited server-side — so
 * pre-fetching would write a VIEW_RAW_EVENT entry for a payload nobody looked
 * at.
 */

/** A copyable value. Identifiers exist to be pasted into a ticket or another
    console, so every id in this drawer is one click from the clipboard. */
const CopyableValue = ({ value, mono = true, className = '' }) => {
  const [copied, setCopied] = useState(false);

  if (value === null || value === undefined || value === '') return <NotAvailable />;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(String(value));
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard access is denied in some contexts (an insecure origin, a
      // locked-down browser). The value is still selectable by hand, so a
      // failure here is not worth an error state.
    }
  };

  return (
    <span className={`group/copy inline-flex max-w-full items-start gap-1 ${className}`}>
      <span className={`min-w-0 break-all ${mono ? 'font-mono text-meta' : 'text-[12px]'} text-fg`}>
        {String(value)}
      </span>
      <button
        type="button"
        onClick={copy}
        title={copied ? 'Copied' : 'Copy'}
        aria-label={copied ? 'Copied' : 'Copy value'}
        className="mt-px shrink-0 text-subtle opacity-0 transition-opacity group-hover/copy:opacity-100 focus:opacity-100 hover:text-fg"
      >
        {copied ? <Check size={11} /> : <Copy size={11} />}
      </button>
    </span>
  );
};

/**
 * What a field looks like when the provider did not report it.
 *
 * Never a dash, never blank, never a guess. AWS reports a source IP and OCI
 * does not report a previous state; saying so is the honest answer and is a
 * hard requirement of this feature.
 */
const NotAvailable = ({ reason }) => (
  <span className="text-meta italic text-subtle" title={reason || 'The provider did not report this field for this event.'}>
    Not available
  </span>
);

/**
 * One labelled value.
 *
 * `onPivot` turns the value into a link that re-filters the Event Log by it —
 * "show me everything this principal did", "everything that touched this
 * resource", "everything from this IP". That is the move an investigation
 * actually makes, and without it the reader has to copy the value, close the
 * drawer, find the right filter and paste. The pivot is only offered where the
 * Event Log can genuinely filter on that field, so a link never leads to an
 * empty result caused by us rather than by the data.
 */
const Field = ({
  label, value, copyable = false, mono = false, reason, children, onPivot,
  pivotHint,
}) => (
  <div className="min-w-0 py-1">
    <dt className="text-micro font-semibold uppercase tracking-wide text-subtle">{label}</dt>
    <dd className="mt-0.5 min-w-0">
      {children !== undefined
        ? children
        : value === null || value === undefined || value === ''
          ? <NotAvailable reason={reason} />
          : onPivot
            ? (
              <span className="flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => onPivot(value)}
                  title={pivotHint || `Filter the Event Log by ${label.toLowerCase()}`}
                  className={`min-w-0 break-words text-left text-accent-text underline decoration-dotted underline-offset-2 hover:decoration-solid ${
                    mono ? 'font-mono text-meta' : 'text-[12px]'
                  }`}
                >
                  {String(value)}
                </button>
                {copyable && <CopyButton text={String(value)} label="" variant="ghost" />}
              </span>
            )
            : copyable
              ? <CopyableValue value={value} mono={mono} />
              : <span className={`break-words ${mono ? 'font-mono text-meta' : 'text-[12px]'} text-fg`}>{String(value)}</span>}
    </dd>
  </div>
);

const Section = ({ title, icon: Icon, children, action, defaultOpen = true, count }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-card border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {open ? <ChevronDown size={13} className="shrink-0 text-subtle" />
            : <ChevronRight size={13} className="shrink-0 text-subtle" />}
          {Icon && <Icon size={13} className="shrink-0 text-accent-text" />}
          <span className="truncate text-[12px] font-bold uppercase tracking-wide text-fg">
            {title}
          </span>
          {count !== undefined && count !== null && (
            <Badge tone="neutral" size="xs">{count}</Badge>
          )}
        </button>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {open && <div className="px-3 py-2.5">{children}</div>}
    </section>
  );
};

/** Icon for a principal kind. A person and a machine must not look alike —
    mistaking one for the other is the most consequential misread in an audit
    trail, so the actor type gets its own glyph and its own badge. */
const ACTOR_ICON = {
  Human: User,
  RootAccount: ShieldAlert,
  IAMRole: UserCog,
  ServicePrincipal: Bot,
  ServiceAccount: Bot,
  CloudService: Cloud,
  AutomatedProcess: Workflow,
  Unknown: KeyRound,
};

const ACTOR_TONE = {
  Human: 'info',
  RootAccount: 'danger',
  IAMRole: 'warning',
  ServicePrincipal: 'neutral',
  ServiceAccount: 'neutral',
  CloudService: 'neutral',
  AutomatedProcess: 'neutral',
  Unknown: 'neutral',
};

const ACTOR_LABEL = {
  Human: 'Human user',
  RootAccount: 'Root / tenancy administrator',
  IAMRole: 'Assumed IAM role',
  ServicePrincipal: 'Service principal',
  ServiceAccount: 'Service account',
  CloudService: 'Cloud service',
  AutomatedProcess: 'Automated process',
  Unknown: 'Unidentified principal',
};

/** Confidence of a related-events group, as a tone. A time-proximity link must
    not look as authoritative as a provider-assigned correlation id. */
const CONFIDENCE_TONE = { high: 'success', medium: 'info', low: 'neutral' };
const CONFIDENCE_LABEL = {
  high: 'Provider-asserted',
  medium: 'Same resource',
  low: 'Time proximity',
};

/** Pretty-printed JSON with copy and download. */
const JsonViewer = ({ value, filename }) => {
  const [copied, setCopied] = useState(false);
  const text = useMemo(() => JSON.stringify(value, null, 2), [value]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* see CopyableValue */ }
  };

  const download = () => {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1.5 rounded-control border border-border px-2 py-1 text-meta font-semibold text-muted transition-colors hover:text-fg"
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? 'Copied' : 'Copy JSON'}
        </button>
        <button
          type="button"
          onClick={download}
          className="inline-flex items-center gap-1.5 rounded-control border border-border px-2 py-1 text-meta font-semibold text-muted transition-colors hover:text-fg"
        >
          <Download size={11} /> Download JSON
        </button>
      </div>
      {/* Its own horizontal scroller: a deeply-nested payload must not make the
          drawer itself scroll sideways. */}
      <pre className="max-h-[420px] overflow-auto rounded-control bg-sunken p-2.5 font-mono text-meta leading-relaxed text-fg">
        {text}
      </pre>
    </div>
  );
};

/**
 * The before/after diff, shown ONLY where the provider genuinely reported both
 * sides.
 *
 * OCI Audit supplies `stateChange.previous` and `.current`, so OCI events get a
 * real diff. AWS and Azure report the parameters that were *requested*, which
 * is a different claim — those appear under the provider payload, labelled as
 * such, and this panel says the diff is unavailable instead of dressing a
 * request up as a previous state.
 */
const ChangeDiff = ({ change, provider }) => {
  if (!change?.available) {
    return (
      <p className="text-meta leading-relaxed text-muted">
        Not available from the provider audit event.
        {' '}
        {provider === 'OCI'
          ? 'OCI reports a previous state for some operations but did not for this one.'
          : `${provider} audit events record the parameters a change requested, not the resource's prior state. The requested parameters are under "Provider payload" below — they are what was asked for, not what the resource was before.`}
      </p>
    );
  }

  const fields = change.changed_fields?.length
    ? change.changed_fields
    : Array.from(new Set([
      ...Object.keys(change.before || {}),
      ...Object.keys(change.after || {}),
    ]));

  return (
    <div className="space-y-3">
      {fields.length > 0 && (
        <p className="flex flex-wrap items-center gap-1 text-meta text-muted">
          <span className="font-semibold">Changed:</span>
          {fields.map((f) => (
            <Badge key={f} tone="warning" size="xs">{f}</Badge>
          ))}
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="min-w-0 rounded-control border border-danger/30 bg-danger-soft/30 p-2">
          <p className="mb-1 text-micro font-bold uppercase tracking-wide text-danger-fg">
            − Before
          </p>
          <pre className="max-h-56 overflow-auto font-mono text-meta leading-relaxed text-fg">
            {JSON.stringify(change.before, null, 2)}
          </pre>
        </div>
        <div className="min-w-0 rounded-control border border-success/30 bg-success-soft/30 p-2">
          <p className="mb-1 text-micro font-bold uppercase tracking-wide text-success-fg">
            + After
          </p>
          <pre className="max-h-56 overflow-auto font-mono text-meta leading-relaxed text-fg">
            {JSON.stringify(change.after, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
};

/** The role-assumption / federation chain. Answers "who is the human behind
    this assumed role", which is the question an AWS audit trail is most often
    opened to answer. Rendered only from hops the provider actually recorded. */
const ActorChain = ({ chain }) => {
  if (!chain?.length) return null;
  return (
    <div className="mt-2 rounded-control bg-sunken p-2">
      <p className="mb-1.5 text-micro font-semibold uppercase tracking-wide text-subtle">
        Identity chain
      </p>
      <ol className="space-y-1">
        {chain.map((hop, i) => (
          <li key={`${hop.step}-${i}`} className="flex items-start gap-1.5 text-meta">
            <span className="mt-0.5 shrink-0 text-subtle">
              {i === 0 ? '' : '↓'}
            </span>
            <span className="min-w-0">
              <span className="font-semibold text-fg">{hop.name || 'Unnamed'}</span>
              <span className="text-subtle"> · {hop.type || hop.step}</span>
              {hop.id && (
                <span className="block truncate font-mono text-micro text-subtle" title={hop.id}>
                  {hop.id}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
};

export default function EventDetailDrawer({
  eventId, open, onClose, onOpenEvent, onViewDrift, onPivot,
}) {
  const navigate = useNavigate();
  const [rawOpen, setRawOpen] = useState(false);
  const { data: event, isLoading, isError, error } = useEvent(open ? eventId : null);
  const { data: raw, isLoading: rawLoading } = useEventRaw(eventId, open && rawOpen);
  const { data: related, isLoading: relatedLoading } = useRelatedEvents(
    open ? eventId : null, open,
  );

  const relatedGroups = related?.groups || {};
  const relatedCount = Object.values(relatedGroups)
    .reduce((sum, g) => sum + (g.events?.length || 0), 0);
  const relatedDrift = related?.related_drift || [];

  const ActorIcon = ACTOR_ICON[event?.actor?.type] || KeyRound;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={event?.event_name || 'Event details'}
      subtitle={event
        ? `${event.provider} · ${formatEventTime(event.timestamp)}`
        : undefined}
      width={720}
    >
      {isLoading ? (
        <InlineLoading label="Loading event…" />
      ) : isError || !event ? (
        <p className="text-sm text-muted">
          Could not load this event
          {error?.response?.status ? ` (HTTP ${error.response.status})` : ''}.
          {' '}
          {error?.response?.status === 404
            ? 'It may have aged out of the configured retention window.'
            : 'This is a request failure, not a missing event.'}
        </p>
      ) : (
        <div className="space-y-3">
          {/* ── Overview ──────────────────────────────────────────────────── */}
          <div className="rounded-card border border-border bg-sunken p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-2.5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border" style={providerTileStyle(event.provider)}>
                  <ProviderLogo provider={event.provider} size={22} />
                </span>
                <div className="min-w-0">
                  <p className="break-words text-[14px] font-bold text-fg">{event.event_name}</p>
                  <p className="mt-0.5 break-all font-mono text-meta text-subtle">
                    {event.api_operation || event.event_source}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                <Badge tone={STATUS_TONE[event.status] || 'neutral'} size="sm">
                  {event.status}
                </Badge>
                <Badge tone={RISK_TONE[event.risk_level] || 'neutral'} size="sm">
                  {event.risk_level}
                </Badge>
                <Badge tone="neutral" size="sm">{event.event_category}</Badge>
              </div>
            </div>

            {/* Why this risk level. A CRITICAL badge with no stated reason is
                something the reader has to take on trust; the classifier
                records the rule that fired, so it is shown. */}
            {event.risk_reason && (
              <p className="mt-2.5 flex items-start gap-1.5 rounded-control bg-surface px-2 py-1.5 text-meta leading-relaxed text-muted">
                <AlertTriangle size={12} className="mt-px shrink-0 text-warning-fg" />
                <span>
                  <span className="font-semibold text-fg">Why {event.risk_level}: </span>
                  {event.risk_reason}
                </span>
              </p>
            )}
          </div>

          {/* ── Who ───────────────────────────────────────────────────────── */}
          <Section title="Actor — who performed this" icon={ActorIcon}>
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <Badge tone={ACTOR_TONE[event.actor.type] || 'neutral'} size="sm">
                <ActorIcon size={11} /> {ACTOR_LABEL[event.actor.type] || event.actor.type}
              </Badge>
              {event.actor.type === 'RootAccount' && (
                <span className="text-meta font-semibold text-danger-fg">
                  Break-glass identity — every use is worth explaining
                </span>
              )}
              {['ServicePrincipal', 'CloudService', 'AutomatedProcess', 'ServiceAccount']
                .includes(event.actor.type) && (
                <span className="text-meta text-subtle">
                  Not a person — this was performed by software
                </span>
              )}
            </div>
            <dl className="grid gap-x-4 sm:grid-cols-2">
              <Field label="Name" value={event.actor.name} copyable
                onPivot={(v) => onPivot?.({ actor: v })}
                pivotHint="Show every event by this principal" />
              <Field label="Email" value={event.actor.email} copyable
                reason="This provider does not report an email address for this principal, and one is never derived from a username." />
              <Field label="Principal ID" value={event.actor.id} copyable mono
                onPivot={(v) => onPivot?.({ actor: v })}
                pivotHint="Show every event by this principal" />
              <Field label="Role" value={event.actor.role} copyable mono
                reason="No role was named on this audit event." />
              <Field label="Authentication" value={event.actor.authentication_method}
                reason="The provider did not record how this principal authenticated." />
            </dl>
            <ActorChain chain={event.actor.chain} />
          </Section>

          {/* ── What ──────────────────────────────────────────────────────── */}
          <Section title="Action — what was done" icon={Workflow}>
            <dl className="grid gap-x-4 sm:grid-cols-2">
              <Field label="Service / source" value={event.event_source} />
              <Field label="Action type" value={event.action} />
              <Field label="API operation" value={event.api_operation} copyable mono />
              <Field label="HTTP method" value={event.http_method}
                reason="The provider did not record the HTTP method." />
              <Field label="Provider category" value={event.provider_category} />
              <Field label="Read-only">
                {event.read_only === null || event.read_only === undefined
                  ? <NotAvailable reason="The provider did not state whether this operation was read-only." />
                  : (
                    <Badge tone={event.read_only ? 'neutral' : 'warning'} size="xs">
                      {event.read_only ? 'Read-only' : 'Changed state'}
                    </Badge>
                  )}
              </Field>
            </dl>
          </Section>

          {/* ── Which resource ────────────────────────────────────────────── */}
          <Section title="Resource — what was affected" icon={Server}>
            <dl className="grid gap-x-4 sm:grid-cols-2">
              <Field label="Name" value={event.resource.name} copyable
                onPivot={(v) => onPivot?.({ search: v })}
                pivotHint="Show every event touching this resource" />
              <Field label="Type" value={event.resource.type} />
              <Field label="Resource ID / ARN / OCID" value={event.resource.id} copyable mono
                onPivot={(v) => onPivot?.({ search: v })}
                pivotHint="Show every event touching this resource" />
              <Field label="Region" value={event.resource.region}
                reason="This provider's audit event carries no region field, and one is never inferred." />
              <Field label="Account / subscription / tenancy"
                value={event.resource.subscription || event.resource.tenancy || event.resource.account}
                copyable mono />
              <Field label="Resource group" value={event.resource.resource_group} />
              <Field label="Compartment" value={event.resource.compartment} />
              <Field label="Tenant" value={event.resource.tenant} copyable mono />
            </dl>
            {event.resource.additional?.length > 0 && (
              <div className="mt-2 rounded-control bg-sunken p-2">
                <p className="mb-1 text-micro font-semibold uppercase tracking-wide text-subtle">
                  Also touched ({event.resource.additional.length})
                </p>
                <ul className="space-y-0.5">
                  {event.resource.additional.map((r, i) => (
                    <li key={r.id || i} className="break-all font-mono text-meta text-muted">
                      {r.id}{r.type ? ` · ${r.type}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {event.resource.id && (
              <button
                type="button"
                onClick={() => { onClose(); navigate(`/cloud/resources?q=${encodeURIComponent(event.resource.name || event.resource.id)}`); }}
                className="mt-2 inline-flex items-center gap-1.5 text-meta font-semibold text-accent-text hover:text-accent-hover"
              >
                Find this resource in inventory <ExternalLink size={11} />
              </button>
            )}
          </Section>

          {/* ── When ──────────────────────────────────────────────────────── */}
          <Section title="When it happened" icon={Globe} defaultOpen={false}>
            <dl className="grid gap-x-4 sm:grid-cols-2">
              <Field label="Event time (local)">
                <span className="text-[12px] text-fg">{formatEventTime(event.timestamp)}</span>
              </Field>
              <Field label="Event time (UTC)">
                <span className="font-mono text-meta text-fg">
                  {new Date(event.timestamp).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}
                </span>
              </Field>
              <Field label="Reported by provider at"
                value={event.provider_received_at ? formatEventTime(event.provider_received_at) : null}
                reason="This provider does not report when it received the event." />
              <Field label="Collected by ACTMON at">
                <span className="text-[12px] text-fg">{formatEventTime(event.ingested_at)}</span>
              </Field>
              <Field label="Ingestion delay">
                {event.ingestion_latency_s === null || event.ingestion_latency_s === undefined
                  ? <NotAvailable />
                  : (
                    <span className="text-[12px] text-fg" title="Time between the provider's event time and this system collecting it. Provider audit APIs publish with their own delay, and collection runs on an interval.">
                      {formatDelay(event.ingestion_latency_s)}
                    </span>
                  )}
              </Field>
            </dl>
          </Section>

          {/* ── Where from ────────────────────────────────────────────────── */}
          <Section title="Source — where it came from" icon={Globe}>
            <dl className="grid gap-x-4 sm:grid-cols-2">
              <Field label="Source IP" value={event.source.ip} copyable mono
                onPivot={(v) => onPivot?.({ search: v })}
                pivotHint="Show every event from this address"
                reason="This provider did not record a source IP for this event." />
              <Field label="Access method" value={event.source.access_method}
                reason="The provider recorded nothing that identifies the client, so the access method is genuinely unknown rather than assumed." />
              <Field label="Geographic location" value={event.source.location}
                reason="None of the three providers report a location, and this system never derives one from an IP address." />
            </dl>
            <Field label="User agent" value={event.source.user_agent} mono
              reason="This provider's audit event carries no user agent." />
          </Section>

          {/* ── Request correlation ───────────────────────────────────────── */}
          <Section title="Request identifiers" icon={Workflow} defaultOpen={false}>
            <dl className="grid gap-x-4 sm:grid-cols-2">
              <Field label="Request ID" value={event.request.request_id} copyable mono />
              <Field label="Correlation ID" value={event.request.correlation_id} copyable mono
                reason="This provider does not assign a separate correlation id; the request id above is the identifier it does supply." />
              <Field label="Session ID" value={event.request.session_id} copyable mono />
              <Field label="Trace ID" value={event.request.trace_id} copyable mono />
              <Field label="Provider event ID" value={event.provider_event_id} copyable mono />
            </dl>
          </Section>

          {/* ── Result ────────────────────────────────────────────────────── */}
          <Section
            title="Result"
            icon={event.status === 'Success' ? Check : AlertTriangle}
          >
            <div
              className={`rounded-control p-2.5 ${
                ['Failed', 'Denied'].includes(event.status)
                  ? 'border border-danger/40 bg-danger-soft/40'
                  : 'bg-sunken'
              }`}
            >
              <dl className="grid gap-x-4 sm:grid-cols-2">
                <Field label="Status">
                  <Badge tone={STATUS_TONE[event.status] || 'neutral'} size="sm">
                    {event.status}
                  </Badge>
                </Field>
                <Field label="HTTP status" value={event.result.http_status}
                  reason="The provider did not record an HTTP status for this event." />
                <Field label="Error code" value={event.result.error_code}
                  reason={event.status === 'Success'
                    ? 'This event succeeded, so there is no error code.'
                    : 'The provider reported no error code.'} />
              </dl>
              {event.result.error_message && (
                <p className="mt-1.5 break-words rounded-control bg-surface px-2 py-1.5 text-meta leading-relaxed text-danger-fg">
                  {event.result.error_message}
                </p>
              )}
              {event.status === 'Denied' && (
                <p className="mt-1.5 text-meta leading-relaxed text-muted">
                  This operation was refused. A cluster of refusals from one principal
                  is what reconnaissance — or a misconfigured automation — looks like.
                </p>
              )}
              {event.status === 'Partial' && (
                <p className="mt-1.5 text-meta leading-relaxed text-muted">
                  The provider recorded this operation starting but not finishing.
                  Its outcome is a separate event sharing the same correlation id — see
                  Related events below.
                </p>
              )}
            </div>
          </Section>

          {/* ── What changed ──────────────────────────────────────────────── */}
          <Section title="Configuration change" icon={GitCompareArrows}>
            <ChangeDiff change={event.change} provider={event.provider} />
          </Section>

          {/* ── Related configuration drift ───────────────────────────────── */}
          {relatedDrift.length > 0 && (
            <Section
              title="Configuration drift this may have caused"
              icon={GitCompareArrows}
              count={relatedDrift.length}
            >
              <p className="mb-2 text-meta leading-relaxed text-muted">
                {relatedDrift[0].match_note}
              </p>
              <ul className="space-y-1.5">
                {relatedDrift.map((d) => (
                  <li key={d.id} className="rounded-control border border-border bg-sunken p-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={RISK_TONE[d.severity] || 'neutral'} size="xs">
                        {d.severity}
                      </Badge>
                      {d.field_path && (
                        <span className="font-mono text-meta font-semibold text-fg">
                          {d.field_path}
                        </span>
                      )}
                      <span className="ml-auto text-micro text-subtle">
                        detected {relativeTime(d.detected_at)}
                      </span>
                    </div>
                    <p className="mt-1 break-words text-meta text-muted">{d.summary}</p>
                    {onViewDrift && (
                      <button
                        type="button"
                        onClick={() => { onClose(); onViewDrift(d); }}
                        className="mt-1 inline-flex items-center gap-1 text-meta font-semibold text-accent-text hover:text-accent-hover"
                      >
                        View drift <ExternalLink size={10} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* ── Related events ────────────────────────────────────────────── */}
          <Section
            title="Related events"
            icon={Workflow}
            count={relatedCount}
            defaultOpen={relatedCount > 0}
          >
            {relatedLoading ? (
              <InlineLoading label="Finding related events…" />
            ) : relatedCount === 0 ? (
              <p className="text-meta leading-relaxed text-muted">
                Nothing else on file is linked to this event by a provider-assigned
                identifier, the same resource, or the same principal in a narrow time
                window. Time proximity alone is deliberately not treated as a
                relationship.
              </p>
            ) : (
              <div className="space-y-3">
                {Object.entries(relatedGroups).map(([key, group]) => (
                  <div key={key}>
                    <div className="mb-1 flex flex-wrap items-center gap-1.5">
                      <Badge tone={CONFIDENCE_TONE[group.confidence] || 'neutral'} size="xs">
                        {CONFIDENCE_LABEL[group.confidence] || group.confidence}
                      </Badge>
                      <span className="text-meta text-subtle">
                        {group.events.length} event{group.events.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <p className="mb-1.5 text-meta leading-relaxed text-subtle">
                      {group.why}
                    </p>
                    <ul className="space-y-1">
                      {group.events.map((e) => (
                        <li key={e.id}>
                          <button
                            type="button"
                            onClick={() => onOpenEvent?.(e.id)}
                            className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-sunken"
                          >
                            <Badge tone={RISK_TONE[e.risk_level] || 'neutral'} size="xs">
                              {e.risk_level}
                            </Badge>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-meta font-medium text-fg">
                                {e.event_name}
                              </span>
                              <span className="block truncate text-micro text-subtle">
                                {e.actor_name || 'Unknown actor'} · {relativeTime(e.timestamp)}
                              </span>
                            </span>
                            <ChevronRight size={12} className="shrink-0 text-subtle" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* ── Provider payload ──────────────────────────────────────────── */}
          {Object.keys(event.provider_metadata || {}).length > 0 && (
            <Section title="Provider payload (normalized)" icon={Cloud} defaultOpen={false}>
              <p className="mb-2 text-meta leading-relaxed text-muted">
                Fields this provider reports that the other two have no equivalent for.
                Kept rather than dropped during normalization.
              </p>
              <JsonViewer
                value={event.provider_metadata}
                filename={`event-${event.id}-metadata.json`}
              />
            </Section>
          )}

          {/* ── Raw event ─────────────────────────────────────────────────── */}
          <section className="rounded-card border border-border bg-surface">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <button
                type="button"
                onClick={() => setRawOpen((v) => !v)}
                aria-expanded={rawOpen}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                {rawOpen ? <ChevronDown size={13} className="shrink-0 text-subtle" />
                  : <ChevronRight size={13} className="shrink-0 text-subtle" />}
                <Cloud size={13} className="shrink-0 text-accent-text" />
                <span className="truncate text-[12px] font-bold uppercase tracking-wide text-fg">
                  Raw {event.provider} event
                </span>
                {event.redacted && <Badge tone="warning" size="xs">Redacted</Badge>}
              </button>
            </div>
            {rawOpen && (
              <div className="px-3 py-2.5">
                {event.raw_event_withheld ? (
                  <p className="text-meta leading-relaxed text-muted">
                    {event.raw_event_withheld}
                  </p>
                ) : rawLoading ? (
                  <InlineLoading label="Loading raw payload…" />
                ) : raw?.raw_event ? (
                  <>
                    <p className="mb-2 text-meta leading-relaxed text-muted">
                      {raw.redaction_note}
                    </p>
                    <JsonViewer
                      value={raw.raw_event}
                      filename={`event-${event.id}-raw.json`}
                    />
                  </>
                ) : (
                  <p className="text-meta text-muted">
                    No raw payload was stored for this event.
                  </p>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </Drawer>
  );
}

/** Ingestion delay in the largest unit that keeps it readable. */
function formatDelay(seconds) {
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)} ms`;
  if (seconds < 90) return `${seconds.toFixed(1)} seconds`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${minutes.toFixed(1)} minutes`;
  return `${(minutes / 60).toFixed(1)} hours`;
}

