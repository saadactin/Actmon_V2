/**
 * Panels for the Cost Intelligence tabs: top drivers, forecast, anomalies,
 * change analysis and budgets.
 *
 * The recurring rule: an analysis the stored history cannot support renders
 * `InsufficientHistory` naming the shortfall, never an empty chart. And the
 * change panel says "associated changes", never "cause" — billing data can
 * show that figures moved together, not that one produced the other.
 */
import { useState } from 'react';
import cn from '@/lib/cn';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, ChevronRight, Info, Target,
  TrendingUp, Zap,
} from 'lucide-react';
import {
  Amount, ChangeChip, InsufficientHistory, PanelHeading, Provenance,
} from './CostPrimitives';
import { CostForecastChart, CostWaterfall } from './CostCharts';
import { compact, exact, formatDate, isMissing, percent, seriesColor } from '../../utils/costFormat';

/** Ranked cost drivers. Clicking one filters the rest of the page. */
export function TopCostDrivers({ rows, currency, onSelect, dimension = 'service' }) {
  const items = (rows || [])
    .filter((r) => !isMissing(r.amount))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 8);
  const total = items.reduce((s, r) => s + Number(r.amount), 0);

  if (!items.length) {
    return <p className="text-[12px] text-muted">No billed {dimension}s in this period.</p>;
  }

  return (
    <ol className="space-y-1.5">
      {items.map((row, i) => {
        const name = row[dimension] || row.name || 'Unknown';
        const share = total ? (Number(row.amount) / total) * 100 : 0;
        return (
          <li key={`${name}-${i}`}>
            <button
              type="button"
              onClick={() => onSelect?.(name)}
              className="group flex w-full items-center gap-3 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-sunken"
            >
              <span className="w-4 text-[11px] font-bold tabular-nums text-subtle">
                {i + 1}
              </span>
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ background: seriesColor(i) }}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium text-fg">
                  {name}
                </span>
                {/* the bar is a secondary encoding of the same share the number
                    states, so the ranking survives without colour vision */}
                <span className="mt-1 block h-1 w-full rounded-full bg-[var(--chart-track)]">
                  <span
                    className="block h-1 rounded-full"
                    style={{ width: `${Math.max(2, share)}%`, background: seriesColor(i) }}
                  />
                </span>
              </span>
              <span className="text-right">
                <span
                  className="block text-[12.5px] font-semibold tabular-nums text-fg"
                  title={exact(row.amount, row.currency || currency)}
                >
                  {compact(row.amount, row.currency || currency)}
                </span>
                <span className="block text-[10.5px] tabular-nums text-subtle">
                  {percent(share)}
                </span>
              </span>
              <ChevronRight
                size={14}
                className="shrink-0 text-subtle opacity-0 transition-opacity group-hover:opacity-100"
                aria-hidden
              />
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** Forecast panel. Refuses to project without enough history, and always
 *  labels the method and its confidence. */
export function ForecastPanel({ forecast, history, coverage, onBackfill, onWhy }) {
  const byCurrency = forecast?.by_currency || {};
  const currencies = Object.keys(byCurrency);

  if (!currencies.length) {
    return (
      <InsufficientHistory
        available={coverage?.days_covered ?? 0}
        required={14}
        reason="No stored billing history for this scope yet."
        onBackfill={onBackfill}
      />
    );
  }

  return (
    <div className="space-y-5">
      {currencies.map((code) => {
        const fc = byCurrency[code];
        if (!fc.available) {
          return (
            <div key={code}>
              <PanelHeading title={`${code} forecast`} />
              <InsufficientHistory
                available={fc.days_available}
                required={fc.days_required}
                reason={fc.reason}
                onBackfill={onBackfill}
              />
            </div>
          );
        }
        const month = fc.current_month;
        return (
          <div key={code} className="space-y-3">
            <PanelHeading
              title={`${code} forecast`}
              description={fc.basis}
              right={(
                <Badge tone={fc.confidence === 'high' ? 'success'
                  : fc.confidence === 'low' ? 'danger' : 'warning'}>
                  {fc.confidence} confidence
                </Badge>
              )}
            />

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {[
                ['Month to date', month.month_to_date_actual, 'Measured'],
                ['Projected remainder', month.projected_remainder, 'Run-rate'],
                ['Projected month total', month.projected_total, 'Run-rate'],
                ['Daily average', fc.daily_average, `${fc.observed_days} days`],
              ].map(([label, value, note]) => (
                <div key={label} className="rounded-card border border-border bg-surface p-3">
                  <p className="text-[10.5px] font-bold uppercase tracking-wider text-muted">
                    {label}
                  </p>
                  <Amount value={value} currency={code} size="lg" className="mt-1 block" />
                  <p className="mt-0.5 text-[10.5px] text-subtle">{note}</p>
                </div>
              ))}
            </div>

            <CostForecastChart
              series={(history || []).filter((p) => p.currency === code)}
              forecast={fc}
              currency={code}
              onWhy={onWhy}
            />

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {Object.entries(fc.horizons).map(([key, value]) => (
                <div key={key} className="rounded-control border border-border bg-sunken p-2.5">
                  <p className="text-[11px] text-muted">
                    {key.replace('next_', 'Next ').replace('_days', ' days')}
                  </p>
                  <p className="text-[14px] font-semibold tabular-nums text-fg"
                     title={exact(value, code)}>
                    {compact(value, code)}
                  </p>
                </div>
              ))}
            </div>

            <p className="rounded-control border border-border bg-sunken p-2.5 text-[11px] leading-relaxed text-muted">
              <Info size={11} className="mr-1 inline align-[-1px]" aria-hidden />
              This is a <strong className="text-fg">run-rate projection</strong>: the
              mean of {fc.observed_days} observed days extended forward. It is
              arithmetic, not a trained model, and it assumes spend continues at
              the current rate.
            </p>
          </div>
        );
      })}
    </div>
  );
}

/** Anomaly list. Each entry states the baseline it was measured against, so a
 *  finding can be checked rather than merely believed. */
export function AnomalyList({ anomalies, coverage, onBackfill }) {
  const byCurrency = anomalies?.by_currency || {};
  const currencies = Object.keys(byCurrency);

  if (!currencies.length) {
    return (
      <InsufficientHistory
        available={coverage?.days_covered ?? 0}
        required={30}
        reason="No stored billing history for this scope yet."
        onBackfill={onBackfill}
      />
    );
  }

  const SEVERITY_TONE = {
    CRITICAL: 'danger', HIGH: 'danger', MEDIUM: 'warning', INFO: 'info',
  };

  return (
    <div className="space-y-4">
      {currencies.map((code) => {
        const bucket = byCurrency[code];
        if (!bucket.available) {
          return (
            <InsufficientHistory
              key={code}
              available={bucket.days_available}
              required={bucket.days_required}
              reason={bucket.reason}
              onBackfill={onBackfill}
            />
          );
        }
        if (!bucket.anomalies.length) {
          return (
            <div key={code} className="rounded-control border border-border bg-sunken p-4 text-center">
              <p className="text-[13px] font-medium text-fg">
                No anomalies detected in {code}
              </p>
              <p className="mt-1 text-[11.5px] text-muted">
                {bucket.days_analyzed} days analysed against a trailing baseline.
                A day must exceed both the percentage and the absolute threshold
                to be flagged.
              </p>
            </div>
          );
        }
        return (
          <div key={code} className="space-y-2">
            <PanelHeading
              title={`${code} — ${bucket.count} anomal${bucket.count === 1 ? 'y' : 'ies'}`}
              description={`${bucket.days_analyzed} days analysed`}
            />
            {bucket.anomalies.map((a) => (
              <div
                key={a.date}
                className={cn(
                  'rounded-card border border-border bg-surface p-3 border-l-4',
                  a.severity === 'CRITICAL' || a.severity === 'HIGH' ? 'border-l-danger'
                    : a.severity === 'MEDIUM' ? 'border-l-warning' : 'border-l-info',
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="flex items-center gap-2 text-[13px] font-semibold text-fg">
                      <AlertTriangle size={13} className="text-warning-fg" aria-hidden />
                      {formatDate(a.date)}
                      <Badge tone={SEVERITY_TONE[a.severity]} size="xs">{a.severity}</Badge>
                    </p>
                    <p className="mt-1 text-[11.5px] leading-relaxed text-muted">
                      {a.basis}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[15px] font-bold tabular-nums text-fg"
                       title={exact(a.actual, code)}>
                      {compact(a.actual, code)}
                    </p>
                    <p className="text-[11px] tabular-nums text-muted">
                      baseline {compact(a.baseline, code)}
                    </p>
                    <Badge tone="danger" size="xs" className="mt-1">
                      <ArrowUpRight size={10} aria-hidden />
                      +{a.percent_increase.toFixed(1)}%
                    </Badge>
                  </div>
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** Change analysis + waterfall. The heading deliberately says "associated". */
export function ChangeAnalysisPanel({ change, period, comparisonPeriod, onWhy }) {
  const byCurrency = change?.by_currency || {};
  const currencies = Object.keys(byCurrency);

  if (!currencies.length) {
    return (
      <p className="rounded-control border border-dashed border-border bg-sunken p-4 text-center text-[12px] text-muted">
        No comparable spend in the two periods, so there is nothing to compare.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {currencies.map((code) => {
        const bucket = byCurrency[code];
        return (
          <div key={code} className="space-y-3">
            <PanelHeading
              title={`${code} — associated cost changes`}
              description={`${comparisonPeriod?.start} → ${comparisonPeriod?.end} compared with ${period?.start} → ${period?.end}`}
              right={(
                <div className="text-right">
                  <p className="text-[16px] font-bold tabular-nums text-fg">
                    {bucket.net_change > 0 ? '+' : ''}{compact(bucket.net_change, code)}
                  </p>
                  <p className="text-[10.5px] text-subtle">net change</p>
                </div>
              )}
            />

            <CostWaterfall
              movements={bucket.movements}
              currency={code}
              before={bucket.total_before}
              after={bucket.total_after}
              onWhy={onWhy}
            />

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {[['Increases', bucket.increases, ArrowUpRight, 'danger'],
                ['Decreases', bucket.decreases, ArrowDownRight, 'success']].map(
                ([label, rows, Icon, tone]) => (
                  <div key={label} className="rounded-card border border-border bg-surface p-3">
                    <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted">
                      {label}
                    </p>
                    {rows?.length ? (
                      <ul className="space-y-1">
                        {rows.map((m) => (
                          <li key={m.service || m.name} className="flex items-center gap-2 text-[12px]">
                            <Icon size={12} className={tone === 'danger' ? 'text-danger-fg' : 'text-success-fg'} aria-hidden />
                            <span className="min-w-0 flex-1 truncate text-fg">
                              {m.service || m.region || m.name}
                            </span>
                            {m.kind === 'new' && <Badge tone="warning" size="xs">New</Badge>}
                            <span className="font-semibold tabular-nums text-fg"
                                  title={exact(m.delta, code)}>
                              {m.delta > 0 ? '+' : ''}{compact(m.delta, code)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-[11.5px] text-muted">None in this period.</p>
                    )}
                  </div>
                ),
              )}
            </div>
          </div>
        );
      })}

      <p className="rounded-control border border-border bg-sunken p-2.5 text-[11px] leading-relaxed text-muted">
        <Info size={11} className="mr-1 inline align-[-1px]" aria-hidden />
        {change?.interpretation}
      </p>
    </div>
  );
}

/** Budget utilisation. Thresholds are drawn on the bar so a breach is visible
 *  rather than inferred from a percentage. */
export function BudgetPanel({ budgets, onCreate, canManage }) {
  const rows = budgets?.budgets || [];

  if (!rows.length) {
    return (
      <div className="rounded-control border border-dashed border-border bg-sunken p-6 text-center">
        <Target size={20} className="mx-auto mb-2 text-subtle" aria-hidden />
        <p className="text-[13px] font-medium text-fg">No budgets yet</p>
        <p className="mx-auto mt-1 max-w-md text-[11.5px] text-muted">
          A budget compares spend in one currency against a target over a
          period, and alerts as it crosses the thresholds you set.
        </p>
        {canManage && onCreate && (
          <Button variant="primary" className="mt-3" onClick={onCreate}>
            Create a budget
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map((entry) => {
        const b = entry.budget || entry;
        const used = entry.utilization_percent;
        const spend = entry.spend;
        const tone = isMissing(used) ? 'neutral'
          : used >= 100 ? 'danger' : used >= 90 ? 'warning' : 'success';

        return (
          <div key={b.id} className="rounded-card border border-border bg-surface p-3.5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[13.5px] font-semibold text-fg">{b.name}</p>
                <p className="mt-0.5 text-[11px] text-muted">
                  {b.period?.toLowerCase()} · {compact(b.amount, b.currency)} {b.currency}
                  {b.provider && ` · ${b.provider}`}
                  {b.service && ` · ${b.service}`}
                </p>
              </div>
              <div className="text-right">
                <Badge tone={tone}>
                  {isMissing(used) ? 'No data' : `${used.toFixed(1)}% used`}
                </Badge>
                <p className="mt-1 text-[11px] tabular-nums text-muted">
                  {isMissing(spend?.amount)
                    ? 'NA'
                    : `${compact(spend.amount, b.currency)} of ${compact(b.amount, b.currency)}`}
                </p>
              </div>
            </div>

            {/* threshold ticks sit on the track, so "90%" is a place, not a number */}
            <div className="relative mt-3 h-2 w-full rounded-full bg-[var(--chart-track)]">
              {!isMissing(used) && (
                <div
                  className={cn(
                    'h-2 rounded-full',
                    used >= 100 ? 'bg-danger' : used >= 90 ? 'bg-warning' : 'bg-success',
                  )}
                  style={{ width: `${Math.min(100, used)}%` }}
                />
              )}
              {(b.thresholds || []).map((t) => (
                <span
                  key={t}
                  className="absolute top-[-3px] h-[14px] w-px bg-[var(--fg-subtle)]"
                  style={{ left: `${Math.min(100, t)}%` }}
                  title={`${t}% threshold`}
                  aria-hidden
                />
              ))}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[10.5px] text-subtle">
              {(b.thresholds || []).map((t) => <span key={t}>{t}%</span>)}
              {entry.period && (
                <span className="ml-auto">
                  {entry.period.days_elapsed}/{entry.period.days_total} days elapsed
                </span>
              )}
            </div>

            {spend?.out_of_scope_currencies
              && Object.keys(spend.out_of_scope_currencies).length > 0 && (
              <p className="mt-2 rounded-control border border-warning/30 bg-warning-soft px-2.5 py-1.5 text-[11px] text-warning-fg">
                Spend in other currencies exists in this scope and is not counted
                against this budget:{' '}
                {Object.entries(spend.out_of_scope_currencies)
                  .map(([c, v]) => `${compact(v, c)} ${c}`).join(', ')}.
              </p>
            )}

            {entry.forecast?.projected_percent != null && (
              <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted">
                <TrendingUp size={11} aria-hidden />
                Run-rate projection for the full period:{' '}
                <strong className="text-fg">
                  {compact(entry.forecast.projected_period_total, b.currency)}
                </strong>
                ({entry.forecast.projected_percent.toFixed(0)}% of budget)
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
