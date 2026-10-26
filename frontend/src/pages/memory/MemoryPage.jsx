import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useSelectAt, useTimeContext } from '../_shared/useTimeContext';
import { useQuery } from '@tanstack/react-query';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import { OsMark } from '@/components/dashboard/TopHostsCard';
import { statusOf } from '@/components/charts/status';
import { getHostInfraDetail, getOsServer } from '@/api/servers';
import { listAgents } from '@/api/agents';
import { getMemoryAnalysis, getMemoryHistory, getMemorySnapshot, getProcessMemoryHistory, getTopProcessTimeline } from '@/api/memory';
import { fmtDuration, freshness } from '../cpu/cpuAnalysis';
import { BUCKET_LABEL, RANGES, breakdown, fmtBytes, normProc, pct, share, splitWindows } from './memoryUtil';
import {
  ComponentBars, Delta, Donut, Empty, EventsTable, MiniStat, PageFaultChart, Panel, ProcessDetails, ProcessTable, ProcessTimeline,
  Skeleton, Spark, StatCard, TrendChart, TrendLegend, ctl, tLong, tSec, tShort,
} from './memoryParts';

/**
 * Memory Analysis / Memory Pressure for ONE host — /memory/:hostId/:tab?. Real data only:
 *   GET /os-servers/{id}              host identity (org-scoped: another org's host = not found, nothing else fetched)
 *   GET /os-servers/{id}/infra-detail live mem_detail + mem_procs (latest collection)
 *   GET /memory/{id}/history          ClickHouse host_memory_metrics, bucketed; stats over raw samples
 *   GET /memory/{id}/snapshot?at=     stored processes + components at the clicked time (nearest within tolerance)
 *   GET /memory/{id}/process-history  one process instance (pid + name + start time)
 *   GET /memory/{id}/top-processes    top-N process timeline
 *   GET /memory/{id}/analysis         events (hysteresis), duration above threshold, leaks (heuristic), recommendations
 *   GET /agents/                      agent version
 * "Memory pressure" is a CALCULATED score (see backend memory_service) — labelled as such, never as an OS metric.
 */

const TABS = {
  '': 'Memory Analysis', processes: 'Process Analysis', pressure: 'Memory Pressure', 'per-process': 'Per-Process Usage',
  system: 'System Metrics', swap: 'Swap & Page File', leaks: 'Memory Leaks', recommendations: 'Recommendations',
};
const SET_A = ['', 'processes', 'pressure', 'per-process', 'system', 'recommendations'];
const SET_B = ['', 'processes', 'pressure', 'per-process', 'swap', 'leaks', 'recommendations'];
const BLUE = '#2563eb';
const RED = '#ef4444';

function Toggle({ on, onChange }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label="Auto refresh" onClick={() => onChange(!on)}
      className={cn('relative h-5 w-9 rounded-full transition-colors', on ? 'bg-accent' : 'bg-strong')}>
      <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', on ? 'left-[18px]' : 'left-0.5')} />
    </button>
  );
}

