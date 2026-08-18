import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, Clipboard, ClipboardCheck, Copy, Database, FileText, GitMerge, Layers,
  Network, Server, TrendingUp, Zap,
} from 'lucide-react';
import client from '@/api/client';

import EngineDashboardHeader from '@/components/layout/EngineDashboardHeader';
import HostResources from '@/pages/postgresql/PgHostResources';
import TrendChart from '@/components/gauges/TrendChart';
import ChartCard from '@/components/charts/ChartCard';
import { STATUS, bandFor } from '@/components/charts/status';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import CopyButton from '@/components/ui/CopyButton';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import { dbError } from '@/lib/format';
import Select from '@/components/ui/Select';
import Table, { EmptyState } from '@/components/ui/Table';
import { InlineLoading, PageLoading } from '@/components/ui/Loading';
import { Paged } from '@/components/ui/Pagination';
import { DashboardScopeProvider } from '@/context/DashboardAppearanceContext';

import ObjectTable from '@/pages/_shared/ObjectTable';
import {
  DefRow, MetricTile, Panel, SqlBlock, SqlCell, StatCell, StateChip, StatusPill, TablePanel,
  UsageBar,
} from '@/pages/_shared/enginePanels';
import { fmtBytes, fmtNumber } from '@/config/dbCatalog';
import {
  CH_DATABASE_COLUMNS, CH_TABLE_COLUMNS, MAX_PARTS_WARN, chDatabaseRow, chTableRow,
} from '@/config/clickhouseCatalog';
import { CLICKHOUSE_DASHBOARD_TABS } from '@/config/clickhouseDashboardNav';

/**
 * ClickHouse dashboard — twelve tabs, each backed by its own `system.*` query.
 *
 * Two things drive most of what a ClickHouse operator needs to know, and both are
 * surfaced rather than left as raw numbers:
 *
 *  · part count per partition. ClickHouse refuses inserts once a partition passes
 *    `parts_to_throw_insert` (300 by default, 3000 in the collector's threshold),
 *    so this is the metric that turns into an outage. It leads the overview.
 *  · compression ratio. It is the reason the storage numbers look the way they do,
 *    and the collector already computes it per table — so it is shown next to the
 *    sizes rather than left for someone to work out.
 */

const REFRESH_INTERVAL = 15; // seconds

const get = (id, path) =>
  client.get(`/connections/clickhouse/${id}/${path}`).then((r) => r.data);

const TABS = CLICKHOUSE_DASHBOARD_TABS;

const num = (v) => Number(v) || 0;

/** query_log row types — the two exception kinds are what matters. */
const LOG_TYPE_TONES = {
  QueryFinish: 'success',
  ExceptionBeforeStart: 'danger',
  ExceptionWhileProcessing: 'danger',
  QueryStart: 'info',
};

/**
 * One tab's query. `enabled` is what stops a tab polling `system.*` while it is off
 * screen — several of these run against every part or every replica.
 */
function useTabQuery(id, key, path, opts = {}) {
  return useQuery({
    queryKey: [key, id],
    queryFn: () => get(id, path),
    retry: false,
    ...opts,
  });
}

/** 0–100. Part pressure dominates, because that is what stops inserts. */
function computeHealthScore({ memPct, maxParts, partsThreshold, failedRatio, replicaDelay }) {
  let score = 100;
  const partPct = partsThreshold > 0 ? (maxParts / partsThreshold) * 100 : 0;
  if (partPct > 90) score -= 35;
  else if (partPct > 60) score -= 18;
  else if (partPct > 30) score -= 8;
  if (memPct > 90) score -= 20;
  else if (memPct > 75) score -= 10;
  if (failedRatio > 0.05) score -= 15;
  else if (failedRatio > 0.01) score -= 7;
  if (replicaDelay > 300) score -= 20;
  else if (replicaDelay > 60) score -= 10;
  return Math.max(0, score);
}

function HealthBadge({ score }) {
  const band = score >= 80 ? STATUS.good : score >= 60 ? STATUS.warning : STATUS.critical;
  return (
    <span
      className="flex h-control shrink-0 items-center gap-1.5 rounded-control px-2.5 text-[12px] font-bold text-white"
      style={{ background: band.color }}
      title={`Composite of part pressure, memory, failed-query ratio and replica delay (${score}/100)`}
    >
      <Icon name="activity" size={13} />
      Health {score}
    </span>
  );
}

