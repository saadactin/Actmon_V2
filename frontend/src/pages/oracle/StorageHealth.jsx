import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import cn from '@/lib/cn';
import client, { errorText } from '@/api/client';
import PageHeader from '@/components/layout/PageHeader';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Table, { EmptyState } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';
import { Paged } from '@/components/ui/Pagination';
import Toasts, { useToasts } from '@/components/ui/Toast';
import { MetricTile, SqlBlock, TablePanel } from '@/pages/_shared/enginePanels';
import { fmtNumber } from '@/config/dbCatalog';
import { STATUS_TONES, ACTION_LABELS, JOB_STATUS_TONES, fmtIST } from './storageHealthConstants';

/**
 * Oracle Storage Health — read-only findings from the Phase 2 decision engine,
 * plus the Phase 3 approval workflow for the handful of recommendations that
 * map to a safe, single-statement fix (SHRINK SPACE / MOVE / REBUILD).
 *
 * Nothing here ever runs automatically: "Request Maintenance" only creates a
 * pending audit row, and the actual DDL only runs after an explicit Approve,
 * which is why Approve is the one action behind a confirm dialog that shows
 * the exact SQL — Request is reversible (a no-op until approved), Approve is not.
 */

const OBJECT_TABS = [
  { id: 'all', label: 'All' },
  { id: 'tablespace', label: 'Tablespaces' },
  { id: 'datafile', label: 'Datafiles' },
  { id: 'segment', label: 'Segments' },
  { id: 'index', label: 'Indexes' },
  { id: 'partition', label: 'Partitions' },
];

const JOB_TABS = [
  { id: 'pending', label: 'Pending Approval' },
  { id: 'history', label: 'History' },
];

