import { Fragment, useMemo, useState } from 'react';
import {
  Area, AreaChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ReferenceDot, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import { UTILISATION_BANDS } from '@/components/charts/status';
import { downloadCsv, fmtBytes, pct, share, toCsv } from './memoryUtil';

export const tShort = (ms) => (ms == null ? 'N/A' : new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
export const tLong = (ms) => (ms == null ? 'N/A' : new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }));
export const tSec = (ms) => (ms == null ? 'N/A' : new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
const PALETTE = ['#dc2626', '#2563eb', '#f59e0b', '#7c3aed', '#16a34a', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#475569'];
const axisTick = { fontSize: 11, fill: 'var(--fg-muted)' };

export function Panel({ icon, title, sub, actions, className, bodyClass, children }) {
  return (
    <section className={cn('card flex min-w-0 flex-col', className)}>
      <div className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-2">
        <div className="flex min-w-0 items-center gap-2.5">
          {icon && <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent-soft text-accent"><Icon name={icon} size={15} /></span>}
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold text-fg">{title}</h2>
            {sub && <p className="truncate text-[11.5px] text-muted">{sub}</p>}
          </div>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      <div className={cn('min-h-0 flex-1 px-4 pb-3.5', bodyClass)}>{children}</div>
    </section>
  );
}

export function Skeleton({ className }) { return <div className={cn('animate-pulse rounded-md bg-sunken', className)} />; }

export function Empty({ icon = 'info', title, children, className }) {
  return (
    <div className={cn('flex h-full flex-col items-center justify-center gap-1.5 py-6 text-center', className)}>
      <Icon name={icon} size={20} className="text-subtle" />
      <div className="text-[13px] font-semibold text-fg">{title}</div>
      {children && <div className="max-w-md text-[12px] text-muted">{children}</div>}
    </div>
  );
}

export const ctl = 'inline-flex h-9 items-center gap-2 rounded-control border border-border bg-surface px-3 text-[13px] text-fg hover:bg-raised';

export function Spark({ points, color }) {
  if (!points || points.length < 2) return <div className="h-9 w-[72px]" />;
  return (
    <div className="h-9 w-[72px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points}><Line type="monotone" dataKey="v" stroke={color} strokeWidth={1.8} dot={false} isAnimationActive={false} /></LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Delta({ value, suffix }) {
  if (value == null || Number.isNaN(value)) return <span className="text-muted">{suffix ? `— ${suffix}` : '—'}</span>;
  const up = value > 0;
  return (
    <span className="leading-tight">
      <span className={cn('font-semibold', up ? 'text-danger-fg' : 'text-success-fg')}>{up ? '↑' : '↓'} {Math.abs(value).toFixed(1)}%</span>
      {suffix && <span className="block text-muted">{suffix}</span>}
    </span>
  );
}

export function StatCard({ icon, tone, label, value, sub, children, spark }) {
  return (
    <div className="card flex min-h-[112px] gap-3 p-3.5">
      <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-lg', tone)}><Icon name={icon} size={22} /></span>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-semibold text-fg">{label}</div>
        <div className="mt-1 text-[25px] font-bold leading-none text-fg tabular-nums">{value}</div>
        {sub && <div className="mt-0.5 text-[10.5px] text-subtle">{sub}</div>}
        <div className="mt-2 flex items-end justify-between gap-2 text-[12px]">
          <div className="min-w-0">{children}</div>
          {spark}
        </div>
      </div>
    </div>
  );
}

/** Time-series % chart with thresholds, crosshair, rich tooltip and click-to-select. */
export function TrendChart({ data, dataKey, color, kind, height, selected, onSelect, tooltipRows, rangeMinutes }) {
  const gid = `g-${dataKey}`;
  const Tip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    const p = payload[0].payload;
    return (
      <div className="rounded-lg border border-border bg-surface px-3 py-2 text-[12px] shadow-lg">
        <div className="mb-1 font-semibold text-fg">{tLong(label)}</div>
        {tooltipRows(p).map(([k, v, c]) => (
          <div key={k} className="flex items-center justify-between gap-6">
            <span className="flex items-center gap-1.5 text-muted"><span className="h-2 w-2 rounded-full" style={{ background: c }} />{k}</span>
            <b className="tabular-nums text-fg">{v}</b>
          </div>
        ))}
        <div className="mt-1 text-[10.5px] text-subtle">Click to inspect this time</div>
      </div>
    );
  };
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 10, bottom: 0, left: -12 }} style={{ cursor: 'crosshair' }}
          onClick={(e) => { const p = e?.activePayload?.[0]?.payload; if (p) onSelect(p); }}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={kind === 'area' ? 0.4 : 0.22} /><stop offset="100%" stopColor={color} stopOpacity={0.03} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <ReferenceLine y={90} stroke="var(--status-critical)" strokeDasharray="5 4" />
          <ReferenceLine y={75} stroke="var(--status-serious)" strokeDasharray="5 4" />
          <ReferenceLine y={60} stroke="var(--status-warning)" strokeDasharray="5 4" />
          <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tick={axisTick} stroke="var(--border)" minTickGap={44}
            tickFormatter={(t) => (rangeMinutes > 1440 ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : tShort(t))} />
          <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} tick={axisTick} stroke="var(--border)" />
          <Tooltip content={<Tip />} cursor={{ stroke: color, strokeDasharray: '4 3' }} />
          <Area type="linear" dataKey={dataKey} stroke={color} strokeWidth={2} fill={`url(#${gid})`} isAnimationActive={false} connectNulls={false}
            dot={kind === 'line' && data.length <= 90 ? { r: 2.5, fill: color, strokeWidth: 0 } : false} activeDot={{ r: 5 }} />
          {selected && <ReferenceLine x={selected.t} stroke={color} strokeDasharray="4 3" label={{ value: tShort(selected.t), position: 'insideBottom', fill: '#fff', fontSize: 11 }} />}
          {selected && selected[dataKey] != null && <ReferenceDot x={selected.t} y={selected[dataKey]} r={7} fill={color} stroke="#fff" strokeWidth={2.5} />}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function TrendLegend({ color, label, selected, onClear }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px] text-muted">
      <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />{label}</span>
      {UTILISATION_BANDS.map((b) => <span key={b.id} className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: b.color }} />{b.label}</span>)}
      {selected && (
        <span className="ml-auto inline-flex items-center gap-2 rounded-full bg-accent-soft px-2.5 py-0.5 font-semibold text-accent">
          Selected {tSec(selected.t)}
          <button type="button" aria-label="Clear selection" onClick={onClear}><Icon name="close" size={12} /></button>
        </span>
      )}
    </div>
  );
}

