import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import client from '@/api/client';
import PageHeader from '@/components/layout/PageHeader';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import { dbError } from '@/lib/format';
import Select from '@/components/ui/Select';
import Table, { EmptyState, nextSort, sortRows } from '@/components/ui/Table';
import Tabs from '@/components/ui/Tabs';
import { PageLoading } from '@/components/ui/Loading';
import { Paged } from '@/components/ui/Pagination';
import { MetricTile, Panel, TablePanel } from '@/pages/_shared/enginePanels';
import { fmtBytes, fmtNumber } from '@/config/dbCatalog';
import { MAX_PARTS_WARN } from '@/config/clickhouseCatalog';

/**
 * ClickHouse table analysis — `system.parts`, `system.merges` and the per-table
 * rollups the collector derives from them.
 *
 * The one number here that becomes an outage is parts per table: ClickHouse delays
 * inserts past `parts_to_delay_insert` and rejects them past
 * `parts_to_throw_insert`, so that leads. Everything else on the page — sizes,
 * compression, merge progress — is context for why the count is where it is.
 *
 * The collector reads the 200 largest parts, so every parts-derived total is a
 * total *of those 200*, not of the server. That is stated wherever such a total is
 * shown rather than being left to look like a full picture.
 */

const PARTS_LIMIT = 200;
const num = (v) => Number(v) || 0;

/** Compression as `n×`, from a compressed/uncompressed pair. */
export function ratioOf(compressed, uncompressed) {
  const c = num(compressed);
  const u = num(uncompressed);
  return c > 0 && u > 0 ? u / c : null;
}

const ratioTone = (r) => (r == null ? 'neutral' : r >= 5 ? 'success' : r >= 2 ? 'accent' : 'neutral');

/** A merge that has been running a long time is the signal, not the merge itself. */
export function mergeTone(elapsedSec) {
  const s = num(elapsedSec);
  if (s > 600) return 'bad';
  if (s > 60) return 'warn';
  return 'neutral';
}

const TABS = [
  { id: 'pressure', label: 'Part pressure', icon: 'gauge' },
  { id: 'parts', label: 'Parts', icon: 'layers' },
  { id: 'merges', label: 'Merges', icon: 'branch' },
  { id: 'tables', label: 'Table stats', icon: 'table' },
  { id: 'compression', label: 'Compression', icon: 'archive' },
];

