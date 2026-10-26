import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import { getMetricsHistory } from '@/api/agents';
import { listActiveAlerts } from '@/api/alerts';
import { getDiskMountHistory, getMemoryHistory, getNetworkHistory } from '@/api/memory';
import { toSeries } from '../cpu/cpuAnalysis';
import { BUCKET_LABEL, breakdown, downloadCsv, fmtBytes, normProc, pct, splitWindows, toCsv } from '../memory/memoryUtil';
import { Delta, Donut, Empty, Skeleton, Spark, TrendChart, TrendLegend, ctl, tLong, tSec } from '../memory/memoryParts';

/**
 * Infrastructure → host → Overview. Every number is this host's own, from:
 *   live      GET /os-servers/{id}/infra-detail (passed in as `data`): current CPU/memory/filesystems/network/
 *             processes, cpu_detail (per core), mem_detail, proc_count, boot_time, system inventory
 *   CPU       GET /metrics/history/{server_name}?kind=infra&tech=host        (ClickHouse metrics_infra)
 *   memory    GET /memory/{id}/history                                       (ClickHouse host_memory_metrics)
 *   disk      GET /disk/{id}/mount-history?mount=<fullest filesystem>        (ClickHouse host_fs_usage)
 *   network   GET /disk/{id}/network-history                                 (ClickHouse host_net_metrics)
 *   alerts    GET /alerts/active, filtered to this host's name
 * Not collected → shown as such: per-process disk I/O, process start "severity".
 */
const ORANGE = '#f97316';
const BLUE = '#2563eb';
const RED = '#ef4444';
const pseudo = (f) => /^(tmpfs|devtmpfs|overlay|squashfs)$/i.test(f.fstype || '') || /^(tmpfs|devtmpfs|overlay)/.test(f.filesystem || '');
const num = (v) => { const n = parseFloat(String(v ?? '').replace('%', '')); return Number.isFinite(n) ? n : null; };
const mbps = (bps) => (bps == null ? null : (bps * 8) / 1e6);
const fmtMbps = (v) => (v == null ? 'N/A' : v >= 100 ? `${v.toFixed(0)} Mbps` : v >= 1 ? `${v.toFixed(1)} Mbps` : `${(v * 1000).toFixed(0)} Kbps`);
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

function Card({ icon, tone, title, value, sub, children, spark }) {
  return (
    <div className="card flex min-h-[118px] gap-3 p-3.5">
      <span className={cn('grid h-12 w-12 shrink-0 place-items-center rounded-lg', tone)}><Icon name={icon} size={22} /></span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-semibold text-fg" title={title}>{title}</div>
        <div className={cn("mt-1 font-bold leading-tight text-fg tabular-nums", String(value).length > 11 ? "text-[18px]" : "truncate text-[24px] leading-none")} title={String(value)}>{value}</div>
        {sub && <div className="mt-0.5 truncate text-[11px] text-subtle">{sub}</div>}
        <div className="mt-2 flex items-end justify-between gap-2 text-[12px]"><div className="min-w-0">{children}</div>{spark}</div>
      </div>
    </div>
  );
}

function Tile({ icon, iconTone = 'bg-accent-soft text-accent', title, sub, right, children, className }) {
  return (
    <section className={cn('card flex min-w-0 flex-col', className)}>
      <div className="flex items-center justify-between gap-2 px-4 pt-3.5 pb-1.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-md', iconTone)}><Icon name={icon} size={15} /></span>
          <div className="min-w-0"><h2 className="truncate text-[15px] font-semibold text-fg">{title}</h2>{sub && <p className="truncate text-[11px] text-muted">{sub}</p>}</div>
        </div>
        {right && <div className="flex shrink-0 items-center gap-1.5">{right}</div>}
      </div>
      <div className="min-h-0 flex-1 px-4 pb-3.5">{children}</div>
    </section>
  );
}

