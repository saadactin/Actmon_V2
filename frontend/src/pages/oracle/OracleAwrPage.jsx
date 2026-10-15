import { useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import cn from '@/lib/cn';
import client, { errorText } from '@/api/client';
import PageHeader from '@/components/layout/PageHeader';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import CopyButton from '@/components/ui/CopyButton';
import Icon from '@/components/ui/Icon';
import Notice from '@/components/ui/Notice';
import Table, { EmptyState } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';
import BarList from '@/components/charts/BarList';
import StatTile from '@/components/charts/StatTile';
import { Panel, TablePanel } from '@/pages/_shared/enginePanels';
import ProviderLogo from '@/features/cloud/components/ProviderLogo';
import { providerColor, providerTileStyle } from '@/features/cloud/utils/providerTheme';

/**
 * Oracle AWR Analyzer — upload AWR HTML reports and read them back as
 * findings, top timed events, top SQL, instance efficiency and load profile.
 *
 * Two routes, one page: /cloud/oracle-awr is the whole library (opened from the
 * OCI page), /oracle-dashboard/:id/awr is the same page filtered to — and
 * uploading into — one monitored connection. A report names its own database,
 * so the connection link is optional.
 *
 * Deliberately NOT shown: an ML "risk score". The source project's model is
 * trained on 7 examples with labels derived from its own rule engine (in-sample
 * only), so a bare number would overstate what it knows.
 */

const ORACLE = providerColor('OCI');
const API = '/oracle/awr';
const MAX_MB = 50;

const SEVERITY = {
  HIGH: { tone: 'danger', bar: 'var(--status-critical)', label: 'High', icon: 'alert' },
  MEDIUM: { tone: 'warning', bar: 'var(--status-warning)', label: 'Medium', icon: 'alert' },
  LOW: { tone: 'info', bar: 'var(--chart-1)', label: 'Low', icon: 'info' },
  INFO: { tone: 'neutral', bar: 'var(--status-unknown)', label: 'Info', icon: 'info' },
};
const STATUS_TONE = { PARSED: 'success', FAILED: 'danger', PENDING: 'neutral' };

// The only efficiency ratios the rule engine judges (rule_engine.py, < 95%).
// Colouring the others would imply a verdict the rules never make.
const JUDGED_EFFICIENCY = ['buffer nowait', 'library hit', 'soft parse'];

const num = (v, d = 1) => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d }));
const fmtMin = (m) => (m == null ? null : `${Math.round(m).toLocaleString()} min`);
const fmtSec = (s) => {
  if (s == null) return '—';
  if (s >= 3600) return `${(s / 3600).toFixed(1)} h`;
  if (s >= 60) return `${(s / 60).toFixed(1)} min`;
  return `${s.toFixed(s < 1 ? 3 : 1)} s`;
};
const aas = (r) => (r?.db_time_minutes != null && r?.elapsed_minutes ? r.db_time_minutes / r.elapsed_minutes : null);
const isAwrFile = (f) => /\.html?$/i.test(f.name);

