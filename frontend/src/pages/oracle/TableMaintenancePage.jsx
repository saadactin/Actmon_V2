import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import client from '@/api/client';
import Badge from '@/components/ui/Badge';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Table, { EmptyState } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';
import { Paged } from '@/components/ui/Pagination';
import { fmtNumber } from '@/config/dbCatalog';
import {
  ActionsMenu, CategorySummaryBar, OperationConfirmDialog, RefreshBar, useDirectMaintenance,
} from './maintenanceShared';
import { ACTION_LABELS, fmtIST } from './storageHealthConstants';

const REFRESH_SECONDS = 30;

function eligibility(t) {
  return [
    {
      action: 'shrink_space', label: ACTION_LABELS.shrink_space,
      disabled: !t.row_movement_enabled,
      reason: !t.row_movement_enabled ? 'Row movement is disabled — enable it first' : undefined,
    },
    { action: 'move', label: ACTION_LABELS.move, disabled: false },
    {
      action: 'enable_row_movement', label: ACTION_LABELS.enable_row_movement,
      disabled: t.row_movement_enabled, reason: t.row_movement_enabled ? 'Already enabled' : undefined,
    },
    {
      action: 'disable_row_movement', label: ACTION_LABELS.disable_row_movement,
      disabled: !t.row_movement_enabled, reason: !t.row_movement_enabled ? 'Already disabled' : undefined,
    },
    { action: 'truncate_table', label: ACTION_LABELS.truncate_table, disabled: false },
  ];
}

