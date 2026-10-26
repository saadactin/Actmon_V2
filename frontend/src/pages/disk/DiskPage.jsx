import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useSelectAt, useTimeContext } from '../_shared/useTimeContext';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import { OsMark } from '@/components/dashboard/TopHostsCard';
import { bandFor, statusOf } from '@/components/charts/status';
import { getHostInfraDetail, getOsServer } from '@/api/servers';
import { listAgents } from '@/api/agents';
import { getDiskHistory, getDiskMountHistory } from '@/api/memory';
import { fmtDuration, freshness } from '../cpu/cpuAnalysis';
import { BUCKET_LABEL, RANGES, fmtBytes, pct, splitWindows } from '../memory/memoryUtil';
import { Delta, Empty, Panel, Skeleton, Spark, StatCard, TrendChart, TrendLegend, ctl, tLong, tSec, tShort } from '../memory/memoryParts';

/**
 * Disk Consumption for ONE host — /disk/:hostId. Real data only:
 *   GET /os-servers/{id}              host identity (org-scoped)
 *   GET /os-servers/{id}/infra-detail live filesystems (exact bytes, type, label; Linux inodes)
 *   GET /disk/{id}/history            ClickHouse host_fs_usage: busiest-filesystem trend, stats, per-mount growth
 *   GET /disk/{id}/mount-history      one filesystem's usage over the range
 * Disk I/O (throughput, IOPS, latency) is not collected and is not shown.
 */
const PURPLE = '#7c3aed';
const isPseudo = (f) => /^(tmpfs|devtmpfs|overlay|squashfs)$/i.test(f.fstype || '') || /^(tmpfs|devtmpfs|overlay)/.test(f.filesystem || '');

function Toggle({ on, onChange }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label="Auto refresh" onClick={() => onChange(!on)}
      className={cn('relative h-5 w-9 rounded-full transition-colors', on ? 'bg-accent' : 'bg-strong')}>
      <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', on ? 'left-[18px]' : 'left-0.5')} />
    </button>
  );
}

