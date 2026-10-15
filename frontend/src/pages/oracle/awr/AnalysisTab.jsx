import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import cn from '@/lib/cn';
import client, { errorText } from '@/api/client';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import CopyButton from '@/components/ui/CopyButton';
import Icon from '@/components/ui/Icon';
import Notice from '@/components/ui/Notice';
import Table, { EmptyState } from '@/components/ui/Table';
import BarList from '@/components/charts/BarList';
import StatTile from '@/components/charts/StatTile';
import { Panel, TablePanel } from '@/pages/_shared/enginePanels';
import { providerColor } from '@/features/cloud/utils/providerTheme';
import { API, Fact, FindingList, SourceBadge, fmtSec, num } from './shared';

export const ORACLE = providerColor('OCI');
export const MAX_MB = 20;
const STATUS_TONE = { PARSED: 'success', FAILED: 'danger', PENDING: 'neutral' };
// The only efficiency ratios a rule judges (diagnosis.py: < 95%). Colouring
// the others would imply a verdict the rules never make.
const JUDGED_EFFICIENCY = ['buffer nowait', 'library hit'];
const fmtMin = (m) => (m == null ? null : `${Math.round(m).toLocaleString()} min`);
const aas = (r) => (r?.db_time_minutes != null && r?.elapsed_minutes ? r.db_time_minutes / r.elapsed_minutes : null);

export function DropZone({ onFiles, onBrowse, busy, compact }) {
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onFiles(e.dataTransfer.files); }}
      className={cn('mb-gutter flex flex-wrap items-center gap-4 rounded-2xl border-2 border-dashed px-5 transition-all',
        compact ? 'py-4' : 'flex-col justify-center py-10 text-center', over && 'scale-[1.005]')}
      style={{
        borderColor: `color-mix(in srgb, ${ORACLE} ${over ? 70 : 32}%, transparent)`,
        background: `linear-gradient(135deg, color-mix(in srgb, ${ORACLE} ${over ? 14 : 7}%, var(--surface)) 0%, var(--surface) 70%)`,
      }}
    >
      <div className={cn('grid shrink-0 place-items-center rounded-2xl text-white shadow-sm', compact ? 'h-12 w-12' : 'h-16 w-16')}
           style={{ background: `linear-gradient(135deg, color-mix(in srgb, ${ORACLE} 80%, white), ${ORACLE})` }}>
        <Icon name={busy ? 'spinner' : 'report'} size={compact ? 22 : 28} className={busy ? 'animate-spin' : undefined} />
      </div>
      <div className={cn('min-w-0', compact && 'flex-1')}>
        <p className={cn('font-bold text-fg', compact ? 'text-[15px]' : 'text-lg')}>{busy ? 'Analysing AWR reports…' : 'Drop AWR HTML reports here'}</p>
        <p className="mt-0.5 text-meta text-muted">
          .html / .htm, up to {MAX_MB} MB each · several files analyse as a batch · duplicates are refused · files are parsed as text, never executed
        </p>
      </div>
      <Button variant={compact ? 'secondary' : 'primary'} icon="report" onClick={onBrowse} disabled={busy}>Browse files</Button>
    </div>
  );
}

export function FeatureStrip() {
  const items = [
    { icon: 'alert', cls: 'bg-danger-soft text-danger-fg', title: 'Diagnosis from one report', body: 'Commit latency, I/O, CPU, locks, parsing, memory and expensive SQL — each with evidence, actions, validation and rollback.' },
    { icon: 'trend', cls: 'bg-info-soft text-info-fg', title: 'Trends across reports', body: 'Upload several reports of one database for trends, SQL regressions, anomalies and recurring peak windows.' },
    { icon: 'clock', cls: 'bg-warning-soft text-warning-fg', title: 'Backtested forecasts', body: 'Forecasts appear only once there is enough history — with intervals and measured past accuracy.' },
    { icon: 'sparkles', cls: 'bg-accent-soft text-accent-text', title: 'AI narrative', body: 'Groq explains and ranks the evidence; it never invents measurements.' },
  ];
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {items.map((it) => (
        <div key={it.title} className="card px-card py-card">
          <span className={cn('grid h-10 w-10 place-items-center rounded-full', it.cls)}><Icon name={it.icon} size={18} /></span>
          <p className="mt-3 text-[15px] font-semibold text-fg">{it.title}</p>
          <p className="mt-1 text-meta text-muted">{it.body}</p>
        </div>
      ))}
    </div>
  );
}

