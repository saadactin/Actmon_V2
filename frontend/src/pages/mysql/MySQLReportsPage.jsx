import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  Activity, Clock, Server, Database, Users, Zap, HardDrive,
  BarChart2, Cpu, Heart, CheckCircle2, TrendingUp,
  Archive, AlertOctagon, Radio, GitCommit, Info,
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, PieChart, Pie, Cell, Legend, LineChart, Line,
} from 'recharts';
import client from '@/api/client';
import {
  ReportShell, RSection, KStat, RTable, UsageBar, HealthChecks,
  statusBadge, fmtNum, fmtBytes, now, shortVersion, C,
} from '../_shared/reportKit';
import { computeHealthScore } from '@/utils/mysqlHealth';
import { PageLoading } from '@/components/ui/Loading';

const ENGINE = {
  key: 'mysql',
  label: 'MySQL',
  emoji: '🐬',
  reportPrefix: 'mysql-report',
  headerGradient: 'linear-gradient(135deg,#0f172a 0%,#00618a 55%,#013a52 100%)',
  gradient: 'linear-gradient(135deg,#00618a,#f29111)',
};

/* MySQL accent + chart palette (kit's C has no mysql key) */
const MYSQL = '#005b30';
const POOL_COLORS = [C.green, C.blue, C.orange, C.purple, C.teal, C.cyan, C.amber, C.indigo];

const api = (path, id, params = {}) =>
  client.get(`/connections/mysql/${id}/${path}`, { params }).then(r => r.data);
const reportApi = (id, params) =>
  client.get(`/connections/mysql/${id}/reports`, { params }).then(r => r.data);

