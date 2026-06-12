import React, { useState, useEffect, useRef } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Database, Server, Activity, HardDrive, RefreshCw, Clock,
  Layers, Network, ShieldCheck, AlertTriangle, Cpu, MemoryStick,
  FileText, Zap, Terminal, Archive, RotateCcw,
  CheckCircle2, XCircle, ChevronRight, Heart, Users, Lock,
  TrendingUp, BarChart2, Table, Settings, Bell,
  ArrowUp, ArrowDown, Minus, Search, Filter,
  ChevronDown, ChevronUp, Code2, FolderOpen, Key,
  Copy, Wifi, WifiOff, Loader2, GitBranch, Box, Boxes,
} from 'lucide-react';
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  LineChart, Line, AreaChart, Area,
} from 'recharts';
import client from '../../api/client';

/* ─── palette ─── */
const C = {
  red:    '#C74634',
  orange: '#F97316',
  amber:  '#F59E0B',
  green:  '#22C55E',
  blue:   '#3B82F6',
  purple: '#8B5CF6',
  slate:  '#64748B',
  teal:   '#14B8A6',
  rose:   '#F43F5E',
  yellow: '#EAB308',
  cyan:   '#06B6D4',
  indigo: '#6366F1',
};

/* ─── fetchers ─── */
const fetchDashboard   = (id) => client.get(`/connections/oracle/${id}/oracle-dashboard`).then(r => r.data);
const fetchSgaDetail   = (id) => client.get(`/connections/oracle/${id}/oracle-sga-detail`).then(r => r.data);
const fetchPgaDetail   = (id) => client.get(`/connections/oracle/${id}/oracle-pga-detail`).then(r => r.data);
const fetchSessions    = (id) => client.get(`/connections/oracle/${id}/oracle-sessions`).then(r => r.data);
const fetchTopSql      = (id) => client.get(`/connections/oracle/${id}/oracle-top-sql`).then(r => r.data);
const fetchWaitEvents  = (id) => client.get(`/connections/oracle/${id}/oracle-wait-events`).then(r => r.data);
const fetchTablespaces = (id) => client.get(`/connections/oracle/${id}/oracle-tablespaces`).then(r => r.data);
const fetchObjects     = (id) => client.get(`/connections/oracle/${id}/oracle-objects`).then(r => r.data);
const fetchUsers       = (id) => client.get(`/connections/oracle/${id}/oracle-users`).then(r => r.data);
const fetchRedoLogs    = (id) => client.get(`/connections/oracle/${id}/oracle-redo-logs`).then(r => r.data);
const fetchDataGuard   = (id) => client.get(`/connections/oracle/${id}/oracle-data-guard`).then(r => r.data);
const fetchProcesses   = (id) => client.get(`/connections/oracle/${id}/oracle-processes`).then(r => r.data);
const fetchSysStats    = (id) => client.get(`/connections/oracle/${id}/oracle-system-stats`).then(r => r.data);
const fetchSlowQueries = (id) => client.get(`/connections/oracle/${id}/oracle-slow-queries`).then(r => r.data);

const TABS = [
  { id: 'overview',     label: 'Overview',      icon: Activity },
  { id: 'performance',  label: 'Performance',   icon: TrendingUp },
  { id: 'sessions',     label: 'Sessions',      icon: Users },
  { id: 'sql',          label: 'SQL',           icon: Zap },
  { id: 'tablespaces',  label: 'Tablespaces',   icon: HardDrive },
  { id: 'objects',      label: 'Objects',       icon: Boxes },
  { id: 'dataguard',    label: 'Data Guard',    icon: ShieldCheck },
  { id: 'redologs',     label: 'Redo Logs',     icon: RotateCcw },
  { id: 'processes',    label: 'Processes',     icon: Cpu },
  { id: 'users',        label: 'Users',         icon: Key },
  { id: 'systemstats',  label: 'Sys Stats',     icon: BarChart2 },
  { id: 'slowqueries',  label: 'Slow Queries',  icon: Clock },
];

const REFRESH_INTERVAL = 15;

