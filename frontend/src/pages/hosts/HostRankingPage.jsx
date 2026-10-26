import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import { OsMark } from '@/components/dashboard/TopHostsCard';
import { bandFor, STATUS, statusOf, UTILISATION_BANDS } from '@/components/charts/status';
import { listOsServers } from '@/api/servers';
import { QK } from '@/api/queryKeys';
import { readingOf } from '@/hooks/useDashboardData';

/**
 * Every host ranked by one resource — /hosts/top/:metric (cpu | memory | disk). Opened from the dashboard's
 * Top CPU / Memory / Disk Hosts arrow. Same source and the same reading rule as those cards (GET /os-servers/,
 * the latest reading per host, org-scoped); here nothing is cut to 5. A host name opens its consumption page.
 * Offline hosts are listed separately with their LAST reading greyed out — never ranked as if it were current.
 */
const METRICS = {
  cpu: { label: 'CPU', title: 'CPU Consumption', field: 'cpu_usage', icon: 'cpu', to: (id) => `/cpu-performance/${id}` },
  memory: { label: 'Memory', title: 'Memory Consumption', field: 'ram_usage', icon: 'memory', to: (id) => `/memory/${id}` },
  disk: { label: 'Disk', title: 'Disk Consumption', field: 'disk_usage', icon: 'archive', to: (id) => `/disk/${id}` },
};
const ctl = 'inline-flex h-9 items-center gap-2 rounded-control border border-border bg-surface px-3 text-[13px] text-fg hover:bg-raised';

function Bar({ value, muted }) {
  if (value == null) return <span className="text-[12px] text-subtle">N/A</span>;
  const b = bandFor(value);
  return (
    <span className="flex items-center gap-2" title={`${value.toFixed(1)}% — ${b.label}`}>
      <span className="h-2.5 min-w-[80px] flex-1 overflow-hidden rounded-full bg-sunken">
        <span className="block h-full rounded-full" style={{ width: `${Math.max(2, value)}%`, background: muted ? 'var(--border-strong, #cbd5e1)' : b.color }} />
      </span>
      <span className={cn('w-11 shrink-0 text-right font-bold tabular-nums', muted ? 'text-subtle' : 'text-fg')}>{Math.round(value)}%</span>
    </span>
  );
}