export default function MemoryPage() {
  const { hostId, tab: tabParam } = useParams();
  const tab = tabParam && TABS[tabParam] ? tabParam : '';
  const navigate = useNavigate();
  const tc = useTimeContext(RANGES);
  const [rangeIdx, setRangeIdx] = useState(tc.idx);
  const range = RANGES[rangeIdx];
  const [bucket, setBucket] = useState(tc.bucket);
  const [auto, setAuto] = useState(true);
  const [kind, setKind] = useState('line');
  const [wide, setWide] = useState(false);
  const [selected, setSelected] = useState(null);         // a history point {t, ...}
  const [proc, setProc] = useState(null);                 // normalised process row
  const [topN, setTopN] = useState(5);
  const [tlMode, setTlMode] = useState('stacked');
  const [, setTick] = useState(0);                        // re-render each minute so the header range moves

  const validId = /^\d+$/.test(String(hostId || ''));
  const hostQ = useQuery({ queryKey: ['mem', 'host', hostId], queryFn: () => getOsServer(hostId), enabled: validId, retry: (n, e) => n < 1 && !/not found/i.test(e?.message || '') });
  const host = hostQ.data?.data;
  const id = host?.id;
  const live = useQuery({ queryKey: ['mem', 'live', id], queryFn: () => getHostInfraDetail(id), enabled: Boolean(id), refetchInterval: auto ? 30_000 : false });
  const histQ = useQuery({ queryKey: ['mem', 'hist', id, range.minutes, bucket], queryFn: () => getMemoryHistory(id, { minutes: range.minutes, bucket }), enabled: Boolean(id), refetchInterval: auto ? 60_000 : false });
  const anaQ = useQuery({ queryKey: ['mem', 'analysis', id, range.minutes, bucket], queryFn: () => getMemoryAnalysis(id, { minutes: range.minutes, bucket: bucket || 60 }), enabled: Boolean(id), refetchInterval: auto ? 60_000 : false });
  const needTimeline = ['', 'pressure', 'per-process'].includes(tab);
  const tlQ = useQuery({ queryKey: ['mem', 'timeline', id, range.minutes, bucket, topN], queryFn: () => getTopProcessTimeline(id, { minutes: range.minutes, bucket: bucket || 60, n: topN }), enabled: Boolean(id) && needTimeline, refetchInterval: auto ? 60_000 : false });
  const snapAt = selected ? selected.t + ((bucket || 0) * 1000) / 2 : null;
  const snapQ = useQuery({ queryKey: ['mem', 'snap', id, snapAt], queryFn: () => getMemorySnapshot(id, snapAt), enabled: Boolean(id) && snapAt != null, staleTime: Infinity });
  const phQ = useQuery({
    queryKey: ['mem', 'proc', id, proc?.pid, proc?.name, proc?.start_t, range.minutes, bucket],
    queryFn: () => getProcessMemoryHistory(id, { pid: proc.pid, name: proc.name, start: proc.start_t, minutes: range.minutes, bucket: bucket || 60 }),
    enabled: Boolean(id && proc), refetchInterval: auto ? 60_000 : false,
  });
  const agentsQ = useQuery({ queryKey: ['mem', 'agents'], queryFn: listAgents, enabled: host?.collector === 'agent', staleTime: 5 * 60_000 });
  useEffect(() => { const h = setInterval(() => setTick((x) => x + 1), 60_000); return () => clearInterval(h); }, []);

  const L = live.data;
  const md = L?.mem_detail || null;
  const platform = md?.platform || (/win/i.test(L?.system?.os || host?.os_type || '') ? 'windows' : 'linux');
  const samples = histQ.data?.samples || [];
  const { current } = useMemo(() => splitWindows(samples, range.minutes, histQ.dataUpdatedAt || Date.now()), [samples, range.minutes, histQ.dataUpdatedAt]);
  useSelectAt(tc.at, current, setSelected, Math.max(120_000, (bucket || 15) * 1000));   // opened "at this point" from another page
  const st = histQ.data?.stats?.current || null;
  const prev = histQ.data?.stats?.previous || null;
  const liveProcs = useMemo(() => (L?.mem_procs || []).map((p) => normProc(p, md?.total_bytes)), [L, md]);
  const snapProcs = useMemo(() => (snapQ.data?.processes || []).map((p) => normProc(p, snapQ.data?.host?.total_bytes || md?.total_bytes)), [snapQ.data, md]);
  const procs = selected ? snapProcs : liveProcs;
  const agent = useMemo(() => {
    const names = [host?.server_name, host?.hostname, host?.ip_address].filter(Boolean).map((s) => String(s).toLowerCase());
    return (agentsQ.data || []).find((a) => names.includes(String(a.hostname || '').toLowerCase()) || names.includes(String(a.name || '').toLowerCase()));
  }, [agentsQ.data, host]);
  const atMem = selected ? (snapQ.data?.host ? { ...snapQ.data.host, platform } : null) : md;
  const bd = useMemo(() => breakdown(atMem), [atMem]);

  // ── unrecoverable states
  if (!validId) return <Shell><Empty icon="alert" title="Invalid host id">“{hostId}” is not a host id.</Empty></Shell>;
  if (hostQ.isLoading) return <Shell><Skeleton className="h-16" /><Skeleton className="h-10" /><Skeleton className="h-28" /><Skeleton className="h-80" /></Shell>;
  if (hostQ.isError || !host) {
    const msg = hostQ.error?.message || '';
    return (
      <Shell>
        <Empty icon="alert" title={/not found/i.test(msg) ? 'Host not found' : 'Could not load this host'}>
          {/not found/i.test(msg) ? 'This host does not exist or is not in your organisation.' : msg}
          <div className="mt-3"><Link to="/infra/hosts" className="text-accent hover:underline">Back to Infrastructure</Link></div>
        </Empty>
      </Shell>
    );
  }

  const hs = statusOf(host.status);
  const online = hs.id === 'good';
  const lastMs = Date.parse(/Z|[+-]\d\d:?\d\d$/.test(host.last_infra_at || '') ? host.last_infra_at : `${host.last_infra_at}Z`) || null;
  const fresh = freshness(lastMs, { collector: host.collector });
  const pressureScreen = ['pressure', 'swap', 'leaks'].includes(tab);
  const tabSet = pressureScreen ? SET_B : SET_A;
  const go = (t) => navigate(`/memory/${host.id}${t ? `/${t}` : ''}`);
  const refresh = () => { live.refetch(); histQ.refetch(); anaQ.refetch(); if (needTimeline) tlQ.refetch(); if (proc) phQ.refetch(); };
  const nowMs = Date.now();   // the 1-minute tick below re-renders, so the header range keeps moving
  const histErr = histQ.isError ? histQ.error?.message : null;
  const chart = current;
  const pickPoint = (p) => { setSelected(p); };
  const clear = () => setSelected(null);
  const curUsed = md?.used_pct ?? L?.memory?.used_pct ?? null;
  const swapLbl = platform === 'linux' ? 'Swap' : 'Page File';
  const vsPrev = `vs previous ${range.short}`;
  const spark = (k) => current.slice(-40).map((p) => ({ v: p[k] }));
  const ana = anaQ.data;

  const procTitle = selected
    ? <h3 className="mr-auto flex items-center gap-2 text-[14.5px] font-semibold text-fg"><span className="grid h-7 w-7 place-items-center rounded-md bg-accent-soft text-accent"><Icon name="list" size={15} /></span>Processes at Selected Time <span className="font-normal text-muted">({tSec(snapQ.data?.sample_t ?? selected.t)})</span></h3>
    : <h3 className="mr-auto flex items-center gap-2 text-[14.5px] font-semibold text-fg"><span className="grid h-7 w-7 place-items-center rounded-md bg-accent-soft text-accent"><Icon name="list" size={15} /></span>{pressureScreen ? 'Top Processes by Memory Usage' : 'Processes at Selected Time'} <span className="font-normal text-muted">(latest collection{L ? '' : ''})</span></h3>;
  const procEmpty = selected
    ? <Empty title="No process sample stored for this time">{`No collection within ±${snapQ.data?.tolerance_s ?? 90} s of ${tSec(selected.t)}. Current processes are not shown in its place.`}</Empty>
    : <Empty title="No process memory reported yet">The updated collector reports the top processes by memory from its next cycle.</Empty>;

  const tipAnalysis = (p) => [
    ['Memory Usage', pct(p.used_pct), BLUE],
    ['Memory Pressure (score)', pct(p.pressure_score), '#a21caf'],
    ['Used Memory', fmtBytes(p.used_bytes), '#0f766e'],
    ['Available Memory', `${fmtBytes(p.available_bytes)}${p.total_bytes ? ` (${pct(share(p.available_bytes, p.total_bytes))})` : ''}`, '#f59e0b'],
    ['Cached Memory', fmtBytes(p.cached_bytes), '#f97316'],
    ['Committed Memory', fmtBytes(p.committed_bytes), '#dc2626'],
    [`${swapLbl} Usage`, `${fmtBytes(p.swap_used_bytes)}${p.swap_total_bytes ? ` (${pct(share(p.swap_used_bytes, p.swap_total_bytes))})` : ''}`, '#7c3aed'],
  ];
  const tipPressure = (p) => [
    ['Memory Pressure (score)', pct(p.pressure_score), RED],
    ['Used Memory', fmtBytes(p.used_bytes), BLUE],
    ['Available Memory', fmtBytes(p.available_bytes), '#16a34a'],
    ['Cached Memory', fmtBytes(p.cached_bytes), '#f59e0b'],
    [`${swapLbl} Usage`, fmtBytes(p.swap_used_bytes), '#ef4444'],
    ...(p.psi_some_avg10 != null ? [['PSI some avg10 (OS)', pct(p.psi_some_avg10, 2), '#64748b']] : []),
  ];

  const trendPanel = (isPressure) => {
    const color = isPressure ? RED : BLUE;
    return (
      <Panel icon={isPressure ? 'gauge' : 'activity'} title={isPressure ? 'Memory Pressure Trend' : 'Memory Utilization Trend'}
        sub={`${range.label} · ${BUCKET_LABEL[bucket]}${st ? ` · ${st.n} samples` : ''}${isPressure ? ' · calculated score: max(100 − available %, commit charge %)' : ''}`}
        actions={(
          <>
            <select aria-label="Chart type" value={kind} onChange={(e) => setKind(e.target.value)} className={cn(ctl, 'h-8')}><option value="line">Line Chart</option><option value="area">Area Chart</option></select>
            <button type="button" aria-label={wide ? 'Collapse chart' : 'Expand chart'} className="grid h-8 w-8 place-items-center rounded-control text-muted hover:bg-raised" onClick={() => setWide(!wide)}><Icon name={wide ? 'collapse' : 'expand'} size={15} /></button>
          </>
        )}>
        {histQ.isLoading ? <Skeleton className="h-60" />
          : histErr ? <Empty icon="alert" title="Memory history could not be loaded">{histErr}</Empty>
            : !chart.length ? <Empty title="No memory samples in this range">No memory history was stored for {host.server_name} in the {range.label.toLowerCase()}. History starts with the updated collector.</Empty>
              : <TrendChart data={chart} dataKey={isPressure ? 'pressure_score' : 'used_pct'} color={color} kind={kind} height={wide ? 400 : 228}
                  selected={selected} onSelect={pickPoint} tooltipRows={isPressure ? tipPressure : tipAnalysis} rangeMinutes={range.minutes} />}
        <TrendLegend color={color} label={isPressure ? 'Memory Pressure' : 'Memory Usage'} selected={selected} onClear={clear} />
      </Panel>
    );
  };

  const breakdownPanel = (
    <Panel icon="chart-donut" title={`Memory Usage Breakdown (at ${selected ? tShort(snapQ.data?.host?.t ?? selected.t) : tShort(live.dataUpdatedAt || null)})`}
      sub={selected ? (snapQ.isLoading ? 'Loading stored components…' : snapQ.data?.host ? 'Stored collection nearest the selected time' : 'No stored collection near the selected time') : 'Latest collection'}>
      {(selected ? snapQ.isLoading : live.isLoading) ? <Skeleton className="h-44" />
        : selected && !snapQ.data?.host ? <Empty title="No stored components for this time">{`Nothing was collected within ±${snapQ.data?.tolerance_s ?? 90} s of ${tSec(selected.t)}.`}</Empty>
          : <Donut bd={bd} centerValue={pct(atMem?.used_pct)} centerLabel="Used Memory" />}
      {bd && <p className="mt-2 text-[10.5px] text-subtle">Slices are disjoint OS components and add up to {fmtBytes(bd.total)}{bd.parts.some((p) => p.id === 'hw') ? ' installed' : ''}; “Used Memory” = (total − available) / total.</p>}
    </Panel>
  );

  const processPanel = (compact) => (
    <Panel className="h-full" bodyClass="pt-1">
      <ProcessTable procs={procs} selectedPid={proc?.pid} onPick={setProc} compact={compact} title={procTitle}
        csvName={`${host.server_name}-processes-${selected ? new Date(snapQ.data?.sample_t ?? selected.t).toISOString() : 'latest'}.csv`}
        loading={selected ? snapQ.isLoading : live.isLoading} emptyNode={procEmpty} />
    </Panel>
  );

  const detailsPanel = (
    <Panel icon="box" title={proc ? `Process Details (${proc.name})` : 'Process Details'} sub={proc ? `PID ${proc.pid}${selected ? ` · as collected ${tSec(snapQ.data?.sample_t)}` : ' · latest collection'}` : 'Select a process'}>
      <ProcessDetails proc={proc} history={phQ.data?.points} historyLoading={phQ.isLoading && Boolean(proc)} selectedT={selected?.t} onClose={proc ? () => setProc(null) : null}
        rangeLabel={range.short === 'hour' ? '1h' : range.short} platform={platform} />
    </Panel>
  );

  const timelinePanel = (title, height) => (
    <Panel icon="chart-line" title={title} sub={`${range.label} · working set per process name (instances summed)`}
      actions={(
        <>
          <select aria-label="Number of processes" value={topN} onChange={(e) => setTopN(Number(e.target.value))} className={cn(ctl, 'h-8')}>
            {[3, 5, 10].map((n) => <option key={n} value={n}>Top {n} Processes</option>)}
          </select>
          <select aria-label="Timeline view" value={tlMode} onChange={(e) => setTlMode(e.target.value)} className={cn(ctl, 'h-8')}>
            <option value="stacked">Stacked View</option><option value="lines">Line View</option>
          </select>
        </>
      )}>
      {tlQ.isError ? <Empty icon="alert" title="Process timeline could not be loaded">{tlQ.error?.message}</Empty>
        : <ProcessTimeline data={tlQ.data} loading={tlQ.isLoading} mode={tlMode} height={height} selectedT={selected?.t} />}
    </Panel>
  );

  const above = ana?.above_threshold;
  const aboveTxt = above?.seconds ? fmtDuration(above.seconds * 1000) : '0 min';
  const aboveSub = above?.first_t ? `${tShort(above.first_t)} – ${tShort(above.last_t)}` : `never ≥ ${ana?.threshold ?? 75}%`;
  const swapPeak = st?.swap_used_max != null && st?.swap_total ? (100 * st.swap_used_max) / st.swap_total : null;
  const analysisPanel = (isPressure) => (
    <Panel icon={isPressure ? 'gauge' : 'activity'} title="Memory Pressure Analysis" sub={`${range.label} · from stored samples`}
      actions={<button type="button" className={cn(ctl, 'h-8 text-accent')} onClick={() => go('recommendations')}>View Full Analysis</button>}>
      {anaQ.isLoading ? <Skeleton className="h-20" /> : anaQ.isError ? <Empty icon="alert" title="Analysis unavailable">{anaQ.error?.message}</Empty> : !st ? <Empty title="No samples in this range" /> : (
        <div className={cn('grid gap-2.5', isPressure ? 'grid-cols-2' : 'grid-cols-2 lg:grid-cols-5')}>
          {isPressure
            ? <MiniStat icon="activity" tone="bg-danger-soft text-danger-fg" label="Peak Pressure" value={pct(st.pr_max)} sub={tLong(st.pr_max_t)} />
            : <MiniStat icon="activity" tone="bg-danger-soft text-danger-fg" label="Peak Memory Usage" value={pct(st.used_max)} sub={tLong(st.used_max_t)} />}
          <MiniStat icon="clock" tone="bg-accent-soft text-accent" label="Duration Above Threshold" value={aboveTxt} sub={aboveSub} sub2={`pressure ≥ ${ana?.threshold}%`} />
          <MiniStat icon="cpu" tone="bg-danger-soft text-danger-fg" label={isPressure ? 'Top Process' : 'Top Memory Process'} value={ana?.top_process?.name || 'N/A'} sub={ana?.top_process ? `${fmtBytes(ana.top_process.ws_max)} at peak` : 'no process history'} />
          {!isPressure && <MiniStat icon="database" tone="bg-success-soft text-success-fg" label="Available Memory (Min)" value={fmtBytes(st.avail_min)} sub={`at ${tShort(st.avail_min_t)}`} />}
          <MiniStat icon="folder" tone="bg-warning-soft text-warning-fg" label={`${swapLbl} Usage (Peak)`} value={pct(swapPeak)} sub={st.swap_total ? `${fmtBytes(st.swap_used_max)} of ${fmtBytes(st.swap_total)}` : `no ${swapLbl.toLowerCase()} configured`} />
        </div>
      )}
    </Panel>
  );

  const usageCards = (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
      <StatCard icon="memory" tone="bg-info-soft text-accent" label="Current Memory Usage" value={live.isLoading ? '…' : pct(curUsed)} spark={<Spark points={spark('used_pct')} color="#dc2626" />}>
        <Delta value={curUsed != null && prev ? curUsed - prev.used_avg : null} suffix={vsPrev} />
      </StatCard>
      <StatCard icon="memory" tone="bg-accent-soft text-accent" label="Average Memory Usage" value={pct(st?.used_avg)} spark={<Spark points={spark('used_pct')} color={BLUE} />}>
        <Delta value={st && prev ? st.used_avg - prev.used_avg : null} suffix={st ? vsPrev : 'no samples'} />
      </StatCard>
      <StatCard icon="memory" tone="bg-danger-soft text-danger-fg" label="Peak Memory Usage" value={pct(st?.used_max)} spark={<Spark points={spark('used_pct')} color="#dc2626" />}>
        <Delta value={st && prev ? st.used_max - prev.used_max : null} suffix={st ? `at ${tShort(st.used_max_t)}` : 'no samples'} />
      </StatCard>
      <StatCard icon="memory" tone="bg-success-soft text-success-fg" label="Minimum Memory Usage" value={pct(st?.used_min)} spark={<Spark points={spark('used_pct')} color="#16a34a" />}>
        <Delta value={st && prev ? st.used_min - prev.used_min : null} suffix={st ? `at ${tShort(st.used_min_t)}` : 'no samples'} />
      </StatCard>
      <PhysCard md={md} L={L} />
      <SwapCard md={md} label={swapLbl} />
    </div>
  );
  const pressureCards = (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
      <StatCard icon="memory" tone="bg-info-soft text-accent" label="Current Memory Pressure" sub="calculated score" value={live.isLoading ? '…' : pct(md?.pressure_score)} spark={<Spark points={spark('pressure_score')} color="#dc2626" />}>
        <Delta value={md?.pressure_score != null && prev ? md.pressure_score - prev.pr_avg : null} suffix={vsPrev} />
      </StatCard>
      <StatCard icon="memory" tone="bg-accent-soft text-accent" label="Average Memory Pressure" sub="calculated score" value={pct(st?.pr_avg)} spark={<Spark points={spark('pressure_score')} color={BLUE} />}>
        <Delta value={st && prev ? st.pr_avg - prev.pr_avg : null} suffix={st ? vsPrev : 'no samples'} />
      </StatCard>
      <StatCard icon="memory" tone="bg-danger-soft text-danger-fg" label="Peak Memory Pressure" sub="calculated score" value={pct(st?.pr_max)} spark={<Spark points={spark('pressure_score')} color="#dc2626" />}>
        <Delta value={st && prev ? st.pr_max - prev.pr_max : null} suffix={st ? `at ${tShort(st.pr_max_t)}` : 'no samples'} />
      </StatCard>
      <StatCard icon="memory" tone="bg-success-soft text-success-fg" label="Minimum Memory Pressure" sub="calculated score" value={pct(st?.pr_min)} spark={<Spark points={spark('pressure_score')} color="#16a34a" />}>
        <Delta value={st && prev ? st.pr_min - prev.pr_min : null} suffix={st ? `at ${tShort(st.pr_min_t)}` : 'no samples'} />
      </StatCard>
      <PhysCard md={md} L={L} />
      <SwapCard md={md} label={swapLbl} />
    </div>
  );

  return (
    <Shell>
      {/* header */}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" aria-label="Back" onClick={() => navigate(-1)} className="grid h-10 w-10 place-items-center rounded-full border border-border bg-surface text-muted hover:bg-raised"><Icon name="arrow-left" size={17} /></button>
        <span className="grid h-11 w-11 place-items-center rounded-lg border border-border bg-surface text-muted"><Icon name="chart-bar" size={22} /></span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[22px] font-bold leading-tight text-fg">{pressureScreen ? 'Memory Pressure' : 'Memory Consumption'} - {host.server_name}</h1>
            <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-semibold', online ? 'bg-success-soft text-success-fg' : 'bg-danger-soft text-danger-fg')}>
              <span className="h-2 w-2 rounded-full" style={{ background: hs.color }} />{online ? 'Online' : (host.status || 'Offline')}
            </span>
            {fresh.state === 'stale' && <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2.5 py-0.5 text-[12px] font-semibold text-warning-fg"><Icon name="alert" size={12} />Data stale · last {fmtDuration(fresh.ageMs)} ago</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
            <OsMark os={L?.system?.os || host.os_type} size={14} /><span>{L?.system?.os || host.os_type || 'OS not reported'}</span>
            <span>•</span><span>Host ID: {host.id}</span><span>•</span><span>IP: {host.ip_address || 'N/A'}</span>
            <span>•</span><span>{host.collector === 'agent' ? `Agent: ${agent?.agent_version ? `v${String(agent.agent_version).replace(/^v/, '')}` : 'version N/A'}` : 'Collected over SSH'}</span>
            {L?.uptime && <><span>•</span><span>Uptime: {String(L.uptime).replace(/^up\s+/, '')}</span></>}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Link to={`/infra/${host.id}`} className={ctl}><Icon name="external" size={15} /> Open in Infrastructure</Link>
          <button type="button" className={ctl} onClick={refresh}><Icon name="refresh" size={15} className={cn((live.isFetching || histQ.isFetching) && 'animate-spin')} /> Refresh</button>
          <span className={cn(ctl, auto && 'text-accent')}><Toggle on={auto} onChange={setAuto} /> Auto Refresh</span>
          <select aria-label="Time range" value={rangeIdx} className={ctl}
            onChange={(e) => { const i = Number(e.target.value); setRangeIdx(i); setBucket(RANGES[i].buckets.includes(bucket) ? bucket : RANGES[i].buckets[0]); setSelected(null); }}>
            {RANGES.map((r, i) => <option key={r.minutes} value={i}>{r.label}</option>)}
          </select>
          <select aria-label="Aggregation interval" value={bucket} className={ctl} onChange={(e) => { setBucket(Number(e.target.value)); setSelected(null); }}>
            {range.buckets.map((b) => <option key={b} value={b}>{BUCKET_LABEL[b]}</option>)}
          </select>
          <span className={cn(ctl, 'cursor-default text-[11.5px] leading-tight')} title="Displayed range (local time)">
            <Icon name="calendar" size={15} /><span>{tLong(nowMs - range.minutes * 60000)}<br />{tLong(nowMs)}</span>
          </span>
          <button type="button" aria-label="Reset selection" title="Clear the selected time and process" className="grid h-9 w-9 place-items-center rounded-control border border-border bg-surface text-muted hover:bg-raised" onClick={() => { setSelected(null); setProc(null); }}><Icon name="restart" size={15} /></button>
        </div>
      </div>

      {/* tabs */}
      <nav className="flex gap-1 overflow-x-auto border-b border-border" aria-label="Memory views">
        {tabSet.map((t) => (
          <button key={t || 'analysis'} type="button" onClick={() => go(t)} aria-current={tab === t ? 'page' : undefined}
            className={cn('whitespace-nowrap rounded-t-md border-b-2 px-4 py-2.5 text-[14px]', tab === t ? 'border-accent bg-accent-soft font-semibold text-accent' : 'border-transparent text-fg hover:bg-raised')}>
            {TABS[t]}
          </button>
        ))}
      </nav>

      {tab === '' && (
        <>
          {usageCards}
          <div className={cn('grid gap-3', wide ? '' : 'xl:grid-cols-[1.72fr_1fr]')}>{trendPanel(false)}{!wide && breakdownPanel}</div>
          <div className="grid gap-3 xl:grid-cols-[1.32fr_1fr]">{processPanel(true)}{detailsPanel}</div>
          <div className="grid gap-3 xl:grid-cols-[1.32fr_1fr]">{analysisPanel(false)}{timelinePanel('Process Memory Activity Timeline (Top Processes)', 130)}</div>
        </>
      )}

      {tab === 'pressure' && (
        <>
          {pressureCards}
          <div className={cn('grid gap-3', wide ? '' : 'xl:grid-cols-[1.72fr_1fr]')}>{trendPanel(true)}{!wide && breakdownPanel}</div>
          <div className="grid gap-3 xl:grid-cols-[1.9fr_0.8fr_0.85fr]">
            {processPanel(true)}
            <Panel icon="layers" title="Memory Pressure Components" sub={selected ? `Stored at ${tSec(snapQ.data?.host?.t)}` : 'Latest collection'}>
              <ComponentBars m={atMem} />
            </Panel>
            <Panel icon="activity" title={`Memory Page Faults (${range.short === 'hour' ? '1h' : range.short})`} sub={`${BUCKET_LABEL[bucket]} · faults/s`}>
              {histQ.isLoading ? <Skeleton className="h-40" /> : <PageFaultChart data={chart} platform={platform} selectedT={selected?.t} />}
            </Panel>
          </div>
          <div className="grid gap-3 xl:grid-cols-[1fr_0.95fr_1.2fr]">
            <Panel icon="alert" title="Memory Pressure Events" sub={`Threshold crossings in the ${range.label.toLowerCase()} · hysteresis ${ana?.hysteresis ?? 5} pts`}>
              <EventsTable events={ana?.events} loading={anaQ.isLoading} hostName={host.server_name} onPick={(t) => setSelected(chart.reduce((b, p) => (!b || Math.abs(p.t - t) < Math.abs(b.t - t) ? p : b), null))} />
            </Panel>
            {analysisPanel(true)}
            {timelinePanel('Memory Pressure Timeline (Top Processes)', 150)}
          </div>
        </>
      )}

      {tab === 'processes' && (
        <>
          <div className="grid gap-3 xl:grid-cols-[1.4fr_1fr]">{processPanel(false)}{detailsPanel}</div>
          <p className="text-[12px] text-muted">Click a point on the Memory Analysis or Memory Pressure trend to load the processes stored for that time; the selection carries across tabs.</p>
        </>
      )}

      {tab === 'per-process' && (
        <>
          {timelinePanel('Per-Process Memory Usage (Top Processes)', 320)}
          <div className="grid gap-3 xl:grid-cols-[1.4fr_1fr]">{processPanel(false)}{detailsPanel}</div>
        </>
      )}

      {tab === 'system' && <SystemMetrics md={md} st={st} platform={platform} loading={live.isLoading} updated={live.dataUpdatedAt} />}

      {tab === 'swap' && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MiniStat icon="folder" tone="bg-warning-soft text-warning-fg" label={`${swapLbl} Size`} value={fmtBytes(md?.swap_total_bytes)} sub={md?.swap_total_bytes === 0 ? `no ${swapLbl.toLowerCase()} configured` : 'configured'} />
            <MiniStat icon="folder" tone="bg-accent-soft text-accent" label={`${swapLbl} Used (now)`} value={fmtBytes(md?.swap_used_bytes)} sub={pct(share(md?.swap_used_bytes, md?.swap_total_bytes))} />
            <MiniStat icon="folder" tone="bg-danger-soft text-danger-fg" label={`${swapLbl} Used (peak in range)`} value={fmtBytes(st?.swap_used_max)} sub={st?.swap_used_max_t ? `at ${tShort(st.swap_used_max_t)}` : 'no samples'} />
            <MiniStat icon="activity" tone="bg-success-soft text-success-fg" label={platform === 'linux' ? 'Swap-in / Swap-out (now)' : 'Hard faults (now)'} value={platform === 'linux' ? `${md?.swap_in_ps ?? 'N/A'} / ${md?.swap_out_ps ?? 'N/A'} pages/s` : `${md?.major_faults_ps != null ? Math.round(md.major_faults_ps) : 'N/A'} /s`} sub={platform === 'linux' ? 'pswpin / pswpout' : 'Memory\\Pages Input/sec'} />
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            <Panel icon="chart-line" title={`${swapLbl} Usage`} sub={`${range.label} · % of ${swapLbl.toLowerCase()} size`}>
              <SwapChart data={chart} />
            </Panel>
            <Panel icon="activity" title="Paging Activity" sub={`${range.label} · faults/s`}>
              <PageFaultChart data={chart} platform={platform} selectedT={selected?.t} height={240} />
            </Panel>
          </div>
        </>
      )}

      {tab === 'leaks' && <Leaks ana={ana} loading={anaQ.isLoading} error={anaQ.isError ? anaQ.error?.message : null} range={range} />}

      {tab === 'recommendations' && <Recommendations ana={ana} loading={anaQ.isLoading} error={anaQ.isError ? anaQ.error?.message : null} range={range} />}
    </Shell>
  );
}

