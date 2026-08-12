import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import cn from '@/lib/cn';
import client from '@/api/client';
import PageHeader from '@/components/layout/PageHeader';
import Badge, { LiveBadge } from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import CopyButton from '@/components/ui/CopyButton';
import Icon from '@/components/ui/Icon';
import IconButton from '@/components/ui/IconButton';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Select from '@/components/ui/Select';
import Switch from '@/components/ui/Switch';
import Table, { EmptyState } from '@/components/ui/Table';
import Toasts, { useToasts } from '@/components/ui/Toast';
import { InlineLoading, PageLoading } from '@/components/ui/Loading';
import { Paged } from '@/components/ui/Pagination';
import {
  DefRow, MetricTile, Panel, SqlBlock, StatCell, StateChip, TablePanel,
} from '@/pages/_shared/enginePanels';
import { fmtBytes, fmtNumber } from '@/config/dbCatalog';

/**
 * SQL Server backup & point-in-time recovery.
 *
 * Five views: the jobs ActMon has run, a wizard to take a new backup, the
 * schedule list, SQL Server's own msdb history, and PITR.
 *
 * Two things here are irreversible — starting a PITR that overwrites a live
 * database, and deleting a job — so both go through an explicit confirmation that
 * names what will happen, rather than a checkbox next to a button.
 *
 * Renders standalone or `embedded` inside the dashboard's Backup tab, which is why
 * the header is conditional: a page header inside a tab would be a second title.
 */

const api = {
  summary: (id) => client.get(`/connections/mssql/${id}/backup/summary`).then((r) => r.data),
  listBackups: (id) => client.get(`/connections/mssql/${id}/backups`).then((r) => r.data),
  takeBackup: (id, body) => client.post(`/connections/mssql/${id}/backup/take`, body).then((r) => r.data),
  deleteJob: (id, jid) => client.delete(`/connections/mssql/${id}/backup/${jid}`).then((r) => r.data),
  pitr: (id, body) => client.post(`/connections/mssql/${id}/pitr`, body).then((r) => r.data),
  history: (id, params) => client.get(`/connections/mssql/${id}/backup/history`, { params }).then((r) => r.data),
  recoveryChain: (id) => client.get(`/connections/mssql/${id}/backup/recovery-chain`).then((r) => r.data),
  listSchedules: (id) => client.get(`/connections/mssql/${id}/backup/schedules`).then((r) => r.data),
  createSchedule: (id, s) => client.post(`/connections/mssql/${id}/backup/schedules`, s).then((r) => r.data),
  updateSchedule: (id, sid, s) => client.put(`/connections/mssql/${id}/backup/schedules/${sid}`, s).then((r) => r.data),
  deleteSchedule: (id, sid) => client.delete(`/connections/mssql/${id}/backup/schedules/${sid}`).then((r) => r.data),
  toggleSchedule: (id, sid, enabled) =>
    client.patch(`/connections/mssql/${id}/backup/schedules/${sid}/toggle`, { enabled }).then((r) => r.data),
  runNow: (id, sid) => client.post(`/connections/mssql/${id}/backup/schedules/${sid}/run-now`).then((r) => r.data),
};

const num = (v) => Number(v) || 0;
const mbToBytes = (v) => num(v) * 1048576;

