import LineChart from '@/components/charts/LineChart';
import { Panel } from '@/pages/_shared/enginePanels';
import { Fact, Insufficient, QueryState, fmtDay, num, useDbQuery, shortLabel } from './shared';

const label = shortLabel;

function Threshold({ est, what }) {
  if (!est) return null;
  if (est.status === 'insufficient') return <Insufficient className="mt-3" detail={est.detail} />;
  const text = {
    crossed: `Already reached: peak ${num(est.peak, 1)} ≥ ${num(est.threshold, 1)}.`,
    no_upward_trend: est.slope_per_day < 0 && est.trend_p < 0.05
      ? `Falling (${num(est.slope_per_day, 2)}/day, p = ${num(est.trend_p, 3)}), so no crossing of ${what} is projected.`
      : `No statistically significant rise (p = ${num(est.trend_p, 3)}), so no crossing date is estimated for ${what}.`,
    estimated: `At the current rise, ${what} is reached in about ${num(est.days_to_threshold, 0)} days (around ${fmtDay(est.eta)}). ${est.method}.`,
  }[est.status];
  return <p className="mt-3 rounded-lg bg-sunken px-3 py-2 text-meta text-fg">{text}</p>;
}

export default function CapacityTab({ databaseKey }) {
  const q = useDbQuery(databaseKey, 'capacity');
  return (
    <QueryState q={q}>
      {(d) => {
        const c = d.capacity; const h = d.history;
        const series = (k) => (h[k] || []).map((p) => ({ label: label(p.time), value: p.value }));
        return (
          <div className="flex flex-col gap-gutter">
            <div className="grid grid-cols-1 gap-gutter xl:grid-cols-2">
              <Panel title="CPU" icon="cpu" subtitle={d.num_cpus ? `${num(d.num_cpus, 0)} CPUs on the host` : 'CPU count not in the reports'}>
                <div className="grid grid-cols-3 gap-3">
                  <Fact label="Host busy (latest)" value={c.cpu.host_busy_pct.latest == null ? '—' : `${num(c.cpu.host_busy_pct.latest, 1)}%`} />
                  <Fact label="Host busy (peak)" value={c.cpu.host_busy_pct.peak == null ? '—' : `${num(c.cpu.host_busy_pct.peak, 1)}%`} />
                  <Fact label="Peak AAS vs CPUs" value={c.cpu.aas_vs_cpus ? `${num(c.cpu.aas_vs_cpus.peak_pct_of_cpus, 0)}%` : '—'}
                        sub={c.cpu.aas_vs_cpus ? `${num(c.cpu.aas_vs_cpus.peak_aas, 1)} active sessions` : undefined} />
                </div>
                <div className="mt-3"><LineChart data={series('host_cpu_busy_pct')} unit="%" kind="line" thresholds domain={[0, 100]} emptyLabel="No OS statistics in these reports" /></div>
                <Threshold est={c.cpu.host_busy_pct.to_80pct} what="80% host CPU busy" />
                {c.cpu.aas_vs_cpus && <Threshold est={c.cpu.aas_vs_cpus.to_80pct_of_cpus} what="active sessions at 80% of the CPU count" />}
              </Panel>
              <Panel title="Memory" icon="gauge" subtitle={d.host_mem_gb ? `${num(d.host_mem_gb, 0)} GB on the host` : 'Host memory not in the reports'}>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Fact label="SGA in use" value={c.memory.sga_used_mb.latest == null ? '—' : `${num(c.memory.sga_used_mb.latest / 1024, 1)} GB`} />
                  <Fact label="PGA allocated" value={c.memory.pga_alloc_mb.latest == null ? '—' : `${num(c.memory.pga_alloc_mb.latest / 1024, 1)} GB`}
                        sub={c.memory.pga_alloc_pct_of_target ? `${num(c.memory.pga_alloc_pct_of_target.latest, 0)}% of target` : undefined} />
                  <Fact label="SGA+PGA of host" value={c.memory.host_mem_used_by_db_pct.latest == null ? '—' : `${num(c.memory.host_mem_used_by_db_pct.latest, 1)}%`}
                        sub={c.memory.host_mem_used_by_db_pct.peak == null ? undefined : `peak ${num(c.memory.host_mem_used_by_db_pct.peak, 1)}%`} />
                  <Fact label="PGA cache hit" value={c.memory.pga_cache_hit_pct.latest == null ? '—' : `${num(c.memory.pga_cache_hit_pct.latest, 1)}%`}
                        tone={c.memory.pga_cache_hit_pct.latest != null && c.memory.pga_cache_hit_pct.latest < 90 ? 'warning' : undefined} />
                </div>
                <div className="mt-3"><LineChart data={series('host_mem_used_by_db_pct')} unit="%" kind="line" domain={[0, 100]} emptyLabel="No memory statistics" /></div>
              </Panel>
            </div>
            <div className="grid grid-cols-1 gap-gutter xl:grid-cols-2">
              <Panel title="Sessions" icon="activity" subtitle="Sessions at the end of each snapshot window">
                <LineChart data={series('sessions_end')} unit="" kind="line" emptyLabel="No session counts" />
                {Object.keys(c.sessions.limits).length ? (
                  <ul className="mt-3 space-y-1 text-meta">
                    {Object.entries(c.sessions.limits).map(([k, v]) => <li key={k}><b>{k.replace(/^limit_|_peak_pct$/g, '').replace(/_/g, ' ')}</b>: peak {num(v.peak, 1)}% of limit</li>)}
                  </ul>
                ) : <p className="mt-3 text-meta text-muted">The reports' Resource Limit section lists no session/process rows (Oracle prints only resources that changed), so limit pressure cannot be judged from them.</p>}
              </Panel>
              <Panel title="Storage I/O demand" icon="trend" subtitle="Read throughput per window (MB/s)">
                <LineChart data={series('read_mb_per_s')} unit=" MB/s" kind="line" emptyLabel="No I/O statistics" />
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <Fact label="Read MB/s (peak)" value={num(c.io.read_mb_per_s.peak, 1)} />
                  <Fact label="Write MB/s (peak)" value={num(c.io.write_mb_per_s.peak, 1)} />
                </div>
              </Panel>
            </div>
            <Panel title="Data growth & time-to-full" icon="layers">
              <Insufficient title="Not available from AWR" detail={c.storage_growth.reason} />
            </Panel>
          </div>
        );
      }}
    </QueryState>
  );
}
