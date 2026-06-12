import React, { useState, useEffect, useRef } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Database, Server, Activity, HardDrive, RefreshCw, Clock,
  Layers, Network, ShieldCheck, AlertTriangle, Cpu, MemoryStick,
  FileText, Zap, Terminal, GitBranch, Archive, RotateCcw,
  CheckCircle2, XCircle, ChevronRight, Heart, Users, Lock,
  TrendingUp, BarChart2, Table, Settings, Bell, ArrowUp,
  ArrowDown, Minus, Search, Filter, Shield, Key, AlertCircle,
  Calendar, Play, Trash2, Plus, Download, ChevronDown, ChevronUp,
  Info, Loader2, ToggleLeft, ToggleRight, Target, CalendarCheck,
  CheckSquare, Square, Copy, FolderOpen, ListTree, ShieldAlert,
} from 'lucide-react';
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  LineChart, Line, AreaChart, Area,
} from 'recharts';
import client from '../../api/client';

/* ─── palette ─── */
const C = {
  msBlue:  '#0078D4',
  sky:     '#38BDF8',
  indigo:  '#6366F1',
  green:   '#22C55E',
  red:     '#EF4444',
  orange:  '#F97316',
  yellow:  '#EAB308',
  purple:  '#8B5CF6',
  slate:   '#64748B',
  teal:    '#14B8A6',
};

/* ─── fetcher ─── */
const fetchDashboard = (id) => client.get(`/connections/mssql/${id}/monitoring-dashboard`).then(r => r.data);

const TABS = [
  { id: 'overview',     label: 'Overview',     icon: Activity },
  { id: 'performance',  label: 'Performance',  icon: TrendingUp },
  { id: 'queries',      label: 'Queries',      icon: Zap },
  { id: 'databases',    label: 'Databases',    icon: Database },
  { id: 'tables',       label: 'Tables',       icon: Table },
  { id: 'locks',        label: 'Locks',        icon: Lock },
  { id: 'replication',  label: 'Replication',  icon: GitBranch },
  { id: 'users',        label: 'Users',        icon: Users },
  { id: 'storage',      label: 'Storage',      icon: HardDrive },
  { id: 'backup',       label: 'Backup',       icon: Archive },
];

const REFRESH_INTERVAL = 15;