/** The backend sends naive ISO strings in server time; treat them as UTC. */
export function fmtStamp(ts) {
  if (!ts) return null;
  const iso = /[Zz]|[+-]\d\d:\d\d$/.test(ts) ? ts : `${ts}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

/** Backups live on the SQL Server host, so the leaf name is what identifies one. */
export const fileName = (p) => (p ? String(p).split(/[/\\]/).pop() : null);

const JOB_STATUS = {
  pending: { label: 'Pending', tone: 'neutral' },
  running: { label: 'Running', tone: 'info' },
  completed: { label: 'Completed', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

const TYPE_TONES = {
  full: 'accent', differential: 'info', log: 'info',
  copy_only: 'neutral', pitr: 'success', restore: 'warning',
};

const TYPE_LABEL = (t) => String(t || '').replace(/_/g, ' ');

/* Each backup type, with the statement it issues and whether it can be part of a
   point-in-time restore. The T-SQL is shown because it is what actually runs. */
const BACKUP_TYPES = {
  full: {
    label: 'Full backup',
    clause: 'BACKUP DATABASE',
    pitr: true,
    desc: 'A complete copy. Every restore chain starts from one of these, and taking it '
      + 'resets the differential base.',
    sql: "BACKUP DATABASE [db] TO DISK = N'path' WITH FORMAT, INIT, STATS = 10",
  },
  differential: {
    label: 'Differential',
    clause: 'WITH DIFFERENTIAL',
    pitr: false,
    desc: 'Everything changed since the last full backup — quicker and smaller, but '
      + 'useless without that full backup.',
    sql: "BACKUP DATABASE [db] TO DISK = N'path' WITH DIFFERENTIAL, FORMAT, STATS = 10",
  },
  log: {
    label: 'Transaction log',
    clause: 'BACKUP LOG',
    pitr: true,
    desc: 'The log since the last log backup. Required for point-in-time recovery, and '
      + 'only possible in FULL or BULK_LOGGED recovery.',
    sql: "BACKUP LOG [db] TO DISK = N'path' WITH FORMAT, INIT, STATS = 10",
  },
  copy_only: {
    label: 'Copy-only full',
    clause: 'WITH COPY_ONLY',
    pitr: false,
    desc: 'A full backup that leaves the differential base and the log chain alone — the '
      + 'safe choice for an ad-hoc copy.',
    sql: "BACKUP DATABASE [db] TO DISK = N'path' WITH COPY_ONLY, FORMAT, STATS = 10",
  },
};

const VIEWS = [
  { id: 'jobs', label: 'ActMon jobs', icon: 'archive' },
  { id: 'new', label: 'New backup', icon: 'plus' },
  { id: 'schedule', label: 'Schedules', icon: 'calendar' },
  { id: 'history', label: 'SQL Server history', icon: 'history' },
  { id: 'pitr', label: 'PITR / restore', icon: 'refresh' },
];

export default function MSSQLBackupPage({ embedded = false }) {
  const { id } = useParams();
  const qc = useQueryClient();
  const [view, setView] = useState('jobs');
  const { toasts, push, dismiss } = useToasts();

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['mssqlBackupSummary', id],
    queryFn: () => api.summary(id),
    refetchInterval: 20000,
    retry: false,
  });
  const { data: jobsData, refetch: refetchJobs } = useQuery({
    queryKey: ['mssqlBackupJobs', id],
    queryFn: () => api.listBackups(id),
    refetchInterval: 6000,
    retry: false,
  });

  const jobs = jobsData?.jobs || [];
  const running = jobs.filter((j) => j.status === 'running').length;
  const stats = summary?.stats || {};
  const defaultDir = summary?.default_backup_dir || '';
  const lastBackups = summary?.last_backups || [];
  const unprotected = summary?.unprotected_databases || [];

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['mssqlBackupSummary', id] });
    qc.invalidateQueries({ queryKey: ['mssqlBackupJobs', id] });
  };

  const nav = (
    <span className="no-scrollbar flex items-center gap-0.5 overflow-x-auto rounded-control border border-border p-0.5">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          type="button"
          onClick={() => setView(v.id)}
          aria-pressed={view === v.id}
          className={cn(
            'flex h-7 shrink-0 items-center gap-1.5 rounded-control px-2.5 text-[11px] font-bold transition-colors',
            view === v.id ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-sunken hover:text-fg',
          )}
        >
          <Icon name={v.icon} size={11} />
          {v.label}
          {v.id === 'jobs' && running > 0 && (
            <span className="grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[9px] font-bold text-white">
              {running}
            </span>
          )}
        </button>
      ))}
    </span>
  );

  return (
    <>
      <Toasts toasts={toasts} onDismiss={dismiss} />

      {embedded ? (
        <div className="mb-gutter flex flex-wrap items-center gap-gutter-sm">
          {nav}
          <div className="ml-auto flex items-center gap-2">
            {unprotected.length > 0 && (
              <Badge tone="warning" size="xs">
                <Icon name="alert" size={9} />
                {unprotected.length} unprotected
              </Badge>
            )}
            {running > 0 && <LiveBadge label={`${running} running`} tone="info" />}
            <Button size="sm" variant="secondary" icon="refresh" loading={summaryLoading} onClick={refresh}>
              Refresh
            </Button>
          </div>
        </div>
      ) : (
        <PageHeader
          title="SQL Server Backup & PITR"
          description="Backups ActMon takes, SQL Server's own history, and point-in-time recovery"
          icon="archive"
          backTo={`/mssql-dashboard/${id}`}
          actions={(
            <>
              {unprotected.length > 0 && (
                <Badge tone="warning">
                  <Icon name="alert" size={10} />
                  {unprotected.length} unprotected
                </Badge>
              )}
              {running > 0 && <LiveBadge label={`${running} running`} tone="info" />}
              <Button variant="secondary" icon="refresh" loading={summaryLoading} onClick={refresh}>
                Refresh
              </Button>
            </>
          )}
        >
          <div className="mt-gutter-sm">{nav}</div>
        </PageHeader>
      )}

      {summary?.error && (
        <Notice tone="warning" title="Could not read msdb.">
          {summary.error} Job history, recovery chains and the default backup directory come
          from msdb, so those will be empty until the login can read it.
        </Notice>
      )}

      {view === 'jobs' && (
        <JobsView
          connId={id}
          jobs={jobs}
          stats={stats}
          defaultDir={defaultDir}
          unprotected={unprotected}
          lastBackups={lastBackups}
          onRefetch={refetchJobs}
          onToast={push}
          onNew={() => setView('new')}
        />
      )}
      {view === 'new' && (
        <NewBackupView connId={id} summary={summary} onDone={refresh} onToast={push} />
      )}
      {view === 'schedule' && <ScheduleView connId={id} summary={summary} onToast={push} />}
      {view === 'history' && <HistoryView connId={id} />}
      {view === 'pitr' && <PitrView connId={id} onDone={refresh} onToast={push} />}
    </>
  );
}

/* ══ ActMon jobs ═══════════════════════════════════════════════════════════ */

function JobsView({
  connId, jobs, stats, defaultDir, unprotected, lastBackups, onRefetch, onToast, onNew,
}) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const del = useMutation({
    mutationFn: (jid) => api.deleteJob(connId, jid),
    onSuccess: () => {
      onToast('Job record deleted');
      qc.invalidateQueries({ queryKey: ['mssqlBackupJobs', connId] });
    },
    onError: (e) => onToast(e?.message || 'Delete failed', 'error'),
  });

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return jobs.filter((j) => {
      const byFilter = filter === 'all' || j.backup_type === filter || j.status === filter;
      const bySearch = !q || [j.backup_type, j.db_name, j.status, j.file_path]
        .some((v) => String(v || '').toLowerCase().includes(q));
      return byFilter && bySearch;
    });
  }, [jobs, filter, search]);

  const totalBytes = jobs.reduce((a, j) => a + num(j.size_bytes), 0);

  const FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'full', label: 'Full' },
    { id: 'differential', label: 'Diff' },
    { id: 'log', label: 'Log' },
    { id: 'copy_only', label: 'Copy-only' },
    { id: 'pitr', label: 'PITR' },
    { id: 'completed', label: 'Completed' },
    { id: 'running', label: 'Running' },
    { id: 'failed', label: 'Failed' },
  ];

  return (
    <div className="space-y-gutter">
      <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-3 xl:grid-cols-6">
        <MetricTile label="Jobs" value={jobs.length} icon="archive" />
        <MetricTile label="Completed" value={jobs.filter((j) => j.status === 'completed').length}
          icon="check" tone="good" />
        <MetricTile label="Running" value={jobs.filter((j) => j.status === 'running').length}
          icon="refresh" tone={jobs.some((j) => j.status === 'running') ? 'warn' : 'neutral'} />
        <MetricTile label="Failed" value={jobs.filter((j) => j.status === 'failed').length}
          icon="alert" tone={jobs.some((j) => j.status === 'failed') ? 'bad' : 'good'} />
        <MetricTile label="Stored" value={totalBytes ? fmtBytes(totalBytes) : '—'} icon="desktop" />
        <MetricTile label="msdb, last 30 days" value={fmtNumber(stats.total_backups)} icon="history"
          sub={stats.databases_backed_up != null ? `${stats.databases_backed_up} databases` : undefined} />
      </div>

      {unprotected.length > 0 && (
        <Notice tone="warning" title={`${unprotected.length} database${unprotected.length === 1 ? '' : 's'} with no backup in 7 days.`}>
          {unprotected.map((d) => d.name).join(', ')} — nothing in msdb.dbo.backupset for the
          last week, so there is no recovery point for {unprotected.length === 1 ? 'it' : 'them'}.
        </Notice>
      )}

      {defaultDir && (
        <Panel title="Default backup directory" icon="desktop"
          subtitle="Where SQL Server writes when no path is given. This is a path on the DB host, not on your machine.">
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-control border border-border bg-sunken px-2.5 py-1.5 font-mono text-[12px] text-fg">
              {defaultDir}
            </code>
            <CopyButton text={defaultDir} />
          </div>
        </Panel>
      )}

      {lastBackups.length > 0 && (
        <TablePanel title="Protection by database" icon="shield"
          subtitle="Most recent backup of each kind, from msdb — last 30 days">
          <Paged rows={lastBackups} unit="databases" pageSize="10">
            {(page, pager) => (
              <>
                <Table
                  columns={[
                    { key: 'db', label: 'Database' },
                    { key: 'full', label: 'Last full' },
                    { key: 'diff', label: 'Last differential' },
                    { key: 'log', label: 'Last log' },
                    { key: 'counts', label: 'Counts (F/D/L)', align: 'right' },
                    { key: 'size', label: 'Total', align: 'right' },
                  ]}
                  rows={page.map((d) => ({
                    key: d.database_name,
                    cells: {
                      db: <span className="font-semibold text-accent-text">{d.database_name}</span>,
                      full: <Stamp value={d.last_full} />,
                      diff: <Stamp value={d.last_diff} />,
                      log: <Stamp value={d.last_log} />,
                      counts: (
                        <span className="font-mono text-[12px]">
                          {num(d.full_count)}/{num(d.diff_count)}/{num(d.log_count)}
                        </span>
                      ),
                      size: (
                        <span className="font-mono text-[12px]">
                          {d.total_backup_bytes ? fmtBytes(d.total_backup_bytes) : '—'}
                        </span>
                      ),
                    },
                  }))}
                  empty={<EmptyState icon="shield" title="No backups recorded" />}
                />
                {pager}
              </>
            )}
          </Paged>
        </TablePanel>
      )}

      <TablePanel
        title="Backup jobs ActMon has run"
        icon="archive"
        subtitle="Select a row for the file path and any error"
        actions={(
          <>
            <Select
              value={filter}
              onChange={setFilter}
              options={FILTERS}
              size="sm"
              width="auto"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onClear={() => setSearch('')}
              placeholder="Search…"
              icon="search"
              size="sm"
              wrapperClassName="w-36"
            />
            <Button size="sm" variant="secondary" icon="refresh" onClick={onRefetch}>Refresh</Button>
          </>
        )}
      >
        <Paged rows={shown} unit="jobs">
          {(page, pager) => (
            <>
              <Table
                columns={[
                  { key: 'job', label: 'Job' },
                  { key: 'type', label: 'Type' },
                  { key: 'db', label: 'Database' },
                  { key: 'status', label: 'Status' },
                  { key: 'size', label: 'Size', align: 'right' },
                  { key: 'file', label: 'File on the SQL Server host' },
                  { key: 'dur', label: 'Duration', align: 'right' },
                  { key: 'started', label: 'Started' },
                  { key: 'actions', label: '', align: 'right' },
                ]}
                rows={page.map((j) => {
                  const st = JOB_STATUS[j.status] || { label: j.status, tone: 'neutral' };
                  return {
                    key: String(j.id),
                    onClick: () => setExpanded(expanded === j.id ? null : j.id),
                    cells: {
                      job: <span className="font-mono text-[11px] font-bold text-subtle">#{j.id}</span>,
                      type: <Badge tone={TYPE_TONES[j.backup_type] || 'neutral'} size="xs">{TYPE_LABEL(j.backup_type)}</Badge>,
                      db: <span className="font-semibold text-fg">{j.db_name}</span>,
                      status: (
                        <Badge tone={st.tone} size="xs">
                          {j.status === 'running' && (
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                          )}
                          {st.label}
                        </Badge>
                      ),
                      size: <span className="font-mono text-[12px]">{j.size_human || null}</span>,
                      file: j.file_path ? (
                        <span title={j.file_path} className="truncate-safe block max-w-[200px] font-mono text-[11px] text-muted">
                          {fileName(j.file_path)}
                        </span>
                      ) : null,
                      dur: <span className="font-mono text-[12px]">{j.duration_sec != null ? `${j.duration_sec}s` : null}</span>,
                      started: <Stamp value={j.backup_start} />,
                      actions: (
                        <span className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                          <IconButton
                            size="sm"
                            tone="danger"
                            icon="trash"
                            disabled={j.status === 'running'}
                            label={j.status === 'running'
                              ? `Job #${j.id} is running and cannot be deleted`
                              : `Delete the record of job #${j.id}`}
                            onClick={() => setConfirmDelete(j)}
                          />
                        </span>
                      ),
                    },
                  };
                })}
                empty={jobs.length ? (
                  <EmptyState icon="filter" title="No matches" body="No job matches this filter." />
                ) : (
                  <EmptyState
                    icon="archive"
                    title="No backups taken yet"
                    body="ActMon has not run a backup on this connection."
                    action={<Button variant="primary" icon="plus" onClick={onNew}>Take a backup</Button>}
                  />
                )}
              />

              {page.some((j) => j.id === expanded) && (
                <div className="border-t border-border bg-sunken px-card py-3">
                  {page.filter((j) => j.id === expanded).map((j) => (
                    <div key={j.id} className="grid gap-gutter md:grid-cols-3">
                      <div>
                        <p className="mb-1.5 text-[11px] font-bold tracking-wide text-subtle uppercase">Job</p>
                        <DefRow label="Number" value={`#${j.id}`} mono />
                        <DefRow label="UUID" value={j.uuid} mono />
                        <DefRow label="Type" value={TYPE_LABEL(j.backup_type)} />
                        <DefRow label="Database" value={j.db_name} />
                        <DefRow label="Host" value={j.db_host} mono />
                      </div>
                      <div>
                        <p className="mb-1.5 text-[11px] font-bold tracking-wide text-subtle uppercase">Timing</p>
                        <DefRow label="Started" value={fmtStamp(j.backup_start)} />
                        <DefRow label="Finished" value={fmtStamp(j.backup_end)} />
                        <DefRow label="Duration" value={j.duration_sec != null ? `${j.duration_sec}s` : null} />
                        <DefRow label="Size" value={j.size_human} />
                      </div>
                      <div>
                        <p className="mb-1.5 text-[11px] font-bold tracking-wide text-subtle uppercase">
                          File, on the SQL Server host
                        </p>
                        {j.file_path ? (
                          <div className="flex items-start gap-2">
                            <code className="min-w-0 flex-1 rounded-control border border-border bg-surface px-2 py-1.5 font-mono text-[11px] break-all text-fg">
                              {j.file_path}
                            </code>
                            <CopyButton text={j.file_path} />
                          </div>
                        ) : (
                          <p className="text-[12px] text-subtle">No path recorded yet.</p>
                        )}
                        {j.notes && (
                          <p className="mt-2 rounded-control bg-info-soft px-2.5 py-1.5 text-[12px] text-info-fg">
                            {j.notes}
                          </p>
                        )}
                      </div>
                      {j.error_msg && (
                        <div className="md:col-span-3">
                          <Notice tone="danger" className="mb-0" title="The backup failed.">
                            <span className="mt-1 block font-mono text-[11px] break-words whitespace-pre-wrap">
                              {j.error_msg}
                            </span>
                          </Notice>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {pager}
            </>
          )}
        </Paged>
      </TablePanel>

      {/* Deleting removes ActMon's record, not the .bak on the server — saying which
          is the difference between a tidy-up and a lost recovery point. */}
      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title={`Delete job #${confirmDelete?.id}?`}
        message={`This removes ActMon's record of the ${TYPE_LABEL(confirmDelete?.backup_type)} backup of ${confirmDelete?.db_name}. The backup file itself stays on the SQL Server host — delete it there if you no longer want it.`}
        confirmLabel="Delete record"
        cancelLabel="Keep it"
        tone="danger"
        onConfirm={() => { del.mutate(confirmDelete.id); setConfirmDelete(null); }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}

function Stamp({ value }) {
  const s = fmtStamp(value);
  return s ? <span className="font-mono text-[11px] whitespace-nowrap text-muted">{s}</span> : null;
}

/* ══ new backup ════════════════════════════════════════════════════════════ */

function NewBackupView({ connId, summary, onDone, onToast }) {
  const [type, setType] = useState('full');
  const [database, setDatabase] = useState('');
  const [path, setPath] = useState('');
  const [notes, setNotes] = useState('');
  const [compress, setCompress] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const recoveryModels = summary?.recovery_models || [];
  const defaultDir = summary?.default_backup_dir || '';
  const chosen = recoveryModels.find((d) => d.name === database);
  const bt = BACKUP_TYPES[type];

  /* A log backup of a SIMPLE-recovery database cannot succeed — SQL Server refuses
     it. Blocking the submit is better than letting it fail on the server. */
  const logOnSimple = type === 'log' && chosen?.recovery_model_desc === 'SIMPLE';
  const canSubmit = Boolean(database.trim()) && !logOnSimple && !busy;

  const submit = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await api.takeBackup(connId, {
        backup_type: type,
        database: database.trim(),
        backup_path: path.trim() || null,
        compress,
        notes: notes.trim() || null,
      });
      setResult({ ok: true, jobId: res.job_id });
      onToast(`${bt.label} started for ${database.trim()}`);
      onDone();
    } catch (e) {
      const msg = e?.message || 'Could not start the backup.';
      setResult({ ok: false, msg });
      onToast(msg, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-gutter">
      <Panel title="1 · What kind of backup" icon="layers"
        subtitle="Each one issues the statement shown — this is what runs on the server">
        <div className="space-y-2">
          {Object.entries(BACKUP_TYPES).map(([k, v]) => (
            <label
              key={k}
              className={cn(
                'block cursor-pointer rounded-card border p-3 transition-colors',
                type === k ? 'border-accent bg-accent-soft' : 'border-border hover:border-strong hover:bg-sunken',
              )}
            >
              <input
                type="radio"
                name="backup-type"
                value={k}
                checked={type === k}
                onChange={() => setType(k)}
                className="sr-only"
              />
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-bold text-fg">{v.label}</span>
                <span className="font-mono text-[11px] text-subtle">{v.clause}</span>
                {v.pitr
                  ? <Badge tone="success" size="xs"><Icon name="check" size={9} />Supports PITR</Badge>
                  : <Badge tone="neutral" size="xs">Not a PITR anchor</Badge>}
              </span>
              <span className="mt-1 block text-[12px] text-muted">{v.desc}</span>
              <SqlBlock sql={v.sql} className="mt-2" />
            </label>
          ))}
        </div>
      </Panel>

      <Panel title="2 · Which database" icon="database"
        subtitle="Recovery model decides what is possible: SIMPLE has no log backups and no PITR">
        {recoveryModels.length > 0 ? (
          <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
            {recoveryModels.map((d) => {
              const simple = d.recovery_model_desc === 'SIMPLE';
              return (
                <label
                  key={d.name}
                  className={cn(
                    'flex cursor-pointer items-center gap-2.5 rounded-card border p-2.5 transition-colors',
                    database === d.name ? 'border-accent bg-accent-soft' : 'border-border hover:border-strong hover:bg-sunken',
                  )}
                >
                  <input
                    type="radio"
                    name="backup-db"
                    value={d.name}
                    checked={database === d.name}
                    onChange={() => setDatabase(d.name)}
                    className="sr-only"
                  />
                  <Icon name={database === d.name ? 'check' : 'circle'} size={13}
                    className={database === d.name ? 'text-accent-text' : 'text-subtle'} />
                  <span className="text-[13px] font-semibold text-fg">{d.name}</span>
                  <Badge tone={simple ? 'warning' : 'success'} size="xs">{d.recovery_model_desc}</Badge>
                  <StateChip value={d.state_desc} tones={{ ONLINE: 'success', OFFLINE: 'danger' }} />
                  {d.log_reuse_wait_desc && d.log_reuse_wait_desc !== 'NOTHING' && (
                    <Badge tone="info" size="xs" className="ml-auto">
                      log wait: {d.log_reuse_wait_desc}
                    </Badge>
                  )}
                </label>
              );
            })}
          </div>
        ) : (
          <>
            <Input
              value={database}
              onChange={(e) => setDatabase(e.target.value)}
              placeholder="Database name"
              icon="database"
            />
            <p className="mt-1.5 text-[11px] text-subtle">
              The database list comes from msdb; type the name if it could not be read.
            </p>
          </>
        )}

        {logOnSimple && (
          <Notice tone="danger" className="mt-3 mb-0" title="A log backup is not possible here.">
            <b>{database}</b> is in SIMPLE recovery, which keeps no reusable log. Switch it to
            FULL first, then take a full backup to start the chain.
          </Notice>
        )}
      </Panel>

      <Panel title="3 · Where to write it" icon="desktop"
        subtitle="A path on the SQL Server host. Leave it blank for the server's own default directory.">
        <Input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder={'C:\\Backups\\MyDB\\  —  blank uses the server default'}
          icon="desktop"
          className="font-mono"
        />
        {(path.trim() || defaultDir) && (
          <div className="mt-2.5 rounded-card border border-border bg-sunken px-3 py-2.5">
            <p className="text-[10px] font-bold tracking-wide text-subtle uppercase">
              {path.trim() ? 'Custom directory' : 'Server default directory'}
            </p>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg">
                {path.trim() || defaultDir}
              </code>
              <CopyButton text={path.trim() || defaultDir} />
            </div>
            <p className="mt-1.5 font-mono text-[11px] text-subtle">
              {database || 'DB'}_{type.toUpperCase()}_&#123;timestamp&#125;.bak
            </p>
          </div>
        )}
        <div className="mt-3 flex items-center gap-2.5">
          <Switch checked={compress} onChange={setCompress} label="Backup compression" />
          <span className="text-[12px] font-semibold text-fg">Compression</span>
          <span className="text-[11px] text-subtle">
            Needs Enterprise (2008+) or Standard (2008 R2+)
          </span>
        </div>
      </Panel>

      <Panel title="4 · Note (optional)" icon="bookmark"
        subtitle="Why this backup exists — it shows on the job row">
        <Input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Before the release, pre-migration snapshot…"
        />
      </Panel>

      {result?.ok && (
        <Notice tone="success" title={`Backup started as job #${result.jobId}.`}>
          It runs on the server, so you can leave this page — the job list updates as it goes.
        </Notice>
      )}
      {result && !result.ok && (
        <Notice tone="danger" title="Could not start the backup.">{result.msg}</Notice>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" size="lg" icon="play" loading={busy} disabled={!canSubmit} onClick={submit}>
          Start {bt.label.toLowerCase()}
        </Button>
        <p className="text-[11px] text-subtle">Runs as T-SQL on the SQL Server host.</p>
      </div>
    </div>
  );
}

/* ══ schedules ═════════════════════════════════════════════════════════════ */

const SCHEDULE_TYPES = [
  { id: 'every_x_minutes', label: 'Every N minutes' },
  { id: 'hourly', label: 'Hourly' },
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
];

const DOW = [
  { id: '0', label: 'Mon' }, { id: '1', label: 'Tue' }, { id: '2', label: 'Wed' },
  { id: '3', label: 'Thu' }, { id: '4', label: 'Fri' }, { id: '5', label: 'Sat' },
  { id: '6', label: 'Sun' },
];

const EMPTY_SCHEDULE = {
  name: '', backup_type: 'full', schedule_type: 'daily',
  interval_minutes: 30, minute: 0, hour: 2,
  day_of_week: '0,1,2,3,4', day_of_month: 1,
  databases: '', compress: true, backup_path: '', retain_days: 7, enabled: true,
};

function ScheduleView({ connId, summary, onToast }) {
  const qc = useQueryClient();
  const [form, setForm] = useState(null); // null = list, object = editing
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['mssqlBackupSchedules', connId],
    queryFn: () => api.listSchedules(connId),
    refetchInterval: 10000,
    retry: 1,
  });

  const schedules = data?.schedules || [];
  const dbNames = (summary?.recovery_models || []).map((d) => d.name);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['mssqlBackupSchedules', connId] });
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const openEdit = (s) => {
    setForm({
      name: s.name,
      backup_type: s.backup_type,
      schedule_type: s.schedule_type,
      interval_minutes: s.interval_minutes || 30,
      minute: s.minute ?? 0,
      hour: s.hour ?? 2,
      day_of_week: s.day_of_week || '0,1,2,3,4',
      day_of_month: s.day_of_month || 1,
      databases: Array.isArray(s.databases) ? s.databases.join(', ') : '',
      compress: Boolean(s.compress),
      backup_path: s.backup_path || '',
      retain_days: s.retain_days || 7,
      enabled: s.enabled,
    });
    setEditingId(s.id);
  };

  const save = async () => {
    if (!form.name.trim()) { onToast('Give the schedule a name', 'error'); return; }
    setSaving(true);
    try {
      const payload = {
        ...form,
        hour: Number(form.hour),
        minute: Number(form.minute),
        interval_minutes: Number(form.interval_minutes),
        day_of_month: Number(form.day_of_month),
        retain_days: Number(form.retain_days),
        databases: form.databases.trim()
          ? form.databases.split(',').map((d) => d.trim()).filter(Boolean)
          : null,
        backup_path: form.backup_path.trim() || null,
      };
      if (editingId) await api.updateSchedule(connId, editingId, payload);
      else await api.createSchedule(connId, payload);
      onToast(editingId ? 'Schedule updated' : 'Schedule created');
      invalidate();
      setForm(null);
      setEditingId(null);
    } catch (e) {
      onToast(e?.message || 'Could not save the schedule', 'error');
    } finally {
      setSaving(false);
    }
  };

  const act = async (fn, message) => {
    try { await fn(); onToast(message); invalidate(); }
    catch (e) { onToast(e?.message || 'That did not work', 'error'); }
  };

  if (isLoading) return <InlineLoading label="Loading schedules…" />;

  if (isError || data?.status === 'error') {
    return (
      <Notice tone="danger" title="Could not load schedules.">
        {data?.error || error?.message}
      </Notice>
    );
  }

  if (form) {
    return (
      <div className="max-w-2xl space-y-gutter">
        <Panel
          title={editingId ? `Edit “${form.name || 'schedule'}”` : 'New schedule'}
          icon="calendar"
          subtitle="ActMon runs these itself — they are not SQL Agent jobs"
        >
          <div className="space-y-gutter-sm">
            <Field label="Name">
              <Input value={form.name} onChange={(e) => set({ name: e.target.value })}
                placeholder="Nightly full backup" />
            </Field>

            <div className="grid gap-gutter-sm sm:grid-cols-2">
              <Field label="Backup type">
                <Select
                  value={form.backup_type}
                  onChange={(v) => set({ backup_type: v })}
                  options={Object.entries(BACKUP_TYPES).map(([id, v]) => ({ id, label: v.label }))}
                />
              </Field>
              <Field label="Runs">
                <Select
                  value={form.schedule_type}
                  onChange={(v) => set({ schedule_type: v })}
                  options={SCHEDULE_TYPES}
                />
              </Field>
            </div>

            {form.schedule_type === 'every_x_minutes' && (
              <Field label="Interval" hint="Minutes between runs">
                <Input type="number" min={1} value={form.interval_minutes}
                  onChange={(e) => set({ interval_minutes: e.target.value })} />
              </Field>
            )}

            {form.schedule_type === 'hourly' && (
              <Field label="Minute past the hour">
                <Input type="number" min={0} max={59} value={form.minute}
                  onChange={(e) => set({ minute: e.target.value })} />
              </Field>
            )}

            {['daily', 'weekly', 'monthly'].includes(form.schedule_type) && (
              <Field label="Time of day" hint="24-hour clock, in the database server's timezone">
                <div className="flex items-center gap-1.5">
                  <Select
                    value={String(form.hour)}
                    onChange={(v) => set({ hour: v })}
                    options={Array.from({ length: 24 }, (_, h) => ({
                      id: String(h), label: `${String(h).padStart(2, '0')}h`,
                    }))}
                    width="auto"
                  />
                  <span className="font-bold text-muted">:</span>
                  <Select
                    value={String(form.minute)}
                    onChange={(v) => set({ minute: v })}
                    options={Array.from({ length: 60 }, (_, m) => ({
                      id: String(m), label: String(m).padStart(2, '0'),
                    }))}
                    width="auto"
                  />
                </div>
              </Field>
            )}

            {form.schedule_type === 'weekly' && (
              <Field label="Days">
                <div className="flex flex-wrap gap-1.5">
                  {DOW.map((d) => {
                    const set0 = new Set(String(form.day_of_week || '').split(',').filter(Boolean));
                    const on = set0.has(d.id);
                    return (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => {
                          if (on) set0.delete(d.id); else set0.add(d.id);
                          set({ day_of_week: [...set0].sort().join(',') });
                        }}
                        aria-pressed={on}
                        className={cn(
                          'h-8 rounded-control border px-2.5 text-[12px] font-semibold transition-colors',
                          on ? 'border-accent bg-accent text-accent-fg' : 'border-border text-muted hover:bg-sunken',
                        )}
                      >
                        {d.label}
                      </button>
                    );
                  })}
                </div>
              </Field>
            )}

            {form.schedule_type === 'monthly' && (
              <Field label="Day of the month" hint="29–31 are skipped in months that are shorter">
                <Input type="number" min={1} max={31} value={form.day_of_month}
                  onChange={(e) => set({ day_of_month: e.target.value })} />
              </Field>
            )}

            <Field label="Databases"
              hint={dbNames.length ? `Comma-separated. Blank means all user databases: ${dbNames.join(', ')}` : 'Comma-separated. Blank means all user databases.'}>
              <Input value={form.databases} onChange={(e) => set({ databases: e.target.value })}
                placeholder="Blank = every user database" />
            </Field>

            <div className="grid gap-gutter-sm sm:grid-cols-2">
              <Field label="Keep for" hint="Days before older files are removed">
                <Input type="number" min={1} value={form.retain_days}
                  onChange={(e) => set({ retain_days: e.target.value })} />
              </Field>
              <Field label="Directory" hint="On the SQL Server host; blank uses the default">
                <Input value={form.backup_path} onChange={(e) => set({ backup_path: e.target.value })}
                  className="font-mono" placeholder="Server default" />
              </Field>
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <span className="flex items-center gap-2">
                <Switch checked={form.compress} onChange={(v) => set({ compress: v })} label="Compression" />
                <span className="text-[12px] font-semibold text-fg">Compression</span>
              </span>
              <span className="flex items-center gap-2">
                <Switch checked={form.enabled} onChange={(v) => set({ enabled: v })} label="Enabled" />
                <span className="text-[12px] font-semibold text-fg">Enabled</span>
              </span>
            </div>
          </div>
        </Panel>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" icon="save" loading={saving} onClick={save}>
            {editingId ? 'Save changes' : 'Create schedule'}
          </Button>
          <Button variant="secondary" onClick={() => { setForm(null); setEditingId(null); }}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-gutter">
      <TablePanel
        title="Backup schedules"
        icon="calendar"
        subtitle="Run by ActMon's own scheduler, so they work whether or not SQL Agent is licensed"
        actions={(
          <>
            <Button size="sm" variant="secondary" icon="refresh" onClick={refetch}>Refresh</Button>
            <Button size="sm" variant="primary" icon="plus"
              onClick={() => { setForm(EMPTY_SCHEDULE); setEditingId(null); }}>
              New schedule
            </Button>
          </>
        )}
      >
        <Table
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'type', label: 'Type' },
            { key: 'when', label: 'Runs' },
            { key: 'dbs', label: 'Databases' },
            { key: 'retain', label: 'Keep', align: 'right' },
            { key: 'last', label: 'Last run' },
            { key: 'next', label: 'Next run' },
            { key: 'state', label: 'State' },
            { key: 'actions', label: '', align: 'right' },
          ]}
          rows={schedules.map((s) => ({
            key: String(s.id),
            cells: {
              name: <span className="font-semibold text-accent-text">{s.name}</span>,
              type: <Badge tone={TYPE_TONES[s.backup_type] || 'neutral'} size="xs">{TYPE_LABEL(s.backup_type)}</Badge>,
              when: <span className="text-[12px] text-muted">{s.human_schedule}</span>,
              dbs: (
                <span className="truncate-safe block max-w-[180px] text-[12px] text-muted">
                  {s.databases?.length ? s.databases.join(', ') : 'All user databases'}
                </span>
              ),
              retain: <span className="font-mono text-[12px]">{s.retain_days ? `${s.retain_days}d` : null}</span>,
              last: (
                <span className="flex flex-col">
                  <Stamp value={s.last_run_at} />
                  {s.last_status && (
                    <Badge tone={s.last_status === 'completed' ? 'success' : s.last_status === 'failed' ? 'danger' : 'neutral'} size="xs">
                      {s.last_status}
                    </Badge>
                  )}
                </span>
              ),
              next: s.enabled ? <Stamp value={s.next_run_at} /> : <span className="text-[11px] text-subtle">paused</span>,
              state: s.enabled
                ? <Badge tone="success" size="xs">Enabled</Badge>
                : <Badge tone="neutral" size="xs">Paused</Badge>,
              actions: (
                <span className="flex items-center justify-end gap-1">
                  <IconButton size="sm" icon="play" label={`Run “${s.name}” now`}
                    onClick={() => act(() => api.runNow(connId, s.id), 'Backup triggered — see ActMon jobs')} />
                  <IconButton
                    size="sm"
                    icon={s.enabled ? 'lock' : 'check'}
                    label={s.enabled ? `Pause “${s.name}”` : `Enable “${s.name}”`}
                    onClick={() => act(
                      () => api.toggleSchedule(connId, s.id, !s.enabled),
                      s.enabled ? 'Schedule paused' : 'Schedule enabled',
                    )}
                  />
                  <IconButton size="sm" icon="settings" label={`Edit “${s.name}”`} onClick={() => openEdit(s)} />
                  <IconButton size="sm" tone="danger" icon="trash" label={`Delete “${s.name}”`}
                    onClick={() => setConfirmDelete(s)} />
                </span>
              ),
            },
          }))}
          empty={(
            <EmptyState
              icon="calendar"
              title="No schedules"
              body="Nothing runs automatically on this connection yet."
              action={(
                <Button variant="primary" icon="plus"
                  onClick={() => { setForm(EMPTY_SCHEDULE); setEditingId(null); }}>
                  Create the first one
                </Button>
              )}
            />
          )}
        />
      </TablePanel>

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title={`Delete “${confirmDelete?.name}”?`}
        message="The schedule stops running. Backups it already took, and their files, are untouched."
        confirmLabel="Delete schedule"
        cancelLabel="Keep it"
        tone="danger"
        onConfirm={() => {
          act(() => api.deleteSchedule(connId, confirmDelete.id), 'Schedule deleted');
          setConfirmDelete(null);
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="mb-1 block text-[12px] font-semibold text-fg">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-subtle">{hint}</p>}
    </div>
  );
}

/* ══ SQL Server's own history ══════════════════════════════════════════════ */

function HistoryView({ connId }) {
  const [dbFilter, setDbFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [days, setDays] = useState('30');
  const [search, setSearch] = useState('');

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['mssqlBackupHistory', connId, dbFilter, typeFilter, days],
    queryFn: () => api.history(connId, {
      db_name: dbFilter || undefined,
      backup_type: typeFilter || undefined,
      days: Number(days),
      limit: 200,
    }),
    retry: false,
  });

  const history = data?.history || [];
  const dbOptions = useMemo(() => ([
    { id: '', label: 'All databases' },
    ...[...new Set(history.map((h) => h.database_name).filter(Boolean))].sort()
      .map((d) => ({ id: d, label: d })),
  ]), [history]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return history;
    return history.filter((h) => [h.database_name, h.file_path, h.backup_name, h.server_name]
      .some((v) => String(v || '').toLowerCase().includes(q)));
  }, [history, search]);

  const compressed = history.filter((h) => num(h.compressed_mb) > 0 && num(h.compressed_mb) < num(h.size_mb));
  const savedPct = compressed.length
    ? Math.round((1 - compressed.reduce((a, h) => a + num(h.compressed_mb), 0)
      / compressed.reduce((a, h) => a + num(h.size_mb), 0)) * 100)
    : null;

  return (
    <div className="space-y-gutter">
      {data?.status === 'error' && (
        <Notice tone="danger" title="Could not read msdb history.">{data.error}</Notice>
      )}

      <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4">
        <MetricTile label="Backup sets" value={history.length} icon="history"
          sub={`last ${days} days`} />
        <MetricTile label="Databases covered" icon="database"
          value={new Set(history.map((h) => h.database_name)).size} />
        <MetricTile label="Total size" icon="desktop"
          value={history.length ? fmtBytes(history.reduce((a, h) => a + mbToBytes(h.size_mb), 0)) : '—'} />
        <MetricTile label="Compression saving" icon="layers"
          value={savedPct != null ? `${savedPct}%` : '—'}
          hint={savedPct != null ? `Across ${compressed.length} compressed sets` : 'No compressed backups in this window'} />
      </div>

      <TablePanel
        title="SQL Server backup history"
        icon="history"
        subtitle="Straight from msdb.dbo.backupset — includes backups taken outside ActMon"
        actions={(
          <>
            <Select value={dbFilter} onChange={setDbFilter} options={dbOptions} size="sm" width="auto" />
            <Select
              value={typeFilter}
              onChange={setTypeFilter}
              options={[
                { id: '', label: 'All types' },
                { id: 'full', label: 'Full' },
                { id: 'differential', label: 'Differential' },
                { id: 'log', label: 'Log' },
                { id: 'copy_only', label: 'Copy-only' },
              ]}
              size="sm"
              width="auto"
            />
            <Select
              value={days}
              onChange={setDays}
              options={[
                { id: '1', label: 'Last 24h' },
                { id: '7', label: 'Last 7 days' },
                { id: '30', label: 'Last 30 days' },
                { id: '90', label: 'Last 90 days' },
                { id: '365', label: 'Last year' },
              ]}
              size="sm"
              width="auto"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onClear={() => setSearch('')}
              placeholder="Search…"
              icon="search"
              size="sm"
              wrapperClassName="w-36"
            />
            <Button size="sm" variant="secondary" icon="refresh" loading={isFetching} onClick={refetch}>
              Refresh
            </Button>
          </>
        )}
      >
        {isLoading ? (
          <InlineLoading label="Reading msdb…" />
        ) : (
          <Paged rows={shown} unit="backup sets">
            {(page, pager) => (
              <>
                <Table
                  columns={[
                    { key: 'db', label: 'Database' },
                    { key: 'type', label: 'Type' },
                    { key: 'finished', label: 'Finished' },
                    { key: 'dur', label: 'Duration', align: 'right' },
                    { key: 'size', label: 'Size', align: 'right' },
                    { key: 'compressed', label: 'On disk', align: 'right' },
                    { key: 'recovery', label: 'Recovery' },
                    { key: 'file', label: 'File' },
                  ]}
                  rows={page.map((h, i) => ({
                    key: `hist-${h.media_set_id}-${i}`,
                    cells: {
                      db: <span className="font-semibold text-accent-text">{h.database_name}</span>,
                      type: <Badge tone={TYPE_TONES[h.backup_type] || 'neutral'} size="xs">{TYPE_LABEL(h.backup_type)}</Badge>,
                      finished: <Stamp value={h.backup_finish} />,
                      dur: (
                        <span className="font-mono text-[12px]">
                          {h.duration_sec != null ? `${h.duration_sec}s` : null}
                        </span>
                      ),
                      size: <span className="font-mono text-[12px]">{fmtBytes(mbToBytes(h.size_mb))}</span>,
                      compressed: num(h.compressed_mb) > 0 ? (
                        <span className="font-mono text-[12px] text-success-fg">
                          {fmtBytes(mbToBytes(h.compressed_mb))}
                        </span>
                      ) : null,
                      recovery: <StateChip value={h.recovery_model}
                        tones={{ FULL: 'success', SIMPLE: 'warning', BULK_LOGGED: 'info' }} />,
                      file: h.file_path ? (
                        <span className="flex items-center gap-1.5">
                          <span title={h.file_path} className="truncate-safe block max-w-[180px] font-mono text-[11px] text-muted">
                            {fileName(h.file_path)}
                          </span>
                          <CopyButton text={h.file_path} variant="ghost" label="" />
                        </span>
                      ) : null,
                    },
                  }))}
                  empty={<EmptyState icon="history" title="No backup sets"
                    body={`msdb has no backup finishing in the last ${days} days for this filter.`} />}
                />
                {pager}
              </>
            )}
          </Paged>
        )}
      </TablePanel>
    </div>
  );
}

