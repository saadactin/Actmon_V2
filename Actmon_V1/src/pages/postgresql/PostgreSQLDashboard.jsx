import React, { useState, useEffect, useRef } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Database, Server, Activity, HardDrive, RefreshCw, Clock,
  Layers, Network, AlertTriangle, Cpu,
  FileText, Zap, GitBranch, RotateCcw,
  CheckCircle2, XCircle, ChevronRight, ChevronDown, ChevronUp, Heart, Users, Lock,
  TrendingUp, Table, Search, ArrowUp, ArrowDown, Shield,
  Circle, Wifi, WifiOff, AlertCircle, Info, Radio, Copy, CheckCheck,
  ArrowRight, Crown, Signal, SignalHigh, SignalLow, SignalZero, Settings,
  BarChart3, X, ExternalLink, Pencil,
} from 'lucide-react';
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  AreaChart, Area,
} from 'recharts';
import client from '../../api/client';
import HostResources from './PgHostResources';

/* ─── palette ─── */
const C = {
  pg:     '#336791',
  indigo: '#6366F1',
  green:  '#22C55E',
  red:    '#EF4444',
  cyan:   '#06B6D4',
  orange: '#F97316',
  yellow: '#EAB308',
  purple: '#8B5CF6',
  blue:   '#3B82F6',
  slate:  '#64748B',
  teal:   '#14B8A6',
};

const fetchDashboard = (id) =>
  client.get(`/connections/postgresql/${id}/monitoring-dashboard`).then(r => r.data);

const TABS = [
  { id: 'overview',    label: 'Overview',    icon: Activity },
  { id: 'performance', label: 'Performance', icon: TrendingUp },
  { id: 'queries',     label: 'Queries',     icon: Zap },
  { id: 'databases',   label: 'Databases',   icon: Database },
  { id: 'tables',      label: 'Tables',      icon: Table },
  { id: 'locks',       label: 'Locks',       icon: Lock },
  { id: 'replication', label: 'Replication', icon: GitBranch },
  { id: 'users',       label: 'Users',       icon: Users },
  { id: 'storage',     label: 'Storage',     icon: HardDrive },
  { id: 'config',      label: 'Config',      icon: Settings },
];

const REFRESH_INTERVAL = 15;

export default function PostgreSQLDashboard() {
  const { id, tab } = useParams();
  const navigate = useNavigate();
  // Tab is URL-driven: /postgresql-dashboard/:id/:tab → every tab has its own route.
  const activeTab = tab || 'overview';
  const setActiveTab = (t) =>
    navigate(`/postgresql-dashboard/${id}${t && t !== 'overview' ? `/${t}` : ''}`);
  const [countdown, setCountdown]         = useState(REFRESH_INTERVAL);
  const [sparklines, setSparklines]       = useState({ conn: [], cache: [], tps: [] });
  const [querySearch, setQuerySearch]     = useState('');
  const [expandedQuery, setExpandedQuery] = useState(null);
  const countRef = useRef(null);

  const { data, isLoading, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['pgDashboard', id],
    queryFn:  () => fetchDashboard(id),
    retry: false,
    refetchInterval: REFRESH_INTERVAL * 1000,
  });

  const { data: replDetail, isLoading: replLoading, refetch: refetchRepl } = useQuery({
    queryKey: ['pgReplDetail', id],
    queryFn:  () => client.get(`/connections/postgresql/${id}/replication-detail`).then(r => r.data),
    enabled:  activeTab === 'replication',
    refetchInterval: activeTab === 'replication' ? 8000 : false,
  });

  const { data: queriesDetail, isLoading: queriesLoading, refetch: refetchQueries } = useQuery({
    queryKey: ['pgQueriesDetail', id],
    queryFn:  () => client.get(`/connections/postgresql/${id}/queries-detail`).then(r => r.data),
    enabled:  activeTab === 'queries',
    refetchInterval: activeTab === 'queries' ? 8000 : false,
  });

  const [tablesDb, setTablesDb] = useState('__all__');   // selected DB to drill into Tables
  const { data: tablesDetail, isLoading: tablesLoading, refetch: refetchTables } = useQuery({
    queryKey: ['pgTablesDetail', id],
    queryFn:  () => client.get(`/connections/postgresql/${id}/tables-detail`).then(r => r.data),
    enabled:  activeTab === 'tables' || activeTab === 'databases',
    refetchInterval: (activeTab === 'tables' || activeTab === 'databases') ? 15000 : false,
  });

  const { data: configDetail, isLoading: configLoading, refetch: refetchConfig } = useQuery({
    queryKey: ['pgConfigDetail', id],
    queryFn:  () => client.get(`/connections/postgresql/${id}/config-detail`).then(r => r.data),
    enabled:  activeTab === 'config',
    staleTime: 60000,
  });

  const { data: usersDetail, isLoading: usersLoading, refetch: refetchUsers } = useQuery({
    queryKey: ['pgUsersDetail', id],
    queryFn:  () => client.get(`/connections/postgresql/${id}/users-detail`).then(r => r.data),
    enabled:  activeTab === 'users',
    refetchInterval: activeTab === 'users' ? 15000 : false,
  });

  const { data: storageDetail, isLoading: storageLoading, refetch: refetchStorage } = useQuery({
    queryKey: ['pgStorageDetail', id],
    queryFn:  () => client.get(`/connections/postgresql/${id}/storage-detail`).then(r => r.data),
    enabled:  activeTab === 'storage',
    staleTime: 30000,
  });

  useEffect(() => {
    setCountdown(REFRESH_INTERVAL);
    if (countRef.current) clearInterval(countRef.current);
    countRef.current = setInterval(() => {
      setCountdown(c => (c <= 1 ? REFRESH_INTERVAL : c - 1));
    }, 1000);
    return () => clearInterval(countRef.current);
  }, [dataUpdatedAt]);

  useEffect(() => {
    if (!data) return;
    const connPct  = Number(data?.health_summary?.connection_usage_pct) || 0;
    const cachePct = Number(data?.health_summary?.cache_hit_ratio)      || 0;
    const tps      = (Number(data?.query_stats?.xact_commit) + Number(data?.query_stats?.xact_rollback)) || 0;
    const t        = new Date().toLocaleTimeString();
    setSparklines(prev => ({
      conn:  [...prev.conn.slice(-20),  { t, v: connPct  }],
      cache: [...prev.cache.slice(-20), { t, v: cachePct }],
      tps:   [...prev.tps.slice(-20),   { t, v: tps      }],
    }));
  }, [data]);

  /* ─── loading ─── */
  if (isLoading) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'linear-gradient(135deg,#0f172a 0%,#1e3a5f 50%,#312e81 100%)' }}>
      <div className="text-center">
        <div className="w-16 h-16 border-4 border-indigo-400/30 border-t-indigo-400 rounded-full animate-spin mx-auto mb-5" />
        <p className="text-indigo-200 font-bold text-lg">Connecting to PostgreSQL…</p>
        <p className="text-indigo-400 text-sm mt-1">Fetching live metrics</p>
      </div>
    </div>
  );

  /* ─── error ─── */
  if (error || data?.status === 'error') return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-8">
      <div className="bg-white border border-red-200 rounded-2xl p-8 max-w-lg w-full shadow-lg">
        <div className="w-12 h-12 bg-red-100 rounded-2xl flex items-center justify-center mb-4">
          <AlertTriangle className="text-red-500" size={24} />
        </div>
        <h2 className="font-black text-slate-900 text-xl mb-2">Connection Failed</h2>
        <p className="text-slate-500 text-sm mb-6">{data?.error || error?.message}</p>
        <button onClick={() => refetch()}
          className="h-10 px-6 bg-indigo-600 text-white rounded-xl text-sm font-bold hover:bg-indigo-700 transition-colors">
          Retry Connection
        </button>
      </div>
    </div>
  );

  /* ─── data ─── */
  const {
    connection = {}, health_summary = {}, databases = [], query_stats = {},
    bgwriter = {}, checkpoints = {}, shared_buffers = {},
    connections_detail = {}, replication = [], replication_slots = [],
    process_list = [], long_running_queries = [],
    pg_stat_statements = [], pg_stat_user_tables = [],
    pg_locks = [], blocking_queries = [],
    tablespaces = [], users_activity = [],
    server_vars = {},
  } = data || {};

  const connPct     = Number(health_summary.connection_usage_pct) || 0;
  const cachePct    = Number(health_summary.cache_hit_ratio)      || 0;
  const activeSess  = Number(health_summary.active_connections)   || 0;
  const totalConns  = Number(health_summary.total_connections)    || 0;
  const maxConns    = Number(health_summary.max_connections)      || 1;
  const rollbacks   = Number(query_stats.xact_rollback)           || 0;
  const commits     = Number(query_stats.xact_commit)             || 0;
  const rollbackPct = commits + rollbacks > 0
    ? Math.min(100, +((rollbacks / (commits + rollbacks)) * 100).toFixed(2)) : 0;
  const healthScore = computeHealthScore(health_summary, long_running_queries, connPct, cachePct);

  const alerts = {
    queries:     long_running_queries.length,
    locks:       blocking_queries.length,
    replication: replication.filter(r => r.state && r.state !== 'streaming' && r.state !== 'catchup').length,
  };

  const DB_COLORS = [C.pg, C.indigo, C.green, C.orange, C.purple, C.cyan, C.yellow, C.red];

  return (
    <div className="min-h-screen bg-[#f1f5f9] flex flex-col">

      {/* ════════ HEADER ════════ */}
      <div style={{ background: 'linear-gradient(135deg,#0f172a 0%,#1e3a5f 55%,#312e81 100%)' }} className="text-white shadow-2xl">

        {/* top row */}
        <div className="px-6 pt-5 pb-3 flex flex-wrap justify-between items-center gap-4">

          {/* left: icon + title */}
          <div className="flex items-center gap-4">
            <div className="w-13 h-13 rounded-2xl flex items-center justify-center text-2xl shadow-lg"
              style={{ background: 'rgba(99,102,241,0.25)', border: '1px solid rgba(99,102,241,0.4)' }}>
              🐘
            </div>
            <div>
              <h1 className="text-[22px] font-black tracking-tight leading-tight">PostgreSQL Dashboard</h1>
              <p className="text-[13px] mt-0.5" style={{ color: 'rgba(165,180,252,0.85)' }}>
                {connection?.name || 'PostgreSQL'}&nbsp;&mdash;&nbsp;
                {connection?.host}:{connection?.port || 5432}
                {connection?.database ? ` / ${connection.database}` : ''}
              </p>
            </div>
          </div>

          {/* right: controls */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* health */}
            <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-black shadow ${
              healthScore >= 80 ? 'bg-emerald-500' : healthScore >= 60 ? 'bg-yellow-400 text-slate-900' : 'bg-red-500'}`}>
              <Heart size={12} className="animate-pulse" />
              Health {healthScore}
            </div>

            {/* nav links */}
            {[
              { to: `/postgresql-dashboard/${id}/slow-queries`,   label: 'Slow Queries' },
              { to: `/postgresql-dashboard/${id}/error-logs`,     label: 'Error Logs' },
              { to: `/postgresql-dashboard/${id}/index-analysis`, label: 'Indexes' },
              { to: `/postgresql-dashboard/${id}/backup`,         label: '🛡 Backup & PITR' },
              { to: `/postgresql-dashboard/${id}/reports`,        label: '📊 Reports' },
            ].map(({ to, label }) => (
              <Link key={to} to={to}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.75)' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.16)'; e.currentTarget.style.color = '#fff'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = 'rgba(255,255,255,0.75)'; }}>
                {label}
              </Link>
            ))}

            {/* refresh */}
            <button onClick={() => refetch()}
              className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-semibold transition-all"
              style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)' }}>
              <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} />
              <span>Refresh</span>
              <span className="w-5 h-5 rounded-full text-[10px] font-black flex items-center justify-center"
                style={{ background: 'rgba(99,102,241,0.5)', color: '#c7d2fe' }}>
                {countdown}
              </span>
            </button>
          </div>
        </div>

        {/* ── TAB BAR ── */}
        <div className="px-2 flex overflow-x-auto" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          {TABS.map(tab => {
            const Icon  = tab.icon;
            const alert = alerts[tab.id] || 0;
            const active = activeTab === tab.id;
            return (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className="relative flex items-center gap-2 px-4 py-3 text-xs font-semibold whitespace-nowrap transition-all flex-shrink-0"
                style={active ? {
                  background: '#f1f5f9',
                  color: '#4338ca',
                  borderRadius: '10px 10px 0 0',
                  marginBottom: '-1px',
                  boxShadow: '0 -2px 8px rgba(0,0,0,0.15)',
                } : {
                  color: 'rgba(255,255,255,0.55)',
                }}>
                <Icon size={13} />
                {tab.label}
                {alert > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-red-500 text-white text-[9px] font-black rounded-full flex items-center justify-center shadow">
                    {alert}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ════════ TAB CONTENT ════════ */}
      <div className="flex-1 p-5 overflow-auto">

        {/* ══ OVERVIEW ══ */}
        {activeTab === 'overview' && (
          <div className="space-y-4">

            {/* KPI strip */}
            <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3">
              {[
                { icon: Clock,     title: 'Uptime',       value: health_summary.uptime,  accent: '#6366F1', tab: 'performance', hint: 'Performance' },
                { icon: Server,    title: 'Version',      value: (health_summary.version||'').split(' ')[1]||health_summary.version, accent: '#3B82F6', tab: 'config', hint: 'Server config' },
                { icon: Database,  title: 'Databases',    value: health_summary.total_databases, accent: '#336791', tab: 'databases', hint: 'List databases' },
                { icon: Layers,    title: 'Tables',       value: fmtNum(health_summary.total_tables), accent: '#22C55E', tab: 'tables', hint: 'All tables' },
                { icon: HardDrive, title: 'DB Size',      value: health_summary.total_size || `${health_summary.total_size_mb||0} MB`, accent: '#F97316', tab: 'storage', hint: 'Storage breakdown' },
                { icon: Activity,  title: 'Commits',      value: fmtNum(commits), accent: '#8B5CF6', tab: 'queries', hint: 'Query activity' },
                { icon: Network,   title: 'Connections',  value: `${totalConns}/${maxConns}`, accent: connPct > 80 ? '#EF4444' : '#22C55E', tab: 'users', hint: 'Sessions & users' },
                { icon: RotateCcw, title: 'Rollbacks',    value: fmtNum(rollbacks), accent: rollbacks > 0 ? '#EF4444' : '#64748B', tab: 'queries', hint: 'Query activity' },
              ].map(({ icon: Icon, title, value, accent, tab, hint }) => (
                <button key={title} type="button" onClick={() => { if (tab === 'databases') setTablesDb('__all__'); setActiveTab(tab); }}
                  className="group text-left bg-white rounded-xl border border-slate-200 p-4 hover:shadow-md hover:border-slate-300 hover:-translate-y-0.5 transition-all cursor-pointer"
                  style={{ borderLeft: `3px solid ${accent}` }} title={`Open ${hint}`}>
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{title}</p>
                      <p className="text-[15px] font-black text-slate-800 mt-1 truncate">{value ?? 'N/A'}</p>
                    </div>
                    <Icon size={18} style={{ color: accent, opacity: 0.4 }} className="mt-0.5 flex-shrink-0" />
                  </div>
                  <p className="text-[9px] text-slate-300 group-hover:text-indigo-500 font-bold uppercase tracking-wide mt-2 flex items-center gap-0.5 transition-colors">
                    {hint} <ChevronRight size={10} />
                  </p>
                </button>
              ))}
            </div>

            {/* status badges */}
            <div className="flex flex-wrap gap-2">
              <SBadge ok={connPct < 80}   label={`Connections ${connPct}%`} onClick={()=>setActiveTab('users')} />
              <SBadge ok={cachePct > 90}  label={`Cache Hit ${cachePct}%`} onClick={()=>{ setTablesDb('__all__'); setActiveTab('tables'); }} />
              <SBadge ok={rollbackPct < 5} label={`Rollback Rate ${rollbackPct}%`} onClick={()=>setActiveTab('queries')} />
              <SBadge ok={replication.length === 0 || replication.every(r => !r.state || r.state === 'streaming' || r.state === 'catchup')}
                label={`Replication: ${replication.length === 0 ? 'STANDALONE' : `${replication.length} replica(s)`}`}
                onClick={()=>setActiveTab('replication')} />
              {long_running_queries.length > 0 && (
                <SBadge ok={false} label={`${long_running_queries.length} long-running quer${long_running_queries.length===1?'y':'ies'}`} onClick={()=>setActiveTab('queries')} />
              )}
              {blocking_queries.length > 0 && (
                <SBadge ok={false} label={`${blocking_queries.length} blocking lock(s)`} onClick={()=>setActiveTab('locks')} />
              )}
              {health_summary.autovacuum_enabled === false && (
                <SBadge ok={false} label="Autovacuum DISABLED" onClick={()=>{ setTablesDb('__all__'); setActiveTab('tables'); }} />
              )}
            </div>

            {/* Host resources — click a gauge to drill: processes → queries → why */}
            <HostResources connId={id} tech="postgresql" />

            {/* gauges */}
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
              <GaugeCard title="Connection Pool"  pct={connPct}
                sub={`${totalConns} / ${maxConns} max`}
                drillHint="Sessions & users" onClick={()=>setActiveTab('users')}
                colorFn={v => v>80 ? C.red : v>60 ? C.orange : C.pg} />
              <GaugeCard title="Buffer Cache Hit" pct={cachePct}
                sub="Shared buffers efficiency"
                drillHint="Tables & cache" onClick={()=>{ setTablesDb('__all__'); setActiveTab('tables'); }}
                colorFn={v => v<70 ? C.red : v<85 ? C.orange : C.green} />
              <GaugeCard title="Active Sessions"
                pct={Math.min(100,Math.round((activeSess/Math.max(maxConns,1))*100))}
                centerLabel={activeSess} centerUnit=" active"
                sub={`${totalConns} total · ${maxConns} max`}
                drillHint="Live sessions" onClick={()=>setActiveTab('locks')}
                colorFn={v => v>50 ? C.orange : C.indigo} />
              <GaugeCard title="Rollback Rate"
                pct={Math.min(100,rollbackPct*10)}
                centerLabel={`${rollbackPct}`} centerUnit="%"
                sub={`${fmtNum(rollbacks)} rollbacks / ${fmtNum(commits+rollbacks)} total`}
                drillHint="Query activity" onClick={()=>setActiveTab('queries')}
                colorFn={v => v>30 ? C.red : v>5 ? C.orange : C.green} />
            </div>

            {/* sparklines */}
            {sparklines.conn.length > 2 ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <TrendCard title="Connection Usage %" data={sparklines.conn}  color={C.pg}     unit="%" />
                <TrendCard title="Buffer Cache Hit %" data={sparklines.cache} color={C.green}  unit="%" />
                <TrendCard title="Transactions/sample" data={sparklines.tps}  color={C.indigo} fmtVal={fmtNum} />
              </div>
            ) : (
              <div className="bg-white rounded-2xl border border-slate-200 p-5 text-center text-slate-400 text-xs">
                <Activity size={20} className="mx-auto mb-2 text-slate-300" />
                Live trend charts appear after first 15-second auto-refresh
              </div>
            )}

            {/* charts */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <ChartCard title="Query Operations (cumulative)">
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={[
                    { name:'SELECT', v: query_stats.total_seq_scan   || 0 },
                    { name:'INSERT', v: query_stats.n_tup_ins         || 0 },
                    { name:'UPDATE', v: query_stats.n_tup_upd         || 0 },
                    { name:'DELETE', v: query_stats.n_tup_del         || 0 },
                    { name:'COMMIT', v: query_stats.xact_commit       || 0 },
                    { name:'ROLLBK', v: query_stats.xact_rollback     || 0 },
                  ]} barCategoryGap="25%">
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize:10, fontWeight:600 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize:9 }} tickFormatter={fmtNum} axisLine={false} tickLine={false} />
                    <Tooltip formatter={v => fmtNum(v)} cursor={{ fill:'#f8fafc' }} />
                    <Bar dataKey="v" radius={[5,5,0,0]}>
                      {[C.pg,C.green,C.orange,C.red,C.indigo,C.purple].map((fill,i)=><Cell key={i} fill={fill}/>)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                <div className="grid grid-cols-2 gap-x-4 mt-2 pt-2 border-t border-slate-100">
                  <Row label="Seq scans"  value={fmtNum(query_stats.total_seq_scan)} />
                  <Row label="Idx scans"  value={fmtNum(query_stats.total_idx_scan)} />
                  <Row label="Temp files" value={fmtNum(query_stats.temp_files)}     />
                  <Row label="Temp bytes" value={fmtBytes(query_stats.temp_bytes)}   />
                </div>
              </ChartCard>

              <ChartCard title="Database Size Distribution — click a bar to open its tables">
                {databases.filter(d=>!['template0','template1'].includes(d.name)).length>0 ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart layout="vertical"
                      data={databases.filter(d=>!['template0','template1'].includes(d.name)).slice(0,8)}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize:9 }} tickFormatter={v=>`${v}MB`} axisLine={false} tickLine={false} />
                      <YAxis width={110} type="category" dataKey="name" tick={{ fontSize:10 }} axisLine={false} tickLine={false} />
                      <Tooltip formatter={v=>`${v} MB`} cursor={{ fill:'#f8fafc' }} />
                      <Bar dataKey="size_mb" radius={[0,5,5,0]} cursor="pointer"
                        onClick={(d)=>{ if(d&&d.name){ setTablesDb(d.name); setActiveTab('tables'); } }}>
                        {databases.slice(0,8).map((_,i)=><Cell key={i} fill={DB_COLORS[i%DB_COLORS.length]}/>)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex items-center justify-center h-[200px] text-slate-300 text-xs">No user databases found</div>
                )}
                <div className="grid grid-cols-2 gap-x-4 mt-2 pt-2 border-t border-slate-100">
                  <Row label="Total databases" value={health_summary.total_databases} />
                  <Row label="Total tables"    value={fmtNum(health_summary.total_tables)} />
                  <Row label="Total size"      value={health_summary.total_size || `${health_summary.total_size_mb||0} MB`} />
                  <Row label="WAL level"       value={server_vars.wal_level || '—'} />
                </div>
              </ChartCard>
            </div>

            {/* detail panels */}
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
              <Panel title="Server Information" icon={<Server size={15} className="text-slate-400" />}>
                <Row label="Hostname"      value={health_summary.host_name || server_vars.hostname || '—'} mono />
                <Row label="Version"       value={health_summary.version   || '—'} mono />
                <Row label="Uptime"        value={health_summary.uptime    || '—'} />
                <Row label="Last Restart"  value={health_summary.last_restart || health_summary.pg_postmaster_start_time || '—'} />
                <Row label="WAL Level"     value={server_vars.wal_level    || '—'} />
                <Row label="Replication"   value={replication.length>0 ? `${replication.length} replica(s)` : 'STANDALONE'} />
                <Row label="Max Conns"     value={maxConns} />
                <Row label="Data Dir"      value={server_vars.data_directory || '—'} mono />
              </Panel>

              <Panel title="Shared Buffers & Cache" icon={<HardDrive size={15} className="text-slate-400" />}>
                <div className="mb-4">
                  <div className="flex justify-between text-xs mb-1.5">
                    <span className="text-slate-500">Buffer Cache Hit Rate</span>
                    <span className="font-black text-slate-800">{cachePct}%</span>
                  </div>
                  <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-700"
                      style={{ width:`${cachePct}%`, background: cachePct>=90?C.green:cachePct>=70?C.orange:C.red }} />
                  </div>
                </div>
                <Row label="Shared Buffers"  value={server_vars.shared_buffers || shared_buffers.size || '—'} />
                <Row label="Blocks Read"     value={fmtNum(shared_buffers.blks_read   || query_stats.blks_read)} />
                <Row label="Blocks Hit"      value={fmtNum(shared_buffers.blks_hit    || query_stats.blks_hit)} />
                <Row label="Effective Cache" value={server_vars.effective_cache_size  || '—'} />
                <Row label="Work Mem"        value={server_vars.work_mem              || '—'} />
                <Row label="Maintenance WM"  value={server_vars.maintenance_work_mem  || '—'} />
                <Row label="Checkpoints"     value={fmtNum((checkpoints.checkpoints_timed||0)+(checkpoints.checkpoints_req||0))} />
              </Panel>

              <Panel title="Connections & Activity" icon={<Network size={15} className="text-slate-400" />}>
                <div className="mb-4">
                  <div className="flex justify-between text-xs mb-1.5">
                    <span className="text-slate-500">Connection Usage</span>
                    <span className="font-black text-slate-800">{connPct}%</span>
                  </div>
                  <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-700"
                      style={{ width:`${connPct}%`, background:connPct>80?C.red:connPct>60?C.orange:C.pg }} />
                  </div>
                </div>
                <Row label="Active"      value={activeSess} />
                <Row label="Idle"        value={connections_detail.idle                || 0} />
                <Row label="Idle in Txn" value={connections_detail.idle_in_transaction || 0} />
                <Row label="Waiting"     value={connections_detail.waiting             || 0} />
                <Row label="Total"       value={totalConns} />
                <Row label="Max Conns"   value={maxConns} />
                <Row label="Autovacuum"  value={health_summary.autovacuum_enabled !== false ? 'ON' : 'OFF'} />
              </Panel>
            </div>

            {/* long-running alert */}
            {long_running_queries.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-2xl p-4">
                <div className="flex items-center gap-2 mb-3">
                  <AlertTriangle className="text-red-500 flex-shrink-0" size={16} />
                  <span className="font-bold text-red-700 text-sm">
                    {long_running_queries.length} Long-Running {long_running_queries.length===1?'Query':'Queries'} Detected
                  </span>
                  <button onClick={()=>setActiveTab('queries')}
                    className="ml-auto text-xs text-red-600 hover:text-red-800 underline font-semibold">
                    View All →
                  </button>
                </div>
                <div className="space-y-2">
                  {long_running_queries.slice(0,3).map((q,i)=>(
                    <div key={i} className="bg-white rounded-xl border border-red-100 px-3 py-2 text-xs">
                      <span className="font-bold text-red-600">PID {q.pid}</span>
                      <span className="ml-2 text-slate-500">{q.usename}@{q.client_addr||'local'}</span>
                      <span className="ml-2 font-black text-orange-600">{q.duration}</span>
                      <div className="mt-1 font-mono text-slate-500 truncate">{String(q.query||'').slice(0,130)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* action cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { icon:<Zap className="text-yellow-500" size={22}/>,    title:'Slow Queries',   desc:'Identify expensive SQL',       action:()=>navigate(`/postgresql-dashboard/${id}/slow-queries`) },
                { icon:<FileText className="text-red-500" size={22}/>,  title:'Error Logs',     desc:'View & classify errors',       action:()=>navigate(`/postgresql-dashboard/${id}/error-logs`) },
                { icon:<Layers className="text-violet-500" size={22}/>, title:'Index Analysis', desc:'Unused, bloated & missing',    action:()=>navigate(`/postgresql-dashboard/${id}/index-analysis`) },
                { icon:<RotateCcw className="text-teal-500" size={22}/>,title:'Vacuum Status',  desc:'Dead tuples & autovacuum',     action:()=>setActiveTab('tables') },
                { icon:<BarChart3 className="text-blue-600" size={22}/>, title:'Reports',        desc:'Generate & email DB reports',  action:()=>navigate(`/postgresql-dashboard/${id}/reports`) },
              ].map(({ icon, title, desc, action }) => (
                <button key={title} onClick={action}
                  className="bg-white rounded-2xl border border-slate-200 p-5 text-left hover:shadow-md hover:border-slate-300 transition-all group">
                  <div className="mb-3">{icon}</div>
                  <p className="font-bold text-slate-900 text-sm">{title}</p>
                  <p className="text-xs text-slate-400 mt-1">{desc}</p>
                  <ChevronRight size={14} className="text-slate-200 group-hover:text-slate-500 mt-3 transition-colors" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ══ PERFORMANCE ══ */}
        {activeTab === 'performance' && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                ['Cache Hit',          `${cachePct}%`,                          cachePct<90?'red':'green', 'bg-green-50 border-green-200 text-green-700'],
                ['Checkpoints (timed)', fmtNum(checkpoints.checkpoints_timed), 'blue',   'bg-blue-50 border-blue-200 text-blue-700'],
                ['Checkpoints (req)',   fmtNum(checkpoints.checkpoints_req),   (checkpoints.checkpoints_req>10?'orange':'green'), (checkpoints.checkpoints_req>10?'bg-orange-50 border-orange-200 text-orange-700':'bg-green-50 border-green-200 text-green-700')],
                ['BGWriter Buffers',    fmtNum(bgwriter.buffers_clean),        'purple',  'bg-purple-50 border-purple-200 text-purple-700'],
              ].map(([t,v,,cls])=>(
                <div key={t} className={`rounded-xl border p-4 ${cls}`}>
                  <p className="text-[10px] font-bold uppercase tracking-wide opacity-70">{t}</p>
                  <p className="text-2xl font-black mt-1">{v}</p>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
              <Panel title="BGWriter Statistics" icon={<Cpu size={15} className="text-slate-400"/>}>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    ['Buffers Clean',      fmtNum(bgwriter.buffers_clean),      'Buffers written by bgwriter'],
                    ['Maxwritten Clean',   fmtNum(bgwriter.maxwritten_clean),   'Bgwriter stop events'],
                    ['Buffers Backend',    fmtNum(bgwriter.buffers_backend),    'Backends writing directly'],
                    ['Buffers Alloc',      fmtNum(bgwriter.buffers_alloc),      'Buffers allocated'],
                    ['Buffers Checkpoint', fmtNum(bgwriter.buffers_checkpoint), 'Written at checkpoint'],
                    ['Stats Reset',        bgwriter.stats_reset?bgwriter.stats_reset.slice(0,16):'—', 'Last statistics reset'],
                  ].map(([label,value,desc])=>(
                    <div key={label} className="bg-slate-50 rounded-xl p-3 border border-slate-100">
                      <p className="text-[10px] text-slate-400 font-semibold uppercase mb-1">{label}</p>
                      <p className="text-lg font-black text-slate-800">{value}</p>
                      <p className="text-[10px] text-slate-400 mt-1">{desc}</p>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel title="Checkpoint Statistics" icon={<Activity size={15} className="text-slate-400"/>}>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    ['Timed',           fmtNum(checkpoints.checkpoints_timed),   'Scheduled checkpoints'],
                    ['Requested',       fmtNum(checkpoints.checkpoints_req),     'Forced checkpoints'],
                    ['Write Time',      `${checkpoints.checkpoint_write_time||0}ms`, 'Dirty buffer write time'],
                    ['Sync Time',       `${checkpoints.checkpoint_sync_time||0}ms`,  'Disk sync time'],
                    ['Buffers Written', fmtNum(checkpoints.buffers_checkpoint),  'At checkpoint'],
                    ['Completion Tgt',  server_vars.checkpoint_completion_target||'—', 'Target ratio'],
                  ].map(([label,value,desc])=>(
                    <div key={label} className="bg-slate-50 rounded-xl p-3 border border-slate-100">
                      <p className="text-[10px] text-slate-400 font-semibold uppercase mb-1">{label}</p>
                      <p className="text-lg font-black text-slate-800">{value}</p>
                      <p className="text-[10px] text-slate-400 mt-1">{desc}</p>
                    </div>
                  ))}
                </div>
              </Panel>
            </div>

            <Panel title="I/O & Transaction Performance">
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={[
                  { name:'Blks Read',    v: Number(query_stats.blks_read)    ||0 },
                  { name:'Blks Hit',     v: Number(query_stats.blks_hit)     ||0 },
                  { name:'Tup Fetched',  v: Number(query_stats.tup_fetched)  ||0 },
                  { name:'Tup Inserted', v: Number(query_stats.tup_inserted) ||0 },
                  { name:'Tup Updated',  v: Number(query_stats.tup_updated)  ||0 },
                  { name:'Tup Deleted',  v: Number(query_stats.tup_deleted)  ||0 },
                ]}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize:10 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize:10 }} tickFormatter={fmtNum} axisLine={false} tickLine={false} />
                  <Tooltip formatter={v=>fmtNum(v)} />
                  <Bar dataKey="v" radius={[6,6,0,0]}>
                    {[C.pg,C.green,C.indigo,C.orange,C.yellow,C.red].map((fill,i)=><Cell key={i} fill={fill}/>)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Panel>
          </div>
        )}

        {/* ══ QUERIES ══ */}
        {activeTab === 'queries' && (
          <AdvancedQueriesTab detail={queriesDetail} isLoading={queriesLoading} refetch={refetchQueries} connId={id} />
        )}

        {/* ══ DATABASES ══ */}
        {activeTab === 'databases' && (() => {
          // per-database table count + table-size roll-up from tablesDetail
          const tblList = tablesDetail?.tables || [];
          const byDb = {};
          tblList.forEach(t => {
            const k = t.database || '';
            (byDb[k] = byDb[k] || { count: 0, mb: 0 });
            byDb[k].count += 1;
            byDb[k].mb += Number(t.total_bytes || 0) / 1048576;
          });
          const openDbTables = (name) => { setTablesDb(name); setActiveTab('tables'); };
          return (
          <Panel title={`Databases (${databases.length}) — click a database to see its tables`} icon={<Database size={15} className="text-slate-400"/>}>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50">
                    {['Database','Owner','Tables','Table Data','Connections','Size','Commits','Rollbacks',''].map(h=>(
                      <th key={h} className="px-4 py-3 text-left text-xs font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {databases.map((db,i)=>{
                    const agg = byDb[db.name] || { count: 0, mb: 0 };
                    return (
                    <tr key={i} onClick={()=>openDbTables(db.name)} className="border-t border-slate-100 hover:bg-indigo-50/50 cursor-pointer transition-colors">
                      <td className="px-4 py-4 font-bold text-indigo-700">{db.name} <ChevronRight size={13} className="inline text-slate-300"/></td>
                      <td className="px-4 py-4 text-xs text-slate-500">{db.owner||'—'}</td>
                      <td className="px-4 py-4 font-mono text-sm font-bold">{agg.count || '—'}</td>
                      <td className="px-4 py-4 font-mono text-xs text-slate-500">{agg.mb ? `${agg.mb.toFixed(1)} MB` : '—'}</td>
                      <td className="px-4 py-4 font-mono text-sm">{db.numbackends??'—'}</td>
                      <td className="px-4 py-4">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm">{db.size_mb?`${db.size_mb} MB`:db.size||'—'}</span>
                          {db.size_mb && (
                            <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden max-w-[60px]">
                              <div className="h-full bg-indigo-500 rounded-full"
                                style={{ width:`${Math.min(100,(db.size_mb/Math.max(...databases.map(d=>d.size_mb||0),1))*100)}%` }}/>
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-4 font-mono text-sm text-green-700 font-bold">{fmtNum(db.xact_commit)}</td>
                      <td className="px-4 py-4 font-mono text-sm text-red-600 font-bold">{fmtNum(db.xact_rollback)}</td>
                      <td className="px-4 py-4">
                        <button onClick={(e)=>{e.stopPropagation(); openDbTables(db.name);}}
                          className="px-3 h-8 bg-indigo-600 text-white text-xs font-bold rounded-xl hover:bg-indigo-700 transition-colors whitespace-nowrap">
                          View Tables →
                        </button>
                      </td>
                    </tr>
                  );})}
                  {databases.length===0 && (
                    <tr><td colSpan={9} className="text-center py-14 text-slate-400">No databases found</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
          );
        })()}

        {/* ══ TABLES ══ */}
        {activeTab === 'tables' && (
          <AdvancedTablesTab detail={tablesDetail} isLoading={tablesLoading} refetch={refetchTables} connId={id} initialDb={tablesDb} />
        )}

        {/* ══ LOCKS ══ */}
        {activeTab === 'locks' && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                ['Total Locks',      pg_locks.length,                              'bg-blue-50 border-blue-200 text-blue-700'],
                ['Blocking Queries', blocking_queries.length,                      blocking_queries.length>0?'bg-red-50 border-red-200 text-red-700':'bg-green-50 border-green-200 text-green-700'],
                ['Waiting Conns',    connections_detail.waiting||0,                (connections_detail.waiting||0)>0?'bg-orange-50 border-orange-200 text-orange-700':'bg-green-50 border-green-200 text-green-700'],
                ['Idle in Txn',      connections_detail.idle_in_transaction||0,    (connections_detail.idle_in_transaction||0)>0?'bg-orange-50 border-orange-200 text-orange-700':'bg-green-50 border-green-200 text-green-700'],
              ].map(([t,v,cls])=>(
                <div key={t} className={`rounded-xl border p-4 ${cls}`}>
                  <p className="text-[10px] font-bold uppercase tracking-wide opacity-70">{t}</p>
                  <p className="text-2xl font-black mt-1">{v}</p>
                </div>
              ))}
            </div>

            {blocking_queries.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-2xl p-5">
                <div className="flex items-center gap-2 text-red-700 font-bold mb-3 text-sm">
                  <AlertTriangle size={18}/> {blocking_queries.length} Blocking {blocking_queries.length===1?'Query':'Queries'}
                </div>
                {blocking_queries.map((q,i)=>(
                  <div key={i} className="bg-white rounded-xl border border-red-100 px-4 py-3 mb-2 text-xs">
                    <div className="flex gap-4 mb-1">
                      <span className="font-bold text-red-600">Blocker PID: {q.blocking_pid}</span>
                      <span className="text-slate-500">Blocked PID: {q.blocked_pid}</span>
                      <span className="text-orange-600 font-bold">Mode: {q.lock_mode}</span>
                    </div>
                    <div className="font-mono text-slate-500 truncate">{String(q.blocking_query||q.query||'').slice(0,160)}</div>
                  </div>
                ))}
              </div>
            )}

            <Panel title={`pg_locks (${pg_locks.length})`} icon={<Lock size={15} className="text-slate-400"/>}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50">
                      {['PID','Lock Type','Relation','Mode','Granted','Database','Duration'].map(h=>(
                        <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pg_locks.slice(0,50).map((l,i)=>(
                      <tr key={i} className={`border-t border-slate-100 hover:bg-slate-50 ${!l.granted?'bg-red-50':''}`}>
                        <td className="px-3 py-2.5 font-mono text-xs text-slate-500">{l.pid}</td>
                        <td className="px-3 py-2.5 text-xs">{l.locktype}</td>
                        <td className="px-3 py-2.5 text-xs text-indigo-700 font-semibold">{l.relation_name||l.relation||'—'}</td>
                        <td className="px-3 py-2.5">
                          <span className="px-2 py-0.5 bg-slate-100 text-slate-600 text-[10px] font-bold rounded-full">{l.mode}</span>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${l.granted?'bg-green-100 text-green-700':'bg-red-100 text-red-700'}`}>
                            {l.granted?'Granted':'Waiting'}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-xs text-slate-400">{l.database_name||l.database||'—'}</td>
                        <td className="px-3 py-2.5 text-xs font-mono">{l.duration||'—'}</td>
                      </tr>
                    ))}
                    {pg_locks.length===0 && (
                      <tr><td colSpan={7} className="text-center py-14">
                        <CheckCircle2 className="mx-auto text-green-400 mb-3" size={36}/>
                        <p className="text-slate-500 font-semibold">No locks detected</p>
                        <p className="text-slate-400 text-xs mt-1">All connections are operating normally</p>
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>
        )}

        {/* ══ REPLICATION ══ */}
        {activeTab === 'replication' && (
          <AdvancedReplicationTab
            replDetail={replDetail}
            replLoading={replLoading}
            refetchRepl={refetchRepl}
            replication={replication}
            replication_slots={replication_slots}
            health_summary={health_summary}
          />
        )}

        {/* ══ USERS ══ */}
        {activeTab === 'users' && (
          <AdvancedUsersTab detail={usersDetail} isLoading={usersLoading} refetch={refetchUsers} />
        )}

        {/* ══ STORAGE ══ */}
        {activeTab === 'storage' && (
          <AdvancedStorageTab detail={storageDetail} isLoading={storageLoading} refetch={refetchStorage} />
        )}

        {/* ══ CONFIG ══ */}
        {activeTab === 'config' && (
          <AdvancedConfigTab detail={configDetail} isLoading={configLoading} refetch={refetchConfig} />
        )}

      </div>
    </div>
  );
}

