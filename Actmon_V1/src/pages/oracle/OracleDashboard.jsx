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
  Copy, Wifi, WifiOff, Loader2, GitBranch, Box, Boxes, X,
} from 'lucide-react';
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  LineChart, Line, AreaChart, Area,
} from 'recharts';
import client from '../../api/client';
import HostResources from '../postgresql/PgHostResources';
import OracleLiveQueriesPanel from './OracleLiveQueriesPanel';
import Gauge from '../../components/gauges/Gauge';
import TrendChart from '../../components/gauges/TrendChart';
import { DashboardScopeProvider } from '../../context/DashboardAppearanceContext';

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
const fetchSlowQueries  = (id) => client.get(`/connections/oracle/${id}/oracle-slow-queries`).then(r => r.data);
const fetchLocks        = (id) => client.get(`/connections/oracle/${id}/oracle-locks`).then(r => r.data);
const fetchParameters   = (id) => client.get(`/connections/oracle/${id}/oracle-parameters`).then(r => r.data);
const fetchSchemaTables = (id, owner) => client.get(`/connections/oracle/${id}/oracle-schema-tables${owner ? `?owner=${owner}` : ''}`).then(r => r.data);

const TABS = [
  { id: 'overview',     label: 'Overview',      icon: Activity },
  { id: 'performance',  label: 'Performance',   icon: TrendingUp },
  { id: 'sessions',     label: 'Sessions',      icon: Users },
  { id: 'sql',          label: 'SQL',           icon: Zap },
  { id: 'tablespaces',  label: 'Tablespaces',   icon: HardDrive },
  { id: 'objects',      label: 'Objects',       icon: Boxes },
  { id: 'schemabrowser',label: 'Tables',        icon: Table },
  { id: 'dataguard',    label: 'Data Guard',    icon: ShieldCheck },
  { id: 'redologs',     label: 'Redo Logs',     icon: RotateCcw },
  { id: 'processes',    label: 'Processes',     icon: Cpu },
  { id: 'users',        label: 'Users',         icon: Key },
  { id: 'systemstats',  label: 'Sys Stats',     icon: BarChart2 },
  { id: 'slowqueries',  label: 'Slow Queries',  icon: Clock },
  { id: 'liveQueries', label: 'Live Queries',  icon: Activity },
  { id: 'locks',       label: 'Locks',         icon: Lock },
  { id: 'parameters',  label: 'Parameters',    icon: Settings },
];

const REFRESH_INTERVAL = 15;

