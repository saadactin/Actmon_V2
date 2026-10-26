/**
 * Oracle RMAN backup monitoring.
 *
 * The page is ordered by the question a DBA actually arrives with: "if this
 * instance died now, what would we get back?" So the findings come first —
 * the handful of things that make a restore fail — then the evidence behind
 * them, and the job history last. A job list on its own looks reassuring
 * right up until the restore, which is why it is not the headline here.
 *
 * Everything is read-only. Nothing on this page can start, cancel or delete a
 * backup: RMAN operations belong in the backup tool and its scheduler, and a
 * monitoring product that can delete backup sets is a monitoring product that
 * can lose your data.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import client from '@/api/client';

import Badge from '@/components/ui/Badge';
import Dialog from '@/components/ui/Dialog';
import Notice from '@/components/ui/Notice';
import Table2, { EmptyState } from '@/components/ui/Table';
import { InlineLoading, PageLoading } from '@/components/ui/Loading';
import { Paged } from '@/components/ui/Pagination';
import {
  DefRow, IdCell, MetricTile, Panel, StateChip, TablePanel, UsageBar,
} from '@/pages/_shared/enginePanels';
import {
  fmtNumber, fmtMB, fmtGB,
} from '@/config/dbCatalog';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const SEVERITY_TONE = { critical: 'danger', high: 'danger', medium: 'warning', low: 'info' };
const SEVERITY_NOTICE = { critical: 'danger', high: 'danger', medium: 'warning', low: 'info' };

/* RMAN's own status vocabulary, mapped to the status token trio. Anything it
   invents that is not listed here stays neutral rather than being guessed at. */
const JOB_STATUS_TONES = {
  COMPLETED: 'success',
  'COMPLETED WITH WARNINGS': 'warning',
  'COMPLETED WITH ERRORS': 'danger',
  FAILED: 'danger',
  RUNNING: 'info',
};

function gb(v) {
  const n = num(v);
  if (!n) return '—';
  return n >= 1024 ? `${fmtNumber(Math.round(n / 1024))} TB` : fmtGB(n.toFixed(n < 10 ? 2 : 0));
}

