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

function eligibility(p) {
  return [
    { action: 'move_partition', label: ACTION_LABELS.move_partition, disabled: false },
    { action: 'shrink_partition', label: ACTION_LABELS.shrink_partition, disabled: false },
    {
      action: 'rebuild_partition', label: ACTION_LABELS.rebuild_partition,
      disabled: !p.unusable_local_indexes?.length,
      reason: !p.unusable_local_indexes?.length ? 'No unusable local index partitions here' : undefined,
    },
    { action: 'merge_partition', label: ACTION_LABELS.merge_partition, disabled: false },
    { action: 'split_partition', label: ACTION_LABELS.split_partition, disabled: false },
    { action: 'drop_partition', label: ACTION_LABELS.drop_partition, disabled: false },
  ];
}

/** Merge/Split/Rebuild need a DBA-supplied parameter beyond just "which
 * partition" — collected here rather than a separate dialog, so it's part
 * of the same confirm-before-execute step. */
function ParamsForm({ action, row, params, setParams }) {
  if (action === 'merge_partition') {
    return (
      <div className="space-y-2">
        <div>
          <label className="mb-1 block text-[11px] font-bold uppercase text-subtle">Merge with partition</label>
          <Input value={params.merge_with || ''} onChange={(e) => setParams({ ...params, merge_with: e.target.value })} placeholder="e.g. P2024_Q2" size="sm" />
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-bold uppercase text-subtle">New partition name</label>
          <Input value={params.new_partition_name || ''} onChange={(e) => setParams({ ...params, new_partition_name: e.target.value })} placeholder="e.g. P2024_H1" size="sm" />
        </div>
      </div>
    );
  }
  if (action === 'split_partition') {
    return (
      <div className="space-y-2">
        <div>
          <label className="mb-1 block text-[11px] font-bold uppercase text-subtle">Split at value expression</label>
          <Input value={params.split_at || ''} onChange={(e) => setParams({ ...params, split_at: e.target.value })} placeholder="e.g. TO_DATE('2024-07-01','YYYY-MM-DD')" size="sm" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="mb-1 block text-[11px] font-bold uppercase text-subtle">New partition 1</label>
            <Input value={params.new_partition_name_1 || ''} onChange={(e) => setParams({ ...params, new_partition_name_1: e.target.value })} size="sm" />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-bold uppercase text-subtle">New partition 2</label>
            <Input value={params.new_partition_name_2 || ''} onChange={(e) => setParams({ ...params, new_partition_name_2: e.target.value })} size="sm" />
          </div>
        </div>
      </div>
    );
  }
  if (action === 'rebuild_partition') {
    return (
      <div>
        <label className="mb-1 block text-[11px] font-bold uppercase text-subtle">Unusable local index</label>
        <select
          className="h-control-sm w-full rounded-control border border-border bg-surface px-2.5 text-[13px] text-fg"
          value={params.index_name || row.unusable_local_indexes?.[0] || ''}
          onChange={(e) => setParams({ ...params, index_name: e.target.value })}
        >
          {(row.unusable_local_indexes || []).map((idx) => <option key={idx} value={idx}>{idx}</option>)}
        </select>
      </div>
    );
  }
  return null;
}