export default function OracleAwrPage() {
  const { id: connectionId } = useParams(); // absent on /cloud/oracle-awr
  const qc = useQueryClient();
  const fileInputRef = useRef(null);
  const [selectedId, setSelectedId] = useState(null);
  const [dbFilter, setDbFilter] = useState('All');
  const [notice, setNotice] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);

  const connQ = useQuery({
    queryKey: ['oracleConnection', connectionId],
    queryFn: () => client.get(`/connections/oracle/${connectionId}`).then((r) => r.data?.data),
    enabled: Boolean(connectionId),
    retry: false,
  });
  const reportsQ = useQuery({
    queryKey: ['oracleAwrReports', connectionId ?? 'all'],
    queryFn: () => client.get(`${API}/`, { params: connectionId ? { connection_id: connectionId } : {} }).then((r) => r.data),
    retry: false,
  });

  const allReports = useMemo(() => reportsQ.data?.reports || [], [reportsQ.data]);
  const databases = useMemo(() => {
    const counts = {};
    allReports.forEach((r) => { const k = r.db_name || 'Unknown'; counts[k] = (counts[k] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [allReports]);
  const reports = dbFilter === 'All' ? allReports : allReports.filter((r) => (r.db_name || 'Unknown') === dbFilter);
  const activeId = reports.some((r) => r.id === selectedId) ? selectedId : reports[0]?.id ?? null;
  const active = reports.find((r) => r.id === activeId);

  const remove = useMutation({
    mutationFn: (rid) => client.delete(`${API}/${rid}`).then((r) => r.data),
    onSuccess: (result, rid) => {
      setPendingDelete(null);
      if (result?.status === 'error') { setNotice({ tone: 'danger', text: result.error }); return; }
      if (selectedId === rid) setSelectedId(null);
      setNotice({ tone: 'success', text: 'Report deleted.' });
      qc.invalidateQueries({ queryKey: ['oracleAwrReports'] });
    },
    onError: (err) => { setPendingDelete(null); setNotice({ tone: 'danger', text: errorText(err) }); },
  });

  const upload = useMutation({
    mutationFn: (files) => {
      const multiple = files.length > 1;
      const form = new FormData();
      files.forEach((f) => form.append(multiple ? 'files' : 'file', f));
      if (connectionId) form.append('connection_id', connectionId);
      return client.post(`${API}/${multiple ? 'batch-upload' : 'upload'}`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 300000,
      }).then((r) => r.data);
    },
    onSuccess: (result) => {
      if (result?.status === 'error') {
        setNotice({ tone: 'danger', text: result.error });
        return;
      }
      if (result?.batch_id) {
        const tone = result.failed ? 'warning' : 'success';
        setNotice({ tone, text: `Batch analysed: ${result.succeeded} of ${result.total} reports parsed${result.failed ? `, ${result.failed} failed` : ''}.` });
      } else if (result?.report?.status === 'FAILED') {
        setNotice({ tone: 'danger', text: `Could not parse ${result.report.original_filename}: ${result.report.error_message}` });
      } else {
        setNotice({ tone: 'success', text: `${result.report.original_filename} analysed.` });
      }
      const newest = result?.report?.id ?? result?.results?.find((r) => r.report)?.report?.id;
      if (newest) { setSelectedId(newest); setDbFilter('All'); }
      qc.invalidateQueries({ queryKey: ['oracleAwrReports'] });
    },
    onError: (err) => setNotice({ tone: 'danger', text: errorText(err) }),
  });

  const handleFiles = (fileList) => {
    const files = Array.from(fileList || []);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!files.length) return;
    const rejected = files.filter((f) => !isAwrFile(f) || f.size > MAX_MB * 1024 * 1024);
    const accepted = files.filter((f) => !rejected.includes(f));
    if (rejected.length) {
      setNotice({ tone: 'warning', text: `Skipped ${rejected.map((f) => f.name).join(', ')} — only .html/.htm AWR reports up to ${MAX_MB} MB.` });
    } else {
      setNotice(null);
    }
    if (accepted.length) upload.mutate(accepted);
  };

  if (reportsQ.isLoading) return <PageLoading />;

  const conn = connQ.data;
  const target = conn
    ? [conn.host, conn.port].filter(Boolean).join(':') + (conn.service_name || conn.sid ? `/${conn.service_name || conn.sid}` : '')
    : null;
  const browse = () => fileInputRef.current?.click();

  return (
    <div>
      <input ref={fileInputRef} type="file" accept=".html,.htm" multiple hidden onChange={(e) => handleFiles(e.target.files)} />

      <PageHeader
        title="AWR Analysis"
        description={connectionId
          ? (conn ? `${conn.connection_name || 'Oracle'} · ${target}` : 'Reports linked to this Oracle connection')
          : 'Oracle Automatic Workload Repository reports — upload new ones or open any you analysed before'}
        backTo={connectionId ? `/oracle-dashboard/${connectionId}` : '/cloud/oci-accounts'}
        leading={(
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md border" style={providerTileStyle('OCI')}>
            <ProviderLogo provider="OCI" size={28} />
          </div>
        )}
        actions={(
          <Button variant="primary" icon="report" onClick={browse} loading={upload.isPending}>
            Upload AWR
          </Button>
        )}
      />

      {reportsQ.error && <Notice tone="danger">{errorText(reportsQ.error, 'Could not load AWR reports.')}</Notice>}
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      <DropZone onFiles={handleFiles} onBrowse={browse} busy={upload.isPending} compact={allReports.length > 0} />

      {allReports.length === 0 ? (
        <FeatureStrip />
      ) : (
        <>
          <KpiRow reports={reports} />
          {databases.length > 1 && (
            <div className="mb-4 flex flex-wrap items-center gap-1.5 rounded-2xl border border-border bg-surface px-4 py-2.5 shadow-sm">
              <span className="mr-1 text-micro font-bold tracking-wide text-subtle uppercase">Database</span>
              {[['All', allReports.length], ...databases].map(([name, count]) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => setDbFilter(name)}
                  aria-pressed={dbFilter === name}
                  className={cn(
                    'inline-flex h-7 items-center gap-1.5 rounded-lg px-3 text-meta font-bold transition-all',
                    dbFilter === name ? 'bg-accent text-accent-fg shadow-sm' : 'text-muted hover:bg-sunken hover:text-fg',
                  )}
                >
                  {name}
                  <span className={cn('rounded-full px-1.5 text-micro', dbFilter === name ? 'bg-white/25' : 'bg-sunken')}>{count}</span>
                </button>
              ))}
            </div>
          )}
          <div className="grid grid-cols-1 gap-gutter xl:grid-cols-[minmax(300px,360px)_1fr]">
            <ReportHistory reports={reports} activeId={activeId} onSelect={setSelectedId} onDelete={setPendingDelete} />
            {active && <ReportDetail key={active.id} report={active} />}
          </div>
        </>
      )}

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        tone="danger"
        icon="trash"
        title="Delete this AWR report?"
        message={pendingDelete ? `${pendingDelete.original_filename} and its findings will be removed. The uploaded file is deleted too.` : ''}
        confirmLabel="Delete report"
        cancelLabel="Keep it"
        loading={remove.isPending}
        onConfirm={() => remove.mutate(pendingDelete.id)}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

/* ── upload ───────────────────────────────────────────────────────────────── */

function DropZone({ onFiles, onBrowse, busy, compact }) {
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onFiles(e.dataTransfer.files); }}
      className={cn(
        'mb-gutter flex flex-wrap items-center gap-4 rounded-2xl border-2 border-dashed px-5 transition-all',
        compact ? 'py-4' : 'py-10 justify-center text-center flex-col',
        over && 'scale-[1.005]',
      )}
      style={{
        borderColor: `color-mix(in srgb, ${ORACLE} ${over ? 70 : 32}%, transparent)`,
        background: `linear-gradient(135deg, color-mix(in srgb, ${ORACLE} ${over ? 14 : 7}%, var(--surface)) 0%, var(--surface) 70%)`,
      }}
    >
      <div
        className={cn('grid shrink-0 place-items-center rounded-2xl text-white shadow-sm', compact ? 'h-12 w-12' : 'h-16 w-16')}
        style={{ background: `linear-gradient(135deg, color-mix(in srgb, ${ORACLE} 80%, white), ${ORACLE})` }}
      >
        <Icon name={busy ? 'spinner' : 'report'} size={compact ? 22 : 28} className={busy ? 'animate-spin' : undefined} />
      </div>
      <div className={cn('min-w-0', compact && 'flex-1')}>
        <p className={cn('font-bold text-fg', compact ? 'text-[15px]' : 'text-lg')}>
          {busy ? 'Analysing AWR reports…' : 'Drop AWR HTML reports here'}
        </p>
        <p className="mt-0.5 text-meta text-muted">
          .html / .htm, up to {MAX_MB} MB each · select several files to analyse a batch · files are parsed as text, never executed
        </p>
      </div>
      <Button variant={compact ? 'secondary' : 'primary'} icon="report" onClick={onBrowse} disabled={busy}>
        Browse files
      </Button>
    </div>
  );
}

