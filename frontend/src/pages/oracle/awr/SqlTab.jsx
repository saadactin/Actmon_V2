import { useState } from 'react';
import Badge from '@/components/ui/Badge';
import CopyButton from '@/components/ui/CopyButton';
import Notice from '@/components/ui/Notice';
import Tabs from '@/components/ui/Tabs';
import Table, { EmptyState } from '@/components/ui/Table';
import { Panel, TablePanel } from '@/pages/_shared/enginePanels';
import { FindingList, Insufficient, QueryState, fmtSec, num, useDbQuery } from './shared';

const Id = ({ id }) => (
  <span className="flex items-center gap-1"><code className="font-mono text-[12px] font-semibold text-fg">{id}</code><CopyButton text={id} label="Copy" variant="ghost" /></span>
);
const Mod = ({ module, text }) => (
  <span className="block max-w-[24rem] leading-tight" title={text || ''}>
    <span className="block truncate text-meta text-fg">{module || '—'}</span>
    {text && <span className="block truncate font-mono text-micro text-subtle">{text}</span>}
  </span>
);

const LATEST_VIEWS = [
  { id: 'by_elapsed', label: 'Elapsed', col: 'elapsed_s', fmt: fmtSec, unit: 'Elapsed' },
  { id: 'by_cpu', label: 'CPU', col: 'cpu_s', fmt: fmtSec, unit: 'CPU time' },
  { id: 'by_gets', label: 'Buffer gets', col: 'buffer_gets', fmt: (v) => num(v, 0), unit: 'Gets' },
  { id: 'by_reads', label: 'Physical reads', col: 'physical_reads', fmt: (v) => num(v, 0), unit: 'Reads' },
  { id: 'by_parse_calls', label: 'Parse calls', col: 'parse_calls', fmt: (v) => num(v, 0), unit: 'Parse calls' },
  { id: 'by_version_count', label: 'Version count', col: 'version_count', fmt: (v) => num(v, 0), unit: 'Versions' },
];

export default function SqlTab({ databaseKey }) {
  const q = useDbQuery(databaseKey, 'sql');
  const [view, setView] = useState('by_elapsed');
  return (
    <QueryState q={q}>
      {(d) => {
        const v = LATEST_VIEWS.find((x) => x.id === view);
        return (
          <div className="flex flex-col gap-gutter">
            <Panel title="SQL regressions" icon="trend" subtitle="Elapsed time per execution in the latest report vs the median of earlier reports (≥ 5 executions each)">
              {d.regressions_status !== 'ok' ? <Insufficient detail="Needs at least 3 reports of this database." /> : !d.regressions.length ? (
                <p className="py-3 text-center text-meta text-muted">No statement is ≥ 2× slower per execution than its history.</p>
              ) : (
                <Table
                  columns={[{ key: 'id', label: 'SQL ID' }, { key: 'ratio', label: 'Slower by', align: 'right' }, { key: 'now', label: 'Now / exec', align: 'right' },
                            { key: 'base', label: 'Baseline / exec', align: 'right' }, { key: 'n', label: 'Baseline reports', align: 'right' }, { key: 'mod', label: 'Module' }]}
                  rows={d.regressions.map((r) => ({ key: r.sql_id, cells: {
                    id: <Id id={r.sql_id} />, ratio: <Badge tone={r.ratio >= 5 ? 'danger' : 'warning'}>{num(r.ratio, 1)}×</Badge>,
                    now: fmtSec(r.latest_per_exec_s), base: fmtSec(r.baseline_per_exec_s), n: r.baseline_reports, mod: <Mod module={r.module} /> } }))}
                />
              )}
              <Notice tone="info" className="mt-3 mb-0">{d.plan_history.reason}</Notice>
            </Panel>

            <TablePanel title="Most expensive SQL across all reports" icon="zap" subtitle="Ranked by total elapsed time over every uploaded window of this database">
              <Table
                columns={[{ key: 'id', label: 'SQL ID' }, { key: 'el', label: 'Total elapsed', align: 'right' }, { key: 'rep', label: 'Reports', align: 'right' },
                          { key: 'pe', label: 'Median / exec', align: 'right' }, { key: 'max', label: 'Peak % DB time', align: 'right' },
                          { key: 'prof', label: 'Profile' }, { key: 'mod', label: 'Module / text' }]}
                empty={<EmptyState icon="zap" title="No SQL statistics" />}
                rows={d.ranking.map((r) => ({ key: r.sql_id, cells: {
                  id: <Id id={r.sql_id} />, el: fmtSec(r.elapsed_s), rep: r.reports, pe: fmtSec(r.median_per_exec_s),
                  max: r.max_pct_db_time ? `${num(r.max_pct_db_time, 1)}%` : '—',
                  prof: <Badge tone={r.profile === 'CPU-heavy' ? 'warning' : r.profile === 'I/O-heavy' ? 'info' : 'neutral'}>{r.profile}</Badge>,
                  mod: <Mod module={r.module} text={r.text_preview} /> } }))}
              />
            </TablePanel>

            <TablePanel title="Latest report: top statements by resource" icon="report" subtitle="From the AWR 'SQL ordered by …' lists"
                        actions={<Tabs tabs={LATEST_VIEWS.map(({ id, label }) => ({ id, label }))} value={view} onChange={setView} className="border-0" />}>
              <Table
                columns={[{ key: 'id', label: 'SQL ID' }, { key: 'val', label: v.unit, align: 'right' }, { key: 'ex', label: 'Executions', align: 'right' },
                          { key: 'pe', label: 'Per exec', align: 'right' }, { key: 'cpu', label: '% CPU', align: 'right' }, { key: 'io', label: '% I/O', align: 'right' }, { key: 'mod', label: 'Module / text' }]}
                empty={<EmptyState icon="zap" title="This list is not in the latest report" />}
                rows={(d.latest[view] || []).map((r) => ({ key: r.sql_id, cells: {
                  id: <Id id={r.sql_id} />, val: v.fmt(r[v.col]), ex: num(r.executions, 0), pe: fmtSec(r.elapsed_per_exec_s),
                  cpu: r.cpu_pct == null ? '—' : `${num(r.cpu_pct)}%`, io: r.io_pct == null ? '—' : `${num(r.io_pct)}%`,
                  mod: <Mod module={r.module} text={r.text_preview} /> } }))}
              />
            </TablePanel>

            {d.latest.frequent_no_rows.length > 0 && (
              <TablePanel title="Frequent statements returning no rows" icon="activity" subtitle="Often polling loops — each empty execution still costs CPU">
                <Table
                  columns={[{ key: 'id', label: 'SQL ID' }, { key: 'ex', label: 'Executions', align: 'right' }, { key: 'ps', label: 'Per second', align: 'right' }, { key: 'mod', label: 'Module / text' }]}
                  rows={d.latest.frequent_no_rows.map((r) => ({ key: r.sql_id, cells: {
                    id: <Id id={r.sql_id} />, ex: num(r.executions, 0), ps: num(r.executions_per_s, 0), mod: <Mod module={r.module} text={r.text_preview} /> } }))}
                />
              </TablePanel>
            )}

            <Panel title="SQL findings & tuning suggestions" icon="alert" subtitle="Diagnosis of the latest report plus regressions across reports">
              <FindingList findings={d.findings} empty="No SQL findings." />
            </Panel>
          </div>
        );
      }}
    </QueryState>
  );
}
