import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import cn from '@/lib/cn';
import Drawer from '@/components/ui/Drawer';
import Icon from '@/components/ui/Icon';
import { getCpuProcessDetail, getCpuProcessTrend } from '@/api/cpu';
import { fmtDuration } from './cpuAnalysis';

/**
 * Process Details — read-only.
 *   snapshot   CPU / memory / threads / user / elapsed from the collector's process list
 *   live       GET /cpu/{id}/process-detail — read on open from the host (agent or SSH): parent PID, executable,
 *              command line (masked unless the viewer has Infrastructure "execute"), working directory, CPU time,
 *              context switches, open files (count for everyone, list with "execute")
 *   history    GET /cpu/{id}/process-trend — host_process_cpu, only the collections where it was in the top 15
 */
const tShort = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const secs = (s) => (s == null ? null : s < 60 ? `${s.toFixed(1)} s` : fmtDuration(s * 1000));

function Kpi({ icon, tint, label, value, children }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-lg" style={{ background: `color-mix(in srgb, ${tint} 14%, transparent)`, color: tint }}><Icon name={icon} size={15} /></span>
        <span className="text-[11.5px] font-semibold text-muted">{label}</span>
      </div>
      <div className="mt-1.5 text-[20px] font-bold text-fg tabular-nums">{value}</div>
      {children}
    </div>
  );
}