export default function ClickHouseDashboard() {
  const { id, tab } = useParams();
  const navigate = useNavigate();

  const activeTab = tab || 'overview';
  const setActiveTab = (t) =>
    navigate(`/clickhouse-dashboard/${id}${t && t !== 'overview' ? `/${t}` : ''}`);

  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const [trend, setTrend] = useState({ mem: [], qps: [], parts: [] });
  const [tableDb, setTableDb] = useState('__all__');
  const [partTable, setPartTable] = useState('__all__');
  const [logType, setLogType] = useState('');
  const [logSearch, setLogSearch] = useState('');
  const [settingSearch, setSettingSearch] = useState('');
  const [metricSearch, setMetricSearch] = useState('');
  const [openRow, setOpenRow] = useState(null);
  const countRef = useRef(null);

  const on = (t) => activeTab === t;
  const q = (key, path, opts) => useTabQuery(id, key, path, opts);

  const { data, isLoading, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['chDashboard', id],
    queryFn: () => get(id, 'ch-dashboard'),
    retry: false,
    refetchInterval: REFRESH_INTERVAL * 1000,
  });

  const running = q('chQueries', 'ch-queries', { refetchInterval: 5000, enabled: on('queries') });
  const queryLog = q('chQueryLog', 'ch-query-log', { refetchInterval: 15000, enabled: on('querylog') });
  const slow = q('chSlow', 'ch-slow-queries', { refetchInterval: 30000, enabled: on('slowqueries') });
  const tables = q('chTables', 'ch-tables', { refetchInterval: 30000, enabled: on('tables') });
  const partitions = q('chPartitions', 'ch-partitions', { refetchInterval: 30000, enabled: on('partitions') });
  const merges = q('chMerges', 'ch-merges', { refetchInterval: 5000, enabled: on('merges') || on('overview') });
  const replicas = q('chReplicas', 'ch-replicas', { refetchInterval: 10000, enabled: on('replicas') });
  const clusters = q('chClusters', 'ch-clusters', { refetchInterval: 30000, enabled: on('clusters') });
  const databases = q('chDatabases', 'ch-databases', { refetchInterval: 30000, enabled: on('databases') });
  const sysMetrics = q('chSysMetrics', 'ch-system-metrics', {
    refetchInterval: 30000, enabled: on('sysmetrics') || on('overview'),
  });
  const settings = q('chSettings', 'ch-settings', { refetchInterval: 60000, enabled: on('settings') });

  useEffect(() => {
    setCountdown(REFRESH_INTERVAL);
    clearInterval(countRef.current);
    countRef.current = setInterval(
      () => setCountdown((c) => (c <= 1 ? REFRESH_INTERVAL : c - 1)),
      1000,
    );
    return () => clearInterval(countRef.current);
  }, [dataUpdatedAt]);

  useEffect(() => {
    if (!data) return;
    const hs = data.health_summary || {};
    const t = new Date().toLocaleTimeString();
    setTrend((prev) => ({
      mem: [...prev.mem.slice(-19), { t, v: num(hs.memory_usage_pct) }],
      qps: [...prev.qps.slice(-19), { t, v: num(hs.queries_per_second) }],
      parts: [...prev.parts.slice(-19), { t, v: num(hs.max_part_count_for_partition) }],
    }));
  }, [data]);

  const d = useMemo(() => {
    const p = data || {};
    const hs = p.health_summary || {};
    const metrics = Array.isArray(p.metrics) ? p.metrics : [];
    const disk = p.disk_usage || {};
    const stats = p.query_stats || {};

    const maxParts = num(hs.max_part_count_for_partition);
    const partsThreshold = num(hs.max_parts_threshold) || 3000;
    const totalQueries = num(stats.select_count) + num(stats.insert_count);
    const failedRatio = totalQueries > 0 ? num(stats.failed_count) / totalQueries : 0;
    const replicaDelay = Math.max(
      0,
      ...(Array.isArray(p.replicas) ? p.replicas : []).map((r) => num(r.absolute_delay)),
    );
    const memPct = num(hs.memory_usage_pct);

    return {
      connection: p.connection || {},
      hs,
      metrics,
      disk,
      stats,
      dbRows: Array.isArray(p.databases) ? p.databases : [],
      topDatabases: Array.isArray(p.top_databases) ? p.top_databases : [],
      tableRows: Array.isArray(p.tables) ? p.tables : [],
      processes: Array.isArray(p.active_processes) ? p.active_processes : [],
      recentErrors: Array.isArray(p.recent_errors) ? p.recent_errors : [],
      mergeRows: Array.isArray(p.merges) ? p.merges : [],
      replicaRows: Array.isArray(p.replicas) ? p.replicas : [],
      settingRows: Array.isArray(p.settings) ? p.settings : [],
      collectorErrors: Object.entries(p.errors || {}).map(([k, v]) => `${k}: ${v}`),

      memPct,
      maxParts,
      partsThreshold,
      partPct: partsThreshold > 0 ? Math.min(100, Math.round((maxParts / partsThreshold) * 100)) : 0,
      totalParts: num(hs.total_parts),
      failedRatio,
      replicaDelay,
      diskPct: num(disk.used_pct),
      healthScore: computeHealthScore({
        memPct, maxParts, partsThreshold, failedRatio, replicaDelay,
      }),
    };
  }, [data]);

  /* The lists, with the per-tab payload preferred over the overview's smaller copy.
     Kept in a memo ABOVE the early returns: a hook may not follow a conditional
     return, and these feed ObjectTable, which memoises on item identity. */
  const lists = useMemo(() => {
    const liveTables = tables.data?.tables || d.tableRows;
    const liveDatabases = databases.data?.databases || d.dbRows;
    return {
      tableItems: liveTables.map(chTableRow),
      dbItems: liveDatabases.map(chDatabaseRow),
      liveMerges: merges.data?.merges || d.mergeRows,
      liveReplicas: replicas.data?.replicas || d.replicaRows,
    };
  }, [tables.data, databases.data, merges.data, replicas.data, d]);

  if (isLoading) return <PageLoading title="Connecting to ClickHouse…" />;

  if (error || data?.status === 'error') {
    return (
      <div className="max-w-2xl">
        <Notice tone="danger" title="Connection failed.">
          {data?.error || error?.message || 'ClickHouse did not respond.'}
        </Notice>
        <Button variant="primary" icon="refresh" onClick={() => refetch()}>Retry</Button>
      </div>
    );
  }

  const {
    connection, hs, metrics, disk, stats, topDatabases,
    processes, recentErrors, settingRows, collectorErrors,
    memPct, maxParts, partsThreshold, partPct, totalParts, replicaDelay, diskPct, healthScore,
  } = d;
  const { tableItems, dbItems, liveMerges, liveReplicas } = lists;

  const shownTables = tableDb === '__all__'
    ? tableItems
    : tableItems.filter((t) => t.database === tableDb);

  const tableDbOptions = [
    { id: '__all__', label: 'All databases' },
    ...[...new Set(tableItems.map((t) => t.database).filter(Boolean))].sort()
      .map((n) => ({ id: n, label: n })),
  ];

  const partitionRows = partitions.data?.partitions || [];
  const shownPartitions = partTable === '__all__'
    ? partitionRows
    : partitionRows.filter((p) => `${p.database}.${p.table}` === partTable);
  const partTableOptions = [
    { id: '__all__', label: 'All tables' },
    ...[...new Set(partitionRows.map((p) => `${p.database}.${p.table}`))].sort()
      .map((n) => ({ id: n, label: n })),
  ];

  const alerts = {
    partitions: maxParts > MAX_PARTS_WARN ? 1 : 0,
    replicas: replicaDelay > 60 ? 1 : 0,
    querylog: recentErrors.length,
  };

  return (
    <DashboardScopeProvider tech="clickhouse">
      <div className="flex min-h-full flex-col">
        <EngineDashboardHeader
          tech="clickhouse"
          connectionId={id}
          connection={connection}
          tabs={TABS}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          alerts={alerts}
          health={<HealthBadge score={healthScore} />}
          onRefresh={() => refetch()}
          isFetching={isFetching}
          countdown={countdown}
        />

        {collectorErrors.length > 0 && (
          <Notice tone="warning" title="Some system tables could not be read.">
            {/* One line per source, trimmed. The engine appends a native stack
                trace to every exception; printed verbatim it buried the page. */}
            <span className="flex flex-col gap-0.5">
              {collectorErrors.map((msg, i) => (
                <span key={i} className="clamp-2" title={String(msg)}>{dbError(msg)}</span>
              ))}
            </span>
          </Notice>
        )}

        {/* ══ OVERVIEW ══════════════════════════════════════════════════════ */}
        {on('overview') && (
          <div className="space-y-gutter">
            <div className="grid grid-cols-2 gap-gutter-sm sm:grid-cols-4 xl:grid-cols-8">
              <MetricTile label="Version" icon="server" value={hs.version || '—'}
                sub={hs.host || connection.host || undefined} />
              <MetricTile label="Uptime" icon="clock" value={hs.uptime_str || '—'} />
              <MetricTile label="Databases" icon="server" value={hs.total_databases ?? dbItems.length}
                onClick={() => setActiveTab('databases')} />
              <MetricTile label="Tables" icon="database" value={hs.total_tables ?? tableItems.length}
                onClick={() => setActiveTab('tables')} />
              <MetricTile label="Running queries" icon="zap" value={hs.active_queries ?? processes.length}
                onClick={() => setActiveTab('queries')} />
              <MetricTile label="Queries/sec" icon="activity" value={hs.queries_per_second ?? '—'} />
              <MetricTile label="Memory" icon="memory"
                value={hs.memory_usage_human || `${memPct}%`}
                sub={hs.total_memory_human ? `of ${hs.total_memory_human}` : undefined}
                tone={memPct > 90 ? 'bad' : memPct > 75 ? 'warn' : 'good'} />
              <MetricTile label="Parts / partition" icon="layers" value={fmtNumber(maxParts)}
                sub={`limit ${fmtNumber(partsThreshold)}`}
                tone={partPct > 90 ? 'bad' : partPct > 60 ? 'warn' : 'good'}
                hint="ClickHouse stops accepting inserts into a partition once it has too many parts"
                onClick={() => setActiveTab('partitions')} />
            </div>

            <HostResources connId={id} tech="clickhouse" />

            {/* Part pressure is the finding that becomes an outage, so it is stated
                as a consequence rather than left as a ratio. */}
            {partPct > 60 && (
              <Notice tone={partPct > 90 ? 'danger' : 'warning'}
                title={`A partition holds ${fmtNumber(maxParts)} parts — ${partPct}% of the ${fmtNumber(partsThreshold)} limit.`}>
                ClickHouse merges parts in the background; when a partition accumulates them faster
                than merges can keep up it eventually refuses inserts outright
                (<span className="font-mono">TOO_MANY_PARTS</span>). Usually the cause is many small
                inserts — batch them, or check whether merges are keeping up on the Merges tab.
              </Notice>
            )}

            <div className="flex flex-wrap gap-2">
              <StatusPill ok={partPct <= 60} label={`Parts ${partPct}% of limit`}
                onClick={() => setActiveTab('partitions')} />
              <StatusPill ok={memPct < 90} label={`Memory ${memPct}%`} />
              <StatusPill ok={diskPct < 85}
                label={disk.name ? `Disk ${disk.name} ${diskPct}%` : 'No disk data'}
                hint={disk.total_human ? `${disk.used_human} of ${disk.total_human}` : undefined} />
              <StatusPill ok={num(stats.failed_count) === 0}
                label={`Failed queries: ${fmtNumber(stats.failed_count)}`}
                hint="Cumulative since the server started, not a rate" />
              <StatusPill ok={!hs.replication_enabled || replicaDelay <= 60}
                label={hs.replication_enabled
                  ? `Replication delay ${fmtNumber(replicaDelay)}s`
                  : 'Not replicated'}
                onClick={() => setActiveTab('replicas')} />
              <StatusPill ok={num(hs.merge_queue_size) < 10}
                label={`Merges running: ${num(hs.merge_queue_size)}`}
                onClick={() => setActiveTab('merges')} />
            </div>

            <div className="grid gap-gutter xl:grid-cols-2">
              <ChartCard
                cardId="ch-utilisation"
                family="ratio"
                items={[
                  { key: 'parts', label: 'Part pressure', value: partPct, icon: 'layers',
                    hint: `${fmtNumber(maxParts)} parts in the busiest partition, limit ${fmtNumber(partsThreshold)}` },
                  { key: 'mem', label: 'Memory', value: memPct, icon: 'memory',
                    hint: `${hs.memory_usage_human || '—'} of ${hs.total_memory_human || '—'}` },
                  { key: 'disk', label: 'Disk', value: diskPct, icon: 'desktop',
                    hint: disk.path ? `${disk.name} at ${disk.path}` : 'No disk reported' },
                ]}
                title="Utilisation"
                icon="gauge"
                subtitle="Each against its own ceiling"
                loading={isFetching}
                tableColumns={[
                  { key: 'resource', label: 'Resource' },
                  { key: 'used', label: 'Used', align: 'right' },
                  { key: 'band', label: 'Band', align: 'right' },
                ]}
                tableRows={[['Part pressure', partPct], ['Memory', memPct], ['Disk', diskPct]]
                  .map(([label, v]) => ({
                    key: label, cells: { resource: label, used: `${v}%`, band: bandFor(v).label },
                  }))}
              />

              <ChartCard
                cardId="ch-db-size"
                family="breakdown"
                rows={topDatabases.slice(0, 8).map((row) => ({
                  key: row.database,
                  label: row.database,
                  total: num(row.total_bytes),
                  segments: [
                    { key: 'bytes', label: 'On disk', value: num(row.total_bytes), status: STATUS.good },
                  ],
                }))}
                chartProps={{ emptyLabel: 'No database sizes reported', labelWidth: 130, legend: false }}
                title="Space by database"
                icon="server"
                subtitle="Compressed size as ClickHouse reports it"
                loading={isFetching}
                tableColumns={[
                  { key: 'db', label: 'Database' },
                  { key: 'tables', label: 'Tables', align: 'right' },
                  { key: 'rows', label: 'Rows', align: 'right' },
                  { key: 'size', label: 'On disk', align: 'right' },
                ]}
                tableRows={topDatabases.map((row) => ({
                  key: row.database,
                  cells: {
                    db: row.database,
                    tables: fmtNumber(row.table_count),
                    rows: fmtNumber(row.total_rows),
                    size: fmtBytes(row.total_bytes),
                  },
                }))}
              />
            </div>

            {trend.mem.length > 2 ? (
              <div className="grid gap-gutter md:grid-cols-3">
                <Panel title="Memory" icon="memory">
                  <TrendChart data={trend.mem} series={[{ key: 'v', label: '%' }]} height={150} />
                </Panel>
                <Panel title="Queries per second" icon="activity">
                  <TrendChart data={trend.qps} series={[{ key: 'v', label: 'q/s' }]} height={150}
                    yDomain={['auto', 'auto']} />
                </Panel>
                <Panel title="Parts in the busiest partition" icon="layers">
                  <TrendChart data={trend.parts} series={[{ key: 'v', label: 'parts' }]} height={150}
                    yDomain={['auto', 'auto']} />
                </Panel>
              </div>
            ) : (
              <Panel>
                <p className="text-center text-[12px] text-subtle">
                  Live trends build up from this page — the first points appear after the next
                  {' '}{REFRESH_INTERVAL}-second refresh.
                </p>
              </Panel>
            )}

            <div className="grid gap-gutter xl:grid-cols-3">
              <Panel title="Server" icon="server">
                <DefRow label="Version" value={hs.version} mono />
                <DefRow label="Host" value={hs.host || connection.host} mono />
                <DefRow label="Uptime" value={hs.uptime_str} />
                <DefRow label="Databases" value={hs.total_databases} />
                <DefRow label="Tables" value={hs.total_tables} />
                <DefRow label="Replicated" value={hs.replication_enabled ? 'Yes' : 'No'} />
              </Panel>

              <Panel title="Storage" icon="desktop">
                {disk.name ? (
                  <>
                    <UsageBar label={`${disk.name} (${disk.path || 'default'})`} pct={diskPct}
                      sub={`${disk.used_human} used of ${disk.total_human}`} className="mb-3" />
                    <DefRow label="Free" value={disk.free_human} />
                  </>
                ) : (
                  <p className="mb-2 text-[12px] text-subtle">system.disks reported nothing.</p>
                )}
                <DefRow label="Active parts" value={fmtNumber(totalParts)} />
                <DefRow label="Busiest partition" value={fmtNumber(maxParts)}
                  tone={partPct > 60 ? 'warn' : undefined}
                  hint={`Inserts are refused past roughly ${fmtNumber(partsThreshold)} parts`} />
                <DefRow label="Merges running" value={num(hs.merge_queue_size)} />
              </Panel>

              <Panel title="Query activity" icon="zap"
                subtitle="Counters since the server started, not rates">
                <DefRow label="Queries/sec" value={hs.queries_per_second} />
                <DefRow label="SELECT" value={fmtNumber(stats.select_count)} />
                <DefRow label="INSERT" value={fmtNumber(stats.insert_count)} />
                <DefRow label="Failed" value={fmtNumber(stats.failed_count)}
                  tone={num(stats.failed_count) > 0 ? 'warn' : undefined} />
                <DefRow label="Running now" value={processes.length} />
                <DefRow label="Recent exceptions" value={recentErrors.length}
                  tone={recentErrors.length ? 'warn' : undefined} />
              </Panel>
            </div>

            {recentErrors.length > 0 && (
              <TablePanel title={`Recent exceptions (${recentErrors.length})`} icon="alert"
                subtitle="From system.query_log — the last 20 failures"
                actions={<Button size="sm" variant="secondary" iconRight="chevron-right"
                  onClick={() => navigate(`/clickhouse-dashboard/${id}/error-logs`)}>All errors</Button>}>
                <Paged rows={recentErrors} unit="exceptions" pageSize="10">
                  {(page, pager) => (
                    <>
                      <Table
                        columns={[
                          { key: 'when', label: 'Time' },
                          { key: 'type', label: 'Type' },
                          { key: 'code', label: 'Code', align: 'right' },
                          { key: 'user', label: 'User' },
                          { key: 'msg', label: 'Message' },
                        ]}
                        rows={page.map((e, i) => ({
                          key: `err-${i}`,
                          cells: {
                            when: <span className="font-mono text-[11px] whitespace-nowrap text-muted">{String(e.event_time || '').slice(0, 19)}</span>,
                            type: <StateChip value={e.type} tones={LOG_TYPE_TONES} fallback="danger" />,
                            code: <span className="font-mono">{e.exception_code ?? null}</span>,
                            user: <span className="text-[11px] text-muted">{e.user}</span>,
                            msg: <span className="block max-w-[520px] text-[12px] break-words text-fg">{e.message}</span>,
                          },
                        }))}
                        empty={<EmptyState icon="check" title="No exceptions" />}
                      />
                      {pager}
                    </>
                  )}
                </Paged>
              </TablePanel>
            )}
          </div>
        )}

        {/* ══ RUNNING QUERIES ═══════════════════════════════════════════════ */}
        {on('queries') && (
          <div className="space-y-gutter">
            {running.isLoading ? <InlineLoading label="Reading system.processes…" /> : (
              <>
                <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4">
                  <MetricTile label="Running now" value={running.data?.total ?? 0} icon="zap" />
                  <MetricTile label="Queries/sec" value={running.data?.stats?.queries_per_second ?? '—'} icon="activity" />
                  <MetricTile label="SELECT total" value={fmtNumber(running.data?.stats?.select_queries)} icon="search" />
                  <MetricTile label="Failed total" value={fmtNumber(running.data?.stats?.failed_queries)} icon="alert"
                    tone={num(running.data?.stats?.failed_queries) ? 'warn' : 'good'} />
                </div>
                <RunningQueriesPanel rows={running.data?.queries || []} openRow={openRow} setOpenRow={setOpenRow} />
              </>
            )}
          </div>
        )}

        {/* ══ QUERY LOG ═════════════════════════════════════════════════════ */}
        {on('querylog') && (
          <div className="space-y-gutter">
            {queryLog.isLoading ? <InlineLoading label="Reading system.query_log…" /> : (
              <TablePanel
                title={`Query log (${queryLog.data?.total ?? 0})`}
                icon="logs"
                subtitle="The last 100 finished or failed queries, newest first"
                actions={(
                  <>
                    <Select
                      value={logType}
                      onChange={setLogType}
                      options={[
                        { id: '', label: 'All outcomes' },
                        { id: 'QueryFinish', label: 'Finished' },
                        { id: 'ExceptionWhileProcessing', label: 'Failed while running' },
                        { id: 'ExceptionBeforeStart', label: 'Failed before start' },
                      ]}
                      size="sm"
                      width="auto"
                    />
                    <Input
                      value={logSearch}
                      onChange={(e) => setLogSearch(e.target.value)}
                      onClear={() => setLogSearch('')}
                      placeholder="User or SQL…"
                      icon="search"
                      size="sm"
                      wrapperClassName="w-44"
                    />
                  </>
                )}
              >
                <Paged
                  rows={(queryLog.data?.logs || []).filter((l) => (
                    (!logType || l.type === logType)
                    && (!logSearch.trim()
                      || `${l.user} ${l.query}`.toLowerCase().includes(logSearch.trim().toLowerCase()))
                  ))}
                  unit="queries"
                >
                  {(page, pager) => (
                    <>
                      <Table
                        columns={[
                          { key: 'when', label: 'Time' },
                          { key: 'type', label: 'Outcome' },
                          { key: 'user', label: 'User' },
                          { key: 'kind', label: 'Kind' },
                          { key: 'ms', label: 'Duration', align: 'right' },
                          { key: 'read', label: 'Rows read', align: 'right' },
                          { key: 'bytes', label: 'Bytes read', align: 'right' },
                          { key: 'mem', label: 'Peak memory', align: 'right' },
                          { key: 'sql', label: 'Query' },
                        ]}
                        rows={page.map((l, i) => ({
                          key: `${l.query_id}-${i}`,
                          cells: {
                            when: <span className="font-mono text-[11px] whitespace-nowrap text-muted">{String(l.event_time || '').slice(0, 19)}</span>,
                            type: <StateChip value={l.type} tones={LOG_TYPE_TONES} />,
                            user: <span className="text-[11px] text-muted">{l.user}</span>,
                            kind: l.query_kind ? <Badge tone="neutral" size="xs">{l.query_kind}</Badge> : null,
                            ms: <span className="font-mono font-semibold">{fmtNumber(l.elapsed_ms)} ms</span>,
                            read: <span className="font-mono">{fmtNumber(l.read_rows)}</span>,
                            bytes: <span className="font-mono text-[12px]">{fmtBytes(l.read_bytes)}</span>,
                            mem: <span className="font-mono text-[12px]">{fmtBytes(l.memory_usage)}</span>,
                            sql: (
                              <span className="block">
                                <SqlCell sql={l.query} max={90} />
                                {l.exception && (
                                  <span className="mt-0.5 block max-w-[380px] text-[11px] break-words text-danger-fg">
                                    {l.exception}
                                  </span>
                                )}
                              </span>
                            ),
                          },
                        }))}
                        empty={<EmptyState icon="logs" title="No query log entries"
                          body={queryLog.data?.error || 'system.query_log is empty — it may be disabled in the server config.'} />}
                      />
                      {pager}
                    </>
                  )}
                </Paged>
              </TablePanel>
            )}
          </div>
        )}

        {/* ══ SLOW QUERIES ══════════════════════════════════════════════════ */}
        {on('slowqueries') && (
          <div className="space-y-gutter">
            {slow.isLoading ? <InlineLoading label="Reading slow queries…" /> : (
              <>
                <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4">
                  <MetricTile label="Slow queries" value={slow.data?.total ?? 0} icon="trend" />
                  <MetricTile label="Threshold" value={`${slow.data?.threshold_ms ?? 500} ms`} icon="clock" />
                  <MetricTile label="Window" value={`${slow.data?.window_hours ?? 24} h`} icon="history" />
                  <MetricTile label="Slowest" icon="alert"
                    value={(slow.data?.queries || []).length
                      ? `${fmtNumber(Math.max(...slow.data.queries.map((x) => num(x.query_duration_ms))))} ms`
                      : '—'} />
                </div>
                <SlowQueriesPanel
                  rows={slow.data?.queries || []}
                  onOpen={() => navigate(`/clickhouse-dashboard/${id}/slow-queries`)}
                />
              </>
            )}
          </div>
        )}

        {/* ══ DATABASES ═════════════════════════════════════════════════════ */}
        {on('databases') && (
          <ObjectTable
            title="Databases"
            icon="server"
            columns={CH_DATABASE_COLUMNS}
            items={dbItems}
            loading={databases.isFetching || isFetching}
            searchOn={['name', 'engine']}
            searchPlaceholder="Search databases…"
            defaultSort={{ key: 'size', dir: 'desc' }}
            sizeOf={(row) => num(row.size_bytes)}
            keyOf={(row) => row.name}
            onOpen={(row) => { setTableDb(row.name); setActiveTab('tables'); }}
            onRowClick={(row) => { setTableDb(row.name); setActiveTab('tables'); }}
            unit="databases"
            views={['table']}
            note="Sizes are the compressed on-disk figures ClickHouse reports"
            emptyTitle="No databases"
            emptyBody="system.databases returned nothing for this user."
          />
        )}

        {/* ══ TABLES ════════════════════════════════════════════════════════ */}
        {on('tables') && (
          <ObjectTable
            title="Tables"
            icon="database"
            columns={CH_TABLE_COLUMNS}
            items={shownTables}
            loading={tables.isFetching || isFetching}
            searchOn={['name', 'database', 'engine']}
            searchPlaceholder="Search tables…"
            filter={{ value: tableDb, onChange: setTableDb, options: tableDbOptions }}
            defaultSort={{ key: 'total', dir: 'desc' }}
            sizeOf={(t) => num(t.total_bytes)}
            keyOf={(t) => `${t.database}.${t.name}`}
            unit="tables"
            note="Compression ratio and part count come from system.parts"
            emptyTitle="No tables"
            emptyBody="system.tables returned nothing outside the system databases."
          />
        )}

        {/* ══ PARTITIONS ════════════════════════════════════════════════════ */}
        {on('partitions') && (
          <div className="space-y-gutter">
            {partitions.isLoading ? <InlineLoading label="Reading system.parts…" /> : (
              <>
                <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4">
                  <MetricTile label="Partitions" value={partitionRows.length} icon="layers" />
                  <MetricTile label="Parts, busiest partition" value={fmtNumber(maxParts)} icon="boxes"
                    tone={partPct > 90 ? 'bad' : partPct > 60 ? 'warn' : 'good'}
                    sub={`${partPct}% of the ${fmtNumber(partsThreshold)} limit`} />
                  <MetricTile label="Total active parts" value={fmtNumber(totalParts)} icon="boxes" />
                  <MetricTile label="On disk" icon="desktop"
                    value={fmtBytes(partitionRows.reduce((a, p) => a + num(p.bytes), 0))} />
                </div>

                <TablePanel
                  title="Partitions"
                  icon="layers"
                  subtitle="Part count per partition — the number that decides whether inserts keep working"
                  actions={(
                    <Select value={partTable} onChange={setPartTable} options={partTableOptions}
                      size="sm" width="auto" />
                  )}
                >
                  <Paged rows={shownPartitions} unit="partitions">
                    {(page, pager) => (
                      <>
                        <Table
                          columns={[
                            { key: 'table', label: 'Table' },
                            { key: 'partition', label: 'Partition' },
                            { key: 'parts', label: 'Parts', align: 'right' },
                            { key: 'rows', label: 'Rows', align: 'right' },
                            { key: 'size', label: 'On disk', align: 'right' },
                            { key: 'marks', label: 'Marks', align: 'right' },
                            { key: 'active', label: 'Active' },
                          ]}
                          rows={page.map((p, i) => {
                            const parts = num(p.part_count);
                            return {
                              key: `${p.database}.${p.table}-${p.partition_id}-${i}`,
                              cells: {
                                table: (
                                  <span className="block">
                                    <span className="font-mono text-[12px] font-semibold text-accent-text">{p.table}</span>
                                    <span className="mt-0.5 block font-mono text-[10px] text-subtle">{p.database}</span>
                                  </span>
                                ),
                                partition: <span className="font-mono text-[11px]">{p.partition}</span>,
                                parts: (
                                  <span className={
                                    parts > partsThreshold * 0.9 ? 'font-mono font-bold text-danger-fg'
                                      : parts > partsThreshold * 0.6 ? 'font-mono font-bold text-warning-fg'
                                        : 'font-mono font-semibold'
                                  }>
                                    {fmtNumber(parts)}
                                  </span>
                                ),
                                rows: <span className="font-mono">{fmtNumber(p.rows)}</span>,
                                size: <span className="font-mono text-[12px]">{p.size_pretty || fmtBytes(p.bytes)}</span>,
                                marks: <span className="font-mono text-[12px] text-muted">{fmtNumber(p.marks)}</span>,
                                active: p.active
                                  ? <Badge tone="success" size="xs">Active</Badge>
                                  : <Badge tone="neutral" size="xs">Inactive</Badge>,
                              },
                            };
                          })}
                          empty={<EmptyState icon="layers" title="No partitions"
                            body={partitions.data?.error || 'system.parts returned nothing outside the system databases.'} />}
                        />
                        {pager}
                      </>
                    )}
                  </Paged>
                </TablePanel>

                <p className="flex items-start gap-1.5 text-[11px] text-subtle">
                  <Icon name="info" size={12} className="mt-0.5 shrink-0" />
                  Inactive parts are ones a merge has already superseded; ClickHouse removes them
                  after <span className="font-mono">old_parts_lifetime</span>, so seeing a few is normal.
                </p>
              </>
            )}
          </div>
        )}

        {/* ══ MERGES ════════════════════════════════════════════════════════ */}
        {on('merges') && (
          <div className="space-y-gutter">
            {merges.isLoading ? <InlineLoading label="Reading system.merges…" /> : (
              <>
                <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-3">
                  <MetricTile label="Merges running" value={liveMerges.length} icon="branch"
                    tone={liveMerges.length > 10 ? 'warn' : 'neutral'} />
                  <MetricTile label="Rows merged, lifetime" icon="rows"
                    value={fmtNumber(merges.data?.merge_rate_total_rows)} />
                  <MetricTile label="Longest running" icon="clock"
                    value={liveMerges.length
                      ? `${Math.round(Math.max(...liveMerges.map((m) => num(m.elapsed))))}s`
                      : '—'} />
                </div>

                <TablePanel title="Merges in progress" icon="branch"
                  subtitle="Background part merges — the process that keeps part counts down">
                  <Paged rows={liveMerges} unit="merges">
                    {(page, pager) => (
                      <>
                        <Table
                          columns={[
                            { key: 'table', label: 'Table' },
                            {
                              key: 'kind',
                              label: 'Kind',
                              hint: 'Regular is a routine merge; TTLDelete and TTLRecompress are '
                                + 'triggered by a TTL expression, not by part pressure.',
                            },
                            { key: 'progress', label: 'Progress' },
                            { key: 'elapsed', label: 'Elapsed', align: 'right' },
                            { key: 'parts', label: 'Parts in', align: 'right' },
                            { key: 'size', label: 'Size in', align: 'right' },
                            { key: 'read', label: 'Rows read', align: 'right' },
                            { key: 'written', label: 'Rows written', align: 'right' },
                            { key: 'mem', label: 'Memory', align: 'right' },
                            { key: 'result', label: 'Result part' },
                          ]}
                          rows={page.map((m, i) => ({
                            key: `${m.database}.${m.table}-${i}`,
                            cells: {
                              table: (
                                <span className="block">
                                  <span className="font-mono text-[12px] font-semibold text-accent-text">{m.table}</span>
                                  <span className="mt-0.5 block font-mono text-[10px] text-subtle">{m.database}</span>
                                </span>
                              ),
                              kind: (
                                <span className="flex flex-col gap-0.5">
                                  {m.merge_type && (
                                    <Badge tone={m.merge_type === 'Regular' ? 'neutral' : 'info'} size="xs">
                                      {m.merge_type}
                                    </Badge>
                                  )}
                                  {m.merge_algorithm && (
                                    <span className="font-mono text-[10px] text-subtle">{m.merge_algorithm}</span>
                                  )}
                                </span>
                              ),
                              progress: (
                                <span className="inline-flex w-28 items-center gap-2">
                                  <span className="w-9 shrink-0 text-right font-mono text-[12px] tabular-nums">
                                    {Math.round(num(m.progress) * 100)}%
                                  </span>
                                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken">
                                    <span className="block h-full rounded-full bg-accent"
                                      style={{ width: `${Math.min(100, num(m.progress) * 100)}%` }} />
                                  </span>
                                </span>
                              ),
                              elapsed: <span className="font-mono">{Math.round(num(m.elapsed))}s</span>,
                              parts: <span className="font-mono">{m.num_parts}</span>,
                              size: (
                                <span className="font-mono text-[12px] text-muted">
                                  {fmtBytes(m.total_size_bytes_compressed)}
                                </span>
                              ),
                              read: <span className="font-mono">{fmtNumber(m.rows_read)}</span>,
                              written: <span className="font-mono">{fmtNumber(m.rows_written)}</span>,
                              mem: <span className="font-mono text-[12px]">{fmtBytes(m.memory_usage)}</span>,
                              result: (
                                <span title={m.result_part_name}
                                  className="truncate-safe block max-w-[200px] font-mono text-[11px] text-muted">
                                  {m.result_part_name}
                                </span>
                              ),
                            },
                          }))}
                          empty={<EmptyState icon="check" title="No merges running"
                            body="Nothing is merging right now. On an idle server that is expected; if part counts are climbing it is not." />}
                        />
                        {pager}
                      </>
                    )}
                  </Paged>
                </TablePanel>
              </>
            )}
          </div>
        )}

        {/* ══ REPLICAS ══════════════════════════════════════════════════════ */}
        {on('replicas') && (
          <div className="space-y-gutter">
            {replicas.isLoading ? <InlineLoading label="Reading system.replicas…" /> : (
              <>
                <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-3 xl:grid-cols-6">
                  <MetricTile label="Replicated tables" value={replicas.data?.summary?.total_replicated_tables ?? 0} icon="copy" />
                  <MetricTile label="Leaders" value={replicas.data?.summary?.leaders ?? 0} icon="check" />
                  <MetricTile label="Read-only" value={replicas.data?.summary?.readonly ?? 0} icon="lock"
                    tone={num(replicas.data?.summary?.readonly) ? 'bad' : 'good'}
                    hint="A read-only replica has lost its ZooKeeper session and cannot accept writes" />
                  <MetricTile label="Behind" value={replicas.data?.summary?.with_delay ?? 0} icon="clock"
                    tone={num(replicas.data?.summary?.with_delay) ? 'warn' : 'good'} />
                  <MetricTile label="With errors" value={replicas.data?.summary?.with_errors ?? 0} icon="alert"
                    tone={num(replicas.data?.summary?.with_errors) ? 'bad' : 'good'} />
                  <MetricTile label="Total queue" value={fmtNumber(replicas.data?.summary?.total_queue_size)} icon="layers" />
                </div>

                {num(replicas.data?.summary?.readonly) > 0 && (
                  <Notice tone="danger" title="A replica is read-only.">
                    That happens when the replica loses its ZooKeeper session — it keeps serving reads
                    but silently accepts no writes. Check ZooKeeper connectivity from that host.
                  </Notice>
                )}

                <TablePanel title="Replicas" icon="copy"
                  subtitle="Ordered by how far behind they are, then by queue size">
                  <Paged rows={liveReplicas} unit="replicas">
                    {(page, pager) => (
                      <>
                        <Table
                          columns={[
                            { key: 'table', label: 'Table' },
                            { key: 'role', label: 'Role' },
                            { key: 'delay', label: 'Behind', align: 'right' },
                            { key: 'queue', label: 'Queue', align: 'right' },
                            { key: 'inserts', label: 'Inserts', align: 'right' },
                            { key: 'merges', label: 'Merges', align: 'right' },
                            { key: 'log', label: 'Log pointer / max', align: 'right' },
                            { key: 'replicas', label: 'Active / total', align: 'right' },
                            { key: 'problem', label: 'Last exception' },
                          ]}
                          rows={page.map((r, i) => {
                            const delay = num(r.absolute_delay);
                            return {
                              key: `${r.database}.${r.table}-${i}`,
                              cells: {
                                table: (
                                  <span className="block">
                                    <span className="font-mono text-[12px] font-semibold text-accent-text">{r.table}</span>
                                    <span className="mt-0.5 block font-mono text-[10px] text-subtle">{r.database}</span>
                                  </span>
                                ),
                                role: (
                                  <span className="flex flex-wrap gap-1">
                                    {r.is_leader ? <Badge tone="accent" size="xs">Leader</Badge> : null}
                                    {r.is_readonly ? <Badge tone="danger" size="xs">Read-only</Badge> : null}
                                    {r.is_session_expired ? <Badge tone="danger" size="xs">Session expired</Badge> : null}
                                    {!r.is_leader && !r.is_readonly && !r.is_session_expired
                                      ? <Badge tone="neutral" size="xs">Follower</Badge> : null}
                                  </span>
                                ),
                                delay: (
                                  <span className={
                                    delay > 300 ? 'font-mono font-bold text-danger-fg'
                                      : delay > 60 ? 'font-mono font-bold text-warning-fg' : 'font-mono'
                                  }>
                                    {delay ? `${fmtNumber(delay)}s` : '0s'}
                                  </span>
                                ),
                                queue: <span className="font-mono">{fmtNumber(r.queue_size)}</span>,
                                inserts: <span className="font-mono">{fmtNumber(r.inserts_in_queue)}</span>,
                                merges: <span className="font-mono">{fmtNumber(r.merges_in_queue)}</span>,
                                log: (
                                  <span className="font-mono text-[11px]">
                                    {r.log_pointer ?? '—'} / {r.log_max_index ?? '—'}
                                  </span>
                                ),
                                replicas: (
                                  <span className="font-mono text-[11px]">
                                    {r.active_replicas ?? '—'} / {r.total_replicas ?? '—'}
                                  </span>
                                ),
                                /* Two distinct failures, and they mean different things: a queue
                                   exception is this replica failing to apply a log entry;
                                   a ZooKeeper exception is it losing contact with the
                                   coordinator entirely. */
                                problem: (r.last_queue_update_exception || r.zookeeper_exception)
                                  ? (
                                    <span className="block max-w-[240px] text-[11px] break-words text-danger-fg">
                                      {r.zookeeper_exception
                                        ? `ZooKeeper: ${r.zookeeper_exception}`
                                        : r.last_queue_update_exception}
                                    </span>
                                  )
                                  : null,
                              },
                            };
                          })}
                          empty={<EmptyState icon="copy" title="No replicated tables"
                            body="system.replicas is empty — no table on this server uses a Replicated engine." />}
                        />
                        {pager}
                      </>
                    )}
                  </Paged>
                </TablePanel>
              </>
            )}
          </div>
        )}

        {/* ══ CLUSTERS ══════════════════════════════════════════════════════ */}
        {on('clusters') && (
          <div className="space-y-gutter">
            {clusters.isLoading ? <InlineLoading label="Reading system.clusters…" /> : (
              <>
                <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-3">
                  <MetricTile label="Clusters" value={(clusters.data?.cluster_summary || []).length} icon="network" />
                  <MetricTile label="Hosts" value={clusters.data?.total_hosts ?? 0} icon="server" />
                  <MetricTile label="Hosts with errors" icon="alert"
                    value={(clusters.data?.clusters || []).filter((c) => num(c.errors_count) > 0).length}
                    tone={(clusters.data?.clusters || []).some((c) => num(c.errors_count) > 0) ? 'bad' : 'good'} />
                </div>

                {(clusters.data?.cluster_summary || []).length > 0 && (
                  <div className="grid gap-gutter-sm sm:grid-cols-2 xl:grid-cols-3">
                    {clusters.data.cluster_summary.map((c) => (
                      <Panel key={c.name} title={c.name} icon="network">
                        <div className="grid grid-cols-3 gap-gutter-sm">
                          <StatCell label="Shards" value={c.shards} />
                          <StatCell label="Replicas" value={c.replicas} />
                          <StatCell label="Errors" value={c.errors}
                            tone={num(c.errors) ? 'bad' : 'good'} />
                        </div>
                      </Panel>
                    ))}
                  </div>
                )}

                <TablePanel title="Cluster hosts" icon="server"
                  subtitle="Every shard/replica this server knows about, from its own config">
                  <Paged rows={clusters.data?.clusters || []} unit="hosts">
                    {(page, pager) => (
                      <>
                        <Table
                          columns={[
                            { key: 'cluster', label: 'Cluster' },
                            { key: 'shard', label: 'Shard', align: 'right' },
                            { key: 'replica', label: 'Replica', align: 'right' },
                            { key: 'host', label: 'Host' },
                            { key: 'local', label: 'Local' },
                            { key: 'user', label: 'User' },
                            { key: 'errors', label: 'Errors', align: 'right' },
                            { key: 'slow', label: 'Slowdowns', align: 'right' },
                          ]}
                          rows={page.map((c, i) => ({
                            key: `${c.cluster}-${c.shard_num}-${c.replica_num}-${i}`,
                            cells: {
                              cluster: <span className="font-mono text-[12px] font-semibold text-accent-text">{c.cluster}</span>,
                              shard: <span className="font-mono">{c.shard_num}</span>,
                              replica: <span className="font-mono">{c.replica_num}</span>,
                              host: (
                                <span className="block text-[11px] leading-tight">
                                  <span className="block font-mono text-fg">{c.host_name}:{c.port}</span>
                                  {c.host_address && <span className="block text-subtle">{c.host_address}</span>}
                                </span>
                              ),
                              local: c.is_local ? <Badge tone="accent" size="xs">This server</Badge> : null,
                              user: <span className="text-[11px] text-muted">{c.user}</span>,
                              errors: (
                                <span className={num(c.errors_count) ? 'font-mono font-bold text-danger-fg' : 'font-mono'}>
                                  {fmtNumber(c.errors_count)}
                                </span>
                              ),
                              slow: <span className="font-mono">{fmtNumber(c.slowdowns_count)}</span>,
                            },
                          }))}
                          empty={<EmptyState icon="network" title="No clusters configured"
                            body="system.clusters lists only this server — no distributed cluster is defined in remote_servers." />}
                        />
                        {pager}
                      </>
                    )}
                  </Paged>
                </TablePanel>
              </>
            )}
          </div>
        )}

        {/* ══ SYSTEM METRICS ════════════════════════════════════════════════ */}
        {on('sysmetrics') && (
          <div className="space-y-gutter">
            {sysMetrics.isLoading ? <InlineLoading label="Reading system.metrics…" /> : (
              <>
                <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4 xl:grid-cols-6">
                  <MetricTile label="Memory resident" icon="memory"
                    value={fmtBytes(sysMetrics.data?.summary?.memory_resident_bytes)}
                    sub={`${sysMetrics.data?.summary?.memory_pct ?? 0}% of host`} />
                  <MetricTile label="Query threads" value={fmtNumber(sysMetrics.data?.summary?.query_threads)} icon="cpu" />
                  <MetricTile label="Active merges" value={fmtNumber(sysMetrics.data?.summary?.active_merges)} icon="branch" />
                  <MetricTile label="Total parts" value={fmtNumber(sysMetrics.data?.summary?.total_parts)} icon="boxes" />
                  <MetricTile label="Failed queries" value={fmtNumber(sysMetrics.data?.summary?.failed_queries)} icon="alert"
                    tone={num(sysMetrics.data?.summary?.failed_queries) ? 'warn' : 'good'} />
                  <MetricTile label="Rows merged" value={fmtNumber(sysMetrics.data?.summary?.merged_rows)} icon="rows" />
                </div>

                <div className="grid gap-gutter xl:grid-cols-2">
                  <Panel title="Throughput" icon="activity"
                    subtitle="Counters since the server started — compare two readings to get a rate">
                    <DefRow label="Queries" value={fmtNumber(sysMetrics.data?.summary?.total_queries)} />
                    <DefRow label="SELECT" value={fmtNumber(sysMetrics.data?.summary?.select_queries)} />
                    <DefRow label="INSERT" value={fmtNumber(sysMetrics.data?.summary?.insert_queries)} />
                    <DefRow label="Failed" value={fmtNumber(sysMetrics.data?.summary?.failed_queries)} />
                    <DefRow label="Compressed read" value={fmtBytes(sysMetrics.data?.summary?.read_compressed_bytes)} />
                    <DefRow label="Compressed written" value={fmtBytes(sysMetrics.data?.summary?.write_compressed_bytes)} />
                    <DefRow label="Network received" value={fmtBytes(sysMetrics.data?.summary?.network_receive_bytes)} />
                    <DefRow label="Network sent" value={fmtBytes(sysMetrics.data?.summary?.network_send_bytes)} />
                  </Panel>

                  <Panel title="Parts and replication" icon="layers">
                    <DefRow label="Total parts" value={fmtNumber(sysMetrics.data?.summary?.total_parts)} />
                    <DefRow label="Busiest partition" value={fmtNumber(sysMetrics.data?.summary?.max_part_count_for_partition)}
                      tone={num(sysMetrics.data?.summary?.max_part_count_for_partition) > MAX_PARTS_WARN ? 'warn' : undefined} />
                    <DefRow label="Largest replica queue" value={fmtNumber(sysMetrics.data?.summary?.replicas_max_queue)} />
                    <DefRow label="Largest replica delay"
                      value={sysMetrics.data?.summary?.replicas_max_delay != null
                        ? `${fmtNumber(sysMetrics.data.summary.replicas_max_delay)}s` : null}
                      tone={num(sysMetrics.data?.summary?.replicas_max_delay) > 60 ? 'warn' : undefined} />
                    <DefRow label="Host memory" value={fmtBytes(sysMetrics.data?.summary?.memory_total_bytes)} />
                  </Panel>
                </div>

                <TablePanel
                  title="All current metrics"
                  icon="chart-bar"
                  subtitle="system.metrics — instantaneous gauges, not counters"
                  actions={(
                    <Input
                      value={metricSearch}
                      onChange={(e) => setMetricSearch(e.target.value)}
                      onClear={() => setMetricSearch('')}
                      placeholder="Search metrics…"
                      icon="search"
                      size="sm"
                      wrapperClassName="w-44"
                    />
                  )}
                >
                  <Paged
                    rows={(sysMetrics.data?.metrics || metrics).filter((m) => (
                      !metricSearch.trim()
                      || `${m.metric} ${m.description || ''}`.toLowerCase().includes(metricSearch.trim().toLowerCase())
                    ))}
                    unit="metrics"
                  >
                    {(page, pager) => (
                      <>
                        <Table
                          columns={[
                            { key: 'metric', label: 'Metric' },
                            { key: 'value', label: 'Value', align: 'right' },
                            { key: 'desc', label: 'What it means' },
                          ]}
                          rows={page.map((m, i) => ({
                            key: `${m.metric}-${i}`,
                            cells: {
                              metric: <span className="font-mono text-[12px] font-semibold">{m.metric}</span>,
                              value: <span className="font-mono">{fmtNumber(m.value)}</span>,
                              desc: <span className="block max-w-[420px] text-[11px] leading-snug text-muted">{m.description}</span>,
                            },
                          }))}
                          empty={<EmptyState icon="chart-bar" title="No metrics" />}
                        />
                        {pager}
                      </>
                    )}
                  </Paged>
                </TablePanel>
              </>
            )}
          </div>
        )}

        {/* ══ SETTINGS ══════════════════════════════════════════════════════ */}
        {on('settings') && (
          <div className="space-y-gutter">
            {settings.isLoading ? <InlineLoading label="Reading system.settings…" /> : (
              <TablePanel
                title="Settings"
                icon="settings"
                subtitle={`${settings.data?.changed_count ?? 0} changed from the default, plus the ones worth checking`}
                actions={(
                  <Input
                    value={settingSearch}
                    onChange={(e) => setSettingSearch(e.target.value)}
                    onClear={() => setSettingSearch('')}
                    placeholder="Search settings…"
                    icon="search"
                    size="sm"
                    wrapperClassName="w-44"
                  />
                )}
              >
                <Paged
                  rows={(settings.data?.settings || settingRows).filter((s) => (
                    !settingSearch.trim()
                    || `${s.name} ${s.value}`.toLowerCase().includes(settingSearch.trim().toLowerCase())
                  ))}
                  unit="settings"
                >
                  {(page, pager) => (
                    <>
                      <Table
                        columns={[
                          { key: 'name', label: 'Setting' },
                          { key: 'value', label: 'Value' },
                          { key: 'changed', label: 'Default' },
                          { key: 'readonly', label: 'Writable' },
                          { key: 'desc', label: 'What it does' },
                        ]}
                        rows={page.map((s, i) => ({
                          key: `${s.name}-${i}`,
                          cells: {
                            name: <span className="font-mono text-[12px] font-semibold text-accent-text">{s.name}</span>,
                            value: (
                              <span title={String(s.value)}
                                className="truncate-safe block max-w-[200px] font-mono text-[12px] text-fg">
                                {String(s.value) || <span className="text-subtle">(empty)</span>}
                              </span>
                            ),
                            changed: s.changed
                              ? <Badge tone="accent" size="xs">Changed</Badge>
                              : <Badge tone="neutral" size="xs">Default</Badge>,
                            readonly: num(s.readonly) === 0
                              ? <Badge tone="success" size="xs">Yes</Badge>
                              : <Badge tone="neutral" size="xs">Read-only</Badge>,
                            desc: <span className="block max-w-[380px] text-[11px] leading-snug text-muted">{s.description}</span>,
                          },
                        }))}
                        empty={<EmptyState icon="settings" title="No settings returned" />}
                      />
                      {pager}
                    </>
                  )}
                </Paged>
              </TablePanel>
            )}
          </div>
        )}
      </div>
    </DashboardScopeProvider>
  );
}

