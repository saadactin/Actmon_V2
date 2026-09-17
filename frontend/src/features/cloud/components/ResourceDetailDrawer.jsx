import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import CopyButton from '@/components/ui/CopyButton';
import Drawer from '@/components/ui/Drawer';
import Icon from '@/components/ui/Icon';
import Tabs from '@/components/ui/Tabs';
import { InlineLoading } from '@/components/ui/Loading';
import cn from '@/lib/cn';
import RelatedEventsPanel from './RelatedEventsPanel';
import ResourceActions from './resources/ResourceActions';
import { useResourceDrift } from '../hooks/useDrift';
import { useResourceDetail, useResourceMetrics } from '../hooks/useResources';
import { useNeighbors } from '../hooks/useTopology';
import { slugForProvider } from '../utils/providerScope';
import { edgeStyle, typeMeta } from '../utils/topologyModel';
import {
  costText, formatDateTime, freshnessMeta, providerLabel, relativeTime, riskMeta,
  statusMeta, typeIcon,
} from '../utils/resourceModel';

/**
 * Resource inspection without leaving the inventory.
 *
 * Opens instantly against the row the table already holds, then fills in
 * configuration, metadata and metrics as those requests land. Waiting for a
 * round trip before showing anything would make the drawer feel slower than the
 * full page it exists to save you from opening.
 *
 * It reads from Cost, Security, Topology, Drift and Events — it does not
 * recompute any of them. Where one of those systems has nothing for this
 * resource, it says so and offers the link rather than inventing a count.
 */

const SENSITIVE = /(secret|password|passwd|token|key|credential|connection[_-]?string|private)/i;

/** Masked by key name: the scanners store provider payloads verbatim, and a
 *  field called "accessKey" is a secret whichever provider wrote it. */
const maskValue = (key, value) => (SENSITIVE.test(key) && value ? '••••••••' : value);

const Row = ({ label, value, mono, title, copy }) => (
  <div className="flex items-start justify-between gap-3 border-b border-border py-2 last:border-b-0">
    <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-muted">
      {label}
    </span>
    <span
      className={cn('min-w-0 flex-1 break-words text-right text-[12px] text-fg', mono && 'font-mono text-[11px]')}
      title={title}
    >
      {value === null || value === undefined || value === ''
        ? <span className="text-subtle">Not reported</span>
        : value}
      {copy && value ? (
        <span className="ml-2 inline-block align-middle">
          <CopyButton text={String(value)} label="" variant="ghost" />
        </span>
      ) : null}
    </span>
  </div>
);

const Section = ({ title, children, action }) => (
  <section className="mb-5">
    <div className="mb-1.5 flex items-center justify-between">
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</h4>
      {action}
    </div>
    {children}
  </section>
);

const Empty = ({ children }) => (
  <p className="rounded-control border border-dashed border-border px-3 py-4 text-center text-[12px] text-muted">
    {children}
  </p>
);