function KpiRow({ reports }) {
  const parsed = reports.filter((r) => r.status === 'PARSED');
  const high = parsed.reduce((s, r) => s + (r.high_findings || 0), 0);
  const medium = parsed.reduce((s, r) => s + (r.medium_findings || 0), 0);
  const latest = parsed.find((r) => aas(r) != null);
  const latestAas = aas(latest);
  return (
    <div className="mb-gutter grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatTile label="Reports analysed" value={parsed.length} sub={reports.length - parsed.length ? `${reports.length - parsed.length} could not be parsed` : `${reports.length} uploaded`} icon="report" tone="accent" />
      <StatTile label="High findings" value={high} sub="diagnosis, across these reports" icon="alert" tone="danger" valueTone={high ? 'danger' : 'neutral'} />
      <StatTile label="Medium findings" value={medium} sub="diagnosis, across these reports" icon="alert" tone="warning" valueTone={medium ? 'warning' : 'neutral'} />
      <StatTile label="Latest load" value={latestAas == null ? null : +latestAas.toFixed(1)} sub={latestAas == null ? 'no DB time in reports yet' : `avg active sessions · ${fmtWhenShort(latest.begin_time)}`} icon="activity" tone="info" valueTone="info" />
    </div>
  );
}
const fmtWhenShort = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

