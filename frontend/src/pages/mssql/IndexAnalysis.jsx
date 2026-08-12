import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import cn from '@/lib/cn';
import client from '@/api/client';
import PageHeader from '@/components/layout/PageHeader';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import CopyButton from '@/components/ui/CopyButton';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Table, { EmptyState } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';
import { Paged } from '@/components/ui/Pagination';
import { MetricTile, Panel, SqlBlock, StatCell, TablePanel } from '@/pages/_shared/enginePanels';
import { fmtNumber } from '@/config/dbCatalog';

/**
 * SQL Server index analysis — three lists, all from the connected database:
 * indexes nothing reads, indexes the optimiser wishes existed, and pairs that
 * look redundant.
 *
 * The third tab is Duplicates, not "All indexes". The existing page reads
 * `data.all_indexes` / `data.indexes`, neither of which the endpoint returns —
 * that tab was always empty, while `duplicate_indexes` (which the backend does
 * compute, complete with a drop hint) was never shown at all.
 *
 * Every counter here resets when SQL Server restarts, which changes what "unused"
 * means. That caveat is on the page rather than in a comment, because acting on it
 * means dropping an index.
 */

const fetchIndexAnalysis = (id) =>
  client.get(`/connections/mssql/${id}/mssql-index-analysis`).then((r) => r.data);

const num = (v) => Number(v) || 0;
const bracket = (s) => `[${String(s || '').replace(/[[\]]/g, '')}]`;

/** The statement to drop an unused index, quoted so odd names still work. */
export function dropStatement(u) {
  return `DROP INDEX ${bracket(u.index_name)} ON [dbo].${bracket(u.table_name)};`;
}

/** The backend builds a create hint; fall back to composing one if it is absent. */
export function createStatement(m) {
  if (m.create_index_hint) return m.create_index_hint;
  const cols = m.suggested_columns || '';
  const include = m.included_columns ? ` INCLUDE (${m.included_columns})` : '';
  const safeName = cols.replace(/,\s*/g, '_').replace(/\s+/g, '_').slice(0, 40);
  return `CREATE NONCLUSTERED INDEX [IX_${m.table_name}_${safeName}] ON [dbo].${bracket(m.table_name)} (${cols})${include};`;
}

const TABS = [
  { id: 'unused', label: 'Unused', icon: 'trash' },
  { id: 'missing', label: 'Candidates', icon: 'plus' },
  { id: 'duplicate', label: 'Duplicates', icon: 'boxes' },
];

