import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import { bandFor } from '@/components/charts/status';
import { getFleetHistory } from '@/api/memory';
import { OsMark } from '@/components/dashboard/TopHostsCard';
import { hostLevel, osLabel, pctOf } from './InfraHostCard';

/**
 * Infrastructure → Overview (fleet). Real data only:
 *   hosts      GET /os-servers/ (+ live status merge, done by InfraPage) — counts, composition, latest readings
 *   history    GET /infra-fleet/history — ClickHouse metrics_infra, each host averaged per bucket then across hosts
 * KPI sparklines exist only where a stored history exists (resource usage). Host-status counts have no stored
 * history, so their cards show none rather than an invented curve.
 */
const C = { online: '#22c55e', warning: '#f59e0b', offline: '#ef4444', blue: '#2563eb', orange: '#f97316', purple: '#a855f7', cpu: '#f97316', mem: '#2563eb', disk: '#a855f7' };
const PALETTE = ['#2563eb', '#f97316', '#22c55e', '#a855f7', '#0891b2', '#f59e0b', '#db2777', '#64748b'];
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

function Spark({ data, color, k = 'v', h = 46 }) {
  if (!data || data.length < 2) return null;
  return (
    <div style={{ height: h }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
          <defs><linearGradient id={`sp-${color.slice(1)}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.28} /><stop offset="100%" stopColor={color} stopOpacity={0} /></linearGradient></defs>
          <Area type="monotone" dataKey={k} stroke={color} strokeWidth={1.8} fill={`url(#sp-${color.slice(1)})`} dot={false} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function Kpi({ icon, tone, label, value, valueClass, sub, onClick, spark }) {
  return (
    <button type="button" onClick={onClick} className="card relative flex min-h-[130px] flex-col overflow-hidden p-4 text-left transition-colors hover:border-strong">
      <div className="flex items-start gap-4">
        <span className={cn('grid h-14 w-14 shrink-0 place-items-center rounded-xl', tone)}><Icon name={icon} size={26} /></span>
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-fg">{label}</div>
          <div className={cn('mt-1 text-[34px] font-extrabold leading-none tabular-nums', valueClass || 'text-fg')}>{value}</div>
          <div className="relative z-10 mt-2 truncate text-[13px] text-muted" title={typeof sub === 'string' ? sub : undefined}>{sub}</div>
        </div>
      </div>
      {spark && <div className="pointer-events-none absolute inset-x-3 bottom-0 opacity-60">{spark}</div>}
    </button>
  );
}

function CardShell({ icon, title, menu, children, className, right }) {
  const [open, setOpen] = useState(false);
  return (
    <section className={cn('card flex min-w-0 flex-col p-4', className)}>
      <div className="mb-2 flex items-center gap-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent"><Icon name={icon} size={18} /></span>
        <h2 className="min-w-0 flex-1 truncate text-[17px] font-bold text-fg">{title}</h2>
        {right}
        {menu && (
          <div className="relative">
            <button type="button" aria-label={`${title} options`} aria-expanded={open} onClick={() => setOpen(!open)} className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-raised"><Icon name="more-vertical" size={16} /></button>
            {open && (
              <div className="absolute right-0 z-20 mt-1 w-48 rounded-lg border border-border bg-surface py-1 shadow-lg" onMouseLeave={() => setOpen(false)}>
                {menu.map((m) => <button key={m.label} type="button" onClick={() => { setOpen(false); m.onClick(); }} className="block w-full px-3 py-1.5 text-left text-[13px] text-fg hover:bg-raised">{m.label}</button>)}
              </div>
            )}
          </div>
        )}
      </div>
      {children}
    </section>
  );
}

/** Donut with clickable segments AND legend entries (both open the Hosts list filtered to that slice). */
function DonutCard({ icon, title, items, total, onPick, menu, footer }) {
  const data = items.filter((i) => i.value > 0);
  return (
    <CardShell icon={icon} title={title} menu={menu}>
      {!total ? <p className="grid flex-1 place-items-center py-10 text-[13px] text-muted">No hosts registered yet</p> : (
        <>
          <div className="relative mx-auto h-[172px] w-[172px]">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={data} dataKey="value" nameKey="label" innerRadius="62%" outerRadius="100%" startAngle={90} endAngle={-270} stroke="#fff" strokeWidth={3} isAnimationActive={false}
                  onClick={(d) => onPick(d?.payload ?? d)} className="cursor-pointer">
                  {data.map((d) => <Cell key={d.key} fill={d.color} />)}
                </Pie>
                <Tooltip formatter={(v, n) => [`${v} host${v === 1 ? '' : 's'} (${Math.round((100 * v) / total)}%)`, n]} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 grid place-items-center text-center"><div><div className="text-[22px] font-bold text-fg">{total}</div><div className="text-[13px] text-muted">Hosts</div></div></div>
          </div>
          <div className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1.5 text-[13.5px]">
            {items.map((i) => (
              <button key={i.key} type="button" onClick={() => onPick(i)} className="inline-flex items-center gap-1.5 rounded px-1 text-muted hover:bg-raised hover:text-fg" title={`Show ${i.label} hosts`}>
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: i.color }} />{i.label}<b className="ml-1 text-fg">{i.value}</b>
              </button>
            ))}
          </div>
          {footer}
        </>
      )}
    </CardShell>
  );
}

/** 270° arc gauge. */
function ArcGauge({ value, color, label }) {
  const r = 52; const c = 2 * Math.PI * r; const arc = c * 0.75;
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div className="relative mx-auto h-[132px] w-[132px]">
      <svg viewBox="0 0 132 132" className="h-full w-full" style={{ transform: 'rotate(135deg)' }}>
        <circle cx="66" cy="66" r={r} fill="none" stroke="var(--surface-sunken, #eef1f5)" strokeWidth="13" strokeDasharray={`${arc} ${c}`} strokeLinecap="round" />
        <circle cx="66" cy="66" r={r} fill="none" stroke={color} strokeWidth="13" strokeDasharray={`${(arc * v) / 100} ${c}`} strokeLinecap="round" />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center"><div><div className="text-[24px] font-bold text-fg">{value == null ? 'N/A' : `${Math.round(value)}%`}</div><div className="text-[13px] text-muted">{label}</div></div></div>
    </div>
  );
}

export default function InfraFleetOverview({ hosts, counts, serverId, loading }) {
  const navigate = useNavigate();
  const [attn, setAttn] = useState('all');
  const histQ = useQuery({
    queryKey: ['infraFleet', 'history', serverId || 'all'],
    queryFn: () => getFleetHistory({ minutes: 60, bucket: 60, serverId: serverId || undefined }),
    refetchInterval: 60_000,
  });
  const live = hosts.filter((h) => hostLevel(h) !== 'offline');
  // Latest readings: online/warning hosts that actually report the metric (offline = frozen, "0/—" = no reading)
  const latest = (k) => { const v = live.map((h) => pctOf(h[k])).filter((x) => Number.isFinite(x) && x > 0); return v.length ? avg(v) : null; };
  const cur = { cpu: latest('cpu_usage'), mem: latest('ram_usage'), disk: latest('disk_usage') };
  const reporting = live.filter((h) => [h.cpu_usage, h.ram_usage, h.disk_usage].some((x) => Number.isFinite(pctOf(x)) && pctOf(x) > 0)).length;
  const avgAll = [cur.cpu, cur.mem, cur.disk].filter((x) => x != null);
  const samples = histQ.data?.samples || [];
  const cut = (histQ.dataUpdatedAt || Date.now()) - 60 * 60000;
  const curS = samples.filter((s) => s.t >= cut);
  const prevS = samples.filter((s) => s.t < cut);
  const prevAvg = (k) => avg(prevS.map((s) => s[k]).filter((x) => x != null));
  const series = (k) => curS.map((s) => ({ t: s.t, v: s[k] }));
  const resSeries = curS.map((s) => ({ t: s.t, v: avg([s.cpu, s.memory, s.disk].filter((x) => x != null)) }));
  const healthPct = counts.total ? Math.round((counts.online / counts.total) * 100) : 0;
  const pctOfTotal = (n) => (counts.total ? `${Math.round((100 * n) / counts.total)}% of ${counts.total} hosts` : '—');
  const toHosts = (params) => navigate(`/infra/hosts${params ? `?${params}` : ''}`);

  const statusItems = [
    { key: 'online', label: 'Online', value: counts.online, color: C.online, go: 'status=online' },
    { key: 'warning', label: 'Warning', value: counts.warning, color: C.warning, go: 'status=warning' },
    { key: 'offline', label: 'Offline', value: counts.offline, color: C.offline, go: 'status=offline' },
  ];
  const group = (fn, colors) => {
    const m = {};
    hosts.forEach((h) => { const k = fn(h); m[k] = (m[k] || 0) + 1; });
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v], i) => ({ key: k, label: k, value: v, color: (colors && colors[k]) || PALETTE[i % PALETTE.length] }));
  };
  const osItems = group((h) => osLabel(h.os_type) || 'Unknown', { Windows: C.blue, Linux: C.orange }).map((i) => ({ ...i, go: `os=${encodeURIComponent(i.key)}` }));
  const envItems = group((h) => h.environment || 'Unassigned').map((i) => ({ ...i, go: `env=${encodeURIComponent(i.key)}` }));
  const colItems = group((h) => (h.collector === 'agent' ? 'ActMon Agent' : h.collector === 'rac-peer' ? 'RAC peer' : 'SSH (poll)'), { 'ActMon Agent': C.blue, 'SSH (poll)': C.orange })
    .map((i) => ({ ...i, go: `collector=${i.key === 'ActMon Agent' ? 'agent' : i.key === 'RAC peer' ? 'rac-peer' : 'ssh'}` }));

  const attention = hosts.filter((h) => hostLevel(h) !== 'online')
    .map((h) => ({ h, sev: hostLevel(h) === 'offline' ? 'critical' : 'warning' }))
    .sort((a, b) => (a.sev === b.sev ? 0 : a.sev === 'critical' ? -1 : 1));
  const attnShown = attention.filter((a) => attn === 'all' || a.sev === attn);
  const nCrit = attention.filter((a) => a.sev === 'critical').length;

  const topCpu = useMemo(() => live.map((h) => ({ h, v: pctOf(h.cpu_usage) })).filter((x) => Number.isFinite(x.v) && x.v > 0)
    .sort((a, b) => b.v - a.v).slice(0, 6), [live]);

  const gauge = (key, label, color, k, path) => {
    const v = cur[key];
    const p = prevAvg(k);
    const d = v != null && p != null ? v - p : null;
    return (
      <button type="button" onClick={() => navigate(`/hosts/top/${path}`)} className="flex min-w-0 flex-col items-center rounded-lg px-2 py-1 hover:bg-raised" title={`All hosts by ${label}`}>
        <ArcGauge value={v} color={color} label={label} />
        <div className="-mt-3 w-full"><Spark data={series(k)} color={color} h={42} /></div>
        <div className="mt-1 text-center text-[13px]">
          {d == null ? <span className="text-muted">{samples.length ? 'no previous-hour samples' : 'no history yet'}</span> : (
            <><span className={cn('font-bold', d > 0 ? 'text-danger-fg' : 'text-success-fg')}>{d > 0 ? '↑' : '↓'} {Math.abs(d).toFixed(1)} pts</span><span className="block text-muted">vs previous hour</span></>
          )}
        </div>
      </button>
    );
  };

  return (
    <div className={cn('flex flex-col gap-4', loading && 'opacity-80')}>
      {/* KPI cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <Kpi icon="server" tone="bg-info-soft text-accent" label="Total Hosts" value={counts.total} onClick={() => toHosts('')}
          sub={<b className="font-semibold text-success-fg">{healthPct}% Healthy</b>} />
        <Kpi icon="check" tone="bg-success-soft text-success-fg" label="Online" value={counts.online} onClick={() => toHosts('status=online')} sub={pctOfTotal(counts.online)} />
        <Kpi icon="alert" tone="bg-warning-soft text-warning-fg" label="Warning" value={String(counts.warning).padStart(2, '0')} valueClass="text-[#b45309]" onClick={() => toHosts('status=warning')} sub={pctOfTotal(counts.warning)} />
        <Kpi icon="close" tone="bg-danger-soft text-danger-fg" label="Offline" value={String(counts.offline).padStart(2, '0')} valueClass="text-danger-fg" onClick={() => toHosts('status=offline')} sub={pctOfTotal(counts.offline)} />
        <Kpi icon="gauge" tone="bg-warning-soft text-warning-fg" label="Avg Resource Usage" value={avgAll.length ? `${Math.round(avg(avgAll))}%` : 'N/A'} onClick={() => navigate('/hosts/top/cpu')}
          sub={`CPU ${cur.cpu == null ? 'N/A' : `${Math.round(cur.cpu)}%`} • RAM ${cur.mem == null ? 'N/A' : `${Math.round(cur.mem)}%`} • Disk ${cur.disk == null ? 'N/A' : `${Math.round(cur.disk)}%`}`}
          spark={<Spark data={resSeries} color={C.purple} h={26} />} />
      </div>

      {/* composition + attention */}
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_1fr_1.45fr]">
        <DonutCard icon="server" title="Host Status" items={statusItems} total={counts.total} onPick={(i) => toHosts(i.go)}
          menu={[{ label: 'View all hosts', onClick: () => toHosts('') }, { label: 'View offline hosts', onClick: () => toHosts('status=offline') }]}
          footer={<button type="button" onClick={() => toHosts(counts.offline ? 'status=offline' : 'status=warning')} className="mx-auto mt-3 inline-flex items-center gap-2 rounded-lg bg-accent-soft px-3 py-1.5 text-[13px] font-semibold text-accent hover:brightness-95">View hosts needing attention<Icon name="arrow-right" size={14} /></button>} />
        <DonutCard icon="desktop" title="OS Platform" items={osItems} total={counts.total} onPick={(i) => toHosts(i.go)} menu={[{ label: 'View all hosts', onClick: () => toHosts('') }]} />
        <DonutCard icon="chart-line" title="Environments" items={envItems} total={counts.total} onPick={(i) => toHosts(i.go)} menu={[{ label: 'View all hosts', onClick: () => toHosts('') }]} />
        <DonutCard icon="radio" title="Collector" items={colItems} total={counts.total} onPick={(i) => toHosts(i.go)} menu={[{ label: 'View all hosts', onClick: () => toHosts('') }]} />
        <CardShell icon="alert" title="Needs Attention" className="lg:col-span-2 xl:col-span-1"
          right={<button type="button" onClick={() => toHosts(attn === 'all' ? (nCrit ? 'status=offline' : 'status=warning') : attn === 'critical' ? 'status=offline' : 'status=warning')} className="rounded-lg bg-[#0f172a] px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-[#1e293b]">View Hosts</button>}>
          <div className="mb-3 flex flex-wrap gap-2" role="tablist">
            {[['all', `ALL (${attention.length})`, null], ['critical', `Critical (${nCrit})`, C.offline], ['warning', `Warning (${attention.length - nCrit})`, C.warning]].map(([k, l, dot]) => (
              <button key={k} type="button" role="tab" aria-selected={attn === k} onClick={() => setAttn(k)}
                className={cn('inline-flex items-center gap-2 rounded-lg border px-4 py-1.5 text-[13px] font-semibold', attn === k ? 'border-[#0f172a] bg-[#0f172a] text-white' : 'border-border bg-surface text-fg hover:bg-raised')}>
                {dot && <span className="h-2.5 w-2.5 rounded-full" style={{ background: dot }} />}{l}
              </button>
            ))}
          </div>
          {!attnShown.length ? <p className="grid flex-1 place-items-center py-8 text-center text-[13px] text-muted"><span><Icon name="check" size={18} className="mx-auto mb-1 text-success-fg" />All {attn === 'all' ? '' : `${attn} `}clear — every host is online.</span></p> : (
            <ul className="max-h-[300px] space-y-2 overflow-y-auto pr-1">
              {attnShown.map(({ h, sev }) => (
                <li key={h.id}>
                  <button type="button" onClick={() => navigate(`/infra/${h.id}`)} className={cn('flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left transition-colors', sev === 'critical' ? 'bg-[#fef2f2] hover:bg-[#fee2e2]' : 'bg-[#fffbeb] hover:bg-[#fef3c7]')}>
                    <Icon name="server" size={20} className="shrink-0 text-fg" />
                    <span className="min-w-0 flex-1"><span className="block truncate font-bold text-fg">{h.server_name || h.hostname}</span><span className="block truncate text-[13px] text-muted">{h.ip_address || h.hostname || '—'} · {h.status || 'Unknown'}</span></span>
                    <span className={cn('rounded-md px-3 py-1 text-[13px] font-semibold', sev === 'critical' ? 'bg-[#fee2e2] text-[#dc2626]' : 'bg-[#fef3c7] text-[#b45309]')}>{sev === 'critical' ? 'Critical' : 'Warning'}</span>
                    <Icon name="chevron-right" size={16} className="shrink-0 text-muted" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[11px] text-subtle">Critical = offline / not reporting · Warning = reporting with a warning status.</p>
        </CardShell>
      </div>

      {/* top CPU + averages */}
      <div className="grid gap-4 xl:grid-cols-[1.02fr_1fr]">
        <CardShell icon="chart-bar" title={<>Top Hosts By CPU <span className="text-[14px] font-normal text-muted">(Top 6)</span></>}
          menu={[{ label: 'All hosts by CPU', onClick: () => navigate('/hosts/top/cpu') }, { label: 'All hosts by Memory', onClick: () => navigate('/hosts/top/memory') }, { label: 'All hosts by Disk', onClick: () => navigate('/hosts/top/disk') }]}>
          {!topCpu.length ? <p className="py-10 text-center text-[13px] text-muted">No online host is reporting CPU yet.</p> : (
            <table className="w-full text-[13.5px]">
              <thead><tr className="bg-sunken/60 text-left text-[13px] text-fg"><th className="rounded-l-md px-3 py-2 font-semibold">#</th><th className="px-3 py-2 font-semibold">Host Name</th><th className="px-3 py-2 font-semibold">IP Address</th><th className="rounded-r-md px-3 py-2 font-semibold" colSpan={2}>CPU Usage</th></tr></thead>
              <tbody>
                {topCpu.map(({ h, v }, i) => {
                  const hot = v >= 75;
                  return (
                    <tr key={h.id} className="border-b border-border last:border-0">
                      <td className="px-3 py-2 text-muted">{i + 1}</td>
                      <td className="px-3 py-2"><button type="button" onClick={() => navigate(`/cpu-performance/${h.id}`)} className="inline-flex items-center gap-1.5 font-medium text-accent hover:underline" title="Open CPU Consumption"><OsMark os={h.os_type} size={13} />{h.server_name || h.hostname}</button></td>
                      <td className="px-3 py-2 tabular-nums text-muted">{h.ip_address || '—'}</td>
                      <td className="w-12 px-1 py-2 text-right tabular-nums text-fg">{Math.round(v)}%</td>
                      <td className="w-[38%] px-3 py-2"><span className="block h-2.5 overflow-hidden rounded-full bg-sunken"><span className="block h-full rounded-full" style={{ width: `${Math.max(3, v)}%`, background: hot ? '#ef4444' : bandFor(v).id === 'good' ? '#22c55e' : bandFor(v).color }} /></span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardShell>
        <CardShell icon="activity" title="Average Resource Usage"
          menu={[{ label: 'All hosts by CPU', onClick: () => navigate('/hosts/top/cpu') }, { label: 'All hosts by Memory', onClick: () => navigate('/hosts/top/memory') }, { label: 'All hosts by Disk', onClick: () => navigate('/hosts/top/disk') }]}>
          <div className="grid grid-cols-3 divide-x divide-border">
            {gauge('cpu', 'CPU', C.cpu, 'cpu', 'cpu')}
            {gauge('mem', 'Memory', C.mem, 'memory', 'memory')}
            {gauge('disk', 'Disk', C.disk, 'disk', 'disk')}
          </div>
          <p className="mt-2 text-[11px] text-subtle">
            Gauges: latest reading averaged over {reporting} online host{reporting === 1 ? '' : 's'} with a reading. Trend: last hour from stored history
            {histQ.isError ? ' — unavailable (history could not be loaded)' : histQ.data ? ` (${histQ.data.hosts} host${histQ.data.hosts === 1 ? '' : 's'})` : ''}.
          </p>
        </CardShell>
      </div>
    </div>
  );
}