export default function OracleDashboard() {
  const { id, tab }   = useParams();
  const navigate      = useNavigate();
  // Tab is URL-driven: /oracle-dashboard/:id/:tab → every tab has its own route.
  const activeTab = tab || 'overview';
  const setActiveTab = (t) =>
    navigate(`/oracle-dashboard/${id}${t && t !== 'overview' ? `/${t}` : ''}`);
  const [countdown, setCountdown]     = useState(REFRESH_INTERVAL);
  const [sparklines, setSparklines]   = useState({ sessions: [], bufHit: [], pga: [], libHit: [] });
  const [sqlSearch, setSqlSearch]           = useState('');
  const [userSearch, setUserSearch]         = useState('');
  const [statSearch, setStatSearch]         = useState('');
  const [paramSearch, setParamSearch]       = useState('');
  const [expandedSql, setExpandedSql]       = useState(null);
  const [expandedSess, setExpandedSess]     = useState(null);
  const [expandedTs, setExpandedTs]         = useState(null);
  const [expandedUser, setExpandedUser]     = useState(null);
  const [expandedSlow, setExpandedSlow]     = useState(null);
  const [drillModal, setDrillModal]         = useState(null);
  const [schemaOwner, setSchemaOwner]       = useState('');
  const [expandedTable, setExpandedTable]   = useState(null);
  const [schemaTableModal, setSchemaTableModal] = useState(null); // table → full detail modal
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
  const { data: slowData,   isLoading: slowLoading }   = useQuery({ queryKey: ['oracleSlowSql', id],  queryFn: () => fetchSlowQueries(id),  retry: false, refetchInterval: 30000, enabled: activeTab === 'slowqueries' });
  const { data: lockData,   isLoading: lockLoading }   = useQuery({ queryKey: ['oracleLocks', id],    queryFn: () => fetchLocks(id),        retry: false, refetchInterval: 10000, enabled: activeTab === 'locks' });
  const { data: paramData,  isLoading: paramLoading }  = useQuery({ queryKey: ['oracleParams', id],   queryFn: () => fetchParameters(id),   retry: false, staleTime: 120000,      enabled: activeTab === 'parameters' });
  const { data: schemaData, isLoading: schemaLoading } = useQuery({ queryKey: ['oracleSchemaTables', id, schemaOwner], queryFn: () => fetchSchemaTables(id, schemaOwner), retry: false, staleTime: 60000, enabled: activeTab === 'schemabrowser' });

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
    const libHit    = Number(hs.library_cache_hit_pct) || 0;
    const now = new Date().toLocaleTimeString();
    setSparklines(prev => ({
      sessions: [...prev.sessions.slice(-20), { t: now, v: sessCount }],
      bufHit:   [...prev.bufHit.slice(-20),   { t: now, v: bufHit }],
      pga:      [...prev.pga.slice(-20),       { t: now, v: pgaUsed }],
      libHit:   [...prev.libHit.slice(-20),   { t: now, v: libHit }],
    }));
  }, [data]);

  if (isLoading) return (
    <div className="min-h-screen flex items-center justify-center bg-[#f1f5f9]">
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
  const hostCpuPct  = Number(hs.host_cpu_pct) || 0;
  const cpuCount    = Number(hs.cpu_count) || 0;
  const cpuCores    = Number(hs.cpu_cores) || 0;
  const dbCpuPct    = Number(hs.db_cpu_pct) || 0;
  const physMemMb   = Number(hs.physical_mem_mb) || 0;

  const healthScore = computeHealthScore(sessionPct, bufHitPct, maxTsPct, wait_events.length);

  const POOL_COLORS = [C.red, C.orange, C.amber, C.blue, C.purple, C.teal, C.green, C.cyan];

  return (
    <DashboardScopeProvider tech="oracle">
    <div className="-mx-6 md:-mx-8 min-h-full bg-[#f1f5f9] flex flex-col">

      {/* ─── DRILL MODAL ─── */}
      {drillModal && (
        <div className="fixed inset-0 z-50 flex items-start justify-end">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDrillModal(null)} />
          <div className="relative z-10 w-full max-w-2xl h-full bg-white shadow-2xl flex flex-col">
            <div className="flex items-start justify-between p-5 border-b border-slate-200 bg-gradient-to-r from-slate-900 to-slate-800">
              <div>
                <h2 className="text-white font-black text-lg">{drillModal.title}</h2>
                {drillModal.subtitle && <p className="text-slate-300 text-xs mt-0.5">{drillModal.subtitle}</p>}
              </div>
              <button onClick={() => setDrillModal(null)} className="text-white/60 hover:text-white text-xl font-bold ml-4">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">{drillModal.content}</div>
          </div>
        </div>
      )}

      {/* ─── HEADER ─── */}
      <div className="text-white shadow-xl" style={{ background: 'linear-gradient(135deg,#0f172a 0%,#1e3a5f 55%,#3b0a0a 100%)' }}>
        <div className="px-6 pt-5 pb-3 flex flex-wrap justify-between items-center gap-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl shadow-lg"
              style={{ background: 'rgba(199,70,52,0.25)', border: '1px solid rgba(199,70,52,0.4)' }}>
              🏛
            </div>
            <div>
              <h1 className="text-[22px] font-black tracking-tight leading-tight">Oracle Dashboard</h1>
              <p className="text-[13px] mt-0.5" style={{ color: 'rgba(252,165,165,0.85)' }}>
                {connection?.name || 'Oracle'}&nbsp;&mdash;&nbsp;{connection?.host}:{connection?.port}
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
              { to: `/oracle-dashboard/${id}/reports`,        label: '📊 Reports' },
            ].map(({ to, label }) => (
              <Link key={to} to={to}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.75)' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.16)'; e.currentTarget.style.color = '#fff'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = 'rgba(255,255,255,0.75)'; }}>
                {label}
              </Link>
            ))}
            <button onClick={() => refetch()}
              className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-semibold transition-all"
              style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)' }}>
              <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} />
              <span>Refresh</span>
              <span className="w-5 h-5 rounded-full text-[10px] font-black flex items-center justify-center"
                style={{ background: 'rgba(199,70,52,0.4)', color: '#fca5a5' }}>
                {countdown}
              </span>
            </button>
          </div>
        </div>

        {/* TAB BAR */}
        <div className="px-2 flex overflow-x-auto" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          {TABS.map(tab => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className="relative flex items-center gap-2 px-4 py-3 text-xs font-semibold whitespace-nowrap transition-all flex-shrink-0"
                style={active ? {
                  background: '#f1f5f9',
                  color: '#C74634',
                  borderRadius: '10px 10px 0 0',
                  marginBottom: '-1px',
                  boxShadow: '0 -2px 8px rgba(0,0,0,0.15)',
                } : { color: 'rgba(255,255,255,0.55)' }}>
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
              <KpiCard icon={Server}   title="Instance"     value={hs.instance_name || '—'} accent="red"
                onClick={() => setDrillModal({ title: 'Instance Info', content: (
                  <div className="space-y-2">
                    {[['Instance Name',hs.instance_name],['Host',hs.host_name],['Version',hs.version],['Status',hs.status],['Startup Time',hs.startup_time],['Log Mode',hs.log_mode]].map(([l,v])=>(
                      <div key={l} className="flex justify-between py-2 border-b border-slate-100 text-sm"><span className="text-slate-500">{l}</span><span className="font-bold text-slate-800 font-mono">{v||'—'}</span></div>
                    ))}
                  </div>
                )})} />
              <KpiCard icon={Database}  title="DB Name"   value={hs.db_name || '—'}  accent="orange"
                onClick={() => setDrillModal({ title: 'Database Details', content: (
                  <div className="space-y-2">
                    {[['DB Name',hs.db_name],['DB Unique Name',hs.db_unique_name],['Log Mode',hs.log_mode],['DB Size (GB)',hs.db_size_gb],['Status',hs.status]].map(([l,v])=>(
                      <div key={l} className="flex justify-between py-2 border-b border-slate-100 text-sm"><span className="text-slate-500">{l}</span><span className="font-bold text-slate-800">{v||'—'}</span></div>
                    ))}
                  </div>
                )})} />
              <KpiCard icon={Cpu}       title="CPU (of 100%)" value={`${hostCpuPct}%`} accent={hostCpuPct > 85 ? 'red' : hostCpuPct > 65 ? 'orange' : 'green'}
                onClick={() => setDrillModal({ title: 'CPU', subtitle: `${cpuCount || cpuCores} logical CPU${(cpuCount||cpuCores)===1?'':'s'}`, content: (
                  <div className="space-y-2">
                    {[['Host CPU Utilization', `${hostCpuPct}%`],['Database CPU Time Ratio', `${dbCpuPct}%`],['CPU Count (cpu_count)', cpuCount || '—'],['CPU Cores', cpuCores || '—'],['Physical Memory', physMemMb ? `${fmtNum(physMemMb)} MB` : '—'],['Host', hs.host_name]].map(([l,v])=>(
                      <div key={l} className="flex justify-between py-2 border-b border-slate-100 text-sm"><span className="text-slate-500">{l}</span><span className="font-bold text-slate-800 font-mono">{v ?? '—'}</span></div>
                    ))}
                    <p className="text-[11px] text-slate-400 pt-2">Source: Oracle v$sysmetric (Host CPU Utilization %), v$osstat (cores/memory), v$parameter (cpu_count).</p>
                  </div>
                )})} hint="Click for CPU details" />
              <KpiCard icon={Users}     title="Sessions"  value={`${totalSess}/${maxSess}`} accent={sessionPct > 80 ? 'red' : 'green'}
                onClick={() => setActiveTab('sessions')} hint="Click to view sessions" />
              <KpiCard icon={MemoryStick} title="SGA (MB)" value={fmtNum(sgaMb)} accent="blue"
                onClick={() => setActiveTab('performance')} hint="Click for SGA details" />
              <KpiCard icon={Cpu}       title="PGA (MB)"  value={fmtNum(pgaMb)} accent="purple"
                onClick={() => setActiveTab('performance')} hint="Click for PGA details" />
              <KpiCard icon={HardDrive} title="DB Size (GB)" value={hs.db_size_gb || '—'} accent="amber"
                onClick={() => setDrillModal({ title: 'Tablespace Usage', subtitle: `${tablespaces.length} tablespaces`, content: (
                  <div className="space-y-2">
                    {tablespaces.map((ts,i) => {
                      const pct = Number(ts.used_pct)||0;
                      return (
                        <div key={i} className="bg-slate-50 rounded-xl p-3 border border-slate-100">
                          <div className="flex justify-between mb-1"><span className="font-bold text-red-700 text-sm">{ts.tablespace_name}</span><span className={`font-black text-sm ${pct>85?'text-red-600':pct>70?'text-orange-600':'text-green-600'}`}>{pct}%</span></div>
                          <div className="h-2 bg-slate-200 rounded-full"><div className="h-2 rounded-full transition-all" style={{width:`${pct}%`,background:pct>85?C.red:pct>70?C.orange:C.green}} /></div>
                          <div className="flex justify-between mt-1 text-[10px] text-slate-400"><span>Used: {fmtNum(ts.used_mb)} MB</span><span>Total: {fmtNum(ts.total_mb)} MB</span></div>
                        </div>
                      );
                    })}
                    {tablespaces.length===0 && <p className="text-center text-slate-400 py-8">No tablespace data</p>}
                  </div>
                )})} hint="Click to view tablespaces" />
              <KpiCard icon={TrendingUp} title="Buffer Hit%" value={`${bufHitPct}%`} accent={bufHitPct < 80 ? 'red' : bufHitPct < 90 ? 'orange' : 'green'}
                onClick={() => setActiveTab('performance')} hint="Click for performance details" />
            </div>

            {/* Host Resources drill-down */}
            <HostResources connId={id} tech="oracle" />

            {/* System Health — Grafana-style score tile + cache-hit trend + status tiles */}
            <SystemHealthPanel
              healthScore={healthScore}
              hs={hs}
              hostCpuPct={hostCpuPct}
              sessionPct={sessionPct}
              totalSess={totalSess}
              maxSess={maxSess}
              bufHitPct={bufHitPct}
              libHitPct={libHitPct}
              maxTsPct={maxTsPct}
              sparklines={sparklines}
            />

            {/* Gauges */}
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
              <Gauge label="CPU Usage" pct={hostCpuPct}
                sub={`of 100% · ${cpuCount || cpuCores || '?'} CPU${(cpuCount||cpuCores)===1?'':'s'}${physMemMb ? ` · ${fmtNum(physMemMb)} MB RAM` : ''}`}
                colorFn={v => v > 85 ? C.red : v > 65 ? C.orange : C.green} />
              <Gauge label="Sessions %" pct={sessionPct}
                sub={`${totalSess} total / ${maxSess} max`}
                colorFn={v => v > 80 ? C.red : v > 60 ? C.orange : C.green} />
              <Gauge label="SGA Used %" pct={sgaUsedPct}
                sub={`${fmtNum(sgaMb)} MB of ${fmtNum(sgaTargetMb)} MB target`}
                colorFn={v => v > 90 ? C.red : v > 75 ? C.orange : C.teal} />
              <Gauge label="Buffer Cache Hit" pct={bufHitPct}
                sub="Logical read efficiency"
                colorFn={v => v < 70 ? C.red : v < 85 ? C.orange : C.green} />
              <Gauge label="PGA Used %" pct={pgaUsedPct}
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
              <div className="bg-white rounded-2xl border border-slate-200 p-6 text-center">
                <Activity size={20} className="text-slate-300 mx-auto mb-2" />
                <p className="text-slate-400 text-xs font-semibold">Live trend charts appear after first auto-refresh (15 s)</p>
              </div>
            )}

            {/* Wait events + Top SQL */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <Panel title="Top Wait Events — click bar for details" accent="red">
                {wait_events.length === 0 ? (
                  <p className="text-center text-slate-400 text-xs py-8">No wait event data</p>
                ) : (
                  <>
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart layout="vertical"
                        data={wait_events.slice(0, 8).map(w => ({
                          name: (w.event || '').slice(0, 28),
                          waits: Number(w.total_waits) || 0,
                          time_s: Number(w.time_waited_seconds) || 0,
                          _full: w,
                        }))}
                        margin={{ left: 10, right: 10 }}
                        onClick={e => {
                          const w = e?.activePayload?.[0]?.payload?._full;
                          if (!w) return;
                          setDrillModal({ title: w.event || 'Wait Event', subtitle: `Wait Class: ${w.wait_class || '—'}`, content: (
                            <div className="space-y-3">
                              {[['Event',w.event],['Wait Class',w.wait_class],['Total Waits',fmtNum(w.total_waits)],['Time Waited (s)',w.time_waited_seconds],['Avg Wait (ms)',w.avg_wait_ms]].map(([l,v])=>(
                                <div key={l} className="flex justify-between py-2 border-b border-slate-100 text-sm"><span className="text-slate-500">{l}</span><span className="font-bold text-slate-800">{v||'—'}</span></div>
                              ))}
                            </div>
                          )});
                        }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                        <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={fmtNum} axisLine={false} tickLine={false} />
                        <YAxis width={155} type="category" dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                        <Tooltip formatter={(v, n) => [fmtNum(v), n]} cursor={{ fill: '#fef2f2' }} />
                        <Bar dataKey="waits" fill={C.red} radius={[0, 4, 4, 0]} name="Waits" style={{ cursor: 'pointer' }} />
                      </BarChart>
                    </ResponsiveContainer>
                    <p className="text-[10px] text-slate-300 mt-1 text-center">Click any bar to see full event details</p>
                  </>
                )}
              </Panel>

              <Panel title="Instance Info" accent="blue">
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
                  <Panel title="SGA Pool Breakdown" accent="blue">
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
                            <div key={i} className="flex items-center justify-between rounded-xl px-3 py-2.5 text-xs border"
                              style={{ borderColor: POOL_COLORS[i % POOL_COLORS.length] + '40', background: POOL_COLORS[i % POOL_COLORS.length] + '10' }}>
                              <span className="flex items-center gap-1.5">
                                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0 shadow-sm" style={{ background: POOL_COLORS[i % POOL_COLORS.length] }} />
                                <span className="text-slate-700 font-semibold truncate max-w-[90px]">{p.pool}</span>
                              </span>
                              <span className="font-black text-slate-900 text-[11px]">{fmtNum(p.mb)} MB</span>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : sgaLoading ? <TabLoader /> : <p className="text-center text-slate-400 text-xs py-8">No SGA data</p>}
                  </Panel>

                  {/* PGA stats */}
                  <Panel title="PGA Statistics" accent="purple">
                    {pgaData?.summary ? (
                      <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-3">
                          {[
                            ['Total Allocated', `${fmtNum(pgaData.summary.total_allocated_mb)} MB`,  'blue'],
                            ['Total Used',      `${fmtNum(pgaData.summary.total_used_mb)} MB`,       'purple'],
                            ['Aggregate Target',`${fmtNum(pgaData.summary.aggregate_target_mb)} MB`, 'indigo'],
                            ['Cache Hit %',     `${pgaData.summary.cache_hit_pct}%`,                 'green'],
                            ['Work Areas Active', pgaData.summary.work_areas_active,                 'teal'],
                          ].map(([label, val, col]) => {
                            const bg   = { blue:'bg-blue-50 border-blue-200', purple:'bg-purple-50 border-purple-200', indigo:'bg-indigo-50 border-indigo-200', green:'bg-green-50 border-green-200', teal:'bg-teal-50 border-teal-200' }[col];
                            const text = { blue:'text-blue-800', purple:'text-purple-800', indigo:'text-indigo-800', green:'text-green-800', teal:'text-teal-800' }[col];
                            return (
                              <div key={label} className={`rounded-xl border-2 p-3 ${bg}`}>
                                <p className={`text-[9px] font-black uppercase tracking-widest ${text} opacity-70`}>{label}</p>
                                <p className={`text-xl font-black mt-0.5 ${text}`}>{val}</p>
                              </div>
                            );
                          })}
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
                <Panel title="Wait Events by Time" accent="orange">
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
                  <MetricKpi title="Total"       value={summary.total || 0}       accent="blue"
                    onClick={() => setDrillModal({ title: 'All Sessions', subtitle: `${summary.total} total sessions`, content: <SessionDetailTable sessions={sessions} /> })} />
                  <MetricKpi title="Active"      value={summary.active || 0}      accent={summary.active > 0 ? 'green' : 'slate'}
                    onClick={() => setDrillModal({ title: 'Active Sessions', subtitle: `${summary.active} active`, content: <SessionDetailTable sessions={sessions.filter(s=>s.status==='ACTIVE')} /> })} />
                  <MetricKpi title="Inactive"    value={summary.inactive || 0}    accent="slate"
                    onClick={() => setDrillModal({ title: 'Inactive Sessions', subtitle: `${summary.inactive} inactive`, content: <SessionDetailTable sessions={sessions.filter(s=>s.status==='INACTIVE')} /> })} />
                  <MetricKpi title="Blocking"    value={summary.blocking || 0}    accent={summary.blocking > 0 ? 'red' : 'green'}
                    onClick={() => summary.blocking > 0 && setDrillModal({ title: 'Blocking Sessions', subtitle: `${summary.blocking} blocking`, content: <SessionDetailTable sessions={sessions.filter(s=>s.blocking_session!=null)} /> })} />
                  <MetricKpi title="User"        value={summary.user || 0}        accent="orange"
                    onClick={() => setDrillModal({ title: 'User Sessions', subtitle: `${summary.user} user sessions`, content: <SessionDetailTable sessions={sessions.filter(s=>s.type==='USER')} /> })} />
                  <MetricKpi title="Background"  value={summary.background || 0}  accent="purple"
                    onClick={() => setDrillModal({ title: 'Background Sessions', subtitle: `${summary.background} background`, content: <SessionDetailTable sessions={sessions.filter(s=>s.type==='BACKGROUND')} /> })} />
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

                <Panel title={`Sessions (${sessions.length}) — click row for details`}>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 sticky top-0">
                        <tr>
                          {['','SID','Serial#','Username','Status','Type','Machine','Wait Event','Sec Wait','SQL ID'].map(h => (
                            <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sessions.slice(0, 60).map((s, i) => (
                          <React.Fragment key={i}>
                            <tr onClick={() => setExpandedSess(expandedSess === i ? null : i)}
                              className={`border-t border-slate-100 hover:bg-red-50/20 cursor-pointer ${i % 2 === 1 ? 'bg-slate-50/30' : ''} ${s.blocking_session ? 'bg-red-50/60' : ''}`}>
                              <td className="px-2 py-2 text-slate-300">{expandedSess === i ? <ChevronUp size={12}/> : <ChevronDown size={12}/>}</td>
                              <td className="px-3 py-2 font-mono text-xs text-slate-500">{s.sid}</td>
                              <td className="px-3 py-2 font-mono text-[10px] text-slate-400">{s.serial_number}</td>
                              <td className="px-3 py-2 font-semibold text-red-700 text-xs">{s.username || '—'}</td>
                              <td className="px-3 py-2">
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${s.status === 'ACTIVE' ? 'bg-green-100 text-green-700' : s.status === 'INACTIVE' ? 'bg-slate-100 text-slate-500' : 'bg-yellow-100 text-yellow-700'}`}>{s.status || '—'}</span>
                              </td>
                              <td className="px-3 py-2">
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${s.type === 'USER' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>{s.type || '—'}</span>
                              </td>
                              <td className="px-3 py-2 text-[10px] text-slate-400 max-w-[100px] truncate">{s.machine || '—'}</td>
                              <td className="px-3 py-2 text-[10px] text-orange-600 max-w-[120px] truncate">{s.wait_event || '—'}</td>
                              <td className={`px-3 py-2 font-bold text-xs ${s.seconds_in_wait > 60 ? 'text-red-600' : s.seconds_in_wait > 10 ? 'text-orange-600' : 'text-slate-600'}`}>{s.seconds_in_wait || 0}</td>
                              <td className="px-3 py-2 font-mono text-[10px] text-slate-400">{s.sql_id || '—'}</td>
                            </tr>
                            {expandedSess === i && (
                              <tr className="bg-slate-50 border-t border-red-100">
                                <td colSpan={10} className="px-5 py-3">
                                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                                    {[['SID',s.sid],['Serial#',s.serial_number],['Username',s.username],['Status',s.status],['Type',s.type],['Machine',s.machine],['Program',s.program],['Module',s.module],['Wait Event',s.wait_event],['Wait Class',s.wait_class],['Seconds in Wait',s.seconds_in_wait],['SQL ID',s.sql_id],['Blocking SID',s.blocking_session],['Logon Time',s.logon_time]].map(([l,v])=>(
                                      <div key={l} className="bg-white rounded-lg p-2 border border-slate-200"><p className="text-[9px] text-slate-400 uppercase font-bold">{l}</p><p className="font-bold text-slate-800 text-xs mt-0.5 truncate">{v||'—'}</p></div>
                                    ))}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
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

                <Panel title="Tablespace Details — click row for breakdown">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 sticky top-0">
                        <tr>
                          {['','Tablespace','Status','Type','Total (MB)','Used (MB)','Free (MB)','Usage %'].map(h => (
                            <th key={h} className="px-4 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {tsList.map((ts, i) => {
                          const pct = Number(ts.used_pct) || 0;
                          return (
                            <React.Fragment key={i}>
                              <tr onClick={() => setExpandedTs(expandedTs === i ? null : i)}
                                className={`border-t border-slate-100 hover:bg-red-50/20 cursor-pointer ${i % 2 === 1 ? 'bg-slate-50/30' : ''} ${pct > 85 ? 'bg-red-50/50' : pct > 70 ? 'bg-orange-50/50' : ''}`}>
                                <td className="px-3 py-3 text-slate-300">{expandedTs === i ? <ChevronUp size={12}/> : <ChevronDown size={12}/>}</td>
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
                                    <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden min-w-[80px]">
                                      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: pct > 85 ? C.red : pct > 70 ? C.orange : C.green }} />
                                    </div>
                                  </div>
                                </td>
                              </tr>
                              {expandedTs === i && (
                                <tr className="bg-slate-50 border-t border-red-100">
                                  <td colSpan={8} className="px-6 py-3">
                                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
                                      {[['Tablespace',ts.tablespace_name],['Status',ts.status],['Type',ts.contents],['Total (MB)',fmtNum(ts.total_mb)],['Used (MB)',fmtNum(ts.used_mb)],['Free (MB)',fmtNum(ts.free_mb)],['Usage %',`${pct}%`],['Allocation Type',ts.allocation_type||'—']].map(([l,v])=>(
                                        <div key={l} className="bg-white rounded-lg p-2 border border-slate-200"><p className="text-[9px] text-slate-400 uppercase font-bold">{l}</p><p className="font-bold text-slate-800 text-sm mt-0.5">{v}</p></div>
                                      ))}
                                    </div>
                                    <div className="h-3 bg-slate-200 rounded-full overflow-hidden">
                                      <div className="h-full rounded-full transition-all" style={{width:`${pct}%`,background:pct>85?C.red:pct>70?C.orange:C.green}}/>
                                    </div>
                                    <div className="flex justify-between text-[10px] text-slate-400 mt-1">
                                      <span>Used: {fmtNum(ts.used_mb)} MB</span>
                                      <span className={`font-black ${pct>85?'text-red-600':pct>70?'text-orange-500':'text-green-600'}`}>{pct}% used</span>
                                      <span>Total: {fmtNum(ts.total_mb)} MB</span>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                        {tsList.length === 0 && <tr><td colSpan={8} className="text-center py-10 text-slate-400">No tablespace data</td></tr>}
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
                          {['','Username','Status','Created','Profile','Default Tablespace','Last Login'].map(h => (
                            <th key={h} className="px-4 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((u, i) => {
                          const statusColor = u.account_status === 'OPEN' ? 'bg-green-100 text-green-700'
                            : (u.account_status||'').includes('LOCKED') ? 'bg-red-100 text-red-700'
                            : 'bg-yellow-100 text-yellow-700';
                          return (
                            <React.Fragment key={i}>
                              <tr onClick={() => setExpandedUser(expandedUser === i ? null : i)}
                                className={`border-t border-slate-100 hover:bg-red-50/20 cursor-pointer ${i % 2 === 1 ? 'bg-slate-50/30' : ''}`}>
                                <td className="px-3 py-3 text-slate-300">{expandedUser === i ? <ChevronUp size={12}/> : <ChevronDown size={12}/>}</td>
                                <td className="px-4 py-3 font-bold text-red-700">{u.username}</td>
                                <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${statusColor}`}>{u.account_status || '—'}</span></td>
                                <td className="px-4 py-3 text-xs text-slate-400">{u.created || '—'}</td>
                                <td className="px-4 py-3 text-xs text-slate-500">{u.profile || '—'}</td>
                                <td className="px-4 py-3 text-xs text-slate-500">{u.default_tablespace || '—'}</td>
                                <td className="px-4 py-3 text-xs text-slate-400">{u.last_login || '—'}</td>
                              </tr>
                              {expandedUser === i && (
                                <tr className="bg-slate-50 border-t border-red-100">
                                  <td colSpan={7} className="px-6 py-3">
                                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                                      {[['Username',u.username],['Account Status',u.account_status],['Created',u.created],['Profile',u.profile],['Default Tablespace',u.default_tablespace],['Temp Tablespace',u.temporary_tablespace],['Last Login',u.last_login],['Expiry Date',u.expiry_date],['External Name',u.external_name]].map(([l,v])=>(
                                        <div key={l} className="bg-white rounded-lg p-2 border border-slate-200"><p className="text-[9px] text-slate-400 uppercase font-bold">{l}</p><p className="font-bold text-slate-800 text-xs mt-0.5">{v||'—'}</p></div>
                                      ))}
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                        {filtered.length === 0 && <tr><td colSpan={7} className="text-center py-10 text-slate-400">No users found</td></tr>}
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

                <Panel title={`Top Slow SQL (${queries.length}) — click row for full SQL`}>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 sticky top-0">
                        <tr>
                          {['','SQL ID','Schema','Executions','Avg Elapsed (s)','Avg CPU (s)','Avg Disk Reads','Avg Buf Gets','Rows','Last Active'].map(h => (
                            <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {queries.map((q, i) => (
                          <React.Fragment key={i}>
                            <tr onClick={() => setExpandedSlow(expandedSlow === i ? null : i)}
                              className={`border-t border-slate-100 hover:bg-red-50/20 cursor-pointer ${i % 2 === 1 ? 'bg-slate-50/30' : ''} ${q.avg_elapsed_sec > 5 ? 'bg-red-50/40' : q.avg_elapsed_sec > 1 ? 'bg-orange-50/30' : ''}`}>
                              <td className="px-2 py-2.5 text-slate-300">{expandedSlow === i ? <ChevronUp size={12}/> : <ChevronDown size={12}/>}</td>
                              <td className="px-3 py-2.5 font-mono text-[10px] text-red-700">{q.sql_id}</td>
                              <td className="px-3 py-2.5 text-[10px] text-slate-500">{q.parsing_schema_name || '—'}</td>
                              <td className="px-3 py-2.5 font-bold text-slate-800 text-xs">{fmtNum(q.executions)}</td>
                              <td className={`px-3 py-2.5 font-bold text-xs ${q.avg_elapsed_sec > 5 ? 'text-red-600' : q.avg_elapsed_sec > 1 ? 'text-orange-600' : 'text-green-600'}`}>{q.avg_elapsed_sec}</td>
                              <td className="px-3 py-2.5 font-mono text-xs">{q.avg_cpu_sec}</td>
                              <td className="px-3 py-2.5 font-mono text-xs">{fmtNum(q.avg_disk_reads)}</td>
                              <td className="px-3 py-2.5 font-mono text-xs">{fmtNum(q.avg_buffer_gets)}</td>
                              <td className="px-3 py-2.5 font-mono text-xs">{fmtNum(q.rows_processed)}</td>
                              <td className="px-3 py-2.5 text-[10px] text-slate-400 whitespace-nowrap">{_shortDate(q.last_active_time)}</td>
                            </tr>
                            {expandedSlow === i && (
                              <tr className="border-t border-red-100 bg-slate-900">
                                <td colSpan={10} className="px-4 py-3">
                                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
                                    {[['SQL ID',q.sql_id],['Schema',q.parsing_schema_name],['Executions',fmtNum(q.executions)],['Avg Elapsed (s)',q.avg_elapsed_sec],['Avg CPU (s)',q.avg_cpu_sec],['Avg Disk Reads',fmtNum(q.avg_disk_reads)],['Avg Buf Gets',fmtNum(q.avg_buffer_gets)],['Rows',fmtNum(q.rows_processed)]].map(([l,v])=>(
                                      <div key={l} className="bg-slate-800 rounded-lg p-2"><p className="text-[9px] text-slate-400 uppercase font-bold">{l}</p><p className="font-bold text-white text-xs mt-0.5">{v||'—'}</p></div>
                                    ))}
                                  </div>
                                  <div className="flex items-center justify-between mb-2">
                                    <span className="text-[10px] font-bold text-slate-400 uppercase">Full SQL</span>
                                    <button onClick={e=>{e.stopPropagation();navigator.clipboard.writeText(q.sql_fulltext||q.sql_text||'');}}
                                      className="flex items-center gap-1 h-6 px-2 rounded bg-slate-700 text-[10px] text-slate-300 hover:bg-slate-600"><Copy size={9}/> Copy</button>
                                  </div>
                                  <pre className="font-mono text-[11px] text-green-400 whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
                                    {q.sql_fulltext||q.sql_text||'—'}
                                  </pre>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
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

        {/* ══ LIVE QUERIES ══════════════════════════════════════════ */}
        {activeTab === 'liveQueries' && <OracleLiveQueriesPanel connId={id} />}

        {/* ══ SCHEMA / TABLE BROWSER ════════════════════════════════ */}
        {activeTab === 'schemabrowser' && (
          schemaLoading && !schemaData ? <TabLoader /> : (() => {
            const schemas = schemaData?.schemas || [];
            const tables  = schemaData?.tables  || [];
            const owner   = schemaData?.owner   || '';
            return (
              <div className="space-y-4">
                {/* Schema selector */}
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-xs font-bold text-slate-500 uppercase">Schema:</p>
                  <div className="flex flex-wrap gap-2">
                    {schemas.slice(0, 20).map(s => (
                      <button key={s}
                        onClick={() => { setSchemaOwner(s); setExpandedTable(null); }}
                        className={`px-3 py-1 rounded-lg text-xs font-bold transition-all border ${
                          owner === s
                            ? 'bg-red-600 text-white border-red-600'
                            : 'bg-white text-slate-600 border-slate-200 hover:border-red-300'
                        }`}>{s}</button>
                    ))}
                    {schemas.length === 0 && <span className="text-xs text-slate-400">No user schemas found</span>}
                  </div>
                  <span className="ml-auto text-[11px] text-slate-400">{tables.length} tables in <strong>{owner}</strong></span>
                </div>

                {/* KPI strip */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    ['Tables',   tables.length,                                       C.blue],
                    ['Total Rows', fmtNum(tables.reduce((s,t)=>s+(Number(t.num_rows)||0),0)), C.green],
                    ['Total Size', `${(tables.reduce((s,t)=>s+(Number(t.size_mb)||0),0)).toFixed(1)} MB`, C.orange],
                    ['Invalid',  tables.filter(t=>t.status!=='VALID').length,         C.red],
                  ].map(([l,v,c])=>(
                    <div key={l} className="bg-white rounded-xl border border-slate-200 p-3" style={{borderLeft:`3px solid ${c}`}}>
                      <p className="text-[10px] text-slate-400 font-bold uppercase">{l}</p>
                      <p className="text-lg font-black mt-0.5" style={{color:c}}>{v}</p>
                    </div>
                  ))}
                </div>

                {/* Tables list */}
                {tables.length === 0 ? (
                  <div className="bg-white rounded-xl border border-slate-200 text-center py-16">
                    <Database size={32} className="mx-auto mb-3 text-slate-300" />
                    <p className="font-bold text-slate-500">No tables found in schema {owner}</p>
                    <p className="text-xs text-slate-400 mt-1">Select a different schema above or create tables</p>
                  </div>
                ) : (
                  <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                    <div className="px-5 py-3 border-b border-slate-100" style={{borderLeft:'3px solid #C74634'}}>
                      <h3 className="font-black text-slate-800 text-sm uppercase tracking-tight flex items-center gap-2">
                        <Table size={14} style={{color:C.red}} /> Tables in {owner} ({tables.length})
                      </h3>
                    </div>
                    {/* Header */}
                    <div className="grid text-[10px] font-bold text-slate-400 uppercase tracking-wide bg-slate-50 border-b border-slate-200 px-4 py-2"
                      style={{gridTemplateColumns:'200px 90px 80px 80px 80px 100px 80px 1fr'}}>
                      <span>Table Name</span>
                      <span>Rows</span>
                      <span>Columns</span>
                      <span>Indexes</span>
                      <span>Size (MB)</span>
                      <span>Last Analyzed</span>
                      <span>Status</span>
                      <span>Partitioned</span>
                    </div>
                    {tables.map((t, i) => (
                      <div
                        key={i}
                        className="grid items-center px-4 py-2.5 cursor-pointer hover:bg-red-50/40 transition-colors text-xs border-b border-slate-100 group"
                        style={{gridTemplateColumns:'200px 90px 80px 80px 80px 100px 80px 1fr'}}
                        onClick={() => setSchemaTableModal(t)}>
                        <span className="font-black text-red-700 flex items-center gap-1.5">
                          <Table size={11} className="opacity-40 flex-shrink-0" />
                          <span className="truncate">{t.table_name}</span>
                        </span>
                        <span className="font-mono text-slate-700">{fmtNum(t.num_rows)}</span>
                        <span className="font-bold text-indigo-700">{t.col_count || '—'}</span>
                        <span className={`font-bold ${t.idx_count > 0 ? 'text-green-600' : 'text-slate-400'}`}>{t.idx_count || 0}</span>
                        <span className="font-mono text-slate-600">{t.size_mb != null ? t.size_mb : '—'}</span>
                        <span className="text-[10px] text-slate-400">{t.last_analyzed ? String(t.last_analyzed).slice(0,10) : 'Not analyzed'}</span>
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold w-fit ${t.status==='VALID'?'bg-green-100 text-green-700':'bg-red-100 text-red-700'}`}>
                          {t.status || '—'}
                        </span>
                        <span className="text-[10px] text-slate-400 flex items-center justify-between gap-2">
                          {t.partitioned === 'YES' ? <span className="text-indigo-600 font-bold">Partitioned</span> : '—'}
                          <span className="flex items-center gap-1 text-[10px] font-bold text-red-600 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                            Inspect <ChevronRight size={12} />
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {schemaTableModal && (
                  <SchemaTableModal table={schemaTableModal} owner={owner} onClose={() => setSchemaTableModal(null)} />
                )}
              </div>
            );
          })()
        )}

        {/* ══ LOCKS ═════════════════════════════════════════════════ */}
        {activeTab === 'locks' && (
          lockLoading && !lockData ? <TabLoader /> : (() => {
            const lockWaits  = lockData?.lock_waits  || [];
            const enqStats   = lockData?.enqueue_stats || [];
            const hasBlocking = lockWaits.some(l => l.blocking_sid);
            return (
              <div className="space-y-5">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <MetricKpi title="Lock Waits"     value={lockWaits.length}              accent={lockWaits.length > 0 ? 'red' : 'green'} />
                  <MetricKpi title="Blocking"        value={lockWaits.filter(l => l.blocking_sid).length} accent={hasBlocking ? 'red' : 'green'} />
                  <MetricKpi title="Enqueue Types"   value={enqStats.length}              accent="blue" />
                  <MetricKpi title="Max Wait (s)"    value={Math.max(0, ...lockWaits.map(l => Number(l.seconds_in_wait) || 0))} accent="orange" />
                </div>

                {hasBlocking && (
                  <div className="bg-red-50 border border-red-200 rounded-2xl p-4 flex items-start gap-3">
                    <AlertTriangle className="text-red-500 flex-shrink-0 mt-0.5" size={18} />
                    <div>
                      <p className="font-bold text-red-700 text-sm">Blocking Locks Detected</p>
                      <p className="text-xs text-red-600 mt-1">{lockWaits.filter(l => l.blocking_sid).length} session(s) are being blocked. Investigate and consider killing the blocking session if needed.</p>
                    </div>
                  </div>
                )}

                <Panel title={`Lock Waits (${lockWaits.length})`}>
                  {lockWaits.length === 0 ? (
                    <div className="py-12 text-center text-slate-400">
                      <CheckCircle2 size={36} className="mx-auto mb-3 text-green-300" />
                      <p className="font-semibold">No lock waits detected</p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 sticky top-0">
                          <tr>
                            {['SID','Username','Status','Wait Event','Wait (s)','Blocking SID','Lock Type','Mode Held','Mode Req','Object'].map(h => (
                              <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {lockWaits.map((l, i) => (
                            <tr key={i} className={`border-t border-slate-100 hover:bg-slate-50 ${l.blocking_sid ? 'bg-red-50/50 border-l-2 border-l-red-400' : ''}`}>
                              <td className="px-3 py-2.5 font-mono text-xs text-slate-500">{l.sid}</td>
                              <td className="px-3 py-2.5 font-bold text-red-700 text-xs">{l.username || '—'}</td>
                              <td className="px-3 py-2.5">
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${l.status === 'ACTIVE' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>{l.status || '—'}</span>
                              </td>
                              <td className="px-3 py-2.5 text-[10px] text-orange-600 max-w-[120px] truncate">{l.wait_event || '—'}</td>
                              <td className={`px-3 py-2.5 font-black text-xs ${Number(l.seconds_in_wait) > 60 ? 'text-red-600' : Number(l.seconds_in_wait) > 10 ? 'text-orange-600' : 'text-slate-600'}`}>{l.seconds_in_wait || 0}</td>
                              <td className="px-3 py-2.5 font-mono text-xs text-red-600 font-bold">{l.blocking_sid || '—'}</td>
                              <td className="px-3 py-2.5 font-mono text-xs text-slate-500">{l.lock_type || '—'}</td>
                              <td className="px-3 py-2.5 text-[10px] text-slate-500">{l.mode_held || '—'}</td>
                              <td className="px-3 py-2.5 text-[10px] text-slate-500">{l.mode_requested || '—'}</td>
                              <td className="px-3 py-2.5 text-[10px] text-slate-600 max-w-[120px] truncate">{l.object_name || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Panel>

                {enqStats.length > 0 && (
                  <Panel title={`Enqueue Statistics (${enqStats.length})`}>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50">
                          <tr>
                            {['Enqueue Type','Total Requests','Successful Gets','Failed Gets','Waits','Wait Time (s)'].map(h => (
                              <th key={h} className="px-4 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {enqStats.filter(e => (e.total_waits || 0) > 0 || (e.failed_gets || 0) > 0).slice(0, 30).map((e, i) => (
                            <tr key={i} className={`border-t border-slate-100 hover:bg-slate-50 ${i % 2 === 1 ? 'bg-slate-50/30' : ''} ${(e.failed_gets || 0) > 0 ? 'bg-orange-50/40' : ''}`}>
                              <td className="px-4 py-2.5 font-bold text-red-700 text-xs">{e.event || e.eq_type || '—'}</td>
                              <td className="px-4 py-2.5 font-mono text-xs">{fmtNum(e.total_requests)}</td>
                              <td className="px-4 py-2.5 font-mono text-xs text-green-600">{fmtNum(e.succ_gets)}</td>
                              <td className={`px-4 py-2.5 font-mono text-xs ${(e.failed_gets || 0) > 0 ? 'text-red-600 font-bold' : 'text-slate-400'}`}>{fmtNum(e.failed_gets)}</td>
                              <td className={`px-4 py-2.5 font-mono text-xs ${(e.total_waits || 0) > 0 ? 'text-orange-600 font-bold' : 'text-slate-400'}`}>{fmtNum(e.total_waits)}</td>
                              <td className="px-4 py-2.5 font-mono text-xs">{fmtNum(e.wait_time_s)}</td>
                            </tr>
                          ))}
                          {enqStats.every(e => !e.total_waits && !e.failed_gets) && (
                            <tr><td colSpan={6} className="text-center py-8 text-slate-400 text-xs">No enqueue waits or failures</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </Panel>
                )}

                {lockData?.error && (
                  <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700 flex items-center gap-2">
                    <AlertTriangle size={16} /> {lockData.error}
                  </div>
                )}
              </div>
            );
          })()
        )}

        {/* ══ PARAMETERS ════════════════════════════════════════════ */}
        {activeTab === 'parameters' && (
          paramLoading && !paramData ? <TabLoader /> : (() => {
            const keyParams = paramData?.key_params || {};
            const allParams = paramData?.all_params || [];
            const filteredParams = allParams.filter(p =>
              !paramSearch ||
              (p.name || '').toLowerCase().includes(paramSearch.toLowerCase()) ||
              (p.value || '').toLowerCase().includes(paramSearch.toLowerCase()) ||
              (p.description || '').toLowerCase().includes(paramSearch.toLowerCase())
            );
            const KEY_GROUPS = [
              {
                title: 'Memory',
                params: [
                  ['SGA Target',        keyParams['sga_target']],
                  ['PGA Target',        keyParams['pga_aggregate_target']],
                  ['Shared Pool Size',  keyParams['shared_pool_size']],
                  ['DB Cache Size',     keyParams['db_cache_size']],
                  ['Java Pool Size',    keyParams['java_pool_size']],
                ],
              },
              {
                title: 'Connections',
                params: [
                  ['Max Sessions',      keyParams['sessions']],
                  ['Max Processes',     keyParams['processes']],
                  ['Open Cursors',      keyParams['open_cursors']],
                  ['Cursor Sharing',    keyParams['cursor_sharing']],
                ],
              },
              {
                title: 'I/O & Logging',
                params: [
                  ['DB Block Size',     keyParams['db_block_size']],
                  ['DB Files',          keyParams['db_files']],
                  ['Log Buffer',        keyParams['log_buffer']],
                  ['Undo Tablespace',   keyParams['undo_tablespace']],
                  ['Undo Retention',    keyParams['undo_retention']],
                ],
              },
              {
                title: 'Optimiser',
                params: [
                  ['Optimiser Mode',    keyParams['optimizer_mode']],
                  ['Parallel Max Srv',  keyParams['parallel_max_servers']],
                  ['Parallel Min Srv',  keyParams['parallel_min_servers']],
                  ['Sort Area Size',    keyParams['sort_area_size']],
                ],
              },
            ];
            return (
              <div className="space-y-5">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <MetricKpi title="Total Params"    value={allParams.length}                                       accent="blue" />
                  <MetricKpi title="Modified"        value={allParams.filter(p => p.isdefault === 'FALSE').length}  accent="orange" />
                  <MetricKpi title="Session Mod"     value={allParams.filter(p => p.issys_modifiable === 'IMMEDIATE').length} accent="teal" />
                  <MetricKpi title="SGA Target"      value={keyParams['sga_target'] || '—'}                        accent="purple" />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                  {KEY_GROUPS.map(group => (
                    <div key={group.title} className="bg-white rounded-2xl border border-slate-200 p-4">
                      <h4 className="text-xs font-black text-red-700 uppercase tracking-wider mb-3">{group.title}</h4>
                      <div className="space-y-2">
                        {group.params.map(([label, val]) => (
                          <div key={label} className="flex items-center justify-between text-xs py-1 border-b border-slate-100 last:border-0">
                            <span className="text-slate-500 truncate mr-2">{label}</span>
                            <span className="font-mono font-bold text-slate-800 text-right flex-shrink-0">{val || '—'}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                <Panel title={`All Parameters (${allParams.length})`}>
                  <div className="mb-3 relative">
                    <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input value={paramSearch} onChange={e => setParamSearch(e.target.value)}
                      placeholder="Search parameter name, value, or description…"
                      className="h-9 w-full pl-8 pr-3 rounded-xl border border-slate-200 text-xs outline-none focus:border-red-400 bg-white" />
                  </div>
                  <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 sticky top-0">
                        <tr>
                          {['Parameter','Value','Default?','Session Modifiable','Description'].map(h => (
                            <th key={h} className="px-4 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filteredParams.slice(0, 300).map((p, i) => (
                          <tr key={i} className={`border-t border-slate-100 hover:bg-slate-50 ${i % 2 === 1 ? 'bg-slate-50/30' : ''} ${p.isdefault === 'FALSE' ? 'bg-amber-50/30' : ''}`}>
                            <td className="px-4 py-2.5 font-mono text-xs text-red-700 font-semibold">{p.name}</td>
                            <td className="px-4 py-2.5 font-mono font-bold text-xs text-slate-800">{p.value || '—'}</td>
                            <td className="px-4 py-2.5">
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${p.isdefault === 'TRUE' ? 'bg-slate-100 text-slate-500' : 'bg-amber-100 text-amber-700'}`}>
                                {p.isdefault === 'TRUE' ? 'YES' : 'MODIFIED'}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-[10px] text-slate-500">{p.issys_modifiable || '—'}</td>
                            <td className="px-4 py-2.5 text-[10px] text-slate-400 max-w-[280px] truncate">{p.description || '—'}</td>
                          </tr>
                        ))}
                        {filteredParams.length === 0 && (
                          <tr><td colSpan={5} className="text-center py-10 text-slate-400">No parameters found</td></tr>
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
    </DashboardScopeProvider>
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
  const bg = score >= 80 ? 'bg-emerald-500' : score >= 60 ? 'bg-yellow-400 text-slate-900' : 'bg-red-500';
  const label = score >= 80 ? 'Healthy' : score >= 60 ? 'Warning' : 'Critical';
  return (
    <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-black shadow ${bg} text-white`}>
      <Heart size={12} className="animate-pulse" />
      {label} {score}
    </div>
  );
}

function KpiCard({ icon: Icon, title, value, accent, onClick, hint }) {
  const colorMap = {
    red:    '#C74634',
    orange: '#F97316',
    amber:  '#F59E0B',
    green:  '#22C55E',
    blue:   '#3B82F6',
    purple: '#8B5CF6',
    teal:   '#14B8A6',
    slate:  '#64748B',
    cyan:   '#06B6D4',
    indigo: '#6366F1',
  };
  const color = colorMap[accent] || colorMap.slate;
  return (
    <div onClick={onClick}
      className={`bg-white rounded-xl border border-slate-200 p-4 transition-all ${onClick ? 'cursor-pointer hover:shadow-md hover:scale-[1.02] active:scale-[0.99]' : 'hover:shadow-sm'}`}
      style={{ borderLeft: `3px solid ${color}` }}>
      <div className="flex justify-between items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{title}</p>
          <p className="text-[15px] font-black mt-1 truncate" style={{ color }}>{value ?? '—'}</p>
          {hint && <p className="text-[9px] text-slate-300 mt-1 truncate">{hint}</p>}
        </div>
        <Icon size={17} style={{ color, opacity: 0.35 }} className="mt-0.5 flex-shrink-0" />
      </div>
    </div>
  );
}

function MetricKpi({ title, value, accent, onClick }) {
  const colorMap = {
    green:  '#22C55E',
    red:    '#C74634',
    orange: '#F97316',
    amber:  '#F59E0B',
    blue:   '#3B82F6',
    purple: '#8B5CF6',
    teal:   '#14B8A6',
    slate:  '#64748B',
  };
  const color = colorMap[accent] || colorMap.slate;
  return (
    <div onClick={onClick}
      className={`bg-white rounded-xl border border-slate-200 p-4 transition-all ${onClick ? 'cursor-pointer hover:shadow-md hover:scale-[1.02]' : ''}`}
      style={{ borderLeft: `3px solid ${color}` }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{title}</p>
          <p className="text-[22px] font-black mt-1" style={{ color }}>{value ?? '—'}</p>
        </div>
        {onClick && <ChevronRight size={14} className="text-slate-300 flex-shrink-0 mt-1" />}
      </div>
    </div>
  );
}

function SessionDetailTable({ sessions = [] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-slate-50 sticky top-0">
          <tr>{['SID','Username','Status','Machine','Wait Event','Sec Wait','SQL ID'].map(h=>(
            <th key={h} className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
          ))}</tr>
        </thead>
        <tbody>
          {sessions.map((s,i)=>(
            <tr key={i} className={`border-t border-slate-100 ${i%2===1?'bg-slate-50/30':''} ${s.blocking_session?'bg-red-50/50':''}`}>
              <td className="px-3 py-2 font-mono text-slate-500">{s.sid}</td>
              <td className="px-3 py-2 font-bold text-red-700">{s.username||'—'}</td>
              <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${s.status==='ACTIVE'?'bg-green-100 text-green-700':'bg-slate-100 text-slate-500'}`}>{s.status||'—'}</span></td>
              <td className="px-3 py-2 text-slate-400 max-w-[100px] truncate">{s.machine||'—'}</td>
              <td className="px-3 py-2 text-orange-600 max-w-[120px] truncate">{s.wait_event||'—'}</td>
              <td className={`px-3 py-2 font-bold ${Number(s.seconds_in_wait)>60?'text-red-600':Number(s.seconds_in_wait)>10?'text-orange-600':'text-slate-600'}`}>{s.seconds_in_wait||0}</td>
              <td className="px-3 py-2 font-mono text-slate-400">{s.sql_id||'—'}</td>
            </tr>
          ))}
          {sessions.length===0 && <tr><td colSpan={7} className="text-center py-8 text-slate-400">No sessions</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/* System Health — a Grafana-style health-score stat tile + a cache-hit-ratio
   time-series panel + a row of status stat tiles. Only 5 vitals are surfaced
   here (DB Status, Sessions, Buffer Hit, Library Cache, Archive Log) — CPU
   already has its own ring gauge in Host Resources above, and Tablespace has
   its own KPI card + drill-down, so neither is duplicated here. */
function SystemHealthPanel({ healthScore, hs, sessionPct, totalSess, maxSess, bufHitPct, libHitPct, sparklines }) {
  const scoreColor = healthScore >= 80 ? C.green : healthScore >= 60 ? C.amber : C.red;
  const scoreLabel = healthScore >= 80 ? 'Healthy' : healthScore >= 60 ? 'Degraded' : 'Critical';

  const trend = sparklines.bufHit.map((p, i) => ({
    t: p.t,
    bufHit: p.v,
    libHit: sparklines.libHit[i]?.v ?? null,
  }));

  const tiles = [
    { label: 'DB Status',      value: hs.status || '—',    status: hs.status === 'OPEN' ? 'good' : 'crit',
      sub: hs.status === 'OPEN' ? 'read-write' : 'not open' },
    { label: 'Sessions',       value: totalSess,           status: sessionPct < 80 ? 'good' : sessionPct < 95 ? 'warn' : 'crit',
      sub: `of ${maxSess} max` },
    { label: 'Buffer Hit',     value: `${bufHitPct}%`,     status: bufHitPct >= 90 ? 'good' : bufHitPct >= 80 ? 'warn' : 'crit',
      sub: 'logical read eff.' },
    { label: 'Library Cache',  value: `${libHitPct}%`,     status: libHitPct >= 95 ? 'good' : libHitPct >= 90 ? 'warn' : 'crit',
      sub: libHitPct >= 95 ? 'on target' : 'below 95% target' },
    { label: 'Archive Log',    value: hs.log_mode || '—',  status: hs.log_mode === 'ARCHIVELOG' ? 'good' : 'crit',
      sub: hs.log_mode === 'ARCHIVELOG' ? 'point-in-time recovery on' : 'no PITR' },
  ];
  const colorOf = (s) => (s === 'good' ? C.green : s === 'warn' ? C.amber : C.red);

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-black text-slate-600 uppercase tracking-widest">System Health</h3>
        <span className="text-[10px] text-slate-400 font-semibold">5 vitals · live</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[200px_1fr] gap-3 mb-3">
        {/* Health score tile */}
        <div className="rounded-xl border border-slate-200 p-4 flex flex-col justify-between"
          style={{ background: `linear-gradient(160deg, ${scoreColor}1a, transparent 65%)`, borderLeft: `3px solid ${scoreColor}` }}>
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Health Score</span>
          <div className="flex items-baseline gap-1">
            <span className="text-4xl font-black font-mono" style={{ color: scoreColor }}>{healthScore}</span>
            <span className="text-xs text-slate-400">/100</span>
          </div>
          <span className="text-xs font-bold" style={{ color: scoreColor }}>{scoreLabel}</span>
        </div>

        {/* Cache hit ratio time series */}
        <div className="rounded-xl border border-slate-200 p-3 bg-slate-50/60">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Cache Hit Ratios</span>
            <span className="text-[10px] text-slate-400 font-mono">last {trend.length} samples</span>
          </div>
          {trend.length > 2 ? (
            <TrendChart data={trend} xKey="t" height={100} showLegend={false} yDomain={[0, 100]}
              series={[
                { key: 'bufHit', label: 'Buffer Cache Hit', color: C.green },
                { key: 'libHit', label: 'Library Cache Hit', color: C.amber },
              ]} />
          ) : (
            <div className="h-[100px] flex items-center justify-center text-[11px] text-slate-400">Trend appears after the next couple of refreshes</div>
          )}
          <div className="flex gap-4 mt-1 text-[10.5px]">
            <span className="flex items-center gap-1.5 text-slate-500"><span className="w-2 h-2 rounded-full" style={{ background: C.green }} />Buffer Hit <b className="font-mono text-slate-700">{bufHitPct}%</b></span>
            <span className="flex items-center gap-1.5 text-slate-500"><span className="w-2 h-2 rounded-full" style={{ background: C.amber }} />Library Cache <b className="font-mono text-slate-700">{libHitPct}%</b></span>
          </div>
        </div>
      </div>

      {/* Status stat tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
        {tiles.map(t => {
          const c = colorOf(t.status);
          return (
            <div key={t.label} className="rounded-lg border border-slate-200 px-3 py-2.5" style={{ borderLeftWidth: 3, borderLeftColor: c }}>
              <p className="text-[9.5px] font-black text-slate-400 uppercase tracking-wider truncate">{t.label}</p>
              <p className="text-base font-black font-mono mt-0.5 truncate" style={{ color: c }}>{t.value}</p>
              <p className="text-[10px] text-slate-400 truncate">{t.sub}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Panel({ title, children }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      {title && (
        <div className="px-5 py-4 border-b border-slate-100">
          <h3 className="font-bold text-slate-800 text-sm">{title}</h3>
        </div>
      )}
      <div className="p-5">{children}</div>
    </div>
  );
}

function Row({ label, value, mono }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 border-b border-slate-100 last:border-0">
      <span className="text-slate-400 text-xs flex-shrink-0">{label}</span>
      <span className={`text-right font-semibold text-slate-800 text-xs ${mono ? 'font-mono' : ''} break-all`}>{value ?? '—'}</span>
    </div>
  );
}

function TabLoader() {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-3">
      <div className="w-10 h-10 border-4 border-red-100 border-t-red-500 rounded-full animate-spin" />
      <p className="text-xs text-slate-400 font-semibold">Loading data…</p>
    </div>
  );
}

/* ── Full table detail (opens when a schema-browser table row is clicked) ── */
function SchemaTableModal({ table: t, owner, onClose }) {
  const cols = t.columns || [];
  const idxs = t.indexes || [];
  const pk = idxs.find(i => i.uniqueness === 'UNIQUE');
  const stat = [
    { label: 'Rows',        value: fmtNum(t.num_rows),                 color: C.green },
    { label: 'Columns',     value: t.col_count ?? cols.length,         color: C.indigo },
    { label: 'Indexes',     value: t.idx_count ?? idxs.length,         color: C.blue },
    { label: 'Size',        value: t.size_mb != null ? `${t.size_mb} MB` : '—', color: C.orange },
    { label: 'Last Analyzed', value: t.last_analyzed ? String(t.last_analyzed).slice(0,10) : 'Never', color: C.slate },
    { label: 'Status',      value: t.status || '—',                    color: t.status === 'VALID' ? C.green : C.red },
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="w-full max-w-5xl h-[85vh] bg-slate-50 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* header */}
        <div className="text-white px-6 py-4 flex items-start gap-4 flex-shrink-0"
          style={{ background: 'linear-gradient(135deg,#0f172a 0%,#1e3a5f 55%,#3b0a0a 100%)' }}>
          <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: 'rgba(199,70,52,0.25)', border: '1px solid rgba(199,70,52,0.4)' }}>
            <Table size={20} className="text-red-300" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-black tracking-tight font-mono">{owner}.{t.table_name}</h2>
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-black ${t.status==='VALID'?'bg-green-500':'bg-red-500'}`}>{t.status || '—'}</span>
              {t.partitioned === 'YES' && <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-indigo-500">PARTITIONED</span>}
            </div>
            <p className="text-[12px] mt-0.5" style={{ color: 'rgba(252,165,165,0.85)' }}>
              {fmtNum(t.num_rows)} rows · {cols.length} columns · {idxs.length} indexes
            </p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center flex-shrink-0"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-4">
          {/* KPI strip */}
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
            {stat.map(s => (
              <div key={s.label} className="bg-white rounded-xl border border-slate-200 p-3" style={{ borderLeft: `3px solid ${s.color}` }}>
                <p className="text-[10px] text-slate-400 font-bold uppercase">{s.label}</p>
                <p className="text-[15px] font-black mt-0.5 truncate" style={{ color: s.color }}>{s.value}</p>
              </div>
            ))}
          </div>

          {/* Columns */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2" style={{ borderLeft: '3px solid #6366F1' }}>
              <Code2 size={14} className="text-indigo-500" />
              <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">Columns ({cols.length})</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    {['#','Name','Data Type','Length','Nullable'].map(h => (
                      <th key={h} className="px-4 py-2.5 text-left text-[10px] font-black text-slate-400 uppercase tracking-wide">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cols.map((c, j) => (
                    <tr key={j} className="border-b border-slate-50 hover:bg-slate-50/70">
                      <td className="px-4 py-2.5 text-slate-400 font-mono text-[11px]">{c.column_id}</td>
                      <td className="px-4 py-2.5 font-black text-slate-800">{c.column_name}</td>
                      <td className="px-4 py-2.5 font-mono text-indigo-600">{c.data_type}</td>
                      <td className="px-4 py-2.5 text-slate-500">{c.data_length ?? '—'}</td>
                      <td className="px-4 py-2.5">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${c.nullable==='Y'?'bg-slate-100 text-slate-400':'bg-red-100 text-red-600'}`}>
                          {c.nullable==='Y'?'NULL':'NOT NULL'}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {cols.length === 0 && <tr><td colSpan={5} className="text-center py-6 text-slate-400">No column information</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          {/* Indexes */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2" style={{ borderLeft: '3px solid #3B82F6' }}>
              <Zap size={14} className="text-blue-500" />
              <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">Indexes ({idxs.length})</h3>
            </div>
            <div className="p-4">
              {idxs.length === 0 ? (
                <p className="text-[12px] text-slate-400 italic text-center py-6">No indexes on this table</p>
              ) : (
                <div className="grid sm:grid-cols-2 gap-3">
                  {idxs.map((idx, j) => (
                    <div key={j} className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <span className="font-black text-[12px] text-indigo-700">{idx.index_name}</span>
                        <div className="flex gap-1.5">
                          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${idx.uniqueness==='UNIQUE'?'bg-blue-100 text-blue-700':'bg-slate-100 text-slate-500'}`}>{idx.uniqueness}</span>
                          <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${idx.status==='VALID'?'bg-green-100 text-green-700':'bg-red-100 text-red-700'}`}>{idx.status}</span>
                        </div>
                      </div>
                      <p className="text-[11px] text-slate-500 mt-1.5">
                        <span className="font-bold text-slate-600">Type:</span> {idx.index_type} &nbsp;·&nbsp;
                        <span className="font-bold text-slate-600">Columns:</span> <span className="font-mono text-indigo-600">{idx.columns}</span>
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Advanced context */}
          <div className="grid sm:grid-cols-3 gap-3">
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <p className="text-[10px] font-black text-slate-400 uppercase mb-1 flex items-center gap-1.5"><Key size={12} className="text-amber-500" /> Primary / Unique</p>
              <p className="text-[12px] text-slate-600">{pk ? <span className="font-mono font-bold text-indigo-700">{pk.index_name}</span> : <span className="text-slate-400">None detected</span>}</p>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <p className="text-[10px] font-black text-slate-400 uppercase mb-1 flex items-center gap-1.5"><Boxes size={12} className="text-indigo-500" /> Partitioning</p>
              <p className="text-[12px] text-slate-600">{t.partitioned === 'YES' ? <span className="font-bold text-indigo-700">Partitioned table</span> : <span className="text-slate-400">Not partitioned</span>}</p>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <p className="text-[10px] font-black text-slate-400 uppercase mb-1 flex items-center gap-1.5"><HardDrive size={12} className="text-orange-500" /> Storage</p>
              <p className="text-[12px] text-slate-600">{t.size_mb != null ? <><span className="font-bold text-orange-600">{t.size_mb} MB</span> across {fmtNum(t.num_rows)} rows</> : <span className="text-slate-400">Size unavailable</span>}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TrendCard({ title, data, color, unit = '', fmtVal }) {
  const fmt    = fmtVal || (v => `${v}${unit}`);
  const latest = data[data.length - 1]?.v;
  const gradId = `tg-oracle-${title.replace(/\s+/g, '')}`;
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
              <stop offset="5%"  stopColor={color} stopOpacity={0.2} />
              <stop offset="95%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="t" hide />
          <YAxis hide domain={['auto', 'auto']} />
          <Tooltip contentStyle={{ fontSize: 9, padding: '2px 8px', borderRadius: 8 }} formatter={v => fmt(v)} labelFormatter={() => ''} />
          <Area type="monotone" dataKey="v" stroke={color} fill={`url(#${gradId})`} strokeWidth={2} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
      <div className="flex justify-between text-[9px] text-slate-300 mt-1">
        <span>{fmt(data[0]?.v)}</span>
        <span className="text-slate-400">{data.length} samples · {REFRESH_INTERVAL}s</span>
      </div>
    </div>
  );
}