export default function MSSQLIndexAnalysis() {
  const { id } = useParams();
  const [tab, setTab] = useState('unused');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(null); // key of the expanded row

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['mssqlIndexAnalysis', id],
    queryFn: () => fetchIndexAnalysis(id),
    retry: false,
    refetchInterval: 60000,
  });

  const unused = useMemo(() => data?.unused_indexes || [], [data]);
  const missing = useMemo(() => data?.missing_indexes || [], [data]);
  const duplicate = useMemo(() => data?.duplicate_indexes || [], [data]);
  const summary = data?.summary || {};

  const q = search.trim().toLowerCase();
  const match = (...fields) => !q || fields.some((f) => String(f || '').toLowerCase().includes(q));

  const shown = {
    unused: unused.filter((u) => match(u.table_name, u.index_name)),
    missing: missing.filter((m) => match(m.table_name, m.suggested_columns)),
    duplicate: duplicate.filter((d) => match(d.table_name, d.index1, d.index2)),
  }[tab];

  const counts = { unused: unused.length, missing: missing.length, duplicate: duplicate.length };

  /* The endpoint reports per-query failures instead of failing the whole call, so
     a permission gap shows up as one empty list. Surface it. */
  const partialErrors = Object.entries(data?.errors || {})
    .filter(([, v]) => v)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`);

  const header = (
    <PageHeader
      title="SQL Server Index Analysis"
      description="Unused indexes, optimiser candidates and redundant pairs — for the connected database"
      icon="layers"
      backTo={`/mssql-dashboard/${id}`}
      actions={(
        <Button variant="secondary" icon="refresh" loading={isFetching} onClick={() => refetch()}>
          Refresh
        </Button>
      )}
    />
  );

  if (isLoading) return <>{header}<PageLoading title="Analysing indexes…" /></>;

  if (error || data?.status === 'error') {
    return (
      <>
        {header}
        <Notice tone="danger" title="Could not analyse indexes.">
          {data?.error || error?.message}
        </Notice>
        <Button variant="primary" icon="refresh" onClick={() => refetch()}>Retry</Button>
      </>
    );
  }

  return (
    <>
      {header}

      {partialErrors.length > 0 && (
        <Notice tone="warning" title="Some checks could not run.">
          {partialErrors.join(' · ')}
        </Notice>
      )}

      <div className="space-y-gutter">
        <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4">
          <MetricTile label="Indexes on user tables" value={fmtNumber(data?.all_indexes_count)} icon="layers" />
          <MetricTile label="Never read" value={counts.unused} icon="trash"
            tone={counts.unused ? 'bad' : 'good'}
            hint="Zero seeks, scans and lookups since the last restart" />
          <MetricTile label="Candidates" value={counts.missing} icon="plus"
            tone={counts.missing ? 'warn' : 'good'}
            hint="Recorded by the query optimiser" />
          <MetricTile label="Redundant pairs" value={counts.duplicate} icon="boxes"
            tone={counts.duplicate ? 'warn' : 'good'}
            hint="Two indexes on the same table with the same key-column count" />
        </div>

        {summary.health_score != null && (
          <Panel title="Index health" icon="activity"
            subtitle={summary.note}>
            <div className="grid gap-gutter-sm sm:grid-cols-2 xl:grid-cols-5">
              <StatCell label="Score" value={`${summary.health_score}/100`}
                tone={summary.health_score >= 80 ? 'good' : summary.health_score >= 60 ? 'warn' : 'bad'} />
              <StatCell label="Total indexes" value={fmtNumber(summary.total_indexes)} />
              <StatCell label="Unused" value={summary.unused_indexes_count} />
              <StatCell label="Unused but written to" value={summary.unused_with_writes_count}
                hint="Costs write throughput for no read benefit" />
              <StatCell label="Duplicates" value={summary.duplicate_indexes_count} />
            </div>
          </Panel>
        )}

        <TablePanel
          title="Findings"
          icon="layers"
          subtitle="Select a row for the statement to run"
          actions={(
            <>
              <span className="flex items-center gap-0.5 rounded-control border border-border p-0.5">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => { setTab(t.id); setOpen(null); }}
                    aria-pressed={tab === t.id}
                    className={cn(
                      'flex h-7 items-center gap-1.5 rounded-control px-2.5 text-[11px] font-bold transition-colors',
                      tab === t.id ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-sunken hover:text-fg',
                    )}
                  >
                    <Icon name={t.icon} size={11} />
                    {t.label}
                    <span className="tabular-nums opacity-70">{counts[t.id]}</span>
                  </button>
                ))}
              </span>
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onClear={() => setSearch('')}
                placeholder="Search tables…"
                icon="search"
                size="sm"
                wrapperClassName="w-40"
              />
            </>
          )}
        >
          {tab === 'unused' && (
            <>
              <div className="border-b border-border px-card py-2">
                <p className="flex items-start gap-1.5 text-[11px] text-warning-fg">
                  <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
                  These have had no reads since SQL Server last started. Confirm over a full
                  business cycle — a month-end report can be the only thing that uses an index.
                </p>
              </div>
              <Paged rows={shown} unit="indexes">
                {(page, pager) => (
                  <>
                    <Table
                      columns={[
                        { key: 'table', label: 'Table' },
                        { key: 'index', label: 'Index' },
                        { key: 'type', label: 'Type' },
                        { key: 'unique', label: 'Unique' },
                        { key: 'reads', label: 'Reads', align: 'right' },
                        { key: 'writes', label: 'Writes', align: 'right' },
                        { key: 'cost', label: 'Verdict' },
                      ]}
                      rows={page.map((u, i) => {
                        const key = `unused-${u.table_name}-${u.index_name}-${i}`;
                        return {
                          key,
                          onClick: () => setOpen(open === key ? null : key),
                          cells: {
                            table: <span className="font-mono text-[12px]">{u.table_name}</span>,
                            index: <span className="font-mono text-[12px] font-semibold text-danger-fg">{u.index_name}</span>,
                            type: <Badge tone="neutral" size="xs">{String(u.type_desc || '').replace('_INDEX', '')}</Badge>,
                            unique: u.is_unique ? <Badge tone="info" size="xs">Unique</Badge> : null,
                            reads: <span className="font-mono">{fmtNumber(u.total_reads)}</span>,
                            writes: <span className="font-mono">{fmtNumber(u.total_writes)}</span>,
                            cost: num(u.total_writes) > 0
                              ? <Badge tone="danger" size="xs">Pure overhead</Badge>
                              : <Badge tone="neutral" size="xs">Idle</Badge>,
                          },
                        };
                      })}
                      empty={<EmptyState icon="check"
                        title={unused.length ? 'No matches' : 'Every index is being read'}
                        body={unused.length ? undefined : 'No index on a user table has zero reads.'} />}
                    />
                    {page.some((u, i) => open === `unused-${u.table_name}-${u.index_name}-${i}`) && (
                      <div className="border-t border-border bg-sunken px-card py-3">
                        {page.map((u, i) => {
                          const key = `unused-${u.table_name}-${u.index_name}-${i}`;
                          if (open !== key) return null;
                          const sql = dropStatement(u);
                          return (
                            <div key={key} className="space-y-2">
                              <p className="text-[11px] font-bold tracking-wide text-subtle uppercase">
                                Drop statement
                              </p>
                              <div className="flex items-start gap-2">
                                <SqlBlock sql={sql} className="flex-1" />
                                <CopyButton text={sql} />
                              </div>
                              <p className="text-[11px] text-muted">
                                {num(u.total_writes) > 0
                                  ? `This index has absorbed ${fmtNumber(u.total_writes)} writes without serving a single read — dropping it makes every INSERT, UPDATE and DELETE on ${u.table_name} cheaper.`
                                  : 'Neither read nor written since the last restart. It may simply be unused, or the server may have restarted recently.'}
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {pager}
                  </>
                )}
              </Paged>
            </>
          )}

          {tab === 'missing' && (
            <>
              <div className="border-b border-border px-card py-2">
                <p className="flex items-start gap-1.5 text-[11px] text-muted">
                  <Icon name="info" size={12} className="mt-0.5 shrink-0" />
                  The optimiser records these when it would have used an index that does not
                  exist. Treat them as a starting point: check the column order, and prefer
                  widening an existing index to adding another one.
                </p>
              </div>
              <Paged rows={shown} unit="candidates">
                {(page, pager) => (
                  <>
                    <Table
                      columns={[
                        { key: 'table', label: 'Table' },
                        { key: 'cols', label: 'Suggested columns' },
                        { key: 'include', label: 'Include' },
                        { key: 'measure', label: 'Improvement measure', align: 'right' },
                        { key: 'seeks', label: 'Seeks', align: 'right' },
                        { key: 'scans', label: 'Scans', align: 'right' },
                      ]}
                      rows={page.map((m, i) => {
                        const key = `missing-${m.table_name}-${i}`;
                        return {
                          key,
                          onClick: () => setOpen(open === key ? null : key),
                          cells: {
                            table: <span className="font-mono text-[12px] font-semibold text-accent-text">{m.table_name}</span>,
                            cols: (
                              <span title={m.suggested_columns}
                                className="truncate-safe block max-w-[240px] font-mono text-[11px]">
                                {m.suggested_columns}
                              </span>
                            ),
                            include: (
                              <span title={m.included_columns}
                                className="truncate-safe block max-w-[160px] font-mono text-[11px] text-subtle">
                                {m.included_columns}
                              </span>
                            ),
                            measure: (
                              <span className="font-mono font-semibold">
                                {m.improvement_measure != null ? fmtNumber(Math.round(m.improvement_measure)) : null}
                              </span>
                            ),
                            seeks: <span className="font-mono">{fmtNumber(m.user_seeks)}</span>,
                            scans: <span className="font-mono">{fmtNumber(m.user_scans)}</span>,
                          },
                        };
                      })}
                      empty={<EmptyState icon="check"
                        title={missing.length ? 'No matches' : 'No candidates'}
                        body={missing.length ? undefined : 'The optimiser has not wanted an index that does not exist.'} />}
                    />
                    {page.some((m, i) => open === `missing-${m.table_name}-${i}`) && (
                      <div className="border-t border-border bg-sunken px-card py-3">
                        {page.map((m, i) => {
                          const key = `missing-${m.table_name}-${i}`;
                          if (open !== key) return null;
                          const sql = createStatement(m);
                          return (
                            <div key={key} className="space-y-2">
                              <p className="text-[11px] font-bold tracking-wide text-subtle uppercase">
                                Create statement
                              </p>
                              <div className="flex items-start gap-2">
                                <SqlBlock sql={sql} className="flex-1" />
                                <CopyButton text={sql} />
                              </div>
                              <p className="text-[11px] text-muted">
                                Improvement measure is <span className="font-mono">avg cost × avg impact ×
                                (seeks + scans)</span> — a relative ranking, not a percentage. Rename
                                the index to your convention before running it.
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {pager}
                  </>
                )}
              </Paged>
            </>
          )}

          {tab === 'duplicate' && (
            <>
              <div className="border-b border-border px-card py-2">
                <p className="flex items-start gap-1.5 text-[11px] text-warning-fg">
                  <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
                  Matched on key-column <em>count</em>, not on the columns themselves — these are
                  candidates for review, not confirmed duplicates. Compare the definitions before
                  dropping either one.
                </p>
              </div>
              <Paged rows={shown} unit="pairs">
                {(page, pager) => (
                  <>
                    <Table
                      columns={[
                        { key: 'table', label: 'Table' },
                        { key: 'first', label: 'Index' },
                        { key: 'second', label: 'Overlaps with' },
                        { key: 'keys', label: 'Key columns', align: 'right' },
                      ]}
                      rows={page.map((d, i) => {
                        const key = `dup-${d.table_name}-${d.index1}-${d.index2}-${i}`;
                        return {
                          key,
                          onClick: () => setOpen(open === key ? null : key),
                          cells: {
                            table: <span className="font-mono text-[12px]">{d.table_name}</span>,
                            first: (
                              <span className="flex flex-col">
                                <span className="font-mono text-[12px] font-semibold">{d.index1}</span>
                                <span className="text-[10px] text-subtle">{String(d.index1_type || '').replace('_INDEX', '')}</span>
                              </span>
                            ),
                            second: (
                              <span className="flex flex-col">
                                <span className="font-mono text-[12px] font-semibold text-warning-fg">{d.index2}</span>
                                <span className="text-[10px] text-subtle">{String(d.index2_type || '').replace('_INDEX', '')}</span>
                              </span>
                            ),
                            keys: <span className="font-mono">{d.key_column_count}</span>,
                          },
                        };
                      })}
                      empty={<EmptyState icon="check"
                        title={duplicate.length ? 'No matches' : 'No overlapping indexes'}
                        body={duplicate.length ? undefined : 'No two indexes on the same table share a key-column count.'} />}
                    />
                    {page.some((d, i) => open === `dup-${d.table_name}-${d.index1}-${d.index2}-${i}`) && (
                      <div className="border-t border-border bg-sunken px-card py-3">
                        {page.map((d, i) => {
                          const key = `dup-${d.table_name}-${d.index1}-${d.index2}-${i}`;
                          if (open !== key) return null;
                          const sql = d.drop_hint
                            || `-- Verify the columns match before dropping:\nDROP INDEX ${bracket(d.index2)} ON [dbo].${bracket(d.table_name)};`;
                          return (
                            <div key={key} className="space-y-2">
                              <p className="text-[11px] font-bold tracking-wide text-subtle uppercase">
                                Suggested drop
                              </p>
                              <div className="flex items-start gap-2">
                                <SqlBlock sql={sql} className="flex-1" />
                                <CopyButton text={sql} />
                              </div>
                              <p className="text-[11px] text-muted">
                                Run <span className="font-mono">sp_helpindex &apos;{d.table_name}&apos;</span> and compare
                                the two key lists first. Identical counts often mean different columns.
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {pager}
                  </>
                )}
              </Paged>
            </>
          )}
        </TablePanel>

        <p className="flex items-start gap-1.5 text-[11px] text-subtle">
          <Icon name="info" size={12} className="mt-0.5 shrink-0" />
          All three lists cover the connected database only — SQL Server's index usage and
          missing-index DMVs are per-database. Point the connection at another database to
          analyse that one.
        </p>
      </div>
    </>
  );
}
