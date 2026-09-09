import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import cn from '@/lib/cn';
import client from '@/api/client';
import EngineDashboardHeader from '@/components/layout/EngineDashboardHeader';
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
import { MSSQL_DASHBOARD_TABS, mssqlTabRoute } from '@/config/mssqlDashboardNav';

/**
 * SQL Server Index Fragmentation — its own page, deliberately separate from
 * Index Analysis (that page is about which indexes exist/don't; this one is
 * about the physical state of the ones that do).
 *
 * Two-tier, matching the backend: the table below is a cheap 'LIMITED' sweep
 * of every index over 1,000 pages — fast enough to run broadly, but it can't
 * see internal fragmentation (how full each page actually is). Expanding a
 * row offers an on-demand 'DETAILED' scan of just that one index for the
 * real page-density number, before committing to a REORGANIZE/REBUILD.
 */

const fetchFragmentation = (id) =>
  client.get(`/connections/mssql/${id}/mssql-fragmentation-analysis`).then((r) => r.data);

const num = (v) => Number(v) || 0;

const TEST_SCRIPT = `-- Run this against a TEST database only (e.g. actmon_test_db) — it creates
-- and fills a throwaway table. Manufactures a REAL, verifiable fragmentation
-- scenario so this page has something honest to detect and report on.

IF OBJECT_ID('dbo.ActMon_FragTest', 'U') IS NOT NULL DROP TABLE dbo.ActMon_FragTest;
GO

CREATE TABLE dbo.ActMon_FragTest (
    id         UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    filler     CHAR(1000)       NOT NULL DEFAULT REPLICATE('X', 1000),
    created_at DATETIME2        NOT NULL DEFAULT SYSDATETIME()
);
GO

CREATE CLUSTERED INDEX CIX_ActMon_FragTest ON dbo.ActMon_FragTest(id);
GO

-- Random GUID keys force random insertion points in the clustered index,
-- causing real page splits (not simulated). 30,000 rows clears the
-- 1,000-page / 5% floor this page's sweep requires before it looks at all.
SET NOCOUNT ON;
DECLARE @i INT = 0;
WHILE @i < 30000
BEGIN
    INSERT INTO dbo.ActMon_FragTest (id, filler) VALUES (NEWID(), REPLICATE('X', 1000));
    SET @i += 1;
END
GO

-- Verify here first — the same DMV this page reads:
SELECT OBJECT_NAME(ips.object_id) AS table_name, i.name AS index_name,
       ips.avg_fragmentation_in_percent, ips.page_count
FROM sys.dm_db_index_physical_stats(DB_ID(), OBJECT_ID('dbo.ActMon_FragTest'), NULL, NULL, 'LIMITED') ips
JOIN sys.indexes i ON ips.object_id = i.object_id AND ips.index_id = i.index_id;
GO

-- Cleanup once you're done testing:
-- DROP TABLE dbo.ActMon_FragTest;`;

