import { useState } from 'react';
import Icon from '@/components/ui/Icon';
import cn from '@/lib/cn';
import {
  categoryTone, formatCount, freshnessMeta, providerLabel, riskMeta, statusMeta,
  toggleFacet, typeIcon,
} from '../../utils/resourceModel';

/**
 * The facet rail.
 *
 * Counts come from the server in the current filter context, and a facet's own
 * filter is excluded from its own counts — so selecting "Compute" does not zero
 * out every other type. The rail's job is to answer "what would I get if I
 * picked something else", which a rail of zeros cannot do.
 *
 * This replaces a wall of type chips that rendered one button per distinct type
 * in the account. At 115 resource types that control was unusable; grouping by
 * category first, with types underneath, keeps it navigable.
 */

const Section = ({ title, children, count, defaultOpen = true }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-border py-2 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted hover:text-fg"
      >
        <span>{title}</span>
        <span className="flex items-center gap-1">
          {count > 0 && (
            <span className="rounded-full bg-accent-soft px-1.5 text-[10px] font-bold text-accent-text">
              {count}
            </span>
          )}
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
        </span>
      </button>
      {open && <div className="mt-0.5 space-y-px px-1.5">{children}</div>}
    </div>
  );
};

// Tone → class, written out rather than interpolated: Tailwind scans source for
// complete class names, so a template literal like `text-${tone}` produces a
// class that is never generated and silently renders unstyled.
const TONE_TEXT = {
  success: 'text-success-fg',
  warning: 'text-warning-fg',
  danger: 'text-danger',
  info: 'text-info-fg',
  accent: 'text-accent-text',
  neutral: 'text-subtle',
};

const Row = ({ label, count, active, onClick, icon: IconComponent, tone, title }) => (
  <button
    type="button"
    onClick={onClick}
    title={title || label}
    aria-pressed={active}
    className={cn(
      'flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-[12px] transition-colors',
      active ? 'bg-accent-soft font-semibold text-accent-text' : 'text-muted hover:bg-sunken hover:text-fg',
    )}
  >
    <span
      className={cn(
        'grid h-4 w-4 shrink-0 place-items-center rounded-[4px] border',
        active ? 'border-accent bg-accent text-accent-fg' : 'border-border',
      )}
      aria-hidden="true"
    >
      {active && <Icon name="check" size={11} />}
    </span>
    {IconComponent && (
      <IconComponent className={cn('h-3.5 w-3.5 shrink-0', TONE_TEXT[tone] || 'text-subtle')} />
    )}
    <span className="min-w-0 flex-1 truncate">{label}</span>
    {/* No count rather than a zero. These rows are narrowings the server does
        not facet, so for some of them we genuinely do not know the count —
        and printing 0 would state that we do. */}
    {typeof count === 'number' && (
      <span className="shrink-0 tabular-nums text-[11px] text-subtle">{formatCount(count)}</span>
    )}
  </button>
);