export default function ClickHouseTableAnalysis() {
  const { id } = useParams();
  const [tab, setTab] = useState('pressure');
  const [search, setSearch] = useState('');
  const [dbFilter, setDbFilter] = useState('');
  const [sort, setSort] = useState({ key: 'disk', dir: 'desc' });

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['chTableAnalysis', id],
    queryFn: () => client.get(`/connections/clickhouse/${id}/ch-table-analysis`).then((r) => r.data),
    retry: false,
    refetchInterval: 30000,
  });

  /* One memo above the early returns — a hook may not follow a conditional return. */
  const d = useMemo(() => {
    const parts = data?.parts || [];
    const merges = data?.merges || [];
    const tableStats = data?.table_stats || [];
    const compression = data?.compression || [];
    const summary = data?.summary || {};

    /* The server's own per-table counts, turned into a sortable list. Keys are
       "db.table"; the value is how many of the top-200 parts belong to it. */
    const pressure = Object.entries(summary.table_part_counts || {})
      .map(([key, count]) => {
        const dot = key.indexOf('.');
        const database = dot > 0 ? key.slice(0, dot) : '';
        const table = dot > 0 ? key.slice(dot + 1) : key;
        const comp = compression.find((c) => c.database === database && c.table === table);
        return {
          key,
          database,
          table,
          /* system.parts grouped without the LIMIT — the honest count where we have it. */
          parts: num(comp?.parts_count) || count,
          sampled: count,
          exact: comp?.parts_count != null,
          bytes: num(comp?.compressed),
          ratio: comp?.compression_ratio ?? null,
        };
      })
      .sort((a, b) => b.parts - a.parts);

    const databases = [...new Set([
      ...parts.map((p) => p.database),
      ...merges.map((m) => m.database),
      ...tableStats.map((t) => t.database),
      ...compression.map((c) => c.database),
    ].filter(Boolean))].sort();

    return {
      parts,
      merges,
      tableStats,
      compression,
      summary,
      pressure,
      databases,
      /* Capped list means "at least this many"; say so rather than implying a total. */
      capped: parts.length >= PARTS_LIMIT,
      worstParts: pressure[0] || null,
      longMerge: merges.reduce((worst, m) => (num(m.elapsed) > num(worst?.elapsed) ? m : worst), null),
    };
  }, [data]);

  const header = (
    <PageHeader
      title="ClickHouse Table Analysis"
      description="Parts, merges and compression per table"
      icon="layers"
      backTo={`/clickhouse-dashboard/${id}`}
      actions={(
        <Button variant="secondary" icon="refresh" loading={isFetching} onClick={() => refetch()}>
          Refresh
        </Button>
      )}
    />
  );

  if (isLoading) return <>{header}<PageLoading title="Reading system.parts…" /></>;

  if (error) {
    return (
      <>
        {header}
        <Notice tone="danger" title="Could not read the table analysis.">{error.message}</Notice>
        <Button variant="primary" icon="refresh" onClick={() => refetch()}>Retry</Button>
      </>
    );
  }

  const { parts, merges, tableStats, compression, summary, pressure, databases } = d;

  const term = search.trim().toLowerCase();
  const matches = (...fields) => !term || fields.some((f) => String(f || '').toLowerCase().includes(term));
  const inDb = (row) => !dbFilter || row.database === dbFilter;

  const filteredParts = parts.filter((p) => inDb(p) && matches(p.table, p.database, p.partition));
  const filteredMerges = merges.filter((m) => inDb(m) && matches(m.table, m.database));
  const filteredTables = tableStats.filter((t) => inDb(t) && matches(t.table_name, t.database, t.engine));
  const filteredCompression = compression.filter((c) => inDb(c) && matches(c.table, c.database));
  const filteredPressure = pressure.filter((p) => inDb(p) && matches(p.table, p.database));

  const overThreshold = pressure.filter((p) => p.parts > MAX_PARTS_WARN);
  const ratio = summary.compression_ratio;

  return (
    <>
      {header}

      {data?.status === 'partial' && data?.errors && (
        <Notice tone="warning" title="Some system tables could not be read.">
          <span className="flex flex-col gap-0.5">
            {Object.entries(data.errors).map(([src, msg]) => (
              <span key={src}>
                <code className="font-mono">system.{src === 'table_stats' ? 'tables' : src}</code>:{' '}
                <span className="clamp-2" title={String(msg)}>{dbError(msg)}</span>
              </span>
            ))}
          </span>
        </Notice>
      )}

      <div className="space-y-gutter">
        <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4 xl:grid-cols-5">
          <MetricTile
            label="Tables over the part limit"
            value={overThreshold.length}
            icon="gauge"
            tone={overThreshold.length ? 'bad' : 'good'}
            hint={`More than ${MAX_PARTS_WARN} active parts — ClickHouse starts delaying inserts here`}
            onClick={() => setTab('pressure')}
          />
          <MetricTile
            label="Active merges"
            value={summary.active_merges ?? merges.length}
            icon="branch"
            tone={merges.length > 15 ? 'warn' : 'neutral'}
            onClick={() => setTab('merges')}
          />
          <MetricTile
            label="Tables with parts"
            value={summary.tables_with_parts ?? pressure.length}
            icon="table"
          />
          <MetricTile
            label={d.capped ? `On disk (top ${PARTS_LIMIT} parts)` : 'On disk'}
            value={summary.total_bytes_on_disk_human || fmtBytes(summary.total_bytes_on_disk)}
            icon="database"
            sub={d.capped ? 'not the server total' : undefined}
          />
          <MetricTile
            label="Compression"
            value={ratio != null ? `${ratio}×` : '—'}
            icon="archive"
            tone={ratio != null && ratio >= 3 ? 'good' : 'neutral'}
            sub={summary.total_uncompressed_bytes
              ? `${fmtBytes(summary.total_uncompressed_bytes)} → ${fmtBytes(summary.total_compressed_bytes)}`
              : undefined}
          />
        </div>

        {overThreshold.length > 0 && (
          <Notice
            tone={overThreshold.some((p) => p.parts > MAX_PARTS_WARN * 2) ? 'danger' : 'warning'}
            title={`${overThreshold.length} table${overThreshold.length === 1 ? '' : 's'} holding more than ${MAX_PARTS_WARN} active parts.`}
          >
            {overThreshold.slice(0, 3).map((p) => `${p.database}.${p.table} (${fmtNumber(p.parts)})`).join(', ')}
            {overThreshold.length > 3 ? ` and ${overThreshold.length - 3} more` : ''}.
            {' '}Parts accumulate when inserts arrive faster than background merges can combine them — usually
            many small inserts instead of batched ones. ClickHouse delays inserts as the count climbs and
            eventually rejects them with <span className="font-mono">TOO_MANY_PARTS</span>, so this is the
            number to act on: batch the writes, or check whether merges are starved of threads.
          </Notice>
        )}

        {d.longMerge && num(d.longMerge.elapsed) > 600 && (
          <Notice tone="warning" title="A merge has been running for a long time.">
            <span className="font-mono">{d.longMerge.database}.{d.longMerge.table}</span> has been merging
            for {Math.round(num(d.longMerge.elapsed) / 60)} minutes
            ({Math.round(num(d.longMerge.progress) * 100)}% done). Large merges are normal on big partitions,
            but one that stalls holds parts open and keeps the count above.
          </Notice>
        )}

        <TablePanel
          title="Details"
          icon="layers"
          actions={(
            <>
              {databases.length > 0 && (
                <Select
                  value={dbFilter}
                  onChange={setDbFilter}
                  options={[
                    { id: '', label: 'All databases' },
                    ...databases.map((x) => ({ id: x, label: x })),
                  ]}
                  size="sm"
                  width="auto"
                />
              )}
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onClear={() => setSearch('')}
                placeholder="Table, database or partition…"
                icon="search"
                size="sm"
                wrapperClassName="w-52"
              />
            </>
          )}
        >
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={TABS.map((t) => ({
              ...t,
              count: {
                pressure: pressure.length,
                parts: parts.length,
                merges: merges.length,
                tables: tableStats.length,
                compression: compression.length,
              }[t.id],
              tone: t.id === 'pressure' && overThreshold.length ? 'danger' : undefined,
            }))}
            className="px-card"
          />

          {tab === 'pressure' && (
            <PressureTab rows={filteredPressure} total={pressure.length} capped={d.capped} />
          )}
          {tab === 'parts' && (
            <PartsTab
              rows={filteredParts}
              total={parts.length}
              sort={sort}
              onSort={(key) => setSort((cur) => nextSort(cur, key))}
              capped={d.capped}
            />
          )}
          {tab === 'merges' && <MergesTab rows={filteredMerges} total={merges.length} />}
          {tab === 'tables' && <TableStatsTab rows={filteredTables} total={tableStats.length} />}
          {tab === 'compression' && <CompressionTab rows={filteredCompression} total={compression.length} />}
        </TablePanel>

        <Panel className="bg-sunken">
          <div className="space-y-1.5 text-[11px] leading-relaxed text-muted">
            <p className="flex items-start gap-1.5">
              <Icon name="info" size={12} className="mt-0.5 shrink-0" />
              <span>
                <span className="font-semibold text-fg">Parts</span> lists the {PARTS_LIMIT} largest
                active parts, so its rows are the biggest ones — not every part. Part <em>counts</em> in
                Part pressure and Compression come from a grouped query without that limit, so they are
                the real counts.
              </span>
            </p>
            <p className="flex items-start gap-1.5">
              <Icon name="info" size={12} className="mt-0.5 shrink-0" />
              <span>
                <span className="font-semibold text-fg">Table stats</span> covers MergeTree-family tables
                only — a Distributed, View or Log table has no parts to analyse.
              </span>
            </p>
          </div>
        </Panel>
      </div>
    </>
  );
}

