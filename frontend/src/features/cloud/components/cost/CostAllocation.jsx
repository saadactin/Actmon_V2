/**
 * Allocation, tag coverage and the FinOps health score.
 *
 * The unallocated bucket is rendered as prominently as the allocated ones on
 * purpose. A chargeback view that shows four tidy owner totals and quietly
 * omits the 40% nobody tagged is worse than no view at all — the reader
 * assumes the four add up to the bill.
 *
 * The health score sits in its own section, visually separated from every
 * money figure, because a maturity score placed next to spend gets read as a
 * spend metric within about two seconds.
 */
import cn from '@/lib/cn';
import Badge from '@/components/ui/Badge';
import CloudSection from '../CloudSection';
import { AlertTriangle, Gauge, Info, Tag } from 'lucide-react';
import { compact, exact, isMissing, seriesColor } from '../../utils/costFormat';

const DIMENSION_LABELS = {
  owner: 'Owner', environment: 'Environment', application: 'Application',
  project: 'Project', department: 'Department', cost_center: 'Cost centre',
  team: 'Team', business_unit: 'Business unit',
};

export default function CostAllocation({ data, dimension, onDimension }) {
  if (!data) return null;

  if (data.supported === false) {
    const blockers = data.unsupported_reason || {};
    return (
      <CloudSection title="Cost allocation">
        <div className="rounded-control border border-dashed border-border bg-sunken p-5 text-center">
          <AlertTriangle size={20} className="mx-auto mb-2 text-subtle" aria-hidden />
          <p className="text-[13px] font-medium text-fg">
            Allocation is not available for this scope
          </p>
          <p className="mx-auto mt-1 max-w-xl text-[11.5px] leading-relaxed text-muted">
            Attributing spend to a tag requires knowing what each resource cost.
            This is a provider limitation, not missing tags — nothing here can be
            fixed by tagging more resources.
          </p>
          {Object.entries(blockers).map(([provider, reason]) => (
            <p key={provider} className="mx-auto mt-2 max-w-xl rounded-control border border-border bg-surface p-2.5 text-left text-[11px] text-muted">
              <strong className="text-fg">{provider}:</strong> {reason}
            </p>
          ))}
        </div>
      </CloudSection>
    );
  }

  const a = data.allocation || {};
  const allocated = a.allocated || [];
  const unallocated = a.unallocated_by_currency || {};
  const coverage = a.coverage_percent_by_currency || {};
  const tags = data.tag_coverage || {};

  const maxValue = Math.max(
    ...allocated.flatMap((b) => Object.values(b.by_currency || {})),
    ...Object.values(unallocated),
    1,
  );

  return (
    <div className="space-y-4">
      <CloudSection
        title="Cost allocation"
        description="Spend attributed from resource tags. Untagged spend is never assigned to anyone."
        action={(
          <select
            value={dimension}
            onChange={(e) => onDimension?.(e.target.value)}
            className="rounded-control border border-border bg-surface px-2 py-1 text-[12px] text-fg"
            aria-label="Allocation dimension"
          >
            {(data.dimensions_available || []).map((d) => (
              <option key={d} value={d}>{DIMENSION_LABELS[d] || d}</option>
            ))}
          </select>
        )}
      >
        <div className="mb-3 flex flex-wrap gap-2">
          {Object.entries(coverage).map(([code, pct]) => (
            <Badge key={code} tone={pct >= 80 ? 'success' : pct >= 50 ? 'warning' : 'danger'}>
              {code} allocation coverage: {isMissing(pct) ? 'NA' : `${pct}%`}
            </Badge>
          ))}
        </div>

        {allocated.length || Object.keys(unallocated).length ? (
          <ul className="space-y-2">
            {allocated.map((bucket, i) => (
              <li key={bucket.value} className="flex items-center gap-3 text-[12px]">
                <span className="w-40 shrink-0 truncate font-medium text-fg" title={bucket.value}>
                  {bucket.value}
                </span>
                <span className="h-2.5 flex-1 rounded-full bg-[var(--chart-track)]">
                  <span
                    className="block h-2.5 rounded-full"
                    style={{
                      width: `${Math.max(2, (Math.max(...Object.values(bucket.by_currency)) / maxValue) * 100)}%`,
                      background: seriesColor(i),
                    }}
                  />
                </span>
                <span className="w-12 text-right tabular-nums text-subtle">
                  {bucket.resource_count}
                </span>
                <span className="w-36 text-right font-semibold tabular-nums text-fg">
                  {Object.entries(bucket.by_currency)
                    .map(([code, v]) => (
                      <span key={code} title={exact(v, code)} className="block">
                        {compact(v, code)}
                      </span>
                    ))}
                </span>
              </li>
            ))}

            {/* Unallocated is a first-class row, not a footnote. */}
            {Object.keys(unallocated).length > 0 && (
              <li className="flex items-center gap-3 border-t border-border pt-2 text-[12px]">
                <span className="w-40 shrink-0 font-bold text-warning-fg">
                  Unallocated
                </span>
                <span className="h-2.5 flex-1 rounded-full bg-[var(--chart-track)]">
                  <span
                    className="block h-2.5 rounded-full bg-[var(--warning)]"
                    style={{
                      width: `${Math.max(2, (Math.max(...Object.values(unallocated)) / maxValue) * 100)}%`,
                    }}
                  />
                </span>
                <span className="w-12 text-right tabular-nums text-subtle">
                  {a.unallocated_resource_count}
                </span>
                <span className="w-36 text-right font-bold tabular-nums text-warning-fg">
                  {Object.entries(unallocated).map(([code, v]) => (
                    <span key={code} title={exact(v, code)} className="block">
                      {compact(v, code)}
                    </span>
                  ))}
                </span>
              </li>
            )}
          </ul>
        ) : (
          <p className="text-[12px] text-muted">
            No priced resources in this scope to allocate.
          </p>
        )}

        <p className="mt-3 rounded-control border border-border bg-sunken p-2.5 text-[11px] leading-relaxed text-muted">
          <Info size={11} className="mr-1 inline align-[-1px]" aria-hidden />
          {a.coverage_basis}
          {a.unpriced_resource_count > 0 && (
            <> {a.unpriced_resource_count} resource(s) had no billing record and are
            excluded from both figures — their cost is unknown, not unattributed.</>
          )}
        </p>
      </CloudSection>

      <CloudSection
        title="Tag coverage"
        description={tags.basis}
      >
        <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {Object.entries(tags.by_dimension || {}).map(([dim, v]) => (
            <li key={dim} className="flex items-center gap-2 text-[12px]">
              <Tag size={11} className="text-subtle" aria-hidden />
              <span className="w-28 text-muted">{DIMENSION_LABELS[dim] || dim}</span>
              <span className="h-1.5 flex-1 rounded-full bg-[var(--chart-track)]">
                <span
                  className="block h-1.5 rounded-full bg-[var(--chart-3)]"
                  style={{ width: `${v.coverage_percent ?? 0}%` }}
                />
              </span>
              <span className="w-14 text-right tabular-nums text-fg">
                {isMissing(v.coverage_percent) ? 'NA' : `${v.coverage_percent}%`}
              </span>
            </li>
          ))}
        </ul>
      </CloudSection>
    </div>
  );
}