export default function PartitionMaintenancePage({ connId }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [confirmState, setConfirmState] = useState(null); // { action, row }
  const [params, setParams] = useState({});

  const q = useQuery({
    queryKey: ['oraclePartitionMaintenance', connId],
    queryFn: () => client.get(`/connections/oracle/${connId}/oracle-maintenance/partition-telemetry`).then((r) => r.data),
    retry: false,
    refetchInterval: REFRESH_SECONDS * 1000,
  });

  const [countdown, setCountdown] = useState(REFRESH_SECONDS);
  useEffect(() => {
    const t = setInterval(() => setCountdown((c) => (c <= 1 ? REFRESH_SECONDS : c - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  const directMut = useDirectMaintenance(connId, navigate, 'partition');

  const partitions = q.data?.partitions || [];
  const shown = useMemo(() => {
    let rows = partitions;
    if (filter === 'needing') rows = rows.filter((p) => p.recommendation);
    const term = search.trim().toLowerCase();
    if (term) rows = rows.filter((p) => p.object_name.toLowerCase().includes(term));
    return rows;
  }, [partitions, filter, search]);

  if (q.isLoading) return <PageLoading title="Reading dba_tab_partitions/dba_ind_partitions…" illustration />;
  if (q.error || q.data?.status === 'error') {
    return <Notice tone="danger" title="Could not load partition telemetry.">{q.data?.error || q.error?.message}</Notice>;
  }

  const s = q.data.summary;
  const openConfirm = (action, row) => { setParams({}); setConfirmState({ action, row }); };
  const runConfirmed = () => {
    if (!confirmState) return;
    const { action, row } = confirmState;
    directMut.mutate({
      objectType: 'partition', objectName: row.object_name, action,
      params: { ...params, confirm_destructive: true },
    });
  };

  return (
    <div className="space-y-gutter">
      <RefreshBar seconds={countdown} isFetching={q.isFetching} onRefresh={() => { q.refetch(); setCountdown(REFRESH_SECONDS); }} lastUpdatedAt={new Date().toISOString()} />

      {(q.data.errors || []).length > 0 && (
        <Notice tone="warning" title="Some telemetry could not be collected.">{q.data.errors.join(' · ')}</Notice>
      )}

      <CategorySummaryBar items={[
        { label: 'Total Partitions', value: fmtNumber(s.total_partitions) },
        { label: 'Needing Maintenance', value: fmtNumber(s.needing_maintenance), tone: s.needing_maintenance ? 'warn' : 'good' },
        { label: 'Unusable Local Indexes', value: s.unusable_local_indexes, tone: s.unusable_local_indexes ? 'bad' : 'good' },
        { label: 'Running', value: s.running, tone: s.running ? 'warn' : 'good' },
        { label: 'Failed', value: s.failed, tone: s.failed ? 'bad' : 'good' },
        { label: 'Last Run', value: s.last_execution_at ? fmtIST(s.last_execution_at) : 'Never' },
      ]}
      />

      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 rounded-control border border-border p-0.5">
          {[['all', 'All'], ['needing', 'Needs Maintenance']].map(([id, label]) => (
            <button
              key={id} type="button" onClick={() => setFilter(id)} aria-pressed={filter === id}
              className={`h-7 rounded-control px-2.5 text-[11px] font-bold transition-colors ${filter === id ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-sunken hover:text-fg'}`}
            >
              {label}
            </button>
          ))}
        </span>
        <Input value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch('')} placeholder="Owner.Table.Partition…" icon="search" size="sm" wrapperClassName="w-64" />
      </div>

      <Paged rows={shown} unit="partitions">
        {(page, pager) => (
          <>
            <Table
              columns={[
                { key: 'object', label: 'Owner.Table.Partition' },
                { key: 'position', label: 'Pos', align: 'right' },
                { key: 'tablespace', label: 'Tablespace' },
                { key: 'size', label: 'Size', align: 'right' },
                { key: 'highvalue', label: 'High Value' },
                { key: 'rows', label: 'Rows', align: 'right' },
                { key: 'analyzed', label: 'Last Analyzed' },
                { key: 'reco', label: 'Recommendation' },
                { key: 'ops', label: '' },
              ]}
              rows={page.map((p) => ({
                key: p.object_name,
                cells: {
                  object: <span className="font-mono text-[12px] font-semibold text-accent-text">{p.object_name}</span>,
                  position: <span className="font-mono text-[12px]">{p.partition_position ?? '—'}</span>,
                  tablespace: <span className="text-[12px]">{p.tablespace_name || '—'}</span>,
                  size: <span className="font-mono text-[12px]">{p.size_mb != null ? `${fmtNumber(p.size_mb)} MB` : '—'}</span>,
                  highvalue: <span className="max-w-[220px] truncate font-mono text-[11px] text-muted" title={p.high_value}>{p.high_value || '—'}</span>,
                  rows: <span className="font-mono text-[12px]">{p.num_rows != null ? fmtNumber(p.num_rows) : '—'}</span>,
                  analyzed: <span className="text-[11px] text-muted">{p.last_analyzed ? fmtIST(p.last_analyzed) : 'Never'}</span>,
                  reco: p.recommendation
                    ? <Badge tone="warning" size="xs">{ACTION_LABELS[p.recommendation] || p.recommendation}</Badge>
                    : <span className="text-subtle">—</span>,
                  ops: <ActionsMenu actions={eligibility(p)} onPick={(action) => openConfirm(action, p)} />,
                },
              }))}
              empty={<EmptyState icon="layers" title="No partitions found" />}
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
        extra={confirmState && (
          <ParamsForm action={confirmState.action} row={confirmState.row} params={params} setParams={setParams} />
        )}
      />
    </div>
  );
}
