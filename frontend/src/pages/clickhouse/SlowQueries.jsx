import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import client from '@/api/client';
import PageHeader from '@/components/layout/PageHeader';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import CopyButton from '@/components/ui/CopyButton';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import { dbError } from '@/lib/format';
import Select from '@/components/ui/Select';
import Table, { EmptyState, nextSort, sortRows } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';
import { Paged } from '@/components/ui/Pagination';
import { MetricTile, SqlBlock, SqlCell, StatCell, StateChip, TablePanel } from '@/pages/_shared/enginePanels';
import { fmtBytes, fmtNumber } from '@/config/dbCatalog';

/**
 * ClickHouse slow queries — from `system.query_log`, over the server's threshold,
 * within the collector's window.
 *
 * ClickHouse is columnar, so "slow" almost always means one of two things, and the
 * page names which: it read too many rows (no useful primary-key prefix, so it
 * scanned granules it did not need), or it spilled memory. Those have different
 * fixes, so the flags distinguish them rather than saying "slow".
 */

const num = (v) => Number(v) || 0;

export const CH_SLOW_THRESHOLDS = {
  /** Rows read per result row — a scan that returns little from a lot. */
  selectivity: 1000,
  /** Bytes read where the primary key clearly did not narrow the scan. */
  readBytes: 1024 ** 3,
  /** Peak memory where a query is a risk to the server, not just itself. */
  memory: 4 * 1024 ** 3,
  slowMs: 10000,
};

/** Why a query is flagged. Empty means it was merely over the threshold. */
export function queryWarnings(q) {
  const out = [];
  const ms = num(q.query_duration_ms);
  const read = num(q.read_rows);
  const result = num(q.result_rows);

  if (q.exception) {
    out.push({
      level: 'bad',
      title: 'Failed',
      text: q.exception,
    });
  }
  if (ms >= CH_SLOW_THRESHOLDS.slowMs) {
    out.push({
      level: 'bad',
      title: 'Very slow',
      text: `Took ${fmtNumber(ms)} ms.`,
    });
  }
  /* The characteristic ClickHouse problem: reading orders of magnitude more rows
     than the query returns means the primary key did not narrow the scan. */
  if (result > 0 && read / result > CH_SLOW_THRESHOLDS.selectivity) {
    out.push({
      level: 'warn',
      title: 'Scanned far more than it returned',
      text: `Read ${fmtNumber(read)} rows to return ${fmtNumber(result)} — about ${fmtNumber(Math.round(read / result))}× more. `
        + 'The WHERE clause is probably not using a prefix of the table\'s ORDER BY key, so ClickHouse '
        + 'cannot skip granules.',
    });
  } else if (result === 0 && read > CH_SLOW_THRESHOLDS.selectivity) {
    out.push({
      level: 'warn',
      title: 'Scanned a lot, returned nothing',
      text: `Read ${fmtNumber(read)} rows and returned none — the same primary-key problem, on a query that happens to match nothing.`,
    });
  }
  if (num(q.read_bytes) > CH_SLOW_THRESHOLDS.readBytes) {
    out.push({
      level: 'warn',
      title: 'Heavy read',
      text: `Read ${fmtBytes(q.read_bytes)} from disk. Selecting fewer columns is the cheapest win in a columnar store — `
        + 'a SELECT * reads every column\'s file.',
    });
  }
  if (num(q.memory_usage) > CH_SLOW_THRESHOLDS.memory) {
    out.push({
      level: 'warn',
      title: 'Large memory footprint',
      text: `Peaked at ${fmtBytes(q.memory_usage)}. A GROUP BY with high cardinality or a large JOIN is the usual cause; `
        + 'both can hit max_memory_usage and be killed outright.',
    });
  }
  return out;
}

const TYPE_TONES = {
  QueryFinish: 'success',
  ExceptionWhileProcessing: 'danger',
  ExceptionBeforeStart: 'danger',
};

