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

function eligibility(i) {
  const unusable = i.status === 'UNUSABLE';
  return [
    {
      action: 'index_maintenance_rebuild', label: ACTION_LABELS.index_maintenance_rebuild,
      disabled: false,
    },
    {
      action: 'index_rebuild_online', label: ACTION_LABELS.index_rebuild_online,
      disabled: (i.index_type || '').includes('BITMAP'),
      reason: (i.index_type || '').includes('BITMAP') ? 'Bitmap indexes cannot be rebuilt online' : undefined,
    },
    {
      action: 'index_coalesce', label: ACTION_LABELS.index_coalesce,
      disabled: unusable, reason: unusable ? 'Cannot coalesce an unusable index — rebuild first' : undefined,
    },
    {
      action: 'index_rebuild_unusable', label: ACTION_LABELS.index_rebuild_unusable,
      disabled: !unusable, reason: !unusable ? 'Index is not unusable' : undefined,
    },
  ];
}

export default function IndexMaintenancePage({ connId }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all'); // all | needing | unusable
  const [confirmState, setConfirmState] = useState(null);

  const q = useQuery({
    queryKey: ['oracleIndexMaintenance', connId],
    queryFn: () => client.get(`/connections/oracle/${connId}/oracle-maintenance/index-telemetry`).then((r) => r.data),
    retry: false,
    refetchInterval: REFRESH_SECONDS * 1000,
  });

  const [countdown, setCountdown] = useState(REFRESH_SECONDS);
  useEffect(() => {
    const t = setInterval(() => setCountdown((c) => (c <= 1 ? REFRESH_SECONDS : c - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  const directMut = useDirectMaintenance(connId, navigate, 'index');

  const indexes = q.data?.indexes || [];
  const shown = useMemo(() => {
    let rows = indexes;
    if (filter === 'needing') rows = rows.filter((i) => i.recommendation);
    else if (filter === 'unusable') rows = rows.filter((i) => i.status === 'UNUSABLE');
    const term = search.trim().toLowerCase();
    if (term) rows = rows.filter((i) => i.object_name.toLowerCase().includes(term) || i.table_name.toLowerCase().includes(term));
    return rows;
  }, [indexes, filter, search]);

  if (q.isLoading) return <PageLoading title="Reading index telemetry from dba_indexes…" illustration />;
  if (q.error || q.data?.status === 'error') {
    return <Notice tone="danger" title="Could not load index telemetry.">{q.data?.error || q.error?.message}</Notice>;
  }

  const s = q.data.summary;
  const runConfirmed = () => {
    if (!confirmState) return;
    directMut.mutate({ objectType: 'index', objectName: confirmState.row.object_name, action: confirmState.action });
  };

  return (
    <div className="space-y-gutter">
      <RefreshBar seconds={countdown} isFetching={q.isFetching} onRefresh={() => { q.refetch(); setCountdown(REFRESH_SECONDS); }} lastUpdatedAt={new Date().toISOString()} />

      {(q.data.errors || []).length > 0 && (
        <Notice tone="warning" title="Some telemetry could not be collected.">{q.data.errors.join(' · ')}</Notice>
      )}

      <CategorySummaryBar items={[
        { label: 'Total Indexes', value: fmtNumber(s.total_indexes) },
        { label: 'Unusable', value: s.unusable, tone: s.unusable ? 'bad' : 'good' },
        { label: 'Needing Maintenance', value: fmtNumber(s.needing_maintenance), tone: s.needing_maintenance ? 'warn' : 'good' },
        { label: 'Running', value: s.running, tone: s.running ? 'warn' : 'good' },
        { label: 'Failed', value: s.failed, tone: s.failed ? 'bad' : 'good' },
        { label: 'Last Run', value: s.last_execution_at ? fmtIST(s.last_execution_at) : 'Never' },
      ]}
      />

      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 rounded-control border border-border p-0.5">
          {[['all', 'All'], ['needing', 'Needs Maintenance'], ['unusable', 'Unusable']].map(([id, label]) => (
            <button
              key={id} type="button" onClick={() => setFilter(id)} aria-pressed={filter === id}
              className={`h-7 rounded-control px-2.5 text-[11px] font-bold transition-colors ${filter === id ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-sunken hover:text-fg'}`}
            >
              {label}
            </button>
          ))}
        </span>
        <Input value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch('')} placeholder="Index or table name…" icon="search" size="sm" wrapperClassName="w-56" />
      </div>

      <Paged rows={shown} unit="indexes">
        {(page, pager) => (
          <>
            <Table
              columns={[
                { key: 'object', label: 'Owner.Index' },
                { key: 'table', label: 'Table' },
                { key: 'tablespace', label: 'Tablespace' },
                { key: 'type', label: 'Type' },
                { key: 'status', label: 'Status' },
                { key: 'size', label: 'Size', align: 'right' },
                { key: 'blevel', label: 'BLEVEL', align: 'right' },
                { key: 'leaf', label: 'Leaf Blocks', align: 'right' },
                { key: 'distinct', label: 'Distinct Keys', align: 'right' },
                { key: 'clustering', label: 'Clustering Factor', align: 'right' },
                { key: 'analyzed', label: 'Last Analyzed' },
                { key: 'lastop', label: 'Last Operation' },
                { key: 'reco', label: 'Recommendation' },
                { key: 'ops', label: '' },
              ]}
              rows={page.map((i) => ({
                key: i.object_name,
                cells: {
                  object: <span className="font-mono text-[12px] font-semibold text-accent-text">{i.object_name}</span>,
                  table: <span className="text-[12px]">{i.table_name}</span>,
                  tablespace: <span className="text-[12px]">{i.tablespace_name || '—'}</span>,
                  type: <span className="text-[11px] text-muted">{i.index_type}</span>,
                  status: <Badge tone={i.status === 'UNUSABLE' ? 'danger' : 'success'} size="xs">{i.status}</Badge>,
                  size: <span className="font-mono text-[12px]">{i.size_mb != null ? `${fmtNumber(i.size_mb)} MB` : '—'}</span>,
                  blevel: <span className={i.blevel >= 3 ? 'font-mono text-[12px] text-warning-fg' : 'font-mono text-[12px]'}>{i.blevel ?? '—'}</span>,
                  leaf: <span className="font-mono text-[12px]">{i.leaf_blocks != null ? fmtNumber(i.leaf_blocks) : '—'}</span>,
                  distinct: <span className="font-mono text-[12px]">{i.distinct_keys != null ? fmtNumber(i.distinct_keys) : '—'}</span>,
                  clustering: <span className="font-mono text-[12px]">{i.clustering_factor != null ? fmtNumber(i.clustering_factor) : '—'}</span>,
                  analyzed: <span className={i.stats_stale ? 'text-[11px] text-warning-fg' : 'text-[11px] text-muted'}>{i.last_analyzed ? fmtIST(i.last_analyzed) : 'Never'}</span>,
                  lastop: i.last_operation ? (
                    <span className="flex flex-col gap-0.5">
                      <span className="text-[11px] text-fg">{ACTION_LABELS[i.last_operation] || i.last_operation}</span>
                      <Badge tone={i.last_status === 'succeeded' ? 'success' : i.last_status === 'failed' ? 'danger' : 'info'} size="xs">{i.last_status}</Badge>
                    </span>
                  ) : <span className="text-subtle">—</span>,
                  reco: i.recommendation ? <Badge tone="warning" size="xs">{ACTION_LABELS[i.recommendation] || i.recommendation}</Badge> : <span className="text-subtle">—</span>,
                  ops: <ActionsMenu actions={eligibility(i)} onPick={(action) => setConfirmState({ action, row: i })} />,
                },
              }))}
              empty={<EmptyState icon="key" title="No indexes found" />}
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
      />
    </div>
  );
}