/* ── shared panels ────────────────────────────────────────────────────────── */

function RunningQueriesPanel({ rows, openRow, setOpenRow }) {
  return (
    <TablePanel title={`Running queries (${rows.length})`} icon="zap"
      subtitle="system.processes — what the server is executing right now. Select a row for the full SQL.">
      <Paged rows={rows} unit="queries">
        {(page, pager) => (
          <>
            <Table
              columns={[
                { key: 'id', label: 'Query ID' },
                { key: 'user', label: 'User' },
                { key: 'db', label: 'Database' },
                { key: 'elapsed', label: 'Running for', align: 'right' },
                { key: 'rows', label: 'Rows read', align: 'right' },
                { key: 'bytes', label: 'Bytes read', align: 'right' },
                { key: 'mem', label: 'Memory', align: 'right' },
                { key: 'sql', label: 'Query' },
              ]}
              rows={page.map((qr, i) => {
                const key = `${qr.query_id}-${i}`;
                return {
                  key,
                  onClick: () => setOpenRow(openRow === key ? null : key),
                  cells: {
                    id: (
                      <span className="flex items-center gap-1.5">
                        <Icon name={openRow === key ? 'chevron-down' : 'chevron-right'} size={12} className="text-subtle" />
                        <span className="truncate-safe block max-w-[130px] font-mono text-[11px]">{qr.query_id}</span>
                      </span>
                    ),
                    user: <span className="text-[12px] font-semibold text-accent-text">{qr.user}</span>,
                    db: qr.current_database ? <Badge tone="accent" size="xs">{qr.current_database}</Badge> : null,
                    elapsed: (
                      <span className={num(qr.elapsed) > 30 ? 'font-mono font-bold text-warning-fg' : 'font-mono font-semibold'}>
                        {num(qr.elapsed).toFixed(1)}s
                      </span>
                    ),
                    rows: <span className="font-mono">{fmtNumber(qr.read_rows)}</span>,
                    bytes: <span className="font-mono text-[12px]">{fmtBytes(qr.read_bytes)}</span>,
                    mem: <span className="font-mono text-[12px]">{fmtBytes(qr.memory_usage)}</span>,
                    sql: <SqlCell sql={qr.query} max={90} />,
                  },
                };
              })}
              empty={<EmptyState icon="check" title="Nothing running"
                body="system.processes is empty — the server is idle." />}
            />
            {page.map((qr, i) => {
              const key = `${qr.query_id}-${i}`;
              if (openRow !== key) return null;
              return (
                <div key={key} className="space-y-2 border-t border-border bg-sunken px-card py-3">
                  <div className="grid gap-gutter-sm sm:grid-cols-4">
                    <StatCell label="Running for" value={`${num(qr.elapsed).toFixed(1)}s`} />
                    <StatCell label="Rows read" value={fmtNumber(qr.read_rows)} />
                    {/* system.processes has no result count — a running query has not produced
                        one yet. total_rows_approx is what it expects to read, so
                        read_rows against it is the only real progress figure here. */}
                    <StatCell label="Rows written" value={fmtNumber(qr.written_rows)} />
                    <StatCell
                      label="Progress"
                      value={num(qr.total_rows_approx) > 0
                        ? `${Math.min(100, Math.round((num(qr.read_rows) / num(qr.total_rows_approx)) * 100))}%`
                        : '—'}
                      hint={num(qr.total_rows_approx) > 0
                        ? `${fmtNumber(qr.read_rows)} of about ${fmtNumber(qr.total_rows_approx)} rows`
                        : 'ClickHouse could not estimate a total for this query'}
                    />
                    <StatCell label="Memory" value={fmtBytes(qr.memory_usage)}
                      hint={num(qr.peak_memory_usage) > num(qr.memory_usage)
                        ? `peaked at ${fmtBytes(qr.peak_memory_usage)}`
                        : undefined} />
                  </div>
                  <div className="flex items-start gap-2">
                    <SqlBlock sql={qr.query || '(empty)'} className="max-h-52 flex-1 overflow-auto" />
                    <CopyButton text={qr.query} />
                  </div>
                  <p className="text-[11px] text-subtle">
                    Truncated to 400 characters by the collector.
                    {qr.is_initial_query === false
                      ? ' This is a secondary query — part of a distributed query started elsewhere.'
                      : ''}
                  </p>
                </div>
              );
            })}
            {pager}
          </>
        )}
      </Paged>
    </TablePanel>
  );
}