/* ── part pressure ────────────────────────────────────────────────────────── */

function PressureTab({ rows, total, capped }) {
  const max = Math.max(MAX_PARTS_WARN, ...rows.map((r) => r.parts), 1);

  return (
    <Paged rows={rows} unit="tables">
      {(page, pager) => (
        <>
          <Table
            columns={[
              { key: 'table', label: 'Table' },
              { key: 'parts', label: 'Active parts', align: 'right' },
              { key: 'bar', label: `Against ${MAX_PARTS_WARN}` },
              { key: 'bytes', label: 'Compressed', align: 'right' },
              { key: 'ratio', label: 'Compression', align: 'right' },
              { key: 'verdict', label: 'Verdict' },
            ]}
            rows={page.map((r) => {
              const pct = Math.min(100, (r.parts / max) * 100);
              const over = r.parts > MAX_PARTS_WARN;
              const severe = r.parts > MAX_PARTS_WARN * 2;
              return {
                key: r.key,
                cells: {
                  table: (
                    <span className="flex flex-col gap-0.5">
                      <span className="font-semibold text-accent-text">{r.table}</span>
                      <span className="font-mono text-[10px] text-subtle">{r.database}</span>
                    </span>
                  ),
                  parts: (
                    <span className={over ? 'font-mono font-bold text-danger-fg' : 'font-mono font-semibold'}>
                      {fmtNumber(r.parts)}
                    </span>
                  ),
                  bar: (
                    <span className="flex items-center gap-2">
                      <span className="relative h-1.5 w-32 shrink-0 overflow-hidden rounded-full bg-sunken">
                        <span
                          className={`block h-full rounded-full ${severe ? 'bg-danger' : over ? 'bg-warning' : 'bg-accent'}`}
                          style={{ width: `${Math.max(pct, r.parts > 0 ? 2 : 0)}%` }}
                        />
                        {/* the threshold marker, so the bar is read against a limit not a maximum */}
                        <span
                          className="absolute top-0 h-full w-px bg-strong"
                          style={{ left: `${(MAX_PARTS_WARN / max) * 100}%` }}
                        />
                      </span>
                    </span>
                  ),
                  bytes: <span className="font-mono text-[12px] text-muted">{r.bytes ? fmtBytes(r.bytes) : null}</span>,
                  ratio: r.ratio == null ? null : (
                    <Badge tone={ratioTone(r.ratio)} size="xs">{r.ratio}×</Badge>
                  ),
                  verdict: severe
                    ? <Badge tone="danger" size="xs"><Icon name="alert" size={9} />Inserts at risk</Badge>
                    : over
                      ? <Badge tone="warning" size="xs"><Icon name="alert" size={9} />High</Badge>
                      : <Badge tone="success" size="xs"><Icon name="check" size={9} />Healthy</Badge>,
                },
              };
            })}
            empty={total ? (
              <EmptyState icon="filter" title="No matches" body="No table matches the filters." />
            ) : (
              <EmptyState icon="check" title="No parts"
                body="No MergeTree table on this server holds active parts." />
            )}
          />
          {capped && rows.length > 0 && (
            <p className="border-t border-border px-card py-2 text-[11px] text-subtle">
              Counts come from a grouped <span className="font-mono">system.parts</span> query where
              available, so they are not limited by the parts sample.
            </p>
          )}
          {pager}
        </>
      )}
    </Paged>
  );
}

