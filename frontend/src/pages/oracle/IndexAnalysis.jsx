import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import cn from '@/lib/cn';
import client from '@/api/client';
import PageHeader from '@/components/layout/PageHeader';
import ChartCard from '@/components/charts/ChartCard';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import CopyButton from '@/components/ui/CopyButton';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Select from '@/components/ui/Select';
import Table, { EmptyState } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';
import { Paged } from '@/components/ui/Pagination';
import { MetricTile, Panel, SqlBlock, StatCell, TablePanel } from '@/pages/_shared/enginePanels';
import { fmtNumber } from '@/config/dbCatalog';

/**
 * Oracle index analysis — the inventory, the ones that are unusable, and the ones
 * whose B-tree has grown deep enough to be worth rebuilding.
 *
 * On the fragmentation figure: the backend derives it from BLEVEL, the height of
 * the B-tree. That is a proxy, not a measurement — a deep index is usually a bloated
 * one, but the only way to know how much space would actually be reclaimed is
 * `ANALYZE INDEX … VALIDATE STRUCTURE`. The page says so, because the action it
 * leads to (a rebuild) locks the index.
 */

const num = (v) => Number(v) || 0;
const quote = (s) => `"${String(s || '').replace(/"/g, '')}"`;

const INDEX_STATUS_TONES = { VALID: 'success', UNUSABLE: 'danger', 'N/A': 'neutral' };

/** REBUILD ONLINE, because the offline form locks the table for writes. */
export function rebuildStatement(ix) {
  return `ALTER INDEX ${quote(ix.owner)}.${quote(ix.index_name)} REBUILD ONLINE;`;
}

/** What to run before rebuilding, so the decision rests on a measurement. */
export function validateStatement(ix) {
  return [
    `-- Measure first: this populates INDEX_STATS for one index at a time.`,
    `ANALYZE INDEX ${quote(ix.owner)}.${quote(ix.index_name)} VALIDATE STRUCTURE;`,
    `SELECT name, height, lf_rows, del_lf_rows,`,
    `       ROUND(del_lf_rows / NULLIF(lf_rows, 0) * 100, 1) AS pct_deleted`,
    `FROM   index_stats;`,
  ].join('\n');
}

const TABS = [
  { id: 'fragmented', label: 'Deep B-trees', icon: 'trend' },
  { id: 'unusable', label: 'Unusable', icon: 'alert' },
  { id: 'all', label: 'All indexes', icon: 'layers' },
];

