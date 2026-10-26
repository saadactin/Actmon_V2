import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useSelectAt, useTimeContext } from '../_shared/useTimeContext';
import { useQuery } from '@tanstack/react-query';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ReferenceDot, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import { OsMark } from '@/components/dashboard/TopHostsCard';
import { getHostInfraDetail, getOsServer } from '@/api/servers';
import { getMetricsHistory, listAgents } from '@/api/agents';
import { bandFor, statusOf, UTILISATION_BANDS } from '@/components/charts/status';
import { BUCKET_LABEL, fmtDuration, freshness, RANGES, splitWindows, stats, toSeries } from './cpuAnalysis';
import CpuCategoryPanel from './CpuCategoryPanel';
import ProcessDrawer from './ProcessDrawer';
import { getCpuProcessesAt } from '@/api/cpu';

/**
 * CPU Performance for ONE host (route /cpu-performance/:hostId). Every value is real and for this host only:
 *   host       GET /os-servers/{id}                 org-scoped: another org's host is "not found", nothing else is fetched
 *   live       GET /os-servers/{id}/infra-detail     current CPU, processes (+threads), cpu_detail: model/cores/per-core,
 *                                                    time split and event rates (one sample per collection), load / queue
 *   history    GET /metrics/history/{server_name}?kind=infra&tech=host   ClickHouse metrics_infra.host_cpu
 *   agent      GET /agents/                          agent version for agent-collected hosts (matched by host name)
 *   stored     GET /cpu/{id}/processes?at=…  top-CPU processes at a past collection; /cpu/{id}/categories CPU time split
 * Not collected (shown as N/A / unavailable, never guessed): process start time on Windows, command line, open files.
 */