export default function TableMaintenancePage({ connId }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all'); // all | needing | reclaimable
  const [confirmState, setConfirmState] = useState(null); // { action, row }

  const q = useQuery({
    queryKey: ['oracleTableMaintenance', connId],
    queryFn: () => client.get(`/connections/oracle/${connId}/oracle-maintenance/table-telemetry`).then((r) => r.data),
    retry: false,
    refetchInterval: REFRESH_SECONDS * 1000,
  });

  const [countdown, setCountdown] = useState(REFRESH_SECONDS);
  useEffect(() => {
    const t = setInterval(() => setCountdown((c) => (c <= 1 ? REFRESH_SECONDS : c - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  const directMut = useDirectMaintenance(connId, navigate, 'table');

  const tables = q.data?.tables || [];
  const shown = useMemo(() => {
    let rows = tables;
    if (filter === 'needing') rows = rows.filter((t) => t.recommendation);
    else if (filter === 'reclaimable') rows = rows.filter((t) => (t.reclaimable_mb || 0) > 0);
    const term = search.trim().toLowerCase();
    if (term) rows = rows.filter((t) => t.object_name.toLowerCase().includes(term));
    return rows;
  }, [tables, filter, search]);

  if (q.isLoading) return <PageLoading title="Reading table telemetry from dba_segments/dba_tables…" illustration />;
  if (q.error || q.data?.status === 'error') {
    return <Notice tone="danger" title="Could not load table telemetry.">{q.data?.error || q.error?.message}</Notice>;
  }

  const s = q.data.summary;
  const openConfirm = (action, row) => setConfirmState({ action, row });
  const runConfirmed = () => {
    if (!confirmState) return;
    const { action, row } = confirmState;
    directMut.mutate({ objectType: 'table', objectName: row.object_name, action, params: { confirm_destructive: true } });
  };

  return (
    <div className="space-y-gutter">
      <RefreshBar seconds={countdown} isFetching={q.isFetching} onRefresh={() => { q.refetch(); setCountdown(REFRESH_SECONDS); }} lastUpdatedAt={new Date().toISOString()} />

      {(q.data.errors || []).length > 0 && (
        <Notice tone="warning" title="Some telemetry could not be collected.">{q.data.errors.join(' · ')}</Notice>
      )}

      <CategorySummaryBar items={[
        { label: 'Total Tables', value: fmtNumber(s.total_tables) },
        { label: 'Needing Maintenance', value: fmtNumber(s.needing_maintenance), tone: s.needing_maintenance ? 'warn' : 'good' },
        { label: 'With Reclaimable Space', value: fmtNumber(s.with_reclaimable_space) },
        { label: 'Reclaimable Total', value: `${fmtNumber(s.reclaimable_total_mb)} MB` },
        { label: 'Running', value: s.running, tone: s.running ? 'warn' : 'good' },
        { label: 'Failed', value: s.failed, tone: s.failed ? 'bad' : 'good' },
      ]}
      />

      {s.largest_reclaimable?.length > 0 && (
        <div className="card p-card">
          <p className="mb-2 text-[12px] font-bold uppercase tracking-wide text-subtle">Largest Reclaimable Tables</p>
          <div className="flex flex-wrap gap-2">
            {s.largest_reclaimable.map((t) => (
              <span key={t.object_name} className="rounded-control border border-border bg-surface px-2.5 py-1 text-[11px]">
                <span className="font-mono font-semibold text-fg">{t.object_name}</span>
                <span className="ml-1.5 text-subtle">{fmtNumber(t.reclaimable_mb)} MB</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 rounded-control border border-border p-0.5">
          {[['all', 'All'], ['needing', 'Needs Maintenance'], ['reclaimable', 'Has Reclaimable Space']].map(([id, label]) => (
            <button
              key={id} type="button" onClick={() => setFilter(id)} aria-pressed={filter === id}
              className={`h-7 rounded-control px-2.5 text-[11px] font-bold transition-colors ${filter === id ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-sunken hover:text-fg'}`}
            >
              {label}
            </button>
          ))}
        </span>
        <Input value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch('')} placeholder="Owner.Table…" icon="search" size="sm" wrapperClassName="w-56" />
      </div>

      <Paged rows={shown} unit="tables">
        {(page, pager) => (
          <>
            <Table
              columns={[
                { key: 'object', label: 'Owner.Table' },
                { key: 'tablespace', label: 'Tablespace' },
                { key: 'size', label: 'Size', align: 'right' },
                { key: 'reclaim', label: 'Reclaimable', align: 'right' },
                { key: 'rows', label: 'Rows', align: 'right' },
                { key: 'analyzed', label: 'Last Analyzed' },
                { key: 'rowmove', label: 'Row Movement' },
                { key: 'lastop', label: 'Last Operation' },
                { key: 'reco', label: 'Recommendation' },
                { key: 'ops', label: '' },
              ]}
              rows={page.map((t) => ({
                key: t.object_name,
                cells: {
                  object: <span className="font-mono text-[12px] font-semibold text-accent-text">{t.object_name}</span>,
                  tablespace: <span className="text-[12px]">{t.tablespace_name}</span>,
                  size: <span className="font-mono text-[12px]">{fmtNumber(t.size_mb)} MB</span>,
                  reclaim: t.reclaimable_mb != null ? (
                    <span className="font-mono text-[12px]">
                      {fmtNumber(t.reclaimable_mb)} MB <span className="text-subtle">({t.reclaimable_pct}%)</span>
                    </span>
                  ) : <span className="text-subtle">—</span>,
                  rows: <span className="font-mono text-[12px]">{t.num_rows != null ? fmtNumber(t.num_rows) : '—'}</span>,
                  analyzed: (
                    <span className={t.stats_stale ? 'text-[11px] text-warning-fg' : 'text-[11px] text-muted'}>
                      {t.last_analyzed ? fmtIST(t.last_analyzed) : 'Never'}
                    </span>
                  ),
                  rowmove: <Badge tone={t.row_movement_enabled ? 'success' : 'neutral'} size="xs">{t.row_movement_enabled ? 'Enabled' : 'Disabled'}</Badge>,
                  lastop: t.last_operation ? (
                    <span className="flex flex-col gap-0.5">
                      <span className="text-[11px] text-fg">{ACTION_LABELS[t.last_operation] || t.last_operation}</span>
                      <Badge tone={t.last_status === 'succeeded' ? 'success' : t.last_status === 'failed' ? 'danger' : 'info'} size="xs">{t.last_status}</Badge>
                    </span>
                  ) : <span className="text-subtle">—</span>,
                  reco: t.recommendation ? <Badge tone="warning" size="xs">{ACTION_LABELS[t.recommendation] || t.recommendation}</Badge> : <span className="text-subtle">—</span>,
                  ops: <ActionsMenu actions={eligibility(t)} onPick={(action) => openConfirm(action, t)} />,
                },
              }))}
              empty={<EmptyState icon="table" title="No tables found" />}
            />
            {pager}
          </>
        )}
      </Paged>

      <OperationConfirmDialog
        open={!!confirmState}
        action={confirmState?.action}
        objectLabel={confirmState?.row?.object_name}
        loading={directMut.isPending}
        error={directMut.error}
        onCancel={() => setConfirmState(null)}
        onConfirm={runConfirmed}
        extra={confirmState?.row && (confirmState.action === 'shrink_space' || confirmState.action === 'move') && (
          <p className="text-[12px] text-muted">
            Current size <span className="font-semibold text-fg">{fmtNumber(confirmState.row.size_mb)} MB</span>,
            {' '}estimated reclaimable <span className="font-semibold text-fg">{fmtNumber(confirmState.row.reclaimable_mb)} MB</span>.
            The exact amount reclaimed is measured after execution.
          </p>
        )}
      />
    </div>
  );
}