export default function OracleIndexAnalysis() {
  const { id } = useParams();
  const [tab, setTab] = useState('fragmented');
  const [search, setSearch] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [open, setOpen] = useState(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['oracleIndexAnalysis', id],
    queryFn: () => client.get(`/connections/oracle/${id}/oracle-index-analysis`).then((r) => r.data),
    retry: false,
    refetchInterval: 60000,
  });

  const indexes = useMemo(() => data?.indexes || [], [data]);
  const fragmented = useMemo(() => data?.fragmented_indexes || [], [data]);
  const unusable = useMemo(() => indexes.filter((i) => i.status === 'UNUSABLE'), [indexes]);
  const summary = data?.summary || {};
  const partialErrors = (data?.errors || []).filter(Boolean);

  const ownerOptions = useMemo(() => ([
    { id: '', label: 'All schemas' },
    ...[...new Set(indexes.map((i) => i.owner).filter(Boolean))].sort()
      .map((o) => ({ id: o, label: o })),
  ]), [indexes]);

  const byOwner = useMemo(() => {
    const acc = {};
    indexes.forEach((i) => { acc[i.owner] = (acc[i.owner] || 0) + 1; });
    return Object.entries(acc).sort((a, b) => b[1] - a[1])
      .map(([owner, count]) => ({ key: owner, label: owner, value: count }));
  }, [indexes]);

  const term = search.trim().toLowerCase();
  const match = (...fields) => !term || fields.some((f) => String(f || '').toLowerCase().includes(term));
  const byOwnerFilter = (row) => !ownerFilter || row.owner === ownerFilter;

  const shown = {
    fragmented: fragmented.filter((f) => byOwnerFilter(f) && match(f.index_name, f.table_name)),
    unusable: unusable.filter((u) => byOwnerFilter(u) && match(u.index_name, u.table_name)),
    all: indexes.filter((i) => byOwnerFilter(i) && match(i.index_name, i.table_name)),
  }[tab];

  const counts = { fragmented: fragmented.length, unusable: unusable.length, all: indexes.length };

  const header = (
    <PageHeader
      title="Oracle Index Analysis"
      description="dba_indexes across user schemas — inventory, unusable indexes and deep B-trees"
      icon="layers"
      backTo={`/oracle-dashboard/${id}`}
      actions={(
        <Button variant="secondary" icon="refresh" loading={isFetching} onClick={() => refetch()}>
          Refresh
        </Button>
      )}
    />
  );

  if (isLoading) return <>{header}<PageLoading title="Reading dba_indexes…" /></>;

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
        <Notice tone="warning" title="Some checks could not run.">{partialErrors.join(' · ')}</Notice>
      )}

      <div className="space-y-gutter">
        <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-3 xl:grid-cols-5">
          <MetricTile label="Indexes" value={fmtNumber(summary.total_indexes ?? indexes.length)} icon="layers" />
          <MetricTile label="Unique" value={fmtNumber(summary.unique_indexes)} icon="key" />
          <MetricTile label="Non-unique" value={fmtNumber(summary.non_unique_indexes)} icon="layers" />
          <MetricTile label="Unusable" value={summary.unusable_indexes ?? unusable.length} icon="alert"
            tone={num(summary.unusable_indexes ?? unusable.length) ? 'bad' : 'good'}
            hint="An UNUSABLE index is ignored by the optimiser and not maintained by DML" />
          <MetricTile label="Deep B-trees" value={summary.fragmented_indexes ?? fragmented.length} icon="trend"
            tone={num(summary.fragmented_indexes ?? fragmented.length) ? 'warn' : 'good'}
            hint="BLEVEL 3 or more — worth measuring before rebuilding" />
        </div>

        {unusable.length > 0 && (
          <Notice tone="danger" title={`${unusable.length} index${unusable.length === 1 ? ' is' : 'es are'} UNUSABLE.`}>
            The optimiser will not use them and DML does not maintain them, so queries that should
            be seeking are scanning instead. A unique or primary-key index in this state also stops
            inserts. Rebuild them: {unusable.slice(0, 3).map((u) => `${u.owner}.${u.index_name}`).join(', ')}
            {unusable.length > 3 ? ` and ${unusable.length - 3} more` : ''}.
          </Notice>
        )}

        <div className="grid gap-gutter xl:grid-cols-2">
          <ChartCard
            cardId="oracle-indexes-by-owner"
            family="flat"
            items={byOwner.slice(0, 10)}
            chartProps={{ format: fmtNumber, labelWidth: 140, emptyLabel: 'No indexes found' }}
            title="Indexes by schema"
            icon="layers"
            subtitle="Where the indexes live"
            loading={isFetching}
            tableColumns={[
              { key: 'owner', label: 'Schema' },
              { key: 'count', label: 'Indexes', align: 'right' },
            ]}
            tableRows={byOwner.map((o) => ({ key: o.key, cells: { owner: o.label, count: o.value } }))}
          />

          <Panel title="How to read the fragmentation figure" icon="info"
            subtitle="It matters, because acting on it means locking an index">
            <p className="text-[12px] leading-relaxed text-fg">
              The percentage comes from <span className="font-mono">BLEVEL</span>, the height of the
              B-tree — the collector derives it as
              {' '}<span className="font-mono">100 × (1 − 1/2^blevel)</span>. A deep index is usually
              a bloated one, but height is a <b>proxy</b>: it does not measure how much space a
              rebuild would actually reclaim.
            </p>
            <p className="mt-2 text-[12px] leading-relaxed text-fg">
              Before rebuilding, measure. The Validate statement on each row populates
              {' '}<span className="font-mono">INDEX_STATS</span>, where
              {' '}<span className="font-mono">del_lf_rows / lf_rows</span> is the real deleted-space
              figure. Rebuild when that is over roughly 20%.
            </p>
            <div className="mt-3 grid gap-gutter-sm sm:grid-cols-3">
              <StatCell label="BLEVEL 3" value="87.5%" hint="Normal for a large index" />
              <StatCell label="BLEVEL 4" value="93.8%" hint="Large, or possibly bloated" />
              <StatCell label="BLEVEL 5+" value="96.9%+" hint="Worth measuring" />
            </div>
          </Panel>
        </div>

        <TablePanel
          title="Findings"
          icon="layers"
          subtitle="Select a row for the statements to run"
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
              <Select value={ownerFilter} onChange={setOwnerFilter} options={ownerOptions} size="sm" width="auto" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onClear={() => setSearch('')}
                placeholder="Index or table…"
                icon="search"
                size="sm"
                wrapperClassName="w-40"
              />
            </>
          )}
        >
          {tab === 'fragmented' && (
            <Paged rows={shown} unit="indexes">
              {(page, pager) => (
                <>
                  <Table
                    columns={[
                      { key: 'index', label: 'Index' },
                      { key: 'table', label: 'Table' },
                      { key: 'blevel', label: 'B-tree height', align: 'right' },
                      { key: 'leaf', label: 'Leaf blocks', align: 'right' },
                      { key: 'pct', label: 'Derived fragmentation', align: 'right' },
                    ]}
                    rows={page.map((f, i) => {
                      const key = `frag-${f.owner}-${f.index_name}-${i}`;
                      const pct = num(f.fragmentation_pct);
                      return {
                        key,
                        onClick: () => setOpen(open === key ? null : key),
                        cells: {
                          index: (
                            <span className="block">
                              <span className="font-mono text-[12px] font-semibold text-accent-text">{f.index_name}</span>
                              <span className="mt-0.5 block font-mono text-[10px] text-subtle">{f.owner}</span>
                            </span>
                          ),
                          table: <span className="font-mono text-[12px]">{f.table_name}</span>,
                          blevel: (
                            <span className={num(f.blevel) >= 5 ? 'font-mono font-bold text-danger-fg' : 'font-mono font-semibold'}>
                              {f.blevel}
                            </span>
                          ),
                          leaf: <span className="font-mono">{fmtNumber(f.leaf_blocks)}</span>,
                          pct: (
                            <span className="inline-flex items-center gap-1.5">
                              <span className="font-mono">{pct}%</span>
                              <abbr title="Derived from BLEVEL, not measured. Validate first."
                                className="cursor-help no-underline">
                                <Icon name="info" size={10} className="text-subtle" />
                              </abbr>
                            </span>
                          ),
                        },
                      };
                    })}
                    empty={<EmptyState icon="check"
                      title={fragmented.length ? 'No matches' : 'No deep B-trees'}
                      body={fragmented.length ? undefined : 'No index has a BLEVEL of 3 or more, so none is a rebuild candidate on this measure.'} />}
                  />
                  <ExpandedDetail rows={page} open={open}
                    keyOf={(f, i) => `frag-${f.owner}-${f.index_name}-${i}`}
                    render={(f) => <RebuildAdvice ix={f} />} />
                  {pager}
                </>
              )}
            </Paged>
          )}

          {tab === 'unusable' && (
            <Paged rows={shown} unit="indexes">
              {(page, pager) => (
                <>
                  <Table
                    columns={[
                      { key: 'index', label: 'Index' },
                      { key: 'table', label: 'Table' },
                      { key: 'type', label: 'Type' },
                      { key: 'unique', label: 'Unique' },
                      { key: 'rows', label: 'Rows (stats)', align: 'right' },
                    ]}
                    rows={page.map((u, i) => {
                      const key = `unusable-${u.owner}-${u.index_name}-${i}`;
                      return {
                        key,
                        onClick: () => setOpen(open === key ? null : key),
                        cells: {
                          index: (
                            <span className="block">
                              <span className="font-mono text-[12px] font-semibold text-danger-fg">{u.index_name}</span>
                              <span className="mt-0.5 block font-mono text-[10px] text-subtle">{u.owner}</span>
                            </span>
                          ),
                          table: <span className="font-mono text-[12px]">{u.table_name}</span>,
                          type: <Badge tone="neutral" size="xs">{u.index_type}</Badge>,
                          unique: u.uniqueness === 'UNIQUE'
                            ? <Badge tone="warning" size="xs">Unique — blocks inserts</Badge>
                            : <Badge tone="neutral" size="xs">Non-unique</Badge>,
                          rows: <span className="font-mono">{fmtNumber(u.num_rows)}</span>,
                        },
                      };
                    })}
                    empty={<EmptyState icon="check"
                      title={unusable.length ? 'No matches' : 'Every index is usable'}
                      body={unusable.length ? undefined : 'No index is in the UNUSABLE state.'} />}
                  />
                  <ExpandedDetail rows={page} open={open}
                    keyOf={(u, i) => `unusable-${u.owner}-${u.index_name}-${i}`}
                    render={(u) => (
                      <div className="space-y-2">
                        <Notice tone="danger" className="mb-0" title="This index is not being used or maintained.">
                          {u.uniqueness === 'UNIQUE'
                            ? 'Because it is unique, inserts and updates that would need to check it fail outright.'
                            : 'Queries that would have used it are scanning instead.'}
                          {' '}An index usually becomes unusable after a partition operation or a
                          direct-path load.
                        </Notice>
                        <p className="text-[11px] font-bold tracking-wide text-subtle uppercase">Rebuild</p>
                        <div className="flex items-start gap-2">
                          <SqlBlock sql={rebuildStatement(u)} className="flex-1" />
                          <CopyButton text={rebuildStatement(u)} />
                        </div>
                        <p className="text-[11px] text-muted">
                          <span className="font-mono">ONLINE</span> keeps the table writable while it
                          rebuilds, at the cost of taking longer and using more temp space.
                        </p>
                      </div>
                    )} />
                  {pager}
                </>
              )}
            </Paged>
          )}

          {tab === 'all' && (
            <Paged rows={shown} unit="indexes">
              {(page, pager) => (
                <>
                  <Table
                    columns={[
                      { key: 'index', label: 'Index' },
                      { key: 'table', label: 'Table' },
                      { key: 'type', label: 'Type' },
                      { key: 'unique', label: 'Unique' },
                      { key: 'status', label: 'Status' },
                      { key: 'rows', label: 'Rows (stats)', align: 'right' },
                      { key: 'leaf', label: 'Leaf blocks', align: 'right' },
                    ]}
                    rows={page.map((ix, i) => ({
                      key: `all-${ix.owner}-${ix.index_name}-${i}`,
                      cells: {
                        index: (
                          <span className="block">
                            <span className="font-mono text-[12px] font-semibold text-accent-text">{ix.index_name}</span>
                            <span className="mt-0.5 block font-mono text-[10px] text-subtle">{ix.owner}</span>
                          </span>
                        ),
                        table: <span className="font-mono text-[12px]">{ix.table_name}</span>,
                        type: <Badge tone="neutral" size="xs">{ix.index_type}</Badge>,
                        unique: ix.uniqueness === 'UNIQUE'
                          ? <Badge tone="info" size="xs">Unique</Badge> : null,
                        status: (
                          <Badge tone={INDEX_STATUS_TONES[ix.status] || 'neutral'} size="xs">
                            {ix.status}
                          </Badge>
                        ),
                        rows: <span className="font-mono">{fmtNumber(ix.num_rows)}</span>,
                        leaf: <span className="font-mono text-[12px] text-muted">{fmtNumber(ix.leaf_blocks)}</span>,
                      },
                    }))}
                    empty={<EmptyState icon="layers"
                      title={indexes.length ? 'No matches' : 'No indexes'}
                      body={indexes.length ? undefined : 'dba_indexes returned nothing for the user schemas — the login may lack SELECT on the DBA views.'} />}
                  />
                  {pager}
                </>
              )}
            </Paged>
          )}
        </TablePanel>

        <p className="flex items-start gap-1.5 text-[11px] text-subtle">
          <Icon name="info" size={12} className="mt-0.5 shrink-0" />
          Row counts and leaf-block counts come from optimiser statistics, so an index on a table
          that has not been analysed recently will report stale numbers.
        </p>
      </div>
    </>
  );
}