const ORANGE = '#f97316';
const pct = (v, d = 1) => (v == null || Number.isNaN(Number(v)) ? 'N/A' : `${Number(v).toFixed(d)}%`);
const fmtNum = (v) => (v == null ? 'N/A' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const tShort = (ms) => (ms == null ? 'N/A' : new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
const tLong = (ms) => (ms == null ? 'N/A' : new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
const num = (v) => { const n = parseFloat(String(v ?? '').replace('%', '')); return Number.isFinite(n) ? n : null; };
const isoMs = (s) => (s ? Date.parse(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`) : null);

/* ── building blocks ─────────────────────────────────────────────────────── */
function Panel({ icon, title, sub, actions, className, bodyClass, children }) {
  return (
    <section className={cn('card flex min-w-0 flex-col', className)}>
      <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
        <div className="flex min-w-0 items-center gap-2.5">
          {icon && <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent-soft text-accent"><Icon name={icon} size={17} /></span>}
          <div className="min-w-0">
            <h2 className="truncate text-[15.5px] font-semibold text-fg">{title}</h2>
            {sub && <p className="truncate text-[11.5px] text-muted">{sub}</p>}
          </div>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      <div className={cn('min-h-0 flex-1 px-5 pb-4', bodyClass)}>{children}</div>
    </section>
  );
}

function Skeleton({ className }) { return <div className={cn('animate-pulse rounded-md bg-sunken', className)} />; }

function Empty({ icon = 'info', title, children, className }) {
  return (
    <div className={cn('flex h-full flex-col items-center justify-center gap-1.5 py-6 text-center', className)}>
      <Icon name={icon} size={20} className="text-subtle" />
      <div className="text-[13px] font-semibold text-fg">{title}</div>
      {children && <div className="max-w-sm text-[12px] text-muted">{children}</div>}
    </div>
  );
}

function Spark({ points, color }) {
  if (!points || points.length < 2) return <div className="h-9 w-24" />;
  return (
    <div className="h-9 w-24">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points}><Line type="monotone" dataKey="v" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} /></LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function Delta({ value, suffix }) {
  if (value == null || Number.isNaN(value)) return <span className="text-muted">{suffix ? `— ${suffix}` : '—'}</span>;
  const up = value > 0;
  return (
    <span>
      <span className={cn('font-semibold', up ? 'text-danger-fg' : 'text-success-fg')}>{up ? '↑' : '↓'} {Math.abs(value).toFixed(1)} pts</span>
      {suffix && <span className="ml-1 text-muted">{suffix}</span>}
    </span>
  );
}

function StatCard({ icon, tone, label, value, children }) {
  return (
    <div className="card flex min-h-[132px] gap-3 p-4">
      <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-lg', tone)}><Icon name={icon} size={22} /></span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-fg">{label}</div>
        <div className="mt-1.5 text-[27px] font-bold leading-none text-fg tabular-nums">{value}</div>
        <div className="mt-2.5">{children}</div>
      </div>
    </div>
  );
}

function Toggle({ on, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
      className={cn('relative h-5 w-9 rounded-full transition-colors', on ? 'bg-accent' : 'bg-strong')}>
      <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', on ? 'left-[18px]' : 'left-0.5')} />
    </button>
  );
}

const ctl = 'inline-flex h-9 items-center gap-2 rounded-control border border-border bg-surface px-3 text-[13px] text-fg hover:bg-raised';

/* ── page ───────────────────────────────────────────────────────────────── */
export default function CpuPerformance() {
  const { hostId } = useParams();
  const navigate = useNavigate();
  const tc = useTimeContext(RANGES);
  const [rangeIdx, setRangeIdx] = useState(tc.idx);
  const range = RANGES[rangeIdx];
  const [bucket, setBucket] = useState(tc.bucket);
  const [auto, setAuto] = useState(true);
  const [kind, setKind] = useState('line');
  const [wide, setWide] = useState(null);                // 'trend' | 'cores' | null
  const [selected, setSelected] = useState(null);
  const [procSort, setProcSort] = useState({ key: 'cpu', dir: -1 });
  const [showAll, setShowAll] = useState(false);
  const [openPid, setOpenPid] = useState(null);
  const [openSnap, setOpenSnap] = useState(null);   // keeps the drawer filled if the process leaves the list

  const validId = /^\d+$/.test(String(hostId || ''));
  const hostQ = useQuery({ queryKey: ['cpuPerf', 'host', hostId], queryFn: () => getOsServer(hostId), enabled: validId, retry: (n, e) => n < 1 && !/not found/i.test(e?.message || '') });
  const host = hostQ.data?.data;
  const liveQ = useQuery({ queryKey: ['cpuPerf', 'live', hostId], queryFn: () => getHostInfraDetail(hostId), enabled: Boolean(host), refetchInterval: auto ? 30_000 : false });
  const histQ = useQuery({
    queryKey: ['cpuPerf', 'history', host?.server_name, range.minutes, bucket],
    queryFn: () => getMetricsHistory(host.server_name, { minutes: range.minutes * 2, bucketSeconds: bucket || undefined, kind: 'infra', tech: 'host' }),
    enabled: Boolean(host?.server_name), refetchInterval: auto ? 60_000 : false,
  });
  const agentsQ = useQuery({ queryKey: ['cpuPerf', 'agents'], queryFn: listAgents, enabled: host?.collector === 'agent', staleTime: 5 * 60_000 });

  const all = useMemo(() => toSeries(histQ.data?.samples), [histQ.data]);
  const { previous, current } = useMemo(() => splitWindows(all, range.minutes, histQ.dataUpdatedAt || Date.now()), [all, range.minutes, histQ.dataUpdatedAt]);
  useSelectAt(tc.at, current, setSelected, Math.max(120_000, (bucket || 15) * 1000));   // opened "at this point" from another page
  const st = useMemo(() => stats(current), [current]);
  const prevSt = useMemo(() => stats(previous), [previous]);
  const live = liveQ.data;
  const cd = live?.cpu_detail || null;
  const liveCpu = num(live?.cpu_pct);
  const latest = current[current.length - 1] || null;
  const fresh = freshness(latest?.t ?? isoMs(host?.last_infra_at), { collector: host?.collector });
  const osName = live?.system?.os || host?.os_type || '';
  const isWindows = /win/i.test(osName || host?.os_type || '');
  const agent = useMemo(() => {
    const names = [host?.server_name, host?.hostname, host?.ip_address].filter(Boolean).map((s) => String(s).toLowerCase());
    return (agentsQ.data || []).find((a) => names.includes(String(a.hostname || '').toLowerCase()) || names.includes(String(a.name || '').toLowerCase()));
  }, [agentsQ.data, host]);
  const atQ = useQuery({
    queryKey: ['cpuPerf', 'procsAt', hostId, selected?.t],
    queryFn: () => getCpuProcessesAt(hostId, selected.t),
    enabled: Boolean(host && selected?.t), retry: false, staleTime: 300_000,
  });
  const stored = selected && atQ.data?.ts ? atQ.data : null;
  const nowList = Array.isArray(live?.procs_now) && live.procs_now.length ? live.procs_now : null;   // Linux: 0.5 s sample
  const procSource = stored ? 'stored' : nowList ? 'now' : 'snapshot';
  const procs = useMemo(() => (stored
    ? stored.processes.map((p, i) => ({ key: `${p.pid}-${i}`, pid: p.pid, name: p.name || '?', user: p.user_name || '', cpu: num(p.cpu_pct), mem: num(p.mem_pct), threads: p.threads ?? null, instances: null, running_s: p.running_s ?? null }))
    : (nowList || (Array.isArray(live?.processes) ? live.processes : [])).map((p, i) => ({
      key: `${p.pid}-${i}`, pid: Number(p.pid), name: p.command || p.name || '?', user: p.user || '', cpu: num(p.cpu), mem: num(p.mem),
      threads: p.threads ?? null, instances: p.instances ?? null, running_s: p.running_s ?? null,
    }))), [live, nowList, stored]);
  const procsSorted = useMemo(() => [...procs].sort((a, b) => {
    const k = procSort.key; const x = a[k] ?? -1; const y = b[k] ?? -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * procSort.dir;
  }), [procs, procSort]);
  const spark = (n) => current.slice(-n).map((p) => ({ v: p.v }));

  // ── unrecoverable states
  if (!validId) return <Shell><Empty icon="alert" title="Invalid host id">“{hostId}” is not a host id.</Empty></Shell>;
  if (hostQ.isLoading) return <Shell><Skeleton className="h-16" /><Skeleton className="h-20" /><Skeleton className="h-32" /><Skeleton className="h-80" /></Shell>;
  if (hostQ.isError || !host) {
    const msg = hostQ.error?.message || '';
    return (
      <Shell>
        <Empty icon="alert" title={/not found/i.test(msg) ? 'Host not found' : /401|403|auth|permission/i.test(msg) ? 'Not allowed' : 'Could not load this host'}>
          {/not found/i.test(msg) ? 'This host does not exist or is not in your organisation.' : msg}
          <div className="mt-3"><Link to="/infra/hosts" className="text-accent hover:underline">Back to Infrastructure</Link></div>
        </Empty>
      </Shell>
    );
  }

  const hostStatus = statusOf(host.status);
  const online = hostStatus.id === 'good';
  const chartData = current.map((p) => ({ t: p.t, v: Math.round(p.v * 10) / 10 }));
  const histErr = histQ.isError ? histQ.error?.message || 'History request failed' : null;
  const refresh = () => { hostQ.refetch(); liveQ.refetch(); histQ.refetch(); if (agentsQ.isFetched) agentsQ.refetch(); };
  const ghz = cd?.max_mhz ? `${(cd.max_mhz / 1000).toFixed(2)} GHz` : null;
  const ramGb = live?.memory?.total_mb ? `${(live.memory.total_mb / 1024).toFixed(1)} GB RAM` : null;
  const procShown = showAll ? procsSorted : procsSorted.slice(0, 5);
  const openProc = openPid ? (procs.find((p) => p.pid === openPid) || openSnap) : null;

  return (
    <Shell>
      {/* breadcrumb + header */}
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-[13px] text-muted">
        <Link to="/infra/hosts" className="hover:text-fg">Infrastructure</Link>
        <Icon name="chevron-right" size={13} className="opacity-60" />
        <Link to={`/infra/${host.id}`} className="hover:text-fg">{host.server_name}</Link>
        <Icon name="chevron-right" size={13} className="opacity-60" />
        <span className="font-semibold text-fg" aria-current="page">CPU Performance</span>
      </nav>
      <div className="flex flex-wrap items-center gap-4">
        <button type="button" aria-label="Back" onClick={() => navigate(-1)} className="grid h-10 w-10 place-items-center rounded-control border border-border bg-surface text-fg hover:bg-raised">
          <Icon name="arrow-left" size={17} />
        </button>
        <span className="grid h-12 w-12 place-items-center rounded-lg bg-sunken text-muted"><Icon name="cpu" size={24} /></span>
        <div className="min-w-0">
          <h1 className="text-[26px] font-bold leading-tight text-fg">CPU Performance</h1>
          <p className="text-[13.5px] text-muted">Real-time CPU consumption, utilization trends, process activity, and performance diagnostics.</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Link to={`/infra/${host.id}`} className={ctl}><Icon name="external" size={15} /> Open in Host Overview</Link>
          <button type="button" className={ctl} onClick={refresh}>
            <Icon name="refresh" size={15} className={cn((liveQ.isFetching || histQ.isFetching) && 'animate-spin')} /> Refresh
          </button>
          <span className={ctl}><Icon name="clock" size={15} /> Auto Refresh <Toggle on={auto} onChange={setAuto} label="Auto refresh" /></span>
          <select aria-label="Time range" value={rangeIdx} className={ctl}
            onChange={(e) => { const i = Number(e.target.value); setRangeIdx(i); setBucket(RANGES[i].buckets.includes(bucket) ? bucket : RANGES[i].buckets[0]); setSelected(null); }}>
            {RANGES.map((r, i) => <option key={r.minutes} value={i}>{r.label}</option>)}
          </select>
          <select aria-label="Aggregation interval" value={bucket} className={ctl} onChange={(e) => { setBucket(Number(e.target.value)); setSelected(null); }}>
            {range.buckets.map((b) => <option key={b} value={b}>{BUCKET_LABEL[b]}</option>)}
          </select>
        </div>
      </div>

      {/* host card */}
      <div className="card flex flex-wrap items-center gap-x-8 gap-y-4 px-5 py-4">
        <div className="flex min-w-0 items-center gap-4">
          <span className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-info-soft"><OsMark os={osName || host.os_type} size={30} /></span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-[20px] font-bold text-fg">{host.server_name}</span>
              <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-semibold',
                online ? 'bg-success-soft text-success-fg' : 'bg-danger-soft text-danger-fg')}>
                <span className="h-2 w-2 rounded-full" style={{ background: hostStatus.color }} />{online ? 'Online' : (host.status || 'Unknown')}
              </span>
              {fresh.state === 'stale' && <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2.5 py-0.5 text-[12px] font-semibold text-warning-fg"><Icon name="alert" size={12} />Data stale</span>}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-2 text-[13.5px] text-muted">
              <span>{osName || 'OS not reported'}</span><span>•</span><span>Host ID: {host.id}</span><span>•</span><span>IP: {host.ip_address || 'N/A'}</span>
              <span>•</span><span>{host.collector === 'agent' ? `Agent ${agent?.agent_version ? `v${String(agent.agent_version).replace(/^v/, '')}` : 'version N/A'}` : 'Collected over SSH'}</span>
              {live?.uptime && <><span>•</span><span>Uptime: {String(live.uptime).replace(/^up\s+/, '')}</span></>}
            </div>
            <div className="mt-0.5 text-[12px] text-subtle">
              {fresh.state === 'none' ? 'No samples collected yet' : `Last sample ${tLong(latest?.t ?? isoMs(host.last_infra_at))} (${fmtDuration(fresh.ageMs)} ago)`}
            </div>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-4 border-l border-border pl-8">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent"><Icon name="cpu" size={24} /></span>
          <div>
            <div className="text-[16px] font-semibold text-fg">{cd?.model || 'CPU model not reported'}</div>
            <div className="mt-0.5 text-[13px] text-muted">
              {[ghz, cd?.physical_cores ? `${cd.physical_cores} Core${cd.physical_cores === 1 ? "" : "s"}` : null, cd?.logical ? `${cd.logical} Threads` : null, ramGb].filter(Boolean).join(' • ') || (liveQ.isLoading ? 'Loading…' : 'Details not reported yet')}
            </div>
          </div>
        </div>
      </div>

      {/* summary */}
      <div className="grid gap-gutter-lg sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <StatCard icon="cpu" tone="bg-success-soft text-success-fg" label="Current CPU Usage" value={liveQ.isLoading ? '…' : pct(liveCpu)}>
          <div className="flex items-end justify-between gap-2 text-[12px]">
            <div><Delta value={liveCpu != null && prevSt ? liveCpu - prevSt.avg : null} suffix={`vs previous ${range.label.replace('Last ', '')}`} /></div>
            <Spark points={spark(30)} color="#16a34a" />
          </div>
        </StatCard>
        <StatCard icon="activity" tone="bg-accent-soft text-accent" label="Average CPU Usage" value={pct(st?.avg)}>
          <div className="flex items-end justify-between gap-2 text-[12px]">
            <div><Delta value={st && prevSt ? st.avg - prevSt.avg : null} suffix={st ? `vs previous ${range.label.replace('Last ', '')}` : 'no samples'} /></div>
            <Spark points={spark(60)} color="#2563eb" />
          </div>
        </StatCard>
        <StatCard icon="cpu" tone="bg-danger-soft text-danger-fg" label="Peak CPU Usage" value={pct(st?.peak?.v)}>
          <div className="flex items-end justify-between gap-2 text-[12px]">
            <div><Delta value={st && prevSt ? st.peak.v - prevSt.peak.v : null} /><div className="text-muted">{st?.peak ? `at ${tShort(st.peak.t)}` : 'no samples'}</div></div>
            <Spark points={spark(60)} color="#dc2626" />
          </div>
        </StatCard>
        <StatCard icon="cpu" tone="bg-success-soft text-success-fg" label="Minimum CPU Usage" value={pct(st?.min?.v)}>
          <div className="flex items-end justify-between gap-2 text-[12px]">
            <div><Delta value={st && prevSt ? st.min.v - prevSt.min.v : null} /><div className="text-muted">{st?.min ? `at ${tShort(st.min.t)}` : 'no samples'}</div></div>
            <Spark points={spark(60)} color="#16a34a" />
          </div>
        </StatCard>
        <StatCard icon="layout-grid" tone="bg-[#f3e8ff] text-[#7c3aed]" label="Logical Processors" value={cd?.logical ?? 'N/A'}>
          <div className="text-[12.5px]">
            <div className="font-semibold text-fg">{cd?.physical_cores ? `${cd.physical_cores} Physical Core${cd.physical_cores === 1 ? "" : "s"}` : 'Physical cores N/A'}</div>
            <div className="truncate text-muted" title={cd?.model || ''}>{cd?.model || 'CPU model not reported'}</div>
          </div>
        </StatCard>
        <StatCard icon="gauge" tone="bg-warning-soft text-warning-fg" label={isWindows ? 'Processor Queue' : 'Load Average'} value={isWindows ? fmtNum(live?.queue_length) : (live?.load ? Number(live.load.one).toFixed(2) : 'N/A')}>
          {isWindows ? (
            <div className="text-[12px] text-muted">Threads waiting for a core. Windows has no Unix load average.</div>
          ) : live?.load ? (
            <div className="grid grid-cols-[1fr_auto] gap-x-4 text-[12.5px]">
              <span className="text-muted">1 min</span><b className="tabular-nums text-fg">{Number(live.load.one).toFixed(2)}</b>
              <span className="text-muted">5 min</span><b className="tabular-nums text-fg">{Number(live.load.five).toFixed(2)}</b>
              <span className="text-muted">15 min</span><b className="tabular-nums text-fg">{Number(live.load.fifteen).toFixed(2)}</b>
            </div>
          ) : <div className="text-[12px] text-muted">Not reported for this host.</div>}
        </StatCard>
      </div>

      {/* trend + cores */}
      <div className={cn('grid gap-gutter-lg', wide ? 'grid-cols-1' : 'xl:grid-cols-[1.75fr_1fr]')}>
        {wide !== 'cores' && (
          <Panel icon="activity" title="CPU Utilization Trend"
            sub={`${range.label} · ${BUCKET_LABEL[bucket]}${st ? ` · ${st.count} samples` : ''} · click a point to select it`}
            actions={(
              <>
                <select aria-label="Chart type" value={kind} onChange={(e) => setKind(e.target.value)} className={ctl}>
                  <option value="line">Line Chart</option><option value="area">Area Chart</option>
                </select>
                <button type="button" aria-label={wide ? 'Collapse chart' : 'Expand chart'} className="grid h-9 w-9 place-items-center rounded-control text-muted hover:bg-raised" onClick={() => setWide(wide ? null : 'trend')}><Icon name={wide ? "collapse" : "expand"} size={16} /></button>
              </>
            )}>
            {histQ.isLoading ? <Skeleton className="h-64" />
              : histErr ? <Empty icon="alert" title="CPU history could not be loaded">{histErr}</Empty>
                : !chartData.length ? <Empty title="No CPU samples in this range">No CPU readings were stored for {host.server_name} in the {range.label.toLowerCase()}.</Empty>
                  : (
                    <div className={wide ? 'h-[420px]' : 'h-64'}>
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={chartData} margin={{ top: 10, right: 12, bottom: 0, left: -14 }} style={{ cursor: 'crosshair' }}
                          onClick={(e) => { const p = e?.activePayload?.[0]?.payload; if (p) setSelected(p); }}>
                          <defs>
                            <linearGradient id="cpuOrange" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor={ORANGE} stopOpacity={kind === 'area' ? 0.35 : 0.16} /><stop offset="100%" stopColor={ORANGE} stopOpacity={0.02} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                          <ReferenceLine y={90} stroke="var(--status-critical)" strokeDasharray="5 4" />
                          <ReferenceLine y={75} stroke="var(--status-serious)" strokeDasharray="5 4" />
                          <ReferenceLine y={60} stroke="var(--status-warning)" strokeDasharray="5 4" />
                          <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={(t) => (range.minutes > 1440 ? tLong(t) : tShort(t))}
                            tick={{ fontSize: 11, fill: 'var(--fg-muted)' }} stroke="var(--border)" minTickGap={40} />
                          <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11, fill: 'var(--fg-muted)' }} stroke="var(--border)" />
                          <Tooltip labelFormatter={(t) => tLong(t)} formatter={(v) => [`${v}%`, 'CPU usage']} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                          <Area type="monotone" dataKey="v" stroke={ORANGE} strokeWidth={2} fill="url(#cpuOrange)" isAnimationActive={false}
                            dot={kind === 'line' && chartData.length <= 90 ? { r: 2, fill: ORANGE, strokeWidth: 0 } : false} activeDot={{ r: 5 }} />
                          {selected && <ReferenceLine x={selected.t} stroke="var(--fg-muted)" strokeDasharray="3 3" />}
                          {selected && <ReferenceDot x={selected.t} y={selected.v} r={6} fill={ORANGE} stroke="#fff" strokeWidth={2} />}
                          {latest && <ReferenceDot x={latest.t} y={Math.round(latest.v * 10) / 10} r={4} fill={ORANGE} stroke="#fff" />}
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  )}
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
              <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: ORANGE }} />CPU Usage</span>
              {UTILISATION_BANDS.map((b) => <span key={b.id} className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: b.color }} />{b.label}</span>)}
              {selected && (
                <span className="ml-auto inline-flex items-center gap-2 font-semibold text-fg">
                  Selected {tLong(selected.t)} · {selected.v}%
                  <button type="button" className="text-accent hover:underline" onClick={() => setSelected(null)}>Clear</button>
                </span>
              )}
            </div>
          </Panel>
        )}

        {wide !== 'trend' && (
          <Panel icon="layers" title="CPU Usage by Core"
            sub={cd?.per_core?.length ? `${cd.per_core.length} logical processors · one ${cd.sample_s || 1}s sample · ${liveQ.dataUpdatedAt ? tLong(liveQ.dataUpdatedAt) : ''}` : 'Latest sample'}
            actions={<button type="button" aria-label={wide ? 'Collapse chart' : 'Expand chart'} className="grid h-9 w-9 place-items-center rounded-control text-muted hover:bg-raised" onClick={() => setWide(wide ? null : 'cores')}><Icon name={wide ? "collapse" : "expand"} size={16} /></button>}>
            {liveQ.isLoading ? <Skeleton className="h-64" />
              : liveQ.isError ? <Empty icon="alert" title="Live data could not be loaded">{liveQ.error?.message}</Empty>
                : !cd?.per_core?.length ? (
                  <Empty title="Per-core usage not reported yet">The collector reports per-core CPU from its next cycle on (updated collector). Overall CPU is never split across cores artificially.</Empty>
                ) : (
                  <div className={wide ? 'h-[420px]' : 'h-64'}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={cd.per_core.map((c) => ({ id: String(c.id), pct: c.pct }))} margin={{ top: 10, right: 8, bottom: 0, left: -14 }}>
                        <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                        <XAxis dataKey="id" tick={{ fontSize: 11, fill: 'var(--fg-muted)' }} stroke="var(--border)" interval={0} />
                        <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11, fill: 'var(--fg-muted)' }} stroke="var(--border)" />
                        <Tooltip formatter={(v) => [`${v}%`, 'Utilization']} labelFormatter={(l) => `Processor ${l}`} contentStyle={{ fontSize: 12, borderRadius: 8 }} cursor={{ fill: 'var(--surface-sunken)' }} />
                        <Bar dataKey="pct" fill="#2f7cf6" radius={[3, 3, 0, 0]} maxBarSize={26} isAnimationActive={false} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
          </Panel>
        )}
      </div>

      {/* processes, categories, metrics */}
      <div className="grid gap-gutter-lg xl:grid-cols-[1.35fr_1.5fr_1fr]">
        <Panel icon="list" title="Top CPU Consuming Processes"
          sub={selected
            ? (atQ.isLoading ? `Loading processes stored at ${tShort(selected.t)}…`
              : stored ? `Stored at ${tLong(stored.ts)} (selected point)` : `Nothing stored near ${tShort(selected.t)} — showing the latest snapshot`)
            : `Latest snapshot${liveQ.dataUpdatedAt ? ` · ${tLong(liveQ.dataUpdatedAt)}` : ''}`}
          actions={procs.length > 5 && <button type="button" className="text-[13px] font-semibold text-accent hover:underline" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show Top 5' : 'View All'}</button>}>
          {liveQ.isLoading ? <Skeleton className="h-48" />
            : liveQ.isError ? <Empty icon="alert" title="Processes could not be loaded">{liveQ.error?.message}</Empty>
              : !procs.length ? <Empty title="No process snapshot">The collector has not reported processes for this host.</Empty>
                : (
                  <>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[13px]">
                        <thead>
                          <tr className="border-b border-border text-left text-[12px] text-muted">
                            {[['#', null], ['Process Name', 'name'], ['PID', 'pid'], ['CPU Usage', 'cpu'], ['Threads', 'threads'], ['User', 'user']].map(([label, k]) => (
                              <th key={label} className="px-2 py-2 font-semibold">
                                {k ? <button type="button" className="inline-flex items-center gap-1 hover:text-fg" onClick={() => setProcSort((s) => ({ key: k, dir: s.key === k ? -s.dir : -1 }))}>
                                  {label}{procSort.key === k && <Icon name={procSort.dir < 0 ? 'chevron-down' : 'chevron-up'} size={12} />}</button> : label}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {procShown.map((p, i) => {
                            const band = p.cpu != null ? bandFor(p.cpu) : null;
                            return (
                              <tr key={p.key} onClick={() => { setOpenPid(p.pid); setOpenSnap(p); }} aria-selected={openPid === p.pid}
                                className={cn('cursor-pointer border-b border-border last:border-0 hover:bg-raised', openPid === p.pid && 'bg-accent-soft ring-1 ring-inset ring-accent')}>
                                <td className="px-2 py-2 text-muted">{i + 1}</td>
                                <td className="px-2 py-2 font-medium text-fg">{p.name}{p.instances > 1 && <span className="ml-1 text-[11px] text-subtle">×{p.instances}</span>}</td>
                                <td className="px-2 py-2 tabular-nums text-muted">{p.pid}</td>
                                <td className="px-2 py-2">
                                  <div className="flex items-center gap-2">
                                    <span className="w-12 tabular-nums text-fg">{pct(p.cpu)}</span>
                                    <span className="h-1.5 w-28 overflow-hidden rounded-full bg-sunken"><span className="block h-full rounded-full" style={{ width: `${Math.min(100, p.cpu ?? 0)}%`, background: band?.color }} /></span>
                                  </div>
                                </td>
                                <td className="px-2 py-2 tabular-nums text-fg">{p.threads ?? 'N/A'}</td>
                                <td className="px-2 py-2 text-muted">{p.user || 'N/A'}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <p className="mt-2 text-[11px] text-subtle">
                      {isWindows ? 'CPU = share of total CPU across all cores, sampled over 0.4 s; same-name processes grouped.'
                        : procSource === 'snapshot' ? `CPU = share of the whole host (all ${cd?.logical || ''} cores = 100%), averaged since the process started (current sampling arrives with the next collector cycle).`
                          : `CPU = share of the whole host, measured over 0.5 s (all ${cd?.logical || ''} cores = 100%).`} Click a process for details. Read-only view.
                    </p>
                  </>
                )}
        </Panel>

        <CpuCategoryPanel hostId={host.id} cd={cd} isWindows={isWindows} liveCpu={liveCpu} liveUpdatedAt={liveQ.dataUpdatedAt}
          procsNow={nowList || (isWindows && Array.isArray(live?.processes) ? live.processes : null)}
          onOpenProcess={(p) => { const n = { key: `d-${p.pid}`, pid: Number(p.pid), name: p.command || p.name || '?', user: p.user || '', cpu: num(p.cpu), mem: num(p.mem), threads: p.threads ?? null, instances: p.instances ?? null, running_s: p.running_s ?? null }; setOpenPid(n.pid); setOpenSnap(n); }}
          onRefresh={() => liveQ.refetch()} refreshing={liveQ.isFetching} />

        <Panel icon="list" title="CPU Metrics" sub={cd ? `One ${cd.sample_s || 1}s sample · ${liveQ.dataUpdatedAt ? tLong(liveQ.dataUpdatedAt) : ''}` : 'Latest sample'}>
          {liveQ.isLoading ? <Skeleton className="h-48" />
            : !cd ? <Empty title="Not reported yet">CPU counters arrive with the collector's next cycle (updated collector).</Empty>
              : (
                <table className="w-full text-[13px]">
                  <thead><tr className="border-b border-border text-left text-[12px] text-muted"><th className="py-1.5 font-semibold">Metric</th><th className="py-1.5 text-right font-semibold">Value</th></tr></thead>
                  <tbody>
                    {(isWindows ? [
                      ['Context Switches/sec', fmtNum(cd.context_switches_per_s)],
                      ['CPU Interrupts/sec', fmtNum(cd.interrupts_per_s)],
                      ['DPCs Queued/sec', fmtNum(cd.dpcs_per_s)],
                      ['Processor Queue Length', fmtNum(live?.queue_length)],
                      ['Privileged (Kernel) Time', pct(cd.privileged_pct)],
                      ['User Time', pct(cd.user_pct)],
                      ['Interrupt Time', pct(cd.interrupt_pct)],
                      ['DPC Time', pct(cd.dpc_pct)],
                      ['CPU Utilization', pct(liveCpu)],
                    ] : [
                      ['Context Switches/sec', fmtNum(cd.context_switches_per_s)],
                      ['Interrupts/sec', fmtNum(cd.interrupts_per_s)],
                      ['Runnable Tasks', fmtNum(cd.runnable_tasks)],
                      ['User Time', pct(cd.user_pct)],
                      ['System (Kernel) Time', pct(cd.system_pct)],
                      ['I/O Wait', pct(cd.iowait_pct)],
                      ['IRQ + SoftIRQ', pct(cd.irq_pct)],
                      ['Steal', pct(cd.steal_pct)],
                      ['Idle', pct(cd.idle_pct)],
                    ]).map(([k, v]) => (
                      <tr key={k} className="border-b border-border last:border-0"><td className="py-1.5 text-fg">{k}</td><td className="py-1.5 text-right tabular-nums font-medium text-fg">{v}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
        </Panel>
      </div>
      {openProc && (
        <ProcessDrawer hostId={host.id} proc={openProc} isWindows={isWindows} cores={cd?.logical} stale={!procs.some((p) => p.pid === openProc.pid)}
          onClose={() => setOpenPid(null)} onRefresh={() => liveQ.refetch()} refreshing={liveQ.isFetching} />
      )}
    </Shell>
  );
}

function Shell({ children }) {
  return <div className="flex flex-col gap-gutter-lg">{children}</div>;
}
