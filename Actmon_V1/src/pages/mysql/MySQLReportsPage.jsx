import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, Clock, Server, Database, Users, Zap, HardDrive,
  BarChart2, Cpu, Heart, CheckCircle2, TrendingUp,
  Archive, AlertOctagon, Radio,
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, PieChart, Pie, Cell, Legend,
} from 'recharts';
import client from '../../api/client';
import {
  ReportShell, RSection, KStat, RTable, UsageBar, HealthChecks,
  statusBadge, fmtNum, fmtBytes, now, C,
} from '../_shared/reportKit';

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

export default function MySQLReportsPage() {
  const { id } = useParams();
  const [period, setPeriod] = useState('live');
  const [genTime, setGenTime] = useState(now);

  const refetchInterval = period === 'live' ? 30000 : false;
  const reportParams = { period, live: period === 'live' };

  const { data: dash,  isLoading: l1, refetch: r1 } = useQuery({ queryKey: ['rpt-mysql-dash',   id, period], queryFn: () => api('dashboard',           id, reportParams), refetchInterval });
  const { data: backupD, refetch: r2 }              = useQuery({ queryKey: ['rpt-mysql-backup', id, period], queryFn: () => api('backup-info',         id, reportParams), refetchInterval });
  const { data: tableD,  refetch: r3 }              = useQuery({ queryKey: ['rpt-mysql-table',  id, period], queryFn: () => api('table-stats',         id, reportParams), refetchInterval });
  const { data: innoD,   refetch: r4 }              = useQuery({ queryKey: ['rpt-mysql-innodb', id, period], queryFn: () => api('innodb-metrics',      id, reportParams), refetchInterval });
  const { data: perfD,   refetch: r5 }              = useQuery({ queryKey: ['rpt-mysql-perf',   id, period], queryFn: () => api('performance-detail',  id, reportParams), refetchInterval });
  const { data: userD,   refetch: r6 }              = useQuery({ queryKey: ['rpt-mysql-users',  id, period], queryFn: () => api('user-stats',          id, reportParams), refetchInterval });
  const { data: slowD,   refetch: r7 }              = useQuery({ queryKey: ['rpt-mysql-slow',   id, period], queryFn: () => api('slow-queries',        id, reportParams), refetchInterval: period === 'live' ? 15000 : false });
  const { data: replD,   refetch: r8 }              = useQuery({ queryKey: ['rpt-mysql-repl',   id, period], queryFn: () => api('replication/status',  id, reportParams), refetchInterval });
  const { data: errD,    refetch: r9 }              = useQuery({ queryKey: ['rpt-mysql-errlogs',id, period], queryFn: () => api('error-logs',          id, reportParams), refetchInterval });
  const { data: idxD,    refetch: r10 }             = useQuery({ queryKey: ['rpt-mysql-idx',    id, period], queryFn: () => api('index-analysis',      id, reportParams), refetchInterval });

  const loading = l1;
  const refetchAll = () => { [r1, r2, r3, r4, r5, r6, r7, r8, r9, r10].forEach(fn => fn()); };

  /* ── derived values ── */
  const hs          = dash?.health_summary || {};
  const conn        = dash?.connection || {};
  const tables      = (tableD?.tables || []).map((t, i) => {
    const tableName = t.table || t.table_name || t.name || `Table ${i + 1}`;
    const schemaName = t.schema || t.database || t.db_name || '';
    return {
      ...t,
      tableName,
      fullTableName: schemaName ? `${schemaName}.${tableName}` : tableName,
    };
  });
  const slowQueries = slowD?.queries || slowD?.slow_queries || [];
  const errLogs     = errD?.logs || errD?.errors || [];
  const users       = userD?.users || [];
  const innoMetrics = innoD?.metrics || {};
  const replStatus  = replD?.slave_status || replD?.replica_status || {};
  const processList = dash?.process_list || [];
  const longRunning = dash?.long_running_queries || [];
  const chartData   = dash?.chart_data || {};
  const dbSizes     = chartData.db_sizes || [];
  const queryStats  = dash?.query_stats || {};
  const threads     = dash?.threads || {};
  const memory      = dash?.memory || {};
  const network     = dash?.network || {};
  const tableLocks  = dash?.table_locks || perfD?.locking || {};
  const tmpTables   = dash?.tmp_tables || perfD?.tmp_tables || {};
  const perfTables  = perfD?.table_io_stats || [];
  const topStatements = perfD?.top_statements || [];
  const waitEvents  = perfD?.wait_events || [];
  const memoryConsumers = perfD?.memory_consumers || [];
  const perfStats   = perfD?.stats || perfD?.variables || {
    qps: perfD?.query_quality?.qps,
    tps: perfD?.query_quality?.tps,
    slow_queries: perfD?.query_quality?.slow_queries,
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
  const existingIdx = idxD?.existing_indexes || idxD?.indexes || [];
  const idxIssues   = idxD?.issues || missingIdx || unusedIdx || [];
  const idxSummary  = idxD?.summary || {};

  const activeCon   = Number(hs.active_connections || hs.threads_connected || hs.current_connections || dash?.connections_detail?.current) || 0;
  const maxCon      = Number(hs.max_connections) || 0;
  const conPct      = maxCon > 0 ? Math.min(100, Math.round(activeCon / maxCon * 100)) : 0;
  const bufHitPct   = Number(hs.buffer_pool_hit_pct || hs.buffer_hit_ratio || hs.cache_usage_pct || memory.cache_usage_pct || chartData.cache_pct) || 0;
  const slowQCnt    = Number(hs.slow_queries || queryStats.Slow_queries || perfD?.query_quality?.slow_queries) || 0;
  const dbSizeGb    = Number(hs.database_size_gb || hs.db_size_gb || hs.total_size_gb) || 0;
  const uptime      = hs.uptime || '—';
  const totalTables = hs.table_count || hs.total_tables || tables.length || '—';
  const totalDbs    = hs.total_databases || dbSizes.length || '—';
  const questionsPerSec = hs.questions_per_sec || perfD?.query_quality?.qps || 0;
  const rowsPerSec = hs.innodb_rows_per_sec || hs.rows_per_sec || perfD?.row_ops?.reads_per_sec || 0;
  const openTables = hs.open_tables || dash?.server_vars?.table_open_cache || '—';
  const commandChart = chartData.query_stats?.labels?.map((label, i) => ({
    name: label.replace('Com_', ''),
    value: Number(chartData.query_stats?.values?.[i]) || 0,
  })) || Object.entries({
    Select: queryStats.Com_select,
    Insert: queryStats.Com_insert,
    Update: queryStats.Com_update,
    Delete: queryStats.Com_delete,
  }).map(([name, value]) => ({ name, value: Number(value) || 0 }));
  const processCommandData = Object.entries(processList.reduce((acc, p) => {
    const cmd = procField(p, ['Command', 'command'], 'Unknown');
    acc[cmd] = (acc[cmd] || 0) + 1;
    return acc;
  }, {})).map(([name, value]) => ({ name, value }));
  const connectionPieData = [
    { name: 'Used', value: activeCon },
    { name: 'Free', value: Math.max(0, maxCon - activeCon) },
  ];

  const replRunning = replStatus.slave_io_running || replStatus.replica_io_running || '—';
  const replSQLRunning = replStatus.slave_sql_running || replStatus.replica_sql_running || '—';
  const replLag     = replStatus.seconds_behind_master || replStatus.seconds_behind_source || 0;

  function computeScore() {
    let s = 100;
    if (conPct > 90) s -= 30; else if (conPct > 70) s -= 15;
    if (bufHitPct < 70) s -= 25; else if (bufHitPct < 85) s -= 10;
    if (slowQCnt > 100) s -= 20; else if (slowQCnt > 20) s -= 10;
    if (replRunning === 'No') s -= 20;
    if (replLag > 60) s -= 20; else if (replLag > 10) s -= 10;
    return Math.max(0, s);
  }
  const healthScore = computeScore();

  const connName  = dash?.connection?.name || hs?.database || `MySQL #${id}`;
  const subtitle  = `${conn.host || hs.host || ''}${hs.version ? ` · v${hs.version}` : ''}`;

  const alertBadges = [
    replRunning === 'No' && { tone: 'red', label: 'Replication IO Stopped' },
    slowQCnt > 20 && { tone: 'amber', label: `${slowQCnt} Slow Queries` },
    conPct > 80 && { tone: 'red', label: `Connections ${conPct}%` },
    bufHitPct > 0 && bufHitPct < 80 && { tone: 'amber', label: `Buffer Hit ${bufHitPct}%` },
  ];

  if (loading && !dash) return (
    <div className="min-h-screen flex items-center justify-center bg-[#f1f5f9]">
      <div className="text-center">
        <div className="w-12 h-12 border-4 border-green-200 border-t-green-600 rounded-full animate-spin mx-auto mb-4" />
        <p className="text-slate-600 font-semibold">Loading MySQL report…</p>
      </div>
    </div>
  );

  return (
    <ReportShell
      engine={{ ...ENGINE, backTo: `/mysql-dashboard/${id}` }}
      id={id} period={period} setPeriod={setPeriod}
      genTime={genTime} setGenTime={setGenTime} onRefresh={refetchAll}
      connName={connName} subtitle={subtitle} alertBadges={alertBadges}
    >
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
          { ok: replRunning !== 'No',    label: `Replication IO: ${replRunning}` },
          { ok: replSQLRunning !== 'No', label: `Replication SQL: ${replSQLRunning}` },
          { ok: Number(replLag) <= 10,   label: `Repl Lag: ${replLag}s` },
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
              ['Slow Query Log',  hs.slow_query_log || '—'],
              ['Binary Logging',  hs.log_bin || '—'],
              ['Default Engine',  hs.default_storage_engine || 'InnoDB'],
              ['Character Set',   hs.character_set || '—'],
              ['Collation',       hs.collation || '—'],
              ['DB Size (GB)',     dbSizeGb > 0 ? `${dbSizeGb.toFixed(2)}` : '—'],
              ['Database Count',   totalDbs],
              ['Table Count',      totalTables],
              ['Error Log Path',   dash?.error_log_path || '—'],
            ].map(([l, v]) => (
              <div key={l} className="flex items-start justify-between py-1.5 border-b border-slate-100 last:border-0 col-span-1">
                <span className="text-[11px] text-slate-400 font-semibold flex-shrink-0">{l}</span>
                <span className="text-[11px] font-bold text-slate-800 font-mono ml-2 text-right break-all">
                  {v ?? '—'}
                </span>
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
                data={Object.entries(perfStats).slice(0, 6).map(([k, v]) => ({
                  name: k.replace(/_/g,' ').slice(0,18),
                  value: Number(v) || 0,
                }))}
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
        {slowQueries.length === 0 ? (
          <div className="text-center py-4 flex items-center justify-center gap-2 text-green-600">
            <CheckCircle2 size={18} />
            <span className="font-bold text-sm">No slow queries captured</span>
          </div>
        ) : (
          <RTable
            headers={['Execution Time (s)', 'Rows Examined', 'Rows Sent', 'Database', 'Query Preview']}
            rows={slowQueries.slice(0, 15).map(q => [
              <span className={`font-bold ${Number(q.query_time || q.execution_time) > 5 ? 'text-red-600' : 'text-orange-600'}`}>
                {q.query_time || q.execution_time || '—'}
              </span>,
              fmtNum(q.rows_examined),
              fmtNum(q.rows_sent),
              <span className="text-[10px] text-blue-700 font-bold">{q.db || q.database || '—'}</span>,
              <span className="font-mono text-[10px] text-slate-500 max-w-[300px] truncate block">
                {(q.sql_text || q.query || '').slice(0, 100)}
              </span>,
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
              return (
                <UsageBar key={i}
                  label={t.fullTableName}
                  pct={pct}
                  sub={`Data: ${dataMb.toFixed(1)} MB · Total: ${totalMb.toFixed(1)} MB`}
                  color={C.teal} />
              );
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
      <RSection title="Backup Status" icon={Archive}
        color={backupInfo.status === 'COMPLETED' ? C.green : C.orange} pageBreak>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <KStat label="Last Backup Status"
            value={backupInfo.status || backupInfo.backup_status || '—'}
            color={backupInfo.status === 'COMPLETED' || backupInfo.status === 'OK' ? C.green : C.orange} />
          <KStat label="Backup Date"
            value={backupInfo.backup_date?.toString().slice(0,16) || backupInfo.created_at?.toString().slice(0,16) || '—'} />
          <KStat label="Backup Type"   value={backupInfo.backup_type || backupInfo.type || '—'} color={C.blue} />
          <KStat label="Backup Size"   value={backupInfo.backup_size || backupInfo.size || '—'} color={C.purple} />
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
                statusBadge(s.last_status || s.status),
                statusBadge(s.enabled ? 'YES' : 'NO'),
              ])}
            />
          </>
        ) : (
          <div className="text-center py-4 text-slate-400 text-sm">
            No backup schedules configured
          </div>
        )}
      </RSection>

      {/* ══ 8. REPLICATION STATUS ══ */}
      <RSection title="Replication Status" icon={Radio}
        color={replRunning === 'Yes' ? C.green : replRunning === '—' ? C.slate : C.red}>
        {!replStatus || Object.keys(replStatus).length === 0 ? (
          <div className="text-center py-4 text-slate-400 text-sm">
            No replication configured — standalone instance
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <KStat label="IO Thread"    value={replRunning}     color={replRunning === 'Yes' ? C.green : C.red} />
              <KStat label="SQL Thread"   value={replSQLRunning}  color={replSQLRunning === 'Yes' ? C.green : C.red} />
              <KStat label="Lag (seconds)" value={replLag}        color={Number(replLag) > 60 ? C.red : Number(replLag) > 10 ? C.orange : C.green} />
              <KStat label="Master Host"
                value={replStatus.master_host || replStatus.source_host || '—'} color={C.blue} />
            </div>
            <div className="grid grid-cols-2 gap-x-6">
              {[
                ['Master Log File',   replStatus.master_log_file || replStatus.source_log_file],
                ['Read Master Log Pos', replStatus.read_master_log_pos || replStatus.read_source_log_pos],
                ['Relay Log File',    replStatus.relay_log_file],
                ['Relay Log Pos',     replStatus.relay_log_pos],
                ['Exec Master Log Pos', replStatus.exec_master_log_pos || replStatus.exec_source_log_pos],
                ['Last SQL Error',    replStatus.last_sql_error || 'None'],
                ['Last IO Error',     replStatus.last_io_error || 'None'],
                ['Auto Position',     replStatus.auto_position],
              ].map(([l, v]) => (
                <div key={l} className="flex items-start justify-between py-1.5 border-b border-slate-100 last:border-0 col-span-1">
                  <span className="text-[11px] text-slate-400 font-semibold flex-shrink-0">{l}</span>
                  <span className="text-[11px] font-bold text-slate-800 font-mono ml-2 text-right break-all max-w-[200px] truncate">
                    {v ?? '—'}
                  </span>
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
                <KStat key={k}
                  label={k.replace(/innodb_/g,'').replace(/_/g,' ').toUpperCase().slice(0,20)}
                  value={typeof v === 'number' ? fmtNum(v) : String(v).slice(0,12)}
                  color={C.cyan} />
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
                fmtNum(s.count),
                <span className="font-bold">{s.avg_ms}</span>,
                <span className={Number(s.max_ms) > 1000 ? 'font-bold text-red-600' : 'font-bold'}>{s.max_ms}</span>,
                fmtNum(s.rows_examined),
                <span className={Number(s.no_index || s.no_good_index) > 0 ? 'text-red-600 font-bold' : 'text-green-600 font-bold'}>
                  {fmtNum((s.no_index || 0) + (s.no_good_index || 0))}
                </span>,
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
                w.wait_class || '—',
                fmtNum(w.count),
                <span className="font-bold">{w.total_ms}</span>,
                w.avg_ms,
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
                fmtNum(t.fetch),
                fmtNum(t.insert),
                fmtNum(t.update),
                fmtNum(t.delete),
                <span className="font-bold">{t.total_ms}</span>,
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
                <span className="font-bold">{m.current_mb}</span>,
                m.high_mb,
                fmtNum(m.count_used),
              ])}
            />
          </div>
        )}
      </RSection>

      {/* ══ 11. USER STATISTICS ══ */}
      <RSection title="User Statistics" icon={Users} color={C.indigo}>
        {users.length === 0 ? (
          <p className="text-center text-slate-400 py-4">No user statistics available</p>
        ) : (
          <RTable
            headers={['User','Host','Active Connections','Total Connections','Queries Sent']}
            rows={users.slice(0, 15).map(u => [
              <span className="font-bold text-indigo-700">{u.user || u.username || '—'}</span>,
              <span className="font-mono text-[10px] text-slate-500">{u.host || '%'}</span>,
              <span className="font-bold">{u.current_connections || u.active_connections || 0}</span>,
              fmtNum(u.total_connections || u.connections || 0),
              fmtNum(u.total_queries || u.queries_sent || 0),
            ])}
          />
        )}
      </RSection>

      {/* ══ 12. ERROR LOGS ══ */}
      <RSection title={`Error Logs (${errLogs.length} entries)`} icon={AlertOctagon}
        color={errLogs.length > 0 ? C.orange : C.green} pageBreak>
        {errLogs.length === 0 ? (
          <div className="text-center py-4 flex items-center justify-center gap-2 text-green-600">
            <CheckCircle2 size={18} />
            <span className="font-bold text-sm">No recent errors in error log</span>
          </div>
        ) : (
          <RTable
            headers={['Timestamp','Level','Message']}
            rows={errLogs.slice(0, 20).map(e => [
              <span className="font-mono text-[10px] text-slate-400">{(e.timestamp || e.logged || e.time || '—').toString().slice(0,19)}</span>,
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                (e.level || e.priority || '').includes('ERROR') ? 'bg-red-100 text-red-700'
                : (e.level || '').includes('WARN')  ? 'bg-amber-100 text-amber-700'
                : 'bg-slate-100 text-slate-600'}`}>
                {e.level || e.priority || e.errcode || '—'}
              </span>,
              <span className="text-[11px] text-slate-700">{(e.message || e.msg || e.subsystem || '—').toString().slice(0,120)}</span>,
            ])}
          />
        )}
      </RSection>

      {/* ══ 13. INDEX ANALYSIS ══ */}
      <RSection title="Index Analysis" icon={BarChart2} color={C.amber}>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
          <KStat label="Total Indexes" value={fmtNum(idxSummary.total_indexes || existingIdx.length)} color={C.amber} />
          <KStat label="Unused" value={fmtNum(idxSummary.unused_count || unusedIdx.length)} color={unusedIdx.length ? C.orange : C.green} />
          <KStat label="Duplicate" value={fmtNum(idxSummary.duplicate_count || duplicateIdx.length)} color={duplicateIdx.length ? C.orange : C.green} />
          <KStat label="Missing Candidates" value={fmtNum(idxSummary.missing_candidates || missingIdx.length)} color={missingIdx.length ? C.red : C.green} />
          <KStat label="Tables Analyzed" value={fmtNum(idxSummary.total_tables_analyzed || 0)} color={C.slate} />
        </div>

        {missingIdx.length === 0 && unusedIdx.length === 0 && duplicateIdx.length === 0 && idxIssues.length === 0 ? (
          <div className="text-center py-4 flex items-center justify-center gap-2 text-green-600">
            <CheckCircle2 size={18} />
            <span className="font-bold text-sm">No index issues detected</span>
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
                    fmtNum(idx.no_index_count),
                    fmtNum(idx.rows_examined),
                    idx.worst_avg_sec ?? '—',
                    idx.data_mb ?? '—',
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
                    idx.data_mb ?? '—',
                    fmtNum(idx.row_estimate || idx.table_rows),
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
                  idx.index_type || idx.type || '—',
                  fmtNum(idx.cardinality || idx.distinct_values || 0),
                  statusBadge(idx.usage || (idx.used ? 'YES' : 'NO')),
                  <span className={`text-[10px] font-bold ${idx.issue ? 'text-red-600' : 'text-slate-400'}`}>
                    {idx.issue || idx.recommendation || 'OK'}
                  </span>,
                ])}
              />
            )}
          </div>
        )}
      </RSection>
    </ReportShell>
  );
}
