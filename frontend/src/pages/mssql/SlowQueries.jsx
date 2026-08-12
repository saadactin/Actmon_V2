import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import client from '@/api/client';
import PageHeader from '@/components/layout/PageHeader';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Select from '@/components/ui/Select';
import Table, { EmptyState, nextSort, sortRows } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';
import { Paged } from '@/components/ui/Pagination';
import { MetricTile, SqlCell, TablePanel } from '@/pages/_shared/enginePanels';
import { fmtNumber } from '@/config/dbCatalog';

/**
 * SQL Server slow queries — the plan cache ranked by average elapsed time.
 *
 * A row opens the full analysis page rather than expanding in place: the per-query
 * work (parse the tables, read each one's indexes, then ask the model) needs more
 * room than a table row, and it should be linkable.
 */

const fetchSlowQueries = (id) =>
  client.get(`/connections/mssql/${id}/mssql-slow-queries`).then((r) => r.data);

const num = (v) => Number(v) || 0;

/* Thresholds that decide whether a query is worth attention. Named here so the
   table, the flags and the KPI strip cannot drift apart. */
export const SLOW_THRESHOLDS = {
  elapsedMs: 5000,
  logicalReads: 10000,
  physicalReads: 1000,
};

/** Why this query is flagged. Empty means nothing is wrong with it. */
export function queryWarnings(q) {
  const out = [];
  if (num(q.avg_elapsed_ms) > SLOW_THRESHOLDS.elapsedMs) {
    out.push({
      level: 'bad',
      title: 'Very slow',
      text: `Averages ${fmtNumber(q.avg_elapsed_ms)} ms per execution, over the ${SLOW_THRESHOLDS.elapsedMs / 1000}s threshold.`,
    });
  }
  if (num(q.avg_physical_reads) > SLOW_THRESHOLDS.physicalReads) {
    out.push({
      level: 'warn',
      title: 'Heavy disk I/O',
      text: `${fmtNumber(q.avg_physical_reads)} physical reads per execution — the pages it needs are not in the buffer pool.`,
    });
  }
  if (num(q.avg_logical_reads) > SLOW_THRESHOLDS.logicalReads) {
    out.push({
      level: 'warn',
      title: 'Poor index coverage',
      text: `${fmtNumber(q.avg_logical_reads)} logical reads per execution suggests a scan where a seek would do.`,
    });
  }
  return out;
}

const ELAPSED_FILTERS = [
  { id: '0', label: 'Any duration' },
  { id: '500', label: '≥ 500 ms' },
  { id: '1000', label: '≥ 1 s' },
  { id: '5000', label: '≥ 5 s' },
  { id: '10000', label: '≥ 10 s' },
  { id: '30000', label: '≥ 30 s' },
];

const COLUMNS = [
  { key: 'sql', label: 'Statement' },
  { key: 'db', label: 'Database' },
  { key: 'avg', label: 'Avg elapsed (ms)', align: 'right', sortable: true },
  { key: 'execs', label: 'Executions', align: 'right', sortable: true },
  { key: 'cpu', label: 'Total CPU (ms)', align: 'right', sortable: true },
  { key: 'logical', label: 'Avg logical reads', align: 'right', sortable: true },
  { key: 'physical', label: 'Avg phys. reads', align: 'right', sortable: true },
  { key: 'last', label: 'Last executed', sortable: true },
  { key: 'flags', label: 'Flags' },
];