/** FinOps health. Deliberately in its own section, away from spend. */
export function FinOpsHealth({ governance }) {
  const health = governance?.finops_health;
  const coverage = governance?.data_coverage;
  if (!health) return null;

  const tone = health.score >= 80 ? 'success'
    : health.score >= 50 ? 'warning' : 'danger';

  return (
    <CloudSection
      title="FinOps health"
      description="How well this estate is MANAGED — deliberately independent of what it costs"
    >
      <div className="flex flex-wrap items-center gap-5">
        <div className="text-center">
          <p className={cn(
            'text-[34px] font-bold tabular-nums leading-none',
            tone === 'success' ? 'text-success-fg'
              : tone === 'warning' ? 'text-warning-fg' : 'text-danger-fg',
          )}>
            {isMissing(health.score) ? 'NA' : health.score}
          </p>
          <p className="mt-1 text-[10.5px] uppercase tracking-wider text-subtle">
            out of 100
          </p>
        </div>

        <ul className="min-w-[240px] flex-1 space-y-1">
          {Object.entries(health.components || {}).map(([key, value]) => (
            <li key={key} className="flex items-center gap-2 text-[12px]">
              <span className="w-40 text-muted">{key.replace(/_/g, ' ')}</span>
              {isMissing(value) ? (
                <Badge tone="neutral" size="xs">No data — excluded</Badge>
              ) : (
                <>
                  <span className="h-1.5 flex-1 rounded-full bg-[var(--chart-track)]">
                    <span className="block h-1.5 rounded-full bg-[var(--chart-1)]"
                          style={{ width: `${value}%` }} />
                  </span>
                  <span className="w-12 text-right tabular-nums text-fg">{value}</span>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>

      <p className="mt-3 rounded-control border border-warning/30 bg-warning-soft p-2.5 text-[11px] leading-relaxed text-warning-fg">
        <Gauge size={11} className="mr-1 inline align-[-1px]" aria-hidden />
        {health.warning}
      </p>
      <p className="mt-2 text-[11px] text-subtle">{health.formula}</p>

      {coverage && (
        <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 lg:grid-cols-4">
          {[
            ['Historical data', `${coverage.historical_days} days`],
            ['Billing facts', (coverage.billing_facts ?? 0).toLocaleString()],
            ['Resource attribution',
              isMissing(coverage.resource_attribution_percent)
                ? 'NA' : `${coverage.resource_attribution_percent}%`],
            ['Forecast readiness', coverage.forecast_ready ? 'Ready' : 'Needs more history'],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-[10px] font-bold uppercase tracking-wider text-muted">
                {label}
              </dt>
              <dd className="text-[13px] font-semibold text-fg">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </CloudSection>
  );
}
