import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import client, { errorText } from '@/api/client';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Notice from '@/components/ui/Notice';
import Select from '@/components/ui/Select';
import Table, { EmptyState } from '@/components/ui/Table';
import { Panel, TablePanel } from '@/pages/_shared/enginePanels';
import { API, FindingCard, fmtSec, fmtWhen, num, useDbQuery } from './shared';

const STATUS_TONE = { PARSED: 'success', FAILED: 'danger', PENDING: 'neutral' };

function Compare({ reports }) {
  const parsed = reports.filter((r) => r.status === 'PARSED');
  const [base, setBase] = useState(parsed[1]?.id ? String(parsed[1].id) : '');
  const [target, setTarget] = useState(parsed[0]?.id ? String(parsed[0].id) : '');
  const q = useQuery({
    queryKey: ['awrCompare', base, target], enabled: Boolean(base && target && base !== target), retry: false,
    queryFn: () => client.get(`${API}/compare`, { params: { base, target } }).then((r) => r.data),
  });
  const opts = parsed.map((r) => ({ id: String(r.id), label: `${fmtWhen(r.begin_time)} · ${r.original_filename}` }));
  const d = q.data?.status === 'ok' ? q.data : null;
  const KEYS = ['aas', 'db_cpu_per_s', 'host_cpu_busy_pct', 'log_file_sync_ms', 'single_block_read_ms', 'wait_class_commit_pct',
    'wait_class_user_i_o_pct', 'wait_class_application_pct', 'executes_per_s', 'commits_per_s', 'hard_parses_per_s',
    'logical_reads_per_s', 'physical_reads_per_s', 'sessions_end'];
  return (
    <Panel title="Before / after comparison" icon="trend" subtitle="Compare any two reports — per-second rates, so different window lengths still compare">
      {parsed.length < 2 ? <p className="py-3 text-center text-meta text-muted">Upload at least two reports to compare.</p> : (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="text-meta font-semibold text-muted">Before<Select value={base} onChange={setBase} options={opts} /></label>
            <label className="text-meta font-semibold text-muted">After<Select value={target} onChange={setTarget} options={opts} /></label>
          </div>
          {base === target && <p className="mt-3 text-meta text-muted">Pick two different reports.</p>}
          {q.data?.status === 'error' && <Notice tone="warning" className="mt-3">{q.data.error}</Notice>}
          {d && (
            <div className="mt-3 flex flex-col gap-3">
              {d.warnings.map((w) => <Notice key={w} tone="warning" className="mb-0">{w}</Notice>)}
              <Table
                columns={[{ key: 'm', label: 'Metric' }, { key: 'a', label: 'Before', align: 'right' }, { key: 'b', label: 'After', align: 'right' }, { key: 'c', label: 'Change', align: 'right' }]}
                rows={d.metrics.filter((m) => KEYS.includes(m.metric_key)).sort((x, y) => KEYS.indexOf(x.metric_key) - KEYS.indexOf(y.metric_key)).map((m) => ({
                  key: m.metric_key, cells: { m: m.label, a: `${num(m.base, 2)} ${m.unit}`, b: `${num(m.target, 2)} ${m.unit}`,
                    c: m.pct_change == null ? '—' : <b className={Math.abs(m.pct_change) >= 25 ? 'text-warning-fg' : 'text-fg'}>{m.pct_change >= 0 ? '+' : ''}{num(m.pct_change, 0)}%</b> } }))}
              />
              <Table
                columns={[{ key: 'id', label: 'SQL ID' }, { key: 's', label: 'Status' }, { key: 'a', label: 'Before / exec', align: 'right' }, { key: 'b', label: 'After / exec', align: 'right' }, { key: 'r', label: 'Ratio', align: 'right' }, { key: 'mod', label: 'Module' }]}
                empty={<EmptyState icon="zap" title="No SQL in either report" />}
                rows={d.sql.slice(0, 15).map((s) => ({ key: s.sql_id, cells: {
                  id: <code className="font-mono text-[12px]">{s.sql_id}</code>, s: <Badge tone={s.status === 'new' ? 'info' : s.status === 'gone' ? 'neutral' : 'outline'} size="xs">{s.status}</Badge>,
                  a: fmtSec(s.base_per_exec_s), b: fmtSec(s.target_per_exec_s),
                  r: s.ratio == null ? '—' : <b className={s.ratio >= 2 ? 'text-danger-fg' : s.ratio <= 0.5 ? 'text-success-fg' : 'text-fg'}>{num(s.ratio, 2)}×</b>,
                  mod: <span className="text-meta text-muted">{s.module || '—'}</span> } }))}
              />
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

export default function HistoryTab({ databaseKey, reports, onDelete }) {
  const qc = useQueryClient();
  const recQ = useDbQuery(databaseKey, 'recommendations');
  const reanalyze = useMutation({
    mutationFn: (id) => client.post(`${API}/${id}/reanalyze`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ predicate: (q) => ['awrDb', 'oracleAwrReports', 'oracleAwrReportDetail', 'oracleAwrReportInsights'].includes(q.queryKey[0]) }),
  });
  const outcomes = (recQ.data?.items || []).filter((f) => (f.status && f.status !== 'open') || f.outcome_note);
  const exportUrl = (fmt) => `/api/v1${API}/databases/${encodeURIComponent(databaseKey)}/export?format=${fmt}`;
  return (
    <div className="flex flex-col gap-gutter">
      <TablePanel title="Analysed reports" icon="history" subtitle="Every upload for this database; re-analyse applies the current parser and rules"
                  actions={<>
                    <a href={exportUrl('csv')} download><Button size="sm" icon="download">Export findings (CSV)</Button></a>
                    <a href={exportUrl('json')} download><Button size="sm" variant="ghost" icon="download">JSON</Button></a>
                  </>}>
        <Table
          columns={[{ key: 'w', label: 'Snapshot window' }, { key: 'f', label: 'File' }, { key: 's', label: 'Status' }, { key: 'q', label: 'Data' },
                    { key: 'n', label: 'Findings' }, { key: 'u', label: 'Uploaded' }, { key: 'a', label: '' }]}
          empty={<EmptyState icon="report" title="No reports" />}
          rows={reports.map((r) => ({ key: r.id, cells: {
            w: r.begin_time ? `${fmtWhen(r.begin_time)} · ${num(r.elapsed_minutes, 0)} min` : '—',
            f: <span className="block max-w-[16rem] truncate text-meta" title={r.original_filename}>{r.original_filename}</span>,
            s: <Badge tone={STATUS_TONE[r.status] || 'neutral'} size="xs">{r.status}</Badge>,
            q: r.data_quality?.level ? <Badge tone={r.data_quality.level === 'complete' ? 'success' : 'warning'} size="xs">{r.data_quality.level}</Badge> : '—',
            n: r.status === 'PARSED' ? `${r.high_findings}H · ${r.medium_findings}M · ${r.low_findings}L` : <span className="text-micro text-danger-fg">{r.error_message}</span>,
            u: fmtWhen(r.created_at),
            a: (
              <span className="flex gap-1">
                <Button size="sm" variant="ghost" loading={reanalyze.isPending && reanalyze.variables === r.id} onClick={() => reanalyze.mutate(r.id)}>Re-analyse</Button>
                <a href={`/api/v1${API}/${r.id}/download`} download={r.original_filename}><Button size="sm" variant="ghost" icon="download" aria-label="Download" /></a>
                <Button size="sm" variant="danger-ghost" icon="trash" aria-label="Delete" onClick={() => onDelete(r)} />
              </span>
            ) } }))}
        />
      </TablePanel>
      {reanalyze.data?.status === 'error' && <Notice tone="warning">{reanalyze.data.error}</Notice>}
      {reanalyze.error && <Notice tone="danger">{errorText(reanalyze.error)}</Notice>}
      <Compare reports={reports} />
      <Panel title="Remediation outcomes" icon="check" subtitle="Findings a DBA acknowledged, resolved or annotated">
        {!outcomes.length ? <p className="py-3 text-center text-meta text-muted">No outcomes recorded yet — open a finding and acknowledge or resolve it with a note.</p>
          : <div className="flex flex-col gap-2.5">{outcomes.map((f) => <FindingCard key={f.id} f={f} />)}</div>}
      </Panel>
    </div>
  );
}
