import cn from '@/lib/cn';
import { compact, exact } from '../../utils/costFormat';
import {
  formatCount, providerLabel, riskMeta, statusMeta, toggleFacet,
} from '../../utils/resourceModel';

/**
 * Server-aggregated groups.
 *
 * The totals here are computed by the database over the same filter as the
 * table, not by bucketing the current page — a page of fifty rows cannot tell
 * you what a category of nine hundred costs.
 *
 * Costs are listed per currency and never summed across them. This estate bills
 * in both INR and USD, so a single combined figure would be a number
 * denominated in nothing.
 */

/** Which filter key a group dimension narrows to, so clicking a group applies
 *  the filter it represents. Dimensions with no matching filter are not
 *  clickable rather than silently doing nothing. */
const FILTER_KEY = {
  normalized_type: 'categories',
  resource_type: 'types',
  status: 'statuses',
  risk: 'risk',
  region: 'regions',
  provider: 'providers',
  environment: 'environments',
  owner: 'owners',
  resource_group: 'resourceGroups',
  compartment: 'compartments',
};

const labelFor = (groupBy, group) => {
  if (group.value === null || group.value === undefined) return 'Not set';
  if (groupBy === 'status') return statusMeta(group.value).label;
  if (groupBy === 'risk') return riskMeta(group.value).label;
  if (groupBy === 'provider') return providerLabel(group.value);
  return group.label ?? String(group.value);
};

export default function ResourceGroupPanel({ groups, groupBy, filters, onFilter }) {
  if (!groups) return null;

  if (groups.length === 0) {
    return (
      <div className="card px-4 py-3 text-[12px] text-muted">
        No groups — nothing matches the current filter.
      </div>
    );
  }

  const filterKey = FILTER_KEY[groupBy];
  const sorted = [...groups].sort((a, b) => (b.resource_count || 0) - (a.resource_count || 0));

  return (
    <div className="card overflow-hidden">
      <div className="border-b border-border bg-sunken px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
        {`Grouped — ${sorted.length} group${sorted.length === 1 ? '' : 's'}`}
      </div>
      <div className="grid gap-px bg-border [grid-template-columns:repeat(auto-fill,minmax(230px,1fr))]">
        {sorted.map((group) => {
          const active = filterKey && (filters[filterKey] || []).includes(group.value);
          const clickable = !!filterKey && group.value !== null && group.value !== undefined;
          const Element = clickable ? 'button' : 'div';
          return (
            <Element
              key={String(group.value ?? 'unset')}
              type={clickable ? 'button' : undefined}
              onClick={clickable ? () => onFilter(toggleFacet(filters, filterKey, group.value)) : undefined}
              aria-pressed={clickable ? !!active : undefined}
              className={cn(
                'bg-surface px-4 py-3 text-left',
                clickable && 'transition-colors hover:bg-sunken',
                active && 'bg-accent-soft/40',
              )}
            >
              <div className="truncate text-[13px] font-semibold text-fg" title={labelFor(groupBy, group)}>
                {labelFor(groupBy, group)}
              </div>
              <div className="mt-1 text-lg font-bold tabular-nums text-fg">
                {formatCount(group.resource_count)}
              </div>
              <div className="mt-0.5 space-y-0.5 text-[11px] text-muted">
                {(group.cost_by_currency || []).length > 0 ? (
                  group.cost_by_currency.map((c) => (
                    <div key={c.currency} title={exact(c.amount, c.currency)}>
                      {compact(c.amount, c.currency)}
                    </div>
                  ))
                ) : (
                  <div className="text-subtle">No cost reported</div>
                )}
                <div className="flex flex-wrap gap-x-2">
                  {group.risky_count > 0 && (
                    <span className="text-danger">{`${group.risky_count} at risk`}</span>
                  )}
                  {group.stopped_count > 0 && <span>{`${group.stopped_count} stopped`}</span>}
                  {group.untagged_count > 0 && <span>{`${group.untagged_count} untagged`}</span>}
                </div>
              </div>
            </Element>
          );
        })}
      </div>
    </div>
  );
}