export default function MSSQLDashboard() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [activeTab, setActiveTab]     = useState('overview');
  const [countdown, setCountdown]     = useState(REFRESH_INTERVAL);
  const [sparklines, setSparklines]   = useState({ conn: [], cache: [], cpu: [] });
  const [tableSearch, setTableSearch] = useState('');


  const countRef = useRef(null);

  /* ── Main dashboard query ── */
  const { data, isLoading, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['mssqlDashboard', id],
    queryFn:  () => fetchDashboard(id),
    retry: false,
    refetchInterval: REFRESH_INTERVAL * 1000,
  });



  /* ── Countdown timer ── */
  useEffect(() => {
    setCountdown(REFRESH_INTERVAL);
    if (countRef.current) clearInterval(countRef.current);
    countRef.current = setInterval(() => {
      setCountdown(c => (c <= 1 ? REFRESH_INTERVAL : c - 1));
    }, 1000);
    return () => clearInterval(countRef.current);
  }, [dataUpdatedAt]);

  /* ── Sparkline collection ── */
  useEffect(() => {
    if (!data) return;
    const connPct  = Number(data?.health_summary?.connection_usage_pct) || 0;
    const cachePct = Number(data?.health_summary?.buffer_cache_hit_pct) || 0;
    const cpuTime  = Number(data?.health_summary?.cpu_time_ms)          || 0;
    setSparklines(prev => ({
      conn:  [...prev.conn.slice(-20),  { t: new Date().toLocaleTimeString(), v: connPct  }],
      cache: [...prev.cache.slice(-20), { t: new Date().toLocaleTimeString(), v: cachePct }],
      cpu:   [...prev.cpu.slice(-20),   { t: new Date().toLocaleTimeString(), v: cpuTime  }],
    }));
  }, [data]);

  if (isLoading) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center">
        <div className="w-12 h-12 border-4 border-sky-200 border-t-sky-600 rounded-full animate-spin mx-auto mb-4" />
        <p className="text-slate-600 font-semibold">Connecting to SQL Server…</p>
      </div>
    </div>
  );

  if (error || data?.status === 'error') return (
    <div className="p-8">
      <div className="bg-red-50 border border-red-200 text-red-700 p-6 rounded-2xl max-w-2xl">
        <AlertTriangle className="mb-2" size={24} />
        <p className="font-bold text-lg">Connection Error</p>
        <p className="text-sm mt-2">{data?.error || error?.message}</p>
        <button onClick={() => refetch()} className="mt-4 px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700">
          Retry
        </button>
      </div>
    </div>
  );

  const {
    connection        = {},
    health_summary    = {},
    databases         = [],
    active_queries    = [],
    wait_stats        = [],
    sessions          = {},
    memory            = {},
    disk_io           = {},
    cpu               = {},
    locks             = {},
    blocking          = [],
    replication       = {},
    always_on         = {},
    users             = [],
    logins            = [],
    tables            = [],
    backup_history    = [],
    job_history       = [],
    server_info       = {},
    top_queries       = [],
    missing_indexes   = [],
  } = data || {};

  const connPct      = Number(health_summary.connection_usage_pct) || 0;
  const cachePct     = Number(health_summary.buffer_cache_hit_pct) || 0;
  const diskIoPct    = Number(health_summary.disk_io_pct)          || 0;
  const memPct       = Number(health_summary.memory_usage_pct)     || 0;
  const healthScore  = computeHealthScore(health_summary, blocking, connPct, cachePct);
  const hasAlwaysOn  = always_on && (always_on.ag_name || (always_on.replicas && always_on.replicas.length > 0));

  const alerts = {
    queries:     active_queries.filter(q => Number(q.duration_ms) > 5000).length,
    locks:       blocking.length,
    replication: hasAlwaysOn && always_on.health_state !== 'HEALTHY' ? 1 : 0,
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">

      {/* ─── TOP HEADER ─── */}
      <div className="bg-gradient-to-r from-slate-900 via-blue-800 to-sky-700 text-white shadow-xl">
        <div className="px-6 py-4 flex flex-wrap justify-between items-start gap-3">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-sky-400/20 border border-sky-400/40 rounded-2xl flex items-center justify-center text-2xl">
              🗄️
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight">SQL Server Dashboard</h1>
              <p className="text-sky-300 text-sm mt-0.5">
                {connection?.name || 'MSSQL'} — {connection?.host}:{connection?.port || 1433}
                {connection?.database ? ` / ${connection.database}` : ''}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <HealthBadge score={healthScore} />

            {[
              { to: `/mssql-dashboard/${id}/slow-queries`,   label: 'Slow Queries' },
              { to: `/mssql-dashboard/${id}/error-logs`,     label: 'Error Logs' },
              { to: `/mssql-dashboard/${id}/index-analysis`, label: 'Index Analysis' },
            ].map(({ to, label }) => (
              <Link key={to} to={to}
                className="px-3 py-1.5 rounded-lg border border-white/20 hover:bg-white/10 text-xs font-semibold text-white/80 hover:text-white">
                {label}
              </Link>
            ))}

            <button onClick={() => refetch()}
              className="flex items-center gap-2 px-4 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg text-sm font-semibold">
              <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} />
              <span>Refresh</span>
              <span className="ml-1 w-5 h-5 rounded-full bg-sky-500/30 text-sky-200 text-[10px] font-black flex items-center justify-center">
                {countdown}
              </span>
            </button>
          </div>
        </div>

        {/* ─── TAB BAR ─── */}
        <div className="px-4 flex gap-0.5 overflow-x-auto border-t border-white/10">
          {TABS.map(tab => {
            const Icon  = tab.icon;
            const alert = alerts[tab.id] || 0;
            return (
              <button key={tab.id} onClick={() => tab.id === 'backup' ? navigate(`/mssql-dashboard/${id}/backup`) : setActiveTab(tab.id)}
                className={`relative flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-t-lg whitespace-nowrap transition-all ${
                  activeTab === tab.id
                    ? 'bg-slate-50 text-blue-700'
                    : 'text-white/60 hover:text-white hover:bg-white/10'
                }`}>
                <Icon size={13} />
                {tab.label}
                {alert > 0 && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white text-[9px] font-black rounded-full flex items-center justify-center">
                    {alert}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ─── TAB CONTENT ─── */}
      <div className="flex-1 p-5 overflow-auto">

        {/* ══ OVERVIEW ══════════════════════════════════════════════ */}
        {activeTab === 'overview' && (() => {
          const topWaits = Array.isArray(wait_stats)
            ? wait_stats.slice(0, 8).map(w => ({ name: (w.wait_type||'').slice(0, 18), v: Number(w.wait_time_ms) || 0 }))
            : [];
          return (
            <div className="space-y-4">

              {/* ── Row 1: KPI strip ── */}
              <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3">
                <KpiCard icon={Server}    title="Version"        value={(health_summary.version||'').split(' ')[0] || '—'}  accent="blue" />
                <KpiCard icon={Clock}     title="Uptime"         value={health_summary.uptime || '—'}                       accent="sky" />
                <KpiCard icon={Database}  title="Databases"      value={health_summary.total_databases ?? (databases.length || '—')}  accent="indigo" />
                <KpiCard icon={Users}     title="Active Sessions" value={health_summary.active_sessions ?? sessions.active ?? '—'}  accent="green" />
                <KpiCard icon={Activity}  title="Buffer Cache%"  value={cachePct > 0 ? `${cachePct}%` : '—'}                accent={cachePct < 80 ? 'red' : 'green'} />
                <KpiCard icon={Cpu}       title="CPU Time (ms)"  value={fmtNum(health_summary.cpu_time_ms)}                 accent="orange" />
                <KpiCard icon={AlertCircle} title="Wait Stats"   value={wait_stats.length > 0 ? `${wait_stats.length} types` : '—'}  accent="purple" />
                <KpiCard icon={HardDrive} title="DB Size"        value={health_summary.total_size_gb > 0.1 ? `${health_summary.total_size_gb} GB` : `${health_summary.total_size_mb || 0} MB`} accent="slate" />
              </div>

              {/* ── Row 2: Status badges ── */}
              <div className="flex flex-wrap gap-2">
                <StatusBadge ok={connPct < 80}  label={`Connections ${connPct}%`} />
                <StatusBadge ok={cachePct > 90} label={`Buffer Cache ${cachePct}%`} />
                <StatusBadge ok={diskIoPct < 80} label={`Disk I/O ${diskIoPct}%`} />
                <StatusBadge ok={memPct < 85}   label={`Memory ${memPct}%`} />
                <StatusBadge ok={blocking.length === 0} label={`Blocking: ${blocking.length} chain${blocking.length !== 1 ? 's' : ''}`} />
                {hasAlwaysOn && (
                  <StatusBadge ok={always_on.health_state === 'HEALTHY'}
                    label={`AlwaysOn AG: ${always_on.health_state || always_on.ag_name || 'Configured'}`} />
                )}
                {active_queries.filter(q => Number(q.duration_ms) > 5000).length > 0 && (
                  <StatusBadge ok={false}
                    label={`${active_queries.filter(q => Number(q.duration_ms) > 5000).length} long-running quer${active_queries.filter(q => Number(q.duration_ms) > 5000).length === 1 ? 'y' : 'ies'}`} />
                )}
              </div>

              {/* ── Row 3: Gauges ── */}
              <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
                <GaugeCard
                  title="Connection Pool"
                  pct={connPct}
                  sub={`${sessions.active || 0} active / ${health_summary.max_connections || sessions.max || '?'} max`}
                  colorFn={v => v > 80 ? C.red : v > 60 ? C.orange : C.msBlue}
                />
                <GaugeCard
                  title="Buffer Cache Hit%"
                  pct={cachePct}
                  sub="Pages served from buffer pool"
                  colorFn={v => v < 70 ? C.red : v < 85 ? C.orange : C.green}
                />
                <GaugeCard
                  title="Disk I/O Usage"
                  pct={diskIoPct}
                  sub={`Read: ${fmtNum(disk_io.reads || 0)} · Write: ${fmtNum(disk_io.writes || 0)}`}
                  colorFn={v => v > 80 ? C.red : v > 60 ? C.orange : C.teal}
                />
                <GaugeCard
                  title="Memory Usage"
                  pct={memPct}
                  sub={`${memory.used_mb || 0} MB used / ${memory.total_mb || 0} MB total`}
                  colorFn={v => v > 90 ? C.red : v > 75 ? C.orange : C.indigo}
                />
              </div>

              {/* ── Row 4: Live sparklines ── */}
              {sparklines.conn.length > 2 ? (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <TrendCard title="Connection Usage %" data={sparklines.conn}  color={C.msBlue} unit="%" />
                  <TrendCard title="Buffer Cache Hit %" data={sparklines.cache} color={C.green}  unit="%" />
                  <TrendCard title="CPU Time (ms)"      data={sparklines.cpu}   color={C.orange} fmtVal={fmtNum} />
                </div>
              ) : (
                <div className="bg-white rounded-2xl border border-slate-200 p-4 text-center text-slate-400 text-xs">
                  Live trend charts appear after first 15-second auto-refresh
                </div>
              )}

              {/* ── Row 5: Wait types chart + active queries ── */}
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <ChartCard title="Top Wait Types (ms)">
                  {topWaits.length > 0 ? (
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart layout="vertical" data={topWaits} barCategoryGap="20%">
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                        <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={fmtNum} axisLine={false} tickLine={false} />
                        <YAxis width={120} type="category" dataKey="name" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                        <Tooltip formatter={v => `${fmtNum(v)} ms`} cursor={{ fill: '#f8fafc' }} />
                        <Bar dataKey="v" radius={[0, 5, 5, 0]}>
                          {topWaits.map((_, i) => (
                            <Cell key={i} fill={[C.msBlue, C.sky, C.indigo, C.orange, C.red, C.purple, C.teal, C.green][i % 8]} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <p className="text-center text-slate-400 text-xs py-16">No wait statistics available</p>
                  )}
                </ChartCard>

                <ChartCard title="Session Summary">
                  <div className="grid grid-cols-2 gap-3 mb-4">
                    {[
                      ['Active',    sessions.active    || 0, C.green],
                      ['Idle',      sessions.idle      || 0, C.slate],
                      ['Blocked',   sessions.blocked   || blocking.length || 0, C.red],
                      ['Background',sessions.background|| 0, C.msBlue],
                    ].map(([label, value, color]) => (
                      <div key={label} className="bg-slate-50 rounded-xl border border-slate-100 p-3 flex items-center gap-3">
                        <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: color }} />
                        <div>
                          <p className="text-[10px] text-slate-400 font-semibold uppercase">{label}</p>
                          <p className="text-lg font-black text-slate-800">{value}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-x-4">
                    <Row label="Total sessions"    value={sessions.total || '—'} />
                    <Row label="Max connections"   value={health_summary.max_connections || '—'} />
                    <Row label="SQL compilations"  value={fmtNum(cpu.sql_compilations)} />
                    <Row label="Re-compilations"   value={fmtNum(cpu.sql_recompilations)} />
                  </div>
                </ChartCard>
              </div>

              {/* ── Row 6: Active queries table ── */}
              {active_queries.length > 0 && (
                <div className="bg-white rounded-2xl border border-slate-200 p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-bold text-slate-800 text-sm">Active Queries ({active_queries.length})</h3>
                    <button onClick={() => setActiveTab('queries')}
                      className="text-xs text-blue-600 hover:text-blue-800 font-semibold underline">
                      View All →
                    </button>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50">
                        <tr>{['Session ID', 'Login', 'Database', 'Duration (ms)', 'Wait Type', 'Query'].map(h => (
                          <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                        ))}</tr>
                      </thead>
                      <tbody>
                        {active_queries.slice(0, 8).map((q, i) => (
                          <tr key={i} className={`border-t border-slate-100 hover:bg-slate-50 ${Number(q.duration_ms) > 5000 ? 'bg-yellow-50' : ''}`}>
                            <td className="px-3 py-2.5 font-mono text-xs text-slate-500">{q.session_id}</td>
                            <td className="px-3 py-2.5 font-semibold text-blue-700 text-xs">{q.login_name || q.user || '—'}</td>
                            <td className="px-3 py-2.5 text-xs text-slate-400">{q.database_name || '—'}</td>
                            <td className={`px-3 py-2.5 font-bold text-sm ${Number(q.duration_ms) > 5000 ? 'text-red-600' : Number(q.duration_ms) > 1000 ? 'text-orange-600' : 'text-slate-700'}`}>
                              {fmtNum(q.duration_ms)}
                            </td>
                            <td className="px-3 py-2.5 text-[10px]">
                              {q.wait_type ? (
                                <span className="px-2 py-0.5 bg-orange-100 text-orange-700 rounded-full font-bold">{q.wait_type}</span>
                              ) : (
                                <span className="text-slate-300">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2.5 font-mono text-[10px] text-slate-500 max-w-[240px] truncate">
                              {String(q.sql_text || q.query || '').slice(0, 120) || '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* ── Row 7: Blocking alert ── */}
              {blocking.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-2xl p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Lock className="text-red-500 flex-shrink-0" size={16} />
                    <span className="font-bold text-red-700 text-sm">
                      {blocking.length} Blocking Chain{blocking.length > 1 ? 's' : ''} Detected
                    </span>
                    <button onClick={() => setActiveTab('locks')}
                      className="ml-auto text-xs text-red-600 hover:text-red-800 underline font-semibold">
                      View Locks →
                    </button>
                  </div>
                  <div className="space-y-2">
                    {blocking.slice(0, 3).map((b, i) => (
                      <div key={i} className="bg-white rounded-xl border border-red-100 px-3 py-2 text-xs">
                        <span className="font-bold text-red-600">Blocker SPID {b.blocking_spid || b.blocker_id}</span>
                        <span className="ml-2 text-slate-500">Blocking: {b.blocked_spid || b.blocked_count || '?'}</span>
                        <span className="ml-2 font-black text-orange-600">{b.wait_time_ms ? `${fmtNum(b.wait_time_ms)}ms` : ''}</span>
                        <div className="mt-1 font-mono text-slate-500 truncate">{String(b.sql_text || b.query || '').slice(0, 130)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Row 8: Server info panels ── */}
              <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <Panel title="Server Information">
                  <Row label="Host"         value={server_info.machine_name || connection?.host || '—'} mono />
                  <Row label="Version"      value={server_info.product_version || health_summary.version || '—'} mono />
                  <Row label="Edition"      value={server_info.edition || health_summary.edition || '—'} />
                  <Row label="Uptime"       value={health_summary.uptime || '—'} />
                  <Row label="SQL Collation" value={server_info.sql_collation || server_info.collation || '—'} />
                  <Row label="Data Directory" value={server_info.data_directory || '—'} mono />
                  <Row label="Authentication" value={server_info.auth_mode || '—'} />
                  <Row label="AlwaysOn"     value={hasAlwaysOn ? (always_on.ag_name || 'Enabled') : 'Not configured'} />
                </Panel>

                <Panel title="Memory & CPU">
                  <div className="mb-4">
                    <div className="flex justify-between text-xs text-slate-500 mb-1">
                      <span>Buffer Cache Hit Rate</span>
                      <span className="font-black">{cachePct}%</span>
                    </div>
                    <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-500"
                        style={{ width: `${cachePct}%`, background: cachePct >= 90 ? C.green : cachePct >= 70 ? C.orange : C.red }} />
                    </div>
                  </div>
                  <Row label="Total Server Mem" value={memory.total_mb ? `${fmtNum(memory.total_mb)} MB` : '—'} />
                  <Row label="SQL Server Target" value={memory.target_mb ? `${fmtNum(memory.target_mb)} MB` : '—'} />
                  <Row label="SQL Server Used"   value={memory.used_mb  ? `${fmtNum(memory.used_mb)} MB`  : '—'} />
                  <Row label="Page Life Exp."    value={memory.page_life_expectancy ? `${memory.page_life_expectancy}s` : '—'} />
                  <Row label="SQL Compilations"  value={fmtNum(cpu.sql_compilations)} />
                  <Row label="Batch Requests/s"  value={fmtNum(cpu.batch_requests_sec)} />
                </Panel>

                <Panel title="Disk I/O">
                  <div className="mb-4">
                    <div className="flex justify-between text-xs text-slate-500 mb-1">
                      <span>I/O Utilization</span>
                      <span className="font-black">{diskIoPct}%</span>
                    </div>
                    <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-500"
                        style={{ width: `${diskIoPct}%`, background: diskIoPct > 80 ? C.red : diskIoPct > 60 ? C.orange : C.teal }} />
                    </div>
                  </div>
                  <Row label="Physical Reads"   value={fmtNum(disk_io.reads)} />
                  <Row label="Physical Writes"  value={fmtNum(disk_io.writes)} />
                  <Row label="Read Latency ms"  value={disk_io.read_latency_ms  ? `${disk_io.read_latency_ms}ms`  : '—'} />
                  <Row label="Write Latency ms" value={disk_io.write_latency_ms ? `${disk_io.write_latency_ms}ms` : '—'} />
                  <Row label="Stall Read ms"    value={fmtNum(disk_io.io_stall_read_ms)} />
                  <Row label="Stall Write ms"   value={fmtNum(disk_io.io_stall_write_ms)} />
                </Panel>
              </div>

              {/* ── Row 9: Quick actions ── */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <ActionCard icon={<Zap className="text-yellow-500" size={24} />}      title="Slow Queries"    desc="Identify expensive SQL"   onClick={() => navigate(`/mssql-dashboard/${id}/slow-queries`)} />
                <ActionCard icon={<FileText className="text-red-500" size={24} />}    title="Error Logs"      desc="View SQL Server errors"    onClick={() => navigate(`/mssql-dashboard/${id}/error-logs`)} />
                <ActionCard icon={<Layers className="text-violet-500" size={24} />}   title="Index Analysis"  desc="Missing, unused indexes"   onClick={() => navigate(`/mssql-dashboard/${id}/index-analysis`)} />
                <ActionCard icon={<Heart className="text-pink-500" size={24} />}      title="Self-Heal"       desc="AI-powered remediation"    onClick={() => navigate(`/mssql-dashboard/${id}/self-heal`)} />
              </div>

            </div>
          );
        })()}

        {/* ══ PERFORMANCE ═══════════════════════════════════════════ */}
        {activeTab === 'performance' && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                ['Batch Req/s',   fmtNum(cpu.batch_requests_sec),    cpu.batch_requests_sec > 1000 ? 'orange' : 'green'],
                ['Compilations/s', fmtNum(cpu.sql_compilations),     cpu.sql_compilations > 500 ? 'orange' : 'green'],
                ['Recompiles/s',   fmtNum(cpu.sql_recompilations),   cpu.sql_recompilations > 100 ? 'red' : 'green'],
                ['Cache Hit',      `${cachePct}%`,                   cachePct < 90 ? 'red' : 'green'],
              ].map(([t, v, a]) => (
                <MetricKpi key={t} title={t} value={v} accent={a} />
              ))}
            </div>

            <Panel title="Memory Performance">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {[
                  ['Buffer Cache Hit%',    `${cachePct}%`,                          'Reads from buffer pool'],
                  ['Page Life Expectancy', memory.page_life_expectancy ? `${memory.page_life_expectancy}s` : '—', 'Seconds a page stays in buffer'],
                  ['Free Pages',          fmtNum(memory.free_pages),               'Available buffer pages'],
                  ['Stolen Pages',        fmtNum(memory.stolen_pages),             'Non-buffer cache allocations'],
                  ['Target Memory MB',    fmtNum(memory.target_mb),                'SQL Server memory goal'],
                  ['Used Memory MB',      fmtNum(memory.used_mb),                  'Current committed memory'],
                ].map(([label, value, desc]) => (
                  <div key={label} className="bg-slate-50 rounded-xl p-3 border border-slate-100">
                    <p className="text-[10px] text-slate-400 font-semibold uppercase mb-1">{label}</p>
                    <p className="text-lg font-black text-slate-800">{value || '—'}</p>
                    <p className="text-[10px] text-slate-400 mt-1">{desc}</p>
                  </div>
                ))}
              </div>
            </Panel>

            {wait_stats.length > 0 && (
              <Panel title="Wait Statistics Detail">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50">
                      <tr>{['Wait Type', 'Waiting Tasks', 'Wait Time (ms)', 'Max Wait (ms)', 'Signal Wait (ms)'].map(h => (
                        <th key={h} className="px-4 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                      ))}</tr>
                    </thead>
                    <tbody>
                      {wait_stats.map((w, i) => (
                        <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                          <td className="px-4 py-3 font-mono text-xs font-bold text-blue-700">{w.wait_type}</td>
                          <td className="px-4 py-3 font-mono text-xs">{fmtNum(w.waiting_tasks_count)}</td>
                          <td className="px-4 py-3 font-bold">{fmtNum(w.wait_time_ms)}</td>
                          <td className="px-4 py-3 font-mono text-xs">{fmtNum(w.max_wait_time_ms)}</td>
                          <td className="px-4 py-3 font-mono text-xs">{fmtNum(w.signal_wait_time_ms)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            )}

            <Panel title="CPU & Execution">
              <div className="grid grid-cols-2 gap-3">
                <Row label="Batch Requests/sec"    value={fmtNum(cpu.batch_requests_sec)} />
                <Row label="SQL Compilations/sec"  value={fmtNum(cpu.sql_compilations)} />
                <Row label="SQL Recompilations/sec" value={fmtNum(cpu.sql_recompilations)} />
                <Row label="Lock Waits/sec"        value={fmtNum(locks.lock_waits_sec)} />
                <Row label="Deadlocks/sec"         value={fmtNum(locks.deadlocks_sec)} />
                <Row label="Full Scans/sec"        value={fmtNum(cpu.full_scans_sec)} />
              </div>
            </Panel>
          </div>
        )}

        {/* ══ QUERIES ═══════════════════════════════════════════════ */}
        {activeTab === 'queries' && (
          <div className="space-y-5">
            {active_queries.filter(q => Number(q.duration_ms) > 5000).length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-2xl p-5">
                <div className="flex items-center gap-3 mb-3">
                  <AlertTriangle className="text-red-500" size={20} />
                  <h3 className="font-bold text-red-700">
                    {active_queries.filter(q => Number(q.duration_ms) > 5000).length} Long-Running Queries (&gt;5s)
                  </h3>
                </div>
                {active_queries.filter(q => Number(q.duration_ms) > 5000).map((q, i) => (
                  <div key={i} className="bg-white rounded-xl p-3 text-xs font-mono border border-red-100 mb-2">
                    <span className="font-bold text-red-600">SPID:{q.session_id}</span>
                    <span className="ml-3 text-slate-500">Login: {q.login_name || '—'}</span>
                    <span className="ml-3 text-orange-600 font-bold">Duration: {fmtNum(q.duration_ms)}ms</span>
                    {q.wait_type && <span className="ml-3 text-purple-600">Wait: {q.wait_type}</span>}
                    <div className="mt-1 text-slate-600 truncate">{String(q.sql_text || q.query || '').slice(0, 200)}</div>
                  </div>
                ))}
              </div>
            )}

            <Panel title={`Active Queries (${active_queries.length})`}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50">
                    <tr>{['SPID', 'Login', 'Database', 'Status', 'Duration (ms)', 'CPU (ms)', 'Wait Type', 'Query'].map(h => (
                      <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {active_queries.map((q, i) => (
                      <tr key={i} className={`border-t border-slate-100 hover:bg-slate-50 ${Number(q.duration_ms) > 5000 ? 'bg-yellow-50' : ''}`}>
                        <td className="px-3 py-2.5 font-mono text-xs">{q.session_id}</td>
                        <td className="px-3 py-2.5 font-semibold text-blue-700 text-xs">{q.login_name || '—'}</td>
                        <td className="px-3 py-2.5 text-xs text-slate-400">{q.database_name || '—'}</td>
                        <td className="px-3 py-2.5">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            q.status === 'running' ? 'bg-green-100 text-green-700'
                            : q.status === 'sleeping' ? 'bg-slate-100 text-slate-500'
                            : 'bg-blue-100 text-blue-700'}`}>
                            {q.status || '—'}
                          </span>
                        </td>
                        <td className={`px-3 py-2.5 font-bold text-sm ${Number(q.duration_ms) > 5000 ? 'text-red-600' : Number(q.duration_ms) > 1000 ? 'text-orange-600' : 'text-slate-600'}`}>
                          {fmtNum(q.duration_ms)}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs">{fmtNum(q.cpu_time)}</td>
                        <td className="px-3 py-2.5 text-[10px]">
                          {q.wait_type ? (
                            <span className="px-2 py-0.5 bg-orange-100 text-orange-700 rounded-full font-bold">{q.wait_type}</span>
                          ) : '—'}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-[10px] text-slate-500 max-w-[200px] truncate">
                          {String(q.sql_text || q.query || '').slice(0, 100) || '—'}
                        </td>
                      </tr>
                    ))}
                    {active_queries.length === 0 && (
                      <tr><td colSpan={8} className="text-center py-10 text-slate-400">No active queries</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Panel>

            {top_queries.length > 0 && (
              <Panel title="Top Queries by CPU (Cached Plans)">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50">
                      <tr>{['Executions', 'Total CPU', 'Avg CPU', 'Total Duration', 'Avg Duration', 'Query'].map(h => (
                        <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                      ))}</tr>
                    </thead>
                    <tbody>
                      {top_queries.slice(0, 20).map((q, i) => (
                        <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                          <td className="px-3 py-2.5 font-mono text-xs">{fmtNum(q.execution_count)}</td>
                          <td className="px-3 py-2.5 font-bold text-orange-600">{fmtNum(q.total_cpu_ms)}</td>
                          <td className="px-3 py-2.5 font-mono text-xs">{fmtNum(q.avg_cpu_ms)}</td>
                          <td className="px-3 py-2.5 font-mono text-xs">{fmtNum(q.total_duration_ms)}</td>
                          <td className="px-3 py-2.5 font-mono text-xs">{fmtNum(q.avg_duration_ms)}</td>
                          <td className="px-3 py-2.5 font-mono text-[10px] text-slate-500 max-w-[280px] truncate">
                            {String(q.sql_text || q.query_text || '').slice(0, 120)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            )}
          </div>
        )}

        {/* ══ DATABASES ═════════════════════════════════════════════ */}
        {activeTab === 'databases' && (
          <Panel title={`Databases (${databases.length})`}>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50">
                  <tr>{['Database', 'State', 'Recovery Model', 'Compatibility', 'Size (MB)', 'Log Size (MB)', 'Owner'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                  ))}</tr>
                </thead>
                <tbody>
                  {databases.map((db, i) => (
                    <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-4 font-bold text-blue-700">{db.name}</td>
                      <td className="px-4 py-4">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                          db.state_desc === 'ONLINE' ? 'bg-green-100 text-green-700'
                          : db.state_desc === 'OFFLINE' ? 'bg-red-100 text-red-700'
                          : 'bg-yellow-100 text-yellow-700'}`}>
                          {db.state_desc || db.state || '—'}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-xs text-slate-600">{db.recovery_model_desc || db.recovery_model || '—'}</td>
                      <td className="px-4 py-4 font-mono text-xs">{db.compatibility_level || '—'}</td>
                      <td className="px-4 py-4">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm">{db.size_mb || db.data_size_mb || '—'}</span>
                          {databases.length > 1 && (
                            <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden max-w-[60px]">
                              <div className="h-full bg-blue-500 rounded-full"
                                style={{ width: `${Math.min(100, ((db.size_mb || db.data_size_mb || 0) / Math.max(...databases.map(d => d.size_mb || d.data_size_mb || 0), 1)) * 100)}%` }} />
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-4 font-mono text-xs">{db.log_size_mb || '—'}</td>
                      <td className="px-4 py-4 text-xs text-slate-400">{db.owner || '—'}</td>
                    </tr>
                  ))}
                  {databases.length === 0 && (
                    <tr><td colSpan={7} className="text-center py-12 text-slate-400">No databases found</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
        )}

        {/* ══ TABLES ════════════════════════════════════════════════ */}
        {activeTab === 'tables' && (() => {
          const filteredTables = (tables || []).filter(t =>
            !tableSearch
              || (t.table_name || t.name || '').toLowerCase().includes(tableSearch.toLowerCase())
              || (t.schema_name || t.schema || '').toLowerCase().includes(tableSearch.toLowerCase())
          );
          return (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="relative flex-1 max-w-sm">
                  <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input value={tableSearch} onChange={e => setTableSearch(e.target.value)}
                    placeholder="Search tables…"
                    className="h-9 w-full pl-8 pr-4 rounded-xl border border-slate-200 text-sm outline-none focus:border-slate-400" />
                </div>
                <span className="text-xs text-slate-400">{filteredTables.length} tables</span>
              </div>

              <Panel title="Table Statistics">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50">
                      <tr>{['Schema', 'Table', 'Rows', 'Data (MB)', 'Index (MB)', 'Total (MB)', 'Last Updated', 'Missing Indexes'].map(h => (
                        <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                      ))}</tr>
                    </thead>
                    <tbody>
                      {filteredTables.slice(0, 100).map((t, i) => (
                        <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                          <td className="px-3 py-2.5 text-xs text-slate-400">{t.schema_name || t.schema || '—'}</td>
                          <td className="px-3 py-2.5 font-semibold text-blue-700">{t.table_name || t.name || '—'}</td>
                          <td className="px-3 py-2.5 font-mono text-xs">{fmtNum(t.row_count || t.rows)}</td>
                          <td className="px-3 py-2.5 font-mono text-xs">{t.data_mb || t.data_size_mb || '—'}</td>
                          <td className="px-3 py-2.5 font-mono text-xs">{t.index_mb || t.index_size_mb || '—'}</td>
                          <td className="px-3 py-2.5 font-mono text-xs font-bold">{t.total_mb || t.total_size_mb || '—'}</td>
                          <td className="px-3 py-2.5 text-[10px] text-slate-400">
                            {(t.last_updated || t.modify_date || '').toString().slice(0, 16) || '—'}
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            {t.missing_index_count > 0 ? (
                              <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded-full text-[10px] font-bold">{t.missing_index_count}</span>
                            ) : (
                              <span className="text-green-400">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                      {filteredTables.length === 0 && (
                        <tr><td colSpan={8} className="text-center py-10 text-slate-400">No tables found</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </div>
          );
        })()}

        {/* ══ LOCKS ═════════════════════════════════════════════════ */}
        {activeTab === 'locks' && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricKpi title="Blocking Chains"  value={blocking.length}              accent={blocking.length > 0 ? 'red' : 'green'} />
              <MetricKpi title="Lock Waits/s"     value={fmtNum(locks.lock_waits_sec)} accent={locks.lock_waits_sec > 10 ? 'orange' : 'green'} />
              <MetricKpi title="Deadlocks/s"      value={fmtNum(locks.deadlocks_sec)}  accent={locks.deadlocks_sec > 0 ? 'red' : 'green'} />
              <MetricKpi title="Lock Timeouts/s"  value={fmtNum(locks.lock_timeouts_sec)} accent={locks.lock_timeouts_sec > 0 ? 'orange' : 'green'} />
            </div>

            <Panel title={`Blocking Sessions (${blocking.length})`}>
              {blocking.length === 0 ? (
                <div className="text-center py-10">
                  <CheckCircle2 className="mx-auto text-green-400 mb-3" size={36} />
                  <p className="text-slate-500 font-semibold">No blocking detected</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {blocking.map((b, i) => (
                    <div key={i} className="bg-red-50 border border-red-200 rounded-xl p-4">
                      <div className="flex items-center gap-3 mb-2">
                        <Lock className="text-red-500" size={16} />
                        <span className="font-bold text-red-700 text-sm">
                          SPID {b.blocking_spid || b.blocker_id} blocking SPID {b.blocked_spid || '—'}
                        </span>
                        {b.wait_time_ms && (
                          <span className="ml-auto text-xs font-black text-orange-600">{fmtNum(b.wait_time_ms)}ms wait</span>
                        )}
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                        <div><span className="text-slate-400">Login: </span><span className="font-semibold">{b.login_name || '—'}</span></div>
                        <div><span className="text-slate-400">DB: </span><span className="font-semibold">{b.database_name || '—'}</span></div>
                        <div><span className="text-slate-400">Status: </span><span className="font-semibold">{b.status || '—'}</span></div>
                        <div><span className="text-slate-400">Wait Type: </span><span className="font-semibold">{b.wait_type || '—'}</span></div>
                      </div>
                      {(b.sql_text || b.query) && (
                        <div className="mt-2 bg-white rounded-lg p-2 font-mono text-[10px] text-slate-600 truncate">
                          {String(b.sql_text || b.query).slice(0, 200)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            <Panel title="Lock Statistics">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {[
                  ['Lock Requests/s',    fmtNum(locks.lock_requests_sec),   'Total lock requests per second'],
                  ['Lock Timeouts/s',    fmtNum(locks.lock_timeouts_sec),   'Lock requests that timed out'],
                  ['Deadlocks/s',        fmtNum(locks.deadlocks_sec),       'Deadlocks per second'],
                  ['Lock Waits/s',       fmtNum(locks.lock_waits_sec),      'Lock requests that had to wait'],
                  ['Avg Lock Wait ms',   `${locks.avg_lock_wait_ms || 0}ms`, 'Average time waiting for a lock'],
                  ['Lock Memory KB',     fmtNum(locks.lock_memory_kb),      'Memory allocated to lock manager'],
                ].map(([label, value, desc]) => (
                  <div key={label} className="bg-slate-50 rounded-xl p-3 border border-slate-100">
                    <p className="text-[10px] text-slate-400 font-semibold uppercase mb-1">{label}</p>
                    <p className="text-lg font-black text-slate-800">{value || '—'}</p>
                    <p className="text-[10px] text-slate-400 mt-1">{desc}</p>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
        )}

        {/* ══ REPLICATION / ALWAYSON ════════════════════════════════ */}
        {activeTab === 'replication' && (
          <div className="space-y-5">
            <Panel>
              <div className="flex items-center gap-3 mb-5">
                <GitBranch className="text-blue-600" size={22} />
                <h2 className="text-lg font-bold text-slate-800">AlwaysOn / Replication Status</h2>
                <span className={`px-3 py-1 rounded-full text-xs font-bold ${
                  hasAlwaysOn ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'}`}>
                  {hasAlwaysOn ? 'AlwaysOn AG' : 'Not Configured'}
                </span>
              </div>

              {!hasAlwaysOn ? (
                <div className="text-center py-10 text-slate-400">
                  <GitBranch size={44} className="mx-auto mb-4 text-slate-200" />
                  <p className="font-semibold">No AlwaysOn Availability Groups detected</p>
                  <p className="text-sm mt-1">Configure SQL Server AlwaysOn AG or replication to enable this tab.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* AG Overview */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <HeartbeatCard label="AG Name"        value={always_on.ag_name || '—'} />
                    <HeartbeatCard label="Health State"   value={always_on.health_state || always_on.synchronization_health_desc || '—'}
                      warn={always_on.health_state !== 'HEALTHY' && always_on.synchronization_health_desc !== 'HEALTHY'} />
                    <HeartbeatCard label="Primary Replica" value={always_on.primary_replica || '—'} />
                    <HeartbeatCard label="Failover Mode"   value={always_on.failover_mode || '—'} />
                  </div>

                  {/* AG Properties */}
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {Object.entries(always_on)
                      .filter(([k]) => !['replicas', 'databases', 'listeners'].includes(k))
                      .slice(0, 12)
                      .map(([k, v]) => (
                        <div key={k} className="bg-slate-50 rounded-xl p-3 border border-slate-100">
                          <p className="text-[10px] text-slate-400 font-bold uppercase mb-1">{k.replace(/_/g, ' ')}</p>
                          <p className={`font-mono text-sm font-bold ${
                            String(v) === 'HEALTHY' || String(v) === 'SYNCHRONIZED' ? 'text-green-600'
                            : String(v) === 'NOT_HEALTHY' || String(v) === 'NOT SYNCHRONIZED' ? 'text-red-600'
                            : 'text-slate-800'}`}>
                            {String(v || '—').slice(0, 50)}
                          </p>
                        </div>
                      ))}
                  </div>

                  {/* Replicas table */}
                  {Array.isArray(always_on.replicas) && always_on.replicas.length > 0 && (
                    <Panel title={`AG Replicas (${always_on.replicas.length})`}>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-slate-50">
                            <tr>{['Replica', 'Role', 'Availability Mode', 'Failover Mode', 'Sync State', 'Connected'].map(h => (
                              <th key={h} className="px-4 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                            ))}</tr>
                          </thead>
                          <tbody>
                            {always_on.replicas.map((r, i) => (
                              <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                                <td className="px-4 py-3 font-semibold text-blue-700">{r.replica_server_name || r.replica || '—'}</td>
                                <td className="px-4 py-3">
                                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                    r.role_desc === 'PRIMARY' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'}`}>
                                    {r.role_desc || r.role || '—'}
                                  </span>
                                </td>
                                <td className="px-4 py-3 text-xs">{r.availability_mode_desc || r.availability_mode || '—'}</td>
                                <td className="px-4 py-3 text-xs">{r.failover_mode_desc || r.failover_mode || '—'}</td>
                                <td className="px-4 py-3">
                                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                    r.synchronization_health_desc === 'HEALTHY' || r.sync_state === 'SYNCHRONIZED'
                                      ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                                    {r.synchronization_health_desc || r.sync_state || '—'}
                                  </span>
                                </td>
                                <td className="px-4 py-3">
                                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                    r.connected_state_desc === 'CONNECTED' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                                    {r.connected_state_desc || r.connected || '—'}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </Panel>
                  )}

                  {/* AG Databases */}
                  {Array.isArray(always_on.databases) && always_on.databases.length > 0 && (
                    <Panel title="AG Databases">
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-slate-50">
                            <tr>{['Database', 'Replica', 'Sync State', 'Suspend Reason', 'Redo Queue KB', 'Log Send Queue KB'].map(h => (
                              <th key={h} className="px-4 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                            ))}</tr>
                          </thead>
                          <tbody>
                            {always_on.databases.map((d, i) => (
                              <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                                <td className="px-4 py-3 font-semibold text-blue-700">{d.database_name || d.name || '—'}</td>
                                <td className="px-4 py-3 text-xs text-slate-400">{d.replica_server_name || '—'}</td>
                                <td className="px-4 py-3">
                                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                    d.synchronization_state_desc === 'SYNCHRONIZED' ? 'bg-green-100 text-green-700'
                                    : d.synchronization_state_desc === 'SYNCHRONIZING' ? 'bg-yellow-100 text-yellow-700'
                                    : 'bg-red-100 text-red-700'}`}>
                                    {d.synchronization_state_desc || d.sync_state || '—'}
                                  </span>
                                </td>
                                <td className="px-4 py-3 text-xs text-slate-400">{d.suspend_reason_desc || '—'}</td>
                                <td className="px-4 py-3 font-mono text-xs">{fmtNum(d.redo_queue_size)}</td>
                                <td className="px-4 py-3 font-mono text-xs">{fmtNum(d.log_send_queue_size)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </Panel>
                  )}
                </div>
              )}
            </Panel>

            {/* Replication (traditional) */}
            {replication && Object.keys(replication).length > 0 && !hasAlwaysOn && (
              <Panel title="Transactional / Merge Replication">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {Object.entries(replication).slice(0, 18).map(([k, v]) => (
                    <div key={k} className="bg-slate-50 rounded-xl p-3 border border-slate-100">
                      <p className="text-[10px] text-slate-400 font-bold uppercase mb-1">{k.replace(/_/g, ' ')}</p>
                      <p className="font-mono text-sm font-bold text-slate-800">{String(v || '—').slice(0, 60)}</p>
                    </div>
                  ))}
                </div>
              </Panel>
            )}
          </div>
        )}

        {/* ══ USERS ═════════════════════════════════════════════════ */}
        {activeTab === 'users' && (
          <div className="space-y-5">
            <div className="grid grid-cols-3 gap-3">
              <MetricKpi title="Total Logins"  value={logins.length}  accent="blue" />
              <MetricKpi title="DB Users"      value={users.length}   accent="green" />
              <MetricKpi title="Active Sessions" value={sessions.active || 0} accent="indigo" />
            </div>

            {logins.length > 0 && (
              <Panel title={`Server Logins (${logins.length})`}>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50">
                      <tr>{['Login', 'Type', 'Enabled', 'Password Policy', 'Default DB', 'Last Login', 'Is Sysadmin'].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                      ))}</tr>
                    </thead>
                    <tbody>
                      {logins.map((l, i) => (
                        <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                          <td className="px-4 py-3 font-bold text-blue-700">{l.name || l.login_name || '—'}</td>
                          <td className="px-4 py-3 text-xs">
                            <span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded-full font-bold text-[10px]">
                              {l.type_desc || l.login_type || '—'}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            {l.is_disabled !== undefined ? (
                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${!l.is_disabled ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                                {l.is_disabled ? 'Disabled' : 'Enabled'}
                              </span>
                            ) : '—'}
                          </td>
                          <td className="px-4 py-3 text-xs">{l.is_policy_checked !== undefined ? (l.is_policy_checked ? 'Yes' : 'No') : '—'}</td>
                          <td className="px-4 py-3 text-xs text-slate-400">{l.default_database_name || '—'}</td>
                          <td className="px-4 py-3 text-[10px] text-slate-400">{(l.last_login || '').toString().slice(0, 16) || '—'}</td>
                          <td className="px-4 py-3">
                            {l.is_sysadmin ? (
                              <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded-full text-[10px] font-bold">YES</span>
                            ) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            )}

            {users.length > 0 && (
              <Panel title="Database Users">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50">
                      <tr>{['User', 'Database', 'Type', 'Default Schema', 'Roles'].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                      ))}</tr>
                    </thead>
                    <tbody>
                      {users.map((u, i) => (
                        <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                          <td className="px-4 py-3 font-bold text-blue-700">{u.name || u.user_name || '—'}</td>
                          <td className="px-4 py-3 text-xs text-slate-400">{u.database_name || u.db || '—'}</td>
                          <td className="px-4 py-3 text-[10px]">
                            <span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded-full font-bold">{u.type_desc || u.user_type || '—'}</span>
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-400">{u.default_schema_name || '—'}</td>
                          <td className="px-4 py-3 text-xs text-slate-400">{u.roles || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            )}
          </div>
        )}

        {/* ══ STORAGE ═══════════════════════════════════════════════ */}
        {activeTab === 'storage' && (() => {
          const userDbs    = databases.filter(d => !['master','model','msdb','tempdb'].includes((d.name||'').toLowerCase()));
          const totalMB    = databases.reduce((a, d) => a + Number(d.size_mb || d.data_size_mb || 0), 0);
          const logMB      = databases.reduce((a, d) => a + Number(d.log_size_mb || 0), 0);
          const DB_COLORS  = [C.msBlue, C.sky, C.indigo, C.orange, C.purple, C.teal, C.green, C.red];
          return (
            <div className="space-y-5">
              <div className="grid grid-cols-3 gap-3">
                <MetricKpi title="Total Data Size"  value={totalMB > 1024 ? `${(totalMB/1024).toFixed(2)} GB` : `${totalMB.toFixed(0)} MB`}  accent="orange" />
                <MetricKpi title="Total Log Size"   value={logMB > 1024   ? `${(logMB/1024).toFixed(2)} GB`   : `${logMB.toFixed(0)} MB`}    accent="blue" />
                <MetricKpi title="User Databases"   value={userDbs.length}                                                                     accent="indigo" />
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
                <ChartCard title="Top Databases by Data Size (MB)">
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart layout="vertical" data={databases.slice(0, 10).map(d => ({
                      name: (d.name || '').slice(0, 16),
                      data: Number(d.size_mb || d.data_size_mb || 0),
                      log:  Number(d.log_size_mb || 0),
                    }))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={v => `${v}MB`} />
                      <YAxis width={120} type="category" dataKey="name" tick={{ fontSize: 10 }} />
                      <Tooltip formatter={v => `${v} MB`} />
                      <Bar dataKey="data" fill={C.msBlue} radius={[0, 4, 4, 0]} stackId="a" name="Data" />
                      <Bar dataKey="log"  fill={C.sky}    radius={[0, 4, 4, 0]} stackId="a" name="Log" />
                      <Legend />
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>

                <ChartCard title="Database Size Distribution">
                  <ResponsiveContainer width="100%" height={280}>
                    <PieChart>
                      <Pie
                        data={databases.filter(d => Number(d.size_mb || d.data_size_mb || 0) > 0)}
                        dataKey={d => Number(d.size_mb || d.data_size_mb || 0)}
                        nameKey="name"
                        innerRadius={50}
                        outerRadius={90}
                        label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                      >
                        {databases.map((_, i) => <Cell key={i} fill={DB_COLORS[i % DB_COLORS.length]} />)}
                      </Pie>
                      <Tooltip formatter={v => `${v} MB`} />
                    </PieChart>
                  </ResponsiveContainer>
                </ChartCard>
              </div>

              {tables.length > 0 && (
                <ChartCard title="Top 10 Tables by Total Size (MB)">
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart layout="vertical" data={[...tables].sort((a, b) => Number(b.total_mb || b.total_size_mb || 0) - Number(a.total_mb || a.total_size_mb || 0)).slice(0, 10).map(t => ({
                      name: `${t.schema_name || t.schema || ''}.${(t.table_name || t.name || '').slice(0, 20)}`,
                      data: Number(t.data_mb || t.data_size_mb || 0),
                      idx:  Number(t.index_mb || t.index_size_mb || 0),
                    }))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={v => `${v}MB`} />
                      <YAxis width={170} type="category" dataKey="name" tick={{ fontSize: 9 }} />
                      <Tooltip formatter={v => `${v} MB`} />
                      <Bar dataKey="data" fill={C.msBlue} stackId="a" name="Data" />
                      <Bar dataKey="idx"  fill={C.indigo} stackId="a" name="Index" radius={[0,4,4,0]} />
                      <Legend />
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>
              )}
            </div>
          );
        })()}

        {/* ══ BACKUP & PITR — navigate to dedicated page ═════════════════ */}
        {activeTab === 'backup' && navigate(`/mssql-dashboard/${id}/backup`)}

      </div>
    </div>
  );
}

/* ─── helpers ─── */
function computeHealthScore(hs, blocking, connPct, cachePct) {
  let score = 100;
  if (connPct > 90)        score -= 30;
  else if (connPct > 70)   score -= 15;
  if (cachePct < 80)       score -= 20;
  else if (cachePct < 90)  score -= 10;
  if (blocking.length > 5) score -= 20;
  else if (blocking.length > 0) score -= 10;
  if (hs.deadlocks_sec > 0) score -= 10;
  return Math.max(0, score);
}
function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  const b = Number(bytes);
  if (b > 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
  if (b > 1048576)    return `${(b / 1048576).toFixed(2)} MB`;
  if (b > 1024)       return `${(b / 1024).toFixed(2)} KB`;
  return `${b} B`;
}
function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

/* ─── small components ─── */
function HealthBadge({ score }) {
  const color = score >= 80 ? 'bg-green-500' : score >= 60 ? 'bg-yellow-400' : 'bg-red-500';
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-xl ${color} text-white text-xs font-black shadow`}>
      <Heart size={12} className="animate-pulse" />
      Health {score}
    </div>
  );
}
function KpiCard({ icon: Icon, title, value, accent }) {
  const acc = {
    sky:    'border-l-sky-500',
    blue:   'border-l-blue-500',
    indigo: 'border-l-indigo-500',
    green:  'border-l-green-500',
    orange: 'border-l-orange-500',
    red:    'border-l-red-500',
    purple: 'border-l-purple-500',
    slate:  'border-l-slate-400',
  };
  return (
    <div className={`bg-white rounded-xl border border-slate-200 border-l-4 ${acc[accent] || acc.slate} p-4 hover:shadow-md transition-all`}>
      <div className="flex justify-between items-start">
        <div>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{title}</p>
          <p className="text-lg font-black text-slate-800 mt-1">{value ?? 'N/A'}</p>
        </div>
        <Icon size={20} className="text-slate-300 mt-0.5" />
      </div>
    </div>
  );
}
function MetricKpi({ title, value, accent }) {
  const acc = {
    green:  'bg-green-50 border-green-200 text-green-700',
    red:    'bg-red-50 border-red-200 text-red-700',
    orange: 'bg-orange-50 border-orange-200 text-orange-700',
    blue:   'bg-blue-50 border-blue-200 text-blue-700',
    sky:    'bg-sky-50 border-sky-200 text-sky-700',
    indigo: 'bg-indigo-50 border-indigo-200 text-indigo-700',
    purple: 'bg-purple-50 border-purple-200 text-purple-700',
    slate:  'bg-slate-50 border-slate-200 text-slate-700',
  };
  return (
    <div className={`rounded-xl border p-4 ${acc[accent] || acc.slate}`}>
      <p className="text-[10px] font-bold uppercase tracking-wide opacity-70">{title}</p>
      <p className="text-2xl font-black mt-1">{value ?? '—'}</p>
    </div>
  );
}
function StatusBadge({ ok, label }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold ${
      ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
      {ok ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />}
      {label}
    </span>
  );
}
function ChartCard({ title, children }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      <h3 className="font-bold text-slate-700 text-sm mb-4">{title}</h3>
      {children}
    </div>
  );
}
function Panel({ title, children }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      {title && <h3 className="font-bold text-slate-800 text-sm mb-4">{title}</h3>}
      {children}
    </div>
  );
}
function Row({ label, value, mono }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 border-b border-slate-100 last:border-0">
      <span className="text-slate-500 text-xs flex-shrink-0">{label}</span>
      <span className={`text-right font-semibold text-slate-800 text-xs ${mono ? 'font-mono' : ''} break-all`}>{value}</span>
    </div>
  );
}
function ActionCard({ icon, title, desc, onClick }) {
  return (
    <button onClick={onClick}
      className="bg-white rounded-2xl border border-slate-200 p-5 text-left hover:shadow-md hover:border-slate-300 transition-all group">
      <div className="mb-3">{icon}</div>
      <p className="font-bold text-slate-900 text-sm">{title}</p>
      <p className="text-xs text-slate-400 mt-1">{desc}</p>
      <ChevronRight size={14} className="text-slate-200 group-hover:text-slate-500 mt-3 transition-colors" />
    </button>
  );
}
function HeartbeatCard({ label, value, warn }) {
  return (
    <div className={`rounded-xl border p-4 ${warn ? 'bg-red-50 border-red-200' : 'bg-blue-50 border-blue-200'}`}>
      <p className="text-[10px] text-slate-400 font-bold uppercase mb-1">{label}</p>
      <p className={`font-black text-lg ${warn ? 'text-red-700' : 'text-blue-700'}`}>{String(value)}</p>
    </div>
  );
}
function GaugeCard({ title, pct, sub, centerLabel, centerUnit = '%', colorFn }) {
  const safePct       = Math.max(0, Math.min(100, pct || 0));
  const fill          = colorFn ? colorFn(safePct) : (safePct > 80 ? C.red : safePct > 60 ? C.orange : C.msBlue);
  const displayCenter = centerLabel !== undefined ? centerLabel : safePct;
  const displayUnit   = centerLabel !== undefined ? centerUnit : '%';
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4 flex flex-col items-center">
      <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1 text-center">{title}</p>
      <div className="relative flex flex-col items-center">
        <PieChart width={150} height={90}>
          <Pie
            data={[{ v: safePct }, { v: 100 - safePct }]}
            cx={75} cy={86}
            startAngle={180} endAngle={0}
            innerRadius={50} outerRadius={68}
            dataKey="v" stroke="none"
          >
            <Cell fill={fill} />
            <Cell fill="#e2e8f0" />
          </Pie>
        </PieChart>
        <div style={{ marginTop: '-38px' }} className="text-center pointer-events-none">
          <p className="text-xl font-black text-slate-900 leading-none">{displayCenter}</p>
          <p className="text-[10px] text-slate-400 mt-0.5">{displayUnit}</p>
        </div>
      </div>
      <p className="text-[10px] text-slate-400 mt-2 text-center leading-tight">{sub}</p>
    </div>
  );
}
function TrendCard({ title, data, color, unit = '', fmtVal }) {
  const fmt    = fmtVal || (v => `${v}${unit}`);
  const latest = data[data.length - 1]?.v;
  const gradId = `tg-${title.replace(/\s+/g, '')}`;
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="flex justify-between items-center mb-2">
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">{title}</p>
        <span className="text-base font-black" style={{ color }}>{fmt(latest)}</span>
      </div>
      <ResponsiveContainer width="100%" height={68}>
        <AreaChart data={data}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={color} stopOpacity={0.25} />
              <stop offset="95%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="t" hide />
          <YAxis hide domain={['auto', 'auto']} />
          <Tooltip contentStyle={{ fontSize: 9, padding: '2px 8px' }} formatter={v => fmt(v)} labelFormatter={() => ''} />
          <Area type="monotone" dataKey="v" stroke={color} fill={`url(#${gradId})`} strokeWidth={2} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
      <div className="flex justify-between text-[9px] text-slate-300 mt-1">
        <span>{fmt(data[0]?.v)}</span>
        <span className="text-slate-400">{data.length} samples · 15s interval</span>
      </div>
    </div>
  );
}
function TabLoader() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="w-8 h-8 border-4 border-sky-200 border-t-sky-600 rounded-full animate-spin" />
    </div>
  );
}
