import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import cn from '@/lib/cn';
import { compact, exact, relativeTime } from '../../utils/costFormat';
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

  // This figure is the spend the provider attributes to INDIVIDUAL resources.
  // It is not the account's bill and is normally smaller — on OCI the gap is
  // everything billed at tenancy level (data transfer, support, licences) plus
  // every resource the provider prices at all. On one real account it read
  // ₹35.03L against a ₹45.34L bill, a 23% shortfall, because the tile was
  // labelled "Cost" and said only "212 of 476 priced". Saying how many
  // resources are covered is not the same as saying the number is a subset of
  // the bill, so both the label and the hover now say so outright, and the
  // window and fetch time travel with the figure.
  const costPeriod = costs.find((c) => c.period_days)?.period_days || null;
  const costFetchedAt = costs.map((c) => c.fetched_at).filter(Boolean).sort().pop() || null;

  const costSub = costs.length === 0 ? null : [
    `${formatCount(summary.cost_resource_count)} of ${formatCount(summary.resource_count)} priced`,
    'not the full bill',
  ].join(' · ');

  const costTitle = costs.length === 0
    ? 'No per-resource cost is available for the resources in this view.'
    : [
      ...costs.map((c) => `${exact(c.amount, c.currency)} across ${c.resource_count} resource(s)`),
      '',
      `This is only the spend your provider attributes to individual resources${
        costPeriod ? `, over the last ${costPeriod} days` : ''}.`,
      `${formatCount(summary.resource_count - summary.cost_resource_count)} resource(s) in this `
      + 'view report no per-resource billing, and spend billed at account level '
      + '(data transfer, support, licences) never appears here at all.',
      'Your account\'s actual billed total is on the Cost tab.',
      costFetchedAt ? `\nPer-resource prices last fetched ${relativeTime(costFetchedAt)}.` : '',
    ].filter(Boolean).join('\n');

  const isActive = (key, value) => (filters[key] || []).includes(value);

  return (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
      <Card
        label="Resources"
        icon="boxes"
        value={formatCount(summary.resource_count)}
        sub={loading ? 'Updating…' : 'In this view'}
      />

      {/* Shown only where the provider reports per-resource billing. On AWS
          this tile read "NA / No resource-level billing" on every account, and
          clicking it filtered to the zero resources that have a price — a
          control that could only ever empty the table. Spend for those
          accounts lives on the Cost tab, which reads the billing API at the
          service level where AWS does report. */}
      {summary.cost_resource_count > 0 && (
        <Card
          // "Per-resource cost", not "Cost". The old label invited the one
          // reading it cannot support: that this is what the account costs.
          label="Per-resource cost"
          icon="report"
          value={costValue}
          title={costTitle}
          sub={costSub}
          active={filters.hasCost === true}
          onClick={() => onFilter({
            ...filters,
            hasCost: filters.hasCost === true ? null : true,
          })}
        />
      )}

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

      {/* The Stopped and Unattached tiles are gone.
       *
       * "Unattached" was the worse of the two: the word appeared twice on this
       * page driven by two DIFFERENT backend columns — this tile counted
       * `attachment_state = UNATTACHED` (a volume attached to no host), while
       * the Status vocabulary has its own UNATTACHED value counted from
       * `normalized_status`. Two counts, one word, no way for a reader to know
       * which question either was answering.
       *
       * Both were also permanently 0 on a general inventory, because both only
       * ever apply to block storage. A tile that reads 0 for every account and
       * filters to nothing when clicked is a control that can only disappoint.
       *
       * The filters themselves still exist — `statuses: ['STOPPED']` and
       * `attachment: 'UNATTACHED'` remain valid query parameters, so a saved
       * view or a shared URL using them still works, and the Status facet
       * still offers Stopped where the data has any.
       */}

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