/* ─── MySQL-specific field helpers ─── */
function pick(obj, keys, fallback = undefined) {
  for (const k of keys) {
    if (obj?.[k] !== undefined && obj?.[k] !== null && obj?.[k] !== '') return obj[k];
  }
  return fallback;
}
function procField(p, keys, fallback = '—') {
  return pick(p, keys, fallback);
}
function fmtTs(v) {
  if (!v) return '—';
  return String(v).replace('T', ' ').slice(0, 19);
}
function avgOf(points, key) {
  const vals = (points || []).map(p => Number(p[key])).filter(v => !Number.isNaN(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
function lastOf(points, key) {
  const p = (points || [])[points.length - 1];
  return p ? Number(p[key]) || 0 : null;
}

/**
 * "N/A — unavailable" vs "0 — none recorded" vs "Not Configured" (§29): the
 * report backend already tags every section's `status`; this just renders
 * the right empty state instead of ever letting a missing value read as 0.
 */
function EmptyState({ children }) {
  return (
    <div className="text-center py-6 text-slate-400 text-sm flex items-center justify-center gap-2">
      <Info size={15} /> <span>{children}</span>
    </div>
  );
}

export default function MySQLReportsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [period, setPeriod] = useState('live');
  const [genTime, setGenTime] = useState(now);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const isLive = period === 'live';
  const isCustom = period === 'custom';
  const customReady = !isCustom || Boolean(customFrom && customTo);

  const reportParams = isCustom
    ? {
        mode: 'custom',
        from: customFrom ? new Date(customFrom).toISOString() : undefined,
        to: customTo ? new Date(customTo).toISOString() : undefined,
      }
    : { mode: period };

  const {
    data: report, isLoading: reportLoading, refetch: refetchReport, dataUpdatedAt,
  } = useQuery({
    queryKey: ['mysql-report', id, period, customFrom, customTo],
    queryFn: () => reportApi(id, reportParams),
    enabled: Boolean(id) && customReady,
    refetchInterval: isLive ? 30000 : false,
    // v5's replacement for the removed v4 boolean `keepPreviousData: true` —
    // without this, switching periods (or the 30s live refresh) replaces the
    // whole report with a full loading state instead of updating in place.
    placeholderData: keepPreviousData,
  });

  // Live-only supplementary sections this report has always shown (table
  // stats / backup / InnoDB / performance-schema / users / index analysis) —
  // ActMon does not store historical data for these (only what's genuinely
  // in the ClickHouse architecture: resources, slow queries, errors,
  // replication, binary logs), so they stay live-only rather than inventing
  // fake historical versions (§29).
  const liveOpts = { enabled: isLive, refetchInterval: isLive ? 30000 : false, placeholderData: keepPreviousData };
  const { data: dash,    refetch: r1 } = useQuery({ queryKey: ['rpt-mysql-dash',   id], queryFn: () => api('dashboard', id, { live: true }), ...liveOpts });
  const { data: backupD, refetch: r2 } = useQuery({ queryKey: ['rpt-mysql-backup', id], queryFn: () => api('backup-info', id, { live: true }), ...liveOpts });
  const { data: tableD,  refetch: r3 } = useQuery({ queryKey: ['rpt-mysql-table',  id], queryFn: () => api('table-stats', id, { live: true }), ...liveOpts });
  const { data: innoD,   refetch: r4 } = useQuery({ queryKey: ['rpt-mysql-innodb', id], queryFn: () => api('innodb-metrics', id, { live: true }), ...liveOpts });
  const { data: perfD,   refetch: r5 } = useQuery({ queryKey: ['rpt-mysql-perf',   id], queryFn: () => api('performance-detail', id, { live: true }), ...liveOpts });
  const { data: userD,   refetch: r6 } = useQuery({ queryKey: ['rpt-mysql-users',  id], queryFn: () => api('user-stats', id, { live: true }), ...liveOpts });
  const { data: idxD,    refetch: r7 } = useQuery({ queryKey: ['rpt-mysql-idx',    id], queryFn: () => api('index-analysis', id, { live: true }), ...liveOpts });

  const refetchAll = () => {
    refetchReport();
    if (isLive) [r1, r2, r3, r4, r5, r6, r7].forEach(fn => fn());
  };

  const openSlowQueryDetail = (row) => {
    navigate(`/mysql-dashboard/${id}/slow-queries/detail`, {
      state: {
        row: {
          query_id: row.query_hash, database_name: row.db_name, query_text: row.query_text,
          average_execution_time: (row.execution_time || 0) * 1000,
          max_execution_time: (row.execution_time || 0) * 1000,
          rows_affected: row.rows_examined, rows_returned: row.rows_sent,
          user_name: row.user, host: row.host, severity: row.severity, last_seen: row.ts,
        },
        raw: row,
      },
    });
  };

  const initialLoading = isLive ? (reportLoading && !dash && !report) : (reportLoading && !report);
  if (initialLoading) return <PageLoading title="Loading MySQL report…" illustration />;

  /* ── derived values shared by both live and historical branches ── */
  const slowSection  = report?.slow_queries || {};
  const slowSummary  = slowSection.summary || {};
  const slowRows     = slowSection.top_queries || [];
  const slowQCnt     = slowSummary.total || 0;

  const errSection   = report?.errors || {};
  const errSummary   = errSection.summary || {};
  const errRows      = isLive ? (errSection.recent || []) : (errSection.recent || []);

  const replSection  = report?.replication || {};
  const replConfigured = replSection.status !== 'not_configured';

  const binlogSection = report?.binary_logs || {};

  const hs   = dash?.health_summary || {};
  const conn = dash?.connection || {};

  const connName = report?.server?.name || dash?.connection?.name || hs?.database || `MySQL #${id}`;
  const subtitle = `${report?.server?.host || conn.host || hs.host || ''}${shortVersion(hs.version) ? ` · v${shortVersion(hs.version)}` : ''}`;
  const lastUpdatedLabel = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : '—';

  /* ══════════════════════════ LIVE MODE ══════════════════════════ */
  if (isLive) {
    const tables      = (tableD?.tables || []).map((t, i) => {
      const tableName = t.table || t.table_name || t.name || `Table ${i + 1}`;
      const schemaName = t.schema || t.database || t.db_name || '';
      return { ...t, tableName, fullTableName: schemaName ? `${schemaName}.${tableName}` : tableName };
    });
    const users       = userD?.users || [];
    const innoMetrics = innoD?.metrics || {};
    const processList = dash?.process_list || [];
    const longRunning = dash?.long_running_queries || [];
    const chartData   = dash?.chart_data || {};
    const dbSizes     = chartData.db_sizes || [];
    const queryStats  = dash?.query_stats || {};
    const threads     = dash?.threads || {};
    const network     = dash?.network || {};
    const tableLocks  = dash?.table_locks || perfD?.locking || {};
    const tmpTables   = dash?.tmp_tables || perfD?.tmp_tables || {};
    const perfTables  = perfD?.table_io_stats || [];
    const topStatements = perfD?.top_statements || [];
    const waitEvents  = perfD?.wait_events || [];
    const memoryConsumers = perfD?.memory_consumers || [];
    const perfStats   = perfD?.stats || perfD?.variables || {
      qps: perfD?.query_quality?.qps, tps: perfD?.query_quality?.tps,
      active_connections: perfD?.connections?.current,
      buffer_pool_hit_pct: perfD?.buffer_pool?.hit_ratio,
      tmp_disk_pct: perfD?.tmp_tables?.disk_pct,
      lock_waits: perfD?.locking?.lock_waits,
      table_contention_pct: perfD?.locking?.table_contention_pct,
    };
    const backupInfo  = backupD?.last_backup || backupD?.backup_info || {};
    const missingIdx  = idxD?.missing_index_candidates || [];
    const unusedIdx   = idxD?.unused_indexes || [];
    const duplicateIdx = idxD?.duplicate_indexes || [];
    const idxIssues   = idxD?.issues || missingIdx || unusedIdx || [];
    const idxSummary  = idxD?.summary || {};

    const activeCon = Number(hs.current_connections) || 0;
    const maxCon    = Number(hs.max_connections) || 0;
    const conPct    = maxCon > 0 ? Math.min(100, Math.round(activeCon / maxCon * 100)) : 0;
    const bufHitPct = Number(hs.cache_usage_pct) || 0;
    const dbSizeGb  = Number(hs.total_size_gb) || 0;
    const uptime    = hs.uptime || '—';
    const totalTables = hs.total_tables || tables.length || '—';
    const totalDbs  = hs.total_databases || dbSizes.length || '—';
    const questionsPerSec = perfD?.query_quality?.qps || 0;
    const rowsPerSec = perfD?.row_ops?.reads_per_sec || 0;
    const openTables = dash?.server_vars?.table_open_cache || '—';
    const commandChart = chartData.query_stats?.labels?.map((label, i) => ({
      name: label.replace('Com_', ''), value: Number(chartData.query_stats?.values?.[i]) || 0,
    })) || Object.entries({
      Select: queryStats.Com_select, Insert: queryStats.Com_insert,
      Update: queryStats.Com_update, Delete: queryStats.Com_delete,
    }).map(([name, value]) => ({ name, value: Number(value) || 0 }));
    const processCommandData = Object.entries(processList.reduce((acc, p) => {
      const cmd = procField(p, ['Command', 'command'], 'Unknown');
      acc[cmd] = (acc[cmd] || 0) + 1;
      return acc;
    }, {})).map(([name, value]) => ({ name, value }));
    const connectionPieData = [
      { name: 'Used', value: activeCon }, { name: 'Free', value: Math.max(0, maxCon - activeCon) },
    ];

    const replSlave = replSection.slave_status || {};
    const replRunning = replConfigured ? (replSlave.io_running === 'Yes' ? 'Yes' : (replSlave.io_running ? 'No' : '—')) : '—';
    const replSQLRunning = replConfigured ? (replSlave.sql_running === 'Yes' ? 'Yes' : (replSlave.sql_running ? 'No' : '—')) : '—';
    const replLag = Number(replSlave.seconds_behind_master) || 0;

    const healthScore = report?.health?.health_score ?? computeHealthScore(longRunning.length, conPct, bufHitPct);

    const alertBadges = [
      replConfigured && replRunning === 'No' && { tone: 'red', label: 'Replication IO Stopped' },
      slowQCnt > 20 && { tone: 'amber', label: `${slowQCnt} Slow Queries` },
      conPct > 80 && { tone: 'red', label: `Connections ${conPct}%` },
      bufHitPct > 0 && bufHitPct < 80 && { tone: 'amber', label: `Buffer Hit ${bufHitPct}%` },
    ];

    return (
      <ReportShell
        engine={{ ...ENGINE, backTo: `/mysql-dashboard/${id}` }}
        id={id} period={period} setPeriod={setPeriod}
        genTime={genTime} setGenTime={setGenTime} onRefresh={refetchAll}
        connName={connName} subtitle={subtitle} alertBadges={alertBadges}
      >
        <p className="no-print text-[11px] text-slate-400 mb-3">Last updated {lastUpdatedLabel} · sections refresh in place every 30s</p>

        {/* ══ 1. EXECUTIVE SUMMARY ══ */}
        <RSection title="Executive Summary" icon={Heart}
          color={healthScore >= 80 ? C.green : healthScore >= 60 ? C.amber : C.red}>
          <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3 mb-5">
            <KStat label="Health Score"     value={`${healthScore}/100`}        color={healthScore >= 80 ? C.green : healthScore >= 60 ? C.amber : C.red} />
            <KStat label="DB Status"        value={hs.status || 'RUNNING'}      color={C.green} />
            <KStat label="Uptime"           value={uptime} />
            <KStat label="Connections"      value={`${activeCon}/${maxCon}`}    color={conPct > 80 ? C.red : C.green} sub={`${conPct}% used`} />
            <KStat label="Buffer Pool Hit"  value={`${bufHitPct}%`}             color={bufHitPct < 80 ? C.red : C.green} />
            <KStat label="Slow Queries"     value={slowQCnt}                    color={slowQCnt > 50 ? C.red : slowQCnt > 10 ? C.orange : C.green} />
            <KStat label="DB Size (GB)"     value={dbSizeGb > 0 ? `${dbSizeGb.toFixed(1)}` : '—'} color={C.blue} />
            <KStat label="Replication IO"   value={replRunning}                 color={replRunning === 'Yes' ? C.green : replRunning === '—' ? C.slate : C.red} />
          </div>
          <HealthChecks checks={[
            { ok: true,                    label: `Status: ${hs.status || 'RUNNING'}` },
            { ok: conPct < 80,             label: `Connections ${conPct}%` },
            { ok: bufHitPct >= 90,         label: `Buffer Hit ${bufHitPct}%` },
            { ok: slowQCnt <= 20,          label: `Slow Queries: ${slowQCnt}` },
            { ok: !replConfigured || replRunning !== 'No',    label: replConfigured ? `Replication IO: ${replRunning}` : 'Replication: Not Configured' },
            { ok: !replConfigured || replSQLRunning !== 'No', label: replConfigured ? `Replication SQL: ${replSQLRunning}` : 'Standalone instance' },
            { ok: !replConfigured || Number(replLag) <= 10,   label: replConfigured ? `Repl Lag: ${replLag}s` : 'No replication lag to track' },
          ]} />
        </RSection>

        {/* ══ 2. DATABASE STATUS + PERFORMANCE ══ */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
          <RSection title="Database Status" icon={Database} color={MYSQL} className="!mb-0">
            <div className="grid grid-cols-2 gap-x-6">
              {[
                ['Connection Name', connName],
                ['Host',            conn.host || hs.host || '—'],
                ['Port',            conn.port || hs.port || '3306'],
                ['Database',        conn.database_name || hs.database || '—'],
                ['MySQL Version',   hs.version || '—'],
                ['Uptime',          hs.uptime || '—'],
                ['Active Connections', activeCon],
                ['Max Connections', maxCon],
                ['Buffer Pool Hit %', `${bufHitPct}%`],
                ['Default Engine',  hs.storage_engine || 'InnoDB'],
                ['DB Size (GB)',     dbSizeGb > 0 ? `${dbSizeGb.toFixed(2)}` : '—'],
                ['Database Count',   totalDbs],
                ['Table Count',      totalTables],
              ].map(([l, v]) => (
                <div key={l} className="flex items-start justify-between py-1.5 border-b border-slate-100 last:border-0 col-span-1">
                  <span className="text-[11px] text-slate-400 font-semibold flex-shrink-0">{l}</span>
                  <span className="text-[11px] font-bold text-slate-800 font-mono ml-2 text-right break-all">{v ?? '—'}</span>
                </div>
              ))}
            </div>
          </RSection>

          <RSection title="Performance Overview" icon={TrendingUp} color={C.blue} className="!mb-0">
            <div className="grid grid-cols-2 gap-3 mb-4">
              <KStat label="Buffer Pool Hit" value={`${bufHitPct}%`}      color={bufHitPct < 85 ? C.red : C.green} />
              <KStat label="Active Threads"  value={threads.running || activeCon} color={C.blue} />
              <KStat label="Questions/s"     value={fmtNum(questionsPerSec)} color={C.purple} />
              <KStat label="InnoDB Rows/s"   value={fmtNum(rowsPerSec)} color={C.teal} />
              <KStat label="Slow Queries"    value={slowQCnt}  color={slowQCnt > 50 ? C.red : C.green} />
              <KStat label="Open Tables"     value={fmtNum(openTables)} color={C.slate} />
            </div>
            {Object.keys(perfStats).length > 0 && (
              <ResponsiveContainer width="100%" height={140}>
                <BarChart
                  data={Object.entries(perfStats).slice(0, 6).map(([k, v]) => ({ name: k.replace(/_/g,' ').slice(0,18), value: Number(v) || 0 }))}
                  margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 8 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9 }} tickFormatter={fmtNum} axisLine={false} tickLine={false} />
                  <Tooltip formatter={v => fmtNum(v)} />
                  <Bar dataKey="value" radius={[4,4,0,0]}>
                    {Object.keys(perfStats).slice(0,6).map((_, i) => <Cell key={i} fill={POOL_COLORS[i % POOL_COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </RSection>
        </div>

        {/* ══ 3. LIVE WORKLOAD CHARTS ══ */}
        <RSection title="Live Workload Charts" icon={Activity} color={C.purple}>
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <div className="bg-slate-50 rounded-lg border border-slate-100 p-3">
              <p className="text-[10px] text-slate-400 font-bold uppercase mb-2">SQL Command Mix</p>
              <ResponsiveContainer width="100%" height={170}>
                <BarChart data={commandChart}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9 }} tickFormatter={fmtNum} axisLine={false} tickLine={false} />
                  <Tooltip formatter={v => fmtNum(v)} />
                  <Bar dataKey="value" radius={[4,4,0,0]}>
                    {commandChart.map((_, i) => <Cell key={i} fill={POOL_COLORS[i % POOL_COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="bg-slate-50 rounded-lg border border-slate-100 p-3">
              <p className="text-[10px] text-slate-400 font-bold uppercase mb-2">Connection Usage</p>
              <ResponsiveContainer width="100%" height={170}>
                <PieChart>
                  <Pie data={connectionPieData} dataKey="value" nameKey="name" innerRadius={42} outerRadius={66} paddingAngle={3}>
                    <Cell fill={conPct > 80 ? C.red : C.green} />
                    <Cell fill="#e2e8f0" />
                  </Pie>
                  <Tooltip formatter={v => fmtNum(v)} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <div className="bg-slate-50 rounded-lg border border-slate-100 p-3">
              <p className="text-[10px] text-slate-400 font-bold uppercase mb-2">Database Sizes</p>
              <ResponsiveContainer width="100%" height={170}>
                <BarChart data={dbSizes.slice(0, 8)} layout="vertical" margin={{ left: 20, right: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={fmtNum} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 9 }} width={70} axisLine={false} tickLine={false} />
                  <Tooltip formatter={v => `${fmtNum(v)} MB`} />
                  <Bar dataKey="size_mb" fill={C.teal} radius={[0,4,4,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
            <KStat label="Bytes Received" value={fmtBytes(network.bytes_received)} color={C.blue} />
            <KStat label="Bytes Sent" value={fmtBytes(network.bytes_sent)} color={C.green} />
            <KStat label="Tmp Disk Tables" value={fmtNum(tmpTables.disk || tmpTables.on_disk)} color={Number(tmpTables.disk_pct) > 25 ? C.orange : C.slate} sub={`${tmpTables.disk_pct || 0}% disk`} />
            <KStat label="Table Lock Waits" value={fmtNum(tableLocks.waited || tableLocks.table_locks_waited || tableLocks.lock_waits)} color={Number(tableLocks.contention_pct || tableLocks.table_contention_pct) > 5 ? C.red : C.slate} />
          </div>
        </RSection>

        {/* ══ 4. SLOW QUERIES ══ */}
        <RSection title={`Slow Queries (${slowQCnt} total)`} icon={Clock}
          color={slowQCnt > 50 ? C.red : slowQCnt > 10 ? C.orange : C.green} pageBreak>
          {slowRows.length === 0 ? (
            <div className="text-center py-4 flex items-center justify-center gap-2 text-green-600">
              <CheckCircle2 size={18} /><span className="font-bold text-sm">No slow queries recorded</span>
            </div>
          ) : (
            <RTable
              headers={['Execution Time (s)', 'Rows Examined', 'Rows Sent', 'Database', 'Query Preview', '']}
              rows={slowRows.slice(0, 15).map(q => [
                <span className={`font-bold ${Number(q.execution_time) > 5 ? 'text-red-600' : 'text-orange-600'}`}>{Number(q.execution_time || 0).toFixed(3)}</span>,
                fmtNum(q.rows_examined), fmtNum(q.rows_sent),
                <span className="text-[10px] text-blue-700 font-bold">{q.db_name || '—'}</span>,
                <span className="font-mono text-[10px] text-slate-500 max-w-[280px] truncate block">{(q.query_text || '').slice(0, 100)}</span>,
                <button onClick={() => openSlowQueryDetail(q)} className="text-[10px] font-bold text-blue-600 hover:underline whitespace-nowrap">View Full Query</button>,
              ])}
            />
          )}
        </RSection>

        {/* ══ 5. PROCESSLIST ══ */}
        <RSection title={`Processlist (${processList.length} processes)`} icon={Server} color={longRunning.length ? C.orange : C.green}>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
            <KStat label="Total Processes" value={processList.length} color={C.blue} />
            <KStat label="Long Running" value={longRunning.length} color={longRunning.length ? C.red : C.green} />
            <KStat label="Threads Running" value={threads.running || 0} color={C.purple} />
            <KStat label="Threads Cached" value={threads.cached || 0} color={C.slate} />
            <KStat label="Max Used Connections" value={fmtNum(threads.max_used || 0)} color={C.teal} />
          </div>

          {processCommandData.length > 0 && (
            <div className="mb-4 bg-slate-50 rounded-lg border border-slate-100 p-3">
              <p className="text-[10px] text-slate-400 font-bold uppercase mb-2">Process Commands</p>
              <ResponsiveContainer width="100%" height={130}>
                <BarChart data={processCommandData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9 }} allowDecimals={false} axisLine={false} tickLine={false} />
                  <Tooltip />
                  <Bar dataKey="value" fill={C.cyan} radius={[4,4,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {longRunning.length > 0 && (
            <div className="mb-4">
              <p className="text-xs font-bold text-red-600 mb-2">LONG-RUNNING QUERIES</p>
              <RTable
                headers={['ID','User','Host','DB','Command','Time','State','SQL Preview']}
                rows={longRunning.slice(0, 10).map(p => [
                  <span className="font-mono text-[10px]">{procField(p, ['Id', 'id'])}</span>,
                  procField(p, ['User', 'user']),
                  <span className="font-mono text-[10px]">{procField(p, ['Host', 'host'])}</span>,
                  procField(p, ['db', 'database']),
                  statusBadge(procField(p, ['Command', 'command'])),
                  <span className="font-bold text-red-600">{procField(p, ['Time', 'time'], 0)}s</span>,
                  <span className="text-[10px]">{procField(p, ['State', 'state'])}</span>,
                  <span className="font-mono text-[10px] text-slate-500 max-w-[320px] truncate block">{String(procField(p, ['Info', 'info'], '') || '').slice(0, 140)}</span>,
                ])}
              />
            </div>
          )}

          <RTable
            headers={['ID','User','Host','DB','Command','Time','State','SQL Preview']}
            rows={processList.slice(0, 25).map(p => [
              <span className="font-mono text-[10px]">{procField(p, ['Id', 'id'])}</span>,
              procField(p, ['User', 'user']),
              <span className="font-mono text-[10px]">{procField(p, ['Host', 'host'])}</span>,
              procField(p, ['db', 'database']),
              statusBadge(procField(p, ['Command', 'command'])),
              `${procField(p, ['Time', 'time'], 0)}s`,
              <span className="text-[10px]">{procField(p, ['State', 'state'])}</span>,
              <span className="font-mono text-[10px] text-slate-500 max-w-[320px] truncate block">{String(procField(p, ['Info', 'info'], '') || '').slice(0, 140)}</span>,
            ])}
            emptyMsg="No active processes"
          />
        </RSection>

        {/* ══ 6. TABLE STATISTICS ══ */}
        <RSection title="Top Tables by Size" icon={HardDrive} color={C.teal}>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <div>
              {tables.slice(0, 10).map((t, i) => {
                const dataMb = Number(t.data_mb || (t.data_length / 1048576) || 0);
                const totalMb = dataMb + Number(t.index_mb || (t.index_length / 1048576) || 0);
                const pct = totalMb > 0 ? Math.min(100, Math.round(dataMb / Math.max(totalMb, 1) * 100)) : 0;
                return <UsageBar key={i} label={t.fullTableName} pct={pct} sub={`Data: ${dataMb.toFixed(1)} MB · Total: ${totalMb.toFixed(1)} MB`} color={C.teal} />;
              })}
            </div>
            <RTable
              headers={['Table','Engine','Rows','Data (MB)','Index (MB)','Last Updated']}
              rows={tables.slice(0, 15).map(t => [
                <span className="font-bold text-teal-700 text-[11px]">{t.fullTableName}</span>,
                <span className="text-[10px] font-mono text-slate-500">{t.engine || 'InnoDB'}</span>,
                fmtNum(t.table_rows || t.rows || 0),
                <span className="font-bold">{(Number(t.data_mb || (t.data_length/1048576)) || 0).toFixed(1)}</span>,
                <span className="font-bold">{(Number(t.index_mb || (t.index_length/1048576)) || 0).toFixed(1)}</span>,
                <span className="font-mono text-[10px] text-slate-400">{(t.update_time || '—')?.toString().slice(0,10)}</span>,
              ])}
              emptyMsg="No table statistics available"
            />
          </div>
        </RSection>

        {/* ══ 7. BACKUP STATUS ══ */}
        <RSection title="Backup Status" icon={Archive} color={backupInfo.status === 'COMPLETED' ? C.green : C.orange} pageBreak>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <KStat label="Last Backup Status" value={backupInfo.status || backupInfo.backup_status || '—'} color={backupInfo.status === 'COMPLETED' || backupInfo.status === 'OK' ? C.green : C.orange} />
            <KStat label="Backup Date" value={backupInfo.backup_date?.toString().slice(0,16) || backupInfo.created_at?.toString().slice(0,16) || '—'} />
            <KStat label="Backup Type" value={backupInfo.backup_type || backupInfo.type || '—'} color={C.blue} />
            <KStat label="Backup Size" value={backupInfo.backup_size || backupInfo.size || '—'} color={C.purple} />
          </div>
          {backupD?.schedules?.length > 0 ? (
            <>
              <p className="text-xs font-bold text-slate-500 mb-2">BACKUP SCHEDULES</p>
              <RTable
                headers={['Schedule Name','Frequency','Next Run','Status','Enabled']}
                rows={(backupD.schedules || []).slice(0, 10).map(s => [
                  <span className="font-bold text-slate-700">{s.schedule_name || s.name}</span>,
                  s.frequency || '—',
                  <span className="font-mono text-[10px]">{s.next_run_at?.slice(0,16) || '—'}</span>,
                  statusBadge(s.last_status || s.status), statusBadge(s.enabled ? 'YES' : 'NO'),
                ])}
              />
            </>
          ) : <div className="text-center py-4 text-slate-400 text-sm">No backup schedules configured</div>}
        </RSection>

        {/* ══ 8. REPLICATION STATUS ══ */}
        <RSection title="Replication Status" icon={Radio} color={!replConfigured ? C.slate : (replRunning === 'Yes' ? C.green : C.red)}>
          {!replConfigured ? (
            <div className="text-center py-4 text-slate-400 text-sm">Standalone / Replication Not Configured</div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                <KStat label="IO Thread" value={replRunning} color={replRunning === 'Yes' ? C.green : C.red} />
                <KStat label="SQL Thread" value={replSQLRunning} color={replSQLRunning === 'Yes' ? C.green : C.red} />
                <KStat label="Lag (seconds)" value={replLag} color={replLag > 60 ? C.red : replLag > 10 ? C.orange : C.green} />
                <KStat label="Master Host" value={replSlave.master_host || '—'} color={C.blue} />
              </div>
              <div className="grid grid-cols-2 gap-x-6">
                {[
                  ['Master Log File', replSlave.master_log_file],
                  ['Read Master Log Pos', replSlave.read_master_log_pos],
                  ['Relay Log File', replSlave.relay_log_file],
                  ['Relay Log Pos', replSlave.relay_log_pos],
                  ['Last SQL Error', replSlave.last_sql_error || 'None'],
                  ['Last IO Error', replSlave.last_io_error || 'None'],
                ].map(([l, v]) => (
                  <div key={l} className="flex items-start justify-between py-1.5 border-b border-slate-100 last:border-0 col-span-1">
                    <span className="text-[11px] text-slate-400 font-semibold flex-shrink-0">{l}</span>
                    <span className="text-[11px] font-bold text-slate-800 font-mono ml-2 text-right break-all max-w-[200px] truncate">{v ?? '—'}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </RSection>

        {/* ══ 9. INNODB STATUS ══ */}
        <RSection title="InnoDB Engine Status" icon={Cpu} color={C.cyan} pageBreak>
          {Object.keys(innoMetrics).length === 0 ? (
            <p className="text-center text-slate-400 py-4">No InnoDB metrics available</p>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <div className="grid grid-cols-2 gap-3">
                {Object.entries(innoMetrics).slice(0, 8).map(([k, v]) => (
                  <KStat key={k} label={k.replace(/innodb_/g,'').replace(/_/g,' ').toUpperCase().slice(0,20)} value={typeof v === 'number' ? fmtNum(v) : String(v).slice(0,12)} color={C.cyan} />
                ))}
              </div>
              <RTable
                headers={['Metric', 'Value']}
                rows={Object.entries(innoMetrics).slice(0, 20).map(([k, v]) => [
                  <span className="font-semibold text-slate-600 text-[11px]">{k.replace(/_/g,' ')}</span>,
                  <span className="font-black text-slate-800">{typeof v === 'number' ? fmtNum(v) : String(v)}</span>,
                ])}
              />
            </div>
          )}
        </RSection>

        {/* ══ 10. PERFORMANCE SCHEMA DETAIL ══ */}
        <RSection title="Performance Schema Detail" icon={Zap} color={C.purple}>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <KStat label="PS Enabled" value={perfD?.ps_enabled ? 'YES' : 'NO'} color={perfD?.ps_enabled ? C.green : C.slate} />
            <KStat label="Top Statements" value={topStatements.length} color={C.purple} />
            <KStat label="Wait Events" value={waitEvents.length} color={C.orange} />
            <KStat label="Table IO Rows" value={perfTables.length} color={C.teal} />
          </div>

          {topStatements.length > 0 && (
            <div className="mb-5">
              <p className="text-xs font-bold text-slate-500 mb-2">TOP STATEMENTS BY TOTAL TIME</p>
              <RTable
                headers={['Count','Avg ms','Max ms','Rows Examined','No Index','Last Seen','SQL Digest']}
                rows={topStatements.slice(0, 10).map(s => [
                  fmtNum(s.count), <span className="font-bold">{s.avg_ms}</span>,
                  <span className={Number(s.max_ms) > 1000 ? 'font-bold text-red-600' : 'font-bold'}>{s.max_ms}</span>,
                  fmtNum(s.rows_examined),
                  <span className={Number(s.no_index || s.no_good_index) > 0 ? 'text-red-600 font-bold' : 'text-green-600 font-bold'}>{fmtNum((s.no_index || 0) + (s.no_good_index || 0))}</span>,
                  <span className="font-mono text-[10px]">{s.last_seen || '—'}</span>,
                  <span className="font-mono text-[10px] text-slate-500 max-w-[420px] truncate block">{String(s.digest_text || '').slice(0, 150)}</span>,
                ])}
              />
            </div>
          )}

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <div>
              <p className="text-xs font-bold text-slate-500 mb-2">WAIT EVENTS</p>
              <RTable
                headers={['Event','Class','Count','Total ms','Avg ms']}
                rows={waitEvents.slice(0, 10).map(w => [
                  <span className="font-mono text-[10px] text-slate-600">{w.event_name}</span>,
                  w.wait_class || '—', fmtNum(w.count), <span className="font-bold">{w.total_ms}</span>, w.avg_ms,
                ])}
                emptyMsg="No wait events available"
              />
            </div>
            <div>
              <p className="text-xs font-bold text-slate-500 mb-2">TABLE IO HOTSPOTS</p>
              <RTable
                headers={['Table','Fetch','Insert','Update','Delete','Total ms']}
                rows={perfTables.slice(0, 10).map(t => [
                  <span className="font-bold text-teal-700 text-[11px]">{t.schema}.{t.table}</span>,
                  fmtNum(t.fetch), fmtNum(t.insert), fmtNum(t.update), fmtNum(t.delete), <span className="font-bold">{t.total_ms}</span>,
                ])}
                emptyMsg="No table IO stats available"
              />
            </div>
          </div>

          {memoryConsumers.length > 0 && (
            <div className="mt-5">
              <p className="text-xs font-bold text-slate-500 mb-2">MEMORY CONSUMERS</p>
              <RTable
                headers={['Event','Current MB','High MB','Count Used']}
                rows={memoryConsumers.slice(0, 10).map(m => [
                  <span className="font-mono text-[10px] text-slate-600">{m.event_name}</span>,
                  <span className="font-bold">{m.current_mb}</span>, m.high_mb, fmtNum(m.count_used),
                ])}
              />
            </div>
          )}
        </RSection>

        {/* ══ 11. USER STATISTICS ══ */}
        <RSection title="User Statistics" icon={Users} color={C.indigo}>
          {users.length === 0 ? <p className="text-center text-slate-400 py-4">No user statistics available</p> : (
            <RTable
              headers={['User','Host','Active Connections','Total Connections','Queries Sent']}
              rows={users.slice(0, 15).map(u => [
                <span className="font-bold text-indigo-700">{u.user || u.username || '—'}</span>,
                <span className="font-mono text-[10px] text-slate-500">{u.host || '%'}</span>,
                <span className="font-bold">{u.current_connections || u.active_connections || 0}</span>,
                fmtNum(u.total_connections || u.connections || 0), fmtNum(u.total_queries || u.queries_sent || 0),
              ])}
            />
          )}
        </RSection>

        {/* ══ 12. ERROR LOGS ══ */}
        <RSection title={`Error Logs (${errSummary.total || errRows.length} entries)`} icon={AlertOctagon} color={errRows.length > 0 ? C.orange : C.green} pageBreak>
          {errRows.length === 0 ? (
            <div className="text-center py-4 flex items-center justify-center gap-2 text-green-600">
              <CheckCircle2 size={18} /><span className="font-bold text-sm">No recent errors in error log</span>
            </div>
          ) : (
            <RTable
              headers={['Timestamp','Severity','Message']}
              rows={errRows.slice(0, 20).map(e => [
                <span className="font-mono text-[10px] text-slate-400">{fmtTs(e.ts)}</span>,
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                  (e.severity || '').includes('CRITICAL') || (e.severity || '').includes('ERROR') ? 'bg-red-100 text-red-700'
                  : (e.severity || '').includes('WARN') ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
                  {e.severity || '—'}
                </span>,
                <span className="text-[11px] text-slate-700">{(e.message || '—').toString().slice(0,120)}</span>,
              ])}
            />
          )}
        </RSection>

        {/* ══ 13. INDEX ANALYSIS ══ */}
        <RSection title="Index Analysis" icon={BarChart2} color={C.amber}>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
            <KStat label="Total Indexes" value={fmtNum(idxSummary.total_indexes || 0)} color={C.amber} />
            <KStat label="Unused" value={fmtNum(idxSummary.unused_count || unusedIdx.length)} color={unusedIdx.length ? C.orange : C.green} />
            <KStat label="Duplicate" value={fmtNum(idxSummary.duplicate_count || duplicateIdx.length)} color={duplicateIdx.length ? C.orange : C.green} />
            <KStat label="Missing Candidates" value={fmtNum(idxSummary.missing_candidates || missingIdx.length)} color={missingIdx.length ? C.red : C.green} />
            <KStat label="Tables Analyzed" value={fmtNum(idxSummary.total_tables_analyzed || 0)} color={C.slate} />
          </div>
          {missingIdx.length === 0 && unusedIdx.length === 0 && duplicateIdx.length === 0 && idxIssues.length === 0 ? (
            <div className="text-center py-4 flex items-center justify-center gap-2 text-green-600">
              <CheckCircle2 size={18} /><span className="font-bold text-sm">No index issues detected</span>
            </div>
          ) : (
            <div className="space-y-5">
              {missingIdx.length > 0 && (
                <div>
                  <p className="text-xs font-bold text-red-600 mb-2">MISSING INDEX CANDIDATES</p>
                  <RTable
                    headers={['Table','No Index Count','Rows Examined','Worst Avg sec','Data MB','Recommendation']}
                    rows={missingIdx.slice(0, 10).map(idx => [
                      <span className="font-bold text-red-700">{idx.db_name}.{idx.table_name}</span>,
                      fmtNum(idx.no_index_count), fmtNum(idx.rows_examined), idx.worst_avg_sec ?? '—', idx.data_mb ?? '—',
                      <span className="text-[10px] text-slate-600">{idx.recommendation || 'Review query predicates and joins'}</span>,
                    ])}
                  />
                </div>
              )}
              {unusedIdx.length > 0 && (
                <div>
                  <p className="text-xs font-bold text-orange-600 mb-2">UNUSED INDEXES</p>
                  <RTable
                    headers={['Table','Index','Columns','Data MB','Rows','Issue']}
                    rows={unusedIdx.slice(0, 10).map(idx => [
                      <span className="font-bold text-orange-700">{idx.db_name}.{idx.table_name}</span>,
                      <span className="font-mono text-[10px]">{idx.index_name}</span>,
                      <span className="font-mono text-[10px]">{Array.isArray(idx.columns) ? idx.columns.join(', ') : idx.columns || '—'}</span>,
                      idx.data_mb ?? '—', fmtNum(idx.row_estimate || idx.table_rows),
                      <span className="text-[10px] text-slate-600">{idx.reason || idx.issue || 'No observed reads'}</span>,
                    ])}
                  />
                </div>
              )}
              {duplicateIdx.length > 0 && (
                <div>
                  <p className="text-xs font-bold text-amber-600 mb-2">DUPLICATE INDEXES</p>
                  <RTable
                    headers={['Table','Index','Duplicate Of','Columns','Issue']}
                    rows={duplicateIdx.slice(0, 10).map(idx => [
                      <span className="font-bold text-amber-700">{idx.db_name}.{idx.table_name}</span>,
                      <span className="font-mono text-[10px]">{idx.index_name || idx.index}</span>,
                      <span className="font-mono text-[10px]">{idx.duplicate_of || idx.same_as || '—'}</span>,
                      <span className="font-mono text-[10px]">{Array.isArray(idx.columns) ? idx.columns.join(', ') : idx.columns || '—'}</span>,
                      <span className="text-[10px] text-slate-600">{idx.issue || idx.recommendation || 'Duplicate index definition'}</span>,
                    ])}
                  />
                </div>
              )}
              {idxIssues.length > 0 && missingIdx.length === 0 && (
                <RTable
                  headers={['Table','Index','Type','Cardinality','Usage','Issue']}
                  rows={idxIssues.slice(0, 15).map(idx => [
                    <span className="font-bold text-amber-700">{idx.table_name || idx.table || '—'}</span>,
                    <span className="font-mono text-[10px] text-slate-600">{idx.index_name || idx.name || '—'}</span>,
                    idx.index_type || idx.type || '—', fmtNum(idx.cardinality || idx.distinct_values || 0),
                    statusBadge(idx.usage || (idx.used ? 'YES' : 'NO')),
                    <span className={`text-[10px] font-bold ${idx.issue ? 'text-red-600' : 'text-slate-400'}`}>{idx.issue || idx.recommendation || 'OK'}</span>,
                  ])}
                />
              )}
            </div>
          )}
        </RSection>
      </ReportShell>
    );
  }

  /* ══════════════════════════ HISTORICAL MODES (2h/daily/weekly/monthly/custom) ══════════════════════════ */
  const points = report?.resources?.points || [];
  const lastConnPct = maxOf0to100(lastOf(points, 'connections_used'), lastOf(points, 'connections_max'));
  const avgCachePct = avgOf(points, 'cache_hit_pct') || 0;
  const histHealthScore = computeHealthScore(0, lastConnPct || 0, avgCachePct);

  const alertBadges = [
    slowQCnt > 20 && { tone: 'amber', label: `${slowQCnt} Slow Queries` },
    (errSummary.CRITICAL || 0) > 0 && { tone: 'red', label: `${errSummary.CRITICAL} Critical Errors` },
    replConfigured && replSection.status !== 'not_configured' && replSection.seconds_behind_source > 60 && { tone: 'red', label: `Replication Lag ${replSection.seconds_behind_source}s` },
  ];

  return (
    <ReportShell
      engine={{ ...ENGINE, backTo: `/mysql-dashboard/${id}` }}
      id={id} period={period} setPeriod={setPeriod}
      genTime={genTime} setGenTime={setGenTime} onRefresh={refetchAll}
      connName={connName} subtitle={subtitle} alertBadges={alertBadges}
    >
      {isCustom && (
        <div className="no-print flex flex-wrap items-end gap-3 bg-white rounded-xl border border-slate-200 p-4 mb-4">
          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">From</label>
            <input type="datetime-local" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
              className="h-8 rounded-md border border-slate-200 px-2 text-xs" />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">To</label>
            <input type="datetime-local" value={customTo} onChange={e => setCustomTo(e.target.value)}
              className="h-8 rounded-md border border-slate-200 px-2 text-xs" />
          </div>
          {!customReady && <span className="text-[11px] text-amber-600 font-semibold pb-1.5">Select both a from and to date/time</span>}
        </div>
      )}

      <p className="no-print text-[11px] text-slate-400 mb-3">
        Sourced from ClickHouse historical storage · Generated: {fmtTs(report?.generated_at)}
      </p>

      {/* ══ EXECUTIVE SUMMARY ══ */}
      <RSection title="Executive Summary" icon={Heart} color={histHealthScore >= 80 ? C.green : histHealthScore >= 60 ? C.amber : C.red}>
        <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-6 gap-3">
          <KStat label="Health Score (approx.)" value={`${histHealthScore}/100`} color={histHealthScore >= 80 ? C.green : histHealthScore >= 60 ? C.amber : C.red} />
          <KStat label="Avg Cache Hit %" value={`${avgCachePct.toFixed(1)}%`} color={avgCachePct < 80 ? C.red : C.green} />
          <KStat label="Connections (latest)" value={lastConnPct != null ? `${lastConnPct}%` : '—'} color={C.blue} />
          <KStat label="Slow Queries" value={slowQCnt} color={slowQCnt > 50 ? C.red : slowQCnt > 10 ? C.orange : C.green} />
          <KStat label="Errors" value={errSummary.total || 0} color={(errSummary.CRITICAL || 0) > 0 ? C.red : (errSummary.total || 0) > 0 ? C.orange : C.green} />
          <KStat label="Replication" value={replConfigured ? (replSection.role || '—') : 'Not Configured'} color={replConfigured ? C.blue : C.slate} />
        </div>
      </RSection>

      {/* ══ RESOURCE TRENDS ══ */}
      <RSection title="Performance Trends" icon={TrendingUp} color={C.blue}>
        {points.length === 0 ? (
          <EmptyState>No historical metrics recorded for this period yet</EmptyState>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="bg-slate-50 rounded-lg border border-slate-100 p-3">
              <p className="text-[10px] text-slate-400 font-bold uppercase mb-2">CPU / Memory / Disk %</p>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={points}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="ts" tick={{ fontSize: 8 }} tickFormatter={fmtTs} axisLine={false} tickLine={false} minTickGap={40} />
                  <YAxis tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                  <Tooltip labelFormatter={fmtTs} formatter={v => `${Number(v).toFixed(1)}%`} />
                  <Line type="monotone" dataKey="host_cpu" name="CPU" stroke={C.blue} dot={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="host_memory" name="Memory" stroke={C.purple} dot={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="host_disk" name="Disk" stroke={C.orange} dot={false} strokeWidth={2} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="bg-slate-50 rounded-lg border border-slate-100 p-3">
              <p className="text-[10px] text-slate-400 font-bold uppercase mb-2">Query Activity (QPS / TPS)</p>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={points}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="ts" tick={{ fontSize: 8 }} tickFormatter={fmtTs} axisLine={false} tickLine={false} minTickGap={40} />
                  <YAxis tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                  <Tooltip labelFormatter={fmtTs} formatter={v => fmtNum(v)} />
                  <Line type="monotone" dataKey="qps" name="Queries/s" stroke={C.teal} dot={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="tps" name="Transactions/s" stroke={C.indigo} dot={false} strokeWidth={2} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </RSection>

      {/* ══ SLOW QUERIES ══ */}
      <RSection title={`Slow Queries (${slowQCnt} total)`} icon={Clock} color={slowQCnt > 50 ? C.red : slowQCnt > 10 ? C.orange : C.green} pageBreak>
        <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-3 mb-4">
          <KStat label="Total" value={slowSummary.total || 0} />
          <KStat label="Unique" value={slowSummary.unique || 0} />
          <KStat label="Average Time" value={`${(slowSummary.avg_ms || 0).toFixed(1)}ms`} />
          <KStat label="Maximum Time" value={`${(slowSummary.max_ms || 0).toFixed(1)}ms`} color={C.red} />
          <KStat label="Rows Examined" value={fmtNum(slowSummary.total_rows_examined)} />
          <KStat label="Rows Sent" value={fmtNum(slowSummary.total_rows_sent)} />
        </div>
        {slowRows.length === 0 ? (
          <EmptyState>No slow queries recorded in this period</EmptyState>
        ) : (
          <RTable
            headers={['Severity','Database','Query','Time (ms)','Rows Sent','Rows Examined','Last Seen','User@Host','']}
            rows={slowRows.slice(0, 25).map(q => [
              statusBadge(q.severity), <span className="text-[10px] text-blue-700 font-bold">{q.db_name || '—'}</span>,
              <span className="font-mono text-[10px] text-slate-500 max-w-[260px] truncate block">{(q.query_text || '').slice(0, 100)}</span>,
              <span className="font-bold">{(Number(q.execution_time || 0) * 1000).toFixed(1)}</span>,
              fmtNum(q.rows_sent), fmtNum(q.rows_examined),
              <span className="font-mono text-[10px] text-slate-400">{fmtTs(q.ts)}</span>,
              <span className="font-mono text-[10px]">{q.user || '—'}@{q.host || '—'}</span>,
              <button onClick={() => openSlowQueryDetail(q)} className="text-[10px] font-bold text-blue-600 hover:underline whitespace-nowrap">Open Query Detail</button>,
            ])}
          />
        )}
      </RSection>

      {/* ══ ERROR LOGS ══ */}
      <RSection title={`Error Logs (${errSummary.total || 0} entries)`} icon={AlertOctagon} color={(errSummary.CRITICAL || 0) > 0 ? C.red : (errSummary.total || 0) > 0 ? C.orange : C.green} pageBreak>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <KStat label="Critical" value={errSummary.CRITICAL || 0} color={(errSummary.CRITICAL || 0) > 0 ? C.red : C.green} />
          <KStat label="Error" value={errSummary.ERROR || 0} color={(errSummary.ERROR || 0) > 0 ? C.orange : C.green} />
          <KStat label="Warning" value={errSummary.WARNING || 0} color={C.amber} />
          <KStat label="Info" value={errSummary.INFO || 0} color={C.slate} />
        </div>
        {errRows.length === 0 ? (
          <EmptyState>No errors recorded in this period</EmptyState>
        ) : (
          <RTable
            headers={['Timestamp','Severity','Error Code','Message']}
            rows={errRows.slice(0, 25).map(e => [
              <span className="font-mono text-[10px] text-slate-400">{fmtTs(e.ts)}</span>,
              statusBadge(e.severity),
              <span className="font-mono text-[10px]">{e.error_code || '—'}</span>,
              <span className="text-[11px] text-slate-700">{(e.message || '—').toString().slice(0,140)}</span>,
            ])}
          />
        )}
      </RSection>

      {/* ══ REPLICATION ══ */}
      <RSection title="Replication" icon={Radio} color={!replConfigured ? C.slate : (replSection.io_thread_running ? C.green : C.red)}>
        {!replConfigured ? (
          <EmptyState>Standalone / Replication Not Configured</EmptyState>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <KStat label="Role" value={replSection.role || '—'} color={C.blue} />
            <KStat label="IO Thread" value={replSection.io_thread_running ? 'Running' : 'Stopped'} color={replSection.io_thread_running ? C.green : C.red} />
            <KStat label="SQL Thread" value={replSection.sql_thread_running ? 'Running' : 'Stopped'} color={replSection.sql_thread_running ? C.green : C.red} />
            <KStat label="Lag (seconds)" value={replSection.seconds_behind_source >= 0 ? replSection.seconds_behind_source : '—'} color={replSection.seconds_behind_source > 60 ? C.red : C.green} />
          </div>
        )}
      </RSection>

      {/* ══ BINARY LOGS ══ */}
      <RSection title="Binary Logs" icon={GitCommit} color={binlogSection.status === 'unavailable' ? C.slate : (binlogSection.binary_logging || binlogSection.enabled ? C.green : C.slate)}>
        {binlogSection.status === 'unavailable' ? (
          <EmptyState>{binlogSection.reason || 'Historical binary-log data unavailable'}</EmptyState>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <KStat label="Binary Logging" value={(binlogSection.binary_logging ?? binlogSection.enabled) ? 'ON' : 'OFF'} color={(binlogSection.binary_logging ?? binlogSection.enabled) ? C.green : C.slate} />
            <KStat label="Format" value={binlogSection.binlog_format || binlogSection.format || '—'} />
            <KStat label="Current Log File" value={binlogSection.current_log_file || binlogSection.current_file || '—'} />
            <KStat label="Log Files" value={fmtNum(binlogSection.number_of_log_files || binlogSection.file_count)} />
          </div>
        )}
      </RSection>

      <div className="no-print bg-slate-50 rounded-xl border border-slate-200 p-4 text-[11px] text-slate-500 flex items-start gap-2">
        <Info size={14} className="mt-0.5 flex-shrink-0" />
        <span>Table Statistics, Backup Status, InnoDB Engine Status, Performance Schema Detail, User Statistics and Index Analysis reflect current MySQL state only — ActMon does not store historical data for these sections. Switch to <strong>Live</strong> to view them.</span>
      </div>
    </ReportShell>
  );
}

function maxOf0to100(used, max) {
  if (!max) return null;
  return Math.min(100, Math.round((used / max) * 100));
}