function FeatureStrip() {
  const items = [
    { icon: 'alert', tone: 'danger', title: 'Rule-based findings', body: 'Dominant waits, slow SQL and low efficiency ratios, each with evidence and a recommendation.' },
    { icon: 'clock', tone: 'warning', title: 'Top timed events', body: 'Where DB time went, as a share of the snapshot — CPU, I/O, commits, locks.' },
    { icon: 'zap', tone: 'info', title: 'Top SQL', body: 'Statements by elapsed time with CPU, executions and per-execution cost.' },
    { icon: 'sparkles', tone: 'accent', title: 'AI narrative', body: 'Optional Groq summary of root cause and priority actions.' },
  ];
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {items.map((it) => (
        <div key={it.title} className="card px-card py-card">
          <span className={cn('grid h-10 w-10 place-items-center rounded-full', TONE_DISC[it.tone])}>
            <Icon name={it.icon} size={18} />
          </span>
          <p className="mt-3 text-[15px] font-semibold text-fg">{it.title}</p>
          <p className="mt-1 text-meta text-muted">{it.body}</p>
        </div>
      ))}
    </div>
  );
}

const TONE_DISC = {
  accent: 'bg-accent-soft text-accent-text',
  danger: 'bg-danger-soft text-danger-fg',
  warning: 'bg-warning-soft text-warning-fg',
  info: 'bg-info-soft text-info-fg',
};

