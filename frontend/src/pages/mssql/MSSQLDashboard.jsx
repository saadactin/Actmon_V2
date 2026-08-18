import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, Database, GitBranch, HardDrive, Lock, Search, Table, TrendingUp, Users, Zap,
} from 'lucide-react';
import client from '@/api/client';
import { mssqlTableDetail } from '@/api/drilldown';

import EngineDashboardHeader from '@/components/layout/EngineDashboardHeader';
import HostResources from '@/pages/postgresql/PgHostResources';
import TrendChart from '@/components/gauges/TrendChart';
import ChartCard from '@/components/charts/ChartCard';
import { bandFor, STATUS } from '@/components/charts/status';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import CopyButton from '@/components/ui/CopyButton';
import Dialog from '@/components/ui/Dialog';
import Icon from '@/components/ui/Icon';
import Notice from '@/components/ui/Notice';
import Table2, { EmptyState } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';
import { Paged } from '@/components/ui/Pagination';
import { DashboardScopeProvider } from '@/context/DashboardAppearanceContext';

import ObjectTable from '@/pages/_shared/ObjectTable';
import TableDetailsDialog from '@/pages/_shared/TableDetails';
import { adaptMssqlTableDetails } from '@/pages/_shared/tableDetailsAdapters';
import {
  DefRow, MetricTile, Panel, SqlBlock, SqlCell, StatCell, StateChip, StatusPill, TablePanel, UsageBar,
} from '@/pages/_shared/enginePanels';
import {
  DATABASE_COLUMNS, MSSQL_DATABASE_EXTRAS, MSSQL_DATABASE_HINTS, MSSQL_TABLE_EXTRAS,
  TABLE_COLUMNS, fmtBytes, fmtNumber, mssqlDatabaseRow, mssqlTableRow, orderColumns,
  withExtras, withHints, withoutColumns,
} from '@/config/dbCatalog';
import { MSSQL_DASHBOARD_TABS } from '@/config/mssqlDashboardNav';

/**
 * SQL Server dashboard.
 *
 * Ported from the existing module: same nine tabs, same information in the same
 * order — every field is bound to what `/monitoring-dashboard` actually returns.
 * The existing page used to read `locks.lock_waits_sec`, `disk_io.reads`,
 * `always_on.replicas`, `sessions.idle` and a dozen `databases[]` columns that
 * the collector has never returned — `locks` and `disk_io` are ARRAYS, and
 * `always_on` is `{enabled, groups}`. Those panels could only ever render
 * "—", so here they render the arrays they are actually given.
 */

const REFRESH_INTERVAL = 15; // seconds
const SYSTEM_DATABASES = ['master', 'model', 'msdb', 'tempdb'];

const fetchDashboard = (id) =>
  client.get(`/connections/mssql/${id}/monitoring-dashboard`).then((r) => r.data);

const TABS = MSSQL_DASHBOARD_TABS;

/* SQL Server state vocabulary → the shared tones. Only values that carry meaning
   are mapped; anything else stays neutral rather than being colour-guessed. */
const DB_STATE_TONES = {
  ONLINE: 'success', OFFLINE: 'danger', SUSPECT: 'danger', RECOVERY_PENDING: 'danger',
  RESTORING: 'warning', RECOVERING: 'warning', EMERGENCY: 'danger', COPYING: 'info',
};
const SESSION_STATE_TONES = {
  RUNNING: 'success', RUNNABLE: 'success', SLEEPING: 'neutral',
  SUSPENDED: 'warning', BACKGROUND: 'info', DORMANT: 'neutral', ROLLBACK: 'danger',
};
const SYNC_TONES = {
  HEALTHY: 'success', SYNCHRONIZED: 'success', SYNCHRONIZING: 'warning',
  PARTIALLY_HEALTHY: 'warning', NOT_HEALTHY: 'danger', 'NOT SYNCHRONIZING': 'danger',
};
const LONG_QUERY_MS = 5000;
const num = (v) => Number(v) || 0;
const mb = (v) => num(v) * 1048576;

/** 0–100 health score. Same weighting as the existing dashboard. */
function computeHealthScore({ connPct, cachePct, blocking, cpuPct, memPct }) {
  let score = 100;
  if (connPct > 90) score -= 30;
  else if (connPct > 70) score -= 15;
  if (cachePct > 0 && cachePct < 80) score -= 20;
  else if (cachePct > 0 && cachePct < 90) score -= 10;
  if (blocking > 5) score -= 20;
  else if (blocking > 0) score -= 10;
  if (cpuPct > 90) score -= 15;
  else if (cpuPct > 75) score -= 8;
  if (memPct > 90) score -= 10;
  return Math.max(0, score);
}

function HealthBadge({ score }) {
  const band = score >= 80 ? STATUS.good : score >= 60 ? STATUS.warning : STATUS.critical;
  return (
    <span
      className="flex h-control shrink-0 items-center gap-1.5 rounded-control px-2.5 text-[12px] font-bold text-white"
      style={{ background: band.color }}
      title={`Composite of connection use, buffer cache hit rate, blocking, CPU and memory (${score}/100)`}
    >
      <Icon name="activity" size={13} />
      Health {score}
    </span>
  );
}

/* ── SQL Server column sets, composed from the shared catalogue ─────────────── */

/* `encoding` is dropped rather than left empty: SQL Server's per-database
   collation IS collected (collation_name), but there is no character set to pair
   it with, so it reads better in the Recovery/Compat group. */
const MSSQL_DATABASE_COLUMNS = withExtras(
  withHints(withoutColumns(DATABASE_COLUMNS, ['encoding']), MSSQL_DATABASE_HINTS),
  MSSQL_DATABASE_EXTRAS,
);

/* Explicit order so Schema lands beside Database instead of after Total Size.
   `engine`, `cols` and `idx` are dropped — SQL Server has no per-table storage
   engine, and the collector does not count columns or indexes per table. */
const MSSQL_TABLE_COLUMNS = orderColumns(TABLE_COLUMNS, [
  'database', MSSQL_TABLE_EXTRAS.schema, 'name', 'rows', 'data', 'indexes', 'total',
  'updated', MSSQL_TABLE_EXTRAS.missing, 'actions',
]);