const COLUMNS = [
  { key: 'sql', label: 'Query' },
  { key: 'user', label: 'User' },
  { key: 'ms', label: 'Duration', align: 'right', sortable: true },
  { key: 'read', label: 'Rows read', align: 'right', sortable: true },
  { key: 'result', label: 'Rows out', align: 'right', sortable: true },
  { key: 'ratio', label: 'Read / returned', align: 'right', sortable: true },
  { key: 'bytes', label: 'Bytes read', align: 'right', sortable: true },
  { key: 'mem', label: 'Peak memory', align: 'right', sortable: true },
  { key: 'when', label: 'Time', sortable: true },
  { key: 'flags', label: 'Flags' },
];

export default function ClickHouseSlowQueries() {
  const { id } = useParams();
  const [search, setSearch] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [minMs, setMinMs] = useState('0');
  const [sort, setSort] = useState({ key: 'ms', dir: 'desc' });
  const [open, setOpen] = useState(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['chSlowQueries', id],
    queryFn: () => client.get(`/connections/clickhouse/${id}/ch-slow-queries`).then((r) => r.data),
    retry: false,
    refetchInterval: 30000,
  });

  const queries = useMemo(() => data?.queries || [], [data]);

  const userOptions = useMemo(() => ([
    { id: '', label: 'All users' },
    ...[...new Set(queries.map((q) => q.user).filter(Boolean))].sort().map((u) => ({ id: u, label: u })),
  ]), [queries]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const floor = Number(minMs) || 0;
    return queries.filter((q) => (
      (!term || `${q.query} ${q.query_id}`.toLowerCase().includes(term))
      && (!userFilter || q.user === userFilter)
      && num(q.query_duration_ms) >= floor
    ));
  }, [queries, search, userFilter, minMs]);

  const byKey = useMemo(
    () => new Map(filtered.map((q, i) => [`${q.query_id || 'q'}-${i}`, q])),
    [filtered],
  );

  const rows = useMemo(() => sortRows(filtered.map((q, i) => {
    const key = `${q.query_id || 'q'}-${i}`;
    const warns = queryWarnings(q);
    const ms = num(q.query_duration_ms);
    const read = num(q.read_rows);
    const result = num(q.result_rows);
    const ratio = result > 0 ? read / result : null;
    return {
      key,
      onClick: () => setOpen(open === key ? null : key),
      sort: {
        ms,
        read,
        result,
        ratio: ratio ?? 0,
        bytes: num(q.read_bytes),
        mem: num(q.memory_usage),
        when: q.event_time || '',
      },
      cells: {
        sql: (
          <span className="flex items-start gap-2">
            {warns.length > 0 && (
              <span
                title={warns.map((w) => w.title).join(', ')}
                className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${warns.some((w) => w.level === 'bad') ? 'bg-danger' : 'bg-warning'}`}
              />
            )}
            <span className="min-w-0">
              <SqlCell sql={q.query} max={85} />
              {(q.tables || []).length > 0 && (
                <span className="mt-0.5 block font-mono text-[10px] text-subtle">
                  {(q.tables || []).slice(0, 3).join(', ')}
                </span>
              )}
            </span>
          </span>
        ),
        user: <span className="text-[11px] text-muted">{q.user}</span>,
        ms: (
          <span className={ms >= CH_SLOW_THRESHOLDS.slowMs ? 'font-mono font-bold text-danger-fg' : 'font-mono font-semibold'}>
            {fmtNumber(ms)} ms
          </span>
        ),
        read: <span className="font-mono">{fmtNumber(read)}</span>,
        result: <span className="font-mono text-[12px] text-muted">{fmtNumber(result)}</span>,
        ratio: ratio == null ? null : (
          <span className={ratio > CH_SLOW_THRESHOLDS.selectivity ? 'font-mono font-bold text-warning-fg' : 'font-mono'}>
            {fmtNumber(Math.round(ratio))}×
          </span>
        ),
        bytes: (
          <span className={num(q.read_bytes) > CH_SLOW_THRESHOLDS.readBytes
            ? 'font-mono font-bold text-warning-fg' : 'font-mono text-[12px]'}>
            {fmtBytes(q.read_bytes)}
          </span>
        ),
        mem: (
          <span className={num(q.memory_usage) > CH_SLOW_THRESHOLDS.memory
            ? 'font-mono font-bold text-warning-fg' : 'font-mono text-[12px]'}>
            {fmtBytes(q.memory_usage)}
          </span>
        ),
        when: <span className="font-mono text-[11px] whitespace-nowrap text-muted">{String(q.event_time || '').slice(0, 19)}</span>,
        flags: warns.length ? (
          <span className="flex flex-wrap gap-1">
            {warns.map((w) => (
              <Badge key={w.title} tone={w.level === 'bad' ? 'danger' : 'warning'} size="xs">{w.title}</Badge>
            ))}
          </span>
        ) : null,
      },
    };
  }), sort), [filtered, sort, open]);

  const stats = useMemo(() => ({
    total: queries.length,
    slowest: queries.length ? Math.max(...queries.map((q) => num(q.query_duration_ms))) : 0,
    failed: queries.filter((q) => q.exception).length,
    scans: queries.filter((q) => {
      const r = num(q.result_rows);
      return r > 0 && num(q.read_rows) / r > CH_SLOW_THRESHOLDS.selectivity;
    }).length,
  }), [queries]);

  const header = (
    <PageHeader
      title="ClickHouse Slow Queries"
      description="system.query_log — finished and failed queries over the server's threshold"
      icon="trend"
      backTo={`/clickhouse-dashboard/${id}`}
      actions={(
        <Button variant="secondary" icon="refresh" loading={isFetching} onClick={() => refetch()}>
          Refresh
        </Button>
      )}
    />
  );

  if (isLoading) return <>{header}<PageLoading title="Reading system.query_log…" /></>;

  if (error) {
    return (
      <>
        {header}
        <Notice tone="danger" title="Could not read the query log.">{error.message}</Notice>
        <Button variant="primary" icon="refresh" onClick={() => refetch()}>Retry</Button>
      </>
    );
  }

  return (
    <>
      {header}

      {data?.status === 'error' && data?.error && (
        <Notice tone="warning" title="system.query_log could not be read.">
          <span className="clamp-2" title={String(data.error)}>{dbError(data.error)}</span>{' '}
          It is enabled by default, but a server config can turn it off.
        </Notice>
      )}

      <div className="space-y-gutter">
        <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4">
          <MetricTile label="Slow queries" value={stats.total} icon="trend"
            sub={data?.threshold_ms ? `over ${fmtNumber(data.threshold_ms)} ms, last ${data.window_hours ?? 24}h` : undefined} />
          <MetricTile label="Slowest" value={`${fmtNumber(stats.slowest)} ms`} icon="clock"
            tone={stats.slowest >= CH_SLOW_THRESHOLDS.slowMs ? 'bad' : 'neutral'} />
          <MetricTile label="Failed" value={stats.failed} icon="alert"
            tone={stats.failed ? 'bad' : 'good'} />
          <MetricTile label="Poor key usage" value={stats.scans} icon="layers"
            tone={stats.scans ? 'warn' : 'good'}
            hint={`Read more than ${fmtNumber(CH_SLOW_THRESHOLDS.selectivity)}× the rows they returned`} />
        </div>

        <TablePanel
          title="Slow queries"
          icon="trend"
          subtitle="Select a row for the full SQL and what to look at"
          actions={(
            <>
              <Select value={userFilter} onChange={setUserFilter} options={userOptions} size="sm" width="auto" />
              <Select
                value={minMs}
                onChange={setMinMs}
                options={[
                  { id: '0', label: 'Any duration' },
                  { id: '1000', label: '≥ 1 s' },
                  { id: '5000', label: '≥ 5 s' },
                  { id: '10000', label: '≥ 10 s' },
                  { id: '60000', label: '≥ 1 min' },
                ]}
                size="sm"
                width="auto"
              />
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
                      body="Nothing matches the current filters." />
                  ) : (
                    <EmptyState icon="check" title="No slow queries"
                      body={`No query in the last ${data?.window_hours ?? 24} hours took longer than ${fmtNumber(data?.threshold_ms ?? 500)} ms.`} />
                  )}
                />
                {page.map((row) => {
                  if (open !== row.key) return null;
                  const q = byKey.get(row.key);
                  return q ? <QueryDetail key={row.key} q={q} /> : null;
                })}
                {pager}
              </>
            )}
          </Paged>
        </TablePanel>

        <p className="flex items-start gap-1.5 text-[11px] text-subtle">
          <Icon name="info" size={12} className="mt-0.5 shrink-0" />
          Rows read counts whole granules, not matching rows — ClickHouse reads 8,192 rows at a time
          by default, so a query matching one row still reads at least one granule per part it touches.
        </p>
      </div>
    </>
  );
}

function QueryDetail({ q }) {
  const warns = queryWarnings(q);
  const read = num(q.read_rows);
  const result = num(q.result_rows);

  return (
    <div className="space-y-gutter border-t border-border bg-sunken px-card py-3">
      <div className="grid gap-gutter-sm sm:grid-cols-3 xl:grid-cols-6">
        <StatCell label="Duration" value={`${fmtNumber(q.query_duration_ms)} ms`}
          tone={num(q.query_duration_ms) >= CH_SLOW_THRESHOLDS.slowMs ? 'bad' : 'neutral'} />
        <StatCell label="Rows read" value={fmtNumber(read)} />
        <StatCell label="Rows returned" value={fmtNumber(result)} />
        <StatCell label="Read / returned"
          value={result > 0 ? `${fmtNumber(Math.round(read / result))}×` : '—'}
          tone={result > 0 && read / result > CH_SLOW_THRESHOLDS.selectivity ? 'warn' : 'neutral'}
          hint="How much it read for what it gave back" />
        <StatCell label="Bytes read" value={fmtBytes(q.read_bytes)}
          tone={num(q.read_bytes) > CH_SLOW_THRESHOLDS.readBytes ? 'warn' : 'neutral'} />
        <StatCell label="Peak memory" value={fmtBytes(q.memory_usage)}
          tone={num(q.memory_usage) > CH_SLOW_THRESHOLDS.memory ? 'warn' : 'neutral'} />
      </div>

      {(q.databases || q.tables) && (
        <div className="flex flex-wrap items-center gap-2">
          {q.type && <StateChip value={q.type} tones={TYPE_TONES} />}
          {(q.databases || []).map((dbName) => (
            <Badge key={dbName} tone="accent" size="xs">{dbName}</Badge>
          ))}
          {(q.tables || []).map((t) => (
            <Badge key={t} tone="neutral" size="xs">{t}</Badge>
          ))}
        </div>
      )}

      {warns.length > 0 && (
        <div className="space-y-2">
          {warns.map((w) => (
            <Notice key={w.title} className="mb-0"
              tone={w.level === 'bad' ? 'danger' : 'warning'} title={`${w.title}.`}>
              {w.text}
            </Notice>
          ))}
        </div>
      )}

      <div>
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <p className="text-[11px] font-bold tracking-wide text-subtle uppercase">Query</p>
          {q.query_id && <Badge tone="outline" size="xs">{q.query_id}</Badge>}
          <span className="ml-auto"><CopyButton text={q.query} /></span>
        </div>
        <SqlBlock sql={q.query || '(empty)'} className="max-h-56 overflow-auto" />
        <p className="mt-1.5 text-[11px] text-subtle">
          Truncated to 500 characters by the collector.
        </p>
      </div>
    </div>
  );
}