export default function HostRankingPage() {
  const { metric: m } = useParams();
  const metric = METRICS[m] ? m : 'cpu';
  const M = METRICS[metric];
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [os, setOs] = useState('all');
  const [sortDir, setSortDir] = useState(-1);
  const hostsQ = useQuery({ queryKey: QK.osServers(), queryFn: () => listOsServers(), refetchInterval: 30_000 });

  const { ranked, offline, noReading } = useMemo(() => {
    const all = (hostsQ.data || []).map((h) => {
      const s = statusOf(h.status);
      return {
        id: h.id, name: h.server_name || h.hostname || h.ip_address || '—', ip: h.ip_address, os: h.os_type, env: h.environment,
        collector: h.collector || 'ssh', status: h.status, live: s === STATUS.good || s === STATUS.warning, statusColor: s.color,
        cpu: readingOf(h.cpu_usage), memory: readingOf(h.ram_usage), disk: readingOf(h.disk_usage), last: h.last_infra_at || h.updated_at || null,
      };
    }).filter((h) => (!q || `${h.name} ${h.ip || ''}`.toLowerCase().includes(q.toLowerCase()))
      && (os === 'all' || (os === 'windows' ? /win/i.test(h.os || '') : !/win/i.test(h.os || ''))));
    const live = all.filter((h) => h.live);
    return {
      ranked: live.filter((h) => h[metric] != null).sort((a, b) => (a[metric] - b[metric]) * sortDir),
      noReading: live.filter((h) => h[metric] == null),
      offline: all.filter((h) => !h.live),
    };
  }, [hostsQ.data, q, os, metric, sortDir]);

  const row = (h, i, muted) => (
    <tr key={h.id} className={cn('border-b border-border last:border-0 hover:bg-raised', muted && 'opacity-70')}>
      <td className="px-3 py-2.5 tabular-nums text-muted">{i == null ? '—' : i + 1}</td>
      <td className="px-3 py-2.5">
        <button type="button" onClick={() => navigate(M.to(h.id))} className="text-left font-semibold text-accent hover:underline">{h.name}</button>
        {h.ip && <div className="text-[11.5px] text-muted">{h.ip}</div>}
      </td>
      <td className="px-3 py-2.5"><span className="inline-flex items-center gap-1.5"><OsMark os={h.os} />{h.os || 'N/A'}</span></td>
      <td className="px-3 py-2.5"><span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: h.statusColor }} />{h.status || 'Unknown'}</span></td>
      <td className="w-[26%] px-3 py-2.5"><Bar value={h[metric]} muted={muted} /></td>
      {Object.keys(METRICS).filter((k) => k !== metric).map((k) => (
        <td key={k} className={cn('px-3 py-2.5 text-right tabular-nums', muted ? 'text-subtle' : 'text-fg')}>
          {h[k] == null ? 'N/A' : (
            <button type="button" className="hover:text-accent hover:underline" title={`Open ${METRICS[k].title}`} onClick={() => navigate(METRICS[k].to(h.id))}>{Math.round(h[k])}%</button>
          )}
        </td>
      ))}
      <td className="px-3 py-2.5 text-muted">{h.collector === 'agent' ? 'Agent' : 'SSH'}</td>
      <td className="px-3 py-2.5 text-right">
        <div className="inline-flex gap-1">
          <button type="button" className={cn(ctl, 'h-8 text-accent')} onClick={() => navigate(M.to(h.id))}>{M.label} details</button>
          <Link to={`/infra/${h.id}`} className={cn(ctl, 'h-8')} title="Host overview"><Icon name="external" size={14} /></Link>
        </div>
      </td>
    </tr>
  );
  const others = Object.keys(METRICS).filter((k) => k !== metric);

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-[13px] text-muted">
        <Link to="/dashboard" className="hover:text-fg">Dashboard</Link><Icon name="chevron-right" size={13} className="opacity-60" />
        <span className="font-semibold text-fg" aria-current="page">All Hosts by {M.label}</span>
      </nav>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" aria-label="Back" onClick={() => navigate(-1)} className="grid h-10 w-10 place-items-center rounded-full border border-border bg-surface text-muted hover:bg-raised"><Icon name="arrow-left" size={17} /></button>
        <span className="grid h-11 w-11 place-items-center rounded-lg bg-accent-soft text-accent"><Icon name={M.icon} size={22} /></span>
        <div>
          <h1 className="text-[22px] font-bold text-fg">All Hosts by {M.label} Usage</h1>
          <p className="text-[13px] text-muted">Every host ranked by its latest {M.label.toLowerCase()} reading. Click a host to open its {M.title.toLowerCase()}.</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className={ctl}><Icon name="search" size={14} className="text-muted" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search host or IP" aria-label="Search hosts" className="w-40 bg-transparent outline-none" /></label>
          <select aria-label="Operating system" value={os} onChange={(e) => setOs(e.target.value)} className={ctl}><option value="all">All OS</option><option value="windows">Windows</option><option value="linux">Linux / Unix</option></select>
          <button type="button" className={ctl} onClick={() => setSortDir(-sortDir)}><Icon name={sortDir < 0 ? 'chevron-down' : 'chevron-up'} size={14} />{sortDir < 0 ? 'Highest first' : 'Lowest first'}</button>
          <button type="button" className={ctl} onClick={() => hostsQ.refetch()}><Icon name="refresh" size={14} className={cn(hostsQ.isFetching && 'animate-spin')} />Refresh</button>
        </div>
      </div>

      <div className="flex gap-1 border-b border-border" role="tablist">
        {Object.entries(METRICS).map(([k, v]) => (
          <button key={k} type="button" role="tab" aria-selected={k === metric} onClick={() => navigate(`/hosts/top/${k}`)}
            className={cn('inline-flex items-center gap-2 rounded-t-md border-b-2 px-4 py-2.5 text-[14px]', k === metric ? 'border-accent bg-accent-soft font-semibold text-accent' : 'border-transparent text-fg hover:bg-raised')}>
            <Icon name={v.icon} size={15} />{v.label}
          </button>
        ))}
      </div>

      <section className="card overflow-hidden">
        {hostsQ.isLoading ? <div className="h-60 animate-pulse bg-sunken" />
          : hostsQ.isError ? <p className="p-8 text-center text-danger-fg">Hosts could not be loaded: {hostsQ.error?.message}</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border bg-sunken/40 text-left text-[12px] text-muted">
                    <th className="px-3 py-2.5 font-semibold">#</th><th className="px-3 py-2.5 font-semibold">Host Name</th><th className="px-3 py-2.5 font-semibold">OS</th>
                    <th className="px-3 py-2.5 font-semibold">Status</th><th className="px-3 py-2.5 font-semibold">{M.label} Usage</th>
                    {others.map((k) => <th key={k} className="px-3 py-2.5 text-right font-semibold">{METRICS[k].label}</th>)}
                    <th className="px-3 py-2.5 font-semibold">Collector</th><th className="px-3 py-2.5 text-right font-semibold">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.map((h, i) => row(h, i, false))}
                  {noReading.length > 0 && <tr><td colSpan={9} className="bg-sunken/40 px-3 py-1.5 text-[11.5px] font-semibold text-muted">Online, no {M.label.toLowerCase()} reading yet</td></tr>}
                  {noReading.map((h) => row(h, null, false))}
                  {offline.length > 0 && <tr><td colSpan={9} className="bg-sunken/40 px-3 py-1.5 text-[11.5px] font-semibold text-muted">Offline — last known reading, not ranked</td></tr>}
                  {offline.map((h) => row(h, null, true))}
                  {!ranked.length && !noReading.length && !offline.length && <tr><td colSpan={9} className="p-8 text-center text-muted">No hosts match.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-4 py-2 text-[11.5px] text-muted">
          <span>{ranked.length} ranked · {noReading.length} without a reading · {offline.length} offline{hostsQ.dataUpdatedAt ? ` · updated ${new Date(hostsQ.dataUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</span>
          <span className="ml-auto flex gap-3">{UTILISATION_BANDS.map((b) => <span key={b.id} className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: b.color }} />{b.label}</span>)}</span>
        </div>
      </section>
    </div>
  );
}
