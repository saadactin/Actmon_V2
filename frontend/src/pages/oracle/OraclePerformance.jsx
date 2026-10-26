/**
 * Oracle Dashboard → Performance.
 *
 * Trends come from ACTMON's own stored telemetry (ClickHouse
 * metrics_db_oracle) via /oracle-perf-history, with Oracle-only metrics
 * (PGA, reads, I/O, redo) merged in from GV$SYSMETRIC_HISTORY for the last
 * hour. "Top 5": the latest minute is live (/oracle-perf-top-now); an
 * earlier minute uses the agent's stored Top SQL / wait snapshots
 * (/oracle-perf-top-at). Sessions at a past minute are not stored (that
 * would need ASH, Diagnostics Pack), and the panel says so.
 *
 * Charts are small hand-written SVGs so this page can match its reference
 * without touching the shared chart components other screens use.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import client from '@/api/client';
import Icon from '@/components/ui/Icon';
import Notice from '@/components/ui/Notice';
import { fmtMB } from '@/config/dbCatalog';
import { oracleTabRoute } from '@/config/oracleDashboardNav';
import { cn } from '@/lib/cn';

const api = (id, path, params) => client.get(`/connections/oracle/${id}/${path}`, { params, timeout: 60000 }).then((r) => r.data);

/* ── formatting ───────────────────────────────────────────────────────── */

const fmtBytes = (b) => (b == null ? 'N/A' : fmtMB(b / 1048576));
const fmtRate = (b) => (b == null ? 'N/A' : `${fmtMB(b / 1048576)}/s`);
const fmtCount = (n, d = 0) => (n == null ? 'N/A' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d }));
const fmtShortCount = (n) => {
  if (n == null) return 'N/A';
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`;
  return fmtCount(n, a < 10 ? 2 : 0);
};
const fmtMs = (ms) => (ms == null ? 'N/A' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(2)} ms`);