function SlowQueriesPanel({ rows, onOpen }) {
  return (
    <TablePanel title="Slowest queries" icon="trend"
      subtitle="Finished queries over the threshold in the last 24 hours, slowest first"
      actions={<Button size="sm" variant="secondary" iconRight="chevron-right" onClick={onOpen}>
        Full analysis
      </Button>}>
      <Paged rows={rows} unit="queries">
        {(page, pager) => (
          <>
            <Table
              columns={[
                { key: 'when', label: 'Time' },
                { key: 'user', label: 'User' },
                { key: 'ms', label: 'Duration', align: 'right' },
                { key: 'rows', label: 'Rows read', align: 'right' },
                { key: 'bytes', label: 'Bytes read', align: 'right' },
                { key: 'mem', label: 'Peak memory', align: 'right' },
                { key: 'sql', label: 'Query' },
              ]}
              rows={page.map((s, i) => ({
                key: `${s.query_id}-${i}`,
                cells: {
                  when: <span className="font-mono text-[11px] whitespace-nowrap text-muted">{String(s.event_time || '').slice(0, 19)}</span>,
                  user: <span className="text-[11px] text-muted">{s.user}</span>,
                  ms: (
                    <span className={num(s.query_duration_ms) > 10000 ? 'font-mono font-bold text-danger-fg' : 'font-mono font-semibold'}>
                      {fmtNumber(s.query_duration_ms)} ms
                    </span>
                  ),
                  rows: <span className="font-mono">{fmtNumber(s.read_rows)}</span>,
                  bytes: <span className="font-mono text-[12px]">{fmtBytes(s.read_bytes)}</span>,
                  mem: <span className="font-mono text-[12px]">{fmtBytes(s.memory_usage)}</span>,
                  sql: (
                    <span className="block">
                      <SqlCell sql={s.query} max={90} />
                      {s.exception && (
                        <span className="mt-0.5 block max-w-[380px] text-[11px] break-words text-danger-fg">{s.exception}</span>
                      )}
                    </span>
                  ),
                },
              }))}
              empty={<EmptyState icon="check" title="No slow queries"
                body="No query in the last 24 hours took longer than the threshold." />}
            />
            {pager}
          </>
        )}
      </Paged>
    </TablePanel>
  );
}