/* ─── helpers ─── */
function computeHealthScore(hs, longRunning, connPct, cachePct) {
  let score = 100;
  if (connPct > 90)       score -= 30;
  else if (connPct > 70)  score -= 15;
  if (cachePct < 80)      score -= 20;
  else if (cachePct < 90) score -= 10;
  if ((longRunning||[]).length > 5) score -= 15;
  else if ((longRunning||[]).length > 0) score -= 5;
  return Math.max(0, score);
}
function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  const b = Number(bytes);
  if (b > 1073741824) return `${(b/1073741824).toFixed(2)} GB`;
  if (b > 1048576)    return `${(b/1048576).toFixed(2)} MB`;
  if (b > 1024)       return `${(b/1024).toFixed(2)} KB`;
  return `${b} B`;
}
function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v/1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v/1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v/1e3).toFixed(1)}K`;
  return String(v);
}
function fmtMs(ms) {
  const v = Number(ms) || 0;
  if (v >= 60000) return `${(v/60000).toFixed(1)}m`;
  if (v >= 1000)  return `${(v/1000).toFixed(2)}s`;
  return `${v.toFixed(1)}ms`;
}

/* ─── shared components ─── */
function Panel({ title, icon, children }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      {title && (
        <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
          {icon}
          <h3 className="font-bold text-slate-800 text-sm">{title}</h3>
        </div>
      )}
      <div className="p-5">{children}</div>
    </div>
  );
}

function ChartCard({ title, children }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100">
        <h3 className="font-bold text-slate-800 text-sm">{title}</h3>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function Row({ label, value, mono }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 border-b border-slate-100 last:border-0">
      <span className="text-slate-400 text-xs flex-shrink-0">{label}</span>
      <span className={`text-right font-semibold text-slate-800 text-xs ${mono?'font-mono':''} break-all`}>{value??'—'}</span>
    </div>
  );
}

function SBadge({ ok, label, onClick }) {
  const clickable = typeof onClick === 'function';
  return (
    <span onClick={onClick} role={clickable ? 'button' : undefined}
      className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border transition-all ${
      ok ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'} ${
      clickable ? 'cursor-pointer hover:shadow-sm hover:brightness-95' : ''}`}>
      {ok ? <CheckCircle2 size={11}/> : <AlertTriangle size={11}/>}
      {label}
      {clickable && <ChevronRight size={11} className="opacity-60" />}
    </span>
  );
}

/* SVG semi-circle gauge */
function GaugeCard({ title, pct, sub, centerLabel, centerUnit='%', colorFn, onClick, drillHint }) {
  const safePct = Math.max(0, Math.min(100, pct || 0));
  const fill    = colorFn ? colorFn(safePct) : (safePct > 80 ? C.red : safePct > 60 ? C.orange : C.pg);
  const display = centerLabel !== undefined ? centerLabel : safePct;
  const unit    = centerLabel !== undefined ? centerUnit : '%';
  const R = 52, cx = 75, cy = 80;
  const angle = (safePct / 100) * Math.PI;
  const ex    = cx - R * Math.cos(angle);
  const ey    = cy - R * Math.sin(angle);
  const large = safePct > 50 ? 1 : 0;
  const trackD = `M ${cx-R} ${cy} A ${R} ${R} 0 0 1 ${cx+R} ${cy}`;
  const fillD  = safePct < 1 ? '' : `M ${cx-R} ${cy} A ${R} ${R} 0 ${large} 1 ${ex} ${ey}`;
  const clickable = typeof onClick === 'function';
  return (
    <div onClick={onClick} role={clickable ? 'button' : undefined}
      className={`group bg-white rounded-2xl border border-slate-200 p-4 flex flex-col items-center transition-all ${clickable ? 'cursor-pointer hover:shadow-md hover:border-slate-300 hover:-translate-y-0.5' : ''}`}
      title={clickable ? `Open ${drillHint || title}` : undefined}>
      <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1 text-center">{title}</p>
      <svg width="150" height="88" viewBox="0 0 150 88">
        <path d={trackD} fill="none" stroke="#e2e8f0" strokeWidth="13" strokeLinecap="round"/>
        {fillD && <path d={fillD} fill="none" stroke={fill} strokeWidth="13" strokeLinecap="round"/>}
        <text x="75" y="74" textAnchor="middle" style={{ fontWeight:900, fontSize:20, fill:'#1e293b' }}>{display}</text>
        <text x="75" y="85" textAnchor="middle" style={{ fontSize:10, fill:'#94a3b8' }}>{unit}</text>
      </svg>
      <p className="text-[10px] text-slate-400 mt-1 text-center leading-tight">{sub}</p>
      {clickable && (
        <p className="text-[9px] text-slate-300 group-hover:text-indigo-500 font-bold uppercase tracking-wide mt-1.5 flex items-center gap-0.5 transition-colors">
          {drillHint || 'Details'} <ChevronRight size={10} />
        </p>
      )}
    </div>
  );
}

function TrendCard({ title, data, color, unit='', fmtVal }) {
  const fmt    = fmtVal || (v=>`${v}${unit}`);
  const latest = data[data.length-1]?.v;
  const gradId = `tg-${title.replace(/\s+/g,'')}`;
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="flex justify-between items-center mb-3">
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">{title}</p>
        <span className="text-base font-black" style={{ color }}>{fmt(latest)}</span>
      </div>
      <ResponsiveContainer width="100%" height={68}>
        <AreaChart data={data}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={color} stopOpacity={0.2}/>
              <stop offset="95%" stopColor={color} stopOpacity={0}/>
            </linearGradient>
          </defs>
          <XAxis dataKey="t" hide/>
          <YAxis hide domain={['auto','auto']}/>
          <Tooltip contentStyle={{ fontSize:9, padding:'2px 8px', borderRadius:8 }} formatter={v=>fmt(v)} labelFormatter={()=>''}/>
          <Area type="monotone" dataKey="v" stroke={color} fill={`url(#${gradId})`} strokeWidth={2} dot={false}/>
        </AreaChart>
      </ResponsiveContainer>
      <div className="flex justify-between text-[9px] text-slate-300 mt-1">
        <span>{fmt(data[0]?.v)}</span>
        <span className="text-slate-400">{data.length} samples · 15s</span>
      </div>
    </div>
  );
}

/* ─── byte-lag helpers ─── */
function lagColor(bytes) {
  if (bytes === 0)            return { text:'text-emerald-600', bg:'bg-emerald-50', border:'border-emerald-200', bar:'#10B981' };
  if (bytes < 1_048_576)     return { text:'text-yellow-600',  bg:'bg-yellow-50',  border:'border-yellow-200',  bar:'#F59E0B' };
  if (bytes < 10_485_760)    return { text:'text-orange-600',  bg:'bg-orange-50',  border:'border-orange-200',  bar:'#F97316' };
  return                            { text:'text-red-600',     bg:'bg-red-50',     border:'border-red-200',     bar:'#EF4444' };
}
function lagTimeSev(ms) {
  if (!ms || ms === 0)  return { text:'text-emerald-600', label:'0ms' };
  if (ms < 100)         return { text:'text-yellow-600',  label:`${ms}ms` };
  if (ms < 1000)        return { text:'text-orange-600',  label:`${ms}ms` };
  return                       { text:'text-red-600',     label:`${ms}s` };
}
function syncBadge(state) {
  const m = {
    sync:    'bg-emerald-100 text-emerald-700 border-emerald-200',
    async:   'bg-blue-100 text-blue-700 border-blue-200',
    quorum:  'bg-violet-100 text-violet-700 border-violet-200',
    potential:'bg-slate-100 text-slate-500 border-slate-200',
  };
  return m[state] || 'bg-slate-100 text-slate-500 border-slate-200';
}
function stateBadge(state) {
  const s = state || 'streaming';
  if (s === 'streaming') return 'bg-emerald-100 text-emerald-700';
  if (s === 'catchup')   return 'bg-cyan-100 text-cyan-700';
  if (s === 'backup')    return 'bg-violet-100 text-violet-700';
  return 'bg-red-100 text-red-700';
}

function CopyTip({ text }) {
  const [ok, setOk] = React.useState(false);
  return (
    <button onClick={() => { navigator.clipboard.writeText(text).catch(()=>{}); setOk(true); setTimeout(()=>setOk(false),1500); }}
      className="ml-1 text-slate-300 hover:text-slate-500 transition-colors flex-shrink-0">
      {ok ? <CheckCheck size={10} className="text-emerald-500"/> : <Copy size={10}/>}
    </button>
  );
}