function duration(seconds) {
  const s = num(seconds);
  if (!s) return '—';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** "6.2 hours ago" reads better than a timestamp when the question is staleness. */
function ago(hours) {
  const h = num(hours);
  if (!h) return 'just now';
  if (h < 1) return `${Math.round(h * 60)} min ago`;
  if (h < 48) return `${h.toFixed(1)} h ago`;
  return `${(h / 24).toFixed(1)} days ago`;
}

export default function RmanBackups({ connId }) {
  const [openJob, setOpenJob] = useState(null);
  /* The three input types backup.sql reports on, plus everything. */
  const [jobType, setJobType] = useState('ALL');

  const rman = useQuery({
    queryKey: ['oracleRman', connId],
    queryFn: async () => (await client.get(`/connections/oracle/${connId}/oracle-rman-backup`)).data,
    refetchInterval: 60000,
    enabled: !!connId,
  });

  if (rman.isLoading) return <PageLoading title="Reading RMAN backup history…" illustration />;

  const d = rman.data || {};
  if (d.status === 'error') {
    return <Notice tone="danger" title="Could not read RMAN backup history.">{d.error}</Notice>;
  }

  const s = d.summary || {};
  const findings = d.findings || [];
  const fra = d.fra || {};
  const archivelogs = d.archivelogs || {};
  const lastDb = s.last_db_backup;
  const lastArch = s.last_archivelog;
  // Which readings actually came back. Older builds of the API do not send
  // this, so an absent flag is treated as "read" rather than blanking the page.
  const got = s.available || {};
  const has = (k) => got[k] !== false;
  const archivelogMode = (s.log_mode || '').toUpperCase() === 'ARCHIVELOG';

  return (
    <div className="space-y-gutter">
      {/* ── the answer, before the evidence ─────────────────────────────── */}
      <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-3 xl:grid-cols-6">
        <MetricTile
          label="Last DB backup"
          value={!has('jobs') ? 'Unknown' : lastDb ? ago(lastDb.age_hours) : 'Never'}
          sub={!has('jobs')
            ? 'job history could not be read'
            : lastDb ? `${lastDb.input_type} · ${lastDb.end_time}` : 'no completed database backup'}
          tone={!has('jobs') ? 'warn' : !lastDb || num(lastDb.age_hours) > 24 * 7 ? 'bad' : 'good'}
          icon="database"
          hint="The newest completed job with a datafile input type — the furthest back a restore can reach."
        />
        <MetricTile
          label="Last archivelog backup"
          value={!has('jobs') ? 'Unknown' : lastArch ? ago(lastArch.age_hours) : 'Never'}
          sub={!has('jobs')
            ? 'job history could not be read'
            : lastArch ? lastArch.end_time : 'no completed archivelog backup'}
          tone={!has('jobs') ? 'warn' : !lastArch || num(lastArch.age_hours) > 24 ? 'warn' : 'good'}
          icon="clock"
          hint="Archivelog backups are what shorten the data-loss window between full backups."
        />
        <MetricTile
          label="Archivelog mode"
          value={!has('database') ? 'Unknown' : s.log_mode || '—'}
          sub={!has('database')
            ? 'v$database could not be read'
            : archivelogMode ? 'point-in-time recovery possible' : 'no point-in-time recovery'}
          tone={!has('database') ? 'warn' : archivelogMode ? 'good' : 'bad'}
          icon="shield"
        />
        <MetricTile
          label="Failed (7 days)"
          value={!has('jobs') ? 'Unknown' : fmtNumber(s.failed_7d ?? 0)}
          sub={!has('jobs')
            ? 'job history could not be read'
            : s.running ? `${s.running} running now` : `${fmtNumber(s.total_jobs ?? 0)} jobs on record`}
          tone={!has('jobs') ? 'warn' : num(s.failed_7d) ? 'bad' : 'good'}
          icon="alert"
        />
        <MetricTile
          label="Datafiles covered"
          value={!has('coverage')
            ? 'Unknown'
            : `${fmtNumber((s.datafiles ?? 0) - (s.datafiles_never ?? 0))} / ${fmtNumber(s.datafiles ?? 0)}`}
          sub={!has('coverage')
            ? 'coverage could not be read'
            : num(s.datafiles_never) ? `${s.datafiles_never} never backed up` : 'every datafile has a backup'}
          tone={!has('coverage') ? 'warn' : num(s.datafiles_never) ? 'bad' : 'good'}
          icon="layers"
          hint="A restore needs every datafile. One missing file makes the set unusable for a full recovery."
        />
        <MetricTile
          label="Fast Recovery Area"
          value={!has('fra') ? 'Unknown' : s.fra_configured ? `${num(s.fra_pct_used).toFixed(1)}%` : 'Not configured'}
          sub={!has('fra')
            ? 'v$recovery_file_dest could not be read'
            : s.fra_configured ? `${gb(fra.used_gb)} of ${gb(fra.limit_gb)}` : 'no FRA on this instance'}
          tone={!has('fra') ? 'warn' : !s.fra_configured ? 'neutral' : num(s.fra_pct_used) >= 95 ? 'bad' : num(s.fra_pct_used) >= 85 ? 'warn' : 'good'}
          icon="hard-drive"
          hint="A full FRA does not degrade gracefully — the instance hangs the moment it cannot archive."
        />
      </div>

      {(d.errors || []).length > 0 && (
        <Notice tone="warning" title="Some RMAN views could not be read.">
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px]">
            {d.errors.map((e, i) => <li key={i} className="font-mono break-all">{e}</li>)}
          </ul>
          <p className="mt-2 text-[11px]">
            The panels below show everything that did read. This is usually a monitoring user
            without SELECT on that view, or a view that does not exist on this Oracle version.
          </p>
        </Notice>
      )}

      {/* ── findings ────────────────────────────────────────────────────── */}
      <Panel
        title="Recovery exposure"
        icon="shield"
        subtitle="What would stop a restore, or shorten how far back one could go"
      >
        {findings.length === 0 ? (
          <Notice tone="success" title="Nothing is standing between this instance and a restore.">
            Archivelog mode is on, every datafile has a backup, the last one is recent, and nothing
            is sitting in the recovery path. This panel stays empty while that holds.
          </Notice>
        ) : (
          <div className="space-y-2">
            {findings.map((f, i) => (
              <Notice key={i} tone={SEVERITY_NOTICE[f.severity] || 'warning'} title={f.title}>
                <p className="text-[12px] leading-relaxed">{f.detail}</p>
                <p className="mt-1.5 font-mono text-[11px] opacity-80">{f.evidence}</p>
              </Notice>
            ))}
          </div>
        )}
      </Panel>

      {/* ── hot backup mode: rare, and never routine ─────────────────────── */}
      {(d.hot_backup || []).length > 0 && (
        <TablePanel
          title="Datafiles in hot backup mode"
          icon="alert"
          subtitle="Left in BEGIN BACKUP — writing whole block images into redo, and the instance will not open after a crash until END BACKUP is issued"
        >
          <Table2
            rowHeight={64}
            darkHeader
            cellText
            columns={[
              { key: 'file', label: 'File' },
              { key: 'num', label: 'File #', align: 'right' },
              { key: 'since', label: 'Since' },
              { key: 'open', label: 'Open for', align: 'right' },
            ]}
            rows={(d.hot_backup || []).map((h) => ({
              key: h.file_num,
              cells: {
                file: <span className="font-mono">{h.file_name}</span>,
                num: <IdCell value={h.file_num} />,
                since: <span className="font-mono text-muted">{h.since}</span>,
                open: <span className="font-mono font-bold text-danger-fg">{num(h.hours_open).toFixed(1)} h</span>,
              },
            }))}
          />
        </TablePanel>
      )}

      {/* ── job history ─────────────────────────────────────────────────── */}
      <TablePanel
        title={`Backup jobs (${fmtNumber(s.total_jobs ?? 0)})`}
        icon="clock"
        subtitle={`v$rman_backup_job_details, last ${d.job_window_days ?? 7} days, newest first — plus the latest of each type however old. Click a job for what RMAN said.`}
        actions={(
          <span className="flex items-center gap-0.5 rounded-control border border-border p-0.5">
            {['ALL', 'DB FULL', 'DB INCR', 'ARCHIVELOG'].map((t) => (
              <button key={t} type="button" onClick={() => setJobType(t)} aria-pressed={jobType === t}
                className={`h-7 rounded-control px-2 text-[11px] font-bold transition-colors ${
                  jobType === t ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-sunken hover:text-fg'}`}>
                {t === 'ALL' ? 'All' : t}
              </button>
            ))}
          </span>
        )}
      >
        <Paged rows={(d.jobs || []).filter((j) => jobType === 'ALL' || (j.input_type || '').toUpperCase() === jobType)} unit="jobs">
          {(page, pager) => (
            <>
              <Table2
                rowHeight={64}
                darkHeader
                cellText
                columns={[
                  { key: 'type', label: 'Type' },
                  { key: 'status', label: 'Status' },
                  { key: 'start', label: 'Started' },
                  { key: 'end', label: 'Ended' },
                  { key: 'dur', label: 'Duration', align: 'right' },
                  { key: 'input', label: 'Read', align: 'right' },
                  { key: 'output', label: 'Written', align: 'right' },
                  { key: 'rate', label: 'Throughput', align: 'right' },
                  { key: 'compress', label: 'Compression', align: 'right' },
                  { key: 'device', label: 'Device' },
                ]}
                rows={page.map((j) => ({
                  key: j.session_key,
                  onClick: () => setOpenJob(j),
                  cells: {
                    type: (
                      <span className="flex flex-col">
                        <span className="font-semibold">{j.input_type || '—'}</span>
                        {/* Older than the window — listed because it is the most
                            recent of its type, which is what restore depends on. */}
                        {j.anchor && <span className="text-[11px] font-bold text-warning-fg">latest of its type</span>}
                      </span>
                    ),
                    end: <span className="font-mono text-muted">{j.end_time || (j.status?.startsWith('RUNNING') ? 'running' : '—')}</span>,
                    status: <StateChip value={j.status} tones={JOB_STATUS_TONES} />,
                    start: <span className="font-mono text-muted">{j.start_time || '—'}</span>,
                    dur: <span className="font-mono">{duration(j.elapsed_seconds)}</span>,
                    input: <span className="font-mono">{gb(j.input_gb)}</span>,
                    output: <span className="font-mono">{gb(j.output_gb)}</span>,
                    rate: <span className="font-mono text-muted">{num(j.mb_per_sec) ? `${fmtNumber(j.mb_per_sec)} MB/s` : '—'}</span>,
                    compress: (
                      <span className="font-mono text-muted">
                        {num(j.compression_ratio) > 1 ? `${num(j.compression_ratio).toFixed(2)}×` : '—'}
                      </span>
                    ),
                    device: j.output_device_type
                      ? <Badge tone="neutral" size="xs">{j.output_device_type}</Badge> : null,
                  },
                }))}
                empty={has('jobs')
                  ? <EmptyState icon="clock" title="No RMAN jobs on record"
                      body="v$rman_backup_job_details is empty — either RMAN has never run against this instance, or its control file records were reset." />
                  : <EmptyState icon="alert" title="Job history could not be read"
                      body="v$rman_backup_job_details did not answer, so this table cannot say whether any backup has run. The error is listed at the top of the page." />}
              />
              {pager}
            </>
          )}
        </Paged>
      </TablePanel>

      {/* ── coverage and configuration, side by side ────────────────────── */}
      <div className="grid grid-cols-1 gap-gutter xl:grid-cols-2">
        <TablePanel
          title="Datafile backup coverage"
          icon="layers"
          subtitle="Oldest first — a file with no backup at all sorts to the top, because that is the one that breaks a restore"
        >
          <Paged rows={d.coverage || []} unit="datafiles" pageSize="10">
            {(page, pager) => (
              <>
                <Table2
                  rowHeight={64}
                  darkHeader
                  cellText
                  columns={[
                    { key: 'ts', label: 'Tablespace' },
                    { key: 'num', label: 'File #', align: 'right' },
                    { key: 'size', label: 'Size', align: 'right' },
                    { key: 'last', label: 'Last backup' },
                    { key: 'age', label: 'Age', align: 'right' },
                  ]}
                  rows={page.map((c) => ({
                    key: c.file_num,
                    cells: {
                      ts: (
                        <span className="block">
                          <span className="font-semibold">{c.tablespace_name}</span>
                          <span className="truncate-safe mt-0.5 block max-w-[260px] font-mono text-subtle">
                            {c.file_name}
                          </span>
                        </span>
                      ),
                      num: <IdCell value={c.file_num} />,
                      size: <span className="font-mono text-muted">{gb(c.size_gb)}</span>,
                      last: c.last_backup
                        ? <span className="font-mono text-muted">{c.last_backup}</span>
                        : <Badge tone="danger" size="xs">Never backed up</Badge>,
                      age: c.age_days == null
                        ? <span className="text-subtle">—</span>
                        : (
                          <span className={num(c.age_days) > 7 ? 'font-mono font-bold text-warning-fg' : 'font-mono'}>
                            {num(c.age_days).toFixed(1)} d
                          </span>
                        ),
                    },
                  }))}
                  empty={<EmptyState icon="layers" title="No datafile coverage data" />}
                />
                {pager}
              </>
            )}
          </Paged>
        </TablePanel>

        <div className="space-y-gutter">
          <Panel
            title="Fast Recovery Area"
            icon="hard-drive"
            subtitle={fra.name ? fra.name : 'v$recovery_file_dest'}
          >
            {!s.fra_configured ? (
              <p className="text-[12px] text-muted">
                No FRA is configured on this instance. Backups and archivelogs go wherever RMAN and
                <code className="mx-1 font-mono">log_archive_dest</code> were pointed, so there is no
                single number for headroom here — check those destinations directly.
              </p>
            ) : (
              <div className="space-y-3">
                <UsageBar
                  label="Space used"
                  pct={num(fra.pct_used)}
                  sub={`${gb(fra.used_gb)} of ${gb(fra.limit_gb)} · ${gb(fra.reclaimable_gb)} reclaimable · ${fmtNumber(fra.files)} files`}
                />
                {(d.fra_usage || []).length > 0 && (
                  <div className="space-y-2 border-t border-border pt-3">
                    {(d.fra_usage || []).map((u) => (
                      <UsageBar
                        key={u.file_type}
                        label={u.file_type}
                        pct={num(u.pct_used)}
                        sub={`${fmtNumber(u.files)} file(s) · ${num(u.pct_reclaimable).toFixed(1)}% reclaimable`}
                      />
                    ))}
                  </div>
                )}
                <p className="text-[11px] text-subtle">
                  Reclaimable space is only reclaimed when RMAN is allowed to delete. A high
                  reclaimable figure with a full FRA means the deletion job, not the size, is the
                  problem.
                </p>
              </div>
            )}
          </Panel>

          <Panel
            title="RMAN configuration"
            icon="settings"
            subtitle="v$rman_configuration — non-default settings only"
          >
            {(d.config || []).length === 0 ? (
              <p className="text-[12px] text-muted">
                Every CONFIGURE setting is at its default. Worth knowing: the default for
                <span className="mx-1 font-semibold">CONTROLFILE AUTOBACKUP</span> is OFF.
              </p>
            ) : (
              <div className="space-y-1">
                {(d.config || []).map((c) => (
                  <DefRow key={c.conf_num} label={c.name} value={c.value} mono />
                ))}
              </div>
            )}
          </Panel>

          <Panel
            title="Archivelogs awaiting backup"
            icon="clock"
            subtitle="On disk, not yet copied by any backup"
          >
            <div className="grid grid-cols-2 gap-gutter-sm">
              <MetricTile
                label="Not backed up"
                value={fmtNumber(archivelogs.count ?? 0)}
                sub={num(archivelogs.mb) ? fmtMB(Math.round(num(archivelogs.mb))) : 'nothing pending'}
                tone={num(archivelogs.count) ? 'warn' : 'good'}
              />
              <MetricTile
                label="Oldest pending"
                value={archivelogs.oldest || '—'}
                sub="first_time of the oldest unbacked log"
              />
            </div>
            <p className="mt-3 text-[11px] text-subtle">
              These exist only on the archive destination. If that storage is what fails, the
              recovery window ends at the last archivelog that was backed up — not at the last one
              written.
            </p>
          </Panel>
        </div>
      </div>

      <RmanJobDialog connId={connId} job={openJob} onClose={() => setOpenJob(null)} />
    </div>
  );
}

