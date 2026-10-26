import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import { getCpuCategories } from '@/api/cpu';

/**
 * CPU Usage by Process Category — the host's CPU TIME split as the OS measures it (Linux /proc/stat, Windows processor
 * counters), with a drill-down: click a category to see which processes make up its share.
 *
 *   overview   latest collection: doughnut + breakdown; trend column = latest − average of the stored range
 *   drill      User Processes → each process's USER time, System / Kernel → each process's KERNEL time, from the same
 *              collection's 0.5 s per-process sample (procs_now). Shares are of the whole host (all cores = 100%).
 *              Whatever the 15 busiest processes do not explain is shown as its own row, never spread over them.
 *              I/O wait, interrupts, steal and idle are not owned by a process — the drill says why instead of guessing.
 *   history    stored categories (ClickHouse host_cpu_metrics) for the trend chart
 */
const CATS = {
  user: { label: 'User Processes', color: '#2563eb', key: 'cpu_user' },
  system: { label: 'System / Kernel', color: '#16a34a', key: 'cpu_kernel' },
  iowait: { label: 'I/O Wait', color: '#f59e0b' },
  irq: { label: 'Interrupts', color: '#ef4444' },
  steal: { label: 'Steal (hypervisor)', color: '#ec4899' },
  idle: { label: 'Idle', color: '#cbd5e1' },
};
const NOT_OWNED = {
  iowait: 'I/O wait is time a CPU sat idle while some process waited for disk or network. It belongs to no process — look at disk latency and the processes doing the I/O (Disk page).',
  irq: 'Interrupt time is the kernel servicing hardware (network cards, disks, timers). It is not charged to any process; heavy values usually follow network or storage traffic.',
  steal: 'Steal is time the hypervisor gave this VM\'s CPU to another guest. Nothing inside the VM causes it — it points to an oversubscribed host or a CPU limit on the VM.',
  idle: 'Idle is unused capacity.',
};
const RANGES = [{ id: 60, label: 'Last 1 hour', bucket: 60 }, { id: 360, label: 'Last 6 hours', bucket: 300 }, { id: 1440, label: 'Last 24 hours', bucket: 900 }];
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const tShort = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function liveSplit(cd, isWindows, liveCpu) {
  if (!cd) return null;
  if (isWindows) {
    const irq = (cd.interrupt_pct ?? 0) + (cd.dpc_pct ?? 0);
    const rows = [['user', cd.user_pct], ['system', cd.privileged_pct != null ? Math.max(0, cd.privileged_pct - irq) : null], ['irq', irq || null]];
    if (liveCpu != null) rows.push(['idle', Math.max(0, 100 - liveCpu)]);
    return rows.filter(([, v]) => v != null);
  }
  return [['user', cd.user_pct], ['system', cd.system_pct], ['iowait', cd.iowait_pct], ['irq', cd.irq_pct], ['steal', cd.steal_pct], ['idle', cd.idle_pct]]
    .filter(([, v]) => v != null);
}

/** Programs share a family: ora_w007_dcdb + ora_dbw0_dcdb → "Oracle background (dcdb)". */
function family(name) {
  const n = String(name || '');
  let m = n.match(/^ora_[a-z0-9]+_(.+)$/i);
  if (m) return `Oracle background processes (${m[1]})`;
  m = n.match(/^oracle_?\d*_?(\w*)$/i);
  if (m) return `Oracle server processes${m[1] ? ` (${m[1]})` : ''}`;
  if (/^asm_/i.test(n)) return 'Oracle ASM';
  if (/^kworker|^ksoftirqd|^migration|^rcu_/.test(n)) return 'Kernel threads';
  return n.replace(/\d+/g, '#');
}