function PhysCard({ md, L }) {
  const total = md?.total_bytes ?? (L?.memory?.total_mb != null ? L.memory.total_mb * 1048576 : null);
  return (
    <div className="card flex min-h-[112px] gap-3 p-3.5">
      <div className="flex flex-col gap-2">
        <span className="grid h-11 w-11 place-items-center rounded-lg bg-[#f3e8ff] text-[#7c3aed]"><Icon name="layout-grid" size={22} /></span>
        <span className="grid h-11 w-11 place-items-center rounded-lg bg-info-soft text-accent"><Icon name="memory" size={20} /></span>
      </div>
      <div className="min-w-0">
        <div className="text-[12.5px] font-semibold text-fg">Physical Memory</div>
        <div className="mt-1 text-[25px] font-bold leading-none text-fg">{fmtBytes(md?.installed_bytes ?? total)}</div>
        {md?.installed_bytes && md.installed_bytes > (total || 0) && <div className="mt-0.5 text-[10.5px] text-subtle">{fmtBytes(total)} usable</div>}
        <div className="mt-2 text-[12.5px] leading-snug"><b className="text-fg">{fmtBytes(md?.used_bytes)}</b> <span className="text-muted">Used</span><br /><b className="text-fg">{fmtBytes(md?.available_bytes)}</b> <span className="text-muted">Available</span></div>
      </div>
    </div>
  );
}

