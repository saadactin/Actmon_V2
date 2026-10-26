/**
 * Redo generation — log switches and redo volume per hour, per day.
 *
 * The heatmap is redo_hour.sql (switches per hour per day) and the volume is
 * redo2.sql (megabytes per hour), with the corrections described in
 * oracle_redo_service.py: v$log_history rather than gv$ (which doubles every
 * count on RAC), and volume from v$archived_log rather than switches x log
 * size (which counts a half-empty log as full).
 *
 * Every number on this view is a reading. A failed read shows as unreadable,
 * and an estimated volume says it is an estimate.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import client from '@/api/client';
import Badge from '@/components/ui/Badge';
import Notice from '@/components/ui/Notice';
import Select from '@/components/ui/Select';
import { InlineLoading } from '@/components/ui/Loading';
import { fmtMB } from '@/config/dbCatalog';
import { MetricTile, Panel } from '@/pages/_shared/enginePanels';
import { cn } from '@/lib/cn';

const DAY_OPTIONS = [
  { id: '7', label: 'Last 7 days' },
  { id: '14', label: 'Last 14 days' },
  { id: '30', label: 'Last 30 days' },
  { id: '90', label: 'Last 90 days' },
];

/** Cell colour by switch count against the per-hour target. Zero is blank,
 *  at-or-under target is cool, then warm, then hot. */
function cellTone(n, target, threads) {
  if (!n) return 'bg-sunken text-subtle';
  const perThread = n / Math.max(1, threads);
  if (perThread <= target * 0.5) return 'bg-accent-softer text-accent-text';
  if (perThread <= target) return 'bg-accent-soft text-accent-text';
  if (perThread <= target * 2) return 'bg-warning-soft text-warning-fg';
  return 'bg-danger-soft text-danger-fg font-black';
}

