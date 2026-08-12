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
import Select from '@/components/ui/Select';
import Table, { EmptyState, nextSort, sortRows } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';
import { Paged } from '@/components/ui/Pagination';
import { MetricTile, SqlBlock, SqlCell, StatCell, TablePanel } from '@/pages/_shared/enginePanels';
import { fmtNumber } from '@/config/dbCatalog';

/**
 * Oracle slow SQL — the shared SQL area ranked by average time per execution.
 *
 * Average, not total, on purpose: a statement run a million times at 5ms costs the
 * instance far more than one run once for a minute, but it is the second that a
 * user experiences as "the system is slow". Total elapsed time is on the Top SQL
 * tab of the dashboard; this view answers "what is slow when it runs".
 */

const num = (v) => Number(v) || 0;

/** Thresholds that decide whether a statement is worth attention. */
export const ORACLE_SLOW_THRESHOLDS = {
  elapsedSec: 1,
  criticalSec: 5,
  diskReads: 1000,
  bufferGets: 100000,
};

/** Why a statement is flagged. Empty means nothing looks wrong with it. */
export function sqlWarnings(q) {
  const out = [];
  const avg = num(q.avg_elapsed_sec);
  if (avg >= ORACLE_SLOW_THRESHOLDS.criticalSec) {
    out.push({
      level: 'bad',
      title: 'Very slow',
      text: `Averages ${avg.toFixed(2)}s per execution — anything over ${ORACLE_SLOW_THRESHOLDS.criticalSec}s is felt by whoever is waiting for it.`,
    });
  } else if (avg >= ORACLE_SLOW_THRESHOLDS.elapsedSec) {
    out.push({
      level: 'warn',
      title: 'Over a second',
      text: `Averages ${avg.toFixed(2)}s per execution.`,
    });
  }
  if (num(q.avg_disk_reads) > ORACLE_SLOW_THRESHOLDS.diskReads) {
    out.push({
      level: 'warn',
      title: 'Reading from disk',
      text: `${fmtNumber(q.avg_disk_reads)} physical reads per execution — the blocks it needs are not staying in the buffer cache.`,
    });
  }
  if (num(q.avg_buffer_gets) > ORACLE_SLOW_THRESHOLDS.bufferGets) {
    out.push({
      level: 'warn',
      title: 'Touching too many blocks',
      text: `${fmtNumber(q.avg_buffer_gets)} buffer gets per execution suggests a scan where an index seek would do.`,
    });
  }
  /* A statement whose CPU time is nearly all of its elapsed time is CPU-bound, so
     I/O tuning will not help it — worth saying, because it changes the fix. */
  const cpu = num(q.avg_cpu_sec);
  if (avg > 0.05 && cpu / avg > 0.9) {
    out.push({
      level: 'info',
      title: 'CPU-bound',
      text: `${Math.round((cpu / avg) * 100)}% of its time is CPU, not waiting. Look at the work it does — sorts, joins, function calls — rather than at I/O.`,
    });
  }
  return out;
}

const COLUMNS = [
  { key: 'sql', label: 'Statement' },
  { key: 'schema', label: 'Schema' },
  { key: 'avg', label: 'Avg elapsed', align: 'right', sortable: true },
  { key: 'cpu', label: 'Avg CPU', align: 'right', sortable: true },
  { key: 'execs', label: 'Executions', align: 'right', sortable: true },
  { key: 'reads', label: 'Avg disk reads', align: 'right', sortable: true },
  { key: 'gets', label: 'Avg buffer gets', align: 'right', sortable: true },
  { key: 'rows', label: 'Rows/exec', align: 'right', sortable: true },
  { key: 'last', label: 'Last run', sortable: true },
  { key: 'flags', label: 'Flags' },
];

const DURATION_FILTERS = [
  { id: '0', label: 'Any duration' },
  { id: '0.1', label: '≥ 100 ms' },
  { id: '0.5', label: '≥ 500 ms' },
  { id: '1', label: '≥ 1 s' },
  { id: '5', label: '≥ 5 s' },
  { id: '30', label: '≥ 30 s' },
];

