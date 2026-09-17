import { useMemo, useState } from 'react';
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import cn from '@/lib/cn';
import { axisTick, compact, exact } from '../../utils/costFormat';
import { Panel, PanelEmpty, ViewLink } from './OverviewPrimitives';

/**
 * Billed spend over time.
 *
 * Two rules govern this chart.
 *
 * A day the provider did not report is a GAP, not a zero. Recharts draws a
 * continuous line through nulls only if told to; `connectNulls` is off, so a
 * missing day breaks the line instead of drawing a plunge to zero that never
 * happened.
 *
 * The period comparison is only rendered when both periods are real and of
 * equal length. Comparing 30 days of data against 11 days of history produces
 * a number that looks like a trend and is an artefact of when collection
 * started.
 */

const RANGES = [
  { id: 7, label: '7D' },
  { id: 30, label: '30D' },
  { id: 90, label: '90D' },
];

function ChartTooltip({ active, payload, label, currency, source }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="rounded-control border border-border bg-surface px-3 py-2 text-[12px] shadow-lg">
      <div className="font-semibold text-fg">{label}</div>
      <div className="mt-1 text-muted">
        {point.amount === null || point.amount === undefined ? (
          <span className="text-subtle">No data reported for this day</span>
        ) : (
          <>
            <div className="font-semibold text-fg">{exact(point.amount, currency)}</div>
            {point.records ? <div className="text-subtle">{`${point.records} billing records`}</div> : null}
          </>
        )}
      </div>
      {source && <div className="mt-1 border-t border-border pt-1 text-[10px] text-subtle">{`Source: ${source}`}</div>}
    </div>
  );
}

export default function CostTrendPanel({
  data, isLoading, error, days, onDaysChange, onOpenCost, total,
}) {
  const [hoverRange] = useState(null);

  const series = data?.series || [];
  const currency = series.find((p) => p.currency)?.currency || total?.currency || null;

  const points = useMemo(() => series.map((p) => ({
    date: p.date,
    // A missing amount stays null so the line breaks. Coercing to 0 would draw
    // a cliff on a day nobody billed anything to us.
    amount: p.amount === null || p.amount === undefined ? null : Number(p.amount),
    records: p.records,
    label: new Date(p.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
  })), [series]);

  const reported = points.filter((p) => p.amount !== null);

  // Only compare like with like: two halves of the same series, both fully
  // reported. Anything else is arithmetic on a coincidence.
  const comparison = useMemo(() => {
    if (reported.length < 4) return null;
    const half = Math.floor(points.length / 2);
    const older = points.slice(0, half);
    const newer = points.slice(half);
    if (older.some((p) => p.amount === null) || newer.some((p) => p.amount === null)) return null;
    if (older.length !== newer.length) return null;
    const sum = (rows) => rows.reduce((acc, p) => acc + p.amount, 0);
    const previous = sum(older);
    const current = sum(newer);
    if (previous <= 0) return null;
    return {
      current, previous, changePct: ((current - previous) / previous) * 100, span: newer.length,
    };
  }, [points, reported.length]);

  const peak = reported.length
    ? reported.reduce((a, b) => (b.amount > a.amount ? b : a))
    : null;

  return (
    <Panel
      title="Billed Spend"
      icon="report"
      subtitle={
        data?.period
          ? `${data.period.start || ''} → ${data.period.end || ''}`.trim()
          : `Last ${days} days`
      }
      source={data?.source || 'Provider billing API'}
      action={<ViewLink onClick={onOpenCost}>Cost</ViewLink>}
      loading={isLoading}
      error={error}
    >
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-2xl font-bold tabular-nums text-fg">
            {total?.total_monthly_cost === null || total?.total_monthly_cost === undefined
              ? <span className="text-subtle">NA</span>
              : exact(total.total_monthly_cost, total.currency)}
          </div>
          <div className="text-[11px] text-muted">
            {total?.note || 'Billed spend'}
          </div>
          {comparison && (
            <div className="mt-1 flex items-center gap-1.5 text-[11px]">
              <span className={cn(
                'font-semibold',
                comparison.changePct > 0 ? 'text-danger' : 'text-success-fg',
              )}
              >
                {`${comparison.changePct > 0 ? '+' : ''}${comparison.changePct.toFixed(1)}%`}
              </span>
              <span className="text-muted">
                {`vs previous ${comparison.span} days`}
              </span>
            </div>
          )}
        </div>

        <div className="flex gap-1" role="group" aria-label="Time range">
          {RANGES.map((range) => (
            <button
              key={range.id}
              type="button"
              onClick={() => onDaysChange(range.id)}
              aria-pressed={days === range.id}
              className={cn(
                'rounded-control px-2 py-1 text-[11px] font-semibold transition-colors',
                days === range.id
                  ? 'bg-accent text-accent-fg'
                  : 'border border-border text-muted hover:bg-sunken hover:text-fg',
              )}
            >
              {range.label}
            </button>
          ))}
        </div>
      </div>

      {points.length === 0 ? (
        <PanelEmpty>
          No daily billing history is available for this account. The provider
          billing API returned no per-day records for this period.
        </PanelEmpty>
      ) : (
        <>
          <div className="h-[190px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={points} margin={{ top: 5, right: 8, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="costFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: 'var(--chart-grid)' }}
                  minTickGap={24}
                />
                <YAxis
                  tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => axisTick(v, currency)}
                  width={58}
                />
                <Tooltip content={<ChartTooltip currency={currency} source={data?.source} />} />
                <Area
                  type="monotone"
                  dataKey="amount"
                  stroke="var(--chart-1)"
                  strokeWidth={2}
                  fill="url(#costFill)"
                  // Off on purpose: a day with no reported spend must leave a
                  // hole, not an invented straight line across it.
                  connectNulls={false}
                  dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-2 text-[11px] text-muted">
            {peak && (
              <span>
                {'Highest day '}
                <span className="font-semibold text-fg">{peak.label}</span>
                {` · ${compact(peak.amount, currency)}`}
              </span>
            )}
            <span>{`${reported.length} of ${points.length} days reported`}</span>
            {data?.coverage?.percent != null && (
              <span>{`Coverage ${data.coverage.percent}%`}</span>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}