/* ══ PITR ══════════════════════════════════════════════════════════════════ */

const PITR_STEPS = [
  { n: 1, title: 'Restore the full backup', sql: 'RESTORE DATABASE … WITH NORECOVERY' },
  { n: 2, title: 'Apply the newest differential', sql: 'RESTORE DATABASE … WITH NORECOVERY (if any)' },
  { n: 3, title: 'Replay the log backups', sql: 'RESTORE LOG … WITH NORECOVERY (repeated)' },
  { n: 4, title: 'Bring it online at the target', sql: "RESTORE DATABASE … WITH RECOVERY, STOPAT = '…'" },
];

function PitrView({ connId, onDone, onToast }) {
  const [database, setDatabase] = useState('');
  const [target, setTarget] = useState('');
  const [restoreAs, setRestoreAs] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [openChain, setOpenChain] = useState({});

  const { data, isLoading } = useQuery({
    queryKey: ['mssqlRecoveryChain', connId],
    queryFn: () => api.recoveryChain(connId),
    staleTime: 30000,
    retry: false,
  });

  const chains = data?.chains || [];
  const eligible = chains.filter((c) => c.has_full && num(c.log_count) > 0);
  const selected = chains.find((c) => c.database === database);
  /* The value goes straight into STOPAT. A datetime-local input may omit the
     seconds when they are zero, and "07:30" in a STOPAT clause is ambiguous to
     read even though SQL Server accepts it — pad it so the statement, the
     confirmation and the job note all say the same exact second. */
  const targetSql = target
    ? `${target.replace('T', ' ')}${target.length === 16 ? ':00' : ''}`
    : '';
  const overwriting = !restoreAs.trim();

  const start = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await api.pitr(connId, {
        database,
        target_datetime: targetSql,
        restore_as: restoreAs.trim() || null,
        confirm: true,
      });
      setResult({ ok: true, jobId: res.job_id, message: res.message });
      onToast(`Recovery of ${database} started`);
      onDone();
    } catch (e) {
      const msg = e?.message || 'Could not start the recovery.';
      setResult({ ok: false, msg });
      onToast(msg, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-gutter">
      <Panel title="How point-in-time recovery works" icon="refresh"
        subtitle="Four native RESTORE steps, run for you in order">
        <div className="grid gap-gutter-sm sm:grid-cols-2 xl:grid-cols-4">
          {PITR_STEPS.map((s) => (
            <div key={s.n} className="rounded-card border border-border bg-sunken p-3">
              <span className="grid h-6 w-6 place-items-center rounded-full bg-accent text-[11px] font-bold text-accent-fg">
                {s.n}
              </span>
              <p className="mt-2 text-[12px] font-bold text-fg">{s.title}</p>
              <p className="mt-1 font-mono text-[10px] leading-snug text-subtle">{s.sql}</p>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Recovery windows" icon="clock"
        subtitle="What each database could be restored to right now">
        {isLoading ? (
          <InlineLoading label="Reading the backup chain…" />
        ) : chains.length === 0 ? (
          <EmptyState icon="archive" title="No recovery chain"
            body="msdb has no backup sets. Take a full backup, then log backups, to make point-in-time recovery possible." />
        ) : (
          <div className="space-y-1.5">
            {chains.map((c) => {
              const open = Boolean(openChain[c.database]);
              const logs = num(c.log_count);
              return (
                <div key={c.database} className="overflow-hidden rounded-card border border-border">
                  <button
                    type="button"
                    onClick={() => setOpenChain((s) => ({ ...s, [c.database]: !s[c.database] }))}
                    className="flex w-full flex-wrap items-center gap-2 bg-sunken px-3 py-2.5 text-left transition-colors hover:bg-raised"
                  >
                    <Icon name="database" size={13} className="shrink-0 text-subtle" />
                    <span className="text-[13px] font-bold text-fg">{c.database}</span>
                    {!c.has_full ? (
                      <Badge tone="danger" size="xs">No full backup</Badge>
                    ) : (
                      <>
                        <Badge tone="accent" size="xs">Full</Badge>
                        {c.differentials?.length > 0 && (
                          <Badge tone="info" size="xs">{c.differentials.length} differential</Badge>
                        )}
                        {logs > 0 ? (
                          <>
                            <Badge tone="success" size="xs">{logs} log</Badge>
                            <span className="hidden text-[11px] text-muted md:inline">
                              {String(c.earliest_pitr || '').slice(0, 16)} →{' '}
                              <b className="text-fg">{String(c.latest_pitr || '').slice(0, 16)}</b>
                            </span>
                          </>
                        ) : (
                          <Badge tone="warning" size="xs">No logs — no PITR</Badge>
                        )}
                      </>
                    )}
                    <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14}
                      className="ml-auto shrink-0 text-subtle" />
                  </button>

                  {open && c.has_full && (
                    <div className="space-y-gutter-sm border-t border-border px-3 py-3">
                      <div>
                        <p className="mb-1 text-[10px] font-bold tracking-wide text-subtle uppercase">
                          Latest full backup
                        </p>
                        <div className="flex flex-wrap items-center gap-2 rounded-control bg-sunken px-2.5 py-1.5 text-[12px]">
                          <span className="font-mono text-muted">{String(c.full_backup?.backup_finish || '').slice(0, 19)}</span>
                          <span className="text-subtle">{fmtBytes(mbToBytes(c.full_backup?.size_mb))}</span>
                          {c.full_backup?.file_path && (
                            <>
                              <span title={c.full_backup.file_path}
                                className="truncate-safe min-w-0 flex-1 font-mono text-[11px] text-subtle">
                                {fileName(c.full_backup.file_path)}
                              </span>
                              <CopyButton text={c.full_backup.file_path} variant="ghost" label="" />
                            </>
                          )}
                        </div>
                      </div>

                      {c.differentials?.length > 0 && (
                        <div>
                          <p className="mb-1 text-[10px] font-bold tracking-wide text-subtle uppercase">
                            Differentials since that full backup ({c.differentials.length})
                          </p>
                          <div className="space-y-1">
                            {c.differentials.slice(0, 3).map((d, i) => (
                              <div key={i} className="flex items-center gap-2 rounded-control bg-sunken px-2.5 py-1.5 text-[11px]">
                                <span className="font-mono text-muted">{String(d.backup_finish || '').slice(0, 19)}</span>
                                <span className="text-subtle">{fmtBytes(mbToBytes(d.size_mb))}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {logs > 0 ? (
                        <div>
                          <p className="mb-1 text-[10px] font-bold tracking-wide text-subtle uppercase">
                            Log chain — {logs} backup{logs === 1 ? '' : 's'}, recoverable to any second
                            between {String(c.earliest_pitr || '').slice(0, 16)} and {String(c.latest_pitr || '').slice(0, 16)}
                          </p>
                          {/* One tick per log backup: the gaps are what matter, because a
                              gap is a stretch of time that cannot be recovered to. */}
                          <div className="no-scrollbar flex items-end gap-0.5 overflow-x-auto pb-1">
                            {(c.log_backups || []).slice(0, 60).map((lg, i) => (
                              <span
                                key={i}
                                title={`${String(lg.backup_finish || '').slice(0, 19)} · ${fmtBytes(mbToBytes(lg.size_mb))}`}
                                className="h-6 w-2.5 shrink-0 rounded-xs bg-accent opacity-70 transition-opacity hover:opacity-100"
                              />
                            ))}
                            {logs > 60 && (
                              <span className="ml-1 text-[10px] whitespace-nowrap text-subtle">
                                +{logs - 60} more
                              </span>
                            )}
                          </div>
                        </div>
                      ) : (
                        <Notice tone="warning" className="mb-0" title="No log backups.">
                          Set this database to FULL recovery and schedule log backups; until then it
                          can only be restored to the moment of its last full or differential backup.
                        </Notice>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <div className="max-w-2xl space-y-gutter">
        <Notice tone="danger" title="This overwrites data.">
          A recovery rolls the database back to the moment you choose. Everything written after
          that moment is gone. Restoring under a new name leaves the live database untouched —
          do that unless you specifically intend to replace it.
        </Notice>

        <Panel title="1 · Which database" icon="database"
          subtitle="Only databases with a full backup and at least one log backup can be recovered to a point in time">
          {eligible.length === 0 ? (
            <EmptyState icon="shield" title="Nothing is eligible"
              body="A full backup plus at least one transaction log backup is required." />
          ) : (
            <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
              {eligible.map((c) => (
                <label
                  key={c.database}
                  className={cn(
                    'block cursor-pointer rounded-card border p-3 transition-colors',
                    database === c.database ? 'border-accent bg-accent-soft' : 'border-border hover:border-strong hover:bg-sunken',
                  )}
                >
                  <input
                    type="radio"
                    name="pitr-db"
                    value={c.database}
                    checked={database === c.database}
                    onChange={() => { setDatabase(c.database); setTarget(''); }}
                    className="sr-only"
                  />
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-bold text-fg">{c.database}</span>
                    <Badge tone="success" size="xs">{c.log_count} log backups</Badge>
                    {c.recovery_model && (
                      <StateChip value={c.recovery_model} tones={{ FULL: 'success', SIMPLE: 'warning' }} />
                    )}
                  </span>
                  <span className="mt-1 block text-[11px] text-muted">
                    Recoverable from <b className="text-fg">{String(c.earliest_pitr || '').slice(0, 16)}</b>{' '}
                    to <b className="text-fg">{String(c.latest_pitr || '').slice(0, 16)}</b>
                  </span>
                </label>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="2 · The moment to recover to" icon="clock"
          subtitle="Set it a second before the incident, so the damage is not replayed">
          <input
            type="datetime-local"
            step="1"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            min={selected?.earliest_pitr ? String(selected.earliest_pitr).slice(0, 16).replace(' ', 'T') : undefined}
            max={selected?.latest_pitr ? String(selected.latest_pitr).slice(0, 16).replace(' ', 'T') : undefined}
            className="h-control w-full rounded-control border border-border bg-surface px-2.5 text-[13px] text-fg transition-colors hover:border-strong"
          />
          {target && (
            <p className="mt-2 flex items-center gap-2 text-[12px] font-semibold text-success-fg">
              <Icon name="check" size={13} />
              Recovering to <code className="font-mono">{targetSql}</code>
            </p>
          )}
          {selected && !target && (
            <p className="mt-2 text-[12px] text-muted">
              Anything between{' '}
              <code className="font-mono">{String(selected.earliest_pitr || '').slice(0, 19)}</code> and{' '}
              <code className="font-mono">{String(selected.latest_pitr || '').slice(0, 19)}</code>.
            </p>
          )}
        </Panel>

        <Panel title="3 · Restore as" icon="database"
          subtitle="A new name keeps the live database intact — strongly preferred">
          <Input
            value={restoreAs}
            onChange={(e) => setRestoreAs(e.target.value)}
            placeholder={database ? `${database}_recovered` : 'New database name'}
          />
          {overwriting && database && (
            <Notice tone="warning" className="mt-2 mb-0" title="This will replace the live database.">
              With no new name, <b>{database}</b> itself is rolled back and everything after the
              target time is lost.
            </Notice>
          )}
        </Panel>

        {result?.ok && (
          <Notice tone="success" title={`Recovery started as job #${result.jobId}.`}>
            {result.message || 'It runs on the server — watch progress in ActMon jobs.'}
          </Notice>
        )}
        {result && !result.ok && (
          <Notice tone="danger" title="Could not start the recovery.">{result.msg}</Notice>
        )}

        <Button
          variant="danger"
          size="lg"
          icon="refresh"
          loading={busy}
          disabled={!database || !target || busy}
          onClick={() => setConfirmOpen(true)}
        >
          Start recovery
        </Button>
      </div>

      {/* The confirmation spells out the exact consequence, including the target name,
          because "are you sure?" is not enough for something irreversible. */}
      <ConfirmDialog
        open={confirmOpen}
        title="Start point-in-time recovery?"
        message={restoreAs.trim()
          ? `${database} will be restored to ${targetSql} as a new database called ${restoreAs.trim()}. The live ${database} is not touched.`
          : `${database} will be rolled back to ${targetSql}. Every change made after that moment is permanently lost, and there is no undo.`}
        confirmLabel={restoreAs.trim() ? 'Restore to a new database' : 'Overwrite the live database'}
        cancelLabel="Cancel"
        tone="danger"
        onConfirm={() => { setConfirmOpen(false); start(); }}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