export default function MSSQLDashboard() {
  const { id, tab } = useParams();
  const navigate = useNavigate();

  const activeTab = tab || 'overview';
  const setActiveTab = (t) =>
    navigate(`/mssql-dashboard/${id}${t && t !== 'overview' ? `/${t}` : ''}`);

  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const [trend, setTrend] = useState({ conn: [], cache: [], cpu: [] });
  const [tablesDb, setTablesDb] = useState('__all__');
  const [tableDetail, setTableDetail] = useState(null); // { loading, data, err, title }
  const countRef = useRef(null);

  const { data, isLoading, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['mssqlDashboard', id],
    queryFn: () => fetchDashboard(id),
    retry: false,
    refetchInterval: REFRESH_INTERVAL * 1000,
  });

  /* Countdown to the next auto-refresh, restarted whenever data lands. */
  useEffect(() => {
    setCountdown(REFRESH_INTERVAL);
    clearInterval(countRef.current);
    countRef.current = setInterval(
      () => setCountdown((c) => (c <= 1 ? REFRESH_INTERVAL : c - 1)),
      1000,
    );
    return () => clearInterval(countRef.current);
  }, [dataUpdatedAt]);

  /* Live trend: the payload is a snapshot, so history only exists for as long as
     the page has been open. Capped at 20 points. */
  useEffect(() => {
    if (!data) return;
    const hs = data.health_summary || {};
    const t = new Date().toLocaleTimeString();
    setTrend((prev) => ({
      conn: [...prev.conn.slice(-19), { t, v: num(hs.connection_usage_pct) }],
      cache: [...prev.cache.slice(-19), { t, v: num(hs.buffer_cache_hit_pct) }],
      cpu: [...prev.cpu.slice(-19), { t, v: num(hs.host_cpu_pct) }],
    }));
  }, [data]);

  const openDbTables = (db) => {
    setTablesDb(db?.name || '__all__');
    setActiveTab('tables');
  };

  const fetchTableDetail = (database, schema, table) => {
    mssqlTableDetail(id, database, schema, table)
      .then((d) => setTableDetail((prev) => (prev ? { ...prev, loading: false, data: d, err: null } : prev)))
      .catch((e) => setTableDetail((prev) => (prev ? { ...prev, loading: false, err: e?.message || String(e) } : prev)));
  };
  const openTableDetail = (t) => {
    setTableDetail({ database: t.database, schema: t.schema, table: t.name, loading: true, data: null, err: null });
    fetchTableDetail(t.database, t.schema, t.name);
  };

  /* Everything derived from the payload, in ONE memo above the early returns.
     Two reasons it is shaped this way: hooks may not sit after a conditional
     return, and `clean()` builds new arrays every render — so several small memos
     keyed on those arrays would never actually hit. */
  const d = useMemo(() => {
    const p = data || {};
    /* The collector reports a per-query failure by putting {error} in that list,
       so a partial failure still returns a structurally valid payload. Strip those
       rows out and surface them once, rather than rendering "undefined". */
    const clean = (list) => (Array.isArray(list) ? list.filter((r) => r && !r.error) : []);
    const errorOf = (list) => (Array.isArray(list) ? list.find((r) => r?.error)?.error : null);

    const hs = p.health_summary || {};
    const cpu = p.cpu || {};
    const memory = p.memory || {};
    const alwaysOn = p.always_on || {};
    const blocking = Array.isArray(p.blocking) ? p.blocking : [];

    const dbRows = clean(p.databases);
    const tableRows = clean(p.tables);
    const queryRows = clean(p.active_queries);

    const tableCounts = {};
    tableRows.forEach((t) => {
      const k = t.db_name || '';
      tableCounts[k] = tableCounts[k] || { count: 0, bytes: 0 };
      tableCounts[k].count += 1;
      tableCounts[k].bytes += mb(t.total_mb);
    });

    const dbItems = dbRows.map((row) => mssqlDatabaseRow(row, tableCounts));
    const tableItems = tableRows.map(mssqlTableRow);

    const connPct = num(hs.connection_usage_pct);
    const cachePct = num(hs.buffer_cache_hit_pct);
    const cpuPct = num(cpu.host_cpu_pct ?? hs.host_cpu_pct);
    const memPct = num(hs.memory_usage_pct ?? memory.host_used_pct);
    const agGroups = Array.isArray(alwaysOn.groups) ? alwaysOn.groups : [];
    const longRunning = queryRows.filter((q) => num(q.duration_ms) > LONG_QUERY_MS);

    return {
      connection: p.connection || {},
      hs,
      cpu,
      memory,
      serverInfo: p.server_info || {},
      sessions: p.sessions || {},
      replication: p.replication || {},
      alwaysOn,
      blocking,
      users: Array.isArray(p.users) ? p.users : [],

      dbItems,
      tableItems,
      waitRows: clean(p.wait_stats),
      queryRows,
      ioRows: clean(p.disk_io),
      topQueryRows: clean(p.top_queries),
      waitingRequests: clean(p.locks),

      connPct,
      cachePct,
      cpuPct,
      sqlCpuPct: num(cpu.sql_server_cpu_pct),
      memPct,
      longRunning,
      agGroups,
      hasAlwaysOn: Boolean(alwaysOn.enabled && agGroups.length),
      unhealthyAg: agGroups.filter(
        (g) => g.synchronization_health_desc && g.synchronization_health_desc !== 'HEALTHY',
      ),
      healthScore: computeHealthScore({
        connPct, cachePct, blocking: blocking.length, cpuPct, memPct,
      }),

      tableDbOptions: [
        { id: '__all__', label: 'All databases' },
        ...[...new Set(tableItems.map((t) => t.database).filter(Boolean))].sort()
          .map((name) => ({ id: name, label: name })),
      ],

      collectorErrors: Object.entries({
        databases: p.databases,
        wait_stats: p.wait_stats,
        active_queries: p.active_queries,
        'disk I/O': p.disk_io,
        tables: p.tables,
        top_queries: p.top_queries,
      })
        .map(([label, list]) => {
          const msg = errorOf(list);
          return msg ? `${label}: ${msg}` : null;
        })
        .filter(Boolean),
    };
  }, [data]);

  if (isLoading) return <PageLoading title="Connecting to SQL Server…" />;

  if (error || data?.status === 'error') {
    return (
      <div className="max-w-2xl">
        <Notice tone="danger" title="Connection failed.">
          {data?.error || error?.message || 'SQL Server did not respond.'}
        </Notice>
        <Button variant="primary" icon="refresh" onClick={() => refetch()}>Retry</Button>
      </div>
    );
  }

  const {
    connection, hs, cpu, memory, serverInfo, sessions, replication, blocking,
    users, dbItems, tableItems, waitRows, queryRows,
    ioRows, topQueryRows, waitingRequests, connPct, cachePct, cpuPct, sqlCpuPct,
    memPct, longRunning, agGroups, hasAlwaysOn, unhealthyAg, healthScore,
    tableDbOptions, collectorErrors,
  } = d;

  const alerts = {
    queries: longRunning.length,
    locks: blocking.length,
    replication: unhealthyAg.length,
  };

  const shownTables = tablesDb === '__all__'
    ? tableItems
    : tableItems.filter((t) => t.database === tablesDb);

  return (
    <DashboardScopeProvider tech="mssql">
      <div className="flex min-h-full flex-col">
        <EngineDashboardHeader
          tech="mssql"
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
          <Notice tone="warning" title="Some metrics could not be collected.">
            {collectorErrors.join(' · ')}
          </Notice>
        )}

        {/* ══ OVERVIEW ══════════════════════════════════════════════════════ */}
        {activeTab === 'overview' && (
          <div className="space-y-gutter">
            <div className="grid grid-cols-2 gap-gutter-sm sm:grid-cols-4 xl:grid-cols-8">
              <MetricTile label="Version" icon="server" value={hs.version || '—'}
                sub={hs.edition || undefined} />
              <MetricTile label="Uptime" icon="clock" value={hs.uptime || '—'}
                sub={hs.last_restart && hs.last_restart !== 'N/A' ? `since ${hs.last_restart}` : undefined} />
              <MetricTile label="Databases" icon="database" value={hs.total_databases ?? dbItems.length}
                onClick={() => setActiveTab('databases')} />
              <MetricTile label="Active sessions" icon="users" value={hs.active_sessions ?? sessions.active ?? '—'}
                sub={`of ${fmtNumber(hs.max_connections)} max`} onClick={() => setActiveTab('users')} />
              <MetricTile label="Buffer cache" icon="memory" value={cachePct ? `${cachePct}%` : '—'}
                tone={cachePct === 0 ? 'neutral' : cachePct < 90 ? 'bad' : 'good'}
                onClick={() => setActiveTab('performance')} />
              <MetricTile label="Host CPU" icon="cpu" value={`${cpuPct}%`}
                tone={cpuPct > 85 ? 'bad' : cpuPct > 65 ? 'warn' : 'good'}
                sub={`SQL Server ${sqlCpuPct}%`} onClick={() => setActiveTab('performance')} />
              <MetricTile label="Wait types" icon="clock" value={waitRows.length || '—'}
                onClick={() => setActiveTab('performance')} />
              <MetricTile label="Disk footprint" icon="desktop"
                value={hs.total_size_gb > 0.1 ? `${hs.total_size_gb} GB` : `${hs.total_size_mb || 0} MB`}
                sub="data + log" onClick={() => setActiveTab('storage')} />
            </div>

            <HostResources connId={id} tech="mssql" />

            <div className="flex flex-wrap gap-2">
              <StatusPill ok={connPct < 80} label={`Connections ${connPct}%`}
                onClick={() => setActiveTab('users')} />
              <StatusPill ok={cachePct >= 90} label={`Buffer cache ${cachePct}%`}
                hint="Below 90% means pages are being read from disk more often than they should be."
                onClick={() => setActiveTab('performance')} />
              <StatusPill ok={cpuPct < 85} label={`CPU ${cpuPct}%`}
                onClick={() => setActiveTab('performance')} />
              <StatusPill ok={memPct < 90} label={`Host memory ${memPct}%`}
                onClick={() => setActiveTab('performance')} />
              <StatusPill ok={blocking.length === 0}
                label={`Blocking: ${blocking.length} chain${blocking.length === 1 ? '' : 's'}`}
                onClick={() => setActiveTab('locks')} />
              <StatusPill ok={!hasAlwaysOn || unhealthyAg.length === 0}
                label={hasAlwaysOn
                  ? `AlwaysOn: ${agGroups.map((g) => g.synchronization_health_desc || g.ag_name).join(', ')}`
                  : `Replication: ${replication.state || 'STANDALONE'}`}
                onClick={() => setActiveTab('replication')} />
              {longRunning.length > 0 && (
                <StatusPill ok={false}
                  label={`${longRunning.length} quer${longRunning.length === 1 ? 'y' : 'ies'} over ${LONG_QUERY_MS / 1000}s`}
                  onClick={() => setActiveTab('queries')} />
              )}
            </div>

            {/* Utilisation as one card, so all four read against the same scale and
                the reader can switch between meters and gauges. */}
            <div className="grid gap-gutter xl:grid-cols-2">
              <ChartCard
                cardId="mssql-utilisation"
                family="ratio"
                items={[
                  { key: 'conn', label: 'Connection pool', value: connPct, icon: 'network',
                    hint: `${sessions.active || 0} active of ${fmtNumber(hs.max_connections)}${hs.max_connections_unlimited ? ' (no configured limit)' : ''}` },
                  { key: 'cpu', label: 'Host CPU', value: cpuPct, icon: 'cpu',
                    hint: `SQL Server ${sqlCpuPct}% · other ${num(cpu.other_cpu_pct)}%` },
                  { key: 'mem', label: 'Host memory', value: memPct, icon: 'memory',
                    hint: `${fmtNumber(memory.host_used_mb)} MB of ${fmtNumber(memory.host_total_mb)} MB` },
                  { key: 'cache', label: 'Buffer cache miss', value: Math.max(0, 100 - cachePct), icon: 'layers',
                    hint: 'Inverted from the hit rate, so every meter here reads "more is worse"' },
                ]}
                title="Utilisation"
                icon="gauge"
                subtitle="Against each resource's own ceiling"
                loading={isFetching}
                tableColumns={[
                  { key: 'resource', label: 'Resource' },
                  { key: 'used', label: 'Used', align: 'right' },
                  { key: 'band', label: 'Band', align: 'right' },
                ]}
                tableRows={[
                  ['Connection pool', connPct], ['Host CPU', cpuPct],
                  ['Host memory', memPct], ['Buffer cache miss', Math.max(0, 100 - cachePct)],
                ].map(([label, v]) => ({
                  key: label,
                  cells: { resource: label, used: `${v}%`, band: bandFor(v).label },
                }))}
              />

              <ChartCard
                cardId="mssql-waits"
                family="flat"
                items={waitRows.slice(0, 8).map((w) => ({
                  key: w.wait_type,
                  label: w.wait_type,
                  value: num(w.wait_time_ms),
                }))}
                chartProps={{
                  unit: 'ms', format: fmtNumber, labelWidth: 150,
                  emptyLabel: 'No wait statistics — the login may lack VIEW SERVER STATE',
                }}
                title="Top wait types"
                icon="clock"
                subtitle="Cumulative since the last restart, idle waits excluded"
                loading={isFetching}
                tableColumns={[
                  { key: 'type', label: 'Wait type' },
                  { key: 'ms', label: 'Wait (ms)', align: 'right' },
                  { key: 'tasks', label: 'Tasks', align: 'right' },
                  { key: 'pct', label: 'Share', align: 'right' },
                ]}
                tableRows={waitRows.map((w) => ({
                  key: w.wait_type,
                  cells: {
                    type: w.wait_type,
                    ms: fmtNumber(w.wait_time_ms),
                    tasks: fmtNumber(w.waiting_tasks_count),
                    pct: w.pct != null ? `${w.pct}%` : '—',
                  },
                }))}
              />
            </div>

            {/* Live trends only exist while the page is open — say so rather than
                showing an empty chart frame. */}
            {trend.conn.length > 2 ? (
              <div className="grid gap-gutter md:grid-cols-3">
                <Panel title="Connection usage" icon="network">
                  <TrendChart data={trend.conn} series={[{ key: 'v', label: '%' }]} height={150} />
                </Panel>
                <Panel title="Buffer cache hit" icon="memory">
                  <TrendChart data={trend.cache} series={[{ key: 'v', label: '%' }]} height={150} />
                </Panel>
                <Panel title="Host CPU" icon="cpu">
                  <TrendChart data={trend.cpu} series={[{ key: 'v', label: '%' }]} height={150} />
                </Panel>
              </div>
            ) : (
              <Panel>
                <p className="text-center text-[12px] text-subtle">
                  Live trends build up from this page — the first points appear after the
                  next {REFRESH_INTERVAL}-second refresh.
                </p>
              </Panel>
            )}

            {blocking.length > 0 && (
              <Notice tone="danger" icon="lock"
                title={`${blocking.length} blocking chain${blocking.length === 1 ? '' : 's'} right now.`}>
                Session {blocking[0].blocking_session_id} is holding up session{' '}
                {blocking[0].session_id}
                {blocking[0].wait_time ? ` for ${fmtNumber(blocking[0].wait_time)} ms` : ''}.{' '}
                <button type="button" onClick={() => setActiveTab('locks')}
                  className="font-semibold underline">
                  Open Locks
                </button>
              </Notice>
            )}

            <div className="grid gap-gutter xl:grid-cols-3">
              <Panel title="Server" icon="server">
                <DefRow label="Instance" value={serverInfo.server_name || connection.host} mono />
                <DefRow label="Version" value={serverInfo.product_version || hs.version} mono />
                <DefRow label="Edition" value={serverInfo.edition || hs.edition} />
                <DefRow label="Uptime" value={hs.uptime} />
                <DefRow label="Last restart" value={hs.last_restart} mono />
                <DefRow label="Max connections"
                  value={hs.max_connections_unlimited
                    ? `${fmtNumber(hs.max_connections)} (no configured limit)`
                    : fmtNumber(hs.max_connections)}
                  hint="SQL Server's 'max connections' of 0 means unlimited; the effective ceiling is 32,767." />
                <DefRow label="Replication" value={replication.state || 'STANDALONE'} />
                <DefRow label="AlwaysOn"
                  value={hasAlwaysOn ? agGroups.map((g) => g.ag_name).join(', ') : 'Not configured'} />
              </Panel>

              <Panel title="Memory" icon="memory">
                <UsageBar label="Host RAM in use" pct={memPct}
                  sub={`${fmtNumber(memory.host_used_mb)} MB of ${fmtNumber(memory.host_total_mb)} MB`}
                  className="mb-3" />
                <DefRow label="SQL Server total" value={memory.total_mb ? `${fmtNumber(memory.total_mb)} MB` : null}
                  hint="Total Server Memory — what SQL Server currently holds." />
                <DefRow label="SQL Server target" value={memory.target_mb ? `${fmtNumber(memory.target_mb)} MB` : null}
                  hint="Target Server Memory — what it would like to hold." />
                <DefRow label="Process in use" value={memory.used_mb ? `${fmtNumber(memory.used_mb)} MB` : null} />
                <DefRow label="Page life expectancy"
                  value={memory.page_life_expectancy != null ? `${fmtNumber(memory.page_life_expectancy)} s` : null}
                  tone={memory.page_life_expectancy != null && memory.page_life_expectancy < 300 ? 'warn' : undefined}
                  hint="How long a page stays in the buffer pool. A sustained value under 300s suggests memory pressure." />
                <DefRow label="System state" value={memory.system_memory_state} />
                <DefRow label="Page faults" value={fmtNumber(memory.page_fault_count)} />
              </Panel>

              <Panel title="Throughput" icon="activity">
                <DefRow label="Batch requests/sec" value={fmtNumber(cpu.batch_requests_sec)} />
                <DefRow label="SQL compilations/sec" value={fmtNumber(cpu.sql_compilations)} />
                <DefRow label="Re-compilations/sec" value={fmtNumber(cpu.sql_recompilations)}
                  tone={num(cpu.sql_recompilations) > 100 ? 'warn' : undefined} />
                <DefRow label="Full scans/sec" value={fmtNumber(cpu.full_scans_sec)} />
                <DefRow label="Host CPU" value={`${cpuPct}%`} />
                <DefRow label="SQL Server CPU" value={`${sqlCpuPct}%`} />
                <DefRow label="Other processes" value={`${num(cpu.other_cpu_pct)}%`} />
                <DefRow label="Buffer cache hit" value={cachePct ? `${cachePct}%` : null}
                  tone={cachePct > 0 && cachePct < 90 ? 'warn' : undefined} />
              </Panel>
            </div>

            {queryRows.length > 0 && (
              <ActiveSessionsPanel
                rows={queryRows}
                title={`Active sessions (${queryRows.length})`}
                actions={<Button size="sm" variant="secondary" iconRight="chevron-right"
                  onClick={() => setActiveTab('queries')}>All queries</Button>}
              />
            )}
          </div>
        )}

        {/* ══ PERFORMANCE ═══════════════════════════════════════════════════ */}
        {activeTab === 'performance' && (
          <div className="space-y-gutter">
            <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4">
              <MetricTile label="Batch requests/sec" value={fmtNumber(cpu.batch_requests_sec)} icon="activity" />
              <MetricTile label="Compilations/sec" value={fmtNumber(cpu.sql_compilations)} icon="zap"
                tone={num(cpu.sql_compilations) > 500 ? 'warn' : 'neutral'} />
              <MetricTile label="Re-compilations/sec" value={fmtNumber(cpu.sql_recompilations)} icon="refresh"
                tone={num(cpu.sql_recompilations) > 100 ? 'bad' : 'neutral'}
                hint="High re-compilation usually means plan cache churn." />
              <MetricTile label="Buffer cache hit" value={cachePct ? `${cachePct}%` : '—'} icon="memory"
                tone={cachePct === 0 ? 'neutral' : cachePct < 90 ? 'bad' : 'good'} />
            </div>

            <Panel title="Memory detail" icon="memory">
              <div className="grid gap-gutter-sm sm:grid-cols-2 xl:grid-cols-4">
                <StatCell label="Buffer cache hit" value={cachePct ? `${cachePct}%` : '—'}
                  hint="Pages served without a disk read" />
                <StatCell label="Page life expectancy"
                  value={memory.page_life_expectancy != null ? `${fmtNumber(memory.page_life_expectancy)} s` : '—'}
                  hint="Seconds a page stays in the pool" />
                <StatCell label="SQL Server total" value={memory.total_mb ? `${fmtNumber(memory.total_mb)} MB` : '—'}
                  hint="Currently held" />
                <StatCell label="SQL Server target" value={memory.target_mb ? `${fmtNumber(memory.target_mb)} MB` : '—'}
                  hint="Would like to hold" />
                <StatCell label="Process in use" value={memory.used_mb ? `${fmtNumber(memory.used_mb)} MB` : '—'}
                  hint="Committed to the sqlservr process" />
                <StatCell label="Host RAM" value={memory.host_total_mb ? `${fmtNumber(memory.host_total_mb)} MB` : '—'}
                  hint="Physical memory on the machine" />
                <StatCell label="Host available"
                  value={memory.host_available_mb ? `${fmtNumber(memory.host_available_mb)} MB` : '—'}
                  hint="Free for any process" />
                <StatCell label="Utilisation"
                  value={memory.utilization_pct != null ? `${memory.utilization_pct}%` : '—'}
                  hint="Of the process working set" />
              </div>
            </Panel>

            <TablePanel title="Wait statistics" icon="clock" subtitle="Idle and background waits excluded">
              <Paged rows={waitRows} unit="wait types">
                {(page, pager) => (
                  <>
                    <Table2
                      columns={[
                        { key: 'type', label: 'Wait type' },
                        { key: 'tasks', label: 'Waiting tasks', align: 'right' },
                        { key: 'ms', label: 'Wait time (ms)', align: 'right' },
                        { key: 'share', label: 'Share', align: 'right' },
                      ]}
                      rows={page.map((w, i) => ({
                        key: `${w.wait_type}-${i}`,
                        cells: {
                          type: <span className="font-mono text-[12px] font-semibold text-accent-text">{w.wait_type}</span>,
                          tasks: <span className="font-mono">{fmtNumber(w.waiting_tasks_count)}</span>,
                          ms: <span className="font-mono font-semibold">{fmtNumber(w.wait_time_ms)}</span>,
                          share: w.pct != null ? `${w.pct}%` : null,
                        },
                      }))}
                      empty={<EmptyState icon="clock" title="No wait statistics"
                        body="sys.dm_os_wait_stats returned nothing, which usually means the login lacks VIEW SERVER STATE." />}
                    />
                    {pager}
                  </>
                )}
              </Paged>
            </TablePanel>

            <TablePanel title="File I/O" icon="desktop"
              subtitle="Cumulative stalls per database file since the last restart">
              <Paged rows={ioRows} unit="files">
                {(page, pager) => (
                  <>
                    <Table2
                      columns={[
                        { key: 'db', label: 'Database' },
                        { key: 'file', label: 'Physical file' },
                        { key: 'reads', label: 'Reads', align: 'right' },
                        { key: 'writes', label: 'Writes', align: 'right' },
                        { key: 'rstall', label: 'Read stall (ms)', align: 'right' },
                        { key: 'wstall', label: 'Write stall (ms)', align: 'right' },
                        { key: 'avg', label: 'Avg I/O (ms)', align: 'right' },
                      ]}
                      rows={page.map((f, i) => ({
                        key: `${f.db_name}-${f.physical_name}-${i}`,
                        cells: {
                          db: <Badge tone="accent" size="xs">{f.db_name || '—'}</Badge>,
                          file: (
                            <span title={f.physical_name}
                              className="truncate-safe block max-w-[280px] font-mono text-[11px] text-muted">
                              {f.physical_name}
                            </span>
                          ),
                          reads: <span className="font-mono">{fmtNumber(f.num_of_reads)}</span>,
                          writes: <span className="font-mono">{fmtNumber(f.num_of_writes)}</span>,
                          rstall: <span className="font-mono">{fmtNumber(f.io_stall_read_ms)}</span>,
                          wstall: <span className="font-mono">{fmtNumber(f.io_stall_write_ms)}</span>,
                          avg: (
                            <span className={num(f.avg_io_ms) > 20 ? 'font-mono font-bold text-danger-fg' : 'font-mono'}>
                              {f.avg_io_ms != null ? f.avg_io_ms : '—'}
                            </span>
                          ),
                        },
                      }))}
                      empty={<EmptyState icon="desktop" title="No file I/O statistics"
                        body="sys.dm_io_virtual_file_stats returned nothing for this instance." />}
                    />
                    {pager}
                  </>
                )}
              </Paged>
            </TablePanel>
          </div>
        )}

        {/* ══ QUERIES ═══════════════════════════════════════════════════════ */}
        {activeTab === 'queries' && (
          <div className="space-y-gutter">
            {longRunning.length > 0 && (
              <Notice tone="danger" title={`${longRunning.length} long-running quer${longRunning.length === 1 ? 'y' : 'ies'}.`}>
                Running for more than {LONG_QUERY_MS / 1000} seconds. The slowest is session{' '}
                {longRunning[0].session_id} at {fmtNumber(longRunning[0].duration_ms)} ms.
              </Notice>
            )}

            <ActiveSessionsPanel rows={queryRows} title={`Active sessions (${queryRows.length})`} full />

            <TablePanel title="Top queries by CPU" icon="zap"
              subtitle="From the plan cache — sys.dm_exec_query_stats, averaged per execution"
              actions={<Button size="sm" variant="secondary" iconRight="chevron-right"
                onClick={() => navigate(`/mssql-dashboard/${id}/slow-queries`)}>Slow queries</Button>}>
              <Paged rows={topQueryRows} unit="queries">
                {(page, pager) => (
                  <>
                    <Table2
                      columns={[
                        { key: 'sql', label: 'Statement' },
                        { key: 'execs', label: 'Executions', align: 'right' },
                        { key: 'avgcpu', label: 'Avg CPU (ms)', align: 'right' },
                        { key: 'totcpu', label: 'Total CPU (ms)', align: 'right' },
                        { key: 'avgel', label: 'Avg elapsed (ms)', align: 'right' },
                      ]}
                      rows={page.map((q, i) => ({
                        key: `top-${i}`,
                        cells: {
                          sql: <SqlCell sql={q.query} max={130} />,
                          execs: <span className="font-mono">{fmtNumber(q.execution_count)}</span>,
                          avgcpu: <span className="font-mono font-semibold">{fmtNumber(q.avg_cpu_ms)}</span>,
                          totcpu: <span className="font-mono">{fmtNumber(q.total_cpu_ms)}</span>,
                          avgel: <span className="font-mono">{fmtNumber(q.avg_elapsed_ms)}</span>,
                        },
                      }))}
                      empty={<EmptyState icon="zap" title="No cached plans"
                        body="The plan cache is empty — run some queries, then refresh." />}
                    />
                    {pager}
                  </>
                )}
              </Paged>
            </TablePanel>
          </div>
        )}

        {/* ══ DATABASES ═════════════════════════════════════════════════════ */}
        {activeTab === 'databases' && (
          <ObjectTable
            title="Databases"
            icon="database"
            columns={MSSQL_DATABASE_COLUMNS}
            items={dbItems}
            loading={isFetching}
            searchOn={['name', 'owner', 'recovery_model']}
            searchPlaceholder="Search databases…"
            defaultSort={{ key: 'size', dir: 'desc' }}
            sizeOf={(d) => d.size_bytes}
            onOpen={openDbTables}
            onRowClick={openDbTables}
            unit="databases"
            note="Table counts come from the tables collector, which covers user databases only"
            emptyTitle="No databases"
            emptyBody="sys.databases returned nothing for this login."
          />
        )}

        {/* ══ TABLES ════════════════════════════════════════════════════════ */}
        {activeTab === 'tables' && (
          <ObjectTable
            title="Tables"
            icon="table"
            columns={MSSQL_TABLE_COLUMNS}
            items={shownTables}
            loading={isFetching}
            searchOn={['name', 'schema', 'database']}
            searchPlaceholder="Search tables…"
            filter={{
              value: tablesDb,
              onChange: setTablesDb,
              options: tableDbOptions,
            }}
            defaultSort={{ key: 'total', dir: 'desc' }}
            sizeOf={(t) => t.total_bytes}
            keyOf={(t) => `${t.database}.${t.schema}.${t.name}`}
            onOpen={openTableDetail}
            onRowClick={openTableDetail}
            unit="tables"
            note="Top 100 by size, across user databases"
            emptyTitle="No tables"
            emptyBody="The collector reads user databases only — system databases are skipped."
          />
        )}

        {/* ══ LOCKS ═════════════════════════════════════════════════════════ */}
        {activeTab === 'locks' && (
          <div className="space-y-gutter">
            <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4">
              <MetricTile label="Blocking chains" value={blocking.length} icon="lock"
                tone={blocking.length ? 'bad' : 'good'} />
              <MetricTile label="Waiting requests" value={waitingRequests.length} icon="clock"
                tone={waitingRequests.length ? 'warn' : 'good'} />
              <MetricTile label="Longest wait" icon="clock"
                value={waitingRequests.length
                  ? `${fmtNumber(Math.max(...waitingRequests.map((l) => num(l.wait_time))))} ms`
                  : '—'} />
              <MetricTile label="Databases involved" icon="database"
                value={new Set(waitingRequests.map((l) => l.db_name).filter(Boolean)).size || '—'} />
            </div>

            <TablePanel title={`Blocking chains (${blocking.length})`} icon="lock"
              subtitle="A request whose blocking_session_id is set — someone else holds the lock it needs">
              <Paged rows={blocking} unit="chains">
                {(page, pager) => (
                  <>
                    <Table2
                      columns={[
                        { key: 'blocker', label: 'Blocked by' },
                        { key: 'victim', label: 'Waiting session' },
                        { key: 'db', label: 'Database' },
                        { key: 'wait', label: 'Wait type' },
                        { key: 'ms', label: 'Waiting (ms)', align: 'right' },
                        { key: 'sql', label: 'Statement' },
                      ]}
                      rows={page.map((b, i) => ({
                        key: `block-${b.session_id}-${i}`,
                        cells: {
                          blocker: <Badge tone="danger" size="xs">SPID {b.blocking_session_id}</Badge>,
                          victim: <span className="font-mono font-semibold">{b.session_id}</span>,
                          db: b.db_name,
                          wait: <StateChip value={b.wait_type} fallback="warning" />,
                          ms: <span className="font-mono font-bold text-danger-fg">{fmtNumber(b.wait_time)}</span>,
                          sql: <SqlCell sql={b.query} max={90} />,
                        },
                      }))}
                      empty={<EmptyState icon="check" title="No blocking"
                        body="No request is waiting on a lock held by another session." />}
                    />
                    {pager}
                  </>
                )}
              </Paged>
            </TablePanel>

            <TablePanel title={`All waiting requests (${waitingRequests.length})`} icon="clock"
              subtitle="Includes waits with no blocker — I/O, latches, network">
              <Paged rows={waitingRequests} unit="requests">
                {(page, pager) => (
                  <>
                    <Table2
                      columns={[
                        { key: 'spid', label: 'Session' },
                        { key: 'db', label: 'Database' },
                        { key: 'wait', label: 'Wait type' },
                        { key: 'ms', label: 'Waiting (ms)', align: 'right' },
                        { key: 'blocker', label: 'Blocked by' },
                        { key: 'sql', label: 'Statement' },
                      ]}
                      rows={page.map((l, i) => ({
                        key: `wait-${l.session_id}-${i}`,
                        cells: {
                          spid: <span className="font-mono font-semibold">{l.session_id}</span>,
                          db: l.db_name,
                          wait: <StateChip value={l.wait_type} />,
                          ms: <span className="font-mono">{fmtNumber(l.wait_time)}</span>,
                          blocker: num(l.blocking_session_id) > 0
                            ? <Badge tone="danger" size="xs">SPID {l.blocking_session_id}</Badge>
                            : null,
                          sql: <SqlCell sql={l.query} max={90} />,
                        },
                      }))}
                      empty={<EmptyState icon="check" title="Nothing is waiting"
                        body="Every active request is running rather than waiting." />}
                    />
                    {pager}
                  </>
                )}
              </Paged>
            </TablePanel>
          </div>
        )}

        {/* ══ REPLICATION / ALWAYSON ════════════════════════════════════════ */}
        {activeTab === 'replication' && (
          <div className="space-y-gutter">
            <Panel title="High availability" icon="branch"
              subtitle={hasAlwaysOn
                ? 'AlwaysOn availability groups on this replica'
                : `Replication state: ${replication.state || 'STANDALONE'}`}
              actions={(
                <Badge tone={hasAlwaysOn ? 'accent' : 'neutral'} size="xs">
                  {hasAlwaysOn ? 'AlwaysOn AG' : 'Not configured'}
                </Badge>
              )}
            >
              {hasAlwaysOn ? (
                <div className="grid gap-gutter-sm sm:grid-cols-2 xl:grid-cols-3">
                  {agGroups.map((g, i) => (
                    <div key={`${g.ag_name}-${i}`} className="rounded-card border border-border bg-sunken p-3">
                      <p className="truncate-safe text-[13px] font-bold text-fg">{g.ag_name}</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <StateChip value={g.role_desc} tones={{ PRIMARY: 'accent', SECONDARY: 'info' }} />
                        <StateChip value={g.synchronization_health_desc} tones={SYNC_TONES} fallback="warning" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState icon="branch" title="No availability groups"
                  body="sys.availability_groups returned nothing for the local replica. Configure AlwaysOn, or use the replication list below." />
              )}
            </Panel>

            <TablePanel title="Replication participants" icon="database"
              subtitle="Databases marked as published, subscribed or acting as distributor">
              <Table2
                columns={[
                  { key: 'db', label: 'Database' },
                  { key: 'pub', label: 'Published' },
                  { key: 'sub', label: 'Subscribed' },
                  { key: 'dist', label: 'Distributor' },
                ]}
                rows={(replication.databases || []).map((d, i) => ({
                  key: `${d.database_name}-${i}`,
                  cells: {
                    db: <span className="font-semibold text-accent-text">{d.database_name}</span>,
                    pub: d.is_published ? <Badge tone="success" size="xs">Yes</Badge> : null,
                    sub: d.is_subscribed ? <Badge tone="info" size="xs">Yes</Badge> : null,
                    dist: d.is_distributor ? <Badge tone="accent" size="xs">Yes</Badge> : null,
                  },
                }))}
                empty={<EmptyState icon="branch" title="No replication configured"
                  body="No database on this instance is published, subscribed or acting as a distributor." />}
              />
            </TablePanel>
          </div>
        )}

        {/* ══ LOGINS ════════════════════════════════════════════════════════ */}
        {activeTab === 'users' && (
          <div className="space-y-gutter">
            <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4">
              <MetricTile label="Server logins" value={users.length} icon="users" />
              <MetricTile label="Disabled" icon="lock"
                value={users.filter((u) => u.is_disabled).length}
                tone={users.filter((u) => u.is_disabled).length ? 'warn' : 'neutral'} />
              <MetricTile label="Windows principals" icon="shield"
                value={users.filter((u) => String(u.type_desc || '').startsWith('WINDOWS')).length} />
              <MetricTile label="Active sessions" value={sessions.active ?? queryRows.length} icon="activity" />
            </div>

            <TablePanel title={`Server logins (${users.length})`} icon="users"
              subtitle="sys.server_principals — instance-level logins and groups, top 50 by name">
              <Paged rows={users} unit="logins">
                {(page, pager) => (
                  <>
                    <Table2
                      columns={[
                        { key: 'name', label: 'Login' },
                        { key: 'type', label: 'Type' },
                        { key: 'state', label: 'State' },
                        { key: 'created', label: 'Created' },
                        { key: 'modified', label: 'Modified' },
                      ]}
                      rows={page.map((u, i) => ({
                        key: `${u.name}-${i}`,
                        cells: {
                          name: <span className="font-semibold text-accent-text">{u.name}</span>,
                          type: <StateChip value={u.type_desc} tones={{ SQL_LOGIN: 'accent', WINDOWS_LOGIN: 'info', WINDOWS_GROUP: 'info' }} />,
                          state: u.is_disabled
                            ? <Badge tone="danger" size="xs">Disabled</Badge>
                            : <Badge tone="success" size="xs">Enabled</Badge>,
                          created: <span className="font-mono text-[11px] text-muted">{String(u.create_date || '').slice(0, 19) || null}</span>,
                          modified: <span className="font-mono text-[11px] text-muted">{String(u.modify_date || '').slice(0, 19) || null}</span>,
                        },
                      }))}
                      empty={<EmptyState icon="users" title="No logins returned"
                        body="The login may lack VIEW ANY DEFINITION on sys.server_principals." />}
                    />
                    {pager}
                  </>
                )}
              </Paged>
            </TablePanel>

            <ActiveSessionsPanel rows={queryRows} title={`Active sessions (${queryRows.length})`} full />
          </div>
        )}

        {/* ══ STORAGE ═══════════════════════════════════════════════════════ */}
        {activeTab === 'storage' && (() => {
          const userDbs = dbItems.filter(
            (d) => !SYSTEM_DATABASES.includes(String(d.name).toLowerCase()),
          );
          const dataBytes = dbItems.reduce((a, d) => a + num(d.size_bytes), 0);
          const logBytes = dbItems.reduce((a, d) => a + num(d.log_bytes), 0);
          const topTables = [...tableItems].sort((a, b) => b.total_bytes - a.total_bytes).slice(0, 10);

          return (
            <div className="space-y-gutter">
              <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4">
                <MetricTile label="Data files" value={fmtBytes(dataBytes)} icon="desktop" />
                <MetricTile label="Log files" value={fmtBytes(logBytes)} icon="logs"
                  sub={dataBytes > 0 ? `${Math.round((logBytes / dataBytes) * 100)}% of data` : undefined}
                  tone={logBytes > dataBytes && dataBytes > 0 ? 'warn' : 'neutral'} />
                <MetricTile label="User databases" value={userDbs.length} icon="database"
                  sub={`${dbItems.length - userDbs.length} system`} />
                <MetricTile label="Tables measured" value={tableItems.length} icon="table" />
              </div>

              <div className="grid gap-gutter xl:grid-cols-2">
                <ChartCard
                  cardId="mssql-db-size"
                  family="breakdown"
                  rows={dbItems.slice(0, 10).map((d) => ({
                    key: d.name,
                    label: d.name,
                    total: num(d.size_bytes) + num(d.log_bytes),
                    onClick: () => openDbTables(d),
                    segments: [
                      { key: 'data', label: 'Data', value: num(d.size_bytes), status: STATUS.good },
                      { key: 'log', label: 'Log', value: num(d.log_bytes), status: STATUS.warning },
                    ],
                  }))}
                  chartProps={{ emptyLabel: 'No databases to measure', labelWidth: 130 }}
                  title="Space by database"
                  icon="database"
                  subtitle="Data and log files, largest first"
                  loading={isFetching}
                  tableColumns={[
                    { key: 'db', label: 'Database' },
                    { key: 'data', label: 'Data', align: 'right' },
                    { key: 'log', label: 'Log', align: 'right' },
                    { key: 'total', label: 'Total', align: 'right' },
                  ]}
                  tableRows={dbItems.map((d) => ({
                    key: d.name,
                    cells: {
                      db: d.name,
                      data: fmtBytes(d.size_bytes),
                      log: d.log_bytes == null ? '—' : fmtBytes(d.log_bytes),
                      total: fmtBytes(num(d.size_bytes) + num(d.log_bytes)),
                    },
                  }))}
                />

                <ChartCard
                  cardId="mssql-top-tables"
                  family="breakdown"
                  rows={topTables.map((t) => ({
                    key: `${t.database}.${t.schema}.${t.name}`,
                    label: `${t.schema}.${t.name}`,
                    total: t.total_bytes,
                    onClick: () => openTableDetail(t),
                    segments: [
                      { key: 'data', label: 'Data', value: t.data_bytes, status: STATUS.good },
                      { key: 'index', label: 'Indexes', value: t.index_bytes, status: STATUS.warning },
                    ],
                  }))}
                  chartProps={{ emptyLabel: 'No table sizes collected', labelWidth: 170 }}
                  title="Largest tables"
                  icon="table"
                  subtitle="Data against index footprint"
                  loading={isFetching}
                  tableColumns={[
                    { key: 'table', label: 'Table' },
                    { key: 'rows', label: 'Rows', align: 'right' },
                    { key: 'data', label: 'Data', align: 'right' },
                    { key: 'index', label: 'Indexes', align: 'right' },
                    { key: 'total', label: 'Total', align: 'right' },
                  ]}
                  tableRows={topTables.map((t) => ({
                    key: `${t.database}.${t.schema}.${t.name}`,
                    cells: {
                      table: `${t.database}.${t.schema}.${t.name}`,
                      rows: fmtNumber(t.row_estimate),
                      data: fmtBytes(t.data_bytes),
                      index: fmtBytes(t.index_bytes),
                      total: fmtBytes(t.total_bytes),
                    },
                  }))}
                />
              </div>

              <TablePanel title="Database files" icon="desktop"
                subtitle="Sizes and recovery model per database">
                <Paged rows={dbItems} unit="databases">
                  {(page, pager) => (
                    <>
                      <Table2
                        columns={[
                          { key: 'db', label: 'Database' },
                          { key: 'state', label: 'State' },
                          { key: 'recovery', label: 'Recovery' },
                          { key: 'data', label: 'Data', align: 'right' },
                          { key: 'log', label: 'Log', align: 'right' },
                          { key: 'tables', label: 'Tables', align: 'right' },
                          { key: 'owner', label: 'Owner' },
                        ]}
                        rows={page.map((d) => ({
                          key: d.name,
                          onClick: () => openDbTables(d),
                          cells: {
                            db: <span className="font-semibold text-accent-text">{d.name}</span>,
                            state: <StateChip value={d.state_desc} tones={DB_STATE_TONES} />,
                            recovery: <StateChip value={d.recovery_model}
                              tones={{ SIMPLE: 'warning', FULL: 'success', BULK_LOGGED: 'info' }} />,
                            data: <span className="font-mono text-[12px]">{fmtBytes(d.size_bytes)}</span>,
                            log: d.log_bytes == null ? null
                              : <span className="font-mono text-[12px]">{fmtBytes(d.log_bytes)}</span>,
                            tables: <span className="font-mono">{d.tables || null}</span>,
                            owner: <span className="font-mono text-[11px] text-muted">{d.owner}</span>,
                          },
                        }))}
                        empty={<EmptyState icon="database" title="No databases" />}
                      />
                      {pager}
                    </>
                  )}
                </Paged>
              </TablePanel>
            </div>
          );
        })()}

        {/* Table details — the shared ActMon Table Details UI */}
        <TableDetailsDialog
          open={!!tableDetail}
          onClose={() => setTableDetail(null)}
          breadcrumb={tableDetail ? { database: tableDetail.database, schema: tableDetail.schema, table: tableDetail.table } : null}
          isLoading={!!tableDetail?.loading}
          isError={!!tableDetail?.err}
          errorMessage={tableDetail?.err}
          onRetry={() => fetchTableDetail(tableDetail.database, tableDetail.schema, tableDetail.table)}
          data={adaptMssqlTableDetails(tableDetail?.data)}
        />
      </div>
    </DashboardScopeProvider>
  );
}

/* ── active sessions, used on three tabs ───────────────────────────────────── */

function ActiveSessionsPanel({ rows, title, actions, full = false }) {
  return (
    <TablePanel
      title={title}
      icon="activity"
      subtitle="One row per user session; ActMon's own monitoring connection is excluded"
      actions={actions}
    >
      <Paged rows={rows} unit="sessions" pageSize={full ? undefined : '10'}>
        {(page, pager) => (
          <>
            <Table2
              columns={[
                { key: 'spid', label: 'Session' },
                { key: 'login', label: 'Login' },
                { key: 'host', label: 'Host' },
                { key: 'db', label: 'Database' },
                { key: 'status', label: 'Status' },
                { key: 'ms', label: 'Elapsed (ms)', align: 'right' },
                { key: 'wait', label: 'Wait type' },
                { key: 'sql', label: 'Statement' },
              ]}
              rows={page.map((q, i) => {
                const ms = num(q.duration_ms);
                return {
                  key: `sess-${q.session_id}-${i}`,
                  cells: {
                    spid: <span className="font-mono font-semibold">{q.session_id}</span>,
                    login: <span className="truncate-safe block max-w-[140px] font-semibold text-accent-text">{q.login_name}</span>,
                    host: <span className="truncate-safe block max-w-[120px] font-mono text-[11px] text-muted">{q.host_name}</span>,
                    db: q.database_name ? <Badge tone="accent" size="xs">{q.database_name}</Badge> : null,
                    status: <StateChip value={q.status} tones={SESSION_STATE_TONES} />,
                    ms: (
                      <span className={
                        ms > LONG_QUERY_MS ? 'font-mono font-bold text-danger-fg'
                          : ms > 1000 ? 'font-mono font-semibold text-warning-fg'
                            : 'font-mono'
                      }>
                        {fmtNumber(ms)}
                      </span>
                    ),
                    wait: <StateChip value={q.wait_type} fallback="warning" />,
                    sql: <SqlCell sql={q.sql_text || q.query} max={100} />,
                  },
                };
              })}
              empty={<EmptyState icon="check" title="No user sessions"
                body="Nothing is connected right now apart from the monitoring connection itself." />}
            />
            {pager}
          </>
        )}
      </Paged>
    </TablePanel>
  );
}

/* TableDetailDialog removed — table inspection now goes through the shared
   <TableDetailsDialog> (see openTableDetail / fetchTableDetail above),
   the same component every engine dashboard uses. */
