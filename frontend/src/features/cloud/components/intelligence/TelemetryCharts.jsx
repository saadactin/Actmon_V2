import { useMemo } from 'react';
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import Badge from '@/components/ui/Badge';
import {
  chartSeries, formatAxisTick, formatMetric, orderTelemetry,
} from '../../utils/intelligenceModel';

const AVG = 'var(--chart-1)';
const PEAK = 'var(--chart-2)';
const GRID = 'var(--chart-grid)';
const AXIS = 'var(--chart-axis)';

const dayLabel = (t) => new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

/**
 * The evidence charts: one small chart per metric, never two measures on one
 * axis. Each shows what the provider returned — the hourly average, and the
 * per-hour maximum when the provider published one. A metric that could not
 * be collected is shown as N/A with the collector's own reason, so an absent
 * chart is never mistaken for a flat, idle line.
 */
export default function TelemetryCharts({ rows, only }) {
  const ordered = useMemo(() => {
    const list = orderTelemetry(rows);
    return only?.length ? list.filter((r) => only.includes(r.metric)) : list;
  }, [rows, only]);
  if (!ordered.length) {
    return (
      <p className="rounded-control border border-dashed border-border px-3 py-4 text-center text-[12px] text-muted">
        No telemetry is collected for this resource type. The checks that apply to it read its
        configuration and billing instead.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {ordered.map((row) => <MetricChart key={row.metric} row={row} />)}
    </div>
  );
}

function MetricChart({ row }) {
  const data = useMemo(() => chartSeries(row), [row]);
  const s = row.stats || {};
  const hasPeak = data.some((p) => p.peak !== undefined);
  const ok = row.status === 'OK' && data.length > 0;

  return (
    <figure className="min-w-0 rounded-control border border-border bg-surface p-2.5">
      <figcaption className="mb-1 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate-safe text-[12px] font-semibold text-fg">{row.label}</div>
          {ok && (
            <div className="text-meta text-muted">
              avg {formatMetric(s.avg, row.unit)} · P95 {formatMetric(s.p95, row.unit)}
              {' · '}peak {formatMetric(s.peak, row.unit)}
              {s.peak_source === 'highest_period_average' ? ' (highest hourly average)' : ''}
            </div>
          )}
        </div>
        {!ok && <Badge tone="neutral" size="xs">{row.status_label || row.status}</Badge>}
      </figcaption>

      {ok ? (
        <>
          <div className="h-32">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']}
                  tickFormatter={dayLabel} stroke={AXIS} tick={{ fontSize: 11 }} tickLine={false}
                  minTickGap={28}
                />
                <YAxis
                  stroke={AXIS} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={40}
                  domain={row.unit === 'percent' ? [0, 100] : ['auto', 'auto']}
                  tickFormatter={(v) => formatAxisTick(v, row.unit)}
                />
                <Tooltip
                  cursor={{ stroke: AXIS, strokeDasharray: '3 3' }}
                  content={<ChartTip unit={row.unit} />}
                />
                <Line type="monotone" dataKey="v" name="Hourly average" stroke={AVG} strokeWidth={2}
                  dot={false} isAnimationActive={false} />
                {hasPeak && (
                  <Line type="monotone" dataKey="peak" name="Hourly maximum" stroke={PEAK}
                    strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-micro text-muted">
            <Legend color={AVG} label="Hourly average" />
            {hasPeak && <Legend color={PEAK} label="Hourly maximum" dashed />}
            <span className="ml-auto" title={row.source || undefined}>
              {(s.samples || 0).toLocaleString()} datapoints · {s.coverage_pct ?? '—'}% of hours
            </span>
          </div>
        </>
      ) : (
        <p className="py-3 text-meta leading-relaxed text-muted">
          <span className="font-semibold text-fg">N/A. </span>
          {row.reason || 'No datapoints were returned.'}
        </p>
      )}
      {row.source && <p className="mt-1 truncate-safe text-micro text-subtle" title={row.source}>{row.source}</p>}
    </figure>
  );
}

function Legend({ color, label, dashed }) {
  return (
    <span className="inline-flex items-center gap-1">
      <svg width="16" height="6" aria-hidden="true">
        <line x1="0" y1="3" x2="16" y2="3" stroke={color} strokeWidth="2" strokeDasharray={dashed ? '4 3' : undefined} />
      </svg>
      {label}
    </span>
  );
}

function ChartTip({ active, payload, label, unit }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-control border border-border bg-raised px-2.5 py-1.5 text-meta shadow-md">
      <div className="font-semibold text-fg">{new Date(label).toLocaleString('en-GB')}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex justify-between gap-3 text-muted">
          <span>{p.name}</span>
          <span className="tabular-nums text-fg">{formatMetric(p.value, unit)}</span>
        </div>
      ))}
    </div>
  );
}