export const ResourceDetailDrawer = ({ resource, open, onClose }) => {
  const navigate = useNavigate();
  const [tab, setTab] = useState('overview');

  const resourceId = resource?.id || null;
  const { data: detail, isLoading } = useResourceDetail(open ? resourceId : null);
  const { data: metrics, isLoading: metricsLoading } = useResourceMetrics(
    open && tab === 'metrics' ? resourceId : null,
  );

  // Relationships come from the topology engine, which already resolved them.
  // Building a second relationship model here would give the drawer and the
  // topology page two different answers to the same question. Fetched only when
  // the tab is open — a graph walk is not worth doing for a drawer nobody
  // opened to that tab.
  // Keyed by the platform's own resource id, not the provider's: topology
  // nodes carry the provider id as a field but are identified by this one,
  // which is also why the graph's "open this node" links land on
  // /cloud/resources/{id}.
  const { data: neighbors, isLoading: neighborsLoading } = useNeighbors(
    resource?.account_id,
    open && tab === 'relationships' ? resource?.id : null,
    { hops: 1 },
  );

  // Change history comes from the drift log, which is append-only and built
  // from discovery diffs. It is NOT reconstructed from the resource's current
  // state — a history derived from "what it looks like now" would be fiction.
  const { data: drift, isLoading: driftLoading } = useResourceDrift(
    open && tab === 'activity' ? resourceId : null,
  );

  const accountRoute = useMemo(() => {
    if (!resource?.account_id) return null;
    return `/cloud/${slugForProvider(resource.provider)}-accounts/${resource.account_id}`;
  }, [resource]);

  const go = (tabName, params = '') => {
    if (!accountRoute) return;
    onClose();
    navigate(`${accountRoute}/${tabName}${params}`);
  };

  if (!resource) return null;

  const status = statusMeta(resource.status);
  const risk = riskMeta(resource.risk?.level);
  const cost = costText(resource.cost);
  const fresh = freshnessMeta(resource.freshness?.severity);
  const TypeIcon = typeIcon(resource.type_icon);

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'cost', label: 'Cost' },
    { id: 'risk', label: 'Risk' },
    { id: 'relationships', label: 'Relationships' },
    { id: 'activity', label: 'Activity' },
    { id: 'actions', label: 'Actions' },
    { id: 'tags', label: 'Tags', count: resource.tag_count || undefined },
    { id: 'config', label: 'Configuration' },
    { id: 'metrics', label: 'Metrics' },
    { id: 'raw', label: 'Raw JSON' },
  ];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={580}
      title={resource.resource_name || resource.provider_resource_id}
      subtitle={`${resource.type_label || resource.resource_type} · ${providerLabel(resource.provider)}${resource.account_name ? ` · ${resource.account_name}` : ''}${resource.region ? ` · ${resource.region}` : ''}`}
      footer={(
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            icon="external"
            onClick={() => { onClose(); navigate(`/cloud/resources/${resource.id}`); }}
          >
            Open full page
          </Button>
          <Button variant="secondary" size="sm" onClick={() => go('cost')}>Cost</Button>
          <Button variant="secondary" size="sm" onClick={() => go('security')}>Security</Button>
          <Button variant="secondary" size="sm" onClick={() => go('topology')}>Topology</Button>
          <Button variant="secondary" size="sm" onClick={() => go('events')}>Events</Button>
          <Button variant="secondary" size="sm" onClick={() => go('drift')}>Drift</Button>
        </div>
      )}
    >
      {/* The facts worth seeing before anything else loads. */}
      <div className="mb-4 flex items-start gap-3 rounded-control border border-border bg-sunken p-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-control bg-accent-soft text-accent-text">
          <TypeIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={status.tone} size="xs">
              {status.dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
              {status.label}
            </Badge>
            {resource.risk?.level && resource.risk.level !== 'NONE' && (
              <Badge tone={risk.tone} size="xs">{risk.label}</Badge>
            )}
            <Badge tone={fresh.tone} size="xs">{fresh.label}</Badge>
            {resource.is_default && <Badge tone="neutral" size="xs">default</Badge>}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
            <span className={cn(cost.available ? 'font-semibold text-fg' : 'text-subtle')} title={cost.title}>
              {cost.text}
              {cost.available && resource.cost?.period_days
                ? <span className="font-normal text-muted">{` / ${resource.cost.period_days}d`}</span>
                : null}
            </span>
            <span className="text-muted">
              {resource.risk?.assessed
                ? `${resource.risk.finding_count} finding${resource.risk.finding_count === 1 ? '' : 's'}`
                : 'Risk not assessed'}
            </span>
          </div>
        </div>
      </div>

      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      <div className="mt-4">
        {tab === 'overview' && (
          <>
            <Section title="Identity">
              <Row label="Name" value={resource.resource_name} />
              <Row label="Provider ID" value={resource.provider_resource_id} mono copy />
              <Row label="Type" value={resource.type_label || resource.resource_type} />
              <Row label="Category" value={resource.category_label} />
              <Row label="Provider" value={providerLabel(resource.provider)} />
              <Row label="Account" value={resource.account_name} />
              <Row label="Region" value={resource.region} />
              <Row label="Availability zone" value={resource.availability_zone} />
              <Row label="Resource group" value={resource.resource_group} />
              <Row label="Compartment" value={resource.compartment} />
              <Row label="Environment" value={resource.environment} />
              <Row label="Owner" value={resource.owner} />
              <Row label="IP address" value={resource.ip_address} mono />
            </Section>

            <Section title="Health">
              <Row label="State" value={<Badge tone={status.tone} size="xs">{status.label}</Badge>} />
              {/* Both readings are shown. The provider's own word is the
                  evidence; ours is an interpretation of it, and conflating the
                  two is how an Azure "Succeeded" comes to mean "running". */}
              <Row label="Provider state" value={resource.raw_status} mono />
              {resource.status_reason && <Row label="Why unknown" value={resource.status_reason} />}
              <Row
                label="Last observed"
                value={relativeTime(resource.freshness?.observed_at)}
                title={formatDateTime(resource.freshness?.observed_at)}
              />
              <Row label="Freshness" value={resource.freshness?.label} />
              {resource.freshness?.note && <Row label="Note" value={resource.freshness.note} />}
              <Row label="First discovered" value={formatDateTime(resource.discovered_at)} />
              <Row label="Last changed" value={formatDateTime(resource.updated_at)} />
              <Row label="Attachment" value={resource.attachment_state} />
              {resource.attached_to && (
                <Row
                  label="Attached to"
                  value={`${resource.attached_to.name || resource.attached_to.id}${
                    resource.attached_to.status ? ` (${resource.attached_to.status})` : ''}`}
                />
              )}
            </Section>
          </>
        )}

        {tab === 'cost' && (
          <Section
            title="Cost"
            action={<Button variant="ghost" size="sm" onClick={() => go('cost')}>Open Cost</Button>}
          >
            {cost.available ? (
              <>
                <Row label="Amount" value={cost.text} />
                <Row label="Currency" value={resource.cost.currency} />
                <Row label="Period" value={resource.cost.period_days ? `Last ${resource.cost.period_days} days` : null} />
                <Row label="Source" value={resource.cost.source} />
                <Row label="Billed as" value={resource.cost.billed_service} />
                <Row
                  label="Fetched"
                  value={relativeTime(resource.cost.fetched_at)}
                  title={formatDateTime(resource.cost.fetched_at)}
                />
              </>
            ) : (
              <Empty>{resource.cost?.reason || 'No cost is reported for this resource.'}</Empty>
            )}
          </Section>
        )}

        {tab === 'risk' && (
          <Section
            title="Security findings"
            action={<Button variant="ghost" size="sm" onClick={() => go('security')}>Open Security</Button>}
          >
            {!resource.risk?.assessed ? (
              <Empty>
                {resource.risk?.reason
                  || 'This account has not completed a security assessment, so findings for this resource are unknown — not zero.'}
              </Empty>
            ) : resource.risk.finding_count === 0 ? (
              <Empty>Assessed, with no open findings against this resource.</Empty>
            ) : (
              <>
                <Row label="Highest severity" value={<Badge tone={risk.tone} size="xs">{risk.label}</Badge>} />
                {Object.entries(resource.risk.severity_counts || {})
                  .filter(([, n]) => n > 0)
                  .map(([severity, n]) => (
                    <Row key={severity} label={severity} value={n} />
                  ))}
              </>
            )}
          </Section>
        )}

        {tab === 'relationships' && (
          <Section
            title="Related resources"
            action={<Button variant="ghost" size="sm" onClick={() => go('topology')}>Open Topology</Button>}
          >
            {neighborsLoading ? <InlineLoading label="Resolving relationships…" className="py-8" /> : (() => {
              // `found: false` means this resource is not in the graph at all,
              // which is a different statement from "in the graph, connected to
              // nothing" — the first is a gap in what we resolved, the second
              // is a fact about the estate.
              if (!neighbors || neighbors.error) {
                return <Empty>{neighbors?.error || 'The topology for this account is not available.'}</Empty>;
              }
              if (neighbors.found === false) {
                return (
                  <Empty>
                    This resource has not been placed in the topology graph, so its
                    relationships are unknown — not absent.
                  </Empty>
                );
              }
              const self = resource.id;
              const nodes = Object.fromEntries((neighbors.nodes || []).map((n) => [n.id, n]));
              const edges = (neighbors.edges || []).filter(
                (e) => e.source === self || e.target === self,
              );
              if (edges.length === 0) {
                return <Empty>No confirmed relationship connects this resource to another.</Empty>;
              }
              return (
                <>
                  {neighbors.truncated && (
                    <p className="mb-2 text-[11px] text-warning-fg">
                      Showing part of a large neighbourhood; open Topology for the whole graph.
                    </p>
                  )}
                  {edges.map((edge) => {
                    const otherId = edge.source === self ? edge.target : edge.source;
                    const other = nodes[otherId];
                    const style = edgeStyle(edge.type);
                    return (
                      <button
                        key={edge.id || `${edge.source}|${edge.target}|${edge.type}`}
                        type="button"
                        onClick={() => { onClose(); navigate(`/cloud/resources/${otherId}`); }}
                        className="flex w-full items-start justify-between gap-3 border-b border-border py-2 text-left last:border-b-0 hover:bg-sunken"
                      >
                        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-muted">
                          {/* The edge's own label where the engine wrote one —
                              it is specific to the relationship it found,
                              rather than the generic name for its kind. */}
                          {edge.label || style.label}
                        </span>
                        <span className="min-w-0 flex-1 text-right">
                          <span className="block truncate text-[12px] font-semibold text-fg">
                            {other?.name || otherId}
                          </span>
                          <span className="block truncate text-[11px] text-subtle">
                            {[typeMeta(other?.type).label, other?.status, other?.region]
                              .filter(Boolean).join(' · ')}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </>
              );
            })()}
          </Section>
        )}

        {tab === 'activity' && (
          <>
            <Section
              title="Configuration changes"
              action={<Button variant="ghost" size="sm" onClick={() => go('drift')}>Open Drift</Button>}
            >
              {driftLoading ? <InlineLoading label="Loading change history…" className="py-8" /> : (() => {
                const changes = drift?.changes || [];
                if (changes.length === 0) {
                  return (
                    <Empty>
                      No configuration change has been recorded for this resource.
                      Change history begins when drift capture first saw the
                      account, so anything before that is not missing — it was
                      never collected.
                    </Empty>
                  );
                }
                return changes.slice(0, 25).map((change) => (
                  <div
                    key={change.id}
                    className="border-b border-border py-2 last:border-b-0"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 flex-1 text-[12px] font-semibold text-fg">
                        {change.summary || change.field_path || change.change_type}
                      </span>
                      <span className="shrink-0 text-[11px] text-subtle" title={change.detected_at}>
                        {relativeTime(change.detected_at)}
                      </span>
                    </div>
                    {change.field_path && change.summary && (
                      <div className="mt-0.5 font-mono text-[11px] text-subtle">{change.field_path}</div>
                    )}
                    {(change.old_value !== undefined || change.new_value !== undefined) && (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                        <span className="rounded bg-danger-soft px-1.5 py-0.5 font-mono text-danger-fg">
                          {/* An absent old value and an empty one are different
                              things; the drift layer flags which with
                              value_vanished, so it is shown rather than
                              flattened into a blank. */}
                          {change.old_value === null || change.old_value === undefined
                            ? (change.value_vanished ? 'no longer reported' : 'not set')
                            : String(change.old_value).slice(0, 80)}
                        </span>
                        <Icon name="arrow-right" size={11} className="text-subtle" />
                        <span className="rounded bg-success-soft px-1.5 py-0.5 font-mono text-success-fg">
                          {change.new_value === null || change.new_value === undefined
                            ? 'not set'
                            : String(change.new_value).slice(0, 80)}
                        </span>
                        {change.severity && (
                          <Badge tone={change.severity === 'CRITICAL' || change.severity === 'HIGH' ? 'danger' : 'neutral'} size="xs">
                            {change.severity}
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>
                ));
              })()}
            </Section>

            <Section
              title="Who changed it"
              action={<Button variant="ghost" size="sm" onClick={() => go('events')}>Open Events</Button>}
            >
              {/* The Event Log's own panel, not a second copy of it. It already
                  distinguishes "no event was recorded" from "collection is
                  degraded, so absence is not evidence" — a distinction worth
                  more than a list of rows. */}
              <RelatedEventsPanel
                accountId={resource.account_id}
                resourceId={resource.id}
                resourceName={resource.resource_name}
                hours={720}
                compact
              />
            </Section>
          </>
        )}

        {tab === 'actions' && (
          <ResourceActions resource={resource} />
        )}

        {tab === 'tags' && (
          <Section title="Tags">
            {Object.keys(resource.tags || {}).length === 0 ? (
              <Empty>No tags are set on this resource.</Empty>
            ) : (
              Object.entries(resource.tags).map(([key, value]) => (
                <Row key={key} label={key} value={String(maskValue(key, value))} />
              ))
            )}
            {(resource.missing_required_tags || []).length > 0 && (
              <p className="mt-2 text-[12px] text-warning-fg">
                {`Missing required tag(s): ${resource.missing_required_tags.join(', ')}`}
              </p>
            )}
          </Section>
        )}

        {tab === 'config' && (
          <Section title="Configuration">
            {isLoading ? <InlineLoading label="Loading configuration…" className="py-8" />
              : !detail?.config || Object.keys(detail.config).length === 0
                ? <Empty>The provider returned no configuration for this resource.</Empty>
                : Object.entries(detail.config).map(([key, value]) => (
                  <Row
                    key={key}
                    label={key}
                    mono
                    value={
                      typeof value === 'object' && value !== null
                        ? JSON.stringify(maskValue(key, value))
                        : String(maskValue(key, value))
                    }
                  />
                ))}
          </Section>
        )}

        {tab === 'metrics' && (
          <Section title="Monitoring">
            {metricsLoading ? <InlineLoading label="Loading metrics…" className="py-8" />
              : !metrics?.metrics || Object.keys(metrics.metrics).length === 0 ? (
                <Empty>
                  {metrics?.message
                    || 'No metrics were returned for this resource. That can mean the provider publishes none for this resource type, the monitoring permission is missing, or the resource is stopped — the full page reports which.'}
                </Empty>
              ) : (
                Object.entries(metrics.metrics).map(([name, series]) => (
                  <Row
                    key={name}
                    label={name}
                    value={
                      Array.isArray(series) && series.length
                        ? `${series.length} datapoint${series.length === 1 ? '' : 's'}`
                        : null
                    }
                  />
                ))
              )}
          </Section>
        )}

        {tab === 'raw' && (
          <Section title="Raw provider response">
            {isLoading ? <InlineLoading label="Loading…" className="py-8" /> : (
              <>
                <p className="mb-2 text-[11px] text-muted">
                  Exactly what the provider returned, before normalization.
                </p>
                <pre className="max-h-[420px] overflow-auto rounded-control border border-border bg-sunken p-3 font-mono text-[11px] text-muted">
                  {JSON.stringify(detail?.raw_data ?? detail?.config ?? {}, null, 2)}
                </pre>
              </>
            )}
          </Section>
        )}
      </div>
    </Drawer>
  );
};

export default ResourceDetailDrawer;