function LSNCell({ label, value, accent }) {
  const empty = !value || value === '0/0' || value === '';
  return (
    <div className={`flex flex-col gap-0.5 px-3 py-2 rounded-xl ${accent||'bg-slate-50'}`}>
      <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wide">{label}</span>
      <div className="flex items-center gap-1">
        <span className={`font-mono text-[11px] font-bold truncate ${empty?'text-slate-300':'text-slate-800'}`}>
          {empty ? 'not yet' : value}
        </span>
        {!empty && <CopyTip text={value}/>}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   ADVANCED REPLICATION TAB
══════════════════════════════════════════════════════════════════════════ */
function AdvancedReplicationTab({ replDetail, replLoading, refetchRepl, replication, replication_slots, health_summary }) {

  const rd      = replDetail || {};
  const topo    = rd.topology      || {};
  const cfg     = rd.rep_config    || {};
  const pwal    = rd.primary_wal   || {};
  const sinfo   = rd.standby_info  || {};
  const replicas= rd.replicas      || replication || [];
  const slots   = rd.slots         || replication_slots || [];
  const senders = rd.wal_senders   || [];
  const chkpt   = rd.checkpoint_stats || {};
  const walSt   = rd.wal_stats        || {};
  const confls  = rd.conflicts        || [];
  const pubs    = rd.publications     || [];
  const subs    = rd.subscriptions    || [];
  const recState= rd.recovery_state   || {};
  const role    = rd.role          || (health_summary?.replication_state === 'REPLICA' ? 'STANDBY' : 'PRIMARY');
  const isStandby = role === 'STANDBY';
  const isLoading = replLoading && !rd.status;

  if (isLoading) return (
    <div className="flex items-center justify-center py-32">
      <div className="text-center">
        <div className="w-14 h-14 border-4 border-indigo-200 border-t-indigo-500 rounded-full animate-spin mx-auto mb-4"/>
        <p className="text-slate-500 font-semibold text-sm">Loading replication data…</p>
      </div>
    </div>
  );

  const maxByteLag  = topo.max_byte_lag  || Math.max(...replicas.map(r=>r.byte_lag||0), 0);
  const totalRetain = Math.max(0, topo.total_retained != null ? topo.total_retained : slots.reduce((a,s)=>a+Math.max(0,s.retained_bytes||0),0));

  return (
    <div className="space-y-5">

      {/* ── Role banner ── */}
      <div className={`rounded-2xl border-2 p-5 ${isStandby
        ? 'bg-gradient-to-r from-cyan-50 to-indigo-50 border-cyan-200'
        : 'bg-gradient-to-r from-emerald-50 to-indigo-50 border-emerald-200'}`}>
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-4">
            <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-md ${isStandby?'bg-cyan-500':'bg-emerald-500'}`}>
              {isStandby
                ? <ArrowRight size={26} className="text-white"/>
                : <Crown size={26} className="text-white"/>}
            </div>
            <div>
              <div className="flex items-center gap-2 mb-0.5">
                <h2 className="font-black text-slate-900 text-xl">
                  {isStandby ? 'Standby Replica' : 'Primary Server'}
                </h2>
                <span className={`px-3 py-1 rounded-full text-xs font-black border ${isStandby
                  ?'bg-cyan-100 text-cyan-700 border-cyan-200'
                  :'bg-emerald-100 text-emerald-700 border-emerald-200'}`}>
                  {role}
                </span>
              </div>
              <p className="text-slate-500 text-[12px]">
                {isStandby
                  ? (sinfo.wal_receiver?.status === 'streaming'
                      ? `Streaming WAL from upstream primary · ${sinfo.seconds_behind != null ? sinfo.seconds_behind === 0 ? 'up to date' : `${sinfo.seconds_behind}s behind` : 'lag unknown'}`
                      : sinfo.wal_receiver
                        ? `WAL receiver ${sinfo.wal_receiver.status || 'not streaming'} · ${sinfo.seconds_behind != null ? `${sinfo.seconds_behind}s behind` : 'lag unknown'}`
                        : `WAL receiver not active · using archive recovery or upstream down`)
                  : `Streaming WAL to ${replicas.length} replica${replicas.length!==1?'s':''} · ${slots.length} replication slot${slots.length!==1?'s':''}`}
              </p>
            </div>
          </div>

          {/* KPIs */}
          <div className="flex gap-3 flex-wrap items-center">
            {!isStandby && (
              <>
                <div className="text-center px-4 py-2.5 bg-white rounded-xl border border-slate-200 shadow-sm min-w-[80px]">
                  <p className="text-[20px] font-black text-slate-900">{replicas.length}</p>
                  <p className="text-[9px] font-bold text-slate-400 uppercase">Replicas</p>
                </div>
                <div className="text-center px-4 py-2.5 bg-white rounded-xl border border-slate-200 shadow-sm min-w-[80px]">
                  <p className={`text-[18px] font-black ${lagColor(maxByteLag).text}`}>{fmtBytes(maxByteLag)}</p>
                  <p className="text-[9px] font-bold text-slate-400 uppercase">Max Byte Lag</p>
                </div>
                <div className="text-center px-4 py-2.5 bg-white rounded-xl border border-slate-200 shadow-sm min-w-[80px]">
                  <p className="text-[18px] font-black text-violet-600">{fmtBytes(totalRetain)}</p>
                  <p className="text-[9px] font-bold text-slate-400 uppercase">WAL Retained</p>
                </div>
                {topo.sync_count > 0 && (
                  <div className="text-center px-4 py-2.5 bg-emerald-50 rounded-xl border border-emerald-200 shadow-sm min-w-[80px]">
                    <p className="text-[20px] font-black text-emerald-700">{topo.sync_count}</p>
                    <p className="text-[9px] font-bold text-emerald-600 uppercase">Sync</p>
                  </div>
                )}
              </>
            )}
            {isStandby && sinfo.seconds_behind != null && (
              <div className={`text-center px-4 py-2.5 bg-white rounded-xl border shadow-sm min-w-[100px] ${sinfo.seconds_behind>60?'border-red-200':'border-emerald-200'}`}>
                <p className={`text-[22px] font-black ${sinfo.seconds_behind>60?'text-red-600':sinfo.seconds_behind>0?'text-yellow-600':'text-emerald-600'}`}>
                  {sinfo.seconds_behind === 0 ? '0s' : `${sinfo.seconds_behind}s`}
                </p>
                <p className="text-[9px] font-bold text-slate-400 uppercase">Behind Primary</p>
              </div>
            )}
            {isStandby && slots.length > 0 && (
              <div className="text-center px-4 py-2.5 bg-white rounded-xl border border-violet-200 shadow-sm min-w-[80px]">
                <p className="text-[20px] font-black text-violet-600">{slots.length}</p>
                <p className="text-[9px] font-bold text-slate-400 uppercase">Cascade Slots</p>
              </div>
            )}
            <button onClick={refetchRepl}
              className="w-9 h-9 rounded-xl bg-white border border-slate-200 flex items-center justify-center text-slate-500 hover:bg-slate-50 shadow-sm">
              <RefreshCw size={14} className={replLoading?'animate-spin':''}/>
            </button>
          </div>
        </div>

        {/* Primary WAL position bar */}
        {!isStandby && pwal.current_lsn && (
          <div className="mt-4 flex items-center gap-3 bg-white/70 rounded-xl px-4 py-2.5 border border-emerald-100">
            <Radio size={13} className="text-emerald-500 flex-shrink-0"/>
            <div className="flex items-center gap-2 flex-1 flex-wrap">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">Current WAL:</span>
              <span className="font-mono text-[12px] font-bold text-emerald-700">{pwal.current_lsn}</span>
              <CopyTip text={pwal.current_lsn}/>
              {pwal.wal_file && <>
                <span className="text-slate-300">·</span>
                <span className="font-mono text-[11px] text-slate-500">{pwal.wal_file}</span>
              </>}
            </div>
          </div>
        )}

        {/* Standby receive/replay bar */}
        {isStandby && (sinfo.receive_lsn || sinfo.replay_lsn) && (
          <div className="mt-4 grid grid-cols-2 gap-3">
            <LSNCell label="Last Receive LSN" value={sinfo.receive_lsn} accent="bg-white/70 border border-cyan-100"/>
            <LSNCell label="Last Replay LSN"  value={sinfo.replay_lsn}  accent="bg-white/70 border border-indigo-100"/>
          </div>
        )}
      </div>

      {/* ── Standby WAL receiver detail ── */}
      {isStandby && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="bg-gradient-to-r from-cyan-50 to-slate-50 border-b border-slate-100 px-5 py-3 flex items-center gap-2 flex-wrap">
            <Signal size={14} className="text-cyan-500"/>
            <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">WAL Receiver</h3>
            {sinfo.wal_receiver?.status ? (
              <span className={`ml-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${
                sinfo.wal_receiver.status==='streaming'?'bg-emerald-100 text-emerald-700':
                sinfo.wal_receiver.status==='waiting'||sinfo.wal_receiver.status==='starting'?'bg-amber-100 text-amber-700':
                'bg-slate-100 text-slate-600'}`}>
                {sinfo.wal_receiver.status}
              </span>
            ) : (
              <span className="ml-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-700">
                not streaming
              </span>
            )}
            {recState.walreceiver_procs != null && (
              <span className="ml-auto text-[10px] text-slate-400 font-mono">
                {recState.walreceiver_procs} walreceiver proc{recState.walreceiver_procs!==1?'s':''}
              </span>
            )}
          </div>

          {sinfo.wal_receiver ? (
            <div className="p-5 grid grid-cols-2 md:grid-cols-3 gap-4">
              {[
                { label:'Primary Host',      value: sinfo.wal_receiver.sender_host },
                { label:'Primary Port',      value: sinfo.wal_receiver.sender_port },
                { label:'Slot',              value: sinfo.wal_receiver.slot_name || recState.primary_slot_name || 'none' },
                { label:'Receive Start LSN', value: sinfo.wal_receiver.receive_start_lsn, mono:true },
                { label:'Received LSN',      value: sinfo.wal_receiver.received_lsn, mono:true },
                { label:'Latest End LSN',    value: sinfo.wal_receiver.latest_end_lsn, mono:true },
                { label:'Receive/Replay Δ',  value: fmtBytes(Math.max(0, sinfo.receive_replay_diff || 0)) },
                { label:'Last Msg Received', value: sinfo.wal_receiver.last_msg_receipt_time
                  ? new Date(sinfo.wal_receiver.last_msg_receipt_time).toLocaleString() : '—' },
              ].map(kv => (
                <div key={kv.label}>
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide mb-0.5">{kv.label}</p>
                  <p className={`text-[12px] font-bold text-slate-800 truncate ${kv.mono?'font-mono text-[11px]':''}`}>
                    {kv.value || '—'}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <div className="divide-y divide-amber-100">
              <div className="p-5 flex items-start gap-3 bg-amber-50/50">
                <AlertTriangle size={16} className="text-amber-500 mt-0.5 flex-shrink-0"/>
                <div className="flex-1">
                  <p className="text-[12px] font-bold text-amber-800">No active WAL receiver process</p>
                  <p className="text-[11px] text-amber-600 mt-0.5">
                    Streaming replication is not currently active. This is normal in a Patroni-managed cluster when
                    the upstream connection is being managed or re-established. The standby continues replaying from
                    its last received WAL position.
                  </p>
                </div>
              </div>
              {/* Show fallback connection info parsed from primary_conninfo */}
              {(sinfo.conninfo_host || recState.primary_conninfo) && (
                <div className="p-5 grid grid-cols-2 md:grid-cols-3 gap-4 bg-white">
                  <div>
                    <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide mb-0.5">Configured Primary Host</p>
                    <p className="text-[12px] font-bold text-slate-700 font-mono">{sinfo.conninfo_host || '—'}</p>
                  </div>
                  <div>
                    <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide mb-0.5">Configured Port</p>
                    <p className="text-[12px] font-bold text-slate-700 font-mono">{sinfo.conninfo_port || '—'}</p>
                  </div>
                  <div>
                    <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide mb-0.5">Application Name</p>
                    <p className="text-[12px] font-bold text-slate-700 font-mono">{sinfo.conninfo_app || recState.primary_slot_name || '—'}</p>
                  </div>
                  <div>
                    <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide mb-0.5">Last Receive LSN</p>
                    <p className="text-[11px] font-bold font-mono text-slate-700">{sinfo.receive_lsn || '—'}</p>
                  </div>
                  <div>
                    <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide mb-0.5">Last Replay LSN</p>
                    <p className="text-[11px] font-bold font-mono text-slate-700">{sinfo.replay_lsn || '—'}</p>
                  </div>
                  <div>
                    <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide mb-0.5">Receive/Replay Δ</p>
                    <p className="text-[12px] font-bold text-slate-700">{fmtBytes(Math.max(0, sinfo.receive_replay_diff || 0))}</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Recovery config from pg_settings */}
          {(recState.primary_conninfo || recState.primary_slot_name || recState.restore_command || recState.recovery_target_timeline) && (
            <div className="border-t border-slate-100 px-5 py-4">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-3">Recovery Configuration</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {[
                  { label:'primary_conninfo',           value: recState.primary_conninfo },
                  { label:'primary_slot_name',          value: recState.primary_slot_name },
                  { label:'recovery_target_timeline',   value: recState.recovery_target_timeline },
                  { label:'restore_command',            value: recState.restore_command },
                  { label:'recovery_min_apply_delay',   value: recState.recovery_min_apply_delay },
                ].filter(x => x.value).map(kv => (
                  <div key={kv.label}>
                    <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide mb-0.5">{kv.label}</p>
                    <p className="text-[11px] font-mono text-slate-700 truncate" title={kv.value}>{kv.value}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Replica cards (PRIMARY only) ── */}
      {!isStandby && (
        <>
          {replicas.length === 0 ? (
            <div className="bg-white rounded-2xl border border-dashed border-slate-300 py-20 text-center">
              <div className="w-16 h-16 bg-slate-50 rounded-2xl border border-slate-200 flex items-center justify-center mx-auto mb-4">
                <GitBranch size={28} className="text-slate-300"/>
              </div>
              <p className="font-bold text-slate-500 text-base">No Streaming Replicas</p>
              <p className="text-slate-400 text-sm mt-1 max-w-sm mx-auto">
                This primary has no connected standbys. Configure <code className="bg-slate-100 px-1 rounded text-[11px]">primary_conninfo</code> on a standby and restart it.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {replicas.map((r, i) => {
                const ok       = r.state === 'streaming' || r.state === 'catchup' || !r.state;
                const byteLag  = r.byte_lag || 0;
                const lc       = lagColor(byteLag);
                const replayMs = r.replay_lag_ms || 0;
                const lagPct   = maxByteLag > 0 ? Math.min(100, Math.round((byteLag / maxByteLag) * 100)) : 0;
                const hasLSN   = r.sent_lsn || r.replay_lsn;

                return (
                  <div key={i} className={`bg-white rounded-2xl border-2 overflow-hidden shadow-sm ${ok?'border-emerald-200':'border-red-200'}`}>
                    {/* colored top strip */}
                    <div className={`h-[3px] ${ok?'bg-gradient-to-r from-emerald-400 to-cyan-400':'bg-gradient-to-r from-red-400 to-orange-400'}`}/>

                    {/* header */}
                    <div className="px-5 pt-4 pb-3 flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${ok?'bg-emerald-50':'bg-red-50'}`}>
                          {ok
                            ? <Wifi size={20} className="text-emerald-500"/>
                            : <WifiOff size={20} className="text-red-500"/>}
                        </div>
                        <div>
                          <p className="font-black text-slate-900 text-[15px] leading-tight">
                            {r.application_name || `Replica ${i+1}`}
                          </p>
                          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                            <span className="text-[11px] text-slate-400 font-mono">{r.client_addr || 'local'}</span>
                            <span className="text-slate-200">·</span>
                            <span className="text-[10px] text-slate-400">PID {r.pid}</span>
                            {r.usename && <>
                              <span className="text-slate-200">·</span>
                              <span className="text-[10px] text-indigo-500 font-mono">{r.usename}</span>
                            </>}
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-col gap-1.5 items-end flex-shrink-0">
                        <span className={`px-2.5 py-1 rounded-lg text-[11px] font-bold ${stateBadge(r.state)}`}>
                          {r.state || 'streaming'}
                        </span>
                        <span className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border ${syncBadge(r.sync_state)}`}>
                          {r.sync_state || 'async'}
                        </span>
                      </div>
                    </div>

                    {/* byte lag bar */}
                    <div className={`mx-5 mb-3 px-4 py-3 rounded-xl border ${lc.border} ${lc.bg}`}>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">Total Byte Lag</span>
                        <span className={`text-[14px] font-black ${lc.text}`}>{fmtBytes(byteLag)}</span>
                      </div>
                      <div className="h-2 bg-white/80 rounded-full overflow-hidden border border-white">
                        <div className="h-full rounded-full transition-all" style={{ width:`${lagPct||1}%`, background:lc.bar }}/>
                      </div>
                      <div className="flex justify-between text-[9px] text-slate-400 mt-1">
                        <span>0 B</span>
                        <span>{fmtBytes(maxByteLag)} (cluster max)</span>
                      </div>
                    </div>

                    {/* LSN grid */}
                    <div className="px-5 mb-3">
                      <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide mb-2">LSN Positions</p>
                      <div className="grid grid-cols-2 gap-2">
                        <LSNCell label="Sent LSN"   value={r.sent_lsn}   accent="bg-indigo-50"/>
                        <LSNCell label="Write LSN"  value={r.write_lsn}  accent="bg-blue-50"/>
                        <LSNCell label="Flush LSN"  value={r.flush_lsn}  accent="bg-cyan-50"/>
                        <LSNCell label="Replay LSN" value={r.replay_lsn} accent="bg-emerald-50"/>
                      </div>
                      {!hasLSN && (
                        <p className="text-[11px] text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 mt-2">
                          LSN values are NULL — replica may be initializing or have no recent WAL activity.
                        </p>
                      )}
                    </div>

                    {/* Lag breakdown */}
                    <div className="px-5 mb-4">
                      <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide mb-2">Lag Breakdown</p>
                      <div className="grid grid-cols-3 gap-2">
                        {[
                          { label:'Write Lag',    ms: r.write_lag_ms,  txt: r.write_lag,  bytes: r.write_byte_lag },
                          { label:'Flush Lag',    ms: r.flush_lag_ms,  txt: r.flush_lag,  bytes: r.flush_byte_lag },
                          { label:'Apply Lag',    ms: r.replay_lag_ms, txt: r.replay_lag, bytes: r.apply_byte_lag },
                        ].map(({ label, ms, txt, bytes }) => {
                          const hasLag = ms > 0 || bytes > 0;
                          const lsev   = lagTimeSev(ms);
                          return (
                            <div key={label} className={`rounded-xl border p-2.5 text-center ${hasLag?'bg-orange-50 border-orange-100':'bg-slate-50 border-slate-100'}`}>
                              <p className="text-[8px] font-bold uppercase tracking-wide text-slate-400 mb-1">{label}</p>
                              <p className={`text-[13px] font-black ${hasLag?lsev.text:'text-emerald-600'}`}>
                                {txt && txt !== '0' ? txt.replace(/^00:/,'') : '0ms'}
                              </p>
                              {bytes > 0 && <p className="text-[9px] text-slate-400 mt-0.5">{fmtBytes(bytes)}</p>}
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* footer meta */}
                    {r.backend_start && (
                      <div className="px-5 pb-3 flex items-center gap-2 text-[10px] text-slate-400">
                        <Clock size={10}/>
                        Connected: {new Date(r.backend_start).toLocaleString()}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ── Replication Slots ── */}
      {slots.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="bg-gradient-to-r from-violet-50 to-slate-50 border-b border-slate-100 px-5 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <HardDrive size={14} className="text-violet-500"/>
              <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">
                Replication Slots ({slots.length})
              </h3>
              {slots.some(s=>s.active) && (
                <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold border border-emerald-200">
                  {slots.filter(s=>s.active).length} active
                </span>
              )}
              {slots.some(s=>!s.active) && (
                <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-[10px] font-bold border border-slate-200">
                  {slots.filter(s=>!s.active).length} inactive
                </span>
              )}
            </div>
            <span className="text-[11px] text-slate-400 font-mono">
              Retained WAL: <span className="font-bold text-violet-600">{fmtBytes(totalRetain)}</span>
            </span>
          </div>

          {/* Explain inactive slots context */}
          {slots.some(s=>!s.active) && (
            <div className="px-5 py-3 bg-slate-50/70 border-b border-slate-100 flex items-start gap-2.5">
              <Info size={13} className="text-slate-400 mt-0.5 flex-shrink-0"/>
              <p className="text-[11px] text-slate-500 leading-relaxed">
                <span className="font-bold text-slate-600">Inactive</span> slots mean no replica is currently connected via that slot —
                {isStandby
                  ? ' this standby acts as an intermediate node for cascading replication. Downstream replicas appear inactive when they are not currently streaming from this node.'
                  : ' the replica may be down, restarting, or replicating via a different path (e.g. Patroni switchover). The slot is preserved so WAL is not discarded.'}
                {' '}WAL is still retained at the slot's restart LSN position until the replica reconnects.
              </p>
            </div>
          )}

          <div className="p-5 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {slots.map((s, i) => {
              const retain = Math.max(0, s.retained_bytes || 0);
              const rc = retain > 0 ? lagColor(retain) : { text:'text-slate-400', bar:'#94a3b8' };
              const walStatusColor = s.wal_status === 'reserved' ? 'bg-emerald-100 text-emerald-700'
                : s.wal_status === 'extended' ? 'bg-yellow-100 text-yellow-700'
                : s.wal_status === 'lost' ? 'bg-red-100 text-red-700'
                : 'bg-slate-100 text-slate-500';
              return (
                <div key={i} className={`rounded-xl border overflow-hidden ${s.active?'border-emerald-200':'border-slate-200'}`}>
                  <div className={`px-4 py-3 flex items-center justify-between ${s.active?'bg-emerald-50':'bg-slate-50'}`}>
                    <div className="min-w-0">
                      <p className="font-black text-slate-800 text-[13px] truncate">{s.slot_name}</p>
                      <p className="text-[10px] text-slate-500 font-mono mt-0.5">
                        {s.slot_type || 'physical'} · {s.plugin || 'built-in'}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1.5 ml-2 flex-shrink-0">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${s.active?'bg-emerald-200 text-emerald-800':'bg-slate-200 text-slate-600'}`}>
                        {s.active ? 'Active' : 'Inactive'}
                      </span>
                      {s.wal_status && (
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${walStatusColor}`}>
                          WAL: {s.wal_status}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Inactive reason */}
                  {!s.active && s.inactive_reason && (
                    <div className="px-4 py-2 bg-slate-50/50 border-y border-slate-100 flex items-start gap-1.5">
                      <Info size={11} className="text-slate-400 mt-0.5 flex-shrink-0"/>
                      <p className="text-[10px] text-slate-500 leading-relaxed">{s.inactive_reason}</p>
                    </div>
                  )}

                  <div className="px-4 py-3 space-y-2.5">
                    {/* retained bytes bar */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wide">Retained WAL</span>
                        <span className={`text-[12px] font-black ${retain>0?rc.text:'text-slate-400'}`}>
                          {retain > 0 ? fmtBytes(retain) : '—'}
                        </span>
                      </div>
                      <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: retain>0?'60%':'0%', background: retain>0?rc.bar:'#e2e8f0' }}/>
                      </div>
                    </div>
                    {[
                      { label:'Database',         value: s.database || '—' },
                      { label:'Restart LSN',       value: s.restart_lsn || '—',          mono:true },
                      { label:'Confirmed Flush',   value: s.confirmed_flush_lsn || '—',  mono:true },
                      { label:'xmin',              value: s.xmin || '—',                 mono:true },
                    ].map(kv => (
                      <div key={kv.label} className="flex items-center justify-between">
                        <span className="text-[10px] text-slate-400 font-bold">{kv.label}</span>
                        <span className={`text-[11px] text-slate-700 font-bold ${kv.mono?'font-mono':''} truncate max-w-[140px]`}>{kv.value}</span>
                      </div>
                    ))}
                    {s.safe_wal_size > 0 && (
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-slate-400 font-bold">Safe WAL Ahead</span>
                        <span className="text-[11px] font-bold text-emerald-600">{fmtBytes(s.safe_wal_size)}</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Replication Config ── */}
      {Object.keys(cfg).length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="bg-gradient-to-r from-slate-50 to-indigo-50/30 border-b border-slate-100 px-5 py-3 flex items-center gap-2">
            <Server size={14} className="text-slate-500"/>
            <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">Replication Configuration</h3>
          </div>
          <div className="p-5 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
            {[
              { key:'wal_level',                label:'WAL Level',              warn: v => v==='minimal' },
              { key:'max_wal_senders',          label:'Max WAL Senders' },
              { key:'max_replication_slots',    label:'Max Repl Slots' },
              { key:'synchronous_commit',       label:'Sync Commit',            ok: v => v==='on' || v==='remote_apply' },
              { key:'synchronous_standby_names',label:'Sync Standbys' },
              { key:'hot_standby',              label:'Hot Standby',            ok: v => v==='on' },
              { key:'hot_standby_feedback',     label:'Hot Standby Feedback' },
              { key:'wal_keep_size',            label:'WAL Keep Size' },
              { key:'wal_sender_timeout',       label:'Sender Timeout' },
              { key:'wal_receiver_timeout',     label:'Receiver Timeout' },
              { key:'recovery_min_apply_delay', label:'Min Apply Delay' },
            ].map(({ key, label, warn, ok }) => {
              const v = cfg[key] || 'n/a';
              const isWarn = warn?.(v);
              const isOk   = ok?.(v);
              return (
                <div key={key}>
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide mb-0.5">{label}</p>
                  <span className={`inline-block px-2 py-0.5 rounded-lg text-[11px] font-bold font-mono
                    ${isWarn?'bg-amber-100 text-amber-700':isOk?'bg-emerald-100 text-emerald-700':'bg-slate-100 text-slate-600'}`}>
                    {v}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── WAL Senders ── */}
      {senders.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="bg-gradient-to-r from-slate-50 to-indigo-50/30 border-b border-slate-100 px-5 py-3 flex items-center gap-2">
            <Radio size={14} className="text-indigo-500"/>
            <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">WAL Sender Processes ({senders.length})</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-slate-200">
                  {['PID','User','Application','Client','State','Started'].map(h => (
                    <th key={h} className="px-4 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {senders.map((s, i) => (
                  <tr key={i} className="border-t border-slate-50 hover:bg-slate-50/50">
                    <td className="px-4 py-3 font-mono text-slate-500">{s.pid}</td>
                    <td className="px-4 py-3 text-indigo-600 font-bold">{s.usename}</td>
                    <td className="px-4 py-3 font-bold text-slate-700">{s.application_name||'—'}</td>
                    <td className="px-4 py-3 font-mono text-slate-500">{s.client_addr||'local'}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${stateBadge(s.state)}`}>{s.state||'—'}</span>
                    </td>
                    <td className="px-4 py-3 text-slate-400">{s.backend_start?new Date(s.backend_start).toLocaleString():'—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Raw pg_stat_replication table ── */}
      {replicas.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="bg-gradient-to-r from-slate-50 to-indigo-50/30 border-b border-slate-100 px-5 py-3 flex items-center gap-2">
            <Database size={14} className="text-slate-400"/>
            <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">pg_stat_replication (raw)</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/50">
                  {['Application','Client','State','Sync','Sent LSN','Write LSN','Flush LSN','Replay LSN','Write Lag','Flush Lag','Apply Lag','Byte Lag'].map(h=>(
                    <th key={h} className="px-3 py-2.5 text-left text-[9px] font-bold text-slate-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {replicas.map((r, i) => (
                  <tr key={i} className="border-t border-slate-50 hover:bg-indigo-50/20">
                    <td className="px-3 py-2.5 font-bold text-indigo-700">{r.application_name||'—'}</td>
                    <td className="px-3 py-2.5 font-mono text-slate-500">{r.client_addr||'local'}</td>
                    <td className="px-3 py-2.5">
                      <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold ${stateBadge(r.state)}`}>{r.state||'streaming'}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold border ${syncBadge(r.sync_state)}`}>{r.sync_state||'async'}</span>
                    </td>
                    {['sent_lsn','write_lsn','flush_lsn','replay_lsn'].map(f => (
                      <td key={f} className="px-3 py-2.5">
                        {r[f] ? (
                          <div className="flex items-center gap-1">
                            <span className="font-mono text-slate-700">{r[f]}</span>
                            <CopyTip text={r[f]}/>
                          </div>
                        ) : <span className="text-slate-300">—</span>}
                      </td>
                    ))}
                    {['write_lag','flush_lag','replay_lag'].map(f => {
                      const v = r[f]; const hasV = v && v !== '0';
                      return (
                        <td key={f} className={`px-3 py-2.5 font-bold ${hasV?'text-orange-600':'text-emerald-600'}`}>
                          {v && v !== '0' ? v.replace(/^00:/,'') : '0'}
                        </td>
                      );
                    })}
                    <td className={`px-3 py-2.5 font-bold ${lagColor(r.byte_lag||0).text}`}>
                      {fmtBytes(r.byte_lag||0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Checkpoint / BGWriter Stats ── */}
      {Object.keys(chkpt).length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="bg-gradient-to-r from-orange-50 to-slate-50 border-b border-slate-100 px-5 py-3 flex items-center gap-2">
            <Activity size={14} className="text-orange-500"/>
            <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">Checkpoint &amp; BGWriter</h3>
            {chkpt.stats_reset && (
              <span className="ml-auto text-[10px] text-slate-400">Reset: {new Date(chkpt.stats_reset).toLocaleString()}</span>
            )}
          </div>
          <div className="p-5 grid grid-cols-2 md:grid-cols-4 xl:grid-cols-4 gap-4">
            {[
              { label:'Timed Checkpoints',  value: chkpt.checkpoints_timed?.toLocaleString(), color:'text-indigo-700' },
              { label:'Requested CPs',       value: chkpt.checkpoints_req?.toLocaleString(),   color: chkpt.checkpoints_req > 10 ? 'text-amber-600' : 'text-emerald-700' },
              { label:'Write Time',          value: chkpt.checkpoint_write_time != null ? `${(chkpt.checkpoint_write_time/1000).toFixed(1)}s` : '—', color:'text-slate-700' },
              { label:'Sync Time',           value: chkpt.checkpoint_sync_time  != null ? `${(chkpt.checkpoint_sync_time/1000).toFixed(1)}s` : '—', color:'text-slate-700' },
              { label:'Buffers (CP)',        value: chkpt.buffers_checkpoint?.toLocaleString(), color:'text-blue-700' },
              { label:'Buffers (BgWriter)',  value: chkpt.buffers_clean?.toLocaleString(),      color:'text-cyan-700' },
              { label:'Buffers (Backend)',   value: chkpt.buffers_backend?.toLocaleString(),    color: chkpt.buffers_backend > 1000 ? 'text-amber-600' : 'text-slate-700' },
              { label:'Buffers Allocated',   value: chkpt.buffers_alloc?.toLocaleString(),      color:'text-slate-700' },
            ].map(({ label, value, color }) => (
              <div key={label} className="bg-slate-50 rounded-xl border border-slate-100 px-4 py-3">
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide mb-1">{label}</p>
                <p className={`text-[15px] font-black ${color}`}>{value ?? '—'}</p>
              </div>
            ))}
          </div>
          {chkpt.maxwritten_clean > 0 && (
            <div className="mx-5 mb-4 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5">
              <AlertTriangle size={13} className="text-amber-500 mt-0.5 flex-shrink-0"/>
              <p className="text-[11px] text-amber-700">
                <span className="font-bold">{chkpt.maxwritten_clean.toLocaleString()}</span> times the bgwriter stopped a scan because it had written too many buffers — consider increasing <code className="bg-amber-100 px-1 rounded text-[10px]">bgwriter_lru_maxpages</code>.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── WAL Generation Stats (PG14+, primary only) ── */}
      {!isStandby && Object.keys(walSt).length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="bg-gradient-to-r from-blue-50 to-slate-50 border-b border-slate-100 px-5 py-3 flex items-center gap-2">
            <GitBranch size={14} className="text-blue-500"/>
            <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">WAL Generation (pg_stat_wal)</h3>
            {walSt.stats_reset && (
              <span className="ml-auto text-[10px] text-slate-400">Reset: {new Date(walSt.stats_reset).toLocaleString()}</span>
            )}
          </div>
          <div className="p-5 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
            {[
              { label:'WAL Records',     value: walSt.wal_records?.toLocaleString(),                   color:'text-indigo-700' },
              { label:'Full Page Imgs',  value: walSt.wal_fpi?.toLocaleString(),                       color:'text-blue-700' },
              { label:'Total WAL',       value: fmtBytes(walSt.wal_bytes || 0),                        color:'text-violet-700' },
              { label:'Buffer Full',     value: walSt.wal_buffers_full?.toLocaleString(),              color: walSt.wal_buffers_full > 100 ? 'text-amber-600' : 'text-slate-700' },
              { label:'Write Time',      value: walSt.wal_write_time != null ? `${walSt.wal_write_time.toFixed(1)}ms` : '—', color:'text-slate-700' },
              { label:'Sync Time',       value: walSt.wal_sync_time  != null ? `${walSt.wal_sync_time.toFixed(1)}ms` : '—', color:'text-slate-700' },
            ].map(({ label, value, color }) => (
              <div key={label} className="bg-slate-50 rounded-xl border border-slate-100 px-4 py-3">
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide mb-1">{label}</p>
                <p className={`text-[14px] font-black ${color}`}>{value ?? '—'}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Replication Conflicts (standby only) ── */}
      {isStandby && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="bg-gradient-to-r from-red-50 to-slate-50 border-b border-slate-100 px-5 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle size={14} className="text-red-500"/>
              <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">Replication Conflicts</h3>
              {confls.length > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-[10px] font-bold border border-red-200">
                  {confls.length} db{confls.length !== 1 ? 's' : ''} with conflicts
                </span>
              )}
            </div>
            {recState.pause_state && (
              <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${recState.pause_state === 'paused' ? 'bg-amber-100 text-amber-700 border border-amber-200' : 'bg-emerald-100 text-emerald-700 border border-emerald-200'}`}>
                Replay: {recState.pause_state}
              </span>
            )}
          </div>
          {confls.length === 0 ? (
            <div className="p-8 text-center">
              <div className="w-12 h-12 bg-emerald-50 rounded-2xl border border-emerald-100 flex items-center justify-center mx-auto mb-3">
                <CheckCircle2 size={22} className="text-emerald-500"/>
              </div>
              <p className="font-bold text-slate-600 text-sm">No Replication Conflicts</p>
              <p className="text-slate-400 text-[12px] mt-1">All databases are conflict-free</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/50">
                    {['Database','Tablespace','Lock','Snapshot','BufferPin','Deadlock','Total'].map(h => (
                      <th key={h} className="px-4 py-2.5 text-left text-[9px] font-bold text-slate-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {confls.map((c, i) => {
                    const total = (c.confl_tablespace||0)+(c.confl_lock||0)+(c.confl_snapshot||0)+(c.confl_bufferpin||0)+(c.confl_deadlock||0);
                    return (
                      <tr key={i} className="border-t border-slate-50 hover:bg-red-50/30">
                        <td className="px-4 py-3 font-bold text-slate-800">{c.datname}</td>
                        <td className="px-4 py-3 text-slate-500">{c.confl_tablespace||0}</td>
                        <td className="px-4 py-3 text-slate-500">{c.confl_lock||0}</td>
                        <td className="px-4 py-3 text-slate-500">{c.confl_snapshot||0}</td>
                        <td className="px-4 py-3 text-slate-500">{c.confl_bufferpin||0}</td>
                        <td className="px-4 py-3 text-slate-500">{c.confl_deadlock||0}</td>
                        <td className="px-4 py-3 font-black text-red-600">{total.toLocaleString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Logical Replication Publications ── */}
      {pubs.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="bg-gradient-to-r from-violet-50 to-slate-50 border-b border-slate-100 px-5 py-3 flex items-center gap-2">
            <Radio size={14} className="text-violet-500"/>
            <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">Publications ({pubs.length})</h3>
          </div>
          <div className="p-5 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {pubs.map((p, i) => (
              <div key={i} className="rounded-xl border border-violet-100 bg-violet-50/40 px-4 py-3">
                <p className="font-black text-slate-800 text-[13px] mb-2">{p.pubname}</p>
                <div className="flex flex-wrap gap-1.5">
                  {p.puballtables && <span className="px-2 py-0.5 rounded-full bg-violet-100 text-violet-700 text-[9px] font-bold">ALL TABLES</span>}
                  {p.pubinsert    && <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[9px] font-bold">INSERT</span>}
                  {p.pubupdate    && <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-[9px] font-bold">UPDATE</span>}
                  {p.pubdelete    && <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-[9px] font-bold">DELETE</span>}
                  {p.pubtruncate  && <span className="px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 text-[9px] font-bold">TRUNCATE</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Logical Replication Subscriptions ── */}
      {subs.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="bg-gradient-to-r from-cyan-50 to-slate-50 border-b border-slate-100 px-5 py-3 flex items-center gap-2">
            <ArrowRight size={14} className="text-cyan-500"/>
            <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">Subscriptions ({subs.length})</h3>
          </div>
          <div className="p-5 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {subs.map((s, i) => (
              <div key={i} className={`rounded-xl border px-4 py-3 ${s.subenabled ? 'border-emerald-100 bg-emerald-50/40' : 'border-red-100 bg-red-50/30'}`}>
                <div className="flex items-center justify-between mb-1.5">
                  <p className="font-black text-slate-800 text-[13px]">{s.subname}</p>
                  <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${s.subenabled ? 'bg-emerald-200 text-emerald-800' : 'bg-red-200 text-red-800'}`}>
                    {s.subenabled ? 'Enabled' : 'DISABLED'}
                  </span>
                </div>
                {s.subslotname && (
                  <p className="text-[10px] text-slate-500 font-mono">Slot: {s.subslotname}</p>
                )}
                {s.subpublications?.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {s.subpublications.map((pub, j) => (
                      <span key={j} className="px-1.5 py-0.5 rounded bg-cyan-100 text-cyan-700 text-[9px] font-bold">{pub}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* errors */}
      {rd.errors?.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <p className="text-[11px] font-bold text-amber-700 mb-1">⚠ Some queries failed:</p>
          {rd.errors.map((e,i)=>(
            <p key={i} className="text-[10px] font-mono text-amber-600">{e}</p>
          ))}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   ADVANCED QUERIES TAB
══════════════════════════════════════════════════════════════════════════ */
const QTYPE_COLORS = {
  SELECT: { bg:'#EFF6FF', border:'#BFDBFE', text:'#1D4ED8', dot:'#3B82F6' },
  INSERT: { bg:'#F0FDF4', border:'#BBF7D0', text:'#065F46', dot:'#10B981' },
  UPDATE: { bg:'#FFFBEB', border:'#FDE68A', text:'#92400E', dot:'#F59E0B' },
  DELETE: { bg:'#FFF1F2', border:'#FECDD3', text:'#9F1239', dot:'#F43F5E' },
  WITH:   { bg:'#F5F3FF', border:'#DDD6FE', text:'#6D28D9', dot:'#8B5CF6' },
  OTHER:  { bg:'#F8FAFC', border:'#E2E8F0', text:'#64748B', dot:'#94A3B8' },
};
const WAIT_COLORS = {
  Lock:        'bg-red-100 text-red-700',
  LWLock:      'bg-orange-100 text-orange-700',
  IO:          'bg-amber-100 text-amber-700',
  Client:      'bg-sky-100 text-sky-700',
  running:     'bg-emerald-100 text-emerald-700',
  IPC:         'bg-violet-100 text-violet-700',
  Timeout:     'bg-slate-100 text-slate-600',
  Activity:    'bg-blue-100 text-blue-700',
};
const METRIC_VIEWS = [
  { id:'mean',  label:'Slowest (Mean)',  field:'mean_exec_time',  fmt: v=>fmtMs(v), color:'#EF4444' },
  { id:'total', label:'Most CPU',        field:'total_exec_time', fmt: v=>fmtMs(v), color:'#F97316' },
  { id:'calls', label:'Most Called',     field:'calls',           fmt: v=>fmtNum(v),color:'#6366F1' },
  { id:'io',    label:'Most I/O',        field:'shared_blks_read',fmt: v=>fmtNum(v),color:'#8B5CF6' },
  { id:'rows',  label:'Most Rows',       field:'rows',            fmt: v=>fmtNum(v),color:'#10B981' },
  { id:'temp',  label:'Temp Spill',      field:'temp_blks_read',  fmt: v=>fmtNum(v),color:'#F43F5E' },
];
const METRIC_KEYS = { mean:'top_by_mean_time', total:'top_by_total_time', calls:'top_by_calls', io:'top_by_io', rows:'top_by_rows', temp:'top_by_temp' };

function AiQueryAnalysis({ res }) {
  if (res.err) return <div className="mt-3 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-[12px] text-red-700">AI analysis failed: {res.err}</div>;
  const a = res.data;
  if (!a) return null;
  const SEV = { critical: 'bg-red-100 text-red-700', high: 'bg-orange-100 text-orange-700', medium: 'bg-amber-100 text-amber-700', low: 'bg-emerald-100 text-emerald-700' };
  const Block = ({ title, children }) => (
    <div className="bg-white border border-indigo-100 rounded-xl p-3">
      <p className="text-[9px] font-black text-indigo-400 uppercase tracking-wide mb-1.5">{title}</p>{children}
    </div>
  );
  return (
    <div className="mt-3 space-y-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1 text-[11px] font-black px-2.5 py-1 rounded-full bg-gradient-to-r from-indigo-600 to-violet-600 text-white"><Zap size={11} /> ActMon AI</span>
        {a.severity && <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${SEV[a.severity] || SEV.medium}`}>{a.severity.toUpperCase()}</span>}
        {a.estimated_overall_improvement && <span className="text-[11px] text-emerald-700 font-bold">↑ {a.estimated_overall_improvement}</span>}
      </div>
      {a.summary && <p className="text-[12px] text-slate-700"><b>Summary:</b> {a.summary}</p>}
      {a.root_cause && <Block title="Root cause"><p className="text-[12px] text-slate-700">{a.root_cause}</p></Block>}

      {a.issues?.length > 0 && (
        <Block title={`Issues (${a.issues.length})`}>
          <ul className="space-y-1.5">
            {a.issues.map((is, k) => (
              <li key={k} className="text-[12px] text-slate-700 flex items-start gap-2">
                <span className={`mt-0.5 text-[9px] font-black px-1.5 py-0.5 rounded ${SEV[is.severity] || SEV.medium}`}>{is.type}</span>
                <span>{is.description}{is.table ? <span className="text-slate-400"> · {is.table}</span> : ''}{is.evidence ? <span className="block text-[11px] text-slate-400 font-mono">{is.evidence}</span> : ''}</span>
              </li>
            ))}
          </ul>
        </Block>
      )}

      {a.index_recommendations?.length > 0 && (
        <Block title="Index recommendations">
          {a.index_recommendations.map((ir, k) => (
            <div key={k} className="mb-2">
              <p className="text-[11px] text-slate-600">{ir.reason} {ir.estimated_improvement ? <span className="text-emerald-600 font-bold">— {ir.estimated_improvement}</span> : ''}</p>
              <code className="block font-mono text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-100 rounded px-2 py-1 mt-0.5 break-all">{ir.create_sql}</code>
            </div>
          ))}
        </Block>
      )}

      {a.query_rewrite?.applicable && a.query_rewrite?.optimized_sql && (
        <Block title={`Query rewrite ${a.query_rewrite.expected_gain ? '· ' + a.query_rewrite.expected_gain : ''}`}>
          <p className="text-[11px] text-slate-600 mb-1">{a.query_rewrite.explanation}</p>
          <pre className="font-mono text-[10px] text-violet-900 bg-violet-50 border border-violet-100 rounded p-2 whitespace-pre-wrap break-all">{a.query_rewrite.optimized_sql}</pre>
        </Block>
      )}

      {a.priority_actions?.length > 0 && (
        <Block title="Priority actions">
          <ol className="space-y-1">
            {a.priority_actions.map((p, k) => <li key={k} className="text-[12px] text-slate-700">{p}</li>)}
          </ol>
        </Block>
      )}
      {a.business_impact && <p className="text-[11px] text-slate-500 italic">{a.business_impact}</p>}
    </div>
  );
}

function AdvancedQueriesTab({ detail, isLoading, refetch, connId }) {
  const [view,    setView]    = React.useState('mean');
  const [search,  setSearch]  = React.useState('');
  const [expand,  setExpand]  = React.useState(null);
  const [showAll, setShowAll] = React.useState(false);
  const [modalQuery, setModalQuery] = React.useState(null);   // clicked statement → analysis window

  const d = detail || {};
  const mv = METRIC_VIEWS.find(m=>m.id===view) || METRIC_VIEWS[0];
  const stmts = (d[METRIC_KEYS[view]] || []).filter(s =>
    !search || s.query?.toLowerCase().includes(search.toLowerCase()) || s.usename?.toLowerCase().includes(search.toLowerCase())
  );
  const active  = d.active_queries  || [];
  const longRun = d.long_running    || [];
  const byType  = d.by_type         || {};
  const waitEvs = d.wait_events     || {};
  const backends= d.all_backends    || [];

  if (isLoading && !d.status) return (
    <div className="flex items-center justify-center py-32">
      <div className="text-center">
        <div className="w-14 h-14 border-4 border-indigo-200 border-t-indigo-500 rounded-full animate-spin mx-auto mb-4"/>
        <p className="text-slate-500 text-sm font-semibold">Loading query analytics…</p>
      </div>
    </div>
  );

  const totalCalls = Object.values(byType).reduce((a,b)=>a+b,0);

  return (
    <div className="space-y-5">

      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-6 gap-3">
        {[
          { label:'Total Statements', value: d.total_statements ?? 0,        color:'indigo', icon: Database },
          { label:'Cache Hit %',      value: `${d.cache_hit_pct ?? 0}%`,     color: Number(d.cache_hit_pct)>90?'emerald':Number(d.cache_hit_pct)>70?'yellow':'red', icon: Activity },
          { label:'Active Queries',   value: active.length,                   color:'blue',   icon: Zap },
          { label:'Long Running',     value: longRun.length,                  color: longRun.length>0?'red':'emerald', icon: Clock },
          { label:'Wait Events',      value: Object.keys(waitEvs).filter(k=>k!=='running').length, color: Object.keys(waitEvs).some(k=>k==='Lock'||k==='LWLock')?'red':'slate', icon: AlertTriangle },
          { label:'Query Types',      value: Object.keys(byType).length,      color:'slate',  icon: Layers },
        ].map(k => (
          <div key={k.label} className={`bg-white rounded-2xl border border-slate-200 shadow-sm p-4 flex items-center gap-3`}>
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0
              ${ k.color==='indigo'?'bg-indigo-50 border border-indigo-100':
                 k.color==='emerald'?'bg-emerald-50 border border-emerald-100':
                 k.color==='yellow'?'bg-yellow-50 border border-yellow-100':
                 k.color==='red'?'bg-red-50 border border-red-100':
                 k.color==='blue'?'bg-blue-50 border border-blue-100':'bg-slate-50 border border-slate-100'}`}>
              <k.icon size={17} className={
                k.color==='indigo'?'text-indigo-500':k.color==='emerald'?'text-emerald-500':
                k.color==='yellow'?'text-yellow-500':k.color==='red'?'text-red-500':
                k.color==='blue'?'text-blue-500':'text-slate-400'} />
            </div>
            <div>
              <p className="text-[20px] font-black text-slate-900 leading-tight">{k.value}</p>
              <p className="text-[10px] text-slate-400 font-medium">{k.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Long-running alert */}
      {longRun.length > 0 && (
        <div className="bg-red-50 border-2 border-red-200 rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle size={16} className="text-red-500 flex-shrink-0"/>
            <p className="font-black text-red-700 text-[14px]">{longRun.length} Long-Running Quer{longRun.length===1?'y':'ies'} (&gt;30s)</p>
          </div>
          <div className="space-y-2">
            {longRun.slice(0,5).map((q,i) => (
              <div key={i} className="bg-white rounded-xl border border-red-100 px-4 py-3">
                <div className="flex items-center gap-3 flex-wrap mb-1.5">
                  <span className="font-mono text-[11px] font-bold text-red-600">PID {q.pid}</span>
                  <span className="text-[11px] font-bold text-indigo-700">{q.usename}</span>
                  <span className="text-[11px] text-slate-500">{q.datname}</span>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${q.duration_sec>300?'bg-red-200 text-red-800':q.duration_sec>60?'bg-orange-100 text-orange-700':'bg-yellow-100 text-yellow-700'}`}>
                    {q.duration_sec}s
                  </span>
                  {q.wait_event && <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${WAIT_COLORS[q.wait_event_type]||'bg-slate-100 text-slate-600'}`}>
                    wait: {q.wait_event_type}/{q.wait_event}
                  </span>}
                </div>
                <pre className="font-mono text-[10px] text-slate-600 bg-slate-50 rounded-lg px-3 py-2 truncate">{String(q.query||'').slice(0,200)}</pre>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Query type pills + wait events */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Query types */}
        {Object.keys(byType).length > 0 && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
            <h3 className="text-[11px] font-black text-slate-500 uppercase tracking-wide mb-4">Statement Types</h3>
            <div className="flex flex-wrap gap-2">
              {Object.entries(byType).sort((a,b)=>b[1]-a[1]).map(([type, cnt]) => {
                const c = QTYPE_COLORS[type] || QTYPE_COLORS.OTHER;
                const pct = Math.round(cnt/Math.max(totalCalls,1)*100);
                return (
                  <div key={type} className="flex items-center gap-2 px-3 py-2 rounded-xl border-2" style={{background:c.bg,borderColor:c.border,color:c.text}}>
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{background:c.dot}}/>
                    <span className="font-black text-[12px]">{type}</span>
                    <span className="font-bold text-[11px]">{cnt}</span>
                    <span className="text-[10px] opacity-70">({pct}%)</span>
                  </div>
                );
              })}
            </div>
            {!d.pg_ss_available && (
              <p className="mt-3 text-[11px] text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                pg_stat_statements not enabled. Run: <code className="font-mono bg-amber-100 px-1 rounded">CREATE EXTENSION pg_stat_statements;</code>
              </p>
            )}
          </div>
        )}

        {/* Wait events */}
        {Object.keys(waitEvs).length > 0 && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
            <h3 className="text-[11px] font-black text-slate-500 uppercase tracking-wide mb-4">Active Wait Events</h3>
            <div className="space-y-2">
              {Object.entries(waitEvs).sort((a,b)=>b[1]-a[1]).map(([evt, cnt]) => {
                const total = Object.values(waitEvs).reduce((a,b)=>a+b,0);
                const pct = Math.round(cnt/Math.max(total,1)*100);
                const cls = WAIT_COLORS[evt] || 'bg-slate-100 text-slate-600';
                return (
                  <div key={evt} className="flex items-center gap-3">
                    <span className={`px-2.5 py-1 rounded-lg text-[11px] font-bold w-24 text-center flex-shrink-0 ${cls}`}>{evt}</span>
                    <div className="flex-1 h-3 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-gradient-to-r from-indigo-400 to-indigo-600" style={{width:`${pct}%`}}/>
                    </div>
                    <span className="text-[12px] font-black text-slate-700 w-8 text-right">{cnt}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* pg_stat_statements panel */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="bg-gradient-to-r from-indigo-50 to-violet-50/30 border-b border-slate-100 px-5 py-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-2">
              <Database size={14} className="text-indigo-500"/>
              <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">pg_stat_statements</h3>
              <span className="px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-[10px] font-bold">{d.total_statements ?? 0} stmts</span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative">
                <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"/>
                <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search query / user…"
                  className="h-8 pl-7 pr-3 rounded-xl border border-slate-200 text-[12px] outline-none focus:border-indigo-400 bg-white w-44"/>
              </div>
              <button onClick={refetch} className="w-8 h-8 rounded-xl border border-slate-200 flex items-center justify-center text-slate-400 hover:bg-slate-50">
                <RefreshCw size={12} className={isLoading?'animate-spin':''}/>
              </button>
            </div>
          </div>
          {/* Metric selector */}
          <div className="flex gap-1.5 mt-3 flex-wrap">
            {METRIC_VIEWS.map(mv => (
              <button key={mv.id} onClick={()=>{setView(mv.id);setExpand(null);}}
                className={`flex items-center gap-1.5 h-8 px-3 rounded-xl text-[11px] font-bold border-2 transition-all
                  ${view===mv.id?'border-indigo-500 bg-indigo-50 text-indigo-700':'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}>
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{background:mv.color}}/>
                {mv.label}
              </button>
            ))}
          </div>
        </div>

        {!d.pg_ss_available && !isLoading && (
          <div className="px-5 py-10 text-center">
            <Database size={40} className="mx-auto mb-3 text-slate-200"/>
            <p className="font-bold text-slate-500 text-[14px]">pg_stat_statements not enabled</p>
            <p className="text-slate-400 text-[12px] mt-1">Run as superuser: <code className="bg-slate-100 px-2 py-0.5 rounded font-mono">CREATE EXTENSION IF NOT EXISTS pg_stat_statements;</code></p>
            <p className="text-slate-400 text-[11px] mt-1">Then add <code className="bg-slate-100 px-1 rounded font-mono">shared_preload_libraries = 'pg_stat_statements'</code> to postgresql.conf and restart.</p>
          </div>
        )}

        {d.pg_ss_available && (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-slate-50/70 border-b border-slate-200">
                  {['#','User','DB','Query Type',mv.label,'Calls','Total Time','Min','Max','Stddev','Rows/Call','Cache Hit%','Temp Blks','Query'].map(h=>(
                    <th key={h} className={`px-3 py-2.5 text-left text-[9px] font-black text-slate-400 uppercase tracking-wide whitespace-nowrap ${h===mv.label?'text-indigo-600':''}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stmts.slice(0, showAll?999:25).map((s,i) => {
                  const qt = s.query_type || 'OTHER';
                  const qc = QTYPE_COLORS[qt] || QTYPE_COLORS.OTHER;
                  const isSlow = s.mean_exec_time > 1000;
                  return (
                    <React.Fragment key={i}>
                      <tr onClick={()=>setModalQuery(s)}
                        className={`border-t border-slate-100 cursor-pointer transition-colors hover:bg-indigo-50/40
                          ${isSlow?'bg-red-50/40':''}`}>
                        <td className="px-3 py-2.5 text-slate-400 font-mono">{i+1}</td>
                        <td className="px-3 py-2.5 font-bold text-indigo-700 truncate max-w-[80px]">{s.usename||'—'}</td>
                        <td className="px-3 py-2.5 text-slate-500 font-mono">{s.dbid||'—'}</td>
                        <td className="px-3 py-2.5">
                          <span className="px-2 py-0.5 rounded-full text-[9px] font-black border" style={{background:qc.bg,borderColor:qc.border,color:qc.text}}>{qt}</span>
                        </td>
                        <td className={`px-3 py-2.5 font-black font-mono text-[12px]`} style={{color:mv.color}}>
                          {mv.fmt(s[mv.field])}
                        </td>
                        <td className="px-3 py-2.5 font-mono font-bold text-slate-700">{fmtNum(s.calls)}</td>
                        <td className="px-3 py-2.5 font-mono text-slate-500">{fmtMs(s.total_exec_time)}</td>
                        <td className="px-3 py-2.5 font-mono text-slate-400">{fmtMs(s.min_exec_time)}</td>
                        <td className={`px-3 py-2.5 font-mono font-bold ${s.max_exec_time>5000?'text-red-600':s.max_exec_time>1000?'text-orange-600':'text-slate-500'}`}>
                          {fmtMs(s.max_exec_time)}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-slate-400">{fmtMs(s.stddev_exec_time)}</td>
                        <td className="px-3 py-2.5 font-mono text-slate-600">{s.rows_per_call?.toFixed(1)??'—'}</td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <div className="h-1.5 w-12 bg-slate-100 rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${s.cache_hit_pct>90?'bg-emerald-500':s.cache_hit_pct>70?'bg-yellow-400':'bg-red-500'}`} style={{width:`${s.cache_hit_pct||0}%`}}/>
                            </div>
                            <span className={`text-[10px] font-bold ${s.cache_hit_pct>90?'text-emerald-600':s.cache_hit_pct>70?'text-yellow-600':'text-red-600'}`}>{s.cache_hit_pct}%</span>
                          </div>
                        </td>
                        <td className={`px-3 py-2.5 font-mono font-bold ${s.temp_blks_read>0?'text-red-600':'text-slate-300'}`}>
                          {s.temp_blks_read > 0 ? fmtNum(s.temp_blks_read) : '—'}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-[10px] text-slate-400 max-w-[200px] truncate">
                          {String(s.query||'').replace(/\s+/g,' ').slice(0,70)} <ChevronRight size={12} className="inline text-slate-300" />
                        </td>
                      </tr>
                    </React.Fragment>
                  );
                })}
                {stmts.length === 0 && (
                  <tr><td colSpan={14} className="text-center py-12 text-slate-400">
                    <Database size={32} className="mx-auto mb-2 text-slate-200"/>
                    <p className="font-bold">No statements match</p>
                  </td></tr>
                )}
              </tbody>
            </table>
            {stmts.length > 25 && !showAll && (
              <div className="border-t border-slate-100 px-5 py-3 bg-slate-50/50">
                <button onClick={()=>setShowAll(true)} className="text-[12px] font-bold text-indigo-600 hover:text-indigo-800">
                  Show all {stmts.length} statements ↓
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Active Queries */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="bg-gradient-to-r from-slate-50 to-indigo-50/30 border-b border-slate-100 px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity size={14} className="text-indigo-500"/>
            <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">Active Sessions ({active.length})</h3>
            {longRun.length>0 && <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-[10px] font-bold border border-red-200">{longRun.length} &gt;30s</span>}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="bg-slate-50/70 border-b border-slate-200">
                {['PID','User','DB','App','Backend','State','Wait Type','Wait Event','Duration','Query'].map(h=>(
                  <th key={h} className="px-3 py-2.5 text-left text-[9px] font-black text-slate-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {active.map((q,i) => {
                const isLong = q.duration_sec > 30;
                const hasWait = q.wait_event_type && q.wait_event_type !== 'Client';
                return (
                  <tr key={i} className={`border-t border-slate-100 hover:bg-slate-50/50 ${isLong?'bg-red-50/30':hasWait?'bg-yellow-50/30':''}`}>
                    <td className="px-3 py-2.5 font-mono text-slate-500">{q.pid}</td>
                    <td className="px-3 py-2.5 font-bold text-indigo-700">{q.usename||'—'}</td>
                    <td className="px-3 py-2.5 text-slate-500">{q.datname||'—'}</td>
                    <td className="px-3 py-2.5 text-slate-400 text-[11px] max-w-[80px] truncate">{q.application_name||'—'}</td>
                    <td className="px-3 py-2.5">
                      <span className="px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded text-[9px] font-bold">{q.backend_type||'client'}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        q.state==='active'?'bg-emerald-100 text-emerald-700':
                        q.state==='idle in transaction'?'bg-orange-100 text-orange-700':
                        q.state==='idle in transaction (aborted)'?'bg-red-100 text-red-700':
                        'bg-slate-100 text-slate-500'}`}>{q.state||'—'}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      {q.wait_event_type && <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${WAIT_COLORS[q.wait_event_type]||'bg-slate-100 text-slate-600'}`}>{q.wait_event_type}</span>}
                    </td>
                    <td className="px-3 py-2.5 text-slate-500 text-[11px]">{q.wait_event||'—'}</td>
                    <td className={`px-3 py-2.5 font-mono font-black ${isLong?'text-red-600':q.duration_sec>5?'text-orange-600':'text-emerald-600'}`}>
                      {q.duration_sec}s
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[10px] text-slate-400 max-w-[220px] truncate">{String(q.query||'').replace(/\s+/g,' ').slice(0,80)}</td>
                  </tr>
                );
              })}
              {active.length === 0 && (
                <tr><td colSpan={10} className="text-center py-10">
                  <CheckCircle2 size={28} className="mx-auto mb-2 text-emerald-300"/>
                  <p className="text-slate-400 text-[12px] font-semibold">No active queries — all systems idle</p>
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Backend breakdown */}
      {backends.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="bg-gradient-to-r from-slate-50 to-indigo-50/30 border-b border-slate-100 px-5 py-3 flex items-center gap-2">
            <Server size={14} className="text-slate-400"/>
            <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">All Backends by Type</h3>
          </div>
          <div className="p-5">
            <div className="flex flex-wrap gap-2">
              {backends.map((b,i) => (
                <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-50 border border-slate-100">
                  <span className="text-[11px] font-bold text-slate-600">{b.backend_type||'client backend'}</span>
                  {b.state && <span className="text-[10px] text-slate-400">({b.state})</span>}
                  <span className="text-[13px] font-black text-indigo-700">{b.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {modalQuery && <QueryAnalysisModal stmt={modalQuery} connId={connId} onClose={() => setModalQuery(null)} />}
    </div>
  );
}

function QueryAnalysisModal({ stmt, connId, onClose }) {
  const s = stmt;
  const [res, setRes] = React.useState({ loading: true });
  React.useEffect(() => {
    let alive = true;
    client.post(`/connections/postgresql/${connId}/pg-slow-queries/analyze-groq`, {
      sql_text: s.query, user_name: s.usename,
      calls: s.calls, mean_exec_time_ms: s.mean_exec_time, max_exec_time_ms: s.max_exec_time,
      total_exec_time_ms: s.total_exec_time, rows: s.rows,
      shared_blks_hit: s.shared_blks_hit, shared_blks_read: s.shared_blks_read,
      cache_hit_pct: s.cache_hit_pct,
    }).then(r => { if (alive) setRes({ loading: false, data: r.data?.analysis, err: r.data?.status === 'error' ? r.data.error : null }); })
      .catch(e => { if (alive) setRes({ loading: false, err: e?.response?.data?.detail || e.message }); });
    return () => { alive = false; };
  }, []);
  const stat = (l, v, warn) => (
    <div className="bg-white rounded-xl border border-slate-200 px-3 py-2">
      <p className="text-[9px] font-black text-slate-400 uppercase tracking-wide">{l}</p>
      <p className={`text-[13px] font-black mt-0.5 ${warn ? 'text-red-600' : 'text-slate-800'}`}>{v}</p>
    </div>
  );
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex sm:items-center sm:justify-center sm:p-6" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-white w-full h-full sm:h-[92vh] sm:max-w-4xl sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 bg-gradient-to-r from-slate-900 via-indigo-900 to-violet-900 text-white">
          <div className="flex items-center gap-2.5"><Zap size={20} className="text-violet-300" /><span className="font-black text-sm">Query Analysis · {s.usename || '—'} · db {s.dbid || '—'}</span></div>
          <button onClick={onClose} className="w-9 h-9 rounded-xl flex items-center justify-center text-white/70 hover:bg-white/15 text-2xl leading-none">×</button>
        </div>
        <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5 space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            {stat('Mean', `${(s.mean_exec_time || 0).toFixed(1)} ms`, s.mean_exec_time > 1000)}
            {stat('Max', `${(s.max_exec_time || 0).toFixed(1)} ms`, s.max_exec_time > 5000)}
            {stat('Total', `${(s.total_exec_time || 0).toFixed(0)} ms`)}
            {stat('Calls', (s.calls || 0).toLocaleString())}
            {stat('Rows/Call', (s.rows_per_call ?? 0).toFixed(1))}
            {stat('Cache Hit', `${s.cache_hit_pct ?? 0}%`, (s.cache_hit_pct ?? 100) < 80)}
            {stat('Blks Read', (s.shared_blks_read || 0).toLocaleString(), s.shared_blks_read > 10000)}
            {stat('Temp Blks', (s.temp_blks_read || 0).toLocaleString(), s.temp_blks_read > 0)}
          </div>
          <div>
            <p className="text-[9px] font-black text-slate-400 uppercase tracking-wide mb-1.5">SQL</p>
            <pre className="font-mono text-[11px] text-indigo-900 bg-white border border-indigo-200 rounded-xl p-3 max-h-44 overflow-auto whitespace-pre-wrap break-all">{s.query}</pre>
          </div>
          {res.loading
            ? <div className="flex items-center justify-center py-16 text-slate-400"><RefreshCw size={20} className="animate-spin mr-2" /> Analyzing with ActMon AI…</div>
            : <AiQueryAnalysis res={res} />}
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   ADVANCED TABLES TAB
══════════════════════════════════════════════════════════════════════════ */
const TABLE_VIEWS = [
  { id:'size',    label:'By Size',         sort:(a,b)=>b.total_bytes-a.total_bytes },
  { id:'bloat',   label:'Dead Tuples',     sort:(a,b)=>b.dead_pct-a.dead_pct },
  { id:'vacuum',  label:'Vacuum Needed',   sort:(a,b)=>b.n_dead_tup-a.n_dead_tup, filter: t=>t.needs_vacuum },
  { id:'cache',   label:'Low Cache Hit',   sort:(a,b)=>a.heap_cache_pct-b.heap_cache_pct },
  { id:'seqscan', label:'High Seq Scans',  sort:(a,b)=>b.seq_scan-a.seq_scan },
  { id:'hotrows', label:'DML Activity',    sort:(a,b)=>(b.n_tup_ins+b.n_tup_upd+b.n_tup_del)-(a.n_tup_ins+a.n_tup_upd+a.n_tup_del) },
];

function vacuumAgo(t) {
  const d = t.last_vacuum || t.last_autovacuum;
  if (!d) return null;
  const ms = Date.now() - new Date(d).getTime();
  const hours = Math.round(ms/3600000);
  if (hours < 1) return '<1h ago';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours/24)}d ago`;
}
function analyzeAgo(t) {
  const d = t.last_analyze || t.last_autoanalyze;
  if (!d) return null;
  const ms = Date.now() - new Date(d).getTime();
  const hours = Math.round(ms/3600000);
  if (hours < 1) return '<1h ago';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours/24)}d ago`;
}

/* ══════════════════════════════════════════════════════════════════════════
   TABLE DEEP-DIVE MODAL  — full right-panel with 6 tabs
══════════════════════════════════════════════════════════════════════════ */
function PgssEnablePanel({ connId, database, onEnabled }) {
  const [busy, setBusy] = React.useState(false);
  const [res, setRes] = React.useState(null);
  const enable = () => {
    setBusy(true);
    client.post(`/connections/postgresql/${connId}/enable-pg-stat-statements`, null, { params: { database } })
      .then((r) => { setRes(r.data); if (r.data?.status === 'success') setTimeout(onEnabled, 600); })
      .catch((e) => setRes({ status: 'error', message: e?.response?.data?.detail || e.message }))
      .finally(() => setBusy(false));
  };
  const ok = res?.status === 'success';
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6">
      <div className="flex items-start gap-4">
        <AlertTriangle size={20} className="text-amber-500 mt-0.5 flex-shrink-0" />
        <div className="flex-1">
          <p className="font-black text-amber-800 text-base">pg_stat_statements not enabled</p>
          <p className="text-[12px] text-amber-700 mt-1">Track per-query CPU/time/IO statistics for <b>{database}</b>. One-click enable:</p>
          {res && (
            <div className={`mt-2 text-[12px] rounded-lg px-3 py-2 ${ok ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-white text-slate-700 border border-amber-200'}`}>
              {res.message}
              {res.status === 'needs_restart' && (
                <pre className="mt-2 bg-slate-900 text-emerald-200 rounded-lg px-3 py-2 text-[11px] font-mono whitespace-pre-wrap">{`# 1) postgresql.conf:\nshared_preload_libraries = 'pg_stat_statements'\n# 2) restart PostgreSQL, then click Enable again`}</pre>
              )}
              {res.status === 'permission_denied' && (
                <pre className="mt-2 bg-slate-900 text-emerald-200 rounded-lg px-3 py-2 text-[11px] font-mono whitespace-pre-wrap">{`-- run as a superuser:\nCREATE EXTENSION IF NOT EXISTS pg_stat_statements;`}</pre>
              )}
            </div>
          )}
        </div>
        {!ok && (
          <button onClick={enable} disabled={busy}
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-[12px] font-bold disabled:opacity-60 flex-shrink-0">
            {busy ? <RefreshCw size={14} className="animate-spin" /> : <Zap size={14} />} Enable now
          </button>
        )}
      </div>
    </div>
  );
}

function TableDeepDiveModal({ connId, table, onClose }) {
  const key = `${table.database}/${table.schemaname}/${table.relname}`;
  const [tab, setTab] = React.useState('overview');

  const { data: str, isLoading: strLoad, isError: strError, refetch: refetchStr } = useQuery({
    queryKey: ['pgTableDeep', connId, key],
    queryFn:  () => client.get(`/connections/postgresql/${connId}/table-structure`, {
      params: { database: table.database, schema: table.schemaname, table: table.relname }
    }).then(r => r.data),
    staleTime: 60000,
    retry: 1,
  });

  const meta    = str?.table_meta     || {};
  const cols    = str?.columns        || [];
  const idxs    = str?.indexes        || table.indexes || [];
  const cons    = str?.constraints    || [];
  const trigs   = str?.triggers       || [];
  const parts   = str?.partitions     || [];
  const pInfo   = str?.partition_info || {};
  const cstats  = str?.col_stats      || [];
  const topQ    = str?.top_queries    || [];
  const slowQ   = str?.slow_queries   || [];
  const hasPgSS = str?.has_pg_stat_statements;
  const isPart  = meta.is_partitioned || pInfo.strategy;

  const totalBytes   = meta.total_bytes   || table.total_bytes   || 0;
  const heapBytes    = meta.heap_bytes    || table.heap_bytes    || 0;
  const indexBytes   = meta.indexes_bytes || table.indexes_bytes || 0;
  const toastBytes   = meta.toast_bytes   || 0;
  // Use meta.live_rows (from pg_stat_user_tables) when available — more accurate than reltuples
  const liveRows     = meta.live_rows != null ? meta.live_rows : (table.n_live_tup || 0);
  const estRows      = meta.est_rows  != null ? meta.est_rows  : (str?.row_count   || 0);
  const displayRows  = str?.row_count != null ? str.row_count : liveRows || estRows;
  const statsUpdated = meta.stats_uptodate != null ? meta.stats_uptodate : liveRows > 0;
  const deadRows     = table.n_dead_tup   || 0;
  const deadPct      = table.dead_pct     || 0;
  const unusedIdxs   = idxs.filter(ix => (parseInt(ix.idx_scan) || 0) === 0 && !ix.is_primary);

  const TABS = [
    { id:'overview',    label:'Overview',    icon: BarChart3 },
    { id:'structure',   label:'Structure',   icon: Layers },
    { id:'indexes',     label:`Indexes (${idxs.length})`, icon: Search },
    ...(isPart   ? [{ id:'partitions', label:`Partitions (${pInfo.count||parts.length})`, icon: GitBranch }] : []),
    { id:'queries',     label:'Queries',     icon: Activity },
    { id:'maintenance', label:'Maintenance', icon: RefreshCw },
  ];

  const TYPE_COLOR = {
    integer:'bg-blue-100 text-blue-700', bigint:'bg-blue-100 text-blue-700',
    smallint:'bg-blue-100 text-blue-700', numeric:'bg-indigo-100 text-indigo-700',
    'double precision':'bg-indigo-100 text-indigo-700', real:'bg-indigo-100 text-indigo-700',
    text:'bg-emerald-100 text-emerald-700', varchar:'bg-emerald-100 text-emerald-700',
    'character varying':'bg-emerald-100 text-emerald-700', char:'bg-emerald-100 text-emerald-700',
    boolean:'bg-yellow-100 text-yellow-700',
    date:'bg-orange-100 text-orange-700', timestamp:'bg-orange-100 text-orange-700',
    'timestamp without time zone':'bg-orange-100 text-orange-700',
    'timestamp with time zone':'bg-orange-100 text-orange-700',
    interval:'bg-orange-100 text-orange-700',
    uuid:'bg-violet-100 text-violet-700',
    json:'bg-rose-100 text-rose-700', jsonb:'bg-rose-100 text-rose-700',
    bytea:'bg-slate-100 text-slate-600', ARRAY:'bg-purple-100 text-purple-700',
  };
  const typeColor = dt => TYPE_COLOR[dt] || TYPE_COLOR[dt?.toLowerCase()] || 'bg-slate-100 text-slate-500';
  const CON_CLS   = {
    PRIMARY_KEY:'bg-amber-100 text-amber-700 border border-amber-300',
    UNIQUE:'bg-indigo-100 text-indigo-700 border border-indigo-200',
    FOREIGN_KEY:'bg-blue-100 text-blue-700 border border-blue-200',
    CHECK:'bg-purple-100 text-purple-700 border border-purple-200',
  };

  // Close on Escape
  React.useEffect(() => {
    const h = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex" style={{fontFamily:'inherit'}}>
      {/* backdrop */}
      <div className="flex-1 bg-black/40 cursor-pointer" onClick={onClose}/>

      {/* panel */}
      <div className="w-[78vw] max-w-[1300px] bg-[#f4f5fb] flex flex-col shadow-2xl border-l border-slate-200 overflow-hidden">

        {/* ── HEADER ── */}
        <div className="bg-gradient-to-r from-indigo-700 via-violet-700 to-purple-700 px-6 py-4 flex-shrink-0">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <div className="w-8 h-8 rounded-xl bg-white/20 flex items-center justify-center">
                  <Table size={15} className="text-white"/>
                </div>
                <h2 className="text-white font-black text-[22px] leading-tight truncate">{table.relname}</h2>
                {isPart && <span className="px-2 py-0.5 bg-white/20 text-white text-[10px] font-bold rounded-full border border-white/30">PARTITIONED</span>}
              </div>
              <p className="text-indigo-200 text-[12px] font-medium">
                {table.database} / {table.schemaname}
                {meta.table_comment && <span className="ml-2 text-white/60 italic">{meta.table_comment}</span>}
              </p>
            </div>
            <button onClick={onClose} className="w-8 h-8 rounded-xl bg-white/20 hover:bg-white/30 flex items-center justify-center text-white flex-shrink-0">
              <X size={14}/>
            </button>
          </div>

          {/* KPI row */}
          <div className="flex gap-3 mt-4 flex-wrap">
            {[
              { label: liveRows > 0 ? 'Live Rows' : estRows > 0 ? 'Est. Rows' : 'Rows',
                value: fmtNum(displayRows),
                note: !statsUpdated && displayRows === 0 ? '!' : null },
              { label:'Total Size',   value: meta.total_size || table.total_size || fmtBytes(totalBytes) },
              { label:'Heap Size',    value: meta.heap_size  || table.heap_size  || fmtBytes(heapBytes) },
              { label:'Index Size',   value: meta.indexes_size || table.indexes_size || fmtBytes(indexBytes) },
              ...(toastBytes > 0 ? [{ label:'TOAST', value: meta.toast_size || fmtBytes(toastBytes) }] : []),
              { label:'Dead Rows',    value: fmtNum(deadRows), warn: deadPct > 20 },
              { label:'Dead %',       value: `${deadPct}%`,   warn: deadPct > 20 },
              { label:'Indexes',      value: idxs.length },
              { label:'Columns',      value: cols.length || '…' },
            ].map(k => (
              <div key={k.label} className="bg-white/10 backdrop-blur-sm rounded-xl px-3 py-2 border border-white/20 min-w-[80px]">
                <p className={`text-[15px] font-black ${k.warn ? 'text-red-300' : 'text-white'} flex items-center gap-1`}>
                  {k.value}
                  {k.note && <span className="text-amber-300 text-[11px]">⚠</span>}
                </p>
                <p className="text-[9px] text-indigo-200 font-medium uppercase tracking-wide">{k.label}</p>
              </div>
            ))}
          </div>
        </div>

        {/* ── TAB BAR ── */}
        <div className="bg-white border-b border-slate-200 px-5 flex gap-1 py-2.5 flex-shrink-0 overflow-x-auto">
          {TABS.map(t => {
            const Icon = t.icon;
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-bold border whitespace-nowrap transition-all
                  ${tab === t.id
                    ? 'border-indigo-400 bg-indigo-50 text-indigo-700'
                    : 'border-transparent text-slate-500 hover:bg-slate-50 hover:border-slate-200'}`}>
                <Icon size={12}/>
                {t.label}
              </button>
            );
          })}
        </div>

        {/* ── CONTENT ── */}
        <div className="flex-1 overflow-y-auto">
          {strError ? (
            <div className="p-6">
              <div className="bg-red-50 border border-red-200 rounded-2xl p-6 flex items-start gap-4">
                <AlertTriangle size={20} className="text-red-500 mt-0.5 flex-shrink-0"/>
                <div className="flex-1">
                  <p className="font-black text-red-800 text-base mb-1">Failed to load table details</p>
                  <p className="text-[12px] text-red-600">The backend returned an error. Check that the database connection is active and the user has SELECT permissions on system catalogs.</p>
                  <button onClick={refetchStr} className="mt-3 px-4 py-2 bg-red-100 hover:bg-red-200 text-red-700 rounded-xl text-[12px] font-bold transition-colors flex items-center gap-2">
                    <RefreshCw size={12}/> Retry
                  </button>
                </div>
              </div>
            </div>
          ) : strLoad ? (
            <div className="flex items-center justify-center py-32">
              <div className="text-center">
                <div className="w-12 h-12 border-4 border-indigo-200 border-t-indigo-500 rounded-full animate-spin mx-auto mb-4"/>
                <p className="text-slate-500 font-semibold text-sm">Loading table details…</p>
              </div>
            </div>
          ) : (

          <div className="p-6 space-y-5">

          {/* ══ OVERVIEW ══ */}
          {tab === 'overview' && (<>

            {/* Size breakdown */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="bg-gradient-to-r from-violet-50 to-indigo-50/30 border-b border-slate-100 px-5 py-3 flex items-center gap-2">
                <HardDrive size={13} className="text-violet-500"/>
                <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">Storage</h3>
              </div>
              <div className="p-5">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                  {[
                    { label:'Total',   bytes: totalBytes,  color:'bg-violet-500' },
                    { label:'Heap',    bytes: heapBytes,   color:'bg-indigo-400' },
                    { label:'Indexes', bytes: indexBytes,  color:'bg-blue-400' },
                    { label:'TOAST',   bytes: toastBytes,  color:'bg-slate-300' },
                  ].map(s => (
                    <div key={s.label} className="text-center p-3 rounded-xl bg-slate-50 border border-slate-100">
                      <div className={`w-3 h-3 rounded-full ${s.color} mx-auto mb-1.5`}/>
                      <p className="text-[16px] font-black text-slate-900">{fmtBytes(s.bytes)}</p>
                      <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wide">{s.label}</p>
                    </div>
                  ))}
                </div>
                {/* Visual bar */}
                {totalBytes > 0 && (
                  <div className="h-4 bg-slate-100 rounded-full overflow-hidden flex">
                    {heapBytes  > 0 && <div className="bg-indigo-400 h-full" style={{width:`${Math.round(heapBytes/totalBytes*100)}%`}} title={`Heap: ${fmtBytes(heapBytes)}`}/>}
                    {indexBytes > 0 && <div className="bg-blue-400 h-full"   style={{width:`${Math.round(indexBytes/totalBytes*100)}%`}} title={`Indexes: ${fmtBytes(indexBytes)}`}/>}
                    {toastBytes > 0 && <div className="bg-slate-300 h-full"  style={{width:`${Math.round(toastBytes/totalBytes*100)}%`}} title={`TOAST: ${fmtBytes(toastBytes)}`}/>}
                  </div>
                )}
                {/* Storage options */}
                {(meta.storage_options||[]).length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wide self-center">Storage opts:</span>
                    {(meta.storage_options||[]).map((o,i) => (
                      <span key={i} className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded-lg text-[10px] font-mono font-bold">
                        {o.key}={o.value}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Row stats + Activity */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">

              {/* Row stats */}
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="bg-gradient-to-r from-emerald-50 to-teal-50/30 border-b border-slate-100 px-5 py-3 flex items-center gap-2">
                  <Database size={13} className="text-emerald-500"/>
                  <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">Row Statistics</h3>
                </div>
                <div className="p-5 space-y-3">
                  {[
                    { label: liveRows > 0 ? 'Live Rows (pg_stat)' : 'Est. Rows (reltuples)',
                      value: fmtNum(displayRows),
                      color: liveRows > 0 ? 'text-emerald-600' : 'text-amber-600' },
                    { label:'Dead Rows',       value: fmtNum(deadRows),  color: deadRows>1000?'text-red-600':'text-slate-700' },
                    { label:'Dead Tuple %',    value: `${deadPct}%`,     color: deadPct>20?'text-red-600':'text-slate-700' },
                    { label:'Est. Rows (pg_class)', value: fmtNum(estRows || (str?.row_count||0)), color:'text-slate-500' },
                  ].map(kv => (
                    <div key={kv.label} className="flex items-center justify-between">
                      <span className="text-[11px] text-slate-500 font-medium">{kv.label}</span>
                      <span className={`text-[13px] font-black font-mono ${kv.color}`}>{kv.value}</span>
                    </div>
                  ))}
                  {!statsUpdated && (
                    <div className="px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-[11px] text-amber-700 flex items-start gap-2">
                      <AlertTriangle size={12} className="mt-0.5 flex-shrink-0"/>
                      <span>Statistics not yet collected. Row counts may show 0. Run <code className="bg-amber-100 px-1 rounded font-mono">ANALYZE {table.relname};</code> to update.</span>
                    </div>
                  )}
                  {/* bloat bar */}
                  <div>
                    <div className="flex justify-between mb-1">
                      <span className="text-[9px] text-slate-400 font-bold uppercase tracking-wide">Bloat</span>
                      <span className={`text-[10px] font-bold ${deadPct>20?'text-red-600':deadPct>10?'text-orange-500':'text-emerald-600'}`}>{deadPct}%</span>
                    </div>
                    <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${deadPct>20?'bg-red-400':deadPct>10?'bg-orange-400':'bg-emerald-400'}`}
                           style={{width:`${Math.min(100,deadPct)}%`}}/>
                    </div>
                  </div>
                </div>
              </div>

              {/* Scan activity */}
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="bg-gradient-to-r from-blue-50 to-indigo-50/30 border-b border-slate-100 px-5 py-3 flex items-center gap-2">
                  <Activity size={13} className="text-blue-500"/>
                  <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">Scan Activity</h3>
                </div>
                <div className="p-5 space-y-3">
                  {[
                    { label:'Sequential Scans', value: fmtNum(table.seq_scan),     warn: table.seq_scan > 1000 && table.idx_scan_pct < 50 },
                    { label:'Index Scans',       value: fmtNum(table.idx_scan) },
                    { label:'Index Scan %',      value: `${table.idx_scan_pct||0}%`, ok: (table.idx_scan_pct||0) >= 80 },
                    { label:'Cache Hit %',       value: `${table.heap_cache_pct||0}%`, ok: (table.heap_cache_pct||0) >= 95 },
                    { label:'Heap Blks Read',    value: fmtNum(table.heap_blks_read), warn: table.heap_blks_read > 5000 },
                    { label:'Idx Blks Read',     value: fmtNum(table.idx_blks_read) },
                  ].map(kv => (
                    <div key={kv.label} className="flex items-center justify-between">
                      <span className="text-[11px] text-slate-500 font-medium">{kv.label}</span>
                      <span className={`text-[13px] font-black font-mono ${kv.warn?'text-red-600':kv.ok?'text-emerald-600':'text-slate-700'}`}>{kv.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* DML Activity */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="bg-gradient-to-r from-orange-50 to-amber-50/30 border-b border-slate-100 px-5 py-3 flex items-center gap-2">
                <Pencil size={13} className="text-orange-500"/>
                <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">DML Activity</h3>
              </div>
              <div className="p-5 grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { label:'Inserts',      value: fmtNum(table.n_tup_ins),     color:'text-emerald-600' },
                  { label:'Updates',      value: fmtNum(table.n_tup_upd),     color:'text-blue-600' },
                  { label:'HOT Updates',  value: fmtNum(table.n_tup_hot_upd), color:'text-cyan-600' },
                  { label:'Deletes',      value: fmtNum(table.n_tup_del),     color:'text-red-500' },
                ].map(kv => (
                  <div key={kv.label} className="text-center p-3 rounded-xl bg-slate-50 border border-slate-100">
                    <p className={`text-[20px] font-black ${kv.color}`}>{kv.value}</p>
                    <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wide mt-0.5">{kv.label}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Unused index warning */}
            {unusedIdxs.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-start gap-3">
                <AlertTriangle size={15} className="text-amber-500 mt-0.5 flex-shrink-0"/>
                <div>
                  <p className="font-black text-amber-800 text-[13px]">
                    {unusedIdxs.length} unused index{unusedIdxs.length > 1 ? 'es' : ''} detected
                  </p>
                  <p className="text-[11px] text-amber-700 mt-0.5">
                    {unusedIdxs.map(ix => ix.index_name || ix.indexname).join(', ')} — consider dropping these to save space and reduce write overhead.
                  </p>
                </div>
              </div>
            )}

          </>)}

          {/* ══ STRUCTURE ══ */}
          {tab === 'structure' && (<>

            {/* Columns table */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="bg-gradient-to-r from-indigo-50 to-slate-50 border-b border-slate-100 px-5 py-3 flex items-center gap-2">
                <Layers size={13} className="text-indigo-500"/>
                <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">Columns ({cols.length})</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      {['#','Column','Type','Nullable','Default','Identity','Comment'].map(h => (
                        <th key={h} className="px-3 py-2.5 text-left text-[9px] font-black text-slate-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {cols.map((col, ci) => {
                      const cs = cstats.find(s => s.column_name === col.column_name);
                      return (
                        <tr key={ci} className="border-t border-slate-100 hover:bg-indigo-50/20">
                          <td className="px-3 py-2.5 text-slate-400 font-mono text-[10px]">{col.ordinal_position}</td>
                          <td className="px-3 py-2.5">
                            <div className="font-bold text-slate-800 font-mono">{col.column_name}</div>
                            {cs && cs.null_frac > 0 && (
                              <div className="text-[9px] text-slate-400 mt-0.5">
                                null: {Math.round(cs.null_frac * 100)}%
                                {cs.n_distinct !== 0 && <span className="ml-2">distinct: {cs.n_distinct < 0 ? `${Math.round(-cs.n_distinct*100)}%` : fmtNum(cs.n_distinct)}</span>}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2.5">
                            <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${typeColor(col.data_type)}`}>
                              {col.udt_name || col.data_type}
                              {col.character_maximum_length ? `(${col.character_maximum_length})` :
                               col.numeric_precision ? `(${col.numeric_precision}${col.numeric_scale ? ','+col.numeric_scale : ''})` : ''}
                            </span>
                          </td>
                          <td className="px-3 py-2.5">
                            <span className={`text-[10px] font-bold ${col.is_nullable === 'YES' ? 'text-slate-400' : 'text-red-600'}`}>
                              {col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 font-mono text-[10px] text-slate-400 max-w-[160px] truncate" title={col.column_default}>
                            {col.column_default || '—'}
                          </td>
                          <td className="px-3 py-2.5 text-[10px] text-slate-500">
                            {col.is_identity === 'YES'
                              ? <span className="px-1.5 py-0.5 bg-violet-100 text-violet-700 rounded font-bold text-[9px]">{col.identity_generation}</span>
                              : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-[10px] text-slate-400 italic max-w-[180px] truncate" title={col.column_comment}>
                            {col.column_comment || '—'}
                          </td>
                        </tr>
                      );
                    })}
                    {cols.length === 0 && (
                      <tr><td colSpan={7} className="py-10 text-center text-slate-400 font-medium">No column data available</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Constraints */}
            {cons.length > 0 && (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="bg-gradient-to-r from-amber-50 to-slate-50 border-b border-slate-100 px-5 py-3 flex items-center gap-2">
                  <Shield size={13} className="text-amber-500"/>
                  <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">Constraints ({cons.length})</h3>
                </div>
                <div className="p-5">
                  <div className="overflow-x-auto">
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="border-b border-slate-100">
                          {['Type','Name','Columns','References','On Update','On Delete'].map(h => (
                            <th key={h} className="px-3 py-2 text-left text-[9px] font-black text-slate-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {cons.map((c, ci) => (
                          <tr key={ci} className="border-t border-slate-50 hover:bg-slate-50/50">
                            <td className="px-3 py-2">
                              <span className={`px-2 py-0.5 rounded-full text-[9px] font-black ${CON_CLS[c.constraint_type] || 'bg-slate-100 text-slate-600 border border-slate-200'}`}>
                                {c.constraint_type}
                              </span>
                            </td>
                            <td className="px-3 py-2 font-mono font-bold text-slate-800">{c.constraint_name}</td>
                            <td className="px-3 py-2 font-mono text-slate-600">{c.columns || '—'}</td>
                            <td className="px-3 py-2 text-slate-500">
                              {c.foreign_table ? <span className="font-mono text-blue-600">{c.foreign_table}.{c.foreign_column}</span> : '—'}
                            </td>
                            <td className="px-3 py-2 text-slate-400">{c.update_rule || '—'}</td>
                            <td className="px-3 py-2 text-slate-400">{c.delete_rule || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* Triggers */}
            {trigs.length > 0 && (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="bg-gradient-to-r from-purple-50 to-slate-50 border-b border-slate-100 px-5 py-3 flex items-center gap-2">
                  <Zap size={13} className="text-purple-500"/>
                  <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">Triggers ({trigs.length})</h3>
                </div>
                <div className="p-4 space-y-2">
                  {trigs.map((tg, ti) => (
                    <div key={ti} className="flex items-start gap-3 px-4 py-3 rounded-xl bg-slate-50 border border-slate-100">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="font-bold text-slate-800 text-[12px]">{tg.trigger_name}</span>
                          <span className="px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 text-[9px] font-black">{tg.action_timing} {tg.event_manipulation}</span>
                          <span className="px-2 py-0.5 rounded-full bg-slate-200 text-slate-600 text-[9px] font-bold">{tg.action_orientation}</span>
                        </div>
                        {tg.action_statement && (
                          <pre className="text-[10px] font-mono text-slate-500 bg-white rounded-lg px-3 py-2 mt-1 overflow-x-auto border border-slate-100">
                            {tg.action_statement}
                          </pre>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

          </>)}

          {/* ══ INDEXES ══ */}
          {tab === 'indexes' && (<>

            {unusedIdxs.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-start gap-3">
                <AlertTriangle size={14} className="text-amber-500 mt-0.5"/>
                <p className="text-[12px] text-amber-800">
                  <strong>{unusedIdxs.length} unused index{unusedIdxs.length > 1 ? 'es' : ''}</strong> —
                  zero scans since last stats reset. Consider <code className="bg-amber-100 px-1 rounded text-[11px]">DROP INDEX</code> to reclaim disk space.
                </p>
              </div>
            )}

            <div className="space-y-3">
              {idxs.map((ix, ii) => {
                const scans   = parseInt(ix.idx_scan) || 0;
                const unused  = scans === 0 && !ix.is_primary;
                const idxType = ix.index_def ? ix.index_def.match(/USING (\w+)/i)?.[1]?.toUpperCase() || 'BTREE' : 'BTREE';
                return (
                  <div key={ii} className={`bg-white rounded-2xl border-2 overflow-hidden shadow-sm ${
                    ix.is_primary ? 'border-amber-200' :
                    ix.is_unique  ? 'border-indigo-200' :
                    unused        ? 'border-red-200'   : 'border-slate-200'}`}>
                    <div className={`px-5 py-4 flex items-start justify-between gap-3 ${
                      ix.is_primary ? 'bg-amber-50' :
                      ix.is_unique  ? 'bg-indigo-50/40' :
                      unused        ? 'bg-red-50'    : 'bg-slate-50/50'}`}>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="font-mono font-black text-slate-800 text-[13px]">{ix.index_name || ix.indexname}</span>
                          {ix.is_primary && <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[9px] font-black border border-amber-300">PK</span>}
                          {ix.is_unique && !ix.is_primary && <span className="px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-[9px] font-black border border-indigo-200">UNIQUE</span>}
                          {ix.is_clustered && <span className="px-2 py-0.5 rounded-full bg-teal-100 text-teal-700 text-[9px] font-black">CLUSTER</span>}
                          {!ix.is_valid && <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-[9px] font-black">INVALID</span>}
                          {unused && <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-600 text-[9px] font-black border border-red-200">UNUSED</span>}
                          <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[9px] font-bold">{idxType}</span>
                        </div>
                        {ix.columns && (
                          <p className="text-[11px] text-slate-500 font-mono">
                            Columns: <span className="font-bold text-slate-700">{ix.columns}</span>
                          </p>
                        )}
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-[14px] font-black text-slate-700 font-mono">{ix.index_size || '—'}</p>
                        <p className="text-[9px] text-slate-400 font-bold">SIZE</p>
                      </div>
                    </div>

                    <div className="px-5 py-3 border-t border-slate-100">
                      {ix.index_def && (
                        <pre className="font-mono text-[10px] text-slate-500 bg-slate-50 rounded-lg px-3 py-2 overflow-x-auto mb-3 border border-slate-100">{ix.index_def}</pre>
                      )}
                      <div className="flex gap-6 text-[11px]">
                        <div>
                          <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wide mb-0.5">Scans</p>
                          <p className={`font-black text-[14px] font-mono ${unused ? 'text-red-600' : 'text-emerald-600'}`}>{fmtNum(scans)}</p>
                        </div>
                        <div>
                          <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wide mb-0.5">Rows Read</p>
                          <p className="font-black text-[14px] font-mono text-slate-700">{fmtNum(ix.idx_tup_read || 0)}</p>
                        </div>
                        <div>
                          <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wide mb-0.5">Rows Fetched</p>
                          <p className="font-black text-[14px] font-mono text-slate-700">{fmtNum(ix.idx_tup_fetch || 0)}</p>
                        </div>
                        {ix.index_bytes > 0 && (
                          <div>
                            <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wide mb-0.5">Size Bytes</p>
                            <p className="font-black text-[12px] font-mono text-slate-500">{fmtNum(ix.index_bytes)}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {idxs.length === 0 && (
                <div className="bg-white rounded-2xl border border-dashed border-slate-300 py-16 text-center">
                  <Search size={28} className="text-slate-300 mx-auto mb-3"/>
                  <p className="font-bold text-slate-500">No indexes on this table</p>
                  <p className="text-slate-400 text-sm mt-1">Consider adding indexes on frequently-queried columns.</p>
                </div>
              )}
            </div>

          </>)}

          {/* ══ PARTITIONS ══ */}
          {tab === 'partitions' && (<>

            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="bg-gradient-to-r from-teal-50 to-slate-50 border-b border-slate-100 px-5 py-3 flex items-center gap-3">
                <GitBranch size={13} className="text-teal-500"/>
                <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">Partition Strategy</h3>
              </div>
              <div className="p-5 flex gap-8">
                <div>
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide mb-1">Strategy</p>
                  <span className="px-3 py-1.5 bg-teal-100 text-teal-700 rounded-xl text-[13px] font-black">{pInfo.strategy || '—'}</span>
                </div>
                <div>
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide mb-1">Partition Key</p>
                  <span className="px-3 py-1.5 bg-slate-100 text-slate-700 rounded-xl text-[12px] font-mono font-bold">{pInfo.partition_key || '—'}</span>
                </div>
                <div>
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide mb-1">Total Partitions</p>
                  <span className="text-[20px] font-black text-slate-900">{pInfo.count || parts.length}</span>
                </div>
              </div>
            </div>

            {parts.length > 0 && (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="bg-gradient-to-r from-teal-50 to-slate-50 border-b border-slate-100 px-5 py-3 flex items-center gap-2">
                  <Layers size={13} className="text-teal-500"/>
                  <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">Partitions ({parts.length})</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200">
                        {['Partition','Schema','Bound','Size','Live Rows','Dead Rows'].map(h => (
                          <th key={h} className="px-4 py-2.5 text-left text-[9px] font-black text-slate-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {parts.map((p, pi) => {
                        const maxPB = Math.max(...parts.map(x => x.total_bytes || 0), 1);
                        const pct   = Math.round((p.total_bytes / maxPB) * 100);
                        return (
                          <tr key={pi} className="border-t border-slate-100 hover:bg-teal-50/20">
                            <td className="px-4 py-3 font-mono font-bold text-slate-800">{p.partition_name}</td>
                            <td className="px-4 py-3 text-slate-500">{p.schema_name}</td>
                            <td className="px-4 py-3 font-mono text-[10px] text-slate-600 max-w-[200px] truncate" title={p.partition_bound}>{p.partition_bound}</td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                  <div className="h-full bg-teal-400 rounded-full" style={{width:`${pct}%`}}/>
                                </div>
                                <span className="font-bold text-slate-700">{p.total_size}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3 font-mono text-emerald-600 font-bold">{fmtNum(p.n_live_tup)}</td>
                            <td className="px-4 py-3 font-mono text-red-500 font-bold">{fmtNum(p.n_dead_tup)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

          </>)}

          {/* ══ QUERIES ══ */}
          {tab === 'queries' && (<>

            {!hasPgSS ? (
              <PgssEnablePanel connId={connId} database={table.database} onEnabled={refetchStr} />
            ) : topQ.length === 0 && slowQ.length === 0 ? (
              <div className="bg-white rounded-2xl border border-dashed border-slate-300 py-16 text-center">
                <Activity size={28} className="text-slate-300 mx-auto mb-3"/>
                <p className="font-bold text-slate-500">No query data found for this table</p>
                <p className="text-slate-400 text-sm mt-1">Table may not have been queried since the last stats reset.</p>
              </div>
            ) : (<>

              {/* Top queries by calls */}
              {topQ.length > 0 && (
                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="bg-gradient-to-r from-blue-50 to-slate-50 border-b border-slate-100 px-5 py-3 flex items-center gap-2">
                    <BarChart3 size={13} className="text-blue-500"/>
                    <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">Top Queries by Frequency</h3>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {topQ.map((q, qi) => (
                      <div key={qi} className="px-5 py-4">
                        <div className="flex items-center gap-3 mb-2 flex-wrap">
                          <span className="w-5 h-5 rounded-full bg-blue-100 text-blue-700 text-[10px] font-black flex items-center justify-center flex-shrink-0">{qi+1}</span>
                          <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded-lg text-[10px] font-black">{fmtNum(q.calls)} calls</span>
                          <span className="px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded-lg text-[10px] font-black">{q.mean_time_ms.toFixed(1)} ms avg</span>
                          <span className="px-2 py-0.5 bg-violet-100 text-violet-700 rounded-lg text-[10px] font-black">{q.total_time_ms.toFixed(0)} ms total</span>
                          <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded-lg text-[10px] font-black">{fmtNum(q.rows)} rows</span>
                          {q.cache_hit_pct > 0 && <span className={`px-2 py-0.5 rounded-lg text-[10px] font-black ${q.cache_hit_pct>=90?'bg-emerald-100 text-emerald-700':'bg-orange-100 text-orange-700'}`}>{q.cache_hit_pct.toFixed(0)}% cache</span>}
                        </div>
                        <pre className="font-mono text-[11px] text-slate-600 bg-slate-50 rounded-xl px-4 py-3 overflow-x-auto border border-slate-100 whitespace-pre-wrap break-all">
                          {q.query_text}
                        </pre>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Slow queries by mean time */}
              {slowQ.length > 0 && (
                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="bg-gradient-to-r from-red-50 to-slate-50 border-b border-slate-100 px-5 py-3 flex items-center gap-2">
                    <Clock size={13} className="text-red-500"/>
                    <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">Slowest Queries by Mean Time</h3>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {slowQ.map((q, qi) => (
                      <div key={qi} className="px-5 py-4">
                        <div className="flex items-center gap-3 mb-2 flex-wrap">
                          <span className="w-5 h-5 rounded-full bg-red-100 text-red-700 text-[10px] font-black flex items-center justify-center flex-shrink-0">{qi+1}</span>
                          <span className={`px-2 py-0.5 rounded-lg text-[10px] font-black ${q.mean_time_ms>1000?'bg-red-100 text-red-700':q.mean_time_ms>100?'bg-orange-100 text-orange-700':'bg-yellow-100 text-yellow-700'}`}>
                            {q.mean_time_ms >= 1000 ? `${(q.mean_time_ms/1000).toFixed(2)}s` : `${q.mean_time_ms.toFixed(1)}ms`} avg
                          </span>
                          <span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded-lg text-[10px] font-black">{fmtNum(q.calls)} calls</span>
                          {q.stddev_ms > 0 && <span className="px-2 py-0.5 bg-slate-100 text-slate-500 rounded-lg text-[10px] font-medium">±{q.stddev_ms.toFixed(1)}ms σ</span>}
                        </div>
                        <pre className="font-mono text-[11px] text-slate-600 bg-slate-50 rounded-xl px-4 py-3 overflow-x-auto border border-slate-100 whitespace-pre-wrap break-all">
                          {q.query_text}
                        </pre>
                      </div>
                    ))}
                  </div>
                </div>
              )}

            </>)}

          </>)}

          {/* ══ MAINTENANCE ══ */}
          {tab === 'maintenance' && (<>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">

              {/* Vacuum history */}
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="bg-gradient-to-r from-orange-50 to-amber-50/30 border-b border-slate-100 px-5 py-3 flex items-center gap-2">
                  <RefreshCw size={13} className="text-orange-500"/>
                  <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">Vacuum History</h3>
                </div>
                <div className="p-5 space-y-3">
                  {[
                    { label:'Last Manual Vacuum',   value: table.last_vacuum?.slice(0,19)||'Never',   warn: !table.last_vacuum },
                    { label:'Last Autovacuum',       value: table.last_autovacuum?.slice(0,19)||'Never' },
                    { label:'Manual Vacuum Count',   value: table.vacuum_count ?? '—' },
                    { label:'Autovacuum Count',      value: table.autovacuum_count ?? '—' },
                  ].map(kv => (
                    <div key={kv.label} className="flex items-center justify-between">
                      <span className="text-[11px] text-slate-500 font-medium">{kv.label}</span>
                      <span className={`text-[12px] font-bold font-mono ${kv.warn ? 'text-red-600' : 'text-slate-700'}`}>{kv.value}</span>
                    </div>
                  ))}
                  {table.needs_vacuum && (
                    <div className="mt-2 px-3 py-2 rounded-xl bg-orange-50 border border-orange-200 text-[11px] text-orange-700 font-bold flex items-center gap-2">
                      <AlertTriangle size={12}/>
                      VACUUM RECOMMENDED — high dead tuple count
                    </div>
                  )}
                </div>
              </div>

              {/* Analyze history */}
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="bg-gradient-to-r from-yellow-50 to-amber-50/30 border-b border-slate-100 px-5 py-3 flex items-center gap-2">
                  <Search size={13} className="text-yellow-600"/>
                  <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">Analyze History</h3>
                </div>
                <div className="p-5 space-y-3">
                  {[
                    { label:'Last Manual Analyze',  value: table.last_analyze?.slice(0,19)||'Never', warn: !table.last_analyze },
                    { label:'Last Autoanalyze',      value: table.last_autoanalyze?.slice(0,19)||'Never' },
                    { label:'Analyze Count',         value: table.analyze_count ?? '—' },
                    { label:'Autoanalyze Count',     value: table.autoanalyze_count ?? '—' },
                    { label:'Mod Since Analyze',     value: fmtNum(table.n_mod_since_analyze), warn: table.needs_analyze },
                  ].map(kv => (
                    <div key={kv.label} className="flex items-center justify-between">
                      <span className="text-[11px] text-slate-500 font-medium">{kv.label}</span>
                      <span className={`text-[12px] font-bold font-mono ${kv.warn ? 'text-orange-600' : 'text-slate-700'}`}>{kv.value}</span>
                    </div>
                  ))}
                  {table.needs_analyze && (
                    <div className="mt-2 px-3 py-2 rounded-xl bg-yellow-50 border border-yellow-200 text-[11px] text-yellow-700 font-bold flex items-center gap-2">
                      <AlertTriangle size={12}/>
                      ANALYZE RECOMMENDED — statistics are stale
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Table-level storage options */}
            {(meta.storage_options || []).length > 0 && (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="bg-gradient-to-r from-slate-50 to-indigo-50/30 border-b border-slate-100 px-5 py-3 flex items-center gap-2">
                  <Settings size={13} className="text-slate-500"/>
                  <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">Table Storage Options</h3>
                </div>
                <div className="p-5 grid grid-cols-2 md:grid-cols-3 gap-4">
                  {(meta.storage_options || []).map((opt, oi) => (
                    <div key={oi}>
                      <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide mb-0.5">{opt.key}</p>
                      <span className="px-2 py-0.5 bg-slate-100 text-slate-700 rounded-lg text-[11px] font-mono font-bold">{opt.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

          </>)}

          </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TableDetailPane({ connId, table }) {
  const key = `${table.database}/${table.schemaname}/${table.relname}`;
  const [detailTab, setDetailTab] = React.useState('stats');

  const { data: str, isLoading: strLoading } = useQuery({
    queryKey: ['pgTableStr', connId, key],
    queryFn:  () => client.get(`/connections/postgresql/${connId}/table-structure`, {
      params: { database: table.database, schema: table.schemaname, table: table.relname }
    }).then(r => r.data),
    enabled:  detailTab === 'structure' || detailTab === 'indexes',
    staleTime: 60000,
  });

  const DETAIL_TABS = [
    { id:'stats',      label:'Stats' },
    { id:'structure',  label:'Structure' },
    { id:'indexes',    label:`Indexes (${table.index_count||0})` },
    { id:'io',         label:'I/O' },
    { id:'vacuum',     label:'Vacuum' },
  ];

  const TYPE_COLOR = {
    integer:'bg-blue-100 text-blue-700', bigint:'bg-blue-100 text-blue-700',
    smallint:'bg-blue-100 text-blue-700', numeric:'bg-indigo-100 text-indigo-700',
    'double precision':'bg-indigo-100 text-indigo-700', real:'bg-indigo-100 text-indigo-700',
    text:'bg-emerald-100 text-emerald-700', varchar:'bg-emerald-100 text-emerald-700',
    'character varying':'bg-emerald-100 text-emerald-700', char:'bg-emerald-100 text-emerald-700',
    boolean:'bg-yellow-100 text-yellow-700',
    date:'bg-orange-100 text-orange-700', timestamp:'bg-orange-100 text-orange-700',
    'timestamp without time zone':'bg-orange-100 text-orange-700',
    'timestamp with time zone':'bg-orange-100 text-orange-700', interval:'bg-orange-100 text-orange-700',
    uuid:'bg-violet-100 text-violet-700', json:'bg-rose-100 text-rose-700', jsonb:'bg-rose-100 text-rose-700',
    bytea:'bg-slate-100 text-slate-600', ARRAY:'bg-purple-100 text-purple-700',
  };
  function typeColor(dt) { return TYPE_COLOR[dt] || TYPE_COLOR[dt?.toLowerCase()] || 'bg-slate-100 text-slate-500'; }

  const CON_CLS = { PRIMARY_KEY:'bg-amber-100 text-amber-700 border border-amber-300', UNIQUE:'bg-indigo-100 text-indigo-700 border border-indigo-200', FOREIGN_KEY:'bg-blue-100 text-blue-700 border border-blue-200', CHECK:'bg-purple-100 text-purple-700 border border-purple-200' };

  return (
    <div>
      {/* Tab strip */}
      <div className="flex gap-1 mb-3">
        {DETAIL_TABS.map(t => (
          <button key={t.id} onClick={() => setDetailTab(t.id)}
            className={`h-7 px-3 rounded-lg text-[11px] font-bold border transition-all
              ${detailTab===t.id?'border-indigo-400 bg-indigo-50 text-indigo-700':'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* STATS */}
      {detailTab === 'stats' && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {[
            { label:'Live Rows',       value: fmtNum(table.n_live_tup) },
            { label:'Dead Rows',       value: fmtNum(table.n_dead_tup),  warn: table.n_dead_tup>1000 },
            { label:'Dead %',          value: `${table.dead_pct}%`,       warn: table.dead_pct>20 },
            { label:'Seq Scans',       value: fmtNum(table.seq_scan) },
            { label:'Index Scans',     value: fmtNum(table.idx_scan) },
            { label:'Index Scan %',    value: `${table.idx_scan_pct}%` },
            { label:'Inserts',         value: fmtNum(table.n_tup_ins) },
            { label:'Updates',         value: fmtNum(table.n_tup_upd) },
            { label:'HOT Updates',     value: fmtNum(table.n_tup_hot_upd) },
            { label:'Deletes',         value: fmtNum(table.n_tup_del) },
            { label:'Heap Size',       value: table.heap_size||'—' },
            { label:'Index Size',      value: table.indexes_size||'—' },
          ].map(kv => (
            <div key={kv.label} className="bg-white rounded-xl border border-slate-100 p-3 flex justify-between items-center">
              <span className="text-[10px] text-slate-500 font-medium">{kv.label}</span>
              <span className={`text-[12px] font-black font-mono ${kv.warn?'text-red-600':'text-slate-800'}`}>{kv.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* STRUCTURE */}
      {detailTab === 'structure' && (
        strLoading ? <div className="py-6 text-center text-[12px] text-slate-400">Loading structure…</div> :
        <div>
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  {['#','Column','Type','Nullable','Default','Comment'].map(h=>(
                    <th key={h} className="px-3 py-2 text-left text-[9px] font-black text-slate-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(str?.columns||[]).map((col, ci) => (
                  <tr key={ci} className="border-t border-slate-100 hover:bg-indigo-50/20">
                    <td className="px-3 py-2 text-slate-400 font-mono text-[10px]">{col.ordinal_position}</td>
                    <td className="px-3 py-2 font-bold text-slate-800 font-mono">{col.column_name}</td>
                    <td className="px-3 py-2">
                      <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${typeColor(col.data_type)}`}>
                        {col.udt_name || col.data_type}
                        {col.character_maximum_length ? `(${col.character_maximum_length})` :
                         col.numeric_precision ? `(${col.numeric_precision}${col.numeric_scale?','+col.numeric_scale:''})` : ''}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`text-[10px] font-bold ${col.is_nullable==='YES'?'text-slate-400':'text-red-600'}`}>
                        {col.is_nullable==='YES'?'NULL':'NOT NULL'}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-[10px] text-slate-400 max-w-[140px] truncate" title={col.column_default}>
                      {col.column_default||'—'}
                    </td>
                    <td className="px-3 py-2 text-[10px] text-slate-400 italic">{col.column_comment||'—'}</td>
                  </tr>
                ))}
                {!(str?.columns?.length) && (
                  <tr><td colSpan={6} className="text-center py-8 text-slate-400">No column data</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Constraints */}
          {(str?.constraints||[]).length > 0 && (
            <div className="mt-3">
              <p className="text-[9px] font-black text-slate-400 uppercase tracking-wide mb-2">Constraints</p>
              <div className="flex flex-wrap gap-2">
                {(str.constraints||[]).map((c, ci) => (
                  <div key={ci} className={`flex items-center gap-2 px-3 py-2 rounded-xl text-[11px] font-bold ${CON_CLS[c.constraint_type]||'bg-slate-100 text-slate-600 border border-slate-200'}`}>
                    <span className="text-[9px] font-black opacity-60">{c.constraint_type}</span>
                    <span className="font-mono">{c.constraint_name}</span>
                    {c.columns && <span className="opacity-70">({c.columns})</span>}
                    {c.foreign_table && <span className="opacity-70 text-[9px]">→ {c.foreign_table}.{c.foreign_column}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Triggers */}
          {(str?.triggers||[]).length > 0 && (
            <div className="mt-3">
              <p className="text-[9px] font-black text-slate-400 uppercase tracking-wide mb-2">Triggers ({str.triggers.length})</p>
              <div className="space-y-1">
                {str.triggers.map((tg, ti) => (
                  <div key={ti} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-slate-50 border border-slate-100 text-[11px]">
                    <span className="font-bold text-slate-700">{tg.trigger_name}</span>
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-purple-100 text-purple-700">{tg.action_timing} {tg.event_manipulation}</span>
                    <span className="text-slate-400 text-[10px]">{tg.action_orientation}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* INDEXES */}
      {detailTab === 'indexes' && (
        strLoading ? <div className="py-6 text-center text-[12px] text-slate-400">Loading indexes…</div> :
        <div className="space-y-2">
          {(str?.indexes?.length ? str.indexes : table.indexes||[]).map((ix, ii) => (
            <div key={ii} className={`bg-white rounded-xl border p-4 ${ix.is_primary?'border-amber-300 bg-amber-50/30':ix.is_unique?'border-indigo-200 bg-indigo-50/10':ix.idx_scan===0?'border-red-200 bg-red-50/20':'border-slate-200'}`}>
              <div className="flex items-center gap-2 flex-wrap mb-2">
                <span className="font-mono font-black text-[12px] text-slate-800">{ix.indexname||ix.index_name}</span>
                {ix.is_primary && <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[9px] font-black border border-amber-300">PRIMARY KEY</span>}
                {ix.is_unique && !ix.is_primary && <span className="px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-[9px] font-black border border-indigo-200">UNIQUE</span>}
                {ix.is_clustered && <span className="px-2 py-0.5 rounded-full bg-teal-100 text-teal-700 text-[9px] font-black">CLUSTERED</span>}
                {!ix.is_valid && <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-[9px] font-black">INVALID</span>}
                {ix.idx_scan===0 && <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-600 text-[9px] font-black border border-red-200">UNUSED</span>}
                <span className="ml-auto text-[11px] font-mono text-slate-500">{ix.index_size||'—'}</span>
              </div>
              {ix.columns && <p className="text-[11px] text-slate-600 mb-1.5">Columns: <span className="font-mono font-bold">{ix.columns}</span></p>}
              {(ix.index_def||ix.index_def) && (
                <pre className="font-mono text-[10px] text-slate-500 bg-slate-50 rounded-lg px-3 py-2 overflow-x-auto">{ix.index_def}</pre>
              )}
              <div className="flex gap-4 mt-2 text-[10px] text-slate-500">
                <span>Scans: <strong className={ix.idx_scan===0?'text-red-600':'text-emerald-600'}>{fmtNum(ix.idx_scan||0)}</strong></span>
                <span>Tup Read: <strong>{fmtNum(ix.idx_tup_read||0)}</strong></span>
              </div>
            </div>
          ))}
          {!(str?.indexes?.length||table.indexes?.length) && (
            <div className="py-8 text-center text-slate-400 font-medium">No indexes on this table</div>
          )}
        </div>
      )}

      {/* I/O */}
      {detailTab === 'io' && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {[
            { label:'Heap Blks Read',  value: fmtNum(table.heap_blks_read),  warn: table.heap_blks_read>1000 },
            { label:'Heap Blks Hit',   value: fmtNum(table.heap_blks_hit) },
            { label:'Heap Cache %',    value: `${table.heap_cache_pct}%` },
            { label:'Idx Blks Read',   value: fmtNum(table.idx_blks_read),   warn: table.idx_blks_read>500 },
            { label:'Idx Blks Hit',    value: fmtNum(table.idx_blks_hit) },
            { label:'Toast Blks Read', value: fmtNum(table.toast_blks_read) },
          ].map(kv => (
            <div key={kv.label} className="bg-white rounded-xl border border-slate-100 p-3 flex justify-between items-center">
              <span className="text-[10px] text-slate-500 font-medium">{kv.label}</span>
              <span className={`text-[12px] font-black font-mono ${kv.warn?'text-red-600':'text-slate-800'}`}>{kv.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* VACUUM */}
      {detailTab === 'vacuum' && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {[
            { label:'Last Vacuum',       value: table.last_vacuum?.slice(0,16)||'Never',   warn: !table.last_vacuum },
            { label:'Last Autovacuum',   value: table.last_autovacuum?.slice(0,16)||'Never' },
            { label:'Last Analyze',      value: table.last_analyze?.slice(0,16)||'Never',  warn: !table.last_analyze },
            { label:'Last Autoanalyze',  value: table.last_autoanalyze?.slice(0,16)||'Never' },
            { label:'Vacuum Count',      value: table.vacuum_count },
            { label:'Autovacuum Count',  value: table.autovacuum_count },
            { label:'Analyze Count',     value: table.analyze_count },
            { label:'Mod Since Analyze', value: fmtNum(table.n_mod_since_analyze), warn: table.needs_analyze },
          ].map(kv => (
            <div key={kv.label} className="bg-white rounded-xl border border-slate-100 p-3 flex justify-between items-center">
              <span className="text-[10px] text-slate-500 font-medium">{kv.label}</span>
              <span className={`text-[12px] font-bold font-mono ${kv.warn?'text-orange-600':'text-slate-700'}`}>{kv.value??'—'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AdvancedTablesTab({ detail, isLoading, refetch, connId, initialDb }) {
  const [view,          setView]          = React.useState('size');
  const [search,        setSearch]        = React.useState('');
  const [selDb,         setSelDb]         = React.useState(initialDb || '__all__');
  const [expand,        setExpand]        = React.useState(null);
  const [selectedTable, setSelectedTable] = React.useState(null);

  // when the user drills in from the Databases tab, follow the chosen DB
  React.useEffect(() => {
    if (initialDb) setSelDb(initialDb);
  }, [initialDb]);

  const d   = detail || {};
  const vw  = TABLE_VIEWS.find(v => v.id === view) || TABLE_VIEWS[0];
  const dbs = d.databases || [];

  let tables = [...(d.tables || [])];
  if (selDb !== '__all__') tables = tables.filter(t => t.database === selDb);
  if (vw.filter) tables = tables.filter(vw.filter);
  tables = tables
    .filter(t => !search ||
      t.relname?.toLowerCase().includes(search.toLowerCase()) ||
      t.schemaname?.toLowerCase().includes(search.toLowerCase()) ||
      t.database?.toLowerCase().includes(search.toLowerCase()))
    .sort(vw.sort);

  const totalBytes  = d.total_bytes || 0;
  const vacNeed     = d.vacuum_needed || 0;
  const anaNeed     = d.analyze_needed || 0;
  const autovac     = d.autovac_config || {};

  if (isLoading && !d.status) return (
    <div className="flex items-center justify-center py-32">
      <div className="text-center">
        <div className="w-14 h-14 border-4 border-indigo-200 border-t-indigo-500 rounded-full animate-spin mx-auto mb-4"/>
        <p className="text-slate-500 text-sm font-semibold">Loading table statistics…</p>
      </div>
    </div>
  );

  const maxSize = Math.max(...(d.tables||[]).map(t=>t.total_bytes||0), 1);

  return (
    <div className="space-y-5">

      {/* Deep-dive modal */}
      {selectedTable && (
        <TableDeepDiveModal
          connId={connId}
          table={selectedTable}
          onClose={() => setSelectedTable(null)}
        />
      )}

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-5 gap-3">
        {[
          { label:'Total Tables',   value: d.total_count ?? 0,      color:'indigo' },
          { label:'Total Size',     value: fmtBytes(totalBytes),     color:'violet' },
          { label:'Vacuum Needed',  value: vacNeed,                  color: vacNeed>0?'orange':'emerald' },
          { label:'Analyze Needed', value: anaNeed,                  color: anaNeed>0?'yellow':'emerald' },
          { label:'Autovacuum',     value: autovac.autovacuum||'?',  color: autovac.autovacuum==='on'?'emerald':'red' },
        ].map(k => (
          <div key={k.label} className={`bg-white rounded-2xl border border-slate-200 shadow-sm px-5 py-4 flex items-center gap-3`}>
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0
              ${k.color==='indigo'?'bg-indigo-50 border border-indigo-100':
                k.color==='violet'?'bg-violet-50 border border-violet-100':
                k.color==='orange'?'bg-orange-50 border border-orange-100':
                k.color==='yellow'?'bg-yellow-50 border border-yellow-100':
                k.color==='emerald'?'bg-emerald-50 border border-emerald-100':
                'bg-red-50 border border-red-100'}`}>
              <Table size={17} className={
                k.color==='indigo'?'text-indigo-500':k.color==='violet'?'text-violet-500':
                k.color==='orange'?'text-orange-500':k.color==='yellow'?'text-yellow-500':
                k.color==='emerald'?'text-emerald-500':'text-red-500'} />
            </div>
            <div>
              <p className="text-[18px] font-black text-slate-900 leading-tight">{k.value}</p>
              <p className="text-[10px] text-slate-400 font-medium">{k.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Vacuum warnings */}
      {vacNeed > 0 && (
        <div className="bg-orange-50 border border-orange-200 rounded-2xl p-4 flex items-start gap-3">
          <AlertTriangle size={15} className="text-orange-500 mt-0.5 flex-shrink-0"/>
          <div>
            <p className="font-black text-orange-800 text-[13px]">{vacNeed} table{vacNeed!==1?'s':''} need VACUUM</p>
            <p className="text-[12px] text-orange-700 mt-0.5">
              Dead tuple ratio &gt;20% or many modified rows since last ANALYZE. Switch to "Vacuum Needed" view to see details.
            </p>
          </div>
        </div>
      )}

      {/* Table panel */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="bg-gradient-to-r from-indigo-50 to-violet-50/30 border-b border-slate-100 px-5 py-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-2">
              <Table size={14} className="text-indigo-500"/>
              <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">Tables</h3>
              <span className="px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-[10px] font-bold">{tables.length} / {d.total_count ?? 0}</span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Database filter */}
              {dbs.length > 1 && (
                <select value={selDb} onChange={e=>{setSelDb(e.target.value);setExpand(null);}}
                  className="h-8 px-2 pr-6 rounded-xl border border-slate-200 text-[12px] outline-none focus:border-indigo-400 bg-white font-medium text-slate-600 appearance-none cursor-pointer"
                  style={{backgroundImage:"url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%2394a3b8' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E\")",backgroundRepeat:'no-repeat',backgroundPosition:'right 8px center'}}>
                  <option value="__all__">All Databases ({d.total_count ?? 0})</option>
                  {dbs.map(db => (
                    <option key={db} value={db}>{db} ({(d.tables||[]).filter(t=>t.database===db).length})</option>
                  ))}
                </select>
              )}
              <div className="relative">
                <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"/>
                <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Filter tables…"
                  className="h-8 pl-7 pr-3 rounded-xl border border-slate-200 text-[12px] outline-none focus:border-indigo-400 bg-white w-40"/>
              </div>
              <button onClick={refetch} className="w-8 h-8 rounded-xl border border-slate-200 flex items-center justify-center text-slate-400 hover:bg-slate-50">
                <RefreshCw size={12} className={isLoading?'animate-spin':''}/>
              </button>
            </div>
          </div>
          {/* View selector */}
          <div className="flex gap-1.5 mt-3 flex-wrap">
            {TABLE_VIEWS.map(tv => (
              <button key={tv.id} onClick={()=>{setView(tv.id);setExpand(null);}}
                className={`h-7 px-3 rounded-xl text-[11px] font-bold border-2 transition-all
                  ${view===tv.id?'border-indigo-500 bg-indigo-50 text-indigo-700':'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}>
                {tv.label}
              </button>
            ))}
          </div>
        </div>

        {tables.length === 0 && !isLoading ? (
          <div className="py-16 text-center">
            <Table size={40} className="mx-auto mb-3 text-slate-200"/>
            <p className="font-bold text-slate-500">{d.total_count===0 ? 'No user tables found' : 'No tables match filter'}</p>
            {d.total_count===0 && <p className="text-[12px] text-slate-400 mt-1">No user tables were found in any database on this server.</p>}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-slate-50/70 border-b border-slate-200">
                  {['DB','Schema','Table','Total Size','Heap','Indexes','Live Rows','Dead Rows','Dead %','Cache Hit','Seq Scans','Idx %','Ins/Upd/Del','Last Vacuum','Last Analyze','Detail'].map(h=>(
                    <th key={h} className="px-3 py-2.5 text-left text-[9px] font-black text-slate-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tables.map((t, i) => {
                  const deadPct    = t.dead_pct || 0;
                  const cachePct   = t.heap_cache_pct || 0;
                  const idxPct     = t.idx_scan_pct || 0;
                  const isExp      = expand === i;
                  const needsVac   = t.needs_vacuum;
                  const va         = vacuumAgo(t);
                  const aa         = analyzeAgo(t);
                  const sizePct    = Math.min(100, Math.round((t.total_bytes||0)/maxSize*100));
                  return (
                    <React.Fragment key={i}>
                      <tr className={`border-t border-slate-100 hover:bg-indigo-50/20 transition-colors ${needsVac?'bg-orange-50/30':''} ${isExp?'bg-indigo-50/30':''}`}>
                        <td className="px-3 py-2.5">
                          <span className="px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-[9px] font-bold border border-indigo-200 whitespace-nowrap">{t.database||'—'}</span>
                        </td>
                        <td className="px-3 py-2.5 font-mono text-slate-400 text-[10px]">{t.schemaname}</td>
                        <td className="px-3 py-2.5">
                          <button onClick={() => setSelectedTable(t)}
                            className="font-black text-indigo-700 hover:text-indigo-500 hover:underline text-left flex items-center gap-1 group">
                            {t.relname}
                            <ExternalLink size={10} className="text-indigo-400 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"/>
                          </button>
                        </td>
                        {/* Total size bar */}
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-slate-700 whitespace-nowrap">{t.total_size||'—'}</span>
                            <div className="h-1.5 w-12 bg-slate-100 rounded-full overflow-hidden flex-shrink-0">
                              <div className="h-full rounded-full bg-gradient-to-r from-indigo-400 to-violet-500" style={{width:`${sizePct}%`}}/>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-slate-500 font-mono">{t.heap_size||'—'}</td>
                        <td className="px-3 py-2.5 text-violet-600 font-mono">{t.indexes_size||'—'}</td>
                        <td className="px-3 py-2.5 font-mono font-bold text-slate-700">{fmtNum(t.n_live_tup)}</td>
                        <td className={`px-3 py-2.5 font-mono font-bold ${t.n_dead_tup>10000?'text-red-600':t.n_dead_tup>1000?'text-orange-500':'text-slate-500'}`}>
                          {fmtNum(t.n_dead_tup)}
                        </td>
                        {/* Dead% */}
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <div className="h-1.5 w-10 bg-slate-100 rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${deadPct>20?'bg-red-500':deadPct>5?'bg-orange-400':'bg-emerald-400'}`} style={{width:`${Math.min(100,deadPct*2)}%`}}/>
                            </div>
                            <span className={`font-bold ${deadPct>20?'text-red-600':deadPct>5?'text-orange-600':'text-emerald-600'}`}>{deadPct}%</span>
                          </div>
                        </td>
                        {/* Cache hit */}
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <div className="h-1.5 w-10 bg-slate-100 rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${cachePct>90?'bg-emerald-400':cachePct>70?'bg-yellow-400':'bg-red-500'}`} style={{width:`${cachePct}%`}}/>
                            </div>
                            <span className={`font-bold ${cachePct>90?'text-emerald-600':cachePct>70?'text-yellow-600':'text-red-600'}`}>{cachePct}%</span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 font-mono text-slate-600">{fmtNum(t.seq_scan)}</td>
                        {/* Idx scan % */}
                        <td className="px-3 py-2.5">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${idxPct>80?'bg-emerald-100 text-emerald-700':idxPct>50?'bg-yellow-100 text-yellow-700':'bg-red-100 text-red-700'}`}>
                            {idxPct}%
                          </span>
                        </td>
                        <td className="px-3 py-2.5 font-mono text-[10px] text-slate-500 whitespace-nowrap">
                          <span className="text-emerald-600 font-bold">{fmtNum(t.n_tup_ins)}</span>
                          <span className="text-slate-300 mx-1">/</span>
                          <span className="text-blue-600 font-bold">{fmtNum(t.n_tup_upd)}</span>
                          <span className="text-slate-300 mx-1">/</span>
                          <span className="text-red-500 font-bold">{fmtNum(t.n_tup_del)}</span>
                        </td>
                        {/* Vacuum */}
                        <td className="px-3 py-2.5">
                          {va
                            ? <span className={`text-[10px] font-semibold ${needsVac?'text-orange-600':'text-slate-400'}`}>{va}</span>
                            : <span className="text-[10px] text-red-500 font-bold">Never</span>}
                        </td>
                        {/* Analyze */}
                        <td className="px-3 py-2.5">
                          {aa
                            ? <span className="text-[10px] text-slate-400 font-semibold">{aa}</span>
                            : <span className="text-[10px] text-orange-500 font-bold">Never</span>}
                        </td>
                        <td className="px-3 py-2.5">
                          <button onClick={()=>setExpand(isExp?null:i)}
                            className={`w-7 h-7 rounded-lg border flex items-center justify-center transition-all ${isExp?'border-indigo-400 bg-indigo-100 text-indigo-600':'border-slate-200 bg-slate-50 text-slate-400 hover:border-indigo-300'}`}>
                            {isExp ? <ChevronUp size={12}/> : <ChevronDown size={12}/>}
                          </button>
                        </td>
                      </tr>

                      {/* Expanded detail — tabbed pane */}
                      {isExp && (
                        <tr className="bg-indigo-50/20 border-b border-indigo-100">
                          <td colSpan={16} className="px-5 py-4">
                            <TableDetailPane connId={connId} table={t} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Autovacuum config */}
      {Object.keys(autovac).length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="bg-gradient-to-r from-slate-50 to-indigo-50/30 border-b border-slate-100 px-5 py-3 flex items-center gap-2">
            <RefreshCw size={13} className="text-slate-400"/>
            <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">Autovacuum Configuration</h3>
            <span className={`ml-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${autovac.autovacuum==='on'?'bg-emerald-100 text-emerald-700':'bg-red-100 text-red-700'}`}>
              {autovac.autovacuum||'?'}
            </span>
          </div>
          <div className="p-5 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
            {[
              { key:'autovacuum_vacuum_threshold',     label:'Vacuum Threshold' },
              { key:'autovacuum_analyze_threshold',    label:'Analyze Threshold' },
              { key:'autovacuum_vacuum_scale_factor',  label:'Vacuum Scale Factor' },
              { key:'autovacuum_analyze_scale_factor', label:'Analyze Scale Factor' },
              { key:'autovacuum_vacuum_cost_delay',    label:'Cost Delay' },
              { key:'autovacuum_max_workers',          label:'Max Workers' },
            ].map(({ key, label }) => (
              <div key={key}>
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide mb-0.5">{label}</p>
                <span className="inline-block px-2 py-0.5 rounded-lg bg-slate-100 text-slate-700 text-[11px] font-bold font-mono">
                  {autovac[key] || 'n/a'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   ADVANCED CONFIG TAB  — pg_settings across 15 categories
══════════════════════════════════════════════════════════════════════════ */
const CFG_GROUP_ICONS = {
  'Memory':           '🧠',
  'WAL':              '📝',
  'Checkpoint':       '✅',
  'Background Writer':'✍️',
  'Connections':      '🔗',
  'Query Planner':    '🔍',
  'Parallel Query':   '⚡',
  'Logging':          '📋',
  'Security':         '🔒',
  'SSL':              '🛡️',
  'Replication':      '🔄',
  'Autovacuum':       '🧹',
  'Archiving':        '📦',
  'Resource Usage':   '💼',
  'Lock Management':  '🔐',
};

const SRC_CLS = {
  'default':              'bg-slate-100 text-slate-500',
  'configuration file':   'bg-blue-100 text-blue-700',
  'override':             'bg-orange-100 text-orange-700',
  'environment variable': 'bg-purple-100 text-purple-700',
  'command line':         'bg-violet-100 text-violet-700',
  'database':             'bg-indigo-100 text-indigo-700',
  'user':                 'bg-teal-100 text-teal-700',
};
const SRC_LABEL = {
  'default':              'default',
  'configuration file':   'config file',
  'override':             'override',
  'environment variable': 'env var',
  'command line':         'CLI',
  'database':             'database',
  'user':                 'user',
};
const CTX_CLS = {
  'postmaster':          'bg-red-100 text-red-700 border border-red-200',
  'sighup':              'bg-orange-100 text-orange-700 border border-orange-200',
  'superuser':           'bg-blue-100 text-blue-700 border border-blue-200',
  'user':                'bg-green-100 text-green-700 border border-green-200',
  'superuser-backend':   'bg-indigo-100 text-indigo-700 border border-indigo-200',
  'backend':             'bg-teal-100 text-teal-700 border border-teal-200',
};
const CTX_LABEL = {
  'postmaster':          '⚠ restart',
  'sighup':              '↺ reload',
  'superuser':           'superuser',
  'user':                'user',
  'superuser-backend':   'su-backend',
  'backend':             'backend',
};

function AdvancedConfigTab({ detail, isLoading, refetch }) {
  const [selGroup, setSelGroup] = React.useState('Memory');
  const [search,   setSearch]   = React.useState('');
  const [copied,   setCopied]   = React.useState(null);
  const [showDesc, setShowDesc] = React.useState(true);

  const d      = detail || {};
  const groups = d.groups || {};
  const groupNames = Object.keys(groups);

  const searchLower = search.toLowerCase().trim();
  const searchResults = searchLower
    ? Object.values(groups).flat().filter(p =>
        p.name.toLowerCase().includes(searchLower) ||
        (p.description || '').toLowerCase().includes(searchLower) ||
        (p.setting || '').toLowerCase().includes(searchLower) ||
        (p.category || '').toLowerCase().includes(searchLower))
    : null;

  const params = searchResults || (groups[selGroup] || []);

  function copyParam(name) {
    navigator.clipboard?.writeText(name);
    setCopied(name);
    setTimeout(() => setCopied(null), 1500);
  }

  if (isLoading && !d.status) return (
    <div className="flex items-center justify-center py-32">
      <div className="text-center">
        <div className="w-14 h-14 border-4 border-indigo-200 border-t-indigo-500 rounded-full animate-spin mx-auto mb-4"/>
        <p className="text-slate-500 font-semibold text-sm">Loading PostgreSQL configuration…</p>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">

      {/* Version / uptime banner */}
      {d.version && (
        <div className="bg-gradient-to-r from-[#336791] to-indigo-700 rounded-2xl px-5 py-4 text-white shadow-lg">
          <div className="flex items-center gap-5 flex-wrap">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold opacity-60 uppercase tracking-wide mb-1">PostgreSQL Server</p>
              <p className="font-mono text-[12px] font-bold truncate opacity-90">{d.version}</p>
            </div>
            {d.uptime && (
              <div className="border-l border-white/20 pl-5">
                <p className="text-[10px] font-bold opacity-60 uppercase tracking-wide mb-0.5">Uptime</p>
                <p className="font-black text-[15px]">{d.uptime}</p>
              </div>
            )}
            {d.started_at && (
              <div className="border-l border-white/20 pl-5">
                <p className="text-[10px] font-bold opacity-60 uppercase tracking-wide mb-0.5">Started</p>
                <p className="font-bold text-[13px]">{String(d.started_at).slice(0,19).replace('T',' ')}</p>
              </div>
            )}
            <button onClick={refetch}
              className="ml-auto w-9 h-9 rounded-xl bg-white/10 hover:bg-white/20 flex items-center justify-center border border-white/20 transition-all">
              <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>
      )}

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label:'Total pg_settings',   value: d.total_params ?? 0,          icon: Database,      color:'indigo' },
          { label:'Tracked Params',       value: d.tracked_params ?? 0,        icon: Settings,      color:'violet' },
          { label:'Modified from Default',value: d.modified_count ?? 0,        icon: AlertCircle,   color:(d.modified_count||0)>0?'blue':'emerald' },
          { label:'Pending Restart',      value: d.pending_restart_count ?? 0, icon: AlertTriangle, color:(d.pending_restart_count||0)>0?'red':'emerald' },
        ].map(k => (
          <div key={k.label} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 flex items-center gap-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0
              ${k.color==='indigo'?'bg-indigo-50 border border-indigo-100':
                k.color==='violet'?'bg-violet-50 border border-violet-100':
                k.color==='blue'?'bg-blue-50 border border-blue-100':
                k.color==='emerald'?'bg-emerald-50 border border-emerald-100':
                'bg-red-50 border border-red-100'}`}>
              <k.icon size={16} className={
                k.color==='indigo'?'text-indigo-500':k.color==='violet'?'text-violet-500':
                k.color==='blue'?'text-blue-500':k.color==='emerald'?'text-emerald-500':'text-red-500'} />
            </div>
            <div>
              <p className="text-[20px] font-black text-slate-900 leading-tight">{k.value}</p>
              <p className="text-[10px] text-slate-400 font-medium leading-tight">{k.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Pending restart warning */}
      {(d.pending_restart_count || 0) > 0 && (
        <div className="bg-red-50 border-2 border-red-200 rounded-2xl p-4 flex items-start gap-3">
          <AlertTriangle size={15} className="text-red-500 mt-0.5 flex-shrink-0"/>
          <div>
            <p className="font-black text-red-800 text-[13px]">
              {d.pending_restart_count} parameter{d.pending_restart_count !== 1 ? 's' : ''} require a server restart
            </p>
            <p className="text-[12px] text-red-700 mt-0.5">
              Settings were changed in postgresql.conf but the server must be restarted for them to take effect.
            </p>
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="bg-white rounded-xl border border-slate-200 px-4 py-2.5 flex items-center gap-4 flex-wrap text-[10px] font-bold">
        <span className="text-slate-400 uppercase tracking-wide">Legend:</span>
        <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">config file — set in postgresql.conf</span>
        <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">default — unchanged</span>
        <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 border border-red-200">⚠ restart — needs server restart</span>
        <span className="px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 border border-orange-200">↺ reload — needs pg_reload_conf()</span>
        <label className="ml-auto flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={showDesc} onChange={e=>setShowDesc(e.target.checked)} className="w-3 h-3"/>
          <span className="text-slate-500">Show descriptions</span>
        </label>
      </div>

      {/* Split layout: sidebar + table */}
      <div className="flex gap-4 items-start">

        {/* Category sidebar */}
        <div className="w-56 flex-shrink-0 space-y-1 sticky top-4">
          <div className="relative mb-3">
            <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"/>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search all params…"
              className="w-full h-9 pl-7 pr-3 rounded-xl border border-slate-200 text-[12px] outline-none focus:border-indigo-400 bg-white"/>
            {search && (
              <button onClick={() => setSearch('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                <XCircle size={12}/>
              </button>
            )}
          </div>

          {searchLower && (
            <div className="px-3 py-2 rounded-xl bg-indigo-50 border border-indigo-200 mb-2">
              <p className="text-[10px] font-bold text-indigo-600">{searchResults?.length || 0} params match</p>
            </div>
          )}

          {groupNames.map(gn => {
            const gparams  = groups[gn] || [];
            const modCount = gparams.filter(p => p.is_modified).length;
            const pendCount = gparams.filter(p => p.pending_restart).length;
            const isActive = selGroup === gn && !searchLower;
            return (
              <button key={gn} onClick={() => { setSelGroup(gn); setSearch(''); }}
                className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-left transition-all
                  ${isActive ? 'bg-indigo-50 border-2 border-indigo-300 shadow-sm' : 'border-2 border-transparent hover:bg-slate-50'}`}>
                <span className="text-[15px] flex-shrink-0">{CFG_GROUP_ICONS[gn] || '⚙️'}</span>
                <div className="flex-1 min-w-0">
                  <p className={`text-[11px] font-bold truncate ${isActive ? 'text-indigo-700' : 'text-slate-700'}`}>{gn}</p>
                  <p className="text-[9px] text-slate-400">{gparams.length} params</p>
                </div>
                <div className="flex flex-col items-end gap-0.5">
                  {modCount > 0 && (
                    <span className="text-[8px] font-black text-blue-600 bg-blue-50 border border-blue-200 rounded-full px-1.5 py-px">{modCount}</span>
                  )}
                  {pendCount > 0 && (
                    <span className="text-[8px] font-black text-red-600 bg-red-50 border border-red-200 rounded-full px-1.5 py-px">↻</span>
                  )}
                </div>
              </button>
            );
          })}

          {groupNames.length === 0 && !isLoading && (
            <div className="text-center py-6">
              <p className="text-[11px] text-slate-400">No config data</p>
            </div>
          )}
        </div>

        {/* Params table */}
        <div className="flex-1 min-w-0 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="bg-gradient-to-r from-indigo-50 to-violet-50/30 border-b border-slate-100 px-5 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="text-[18px]">{searchLower ? '🔎' : (CFG_GROUP_ICONS[selGroup] || '⚙️')}</span>
              <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">
                {searchLower ? `Results for "${search}"` : selGroup}
              </h3>
              <span className="px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-[10px] font-bold">{params.length}</span>
              {params.filter(p=>p.is_modified).length > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-[10px] font-bold border border-blue-200">
                  {params.filter(p=>p.is_modified).length} modified
                </span>
              )}
              {params.filter(p=>p.pending_restart).length > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-[10px] font-bold border border-red-200">
                  ↻ {params.filter(p=>p.pending_restart).length} restart
                </span>
              )}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-slate-50/70 border-b border-slate-200">
                  {[
                    { label: 'Parameter',      w: '' },
                    { label: 'Current Value',  w: 'min-w-[120px]' },
                    { label: 'Unit',           w: 'w-16' },
                    { label: 'Default',        w: 'min-w-[80px]' },
                    { label: 'Source',         w: 'w-24' },
                    { label: 'Context',        w: 'w-24' },
                    { label: '↻',             w: 'w-8 text-center' },
                    ...(showDesc ? [{ label: 'Description', w: 'min-w-[200px]' }] : []),
                  ].map(h => (
                    <th key={h.label} className={`px-3 py-2.5 text-left text-[9px] font-black text-slate-400 uppercase tracking-wide whitespace-nowrap ${h.w}`}>
                      {h.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {params.map(p => (
                  <tr key={p.name}
                    className={`border-t border-slate-100 hover:bg-indigo-50/20 transition-colors
                      ${p.pending_restart ? 'bg-red-50/30' : p.is_modified ? 'bg-blue-50/20' : ''}`}>

                    {/* Parameter name */}
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <code className="font-mono text-[11px] font-bold text-slate-800 select-all">{p.name}</code>
                        <button onClick={() => copyParam(p.name)}
                          className="w-5 h-5 rounded flex items-center justify-center text-slate-300 hover:text-indigo-500 transition-colors flex-shrink-0">
                          {copied === p.name
                            ? <CheckCheck size={10} className="text-emerald-500"/>
                            : <Copy size={10}/>}
                        </button>
                      </div>
                    </td>

                    {/* Current value */}
                    <td className="px-3 py-2.5">
                      <code className={`font-mono text-[12px] font-black px-2 py-1 rounded-lg block max-w-[160px] truncate
                        ${p.pending_restart
                          ? 'bg-red-100 text-red-700 border border-red-200'
                          : p.is_modified
                            ? 'bg-blue-100 text-blue-800 border border-blue-200'
                            : 'bg-slate-50 text-slate-700 border border-slate-100'}`}
                        title={p.setting}>
                        {p.setting ?? '—'}
                      </code>
                    </td>

                    {/* Unit */}
                    <td className="px-3 py-2.5 font-mono text-[10px] text-slate-400">{p.unit || '—'}</td>

                    {/* Default (boot_val) */}
                    <td className="px-3 py-2.5">
                      <code className="font-mono text-[10px] text-slate-400 max-w-[100px] truncate block" title={p.boot_val}>
                        {p.boot_val ?? '—'}
                      </code>
                    </td>

                    {/* Source */}
                    <td className="px-3 py-2.5">
                      <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold
                        ${SRC_CLS[p.source || 'default'] || 'bg-slate-100 text-slate-500'}`}>
                        {SRC_LABEL[p.source || 'default'] || p.source || '—'}
                      </span>
                      {p.sourcefile && (
                        <p className="text-[8px] text-slate-400 mt-0.5 font-mono truncate max-w-[100px]" title={p.sourcefile}>
                          :{p.sourceline}
                        </p>
                      )}
                    </td>

                    {/* Context */}
                    <td className="px-3 py-2.5">
                      <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold
                        ${CTX_CLS[p.context || ''] || 'bg-slate-100 text-slate-500'}`}>
                        {CTX_LABEL[p.context || ''] || p.context || '—'}
                      </span>
                    </td>

                    {/* Pending restart */}
                    <td className="px-3 py-2.5 text-center">
                      {p.pending_restart && (
                        <span title="Pending restart — server must be restarted" className="text-red-500 font-black text-[16px] leading-none">↻</span>
                      )}
                    </td>

                    {/* Description */}
                    {showDesc && (
                      <td className="px-3 py-2.5 text-slate-400 text-[11px]" style={{maxWidth: 280}}>
                        {p.description || '—'}
                      </td>
                    )}
                  </tr>
                ))}

                {params.length === 0 && (
                  <tr>
                    <td colSpan={showDesc ? 8 : 7} className="text-center py-16">
                      <Settings size={40} className="mx-auto mb-3 text-slate-200"/>
                      <p className="text-slate-400 font-bold text-[13px]">
                        {searchLower ? 'No parameters match your search' : 'No parameters in this group'}
                      </p>
                      {searchLower && (
                        <p className="text-slate-400 text-[12px] mt-1">Try a broader term, e.g. "memory", "wal", "checkpoint"</p>
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Enumvals helper — show for current group if any params have enumvals */}
      {!searchLower && params.some(p => p.enumvals?.length > 0) && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="bg-slate-50 border-b border-slate-100 px-5 py-2.5 flex items-center gap-2">
            <Info size={13} className="text-slate-400"/>
            <h3 className="font-black text-slate-600 text-[11px] uppercase tracking-wide">Allowed Values for Enum Parameters</h3>
          </div>
          <div className="p-4 flex flex-wrap gap-3">
            {params.filter(p => p.enumvals?.length > 0).map(p => (
              <div key={p.name} className="flex-shrink-0">
                <p className="text-[10px] font-black text-indigo-600 mb-1.5 font-mono">{p.name}</p>
                <div className="flex flex-wrap gap-1">
                  {p.enumvals.map(v => (
                    <span key={v}
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold border
                        ${p.setting===v ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-slate-50 text-slate-600 border-slate-200'}`}>
                      {v}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   ADVANCED USERS TAB
══════════════════════════════════════════════════════════════════════════ */
function AdvancedUsersTab({ detail, isLoading, refetch }) {
  const [activeSection, setActiveSection] = React.useState('roles');
  const d          = detail || {};
  const roles      = d.roles      || [];
  const members    = d.memberships|| [];
  const activity   = d.activity   || [];
  const ownership  = d.obj_ownership || [];
  const summary    = d.summary    || {};
  const connSummary= d.conn_summary|| {};

  if (isLoading && !d.status) return (
    <div className="flex items-center justify-center py-32">
      <div className="text-center">
        <div className="w-12 h-12 border-4 border-indigo-200 border-t-indigo-500 rounded-full animate-spin mx-auto mb-4"/>
        <p className="text-slate-500 font-semibold text-sm">Loading user data...</p>
      </div>
    </div>
  );

  const sectionTabs = [
    { id:'roles',    label:'Roles & Permissions' },
    { id:'activity', label:'Active Sessions' },
    { id:'members',  label:'Role Memberships' },
    { id:'objects',  label:'Object Ownership' },
  ];

  const RoleBadge = ({ label, active, color }) => active ? (
    <span className={`px-1.5 py-0.5 rounded text-[9px] font-black uppercase ${color}`}>{label}</span>
  ) : null;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label:'Total Roles',      value: summary.total_roles     ?? 0, cls:'bg-indigo-50 border-indigo-200 text-indigo-700' },
          { label:'Login Roles',      value: summary.login_roles     ?? 0, cls:'bg-emerald-50 border-emerald-200 text-emerald-700' },
          { label:'Superusers',       value: summary.superuser_count ?? 0, cls: (summary.superuser_count||0) > 1 ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-slate-50 border-slate-200 text-slate-700' },
          { label:'Active Sessions',  value: activity.reduce((a,u)=>a+(u.active||0),0), cls:'bg-blue-50 border-blue-200 text-blue-700' },
          { label:'Expired Passwords',value: summary.expired_count   ?? 0, cls: (summary.expired_count||0) > 0 ? 'bg-red-50 border-red-200 text-red-700' : 'bg-slate-50 border-slate-200 text-slate-700' },
        ].map(({ label, value, cls }) => (
          <div key={label} className={`rounded-xl border p-4 ${cls}`}>
            <p className="text-[10px] font-bold uppercase tracking-wide opacity-70">{label}</p>
            <p className="text-2xl font-black mt-1">{value}</p>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="border-b border-slate-100 px-2 flex items-center gap-1 bg-slate-50/50 flex-wrap">
          {sectionTabs.map(s => (
            <button key={s.id} onClick={() => setActiveSection(s.id)}
              className={`px-4 py-3 text-[12px] font-bold rounded-t transition-colors whitespace-nowrap ${activeSection===s.id?'text-indigo-700 border-b-2 border-indigo-500 bg-white -mb-px':'text-slate-500 hover:text-slate-700'}`}>
              {s.label}
            </button>
          ))}
          <button onClick={refetch} className="ml-auto mr-2 w-7 h-7 rounded-lg border border-slate-200 flex items-center justify-center text-slate-400 hover:bg-slate-100">
            <RefreshCw size={12} className={isLoading?'animate-spin':''}/>
          </button>
        </div>

        {activeSection === 'roles' && (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/50">
                  {['Role Name','Permissions','Conn Limit','Password Expires','Current Conns'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {roles.map((r, i) => (
                  <tr key={i} className={`border-t border-slate-50 hover:bg-slate-50/50 ${r.expired?'bg-red-50/30':''}`}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${r.rolsuper?'bg-red-100':r.rolcanlogin?'bg-emerald-100':'bg-slate-100'}`}>
                          <Shield size={12} className={r.rolsuper?'text-red-600':r.rolcanlogin?'text-emerald-600':'text-slate-400'}/>
                        </div>
                        <span className={`font-bold ${r.rolcanlogin?'text-indigo-700':'text-slate-600'}`}>{r.rolname}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        <RoleBadge label="SUPERUSER"   active={r.rolsuper}       color="bg-red-100 text-red-700"/>
                        <RoleBadge label="LOGIN"       active={r.rolcanlogin}    color="bg-emerald-100 text-emerald-700"/>
                        <RoleBadge label="CREATEDB"    active={r.rolcreatedb}    color="bg-blue-100 text-blue-700"/>
                        <RoleBadge label="CREATEROLE"  active={r.rolcreaterole}  color="bg-purple-100 text-purple-700"/>
                        <RoleBadge label="REPLICATION" active={r.rolreplication} color="bg-cyan-100 text-cyan-700"/>
                        <RoleBadge label="BYPASSRLS"   active={r.rolbypassrls}   color="bg-orange-100 text-orange-700"/>
                        <RoleBadge label="INHERIT"     active={r.rolinherit}     color="bg-slate-100 text-slate-500"/>
                        {!r.rolsuper && !r.rolcanlogin && !r.rolcreatedb && !r.rolcreaterole && (
                          <span className="text-slate-300 text-[10px]">group role</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-600">
                      {r.rolconnlimit == null ? <span className="text-slate-300">unlimited</span> : r.rolconnlimit}
                    </td>
                    <td className="px-4 py-3">
                      {r.rolvaliduntil
                        ? <span className={`text-[11px] font-bold ${r.expired?'text-red-600':'text-slate-600'}`}>
                            {r.expired ? 'EXPIRED: ' : ''}{String(r.rolvaliduntil).slice(0,10)}
                          </span>
                        : <span className="text-slate-300 text-[10px]">never</span>}
                    </td>
                    <td className="px-4 py-3">
                      {connSummary[r.rolname] != null
                        ? <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${connSummary[r.rolname]>0?'bg-blue-100 text-blue-700':'bg-slate-100 text-slate-400'}`}>
                            {connSummary[r.rolname]}
                          </span>
                        : <span className="text-slate-300">-</span>}
                    </td>
                  </tr>
                ))}
                {roles.length === 0 && (
                  <tr><td colSpan={5} className="text-center py-14 text-slate-400">No roles found</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {activeSection === 'activity' && (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/50">
                  {['User','Database','Total','Active','Idle','Idle in Txn','Waiting','Max Query Age'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {activity.map((u, i) => (
                  <tr key={i} className="border-t border-slate-50 hover:bg-slate-50/50">
                    <td className="px-4 py-3 font-bold text-indigo-700">{u.usename}</td>
                    <td className="px-4 py-3 text-slate-400 font-mono text-[11px]">{u.datname || '-'}</td>
                    <td className="px-4 py-3 font-black text-slate-800">{u.total}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${u.active>0?'bg-emerald-100 text-emerald-700':'bg-slate-100 text-slate-400'}`}>{u.active}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-500">{u.idle}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${u.idle_in_txn>0?'bg-amber-100 text-amber-700':'bg-slate-100 text-slate-400'}`}>{u.idle_in_txn}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${u.waiting>0?'bg-red-100 text-red-700':'bg-slate-100 text-slate-400'}`}>{u.waiting}</span>
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px]">
                      {u.max_query_age_s > 0
                        ? <span className={`font-bold ${u.max_query_age_s>60?'text-red-600':u.max_query_age_s>10?'text-amber-600':'text-slate-600'}`}>
                            {u.max_query_age_s >= 60 ? `${Math.floor(u.max_query_age_s/60)}m ${u.max_query_age_s%60}s` : `${u.max_query_age_s}s`}
                          </span>
                        : <span className="text-slate-300">-</span>}
                    </td>
                  </tr>
                ))}
                {activity.length === 0 && (
                  <tr><td colSpan={8} className="text-center py-14 text-slate-400">No active sessions</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {activeSection === 'members' && (
          <div className="overflow-x-auto">
            {members.length === 0 ? (
              <div className="p-12 text-center">
                <Users size={32} className="mx-auto text-slate-200 mb-3"/>
                <p className="text-slate-500 font-semibold">No role memberships</p>
                <p className="text-slate-400 text-sm mt-1">No roles are members of other roles</p>
              </div>
            ) : (
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/50">
                    {['Role (Group)','Member','Admin Option'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wide">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {members.map((m, i) => (
                    <tr key={i} className="border-t border-slate-50 hover:bg-indigo-50/20">
                      <td className="px-4 py-3 font-bold text-purple-700">{m.role_name}</td>
                      <td className="px-4 py-3 font-bold text-indigo-700">
                        <div className="flex items-center gap-2">
                          <ArrowRight size={10} className="text-slate-300"/>
                          {m.member_name}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {m.admin_option
                          ? <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-700">ADMIN</span>
                          : <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-400">member</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {activeSection === 'objects' && (
          <div className="overflow-x-auto">
            {ownership.length === 0 ? (
              <div className="p-12 text-center">
                <Database size={32} className="mx-auto text-slate-200 mb-3"/>
                <p className="text-slate-500 font-semibold">No object ownership data</p>
              </div>
            ) : (
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/50">
                    {['Owner','Tables','Views','Indexes','Sequences','Total Objects'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wide">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ownership.map((o, i) => {
                    const total = (o.tables||0)+(o.views||0)+(o.indexes||0)+(o.sequences||0);
                    return (
                      <tr key={i} className="border-t border-slate-50 hover:bg-slate-50/50">
                        <td className="px-4 py-3 font-bold text-indigo-700">{o.owner}</td>
                        <td className="px-4 py-3 font-black text-slate-800">{o.tables}</td>
                        <td className="px-4 py-3 text-slate-600">{o.views}</td>
                        <td className="px-4 py-3 text-slate-600">{o.indexes}</td>
                        <td className="px-4 py-3 text-slate-600">{o.sequences}</td>
                        <td className="px-4 py-3">
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-100 text-indigo-700">{total}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {d.errors?.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
          {d.errors.map((e,i) => <p key={i} className="text-[10px] font-mono text-amber-600">{e}</p>)}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   ADVANCED STORAGE TAB
══════════════════════════════════════════════════════════════════════════ */
function AdvancedStorageTab({ detail, isLoading, refetch }) {
  const [activeSection, setActiveSection] = React.useState('tables');
  const d           = detail || {};
  const dbSizes     = d.db_sizes           || [];
  const tablespaces = d.tablespaces        || [];
  const topTables   = d.top_tables         || [];
  const bloatTables = d.bloat_tables       || [];
  const vacuumNeeded= d.vacuum_needed      || [];
  const toastTables = d.toast_tables       || [];
  const avSettings  = d.autovacuum_settings|| {};
  const summary     = d.summary            || {};

  if (isLoading && !d.status) return (
    <div className="flex items-center justify-center py-32">
      <div className="text-center">
        <div className="w-12 h-12 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin mx-auto mb-4"/>
        <p className="text-slate-500 font-semibold text-sm">Analyzing storage...</p>
      </div>
    </div>
  );

  const sectionTabs = [
    { id:'tables',  label:'Top Tables' },
    { id:'bloat',   label:`Bloat (${bloatTables.length})` },
    { id:'vacuum',  label:`Vacuum (${vacuumNeeded.length} need)` },
    { id:'spaces',  label:'Tablespaces' },
    { id:'autovac', label:'Autovacuum Config' },
  ];

  const DeadBar = ({ ratio }) => {
    const pct = Math.min(100, ratio || 0);
    const col = pct > 30 ? '#ef4444' : pct > 10 ? '#f97316' : '#22c55e';
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden" style={{maxWidth:'60px'}}>
          <div className="h-full rounded-full" style={{ width:`${pct}%`, background: col }}/>
        </div>
        <span className={`text-[11px] font-bold ${pct>30?'text-red-600':pct>10?'text-orange-500':'text-emerald-600'}`}>{pct}%</span>
      </div>
    );
  };

  const fmtAge = (secs) => {
    if (!secs || secs < 0) return 'never';
    if (secs < 3600) return `${Math.floor(secs/60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs/3600)}h ago`;
    return `${Math.floor(secs/86400)}d ago`;
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        {[
          { label:'Total DB Size',   value: fmtBytes(summary.total_db_bytes||0),   cls:'bg-orange-50 border-orange-200 text-orange-700' },
          { label:'Tables (data)',   value: fmtBytes(summary.total_table_bytes||0), cls:'bg-blue-50 border-blue-200 text-blue-700' },
          { label:'Indexes',         value: fmtBytes(summary.total_index_bytes||0), cls:'bg-indigo-50 border-indigo-200 text-indigo-700' },
          { label:'Dead Tuples',     value: fmtNum(summary.total_dead_tup||0),      cls:(summary.total_dead_tup||0)>100000?'bg-red-50 border-red-200 text-red-700':'bg-slate-50 border-slate-200 text-slate-700' },
          { label:'Bloat Tables',    value: summary.bloat_count||0,                 cls:(summary.bloat_count||0)>0?'bg-amber-50 border-amber-200 text-amber-700':'bg-slate-50 border-slate-200 text-slate-700' },
          { label:'Need Vacuum',     value: summary.vacuum_needed||0,               cls:(summary.vacuum_needed||0)>0?'bg-red-50 border-red-200 text-red-700':'bg-emerald-50 border-emerald-200 text-emerald-700' },
        ].map(({ label, value, cls }) => (
          <div key={label} className={`rounded-xl border p-4 ${cls}`}>
            <p className="text-[10px] font-bold uppercase tracking-wide opacity-70">{label}</p>
            <p className="text-xl font-black mt-1 truncate">{value}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        {dbSizes.length > 0 && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
            <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide mb-4">Database Sizes</h3>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={dbSizes} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false}/>
                <XAxis type="number" tick={{ fontSize:9 }} tickFormatter={v=>fmtBytes(v)} axisLine={false} tickLine={false}/>
                <YAxis width={100} type="category" dataKey="datname" tick={{ fontSize:10 }} axisLine={false} tickLine={false}/>
                <Tooltip formatter={v=>fmtBytes(v)}/>
                <Bar dataKey="size_bytes" name="Size" radius={[0,4,4,0]}>
                  {dbSizes.map((_,i)=><Cell key={i} fill={[C.pg,C.indigo,C.green,C.orange,C.purple,C.cyan][i%6]}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        {topTables.length > 0 && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
            <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide mb-4">Top Tables by Size</h3>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={topTables.slice(0,8)} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false}/>
                <XAxis type="number" tick={{ fontSize:9 }} tickFormatter={v=>fmtBytes(v)} axisLine={false} tickLine={false}/>
                <YAxis width={110} type="category" dataKey="relname" tick={{ fontSize:10 }} axisLine={false} tickLine={false}/>
                <Tooltip formatter={v=>fmtBytes(v)}/>
                <Bar dataKey="total_bytes" name="Total" fill={C.orange} radius={[0,4,4,0]}/>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="border-b border-slate-100 px-2 flex items-center gap-1 bg-slate-50/50 flex-wrap">
          {sectionTabs.map(s => (
            <button key={s.id} onClick={() => setActiveSection(s.id)}
              className={`px-4 py-3 text-[12px] font-bold rounded-t transition-colors whitespace-nowrap ${activeSection===s.id?'text-indigo-700 border-b-2 border-indigo-500 bg-white -mb-px':'text-slate-500 hover:text-slate-700'}`}>
              {s.label}
            </button>
          ))}
          <button onClick={refetch} className="ml-auto mr-2 w-7 h-7 rounded-lg border border-slate-200 flex items-center justify-center text-slate-400 hover:bg-slate-100">
            <RefreshCw size={12} className={isLoading?'animate-spin':''}/>
          </button>
        </div>

        {activeSection === 'tables' && (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/50">
                  {['Schema.Table','Total','Table','Indexes','Live Rows','Dead Rows','Dead %','Last Vacuum','Seq/Idx Scans'].map(h => (
                    <th key={h} className="px-3 py-2.5 text-left text-[9px] font-bold text-slate-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {topTables.map((t, i) => (
                  <tr key={i} className={`border-t border-slate-50 hover:bg-slate-50/50 ${t.dead_ratio>20?'bg-red-50/20':t.dead_ratio>10?'bg-amber-50/20':''}`}>
                    <td className="px-3 py-2.5 font-bold text-indigo-700">
                      <span className="text-slate-400">{t.schemaname}.</span>{t.relname}
                    </td>
                    <td className="px-3 py-2.5 font-bold text-slate-800">{t.total_size}</td>
                    <td className="px-3 py-2.5 text-slate-600">{t.table_size}</td>
                    <td className="px-3 py-2.5 text-slate-600">{t.index_size}</td>
                    <td className="px-3 py-2.5 font-mono text-slate-600">{fmtNum(t.n_live_tup)}</td>
                    <td className="px-3 py-2.5 font-mono">
                      <span className={t.n_dead_tup>10000?'text-red-600 font-bold':t.n_dead_tup>1000?'text-amber-600':'text-slate-500'}>
                        {fmtNum(t.n_dead_tup)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5"><DeadBar ratio={t.dead_ratio}/></td>
                    <td className="px-3 py-2.5 text-slate-400 whitespace-nowrap">
                      {t.last_autovacuum
                        ? new Date(t.last_autovacuum).toLocaleDateString()
                        : t.last_vacuum
                        ? new Date(t.last_vacuum).toLocaleDateString()
                        : <span className="text-red-500 font-bold text-[9px]">NEVER</span>}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-slate-500">
                      <span className="text-indigo-600">{fmtNum(t.seq_scan)}</span>
                      <span className="text-slate-300"> / </span>
                      <span className="text-emerald-600">{fmtNum(t.idx_scan)}</span>
                    </td>
                  </tr>
                ))}
                {topTables.length === 0 && (
                  <tr><td colSpan={9} className="text-center py-14 text-slate-400">No table data</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {activeSection === 'bloat' && (
          <div className="overflow-x-auto">
            {bloatTables.length === 0 ? (
              <div className="p-12 text-center">
                <CheckCircle2 size={32} className="mx-auto text-emerald-400 mb-3"/>
                <p className="text-slate-500 font-semibold">No significant table bloat detected</p>
                <p className="text-slate-400 text-sm mt-1">All tables have dead tuple ratios below threshold</p>
              </div>
            ) : (
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/50">
                    {['Table','Total Size','Live Tuples','Dead Tuples','Dead Ratio','Last Autovacuum','Action'].map(h => (
                      <th key={h} className="px-3 py-2.5 text-left text-[9px] font-bold text-slate-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {bloatTables.map((t, i) => (
                    <tr key={i} className="border-t border-slate-50 hover:bg-red-50/20">
                      <td className="px-3 py-2.5 font-bold text-slate-800">
                        <span className="text-slate-400 text-[10px]">{t.schemaname}.</span>{t.relname}
                      </td>
                      <td className="px-3 py-2.5 font-bold">{t.total_size}</td>
                      <td className="px-3 py-2.5 font-mono text-emerald-700">{fmtNum(t.n_live_tup)}</td>
                      <td className="px-3 py-2.5 font-mono font-bold text-red-600">{fmtNum(t.n_dead_tup)}</td>
                      <td className="px-3 py-2.5"><DeadBar ratio={t.dead_ratio}/></td>
                      <td className="px-3 py-2.5 text-slate-400">
                        {t.last_autovacuum
                          ? new Date(t.last_autovacuum).toLocaleString()
                          : <span className="text-red-500 font-bold text-[9px]">NEVER</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${t.dead_ratio>30?'bg-red-100 text-red-700':'bg-amber-100 text-amber-700'}`}>
                          {t.dead_ratio > 30 ? 'VACUUM NOW' : 'VACUUM SOON'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {activeSection === 'vacuum' && (
          <div className="overflow-x-auto">
            {vacuumNeeded.length === 0 ? (
              <div className="p-12 text-center">
                <CheckCircle2 size={32} className="mx-auto text-emerald-400 mb-3"/>
                <p className="text-slate-500 font-semibold">All tables vacuumed recently</p>
                <p className="text-slate-400 text-sm mt-1">No tables overdue for vacuum</p>
              </div>
            ) : (
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/50">
                    {['Table','Live Tuples','Dead Tuples','Last Autovacuum','Last Manual Vacuum','Autovacuum Runs','Since Last'].map(h => (
                      <th key={h} className="px-3 py-2.5 text-left text-[9px] font-bold text-slate-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {vacuumNeeded.map((v, i) => (
                    <tr key={i} className={`border-t border-slate-50 hover:bg-amber-50/20 ${v.secs_since_vacuum > 86400*30 ? 'bg-red-50/20' : ''}`}>
                      <td className="px-3 py-2.5 font-bold text-slate-800">
                        <span className="text-slate-400 text-[10px]">{v.schemaname}.</span>{v.relname}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-slate-600">{fmtNum(v.n_live_tup)}</td>
                      <td className="px-3 py-2.5 font-mono font-bold text-amber-600">{fmtNum(v.n_dead_tup)}</td>
                      <td className="px-3 py-2.5 text-slate-400">
                        {v.last_autovacuum
                          ? new Date(v.last_autovacuum).toLocaleDateString()
                          : <span className="text-red-500 font-bold text-[9px]">NEVER</span>}
                      </td>
                      <td className="px-3 py-2.5 text-slate-400">
                        {v.last_vacuum
                          ? new Date(v.last_vacuum).toLocaleDateString()
                          : <span className="text-slate-300">-</span>}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-slate-600">{v.autovacuum_count}</td>
                      <td className="px-3 py-2.5">
                        <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${
                          v.secs_since_vacuum > 86400*30 ? 'bg-red-100 text-red-700' :
                          v.secs_since_vacuum > 86400*7  ? 'bg-amber-100 text-amber-700' :
                          'bg-slate-100 text-slate-500'}`}>
                          {fmtAge(v.secs_since_vacuum)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {activeSection === 'spaces' && (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/50">
                  {['Name','Owner','Location','Size'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tablespaces.map((ts, i) => (
                  <tr key={i} className="border-t border-slate-50 hover:bg-slate-50/50">
                    <td className="px-4 py-3 font-bold text-indigo-700">{ts.spcname}</td>
                    <td className="px-4 py-3 text-slate-500">{ts.owner || '-'}</td>
                    <td className="px-4 py-3 font-mono text-[11px] text-slate-400">{ts.location || <span className="text-slate-300">default</span>}</td>
                    <td className="px-4 py-3 font-bold text-slate-800">{ts.size_pretty}</td>
                  </tr>
                ))}
                {tablespaces.length === 0 && (
                  <tr><td colSpan={4} className="text-center py-10 text-slate-400">No tablespace data</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {activeSection === 'autovac' && (
          <div className="p-5">
            {Object.keys(avSettings).length === 0 ? (
              <p className="text-slate-400 text-center py-8">No autovacuum settings data</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {Object.entries(avSettings).map(([name, info]) => (
                  <div key={name} className="bg-slate-50 rounded-xl border border-slate-100 px-4 py-3">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-0.5">{name}</p>
                    <p className="font-black text-slate-800 text-[13px]">
                      {info.setting}{info.unit ? ` ${info.unit}` : ''}
                    </p>
                    <p className="text-[10px] text-slate-400 mt-0.5 truncate" title={info.desc}>{info.desc}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {toastTables.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="bg-gradient-to-r from-slate-50 to-indigo-50/30 border-b border-slate-100 px-5 py-3 flex items-center gap-2">
            <HardDrive size={14} className="text-slate-400"/>
            <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">TOAST Storage ({toastTables.length} tables)</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/50">
                  {['Table','TOAST Size'].map(h => (
                    <th key={h} className="px-4 py-2.5 text-left text-[9px] font-bold text-slate-400 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {toastTables.map((t, i) => (
                  <tr key={i} className="border-t border-slate-50 hover:bg-slate-50/50">
                    <td className="px-4 py-2.5 font-bold text-indigo-700">
                      <span className="text-slate-400">{t.schemaname}.</span>{t.tablename}
                    </td>
                    <td className="px-4 py-2.5 font-bold text-slate-800">{t.toast_size}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {d.errors?.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
          {d.errors.map((e,i) => <p key={i} className="text-[10px] font-mono text-amber-600">{e}</p>)}
        </div>
      )}
    </div>
  );
}