/* ── overview ─────────────────────────────────────────────────────────────── */

function KpiRow({ reports }) {
  const parsed = reports.filter((r) => r.status === 'PARSED');
  const failed = reports.length - parsed.length;
  const high = parsed.reduce((s, r) => s + (r.high_findings || 0), 0);
  const medium = parsed.reduce((s, r) => s + (r.medium_findings || 0), 0);
  const latest = parsed.find((r) => aas(r) != null);
  const latestAas = aas(latest);

  return (
    <div className="mb-gutter grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatTile
        label="Reports analysed"
        value={parsed.length}
        sub={failed ? `${failed} could not be parsed` : `${reports.length} uploaded`}
        icon="report"
        tone="accent"
      />
      <StatTile label="High findings" value={high} sub="across all parsed reports" icon="alert" tone="danger" valueTone={high ? 'danger' : 'neutral'} />
      <StatTile label="Medium findings" value={medium} sub="across all parsed reports" icon="alert" tone="warning" valueTone={medium ? 'warning' : 'neutral'} />
      <StatTile
        label="Latest load"
        value={latestAas == null ? '—' : latestAas.toFixed(1)}
        sub={latestAas == null ? 'no DB time in reports yet' : `avg active sessions · ${latest.db_name}`}
        icon="activity"
        tone="info"
        valueTone="info"
      />
    </div>
  );
}