function ReportHistory({ reports, activeId, onSelect, onDelete }) {
  return (
    <Panel title="Report history" icon="history" subtitle={`${reports.length} report${reports.length === 1 ? '' : 's'} · newest window first`}
           bodyClassName="p-2 max-h-[70vh] overflow-y-auto" className="self-start xl:sticky xl:top-4">
      <ul className="flex flex-col gap-1.5">
        {reports.map((r) => {
          const selected = r.id === activeId;
          return (
            <li key={r.id}>
              <div role="button" tabIndex={0} onClick={() => onSelect(r.id)}
                   onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(r.id); } }}
                   className={cn('relative cursor-pointer rounded-xl border px-3 py-2.5 transition-all',
                     selected ? 'border-transparent bg-accent-softer ring-2 ring-accent-soft' : 'border-border hover:bg-sunken')}>
                <span aria-hidden="true" className="absolute inset-y-2 left-0 w-1 rounded-r"
                      style={{ background: r.status !== 'PARSED' ? 'var(--status-unknown)' : r.high_findings ? 'var(--status-critical)' : r.medium_findings ? 'var(--status-warning)' : 'var(--status-good)' }} />
                <div className="flex items-center gap-2 pl-1.5">
                  <span className="truncate-safe min-w-0 flex-1 text-[13px] font-bold text-fg">{r.db_name || r.original_filename}</span>
                  <Badge tone={STATUS_TONE[r.status] || 'neutral'} size="xs">{r.status}</Badge>
                  <a href={`/api/v1${API}/${r.id}/download`} download={r.original_filename} onClick={(e) => e.stopPropagation()}
                     title={`Download ${r.original_filename}`} aria-label={`Download ${r.original_filename}`}
                     className="grid h-6 w-6 place-items-center rounded-md text-subtle hover:bg-surface hover:text-fg"><Icon name="download" size={13} /></a>
                  <button type="button" onClick={(e) => { e.stopPropagation(); onDelete(r); }} title={`Delete ${r.original_filename}`}
                          aria-label={`Delete ${r.original_filename}`} className="grid h-6 w-6 place-items-center rounded-md text-subtle hover:bg-danger-soft hover:text-danger-fg">
                    <Icon name="trash" size={13} />
                  </button>
                </div>
                <p className="truncate-safe mt-0.5 pl-1.5 text-micro text-subtle" title={r.original_filename}>{r.original_filename}</p>
                <p className="mt-0.5 pl-1.5 text-meta text-muted">
                  {r.begin_snap ? `Snap ${r.begin_snap} → ${r.end_snap}` : 'No snapshot range found'}{r.elapsed_minutes ? ` · ${fmtMin(r.elapsed_minutes)}` : ''}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1 pl-1.5">
                  {r.status === 'PARSED' ? (
                    <>
                      {r.high_findings > 0 && <Badge tone="danger" size="xs">{r.high_findings} high</Badge>}
                      {r.medium_findings > 0 && <Badge tone="warning" size="xs">{r.medium_findings} medium</Badge>}
                      {!r.high_findings && !r.medium_findings && <Badge tone="success" size="xs">no issues</Badge>}
                    </>
                  ) : <span className="text-micro text-danger-fg">{r.error_message || 'Not parsed'}</span>}
                  <span className="ml-auto text-micro text-subtle">{new Date(r.begin_time || r.created_at).toLocaleString()}</span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function SummaryCard({ report, findingCount }) {
  const load = aas(report);
  const q = report.data_quality || {};
  return (
    <section className="card overflow-hidden">
      <div className="h-1.5" style={{ background: `linear-gradient(90deg, ${ORACLE}, color-mix(in srgb, ${ORACLE} 35%, var(--chart-4)))` }} />
      <div className="px-card py-card">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-bold text-fg">{report.db_name || report.original_filename}</h2>
          {report.instance_name && <Badge tone="outline">{report.instance_name}{report.instance_number ? ` #${report.instance_number}` : ''}</Badge>}
          {report.begin_snap && <Badge tone="accent">Snap {report.begin_snap} → {report.end_snap}</Badge>}
          {report.begin_time && <Badge tone="neutral">{new Date(report.begin_time).toLocaleString()}{report.end_time ? ` – ${new Date(report.end_time).toLocaleTimeString()}` : ''}</Badge>}
          {q.level && <Badge tone={q.level === 'complete' ? 'success' : 'warning'} title={(q.missing_sections || []).join(', ') || 'All expected sections present'}>Data {q.level}</Badge>}
        </div>
        <p className="mt-1 text-meta text-muted">
          {[report.host_name, report.platform, report.db_release && `Oracle ${report.db_release}`, report.is_rac != null && (report.is_rac ? 'RAC' : 'single instance'),
            report.num_cpus && `${num(report.num_cpus, 0)} CPUs`, report.host_mem_gb && `${num(report.host_mem_gb, 0)} GB RAM`, report.dbid && `DBID ${report.dbid}`]
            .filter(Boolean).join(' · ')}
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Fact icon="clock" label="Elapsed" value={fmtMin(report.elapsed_minutes) || '—'} />
          <Fact icon="activity" label="DB time" value={fmtMin(report.db_time_minutes) || '—'} />
          <Fact icon="gauge" label="Avg active sessions" value={load == null ? '—' : load.toFixed(1)} sub="DB time ÷ elapsed" />
          <Fact icon="alert" label="Findings" value={report.status === 'PARSED' ? findingCount : '—'} />
        </div>
        {q.missing_sections?.length > 0 && (
          <p className="mt-3 text-meta text-warning-fg">Missing from this report (so not measured): {q.missing_sections.join(', ')}.</p>
        )}
        <p className="mt-2 text-micro text-subtle">{report.original_filename} · {report.file_size_bytes ? `${(report.file_size_bytes / 1048576).toFixed(1)} MB` : ''} · parser {report.parser_version || '—'}</p>
      </div>
    </section>
  );
}

function EfficiencyPanel({ metrics }) {
  return (
    <Panel title="Instance efficiency" icon="gauge" subtitle="Coloured only where a rule judges it (≥ 95% target)">
      {!metrics.length ? <p className="py-6 text-center text-meta text-subtle">No efficiency section in this report</p> : (
        <ul className="flex flex-col gap-3">
          {metrics.map((m) => {
            const judged = JUDGED_EFFICIENCY.some((k) => m.name.toLowerCase().includes(k));
            const ok = m.value != null && m.value >= 95;
            const color = !judged ? 'var(--chart-1)' : ok ? 'var(--status-good)' : 'var(--status-warning)';
            const pct = m.value == null ? 0 : Math.min(Math.max(m.value, 0), 100);
            return (
              <li key={m.name}>
                <div className="flex items-baseline gap-2">
                  <span className="truncate-safe min-w-0 flex-1 text-meta font-semibold text-muted">{m.name}</span>
                  {judged && (
                    <span className="flex items-center gap-1 text-micro font-semibold text-muted">
                      <Icon name={ok ? 'check' : 'alert'} size={10} strokeWidth={3} style={{ color }} />{ok ? 'Meets target' : 'Below target'}
                    </span>
                  )}
                  <span className="w-16 text-right text-[14px] font-bold text-fg tabular-nums">{m.value == null ? '—' : `${num(m.value, 2)}%`}</span>
                </div>
                <div className="relative mt-1 h-1.5 overflow-hidden rounded-sm" style={{ background: 'var(--chart-track)' }}>
                  <span className="absolute inset-y-0 left-0" style={{ width: `${pct}%`, background: color, borderRadius: '0 4px 4px 0' }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function TopSql({ rows }) {
  const maxElapsed = Math.max(...rows.map((r) => r.elapsed_seconds || 0), 0);
  return (
    <TablePanel title="Top SQL by elapsed time" icon="zap" subtitle="This report only — see SQL Insights for history and regressions">
      <Table
        columns={[{ key: 'sql_id', label: 'SQL ID' }, { key: 'elapsed', label: 'Elapsed', align: 'right' }, { key: 'execs', label: 'Executions', align: 'right' },
                  { key: 'per', label: 'Per exec', align: 'right' }, { key: 'cpu', label: '% CPU', align: 'right' }, { key: 'io', label: '% I/O', align: 'right' },
                  { key: 'text', label: 'SQL text / module' }]}
        empty={<EmptyState icon="zap" title="No SQL section in this report" />}
        rows={rows.map((r, i) => ({
          key: `${r.sql_id || 'sql'}-${i}`,
          cells: {
            sql_id: r.sql_id ? <span className="flex items-center gap-1"><code className="font-mono text-[12px] font-semibold text-fg">{r.sql_id}</code><CopyButton text={r.sql_id} label="Copy" variant="ghost" /></span> : '—',
            elapsed: (
              <span className="inline-flex items-center gap-2">
                <span className="hidden h-1.5 w-16 overflow-hidden rounded-sm sm:block" style={{ background: 'var(--chart-track)' }}>
                  <span className="block h-full" style={{ width: `${maxElapsed ? ((r.elapsed_seconds || 0) / maxElapsed) * 100 : 0}%`, background: 'var(--chart-2)' }} />
                </span>
                <b className="text-fg">{fmtSec(r.elapsed_seconds)}</b>
              </span>
            ),
            execs: num(r.executions, 0), per: fmtSec(r.elapsed_per_exec_seconds),
            cpu: r.cpu_pct == null ? '—' : `${num(r.cpu_pct)}%`, io: r.io_pct == null ? '—' : `${num(r.io_pct)}%`,
            text: (
              <span className="block max-w-[26rem] leading-tight" title={r.sql_text || ''}>
                <span className="block truncate font-mono text-[12px] text-fg">{r.sql_text || '—'}</span>
                {r.module && <span className="block truncate text-micro text-subtle">{r.module}</span>}
              </span>
            ),
          },
        }))}
      />
    </TablePanel>
  );
}

function ReportDetail({ report }) {
  const parsed = report.status === 'PARSED';
  const detailQ = useQuery({ queryKey: ['oracleAwrReportDetail', report.id], queryFn: () => client.get(`${API}/${report.id}`).then((r) => r.data) });
  const insightsQ = useQuery({
    queryKey: ['oracleAwrReportInsights', report.id], queryFn: () => client.get(`${API}/${report.id}/insights`).then((r) => r.data),
    enabled: parsed, staleTime: Infinity,
  });
  const findings = (detailQ.data?.findings || []).filter((f) => f.source === 'rule');
  const insights = insightsQ.data?.status === 'ok' ? insightsQ.data : null;
  return (
    <div className="flex min-w-0 flex-col gap-gutter">
      <SummaryCard report={report} findingCount={findings.length} />
      {!parsed && <Notice tone="danger" title="This report could not be parsed.">{report.error_message || 'The file did not look like an Oracle AWR HTML report.'}</Notice>}
      {parsed && insightsQ.isLoading && <Panel><p className="py-6 text-center text-meta text-muted">Reading wait events and SQL from the report…</p></Panel>}
      {insightsQ.data?.status === 'error' && <Notice tone="warning">{insightsQ.data.error}</Notice>}
      {insights && (
        <>
          <div className="grid grid-cols-1 gap-gutter 2xl:grid-cols-[1.4fr_1fr]">
            <Panel title="Top timed events" icon="clock" subtitle="Share of DB time in this snapshot window — DB CPU is work, not a wait">
              <BarList items={insights.wait_events.filter((w) => w.percent_db_time != null).map((w) => ({
                key: w.name, label: w.name, value: w.percent_db_time,
                sub: [w.wait_class && `${w.wait_class} class`, w.avg_wait_ms != null && `avg ${num(w.avg_wait_ms, 2)} ms`].filter(Boolean).join(' · '),
              }))} format={(v) => num(v)} unit="%" labelWidth={200} thickness={22} emptyLabel="No wait events found in this report" />
            </Panel>
            <EfficiencyPanel metrics={insights.instance_efficiency} />
          </div>
          {insights.load_profile.length > 0 && (
            <Panel title="Load profile" icon="trend" subtitle="Per second, averaged over the snapshot window">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
                {insights.load_profile.map((m) => (
                  <div key={m.name} className="rounded-xl border border-border px-3 py-2">
                    <p className="truncate-safe text-micro font-bold tracking-wide text-subtle uppercase" title={m.name}>{m.name}</p>
                    <p className="mt-0.5 text-[16px] font-bold text-fg tabular-nums">{num(m.per_second, 2)}</p>
                  </div>
                ))}
              </div>
            </Panel>
          )}
          <TopSql rows={insights.top_sql} />
        </>
      )}
      <Panel title="Diagnosis for this report" icon="alert" subtitle="Rule checks on this snapshot window — open a finding for its evidence, actions, validation and rollback">
        {detailQ.isLoading ? <p className="py-4 text-center text-meta text-muted">Loading findings…</p> : <FindingList findings={findings} empty="No rule findings." />}
      </Panel>
      {parsed && <AiPanel reportId={report.id} />}
    </div>
  );
}

export function AiPanel({ reportId }) {
  const qc = useQueryClient();
  const analyze = useMutation({
    mutationFn: () => client.post(`${API}/${reportId}/analyze-groq`, null, { timeout: 120000 }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ predicate: (q) => ['awrDb', 'oracleAwrReportDetail'].includes(q.queryKey[0]) }),
  });
  const result = analyze.data;
  const a = result?.status === 'success' ? result.analysis : null;
  return (
    <section className="card overflow-hidden" style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--chart-7) 9%, var(--surface)) 0%, var(--surface) 65%)' }}>
      <div className="flex flex-wrap items-center gap-3 px-card py-card">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-white" style={{ background: 'linear-gradient(135deg, var(--chart-7), var(--chart-5))' }}><Icon name="sparkles" size={18} /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-bold text-fg">AI narrative</p>
          <p className="text-meta text-muted">Groq explains and ranks the measured evidence (metrics, waits, SQL ids, findings — never SQL text). Every claim must cite evidence; anything that does not is removed. Advisory only — nothing is applied to the database.</p>
        </div>
        <Button variant="primary" icon="sparkles" onClick={() => analyze.mutate()} loading={analyze.isPending}>{a ? 'Regenerate' : 'Generate analysis'}</Button>
      </div>
      {(result || analyze.error) && (
        <div className="border-t border-border px-card py-card">
          {analyze.error && <Notice tone="danger">{errorText(analyze.error)}</Notice>}
          {result?.status === 'error' && (
            <Notice tone={result.code === 'no_api_key' ? 'info' : 'warning'} title={result.code === 'no_api_key' ? 'AI analysis is not configured.' : 'AI analysis unavailable.'}>{result.error}</Notice>
          )}
          {a && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={{ critical: 'danger', high: 'danger', medium: 'warning', low: 'info' }[a.severity] || 'neutral'}>{a.severity}</Badge>
                <SourceBadge source="llm" />
                <span className="text-micro text-subtle">{result.model} · {result.prompt_version}</span>
              </div>
              <p className="text-[14px] text-fg">{a.summary}</p>
              {(result.dropped_unsupported > 0 || result.unverified_numbers?.length > 0) && (
                <Notice tone="warning">
                  {result.dropped_unsupported > 0 && `${result.dropped_unsupported} claim(s) without valid evidence were removed. `}
                  {result.unverified_numbers?.length > 0 && `Numbers not found in the evidence: ${result.unverified_numbers.join(', ')} — treat them as unverified.`}
                </Notice>
              )}
              <div>
                <p className="mb-1 text-micro font-bold tracking-wide text-subtle uppercase">Plausible causes (ranked)</p>
                <ul className="flex flex-col gap-1.5">
                  {a.hypotheses.map((h, i) => (
                    <li key={i} className="rounded-lg bg-surface px-3 py-2 text-meta">
                      <Badge tone={{ high: 'danger', medium: 'warning', low: 'neutral' }[h.likelihood]} size="xs">{h.likelihood} likelihood</Badge>
                      <span className="ml-2 text-fg">{h.cause}</span>
                      <span className="mt-1 flex flex-wrap gap-1">{h.evidence.map((e) => <Badge key={e} tone="outline" size="xs">{e}</Badge>)}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <p className="text-meta text-muted">The {a.actions.length} proposed actions are saved as AI recommendations on the Recommendations tab, with validation and rollback steps.</p>
              {a.caveats?.length > 0 && <ul className="list-disc pl-5 text-meta text-muted">{a.caveats.map((c, i) => <li key={i}>{c}</li>)}</ul>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export default function AnalysisTab({ reports, selectedId, setSelectedId, onFiles, onBrowse, uploading, onDelete }) {
  const activeId = reports.some((r) => r.id === selectedId) ? selectedId : reports[0]?.id ?? null;
  const active = reports.find((r) => r.id === activeId);
  return (
    <div>
      <DropZone onFiles={onFiles} onBrowse={onBrowse} busy={uploading} compact={reports.length > 0} />
      {!reports.length ? <FeatureStrip /> : (
        <>
          <KpiRow reports={reports} />
          <div className="grid grid-cols-1 gap-gutter xl:grid-cols-[minmax(300px,360px)_1fr]">
            <ReportHistory reports={reports} activeId={activeId} onSelect={setSelectedId} onDelete={onDelete} />
            {active && <ReportDetail key={active.id} report={active} />}
          </div>
        </>
      )}
    </div>
  );
}