export default function CpuCategoryPanel({ hostId, cd, isWindows, liveCpu, liveUpdatedAt, procsNow, onOpenProcess, onRefresh, refreshing }) {
  const [rid, setRid] = useState(60);
  const [drill, setDrill] = useState(null);      // category key
  const [group, setGroup] = useState('process'); // process | program | parent
  const range = RANGES.find((r) => r.id === rid) || RANGES[0];
  const histQ = useQuery({
    queryKey: ['cpuPerf', 'categories', hostId, range.id, range.bucket],
    queryFn: () => getCpuCategories(hostId, { minutes: range.id, bucket: range.bucket }),
    refetchInterval: 60_000, retry: false,
  });
  const samples = histQ.data?.samples || [];

  const rows = useMemo(() => {
    const split = liveSplit(cd, isWindows, liveCpu);
    if (!split) return [];
    const avg = (k) => {
      const xs = samples.map((s) => s[k]).filter((x) => x != null);
      return xs.length >= 3 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    };
    return split.map(([k, v]) => ({ key: k, v: r1(v), trend: avg(k) != null ? r1(v - avg(k)) : null }));
  }, [cd, isWindows, liveCpu, samples]);

  const used = rows.filter((r) => r.key !== 'idle').reduce((a, r) => a + (r.v || 0), 0);
  const lineKeys = ['user', 'system', 'iowait', 'irq', 'steal'].filter((k) => samples.some((s) => (s[k] || 0) > 0.05));
  const top = rows.filter((r) => r.key !== 'idle').sort((a, b) => b.v - a.v)[0];

  return (
    <section className="card flex min-w-0 flex-col" aria-label="CPU Usage by Process Category">
      <header className="flex flex-wrap items-center gap-2.5 px-5 pt-4 pb-2">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent"><Icon name="chart-pie" size={18} /></span>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-1.5 truncate text-[15.5px] font-semibold text-fg">
            CPU Usage by Process Category
            <span className="text-subtle" title="Where CPU time went in the latest collection, measured by the OS. Click a category to see the processes that make it up."><Icon name="info" size={13} /></span>
          </h2>
          <p className="truncate text-[11.5px] text-muted">Latest snapshot{liveUpdatedAt ? ` · ${new Date(liveUpdatedAt).toLocaleTimeString()}` : ''} · click a category to drill down</p>
        </div>
        <select aria-label="Category trend range" value={rid} onChange={(e) => setRid(Number(e.target.value))}
          className="h-8 rounded-md border border-border bg-surface px-2 text-[12px] text-fg">
          {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
      </header>

      <div className="px-5 pb-4">
        {!rows.length ? (
          <div className="flex items-center gap-4 rounded-xl border border-dashed border-border bg-sunken/40 px-4 py-5">
            <Icon name="info" size={20} className="shrink-0 text-subtle" />
            <div className="min-w-0 flex-1 text-[12.5px] text-muted"><b className="block text-fg">No CPU time split from this host yet</b>The collector reports it with each cycle (updated collector).</div>
            <button type="button" onClick={onRefresh} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-[12px] font-semibold text-fg hover:bg-raised">
              <Icon name="refresh" size={13} className={refreshing ? 'animate-spin' : undefined} />Retry
            </button>
          </div>
        ) : drill ? (
          <Drill cat={drill} total={rows.find((r) => r.key === drill)?.v} procs={procsNow} isWindows={isWindows} group={group} setGroup={setGroup}
            onBack={() => setDrill(null)} onOpenProcess={onOpenProcess} />
        ) : (
          <>
            <div className="grid items-center gap-5 md:grid-cols-[200px_minmax(0,1fr)]">
              <div className="relative mx-auto h-[190px] w-[190px]">
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={rows.filter((r) => r.v > 0)} dataKey="v" nameKey="key" innerRadius={62} outerRadius={92} startAngle={90} endAngle={-270}
                      stroke="var(--surface)" strokeWidth={2} isAnimationActive={false} onClick={(e) => setDrill(e?.payload?.key || e?.key)} style={{ cursor: 'pointer' }}>
                      {rows.filter((r) => r.v > 0).map((r) => <Cell key={r.key} fill={CATS[r.key].color} />)}
                    </Pie>
                    <Tooltip formatter={(v, k) => [`${v}% of host CPU`, CATS[k]?.label || k]} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
                  <div><div className="text-[24px] leading-none font-extrabold text-fg tabular-nums">{r1(used)}%</div><div className="mt-1 text-[11px] text-muted">CPU in use</div></div>
                </div>
              </div>
              <table className="w-full text-[12.5px]">
                <thead><tr className="border-b border-border text-left text-[11.5px] font-semibold text-muted"><th className="py-1.5">Category</th><th className="py-1.5 text-right">Usage</th><th className="w-[34%] py-1.5" /><th className="py-1.5 text-right">Trend</th><th className="w-5" /></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} role="button" tabIndex={0} onClick={() => setDrill(r.key)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setDrill(r.key)}
                      className="cursor-pointer border-b border-border last:border-0 hover:bg-raised" aria-label={`Drill into ${CATS[r.key].label}`}>
                      <td className="py-2"><span className="inline-flex items-center gap-2 text-fg"><span className="h-2.5 w-2.5 rounded-full" style={{ background: CATS[r.key].color }} />{CATS[r.key].label}</span></td>
                      <td className="py-2 text-right font-semibold text-fg tabular-nums">{r.v}%</td>
                      <td className="py-2 pl-3"><span className="block h-1.5 overflow-hidden rounded-full bg-sunken"><span className="block h-full rounded-full" style={{ width: `${Math.min(100, r.v)}%`, background: CATS[r.key].color }} /></span></td>
                      <td className="py-2 text-right tabular-nums" title="Latest minus the average over the selected range">
                        {r.trend == null ? <span className="text-subtle">—</span>
                          : <span className={cn('font-semibold', Math.abs(r.trend) < 0.1 ? 'text-muted' : (r.key === 'idle' ? r.trend > 0 : r.trend < 0) ? 'text-success-fg' : 'text-danger-fg')}>{r.trend > 0 ? '↑' : r.trend < 0 ? '↓' : '–'} {Math.abs(r.trend).toFixed(1)}</span>}
                      </td>
                      <td className="py-2 text-right text-subtle"><Icon name="chevron-right" size={13} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 border-t border-border pt-3">
              <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                <h3 className="flex-1 text-[13.5px] font-semibold text-fg">CPU Usage Trend by Category</h3>
                {lineKeys.map((k) => <span key={k} className="inline-flex items-center gap-1.5 text-[11.5px] text-muted"><span className="h-2 w-2 rounded-full" style={{ background: CATS[k].color }} />{CATS[k].label}</span>)}
              </div>
              {histQ.isLoading ? <div className="h-[170px] animate-pulse rounded-md bg-sunken" />
                : histQ.isError ? <p className="py-8 text-center text-[12px] text-danger-fg">{histQ.error?.response?.data?.detail || 'CPU history could not be loaded.'}</p>
                  : samples.length < 2 ? <p className="py-8 text-center text-[12px] text-muted">History builds from the collector&apos;s cycles — the first points appear within a few minutes.</p>
                    : (
                      <ResponsiveContainer width="100%" height={170}>
                        <AreaChart data={samples} margin={{ top: 6, right: 6, left: -18, bottom: 0 }}>
                          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                          <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={tShort} tick={{ fontSize: 10.5, fill: 'var(--fg-muted)' }} stroke="var(--border)" minTickGap={40} />
                          <YAxis domain={[0, (max) => Math.min(100, Math.max(10, Math.ceil(max / 10) * 10))]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 10.5, fill: 'var(--fg-muted)' }} stroke="var(--border)" />
                          <Tooltip labelFormatter={(t) => new Date(t).toLocaleString()} formatter={(v, k) => [`${r1(v)}%`, CATS[k]?.label || k]} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                          {lineKeys.map((k, i) => <Area key={k} type="monotone" dataKey={k} stroke={CATS[k].color} strokeWidth={1.8} fill={CATS[k].color} fillOpacity={i === 0 ? 0.1 : 0} dot={false} isAnimationActive={false} />)}
                        </AreaChart>
                      </ResponsiveContainer>
                    )}
            </div>
            {top && (
              <div className="mt-3 flex items-start gap-2.5 rounded-lg bg-[#f5f3ff] px-3 py-2.5 text-[12px] text-[#4c1d95]">
                <Icon name="sparkles" size={14} className="mt-0.5 shrink-0" />
                <span>
                  <b>Insights: </b>{CATS[top.key].label} take the largest share of CPU time ({top.v}%).
                  {(top.key === 'user' || top.key === 'system') && <> <button type="button" className="font-semibold underline" onClick={() => setDrill(top.key)}>See which processes</button>.</>}
                  {top.key === 'iowait' && top.v > 10 ? ' High I/O wait usually means storage is the bottleneck, not the CPU.' : ''}
                  {top.key === 'steal' && top.v > 5 ? ' High steal means the hypervisor is giving this VM less CPU than it asks for.' : ''}
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function Drill({ cat, total, procs, isWindows, group, setGroup, onBack, onOpenProcess }) {
  const c = CATS[cat];
  const owned = cat === 'user' || cat === 'system';
  const list = Array.isArray(procs) ? procs : [];
  const hasSplit = list.some((p) => p.cpu_user != null);
  // Windows lists only total CPU per process; it is the best available attribution for User + Kernel together.
  const valueOf = (p) => (hasSplit ? p[c.key] : p.cpu);
  const items = owned ? list.map((p) => ({ ...p, v: Number(valueOf(p)) || 0 })).filter((p) => p.v > 0).sort((a, b) => b.v - a.v) : [];
  const explained = items.reduce((a, p) => a + p.v, 0);
  const rest = total != null ? Math.max(0, total - explained) : null;
  const byPid = Object.fromEntries(list.map((p) => [p.pid, p]));
  const groups = useMemo(() => {
    if (group === 'process') return null;
    const m = new Map();
    for (const p of items) {
      const k = group === 'program' ? family(p.command || p.name)
        : p.ppid == null ? 'Parent not reported' : p.ppid <= 1 ? 'Started by init / systemd (PID 1)'
          : byPid[p.ppid] ? `${byPid[p.ppid].command || byPid[p.ppid].name} (PID ${p.ppid})` : `Parent PID ${p.ppid}`;
      const g = m.get(k) || { key: k, v: 0, children: [] };
      g.v += p.v;
      g.children.push(p);
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.v - a.v);
  }, [items, group]); // eslint-disable-line react-hooks/exhaustive-deps
  const max = Math.max(total || 0, ...items.map((p) => p.v), 0.1);
  const Bar = ({ v, color = c.color }) => <span className="block h-1.5 overflow-hidden rounded-full bg-sunken"><span className="block h-full rounded-full" style={{ width: `${Math.min(100, (v / max) * 100)}%`, background: color }} /></span>;
  const Row = ({ p, indent }) => (
    <li>
      <button type="button" onClick={() => onOpenProcess?.(p)} className={cn('grid w-full grid-cols-[minmax(0,1fr)_70px_64px_28%] items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-raised', indent && 'pl-6')}>
        <span className="min-w-0 truncate"><b className="font-semibold text-fg">{p.command || p.name}</b> <span className="text-subtle">PID {p.pid}{p.user ? ` · ${p.user}` : ''}</span></span>
        <span className="text-right font-semibold text-fg tabular-nums">{p.v.toFixed(1)}%</span>
        <span className="text-right text-muted tabular-nums">{total ? `${((p.v / total) * 100).toFixed(0)}%` : '—'}</span>
        <Bar v={p.v} />
      </button>
    </li>
  );
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[12.5px]">
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1 font-semibold text-accent hover:underline"><Icon name="chevron-left" size={13} />All categories</button>
        <Icon name="chevron-right" size={12} className="text-subtle" />
        <span className="inline-flex items-center gap-1.5 font-semibold text-fg"><span className="h-2.5 w-2.5 rounded-full" style={{ background: c.color }} />{c.label}</span>
        <span className="text-muted">· {total != null ? `${total}% of host CPU` : ''}</span>
        {owned && items.length > 0 && (
          <div role="radiogroup" aria-label="Group by" className="ml-auto inline-flex rounded-lg border border-border p-0.5 text-[11.5px] font-semibold">
            {[['process', 'Processes'], ['program', 'By program'], ['parent', 'By parent']].map(([id, l]) => (
              <button key={id} type="button" role="radio" aria-checked={group === id} onClick={() => setGroup(id)}
                className={cn('rounded-md px-2 py-0.5', group === id ? 'bg-accent text-white' : 'text-muted hover:text-fg')}>{l}</button>
            ))}
          </div>
        )}
      </div>

      {!owned ? (
        <p className="rounded-lg bg-sunken/60 px-3 py-3 text-[12.5px] text-muted">{NOT_OWNED[cat]}</p>
      ) : !items.length ? (
        <p className="rounded-lg bg-sunken/60 px-3 py-3 text-[12.5px] text-muted">
          {list.length ? 'None of the 15 busiest processes spent measurable time here in this sample.' : 'No per-process sample from this host yet — it arrives with the next collector cycle.'}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_70px_64px_28%] gap-2 border-b border-border px-2 pb-1 text-[11px] font-semibold text-muted">
            <span>{group === 'process' ? 'Process' : group === 'program' ? 'Program / family' : 'Parent → children'}</span><span className="text-right">Of host</span><span className="text-right">Of {cat === 'user' ? 'user' : 'kernel'}</span><span />
          </div>
          <ul className="mt-1 max-h-[330px] overflow-auto">
            {groups ? groups.map((g) => (
              <li key={g.key} className="border-b border-border last:border-0">
                <div className="grid grid-cols-[minmax(0,1fr)_70px_64px_28%] items-center gap-2 px-2 py-1.5 text-[12.5px]">
                  <span className="min-w-0 truncate font-semibold text-fg">{g.key} <span className="font-normal text-subtle">· {g.children.length} process{g.children.length === 1 ? '' : 'es'}</span></span>
                  <span className="text-right font-bold text-fg tabular-nums">{g.v.toFixed(1)}%</span>
                  <span className="text-right text-muted tabular-nums">{total ? `${((g.v / total) * 100).toFixed(0)}%` : '—'}</span>
                  <Bar v={g.v} />
                </div>
                <ul>{g.children.map((p) => <Row key={p.pid} p={p} indent />)}</ul>
              </li>
            )) : items.map((p) => <Row key={p.pid} p={p} />)}
            {rest != null && rest >= 0.1 && (
              <li className="grid grid-cols-[minmax(0,1fr)_70px_64px_28%] items-center gap-2 px-2 py-1.5 text-[12.5px] text-muted" title="CPU in this category used by processes outside the 15 busiest, short-lived processes and kernel threads that ended between the two reads">
                <span className="italic">Other processes (not in the 15 busiest / short-lived)</span>
                <span className="text-right tabular-nums">{rest.toFixed(1)}%</span>
                <span className="text-right tabular-nums">{total ? `${((rest / total) * 100).toFixed(0)}%` : '—'}</span>
                <Bar v={rest} color="#94a3b8" />
              </li>
            )}
          </ul>
          <p className="mt-2 text-[11px] text-subtle">
            {hasSplit ? `${c.label} = each process's ${cat === 'user' ? 'user' : 'kernel'}-mode CPU over the same 0.5 s sample, as a share of the whole host (all cores = 100%).`
              : 'This host reports total CPU per process (no user / kernel split) — the list shows each process\'s total share.'} Click a process for its details.
          </p>
        </>
      )}
    </div>
  );
}