function ReportHistory({ reports, activeId, onSelect, onDelete }) {
  return (
    <Panel title="Report history" icon="history" subtitle={`${reports.length} report${reports.length === 1 ? '' : 's'} · newest first`} bodyClassName="p-2 max-h-[70vh] overflow-y-auto" className="self-start xl:sticky xl:top-4">
      <ul className="flex flex-col gap-1.5">
        {reports.map((r) => {
          const selected = r.id === activeId;
          return (
            <li key={r.id}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => onSelect(r.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(r.id); } }}
                className={cn(
                  'relative cursor-pointer rounded-xl border px-3 py-2.5 transition-all',
                  selected ? 'border-transparent bg-accent-softer ring-2 ring-accent-soft' : 'border-border hover:bg-sunken',
                )}
              >
                <span
                  aria-hidden="true"
                  className="absolute inset-y-2 left-0 w-1 rounded-r"
                  style={{ background: r.high_findings ? 'var(--status-critical)' : r.medium_findings ? 'var(--status-warning)' : 'var(--status-good)' }}
                />
                <div className="flex items-center gap-2 pl-1.5">
                  <span className="truncate-safe min-w-0 flex-1 text-[13px] font-bold text-fg">{r.db_name || r.original_filename}</span>
                  <Badge tone={STATUS_TONE[r.status] || 'neutral'} size="xs">{r.status}</Badge>
                  <a
                    href={`/api/v1${API}/${r.id}/download`}
                    download={r.original_filename}
                    onClick={(e) => e.stopPropagation()}
                    title={`Download ${r.original_filename}`}
                    aria-label={`Download ${r.original_filename}`}
                    className="grid h-6 w-6 place-items-center rounded-md text-subtle hover:bg-surface hover:text-fg"
                  >
                    <Icon name="download" size={13} />
                  </a>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onDelete(r); }}
                    title={`Delete ${r.original_filename}`}
                    aria-label={`Delete ${r.original_filename}`}
                    className="grid h-6 w-6 place-items-center rounded-md text-subtle hover:bg-danger-soft hover:text-danger-fg"
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
                <p className="truncate-safe mt-0.5 pl-1.5 text-micro text-subtle" title={r.original_filename}>{r.original_filename}</p>
                <p className="mt-0.5 pl-1.5 text-meta text-muted">
                  {r.begin_snap ? `Snap ${r.begin_snap} → ${r.end_snap}` : 'No snapshot range found'}
                  {r.elapsed_minutes ? ` · ${fmtMin(r.elapsed_minutes)}` : ''}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1 pl-1.5">
                  {r.status === 'PARSED' ? (
                    <>
                      {r.high_findings > 0 && <Badge tone="danger" size="xs">{r.high_findings} high</Badge>}
                      {r.medium_findings > 0 && <Badge tone="warning" size="xs">{r.medium_findings} medium</Badge>}
                      {!r.high_findings && !r.medium_findings && <Badge tone="success" size="xs">no issues</Badge>}
                    </>
                  ) : (
                    <span className="text-micro text-danger-fg">{r.error_message || 'Not parsed'}</span>
                  )}
                  <span className="ml-auto text-micro text-subtle">
                    {r.begin_time ? new Date(r.begin_time).toLocaleString() : new Date(r.created_at).toLocaleString()}
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/* ── one report ───────────────────────────────────────────────────────────── */

function ReportDetail({ report }) {
  const parsed = report.status === 'PARSED';
  const detailQ = useQuery({
    queryKey: ['oracleAwrReportDetail', report.id],
    queryFn: () => client.get(`${API}/${report.id}`).then((r) => r.data),
  });
  const insightsQ = useQuery({
    queryKey: ['oracleAwrReportInsights', report.id],
    queryFn: () => client.get(`${API}/${report.id}/insights`).then((r) => r.data),
    enabled: parsed,
    staleTime: Infinity,
  });

  const findings = detailQ.data?.findings || [];
  const insights = insightsQ.data?.status === 'ok' ? insightsQ.data : null;
  const load = aas(report);

  return (
    <div className="flex min-w-0 flex-col gap-gutter">
      <SummaryCard report={report} load={load} findingCount={findings.length} />

      {!parsed && (
        <Notice tone="danger" title="This report could not be parsed.">
          {report.error_message || 'The file did not look like an Oracle AWR HTML report.'}
        </Notice>
      )}

      {parsed && insightsQ.isLoading && <Panel><p className="py-6 text-center text-meta text-muted">Reading wait events and SQL from the report…</p></Panel>}
      {insightsQ.data?.status === 'error' && <Notice tone="warning">{insightsQ.data.error}</Notice>}

      {insights && (
        <>
          <div className="grid grid-cols-1 gap-gutter 2xl:grid-cols-[1.4fr_1fr]">
            <Panel title="Top timed events" icon="clock" subtitle="Share of DB time in this snapshot window — DB CPU is work, not a wait">
              <BarList
                items={insights.wait_events.filter((w) => w.percent_db_time != null).map((w) => ({
                  key: w.name,
                  label: w.name,
                  value: w.percent_db_time,
                  sub: [w.wait_class && `${w.wait_class} class`, w.avg_wait_ms != null && `avg ${num(w.avg_wait_ms, 2)} ms`].filter(Boolean).join(' · '),
                }))}
                format={(v) => num(v)}
                unit="%"
                labelWidth={200}
                thickness={22}
                emptyLabel="No wait events found in this report"
              />
            </Panel>
            <EfficiencyPanel metrics={insights.instance_efficiency} />
          </div>
          <LoadProfile metrics={insights.load_profile} />
          <TopSql rows={insights.top_sql} />
        </>
      )}

      <FindingsPanel findings={findings} loading={detailQ.isLoading} />
      {parsed && <AiPanel reportId={report.id} />}
    </div>
  );
}

function SummaryCard({ report, load, findingCount }) {
  const facts = [
    { icon: 'clock', label: 'Elapsed', value: fmtMin(report.elapsed_minutes) || '—' },
    { icon: 'activity', label: 'DB time', value: fmtMin(report.db_time_minutes) || '—' },
    { icon: 'gauge', label: 'Avg active sessions', value: load == null ? '—' : load.toFixed(1), hint: 'DB time ÷ elapsed time' },
    { icon: 'alert', label: 'Findings', value: report.status === 'PARSED' ? findingCount : '—' },
  ];
  return (
    <section className="card overflow-hidden">
      <div className="h-1.5" style={{ background: `linear-gradient(90deg, ${ORACLE}, color-mix(in srgb, ${ORACLE} 35%, var(--chart-4)))` }} />
      <div className="px-card py-card">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-bold text-fg">{report.db_name || report.original_filename}</h2>
          {report.instance_name && <Badge tone="outline">{report.instance_name}</Badge>}
          {report.begin_snap && <Badge tone="accent">Snap {report.begin_snap} → {report.end_snap}</Badge>}
          {report.begin_time && (
            <Badge tone="neutral">
              {new Date(report.begin_time).toLocaleString()}{report.end_time ? ` – ${new Date(report.end_time).toLocaleTimeString()}` : ''}
            </Badge>
          )}
        </div>
        <p className="mt-1 text-meta text-muted">
          {[report.host_name, report.original_filename, report.file_size_bytes && `${(report.file_size_bytes / 1048576).toFixed(1)} MB`].filter(Boolean).join(' · ')}
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          {facts.map((f) => (
            <div key={f.label} title={f.hint} className="rounded-xl bg-sunken px-3 py-2.5">
              <span className="flex items-center gap-1.5 text-micro font-bold tracking-wide text-subtle uppercase">
                <Icon name={f.icon} size={12} /> {f.label}
              </span>
              <span className="mt-1 block text-[20px] leading-tight font-bold text-fg">{f.value}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function EfficiencyPanel({ metrics }) {
  return (
    <Panel title="Instance efficiency" icon="gauge" subtitle="Coloured only where a rule judges it (≥ 95% target)">
      {!metrics.length ? (
        <p className="py-6 text-center text-meta text-subtle">No efficiency section in this report</p>
      ) : (
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
                      <Icon name={ok ? 'check' : 'alert'} size={10} strokeWidth={3} style={{ color }} />
                      {ok ? 'Meets target' : 'Below target'}
                    </span>
                  )}
                  <span className="w-14 text-right text-[14px] font-bold text-fg tabular-nums">{m.value == null ? '—' : `${num(m.value, 2)}%`}</span>
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

function LoadProfile({ metrics }) {
  if (!metrics.length) return null;
  return (
    <Panel title="Load profile" icon="trend" subtitle="Per second, averaged over the snapshot window">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
        {metrics.map((m) => (
          <div key={m.name} className="rounded-xl border border-border px-3 py-2">
            <p className="truncate-safe text-micro font-bold tracking-wide text-subtle uppercase" title={m.name}>{m.name}</p>
            <p className="mt-0.5 text-[16px] font-bold text-fg tabular-nums">{num(m.per_second, 2)}</p>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function TopSql({ rows }) {
  const columns = [
    { key: 'sql_id', label: 'SQL ID' },
    { key: 'elapsed', label: 'Elapsed', align: 'right' },
    { key: 'execs', label: 'Executions', align: 'right' },
    { key: 'per_exec', label: 'Per exec', align: 'right' },
    { key: 'cpu', label: '% CPU', align: 'right', hint: 'Share of this statement’s elapsed time spent on CPU' },
    { key: 'io', label: '% I/O', align: 'right', hint: 'Share of this statement’s elapsed time spent waiting on user I/O' },
    { key: 'text', label: 'SQL text / module' },
  ];
  const pct = (v) => (v == null ? '—' : `${num(v)}%`);
  const maxElapsed = Math.max(...rows.map((r) => r.elapsed_seconds || 0), 0);
  return (
    <TablePanel title="Top SQL by elapsed time" icon="zap" subtitle="Statements that consumed the most DB time in this window">
      <Table
        columns={columns}
        empty={<EmptyState icon="zap" title="No SQL section in this report" />}
        rows={rows.map((r, i) => ({
          key: `${r.sql_id || 'sql'}-${i}`,
          cells: {
            sql_id: r.sql_id ? (
              <span className="flex items-center gap-1">
                <code className="font-mono text-[12px] font-semibold text-fg">{r.sql_id}</code>
                <CopyButton text={r.sql_id} label="Copy" variant="ghost" />
              </span>
            ) : '—',
            elapsed: (
              <span className="inline-flex items-center gap-2">
                <span className="hidden h-1.5 w-16 overflow-hidden rounded-sm sm:block" style={{ background: 'var(--chart-track)' }}>
                  <span className="block h-full" style={{ width: `${maxElapsed ? ((r.elapsed_seconds || 0) / maxElapsed) * 100 : 0}%`, background: 'var(--chart-2)' }} />
                </span>
                <b className="text-fg">{fmtSec(r.elapsed_seconds)}</b>
              </span>
            ),
            execs: num(r.executions, 0),
            per_exec: fmtSec(r.elapsed_per_exec_seconds),
            cpu: pct(r.cpu_pct),
            io: pct(r.io_pct),
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

function FindingsPanel({ findings, loading }) {
  const counts = findings.reduce((acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] || 0) + 1 }), {});
  return (
    <Panel
      title="Findings & recommendations"
      icon="alert"
      subtitle="Rule-based checks on this report — evidence first, then what to look at"
      actions={['HIGH', 'MEDIUM', 'LOW'].filter((s) => counts[s]).map((s) => (
        <Badge key={s} tone={SEVERITY[s].tone}>{counts[s]} {SEVERITY[s].label.toLowerCase()}</Badge>
      ))}
    >
      {loading && <p className="py-4 text-center text-meta text-muted">Loading findings…</p>}
      <div className="flex flex-col gap-2.5">
        {findings.map((f) => {
          const s = SEVERITY[f.severity] || SEVERITY.INFO;
          return (
            <article key={f.id} className="relative overflow-hidden rounded-xl border border-border bg-surface py-3 pr-4 pl-5">
              <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1.5" style={{ background: s.bar }} />
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={s.tone}><Icon name={s.icon} size={10} strokeWidth={3} /> {s.label}</Badge>
                <span className="text-micro font-bold tracking-wide text-subtle uppercase">{f.category}</span>
              </div>
              <p className="mt-1.5 text-[14px] font-semibold text-fg">{f.title}</p>
              <p className="mt-0.5 text-meta text-muted">{f.evidence}</p>
              <p className="mt-2 flex gap-2 rounded-lg bg-sunken px-3 py-2 text-meta text-fg">
                <Icon name="check" size={13} className="mt-0.5 shrink-0 text-success-fg" />
                <span>{f.recommendation}</span>
              </p>
            </article>
          );
        })}
      </div>
    </Panel>
  );
}

function AiPanel({ reportId }) {
  const analyze = useMutation({
    mutationFn: () => client.post(`${API}/${reportId}/analyze-groq`, null, { timeout: 120000 }).then((r) => r.data),
  });
  const result = analyze.data;
  const a = result?.status === 'success' ? result.analysis : null;

  return (
    <section
      className="card overflow-hidden"
      style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--chart-7) 9%, var(--surface)) 0%, var(--surface) 65%)' }}
    >
      <div className="flex flex-wrap items-center gap-3 px-card py-card">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-white" style={{ background: 'linear-gradient(135deg, var(--chart-7), var(--chart-5))' }}>
          <Icon name="sparkles" size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-bold text-fg">AI narrative</p>
          <p className="text-meta text-muted">A Groq-generated summary of root cause and priority actions, written from the findings above. Advisory only — nothing is applied to the database.</p>
        </div>
        <Button variant="primary" icon="sparkles" onClick={() => analyze.mutate()} loading={analyze.isPending}>
          {a ? 'Regenerate' : 'Generate analysis'}
        </Button>
      </div>

      {(result || analyze.error) && (
        <div className="border-t border-border px-card py-card">
          {analyze.error && <Notice tone="danger">{errorText(analyze.error)}</Notice>}
          {result?.status === 'error' && (
            <Notice tone={result.code === 'no_api_key' ? 'info' : 'warning'} title={result.code === 'no_api_key' ? 'AI analysis is not configured.' : 'AI analysis failed.'}>
              {result.error}
            </Notice>
          )}
          {a && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                {a.severity && <Badge tone={SEVERITY[String(a.severity).toUpperCase()]?.tone || 'neutral'}>{a.severity}</Badge>}
                <p className="text-[14px] font-semibold text-fg">{a.summary}</p>
              </div>
              {a.root_cause && <p className="text-meta text-muted"><b className="text-fg">Root cause: </b>{a.root_cause}</p>}
              {a.priority_actions?.length > 0 && (
                <ol className="flex flex-col gap-1.5">
                  {a.priority_actions.map((step, i) => (
                    <li key={i} className="flex gap-2 rounded-lg bg-surface px-3 py-2 text-meta text-fg">
                      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent-soft text-micro font-bold text-accent-text">{i + 1}</span>
                      <span>{String(step).replace(/^\d+\.\s*/, '')}</span>
                    </li>
                  ))}
                </ol>
              )}
              {a.business_impact && <p className="text-meta text-muted"><b className="text-fg">Impact: </b>{a.business_impact}</p>}
              {a.validation_queries?.length > 0 && (
                <div>
                  <p className="mb-1 text-micro font-bold tracking-wide text-subtle uppercase">Queries to confirm</p>
                  {a.validation_queries.map((q, i) => (
                    <pre key={i} className="mb-1.5 overflow-x-auto rounded-lg bg-sunken px-3 py-2 font-mono text-[12px] text-fg">{q}</pre>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