export default function OracleSlowQueries() {
  const { id } = useParams();
  const [search, setSearch] = useState('');
  const [schemaFilter, setSchemaFilter] = useState('');
  const [minSec, setMinSec] = useState('0');
  const [sort, setSort] = useState({ key: 'avg', dir: 'desc' });
  const [open, setOpen] = useState(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['oracleSlowQueries', id],
    queryFn: () => client.get(`/connections/oracle/${id}/oracle-slow-queries`).then((r) => r.data),
    retry: false,
    refetchInterval: 30000,
  });

  const queries = useMemo(() => data?.queries || [], [data]);

  const schemaOptions = useMemo(() => ([
    { id: '', label: 'All schemas' },
    ...[...new Set(queries.map((q) => q.parsing_schema_name).filter(Boolean))].sort()
      .map((s) => ({ id: s, label: s })),
  ]), [queries]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const floor = Number(minSec) || 0;
    return queries.filter((q) => (
      (!term || `${q.sql_text} ${q.sql_id}`.toLowerCase().includes(term))
      && (!schemaFilter || q.parsing_schema_name === schemaFilter)
      && num(q.avg_elapsed_sec) >= floor
    ));
  }, [queries, search, schemaFilter, minSec]);

  /* Key → source row, so the expanded detail can find its statement without
     re-deriving the key from an index. */
  const byKey = useMemo(
    () => new Map(filtered.map((q, i) => [`${q.sql_id || 'sql'}-${i}`, q])),
    [filtered],
  );

  const rows = useMemo(() => sortRows(filtered.map((q, i) => {
    const warns = sqlWarnings(q);
    const avg = num(q.avg_elapsed_sec);
    const key = `${q.sql_id || 'sql'}-${i}`;
    return {
      key,
      onClick: () => setOpen(open === key ? null : key),
      sort: {
        avg,
        cpu: num(q.avg_cpu_sec),
        execs: num(q.executions),
        reads: num(q.avg_disk_reads),
        gets: num(q.avg_buffer_gets),
        rows: num(q.executions) ? num(q.rows_processed) / num(q.executions) : 0,
        last: q.last_active_time || '',
      },
      cells: {
        sql: (
          <span className="flex items-start gap-2">
            {warns.some((w) => w.level !== 'info') && (
              <span
                title={warns.map((w) => w.title).join(', ')}
                className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${warns.some((w) => w.level === 'bad') ? 'bg-danger' : 'bg-warning'}`}
              />
            )}
            <span className="min-w-0">
              <SqlCell sql={q.sql_text} max={95} />
              {q.sql_id && <span className="mt-0.5 block font-mono text-[10px] text-subtle">{q.sql_id}</span>}
            </span>
          </span>
        ),
        schema: q.parsing_schema_name ? <Badge tone="accent" size="xs">{q.parsing_schema_name}</Badge> : null,
        avg: (
          <span className={
            avg >= ORACLE_SLOW_THRESHOLDS.criticalSec ? 'font-mono font-bold text-danger-fg'
              : avg >= ORACLE_SLOW_THRESHOLDS.elapsedSec ? 'font-mono font-bold text-warning-fg'
                : 'font-mono font-semibold'
          }>
            {avg.toFixed(3)}s
          </span>
        ),
        cpu: <span className="font-mono">{num(q.avg_cpu_sec).toFixed(3)}s</span>,
        execs: <span className="font-mono">{fmtNumber(q.executions)}</span>,
        reads: (
          <span className={num(q.avg_disk_reads) > ORACLE_SLOW_THRESHOLDS.diskReads
            ? 'font-mono font-bold text-warning-fg' : 'font-mono'}>
            {fmtNumber(q.avg_disk_reads)}
          </span>
        ),
        gets: (
          <span className={num(q.avg_buffer_gets) > ORACLE_SLOW_THRESHOLDS.bufferGets
            ? 'font-mono font-bold text-warning-fg' : 'font-mono'}>
            {fmtNumber(q.avg_buffer_gets)}
          </span>
        ),
        rows: (
          <span className="font-mono text-[12px] text-muted">
            {num(q.executions) ? fmtNumber(Math.round(num(q.rows_processed) / num(q.executions))) : '—'}
          </span>
        ),
        last: <span className="font-mono text-[11px] whitespace-nowrap text-muted">{q.last_active_time}</span>,
        flags: warns.length ? (
          <span className="flex flex-wrap gap-1">
            {warns.map((w) => (
              <Badge key={w.title}
                tone={w.level === 'bad' ? 'danger' : w.level === 'warn' ? 'warning' : 'info'} size="xs">
                {w.title}
              </Badge>
            ))}
          </span>
        ) : null,
      },
    };
  }), sort), [filtered, sort, open]);

  const stats = useMemo(() => {
    const avgs = queries.map((q) => num(q.avg_elapsed_sec));
    return {
      total: queries.length,
      slowest: avgs.length ? Math.max(...avgs) : 0,
      overOne: queries.filter((q) => num(q.avg_elapsed_sec) >= 1).length,
      diskHeavy: queries.filter((q) => num(q.avg_disk_reads) > ORACLE_SLOW_THRESHOLDS.diskReads).length,
    };
  }, [queries]);

  const header = (
    <PageHeader
      title="Oracle Slow SQL"
      description="v$sqlarea, ranked by average time per execution — what is slow when it runs"
      icon="clock"
      backTo={`/oracle-dashboard/${id}`}
      actions={(
        <Button variant="secondary" icon="refresh" loading={isFetching} onClick={() => refetch()}>
          Refresh
        </Button>
      )}
    />
  );

  if (isLoading) return <>{header}<PageLoading title="Reading the shared SQL area…" /></>;

  if (error) {
    return (
      <>
        {header}
        <Notice tone="danger" title="Could not read v$sqlarea.">{error.message}</Notice>
        <Button variant="primary" icon="refresh" onClick={() => refetch()}>Retry</Button>
      </>
    );
  }

  return (
    <>
      {header}

      {data?.status === 'error' && data?.error && (
        <Notice tone="warning" title="The shared SQL area could not be read.">{data.error}</Notice>
      )}

      <div className="space-y-gutter">
        <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4">
          <MetricTile label="Statements" value={stats.total} icon="list"
            sub={data?.source ? `from ${data.source}` : undefined} />
          <MetricTile label="Slowest average" value={`${stats.slowest.toFixed(2)}s`} icon="trend"
            tone={stats.slowest >= ORACLE_SLOW_THRESHOLDS.criticalSec ? 'bad'
              : stats.slowest >= ORACLE_SLOW_THRESHOLDS.elapsedSec ? 'warn' : 'good'} />
          <MetricTile label="Over 1s per run" value={stats.overOne} icon="clock"
            tone={stats.overOne ? 'warn' : 'good'} />
          <MetricTile label="Reading from disk" value={stats.diskHeavy} icon="desktop"
            tone={stats.diskHeavy ? 'warn' : 'good'}
            hint={`More than ${fmtNumber(ORACLE_SLOW_THRESHOLDS.diskReads)} physical reads per execution`} />
        </div>

        <TablePanel
          title="Slow statements"
          icon="clock"
          subtitle="Select a row for the full statement and what to look at"
          actions={(
            <>
              <Select value={schemaFilter} onChange={setSchemaFilter} options={schemaOptions} size="sm" width="auto" />
              <Select value={minSec} onChange={setMinSec} options={DURATION_FILTERS} size="sm" width="auto" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onClear={() => setSearch('')}
                placeholder="Search SQL or sql_id…"
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
          <Paged rows={rows} unit="statements">
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
                      body="Nothing matches the current filters — try a shorter duration or clear the search." />
                  ) : (
                    <EmptyState icon="clock" title="Nothing in the shared SQL area"
                      body="v$sqlarea has no statement with at least one execution. It is cleared on restart, so run some work and refresh."
                      action={<Button variant="primary" icon="refresh" onClick={() => refetch()}>Refresh</Button>} />
                  )}
                />

                {page.map((row) => {
                  if (open !== row.key) return null;
                  const q = byKey.get(row.key);
                  return q ? <SqlDetail key={row.key} q={q} /> : null;
                })}
                {pager}
              </>
            )}
          </Paged>
        </TablePanel>

        <p className="flex items-start gap-1.5 text-[11px] text-subtle">
          <Icon name="info" size={12} className="mt-0.5 shrink-0" />
          Every figure is an average since the statement entered the shared pool, and the pool is
          cleared on restart or when a statement is aged out — a low execution count means the
          average rests on very few runs.
        </p>
      </div>
    </>
  );
}

/* ── one statement, expanded ───────────────────────────────────────────────── */

function SqlDetail({ q }) {
  const warns = sqlWarnings(q);
  const avg = num(q.avg_elapsed_sec);
  const cpu = num(q.avg_cpu_sec);
  const waiting = Math.max(0, avg - cpu);

  return (
    <div className="space-y-gutter border-t border-border bg-sunken px-card py-3">
      <div className="grid gap-gutter-sm sm:grid-cols-3 xl:grid-cols-6">
        <StatCell label="Avg elapsed" value={`${avg.toFixed(3)}s`}
          tone={avg >= ORACLE_SLOW_THRESHOLDS.criticalSec ? 'bad' : avg >= 1 ? 'warn' : 'neutral'} />
        <StatCell label="Avg on CPU" value={`${cpu.toFixed(3)}s`} />
        <StatCell label="Avg waiting" value={`${waiting.toFixed(3)}s`}
          hint="Elapsed minus CPU — time spent on I/O, locks or the network" />
        <StatCell label="Executions" value={fmtNumber(q.executions)} />
        <StatCell label="Avg disk reads" value={fmtNumber(q.avg_disk_reads)}
          tone={num(q.avg_disk_reads) > ORACLE_SLOW_THRESHOLDS.diskReads ? 'warn' : 'neutral'} />
        <StatCell label="Avg buffer gets" value={fmtNumber(q.avg_buffer_gets)}
          tone={num(q.avg_buffer_gets) > ORACLE_SLOW_THRESHOLDS.bufferGets ? 'warn' : 'neutral'} />
      </div>

      {warns.length > 0 && (
        <div className="space-y-2">
          {warns.map((w) => (
            <Notice key={w.title} className="mb-0"
              tone={w.level === 'bad' ? 'danger' : w.level === 'warn' ? 'warning' : 'info'}
              title={`${w.title}.`}>
              {w.text}
            </Notice>
          ))}
        </div>
      )}

      <div>
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <p className="text-[11px] font-bold tracking-wide text-subtle uppercase">Statement</p>
          {q.sql_id && <Badge tone="outline" size="xs">sql_id {q.sql_id}</Badge>}
          <span className="ml-auto"><CopyButton text={q.sql_text} /></span>
        </div>
        <SqlBlock sql={q.sql_text || '(empty)'} className="max-h-56 overflow-auto" />
        <p className="mt-1.5 text-[11px] text-subtle">
          Truncated to 400 characters by the collector. Open Live Queries for the full text of a
          statement that is running now.
        </p>
      </div>
    </div>
  );
}