export default function DiskPage() {
  const { hostId } = useParams();
  const navigate = useNavigate();
  const tc = useTimeContext(RANGES);
  const [rangeIdx, setRangeIdx] = useState(tc.idx);
  const range = RANGES[rangeIdx];
  const [bucket, setBucket] = useState(tc.bucket);
  const [auto, setAuto] = useState(true);
  const [kind, setKind] = useState('area');
  const [selected, setSelected] = useState(null);
  const [mount, setMount] = useState(null);
  const [showPseudo, setShowPseudo] = useState(false);

  const validId = /^\d+$/.test(String(hostId || ''));
  const hostQ = useQuery({ queryKey: ['disk', 'host', hostId], queryFn: () => getOsServer(hostId), enabled: validId, retry: (n, e) => n < 1 && !/not found/i.test(e?.message || '') });
  const host = hostQ.data?.data;
  const id = host?.id;
  const live = useQuery({ queryKey: ['disk', 'live', id], queryFn: () => getHostInfraDetail(id), enabled: Boolean(id), refetchInterval: auto ? 30_000 : false });
  const histQ = useQuery({ queryKey: ['disk', 'hist', id, range.minutes, bucket], queryFn: () => getDiskHistory(id, { minutes: range.minutes, bucket }), enabled: Boolean(id), refetchInterval: auto ? 60_000 : false });
  const mountQ = useQuery({ queryKey: ['disk', 'mount', id, mount, range.minutes, bucket], queryFn: () => getDiskMountHistory(id, { mount, minutes: range.minutes, bucket: bucket || 60 }), enabled: Boolean(id && mount) });
  const agentsQ = useQuery({ queryKey: ['disk', 'agents'], queryFn: listAgents, enabled: host?.collector === 'agent', staleTime: 5 * 60_000 });

  const L = live.data;
  const allFs = useMemo(() => (L?.filesystems || []).map((f) => ({ ...f, use_pct: Number(f.use_pct) })), [L]);
  const fss = useMemo(() => allFs.filter((f) => showPseudo || !isPseudo(f)).sort((a, b) => b.use_pct - a.use_pct), [allFs, showPseudo]);
  const realFs = allFs.filter((f) => !isPseudo(f));
  const growth = useMemo(() => Object.fromEntries((histQ.data?.mounts || []).map((m) => [m.mount, m])), [histQ.data]);
  const samples = histQ.data?.samples || [];
  const { current } = useMemo(() => splitWindows(samples, range.minutes, histQ.dataUpdatedAt || Date.now()), [samples, range.minutes, histQ.dataUpdatedAt]);
  useSelectAt(tc.at, current, setSelected, Math.max(120_000, (bucket || 15) * 1000));   // opened "at this point" from another page
  const st = histQ.data?.stats?.current || null;
  const prev = histQ.data?.stats?.previous || null;
  const agent = useMemo(() => {
    const names = [host?.server_name, host?.hostname, host?.ip_address].filter(Boolean).map((s) => String(s).toLowerCase());
    return (agentsQ.data || []).find((a) => names.includes(String(a.hostname || '').toLowerCase()) || names.includes(String(a.name || '').toLowerCase()));
  }, [agentsQ.data, host]);

  if (!validId) return <Shell><Empty icon="alert" title="Invalid host id">“{hostId}” is not a host id.</Empty></Shell>;
  if (hostQ.isLoading) return <Shell><Skeleton className="h-16" /><Skeleton className="h-24" /><Skeleton className="h-80" /></Shell>;
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
  const isWin = /win/i.test(L?.system?.os || host.os_type || '');
  const busiest = realFs.length ? realFs.reduce((a, b) => (b.use_pct > a.use_pct ? b : a)) : null;
  const hasBytes = realFs.length > 0 && realFs.every((f) => f.size_b != null);
  const totSize = hasBytes ? realFs.reduce((s, f) => s + f.size_b, 0) : null;
  const totUsed = hasBytes ? realFs.reduce((s, f) => s + (f.used_b ?? 0), 0) : null;
  const totFree = hasBytes ? realFs.reduce((s, f) => s + (f.avail_b ?? 0), 0) : null;
  const vsPrev = `vs previous ${range.short}`;
  const spark = current.slice(-40).map((p) => ({ v: p.busiest }));
  const refresh = () => { live.refetch(); histQ.refetch(); if (mount) mountQ.refetch(); };
  const sizeText = (f) => (f.size_b != null ? fmtBytes(f.size_b) : f.size || 'N/A');
  const usedText = (f) => (f.used_b != null ? fmtBytes(f.used_b) : f.used || 'N/A');
  const freeText = (f) => (f.avail_b != null ? fmtBytes(f.avail_b) : f.avail || 'N/A');
  const capBars = realFs.filter((f) => f.size_b != null).sort((a, b) => b.size_b - a.size_b).slice(0, 10)
    .map((f) => ({ mount: f.mount, used: f.used_b, free: f.avail_b, pct: f.use_pct }));
  const mountPts = (mountQ.data?.points || []).map((p) => ({ ...p, v: p.use_pct }));

  return (
    <Shell>
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-[13px] text-muted">
        <Link to="/infra/hosts" className="hover:text-fg">Infrastructure</Link><Icon name="chevron-right" size={13} className="opacity-60" />
        <Link to={`/infra/${host.id}`} className="hover:text-fg">{host.server_name}</Link><Icon name="chevron-right" size={13} className="opacity-60" />
        <span className="font-semibold text-fg" aria-current="page">Disk Consumption</span>
      </nav>
      <div className="flex flex-wrap items-center gap-4">
        <button type="button" aria-label="Back" onClick={() => navigate(-1)} className="grid h-10 w-10 place-items-center rounded-control border border-border bg-surface text-fg hover:bg-raised"><Icon name="arrow-left" size={17} /></button>
        <span className="grid h-12 w-12 place-items-center rounded-lg bg-sunken text-muted"><Icon name="archive" size={24} /></span>
        <div className="min-w-0">
          <h1 className="text-[26px] font-bold leading-tight text-fg">Disk Consumption</h1>
          <p className="text-[13.5px] text-muted">Filesystem capacity, usage trends and growth for this host.</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Link to={`/infra/${host.id}`} className={ctl}><Icon name="external" size={15} /> Open in Host Overview</Link>
          <button type="button" className={ctl} onClick={refresh}><Icon name="refresh" size={15} className={cn((live.isFetching || histQ.isFetching) && 'animate-spin')} /> Refresh</button>
          <span className={ctl}><Icon name="clock" size={15} /> Auto Refresh <Toggle on={auto} onChange={setAuto} /></span>
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
          <span className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-info-soft"><OsMark os={L?.system?.os || host.os_type} size={30} /></span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-[20px] font-bold text-fg">{host.server_name}</span>
              <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-semibold', online ? 'bg-success-soft text-success-fg' : 'bg-danger-soft text-danger-fg')}>
                <span className="h-2 w-2 rounded-full" style={{ background: hs.color }} />{online ? 'Online' : (host.status || 'Unknown')}
              </span>
              {fresh.state === 'stale' && <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2.5 py-0.5 text-[12px] font-semibold text-warning-fg"><Icon name="alert" size={12} />Data stale</span>}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-2 text-[13.5px] text-muted">
              <span>{L?.system?.os || host.os_type || 'OS not reported'}</span><span>•</span><span>Host ID: {host.id}</span><span>•</span><span>IP: {host.ip_address || 'N/A'}</span>
              <span>•</span><span>{host.collector === 'agent' ? `Agent ${agent?.agent_version ? `v${String(agent.agent_version).replace(/^v/, '')}` : 'version N/A'}` : 'Collected over SSH'}</span>
              {L?.uptime && <><span>•</span><span>Uptime: {String(L.uptime).replace(/^up\s+/, '')}</span></>}
            </div>
            <div className="mt-0.5 text-[12px] text-subtle">{fresh.state === 'none' ? 'No samples collected yet' : `Last sample ${tSec(lastMs)} (${fmtDuration(fresh.ageMs)} ago)`}</div>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-4 border-l border-border pl-8">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-[#f3e8ff] text-[#7c3aed]"><Icon name="archive" size={24} /></span>
          <div>
            <div className="text-[16px] font-semibold text-fg">{realFs.length} filesystem{realFs.length === 1 ? '' : 's'}{hasBytes ? ` • ${fmtBytes(totSize)} total` : ''}</div>
            <div className="mt-0.5 text-[13px] text-muted">{hasBytes ? `${fmtBytes(totUsed)} used • ${fmtBytes(totFree)} free` : (live.isLoading ? 'Loading…' : 'Exact sizes arrive with the updated collector')}</div>
          </div>
        </div>
      </div>

      {/* summary */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <StatCard icon="archive" tone="bg-success-soft text-success-fg" label="Current Disk Usage" sub={busiest ? `busiest: ${busiest.mount}` : undefined} value={live.isLoading ? '…' : pct(busiest?.use_pct, 0)} spark={<Spark points={spark} color="#16a34a" />}>
          <Delta value={busiest && prev ? busiest.use_pct - prev.avg : null} suffix={vsPrev} />
        </StatCard>
        <StatCard icon="activity" tone="bg-accent-soft text-accent" label="Average Disk Usage" sub="busiest filesystem" value={pct(st?.avg)} spark={<Spark points={spark} color="#2563eb" />}>
          <Delta value={st && prev ? st.avg - prev.avg : null} suffix={st ? vsPrev : 'no samples'} />
        </StatCard>
        <StatCard icon="archive" tone="bg-danger-soft text-danger-fg" label="Peak Disk Usage" sub="busiest filesystem" value={pct(st?.max)} spark={<Spark points={spark} color="#dc2626" />}>
          <Delta value={st && prev ? st.max - prev.max : null} suffix={st ? `at ${tShort(st.max_t)}` : 'no samples'} />
        </StatCard>
        <StatCard icon="archive" tone="bg-success-soft text-success-fg" label="Minimum Disk Usage" sub="busiest filesystem" value={pct(st?.min)} spark={<Spark points={spark} color="#16a34a" />}>
          <Delta value={st && prev ? st.min - prev.min : null} suffix={st ? `at ${tShort(st.min_t)}` : 'no samples'} />
        </StatCard>
        <StatCard icon="layout-grid" tone="bg-[#f3e8ff] text-[#7c3aed]" label="Total Capacity" value={hasBytes ? fmtBytes(totSize) : 'N/A'}>
          <span className="text-muted">{hasBytes ? `${fmtBytes(totUsed)} used across ${realFs.length}` : 'Exact sizes not reported yet'}</span>
        </StatCard>
        <StatCard icon="folder" tone="bg-warning-soft text-warning-fg" label="Free Space" value={hasBytes ? fmtBytes(totFree) : 'N/A'}>
          <span className="text-muted">{hasBytes && totSize ? `${pct((100 * totFree) / totSize)} of capacity` : '—'}</span>
        </StatCard>
      </div>

      {/* trend + capacity */}
      <div className="grid gap-3 xl:grid-cols-[1.75fr_1fr]">
        <Panel icon="activity" title="Disk Utilization Trend" sub={`${range.label} · ${BUCKET_LABEL[bucket]} · fullest filesystem at each collection${st ? ` · ${st.n} samples` : ''}`}
          actions={<select aria-label="Chart type" value={kind} onChange={(e) => setKind(e.target.value)} className={cn(ctl, 'h-8')}><option value="line">Line Chart</option><option value="area">Area Chart</option></select>}>
          {histQ.isLoading ? <Skeleton className="h-60" />
            : histQ.isError ? <Empty icon="alert" title="Disk history could not be loaded">{histQ.error?.message}</Empty>
              : !current.length ? <Empty title="No disk samples in this range">Per-filesystem history is stored from the updated collector onwards.</Empty>
                : <TrendChart data={current} dataKey="busiest" color={PURPLE} kind={kind} height={240} selected={selected} onSelect={setSelected} rangeMinutes={range.minutes}
                    tooltipRows={(p) => [['Fullest filesystem', pct(p.busiest), PURPLE], ['Used (all filesystems)', fmtBytes(p.used_bytes), '#2563eb'], ['Capacity (all)', fmtBytes(p.size_bytes), '#64748b']]} />}
          <TrendLegend color={PURPLE} label="Disk Usage (fullest filesystem)" selected={selected} onClear={() => setSelected(null)} />
          {selected && <p className="mt-1 text-[12px] text-muted">At {tSec(selected.t)}: fullest filesystem {pct(selected.busiest)} · {fmtBytes(selected.used_bytes)} used of {fmtBytes(selected.size_bytes)}.</p>}
        </Panel>
        <Panel icon="chart-bar" title="Capacity by Filesystem" sub="Used vs free — latest collection">
          {live.isLoading ? <Skeleton className="h-60" /> : !capBars.length ? <Empty title="Sizes not reported yet">Exact filesystem sizes arrive with the updated collector.</Empty> : (
            <div style={{ height: Math.max(180, capBars.length * 34 + 30) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={capBars} layout="vertical" margin={{ top: 4, right: 12, bottom: 0, left: 4 }}>
                  <CartesianGrid stroke="var(--chart-grid)" horizontal={false} />
                  <XAxis type="number" tickFormatter={(v) => fmtBytes(v, 0)} tick={{ fontSize: 10.5, fill: 'var(--fg-muted)' }} stroke="var(--border)" />
                  <YAxis type="category" dataKey="mount" width={92} tick={{ fontSize: 11, fill: 'var(--fg-muted)' }} stroke="var(--border)" />
                  <Tooltip formatter={(v, n) => [fmtBytes(v), n === 'used' ? 'Used' : 'Free']} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                  <Bar dataKey="used" stackId="a" isAnimationActive={false}>{capBars.map((b) => <Cell key={b.mount} fill={bandFor(b.pct).color} />)}</Bar>
                  <Bar dataKey="free" stackId="a" fill="#e2e8f0" isAnimationActive={false} radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>
      </div>

      {/* filesystems */}
      <Panel icon="table" title="Filesystems" sub={`Latest collection${live.dataUpdatedAt ? ` · ${tSec(live.dataUpdatedAt)}` : ''} · growth over the ${range.label.toLowerCase()} · click a row for its history`}
        actions={allFs.length !== realFs.length && (
          <label className="inline-flex items-center gap-2 text-[12.5px] text-muted"><input type="checkbox" checked={showPseudo} onChange={(e) => setShowPseudo(e.target.checked)} />Show tmpfs / overlay</label>
        )}>
        {live.isLoading ? <Skeleton className="h-48" /> : live.isError ? <Empty icon="alert" title="Live data could not be loaded">{live.error?.message}</Empty>
          : !fss.length ? <Empty title="No filesystems reported" /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border text-left text-[12px] text-muted">
                    {['Mount', 'Type', isWin ? 'Label' : 'Device', 'Size', 'Used', 'Free', 'Usage', ...(isWin ? [] : ['Inodes']), 'Growth (range)', 'Days to full (est.)', ''].map((h) => <th key={h} className="whitespace-nowrap px-2 py-2 font-semibold">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {fss.map((f) => {
                    const g = growth[f.mount];
                    const b = bandFor(f.use_pct);
                    return (
                      <tr key={f.mount} onClick={() => setMount(mount === f.mount ? null : f.mount)} className={cn('cursor-pointer border-b border-border last:border-0 hover:bg-raised', mount === f.mount && 'bg-accent-soft/60')}>
                        <td className="px-2 py-2 font-semibold text-fg">{f.mount}</td>
                        <td className="px-2 py-2 text-muted">{f.fstype || 'N/A'}</td>
                        <td className="max-w-[180px] truncate px-2 py-2 text-muted" title={isWin ? f.label : f.filesystem}>{(isWin ? f.label : f.filesystem) || '—'}</td>
                        <td className="whitespace-nowrap px-2 py-2 tabular-nums">{sizeText(f)}</td>
                        <td className="whitespace-nowrap px-2 py-2 tabular-nums">{usedText(f)}</td>
                        <td className="whitespace-nowrap px-2 py-2 tabular-nums">{freeText(f)}</td>
                        <td className="w-[18%] px-2 py-2">
                          <span className="flex items-center gap-2"><span className="h-2 flex-1 overflow-hidden rounded-full bg-sunken"><span className="block h-full rounded-full" style={{ width: `${Math.max(2, f.use_pct)}%`, background: b.color }} /></span><b className="w-10 text-right tabular-nums">{f.use_pct}%</b></span>
                        </td>
                        {!isWin && <td className="px-2 py-2 tabular-nums text-muted">{f.inode_pct != null ? `${f.inode_pct}%` : 'N/A'}</td>}
                        <td className="whitespace-nowrap px-2 py-2 tabular-nums">{g?.growth_bytes != null ? `${g.growth_bytes >= 0 ? '+' : '−'}${fmtBytes(Math.abs(g.growth_bytes))}` : 'N/A'}</td>
                        <td className="whitespace-nowrap px-2 py-2 tabular-nums">{g?.days_to_full_estimate != null ? `~${g.days_to_full_estimate} d` : (g?.rate_bytes_per_day != null ? 'not growing' : 'N/A')}</td>
                        <td className="px-2 py-2 text-right">
                          {!isWin && <button type="button" className="text-[12px] text-accent hover:underline" onClick={(e) => { e.stopPropagation(); navigate(`/infra/${host.id}/files?path=${encodeURIComponent(f.mount)}`); }}>Browse</button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        <p className="mt-2 text-[11px] text-subtle">“Days to full” is a straight-line estimate from the growth in the selected range; it is shown only when usage grew. Disk I/O (throughput, IOPS, latency) is not collected.</p>
      </Panel>

      {mount && (
        <Panel icon="chart-line" title={`Filesystem History — ${mount}`} sub={`${range.label} · ${BUCKET_LABEL[bucket || 60]}`}
          actions={<button type="button" aria-label="Close filesystem history" className="text-muted hover:text-fg" onClick={() => setMount(null)}><Icon name="close" size={16} /></button>}>
          {mountQ.isLoading ? <Skeleton className="h-56" /> : mountQ.isError ? <Empty icon="alert" title="History could not be loaded">{mountQ.error?.message}</Empty>
            : !mountPts.length ? <Empty title="No stored history for this filesystem in the range" />
              : <TrendChart data={mountPts} dataKey="v" color="#2563eb" kind="area" height={220} selected={null} onSelect={() => {}} rangeMinutes={range.minutes}
                  tooltipRows={(p) => [['Usage', pct(p.use_pct), '#2563eb'], ['Used', fmtBytes(p.used_bytes), '#0f766e'], ['Size', fmtBytes(p.size_bytes), '#64748b'], ...(p.inode_pct != null ? [['Inodes used', pct(p.inode_pct), '#7c3aed']] : [])]} />}
        </Panel>
      )}
    </Shell>
  );
}

function Shell({ children }) {
  return <div className="flex flex-col gap-3">{children}</div>;
}