function SwapCard({ md, label }) {
  const p = share(md?.swap_used_bytes, md?.swap_total_bytes);
  return (
    <div className="card flex min-h-[112px] gap-3 p-3.5">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-warning-soft text-warning-fg"><Icon name="folder" size={22} /></span>
      <div className="min-w-0">
        <div className="text-[12.5px] font-semibold text-fg">{label === 'Swap' ? 'Swap' : 'Swap / Page File'}</div>
        <div className="mt-1 text-[25px] font-bold leading-none text-fg">{md ? (md.swap_total_bytes === 0 ? 'None' : fmtBytes(md.swap_total_bytes)) : 'N/A'}</div>
        <div className="mt-2 text-[12.5px] leading-snug">
          {md?.swap_total_bytes === 0 ? <span className="text-muted">No {label.toLowerCase()} configured</span> : (
            <><b className="text-fg">{fmtBytes(md?.swap_used_bytes)}</b> <span className="text-muted">Used</span><br /><b className="text-fg">{pct(p)}</b> <span className="text-muted">Usage</span></>
          )}
        </div>
      </div>
    </div>
  );
}

function SwapChart({ data }) {
  const pts = data.map((d) => ({ t: d.t, v: d.swap_total_bytes ? (100 * d.swap_used_bytes) / d.swap_total_bytes : null }));
  if (!pts.some((p) => p.v != null)) return <Empty title="No swap / page-file samples">Either none is configured or the collector has not reported it.</Empty>;
  return <TrendChart data={pts} dataKey="v" color="#f59e0b" kind="area" height={240} selected={null} onSelect={() => {}} tooltipRows={(p) => [['Usage', pct(p.v), '#f59e0b']]} rangeMinutes={60} />;
}