export function Donut({ bd, centerValue, centerLabel, size = 168 }) {
  if (!bd) return <Empty title="Breakdown not reported">This host's collector has not reported the memory components yet.</Empty>;
  return (
    <div className="flex flex-wrap items-center gap-5">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={bd.parts} dataKey="bytes" nameKey="label" innerRadius="70%" outerRadius="100%" startAngle={90} endAngle={-270} stroke="#fff" strokeWidth={2} isAnimationActive={false}>
              {bd.parts.map((p) => <Cell key={p.id} fill={p.color} />)}
            </Pie>
            <Tooltip formatter={(v, n) => [fmtBytes(v), n]} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div><div className="text-[24px] font-bold text-fg">{centerValue}</div><div className="text-[12px] text-muted">{centerLabel}</div></div>
        </div>
      </div>
      <ul className="min-w-[200px] flex-1 space-y-3 text-[13.5px]">
        {bd.parts.map((p) => (
          <li key={p.id} className="flex items-center gap-2.5">
            <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: p.color }} />
            <span className="flex-1 truncate text-fg">{p.label} <span className="text-muted">({fmtBytes(p.bytes)})</span></span>
            <b className="tabular-nums text-fg">{p.pct.toFixed(1)}%</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

const memBarColor = (p) => (p == null ? '#94a3b8' : p >= 20 ? '#dc2626' : p >= 5 ? '#f97316' : '#f59e0b');

export function ProcessTable({ procs, selectedPid, onPick, compact, title, csvName, loading, emptyNode }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState({ key: 'ws', dir: -1 });
  const [all, setAll] = useState(false);
  const [page, setPage] = useState(0);
  const PAGE = 25;
  const rows = useMemo(() => {
    const f = q ? procs.filter((p) => `${p.name} ${p.pid} ${p.user || ''}`.toLowerCase().includes(q.toLowerCase())) : procs;
    return [...f].sort((a, b) => {
      const x = a[sort.key] ?? -1; const y = b[sort.key] ?? -1;
      return (typeof x === 'string' || typeof y === 'string' ? String(x).localeCompare(String(y)) : x - y) * sort.dir;
    });
  }, [procs, q, sort]);
  const shown = all ? rows.slice(page * PAGE, page * PAGE + PAGE) : rows.slice(0, compact ? 5 : 10);
  const pages = Math.ceil(rows.length / PAGE);
  const cols = [['#', null], ['Process Name', 'name'], ['PID', 'pid'], ['Memory Usage', 'ws'], ['Memory %', 'memPct'], ['CPU Usage', 'cpu'], ['User', 'user'], ['Threads', 'threads'], ['Status', 'status'], ['Actions', null]];
  const exportCsv = () => downloadCsv(csvName, toCsv(rows.map((p) => ({ ...p, ws: p.ws, private: p.private, start: p.start_t ? new Date(p.start_t).toISOString() : '' })), [
    ['name', 'Process Name'], ['pid', 'PID'], ['ws', 'Working Set (bytes)'], ['private', 'Private (bytes)'], ['memPct', 'Memory %'], ['cpu', 'CPU %'],
    ['user', 'User'], ['threads', 'Threads'], ['status', 'Status'], ['start', 'Started (UTC)']]));
  return (
    <>
      <div className="mb-2 flex flex-wrap items-center justify-end gap-2 xl:flex-nowrap">
        {title}
        <label className="ml-auto inline-flex h-8 items-center gap-2 rounded-control border border-border bg-surface px-2.5 text-[12.5px] text-muted">
          <Icon name="search" size={14} />
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder="Search processes..." aria-label="Search processes" className="w-28 2xl:w-36 bg-transparent text-fg outline-none placeholder:text-subtle" />
        </label>
        <button type="button" className={cn(ctl, 'h-8')} onClick={exportCsv} disabled={!rows.length}><Icon name="download" size={14} /> Download CSV</button>
        <button type="button" className={cn(ctl, 'h-8 text-accent')} onClick={() => { setAll(!all); setPage(0); }}>{all ? 'Show Top' : 'View All'}</button>
      </div>
      {loading ? <Skeleton className="h-44" /> : !procs.length ? emptyNode : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px] [&_td]:whitespace-nowrap [&_td]:px-1.5 [&_th]:px-1.5">
            <thead>
              <tr className="border-b border-border text-left text-[12px] text-muted">
                {cols.map(([label, k]) => (
                  <th key={label} className="whitespace-nowrap px-2 py-2 font-semibold">
                    {k ? <button type="button" className="inline-flex items-center gap-1 hover:text-fg" onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? -s.dir : -1 }))}>
                      {label}{sort.key === k && <Icon name={sort.dir < 0 ? 'chevron-down' : 'chevron-up'} size={11} />}</button> : label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((p, i) => (
                <tr key={`${p.pid}-${p.start_t || i}`} onClick={() => onPick(p)}
                  className={cn('cursor-pointer border-b border-border last:border-0 hover:bg-raised', selectedPid === p.pid && 'bg-accent-soft/60')}>
                  <td className="px-2 py-1.5 text-muted">{(all ? page * PAGE : 0) + i + 1}</td>
                  <td className={cn('px-2 py-1.5 font-medium', selectedPid === p.pid ? 'text-accent' : 'text-fg')}>{p.name}</td>
                  <td className="px-2 py-1.5 tabular-nums text-muted">{p.pid}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-2 whitespace-nowrap">
                      <span className="w-14 tabular-nums text-fg">{fmtBytes(p.ws)}</span>
                      <span className="h-2 w-12 overflow-hidden rounded-full bg-sunken"><span className="block h-full rounded-full" style={{ width: `${Math.min(100, (p.memPct ?? 0) * 4)}%`, background: memBarColor(p.memPct) }} /></span>
                    </div>
                  </td>
                  <td className="px-2 py-1.5 tabular-nums text-fg">{pct(p.memPct)}</td>
                  <td className="px-2 py-1.5 tabular-nums text-fg">{pct(p.cpu)}</td>
                  <td className="max-w-[130px] truncate px-2 py-1.5 text-fg" title={p.user || ''}>{p.user || 'N/A'}</td>
                  <td className="px-2 py-1.5 tabular-nums text-fg">{p.threads ?? 'N/A'}</td>
                  <td className="px-2 py-1.5">
                    {p.status ? <span className={cn('rounded-md px-2 py-0.5 text-[11.5px] font-semibold', /run|sleep|idle/i.test(p.status) ? 'bg-success-soft text-success-fg' : 'bg-warning-soft text-warning-fg')}>{p.status}</span> : <span className="text-muted">N/A</span>}
                  </td>
                  <td className="px-2 py-1.5"><button type="button" aria-label={`Details for ${p.name}`} className="text-muted hover:text-accent"><Icon name="plus" size={15} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {all && pages > 1 && (
            <div className="mt-2 flex items-center justify-end gap-2 text-[12px] text-muted">
              <button type="button" className={cn(ctl, 'h-7')} disabled={page === 0} onClick={() => setPage(page - 1)}>Prev</button>
              Page {page + 1} / {pages}
              <button type="button" className={cn(ctl, 'h-7')} disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function MiniHistory({ title, points, dataKey, color, fmt, selectedT, unit }) {
  const sel = selectedT != null ? points.reduce((b, p) => (b == null || Math.abs(p.t - selectedT) < Math.abs(b.t - selectedT) ? p : b), null) : null;
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center gap-1.5 text-[12.5px] font-semibold text-fg"><Icon name="activity" size={13} className="text-accent" />{title}</div>
      {points.length < 2 ? <div className="grid h-[110px] place-items-center text-[12px] text-muted">Not enough stored samples{unit ? ` (${unit})` : ''}</div> : (
        <div className="h-[110px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={points} margin={{ top: 6, right: 6, bottom: 0, left: -6 }}>
              <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
              <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={tShort} tick={{ fontSize: 10, fill: 'var(--fg-muted)' }} stroke="var(--border)" minTickGap={30} />
              <YAxis tickFormatter={fmt} tick={{ fontSize: 10, fill: 'var(--fg-muted)' }} stroke="var(--border)" width={52} />
              <Tooltip labelFormatter={tSec} formatter={(v) => [fmt(v), title]} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
              <Area type="monotone" dataKey={dataKey} stroke={color} fill={color} fillOpacity={0.15} strokeWidth={1.8} dot={false} isAnimationActive={false} />
              {sel && <ReferenceLine x={sel.t} stroke={color} strokeDasharray="3 3" />}
              {sel && sel[dataKey] != null && <ReferenceDot x={sel.t} y={sel[dataKey]} r={4} fill={color} stroke="#fff" />}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

export function ProcessDetails({ proc, history, historyLoading, selectedT, onClose, rangeLabel, platform }) {
  const [tab, setTab] = useState('overview');
  if (!proc) return <Empty title="Select a process">Click a row to see its details and history.</Empty>;
  const pts = (history || []).map((p) => ({ ...p, cpu: p.cpu_pct }));
  const rows = [
    ['PID', proc.pid], ['Path', proc.path || 'N/A'], ['User', proc.user || 'N/A'],
    ['Started At', proc.start_t ? tLong(proc.start_t) : proc.running_s != null ? `${Math.round(proc.running_s / 60)} min ago` : 'N/A'],
    ['Threads', proc.threads ?? 'N/A'],
    [platform === 'linux' ? 'Resident (RSS)' : 'Working Set', `${fmtBytes(proc.ws)}${proc.memPct != null ? ` (${pct(proc.memPct)})` : ''}`],
    [platform === 'linux' ? 'Private (RssAnon)' : 'Private Bytes', fmtBytes(proc.private)],
    ['Committed', platform === 'linux' ? 'Not exposed per process' : fmtBytes(proc.commit)],
    [platform === 'linux' ? 'Peak RSS (VmHWM)' : 'Peak Working Set', fmtBytes(proc.peak)],
    ['Status', proc.status || 'N/A'],
  ];
  return (
    <div>
      <div className="mb-2 flex items-center gap-4 border-b border-border text-[12.5px]">
        {[['overview', 'Overview'], ['mem', 'Memory History'], ['cpu', 'CPU History']].map(([k, l]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={cn('-mb-px border-b-2 px-1 pb-1.5', tab === k ? 'border-accent font-semibold text-accent' : 'border-transparent text-muted hover:text-fg')}>{l}</button>
        ))}
        {onClose && <button type="button" aria-label="Close process details" onClick={onClose} className="ml-auto pb-1.5 text-muted hover:text-fg"><Icon name="close" size={15} /></button>}
      </div>
      {tab === 'overview' ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_1.15fr]">
          <div>
            <div className="mb-2 flex items-center gap-2.5">
              <span className="grid h-9 w-9 place-items-center rounded-md bg-accent-soft text-accent"><Icon name="box" size={18} /></span>
              <div className="min-w-0"><div className="truncate text-[14px] font-semibold text-fg">{proc.name}</div><div className="text-[11.5px] text-muted">{proc.path ? proc.path.split(/[\\/]/).slice(-2, -1)[0] : 'Process'}</div></div>
            </div>
            <dl className="grid grid-cols-[96px_1fr] gap-x-2 gap-y-1 text-[12px]">
              {rows.map(([k, v]) => <Fragment key={k}><dt className="text-muted">{k}</dt><dd className="truncate text-fg" title={String(v)}>{v}</dd></Fragment>)}
            </dl>
          </div>
          <div className="space-y-2">
            {historyLoading ? <Skeleton className="h-56" /> : (
              <>
                <MiniHistory title={`Process Memory Usage (${rangeLabel})`} points={pts} dataKey="ws_bytes" color="#7c3aed" fmt={(v) => fmtBytes(v, 0)} selectedT={selectedT} />
                <MiniHistory title={`Process CPU Usage (${rangeLabel})`} points={pts} dataKey="cpu" color="#f97316" fmt={(v) => `${Math.round(v)}%`} selectedT={selectedT} />
              </>
            )}
          </div>
        </div>
      ) : tab === 'mem' ? (
        <MiniHistory title={`Working set (${rangeLabel})`} points={pts} dataKey="ws_bytes" color="#7c3aed" fmt={(v) => fmtBytes(v, 0)} selectedT={selectedT} />
      ) : (
        <MiniHistory title={`CPU % (${rangeLabel})`} points={pts} dataKey="cpu" color="#f97316" fmt={(v) => `${Math.round(v)}%`} selectedT={selectedT} />
      )}
      <p className="mt-1 text-[10.5px] text-subtle">History is stored while the process is among the host's top 15 by memory; gaps mean it was not.</p>
    </div>
  );
}

export function ProcessTimeline({ data, loading, mode, height = 150, selectedT }) {
  if (loading) return <Skeleton className="h-36" />;
  if (!data?.names?.length) return <Empty title="No process history in this range">Process memory is stored from the updated collector onwards.</Empty>;
  const Chart = mode === 'stacked' ? AreaChart : LineChart;
  return (
    <>
      <div className="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
        {data.names.map((n, i) => <span key={n} className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: PALETTE[i % PALETTE.length] }} />{n}</span>)}
      </div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <Chart data={data.points} margin={{ top: 6, right: 8, bottom: 0, left: -4 }}>
            <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
            <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={tShort} tick={{ fontSize: 10.5, fill: 'var(--fg-muted)' }} stroke="var(--border)" minTickGap={40} />
            <YAxis tickFormatter={(v) => fmtBytes(v, 0)} tick={{ fontSize: 10.5, fill: 'var(--fg-muted)' }} stroke="var(--border)" width={58} />
            <Tooltip labelFormatter={tSec} formatter={(v, n) => [fmtBytes(v), n]} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
            {selectedT != null && <ReferenceLine x={selectedT} stroke="var(--fg-muted)" strokeDasharray="3 3" />}
            {data.names.map((n, i) => (mode === 'stacked'
              ? <Area key={n} type="monotone" dataKey={n} stackId="1" stroke={PALETTE[i % PALETTE.length]} fill={PALETTE[i % PALETTE.length]} fillOpacity={0.25} isAnimationActive={false} />
              : <Line key={n} type="monotone" dataKey={n} stroke={PALETTE[i % PALETTE.length]} strokeWidth={1.8} dot={false} isAnimationActive={false} connectNulls={false} />))}
          </Chart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

export function ComponentBars({ m }) {
  if (!m) return <Empty title="Not reported yet">Memory components arrive with the updated collector.</Empty>;
  const T = m.total_bytes;
  const linux = m.platform === 'linux';
  const rows = [
    ['Used Memory', m.used_bytes, share(m.used_bytes, T), '#dc2626', 'of RAM'],
    ['Available Memory', m.available_bytes, share(m.available_bytes, T), '#16a34a', 'of RAM'],
    [linux ? 'Buffers / Cache' : 'Cached (Standby)', m.cached_bytes, share(m.cached_bytes, T), '#2563eb', 'of RAM'],
    ['Committed Memory', m.committed_bytes, share(m.committed_bytes, m.commit_limit_bytes), '#f97316', linux ? 'of CommitLimit (overcommit allowed)' : 'of commit limit'],
    ...(linux ? [['Shared (Shmem)', m.shmem_bytes, share(m.shmem_bytes, T), '#7c3aed', 'of RAM']] : [
      ['Non-Paged Pool', m.nonpaged_pool_bytes, share(m.nonpaged_pool_bytes, T), '#7c3aed', 'of RAM'],
      ['Paged Pool', m.paged_pool_bytes, share(m.paged_pool_bytes, T), '#7c3aed', 'of RAM']]),
    [linux ? 'Swap Usage' : 'Page File Usage', m.swap_used_bytes, share(m.swap_used_bytes, m.swap_total_bytes), '#2563eb', linux ? 'of swap' : 'of page file'],
  ];
  return (
    <ul className="space-y-2.5 text-[12.5px]">
      {rows.map(([k, b, p, c, basis]) => (
        <li key={k} className="grid grid-cols-[1fr_auto_88px] items-center gap-2" title={`Percentage basis: ${basis}`}>
          <span className="min-w-0 text-muted"><span className="block truncate">{k}</span>{basis !== 'of RAM' && <span className="block truncate text-[10.5px] text-subtle">% {basis}</span>}</span>
          <span className="whitespace-nowrap tabular-nums text-fg"><b>{fmtBytes(b)}</b>{p != null && <span className="text-muted"> ({p.toFixed(1)}%)</span>}</span>
          <span className="h-2 overflow-hidden rounded-full bg-sunken"><span className="block h-full rounded-full" style={{ width: `${Math.min(100, p ?? 0)}%`, background: c }} /></span>
        </li>
      ))}
    </ul>
  );
}

export function PageFaultChart({ data, platform, selectedT, height = 170 }) {
  const pts = data.filter((d) => d.page_faults_ps != null || d.major_faults_ps != null);
  if (!pts.length) return <Empty title="Page faults not reported">This host's collector has not reported page-fault counters yet.</Empty>;
  const fmt = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}K` : `${Math.round(v)}`);
  return (
    <>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={pts} margin={{ top: 6, right: 8, bottom: 0, left: -8 }}>
            <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
            <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={tShort} tick={{ fontSize: 10.5, fill: 'var(--fg-muted)' }} stroke="var(--border)" minTickGap={36} />
            <YAxis tickFormatter={fmt} tick={{ fontSize: 10.5, fill: 'var(--fg-muted)' }} stroke="var(--border)" width={44} />
            <Tooltip labelFormatter={tSec} formatter={(v, n) => [`${Math.round(v).toLocaleString()} /s`, n]} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
            <Area type="monotone" dataKey="page_faults_ps" name="All page faults" stroke="#7c3aed" fill="#7c3aed" fillOpacity={0.18} strokeWidth={1.8} dot={false} isAnimationActive={false} />
            <Area type="monotone" dataKey="major_faults_ps" name={platform === 'linux' ? 'Major faults' : 'Hard faults (Pages Input)'} stroke="#dc2626" fill="#dc2626" fillOpacity={0.12} strokeWidth={1.5} dot={false} isAnimationActive={false} />
            {selectedT != null && <ReferenceLine x={selectedT} stroke="#7c3aed" strokeDasharray="3 3" />}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-[10.5px] text-subtle">Faults per second, averaged per interval. Most faults are soft (resolved in RAM); only hard/major faults read from disk.</p>
    </>
  );
}

const LEVEL = { Critical: 'bg-[#dc2626]', High: 'bg-[#f97316]', Warning: 'bg-[#f59e0b]', Info: 'bg-[#2563eb]' };
const LEVEL_TXT = { Critical: 'text-danger-fg bg-danger-soft', High: 'text-[#c2410c] bg-[#ffedd5]', Warning: 'text-warning-fg bg-warning-soft', Info: 'text-accent bg-accent-soft' };

export function EventsTable({ events, loading, hostName, onPick, max = 6 }) {
  if (loading) return <Skeleton className="h-32" />;
  if (!events?.length) return <Empty icon="check" title="No pressure events in this range">The pressure score never crossed a threshold.</Empty>;
  return (
    <table className="w-full text-[12.5px]">
      <thead><tr className="border-b border-border text-left text-[11.5px] text-muted"><th className="py-1.5 font-semibold">Time</th><th className="font-semibold">Level</th><th className="font-semibold">Message</th></tr></thead>
      <tbody>
        {events.slice(0, max).map((e) => (
          <tr key={`${e.t}-${e.level}`} className="cursor-pointer border-b border-border last:border-0 hover:bg-raised" onClick={() => onPick?.(e.t)} title={`${hostName} · value ${e.value}% · threshold ${e.threshold}%`}>
            <td className="whitespace-nowrap py-1.5 pr-2 text-fg">{tLong(e.t)}</td>
            <td className="pr-2"><span className={cn('inline-flex items-center gap-1.5 rounded px-1.5 text-[11.5px] font-semibold', LEVEL_TXT[e.level])}><span className={cn('h-2 w-2 rounded-full', LEVEL[e.level])} />{e.level}</span></td>
            <td className="text-fg">{e.message}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function MiniStat({ icon, tone, label, value, sub, sub2 }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-lg border border-border bg-surface p-2.5">
      <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-lg', tone)}><Icon name={icon} size={19} /></span>
      <div className="min-w-0">
        <div className="text-[11.5px] leading-tight text-muted">{label}</div>
        <div className="truncate text-[17px] font-bold leading-tight text-fg">{value}</div>
        {sub && <div className="text-[11.5px] leading-tight text-muted">{sub}</div>}
        {sub2 && <div className="truncate text-[11px] text-subtle">{sub2}</div>}
      </div>
    </div>
  );
}
