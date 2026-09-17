import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import cn from '@/lib/cn';
import { compact, exact } from '../../utils/costFormat';
import { formatCount } from '../../utils/resourceModel';

/**
 * The header strip.
 *
 * Every figure here comes from ONE backend summary computed from the same
 * filter as the rows — not from counting the page in the browser. That is what
 * makes the header, the facet rail and the table agree; when each computed its
 * own total they disagreed, which is the defect this layer exists to prevent.
 *
 * Each card is a filter. Clicking "Stopped" selects status=STOPPED rather than
 * navigating somewhere new, so the number you clicked is the number you get.
 */

const Card = ({ label, value, sub, tone = 'neutral', icon, active, onClick, title }) => {
  const Element = onClick ? 'button' : 'div';
  return (
    <Element
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      title={title}
      aria-pressed={onClick ? !!active : undefined}
      className={cn(
        'card px-4 py-3 text-left transition-colors',
        onClick && 'cursor-pointer hover:border-strong hover:bg-sunken',
        active && 'border-accent bg-accent-soft/40',
      )}
    >
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
        {icon && <Icon name={icon} size={13} className="text-subtle" />}
        {label}
      </div>
      <div className={cn(
        'text-lg font-bold tabular-nums',
        tone === 'danger' && 'text-danger',
        tone === 'warning' && 'text-warning-fg',
        tone !== 'danger' && tone !== 'warning' && 'text-fg',
      )}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[11px] leading-snug text-muted">{sub}</div>}
    </Element>
  );
};

export default function ResourceSummaryStrip({
  summary, dataQuality, filters, onFilter, loading, error,
}) {
  // A failed request must not render as a loading one. Skeletons that never
  // resolve are indistinguishable from a slow page, so someone waits instead of
  // reading the error that is already known.
  if (!summary && error) {
    return (
      <div className="card flex items-center gap-2 px-4 py-3 text-[12px] text-danger">
        <Icon name="alert" size={14} />
        <span>Totals are unavailable because the resource query failed.</span>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
        {Array.from({ length: 6 }).map((_, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <div key={i} className="card h-[76px] animate-pulse bg-sunken" />
        ))}
      </div>
    );
  }

  const costs = summary.cost_by_currency || [];
  // Currencies are never summed. This estate bills in INR and USD, and one
  // combined figure would be a number denominated in nothing — so each
  // currency is shown in its own right, and the card says how many resources
  // the figure actually covers.
  const costValue = costs.length === 0
    ? 'NA'
    : costs.map((c) => compact(c.amount, c.currency)).join(' + ');
  const costTitle = costs.length === 0
    ? 'No per-resource cost is available for the resources in this view.'
    : costs.map((c) => `${exact(c.amount, c.currency)} across ${c.resource_count} resource(s)`).join('\n');

  const isActive = (key, value) => (filters[key] || []).includes(value);

  return (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
      <Card
        label="Resources"
        icon="boxes"
        value={formatCount(summary.resource_count)}
        sub={loading ? 'Updating…' : 'In this view'}
      />

      <Card
        label="Cost"
        icon="report"
        value={costValue}
        title={costTitle}
        sub={
          summary.cost_resource_count
            ? `${formatCount(summary.cost_resource_count)} of ${formatCount(summary.resource_count)} priced`
            : 'No resource-level billing'
        }
        active={filters.hasCost === true}
        onClick={() => onFilter({
          ...filters,
          hasCost: filters.hasCost === true ? null : true,
        })}
      />

      <Card
        label="At risk"
        icon="alert"
        tone={summary.high_risk_count > 0 ? 'danger' : 'neutral'}
        value={formatCount(summary.high_risk_count)}
        sub={
          summary.risk_unknown_count
            ? `${formatCount(summary.risk_unknown_count)} not assessed`
            : `${formatCount(summary.risk_resource_count)} with findings`
        }
        title={
          'Critical or High findings.\n'
          + (summary.risk_unknown_count
            ? `${summary.risk_unknown_count} resource(s) are in accounts with no completed security assessment — their risk is unknown, not zero.`
            : '')
        }
        active={isActive('risk', 'CRITICAL') && isActive('risk', 'HIGH')}
        onClick={() => onFilter({
          ...filters,
          risk: isActive('risk', 'CRITICAL') && isActive('risk', 'HIGH')
            ? []
            : ['CRITICAL', 'HIGH'],
        })}
      />

      <Card
        label="Stopped"
        icon="stop"
        value={formatCount(summary.stopped_count)}
        sub="Not running"
        active={isActive('statuses', 'STOPPED')}
        onClick={() => onFilter({
          ...filters,
          statuses: isActive('statuses', 'STOPPED') ? [] : ['STOPPED'],
        })}
      />

      <Card
        label="Unattached"
        icon="plug"
        value={formatCount(summary.unattached_count)}
        sub="Storage with no host"
        title="Volumes and disks the provider reports as attached to nothing. Networks and IAM objects are excluded — they are not attachable, so they are not orphans."
        active={filters.attachment === 'UNATTACHED'}
        onClick={() => onFilter({
          ...filters,
          attachment: filters.attachment === 'UNATTACHED' ? null : 'UNATTACHED',
        })}
      />

      <Card
        label="Untagged"
        icon="bookmark"
        tone={summary.untagged_count > 0 ? 'warning' : 'neutral'}
        value={formatCount(summary.untagged_count)}
        sub={`${formatCount(summary.resource_count - summary.untagged_count)} tagged`}
        active={filters.hasTags === false}
        onClick={() => onFilter({
          ...filters,
          hasTags: filters.hasTags === false ? null : false,
        })}
      />

      <Card
        label="Stale"
        icon="clock"
        tone={summary.stale_count > 0 ? 'warning' : 'neutral'}
        value={formatCount(summary.stale_count)}
        sub={
          summary.newest_seen_at
            ? 'Inventory not re-observed recently'
            : 'Never observed'
        }
        title={
          dataQuality?.partial
            ? 'Some accounts in this view have not been swept recently, so their rows describe what discovery last saw rather than what is there now.'
            : 'Resources discovery has not re-observed within the freshness window.'
        }
        active={filters.stale === true}
        onClick={() => onFilter({
          ...filters,
          stale: filters.stale === true ? null : true,
        })}
      />

      {summary.status_unknown_count > 0 && (
        <Card
          label="No state"
          icon="help"
          value={formatCount(summary.status_unknown_count)}
          sub={(
            <span className="inline-flex items-center gap-1">
              <Badge tone="neutral" size="xs">Not reported</Badge>
            </span>
          )}
          title="The provider returned no lifecycle state for these resources. They are not assumed healthy."
          active={isActive('statuses', 'UNKNOWN')}
          onClick={() => onFilter({
            ...filters,
            statuses: isActive('statuses', 'UNKNOWN') ? [] : ['UNKNOWN'],
          })}
        />
      )}
    </div>
  );
}