function SystemMetrics({ md, st, platform, loading, updated }) {
  if (loading) return <Skeleton className="h-80" />;
  if (!md) return <Empty title="Memory counters not reported yet">They arrive with the updated collector's next cycle.</Empty>;
  const w = platform === 'windows';
  const rows = [
    ['Total visible memory', fmtBytes(md.total_bytes), w ? 'Win32_OperatingSystem.TotalVisibleMemorySize' : '/proc/meminfo MemTotal'],
    ...(w ? [['Installed memory', fmtBytes(md.installed_bytes), 'Win32_PhysicalMemory (sum of Capacity)'], ['Hardware reserved', fmtBytes(md.hardware_reserved_bytes), 'installed − visible']] : []),
    ['Available', fmtBytes(md.available_bytes), w ? '\\Memory\\Available Bytes' : 'MemAvailable'],
    ['Used (total − available)', `${fmtBytes(md.used_bytes)} (${pct(md.used_pct)})`, 'derived'],
    [w ? 'Free & zero page list' : 'Free', fmtBytes(md.free_bytes), w ? '\\Memory\\Free & Zero Page List Bytes' : 'MemFree'],
    [w ? 'Standby (cached)' : 'Buffers + Cached + SReclaimable', fmtBytes(md.cached_bytes), w ? '\\Memory\\Standby Cache * Bytes' : '/proc/meminfo'],
    ...(w ? [['Modified page list', fmtBytes(md.modified_bytes), '\\Memory\\Modified Page List Bytes'],
      ['Paged pool', fmtBytes(md.paged_pool_bytes), '\\Memory\\Pool Paged Bytes'], ['Non-paged pool', fmtBytes(md.nonpaged_pool_bytes), '\\Memory\\Pool Nonpaged Bytes']]
      : [['Buffers', fmtBytes(md.buffers_bytes), 'Buffers'], ['Shared (Shmem)', fmtBytes(md.shmem_bytes), 'Shmem']]),
    ['Committed', fmtBytes(md.committed_bytes), w ? '\\Memory\\Committed Bytes' : 'Committed_AS'],
    ['Commit limit', fmtBytes(md.commit_limit_bytes), w ? '\\Memory\\Commit Limit' : `CommitLimit${md.overcommit_mode != null ? ` (vm.overcommit_memory=${md.overcommit_mode}${md.overcommit_mode === 2 ? ', enforced' : ', not enforced'})` : ''}`],
    [w ? 'Page file size / used' : 'Swap size / used', `${fmtBytes(md.swap_total_bytes)} / ${fmtBytes(md.swap_used_bytes)}`, w ? 'Win32_PageFileUsage' : 'SwapTotal / SwapFree'],
    ...(w ? [['Page file peak usage', fmtBytes(md.swap_peak_bytes), 'Win32_PageFileUsage.PeakUsage (since boot)']] : []),
    ['Page faults/s (all)', md.page_faults_ps != null ? Math.round(md.page_faults_ps).toLocaleString() : 'N/A', w ? '\\Memory\\Page Faults/sec' : 'pgfault rate'],
    [w ? 'Hard faults/s (Pages Input/sec)' : 'Major faults/s', md.major_faults_ps != null ? Math.round(md.major_faults_ps).toLocaleString() : 'N/A', w ? '\\Memory\\Pages Input/sec' : 'pgmajfault rate'],
    ...(w ? [['Pages/s', md.pages_ps != null ? Math.round(md.pages_ps).toLocaleString() : 'N/A', '\\Memory\\Pages/sec']] : [
      ['Swap in / out (pages/s)', `${md.swap_in_ps ?? 'N/A'} / ${md.swap_out_ps ?? 'N/A'}`, 'pswpin / pswpout'],
      ['PSI memory some / full (avg10)', `${pct(md.psi_some_avg10, 2)} / ${pct(md.psi_full_avg10, 2)}`, '/proc/pressure/memory — OS-native pressure']]),
    ['Memory pressure score', pct(md.pressure_score), 'CALCULATED: max(100 − available %, commit %)'],
  ];
  return (
    <div className="grid gap-3 xl:grid-cols-[1.4fr_1fr]">
      <Panel icon="table" title="System Memory Metrics" sub={`Latest collection · ${tSec(updated)} · one ${md.sample_s}s sample for rates`}>
        <table className="w-full text-[13px]">
          <thead><tr className="border-b border-border text-left text-[12px] text-muted"><th className="py-1.5 font-semibold">Metric</th><th className="font-semibold">Value</th><th className="font-semibold">Source</th></tr></thead>
          <tbody>{rows.map(([k, v, s]) => <tr key={k} className="border-b border-border last:border-0"><td className="py-1.5 text-fg">{k}</td><td className="tabular-nums font-medium text-fg">{v}</td><td className="text-[11.5px] text-muted">{s}</td></tr>)}</tbody>
        </table>
      </Panel>
      <Panel icon="activity" title="Range Summary" sub="From stored samples">
        {!st ? <Empty title="No samples in this range" /> : (
          <dl className="grid grid-cols-[1fr_auto] gap-y-1.5 text-[13px]">
            {[['Samples', st.n], ['Average utilisation', pct(st.used_avg)], ['Peak utilisation', `${pct(st.used_max)} at ${tShort(st.used_max_t)}`],
              ['Minimum available', `${fmtBytes(st.avail_min)} at ${tShort(st.avail_min_t)}`], ['Average pressure score', pct(st.pr_avg)],
              ['Page faults/s avg / max', `${st.faults_avg != null ? Math.round(st.faults_avg).toLocaleString() : 'N/A'} / ${st.faults_max != null ? Math.round(st.faults_max).toLocaleString() : 'N/A'}`],
              [platform === 'windows' ? 'Hard faults/s avg / max' : 'Major faults/s avg / max', `${st.major_avg != null ? Math.round(st.major_avg) : 'N/A'} / ${st.major_max != null ? Math.round(st.major_max) : 'N/A'}`]].map(([k, v]) => (
              <Fragment key={k}><dt className="text-muted">{k}</dt><dd className="text-right font-medium tabular-nums text-fg">{v}</dd></Fragment>
            ))}
          </dl>
        )}
      </Panel>
    </div>
  );
}