function ResourceChart({ title, icon, iconTone, color, label, points, loading, error, emptyText, latest, rangeMinutes, onOpen, openLabel, kind, setKind, tooltipLabel }) {
  const [sel, setSel] = useState(null);
  return (
    <Tile icon={icon} iconTone={iconTone} title={title}
      right={(
        <>
          <select aria-label={`${title} chart type`} value={kind} onChange={(e) => setKind(e.target.value)} className={cn(ctl, 'h-8 text-[12px]')}><option value="line">Line Chart</option><option value="area">Area Chart</option></select>
          <button type="button" aria-label={`Open ${openLabel}`} title={`Open ${openLabel}`} onClick={() => onOpen(null)} className="grid h-8 w-8 place-items-center rounded-control text-muted hover:bg-raised"><Icon name="expand" size={15} /></button>
        </>
      )}>
      <div className="flex justify-end text-right leading-tight"><div><div className="text-[20px] font-bold text-fg tabular-nums">{pct(latest)}</div><div className="text-[11px] text-muted">Latest</div></div></div>
      {loading ? <Skeleton className="h-44" /> : error ? <Empty icon="alert" title="History could not be loaded">{error}</Empty>
        : points.length < 2 ? <Empty title="No history in this range">{emptyText}</Empty>
          : <TrendChart data={points} dataKey="v" color={color} kind={kind} height={176} selected={sel} onSelect={setSel} rangeMinutes={rangeMinutes}
              tooltipRows={(p) => [[tooltipLabel, pct(p.v), color]]} />}
      <TrendLegend color={color} label={label} selected={null} onClear={() => setSel(null)} />
      {sel && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-md bg-sunken px-2.5 py-1.5 text-[12px]">
          <span className="text-fg"><b>{tSec(sel.t)}</b> · {tooltipLabel} <b>{pct(sel.v)}</b></span>
          <button type="button" className="ml-auto font-semibold text-accent hover:underline" onClick={() => onOpen(sel.t)}>Inspect in {openLabel} →</button>
          <button type="button" aria-label="Clear selection" className="text-muted hover:text-fg" onClick={() => setSel(null)}><Icon name="close" size={12} /></button>
        </div>
      )}
    </Tile>
  );
}

