import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import cn from '@/lib/cn';
import client, { errorText } from '@/api/client';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import Input from '@/components/ui/Input';
import Table, { EmptyState } from '@/components/ui/Table';
import { Paged } from '@/components/ui/Pagination';
import Toasts, { useToasts } from '@/components/ui/Toast';
import { SqlBlock, TablePanel } from '@/pages/_shared/enginePanels';
import { fmtNumber } from '@/config/dbCatalog';
import { ACTION_LABELS, JOB_STATUS_TONES, fmtIST } from '@/pages/oracle/storageHealthConstants';

/**
 * Maintenance Window — every Oracle Storage Health maintenance job, in one
 * place, instead of having to open Storage Health to find out what's
 * pending or scheduled. Approve/Reject stay here for quick triage;
 * Start/Schedule and the live run itself live on the job's own page,
 * reached by clicking a row.
 *
 * Used two ways: standalone (Alerts -> Maintenance Window), listing every
 * connection with a Connection column — and embedded on one Oracle
 * Dashboard (pass `connId`), scoped to that connection only, no Connection
 * column since it would just repeat the page you're already on.
 */

const STATUS_TABS = [
  { id: 'all', label: 'All' },
  { id: 'planned', label: 'Planned' },
  { id: 'running', label: 'Running' },
  { id: 'completed', label: 'Completed' },
  { id: 'history', label: 'History' },
];

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'rejected']);

const isRunning = (j) => j.status === 'running' || (j.status === 'approved' && !!j.start_requested_at);
// "Planned" = approved/requested but not yet actually running — pending
// approval, or approved and either not started at all, or scheduled for a
// future time that hasn't arrived yet.
const isPlanned = (j) => j.status === 'pending_approval' || (j.status === 'approved' && !isRunning(j));

