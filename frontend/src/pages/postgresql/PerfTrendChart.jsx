import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import { AlertCircle } from 'lucide-react';
import cn from '@/lib/cn';
import client from '@/api/client';

const RANGES = [
  { id: '1m', label: '1m' }, { id: '5m', label: '5m' }, { id: '15m', label: '15m' },
  { id: '1h', label: '1h' }, { id: '6h', label: '6h' }, { id: '24h', label: '24h' },
];

// The collector samples once every 60s (see postgres_perf_collector.py), so
// polling faster than that just re-fetches the same rows — these intervals
// are paced to the range being viewed rather than a single fixed cadence.
const REFETCH_MS = { '1m': 15000, '5m': 15000, '15m': 20000, '1h': 30000, '6h': 60000, '24h': 120000 };

function fmtRate(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(v / 1000).toFixed(2)}K`;
  if (abs >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

/**
 * One live time-series chart on the Performance page — Transaction Activity,
 * I/O Performance, Cache Performance, or Row Activity. Deliberately one
 * chart per closely-related metric GROUP, never a mixed-unit chart (see the
 * removed "I/O & Transaction Performance" bar chart this replaces, which put
 * blocks, tuples and everything else on one shared axis).
 *
 * `series`: [{ key, label, color }] — `key` must match a `<key>_per_sec` (or
 * `cache_hit_pct`) field the /performance/history endpoint already computes
 * server-side; this component never does its own rate math.
 */
export default function PerfTrendChart({ connId, title, description, series, unit = '', defaultRange = '1h', refetchMsOverride, compact = false }) {
  const [range, setRange] = useState(defaultRange);

  const { data, isLoading, isError, dataUpdatedAt } = useQuery({
    queryKey: ['pgPerfHistory', connId, range],
    queryFn: () => client.get(`/connections/postgresql/${connId}/performance/history`, { params: { range } }).then((r) => r.data),
    enabled: !!connId,
    // A process detail page's own "Auto refresh: 5s/10s/30s/1min" control
    // overrides the range-paced default below it — the collector still only
    // produces a new row once a minute, so a shorter interval just re-checks
    // more eagerly for that next row rather than fabricating faster data.
    refetchInterval: refetchMsOverride || REFETCH_MS[range] || 30000,
    placeholderData: keepPreviousData,
  });

  const points = data?.points || [];
  const showSeconds = range === '1m' || range === '5m';
  const chartData = points.map((p) => ({
    ...p,
    t: new Date(p.t).toLocaleTimeString([], showSeconds
      ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
      : { hour: '2-digit', minute: '2-digit' }),
  }));

  const latest = points[points.length - 1];
  const currentValue = latest ? series.reduce((sum, s) => sum + (latest[s.key] ?? 0), 0) : null;

  let minVal = null;
  let maxVal = null;
  for (const p of points) {
    for (const s of series) {
      const v = p[s.key];
      if (v === null || v === undefined) continue;
      if (minVal === null || v < minVal) minVal = v;
      if (maxVal === null || v > maxVal) maxVal = v;
    }
  }

  const refreshMs = REFETCH_MS[range] || 30000;
  const staleMs = dataUpdatedAt ? Date.now() - dataUpdatedAt : null;
  const isStale = staleMs !== null && staleMs > refreshMs * 3;

  return (
    <div className="card flex flex-col gap-2 p-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-[14px] font-bold text-fg">
            <span className="truncate-safe">{title}</span>
            {!isStale && !isError && (
              <span className="flex shrink-0 items-center gap-1 text-[10px] font-bold tracking-wide text-success-fg">
                <span className="h-1.5 w-1.5 rounded-full bg-success-fg" style={{ animation: 'pulse 2s ease-in-out infinite' }} />
                LIVE
              </span>
            )}
          </h3>
          {description && <p className="mt-0.5 text-[11.5px] text-subtle">{description}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          {/* Explicit color key, in the header — matches the reference
              "CPU & Memory" / "Disk" trend cards elsewhere in the app. A
              dot+label pair here is the one place the color→name mapping is
              always unambiguous, regardless of where the lines themselves
              cross on the chart. */}
          {series.length > 1 && (
            <div className="flex flex-wrap items-center gap-2.5">
              {series.map((s) => (
                <span key={s.key} className="inline-flex items-center gap-1.5 text-[11.5px] text-subtle">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
                  {s.label}
                </span>
              ))}
            </div>
          )}
          <div className="flex shrink-0 items-center gap-0.5 rounded-control bg-sunken p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setRange(r.id)}
                className={cn(
                  'rounded px-2 py-1 text-[11px] font-semibold transition-colors',
                  range === r.id ? 'bg-inverse text-on-inverse' : 'text-muted hover:text-fg',
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {currentValue !== null && !isError && (
        <div className="flex items-baseline gap-3">
          <span className="text-[22px] leading-none font-black text-fg tabular-nums">
            {fmtRate(currentValue)}{unit}
          </span>
          {minVal !== null && maxVal !== null && (
            <span className="text-[11px] text-subtle">
              min {fmtRate(minVal)}{unit} · max {fmtRate(maxVal)}{unit}
            </span>
          )}
        </div>
      )}

      {isLoading ? (
        <div className={cn('animate-pulse rounded-control bg-sunken', compact ? 'h-[150px]' : 'h-[200px]')} />
      ) : isError ? (
        <div className={cn('flex flex-col items-center justify-center gap-2 text-center', compact ? 'h-[150px]' : 'h-[200px]')}>
          <AlertCircle size={22} className="text-danger-fg" />
          <p className="text-[12px] font-semibold text-fg">Unable to collect PostgreSQL metrics</p>
          <p className="text-[11px] text-subtle">Check the connection, then try again.</p>
        </div>
      ) : points.length === 0 ? (
        <div className={cn('flex flex-col items-center justify-center gap-1 text-center', compact ? 'h-[150px]' : 'h-[200px]')}>
          <p className="text-[12px] font-semibold text-fg">No monitoring data available</p>
          <p className="text-[11px] text-subtle">Collecting — the first data point appears within about a minute.</p>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={compact ? 150 : 200}>
          <LineChart data={chartData} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.15} vertical={false} />
            <XAxis dataKey="t" tick={{ fontSize: 10 }} tickLine={false} axisLine={{ stroke: '#cbd5e1' }} />
            <YAxis domain={[0, 'auto']} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={36} />
            <Tooltip />
            {series.map((s) => (
              <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} dot={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}

      {isStale && points.length > 0 && (
        <p className="text-[11px] font-semibold text-warning-fg">
          Data delayed — last update {Math.round(staleMs / 1000)}s ago
        </p>
      )}
    </div>
  );
}
