import Badge from '@/components/ui/Badge';
import BarList from '@/components/charts/BarList';
import LineChart from '@/components/charts/LineChart';
import { Panel } from '@/pages/_shared/enginePanels';
import { FindingList, QueryState, num, useDbQuery, shortLabel } from './shared';

const label = shortLabel;

export default function WaitsTab({ databaseKey }) {
  const q = useDbQuery(databaseKey, 'waits');
  return (
    <QueryState q={q}>
      {(d) => (
        <div className="flex flex-col gap-gutter">
          <div className="grid grid-cols-1 gap-gutter xl:grid-cols-2">
            <Panel title="Where DB time went — wait classes" icon="clock" subtitle="Latest report · share of DB time (CPU is work, not a wait)">
              <BarList items={d.classes.filter((c) => c.pct_db_time > 0).map((c) => ({ key: c.metric_key, label: c.label, value: c.pct_db_time }))}
                       format={(v) => num(v, 1)} unit="%" labelWidth={120} thickness={22} />
            </Panel>
            <Panel title="Top wait events" icon="activity" subtitle="Latest report · share of DB time">
              <BarList items={d.events.map((e) => ({ key: e.metric_key, label: e.event, value: e.pct_db_time }))}
                       format={(v) => num(v, 1)} unit="%" labelWidth={210} thickness={18} emptyLabel="No wait events" />
            </Panel>
          </div>

          <Panel title="What each class means" icon="info" subtitle="Interpretation — read alongside the evidence below">
            <dl className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {d.classes.filter((c) => c.guide && c.pct_db_time >= 1).map((c) => {
                const t = d.trends.find((x) => x.metric_key === c.metric_key);
                return (
                  <div key={c.metric_key} className="rounded-xl border border-border p-3">
                    <dt className="flex items-center gap-2 text-[13px] font-semibold text-fg">
                      {c.label} <span className="font-normal text-muted">{num(c.pct_db_time, 1)}% of DB time</span>
                      {t && t.direction !== 'flat' && <Badge tone={t.worsening ? 'warning' : 'success'} size="xs">{t.direction} (p={t.p_value.toFixed(3)})</Badge>}
                    </dt>
                    <dd className="mt-1 text-meta text-muted">{c.guide}</dd>
                    {c.history.length > 1 && (
                      <div className="mt-2"><LineChart data={c.history.map((p) => ({ label: label(p.time), value: p.value }))} unit="%" kind="spark" height={48} /></div>
                    )}
                  </div>
                );
              })}
            </dl>
          </Panel>

          <div className="grid grid-cols-1 gap-gutter xl:grid-cols-2">
            <Panel title="Commit latency per report" icon="clock" subtitle="avg log file sync (ms) — healthy redo storage is typically a few ms">
              <LineChart data={(d.latency.log_file_sync_ms || []).map((p) => ({ label: label(p.time), value: p.value }))} unit=" ms" kind="line" emptyLabel="Not in these reports" />
            </Panel>
            <Panel title="Single-block read latency per report" icon="gauge" subtitle="avg db file sequential read (ms)">
              <LineChart data={(d.latency.single_block_read_ms || []).map((p) => ({ label: label(p.time), value: p.value }))} unit=" ms" kind="line" emptyLabel="Not in these reports" />
            </Panel>
          </div>

          <Panel title="Wait-related findings" icon="alert" subtitle="Evidence-linked diagnosis and trends">
            <FindingList findings={d.findings} empty="No wait-related findings." />
          </Panel>
        </div>
      )}
    </QueryState>
  );
}