export default function MaintenanceWindow({ connId }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toasts, push, dismiss } = useToasts();
  const [tab, setTab] = useState('all');
  const [search, setSearch] = useState('');
  const [approveTarget, setApproveTarget] = useState(null);
  const [rejectTarget, setRejectTarget] = useState(null);
  const [rejectReason, setRejectReason] = useState('');

  const jobsQ = useQuery({
    queryKey: connId ? ['oracleMaintenanceJobs', connId] : ['oracleMaintenanceJobsAll'],
    queryFn: () => client.get(
      connId ? `/connections/oracle/${connId}/oracle-storage-maintenance/jobs` : '/oracle-maintenance/jobs',
    ).then((r) => r.data),
    retry: false,
    refetchInterval: 15000,
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['oracleMaintenanceJobsAll'] });
    qc.invalidateQueries({ queryKey: ['oracleMaintenanceJobs'] });
  };

  const approveMut = useMutation({
    mutationFn: (jobId) => client.post(`/oracle-maintenance/jobs/${jobId}/approve`).then((r) => r.data),
    onSuccess: () => { push('Approved.', 'success'); setApproveTarget(null); invalidateAll(); },
    onError: (e) => { push(errorText(e), 'error'); setApproveTarget(null); },
  });

  const rejectMut = useMutation({
    mutationFn: ({ jobId, reason }) => client.post(`/oracle-maintenance/jobs/${jobId}/reject`, { reason }).then((r) => r.data),
    onSuccess: () => { push('Rejected.', 'success'); setRejectTarget(null); setRejectReason(''); invalidateAll(); },
    onError: (e) => { push(errorText(e), 'error'); setRejectTarget(null); },
  });

  const jobs = useMemo(() => jobsQ.data?.jobs || [], [jobsQ.data]);

  const counts = useMemo(() => ({
    all: jobs.length,
    planned: jobs.filter(isPlanned).length,
    running: jobs.filter(isRunning).length,
    completed: jobs.filter((j) => j.status === 'succeeded').length,
    history: jobs.filter((j) => TERMINAL_STATUSES.has(j.status)).length,
  }), [jobs]);

  const shown = useMemo(() => {
    let rows = jobs;
    if (tab === 'planned') rows = rows.filter(isPlanned);
    else if (tab === 'running') rows = rows.filter(isRunning);
    else if (tab === 'completed') rows = rows.filter((j) => j.status === 'succeeded');
    else if (tab === 'history') rows = rows.filter((j) => TERMINAL_STATUSES.has(j.status));

    const term = search.trim().toLowerCase();
    if (term) {
      rows = rows.filter((j) =>
        [j.object_name, j.connection_name, j.connection_host, j.recommended_action]
          .some((v) => String(v || '').toLowerCase().includes(term)));
    }
    return rows;
  }, [jobs, tab, search]);

  const openJob = (j) => navigate(`/oracle-dashboard/${j.conn_id}/storage-health/job`, { state: { job: j } });

  return (
    <>
      <Toasts toasts={toasts} onDismiss={dismiss} />

      <TablePanel
        title="Oracle Storage Maintenance"
        icon="clipboard"
        subtitle={connId
          ? 'Every requested Shrink/Move/Rebuild job for this connection — click a row for its full detail'
          : 'Every requested Shrink/Move/Rebuild job across every connection — click a row for its full detail'}
        actions={(
          <>
            <span className="flex items-center gap-0.5 rounded-control border border-border p-0.5">
              {STATUS_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  aria-pressed={tab === t.id}
                  className={cn(
                    'flex h-7 items-center gap-1.5 rounded-control px-2.5 text-[11px] font-bold transition-colors',
                    tab === t.id ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-sunken hover:text-fg',
                  )}
                >
                  {t.label}
                  <span className="tabular-nums opacity-70">{counts[t.id]}</span>
                </button>
              ))}
            </span>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onClear={() => setSearch('')}
              placeholder="Object…"
              icon="search"
              size="sm"
              wrapperClassName="w-44"
            />
          </>
        )}
      >
        {(jobsQ.data?.errors || []).length > 0 && (
          <div className="border-b border-border px-card py-2 text-[11px] text-warning-fg">
            {jobsQ.data.errors.join(' · ')}
          </div>
        )}
        <Paged rows={shown} unit="jobs">
          {(page, pager) => (
            <>
              <Table
                columns={[
                  ...(connId ? [] : [{ key: 'connection', label: 'Connection' }]),
                  { key: 'object', label: 'Object' },
                  { key: 'action', label: 'Action' },
                  { key: 'status', label: 'Status' },
                  { key: 'when', label: 'Scheduled / Requested' },
                  { key: 'result', label: 'Result' },
                  { key: 'ops', label: '' },
                ]}
                rows={page.map((j) => ({
                  key: j.id,
                  onClick: () => openJob(j),
                  cells: {
                    ...(connId ? {} : {
                      connection: (
                        <span className="block">
                          <span className="text-[12px] font-semibold text-fg">{j.connection_name}</span>
                          <span className="mt-0.5 block text-[10px] text-subtle">{j.connection_host}</span>
                        </span>
                      ),
                    }),
                    object: (
                      <span className="block">
                        <span className="font-mono text-[12px] font-semibold text-accent-text">{j.object_name}</span>
                        <span className="mt-0.5 block text-[10px] text-subtle capitalize">{j.object_type}</span>
                      </span>
                    ),
                    action: <span className="text-[12px]">{ACTION_LABELS[j.recommended_action] || j.recommended_action}</span>,
                    status: (
                      <span className="flex items-center gap-1.5">
                        <Badge tone={JOB_STATUS_TONES[j.status] || 'neutral'} size="xs">{String(j.status).replace('_', ' ')}</Badge>
                        {j.status === 'approved' && j.scheduled_at && !j.start_requested_at && (
                          <Badge tone="info" size="xs">scheduled</Badge>
                        )}
                      </span>
                    ),
                    when: (
                      <span className="text-[11px] text-muted">
                        {j.status === 'approved' && j.scheduled_at && !j.start_requested_at
                          ? fmtIST(j.scheduled_at)
                          : fmtIST(j.requested_at)}
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
                    title={jobsQ.isLoading ? 'Loading…' : jobs.length ? 'No matches' : 'Nothing here yet'}
                    body={jobsQ.isLoading ? undefined : jobs.length ? 'No job matches the current filter.' : 'Maintenance jobs requested from a Storage Health finding will show up here.'}
                  />
                )}
              />
              {pager}
            </>
          )}
        </Paged>
      </TablePanel>

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
              <span className="font-semibold text-fg">{approveTarget.object_name}</span>
              {approveTarget.connection_name && <> on <span className="font-semibold text-fg">{approveTarget.connection_name}</span></>} —
              it will NOT run automatically. Open the job afterward to start or schedule it.
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