export default function HostOverview({ id, data, serverName, agentVersion, range, bucket, auto }) {
  const navigate = useNavigate();
  const [kinds, setKinds] = useState({ cpu: 'line', mem: 'area', disk: 'area' });
  const [ptab, setPtab] = useState('cpu');
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const [page, setPage] = useState(0);
  const [openPid, setOpenPid] = useState(null);
  const [moreInfo, setMoreInfo] = useState(false);
  const ri = auto ? 60_000 : false;
  const m2 = range.minutes;

  const fs = useMemo(() => (data?.filesystems || []).filter((f) => !pseudo(f)).map((f) => ({ ...f, use_pct: Number(f.use_pct) })), [data]);
  const busiest = fs.length ? fs.reduce((a, b) => (b.use_pct > a.use_pct ? b : a)) : null;

  const cpuQ = useQuery({ queryKey: ['ov', 'cpu', serverName, m2, bucket], queryFn: () => getMetricsHistory(serverName, { minutes: m2 * 2, bucketSeconds: bucket || undefined, kind: 'infra', tech: 'host' }), enabled: Boolean(serverName), refetchInterval: ri });
  const memQ = useQuery({ queryKey: ['ov', 'mem', id, m2, bucket], queryFn: () => getMemoryHistory(id, { minutes: m2, bucket }), enabled: Boolean(id), refetchInterval: ri });
  const diskQ = useQuery({ queryKey: ['ov', 'disk', id, busiest?.mount, m2, bucket], queryFn: () => getDiskMountHistory(id, { mount: busiest.mount, minutes: m2, bucket: bucket || 60 }), enabled: Boolean(id && busiest), refetchInterval: ri });
  const netQ = useQuery({ queryKey: ['ov', 'net', id, m2, bucket], queryFn: () => getNetworkHistory(id, { minutes: m2, bucket }), enabled: Boolean(id), refetchInterval: ri });
  const alertsQ = useQuery({ queryKey: ['ov', 'alerts'], queryFn: () => listActiveAlerts(), refetchInterval: auto ? 60_000 : false });

  const now = Date.now();
  const cpuAll = useMemo(() => toSeries(cpuQ.data?.samples), [cpuQ.data]);
  const cpuW = useMemo(() => splitWindows(cpuAll, m2, cpuQ.dataUpdatedAt || now), [cpuAll, m2, cpuQ.dataUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const memAll = useMemo(() => (memQ.data?.samples || []).filter((s) => s.used_pct != null).map((s) => ({ t: s.t, v: s.used_pct })), [memQ.data]);
  const memW = useMemo(() => splitWindows(memAll, m2, memQ.dataUpdatedAt || now), [memAll, m2, memQ.dataUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const diskPts = useMemo(() => (diskQ.data?.points || []).map((p) => ({ t: p.t, v: p.use_pct })), [diskQ.data]);
  const netAll = useMemo(() => (netQ.data?.samples || []).map((s) => ({ t: s.t, v: mbps((s.rx_bps || 0) + (s.tx_bps || 0)) })), [netQ.data]);
  const netW = useMemo(() => splitWindows(netAll, m2, netQ.dataUpdatedAt || now), [netAll, m2, netQ.dataUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const cpuNow = num(data?.cpu_pct);
  const md = data?.mem_detail || null;
  const memNow = md?.used_pct ?? num(data?.memory?.used_pct);
  const net = data?.network || {};
  const netNow = net.total_download_mbps != null || net.total_upload_mbps != null ? (net.total_download_mbps || 0) + (net.total_upload_mbps || 0) : null;
  const prevAvg = (w) => avg(w.previous.map((p) => p.v));
  const spark = (pts) => pts.slice(-40).map((p) => ({ v: p.v }));
  const vs = `vs previous ${range.short}`;
  const cd = data?.cpu_detail || null;
  const memBd = useMemo(() => breakdown(md), [md]);
  const diskBd = useMemo(() => {
    if (!busiest || busiest.size_b == null) return null;
    const used = busiest.used_b ?? 0; const free = busiest.avail_b ?? 0; const reserved = Math.max(0, busiest.size_b - used - free);
    const parts = [{ id: 'used', label: 'Used Space', bytes: used, color: '#ef4444' }, { id: 'free', label: 'Free Space', bytes: free, color: '#16a34a' },
      ...(reserved > 0 ? [{ id: 'res', label: 'Reserved Space', bytes: reserved, color: '#f59e0b' }] : [])];
    return { total: busiest.size_b, parts: parts.map((p) => ({ ...p, pct: (100 * p.bytes) / busiest.size_b })) };
  }, [busiest]);
  const qs = (t) => `?range=${m2}&bucket=${bucket}${t ? `&at=${t}` : ''}`;
  const hostAlerts = (alertsQ.data || []).filter((a) => a.source === serverName)
    .sort((a, b) => ({ critical: 0, high: 1, warning: 2, info: 3 }[a.severity] ?? 4) - ({ critical: 0, high: 1, warning: 2, info: 3 }[b.severity] ?? 4));

  // processes: CPU tab = the CPU-ranked snapshot; Memory tab = the memory-ranked snapshot; Disk = not collected
  const cpuProcs = useMemo(() => (data?.processes || []).map((p) => ({
    pid: p.pid, name: p.command || p.name || '?', cpu: num(p.cpu), memPct: num(p.mem), ws: null, user: p.user || null, threads: p.threads ?? null,
    status: p.status || (p.instances > 1 ? `${p.instances} instances` : 'Running'),
  })), [data]);
  const memProcs = useMemo(() => (data?.mem_procs || []).map((p) => normProc(p, md?.total_bytes)), [data, md]);
  const base = ptab === 'memory' ? memProcs : cpuProcs;
  const rows = useMemo(() => {
    const f = q ? base.filter((p) => `${p.name} ${p.pid} ${p.user || ''}`.toLowerCase().includes(q.toLowerCase())) : base;
    return [...f].sort((a, b) => (ptab === 'memory' ? (b.ws ?? -1) - (a.ws ?? -1) : (b.cpu ?? -1) - (a.cpu ?? -1)));
  }, [base, q, ptab]);
  const PAGE = 15;
  const shown = all ? rows.slice(page * PAGE, page * PAGE + PAGE) : rows.slice(0, 5);
  const exportCsv = () => downloadCsv(`${serverName}-processes-${ptab}.csv`, toCsv(rows, [['name', 'Process'], ['pid', 'PID'], ['cpu', 'CPU %'], ['memPct', 'Memory %'], ['ws', 'Working set (bytes)'], ['user', 'User'], ['threads', 'Threads'], ['status', 'Status']]));
  const totDisk = fs.length && fs.every((f) => f.size_b != null) ? fs.reduce((s, f) => s + f.size_b, 0) : null;
  const mac = (data?.adapters || []).find((a) => a.mac && /up/i.test(a.status || ''))?.mac || (data?.interfaces || []).find((i) => i.mac && i.mac !== '00:00:00:00:00:00')?.mac || null;
  const boot = data?.boot_time ? Date.parse(data.boot_time) : null;

  return (
    <div className="flex flex-col gap-3">
      {/* six summary cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <Card icon="cpu" tone="bg-info-soft text-accent" title="CPU Usage" value={pct(cpuNow)} spark={<Spark points={spark(cpuW.current)} color="#16a34a" />}>
          <Delta value={cpuNow != null && prevAvg(cpuW) != null ? cpuNow - prevAvg(cpuW) : null} suffix={vs} />
        </Card>
        <Card icon="memory" tone="bg-[#f3e8ff] text-[#7c3aed]" title="Memory Usage" value={pct(memNow)} spark={<Spark points={spark(memW.current)} color={BLUE} />}>
          <Delta value={memNow != null && prevAvg(memW) != null ? memNow - prevAvg(memW) : null} suffix={vs} />
        </Card>
        <Card icon="archive" tone="bg-success-soft text-success-fg" title={`Disk Usage${busiest ? ` (${busiest.mount})` : ''}`} value={busiest ? `${busiest.use_pct.toFixed(1)}%` : 'N/A'} spark={<Spark points={spark(diskPts)} color={RED} />}>
          <Delta value={busiest && diskPts.length > 1 ? busiest.use_pct - diskPts[0].v : null} suffix={`since start of ${range.short}`} />
        </Card>
        <Card icon="network" tone="bg-info-soft text-accent" title="Network I/O" value={fmtMbps(netNow)} sub={net.rate_interval_s ? `rx + tx over ${net.rate_interval_s}s` : undefined} spark={<Spark points={spark(netW.current)} color={BLUE} />}>
          {netNow != null && prevAvg(netW)
            ? <span><span className={cn('font-semibold', netNow > prevAvg(netW) ? 'text-danger-fg' : 'text-success-fg')}>{netNow > prevAvg(netW) ? '↑' : '↓'} {Math.abs((100 * (netNow - prevAvg(netW))) / prevAvg(netW)).toFixed(1)}%</span><span className="block text-muted">{vs}</span></span>
            : <span className="text-muted">{netNow == null ? 'rate needs two collections' : `— ${vs}`}</span>}
        </Card>
        <Card icon="boxes" tone="bg-warning-soft text-warning-fg" title="Running Processes" value={data?.proc_count ?? 'N/A'}>
          <span className="text-muted">{data?.thread_count != null ? `${data.thread_count.toLocaleString()} threads` : data?.proc_count == null ? 'count arrives with the updated collector' : ''}</span>
        </Card>
        <Card icon="clock" tone="bg-info-soft text-accent" title="System Uptime" value={data?.uptime ? String(data.uptime).replace(/^up\s+/, '') : 'N/A'}>
          <span className="text-muted">Last Boot<span className="block text-fg">{boot ? tLong(boot) : 'N/A'}</span></span>
        </Card>
      </div>

      {/* three utilisation charts */}
      <div className="grid gap-3 xl:grid-cols-3">
        <ResourceChart title="CPU Utilization" icon="cpu" iconTone="bg-info-soft text-accent" color={ORANGE} label="CPU Usage" tooltipLabel="CPU Usage"
          points={cpuW.current} loading={cpuQ.isLoading} error={cpuQ.isError ? cpuQ.error?.message : null} latest={cpuNow} rangeMinutes={m2}
          emptyText="CPU history is stored for every collection." kind={kinds.cpu} setKind={(k) => setKinds({ ...kinds, cpu: k })}
          onOpen={(t) => navigate(`/cpu-performance/${id}${qs(t)}`)} openLabel="CPU Consumption" />
        <ResourceChart title="Memory Utilization" icon="memory" iconTone="bg-info-soft text-accent" color={BLUE} label="Memory Usage" tooltipLabel="Memory Usage"
          points={memW.current} loading={memQ.isLoading} error={memQ.isError ? memQ.error?.message : null} latest={memNow} rangeMinutes={m2}
          emptyText="Memory history starts with the updated collector." kind={kinds.mem} setKind={(k) => setKinds({ ...kinds, mem: k })}
          onOpen={(t) => navigate(`/memory/${id}${qs(t)}`)} openLabel="Memory Consumption" />
        <ResourceChart title={`Disk Utilization${busiest ? ` (${busiest.mount})` : ''}`} icon="archive" iconTone="bg-success-soft text-success-fg" color={RED} label="Disk Usage" tooltipLabel="Disk Usage"
          points={diskPts} loading={diskQ.isLoading && Boolean(busiest)} error={diskQ.isError ? diskQ.error?.message : null} latest={busiest?.use_pct} rangeMinutes={m2}
          emptyText="Per-filesystem history starts with the updated collector." kind={kinds.disk} setKind={(k) => setKinds({ ...kinds, disk: k })}
          onOpen={(t) => navigate(`/disk/${id}${qs(t)}`)} openLabel="Disk Consumption" />
      </div>

      {/* three analysis tiles */}
      <div className="grid gap-3 xl:grid-cols-3">
        <Tile icon="layers" title={`CPU Usage by Core${cd?.per_core?.length ? ` (${cd.per_core.length} ${cd.per_core.length === 1 ? 'Core' : 'Cores'})` : ''}`} sub={cd ? `one ${cd.sample_s}s sample · latest collection` : undefined}
          right={<button type="button" aria-label="Open CPU Consumption" onClick={() => navigate(`/cpu-performance/${id}`)} className="grid h-8 w-8 place-items-center rounded-control text-muted hover:bg-raised"><Icon name="expand" size={15} /></button>}>
          {!cd?.per_core?.length ? <Empty title="Per-core usage not reported yet">Reported by the updated collector; overall CPU is never split artificially.</Empty> : (
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={cd.per_core.map((c) => ({ id: String(c.id), pct: c.pct }))} margin={{ top: 8, right: 4, bottom: 0, left: -16 }}>
                  <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                  <XAxis dataKey="id" interval={0} tick={{ fontSize: 10.5, fill: 'var(--fg-muted)' }} stroke="var(--border)" />
                  <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 10.5, fill: 'var(--fg-muted)' }} stroke="var(--border)" />
                  <Tooltip formatter={(v) => [`${v}%`, 'Utilization']} labelFormatter={(l) => `Processor ${l}`} contentStyle={{ fontSize: 12, borderRadius: 8 }} cursor={{ fill: 'var(--surface-sunken)' }} />
                  <Bar dataKey="pct" fill="#2f7cf6" radius={[3, 3, 0, 0]} maxBarSize={30} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Tile>
        <Tile icon="chart-donut" title={`Memory Usage Breakdown (at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`}
          right={<button type="button" aria-label="Open Memory Consumption" onClick={() => navigate(`/memory/${id}`)} className="grid h-8 w-8 place-items-center rounded-control text-muted hover:bg-raised"><Icon name="expand" size={15} /></button>}>
          <Donut bd={memBd} centerValue={pct(memNow)} centerLabel="Used Memory" size={150} />
        </Tile>
        <Tile icon="chart-donut" iconTone="bg-success-soft text-success-fg" title={`Disk Usage Breakdown${busiest ? ` (${busiest.mount})` : ''}`}
          right={<button type="button" aria-label="Open Disk Consumption" onClick={() => navigate(`/disk/${id}`)} className="grid h-8 w-8 place-items-center rounded-control text-muted hover:bg-raised"><Icon name="expand" size={15} /></button>}>
          {!diskBd ? <Empty title="Exact sizes not reported yet">Sent by the updated collector.</Empty> : (
            <div className="flex flex-wrap items-center gap-5">
              <div className="relative h-[150px] w-[150px] shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart><Pie data={diskBd.parts} dataKey="bytes" nameKey="label" innerRadius="70%" outerRadius="100%" startAngle={90} endAngle={-270} stroke="#fff" strokeWidth={2} isAnimationActive={false}>
                    {diskBd.parts.map((p) => <Cell key={p.id} fill={p.color} />)}</Pie>
                    <Tooltip formatter={(v, n) => [fmtBytes(v), n]} contentStyle={{ fontSize: 12, borderRadius: 8 }} /></PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 grid place-items-center text-center"><div><div className="text-[22px] font-bold text-fg">{busiest.use_pct.toFixed(1)}%</div><div className="text-[11.5px] text-muted">Used Space</div></div></div>
              </div>
              <ul className="min-w-[180px] flex-1 space-y-3 text-[13px]">
                {diskBd.parts.map((p) => (
                  <li key={p.id} className="flex items-center gap-2"><span className="h-3 w-3 rounded-full" style={{ background: p.color }} /><span className="flex-1 text-fg">{p.label}</span>
                    <b className="tabular-nums text-fg">{fmtBytes(p.bytes)}</b><span className="w-14 text-right tabular-nums text-muted">({p.pct.toFixed(1)}%)</span></li>
                ))}
              </ul>
            </div>
          )}
          {diskBd?.parts.some((p) => p.id === 'res') && <p className="mt-1 text-[10.5px] text-subtle">Reserved = size − used − free (blocks kept for root by the filesystem).</p>}
        </Tile>
      </div>

      {/* processes · alerts · system information */}
      <div className="grid gap-3 xl:grid-cols-[1.55fr_1fr_0.95fr]">
        <Tile icon="list" title="Top Processes by Resource Usage" sub={`Latest collection · ${data?.proc_count != null ? `${data.proc_count} processes on the host` : ''}`}
          right={(
            <>
              <label className="inline-flex h-8 items-center gap-1.5 rounded-control border border-border bg-surface px-2 text-[12px] text-muted"><Icon name="search" size={13} />
                <input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder="Search processes..." aria-label="Search processes" className="w-28 bg-transparent text-fg outline-none" /></label>
              <button type="button" className={cn(ctl, 'h-8 text-[12px]')} onClick={exportCsv} disabled={!rows.length}><Icon name="download" size={13} />Download CSV</button>
              <button type="button" className={cn(ctl, 'h-8 text-[12px] text-accent')} onClick={() => { setAll(!all); setPage(0); }}>{all ? 'Top 5' : 'View All'}</button>
            </>
          )}>
          <div className="mb-1.5 flex gap-4 border-b border-border text-[12.5px]" role="tablist">
            {[['cpu', 'CPU'], ['memory', 'Memory'], ['disk', 'Disk']].map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={ptab === k} onClick={() => { setPtab(k); setPage(0); setOpenPid(null); }} className={cn('-mb-px border-b-2 px-2 pb-1.5', ptab === k ? 'border-accent font-semibold text-accent' : 'border-transparent text-muted hover:text-fg')}>{l}</button>
            ))}
          </div>
          {ptab === 'disk' ? <Empty title="Per-process disk I/O is not collected">The agents do not sample per-process read/write bytes yet. Filesystem usage and growth are on the Disk Consumption page.</Empty>
            : !rows.length ? <Empty title={ptab === 'memory' && !memProcs.length ? 'Memory-ranked processes not reported yet' : 'No processes'} />
              : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12.5px] [&_td]:whitespace-nowrap">
                    <thead><tr className="border-b border-border text-left text-[11.5px] text-muted">
                      {['#', 'Process Name', 'PID', 'CPU Usage', 'Memory Usage', 'Disk I/O', 'User', 'Threads', 'Status', 'Actions'].map((h) => <th key={h} className="px-1.5 py-1.5 font-semibold">{h}</th>)}
                    </tr></thead>
                    <tbody>
                      {shown.map((p, i) => (
                        <tr key={`${p.pid}-${i}`} className={cn('cursor-pointer border-b border-border last:border-0 hover:bg-raised', openPid === p.pid && 'bg-accent-soft/60')} onClick={() => setOpenPid(openPid === p.pid ? null : p.pid)}>
                          <td className="px-1.5 py-1.5 text-muted">{(all ? page * PAGE : 0) + i + 1}</td>
                          <td className="max-w-[150px] truncate px-1.5 py-1.5 font-medium text-fg" title={p.name}>{p.name}</td>
                          <td className="px-1.5 py-1.5 tabular-nums text-muted">{p.pid}</td>
                          <td className="px-1.5 py-1.5"><span className="flex items-center gap-1.5"><span className="w-11 tabular-nums">{pct(p.cpu)}</span><span className="h-1.5 w-12 overflow-hidden rounded-full bg-sunken"><span className="block h-full rounded-full bg-[#ef4444]" style={{ width: `${Math.min(100, p.cpu ?? 0)}%` }} /></span></span></td>
                          <td className="px-1.5 py-1.5 tabular-nums">{p.ws != null ? fmtBytes(p.ws) : pct(p.memPct)}</td>
                          <td className="px-1.5 py-1.5 text-subtle">N/A</td>
                          <td className="max-w-[110px] truncate px-1.5 py-1.5 text-fg" title={p.user || ''}>{p.user || 'N/A'}</td>
                          <td className="px-1.5 py-1.5 tabular-nums">{p.threads ?? 'N/A'}</td>
                          <td className="px-1.5 py-1.5"><span className="rounded bg-success-soft px-1.5 text-[11px] font-semibold text-success-fg">{p.status || 'Running'}</span></td>
                          <td className="px-1.5 py-1.5">
                            <button type="button" aria-label={`Open ${p.name} in ${ptab === 'memory' ? 'Memory' : 'CPU'} Consumption`} title={`Open in ${ptab === 'memory' ? 'Memory' : 'CPU'} Consumption`} className="text-muted hover:text-accent"
                              onClick={(e) => { e.stopPropagation(); navigate(ptab === 'memory' ? `/memory/${id}/processes` : `/cpu-performance/${id}`); }}><Icon name="external" size={14} /></button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {(() => { const p = rows.find((r) => r.pid === openPid); return p && (
                    <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-0.5 rounded-md border border-border bg-raised p-2.5 text-[12px] sm:grid-cols-4">
                      <span className="col-span-full font-semibold text-fg">{p.name} · PID {p.pid}</span>
                      <span className="text-muted">CPU <b className="text-fg">{pct(p.cpu)}</b></span><span className="text-muted">Memory <b className="text-fg">{p.ws != null ? fmtBytes(p.ws) : pct(p.memPct)}</b></span>
                      {p.private != null && <span className="text-muted">Private <b className="text-fg">{fmtBytes(p.private)}</b></span>}
                      <span className="text-muted">Threads <b className="text-fg">{p.threads ?? 'N/A'}</b></span>
                      {p.start_t && <span className="text-muted">Started <b className="text-fg">{tLong(p.start_t)}</b></span>}
                      {p.path && <span className="col-span-full truncate text-muted" title={p.path}>Path <b className="text-fg">{p.path}</b></span>}
                    </div>
                  ); })()}
                  {all && rows.length > PAGE && (
                    <div className="mt-2 flex items-center justify-end gap-2 text-[12px] text-muted">
                      <button type="button" className={cn(ctl, 'h-7')} disabled={page === 0} onClick={() => setPage(page - 1)}>Prev</button>Page {page + 1} / {Math.ceil(rows.length / PAGE)}
                      <button type="button" className={cn(ctl, 'h-7')} disabled={(page + 1) * PAGE >= rows.length} onClick={() => setPage(page + 1)}>Next</button>
                    </div>
                  )}
                  <p className="mt-1 text-[10.5px] text-subtle">{ptab === 'memory' ? 'Top 15 by working set / RSS, one row per PID.' : (/win/i.test(data?.system?.os || '') ? 'Top by CPU; same-name processes grouped (memory as % of RAM).' : 'Top by CPU, as a share of the whole host (all cores = 100%; ps: average since start).')}</p>
                </div>
              )}
        </Tile>

        <Tile icon="bell" iconTone="bg-warning-soft text-warning-fg" title="Recent Alerts (Resource)" sub={`Active alerts for ${serverName}`}
          right={<button type="button" className={cn(ctl, 'h-8 text-[12px] text-accent')} onClick={() => navigate('/alerts')}>View All</button>}>
          {alertsQ.isLoading ? <Skeleton className="h-36" /> : alertsQ.isError ? <Empty icon="alert" title="Alerts could not be loaded">{alertsQ.error?.message}</Empty>
            : !hostAlerts.length ? <Empty icon="check" title="No active alerts for this host" /> : (
              <table className="w-full text-[12.5px]">
                <thead><tr className="border-b border-border text-left text-[11.5px] text-muted"><th className="py-1.5 font-semibold">Time</th><th className="font-semibold">Level</th><th className="font-semibold">Message</th></tr></thead>
                <tbody>
                  {hostAlerts.slice(0, 6).map((a) => (
                    <tr key={a.id} onClick={() => navigate(`/alerts?alert=${encodeURIComponent(a.id)}`)} className="cursor-pointer border-b border-border last:border-0 hover:bg-sunken" title={a.metric ? `${a.metric}${a.value != null ? ` = ${a.value}` : ''}${a.threshold != null ? ` (threshold ${a.threshold})` : ''}` : ''}>
                      <td className="whitespace-nowrap py-1.5 pr-2 text-fg">{a.rule_id ? 'Active now' : tLong(Date.parse(a.created_at))}</td>
                      <td className="pr-2"><span className={cn('inline-flex items-center gap-1 rounded px-1.5 text-[11.5px] font-semibold capitalize',
                        { critical: 'bg-danger-soft text-danger-fg', high: 'bg-[#ffedd5] text-[#c2410c]', warning: 'bg-warning-soft text-warning-fg' }[a.severity] || 'bg-accent-soft text-accent')}>{a.severity}</span></td>
                      <td className="text-fg">{a.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          <p className="mt-1.5 text-[10.5px] text-subtle">Rule alerts show “Active now” (evaluated against the current state); collector events show when they were raised.</p>
        </Tile>

        <Tile icon="info" title="System Information"
          right={<button type="button" aria-label={moreInfo ? 'Hide system details' : 'Show all system details'} title={moreInfo ? 'Hide details' : 'All system details'} onClick={() => setMoreInfo(!moreInfo)} className="grid h-8 w-8 place-items-center rounded-control text-muted hover:bg-raised"><Icon name={moreInfo ? 'collapse' : 'expand'} size={15} /></button>}>
          <dl className="grid grid-cols-[118px_1fr] gap-x-3 gap-y-1 text-[12.5px]">
            {[
              ['Operating System', data?.system?.os], ['Kernel Version', data?.system?.kernel], ['CPU Model', cd?.model],
              ['Total CPU Cores', cd ? `${cd.physical_cores ?? '?'} (${cd.logical ?? '?'} Logical)` : null],
              ['Total Memory', md?.total_bytes ? fmtBytes(md.installed_bytes ?? md.total_bytes) : data?.memory?.total_mb ? fmtBytes(data.memory.total_mb * 1048576) : null],
              ['Total Disk Space', totDisk != null ? fmtBytes(totDisk) : null], ['Host IP', data?.host?.ip_address], ['MAC Address', mac],
              ['Agent Version', data?.host?.collector === 'agent' ? (agentVersion ? `v${String(agentVersion).replace(/^v/, '')}` : null) : 'SSH (no agent)'],
              ['Last Boot Time', boot ? tLong(boot) : null],
            ].map(([k, v]) => (
              <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className={cn('truncate', v ? 'text-fg' : 'text-subtle')} title={v || ''}>{v || 'N/A'}</dd></div>
            ))}
          </dl>
          {moreInfo && (
            <dl className="mt-2 grid grid-cols-[118px_1fr] gap-x-3 gap-y-1 border-t border-border pt-2 text-[12.5px]">
              {[['Architecture', data?.system?.architecture], ['Hostname', data?.system?.hostname], ['Environment', data?.host?.environment],
                ['Collector', data?.host?.collector === 'agent' ? 'ActMon Agent (push)' : 'SSH (poll)'], ['Virtualization', data?.system?.virtualization],
                ['Chassis', data?.system?.chassis], ['Hardware Vendor', data?.system?.hardware_vendor], ['Hardware Model', data?.system?.hardware_model],
                ['Machine ID', data?.system?.machine_id], ['Boot ID', data?.system?.boot_id],
                ['Firmware', data?.system?.firmware_version && data?.system?.firmware_date ? `${data.system.firmware_version} (${data.system.firmware_date})` : data?.system?.firmware_version],
              ].filter(([, v]) => v).map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="break-all text-fg">{v}</dd></div>)}
            </dl>
          )}
        </Tile>
      </div>
      <p className="text-[11px] text-subtle">{range.label} · {BUCKET_LABEL[bucket]} · history from ClickHouse; cards and breakdowns from the latest collection.</p>
    </div>
  );
}
