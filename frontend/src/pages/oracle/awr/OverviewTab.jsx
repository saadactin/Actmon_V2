import LineChart from '@/components/charts/LineChart';
import BarList from '@/components/charts/BarList';
import { Panel } from '@/pages/_shared/enginePanels';
import { FindingList, Insufficient, MetricTile, QueryState, SEVERITY, fmtWhen, num, shortLabel, useDbQuery } from './shared';

const label = shortLabel;

function SeverityStrip({ dist }) {
  const order = ['HIGH', 'MEDIUM', 'LOW', 'INFO'];
  const total = order.reduce((s, k) => s + (dist[k] || 0), 0);
  if (!total) return <p className="text-meta text-muted">No findings.</p>;
  return (
    <div>
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-sm" role="img"
           aria-label={order.map((k) => `${dist[k] || 0} ${k.toLowerCase()}`).join(', ')}>
        {order.filter((k) => dist[k]).map((k) => (
          <span key={k} style={{ width: `${(dist[k] / total) * 100}%`, background: SEVERITY[k].bar }} title={`${dist[k]} ${SEVERITY[k].label}`} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
        {order.map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5 text-meta text-muted">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: SEVERITY[k].bar }} />
            {SEVERITY[k].label} <b className="text-fg tabular-nums">{dist[k] || 0}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

export default function OverviewTab({ databaseKey }) {
  const q = useDbQuery(databaseKey, 'overview');
  return (
    <QueryState q={q}>
      {(d) => {
        const w = d.workload;
        const cpus = d.database.num_cpus;
        return (
          <div className="flex flex-col gap-gutter">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <MetricTile label="Avg active sessions" value={w.aas == null ? null : num(w.aas, 1)}
                        sub={cpus ? `latest window · host has ${num(cpus, 0)} CPUs` : 'latest window'} icon="activity" tone="info" valueTone="info" />
              <MetricTile label="Host CPU busy" unit="%" value={w.host_cpu_busy_pct == null ? null : num(w.host_cpu_busy_pct, 1)}
                        sub={w.db_cpu_util_pct == null ? 'from OS statistics' : `database uses ${num(w.db_cpu_util_pct, 1)}% of CPUs`} icon="cpu" tone="accent" />
              <MetricTile label="Commit latency" unit="ms" value={w.log_file_sync_ms == null ? null : num(w.log_file_sync_ms, 1)}
                        sub="avg log file sync · healthy is a few ms" icon="clock" tone={w.log_file_sync_ms >= 20 ? 'danger' : 'good'} valueTone={w.log_file_sync_ms >= 20 ? 'danger' : 'neutral'} />
              <MetricTile label="Single-block read" unit="ms" value={w.single_block_read_ms == null ? null : num(w.single_block_read_ms, 2)}
                        sub="avg db file sequential read" icon="gauge" tone={w.single_block_read_ms >= 10 ? 'warning' : 'good'} />
            </div>

            <div className="grid grid-cols-1 gap-gutter xl:grid-cols-[1.3fr_1fr]">
              <Panel title="Load across reports" icon="trend" subtitle="Average active sessions per uploaded snapshot window">
                <LineChart data={(d.history.aas || []).map((p) => ({ label: label(p.time), value: p.value }))} unit="" kind="line"
                           emptyLabel="No history yet" />
              </Panel>
              <Panel title="Findings by severity" icon="alert" subtitle={`Latest report (${fmtWhen(d.latest_report.begin_time)}) + history findings`}>
                <SeverityStrip dist={d.severity_distribution} />
                <div className="mt-5">
                  <p className="mb-2 text-micro font-bold tracking-wide text-subtle uppercase">Daily pattern</p>
                  {d.pattern ? (
                    <>
                      <BarList items={d.pattern.profile.map((p) => ({ key: p.window, label: `${p.window} window`, value: p.median, sub: `median of ${p.n} reports` }))}
                               format={(v) => num(v, 1)} unit="" labelWidth={110} thickness={20} />
                      <p className="mt-2 text-meta text-muted">
                        Peak window {d.pattern.peak_window} was the busiest on {d.pattern.peak_consistency.days_peak} of {d.pattern.peak_consistency.days_compared} full days.
                      </p>
                    </>
                  ) : <Insufficient title="No recurring pattern yet" detail="Needs at least 2 time-of-day windows with 3 reports each." />}
                </div>
              </Panel>
            </div>

            <Panel title="Current risks" icon="alert" subtitle="Open trend and risk findings across this database's history">
              <FindingList findings={d.current_risks} empty="No open risks or worsening trends." />
            </Panel>
            <Panel title="Top findings in the latest report" icon="report" subtitle={d.latest_report.original_filename}>
              <FindingList findings={d.top_findings} empty="No diagnosis findings in the latest report." />
            </Panel>
          </div>
        );
      }}
    </QueryState>
  );
}