export default function ResourceFacetRail({
  facets, filters, onChange, reference, summary, isGlobal, error,
}) {
  // Same rule as the summary strip: a rail of skeletons that never resolve
  // reads as "still loading" when the truth is that the request failed.
  if (!facets && error) {
    return (
      <div className="card px-3 py-4 text-[12px] text-muted">
        Filters are unavailable while the resource query is failing.
      </div>
    );
  }

  if (!facets) {
    return (
      <div className="card space-y-2 p-3">
        {Array.from({ length: 10 }).map((_, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <div key={i} className="h-6 animate-pulse rounded bg-sunken" />
        ))}
      </div>
    );
  }

  const toggle = (key, value) => onChange(toggleFacet(filters, key, value));
  const selected = (key) => filters[key] || [];
  const requiredTags = reference?.required_tag_keys || [];

  return (
    <div className="card divide-y divide-border">
      {isGlobal && (facets.providers || []).length > 0 && (
        <Section title="Provider" count={selected('providers').length}>
          {facets.providers.map((f) => (
            <Row
              key={f.value}
              label={providerLabel(f.value)}
              count={f.count}
              active={selected('providers').includes(f.value)}
              onClick={() => toggle('providers', f.value)}
            />
          ))}
        </Section>
      )}

      {isGlobal && (facets.accounts || []).length > 1 && (
        <Section title="Account" count={0} defaultOpen={false}>
          {facets.accounts.map((f) => (
            <Row key={f.value} label={f.label} count={f.count} active={false} onClick={undefined} />
          ))}
        </Section>
      )}

      {(facets.categories || []).length > 0 && (
        <Section title="Category" count={selected('categories').length}>
          {facets.categories.map((f) => (
            <Row
              key={f.value}
              label={f.label}
              count={f.count}
              icon={typeIcon(
                (reference?.categories || []).find((c) => c.value === f.value)?.icon,
              )}
              tone={categoryTone(f.value)}
              active={selected('categories').includes(f.value)}
              onClick={() => toggle('categories', f.value)}
            />
          ))}
        </Section>
      )}

      {(facets.types || []).length > 0 && (
        <Section title="Resource type" count={selected('types').length} defaultOpen={false}>
          {facets.types.map((f) => (
            <Row
              key={f.value}
              label={f.label}
              count={f.count}
              active={selected('types').includes(f.value)}
              onClick={() => toggle('types', f.value)}
            />
          ))}
        </Section>
      )}

      {(facets.statuses || []).length > 0 && (
        <Section title="Status" count={selected('statuses').length}>
          {facets.statuses.map((f) => {
            const meta = statusMeta(f.value);
            return (
              <Row
                key={f.value}
                label={meta.label}
                count={f.count}
                tone={meta.tone}
                active={selected('statuses').includes(f.value)}
                onClick={() => toggle('statuses', f.value)}
                title={
                  f.value === 'UNKNOWN'
                    ? 'The provider reported no lifecycle state for these resources.'
                    : meta.label
                }
              />
            );
          })}
        </Section>
      )}

      {(facets.risk || []).length > 0 && (
        <Section title="Risk" count={selected('risk').length}>
          {facets.risk.map((f) => {
            const meta = riskMeta(f.value);
            return (
              <Row
                key={f.value}
                label={meta.label}
                count={f.count}
                active={selected('risk').includes(f.value)}
                onClick={() => toggle('risk', f.value)}
                title={
                  f.value === 'UNKNOWN'
                    ? 'No completed security assessment covers these resources, so their risk is unknown — not zero.'
                    : meta.label
                }
              />
            );
          })}
        </Section>
      )}

      {(facets.regions || []).length > 0 && (
        <Section title="Region" count={selected('regions').length} defaultOpen={false}>
          {facets.regions.map((f) => (
            <Row
              key={f.value}
              label={f.label}
              count={f.count}
              active={selected('regions').includes(f.value)}
              onClick={() => toggle('regions', f.value)}
            />
          ))}
        </Section>
      )}

      {(facets.environments || []).length > 0 && (
        <Section title="Environment" count={selected('environments').length} defaultOpen={false}>
          {facets.environments.map((f) => (
            <Row
              key={f.value}
              label={f.label}
              count={f.count}
              active={selected('environments').includes(f.value)}
              onClick={() => toggle('environments', f.value)}
            />
          ))}
        </Section>
      )}

      {(facets.resource_groups || []).length > 0 && (
        <Section title="Resource group" count={selected('resourceGroups').length} defaultOpen={false}>
          {facets.resource_groups.map((f) => (
            <Row
              key={f.value}
              label={f.label}
              count={f.count}
              active={selected('resourceGroups').includes(f.value)}
              onClick={() => toggle('resourceGroups', f.value)}
            />
          ))}
        </Section>
      )}

      {(facets.compartments || []).length > 0 && (
        <Section title="Compartment" count={selected('compartments').length} defaultOpen={false}>
          {facets.compartments.map((f) => (
            <Row
              key={f.value}
              label={f.label}
              count={f.count}
              active={selected('compartments').includes(f.value)}
              onClick={() => toggle('compartments', f.value)}
            />
          ))}
        </Section>
      )}

      {/* Cost, tags, attachment and freshness are not server facets — they are
          boolean narrowings of the same query, so their counts come from the
          summary, which is computed from that same filter. */}
      <Section title="Cost" count={typeof filters.hasCost === 'boolean' ? 1 : 0} defaultOpen={false}>
        <Row
          label="Has cost data"
          count={summary?.cost_resource_count ?? 0}
          active={filters.hasCost === true}
          onClick={() => onChange({ ...filters, hasCost: filters.hasCost === true ? null : true })}
        />
        <Row
          label="No cost reported"
          count={Math.max(0, (summary?.resource_count ?? 0) - (summary?.cost_resource_count ?? 0))}
          active={filters.hasCost === false}
          onClick={() => onChange({ ...filters, hasCost: filters.hasCost === false ? null : false })}
          title="Either the provider does not bill this resource individually, or its billing integration cannot report per-resource cost."
        />
      </Section>

      <Section title="Tags" count={typeof filters.hasTags === 'boolean' || filters.missingTag ? 1 : 0} defaultOpen={false}>
        <Row
          label="Tagged"
          count={Math.max(0, (summary?.resource_count ?? 0) - (summary?.untagged_count ?? 0))}
          active={filters.hasTags === true}
          onClick={() => onChange({ ...filters, hasTags: filters.hasTags === true ? null : true })}
        />
        <Row
          label="Untagged"
          count={summary?.untagged_count ?? 0}
          active={filters.hasTags === false}
          onClick={() => onChange({ ...filters, hasTags: filters.hasTags === false ? null : false })}
        />
        {/* Only rendered when required tags are actually configured. Inventing
            an organisation's tag policy here would be inventing data. */}
        {requiredTags.map((key) => (
          <Row
            key={key}
            label={`Missing ${key}`}
            count={undefined}
            active={filters.missingTag === key}
            onClick={() => onChange({
              ...filters, missingTag: filters.missingTag === key ? null : key,
            })}
          />
        ))}
      </Section>

      <Section title="Attachment" count={filters.attachment ? 1 : 0} defaultOpen={false}>
        <Row
          label="Attached"
          count={undefined}
          active={filters.attachment === 'ATTACHED'}
          onClick={() => onChange({
            ...filters, attachment: filters.attachment === 'ATTACHED' ? null : 'ATTACHED',
          })}
          title="Only storage volumes carry an attachment state. A subnet is not an unattached disk."
        />
        <Row
          label="Unattached"
          count={summary?.unattached_count ?? 0}
          active={filters.attachment === 'UNATTACHED'}
          onClick={() => onChange({
            ...filters, attachment: filters.attachment === 'UNATTACHED' ? null : 'UNATTACHED',
          })}
        />
      </Section>

      <Section title="Freshness" count={typeof filters.stale === 'boolean' ? 1 : 0} defaultOpen={false}>
        <Row
          label={freshnessMeta('FRESH').label}
          count={Math.max(0, (summary?.resource_count ?? 0) - (summary?.stale_count ?? 0))}
          active={filters.stale === false}
          onClick={() => onChange({ ...filters, stale: filters.stale === false ? null : false })}
        />
        <Row
          label={freshnessMeta('STALE').label}
          count={summary?.stale_count ?? 0}
          active={filters.stale === true}
          onClick={() => onChange({ ...filters, stale: filters.stale === true ? null : true })}
          title="Discovery has not re-observed these resources within the freshness window, so the rows describe what was last seen rather than what is there now."
        />
      </Section>

      <Section title="Display" count={filters.includeDefaults === false ? 1 : 0} defaultOpen={false}>
        <Row
          label="Hide default resources"
          count={undefined}
          active={filters.includeDefaults === false}
          onClick={() => onChange({
            ...filters, includeDefaults: filters.includeDefaults === false ? true : false,
          })}
          title="Provider-created boilerplate — default VPCs, default security groups — exists in every account and crowds out what someone actually built."
        />
      </Section>
    </div>
  );
}