/** Point time (DB-local, "YYYY-MM-DDTHH:MM") → Date, using the DB's offset. */
function toDate(t, dbTz) {
  if (!t) return null;
  const iso = t.length === 16 ? `${t}:00` : t;
  const d = new Date(dbTz ? `${iso}${dbTz}` : iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
function fmtTime(d, tz, withDate = false) {
  if (!d) return '—';
  const opts = { hour: 'numeric', minute: '2-digit', ...(withDate ? { month: 'short', day: 'numeric', year: 'numeric', second: '2-digit' } : {}) };
  if (tz === 'utc') opts.timeZone = 'UTC';
  return d.toLocaleString(undefined, opts);
}

/* ── width hook and charts ───────────────────────────────────────────── */

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(160, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceMax(v) {
  if (!v || v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/**
 * Line/area chart over the history points.
 * series: [{ key, color, label, fill? }]
 */
function TrendChart({
  points, series, height = 220, yMax, yFmt = (v) => fmtShortCount(v), yLabel,
  threshold, tz, dbTz, selected, onSelect, compact = false, emptyText = 'No data points in this range.',
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const pad = compact ? { l: 70, r: 12, t: 10, b: 24 } : { l: 64, r: 16, t: 14, b: 28 };
  const W = width; const H = height;
  const iw = W - pad.l - pad.r; const ih = H - pad.t - pad.b;
  const n = points.length;
  const vals = points.flatMap((p) => series.map((s) => p[s.key]).filter((v) => v != null));
  const max = yMax ?? niceMax(Math.max(threshold || 0, ...vals, 0) * 1.1);
  const x = (i) => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => pad.t + ih - (Math.min(v, max) / max) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((k) => k * max);
  const xTicks = n ? Array.from({ length: Math.min(n, compact ? 6 : 13) }, (_, k) => Math.round((k * (n - 1)) / Math.max(1, Math.min(n, compact ? 6 : 13) - 1))) : [];

  // Samples arrive once per collector cycle, which is wider than a bucket,
  // so a bucket without a sample is a gap between readings, not a zero: the
  // line runs straight across it.
  const pathFor = (key) => {
    let d = ''; let open = false;
    points.forEach((p, i) => {
      const v = p[key];
      if (v == null) return;
      d += `${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      open = true;
    });
    return d;
  };
  const areaFor = (key) => {
    const idx = points.map((p, i) => (p[key] == null ? null : i)).filter((i) => i != null);
    if (idx.length < 2) return '';
    return `${pathFor(key)}L${x(idx[idx.length - 1]).toFixed(1)},${(pad.t + ih).toFixed(1)}L${x(idx[0]).toFixed(1)},${(pad.t + ih).toFixed(1)}Z`;
  };
  const pick = (evt) => {
    if (!n) return null;
    const r = evt.currentTarget.getBoundingClientRect();
    const i = Math.round(((evt.clientX - r.left - pad.l) / iw) * (n - 1));
    return Math.max(0, Math.min(n - 1, i));
  };
  const selIdx = selected ? points.findIndex((p) => p.t === selected) : -1;
  const tipIdx = hover ?? (selIdx >= 0 ? selIdx : null);
  const gid = useMemo(() => `g${Math.random().toString(36).slice(2, 8)}`, []);

  return (
    <div ref={ref} className="relative w-full">
      {n === 0 || !points.some((p) => series.some((sr) => p[sr.key] != null)) ? (
        <div className="grid place-items-center px-6 text-center text-[13px] text-muted" style={{ height }}>{emptyText}</div>
      ) : (
        <svg width={W} height={H} className="block select-none"
          onMouseMove={(e) => setHover(pick(e))} onMouseLeave={() => setHover(null)}
          onClick={(e) => { const i = pick(e); if (i != null) onSelect?.(points[i].t); }}
          style={{ cursor: onSelect ? 'crosshair' : 'default' }}>
          <defs>
            {series.map((s) => (
              <linearGradient key={s.key} id={`${gid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity="0.28" />
                <stop offset="100%" stopColor={s.color} stopOpacity="0.02" />
              </linearGradient>
            ))}
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeDasharray={t ? '3 3' : undefined} />
              <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{yFmt(t)}</text>
            </g>
          ))}
          {xTicks.map((i) => (
            <text key={i} x={x(i)} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--muted)">
              {fmtTime(toDate(points[i].t, dbTz), tz)}
            </text>
          ))}
          {yLabel && !compact && (
            <text transform={`translate(13,${pad.t + ih / 2}) rotate(-90)`} textAnchor="middle" fontSize="11" fill="var(--muted)">{yLabel}</text>
          )}
          {threshold != null && (
            <line x1={pad.l} x2={W - pad.r} y1={y(threshold)} y2={y(threshold)} stroke="#ef4444" strokeDasharray="5 4" strokeWidth="1.2" />
          )}
          {series.map((s) => s.fill !== false && <path key={`a${s.key}`} d={areaFor(s.key)} fill={`url(#${gid}-${s.key})`} />)}
          {series.map((s) => <path key={`l${s.key}`} d={pathFor(s.key)} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" />)}
          {/* Few samples (just after deploy, or a sparse range): mark each one,
              so a single stored reading is visible rather than a zero-length line. */}
          {series.map((s) => {
            const idx = points.map((p, i) => (p[s.key] == null ? null : i)).filter((i) => i != null);
            return idx.length > 0 && idx.length <= 40 && idx.map((i) => (
              <circle key={`d${s.key}${i}`} cx={x(i)} cy={y(points[i][s.key])} r={compact ? 2.5 : 3} fill={s.color} />
            ));
          })}
          {selIdx >= 0 && <line x1={x(selIdx)} x2={x(selIdx)} y1={pad.t} y2={pad.t + ih} stroke="#1e3a8a" strokeDasharray="4 3" />}
          {tipIdx != null && series.map((s) => points[tipIdx][s.key] != null && (
            <circle key={`c${s.key}`} cx={x(tipIdx)} cy={y(points[tipIdx][s.key])} r="4.5" fill="#fff" stroke={s.color} strokeWidth="2.5" />
          ))}
        </svg>
      )}
      {tipIdx != null && n > 0 && (
        <div className="pointer-events-none absolute z-10 rounded-lg border border-border bg-surface px-3 py-2 text-[12px] shadow-lg"
          style={{ left: Math.min(Math.max(x(tipIdx) - 70, 4), W - 190), top: 4 }}>
          <p className="font-medium text-fg">{fmtTime(toDate(points[tipIdx].t, dbTz), tz, true)}</p>
          {series.map((s) => (
            <p key={s.key} className="mt-0.5 flex items-center gap-1.5 text-muted">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
              {s.label} <b className="text-fg">{points[tipIdx][s.key] == null ? 'N/A' : yFmt(points[tipIdx][s.key], true)}</b>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function Sparkline({ points, k, color }) {
  const vals = points.map((p) => p[k]).filter((v) => v != null);
  if (vals.length < 2) return <span className="text-[11px] text-subtle">no trend</span>;
  const W = 96; const H = 44;
  const max = Math.max(...vals); const min = Math.min(...vals);
  const span = max - min || 1;
  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${((i / (vals.length - 1)) * W).toFixed(1)},${(H - 4 - ((v - min) / span) * (H - 8)).toFixed(1)}`).join('');
  return (
    <svg width={W} height={H} className="shrink-0">
      <path d={`${d}L${W},${H}L0,${H}Z`} fill={color} opacity="0.12" />
      <path d={d} fill="none" stroke={color} strokeWidth="1.8" />
    </svg>
  );
}

/* ── pieces ───────────────────────────────────────────────────────────── */

function Card({ className, children }) {
  return <section className={cn('rounded-2xl border border-border bg-surface shadow-sm', className)}>{children}</section>;
}

function PillTabs({ value, onChange, options, size = 'md' }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button key={o.id} type="button" onClick={() => onChange(o.id)}
          className={cn('rounded-lg border font-medium transition-colors',
            size === 'sm' ? 'px-3.5 py-1.5 text-[12px]' : 'px-4 py-2 text-[13px]',
            value === o.id ? 'border-accent bg-accent text-accent-fg' : 'border-border bg-sunken/60 text-fg hover:bg-sunken')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Legend({ items }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-5 text-[12px] text-fg">
      {items.map((s) => (
        <span key={s.label} className="flex items-center gap-1.5">
          <span className={cn('inline-block', s.dashed ? 'h-0 w-5 border-t-2 border-dashed' : 'h-2.5 w-2.5 rounded-full')}
            style={s.dashed ? { borderColor: s.color } : { background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

function KpiCard({ icon, iconCls, label, value, trend, points, k, color }) {
  return (
    <Card className="px-5 py-4">
      <div className="flex items-center gap-3">
        <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-full', iconCls)}><Icon name={icon} size={20} /></span>
        <p className="min-w-0 text-[13px] leading-tight text-muted">{label}</p>
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <div className="min-w-0">
          <p className="whitespace-nowrap text-[24px] font-bold leading-tight text-fg">{value}</p>
          {trend}
        </div>
        <Sparkline points={points} k={k} color={color} />
      </div>
    </Card>
  );
}

/** Latest vs the window's average — said as such. Up is bad for load. */
function Trend({ points, k }) {
  const vals = points.map((p) => p[k]).filter((v) => v != null);
  if (vals.length < 3) return null;
  const last = vals[vals.length - 1];
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (!avg) return null;
  const pct = Math.round(((last - avg) / avg) * 100);
  const up = pct > 0;
  return (
    <p className={cn('text-[12px] font-semibold', up ? 'text-danger-fg' : 'text-success-fg')} title="Latest minute against the average of the selected range">
      {up ? '↑' : '↓'} {Math.abs(pct)}% <span className="font-normal text-subtle">vs avg</span>
    </p>
  );
}

/* ── the screen ───────────────────────────────────────────────────────── */

const MAIN_TABS = [
  { id: 'cpu', label: 'CPU', title: 'CPU Usage', icon: 'cpu', series: [{ key: 'cpu_pct', color: '#3b82f6', label: 'CPU Usage' }], yFmt: (v) => `${Math.round(v)}${''}`, tip: (v) => `${v.toFixed(1)}%`, yMax: 100, yLabel: 'CPU Usage %', threshold: 80 },
  { id: 'aas', label: 'Active Sessions', title: 'Active Sessions', icon: 'users', series: [{ key: 'active_sessions', color: '#3b82f6', label: 'Active sessions (stored)' }, { key: 'aas', color: '#8b5cf6', label: 'Average active sessions (Oracle)', fill: false }], yLabel: 'Sessions' },
  { id: 'mem', label: 'Memory (PGA/SGA)', title: 'Memory (PGA / SGA)', icon: 'memory', series: [{ key: 'sga_bytes', color: '#3b82f6', label: 'SGA' }, { key: 'pga_alloc_bytes', color: '#22c55e', label: 'PGA allocated' }, { key: 'pga_used_bytes', color: '#8b5cf6', label: 'PGA in use' }], bytes: true, yLabel: 'Bytes' },
  { id: 'io', label: 'I/O', title: 'I/O Requests', icon: 'database', series: [{ key: 'read_iops', color: '#f97316', label: 'Read requests/s' }, { key: 'write_iops', color: '#eab308', label: 'Write requests/s' }], yLabel: 'Requests / s' },
  { id: 'lr', label: 'Logical Reads', title: 'Logical Reads', icon: 'layers', series: [{ key: 'logical_bytes_s', color: '#3b82f6', label: 'Logical reads' }], rate: true, yLabel: 'Bytes / s' },
  { id: 'pr', label: 'Physical Reads', title: 'Physical Reads', icon: 'database', series: [{ key: 'physical_bytes_s', color: '#16a34a', label: 'Physical reads' }], rate: true, yLabel: 'Bytes / s' },
  { id: 'redo', label: 'Redo Log', title: 'Redo Generated', icon: 'refresh', series: [{ key: 'redo_bytes_s', color: '#0ea5e9', label: 'Redo generated' }], rate: true, yLabel: 'Bytes / s' },
  { id: 'wait', label: 'Wait Events', title: 'Database Wait Time Ratio', icon: 'clock', series: [{ key: 'wait_ratio', color: '#f59e0b', label: 'Share of DB time waiting' }], yMax: 100, yLabel: '% of DB time', tip: (v) => `${v.toFixed(1)}%` },
];

const RANGES = [{ id: 15, label: 'Last 15 Minutes' }, { id: 30, label: 'Last 30 Minutes' }, { id: 60, label: 'Last 1 Hour' }, { id: 360, label: 'Last 6 Hours' }, { id: 1440, label: 'Last 24 Hours' }, { id: 10080, label: 'Last 7 Days' }];

/** Metrics ACTMON does not store: Oracle has them for the last hour only. */
const ORACLE_ONLY = 'No stored samples yet. ACTMON stores these Oracle figures every collection cycle from the moment this version was deployed; rates need two cycles.';

export default function OraclePerformance({ id, instId }) {
  const navigate = useNavigate();
  const [minutes, setMinutes] = useState(60);
  const [tz, setTz] = useState('local');
  const [auto, setAuto] = useState(true);
  const [tab, setTab] = useState('cpu');
  const [showThreshold, setShowThreshold] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState(null);
  const [topTab, setTopTab] = useState('sessions');
  const [memTab, setMemTab] = useState('pga');
  const [ioTab, setIoTab] = useState('req');
  const [readTab, setReadTab] = useState('logical');

  const hist = useQuery({
    queryKey: ['oraclePerfHistory', id, minutes, instId || null],
    queryFn: () => api(id, 'oracle-perf-history', { minutes, ...(instId ? { inst_id: instId } : {}) }),
    refetchInterval: auto ? 60000 : false,
    retry: false,
  });
  const top = useQuery({
    queryKey: ['oraclePerfTopNow', id, instId || null],
    queryFn: () => api(id, 'oracle-perf-top-now', instId ? { inst_id: instId } : undefined),
    refetchInterval: auto ? 30000 : false,
    retry: false,
  });
  const topSql = useQuery({
    queryKey: ['oraclePerfTopSql', id],
    queryFn: () => api(id, 'oracle-top-sql'),
    refetchInterval: auto ? 60000 : false,
    retry: false,
  });

  const d = hist.data;
  const points = d?.status === 'success' ? d.points : [];
  const dbTz = d?.db_tz;
  const latest = points.length ? points[points.length - 1].t : null;
  const sel = selected && points.some((p) => p.t === selected) ? selected : latest;
  const isLatest = sel === latest;
  const topAt = useQuery({
    queryKey: ['oraclePerfTopAt', id, sel],
    queryFn: () => api(id, 'oracle-perf-top-at', { at: sel }),
    enabled: !!sel && !isLatest,
    retry: false,
  });
  const lastOf = (k) => { for (let i = points.length - 1; i >= 0; i -= 1) if (points[i][k] != null) return points[i][k]; return null; };
  const first = points.length ? toDate(points[0].t, dbTz) : null;
  const last = latest ? toDate(latest, dbTz) : null;
  const mt = MAIN_TABS.find((t) => t.id === tab);
  const mainFmt = mt.bytes ? (v) => fmtBytes(v) : mt.rate ? (v) => fmtRate(v) : mt.tip ? (v, full) => (full ? mt.tip(v) : `${Math.round(v)}`) : (v) => fmtShortCount(v);
  const refreshAll = () => { hist.refetch(); top.refetch(); topSql.refetch(); };

  return (
    <div className="space-y-4">
      {/* ── controls ── */}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <select value={minutes} onChange={(e) => { setMinutes(Number(e.target.value)); setSelected(null); }}
          className="h-10 rounded-lg border border-border bg-surface px-3 text-[13px] text-fg shadow-sm">
          {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
        <span className="flex h-10 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-[13px] text-fg shadow-sm"
          title="Oracle keeps one hour of minute-level metric history">
          {first && last ? `${fmtTime(first, tz, true)} – ${fmtTime(last, tz)}` : '—'}
          <Icon name="calendar" size={15} className="text-muted" />
        </span>
        <select value={tz} onChange={(e) => setTz(e.target.value)}
          className="h-10 rounded-lg border border-border bg-surface px-3 text-[13px] text-fg shadow-sm">
          <option value="local">Local time</option>
          <option value="utc">UTC</option>
        </select>
        <label className="flex cursor-pointer items-center gap-2 text-[13px] font-medium text-fg">
          <button type="button" role="switch" aria-checked={auto} onClick={() => setAuto((v) => !v)}
            className={cn('relative h-6 w-11 rounded-full transition-colors', auto ? 'bg-accent' : 'bg-border')}>
            <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', auto ? 'left-[22px]' : 'left-0.5')} />
          </button>
          Auto Refresh
        </label>
        <button type="button" onClick={refreshAll}
          className="flex h-10 items-center gap-2 rounded-lg bg-accent px-5 text-[14px] font-semibold text-accent-fg shadow-sm hover:opacity-90">
          <Icon name="refresh" size={16} className={hist.isFetching ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {hist.error && <Notice tone="danger" title="Metric history could not be read.">{String(hist.error.message || hist.error)}</Notice>}
      {d?.status === 'error' && <Notice tone="danger" title="Metric history could not be read.">{d.error}</Notice>}
      {d?.clamped && <Notice tone="info" title="Showing the last 7 days.">That is the longest range this screen plots.</Notice>}
      {instId && d?.sources?.stored_points > 0 && (
        <p className="text-[11px] text-subtle">Stored history covers the whole database connection, not only instance {instId}.</p>
      )}

      {/* ── KPI row ── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <KpiCard icon="users" iconCls="bg-accent-soft text-accent-text" label="Active Sessions" value={fmtCount(lastOf('active_sessions') ?? lastOf('aas'), 2)} trend={<Trend points={points} k={lastOf('active_sessions') != null ? 'active_sessions' : 'aas'} />} points={points} k={lastOf('active_sessions') != null ? 'active_sessions' : 'aas'} color="#3b82f6" />
        <KpiCard icon="cpu" iconCls="bg-[#8b5cf6]/15 text-[#7c3aed]" label="CPU Usage" value={lastOf('cpu_pct') == null ? 'N/A' : `${lastOf('cpu_pct').toFixed(1)}%`} trend={<Trend points={points} k="cpu_pct" />} points={points} k="cpu_pct" color="#ef4444" />
        <KpiCard icon="memory" iconCls="bg-accent-soft text-accent-text" label="Memory (PGA)" value={fmtBytes(lastOf('pga_alloc_bytes'))} trend={<Trend points={points} k="pga_alloc_bytes" />} points={points} k="pga_alloc_bytes" color="#eab308" />
        <KpiCard icon="layers" iconCls="bg-[#8b5cf6]/15 text-[#7c3aed]" label="Logical Reads" value={fmtRate(lastOf('logical_bytes_s'))} trend={<Trend points={points} k="logical_bytes_s" />} points={points} k="logical_bytes_s" color="#8b5cf6" />
        <KpiCard icon="database" iconCls="bg-accent-soft text-accent-text" label="I/O Requests" value={lastOf('iops') == null ? 'N/A' : `${fmtShortCount(lastOf('iops'))} /s`} trend={<Trend points={points} k="iops" />} points={points} k="iops" color="#3b82f6" />
      </div>

      {/* ── main chart + top 5 ── */}
      <div className={cn('grid gap-4', expanded ? 'grid-cols-1' : 'xl:grid-cols-[1.9fr_1fr]')}>
        <Card className="p-5">
          <div className="flex items-start justify-between gap-3">
            <PillTabs value={tab} onChange={setTab} options={MAIN_TABS} />
            <button type="button" onClick={() => setExpanded((v) => !v)} title={expanded ? 'Collapse' : 'Expand'}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border text-muted hover:bg-sunken">
              <Icon name={expanded ? 'collapse' : 'expand'} size={16} />
            </button>
          </div>
          <div className="mt-4 flex items-center justify-between gap-3">
            <h3 className="flex items-center gap-2 text-[16px] font-bold text-fg">
              <span className="grid h-8 w-8 place-items-center rounded-full bg-[#8b5cf6]/15 text-[#7c3aed]"><Icon name={mt.icon} size={16} /></span>
              {mt.title}
            </h3>
            {mt.threshold != null && (
              <label className="flex items-center gap-2 text-[12px] text-fg">
                <input type="checkbox" checked={showThreshold} onChange={(e) => setShowThreshold(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
                Show Threshold
              </label>
            )}
          </div>
          <div className="mt-2 flex gap-4">
            <div className="min-w-0 flex-1">
              {hist.isLoading ? <div className="h-[300px] animate-pulse rounded-xl bg-sunken" /> : (
                <TrendChart points={points} series={mt.series} height={expanded ? 420 : 300} yMax={mt.yMax} yFmt={mainFmt}
                  yLabel={mt.yLabel} threshold={showThreshold ? mt.threshold : undefined} tz={tz} dbTz={dbTz}
                  selected={sel} onSelect={setSelected}
                  emptyText={['cpu', 'aas'].includes(tab) ? 'No stored samples in this range yet.' : ORACLE_ONLY} />
              )}
            </div>
            <div className="hidden w-36 shrink-0 pt-6 lg:block">
              <div className="space-y-2 text-[12px] text-fg">
                {mt.series.map((s) => (
                  <p key={s.key} className="flex items-center gap-2"><span className="h-0 w-5 border-t-2" style={{ borderColor: s.color }} />{s.label}</p>
                ))}
                {showThreshold && mt.threshold != null && (
                  <p className="flex items-center gap-2"><span className="h-0 w-5 border-t-2 border-dashed border-[#ef4444]" />Threshold ({mt.threshold}%)</p>
                )}
              </div>
            </div>
          </div>
          <p className="mt-1 text-[11px] text-subtle">Click a point to inspect that moment. Source: ACTMON stored telemetry ({d?.bucket_seconds ? `${d.bucket_seconds / 60}-minute` : '1-minute'} buckets){d?.sources?.oracle_points ? ' + Oracle GV$SYSMETRIC_HISTORY for the last hour' : ''}.</p>
        </Card>

        <Card className="flex flex-col p-5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-[14px] font-bold text-fg"><Icon name="info" size={16} className="text-accent-text" />Top 5 at Selected Time</h3>
            <p className="text-[12px] text-muted">Time: <span className="font-medium text-accent-text">{fmtTime(sel ? toDate(sel, dbTz) : null, tz, true)}</span></p>
          </div>
          <div className="mt-3 grid grid-cols-3 rounded-lg bg-sunken/70 p-1 text-[13px]">
            {[['sessions', 'Top Sessions'], ['sql', 'Top SQL'], ['waits', 'Top Wait Events']].map(([k, l]) => (
              <button key={k} type="button" onClick={() => setTopTab(k)}
                className={cn('rounded-md py-2 font-medium', topTab === k ? 'bg-surface text-accent-text shadow-sm underline decoration-2 underline-offset-[10px]' : 'text-muted hover:text-fg')}>
                {l}
              </button>
            ))}
          </div>
          <div className="mt-3 flex-1">
            {!isLatest ? (
              topAt.isLoading ? <div className="h-48 animate-pulse rounded-xl bg-sunken" />
                : topAt.data?.status === 'error' ? <p className="text-[12px] text-danger-fg">{topAt.data.error}</p>
                  : topTab === 'sessions' ? (
                    (topAt.data?.top_sessions || []).length ? (
                      <>
                        <TopTable kind="sessions" data={topAt.data} />
                        <p className="mt-2 text-[11px] text-subtle">Stored snapshot at {fmtTime(toDate(String(topAt.data.top_sessions_at).slice(0, 16).replace(' ', 'T'), '+00:00'), tz, true)} — top sessions by CPU, per instance</p>
                      </>
                    ) : (
                      <Notice tone="info" title="No stored session snapshot near this moment.">
                        <p className="text-[12px]">ACTMON stores the top sessions every collection cycle from the moment this version was deployed. Earlier moments have none; select a later point or the latest point for live sessions.</p>
                      </Notice>
                    )
                  ) : (
                    <>
                      <TopTable kind={topTab} data={topAt.data} stored onSql={(r) => navigate(`/oracle-dashboard/${id}/slow-queries/detail`, {
                          state: { backTo: `/oracle-dashboard/${id}/performance`, row: { query_id: r.sql_id, query_text: r.sql_text || '', execution_count: r.executions ?? null,
                            average_execution_time: r.avg_elapsed_ms ?? null, _raw: r } },
                        })} />
                      {(topTab === 'sql' ? topAt.data?.top_sql_at : topAt.data?.top_waits_at) && (
                        <p className="mt-2 text-[11px] text-subtle">Stored snapshot at {fmtTime(toDate(String(topTab === 'sql' ? topAt.data.top_sql_at : topAt.data.top_waits_at).slice(0, 16).replace(' ', 'T'), '+00:00'), tz, true)}</p>
                      )}
                    </>
                  )
            ) : top.isLoading ? <div className="h-48 animate-pulse rounded-xl bg-sunken" /> : (
              <>
                <TopTable kind={topTab} data={top.data} onSql={(r) => navigate(`/oracle-dashboard/${id}/slow-queries/detail`, {
                          state: { backTo: `/oracle-dashboard/${id}/performance`, row: { query_id: r.sql_id, query_text: r.sql_text || '', execution_count: r.executions ?? null,
                            average_execution_time: r.avg_elapsed_ms ?? null, _raw: r } },
                        })} onSession={(s) => navigate(`/oracle-dashboard/${id}/live-queries/session?inst=${s.inst_id ?? 1}&sid=${s.sid}&serial=${s.serial}`, {
                  state: { backTo: `/oracle-dashboard/${id}/performance`, row: { sid: s.sid, serial_number: s.serial, username: s.username, program: s.program, sql_id: s.sql_id, inst_id: s.inst_id } },
                })} />
                {(top.data?.errors || []).length > 0 && <p className="mt-2 break-words text-[11px] text-subtle">{top.data.errors.join(' · ')}</p>}
              </>
            )}
          </div>
          <div className="mt-3 flex justify-end">
            <button type="button" disabled={!isLatest} onClick={() => navigate(oracleTabRoute(id, 'sessions'))}
              className="flex items-center gap-2 rounded-lg border border-accent px-4 py-2 text-[13px] font-semibold text-accent-text hover:bg-accent-softer disabled:opacity-40">
              View All Sessions at This Time <Icon name="arrow-right" size={14} />
            </button>
          </div>
        </Card>
      </div>

      {/* ── three charts ── */}
      <div className="grid gap-4 xl:grid-cols-3">
        <MiniPanel icon="memory" title="Memory Usage" tabs={[['pga', 'PGA'], ['sga', 'SGA'], ['total', 'Total Memory']]} tab={memTab} onTab={setMemTab}>
          <TrendChart compact points={points} height={170} tz={tz} dbTz={dbTz} yFmt={(v) => fmtBytes(v)}
            emptyText={ORACLE_ONLY}
            series={memTab === 'pga'
              ? [{ key: 'pga_used_bytes', color: '#8b5cf6', label: 'PGA in use' }, { key: 'pga_alloc_bytes', color: '#22c55e', label: 'PGA allocated' }]
              : memTab === 'sga'
                ? [{ key: 'sga_bytes', color: '#3b82f6', label: 'SGA' }]
                : [{ key: 'total_mem_bytes', color: '#0ea5e9', label: 'SGA + PGA' }]} />
          <Legend items={memTab === 'pga'
            ? [{ label: 'PGA in use', color: '#8b5cf6' }, { label: 'PGA allocated', color: '#22c55e' }]
            : memTab === 'sga' ? [{ label: 'SGA', color: '#3b82f6' }] : [{ label: 'SGA + PGA', color: '#0ea5e9' }]} />
        </MiniPanel>
        <MiniPanel icon="database" title="I/O Throughput" tabs={[['req', 'I/O Requests'], ['bytes', 'I/O Bytes']]} tab={ioTab} onTab={setIoTab}>
          {ioTab === 'req' ? (
            <>
              <TrendChart compact points={points} height={170} tz={tz} dbTz={dbTz} emptyText={ORACLE_ONLY}
                series={[{ key: 'read_iops', color: '#f97316', label: 'Read Requests' }, { key: 'write_iops', color: '#eab308', label: 'Write Requests' }]} />
              <Legend items={[{ label: 'Read Requests', color: '#f97316' }, { label: 'Write Requests', color: '#eab308' }]} />
            </>
          ) : (
            <>
              <TrendChart compact points={points} height={170} tz={tz} dbTz={dbTz} yFmt={(v) => fmtRate(v)} emptyText={ORACLE_ONLY}
                series={[{ key: 'read_bytes_s', color: '#f97316', label: 'Read Bytes' }, { key: 'write_bytes_s', color: '#eab308', label: 'Write Bytes' }]} />
              <Legend items={[{ label: 'Read Bytes', color: '#f97316' }, { label: 'Write Bytes', color: '#eab308' }]} />
            </>
          )}
        </MiniPanel>
        <MiniPanel icon="layers" title="Logical & Physical Reads" tabs={[['logical', 'Logical Reads'], ['physical', 'Physical Reads']]} tab={readTab} onTab={setReadTab}>
          <TrendChart compact points={points} height={170} tz={tz} dbTz={dbTz} yFmt={(v) => fmtRate(v)} emptyText={ORACLE_ONLY}
            series={readTab === 'logical'
              ? [{ key: 'logical_bytes_s', color: '#2563eb', label: 'Logical Reads' }, { key: 'physical_bytes_s', color: '#22c55e', label: 'Physical Reads', fill: false }]
              : [{ key: 'physical_bytes_s', color: '#22c55e', label: 'Physical Reads' }, { key: 'logical_bytes_s', color: '#2563eb', label: 'Logical Reads', fill: false }]} />
          <Legend items={[{ label: 'Logical Reads', color: '#2563eb' }, { label: 'Physical Reads', color: '#22c55e' }]} />
        </MiniPanel>
      </div>

      {/* ── historical top SQL ── */}
      <Card className="overflow-hidden">
        <h3 className="flex items-center gap-2 px-5 pt-4 text-[14px] font-bold text-fg">
          <Icon name="report" size={16} className="text-accent-text" />Historical Top SQL
          <span className="ml-2 text-[11px] font-normal text-subtle">cursor cache (V$SQL), totals since each statement was loaded</span>
        </h3>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[1100px] text-[12.5px]">
            <thead className="bg-sunken/70 text-left text-[12px] font-semibold text-muted">
              <tr>{['SQL ID', 'Plan Hash', 'SQL Text (short)', 'Executions', 'Avg Elapsed', 'CPU Time', 'Buffer Gets', 'Physical Reads', 'Database Time', 'Last Active', 'Action']
                .map((h) => <th key={h} className="whitespace-nowrap px-4 py-2.5">{h}</th>)}</tr>
            </thead>
            <tbody>
              {topSql.isLoading && <tr><td colSpan={11} className="px-4 py-6 text-center text-muted">Reading V$SQL…</td></tr>}
              {topSql.data?.status === 'error' && <tr><td colSpan={11} className="px-4 py-6 text-center text-danger-fg">{topSql.data.error}</td></tr>}
              {(topSql.data?.sql || []).slice(0, 10).map((r) => {
                const open = () => navigate(`/oracle-dashboard/${id}/slow-queries/detail`, {
                  state: { backTo: `/oracle-dashboard/${id}/performance`, row: {
                    query_id: r.sql_id, query_text: r.sql_fulltext || r.sql_text, execution_count: r.executions,
                    average_execution_time: r.avg_elapsed_ms, total_execution_time: r.elapsed_ms,
                    schema_name: r.parsing_schema_name, user_name: r.parsing_schema_name, last_seen: r.last_active_time, _raw: r,
                  } },
                });
                return (
                  <tr key={`${r.sql_id}-${r.child_number}`} onClick={open} className="cursor-pointer border-t border-border hover:bg-sunken/60">
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-accent-text">{r.sql_id}</td>
                    <td className="px-4 font-mono">{r.plan_hash_value}</td>
                    <td className="max-w-[340px] truncate px-4 font-mono text-[12px]" title={r.sql_text}>{r.sql_text}</td>
                    <td className="px-4">{fmtCount(r.executions)}</td>
                    <td className="px-4">{fmtMs(r.avg_elapsed_ms)}</td>
                    <td className="px-4">{fmtMs(r.cpu_ms)}</td>
                    <td className="px-4">{fmtCount(r.buffer_gets)}</td>
                    <td className="px-4">{fmtCount(r.disk_reads)}</td>
                    <td className="px-4">{fmtMs(r.elapsed_ms)}</td>
                    <td className="whitespace-nowrap px-4">{r.last_active_time || 'N/A'}</td>
                    <td className="px-4 text-accent-text"><Icon name="chevron-right" size={16} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {(d?.errors || []).length > 0 && (
        <p className="text-[11px] text-subtle">Partial read: {d.errors.join(' · ')}</p>
      )}
    </div>
  );
}

function MiniPanel({ icon, title, tabs, tab, onTab, children }) {
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-[14px] font-bold text-fg"><Icon name={icon} size={16} className="text-accent-text" />{title}</h3>
        <PillTabs size="sm" value={tab} onChange={onTab} options={tabs.map(([id, label]) => ({ id, label }))} />
      </div>
      {children}
    </Card>
  );
}

function TopTable({ kind, data, onSession, onSql, stored = false }) {
  if (!data) return null;
  if (kind === 'sessions') {
    if (data.top_sessions == null) return <p className="text-[12px] text-muted">Session metrics could not be read.</p>;
    if (!data.top_sessions.length) return <p className="text-[12px] text-muted">No user sessions right now.</p>;
    const max = Math.max(1, ...data.top_sessions.map((s) => s.cpu_pct || 0));
    return (
      <table className="w-full text-[12.5px]">
        <thead className="bg-sunken/70 text-left text-[12px] font-semibold text-muted">
          <tr>{['SID', 'Serial#', 'User', 'Program', 'CPU %'].map((h) => <th key={h} className="px-2 py-2">{h}</th>)}<th /></tr>
        </thead>
        <tbody>
          {data.top_sessions.map((s) => (
            <tr key={`${s.inst_id}-${s.sid}-${s.serial}`} onClick={onSession ? () => onSession(s) : undefined}
              className={cn('border-t border-border', onSession && 'cursor-pointer hover:bg-sunken/60')}>
              <td className="px-2 py-2 font-medium text-accent-text">{s.sid}</td>
              <td className="px-2">{s.serial}</td>
              <td className="px-2">{s.username || 'N/A'}</td>
              <td className="max-w-[140px] truncate px-2" title={s.program}>{s.program || 'N/A'}</td>
              <td className="px-2">{s.cpu_pct == null ? 'N/A' : `${s.cpu_pct}%`}</td>
              <td className="w-24 px-2">
                <span className="block h-2.5 rounded-full bg-sunken">
                  <span className="block h-full rounded-full" style={{ width: `${((s.cpu_pct || 0) / max) * 100}%`, background: (s.cpu_pct || 0) >= 50 ? '#ef4444' : '#f59e0b' }} />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  const rows = kind === 'sql' ? data.top_sql : data.top_waits;
  if (rows == null) return <p className="text-[12px] text-muted">Could not be read.</p>;
  if (stored) {
    if (!rows.length) return <p className="text-[12px] text-muted">No stored snapshot within 30 minutes before this moment.</p>;
    return (
      <table className="w-full text-[12.5px]">
        <thead className="bg-sunken/70 text-left text-[12px] font-semibold text-muted">
          <tr>{(kind === 'sql' ? ['SQL ID', 'Executions', 'Avg elapsed', 'CPU'] : ['Wait event', 'Class', 'Time waited', 'Waits']).map((h) => <th key={h} className="px-2 py-2">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.sql_id || r.event} onClick={kind === 'sql' && onSql ? () => onSql(r) : undefined}
              className={cn('border-t border-border', kind === 'sql' && onSql && 'cursor-pointer hover:bg-sunken/60')}>
              {kind === 'sql' ? (
                <>
                  <td className="px-2 py-2 font-mono text-accent-text underline-offset-2 hover:underline" title={r.sql_text}>{r.sql_id}</td>
                  <td className="px-2">{fmtCount(r.executions)}</td>
                  <td className="px-2">{fmtMs(r.avg_elapsed_ms)}</td>
                  <td className="px-2" title={r.cpu_ms ? undefined : 'CPU time is not captured in the stored Top-SQL snapshot'}>{r.cpu_ms ? fmtMs(r.cpu_ms) : '—'}</td>
                </>
              ) : (
                <>
                  <td className="max-w-[160px] truncate px-2 py-2" title={r.event}>{r.event}</td>
                  <td className="px-2">{r.wait_class || 'N/A'}</td>
                  <td className="px-2">{fmtMs(r.time_waited_ms)}</td>
                  <td className="px-2">{fmtCount(r.count)}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (!rows.length) return <p className="text-[12px] text-muted">{kind === 'sql' ? 'No SQL is executing right now.' : 'No session is waiting on anything right now.'}</p>;
  return (
    <table className="w-full text-[12.5px]">
      <thead className="bg-sunken/70 text-left text-[12px] font-semibold text-muted">
        <tr>{(kind === 'sql' ? ['SQL ID', 'User', 'Active sessions'] : ['Wait event', 'Class', 'Sessions']).map((h) => <th key={h} className="px-2 py-2">{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.sql_id || r.event} onClick={kind === 'sql' && onSql ? () => onSql(r) : undefined}
            className={cn('border-t border-border', kind === 'sql' && onSql && 'cursor-pointer hover:bg-sunken/60')}>
            <td className={cn('px-2 py-2', kind === 'sql' && 'font-mono text-accent-text hover:underline')}>{r.sql_id || r.event}</td>
            <td className="px-2">{kind === 'sql' ? (r.username || 'N/A') : (r.wait_class || 'N/A')}</td>
            <td className="px-2">{r.sessions}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