export default function MSSQLFragmentationAnalysis() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(null);
  const [showScript, setShowScript] = useState(false);
  const [preciseByKey, setPreciseByKey] = useState({});
  const [aiByKey, setAiByKey] = useState({});

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['mssqlFragmentationAnalysis', id],
    queryFn: () => fetchFragmentation(id),
    retry: false,
    refetchInterval: 60000,
  });

  const preciseMut = useMutation({
    mutationFn: ({ key, table_name, index_name, partition_number }) =>
      client.get(`/connections/mssql/${id}/mssql-fragmentation-analysis/detail`, {
        params: { table_name, index_name, partition_number },
      }).then((r) => r.data),
    onSuccess: (res, vars) => setPreciseByKey((p) => ({ ...p, [vars.key]: res })),
    onError: (err, vars) => setPreciseByKey((p) => ({ ...p, [vars.key]: { status: 'error', error: err.message } })),
  });

  const aiMut = useMutation({
    mutationFn: ({ key, payload }) =>
      client.post(`/connections/mssql/${id}/mssql-fragmentation-analysis/analyze-groq`, payload).then((r) => r.data),
    onSuccess: (res, vars) => setAiByKey((p) => ({ ...p, [vars.key]: res })),
    onError: (err, vars) => setAiByKey((p) => ({ ...p, [vars.key]: { status: 'error', error: err.message } })),
  });

  const fragmented = useMemo(() => data?.fragmented_indexes || [], [data]);
  const summary = data?.summary || {};

  const q = search.trim().toLowerCase();
  const shown = fragmented.filter((f) => !q
    || String(f.table_name || '').toLowerCase().includes(q)
    || String(f.index_name || '').toLowerCase().includes(q));

  const partialErrors = Object.entries(data?.errors || {})
    .filter(([, v]) => v)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`);

  const header = (
    <>
      <EngineDashboardHeader
        tech="mssql"
        connectionId={id}
        tabs={MSSQL_DASHBOARD_TABS}
        activeTab="fragmentation"
        onTabChange={(t) => navigate(mssqlTabRoute(id, t))}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-black text-fg">SQL Server Index Fragmentation</h1>
          <p className="text-xs text-subtle">
            Physical page fragmentation for the connected database — REORGANIZE/REBUILD guidance
          </p>
        </div>
        <Button variant="secondary" icon="refresh" loading={isFetching} onClick={() => refetch()}>
          Refresh
        </Button>
      </div>
    </>
  );

  if (isLoading) return <>{header}<PageLoading title="Scanning index fragmentation…" /></>;

  if (error || data?.status === 'error') {
    return (
      <>
        {header}
        <Notice tone="danger" title="Could not analyse fragmentation.">
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
          <MetricTile label="Fragmented indexes" value={summary.fragmented_indexes_count || 0} icon="layers"
            tone={summary.fragmented_indexes_count ? 'warn' : 'good'}
            hint="Over 1,000 pages and 5% fragmented" />
          <MetricTile label="Needs REBUILD" value={summary.needs_rebuild_count || 0} icon="alert"
            tone={summary.needs_rebuild_count ? 'bad' : 'good'} />
          <MetricTile label="Needs REORGANIZE" value={summary.needs_reorganize_count || 0} icon="clock"
            tone={summary.needs_reorganize_count ? 'warn' : 'good'} />
          <MetricTile label="Avg fragmentation" value={`${summary.avg_fragmentation_pct ?? 0}%`} icon="activity" />
        </div>

        {summary.fragmented_indexes_count != null && (
          <Panel title="Fragmentation impact" icon="activity" subtitle={summary.note}>
            <div className="grid gap-gutter-sm sm:grid-cols-2 xl:grid-cols-3">
              <StatCell label="Estimated wasted space" value={`${fmtNumber(summary.estimated_wasted_mb || 0)} MB`}
                hint="Fragmented portion of affected indexes' total size" />
              <StatCell label="Blocked from REORGANIZE" value={summary.page_locks_blocked_count || 0}
                tone={summary.page_locks_blocked_count ? 'warn' : undefined}
                hint="ALLOW_PAGE_LOCKS is OFF — only REBUILD works on these" />
              <StatCell label="Total scanned" value={fmtNumber(fragmented.length)} />
            </div>
          </Panel>
        )}

        <TablePanel
          title="Fragmented indexes"
          icon="layers"
          subtitle="Select a row for the statement, a precise check, or an AI explanation"
          actions={(
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onClear={() => setSearch('')}
              placeholder="Search tables…"
              icon="search"
              size="sm"
              wrapperClassName="w-40"
            />
          )}
        >
          <div className="border-b border-border px-card py-2">
            <p className="flex items-start gap-1.5 text-[11px] text-muted">
              <Icon name="info" size={12} className="mt-0.5 shrink-0" />
              Microsoft&apos;s own long-standing thresholds: 5–30% fragmented → REORGANIZE (always
              fully online, lighter). Over 30% → REBUILD (heavier; ONLINE=ON needs Enterprise
              edition). Indexes under 1,000 pages are excluded — fragmentation on them is noise,
              not signal.
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
                    { key: 'frag', label: 'Fragmentation', align: 'right' },
                    { key: 'fill', label: 'Fill Factor', align: 'right' },
                    { key: 'size', label: 'Size', align: 'right' },
                    { key: 'action', label: 'Recommended' },
                  ]}
                  rows={page.map((f, i) => {
                    const key = `frag-${f.table_name}-${f.index_name}-${f.partition_number}-${i}`;
                    const mb = Math.round((num(f.page_count) * 8) / 1024);
                    return {
                      key,
                      onClick: () => setOpen(open === key ? null : key),
                      cells: {
                        table: (
                          <span className="flex flex-col">
                            <span className="font-mono text-[12px]">{f.table_name}</span>
                            {num(f.partition_number) > 1 && (
                              <span className="text-[10px] text-subtle">partition {f.partition_number}</span>
                            )}
                          </span>
                        ),
                        index: <span className="font-mono text-[12px] font-semibold">{f.index_name}</span>,
                        type: <Badge tone="neutral" size="xs">{String(f.type_desc || '').replace('_INDEX', '')}</Badge>,
                        frag: (
                          <span className={cn('font-mono font-semibold', num(f.frag_pct) >= 30 ? 'text-danger-fg' : 'text-warning-fg')}>
                            {f.frag_pct}%
                          </span>
                        ),
                        fill: <span className="font-mono">{f.fill_factor}%</span>,
                        size: <span className="font-mono">{fmtNumber(mb)} MB</span>,
                        action: (
                          <span className="flex items-center gap-1.5">
                            <Badge tone={f.recommended_action === 'REBUILD' ? 'danger' : 'warning'} size="xs">
                              {f.recommended_action}
                            </Badge>
                            {f.action_note && <Icon name="alert" size={12} className="text-warning-fg" />}
                          </span>
                        ),
                      },
                    };
                  })}
                  empty={<EmptyState icon="check"
                    title={fragmented.length ? 'No matches' : 'Nothing worth rebuilding'}
                    body={fragmented.length ? undefined : 'No index over 1,000 pages is fragmented past 5%.'} />}
                />
                {page.some((f, i) => open === `frag-${f.table_name}-${f.index_name}-${f.partition_number}-${i}`) && (
                  <div className="border-t border-border bg-sunken px-card py-3">
                    {page.map((f, i) => {
                      const key = `frag-${f.table_name}-${f.index_name}-${f.partition_number}-${i}`;
                      if (open !== key) return null;
                      const precise = preciseByKey[key];
                      const ai = aiByKey[key];
                      return (
                        <div key={key} className="space-y-3">
                          <div>
                            <p className="text-[11px] font-bold tracking-wide text-subtle uppercase">
                              {f.recommended_action} statement
                            </p>
                            <div className="mt-1 flex items-start gap-2">
                              <SqlBlock sql={f.ddl} className="flex-1" />
                              <CopyButton text={f.ddl} />
                            </div>
                          </div>

                          {f.action_note && (
                            <Notice tone="warning" title="Forced to REBUILD">{f.action_note}</Notice>
                          )}

                          <div className="flex flex-wrap items-center gap-2">
                            {!precise && (
                              <Button
                                size="sm" variant="secondary" icon="search"
                                loading={preciseMut.isPending && preciseMut.variables?.key === key}
                                onClick={() => preciseMut.mutate({
                                  key, table_name: f.table_name, index_name: f.index_name,
                                  partition_number: f.partition_number,
                                })}
                              >
                                Run precise check
                              </Button>
                            )}
                            {!ai && (
                              <Button
                                size="sm" variant="primary" icon="brain"
                                loading={aiMut.isPending && aiMut.variables?.key === key}
                                onClick={() => aiMut.mutate({
                                  key,
                                  payload: {
                                    table_name: f.table_name, index_name: f.index_name,
                                    type_desc: f.type_desc, is_unique: Boolean(f.is_unique),
                                    frag_pct: num(f.frag_pct), page_count: num(f.page_count),
                                    recommended_action: f.recommended_action,
                                    fill_factor: num(f.fill_factor), action_note: f.action_note || null,
                                    page_density_pct: precise?.aggregate?.page_density_pct ?? null,
                                    fragment_count: precise?.aggregate?.fragment_count ?? null,
                                    avg_fragment_size_pages: precise?.partitions?.[0]?.avg_fragment_size_pages ?? null,
                                  },
                                })}
                              >
                                Get AI explanation
                              </Button>
                            )}
                          </div>

                          {precise?.status === 'error' && (
                            <Notice tone="danger" title="Could not run the precise check.">{precise.error}</Notice>
                          )}
                          {precise?.status === 'success' && (
                            <div className="grid gap-gutter-sm sm:grid-cols-2 xl:grid-cols-4 rounded-card border border-border bg-surface p-3">
                              <StatCell label="Page density" value={`${precise.aggregate.page_density_pct}%`}
                                hint="How full each page actually is — the real internal-fragmentation number"
                                tone={precise.aggregate.page_density_pct < 75 ? 'warn' : 'good'} />
                              <StatCell label="Fragment count" value={fmtNumber(precise.aggregate.fragment_count)} />
                              <StatCell label="Row count" value={fmtNumber(precise.aggregate.record_count)} />
                              <StatCell label="Rechecked fragmentation" value={`${precise.aggregate.frag_pct}%`} />
                            </div>
                          )}

                          {ai?.status === 'error' && (
                            <Notice tone="danger" title="Could not get an explanation.">{ai.error}</Notice>
                          )}
                          {ai?.status === 'success' && (
                            <div className="space-y-2 rounded-card border border-border bg-surface p-3">
                              <p className="flex items-center gap-1.5 text-[11px] font-bold tracking-wide text-accent-text uppercase">
                                <Icon name="brain" size={12} /> ActMon AI explanation
                              </p>
                              <div>
                                <p className="text-[11px] font-bold tracking-wide text-subtle uppercase">Why this happened</p>
                                <p className="text-[12px] text-muted">{ai.analysis.explanation}</p>
                              </div>
                              <div>
                                <p className="text-[11px] font-bold tracking-wide text-subtle uppercase">Impact</p>
                                <p className="text-[12px] text-muted">{ai.analysis.impact}</p>
                              </div>
                              <div>
                                <p className="text-[11px] font-bold tracking-wide text-subtle uppercase">Why {f.recommended_action}</p>
                                <p className="text-[12px] text-muted">{ai.analysis.action_reasoning}</p>
                              </div>
                              <div>
                                <p className="text-[11px] font-bold tracking-wide text-warning-fg uppercase">Before you run it</p>
                                <p className="text-[12px] text-muted">{ai.analysis.caution}</p>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {pager}
              </>
            )}
          </Paged>
        </TablePanel>

        <Panel
          title="Manufacture a test scenario"
          icon="terminal"
          subtitle="A T-SQL script to create a real, verifiable fragmentation case on your own test server"
          actions={(
            <Button size="sm" variant="secondary" icon={showScript ? 'eye-off' : 'eye'}
              onClick={() => setShowScript((s) => !s)}>
              {showScript ? 'Hide' : 'Show script'}
            </Button>
          )}
        >
          {showScript ? (
            <div className="space-y-2">
              <p className="text-[12px] text-muted">
                Run this against a disposable test database (e.g. <span className="font-mono">actmon_test_db</span>).
                It creates a table, inserts 30,000 rows with random GUID keys — which forces real
                page splits, not a simulated number — and gives you a verification query to confirm
                the fragmentation before checking back here.
              </p>
              <div className="flex items-start gap-2">
                <SqlBlock sql={TEST_SCRIPT} className="flex-1 max-h-80 overflow-y-auto" />
                <CopyButton text={TEST_SCRIPT} />
              </div>
            </div>
          ) : (
            <p className="text-[12px] text-subtle">Click &quot;Show script&quot; to reveal it.</p>
          )}
        </Panel>

        <p className="flex items-start gap-1.5 text-[11px] text-subtle">
          <Icon name="info" size={12} className="mt-0.5 shrink-0" />
          The sweep above is a fast &apos;LIMITED&apos; scan and covers the connected database only.
          &quot;Run precise check&quot; performs an on-demand &apos;DETAILED&apos; scan (a full page
          walk) of just that one index — heavier, so it is never run automatically.
        </p>
      </div>
    </>
  );
}