/**
 * What RMAN actually printed for one job.
 *
 * v$rman_output is memory-resident and bounded: it holds recent output only
 * and is empty after an instance restart. An old job with no log is therefore
 * normal, and the dialog says so rather than looking broken.
 */
function RmanJobDialog({ connId, job, onClose }) {
  const detail = useQuery({
    queryKey: ['oracleRmanJob', connId, job?.session_key],
    queryFn: async () => (
      await client.get(`/connections/oracle/${connId}/oracle-rman-job-detail`, {
        params: { session_key: job.session_key },
      })
    ).data,
    enabled: !!job?.session_key,
  });

  const d = detail.data || {};
  const output = d.output || [];
  const sets = d.sets || [];

  return (
    <Dialog
      open={!!job}
      onClose={onClose}
      title={job ? `${job.input_type} — ${job.status}` : ''}
      subtitle={job ? `Session key ${job.session_key} · started ${job.start_time}` : ''}
      icon="clock"
      tone={job && JOB_STATUS_TONES[job.status] === 'danger' ? 'danger' : 'accent'}
      width={860}
    >
      {!job ? null : detail.isLoading ? <InlineLoading label="Reading RMAN output…" /> : (
        <div className="space-y-gutter">
          <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4">
            <MetricTile label="Read" value={gb(job.input_gb)} />
            <MetricTile label="Written" value={gb(job.output_gb)} />
            <MetricTile label="Duration" value={duration(job.elapsed_seconds)} />
            <MetricTile label="Device" value={job.output_device_type || '—'} />
          </div>

          {(d.errors || []).length > 0 && (
            <Notice tone="warning" title="Some detail could not be read.">
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px]">
                {d.errors.map((e, i) => <li key={i} className="font-mono break-all">{e}</li>)}
              </ul>
            </Notice>
          )}

          {sets.length > 0 && (
            <div>
              <h4 className="mb-2 text-[11px] font-bold tracking-wide text-subtle uppercase">
                Backup sets ({sets.length})
              </h4>
              <Table2
                rowHeight={64}
                darkHeader
                cellText
                columns={[
                  { key: 'key', label: 'BS key' },
                  { key: 'type', label: 'Type' },
                  { key: 'pieces', label: 'Pieces', align: 'right' },
                  { key: 'in', label: 'Read', align: 'right' },
                  { key: 'out', label: 'Written', align: 'right' },
                  { key: 'done', label: 'Completed' },
                ]}
                rows={sets.map((b) => ({
                  key: b.bs_key,
                  cells: {
                    key: <IdCell value={b.bs_key} />,
                    type: (
                      <span className="flex flex-wrap items-center gap-1">
                        <Badge tone="neutral" size="xs">{b.backup_type}</Badge>
                        {b.compressed === 'YES' && <Badge tone="info" size="xs">compressed</Badge>}
                        {b.controlfile_included && b.controlfile_included !== 'NONE' && (
                          <Badge tone="accent" size="xs">controlfile</Badge>
                        )}
                      </span>
                    ),
                    pieces: <span className="font-mono">{fmtNumber(b.pieces)}</span>,
                    in: <span className="font-mono">{gb(b.input_gb)}</span>,
                    out: <span className="font-mono">{gb(b.output_gb)}</span>,
                    done: <span className="font-mono text-muted">{b.completion_time}</span>,
                  },
                }))}
              />
            </div>
          )}

          <div>
            <h4 className="mb-2 text-[11px] font-bold tracking-wide text-subtle uppercase">
              RMAN output
            </h4>
            {output.length === 0 ? (
              <Notice tone="info" title="No log retained for this job.">
                v$rman_output holds recent output only and is cleared when the instance restarts, so
                an older job having no log here is normal — it does not mean the job produced none.
              </Notice>
            ) : (
              <pre className="max-h-[320px] overflow-auto rounded-card border border-border bg-sunken px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg">
                {output.join('\n')}
              </pre>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