/** Renders one expanded row's detail beneath the table. */
function ExpandedDetail({ rows, open, keyOf, render }) {
  const hit = rows.map((r, i) => [keyOf(r, i), r]).find(([k]) => k === open);
  if (!hit) return null;
  return (
    <div className="border-t border-border bg-sunken px-card py-3">
      {render(hit[1])}
    </div>
  );
}

function RebuildAdvice({ ix }) {
  return (
    <div className="space-y-gutter-sm">
      <div className="grid gap-gutter-sm sm:grid-cols-4">
        <StatCell label="B-tree height" value={ix.blevel} />
        <StatCell label="Leaf blocks" value={fmtNumber(ix.leaf_blocks)} />
        <StatCell label="Derived fragmentation" value={`${ix.fragmentation_pct}%`}
          hint="From BLEVEL — a proxy, not a measurement" />
        <StatCell label="Schema" value={ix.owner} />
      </div>

      <div>
        <p className="mb-1 text-[11px] font-bold tracking-wide text-subtle uppercase">
          1 · Measure it first
        </p>
        <div className="flex items-start gap-2">
          <SqlBlock sql={validateStatement(ix)} className="flex-1" />
          <CopyButton text={validateStatement(ix)} />
        </div>
        <p className="mt-1 text-[11px] text-muted">
          <span className="font-mono">VALIDATE STRUCTURE</span> takes a shared lock on the table for
          the duration, so run it outside peak hours. It writes to
          {' '}<span className="font-mono">INDEX_STATS</span>, which only ever holds one index at a time.
        </p>
      </div>

      <div>
        <p className="mb-1 text-[11px] font-bold tracking-wide text-subtle uppercase">
          2 · Rebuild, if the measurement justifies it
        </p>
        <div className="flex items-start gap-2">
          <SqlBlock sql={rebuildStatement(ix)} className="flex-1" />
          <CopyButton text={rebuildStatement(ix)} />
        </div>
        <p className="mt-1 text-[11px] text-muted">
          Rebuild when <span className="font-mono">del_lf_rows / lf_rows</span> is over about 20%.
          A rebuild needs roughly the size of the index again in free space, and
          {' '}<span className="font-mono">ONLINE</span> is what keeps the table writable while it runs.
        </p>
      </div>
    </div>
  );
}