export default function OracleStorageHealth() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toasts, push, dismiss } = useToasts();

  const [objectTab, setObjectTab] = useState('all');
  const [jobTab, setJobTab] = useState('pending');
  const [approveTarget, setApproveTarget] = useState(null);
  const [rejectTarget, setRejectTarget] = useState(null);
  const [rejectReason, setRejectReason] = useState('');

  const openDetail = (target) => navigate(`/oracle-dashboard/${id}/storage-health/object`, { state: { target } });

  const findingsQ = useQuery({
    queryKey: ['oracleStorageFindings', id],
    queryFn: () => client.get(`/connections/oracle/${id}/oracle-storage-findings`).then((r) => r.data),
    retry: false,
    refetchInterval: 60000,
  });

  const jobsQ = useQuery({
    queryKey: ['oracleMaintenanceJobs', id],
    queryFn: () => client.get(`/connections/oracle/${id}/oracle-storage-maintenance/jobs`).then((r) => r.data),
    retry: false,
    refetchInterval: 20000,
  });

  // Live, unfiltered inventories — every datafile/segment/index/partition,
  // not just the ones a finding flagged. Only the tab actually being viewed
  // fetches, so switching to "Partitions" doesn't pull the datafile list too.
  const datafilesQ = useQuery({
    queryKey: ['oracleStorageDatafilesLive', id],
    queryFn: () => client.get(`/connections/oracle/${id}/oracle-datafile-mounts`).then((r) => r.data),
    retry: false,
    refetchInterval: 60000,
    enabled: objectTab === 'all' || objectTab === 'datafile',
  });

  const segmentsQ = useQuery({
    queryKey: ['oracleStorageSegmentsLive', id],
    queryFn: () => client.get(`/connections/oracle/${id}/oracle-storage-segments`).then((r) => r.data),
    retry: false,
    refetchInterval: 60000,
    enabled: objectTab === 'segment',
  });

  const indexesQ = useQuery({
    queryKey: ['oracleIndexInventoryLive', id],
    queryFn: () => client.get(`/connections/oracle/${id}/oracle-index-analysis`).then((r) => r.data),
    retry: false,
    refetchInterval: 60000,
    enabled: objectTab === 'index',
  });

  const partitionsQ = useQuery({
    queryKey: ['oracleStoragePartitionsLive', id],
    queryFn: () => client.get(`/connections/oracle/${id}/oracle-storage-partitions`).then((r) => r.data),
    retry: false,
    refetchInterval: 60000,
    enabled: objectTab === 'partition',
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['oracleStorageFindings', id] });
    qc.invalidateQueries({ queryKey: ['oracleMaintenanceJobs', id] });
  };

  const approveMut = useMutation({
    mutationFn: (jobId) => client.post(`/oracle-maintenance/jobs/${jobId}/approve`).then((r) => r.data),
    onSuccess: () => { push('Approved — queued for execution.', 'success'); setApproveTarget(null); invalidateAll(); },
    onError: (e) => { push(errorText(e), 'error'); setApproveTarget(null); },
  });

  const rejectMut = useMutation({
    mutationFn: ({ jobId, reason }) => client.post(`/oracle-maintenance/jobs/${jobId}/reject`, { reason }).then((r) => r.data),
    onSuccess: () => { push('Rejected.', 'success'); setRejectTarget(null); setRejectReason(''); invalidateAll(); },
    onError: (e) => { push(errorText(e), 'error'); setRejectTarget(null); },
  });

  const findings = useMemo(() => findingsQ.data?.findings || [], [findingsQ.data]);
  const summary = findingsQ.data?.summary || {};
  const coverage = findingsQ.data?.coverage || {};
  const partialErrors = (findingsQ.data?.errors || []).filter(Boolean);

  const jobs = useMemo(() => jobsQ.data?.jobs || [], [jobsQ.data]);

  const counts = useMemo(() => {
    const c = { all: findings.length };
    OBJECT_TABS.forEach((t) => { if (t.id !== 'all') c[t.id] = findings.filter((f) => f.object_type === t.id).length; });
    return c;
  }, [findings]);

  const shownFindings = objectTab === 'all' ? findings : findings.filter((f) => f.object_type === objectTab);

  const pendingJobs = useMemo(() => jobs.filter((j) => j.status === 'pending_approval'), [jobs]);
  const historyJobs = useMemo(() => jobs.filter((j) => j.status !== 'pending_approval'), [jobs]);
  const shownJobs = jobTab === 'pending' ? pendingJobs : historyJobs;

  const header = (
    <PageHeader
      title="Oracle Storage Health"
      description="Tablespace, segment, index and partition space — evidence-based findings, never auto-executed"
      icon="database"
      backTo={`/oracle-dashboard/${id}`}
      actions={(
        <Button
          variant="secondary"
          icon="refresh"
          loading={findingsQ.isFetching || jobsQ.isFetching}
          onClick={() => { findingsQ.refetch(); jobsQ.refetch(); }}
        >
          Refresh
        </Button>
      )}
    />
  );

  if (findingsQ.isLoading) return <>{header}<PageLoading title="Evaluating storage health…" steps={[
    'Checking tablespace usage and growth trend…',
    'Scanning segments for reclaimable space…',
    'Analyzing index fragmentation…',
    'Checking datafiles and mount status…',
    'Reviewing partition ages…',
  ]} /></>;

  if (findingsQ.error || findingsQ.data?.status === 'error') {
    return (
      <>
        {header}
        <Notice tone="danger" title="Could not evaluate storage health.">
          {findingsQ.data?.error || findingsQ.error?.message}
        </Notice>
        <Button variant="primary" icon="refresh" onClick={() => findingsQ.refetch()}>Retry</Button>
      </>
    );
  }

  return (
    <>
      {header}
      <Toasts toasts={toasts} onDismiss={dismiss} />

      {partialErrors.length > 0 && (
        <Notice tone="warning" title="Some checks could not run.">{partialErrors.join(' · ')}</Notice>
      )}

      <div className="space-y-gutter">
        <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4">
          <MetricTile label="Healthy" value={fmtNumber(summary.healthy)} icon="check" tone="good" />
          <MetricTile label="Monitor" value={fmtNumber(summary.monitor)} icon="info" tone="neutral" />
          <MetricTile label="Warning" value={fmtNumber(summary.warning)} icon="alert" tone={summary.warning ? 'warn' : 'neutral'} />
          <MetricTile label="Critical" value={fmtNumber(summary.critical)} icon="alert" tone={summary.critical ? 'bad' : 'neutral'} />
        </div>
        <p className="text-[11px] text-subtle">
          {fmtNumber(coverage.tablespaces_evaluated)} tablespaces · {fmtNumber(coverage.segments_evaluated)} segments
          {' '}· {fmtNumber(coverage.indexes_evaluated)} indexes · {fmtNumber(coverage.partitions_evaluated)} partitions evaluated
        </p>

        <TablePanel
          title="Findings"
          icon="database"
          subtitle="Select a row for evidence, expected benefit and risk"
          actions={(
            <span className="flex items-center gap-0.5 rounded-control border border-border p-0.5">
              {OBJECT_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setObjectTab(t.id)}
                  aria-pressed={objectTab === t.id}
                  className={cn(
                    'flex h-7 items-center gap-1.5 rounded-control px-2.5 text-[11px] font-bold transition-colors',
                    objectTab === t.id ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-sunken hover:text-fg',
                  )}
                >
                  {t.label}
                  <span className="tabular-nums opacity-70">{counts[t.id]}</span>
                </button>
              ))}
            </span>
          )}
        >
          <Paged rows={shownFindings} unit="findings">
            {(page, pager) => (
              <>
                <Table
                  columns={[
                    { key: 'object', label: 'Object' },
                    { key: 'status', label: 'Status' },
                    { key: 'problem', label: 'Problem' },
                    { key: 'action', label: 'Recommended Action' },
                  ]}
                  rows={page.map((f, i) => {
                    const key = `${f.object_type}-${f.object_name}-${i}`;
                    return {
                      key,
                      onClick: () => openDetail({ ...targetForFinding(f), finding: f }),
                      cells: {
                        object: (
                          <span className="block">
                            <span className="font-mono text-[12px] font-semibold text-accent-text">{f.object_name}</span>
                            <span className="mt-0.5 block text-[10px] text-subtle capitalize">
                              {f.object_type}{f.tablespace_name ? ` · ${f.tablespace_name}` : ''}
                            </span>
                          </span>
                        ),
                        status: <Badge tone={STATUS_TONES[f.status] || 'neutral'} size="xs">{f.status}</Badge>,
                        problem: <span className="text-[12px] text-fg">{f.problem}</span>,
                        action: <span className="text-[12px] text-muted">{ACTION_LABELS[f.recommended_action] || f.recommended_action}</span>,
                      },
                    };
                  })}
                  empty={(
                    <EmptyState
                      icon="check"
                      title={findings.length ? 'No matches' : 'Everything healthy'}
                      body={findings.length ? undefined : 'No tablespace, segment, index or partition currently needs attention.'}
                    />
                  )}
                />
                {pager}
              </>
            )}
          </Paged>
        </TablePanel>

        {/* The live inventory below always matches whichever Findings tab is
            active — "Partitions" shows every partition, not the datafile
            list left over from "All". "All" defaults to Datafiles since
            that's the smallest, cheapest-to-scan inventory. */}
        {(objectTab === 'all' || objectTab === 'datafile') && (
          <TablePanel
            title="All Datafiles"
            icon="desktop"
            subtitle="Every datafile, live — not filtered to only the ones a finding flagged. Click a row for real block-level detail."
          >
            {datafilesQ.data?.errors?.length > 0 && (
              <Notice tone="warning" title="Some datafile checks could not run." className="mb-0 rounded-none border-x-0 border-t-0">
                {datafilesQ.data.errors.join(' · ')}
              </Notice>
            )}
            <Paged rows={datafilesQ.data?.datafiles || []} unit="datafiles">
              {(page, pager) => (
                <>
                  <Table
                    columns={[
                      { key: 'tablespace', label: 'Tablespace' },
                      { key: 'file', label: 'File' },
                      { key: 'size', label: 'Size', align: 'right' },
                      { key: 'autoextend', label: 'Autoextend' },
                      { key: 'max', label: 'Max Size', align: 'right' },
                      { key: 'status', label: 'Status' },
                    ]}
                    rows={page.map((d, i) => ({
                      key: `${d.file_id}-${i}`,
                      onClick: () => openDetail({ object_type: 'datafile', file_id: d.file_id, label: d.file_name }),
                      cells: {
                        tablespace: <span className="font-mono text-[12px] font-semibold text-accent-text">{d.tablespace}</span>,
                        file: <span className="text-[11px] text-muted" title={d.file_name}>{d.file_name}</span>,
                        size: <span className="font-mono text-[12px]">{fmtNumber(d.size_gb)} GB</span>,
                        autoextend: (
                          <Badge tone={d.autoextend === 'YES' ? 'success' : 'neutral'} size="xs">
                            {d.autoextend === 'YES' ? 'On' : 'Off'}
                          </Badge>
                        ),
                        max: <span className="font-mono text-[12px] text-muted">{d.max_gb ? `${fmtNumber(d.max_gb)} GB` : '—'}</span>,
                        status: <Badge tone={d.status === 'AVAILABLE' ? 'success' : 'warning'} size="xs">{d.status}</Badge>,
                      },
                    }))}
                    empty={(
                      <EmptyState
                        icon="desktop"
                        title={datafilesQ.isLoading ? 'Loading…' : 'No datafile data'}
                        body={datafilesQ.isLoading ? undefined : 'dba_data_files returned nothing — the login may lack SELECT on the DBA views.'}
                      />
                    )}
                  />
                  {pager}
                </>
              )}
            </Paged>
          </TablePanel>
        )}

        {objectTab === 'segment' && (
          <TablePanel
            title="All Segments"
            icon="table"
            subtitle="Largest 100 tables/indexes/LOBs/clusters, live. Click a row for real block-level detail."
          >
            {(segmentsQ.data?.errors || []).length > 0 && (
              <Notice tone="warning" title="Some segment checks could not run." className="mb-0 rounded-none border-x-0 border-t-0">
                {segmentsQ.data.errors.join(' · ')}
              </Notice>
            )}
            <Paged rows={segmentsQ.data?.segments || []} unit="segments">
              {(page, pager) => (
                <>
                  <Table
                    columns={[
                      { key: 'name', label: 'Segment' },
                      { key: 'type', label: 'Type' },
                      { key: 'tablespace', label: 'Tablespace' },
                      { key: 'size', label: 'Size', align: 'right' },
                      { key: 'rows', label: 'Rows', align: 'right' },
                    ]}
                    rows={page.map((s, i) => ({
                      key: `${s.owner}.${s.segment_name}-${i}`,
                      onClick: () => openDetail({ object_type: 'segment', owner: s.owner, segment_name: s.segment_name, label: `${s.owner}.${s.segment_name}` }),
                      cells: {
                        name: <span className="font-mono text-[12px] font-semibold text-accent-text">{s.owner}.{s.segment_name}</span>,
                        type: <span className="text-[11px] text-muted capitalize">{s.segment_type?.toLowerCase()}</span>,
                        tablespace: <span className="text-[12px]">{s.tablespace_name}</span>,
                        size: <span className="font-mono text-[12px]">{fmtNumber(s.size_mb)} MB</span>,
                        rows: <span className="font-mono text-[12px] text-muted">{s.num_rows != null ? fmtNumber(s.num_rows) : '—'}</span>,
                      },
                    }))}
                    empty={(
                      <EmptyState
                        icon="table"
                        title={segmentsQ.isLoading ? 'Loading…' : 'No segment data'}
                        body={segmentsQ.isLoading ? undefined : 'dba_segments returned nothing — the login may lack SELECT on the DBA views.'}
                      />
                    )}
                  />
                  {pager}
                </>
              )}
            </Paged>
          </TablePanel>
        )}

        {objectTab === 'index' && (
          <TablePanel
            title="All Indexes"
            icon="layers"
            subtitle="Every index, live — full detail lives on the dedicated Index Analysis page."
          >
            {(indexesQ.data?.errors || []).length > 0 && (
              <Notice tone="warning" title="Some index checks could not run." className="mb-0 rounded-none border-x-0 border-t-0">
                {indexesQ.data.errors.join(' · ')}
              </Notice>
            )}
            <Paged rows={indexesQ.data?.indexes || []} unit="indexes">
              {(page, pager) => (
                <>
                  <Table
                    columns={[
                      { key: 'name', label: 'Index' },
                      { key: 'table', label: 'Table' },
                      { key: 'type', label: 'Type' },
                      { key: 'status', label: 'Status' },
                      { key: 'leaf', label: 'Leaf Blocks', align: 'right' },
                    ]}
                    rows={page.map((x, i) => ({
                      key: `${x.owner}.${x.index_name}-${i}`,
                      onClick: () => openDetail({ object_type: 'index', label: `${x.owner}.${x.index_name}`, raw: x }),
                      cells: {
                        name: <span className="font-mono text-[12px] font-semibold text-accent-text">{x.owner}.{x.index_name}</span>,
                        table: <span className="text-[12px] text-muted">{x.table_name}</span>,
                        type: <span className="text-[11px] text-muted">{x.index_type}{x.uniqueness === 'UNIQUE' ? ' · unique' : ''}</span>,
                        status: <Badge tone={x.status === 'VALID' ? 'success' : 'warning'} size="xs">{x.status}</Badge>,
                        leaf: <span className="font-mono text-[12px]">{fmtNumber(x.leaf_blocks)}</span>,
                      },
                    }))}
                    empty={(
                      <EmptyState
                        icon="layers"
                        title={indexesQ.isLoading ? 'Loading…' : 'No index data'}
                        body={indexesQ.isLoading ? undefined : 'dba_indexes returned nothing — the login may lack SELECT on the DBA views.'}
                      />
                    )}
                  />
                  {pager}
                </>
              )}
            </Paged>
          </TablePanel>
        )}

        {objectTab === 'partition' && (
          <TablePanel
            title="All Partitions"
            icon="layers"
            subtitle="Largest 100 partitions, live."
          >
            {(partitionsQ.data?.errors || []).length > 0 && (
              <Notice tone="warning" title="Some partition checks could not run." className="mb-0 rounded-none border-x-0 border-t-0">
                {partitionsQ.data.errors.join(' · ')}
              </Notice>
            )}
            <Paged rows={partitionsQ.data?.partitions || []} unit="partitions">
              {(page, pager) => (
                <>
                  <Table
                    columns={[
                      { key: 'name', label: 'Partition' },
                      { key: 'table', label: 'Table' },
                      { key: 'size', label: 'Size', align: 'right' },
                      { key: 'rows', label: 'Rows', align: 'right' },
                      { key: 'analyzed', label: 'Last Analyzed' },
                    ]}
                    rows={page.map((p, i) => ({
                      key: `${p.owner}.${p.table_name}.${p.partition_name}-${i}`,
                      onClick: () => openDetail({ object_type: 'partition', label: `${p.owner}.${p.table_name}.${p.partition_name}`, raw: p }),
                      cells: {
                        name: <span className="font-mono text-[12px] font-semibold text-accent-text">{p.partition_name}</span>,
                        table: <span className="text-[12px] text-muted">{p.owner}.{p.table_name}</span>,
                        size: <span className="font-mono text-[12px]">{p.size_mb != null ? `${fmtNumber(p.size_mb)} MB` : '—'}</span>,
                        rows: <span className="font-mono text-[12px] text-muted">{p.num_rows != null ? fmtNumber(p.num_rows) : '—'}</span>,
                        analyzed: <span className="text-[11px] text-muted">{p.last_analyzed || '—'}</span>,
                      },
                    }))}
                    empty={(
                      <EmptyState
                        icon="layers"
                        title={partitionsQ.isLoading ? 'Loading…' : 'No partition data'}
                        body={partitionsQ.isLoading ? undefined : 'This schema has no partitioned tables.'}
                      />
                    )}
                  />
                  {pager}
                </>
              )}
            </Paged>
          </TablePanel>
        )}

        <TablePanel
          title="Maintenance Jobs"
          icon="clipboard"
          subtitle="Every requested action, with the exact SQL that ran and its result"
          actions={(
            <span className="flex items-center gap-0.5 rounded-control border border-border p-0.5">
              {JOB_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setJobTab(t.id)}
                  aria-pressed={jobTab === t.id}
                  className={cn(
                    'flex h-7 items-center gap-1.5 rounded-control px-2.5 text-[11px] font-bold transition-colors',
                    jobTab === t.id ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-sunken hover:text-fg',
                  )}
                >
                  {t.label}
                  <span className="tabular-nums opacity-70">{t.id === 'pending' ? pendingJobs.length : historyJobs.length}</span>
                </button>
              ))}
            </span>
          )}
        >
          <Paged rows={shownJobs} unit="jobs">
            {(page, pager) => (
              <>
                <Table
                  columns={[
                    { key: 'object', label: 'Object' },
                    { key: 'action', label: 'Action' },
                    { key: 'status', label: 'Status' },
                    { key: 'requested', label: 'Requested' },
                    { key: 'result', label: 'Result' },
                    { key: 'ops', label: '' },
                  ]}
                  rows={page.map((j) => ({
                    key: j.id,
                    onClick: () => navigate(`/oracle-dashboard/${id}/storage-health/job`, { state: { job: j } }),
                    cells: {
                      object: (
                        <span className="block">
                          <span className="font-mono text-[12px] font-semibold text-fg">{j.object_name}</span>
                          <span className="mt-0.5 block text-[10px] text-subtle capitalize">{j.object_type}</span>
                        </span>
                      ),
                      action: <span className="text-[12px]">{ACTION_LABELS[j.recommended_action] || j.recommended_action}</span>,
                      status: <Badge tone={JOB_STATUS_TONES[j.status] || 'neutral'} size="xs">{String(j.status).replace('_', ' ')}</Badge>,
                      requested: (
                        <span className="text-[11px] text-muted">
                          {fmtIST(j.requested_at)}
                        </span>
                      ),
                      result: j.status === 'succeeded'
                        ? <span className="text-[12px] text-success-fg">Reclaimed {fmtNumber(j.reclaimed_mb)} MB</span>
                        : j.status === 'failed'
                          ? <span className="text-[11px] text-danger-fg" title={j.error_details}>{(j.error_details || '').slice(0, 60)}</span>
                          : j.status === 'rejected'
                            ? <span className="text-[11px] text-muted" title={j.rejection_reason}>{j.rejection_reason || '—'}</span>
                            : <span className="text-subtle">—</span>,
                      ops: j.status === 'pending_approval' ? (
                        <span className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                          <Button size="sm" variant="primary" onClick={() => setApproveTarget(j)}>Approve</Button>
                          <Button size="sm" variant="secondary" onClick={() => setRejectTarget(j)}>Reject</Button>
                        </span>
                      ) : null,
                    },
                  }))}
                  empty={(
                    <EmptyState
                      icon="check"
                      title={jobTab === 'pending' ? 'Nothing pending' : 'No history yet'}
                      body={jobTab === 'pending' ? 'No maintenance action is awaiting approval.' : 'Approved and rejected jobs will appear here.'}
                    />
                  )}
                />
                {pager}
              </>
            )}
          </Paged>
        </TablePanel>
      </div>

      <ConfirmDialog
        open={!!approveTarget}
        title="Approve maintenance action?"
        tone="warning"
        icon="alert"
        confirmLabel="Approve"
        cancelLabel="Cancel"
        loading={approveMut.isPending}
        onCancel={() => setApproveTarget(null)}
        onConfirm={() => approveTarget && approveMut.mutate(approveTarget.id)}
      >
        {approveTarget && (
          <div className="space-y-2">
            <p className="text-[13px] text-muted">
              This authorizes the following statement against{' '}
              <span className="font-semibold text-fg">{approveTarget.object_name}</span> — it will NOT run
              automatically. Open the job afterward and click Start Execution when you're ready:
            </p>
            <SqlBlock sql={approveTarget.proposed_sql} />
            <p className="text-[11px] text-muted"><span className="font-semibold">Risk:</span> {approveTarget.risk || '—'}</p>
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={!!rejectTarget}
        title="Reject this maintenance request?"
        tone="danger"
        confirmLabel="Reject"
        cancelLabel="Cancel"
        loading={rejectMut.isPending}
        onCancel={() => { setRejectTarget(null); setRejectReason(''); }}
        onConfirm={() => rejectTarget && rejectMut.mutate({ jobId: rejectTarget.id, reason: rejectReason || undefined })}
      >
        {rejectTarget && (
          <div className="space-y-2">
            <p className="text-[13px] text-muted">
              <span className="font-semibold text-fg">{rejectTarget.object_name}</span> will not be touched.
            </p>
            <Input
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Reason (optional)"
              size="sm"
            />
          </div>
        )}
      </ConfirmDialog>
    </>
  );
}

/** Maps one finding to the params the detail page needs to fetch its real
 * block-level data — object_name means something different per type
 * (tablespace name, full datafile path, or "OWNER.SEGMENT_NAME"). Index and
 * partition findings have no block-detail endpoint yet, so they resolve to
 * just enough to label the page — it shows the finding info only. */
function targetForFinding(f) {
  if (f.object_type === 'tablespace') {
    return { object_type: 'tablespace', tablespace_name: f.object_name, label: f.object_name };
  }
  if (f.object_type === 'datafile') {
    return { object_type: 'datafile', file_name: f.object_name, label: f.object_name };
  }
  if (f.object_type === 'segment') {
    const [owner, ...rest] = f.object_name.split('.');
    return { object_type: 'segment', owner, segment_name: rest.join('.'), label: f.object_name };
  }
  return { object_type: f.object_type, label: f.object_name };
}