export default function MSSQLSlowQueries() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [search, setSearch] = useState('');
  const [dbFilter, setDbFilter] = useState('');
  const [minElapsed, setMinElapsed] = useState('0');
  const [sort, setSort] = useState({ key: 'avg', dir: 'desc' });

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['mssqlSlowQueries', id],
    queryFn: () => fetchSlowQueries(id),
    retry: false,
    refetchInterval: 30000,
  });

  const queries = useMemo(() => {
    if (Array.isArray(data)) return data;
    return data?.queries || [];
  }, [data]);

  const dbOptions = useMemo(() => ([
    { id: '', label: 'All databases' },
    ...[...new Set(queries.map((q) => q.db_name).filter(Boolean))].sort()
      .map((d) => ({ id: d, label: d })),
  ]), [queries]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const floor = Number(minElapsed) || 0;
    return queries.filter((row) => (
      (!q || String(row.sql_text || '').toLowerCase().includes(q))
      && (!dbFilter || row.db_name === dbFilter)
      && num(row.avg_elapsed_ms) >= floor
    ));
  }, [queries, search, dbFilter, minElapsed]);

  const rows = useMemo(() => sortRows(filtered.map((q, i) => {
    const warns = queryWarnings(q);
    const avg = num(q.avg_elapsed_ms);
    return {
      key: `q-${i}`,
      onClick: () => navigate(`/mssql-dashboard/${id}/slow-queries/detail`, { state: { query: q } }),
      sort: {
        avg,
        execs: num(q.execution_count),
        cpu: num(q.total_cpu_ms),
        logical: num(q.avg_logical_reads),
        physical: num(q.avg_physical_reads),
        last: q.last_execution_time ? new Date(q.last_execution_time).getTime() || null : null,
      },
      cells: {
        sql: (
          <span className="flex items-center gap-2">
            {warns.length > 0 && (
              <span
                title={warns.map((w) => w.title).join(', ')}
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${warns.some((w) => w.level === 'bad') ? 'bg-danger' : 'bg-warning'}`}
              />
            )}
            <SqlCell sql={q.sql_text} max={100} />
          </span>
        ),
        db: q.db_name ? <Badge tone="accent" size="xs">{q.db_name}</Badge> : null,
        avg: (
          <span className={
            avg > 10000 ? 'font-mono font-bold text-danger-fg'
              : avg > SLOW_THRESHOLDS.elapsedMs ? 'font-mono font-bold text-warning-fg'
                : 'font-mono font-semibold'
          }>
            {fmtNumber(avg)}
          </span>
        ),
        execs: <span className="font-mono">{fmtNumber(q.execution_count)}</span>,
        cpu: <span className="font-mono">{fmtNumber(q.total_cpu_ms)}</span>,
        logical: (
          <span className={num(q.avg_logical_reads) > SLOW_THRESHOLDS.logicalReads
            ? 'font-mono font-bold text-warning-fg' : 'font-mono'}>
            {fmtNumber(q.avg_logical_reads)}
          </span>
        ),
        physical: (
          <span className={num(q.avg_physical_reads) > SLOW_THRESHOLDS.physicalReads
            ? 'font-mono font-bold text-warning-fg' : 'font-mono'}>
            {fmtNumber(q.avg_physical_reads)}
          </span>
        ),
        last: (
          <span className="font-mono text-[11px] whitespace-nowrap text-muted">
            {q.last_execution_time ? String(q.last_execution_time).slice(0, 19) : null}
          </span>
        ),
        flags: warns.length ? (
          <span className="flex flex-wrap gap-1">
            {warns.map((w) => (
              <Badge key={w.title} tone={w.level === 'bad' ? 'danger' : 'warning'} size="xs">{w.title}</Badge>
            ))}
          </span>
        ) : null,
      },
    };
  }), sort), [filtered, sort, navigate, id]);

  const stats = useMemo(() => {
    const list = queries.map((q) => num(q.avg_elapsed_ms));
    return {
      total: queries.length,
      avg: list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : 0,
      max: list.length ? Math.max(...list) : 0,
      heavy: queries.filter((q) => num(q.avg_logical_reads) > SLOW_THRESHOLDS.logicalReads).length,
    };
  }, [queries]);

  const header = (
    <PageHeader
      title="SQL Server Slow Queries"
      description="sys.dm_exec_query_stats — cached plans ranked by average elapsed time"
      icon="zap"
      backTo={`/mssql-dashboard/${id}`}
      actions={(
        <Button variant="secondary" icon="refresh" loading={isFetching} onClick={() => refetch()}>
          Refresh
        </Button>
      )}
    />
  );

  if (isLoading) return <>{header}<PageLoading title="Loading slow queries…" /></>;

  if (error) {
    return (
      <>
        {header}
        <Notice tone="danger" title="Could not load slow queries.">{error.message}</Notice>
        <Button variant="primary" icon="refresh" onClick={() => refetch()}>Retry</Button>
      </>
    );
  }

  return (
    <>
      {header}

      {data?.status === 'error' && data?.error && (
        <Notice tone="warning" title="The plan cache could not be read.">{data.error}</Notice>
      )}

      <div className="space-y-gutter">
        <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4">
          <MetricTile label="Cached statements" value={stats.total} icon="list" />
          <MetricTile label="Average elapsed" value={`${fmtNumber(stats.avg)} ms`} icon="clock" />
          <MetricTile label="Slowest" value={`${fmtNumber(stats.max)} ms`} icon="trend"
            tone={stats.max > SLOW_THRESHOLDS.elapsedMs ? 'bad' : 'neutral'} />
          <MetricTile label="Heavy readers" value={stats.heavy} icon="layers"
            tone={stats.heavy ? 'warn' : 'good'}
            hint={`Averaging more than ${fmtNumber(SLOW_THRESHOLDS.logicalReads)} logical reads per execution`} />
        </div>

        <TablePanel
          title="Slow queries"
          icon="zap"
          subtitle="Select a row for the full analysis: tables, indexes and suggested fixes"
          actions={(
            <>
              <Select value={dbFilter} onChange={setDbFilter} options={dbOptions} size="sm" width="auto" />
              <Select value={minElapsed} onChange={setMinElapsed} options={ELAPSED_FILTERS} size="sm" width="auto" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onClear={() => setSearch('')}
                placeholder="Search SQL…"
                icon="search"
                size="sm"
                wrapperClassName="w-44"
              />
              <Badge tone="accent" size="xs">
                {filtered.length === queries.length ? queries.length : `${filtered.length} / ${queries.length}`}
              </Badge>
            </>
          )}
        >
          <Paged rows={rows} unit="queries">
            {(page, pager) => (
              <>
                <Table
                  columns={COLUMNS}
                  rows={page}
                  sort={sort}
                  onSort={(key) => setSort((cur) => nextSort(cur, key))}
                  loading={isFetching}
                  empty={queries.length ? (
                    <EmptyState icon="filter" title="No matches"
                      body="Nothing matches the current filters — try a wider duration or clear the search." />
                  ) : (
                    <EmptyState icon="zap" title="No cached plans"
                      body="sys.dm_exec_query_stats returned nothing. The cache is cleared on restart, so run some queries and refresh."
                      action={<Button variant="primary" icon="refresh" onClick={() => refetch()}>Refresh now</Button>} />
                  )}
                />
                {pager}
              </>
            )}
          </Paged>
        </TablePanel>

        <p className="flex items-start gap-1.5 text-[11px] text-subtle">
          <Icon name="info" size={12} className="mt-0.5 shrink-0" />
          Averages are per execution since the plan entered the cache — a plan evicted or
          recompiled resets its counters, so a low execution count may understate a query's
          real cost.
        </p>
      </div>
    </>
  );
}