function Leaks({ ana, loading, error, range }) {
  if (loading) return <Skeleton className="h-60" />;
  if (error) return <Empty icon="alert" title="Leak analysis unavailable">{error}</Empty>;
  return (
    <Panel icon="trend" title="Suspected Memory Leaks" sub={`${range.label} · heuristic, not proof`}>
      <p className="mb-3 text-[12.5px] text-muted">A process instance (same PID and start time) is flagged only when its private memory (working set where private bytes are not collected) grows steadily — correlation with time ≥ 0.9, at least +20% and +100 MB, over ≥ 20 samples covering at least half the range. Caches that warm up can match this pattern, so treat results as leads to investigate.</p>
      {!ana?.leaks?.length ? <Empty icon="check" title="No suspected leaks in this range">No process instance grew steadily enough to match the rule.</Empty> : (
        <table className="w-full text-[13px]">
          <thead><tr className="border-b border-border text-left text-[12px] text-muted">{['Process', 'PID', 'Basis', 'From', 'To', 'Growth', 'Rate', 'r', 'Samples'].map((h) => <th key={h} className="py-1.5 font-semibold">{h}</th>)}</tr></thead>
          <tbody>{ana.leaks.map((l) => (
            <tr key={`${l.pid}-${l.start_t}`} className="border-b border-border last:border-0">
              <td className="py-1.5 font-medium text-fg">{l.name}</td><td className="tabular-nums text-muted">{l.pid}</td><td className="text-muted">{l.basis}</td>
              <td className="tabular-nums">{fmtBytes(l.first_b)}</td><td className="tabular-nums">{fmtBytes(l.last_b)}</td>
              <td className="tabular-nums text-danger-fg">+{fmtBytes(l.growth_bytes)} ({l.growth_pct}%)</td>
              <td className="tabular-nums">{l.rate_bytes_per_h != null ? `${fmtBytes(l.rate_bytes_per_h)}/h` : 'N/A'}</td><td className="tabular-nums">{l.r?.toFixed(2)}</td><td className="tabular-nums">{l.n}</td>
            </tr>))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

const SEV = { Critical: 'bg-danger-soft text-danger-fg', High: 'bg-[#ffedd5] text-[#c2410c]', Warning: 'bg-warning-soft text-warning-fg', Info: 'bg-accent-soft text-accent' };
function Recommendations({ ana, loading, error, range }) {
  const [open, setOpen] = useState({});
  const [showRules, setShowRules] = useState(false);
  if (loading) return <Skeleton className="h-60" />;
  if (error) return <Empty icon="alert" title="Recommendations unavailable">{error}</Empty>;
  const recs = ana?.recommendations || [];
  const cat = ana?.rule_catalogue || [];
  const counts = ['Critical', 'High', 'Warning', 'Info'].map((s) => [s, recs.filter((r) => r.severity === s).length]);
  const healthy = recs.length === 1 && recs[0].rule === 'MEM-000';
  const BAR = { Critical: 'border-l-[#dc2626]', High: 'border-l-[#ea580c]', Warning: 'border-l-[#f59e0b]', Info: 'border-l-[#2563eb]' };
  const copy = (t) => { try { navigator.clipboard.writeText(t); } catch { /* clipboard blocked */ } };
  return (
    <Panel icon="sparkles" title="Recommendations" sub={`${range.label} · standard rule catalogue (MEM-001 … MEM-012), each based on measured evidence`}
      actions={<button type="button" className={cn(ctl, 'h-8')} onClick={() => setShowRules(!showRules)}><Icon name="list" size={13} />{showRules ? 'Hide' : 'Show'} rules checked ({cat.length})</button>}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {counts.map(([s, n]) => (
          <span key={s} className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold', n ? SEV[s] : 'bg-sunken text-subtle')}>{s} <b className="tabular-nums">{n}</b></span>
        ))}
        <span className="ml-auto text-[11.5px] text-muted">{healthy ? 'No rule found a problem in this range.' : `${recs.length} finding${recs.length === 1 ? '' : 's'}, most severe first`}</span>
      </div>

      {showRules && (
        <div className="mb-3 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-[12px]">
            <thead><tr className="bg-sunken text-left text-[11px] font-semibold text-muted"><th className="px-3 py-1.5">Rule</th><th className="px-3 py-1.5">Checks</th><th className="px-3 py-1.5">Fires when</th><th className="px-3 py-1.5">Result</th></tr></thead>
            <tbody>
              {cat.map((c) => {
                const hit = recs.find((r) => r.rule === c.rule);
                return (
                  <tr key={c.rule} className="border-t border-border">
                    <td className="px-3 py-1.5 font-mono font-semibold text-fg">{c.rule}</td><td className="px-3 py-1.5 text-fg">{c.name}</td>
                    <td className="px-3 py-1.5 text-muted">{c.threshold}</td>
                    <td className="px-3 py-1.5">{hit ? <span className={cn('rounded px-1.5 py-0.5 font-semibold', SEV[hit.severity])}>{hit.severity}</span> : <span className="text-success-fg">Passed</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!recs.length ? <Empty icon="check" title="No samples in this range">Recommendations need stored memory samples for the selected range.</Empty> : (
        <ul className="space-y-3">
          {recs.map((r) => {
            const key = `${r.rule}-${r.id}`;
            const steps = r.actions?.length ? r.actions : [r.action];
            return (
              <li key={key} className={cn('rounded-lg border border-l-4 border-border p-3.5', BAR[r.severity], r.rule === 'MEM-000' && 'bg-success-soft/40')}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn('rounded px-2 py-0.5 text-[11.5px] font-semibold', r.rule === 'MEM-000' ? 'bg-success-soft text-success-fg' : SEV[r.severity])}>{r.rule === 'MEM-000' ? 'Healthy' : r.severity}</span>
                  {r.rule && <span className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[11px] font-semibold text-muted">{r.rule}</span>}
                  {r.category && <span className="text-[11.5px] text-subtle">{r.category}</span>}
                  <b className="text-[14px] text-fg">{r.condition}</b>
                  {r.engine && <span className="rounded-full bg-[#f3e8ff] px-2 py-0.5 text-[11px] font-semibold text-[#7c3aed]">{r.engine}</span>}
                  <span className="ml-auto text-[11.5px] text-muted">{tLong(r.from_t)} – {tLong(r.to_t)}</span>
                </div>
                <dl className="mt-2 grid gap-x-3 gap-y-1.5 text-[12.5px] sm:grid-cols-[120px_1fr]">
                  <dt className="text-muted">Measured</dt><dd className="font-medium text-fg">{r.evidence}</dd>
                  <dt className="text-muted">Why it matters</dt><dd className="text-fg">{r.reason}</dd>
                  {r.standard && <><dt className="text-muted">Standard</dt><dd className="text-[12px] text-muted">{r.standard}</dd></>}
                  <dt className="text-muted">What to do</dt>
                  <dd>
                    <ol className="list-decimal space-y-0.5 pl-4 text-fg">{steps.map((s) => <li key={s}>{s}</li>)}</ol>
                  </dd>
                </dl>
                {r.commands?.length > 0 && (
                  <div className="mt-2">
                    <button type="button" className="inline-flex items-center gap-1 text-[12px] font-semibold text-accent hover:underline" onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}>
                      <Icon name={open[key] ? 'chevron-down' : 'chevron-right'} size={12} />Commands to confirm ({r.platform === 'windows' ? 'PowerShell' : r.commands.some((c) => /^SELECT|^SHOW|^db\./i.test(c)) ? 'shell / SQL' : 'shell'}, read-only)
                    </button>
                    {open[key] && (
                      <ul className="mt-1.5 space-y-1">
                        {r.commands.map((c) => (
                          <li key={c} className="flex items-start gap-2 rounded-md bg-[#0f172a] px-3 py-1.5">
                            <code className="min-w-0 flex-1 font-mono text-[11.5px] break-all whitespace-pre-wrap text-[#e2e8f0]">{c}</code>
                            <button type="button" aria-label="Copy command" onClick={() => copy(c)} className="shrink-0 text-[#94a3b8] hover:text-white"><Icon name="copy" size={12} /></button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-3 text-[11px] text-subtle">Read-only guidance: ActMon does not change anything on the host. Thresholds follow common OS and vendor guidance (cited per finding); commands only read state.</p>
    </Panel>
  );
}

function Shell({ children }) {
  return <div className="flex flex-col gap-3">{children}</div>;
}