function Heatmap({ matrix, target, threads, metric }) {
  const fmtDay = (d) => {
    const dt = new Date(`${d}T00:00:00`);
    return dt.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-[3px] text-[11px]">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-surface px-2 text-left font-bold text-muted">Day</th>
            {Array.from({ length: 24 }, (_, h) => (
              <th key={h} className="min-w-[30px] text-center font-mono font-bold text-muted">
                {String(h).padStart(2, '0')}
              </th>
            ))}
            <th className="px-2 text-right font-bold text-muted">Total</th>
          </tr>
        </thead>
        <tbody>
          {[...matrix].reverse().map((d) => (
            <tr key={d.day}>
              <td className="sticky left-0 z-10 whitespace-nowrap bg-surface px-2 font-semibold text-fg">
                {fmtDay(d.day)}
              </td>
              {d.hours.map((n, h) => {
                const mb = d.mb_hours?.[h];
                const shown = metric === 'mb' ? (mb ? fmtMB(mb).replace(' ', '') : '') : (n || '');
                return (
                  <td
                    key={h}
                    title={`${d.day} ${String(h).padStart(2, '0')}:00 — ${n} switch${n === 1 ? '' : 'es'}${mb != null ? `, ${fmtMB(mb)}` : ''}`}
                    className={cn('h-7 rounded text-center font-mono tabular-nums', cellTone(n, target, threads))}
                  >
                    {shown}
                  </td>
                );
              })}
              <td className="whitespace-nowrap px-2 text-right font-mono font-bold text-fg">
                {metric === 'mb' ? (d.mb_total != null ? fmtMB(d.mb_total) : '—') : d.total}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The last 48 hours as bars — the shape of today against yesterday. */
function HourlyBars({ matrix, metric }) {
  const series = useMemo(() => {
    const out = [];
    matrix.slice(-2).forEach((d) => d.hours.forEach((n, h) => {
      out.push({ label: `${d.day.slice(5)} ${String(h).padStart(2, '0')}h`, n, mb: d.mb_hours?.[h] ?? null });
    }));
    return out;
  }, [matrix]);
  const val = (p) => (metric === 'mb' ? (p.mb || 0) : p.n);
  const max = Math.max(1, ...series.map(val));
  return (
    <div className="flex h-36 items-end gap-[2px]">
      {series.map((p) => (
        <div key={p.label} className="group relative flex h-full flex-1 items-end"
          title={`${p.label}: ${p.n} switches${p.mb != null ? `, ${fmtMB(p.mb)}` : ''}`}>
          <div className="w-full rounded-t bg-accent/80 transition-colors group-hover:bg-accent"
            style={{ height: `${(val(p) / max) * 100}%`, minHeight: val(p) ? 2 : 0 }} />
        </div>
      ))}
    </div>
  );
}

export default function RedoGeneration({ connId }) {
  const [days, setDays] = useState('14');
  const [metric, setMetric] = useState('switches');

  const q = useQuery({
    queryKey: ['oracleRedoGeneration', connId, days],
    queryFn: () => client.get(`/connections/oracle/${connId}/oracle-redo-generation`, { params: { days } })
      .then((r) => r.data),
    refetchInterval: 300000,
  });

  const d = q.data;
  const st = d?.stats || {};
  const threads = Math.max(1, (d?.threads || []).length);

  return (
    <Panel
      title="Redo generation"
      icon="trend"
      subtitle="Log switches and redo volume per hour — v$log_history and v$archived_log"
      actions={(
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-control border border-border p-0.5">
            {[{ id: 'switches', label: 'Switches' }, { id: 'mb', label: 'Volume' }].map((o) => (
              <button key={o.id} type="button" onClick={() => setMetric(o.id)}
                className={cn('rounded-control px-2.5 py-1 text-[11px] font-semibold',
                  metric === o.id ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-sunken')}>
                {o.label}
              </button>
            ))}
          </div>
          <Select size="sm" width="auto" value={days} onChange={setDays} options={DAY_OPTIONS} />
        </div>
      )}
    >
      {q.isLoading && <InlineLoading label="Reading log history…" />}
      {q.error && <Notice tone="danger" title="Redo history could not be read.">{String(q.error.message || q.error)}</Notice>}
      {d?.status === 'error' && <Notice tone="danger" title="Redo history could not be read.">{d.error}</Notice>}

      {d?.status === 'success' && (
        <div className="space-y-gutter-sm">
          <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-3 xl:grid-cols-6">
            <MetricTile label="Switches" value={st.total_switches?.toLocaleString() ?? '—'} icon="refresh"
              hint={`Log switches in the last ${d.days} days, all threads`} />
            <MetricTile label="Avg / day" value={st.avg_switches_per_day ?? '—'} icon="calendar" />
            <MetricTile label="Busiest hour" value={st.max_switches_per_hour || '—'} icon="zap"
              tone={st.thread_peak?.switches > st.switch_target_per_hour ? 'warn' : 'good'}
              hint={st.peak ? `${st.peak.day} ${String(st.peak.hour).padStart(2, '0')}:00` : undefined} />
            <MetricTile label="Redo volume" value={st.total_mb != null ? fmtMB(st.total_mb) : '—'} icon="database"
              hint={d.volume_source === 'estimated' ? 'Estimated — switches x log size' : 'Archived bytes, v$archived_log'} />
            <MetricTile label="Avg volume / day" value={st.avg_mb_per_day != null ? fmtMB(st.avg_mb_per_day) : '—'} icon="trend" />
            <MetricTile label="Log size"
              value={(d.log_sizes || []).length ? fmtMB(Math.max(...d.log_sizes.map((s) => s.max_mb || 0))) : '—'}
              icon="layers"
              hint={(d.log_sizes || []).map((s) => `thread ${s.thread}: ${s.groups} groups x ${fmtMB(s.max_mb)}`).join(' · ')} />
          </div>

          {(d.findings || []).map((f, i) => (
            <Notice key={i} tone={f.severity === 'critical' ? 'danger' : f.severity === 'warning' ? 'warning' : 'info'} title={f.title}>
              {f.detail}
            </Notice>
          ))}

          <div>
            <p className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-subtle">
              Last 48 hours
              {d.volume_source === 'estimated' && metric === 'mb' && <Badge tone="warning" size="xs">estimated</Badge>}
            </p>
            <HourlyBars matrix={d.matrix || []} metric={metric} />
          </div>

          <div>
            <p className="mb-1.5 flex flex-wrap items-center gap-3 text-[11px] font-bold uppercase tracking-wide text-subtle">
              {metric === 'mb' ? 'Redo volume' : 'Log switches'} per hour, per day
              <span className="flex items-center gap-1.5 font-normal normal-case tracking-normal">
                <span className="inline-block h-3 w-3 rounded bg-accent-softer" /> ≤ {Math.round(st.switch_target_per_hour / 2)}/h
                <span className="inline-block h-3 w-3 rounded bg-accent-soft" /> ≤ {st.switch_target_per_hour}/h
                <span className="inline-block h-3 w-3 rounded bg-warning-soft" /> ≤ {st.switch_target_per_hour * 2}/h
                <span className="inline-block h-3 w-3 rounded bg-danger-soft" /> more, per thread
              </span>
            </p>
            <Heatmap matrix={d.matrix || []} target={st.switch_target_per_hour || 4} threads={threads} metric={metric} />
          </div>

          {(d.errors || []).length > 0 && (
            <p className="text-[11px] text-subtle">Partial read: {d.errors.join(' · ')}</p>
          )}
        </div>
      )}
    </Panel>
  );
}
