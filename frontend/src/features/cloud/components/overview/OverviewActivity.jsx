import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import { exact } from '../../utils/costFormat';
import {
  costText, formatCount, relativeTime, riskMeta, statusMeta, typeIcon,
} from '../../utils/resourceModel';
import { BarRow, Panel, PanelEmpty, ViewLink } from './OverviewPrimitives';

/**
 * The "what is happening / what should I look at" half of the Overview.
 *
 * Every panel here reads the system that owns the data — Resources, Config
 * Drift, the Event Log, the Security Center — and none of them keeps its own
 * copy. Where a system has no history for this account they say so, because
 * "no changes recorded" and "change recording has not started" look identical
 * in a count of zero and mean entirely different things.
 */

export function RecentlyDiscovered({ rows, isLoading, error, onOpenResource, onOpenAll }) {
  return (
    <Panel
      title="Recently Discovered"
      icon="boxes"
      action={<ViewLink onClick={onOpenAll}>Resources</ViewLink>}
      loading={isLoading}
      error={error}
      empty={!isLoading && !error && (rows || []).length === 0}
      emptyMessage="No resources have been discovered yet. Use Refresh all at the top of the page."
      dense
    >
      <div className="space-y-1">
        {(rows || []).map((row) => {
          const TypeIcon = typeIcon(row.type_icon);
          const status = statusMeta(row.status);
          const cost = costText(row.cost);
          return (
            <button
              key={row.id}
              type="button"
              onClick={() => onOpenResource(row.id)}
              className="flex w-full items-center gap-2.5 rounded-control px-2 py-1.5 text-left hover:bg-sunken"
            >
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-control bg-accent-soft text-accent-text">
                <TypeIcon className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-semibold text-fg">
                  {row.resource_name || row.provider_resource_id}
                </span>
                <span className="block truncate text-meta text-subtle">
                  {[row.type_label || row.resource_type, row.region].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <Badge tone={status.tone} size="xs">{status.label}</Badge>
                <span className="mt-0.5 block text-micro text-subtle">
                  {relativeTime(row.discovered_at) || '—'}
                </span>
              </span>
              <span className={`w-20 shrink-0 text-right text-meta tabular-nums ${cost.available ? 'font-semibold text-fg' : 'text-subtle'}`} title={cost.title}>
                {cost.text}
              </span>
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

export function RecentChanges({ changes, summary, isLoading, error, onOpenDrift }) {
  const rows = changes?.items || [];
  // The drift service states outright whether it has any history for this
  // account. An empty list plus has_history=false is "recording has not
  // started", which is not the same claim as "nothing changed".
  const hasHistory = summary?.has_history !== false;

  return (
    <Panel
      title="Recent Changes"
      icon="history"
      subtitle={
        summary?.total_changes != null
          ? `${formatCount(summary.total_changes)} in the last ${summary.window_days ?? 30} days`
          : 'From the configuration drift log'
      }
      action={<ViewLink onClick={onOpenDrift}>Config Drift</ViewLink>}
      loading={isLoading}
      error={error}
      dense
    >
      {!hasHistory ? (
        <PanelEmpty>
          Change history has not been collected for this account yet. Changes are
          recorded from the differences between discovery sweeps, so the first
          entries appear after the next scan.
        </PanelEmpty>
      ) : rows.length === 0 ? (
        <PanelEmpty>
          No configuration change was recorded in this period.
        </PanelEmpty>
      ) : (
        <div className="space-y-1">
          {rows.slice(0, 5).map((change) => (
            <div key={change.id} className="rounded-control px-2 py-1.5 hover:bg-sunken">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-fg">
                  {change.resource_name || change.provider_resource_id}
                </span>
                <span className="shrink-0 text-micro text-subtle" title={change.detected_at}>
                  {relativeTime(change.detected_at)}
                </span>
              </div>
              <div className="truncate text-meta text-muted" title={change.summary || change.field_path}>
                {change.summary || change.field_path || change.change_type}
              </div>
            </div>
          ))}
        </div>
      )}

      {hasHistory && summary?.by_impact && (
        <div className="mt-2 flex flex-wrap gap-1.5 border-t border-border pt-2">
          {Object.entries(summary.by_impact)
            .filter(([, n]) => n > 0)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([impact, n]) => (
              <Badge key={impact} tone={impact === 'security' ? 'warning' : 'neutral'} size="xs">
                {`${n} ${impact}`}
              </Badge>
            ))}
        </div>
      )}
    </Panel>
  );
}

export function RecentEvents({ events, isLoading, error, onOpenEvents }) {
  const rows = events?.items || [];
  return (
    <Panel
      title="Recent Activity"
      icon="logs"
      subtitle={
        events?.total != null
          ? `${formatCount(events.total)} control-plane events in the last 7 days`
          : 'From the Event Log'
      }
      action={<ViewLink onClick={onOpenEvents}>Event Log</ViewLink>}
      loading={isLoading}
      error={error}
      dense
    >
      {rows.length === 0 ? (
        <PanelEmpty>
          No control-plane events were recorded for this account in this period.
          That can mean nothing happened, or that event collection is not
          configured — the Event Log reports which.
        </PanelEmpty>
      ) : (
        <div className="space-y-1">
          {rows.slice(0, 6).map((event) => (
            <button
              key={event.id}
              type="button"
              onClick={onOpenEvents}
              className="flex w-full items-start gap-2 rounded-control px-2 py-1.5 text-left hover:bg-sunken"
            >
              <Icon
                name={event.status === 'Failure' ? 'alert' : 'check'}
                size={13}
                className={`mt-0.5 shrink-0 ${event.status === 'Failure' ? 'text-danger' : 'text-subtle'}`}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-fg">
                  {event.event_name || event.action || 'Event'}
                </span>
                <span className="block truncate text-meta text-subtle">
                  {[event.actor_name || 'Unknown actor', event.resource_name].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span className="shrink-0 text-micro text-subtle" title={event.occurred_at}>
                {relativeTime(event.occurred_at)}
              </span>
            </button>
          ))}
        </div>
      )}
    </Panel>
  );
}

export function TopRisks({ posture, isLoading, error, onOpenResource, onOpenSecurity }) {
  const risks = posture?.top_risks || [];
  return (
    <Panel
      title="Top Risks"
      icon="alert"
      action={<ViewLink onClick={onOpenSecurity}>Security</ViewLink>}
      loading={isLoading}
      error={error}
      empty={!isLoading && !error && risks.length === 0}
      emptyMessage="No open findings were returned for this account."
      dense
    >
      <div className="space-y-1">
        {risks.slice(0, 5).map((risk) => {
          const meta = riskMeta(risk.severity);
          return (
            <button
              key={risk.id}
              type="button"
              onClick={() => (risk.resource_id ? onOpenResource(risk.resource_id) : onOpenSecurity())}
              className="flex w-full items-start gap-2 rounded-control px-2 py-1.5 text-left hover:bg-sunken"
            >
              <Badge tone={meta.tone} size="xs" className="mt-0.5 shrink-0">{meta.label}</Badge>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-semibold text-fg">
                  {risk.resource_name || risk.resource_key || 'Resource'}
                </span>
                <span className="block truncate text-meta text-muted" title={risk.title}>
                  {risk.title || risk.rule_id}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

export function TopCostResources({ rows, isLoading, error, capabilities, onOpenResource, onOpenCost }) {
  const items = rows?.rows || [];
  // AWS Cost Explorer has no per-resource dimension. Saying so beats an empty
  // list that reads as "nothing here costs anything".
  const unsupported = capabilities?.blocked?.some?.(
    (b) => b.capability === 'resource_cost',
  );

  return (
    <Panel
      title="Top Cost Resources"
      icon="report"
      action={<ViewLink onClick={onOpenCost}>Cost</ViewLink>}
      loading={isLoading}
      error={error}
      dense
    >
      {items.length === 0 ? (
        <PanelEmpty>
          {unsupported
            ? 'This provider integration does not report cost per individual resource, so a ranking cannot be built.'
            : 'No resource in this account has a per-resource cost recorded for the current billing window.'}
        </PanelEmpty>
      ) : (
        <div className="space-y-1">
          {items.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => onOpenResource(row.id)}
              className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left hover:bg-sunken"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-semibold text-fg">
                  {row.resource_name || row.provider_resource_id}
                </span>
                <span className="block truncate text-meta text-subtle">
                  {[row.type_label || row.resource_type, row.region].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span className="shrink-0 text-[12px] font-semibold tabular-nums text-fg">
                {exact(row.cost?.amount, row.cost?.currency)}
              </span>
            </button>
          ))}
        </div>
      )}
    </Panel>
  );
}

export function TopologySnapshot({ topology, isLoading, error, onOpenTopology }) {
  return (
    <Panel
      title="Relationships"
      icon="network"
      action={<ViewLink onClick={onOpenTopology}>Topology</ViewLink>}
      loading={isLoading}
      error={error}
      dense
    >
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-xl font-bold tabular-nums text-fg">
            {formatCount(topology?.confirmed_relationships)}
          </div>
          <div className="text-meta text-muted">Confirmed relationships</div>
        </div>
        <div>
          <div className="text-xl font-bold tabular-nums text-fg">
            {formatCount(topology?.isolated)}
          </div>
          <div className="text-meta text-muted">Isolated resources</div>
        </div>
      </div>
      {topology?.resolved_pct != null && (
        <p className="mt-2 border-t border-border pt-2 text-meta text-muted">
          {`${topology.resolved_pct}% of references between resources resolved to a known target.`}
          {topology.unsupported_type > 0
            && ` ${formatCount(topology.unsupported_type)} reference(s) point at resource types the graph does not model yet.`}
        </p>
      )}
    </Panel>
  );
}

export function DataQualityPanel({ dataQuality, monitoring, isLoading, error }) {
  const coverage = dataQuality?.coverage || {};
  const ROWS = [
    ['Inventory', 100, 'Every discovered resource is stored.'],
    ['Status', coverage.status, 'Resources for which the provider reported a lifecycle state.'],
    ['Tags', coverage.tags, 'Resources carrying at least one tag.'],
    ['Cost', coverage.cost, 'Resources with a per-resource billed amount.'],
    ['Configuration', coverage.configuration, 'Resources with stored provider configuration.'],
  ];

  return (
    <Panel
      title="Data Coverage"
      icon="gauge"
      loading={isLoading}
      error={error}
      dense
    >
      <div className="space-y-0.5">
        {ROWS.map(([label, value, hint]) => (
          <BarRow
            key={label}
            label={label}
            value={typeof value === 'number' ? Math.round(value) : 0}
            total={100}
            suffix="%"
            tone={
              typeof value !== 'number' ? 'neutral'
                : value >= 90 ? 'success' : value >= 50 ? 'info' : 'warning'
            }
            title={`${label} — ${hint}`}
          />
        ))}
      </div>
      {/* Coverage is not health. A resource whose state the provider never
          reported is not a broken resource, and this panel must not be read
          as if it were. */}
      <p className="mt-2 border-t border-border pt-2 text-meta leading-snug text-subtle">
        Coverage describes what the platform knows, not whether the resources are
        healthy. A gap usually means the provider does not report that field for
        that resource type.
      </p>
    </Panel>
  );
}