export default function OracleDashboard() {
  const { id }        = useParams();
  const navigate      = useNavigate();
  const [activeTab, setActiveTab]     = useState('overview');
  const [countdown, setCountdown]     = useState(REFRESH_INTERVAL);
  const [sparklines, setSparklines]   = useState({ sessions: [], bufHit: [], pga: [] });
  const [sqlSearch, setSqlSearch]     = useState('');
  const [userSearch, setUserSearch]   = useState('');
  const [statSearch, setStatSearch]   = useState('');
  const [expandedSql, setExpandedSql] = useState(null);
  const countRef = useRef(null);

  /* ── Main dashboard query ── */
  const { data, isLoading, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey:        ['oracleDashboard', id],
    queryFn:         () => fetchDashboard(id),
    retry:           false,
    refetchInterval: REFRESH_INTERVAL * 1000,
  });

  /* ── Per-tab queries ── */
  const { data: sgaData,    isLoading: sgaLoading }    = useQuery({ queryKey: ['oracleSga', id],    queryFn: () => fetchSgaDetail(id),   retry: false, refetchInterval: 30000, enabled: activeTab === 'performance' });
  const { data: pgaData,    isLoading: pgaLoading }    = useQuery({ queryKey: ['oraclePga', id],    queryFn: () => fetchPgaDetail(id),   retry: false, refetchInterval: 30000, enabled: activeTab === 'performance' });
  const { data: sessData,   isLoading: sessLoading }   = useQuery({ queryKey: ['oracleSessions', id], queryFn: () => fetchSessions(id), retry: false, refetchInterval: 10000, enabled: activeTab === 'sessions' });
  const { data: sqlData,    isLoading: sqlLoading }    = useQuery({ queryKey: ['oracleTopSql', id], queryFn: () => fetchTopSql(id),      retry: false, refetchInterval: 30000, enabled: activeTab === 'sql' });
  const { data: waitData,   isLoading: waitLoading }   = useQuery({ queryKey: ['oracleWaits', id],  queryFn: () => fetchWaitEvents(id),  retry: false, refetchInterval: 15000, enabled: activeTab === 'performance' || activeTab === 'overview' });
  const { data: tsData,     isLoading: tsLoading }     = useQuery({ queryKey: ['oracleTs', id],     queryFn: () => fetchTablespaces(id), retry: false, refetchInterval: 30000, enabled: activeTab === 'tablespaces' });
  const { data: objData,    isLoading: objLoading }    = useQuery({ queryKey: ['oracleObjs', id],   queryFn: () => fetchObjects(id),     retry: false, refetchInterval: 60000, enabled: activeTab === 'objects' });
  const { data: userData,   isLoading: userLoading }   = useQuery({ queryKey: ['oracleUsers', id],  queryFn: () => fetchUsers(id),       retry: false, refetchInterval: 60000, enabled: activeTab === 'users' });
  const { data: redoData,   isLoading: redoLoading }   = useQuery({ queryKey: ['oracleRedo', id],   queryFn: () => fetchRedoLogs(id),    retry: false, refetchInterval: 30000, enabled: activeTab === 'redologs' });
  const { data: dgData,     isLoading: dgLoading }     = useQuery({ queryKey: ['oracleDg', id],     queryFn: () => fetchDataGuard(id),   retry: false, refetchInterval: 30000, enabled: activeTab === 'dataguard' });
  const { data: procData,   isLoading: procLoading }   = useQuery({ queryKey: ['oracleProcs', id],  queryFn: () => fetchProcesses(id),   retry: false, refetchInterval: 15000, enabled: activeTab === 'processes' });
  const { data: sysStatData, isLoading: sysStatLoading } = useQuery({ queryKey: ['oracleSysStat', id], queryFn: () => fetchSysStats(id), retry: false, refetchInterval: 30000, enabled: activeTab === 'systemstats' });
  const { data: slowData,   isLoading: slowLoading }   = useQuery({ queryKey: ['oracleSlowSql', id], queryFn: () => fetchSlowQueries(id), retry: false, refetchInterval: 30000, enabled: activeTab === 'slowqueries' });

  /* ── Countdown timer ── */
  useEffect(() => {
    setCountdown(REFRESH_INTERVAL);
    if (countRef.current) clearInterval(countRef.current);
    countRef.current = setInterval(() => {
      setCountdown(c => (c <= 1 ? REFRESH_INTERVAL : c - 1));
    }, 1000);
    return () => clearInterval(countRef.current);
  }, [dataUpdatedAt]);

  /* ── Sparklines ── */
  useEffect(() => {
    if (!data) return;
    const hs = data?.health_summary || {};
    const sessCount = Number(hs.active_sessions) || 0;
    const bufHit    = Number(hs.buffer_cache_hit_pct) || 0;
    const pgaUsed   = Number(hs.pga_used_pct) || 0;
    setSparklines(prev => ({
      sessions: [...prev.sessions.slice(-20), { t: new Date().toLocaleTimeString(), v: sessCount }],
      bufHit:   [...prev.bufHit.slice(-20),   { t: new Date().toLocaleTimeString(), v: bufHit }],
      pga:      [...prev.pga.slice(-20),       { t: new Date().toLocaleTimeString(), v: pgaUsed }],
    }));
  }, [data]);

  if (isLoading) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center">
        <div className="w-12 h-12 border-4 border-red-200 border-t-red-600 rounded-full animate-spin mx-auto mb-4" />
        <p className="text-slate-600 font-semibold">Connecting to Oracle Database…</p>
      </div>
    </div>
  );

  if (error || data?.status === 'error') return (
    <div className="p-8">
      <div className="bg-red-50 border border-red-200 text-red-700 p-6 rounded-2xl max-w-2xl">
        <AlertTriangle className="mb-2" size={24} />
        <p className="font-bold text-lg">Connection Error</p>
        <p className="text-sm mt-2">{data?.error || error?.message}</p>
        <button onClick={() => refetch()} className="mt-4 px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700">Retry</button>
      </div>
    </div>
  );

  const {
    connection    = {},
    health_summary = {},
    tablespaces   = [],
    wait_events   = [],
    top_sql       = [],
    redo_logs     = [],
  } = data || {};

  const hs          = health_summary;
  const activeSess  = Number(hs.active_sessions) || 0;
  const totalSess   = Number(hs.total_sessions) || 0;
  const maxSess     = Number(hs.max_sessions) || 1;
  const sessionPct  = Math.min(100, Math.round((totalSess / maxSess) * 100));
  const bufHitPct   = Number(hs.buffer_cache_hit_pct) || 0;
  const libHitPct   = Number(hs.library_cache_hit_pct) || 0;
  const sgaMb       = Number(hs.sga_mb) || 0;
  const sgaTargetMb = Number(hs.sga_target_mb) || 0;
  const sgaUsedPct  = sgaTargetMb > 0 ? Math.min(100, Math.round(sgaMb / sgaTargetMb * 100)) : 0;
  const pgaMb       = Number(hs.pga_mb) || 0;
  const pgaTargetMb = Number(hs.pga_target_mb) || 0;
  const pgaUsedPct  = pgaTargetMb > 0 ? Math.min(100, Math.round(pgaMb / pgaTargetMb * 100)) : 0;
  const maxTsPct    = tablespaces.length > 0 ? Math.max(...tablespaces.map(t => Number(t.used_pct) || 0)) : 0;

  const healthScore = computeHealthScore(sessionPct, bufHitPct, maxTsPct, wait_events.length);

  const POOL_COLORS = [C.red, C.orange, C.amber, C.blue, C.purple, C.teal, C.green, C.cyan];

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">

      {/* ─── HEADER ─── */}
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-indigo-950 text-white shadow-xl">
        <div className="px-6 py-4 flex flex-wrap justify-between items-start gap-3">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-red-400/20 border border-red-400/40 rounded-2xl flex items-center justify-center">
              {/* Health ring SVG */}
              <svg width="32" height="32" viewBox="0 0 36 36">
                <circle cx="18" cy="18" r="15.9" fill="none" stroke="#ffffff20" strokeWidth="3" />
                <circle cx="18" cy="18" r="15.9" fill="none"
                  stroke={healthScore >= 80 ? '#22C55E' : healthScore >= 60 ? '#F59E0B' : '#EF4444'}
                  strokeWidth="3" strokeDasharray={`${healthScore} ${100 - healthScore}`}
                  strokeLinecap="round" strokeDashoffset="25" transform="rotate(-90 18 18)" />
                <text x="18" y="22" textAnchor="middle" fontSize="9" fill="white" fontWeight="bold">{healthScore}</text>
              </svg>
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight">Oracle Dashboard</h1>
              <p className="text-red-300 text-sm mt-0.5">
                {connection?.name || 'Oracle'} — {connection?.host}:{connection?.port}
                {connection?.service_name ? ` / ${connection.service_name}` : connection?.database ? ` / ${connection.database}` : ''}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <HealthBadge score={healthScore} />
            {[
              { to: `/oracle-dashboard/${id}/slow-queries`,   label: 'Slow Queries' },
              { to: `/oracle-dashboard/${id}/error-logs`,     label: 'Error Logs' },
              { to: `/oracle-dashboard/${id}/index-analysis`, label: 'Index Analysis' },
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
              <span className="ml-1 w-5 h-5 rounded-full bg-red-500/30 text-red-200 text-[10px] font-black flex items-center justify-center">
                {countdown}
              </span>
            </button>
          </div>
        </div>

        {/* TAB BAR */}
        <div className="px-4 flex gap-0.5 overflow-x-auto border-t border-white/10">
          {TABS.map(tab => {
            const Icon = tab.icon;
            return (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`relative flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-t-lg whitespace-nowrap transition-all ${
                  activeTab === tab.id ? 'bg-slate-50 text-red-700' : 'text-white/60 hover:text-white hover:bg-white/10'
                }`}>
                <Icon size={13} />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ─── TAB CONTENT ─── */}
      <div className="flex-1 p-5 overflow-auto">

        {/* ══ OVERVIEW ══════════════════════════════════════════════ */}
        {activeTab === 'overview' && (
          <div className="space-y-4">

            {/* KPI strip */}
            <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3">
              <KpiCard icon={Server}      title="Instance"      value={hs.instance_name || '—'}   accent="red" />
              <KpiCard icon={Database}    title="DB Name"       value={hs.db_name || '—'}          accent="orange" />
              <KpiCard icon={Activity}    title="Status"        value={hs.status || '—'}           accent={hs.status === 'OPEN' ? 'green' : 'red'} />
              <KpiCard icon={Users}       title="Sessions"      value={`${totalSess}/${maxSess}`}  accent={sessionPct > 80 ? 'red' : 'green'} />
              <KpiCard icon={MemoryStick} title="SGA (MB)"      value={fmtNum(sgaMb)}              accent="blue" />
              <KpiCard icon={Cpu}         title="PGA (MB)"      value={fmtNum(pgaMb)}              accent="purple" />
              <KpiCard icon={HardDrive}   title="DB Size (GB)"  value={hs.db_size_gb || '—'}       accent="amber" />
              <KpiCard icon={TrendingUp}  title="Buffer Hit%"   value={`${bufHitPct}%`}            accent={bufHitPct < 80 ? 'red' : bufHitPct < 90 ? 'orange' : 'green'} />
            </div>

            {/* Status badges */}
            <div className="flex flex-wrap gap-2">
              <StatusBadge ok={hs.status === 'OPEN'}      label={`DB: ${hs.status || '—'}`} />
              <StatusBadge ok={sessionPct < 80}           label={`Sessions ${sessionPct}%`} />
              <StatusBadge ok={bufHitPct >= 90}           label={`Buffer Hit ${bufHitPct}%`} />
              <StatusBadge ok={libHitPct >= 95}           label={`Library Cache ${libHitPct}%`} />
              <StatusBadge ok={maxTsPct < 85}             label={`Max TS ${maxTsPct}%`} />
              {hs.log_mode && <StatusBadge ok={hs.log_mode === 'ARCHIVELOG'} label={`Log: ${hs.log_mode}`} />}
            </div>

            {/* Gauges */}
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
              <GaugeCard title="Sessions %" pct={sessionPct}
                sub={`${totalSess} total / ${maxSess} max`}
                colorFn={v => v > 80 ? C.red : v > 60 ? C.orange : C.green} />
              <GaugeCard title="SGA Used %" pct={sgaUsedPct}
                sub={`${fmtNum(sgaMb)} MB of ${fmtNum(sgaTargetMb)} MB target`}
                colorFn={v => v > 90 ? C.red : v > 75 ? C.orange : C.teal} />
              <GaugeCard title="Buffer Cache Hit" pct={bufHitPct}
                sub="Logical read efficiency"
                colorFn={v => v < 70 ? C.red : v < 85 ? C.orange : C.green} />
              <GaugeCard title="PGA Used %" pct={pgaUsedPct}
                sub={`${fmtNum(pgaMb)} MB of ${fmtNum(pgaTargetMb)} MB target`}
                colorFn={v => v > 90 ? C.red : v > 75 ? C.orange : C.purple} />
            </div>

            {/* Sparklines */}
            {sparklines.sessions.length > 2 ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <TrendCard title="Active Sessions"    data={sparklines.sessions} color={C.red}    unit="" />
                <TrendCard title="Buffer Cache Hit %" data={sparklines.bufHit}   color={C.green}  unit="%" />
                <TrendCard title="PGA Used %"         data={sparklines.pga}      color={C.purple} unit="%" />
              </div>
            ) : (
              <div className="bg-white rounded-2xl border border-slate-200 p-4 text-center text-slate-400 text-xs">
                Live trend charts appear after first auto-refresh
              </div>
            )}

            {/* Wait events + Top SQL */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <Panel title="Top Wait Events">
                {wait_events.length === 0 ? (
                  <p className="text-center text-slate-400 text-xs py-8">No wait event data</p>
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart layout="vertical"
                      data={wait_events.slice(0, 8).map(w => ({
                        name: (w.event || '').slice(0, 28),
                        waits: Number(w.total_waits) || 0,
                        time_s: Number(w.time_waited_seconds) || 0,
                      }))}
                      margin={{ left: 10, right: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={fmtNum} axisLine={false} tickLine={false} />
                      <YAxis width={155} type="category" dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                      <Tooltip formatter={(v, n) => [fmtNum(v), n]} cursor={{ fill: '#fef2f2' }} />
                      <Bar dataKey="waits" fill={C.red} radius={[0, 4, 4, 0]} name="Waits" />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </Panel>

              <Panel title="Instance Info">
                <Row label="Instance Name"   value={hs.instance_name || '—'} mono />
                <Row label="Host"            value={hs.host_name || '—'} mono />
                <Row label="DB Name"         value={hs.db_name || '—'} mono />
                <Row label="Status"          value={hs.status || '—'} />
                <Row label="Log Mode"        value={hs.log_mode || '—'} />
                <Row label="Startup Time"    value={hs.startup_time || '—'} />
                <Row label="DB Size (GB)"    value={hs.db_size_gb || '—'} />
                <Row label="Buffer Cache Hit%" value={`${bufHitPct}%`} />
                <Row label="Library Cache Hit%" value={`${libHitPct}%`} />
              </Panel>
            </div>

            {/* Top SQL table */}
            <Panel title={`Top SQL by Elapsed Time (${top_sql.length})`}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr>
                      {['SQL ID','Executions','Elapsed (ms)','CPU (ms)','Buf Gets','Disk Reads','Rows','Avg Elapsed ms','SQL Text'].map(h => (
                        <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {top_sql.slice(0, 10).map((s, i) => (
                      <tr key={i} className={`border-t border-slate-100 hover:bg-slate-50 ${s.avg_elapsed_ms > 1000 ? 'bg-red-50/40' : ''}`}>
                        <td className="px-3 py-2.5 font-mono text-[10px] text-red-700">{s.sql_id || '—'}</td>
                        <td className="px-3 py-2.5 font-bold text-slate-800">{fmtNum(s.executions)}</td>
                        <td className={`px-3 py-2.5 font-bold text-sm ${s.elapsed_ms > 5000 ? 'text-red-600' : s.elapsed_ms > 1000 ? 'text-orange-600' : 'text-slate-700'}`}>{fmtNum(s.elapsed_ms)}</td>
                        <td className="px-3 py-2.5 font-mono text-xs">{fmtNum(s.cpu_ms)}</td>
                        <td className="px-3 py-2.5 font-mono text-xs">{fmtNum(s.buffer_gets)}</td>
                        <td className="px-3 py-2.5 font-mono text-xs">{fmtNum(s.disk_reads)}</td>
                        <td className="px-3 py-2.5 font-mono text-xs">{fmtNum(s.rows_processed)}</td>
                        <td className={`px-3 py-2.5 font-bold text-xs ${s.avg_elapsed_ms > 1000 ? 'text-red-600' : s.avg_elapsed_ms > 200 ? 'text-orange-600' : 'text-green-600'}`}>{fmtNum(s.avg_elapsed_ms)}</td>
                        <td className="px-3 py-2.5 font-mono text-[10px] text-slate-500 max-w-[200px] truncate">{(s.sql_text || '').slice(0, 80) || '—'}</td>
                      </tr>
                    ))}
                    {top_sql.length === 0 && (
                      <tr><td colSpan={9} className="text-center py-8 text-slate-400">No SQL data</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Panel>

          </div>
        )}

        {/* ══ PERFORMANCE ═══════════════════════════════════════════ */}
        {activeTab === 'performance' && (
          <div className="space-y-5">
            {(sgaLoading || pgaLoading || waitLoading) && !sgaData && !pgaData ? <TabLoader /> : (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <MetricKpi title="Buffer Cache Hit%" value={`${bufHitPct}%`} accent={bufHitPct < 80 ? 'red' : 'green'} />
                  <MetricKpi title="Library Cache Hit%" value={`${libHitPct}%`} accent={libHitPct < 90 ? 'orange' : 'green'} />
                  <MetricKpi title="SGA (MB)" value={fmtNum(sgaMb)} accent="blue" />
                  <MetricKpi title="PGA (MB)" value={fmtNum(pgaMb)} accent="purple" />
                </div>

                {/* SGA pool breakdown */}
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
                  <Panel title="SGA Pool Breakdown">
                    {sgaData?.pools?.length > 0 ? (
                      <>
                        <ResponsiveContainer width="100%" height={220}>
                          <BarChart data={sgaData.pools.slice(0, 8)}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                            <XAxis dataKey="pool" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                            <YAxis tick={{ fontSize: 9 }} tickFormatter={v => `${v}MB`} axisLine={false} tickLine={false} />
                            <Tooltip formatter={v => `${v} MB`} cursor={{ fill: '#fef2f2' }} />
                            <Bar dataKey="mb" radius={[4, 4, 0, 0]} name="MB">
                              {(sgaData.pools || []).map((_, i) => <Cell key={i} fill={POOL_COLORS[i % POOL_COLORS.length]} />)}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          {sgaData.pools.slice(0, 6).map((p, i) => (
                            <div key={i} className="flex items-center justify-between bg-slate-50 rounded-lg px-3 py-2 text-xs">
                              <span className="flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: POOL_COLORS[i % POOL_COLORS.length] }} />
                                <span className="text-slate-600 truncate max-w-[100px]">{p.pool}</span>
                              </span>
                              <span className="font-bold text-slate-800">{fmtNum(p.mb)} MB</span>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : sgaLoading ? <TabLoader /> : <p className="text-center text-slate-400 text-xs py-8">No SGA data</p>}
                  </Panel>

                  {/* PGA stats */}
                  <Panel title="PGA Statistics">
                    {pgaData?.summary ? (
                      <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-3">
                          {[
                            ['Total Allocated', `${fmtNum(pgaData.summary.total_allocated_mb)} MB`],
                            ['Total Used',      `${fmtNum(pgaData.summary.total_used_mb)} MB`],
                            ['Aggregate Target',`${fmtNum(pgaData.summary.aggregate_target_mb)} MB`],
                            ['Cache Hit %',     `${pgaData.summary.cache_hit_pct}%`],
                            ['Work Areas Active', pgaData.summary.work_areas_active],
                          ].map(([label, val]) => (
                            <div key={label} className="bg-slate-50 rounded-xl border border-slate-100 p-3">
                              <p className="text-[10px] text-slate-400 font-semibold uppercase">{label}</p>
                              <p className="text-lg font-black text-slate-800 mt-0.5">{val}</p>
                            </div>
                          ))}
                        </div>
                        <div className="mt-2 max-h-48 overflow-y-auto">
                          {(pgaData.stats || []).slice(0, 20).map((s, i) => (
                            <div key={i} className="flex justify-between py-1.5 border-b border-slate-100 last:border-0 text-xs">
                              <span className="text-slate-500 truncate max-w-[200px]">{s.name}</span>
                              <span className="font-mono font-bold text-slate-800">{fmtNum(s.value)} {s.unit}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : pgaLoading ? <TabLoader /> : <p className="text-center text-slate-400 text-xs py-8">No PGA data</p>}
                  </Panel>
                </div>

                {/* Wait events */}
                <Panel title="Wait Events by Time">
                  {waitData?.events?.length > 0 ? (
                    <>
                      <ResponsiveContainer width="100%" height={280}>
                        <BarChart layout="vertical"
                          data={(waitData.events || []).slice(0, 12).map(w => ({
                            name: (w.event || '').slice(0, 30),
                            time_s: Number(w.time_waited_seconds) || 0,
                            waits: Number(w.total_waits) || 0,
                          }))}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                          <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={v => `${v}s`} axisLine={false} tickLine={false} />
                          <YAxis width={165} type="category" dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                          <Tooltip formatter={(v, n) => [n === 'time_s' ? `${v}s` : fmtNum(v), n === 'time_s' ? 'Time Waited' : 'Waits']} cursor={{ fill: '#fef2f2' }} />
                          <Bar dataKey="time_s" radius={[0, 4, 4, 0]}>
                            {(waitData.events || []).slice(0, 12).map((_, i) => (
                              <Cell key={i} fill={[C.red, C.orange, C.amber, C.purple, C.blue, C.teal, C.green][i % 7]} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                      {waitData.class_breakdown?.length > 0 && (
                        <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2">
                          {waitData.class_breakdown.map((cls, i) => (
                            <div key={i} className="bg-slate-50 rounded-lg px-3 py-2 text-xs border border-slate-100">
                              <p className="text-slate-400 font-semibold">{cls.wait_class}</p>
                              <p className="font-bold text-slate-800 mt-0.5">{fmtNum(cls.time_seconds)}s</p>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  ) : waitLoading ? <TabLoader /> : <p className="text-center text-slate-400 text-xs py-8">No wait event data</p>}
                </Panel>

                {/* Dictionary cache hit (from library cache data) */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <MetricKpi title="SGA Used %" value={`${sgaUsedPct}%`} accent={sgaUsedPct > 90 ? 'red' : 'green'} />
                  <MetricKpi title="PGA Used %" value={`${pgaUsedPct}%`} accent={pgaUsedPct > 90 ? 'red' : 'purple'} />
                  <MetricKpi title="Max Tablespace %" value={`${maxTsPct}%`} accent={maxTsPct > 85 ? 'red' : maxTsPct > 70 ? 'orange' : 'green'} />
                  <MetricKpi title="Total Sessions" value={totalSess} accent="blue" />
                </div>
              </>
            )}
          </div>
        )}

        {/* ══ SESSIONS ══════════════════════════════════════════════ */}
        {activeTab === 'sessions' && (
          sessLoading ? <TabLoader /> : (() => {
            const sessions  = sessData?.sessions || [];
            const summary   = sessData?.summary || {};
            const blocking  = sessions.filter(s => s.blocking_session != null);
            const userSess  = sessions.filter(s => s.type === 'USER');
            return (
              <div className="space-y-5">
                <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                  <MetricKpi title="Total"       value={summary.total || 0}       accent="blue" />
                  <MetricKpi title="Active"      value={summary.active || 0}      accent={summary.active > 0 ? 'green' : 'slate'} />
                  <MetricKpi title="Inactive"    value={summary.inactive || 0}    accent="slate" />
                  <MetricKpi title="Blocking"    value={summary.blocking || 0}    accent={summary.blocking > 0 ? 'red' : 'green'} />
                  <MetricKpi title="User"        value={summary.user || 0}        accent="orange" />
                  <MetricKpi title="Background"  value={summary.background || 0}  accent="purple" />
                </div>

                {blocking.length > 0 && (
                  <div className="bg-red-50 border border-red-200 rounded-2xl p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <AlertTriangle className="text-red-500 flex-shrink-0" size={16} />
                      <span className="font-bold text-red-700 text-sm">{blocking.length} Blocking Session{blocking.length > 1 ? 's' : ''} Detected</span>
                    </div>
                    <div className="space-y-1.5">
                      {blocking.slice(0, 5).map((s, i) => (
                        <div key={i} className="bg-white rounded-lg px-3 py-2 text-xs flex items-center gap-4 border border-red-100">
                          <span className="font-bold text-red-700">SID {s.sid}</span>
                          <span className="text-slate-500">{s.username || '—'}</span>
                          <span className="text-orange-600 font-bold">Blocking SID {s.blocking_session}</span>
                          <span className="text-slate-400 ml-auto">{s.wait_event || '—'} · {s.seconds_in_wait}s</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <Panel title={`Sessions (${sessions.length})`}>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 sticky top-0">
                        <tr>
                          {['SID','Serial#','Username','Status','Type','Machine','Program','Wait Event','Sec Wait','SQL ID'].map(h => (
                            <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sessions.slice(0, 60).map((s, i) => (
                          <tr key={i} className={`border-t border-slate-100 hover:bg-slate-50 ${i % 2 === 1 ? 'bg-slate-50/30' : ''} ${s.blocking_session ? 'bg-red-50/60' : ''}`}>
                            <td className="px-3 py-2 font-mono text-xs text-slate-500">{s.sid}</td>
                            <td className="px-3 py-2 font-mono text-[10px] text-slate-400">{s.serial_number}</td>
                            <td className="px-3 py-2 font-semibold text-red-700 text-xs">{s.username || '—'}</td>
                            <td className="px-3 py-2">
                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                s.status === 'ACTIVE' ? 'bg-green-100 text-green-700'
                                : s.status === 'INACTIVE' ? 'bg-slate-100 text-slate-500'
                                : 'bg-yellow-100 text-yellow-700'}`}>
                                {s.status || '—'}
                              </span>
                            </td>
                            <td className="px-3 py-2">
                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${s.type === 'USER' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>{s.type || '—'}</span>
                            </td>
                            <td className="px-3 py-2 text-[10px] text-slate-400 max-w-[100px] truncate">{s.machine || '—'}</td>
                            <td className="px-3 py-2 text-[10px] text-slate-400 max-w-[100px] truncate">{s.program || '—'}</td>
                            <td className="px-3 py-2 text-[10px] text-orange-600 max-w-[120px] truncate">{s.wait_event || '—'}</td>
                            <td className={`px-3 py-2 font-bold text-xs ${s.seconds_in_wait > 60 ? 'text-red-600' : s.seconds_in_wait > 10 ? 'text-orange-600' : 'text-slate-600'}`}>{s.seconds_in_wait || 0}</td>
                            <td className="px-3 py-2 font-mono text-[10px] text-slate-400">{s.sql_id || '—'}</td>
                          </tr>
                        ))}
                        {sessions.length === 0 && (
                          <tr><td colSpan={10} className="text-center py-10 text-slate-400">No session data</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </Panel>

                {/* Session pies */}
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
                  <Panel title="Sessions by Status">
                    {sessions.length > 0 ? (() => {
                      const grouped = sessions.reduce((acc, s) => { const st = s.status || 'UNKNOWN'; acc[st] = (acc[st] || 0) + 1; return acc; }, {});
                      return (
                        <ResponsiveContainer width="100%" height={220}>
                          <PieChart>
                            <Pie data={Object.entries(grouped).map(([name, value]) => ({ name, value }))}
                              dataKey="value" nameKey="name" innerRadius={50} outerRadius={80}
                              label={({ name, value }) => `${name}: ${value}`}>
                              {Object.keys(grouped).map((_, i) => <Cell key={i} fill={[C.green, C.slate, C.orange, C.red][i % 4]} />)}
                            </Pie>
                            <Tooltip /><Legend />
                          </PieChart>
                        </ResponsiveContainer>
                      );
                    })() : <p className="text-center text-slate-400 text-xs py-12">No data</p>}
                  </Panel>

                  <Panel title="Sessions by Type">
                    {sessions.length > 0 ? (() => {
                      const grouped = sessions.reduce((acc, s) => { const t = s.type || 'UNKNOWN'; acc[t] = (acc[t] || 0) + 1; return acc; }, {});
                      return (
                        <ResponsiveContainer width="100%" height={220}>
                          <PieChart>
                            <Pie data={Object.entries(grouped).map(([name, value]) => ({ name, value }))}
                              dataKey="value" nameKey="name" innerRadius={50} outerRadius={80}
                              label={({ name, value }) => `${name}: ${value}`}>
                              {Object.keys(grouped).map((_, i) => <Cell key={i} fill={[C.blue, C.purple, C.teal][i % 3]} />)}
                            </Pie>
                            <Tooltip /><Legend />
                          </PieChart>
                        </ResponsiveContainer>
                      );
                    })() : <p className="text-center text-slate-400 text-xs py-12">No data</p>}
                  </Panel>
                </div>
              </div>
            );
          })()
        )}

        {/* ══ SQL ═══════════════════════════════════════════════════ */}
        {activeTab === 'sql' && (
          sqlLoading ? <TabLoader /> : (() => {
            const sqlList = sqlData?.sql || [];
            const filtered = sqlList.filter(s =>
              !sqlSearch ||
              (s.sql_id || '').toLowerCase().includes(sqlSearch.toLowerCase()) ||
              (s.sql_text || '').toLowerCase().includes(sqlSearch.toLowerCase()) ||
              (s.parsing_schema_name || '').toLowerCase().includes(sqlSearch.toLowerCase())
            );
            return (
              <div className="space-y-5">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <MetricKpi title="Total SQL" value={sqlList.length} accent="blue" />
                  <MetricKpi title="Avg Elapsed > 1s" value={sqlList.filter(s => s.avg_elapsed_ms > 1000).length} accent={sqlList.filter(s => s.avg_elapsed_ms > 1000).length > 0 ? 'red' : 'green'} />
                  <MetricKpi title="High Disk Reads"  value={sqlList.filter(s => s.disk_reads > 10000).length} accent={sqlList.filter(s => s.disk_reads > 10000).length > 0 ? 'orange' : 'green'} />
                  <MetricKpi title="Showing"          value={filtered.length} accent="slate" />
                </div>

                <Panel title="Top SQL by Elapsed Time">
                  <div className="mb-3 relative">
                    <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input value={sqlSearch} onChange={e => setSqlSearch(e.target.value)}
                      placeholder="Search SQL ID, text, or schema…"
                      className="h-9 w-full pl-8 pr-3 rounded-xl border border-slate-200 text-xs outline-none focus:border-red-400 bg-white" />
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 sticky top-0">
                        <tr>
                          {['SQL ID','Schema','Exec','Elapsed ms','CPU ms','Buf Gets','Disk Reads','Rows','Avg ms','SQL Text'].map(h => (
                            <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.slice(0, 50).map((s, i) => (
                          <React.Fragment key={i}>
                            <tr className={`border-t border-slate-100 hover:bg-slate-50 cursor-pointer ${i % 2 === 1 ? 'bg-slate-50/30' : ''} ${s.avg_elapsed_ms > 1000 ? 'bg-red-50/30' : ''}`}
                              onClick={() => setExpandedSql(expandedSql === i ? null : i)}>
                              <td className="px-3 py-2 font-mono text-[10px] text-red-700">{s.sql_id || '—'}</td>
                              <td className="px-3 py-2 text-[10px] text-slate-500">{s.parsing_schema_name || '—'}</td>
                              <td className="px-3 py-2 font-bold text-slate-800 text-xs">{fmtNum(s.executions)}</td>
                              <td className={`px-3 py-2 font-bold text-xs ${s.elapsed_ms > 5000 ? 'text-red-600' : s.elapsed_ms > 1000 ? 'text-orange-600' : 'text-slate-700'}`}>{fmtNum(s.elapsed_ms)}</td>
                              <td className="px-3 py-2 font-mono text-xs">{fmtNum(s.cpu_ms)}</td>
                              <td className="px-3 py-2 font-mono text-xs">{fmtNum(s.buffer_gets)}</td>
                              <td className={`px-3 py-2 font-mono text-xs ${s.disk_reads > 10000 ? 'text-red-600 font-bold' : ''}`}>{fmtNum(s.disk_reads)}</td>
                              <td className="px-3 py-2 font-mono text-xs">{fmtNum(s.rows_processed)}</td>
                              <td className={`px-3 py-2 font-bold text-xs ${s.avg_elapsed_ms > 1000 ? 'text-red-600' : s.avg_elapsed_ms > 200 ? 'text-orange-600' : 'text-green-600'}`}>{fmtNum(s.avg_elapsed_ms)}</td>
                              <td className="px-3 py-2 font-mono text-[10px] text-slate-500 max-w-[200px] truncate">{(s.sql_text || '').slice(0, 80) || '—'}</td>
                            </tr>
                            {expandedSql === i && (
                              <tr className="border-t border-red-100 bg-slate-900">
                                <td colSpan={10} className="px-4 py-3">
                                  <div className="flex items-center justify-between mb-2">
                                    <span className="text-[10px] font-bold text-slate-400 uppercase">Full SQL — {s.sql_id}</span>
                                    <button onClick={() => navigator.clipboard.writeText(s.sql_fulltext || s.sql_text || '')}
                                      className="flex items-center gap-1 h-6 px-2 rounded bg-slate-700 text-[10px] text-slate-300 hover:bg-slate-600">
                                      <Copy size={9} /> Copy
                                    </button>
                                  </div>
                                  <pre className="font-mono text-[11px] text-green-400 whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
                                    {s.sql_fulltext || s.sql_text || '—'}
                                  </pre>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        ))}
                        {filtered.length === 0 && (
                          <tr><td colSpan={10} className="text-center py-10 text-slate-400">No SQL found</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              </div>
            );
          })()
        )}

        {/* ══ TABLESPACES ═══════════════════════════════════════════ */}
        {activeTab === 'tablespaces' && (
          tsLoading ? <TabLoader /> : (() => {
            const tsList = tsData?.tablespaces || [];
            const critical = tsList.filter(t => t.used_pct > 85);
            const warning  = tsList.filter(t => t.used_pct > 70 && t.used_pct <= 85);
            return (
              <div className="space-y-5">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <MetricKpi title="Total Tablespaces" value={tsList.length}    accent="blue" />
                  <MetricKpi title="Critical >85%"     value={critical.length}  accent={critical.length > 0 ? 'red' : 'green'} />
                  <MetricKpi title="Warning 70-85%"    value={warning.length}   accent={warning.length > 0 ? 'orange' : 'green'} />
                  <MetricKpi title="Max Usage %"        value={`${maxTsPct}%`}   accent={maxTsPct > 85 ? 'red' : maxTsPct > 70 ? 'orange' : 'green'} />
                </div>

                <Panel title="Tablespace Details">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 sticky top-0">
                        <tr>
                          {['Tablespace','Status','Type','Total (MB)','Used (MB)','Free (MB)','Usage %'].map(h => (
                            <th key={h} className="px-4 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {tsList.map((ts, i) => {
                          const pct = Number(ts.used_pct) || 0;
                          return (
                            <tr key={i} className={`border-t border-slate-100 hover:bg-slate-50 ${i % 2 === 1 ? 'bg-slate-50/30' : ''} ${pct > 85 ? 'bg-red-50/50' : pct > 70 ? 'bg-orange-50/50' : ''}`}>
                              <td className="px-4 py-3 font-bold text-red-700">{ts.tablespace_name}</td>
                              <td className="px-4 py-3">
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${ts.status === 'ONLINE' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{ts.status || '—'}</span>
                              </td>
                              <td className="px-4 py-3 text-xs text-slate-500">{ts.contents || '—'}</td>
                              <td className="px-4 py-3 font-mono text-xs">{fmtNum(ts.total_mb)}</td>
                              <td className="px-4 py-3 font-mono text-xs">{fmtNum(ts.used_mb)}</td>
                              <td className="px-4 py-3 font-mono text-xs">{fmtNum(ts.free_mb)}</td>
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-2">
                                  <span className={`font-black text-sm ${pct > 85 ? 'text-red-600' : pct > 70 ? 'text-orange-600' : 'text-green-600'}`}>{pct}%</span>
                                  <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden min-w-[60px]">
                                    <div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct > 85 ? C.red : pct > 70 ? C.orange : C.green }} />
                                  </div>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                        {tsList.length === 0 && <tr><td colSpan={7} className="text-center py-10 text-slate-400">No tablespace data</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </Panel>

                {tsList.length > 0 && (
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
                    <Panel title="Tablespace Size (MB)">
                      <ResponsiveContainer width="100%" height={260}>
                        <BarChart layout="vertical"
                          data={tsList.slice(0, 10).map(t => ({ name: t.tablespace_name, used: Number(t.used_mb) || 0, free: Number(t.free_mb) || 0 }))}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                          <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={v => `${v}MB`} axisLine={false} tickLine={false} />
                          <YAxis width={120} type="category" dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                          <Tooltip formatter={v => `${v} MB`} cursor={{ fill: '#fef2f2' }} />
                          <Bar dataKey="used" fill={C.red}  name="Used" stackId="ts" />
                          <Bar dataKey="free" fill={C.teal} name="Free" stackId="ts" radius={[0, 4, 4, 0]} />
                          <Legend />
                        </BarChart>
                      </ResponsiveContainer>
                    </Panel>
                    <Panel title="Usage Distribution">
                      <ResponsiveContainer width="100%" height={260}>
                        <PieChart>
                          <Pie data={tsList.filter(t => t.used_mb > 0).slice(0, 8).map(t => ({ name: t.tablespace_name, value: Number(t.used_mb) || 0 }))}
                            dataKey="value" nameKey="name" innerRadius={55} outerRadius={95}
                            label={({ name, percent }) => percent > 0.04 ? `${name} ${(percent * 100).toFixed(0)}%` : ''}>
                            {tsList.slice(0, 8).map((_, i) => <Cell key={i} fill={[C.red, C.orange, C.amber, C.blue, C.purple, C.teal, C.green, C.slate][i % 8]} />)}
                          </Pie>
                          <Tooltip formatter={v => `${v} MB`} />
                        </PieChart>
                      </ResponsiveContainer>
                    </Panel>
                  </div>
                )}
              </div>
            );
          })()
        )}

        {/* ══ OBJECTS ═══════════════════════════════════════════════ */}
        {activeTab === 'objects' && (
          objLoading ? <TabLoader /> : (() => {
            const byType   = objData?.by_type    || [];
            const topTables= objData?.top_tables || [];
            const summary  = objData?.summary    || {};
            return (
              <div className="space-y-5">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <MetricKpi title="Total Objects"   value={fmtNum(summary.total_objects)}   accent="blue" />
                  <MetricKpi title="Invalid Objects" value={fmtNum(summary.invalid_objects)} accent={summary.invalid_objects > 0 ? 'red' : 'green'} />
                  <MetricKpi title="Tables"          value={fmtNum(summary.tables)}          accent="orange" />
                  <MetricKpi title="Indexes"         value={fmtNum(summary.indexes)}         accent="purple" />
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
                  <Panel title="Objects by Type">
                    {byType.length > 0 ? (
                      <ResponsiveContainer width="100%" height={280}>
                        <BarChart layout="vertical" data={byType.slice(0, 12)}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                          <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={fmtNum} axisLine={false} tickLine={false} />
                          <YAxis width={120} type="category" dataKey="object_type" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                          <Tooltip formatter={v => fmtNum(v)} cursor={{ fill: '#fef2f2' }} />
                          <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                            {byType.slice(0, 12).map((_, i) => <Cell key={i} fill={POOL_COLORS[i % POOL_COLORS.length]} />)}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    ) : <p className="text-center text-slate-400 text-xs py-12">No object data</p>}
                  </Panel>

                  <Panel title="Object Summary">
                    <div className="grid grid-cols-2 gap-3">
                      {[
                        ['Tables',     summary.tables,     C.red],
                        ['Indexes',    summary.indexes,    C.orange],
                        ['Views',      summary.views,      C.amber],
                        ['Procedures', summary.procedures, C.blue],
                        ['Functions',  summary.functions,  C.purple],
                        ['Packages',   summary.packages,   C.teal],
                        ['Triggers',   summary.triggers,   C.green],
                        ['Sequences',  summary.sequences,  C.cyan],
                        ['Synonyms',   summary.synonyms,   C.slate],
                        ['Invalid',    summary.invalid_objects, C.red],
                      ].map(([label, val, color]) => (
                        <div key={label} className="bg-slate-50 rounded-xl border border-slate-100 p-3 flex items-center justify-between">
                          <div>
                            <p className="text-[10px] text-slate-400 font-semibold uppercase">{label}</p>
                            <p className="text-xl font-black text-slate-800 mt-0.5">{fmtNum(val || 0)}</p>
                          </div>
                          <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: color }} />
                        </div>
                      ))}
                    </div>
                  </Panel>
                </div>

                {topTables.length > 0 && (
                  <Panel title="Top 20 Tables by Size (MB)">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50">
                          <tr>{['Owner','Table Name','Size (MB)','Size Bar'].map(h => (
                            <th key={h} className="px-4 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase">{h}</th>
                          ))}</tr>
                        </thead>
                        <tbody>
                          {topTables.map((t, i) => {
                            const maxMb = Math.max(...topTables.map(x => x.size_mb), 1);
                            return (
                              <tr key={i} className={`border-t border-slate-100 hover:bg-slate-50 ${i % 2 === 1 ? 'bg-slate-50/30' : ''}`}>
                                <td className="px-4 py-3 text-xs font-semibold text-slate-600">{t.owner}</td>
                                <td className="px-4 py-3 font-bold text-red-700">{t.table_name}</td>
                                <td className="px-4 py-3 font-mono font-bold text-sm">{fmtNum(t.size_mb)} MB</td>
                                <td className="px-4 py-3">
                                  <div className="h-2 bg-slate-100 rounded-full overflow-hidden w-32">
                                    <div className="h-full bg-red-500 rounded-full" style={{ width: `${Math.min(100, (t.size_mb / maxMb) * 100)}%` }} />
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </Panel>
                )}
              </div>
            );
          })()
        )}

        {/* ══ DATA GUARD ════════════════════════════════════════════ */}
        {activeTab === 'dataguard' && (
          dgLoading ? <TabLoader /> : (() => {
            const configured  = dgData?.configured || false;
            const dgStatus    = dgData?.dg_status  || [];
            const archDests   = dgData?.archive_dests || [];
            const standbyLogs = dgData?.standby_logs  || [];
            return (
              <div className="space-y-5">
                {!configured && (
                  <div className="bg-slate-50 border border-slate-200 rounded-2xl p-8 text-center">
                    <ShieldCheck size={48} className="mx-auto mb-4 text-slate-200" />
                    <p className="font-bold text-slate-500 text-lg">Data Guard Not Configured</p>
                    <p className="text-sm text-slate-400 mt-2">No standby databases or Data Guard services detected for this instance.</p>
                  </div>
                )}

                {archDests.length > 0 && (
                  <Panel title="Archive Destination Status">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50">
                          <tr>{['Dest ID','Name','Status','Target','Destination','DB Unique Name','Sync Status'].map(h => (
                            <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                          ))}</tr>
                        </thead>
                        <tbody>
                          {archDests.map((d, i) => (
                            <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                              <td className="px-3 py-2.5 font-mono text-xs">{d.dest_id}</td>
                              <td className="px-3 py-2.5 text-xs font-semibold text-red-700">{d.dest_name || '—'}</td>
                              <td className="px-3 py-2.5">
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${d.status === 'VALID' ? 'bg-green-100 text-green-700' : d.status === 'ERROR' ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-500'}`}>{d.status || '—'}</span>
                              </td>
                              <td className="px-3 py-2.5 text-xs text-slate-500">{d.target || '—'}</td>
                              <td className="px-3 py-2.5 text-xs text-slate-400 max-w-[150px] truncate">{d.destination || '—'}</td>
                              <td className="px-3 py-2.5 text-xs font-mono text-slate-600">{d.db_unique_name || '—'}</td>
                              <td className="px-3 py-2.5">
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${d.synchronization_status === 'OK' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}`}>{d.synchronization_status || '—'}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Panel>
                )}

                {standbyLogs.length > 0 && (
                  <Panel title="Standby Redo Logs">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50">
                          <tr>{['Group#','Thread#','Sequence#','Size (MB)','Status'].map(h => (
                            <th key={h} className="px-4 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase">{h}</th>
                          ))}</tr>
                        </thead>
                        <tbody>
                          {standbyLogs.map((sl, i) => (
                            <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                              <td className="px-4 py-3 font-mono text-xs">{sl.group}</td>
                              <td className="px-4 py-3 font-mono text-xs">{sl.thread}</td>
                              <td className="px-4 py-3 font-mono text-xs">{fmtNum(sl.sequence)}</td>
                              <td className="px-4 py-3 font-mono text-xs">{sl.size_mb} MB</td>
                              <td className="px-4 py-3">
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${sl.status === 'ACTIVE' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>{sl.status || '—'}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Panel>
                )}

                {dgStatus.length > 0 && (
                  <Panel title={`Data Guard Status Messages (${dgStatus.length})`}>
                    <div className="overflow-x-auto max-h-96">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 sticky top-0">
                          <tr>{['Timestamp','Severity','Dest ID','Message'].map(h => (
                            <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                          ))}</tr>
                        </thead>
                        <tbody>
                          {dgStatus.map((s, i) => (
                            <tr key={i} className={`border-t border-slate-100 hover:bg-slate-50 ${i % 2 === 1 ? 'bg-slate-50/30' : ''}`}>
                              <td className="px-3 py-2.5 text-[10px] text-slate-400 whitespace-nowrap">{s.timestamp}</td>
                              <td className="px-3 py-2.5">
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${s.severity === 'ERROR' ? 'bg-red-100 text-red-700' : s.severity === 'WARNING' ? 'bg-orange-100 text-orange-700' : 'bg-blue-100 text-blue-700'}`}>{s.severity || '—'}</span>
                              </td>
                              <td className="px-3 py-2.5 font-mono text-xs">{s.dest_id}</td>
                              <td className="px-3 py-2.5 text-xs text-slate-600 max-w-[400px] truncate">{s.message || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Panel>
                )}
              </div>
            );
          })()
        )}

        {/* ══ REDO LOGS ═════════════════════════════════════════════ */}
        {activeTab === 'redologs' && (
          redoLoading ? <TabLoader /> : (() => {
            const logGroups = redoData?.log_groups || [];
            const logfiles  = redoData?.logfiles   || [];
            const logMode   = redoData?.log_mode   || hs.log_mode || '';
            return (
              <div className="space-y-5">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <MetricKpi title="Log Groups"    value={logGroups.length}  accent="blue" />
                  <MetricKpi title="Current Group" value={redoData?.current_group || '—'} accent="red" />
                  <MetricKpi title="Log Mode"      value={logMode || '—'}   accent={logMode === 'ARCHIVELOG' ? 'green' : 'orange'} />
                  <MetricKpi title="Total Members" value={logfiles.length}  accent="slate" />
                </div>

                {logMode !== 'ARCHIVELOG' && (
                  <div className="bg-orange-50 border border-orange-200 rounded-2xl p-4 flex items-start gap-3">
                    <AlertTriangle className="text-orange-500 flex-shrink-0 mt-0.5" size={18} />
                    <div>
                      <p className="font-bold text-orange-700 text-sm">NOARCHIVELOG Mode</p>
                      <p className="text-xs text-orange-600 mt-1">Running in NOARCHIVELOG mode. PITR and online backups may not be possible.</p>
                    </div>
                  </div>
                )}

                <Panel title="Redo Log Groups">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50">
                        <tr>{['Group#','Thread#','Sequence#','Members','Size (MB)','Status','Archived','First Change#','First Time'].map(h => (
                          <th key={h} className="px-4 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                        ))}</tr>
                      </thead>
                      <tbody>
                        {logGroups.map((lg, i) => (
                          <tr key={i} className={`border-t border-slate-100 hover:bg-slate-50 ${lg.status === 'CURRENT' ? 'bg-red-50' : i % 2 === 1 ? 'bg-slate-50/30' : ''}`}>
                            <td className="px-4 py-3 font-mono font-bold text-sm">
                              {lg.group}
                              {lg.status === 'CURRENT' && <span className="ml-2 px-1.5 py-0.5 bg-red-100 text-red-700 text-[9px] font-black rounded">CURRENT</span>}
                            </td>
                            <td className="px-4 py-3 font-mono text-xs">{lg.thread}</td>
                            <td className="px-4 py-3 font-mono text-xs">{fmtNum(lg.sequence)}</td>
                            <td className="px-4 py-3 font-mono text-xs">{lg.members}</td>
                            <td className="px-4 py-3 font-mono text-xs">{lg.size_mb} MB</td>
                            <td className="px-4 py-3">
                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${lg.status === 'CURRENT' ? 'bg-red-100 text-red-700' : lg.status === 'ACTIVE' ? 'bg-orange-100 text-orange-700' : 'bg-slate-100 text-slate-500'}`}>{lg.status || '—'}</span>
                            </td>
                            <td className="px-4 py-3">
                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${lg.archived === 'YES' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}`}>{lg.archived || '—'}</span>
                            </td>
                            <td className="px-4 py-3 font-mono text-[10px] text-slate-400">{fmtNum(lg.first_change)}</td>
                            <td className="px-4 py-3 text-[10px] text-slate-400">{lg.first_time || '—'}</td>
                          </tr>
                        ))}
                        {logGroups.length === 0 && <tr><td colSpan={9} className="text-center py-10 text-slate-400">No redo log data</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </Panel>

                {logfiles.length > 0 && (
                  <Panel title="Log File Members">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50">
                          <tr>{['Group#','Member Path','Type','Status'].map(h => (
                            <th key={h} className="px-4 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase">{h}</th>
                          ))}</tr>
                        </thead>
                        <tbody>
                          {logfiles.map((lf, i) => (
                            <tr key={i} className={`border-t border-slate-100 hover:bg-slate-50 ${i % 2 === 1 ? 'bg-slate-50/30' : ''}`}>
                              <td className="px-4 py-3 font-mono text-xs">{lf.group}</td>
                              <td className="px-4 py-3 font-mono text-xs text-slate-600">{lf.member}</td>
                              <td className="px-4 py-3 text-xs text-slate-500">{lf.type || '—'}</td>
                              <td className="px-4 py-3">
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${!lf.file_status || lf.file_status === '' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}`}>{lf.file_status || 'OK'}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Panel>
                )}

                <Panel title="Best Practices">
                  <div className="space-y-3">
                    {[
                      { ok: logMode === 'ARCHIVELOG', title: 'ARCHIVELOG Mode', msg: logMode === 'ARCHIVELOG' ? 'Database is in ARCHIVELOG mode — online backups and PITR supported.' : 'Enable ARCHIVELOG mode: ALTER DATABASE ARCHIVELOG;' },
                      { ok: logGroups.length >= 3,    title: 'Min 3 Redo Groups', msg: logGroups.length >= 3 ? `${logGroups.length} groups configured — meets Oracle best practice.` : `Only ${logGroups.length} group(s). Oracle recommends at least 3 redo log groups.` },
                      { ok: Math.min(...logGroups.map(g => g.size_mb || 0), 999) >= 50, title: 'Redo Log Size >= 50 MB', msg: 'Consider increasing redo log size to 50-200 MB to reduce log switch frequency.' },
                    ].map(({ ok, title, msg }) => (
                      <div key={title} className={`rounded-xl border p-3 ${ok ? 'bg-green-50 border-green-200' : 'bg-orange-50 border-orange-200'}`}>
                        <div className="flex items-center gap-2 mb-1">
                          {ok ? <CheckCircle2 size={14} className="text-green-600" /> : <AlertTriangle size={14} className="text-orange-600" />}
                          <span className="text-xs font-bold text-slate-700">{title}</span>
                        </div>
                        <p className="text-xs text-slate-600">{msg}</p>
                      </div>
                    ))}
                  </div>
                </Panel>
              </div>
            );
          })()
        )}

        {/* ══ PROCESSES ═════════════════════════════════════════════ */}
        {activeTab === 'processes' && (
          procLoading ? <TabLoader /> : (() => {
            const procs = procData?.processes || [];
            return (
              <div className="space-y-5">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <MetricKpi title="BG Processes"  value={procs.length}            accent="blue" />
                  <MetricKpi title="Total PGA (MB)" value={fmtNum(procData?.total_pga_mb)} accent="purple" />
                  <MetricKpi title="Avg PGA (MB)"   value={procs.length > 0 ? fmtNum(((procData?.total_pga_mb || 0) / procs.length).toFixed(2)) : '—'} accent="slate" />
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 gap-3">
                  {procs.map((p, i) => (
                    <div key={i} className="bg-white rounded-2xl border border-slate-200 p-4 hover:shadow-md transition-all">
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-black text-slate-900 text-sm">{p.pname || '—'}</span>
                        <span className="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-bold">BG</span>
                      </div>
                      <p className="text-[10px] text-slate-400 mb-2 leading-tight truncate">{p.description || '—'}</p>
                      <div className="space-y-1">
                        <div className="flex justify-between text-[10px]">
                          <span className="text-slate-400">PGA Used</span>
                          <span className="font-bold text-slate-700">{fmtNum(p.pga_used_mb)} MB</span>
                        </div>
                        <div className="flex justify-between text-[10px]">
                          <span className="text-slate-400">PGA Alloc</span>
                          <span className="font-bold text-slate-700">{fmtNum(p.pga_alloc_mb)} MB</span>
                        </div>
                        <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden mt-1">
                          <div className="h-full bg-purple-500 rounded-full"
                            style={{ width: `${Math.min(100, p.pga_alloc_mb > 0 ? (p.pga_used_mb / p.pga_alloc_mb) * 100 : 0)}%` }} />
                        </div>
                        <p className="text-[9px] text-slate-300 mt-1">PID {p.pid} · SPID {p.spid}</p>
                      </div>
                    </div>
                  ))}
                  {procs.length === 0 && (
                    <div className="col-span-6 text-center py-16 text-slate-400">No background process data</div>
                  )}
                </div>

                {procs.length > 0 && (
                  <Panel title="PGA Allocation by Process (Top 15)">
                    <ResponsiveContainer width="100%" height={240}>
                      <BarChart data={procs.slice(0, 15).map(p => ({ name: p.pname, pga: p.pga_alloc_mb }))}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                        <XAxis dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 9 }} tickFormatter={v => `${v}MB`} axisLine={false} tickLine={false} />
                        <Tooltip formatter={v => `${v} MB`} cursor={{ fill: '#fef2f2' }} />
                        <Bar dataKey="pga" radius={[4, 4, 0, 0]} name="PGA Alloc (MB)">
                          {procs.slice(0, 15).map((_, i) => <Cell key={i} fill={POOL_COLORS[i % POOL_COLORS.length]} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </Panel>
                )}
              </div>
            );
          })()
        )}

        {/* ══ USERS ═════════════════════════════════════════════════ */}
        {activeTab === 'users' && (
          userLoading ? <TabLoader /> : (() => {
            const users = userData?.users || [];
            const filtered = users.filter(u =>
              !userSearch ||
              u.username.toLowerCase().includes(userSearch.toLowerCase()) ||
              (u.profile || '').toLowerCase().includes(userSearch.toLowerCase()) ||
              (u.default_tablespace || '').toLowerCase().includes(userSearch.toLowerCase())
            );
            return (
              <div className="space-y-5">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <MetricKpi title="Total Users"  value={userData?.total || 0}   accent="blue" />
                  <MetricKpi title="Open"         value={userData?.open || 0}    accent="green" />
                  <MetricKpi title="Locked"       value={userData?.locked || 0}  accent={userData?.locked > 0 ? 'red' : 'green'} />
                  <MetricKpi title="Expired"      value={userData?.expired || 0} accent={userData?.expired > 0 ? 'orange' : 'green'} />
                </div>

                <Panel title={`Users (${users.length})`}>
                  <div className="mb-3 relative">
                    <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input value={userSearch} onChange={e => setUserSearch(e.target.value)}
                      placeholder="Search username, profile, tablespace…"
                      className="h-9 w-full pl-8 pr-3 rounded-xl border border-slate-200 text-xs outline-none focus:border-red-400 bg-white" />
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 sticky top-0">
                        <tr>
                          {['Username','Status','Created','Profile','Default Tablespace','Last Login'].map(h => (
                            <th key={h} className="px-4 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((u, i) => {
                          const statusColor = u.account_status === 'OPEN' ? 'bg-green-100 text-green-700'
                            : u.account_status.includes('LOCKED') ? 'bg-red-100 text-red-700'
                            : 'bg-yellow-100 text-yellow-700';
                          return (
                            <tr key={i} className={`border-t border-slate-100 hover:bg-slate-50 ${i % 2 === 1 ? 'bg-slate-50/30' : ''}`}>
                              <td className="px-4 py-3 font-bold text-red-700">{u.username}</td>
                              <td className="px-4 py-3">
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${statusColor}`}>{u.account_status || '—'}</span>
                              </td>
                              <td className="px-4 py-3 text-xs text-slate-400">{u.created || '—'}</td>
                              <td className="px-4 py-3 text-xs text-slate-500">{u.profile || '—'}</td>
                              <td className="px-4 py-3 text-xs text-slate-500">{u.default_tablespace || '—'}</td>
                              <td className="px-4 py-3 text-xs text-slate-400">{u.last_login || '—'}</td>
                            </tr>
                          );
                        })}
                        {filtered.length === 0 && <tr><td colSpan={6} className="text-center py-10 text-slate-400">No users found</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </Panel>

                {users.length > 0 && (
                  <Panel title="Account Status Distribution">
                    <ResponsiveContainer width="100%" height={220}>
                      <PieChart>
                        <Pie
                          data={(() => {
                            const grouped = users.reduce((acc, u) => { const s = u.account_status || 'UNKNOWN'; acc[s] = (acc[s] || 0) + 1; return acc; }, {});
                            return Object.entries(grouped).map(([name, value]) => ({ name, value }));
                          })()}
                          dataKey="value" nameKey="name" innerRadius={50} outerRadius={85}
                          label={({ name, value }) => `${name}: ${value}`}>
                          {users.slice(0, 10).map((_, i) => <Cell key={i} fill={[C.green, C.red, C.orange, C.amber, C.slate, C.blue][i % 6]} />)}
                        </Pie>
                        <Tooltip /><Legend />
                      </PieChart>
                    </ResponsiveContainer>
                  </Panel>
                )}
              </div>
            );
          })()
        )}

        {/* ══ SYSTEM STATS ══════════════════════════════════════════ */}
        {activeTab === 'systemstats' && (
          sysStatLoading ? <TabLoader /> : (() => {
            const allStats = sysStatData?.stats || [];
            const keyStats = sysStatData?.key_stats || {};
            const byClass  = sysStatData?.by_class  || {};
            const filtered = allStats.filter(s =>
              !statSearch || s.name.toLowerCase().includes(statSearch.toLowerCase())
            );
            return (
              <div className="space-y-5">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <MetricKpi title="Total Stats"     value={allStats.length}                         accent="blue" />
                  <MetricKpi title="Physical Reads"  value={fmtNum(keyStats['physical reads'])}       accent="orange" />
                  <MetricKpi title="User Commits"    value={fmtNum(keyStats['user commits'])}         accent="green" />
                  <MetricKpi title="Execute Count"   value={fmtNum(keyStats['execute count'])}        accent="purple" />
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {[
                    ['Physical Reads',       keyStats['physical reads'],         'orange'],
                    ['Logical Reads',        keyStats['db block gets'],           'blue'],
                    ['Redo Size',            keyStats['redo size'],              'amber'],
                    ['User Commits',         keyStats['user commits'],            'green'],
                    ['User Rollbacks',       keyStats['user rollbacks'],          'red'],
                    ['Parse Count (Total)',  keyStats['parse count (total)'],     'slate'],
                    ['Parse Count (Hard)',   keyStats['parse count (hard)'],      'red'],
                    ['Sorts (Memory)',       keyStats['sorts (memory)'],          'teal'],
                    ['Sorts (Disk)',         keyStats['sorts (disk)'],            'orange'],
                    ['Table Scans (Long)',   keyStats['table scans (long tables)'], 'red'],
                    ['Enqueue Deadlocks',    keyStats['enqueue deadlocks'],       'red'],
                    ['Logons Cumulative',    keyStats['logons cumulative'],       'blue'],
                  ].map(([label, val, accent]) => (
                    <KpiCard key={label} icon={BarChart2} title={label} value={fmtNum(val)} accent={accent} />
                  ))}
                </div>

                <Panel title="All System Statistics">
                  <div className="mb-3 relative">
                    <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input value={statSearch} onChange={e => setStatSearch(e.target.value)}
                      placeholder="Search stat name…"
                      className="h-9 w-full pl-8 pr-3 rounded-xl border border-slate-200 text-xs outline-none focus:border-red-400 bg-white" />
                  </div>
                  <div className="overflow-x-auto max-h-96">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 sticky top-0">
                        <tr>
                          {['Stat Name','Value','Class'].map(h => (
                            <th key={h} className="px-4 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.slice(0, 200).map((s, i) => (
                          <tr key={i} className={`border-t border-slate-100 hover:bg-slate-50 ${i % 2 === 1 ? 'bg-slate-50/30' : ''}`}>
                            <td className="px-4 py-2.5 text-xs text-slate-700">{s.name}</td>
                            <td className="px-4 py-2.5 font-mono font-bold text-xs text-slate-800">{fmtNum(s.value)}</td>
                            <td className="px-4 py-2.5 text-[10px] text-slate-400">{s.class}</td>
                          </tr>
                        ))}
                        {filtered.length === 0 && <tr><td colSpan={3} className="text-center py-8 text-slate-400">No stats found</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              </div>
            );
          })()
        )}

        {/* ══ SLOW QUERIES ══════════════════════════════════════════ */}
        {activeTab === 'slowqueries' && (
          slowLoading ? <TabLoader /> : (() => {
            const queries = slowData?.queries || [];
            return (
              <div className="space-y-5">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <MetricKpi title="Total Queries"     value={queries.length}                                     accent="blue" />
                  <MetricKpi title="Avg Elapsed > 1s"  value={queries.filter(q => q.avg_elapsed_sec > 1).length}  accent={queries.filter(q => q.avg_elapsed_sec > 1).length > 0 ? 'red' : 'green'} />
                  <MetricKpi title="Avg Elapsed > 5s"  value={queries.filter(q => q.avg_elapsed_sec > 5).length}  accent={queries.filter(q => q.avg_elapsed_sec > 5).length > 0 ? 'red' : 'green'} />
                  <MetricKpi title="Total Executions"  value={fmtNum(queries.reduce((a, q) => a + (q.executions || 0), 0))} accent="slate" />
                </div>

                {slowData?.error && (
                  <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700 flex items-center gap-2">
                    <AlertTriangle size={16} /> {slowData.error}
                  </div>
                )}

                <Panel title={`Top Slow SQL (${queries.length}) — from v$sqlarea, ordered by avg elapsed time`}>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 sticky top-0">
                        <tr>
                          {['SQL ID','Schema','Executions','Avg Elapsed (s)','Avg CPU (s)','Avg Disk Reads','Avg Buf Gets','Rows','Last Active','SQL Text'].map(h => (
                            <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {queries.map((q, i) => (
                          <tr key={i} className={`border-t border-slate-100 hover:bg-slate-50 ${i % 2 === 1 ? 'bg-slate-50/30' : ''} ${q.avg_elapsed_sec > 5 ? 'bg-red-50/40' : q.avg_elapsed_sec > 1 ? 'bg-orange-50/30' : ''}`}>
                            <td className="px-3 py-2.5 font-mono text-[10px] text-red-700">{q.sql_id}</td>
                            <td className="px-3 py-2.5 text-[10px] text-slate-500">{q.parsing_schema_name || '—'}</td>
                            <td className="px-3 py-2.5 font-bold text-slate-800 text-xs">{fmtNum(q.executions)}</td>
                            <td className={`px-3 py-2.5 font-bold text-xs ${q.avg_elapsed_sec > 5 ? 'text-red-600' : q.avg_elapsed_sec > 1 ? 'text-orange-600' : 'text-green-600'}`}>{q.avg_elapsed_sec}</td>
                            <td className="px-3 py-2.5 font-mono text-xs">{q.avg_cpu_sec}</td>
                            <td className="px-3 py-2.5 font-mono text-xs">{fmtNum(q.avg_disk_reads)}</td>
                            <td className="px-3 py-2.5 font-mono text-xs">{fmtNum(q.avg_buffer_gets)}</td>
                            <td className="px-3 py-2.5 font-mono text-xs">{fmtNum(q.rows_processed)}</td>
                            <td className="px-3 py-2.5 text-[10px] text-slate-400 whitespace-nowrap">{_shortDate(q.last_active_time)}</td>
                            <td className="px-3 py-2.5 font-mono text-[10px] text-slate-500 max-w-[220px] truncate">{(q.sql_text || '').slice(0, 80) || '—'}</td>
                          </tr>
                        ))}
                        {queries.length === 0 && (
                          <tr><td colSpan={10} className="text-center py-10 text-slate-400">No slow query data</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              </div>
            );
          })()
        )}

      </div>
    </div>
  );
}

/* ─── helpers ─── */
function computeHealthScore(sessionPct, bufHitPct, maxTsPct, waitCount) {
  let score = 100;
  if (sessionPct > 90)   score -= 30; else if (sessionPct > 70) score -= 15;
  if (bufHitPct < 70)    score -= 25; else if (bufHitPct < 85)  score -= 10;
  if (maxTsPct > 90)     score -= 20; else if (maxTsPct > 80)   score -= 10;
  if (waitCount > 15)    score -= 5;
  return Math.max(0, score);
}

function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  const b = Number(bytes);
  if (b > 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
  if (b > 1048576)    return `${(b / 1048576).toFixed(2)} MB`;
  if (b > 1024)       return `${(b / 1024).toFixed(2)} KB`;
  return `${b} B`;
}

function _shortDate(val) {
  if (!val) return '—';
  const s = String(val);
  return s.length > 19 ? s.slice(0, 19) : s;
}

/* ─── components ─── */
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
    red:    'border-l-red-500',    orange: 'border-l-orange-500', amber:  'border-l-amber-500',
    green:  'border-l-green-500',  blue:   'border-l-blue-500',   purple: 'border-l-purple-500',
    teal:   'border-l-teal-500',   slate:  'border-l-slate-400',  cyan:   'border-l-cyan-500',
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
    amber:  'bg-amber-50 border-amber-200 text-amber-700',
    blue:   'bg-blue-50 border-blue-200 text-blue-700',
    purple: 'bg-purple-50 border-purple-200 text-purple-700',
    teal:   'bg-teal-50 border-teal-200 text-teal-700',
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
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold ${ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
      {ok ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />}
      {label}
    </span>
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

function TabLoader() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="w-8 h-8 border-4 border-red-200 border-t-red-600 rounded-full animate-spin" />
    </div>
  );
}

function GaugeCard({ title, pct, sub, centerLabel, centerUnit = '%', colorFn }) {
  const safePct       = Math.max(0, Math.min(100, pct || 0));
  const fill          = colorFn ? colorFn(safePct) : (safePct > 80 ? C.red : safePct > 60 ? C.orange : C.green);
  const displayCenter = centerLabel !== undefined ? centerLabel : safePct;
  const displayUnit   = centerLabel !== undefined ? centerUnit : '%';
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4 flex flex-col items-center">
      <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1 text-center">{title}</p>
      <div className="relative flex flex-col items-center">
        <PieChart width={150} height={90}>
          <Pie data={[{ v: safePct }, { v: 100 - safePct }]}
            cx={75} cy={86} startAngle={180} endAngle={0}
            innerRadius={50} outerRadius={68} dataKey="v" stroke="none">
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
  const gradId = `tg-oracle-${title.replace(/\s+/g, '')}`;
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
        <span className="text-slate-400">{data.length} samples · {REFRESH_INTERVAL}s interval</span>
      </div>
    </div>
  );
}