export default function ProcessDrawer({ hostId, proc, onClose, onRefresh, refreshing, isWindows, stale, cores }) {
  const [view, setView] = useState(null);   // 'cmd' | 'files' | null
  const trendQ = useQuery({
    queryKey: ['cpuPerf', 'procTrend', hostId, proc?.pid],
    queryFn: () => getCpuProcessTrend(hostId, { pid: proc.pid, minutes: 60, bucket: 60 }),
    enabled: Boolean(proc?.pid), retry: false, refetchInterval: 60_000,
  });
  const detQ = useQuery({
    queryKey: ['cpuPerf', 'procDetail', hostId, proc?.pid],
    queryFn: () => getCpuProcessDetail(hostId, proc.pid),
    enabled: Boolean(proc?.pid), retry: false, staleTime: 30_000,
  });
  if (!proc) return null;
  const d = detQ.data;
  const gone = d && d.exists === false;
  const err = detQ.isError ? (detQ.error?.response?.data?.detail || 'The host did not return details.') : null;
  const series = trendQ.data?.samples || [];
  // Share of the whole host (all cores = 100%) — never above 100.
  const cpu = proc.cpu != null ? Math.min(proc.cpu, 100) : null;
  const startMs = d?.start_time_epoch ? d.start_time_epoch * 1000 : d?.start_time_iso ? Date.parse(d.start_time_iso) : proc.running_s != null ? Date.now() - proc.running_s * 1000 : null;
  const bar = (v, c) => <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-sunken"><span className="block h-full rounded-full" style={{ width: `${Math.min(100, v || 0)}%`, background: c }} /></span>;
  const pending = detQ.isLoading ? <span className="inline-block h-3 w-24 animate-pulse rounded bg-sunken" /> : null;
  const val = (v, why) => pending || (v != null && v !== '' ? v : <span className="text-subtle">{why || (err ? 'Unavailable' : 'N/A')}</span>);
  const refreshAll = () => { onRefresh(); trendQ.refetch(); detQ.refetch(); };
  const filesLabel = d?.open_files_label === 'handles' ? 'Open Handles' : 'Open Files';
  const info = [
    ['Process name', proc.name], ['PID', proc.pid], ['Parent PID', val(d?.ppid)], ['User', proc.user || d?.owner || 'N/A'],
    ['State', gone ? <span className="text-danger-fg">Exited</span> : d?.state ? d.state : stale ? 'Not in the latest snapshot' : 'Running'],
    ['Start time', startMs ? new Date(startMs).toLocaleString() : val(null)],
    ['Executable', val(d?.exe, d?.exe_error)], ['Working directory', val(d?.cwd, d?.cwd_error)],
    ['CPU time', val(d?.cpu_time_s != null ? `${secs(d.cpu_time_s)} (user ${secs(d.cpu_user_s)}, kernel ${secs(d.cpu_kernel_s)})` : null)],
    ['Context switches', val(d?.context_switches != null ? `${d.context_switches.toLocaleString()} (voluntary ${d.ctx_voluntary?.toLocaleString() ?? '—'}, involuntary ${d.ctx_involuntary?.toLocaleString() ?? '—'})` : null, d?.context_switches_error)],
    ['Threads', d?.threads ?? proc.threads ?? 'N/A'], ['Nice value', val(d?.nice)],
  ];
  return (
    <Drawer open onClose={onClose} title="Process Details" subtitle={`${proc.name} · PID ${proc.pid}`} icon="cpu" width={580}>
      <div className="space-y-5">
        <div className="flex items-start gap-3">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent"><Icon name="settings" size={22} /></span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-[18px] font-bold text-fg">{proc.name}</h3>
              <span className={cn('rounded-full px-2 py-0.5 text-[11.5px] font-semibold', gone ? 'bg-danger-soft text-danger-fg' : stale ? 'bg-sunken text-muted' : 'bg-success-soft text-success-fg')}>{gone ? 'Exited' : stale ? 'Not in latest snapshot' : 'Running'}</span>
            </div>
            <p className="text-[12.5px] text-muted">PID <b className="text-fg">{proc.pid}</b> · User <b className="text-fg">{proc.user || d?.owner || 'N/A'}</b>{startMs && <> · Uptime <b className="text-fg">{fmtDuration(Date.now() - startMs)}</b></>}</p>
          </div>
          <button type="button" onClick={refreshAll} aria-label="Refresh details" className="grid h-9 w-9 place-items-center rounded-lg border border-border text-muted hover:bg-raised">
            <Icon name="refresh" size={15} className={refreshing || detQ.isFetching ? 'animate-spin' : undefined} />
          </button>
        </div>

        {err && <p className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-[12px] text-warning-fg"><Icon name="alert" size={13} className="mt-0.5 shrink-0" />Live details could not be read: {err}</p>}
        {gone && <p className="rounded-lg bg-danger-soft px-3 py-2 text-[12px] text-danger-fg">This process has exited since the snapshot — the values below are from the last collection.</p>}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kpi icon="cpu" tint="#f97316" label="CPU Usage" value={cpu != null ? `${cpu.toFixed(1)}%` : 'N/A'}>{bar(cpu, '#f97316')}</Kpi>
          <Kpi icon="memory" tint="#2563eb" label="Memory" value={proc.mem != null ? `${proc.mem.toFixed(1)}%` : 'N/A'}>{bar(proc.mem, '#2563eb')}</Kpi>
          <Kpi icon="layers" tint="#8b5cf6" label="Threads" value={d?.threads ?? proc.threads ?? 'N/A'} />
          <Kpi icon="report" tint="#16a34a" label={filesLabel} value={detQ.isLoading ? '…' : (d?.open_files_count ?? <span className="text-[13px] font-semibold text-subtle">{d?.open_files_error ? 'No access' : 'N/A'}</span>)} />
        </div>
        <p className="-mt-2 text-[11px] text-subtle">{isWindows ? 'CPU = share of total CPU, sampled over 0.4 s.' : `CPU = share of the whole host, measured over 0.5 s (all ${cores || d?.cpus || ''} cores = 100%).`} Memory = share of RAM. Details read live from the host{d?.via ? ` via ${d.via === 'agent' ? 'its agent' : 'SSH'}` : ''}.</p>

        <section>
          <h4 className="mb-1 flex items-center gap-2 text-[13.5px] font-semibold text-fg"><Icon name="activity" size={14} className="text-accent" />CPU and Memory Trend <span className="text-[11.5px] font-normal text-muted">· last 1 hour</span></h4>
          {trendQ.isLoading ? <div className="h-40 animate-pulse rounded-md bg-sunken" />
            : trendQ.isError ? <p className="py-6 text-center text-[12px] text-danger-fg">Process history could not be loaded.</p>
              : series.length < 2 ? <p className="rounded-lg bg-sunken/60 px-3 py-4 text-[12px] text-muted">Not enough history yet. A process is stored only while it is among the 15 busiest; its trend fills in as collections arrive.</p>
                : (
                  <ResponsiveContainer width="100%" height={170}>
                    <AreaChart data={series} margin={{ top: 6, right: 6, left: -18, bottom: 0 }}>
                      <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                      <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={tShort} tick={{ fontSize: 10.5, fill: 'var(--fg-muted)' }} stroke="var(--border)" minTickGap={40} />
                      <YAxis tickFormatter={(v) => `${v}%`} tick={{ fontSize: 10.5, fill: 'var(--fg-muted)' }} stroke="var(--border)" />
                      <Tooltip labelFormatter={(t) => new Date(t).toLocaleString()} formatter={(v, k) => [`${Number(v).toFixed(1)}%`, k === 'cpu' ? 'CPU' : 'Memory']} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                      <Area type="monotone" dataKey="cpu" stroke="#f97316" strokeWidth={1.8} fill="#f97316" fillOpacity={0.12} dot={false} isAnimationActive={false} />
                      <Area type="monotone" dataKey="mem" stroke="#2563eb" strokeWidth={1.8} fill="#2563eb" fillOpacity={0} dot={false} isAnimationActive={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
        </section>

        <section>
          <h4 className="mb-2 flex items-center gap-2 text-[13.5px] font-semibold text-fg"><Icon name="info" size={14} className="text-accent" />Process Information</h4>
          <dl className="grid grid-cols-[150px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-xl border border-border p-3 text-[12.5px]">
            {info.map(([k, v]) => [<dt key={`k${k}`} className="text-muted">{k}</dt>, <dd key={`v${k}`} className="min-w-0 break-words font-medium text-fg">{v}</dd>])}
          </dl>
        </section>

        <section>
          <h4 className="mb-2 flex items-center gap-2 text-[13.5px] font-semibold text-fg"><Icon name="diagnose" size={14} className="text-accent" />Available Diagnostics</h4>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={!d?.command_line} onClick={() => setView(view === 'cmd' ? null : 'cmd')}
              className={cn('inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-[12.5px] font-semibold', view === 'cmd' ? 'border-accent bg-accent-soft text-accent' : 'border-border text-fg hover:bg-raised', !d?.command_line && 'cursor-not-allowed text-subtle')}>
              <Icon name="terminal" size={13} />View command line
            </button>
            <button type="button" disabled={!d?.open_files_count} onClick={() => setView(view === 'files' ? null : 'files')}
              className={cn('inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-[12.5px] font-semibold', view === 'files' ? 'border-accent bg-accent-soft text-accent' : 'border-border text-fg hover:bg-raised', !d?.open_files_count && 'cursor-not-allowed text-subtle')}>
              <Icon name="folder" size={13} />View open files{d?.open_files_count != null && ` (${d.open_files_count})`}
            </button>
            <button type="button" onClick={refreshAll} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-accent px-3 text-[12.5px] font-semibold text-accent hover:bg-accent-soft">
              <Icon name="refresh" size={13} className={detQ.isFetching ? 'animate-spin' : undefined} />Refresh details
            </button>
          </div>
          {view === 'cmd' && d?.command_line && (
            <div className="mt-3">
              <pre className="max-h-48 overflow-auto rounded-lg bg-[#0f172a] p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all text-[#e2e8f0]">{d.command_line}</pre>
              {d.command_masked && <p className="mt-1 text-[11px] text-subtle">{d.full_access ? 'Values that look like passwords or tokens are masked.' : 'Passwords and tokens are masked. The unmasked command line needs the Infrastructure “Execute” permission.'}</p>}
            </div>
          )}
          {view === 'files' && (
            <div className="mt-3 rounded-lg border border-border">
              {!d?.open_files ? (
                <p className="px-3 py-3 text-[12px] text-muted">{d?.open_files_count} {filesLabel.toLowerCase()}. The list of paths needs the Infrastructure “Execute” permission.</p>
              ) : (
                <>
                  {d.open_files_note && <p className="border-b border-border px-3 py-2 text-[11px] text-subtle">{d.open_files_note}</p>}
                  <ul className="max-h-64 divide-y divide-border overflow-auto text-[12px]">
                    {d.open_files.map((f) => (
                      <li key={f.target} className="flex items-center gap-2 px-3 py-1.5">
                        <Icon name={/^(socket|pipe|anon_inode)$/.test(f.target) ? 'link' : 'report'} size={12} className="shrink-0 text-subtle" />
                        <span className={cn('min-w-0 flex-1 truncate font-mono', /\(deleted\)$/.test(f.target) && 'text-warning-fg')} title={f.target}>{f.target}</span>
                        {f.count > 1 && <span className="shrink-0 rounded bg-sunken px-1.5 text-[11px] font-semibold text-muted">×{f.count}</span>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
          <p className="mt-3 flex items-start gap-2 rounded-lg bg-info-soft px-3 py-2 text-[11.5px] text-info-fg"><Icon name="info" size={13} className="mt-0.5 shrink-0" />Read-only: these details are read from the host when you open a process. Nothing here can stop or change it.</p>
        </section>
      </div>
    </Drawer>
  );
}