/* ── parts ────────────────────────────────────────────────────────────────── */

function PartsTab({ rows, total, sort, onSort, capped }) {
  const max = Math.max(...rows.map((p) => num(p.bytes_on_disk)), 1);

  const tableRows = sortRows(rows.map((p, i) => {
    const r = ratioOf(p.data_compressed_bytes, p.data_uncompressed_bytes);
    const disk = num(p.bytes_on_disk);
    return {
      key: `${p.database}.${p.table}.${p.partition}.${i}`,
      sort: {
        table: `${p.database}.${p.table}`,
        rows: num(p.rows),
        disk,
        uncompressed: num(p.data_uncompressed_bytes),
        ratio: r ?? 0,
        marks: num(p.marks),
      },
      cells: {
        table: (
          <span className="flex flex-col gap-0.5">
            <span className="font-semibold text-accent-text">{p.table}</span>
            <span className="font-mono text-[10px] text-subtle">{p.database}</span>
          </span>
        ),
        partition: (
          <span className="font-mono text-[11px] text-muted">{p.partition || p.partition_id || null}</span>
        ),
        rows: <span className="font-mono">{fmtNumber(p.rows)}</span>,
        disk: (
          <span className="flex items-center justify-end gap-2">
            <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-sunken">
              <span className="block h-full rounded-full bg-accent"
                style={{ width: `${Math.max((disk / max) * 100, disk > 0 ? 2 : 0)}%` }} />
            </span>
            <span className="font-mono whitespace-nowrap tabular-nums">{fmtBytes(disk)}</span>
          </span>
        ),
        uncompressed: (
          <span className="font-mono text-[12px] text-muted">{fmtBytes(p.data_uncompressed_bytes)}</span>
        ),
        ratio: r == null ? null : <Badge tone={ratioTone(r)} size="xs">{r.toFixed(2)}×</Badge>,
        marks: <span className="font-mono text-[12px] text-muted">{fmtNumber(p.marks)}</span>,
      },
    };
  }), sort);

  return (
    <Paged rows={tableRows} unit="parts">
      {(page, pager) => (
        <>
          <Table
            columns={[
              { key: 'table', label: 'Table', sortable: true },
              { key: 'partition', label: 'Partition' },
              { key: 'rows', label: 'Rows', align: 'right', sortable: true },
              { key: 'disk', label: 'On disk', align: 'right', sortable: true },
              { key: 'uncompressed', label: 'Uncompressed', align: 'right', sortable: true },
              { key: 'ratio', label: 'Ratio', align: 'right', sortable: true },
              {
                key: 'marks',
                label: 'Marks',
                align: 'right',
                sortable: true,
                hint: 'Index marks in the part — one per granule, so roughly rows ÷ 8192.',
              },
            ]}
            rows={page}
            sort={sort}
            onSort={onSort}
            empty={total ? (
              <EmptyState icon="filter" title="No matches" body="No part matches the filters." />
            ) : (
              <EmptyState icon="check" title="No parts" body="system.parts returned no active parts." />
            )}
          />
          {capped && (
            <p className="border-t border-border px-card py-2 text-[11px] text-subtle">
              The {PARTS_LIMIT} largest active parts. Smaller parts are not listed — and it is the small
              ones that pile up, so read Part pressure for counts.
            </p>
          )}
          {pager}
        </>
      )}
    </Paged>
  );
}

