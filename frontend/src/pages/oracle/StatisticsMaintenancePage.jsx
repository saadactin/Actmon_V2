import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import client from '@/api/client';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Table, { EmptyState } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';
import { Paged } from '@/components/ui/Pagination';
import { fmtNumber } from '@/config/dbCatalog';
import {
  CategorySummaryBar, OperationConfirmDialog, RefreshBar, useDirectMaintenance,
} from './maintenanceShared';
import { fmtIST } from './storageHealthConstants';

const REFRESH_SECONDS = 30;

export default function StatisticsMaintenancePage({ connId }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('stale'); // all | stale
  const [confirmState, setConfirmState] = useState(null); // { action, row? }

  const q = useQuery({
    queryKey: ['oracleStatsMaintenance', connId],
    queryFn: () => client.get(`/connections/oracle/${connId}/oracle-maintenance/statistics-telemetry`).then((r) => r.data),
    retry: false,
    refetchInterval: REFRESH_SECONDS * 1000,
  });

  const [countdown, setCountdown] = useState(REFRESH_SECONDS);
  useEffect(() => {
    const t = setInterval(() => setCountdown((c) => (c <= 1 ? REFRESH_SECONDS : c - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  const directMut = useDirectMaintenance(connId, navigate, 'statistics');

  const tables = q.data?.tables || [];
  const shown = useMemo(() => {
    let rows = tables;
    if (filter === 'stale') rows = rows.filter((t) => t.stale);
    const term = search.trim().toLowerCase();
    if (term) rows = rows.filter((t) => t.object_name.toLowerCase().includes(term));
    return rows;
  }, [tables, filter, search]);

  if (q.isLoading) return <PageLoading title="Reading dba_tables/dba_tab_modifications…" illustration />;
  if (q.error || q.data?.status === 'error') {
    return <Notice tone="danger" title="Could not load statistics telemetry.">{q.data?.error || q.error?.message}</Notice>;
  }

  const s = q.data.summary;
  const runConfirmed = () => {
    if (!confirmState) return;
    const { action, row } = confirmState;
    if (action === 'gather_schema_stats') {
      directMut.mutate({ objectType: 'schema_stats', objectName: row.owner, action });
    } else {
      directMut.mutate({ objectType: 'table', objectName: row.object_name, action });
    }
  };

  return (
    <div className="space-y-gutter">
      <RefreshBar seconds={countdown} isFetching={q.isFetching} onRefresh={() => { q.refetch(); setCountdown(REFRESH_SECONDS); }} lastUpdatedAt={new Date().toISOString()} />

      {(q.data.errors || []).length > 0 && (
        <Notice tone="warning" title="Some telemetry could not be collected.">{q.data.errors.join(' · ')}</Notice>
      )}

      <CategorySummaryBar items={[
        { label: 'Total Tables', value: fmtNumber(s.total_tables) },
        { label: 'Stale Statistics', value: fmtNumber(s.stale_count), tone: s.stale_count ? 'warn' : 'good' },
        { label: 'Running', value: s.running, tone: s.running ? 'warn' : 'good' },
        { label: 'Failed', value: s.failed, tone: s.failed ? 'bad' : 'good' },
        { label: 'Last Run', value: s.last_execution_at ? fmtIST(s.last_execution_at) : 'Never' },
      ]}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1 rounded-control border border-border p-0.5">
            {[['stale', 'Stale Only'], ['all', 'All Tables']].map(([id, label]) => (
              <button
                key={id} type="button" onClick={() => setFilter(id)} aria-pressed={filter === id}
                className={`h-7 rounded-control px-2.5 text-[11px] font-bold transition-colors ${filter === id ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-sunken hover:text-fg'}`}
              >
                {label}
              </button>
            ))}
          </span>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch('')} placeholder="Owner.Table…" icon="search" size="sm" wrapperClassName="w-56" />
        </span>
        <Button
          size="sm" variant="secondary" icon="chart-bar"
          onClick={() => setConfirmState({ action: 'gather_schema_stats', row: { owner: shown[0]?.owner || tables[0]?.owner } })}
          disabled={!tables.length}
        >
          Gather Schema Statistics…
        </Button>
      </div>

      <Paged rows={shown} unit="tables">
        {(page, pager) => (
          <>
            <Table
              columns={[
                { key: 'object', label: 'Owner.Table' },
                { key: 'rows', label: 'Rows', align: 'right' },
                { key: 'analyzed', label: 'Last Analyzed' },
                { key: 'status', label: 'Status' },
                { key: 'mods', label: 'Modifications (I/U/D)', align: 'right' },
                { key: 'ops', label: '' },
              ]}
              rows={page.map((t) => ({
                key: t.object_name,
                cells: {
                  object: <span className="font-mono text-[12px] font-semibold text-accent-text">{t.object_name}</span>,
                  rows: <span className="font-mono text-[12px]">{t.num_rows != null ? fmtNumber(t.num_rows) : '—'}</span>,
                  analyzed: <span className={t.stale ? 'text-[11px] text-warning-fg' : 'text-[11px] text-muted'}>{t.last_analyzed ? fmtIST(t.last_analyzed) : 'Never'}</span>,
                  status: <Badge tone={t.stale ? 'warning' : 'success'} size="xs">{t.stale ? 'Stale' : 'Fresh'}</Badge>,
                  mods: t.modifications != null ? (
                    <span className="font-mono text-[11px]">{fmtNumber(t.inserts)} / {fmtNumber(t.updates)} / {fmtNumber(t.deletes)}</span>
                  ) : <span className="text-subtle">—</span>,
                  ops: (
                    <span className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                      <Button size="sm" variant="secondary" onClick={() => setConfirmState({ action: 'gather_table_stats', row: t })}>
                        Gather Stats
                      </Button>
                    </span>
                  ),
                },
              }))}
              empty={<EmptyState icon="chart-bar" title={filter === 'stale' ? 'No stale statistics' : 'No tables found'} body={filter === 'stale' ? 'Every table has been analyzed within the freshness window.' : undefined} />}
            />
            {pager}
          </>
        )}
      </Paged>

      <OperationConfirmDialog
        open={!!confirmState}
        action={confirmState?.action}
        objectLabel={confirmState?.action === 'gather_schema_stats' ? `schema ${confirmState?.row?.owner}` : confirmState?.row?.object_name}
        loading={directMut.isPending}
        error={directMut.error}
        onCancel={() => setConfirmState(null)}
        onConfirm={runConfirmed}
        extra={confirmState?.action === 'gather_schema_stats' && (
          <p className="text-[12px] text-muted">
            Gathers statistics for every table in this schema via DBMS_STATS.GATHER_SCHEMA_STATS —
            can take a while on a large schema.
          </p>
        )}
      />
    </div>
  );
}