/* ── merges ───────────────────────────────────────────────────────────────── */

function MergesTab({ rows, total }) {
  const TONE_CLASS = {
    bad: 'font-mono font-bold text-danger-fg',
    warn: 'font-mono font-bold text-warning-fg',
    neutral: 'font-mono font-semibold',
  };

  return (
    <>
      {total > 15 && (
        <Notice tone="warning" className="mx-card mt-3 mb-0"
          title={`${total} merges running at once.`}>
          A deep merge queue means inserts are outpacing merges. Batch the writes, or raise
          <span className="font-mono"> background_pool_size</span> if the server has headroom for it.
        </Notice>
      )}
      <Paged rows={rows} unit="merges">
        {(page, pager) => (
          <>
            <Table
              columns={[
                { key: 'table', label: 'Table' },
                { key: 'elapsed', label: 'Running for', align: 'right' },
                { key: 'progress', label: 'Progress' },
                { key: 'parts', label: 'Parts merging', align: 'right' },
                { key: 'read', label: 'Rows read', align: 'right' },
                { key: 'written', label: 'Rows written', align: 'right' },
                {
                  key: 'shrink',
                  label: 'Rows collapsed',
                  align: 'right',
                  hint: 'Read minus written — how many rows the merge is removing. Only a Replacing, '
                    + 'Collapsing, Summing or Aggregating engine should show a number here.',
                },
              ]}
              rows={page.map((m, i) => {
                const elapsed = num(m.elapsed);
                const pct = Math.round(num(m.progress) * 100);
                const read = num(m.rows_read);
                const written = num(m.rows_written);
                const collapsed = read - written;
                return {
                  key: `${m.database}.${m.table}.${i}`,
                  cells: {
                    table: (
                      <span className="flex flex-col gap-0.5">
                        <span className="font-semibold text-accent-text">{m.table}</span>
                        <span className="font-mono text-[10px] text-subtle">{m.database}</span>
                      </span>
                    ),
                    elapsed: (
                      <span className={TONE_CLASS[mergeTone(elapsed)]}>
                        {elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${Math.round(elapsed % 60)}s` : `${elapsed.toFixed(1)}s`}
                      </span>
                    ),
                    progress: (
                      <span className="flex items-center gap-2">
                        <span className="h-2 w-24 shrink-0 overflow-hidden rounded-full bg-sunken">
                          <span
                            className={`block h-full rounded-full ${pct >= 80 ? 'bg-success' : 'bg-accent'}`}
                            style={{ width: `${Math.max(pct, 2)}%` }}
                          />
                        </span>
                        <span className="font-mono text-[12px] font-semibold tabular-nums">{pct}%</span>
                      </span>
                    ),
                    parts: <span className="font-mono">{m.num_parts || null}</span>,
                    read: <span className="font-mono text-[12px] text-muted">{fmtNumber(read)}</span>,
                    written: <span className="font-mono text-[12px] text-muted">{fmtNumber(written)}</span>,
                    shrink: collapsed > 0 && written > 0
                      ? (
                        <span className="font-mono text-[12px] text-muted">
                          {fmtNumber(collapsed)}
                          <span className="ml-1 text-[10px] text-subtle">
                            ({Math.round((collapsed / read) * 100)}%)
                          </span>
                        </span>
                      )
                      : null,
                  },
                };
              })}
              empty={total ? (
                <EmptyState icon="filter" title="No matches" body="No merge matches the filters." />
              ) : (
                <EmptyState icon="check" title="No merges running"
                  body="Nothing in system.merges. On an idle server this is normal and healthy — it is a snapshot, not a history." />
              )}
            />
            {pager}
          </>
        )}
      </Paged>
    </>
  );
}

/* ── table stats ──────────────────────────────────────────────────────────── */

function TableStatsTab({ rows, total }) {
  const max = Math.max(...rows.map((t) => num(t.total_bytes)), 1);

  return (
    <Paged rows={rows} unit="tables">
      {(page, pager) => (
        <>
          <Table
            columns={[
              { key: 'table', label: 'Table' },
              { key: 'engine', label: 'Engine' },
              { key: 'rows', label: 'Rows', align: 'right' },
              { key: 'size', label: 'On disk', align: 'right' },
              { key: 'avg', label: 'Bytes per row', align: 'right' },
            ]}
            rows={page.map((t, i) => {
              /* The collector aliases system.tables.name to `table_name`; reading
                 `name` here would leave the column blank on every row. */
              const name = t.table_name || t.name || '';
              const bytes = num(t.total_bytes);
              const rowCount = num(t.total_rows);
              return {
                key: `${t.database}.${name}.${i}`,
                cells: {
                  table: (
                    <span className="flex flex-col gap-0.5">
                      <span className="font-semibold text-accent-text">{name}</span>
                      <span className="font-mono text-[10px] text-subtle">{t.database}</span>
                    </span>
                  ),
                  engine: t.engine
                    ? <Badge tone={String(t.engine).startsWith('Replicated') ? 'info' : 'accent'} size="xs">{t.engine}</Badge>
                    : null,
                  rows: <span className="font-mono">{fmtNumber(rowCount)}</span>,
                  size: (
                    <span className="flex items-center justify-end gap-2">
                      <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-sunken">
                        <span className="block h-full rounded-full bg-accent"
                          style={{ width: `${Math.max((bytes / max) * 100, bytes > 0 ? 2 : 0)}%` }} />
                      </span>
                      <span className="font-mono whitespace-nowrap tabular-nums">
                        {t.size_pretty || fmtBytes(bytes)}
                      </span>
                    </span>
                  ),
                  avg: rowCount > 0
                    ? <span className="font-mono text-[12px] text-muted">{fmtBytes(bytes / rowCount)}</span>
                    : null,
                },
              };
            })}
            empty={total ? (
              <EmptyState icon="filter" title="No matches" body="No table matches the filters." />
            ) : (
              <EmptyState icon="table" title="No MergeTree tables"
                body="system.tables holds no MergeTree-family table outside the system databases." />
            )}
          />
          {pager}
        </>
      )}
    </Paged>
  );
}

/* ── compression ──────────────────────────────────────────────────────────── */

function CompressionTab({ rows, total }) {
  return (
    <Paged rows={rows} unit="tables">
      {(page, pager) => (
        <>
          <Table
            columns={[
              { key: 'table', label: 'Table' },
              { key: 'uncompressed', label: 'Uncompressed', align: 'right' },
              { key: 'compressed', label: 'On disk', align: 'right' },
              { key: 'saved', label: 'Saved', align: 'right' },
              { key: 'ratio', label: 'Ratio', align: 'right' },
              { key: 'parts', label: 'Parts', align: 'right' },
            ]}
            rows={page.map((c, i) => {
              const pct = num(c.savings_pct);
              return {
                key: `${c.database}.${c.table}.${i}`,
                cells: {
                  table: (
                    <span className="flex flex-col gap-0.5">
                      <span className="font-semibold text-accent-text">{c.table}</span>
                      <span className="font-mono text-[10px] text-subtle">{c.database}</span>
                    </span>
                  ),
                  uncompressed: (
                    <span className="font-mono text-[12px] text-muted">
                      {c.uncompressed_human || fmtBytes(c.uncompressed)}
                    </span>
                  ),
                  compressed: (
                    <span className="font-mono font-semibold whitespace-nowrap tabular-nums">
                      {c.compressed_human || fmtBytes(c.compressed)}
                    </span>
                  ),
                  saved: (
                    <span className="flex items-center justify-end gap-2">
                      <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-sunken">
                        <span className="block h-full rounded-full bg-success"
                          style={{ width: `${Math.max(Math.min(100, pct), pct > 0 ? 2 : 0)}%` }} />
                      </span>
                      <span className="font-mono text-[12px] tabular-nums">{pct}%</span>
                    </span>
                  ),
                  ratio: c.compression_ratio == null ? null : (
                    <Badge tone={ratioTone(c.compression_ratio)} size="xs">{c.compression_ratio}×</Badge>
                  ),
                  parts: (
                    <span className={num(c.parts_count) > MAX_PARTS_WARN
                      ? 'font-mono font-bold text-danger-fg' : 'font-mono text-[12px] text-muted'}>
                      {fmtNumber(c.parts_count)}
                    </span>
                  ),
                },
              };
            })}
            empty={total ? (
              <EmptyState icon="filter" title="No matches" body="No table matches the filters." />
            ) : (
              <EmptyState icon="archive" title="No compression data"
                body="system.parts returned nothing to aggregate." />
            )}
          />
          {rows.length > 0 && (
            <p className="border-t border-border px-card py-2 text-[11px] text-subtle">
              Largest by uncompressed size, capped at 100 tables. A low ratio on a large table is worth a
              look: a column-appropriate codec (Delta, DoubleDelta, Gorilla for numeric series; LowCardinality
              for repeated strings) usually beats the default LZ4 by a wide margin.
            </p>
          )}
          {pager}
        </>
      )}
    </Paged>
  );
}
