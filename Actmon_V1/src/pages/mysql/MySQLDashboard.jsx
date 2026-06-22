import React, { useState, useEffect, useRef } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Database, Server, Activity, HardDrive, RefreshCw, Clock,
  Layers, Network, ShieldCheck, AlertTriangle, Cpu, MemoryStick,
  FileText, Zap, Terminal, GitBranch, Archive, RotateCcw,
  CheckCircle2, XCircle, ChevronRight, Heart, Users, Lock,
  TrendingUp, BarChart2, Table, Settings, Bell, ArrowUp,
  ArrowDown, Minus, Search, Filter,
  ChevronDown, ChevronUp, Code2, FolderOpen, Key, Link as LinkIcon,
  Copy, Wifi, WifiOff, Loader2, Eye, X,
} from 'lucide-react';
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  LineChart, Line, AreaChart, Area,
} from 'recharts';
import client from '../../api/client';

/* ─── palette ─── */
const C = {
  teal:   '#00758F',
  green:  '#22C55E',
  red:    '#EF4444',
  cyan:   '#06B6D4',
  orange: '#F97316',
  yellow: '#EAB308',
  purple: '#8B5CF6',
  blue:   '#3B82F6',
  slate:  '#64748B',
};

/* ─── fetchers ─── */
const fetchDashboard      = (id) => client.get(`/connections/mysql/${id}/dashboard`).then(r => r.data);
const fetchBackupInfo     = (id) => client.get(`/connections/mysql/${id}/backup-info`).then(r => r.data);
const fetchTableStats     = (id) => client.get(`/connections/mysql/${id}/table-stats`).then(r => r.data);
const fetchUserStats      = (id) => client.get(`/connections/mysql/${id}/user-stats`).then(r => r.data);
const fetchInnoDBMetrics  = (id) => client.get(`/connections/mysql/${id}/innodb-metrics`).then(r => r.data);
const fetchDatabases      = (id) => client.get(`/connections/mysql/${id}/databases`).then(r => r.data);
const fetchTablesInDB     = (id, db) => client.get(`/connections/mysql/${id}/databases/${db}/tables`).then(r => r.data);
const fetchTableDetail    = (id, db, tbl) => client.get(`/connections/mysql/${id}/databases/${db}/tables/${tbl}`).then(r => r.data);
const fetchTableData      = (id, db, tbl) => client.get(`/connections/mysql/${id}/databases/${db}/tables/${tbl}/data`).then(r => r.data);
const fetchReplication    = (id) => client.get(`/connections/mysql/${id}/replication/status`).then(r => r.data);
const fetchReplVars       = (id) => client.get(`/connections/mysql/${id}/replication/variables`).then(r => r.data);
const fetchPerfDetail     = (id) => client.get(`/connections/mysql/${id}/performance-detail`).then(r => r.data);
const fetchBinlogStatus   = (id) => client.get(`/connections/mysql/${id}/binlog/status`).then(r => r.data);
const fetchBinlogs        = (id) => client.get(`/connections/mysql/${id}/binlogs`).then(r => r.data);
const fetchBinlogLive     = (id) => client.get(`/connections/mysql/${id}/binlog/live`).then(r => r.data);
const fetchBinlogEvents   = (id, logName, offset, limit) =>
  client.get(`/connections/mysql/${id}/binlogs/${encodeURIComponent(logName)}/events`, { params: { offset, limit } }).then(r => r.data);

const TABS = [
  { id: 'overview',    label: 'Overview',      icon: Activity },
  { id: 'performance', label: 'Performance',    icon: TrendingUp },
  { id: 'queries',     label: 'Queries',        icon: Zap },
  { id: 'databases',   label: 'Databases',      icon: Database },
  { id: 'tables',      label: 'Tables',         icon: Table },
  { id: 'locks',       label: 'Locks',          icon: Lock },
  { id: 'replication', label: 'Replication',    icon: GitBranch },
  { id: 'users',       label: 'Users',          icon: Users },
  { id: 'storage',     label: 'Storage',        icon: HardDrive },
  { id: 'backup',      label: 'Backup & PITR',  icon: Archive },
  { id: 'logs',        label: 'Logs',           icon: FileText },
];

const REFRESH_INTERVAL = 15; // seconds

/* ═══════════════════════════════════════════════════════════════════════════
   DIAGNOSIS CENTER — shown when MySQL connection fails
   ═══════════════════════════════════════════════════════════════════════════ */
function DiagnosisCenter({ id, error, data, refetch }) {
  const navigate = useNavigate();
  const [diagChecks, setDiagChecks] = React.useState({ running: false, done: false, results: [] });

  const { data: logsData, isLoading: logsLoading, refetch: refetchLogs } = useQuery({
    queryKey: ['mysqlDiagLogs', id],
    queryFn: () => client.get(`/connections/mysql/${id}/error-logs`).then(r => r.data),
    retry: false,
    refetchInterval: 30000,
  });

  const errMsg  = data?.error || error?.message || 'Unknown connection error';
  const errCode = (errMsg.match(/\((\d+),/) || [])[1] || null;
  const logs    = (logsData?.logs || []).slice(0, 20);

  const errorCauses = {
    '2003': ['MySQL / MariaDB service is stopped', 'Port 3306 is blocked by firewall', 'Wrong host or port in connection config'],
    '1130': ['DB user not granted for this host IP', 'Run: GRANT ALL ON db.* TO user@\'%\' IDENTIFIED BY \'pass\''],
    '1045': ['Wrong username or password', 'User account may be locked'],
    '2013': ['Server closed the connection (timeout or crash)', 'Check server memory / OOM killer'],
  };
  const causes = errorCauses[errCode] || [
    'MySQL service may have crashed or stopped',
    'Server is unreachable (network / VM offline)',
    'OOM killer terminated mysqld',
    'Disk full — check /var/lib/mysql',
  ];

  const SEV_STYLE = {
    CRITICAL: 'border-l-red-500    bg-red-950/40   text-red-200',
    ERROR:    'border-l-orange-500 bg-orange-950/30 text-orange-200',
    WARNING:  'border-l-yellow-500 bg-yellow-950/20 text-yellow-200',
    INFO:     'border-l-slate-600  bg-slate-800/40  text-slate-300',
  };
  const SEV_BADGE = {
    CRITICAL: 'bg-red-500 text-white',
    ERROR:    'bg-orange-500 text-white',
    WARNING:  'bg-yellow-400 text-black',
    INFO:     'bg-slate-600 text-white',
  };

  return (
    <div className="min-h-screen bg-slate-950 text-white flex flex-col">

      {/* ── Header ──────────────────────────────────────────── */}
      <div className="bg-gradient-to-r from-red-950 to-slate-900 border-b border-red-800/60 px-6 py-4 flex-shrink-0">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="w-4 h-4 bg-red-500 rounded-full" />
              <div className="w-4 h-4 bg-red-500 rounded-full absolute inset-0 animate-ping opacity-60" />
            </div>
            <div>
              <h1 className="font-bold text-xl text-white leading-tight">Server Offline — Diagnosis Center</h1>
              <p className="text-red-300 text-xs mt-0.5">
                Connection {id} · MySQL failed to respond
                {errCode && <span className="ml-2 px-1.5 py-0.5 bg-red-900 border border-red-700 rounded text-red-300 font-mono">
                  Error #{errCode}
                </span>}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => refetch()}
              className="flex items-center gap-2 px-4 py-2 bg-white/10 border border-white/20 rounded-xl text-sm font-semibold hover:bg-white/20 transition-colors"
            >
              <RefreshCw size={14} /> Retry Connection
            </button>
            <button
              onClick={() => navigate(`/mysql-dashboard/${id}/error-logs`)}
              className="flex items-center gap-2 px-4 py-2 bg-red-700 hover:bg-red-600 rounded-xl text-sm font-semibold transition-colors"
            >
              <FileText size={14} /> Error Logs
            </button>
            <button
              onClick={() => navigate(`/mysql-dashboard/${id}/self-heal`)}
              className="flex items-center gap-2 px-4 py-2 bg-purple-700 hover:bg-purple-600 rounded-xl text-sm font-semibold transition-colors"
            >
              <Heart size={14} /> Self-Heal
            </button>
          </div>
        </div>
      </div>

      {/* ── Body ────────────────────────────────────────────── */}
      <div className="flex-1 max-w-7xl mx-auto w-full px-6 py-6 grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* Left column */}
        <div className="space-y-4">

          {/* Error message */}
          <div className="bg-slate-900 border border-red-900/60 rounded-2xl p-5">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
              <XCircle size={13} className="text-red-500" /> Connection Error
            </p>
            <p className="text-red-200 text-xs font-mono leading-relaxed break-all bg-red-950/30 border border-red-900/40 rounded-xl p-3">
              {errMsg}
            </p>
          </div>

          {/* Possible causes */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
              <AlertTriangle size={13} className="text-yellow-500" /> Possible Causes
            </p>
            <ul className="space-y-2">
              {causes.map((c, i) => (
                <li key={i} className="flex gap-2 text-xs text-slate-300">
                  <span className="text-yellow-500 mt-0.5 flex-shrink-0">▸</span>
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Quick actions */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
              <Zap size={13} className="text-cyan-400" /> Quick Actions
            </p>
            <div className="space-y-2">
              {[
                { icon: FileText, label: 'View Error Logs',    sub: 'SSH + journalctl',    color: 'text-red-400',    path: `/mysql-dashboard/${id}/error-logs` },
                { icon: Heart,    label: 'Self-Heal Terminal', sub: 'SSH root commands',   color: 'text-pink-400',   path: `/mysql-dashboard/${id}/self-heal` },
                { icon: Activity, label: 'Slow Query Analysis',sub: 'When server is up',  color: 'text-yellow-400', path: `/mysql-dashboard/${id}/slow-queries` },
                { icon: Layers,   label: 'Index Analysis',     sub: 'Schema diagnostics',  color: 'text-violet-400', path: `/mysql-dashboard/${id}/index-analysis` },
              ].map(({ icon: Icon, label, sub, color, path }) => (
                <button
                  key={path}
                  onClick={() => navigate(path)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 bg-slate-800 hover:bg-slate-700 rounded-xl text-left transition-colors group"
                >
                  <Icon size={16} className={color} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white">{label}</p>
                    <p className="text-[11px] text-slate-500">{sub}</p>
                  </div>
                  <ChevronRight size={14} className="text-slate-600 group-hover:text-slate-400 flex-shrink-0" />
                </button>
              ))}
            </div>
          </div>

          {/* Log summary counts */}
          {logsData?.summary && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Log Summary</p>
              <div className="grid grid-cols-2 gap-2">
                {Object.entries(logsData.summary.severities || {}).map(([sev, cnt]) => (
                  <div key={sev} className="flex flex-col items-center py-3 bg-slate-800 rounded-xl">
                    <span className={`text-xl font-bold ${
                      sev === 'CRITICAL' ? 'text-red-400' :
                      sev === 'ERROR'    ? 'text-orange-400' :
                      sev === 'WARNING'  ? 'text-yellow-400' : 'text-slate-400'
                    }`}>{cnt}</span>
                    <span className="text-[10px] text-slate-500 uppercase tracking-wider mt-0.5">{sev}</span>
                  </div>
                ))}
              </div>
              {logsData.source && (
                <p className="text-[11px] text-slate-500 mt-3 text-center">
                  Source: <span className="text-cyan-500">{logsData.source}</span>
                  {logsData.log_path && logsData.log_path !== 'none' && (
                    <span className="ml-1 font-mono">{logsData.log_path}</span>
                  )}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Right 2-col: Error log feed */}
        <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-2xl flex flex-col">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 flex-shrink-0">
            <div className="flex items-center gap-2">
              <Terminal size={15} className="text-cyan-400" />
              <span className="font-semibold text-sm text-white">Last Known Server Logs</span>
              {logsData?.source && (
                <span className="text-[11px] px-2 py-0.5 bg-cyan-900/40 border border-cyan-800 text-cyan-400 rounded-full">
                  {logsData.source}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => refetchLogs()}
                className="p-1.5 hover:bg-slate-700 rounded-lg transition-colors"
                title="Refresh logs"
              >
                <RefreshCw size={13} className="text-slate-400" />
              </button>
              <button
                onClick={() => navigate(`/mysql-dashboard/${id}/error-logs`)}
                className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
              >
                Open full view →
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {logsLoading ? (
              <div className="flex flex-col items-center justify-center h-48 gap-3">
                <div className="w-8 h-8 border-2 border-cyan-500/20 border-t-cyan-500 rounded-full animate-spin" />
                <p className="text-slate-500 text-sm">Fetching logs via SSH…</p>
              </div>
            ) : logs.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 gap-3">
                <FileText size={32} className="text-slate-700" />
                <p className="text-slate-500 text-sm text-center">
                  {logsData?.source === 'none'
                    ? 'Error logging is disabled on this server'
                    : 'No log entries found'}
                </p>
                {logsData?.note && (
                  <p className="text-slate-600 text-xs text-center max-w-sm">{logsData.note}</p>
                )}
                <button
                  onClick={() => navigate(`/mysql-dashboard/${id}/error-logs`)}
                  className="mt-2 px-4 py-2 bg-cyan-900/40 border border-cyan-800 text-cyan-400 rounded-xl text-xs hover:bg-cyan-900/60 transition-colors"
                >
                  Configure SSH + Enable Logging →
                </button>
              </div>
            ) : (
              <div className="space-y-1.5">
                {logs.map((log, i) => {
                  const sev = log.severity || 'INFO';
                  return (
                    <div
                      key={i}
                      className={`px-3 py-2 rounded-lg text-[11px] font-mono border-l-2 ${SEV_STYLE[sev] || SEV_STYLE.INFO}`}
                    >
                      <div className="flex gap-2 items-start">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 ${SEV_BADGE[sev] || SEV_BADGE.INFO}`}>
                          {sev}
                        </span>
                        {log.logged && (
                          <span className="text-slate-500 flex-shrink-0 whitespace-nowrap">{log.logged}</span>
                        )}
                        <span className="break-all leading-relaxed">{log.message}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer hint */}
          <div className="border-t border-slate-800 px-5 py-3 flex items-center justify-between flex-shrink-0">
            <p className="text-[11px] text-slate-600">
              {logs.length > 0 ? `Showing ${logs.length} most recent entries` : 'SSH credentials needed for remote log access'}
            </p>
            <button
              onClick={() => navigate(`/mysql-dashboard/${id}/error-logs`)}
              className="text-xs text-purple-400 hover:text-purple-300 flex items-center gap-1 transition-colors"
            >
              <Zap size={11} /> AI Analysis + Self-Heal
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function MySQLDashboard() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [activeTab, setActiveTab]     = useState('overview');
  const [countdown, setCountdown]     = useState(REFRESH_INTERVAL);
  const [sparklines, setSparklines]   = useState({ conn: [], cache: [], qps: [] });
  const [tableSearch, setTableSearch] = useState('');
  const countRef = useRef(null);

  // Table Explorer state
  const [selDb, setSelDb]       = useState(null);
  const [selTable, setSelTable] = useState(null);
  const [tblSubTab, setTblSub]  = useState('columns');
  const [tblSearch, setTblSearch] = useState('');

  // Replication state
  const [replVarsOpen, setReplVarsOpen] = useState(false);

  // Binary log state
  const [selBinlog, setSelBinlog]       = useState(null);
  const [binlogOffset, setBinlogOffset] = useState(0);
  const [liveFilter, setLiveFilter]     = useState('all');
  const BINLOG_PAGE = 100;

  // Performance tab state
  const [perfStmtSort, setPerfStmtSort] = useState({ key: 'sum_ms', asc: false });
  const [perfStmtSearch, setPerfStmtSearch] = useState('');
  const [perfSection, setPerfSection] = useState('all');
  const [perfSparklines, setPerfSparklines] = useState({ qps: [], hit: [], txns: [] });

  // Drill-down / expand state
  const [expandedProcId, setExpandedProcId] = useState(null);
  const [expandedTxnId,  setExpandedTxnId]  = useState(null);
  const [drillModal, setDrillModal]         = useState(null); // {title, subtitle, content}

  /* ── Main dashboard query ── */
  const { data, isLoading, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['mysqlDashboard', id],
    queryFn:  () => fetchDashboard(id),
    retry: false,
    refetchInterval: REFRESH_INTERVAL * 1000,
  });

  /* ── Backup query ── */
  const { data: backupData, isLoading: backupLoading } = useQuery({
    queryKey: ['mysqlBackup', id],
    queryFn:  () => fetchBackupInfo(id),
    retry: false,
    refetchInterval: 60000,
    enabled: activeTab === 'backup',
  });

  /* ── Table stats query ── */
  const { data: tableData, isLoading: tableLoading } = useQuery({
    queryKey: ['mysqlTableStats', id],
    queryFn:  () => fetchTableStats(id),
    retry: false,
    refetchInterval: 30000,
    enabled: activeTab === 'tables' || activeTab === 'storage',
  });

  /* ── User stats query ── */
  const { data: userData, isLoading: userLoading } = useQuery({
    queryKey: ['mysqlUserStats', id],
    queryFn:  () => fetchUserStats(id),
    retry: false,
    refetchInterval: 15000,
    enabled: activeTab === 'users',
  });

  /* ── InnoDB metrics query ── */
  const { data: innodbData, isLoading: innodbLoading } = useQuery({
    queryKey: ['mysqlInnoDBMetrics', id],
    queryFn:  () => fetchInnoDBMetrics(id),
    retry: false,
    refetchInterval: 15000,
    enabled: activeTab === 'performance' || activeTab === 'locks',
  });

  /* ── Table Explorer queries ── */
  const { data: dbListData, isLoading: dbListLoading } = useQuery({
    queryKey: ['mysqlDatabases', id],
    queryFn:  () => fetchDatabases(id),
    retry: false,
    refetchInterval: 30000,
    enabled: activeTab === 'tables',
  });
  const { data: tblListData, isLoading: tblListLoading } = useQuery({
    queryKey: ['mysqlTableList', id, selDb],
    queryFn:  () => fetchTablesInDB(id, selDb),
    retry: false,
    enabled: activeTab === 'tables' && !!selDb,
  });
  const { data: tblDetailData, isLoading: tblDetailLoading } = useQuery({
    queryKey: ['mysqlTableDetail', id, selDb, selTable],
    queryFn:  () => fetchTableDetail(id, selDb, selTable),
    retry: false,
    enabled: activeTab === 'tables' && !!selDb && !!selTable,
  });
  const { data: tblSampleData, isLoading: tblSampleLoading } = useQuery({
    queryKey: ['mysqlTableSample', id, selDb, selTable],
    queryFn:  () => fetchTableData(id, selDb, selTable),
    retry: false,
    enabled: activeTab === 'tables' && !!selDb && !!selTable && tblSubTab === 'sample',
  });

  /* ── Replication queries ── */
  const { data: replData, isLoading: replLoading, refetch: refetchRepl } = useQuery({
    queryKey: ['mysqlReplication', id],
    queryFn:  () => fetchReplication(id),
    retry: false,
    refetchInterval: 4000,
    enabled: activeTab === 'replication',
  });
  const { data: replVarsData, isLoading: replVarsLoading } = useQuery({
    queryKey: ['mysqlReplVars', id],
    queryFn:  () => fetchReplVars(id),
    retry: false,
    enabled: activeTab === 'replication' && replVarsOpen,
  });

  /* ── Binlog queries (Logs tab) ── */
  const { data: binlogStatusData } = useQuery({
    queryKey: ['mysqlBinlogStatus', id],
    queryFn:  () => fetchBinlogStatus(id),
    retry: false,
    refetchInterval: 15000,
    enabled: activeTab === 'logs',
  });
  const { data: binlogsData, isLoading: binlogsLoading } = useQuery({
    queryKey: ['mysqlBinlogs', id],
    queryFn:  () => fetchBinlogs(id),
    retry: false,
    refetchInterval: 30000,
    enabled: activeTab === 'logs',
  });
  const { data: binlogLiveData, isLoading: liveLoading } = useQuery({
    queryKey: ['mysqlBinlogLive', id],
    queryFn:  () => fetchBinlogLive(id),
    retry: false,
    refetchInterval: 5000,
    enabled: activeTab === 'logs',
  });
  const { data: binlogEventsData, isLoading: eventsLoading } = useQuery({
    queryKey: ['mysqlBinlogEvents', id, selBinlog, binlogOffset],
    queryFn:  () => fetchBinlogEvents(id, selBinlog, binlogOffset, BINLOG_PAGE),
    retry: false,
    enabled: activeTab === 'logs' && !!selBinlog,
  });

  /* ── Performance Detail query ── */
  const { data: perfData, isLoading: perfLoading, refetch: refetchPerf, dataUpdatedAt: perfUpdatedAt } = useQuery({
    queryKey: ['mysqlPerfDetail', id],
    queryFn:  () => fetchPerfDetail(id),
    retry: false,
    refetchInterval: 15000,
    enabled: activeTab === 'performance',
  });

  /* ── Perf sparklines ── */
  useEffect(() => {
    if (!perfData) return;
    const qps    = perfData?.query_quality?.qps    || 0;
    const hit    = perfData?.buffer_pool?.hit_ratio || 0;
    const txns   = (perfData?.active_transactions || []).length;
    setPerfSparklines(prev => ({
      qps:  [...prev.qps.slice(-30),  { t: new Date().toLocaleTimeString(), v: qps  }],
      hit:  [...prev.hit.slice(-30),  { t: new Date().toLocaleTimeString(), v: hit  }],
      txns: [...prev.txns.slice(-30), { t: new Date().toLocaleTimeString(), v: txns }],
    }));
  }, [perfUpdatedAt]);

  /* ── Countdown timer ── */
  useEffect(() => {
    setCountdown(REFRESH_INTERVAL);
    if (countRef.current) clearInterval(countRef.current);
    countRef.current = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { return REFRESH_INTERVAL; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(countRef.current);
  }, [dataUpdatedAt]);

  /* ── Sparkline data collection ── */
  useEffect(() => {
    if (!data) return;
    const connPct  = Number(data?.health_summary?.connection_usage_pct) || 0;
    const cachePct = Number(data?.health_summary?.cache_usage_pct)      || 0;
    const qps      = Number(data?.query_stats?.Questions) || 0;
    setSparklines(prev => ({
      conn:  [...prev.conn.slice(-20),  { t: new Date().toLocaleTimeString(), v: connPct  }],
      cache: [...prev.cache.slice(-20), { t: new Date().toLocaleTimeString(), v: cachePct }],
      qps:   [...prev.qps.slice(-20),   { t: new Date().toLocaleTimeString(), v: qps      }],
    }));
  }, [data]);

  if (isLoading) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center">
        <div className="w-12 h-12 border-4 border-cyan-200 border-t-cyan-600 rounded-full animate-spin mx-auto mb-4" />
        <p className="text-slate-600 font-semibold">Connecting to MySQL…</p>
      </div>
    </div>
  );

  if (error || data?.status === 'error') return (
    <DiagnosisCenter id={id} error={error} data={data} refetch={refetch} />
  );

  const {
    connection = {}, health_summary = {}, databases = [], query_stats = {},
    connections_detail = {}, memory = {}, network = {}, replication = {},
    process_list = [], long_running_queries = [], slow_query_config = {},
    error_log_path = '', error_log_count = 0,
    threads = {}, tps = {}, aborted = {}, table_locks = {},
    tmp_tables = {}, binlog = {}, server_vars = {},
  } = data || {};

  const isReplica  = health_summary.replication_state === 'REPLICA';
  const connPct    = Number(health_summary.connection_usage_pct) || 0;
  const cachePct   = Number(health_summary.cache_usage_pct)      || 0;
  const healthScore = computeHealthScore(health_summary, long_running_queries, connPct, cachePct);

  /* ── alert counts per tab ── */
  const alerts = {
    queries:     long_running_queries.length,
    locks:       (innodbData?.metrics?.deadlocks || 0),
    replication: isReplica && replication.Last_Error ? 1 : 0,
    logs:        error_log_count > 0 ? 1 : 0,
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">

      {/* ─── Drill-down Modal ─── */}
      {drillModal && (
        <DetailModal title={drillModal.title} subtitle={drillModal.subtitle} onClose={() => setDrillModal(null)}>
          {drillModal.content}
        </DetailModal>
      )}

      {/* ─── TOP HEADER ─── */}
      <div className="bg-gradient-to-r from-slate-900 via-cyan-900 to-teal-800 text-white shadow-xl">
        <div className="px-6 py-4 flex flex-wrap justify-between items-start gap-3">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-cyan-400/20 border border-cyan-400/40 rounded-2xl flex items-center justify-center text-2xl">
              🐬
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight">MySQL Dashboard</h1>
              <p className="text-cyan-300 text-sm mt-0.5">
                {connection?.name || 'MySQL'} — {connection?.host}:{connection?.port}
                {connection?.database ? ` / ${connection.database}` : ''}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* health score */}
            <HealthBadge score={healthScore} />

            {/* quick links */}
            {[
              { to: `/mysql-dashboard/${id}/slow-queries`,   label: 'Slow Queries' },
              { to: `/mysql-dashboard/${id}/error-logs`,     label: 'Error Logs' },
              { to: `/mysql-dashboard/${id}/error-analysis`, label: 'AI Analysis' },
              { to: `/mysql-dashboard/${id}/index-analysis`, label: 'Indexes' },
              { to: `/mysql-dashboard/${id}/self-heal`,      label: 'Self-Heal' },
              { to: `/mysql-dashboard/${id}/reports`,        label: 'Reports' },
            ].map(({ to, label }) => (
              <Link key={to} to={to}
                className="px-3 py-1.5 rounded-lg border border-white/20 hover:bg-white/10 text-xs font-semibold text-white/80 hover:text-white">
                {label}
              </Link>
            ))}

            {/* refresh */}
            <button onClick={() => refetch()}
              className="flex items-center gap-2 px-4 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg text-sm font-semibold">
              <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} />
              <span>Refresh</span>
              <span className="ml-1 w-5 h-5 rounded-full bg-cyan-500/30 text-cyan-200 text-[10px] font-black flex items-center justify-center">
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
              <button key={tab.id}
                onClick={() => tab.id === 'backup' ? navigate(`/mysql-dashboard/${id}/backup`) : setActiveTab(tab.id)}
                className={`relative flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-t-lg whitespace-nowrap transition-all ${
                  activeTab === tab.id
                    ? 'bg-slate-50 text-cyan-700'
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
          const threadRunPct = Math.min(100, Math.round(((threads.running || 1) / Math.max(health_summary.max_connections, 1)) * 100));
          const slowPct = query_stats.Questions > 0
            ? Math.min(100, +((query_stats.Slow_queries / query_stats.Questions) * 100).toFixed(2))
            : 0;
          const DB_COLORS = [C.teal, C.blue, C.green, C.orange, C.purple, C.cyan, C.yellow, C.red];
          return (
          <div className="space-y-4">

            {/* ── Row 1: KPI strip — all clickable ── */}
            <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3">
              <KpiCard icon={Clock}     title="Uptime"       value={health_summary.uptime}  accent="cyan" />
              <KpiCard icon={Server}    title="Version"      value={(health_summary.version||'').split('-')[0]} accent="blue" />
              <ClickableKpiCard icon={Database}  title="Databases"    value={health_summary.total_databases}  accent="teal"
                onClick={() => setActiveTab('databases')} />
              <ClickableKpiCard icon={Layers}    title="Tables"       value={health_summary.total_tables}     accent="green"
                onClick={() => setActiveTab('tables')} />
              <ClickableKpiCard icon={HardDrive} title="DB Size"      value={health_summary.total_size_gb > 0.1 ? `${health_summary.total_size_gb} GB` : `${health_summary.total_size_mb || 0} MB`} accent="orange"
                onClick={() => setActiveTab('storage')} />
              <ClickableKpiCard icon={Activity}  title="Questions"    value={fmtNum(query_stats.Questions)}   accent="purple"
                onClick={() => setActiveTab('queries')} />
              <ClickableKpiCard icon={Network}   title="Conns"        value={`${health_summary.current_connections}/${health_summary.max_connections}`} accent={connPct > 80 ? 'red' : 'green'}
                onClick={() => setActiveTab('performance')} />
              <ClickableKpiCard icon={Cpu}       title="Slow Queries" value={fmtNum(query_stats.Slow_queries)} accent={Number(query_stats.Slow_queries) > 0 ? 'red' : 'slate'}
                onClick={() => { setActiveTab('queries'); }} />
            </div>

            {/* ── Row 2: Status badges ── */}
            <div className="flex flex-wrap gap-2">
              <StatusBadge ok={connPct < 80}  label={`Connections ${connPct}%`} />
              <StatusBadge ok={cachePct > 90} label={`Cache Hit ${cachePct}%`} />
              <StatusBadge ok={true}          label={`Engine: ${health_summary.storage_engine || 'InnoDB'}`} />
              <StatusBadge ok={!isReplica || replication.Slave_IO_Running === 'Yes'}
                           label={`Replication: ${health_summary.replication_state || 'STANDALONE'}`} />
              <StatusBadge ok={binlog.enabled} label={`Binlog: ${binlog.enabled ? `ON (${binlog.format || '?'})` : 'OFF'}`} />
              {slow_query_config.slow_query_log === 'ON' && (
                <StatusBadge ok={false} label={`Slow Log ON (>${slow_query_config.long_query_time}s)`} />
              )}
              {long_running_queries.length > 0 && (
                <StatusBadge ok={false} label={`${long_running_queries.length} long-running quer${long_running_queries.length === 1 ? 'y' : 'ies'}`} />
              )}
              {(table_locks.contention_pct || 0) > 5 && (
                <StatusBadge ok={false} label={`Lock Contention ${table_locks.contention_pct}%`} />
              )}
            </div>

            {/* ── Row 3: Semi-circle gauges — click to navigate ── */}
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
              <button onClick={() => setActiveTab('performance')} className="text-left hover:ring-2 hover:ring-cyan-300 rounded-2xl transition-all">
                <GaugeCard title="Connection Pool" pct={connPct}
                  sub={`${health_summary.current_connections} / ${health_summary.max_connections} max · click to detail`}
                  colorFn={v => v > 80 ? C.red : v > 60 ? C.orange : C.teal} />
              </button>
              <button onClick={() => setActiveTab('performance')} className="text-left hover:ring-2 hover:ring-green-300 rounded-2xl transition-all">
                <GaugeCard title="InnoDB Cache Hit" pct={cachePct}
                  sub="Buffer pool read efficiency · click to detail"
                  colorFn={v => v < 70 ? C.red : v < 85 ? C.orange : C.green} />
              </button>
              <button onClick={() => setActiveTab('queries')} className="text-left hover:ring-2 hover:ring-blue-300 rounded-2xl transition-all">
                <GaugeCard title="Active Threads" pct={threadRunPct}
                  centerLabel={threads.running ?? '?'} centerUnit=" active"
                  sub={`${threads.cached || 0} cached · click to see queries`}
                  colorFn={v => v > 50 ? C.orange : C.blue} />
              </button>
              <button onClick={() => setActiveTab('queries')} className="text-left hover:ring-2 hover:ring-red-300 rounded-2xl transition-all">
                <GaugeCard title="Slow Query Ratio"
                  pct={Math.min(100, slowPct * 10)}
                  centerLabel={fmtNum(query_stats.Slow_queries)} centerUnit=" slow"
                  sub={`${slowPct}% of ${fmtNum(query_stats.Questions)} total · click to see`}
                  colorFn={v => v > 30 ? C.red : v > 5 ? C.orange : C.green} />
              </button>
            </div>

            {/* ── Row 4: Live sparklines ── */}
            {sparklines.conn.length > 2 ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <TrendCard title="Connection Usage %" data={sparklines.conn} color={C.teal} unit="%" />
                <TrendCard title="Cache Hit Rate %"   data={sparklines.cache} color={C.green} unit="%" />
                <TrendCard title="Total Questions"    data={sparklines.qps}  color={C.purple} fmtVal={fmtNum} />
              </div>
            ) : (
              <div className="bg-white rounded-2xl border border-slate-200 p-4 text-center text-slate-400 text-xs">
                Live trend charts appear after first 15-second auto-refresh
              </div>
            )}

            {/* ── Row 5: Query bar + DB sizes bar ── */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <ChartCard title="Query Operations (cumulative)">
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={[
                    { name: 'SELECT', v: query_stats.Com_select  || 0 },
                    { name: 'INSERT', v: query_stats.Com_insert  || 0 },
                    { name: 'UPDATE', v: query_stats.Com_update  || 0 },
                    { name: 'DELETE', v: query_stats.Com_delete  || 0 },
                    { name: 'COMMIT', v: query_stats.Com_commit  || 0 },
                    { name: 'ROLLBK', v: query_stats.Com_rollback|| 0 },
                  ]} barCategoryGap="25%">
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 10, fontWeight: 600 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 9 }} tickFormatter={fmtNum} axisLine={false} tickLine={false} />
                    <Tooltip formatter={v => fmtNum(v)} cursor={{ fill: '#f8fafc' }} />
                    <Bar dataKey="v" radius={[5,5,0,0]}>
                      {[C.teal, C.green, C.orange, C.red, C.blue, C.purple].map((fill, i) => (
                        <Cell key={i} fill={fill} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                <div className="grid grid-cols-2 gap-x-4 mt-2">
                  <Row label="Aborted clients"  value={fmtNum(aborted.clients  || 0)} />
                  <Row label="Aborted connects" value={fmtNum(aborted.connects || 0)} />
                  <Row label="Tmp disk tables"  value={`${fmtNum(tmp_tables.disk || 0)} (${tmp_tables.disk_pct || 0}%)`} />
                  <Row label="Table lock waits" value={fmtNum(table_locks.waited || 0)} />
                </div>
              </ChartCard>

              <ChartCard title="Database Size Distribution (MB)">
                {databases.filter(d => !['information_schema','performance_schema','mysql','sys'].includes(d.name)).length > 0 ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart layout="vertical" data={databases.filter(d => !['information_schema','performance_schema','mysql','sys'].includes(d.name)).slice(0, 8)}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={v => `${v}MB`} axisLine={false} tickLine={false} />
                      <YAxis width={110} type="category" dataKey="name" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                      <Tooltip formatter={v => `${v} MB`} cursor={{ fill: '#f8fafc' }} />
                      <Bar dataKey="size_mb" radius={[0,5,5,0]}>
                        {databases.slice(0, 8).map((_, i) => (
                          <Cell key={i} fill={DB_COLORS[i % DB_COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-center text-slate-400 text-xs py-16">No user databases found</p>
                )}
                <div className="grid grid-cols-2 gap-x-4 mt-2">
                  <Row label="Total databases" value={health_summary.total_databases} />
                  <Row label="Total tables"    value={fmtNum(health_summary.total_tables)} />
                  <Row label="Total size"      value={health_summary.total_size_gb > 0.1 ? `${health_summary.total_size_gb} GB` : `${health_summary.total_size_mb || 0} MB`} />
                  <Row label="Storage engine"  value={health_summary.storage_engine || 'InnoDB'} />
                </div>
              </ChartCard>
            </div>

            {/* ── Row 6: Detail panels ── */}
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
              {/* Server info */}
              <Panel title="Server Information">
                <Row label="Hostname"       value={health_summary.host_name || server_vars.hostname || '—'} mono />
                <Row label="Version"        value={health_summary.version   || '—'} mono />
                <Row label="Uptime"         value={health_summary.uptime    || '—'} />
                <Row label="Last Restart"   value={health_summary.last_restart || '—'} />
                <Row label="Storage Engine" value={health_summary.storage_engine || 'InnoDB'} />
                <Row label="Replication"    value={health_summary.replication_state || 'STANDALONE'} />
                <Row label="Binary Logging" value={binlog.enabled ? `ON · ${binlog.format || '?'}` : 'OFF'} />
                <Row label="Data Directory" value={server_vars.datadir || '—'} mono />
              </Panel>

              {/* InnoDB / Memory */}
              <Panel title="InnoDB Buffer Pool">
                <div className="mb-4">
                  <div className="flex justify-between text-xs text-slate-500 mb-1">
                    <span>Cache Hit Rate</span>
                    <span className="font-black">{cachePct}%</span>
                  </div>
                  <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${cachePct}%`, background: cachePct >= 90 ? C.green : cachePct >= 70 ? C.orange : C.red }} />
                  </div>
                </div>
                <Row label="Pool Size"       value={`${memory.buffer_pool_size_mb || 0} MB`} />
                <Row label="Pages Data"      value={fmtNum(memory.pages_data)} />
                <Row label="Pages Total"     value={fmtNum(memory.pages_total)} />
                <Row label="Read Requests"   value={fmtNum(memory.read_requests)} />
                <Row label="Disk Reads"      value={fmtNum(memory.reads)} />
                <Row label="InnoDB Log Size" value={server_vars.innodb_log_file_size_mb ? `${server_vars.innodb_log_file_size_mb} MB` : '—'} />
                <Row label="Table Cache"     value={fmtNum(server_vars.table_open_cache)} />
              </Panel>

              {/* Threads & Network */}
              <Panel title="Threads & Network">
                <div className="mb-4">
                  <div className="flex justify-between text-xs text-slate-500 mb-1">
                    <span>Running Threads</span>
                    <span className="font-black">{threads.running || 0} / {health_summary.max_connections}</span>
                  </div>
                  <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${threadRunPct}%`, background: threadRunPct > 50 ? C.orange : C.blue }} />
                  </div>
                </div>
                <Row label="Running"         value={threads.running   || 0} />
                <Row label="Connected"       value={threads.connected || health_summary.current_connections || 0} />
                <Row label="Cached"          value={threads.cached    || 0} />
                <Row label="Max Used Conns"  value={fmtNum(threads.max_used || 0)} />
                <Row label="Bytes Received"  value={fmtBytes(network.bytes_received)} />
                <Row label="Bytes Sent"      value={fmtBytes(network.bytes_sent)} />
                <Row label="Slow Query Log"  value={`${slow_query_config.slow_query_log || 'OFF'} (>${slow_query_config.long_query_time || 0}s)`} />
              </Panel>
            </div>

            {/* ── Row 7: Long-running alert ── */}
            {long_running_queries.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-2xl p-4">
                <div className="flex items-center gap-2 mb-3">
                  <AlertTriangle className="text-red-500 flex-shrink-0" size={16} />
                  <span className="font-bold text-red-700 text-sm">
                    {long_running_queries.length} Long-Running {long_running_queries.length === 1 ? 'Query' : 'Queries'} Detected
                  </span>
                  <button onClick={() => setActiveTab('queries')}
                    className="ml-auto text-xs text-red-600 hover:text-red-800 underline font-semibold">
                    View All →
                  </button>
                </div>
                <div className="space-y-2">
                  {long_running_queries.slice(0, 3).map((q, i) => (
                    <div key={i} className="bg-white rounded-xl border border-red-100 px-3 py-2 text-xs">
                      <span className="font-bold text-red-600">PID {q.Id}</span>
                      <span className="ml-2 text-slate-500">{q.User}@{(q.Host||'').split(':')[0]}</span>
                      <span className="ml-2 font-black text-orange-600">{q.Time}s</span>
                      <div className="mt-1 font-mono text-slate-500 truncate">{String(q.Info||'').slice(0, 130)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Row 8: Quick actions ── */}
            <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
              <ActionCard icon={<Zap className="text-yellow-500" size={24} />}    title="Slow Queries"   desc="Identify expensive SQL"   onClick={() => navigate(`/mysql-dashboard/${id}/slow-queries`)} />
              <ActionCard icon={<FileText className="text-red-500" size={24} />}  title="Error Logs"     desc="View & classify errors"    onClick={() => navigate(`/mysql-dashboard/${id}/error-logs`)} />
              <ActionCard icon={<Layers className="text-violet-500" size={24} />} title="Index Analysis" desc="Unused, dupe & missing"    onClick={() => navigate(`/mysql-dashboard/${id}/index-analysis`)} />
              <ActionCard icon={<Heart className="text-pink-500" size={24} />}    title="Self-Heal"      desc="AI-powered remediation"    onClick={() => navigate(`/mysql-dashboard/${id}/self-heal`)} />
              <ActionCard icon={<Archive className="text-blue-500" size={24} />}  title="Backup & PITR"  desc="Recovery strategy check"  onClick={() => navigate(`/mysql-dashboard/${id}/backup`)} />
              <ActionCard icon={<FileText className="text-green-500" size={24} />} title="Reports"       desc="Open full DB report"       onClick={() => navigate(`/mysql-dashboard/${id}/reports`)} />
            </div>

          </div>
          );
        })()}

        {/* ══ PERFORMANCE — ADVANCED ════════════════════════════════ */}
        {activeTab === 'performance' && (
          <div className="space-y-5">
            {perfLoading && !perfData ? <TabLoader /> : (() => {
              const p   = perfData || {};
              const bp  = p.buffer_pool      || {};
              const ro  = p.row_ops          || {};
              const io  = p.innodb_io        || {};
              const lk  = p.locking          || {};
              const so  = p.sort_ops         || {};
              const tt  = p.tmp_tables       || {};
              const co  = p.connections      || {};
              const hd  = p.handler_stats    || {};
              const qq  = p.query_quality    || {};
              const kc  = p.key_cache        || {};
              const cfg = p.server_config    || {};
              const trx = p.active_transactions || [];
              const lkw = p.lock_waits       || [];
              const stm = p.top_statements   || [];
              const wev = p.wait_events      || [];
              const mem = p.memory_consumers || [];
              const tio = p.table_io_stats   || [];
              const ps  = p.ps_enabled;

              // Sorted + filtered statements
              const filteredStm = stm
                .filter(s => !perfStmtSearch || s.digest_text.toLowerCase().includes(perfStmtSearch.toLowerCase()))
                .sort((a,b) => {
                  const av = a[perfStmtSort.key] ?? 0, bv = b[perfStmtSort.key] ?? 0;
                  return perfStmtSort.asc ? av - bv : bv - av;
                });

              const SortTh = ({ label, k }) => (
                <th className="px-3 py-2 text-left text-[10px] font-bold uppercase text-slate-500 cursor-pointer select-none hover:text-cyan-600 whitespace-nowrap"
                  onClick={() => setPerfStmtSort(s => ({ key: k, asc: s.key === k ? !s.asc : false }))}>
                  {label}{perfStmtSort.key===k ? (perfStmtSort.asc ? ' ↑' : ' ↓') : ''}
                </th>
              );

              const Stat = ({ label, value, sub, accent = 'slate', warn }) => (
                <div className={`bg-white border rounded-xl p-3.5 flex flex-col gap-1 ${warn ? 'border-red-200 bg-red-50' : 'border-slate-100'}`}>
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</p>
                  <p className={`text-xl font-black ${warn ? 'text-red-600' : accent === 'green' ? 'text-emerald-600' : accent === 'red' ? 'text-red-600' : accent === 'orange' ? 'text-orange-500' : 'text-slate-800'}`}>{value}</p>
                  {sub && <p className="text-[10px] text-slate-400 leading-tight">{sub}</p>}
                </div>
              );

              return (
                <>
                  {/* ── SECTION FILTER ── */}
                  <div className="flex flex-wrap gap-2">
                    {[['all','All Sections'],['bufpool','Buffer Pool'],['rowops','Row Operations'],['locking','Locking'],['queries','Query Analysis'],['io','I/O'],['config','Config']].map(([k,l]) => (
                      <button key={k} onClick={() => setPerfSection(k)}
                        className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${perfSection===k ? 'bg-cyan-600 text-white shadow' : 'bg-white text-slate-600 border border-slate-200 hover:border-cyan-300'}`}>
                        {l}
                      </button>
                    ))}
                    <button onClick={() => refetchPerf()} className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-white border border-slate-200 hover:border-cyan-300 text-slate-600">
                      <RefreshCw size={11} className={perfLoading ? 'animate-spin' : ''}/> Refresh
                    </button>
                  </div>

                  {/* ── KPI BAR (8 cards) — all clickable ── */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-2.5">
                    {[
                      { label:'QPS',         value: fmtNum(qq.qps||0),          sub:'Queries/sec',              accent: 'blue',   onClick: () => setActiveTab('queries') },
                      { label:'TPS',         value: fmtNum(qq.tps||0),          sub:'Tx commits+rollbacks/sec', accent: 'teal',   onClick: () => setActiveTab('queries') },
                      { label:'Buffer Hit',  value: `${bp.hit_ratio||0}%`,      sub:'InnoDB buffer pool',       accent: (bp.hit_ratio||100)>=95?'green':'orange', onClick: () => setPerfSection('bufpool') },
                      { label:'Deadlocks',   value: fmtNum(lk.deadlocks||0),    sub:'Since last restart',       accent: lk.deadlocks>0?'red':'green',   onClick: () => setActiveTab('locks') },
                      { label:'Lock Waits',  value: fmtNum(lk.lock_waits||0),   sub:'Row-level lock waits',     accent: lk.lock_waits>1000?'orange':'slate', onClick: () => setActiveTab('locks') },
                      { label:'Full Scans',  value: fmtNum(hd.read_rnd_next||0),sub:'read_rnd_next rows',       accent: hd.read_rnd_next>100000?'orange':'slate', onClick: () => setPerfSection('io') },
                      { label:'Tmp On Disk', value: `${tt.disk_pct||0}%`,       sub:`${tt.on_disk||0} / ${tt.total||0} tables`, accent: (tt.disk_pct||0)<10?'green':'orange', onClick: () => setPerfSection('queries') },
                      { label:'Aborted Conn',value: fmtNum(co.aborted_connects||0), sub:'Failed connections',  accent: co.aborted_connects>0?'orange':'green', onClick: () => setPerfSection('connections') },
                    ].map(kpi => (
                      <button key={kpi.label} onClick={kpi.onClick} className="text-left w-full group">
                        <Stat label={kpi.label} value={kpi.value} sub={kpi.sub} warn={false} accent={kpi.accent} />
                      </button>
                    ))}
                  </div>

                  {/* ── SPARKLINES ── */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    {[
                      { title:'QPS Trend',         data: perfSparklines.qps,  color: C.cyan,   unit:' q/s', fmtVal: v=>v!=null?`${Number(v).toFixed(1)} q/s`:'—' },
                      { title:'Buffer Pool Hit %', data: perfSparklines.hit,  color: C.green,  unit:'%',    fmtVal: v=>v!=null?`${Number(v).toFixed(2)}%`:'—'    },
                      { title:'Active Txns',       data: perfSparklines.txns, color: C.orange, unit:'',     fmtVal: v=>v!=null?`${v} txn`:'—'                    },
                    ].map(s => <TrendCard key={s.title} {...s}/>)}
                  </div>

                  {/* ── BUFFER POOL + WAIT EVENTS ── */}
                  {(perfSection==='all'||perfSection==='bufpool') && (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                    {/* Buffer Pool Breakdown */}
                    <Panel title="InnoDB Buffer Pool">
                      <div className="flex flex-col md:flex-row gap-4 items-center">
                        <div className="w-full md:w-52 flex-shrink-0">
                          <ResponsiveContainer width="100%" height={200}>
                            <PieChart>
                              <Pie data={[
                                { name:'Data Pages',  v: bp.pages_data  || 0 },
                                { name:'Free Pages',  v: bp.pages_free  || 0 },
                                { name:'Dirty Pages', v: bp.pages_dirty || 0 },
                                { name:'Misc',        v: bp.pages_misc  || 0 },
                              ]} dataKey="v" innerRadius={55} outerRadius={80} paddingAngle={2}>
                                {[C.blue, C.green, C.orange, C.slate].map((c,i) => <Cell key={i} fill={c}/>)}
                              </Pie>
                              <Tooltip formatter={fmtNum}/>
                            </PieChart>
                          </ResponsiveContainer>
                          <div className="flex flex-wrap gap-x-3 gap-y-1 justify-center mt-1">
                            {[['Data',C.blue],['Free',C.green],['Dirty',C.orange],['Misc',C.slate]].map(([l,c]) => (
                              <span key={l} className="flex items-center gap-1 text-[10px] text-slate-500">
                                <span className="w-2 h-2 rounded-full inline-block" style={{background:c}}/>{l}
                              </span>
                            ))}
                          </div>
                        </div>
                        <div className="flex-1 grid grid-cols-2 gap-2">
                          {[
                            ['Pool Size',      fmtBytes(bp.size_bytes||0)],
                            ['Hit Ratio',      `${bp.hit_ratio||0}%`],
                            ['Pages Total',    fmtNum(bp.pages_total||0)],
                            ['Data Pages',     `${bp.pages_data||0} (${bp.data_pct||0}%)`],
                            ['Free Pages',     `${bp.pages_free||0} (${bp.free_pct||0}%)`],
                            ['Dirty Pages',    `${bp.pages_dirty||0} (${bp.dirty_pct||0}%)`],
                            ['Read Requests',  fmtNum(bp.read_requests||0)],
                            ['Physical Reads', fmtNum(bp.physical_reads||0)],
                            ['Write Requests', fmtNum(bp.write_requests||0)],
                            ['Pages Flushed',  fmtNum(bp.pages_flushed||0)],
                            ['Instances',      bp.pool_instances||1],
                            ['Pool Size (MB)', bp.size_mb||0],
                          ].map(([l,v]) => (
                            <div key={l} className="bg-slate-50 rounded-lg px-3 py-2 border border-slate-100">
                              <p className="text-[9px] text-slate-400 font-bold uppercase">{l}</p>
                              <p className="text-sm font-bold text-slate-700">{v}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    </Panel>

                    {/* Wait Events */}
                    <Panel title={ps ? 'Top Wait Events (Performance Schema)' : 'InnoDB Locking & I/O'}>
                      {ps && wev.length > 0 ? (
                        <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                          {wev.slice(0,12).map((e,i) => {
                            const maxMs = wev[0]?.total_ms || 1;
                            const pct   = Math.round(e.total_ms / maxMs * 100);
                            const cls   = e.event_name.includes('io') ? 'bg-blue-400' : e.event_name.includes('lock') ? 'bg-red-400' : e.event_name.includes('mutex') ? 'bg-orange-400' : 'bg-slate-400';
                            return (
                              <div key={i}>
                                <div className="flex justify-between text-[10px] text-slate-600 mb-0.5">
                                  <span className="truncate max-w-[65%] font-medium">{e.event_name.replace('wait/','')}</span>
                                  <span className="font-semibold text-slate-700">{fmtNum(e.total_ms)} ms</span>
                                </div>
                                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                                  <div className={`h-full rounded-full transition-all ${cls}`} style={{width:`${pct}%`}}/>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 gap-2">
                          {[
                            ['Deadlocks',         fmtNum(lk.deadlocks||0),          lk.deadlocks>0?'text-red-600':'text-slate-800'],
                            ['Lock Waits',        fmtNum(lk.lock_waits||0),          'text-slate-800'],
                            ['Avg Lock Time',     `${lk.lock_time_avg_ms||0}ms`,     'text-slate-800'],
                            ['Current Waiters',   lk.lock_current_waits||0,          'text-slate-800'],
                            ['Tbl Locks Waited',  fmtNum(lk.table_locks_waited||0),  lk.table_locks_waited>0?'text-orange-600':'text-slate-800'],
                            ['Tbl Contention',    `${lk.table_contention_pct||0}%`,  'text-slate-800'],
                            ['Log Waits',         fmtNum(io.log_waits||0),           'text-slate-800'],
                            ['Pending Reads',     io.pending_reads||0,               'text-slate-800'],
                          ].map(([l,v,cls]) => (
                            <div key={l} className="bg-slate-50 rounded-lg px-3 py-2 border border-slate-100">
                              <p className="text-[9px] text-slate-400 font-bold uppercase">{l}</p>
                              <p className={`text-sm font-bold ${cls}`}>{v}</p>
                            </div>
                          ))}
                        </div>
                      )}
                      {!ps && <p className="text-[10px] text-slate-400 mt-3">Enable performance_schema for full wait event analysis.</p>}
                    </Panel>
                  </div>
                  )}

                  {/* ── ROW OPERATIONS + INNODB I/O ── */}
                  {(perfSection==='all'||perfSection==='rowops'||perfSection==='io') && (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                    <Panel title="Row Operations">
                      <ResponsiveContainer width="100%" height={200}>
                        <BarChart data={[
                          { name:'Reads',   v: ro.reads||0,   ps: ro.reads_per_sec||0 },
                          { name:'Inserts', v: ro.inserts||0, ps: ro.inserts_per_sec||0 },
                          { name:'Updates', v: ro.updates||0, ps: ro.updates_per_sec||0 },
                          { name:'Deletes', v: ro.deletes||0, ps: ro.deletes_per_sec||0 },
                        ]} barSize={36}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9"/>
                          <XAxis dataKey="name" tick={{fontSize:11}}/>
                          <YAxis tick={{fontSize:10}} tickFormatter={fmtNum}/>
                          <Tooltip formatter={(v,n) => [fmtNum(v), n==='v'?'Total':'Per sec']}/>
                          <Bar dataKey="v" name="v" radius={[5,5,0,0]}>
                            {[C.blue,C.green,C.orange,C.red].map((c,i)=><Cell key={i} fill={c}/>)}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                      <div className="grid grid-cols-4 gap-2 mt-3">
                        {[
                          ['Reads/s',   ro.reads_per_sec,   C.blue],
                          ['Insert/s',  ro.inserts_per_sec, C.green],
                          ['Update/s',  ro.updates_per_sec, C.orange],
                          ['Delete/s',  ro.deletes_per_sec, C.red],
                        ].map(([l,v,c]) => (
                          <div key={l} className="text-center bg-slate-50 rounded-lg py-2 border border-slate-100">
                            <p className="text-[10px] text-slate-400 font-bold uppercase">{l}</p>
                            <p className="text-sm font-bold" style={{color:c}}>{v||0}</p>
                          </div>
                        ))}
                      </div>
                    </Panel>

                    <Panel title="InnoDB I/O Statistics">
                      <ResponsiveContainer width="100%" height={200}>
                        <BarChart layout="vertical" data={[
                          { name:'Data Reads',    v: io.data_reads    || 0 },
                          { name:'Data Writes',   v: io.data_writes   || 0 },
                          { name:'Log Writes',    v: io.log_writes    || 0 },
                          { name:'OS Log Fsyncs', v: io.os_log_fsyncs || 0 },
                          { name:'Pages Read',    v: io.pages_read    || 0 },
                          { name:'Pages Written', v: io.pages_written || 0 },
                        ]} margin={{left:90}}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false}/>
                          <XAxis type="number" tick={{fontSize:10}} tickFormatter={fmtNum}/>
                          <YAxis dataKey="name" type="category" tick={{fontSize:10}} width={90}/>
                          <Tooltip formatter={fmtNum}/>
                          <Bar dataKey="v" radius={[0,4,4,0]}>
                            {[C.blue,C.teal,C.purple,C.orange,C.cyan,C.green].map((c,i)=><Cell key={i} fill={c}/>)}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                      <div className="grid grid-cols-2 gap-2 mt-3">
                        {[
                          ['Pending Reads',     io.pending_reads    || 0],
                          ['Pending Writes',    io.pending_writes   || 0],
                          ['Pending Log Writes',io.pending_log_writes||0],
                          ['DoubleWrite Writes',io.dblwr_writes     || 0],
                        ].map(([l,v]) => (
                          <div key={l} className="bg-slate-50 rounded-lg px-3 py-2 border border-slate-100">
                            <p className="text-[9px] text-slate-400 font-bold uppercase">{l}</p>
                            <p className={`text-sm font-bold ${v>0?'text-orange-500':'text-slate-700'}`}>{fmtNum(v)}</p>
                          </div>
                        ))}
                      </div>
                    </Panel>
                  </div>
                  )}

                  {/* ── TOP STATEMENTS (PS) ── */}
                  {(perfSection==='all'||perfSection==='queries') && ps && stm.length > 0 && (
                  <Panel title="Top SQL Statements by Total Latency (Performance Schema)">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="relative flex-1">
                        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"/>
                        <input value={perfStmtSearch} onChange={e=>setPerfStmtSearch(e.target.value)}
                          placeholder="Filter SQL digest…"
                          className="w-full pl-8 pr-3 h-9 rounded-xl border border-slate-200 text-[12px] bg-white focus:ring-2 focus:ring-cyan-300 focus:outline-none"/>
                      </div>
                      <span className="text-[11px] text-slate-400">{filteredStm.length} of {stm.length} statements</span>
                    </div>
                    <div className="overflow-x-auto rounded-xl border border-slate-100">
                      <table className="w-full text-[11px]">
                        <thead className="bg-slate-50 sticky top-0">
                          <tr>
                            <th className="px-3 py-2 text-left text-[10px] font-bold uppercase text-slate-500 w-[35%]">SQL Digest</th>
                            <SortTh label="Count"    k="count"/>
                            <SortTh label="Avg (ms)" k="avg_ms"/>
                            <SortTh label="Max (ms)" k="max_ms"/>
                            <SortTh label="Total (ms)" k="sum_ms"/>
                            <SortTh label="Rows Exam" k="rows_examined"/>
                            <SortTh label="Rows Sent" k="rows_sent"/>
                            <SortTh label="No Index"  k="no_index"/>
                            <th className="px-3 py-2 text-left text-[10px] font-bold uppercase text-slate-500">Last Seen</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredStm.map((s, i) => (
                            <tr key={i} className={`border-t border-slate-50 hover:bg-slate-50/80 ${s.no_index>0?'bg-amber-50/40':''}`}>
                              <td className="px-3 py-1.5 font-mono text-[10px] text-slate-700 max-w-[300px]">
                                <div className="truncate" title={s.digest_text}>{s.digest_text}</div>
                                {s.no_index > 0 && <span className="inline-flex items-center gap-1 text-[9px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-semibold mt-0.5">⚠ no-index ×{s.no_index}</span>}
                                {s.tmp_disk > 0 && <span className="inline-flex items-center gap-1 text-[9px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full font-semibold mt-0.5 ml-1">tmp-disk ×{s.tmp_disk}</span>}
                              </td>
                              <td className="px-3 py-1.5 text-center font-semibold text-slate-700">{fmtNum(s.count)}</td>
                              <td className="px-3 py-1.5 text-center font-mono text-blue-700">{Number(s.avg_ms||0).toFixed(2)}</td>
                              <td className="px-3 py-1.5 text-center font-mono text-orange-700">{Number(s.max_ms||0).toFixed(2)}</td>
                              <td className="px-3 py-1.5 text-center font-mono font-bold text-slate-800">{fmtNum(s.sum_ms)}</td>
                              <td className="px-3 py-1.5 text-center text-slate-600">{Number(s.rows_examined||0).toFixed(1)}</td>
                              <td className="px-3 py-1.5 text-center text-slate-600">{Number(s.rows_sent||0).toFixed(1)}</td>
                              <td className="px-3 py-1.5 text-center">
                                <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold ${s.no_index>0?'bg-red-100 text-red-700':'bg-green-100 text-green-700'}`}>{s.no_index}</span>
                              </td>
                              <td className="px-3 py-1.5 text-slate-400 text-[10px] whitespace-nowrap">{s.last_seen}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {!ps && <p className="text-[10px] text-slate-400 mt-2">Enable performance_schema=ON to see statement analysis.</p>}
                  </Panel>
                  )}
                  {(perfSection==='all'||perfSection==='queries') && !ps && (
                    <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 flex items-start gap-3">
                      <AlertTriangle size={20} className="text-amber-500 flex-shrink-0 mt-0.5"/>
                      <div>
                        <p className="font-bold text-amber-800 text-sm">Performance Schema Disabled</p>
                        <p className="text-[12px] text-amber-700 mt-1">Add <code className="bg-amber-100 px-1 rounded">performance_schema=ON</code> to my.cnf and restart MySQL to enable statement analysis, wait event tracking, and memory profiling.</p>
                      </div>
                    </div>
                  )}

                  {/* ── LOCKING DEEP DIVE ── */}
                  {(perfSection==='all'||perfSection==='locking') && (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                    <Panel title="Locking Details">
                      <div className="grid grid-cols-2 gap-2">
                        {[
                          ['Deadlocks',          fmtNum(lk.deadlocks||0),              lk.deadlocks>0?'text-red-600 font-black':'text-slate-800'],
                          ['Row Lock Waits',     fmtNum(lk.lock_waits||0),             'text-slate-800'],
                          ['Avg Lock Wait',      `${lk.lock_time_avg_ms||0} ms`,        lk.lock_time_avg_ms>100?'text-orange-600':'text-slate-800'],
                          ['Current Waiters',    lk.lock_current_waits||0,              lk.lock_current_waits>0?'text-red-600':'text-slate-800'],
                          ['Tbl Locks Waited',   fmtNum(lk.table_locks_waited||0),     lk.table_locks_waited>0?'text-orange-600':'text-slate-800'],
                          ['Tbl Locks Immediate',fmtNum(lk.table_locks_immediate||0),  'text-slate-800'],
                          ['Tbl Lock Contention',`${lk.table_contention_pct||0}%`,     lk.table_contention_pct>5?'text-orange-600':'text-slate-800'],
                          ['Lock Time Total',    `${fmtNum(lk.lock_time_ms||0)} ms`,   'text-slate-800'],
                        ].map(([l,v,cls]) => (
                          <div key={l} className="bg-slate-50 rounded-lg px-3 py-2 border border-slate-100">
                            <p className="text-[9px] text-slate-400 font-bold uppercase">{l}</p>
                            <p className={`text-sm font-bold ${cls}`}>{v}</p>
                          </div>
                        ))}
                      </div>
                    </Panel>

                    <Panel title="Sort & Temp Operations">
                      <div className="grid grid-cols-2 gap-2">
                        {[
                          ['Sort Rows',          fmtNum(so.rows||0),          'text-slate-800'],
                          ['Sort Range',         fmtNum(so.range||0),         'text-slate-800'],
                          ['Sort Scan',          fmtNum(so.scan||0),          'text-slate-800'],
                          ['Sort Merge Passes',  fmtNum(so.merge_passes||0),  so.merge_passes>0?'text-orange-600':'text-slate-800'],
                          ['Tmp In Memory',      fmtNum(tt.in_memory||0),     'text-slate-800'],
                          ['Tmp On Disk',        fmtNum(tt.on_disk||0),       tt.on_disk>0?'text-orange-600':'text-slate-800'],
                          ['Disk Tmp %',         `${tt.disk_pct||0}%`,        tt.disk_pct>25?'text-red-600':'text-slate-800'],
                          ['Tmp Table Size',     `${tt.tmp_table_size_mb||0} MB`, 'text-slate-800'],
                        ].map(([l,v,cls]) => (
                          <div key={l} className="bg-slate-50 rounded-lg px-3 py-2 border border-slate-100">
                            <p className="text-[9px] text-slate-400 font-bold uppercase">{l}</p>
                            <p className={`text-sm font-bold ${cls}`}>{v}</p>
                          </div>
                        ))}
                      </div>
                    </Panel>
                  </div>
                  )}

                  {/* ── HANDLER STATS + QUERY QUALITY ── */}
                  {(perfSection==='all'||perfSection==='queries') && (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                    <Panel title="Handler Statistics (Read Pattern Analysis)">
                      <div className="space-y-2">
                        {[
                          { l:'read_key',      v:hd.read_key||0,      desc:'Index key lookups (good)', good:true },
                          { l:'read_next',     v:hd.read_next||0,     desc:'Index sequential reads (ok)', good:true },
                          { l:'read_first',    v:hd.read_first||0,    desc:'First row of index reads', good:true },
                          { l:'read_rnd',      v:hd.read_rnd||0,      desc:'Sort/position reads', good:null },
                          { l:'read_rnd_next', v:hd.read_rnd_next||0, desc:'Full table scan rows ← watch this!', good:false },
                          { l:'write',         v:hd.write||0,         desc:'Row inserts', good:null },
                          { l:'update',        v:hd.update||0,        desc:'Row updates', good:null },
                          { l:'delete',        v:hd.delete||0,        desc:'Row deletes', good:null },
                          { l:'commit',        v:hd.commit||0,        desc:'Transaction commits', good:true },
                          { l:'rollback',      v:hd.rollback||0,      desc:'Transaction rollbacks', good: hd.rollback===0 },
                        ].map(({l,v,desc,good}) => {
                          const max = Math.max(hd.read_rnd_next||1, hd.read_next||1, hd.read_key||1, 1);
                          const pct = Math.min(100, Math.round(v / max * 100));
                          const barCls = good === true ? 'bg-emerald-400' : good === false ? 'bg-red-400' : 'bg-blue-300';
                          return (
                            <div key={l}>
                              <div className="flex justify-between text-[10px] mb-0.5">
                                <span className="font-mono font-bold text-slate-700">{l}</span>
                                <span className="text-slate-500">{fmtNum(v)} <span className="text-slate-400">— {desc}</span></span>
                              </div>
                              <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${barCls}`} style={{width:`${pct}%`}}/>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </Panel>

                    <Panel title="Query Quality & Throughput">
                      <div className="grid grid-cols-2 gap-2">
                        {[
                          ['QPS',          qq.qps||0,                  'Queries per second',      'text-cyan-700'],
                          ['TPS',          qq.tps||0,                  'Transactions per second', 'text-teal-700'],
                          ['Slow Queries', fmtNum(qq.slow_queries||0), 'Since last restart',      qq.slow_queries>0?'text-orange-600':'text-slate-800'],
                          ['Slow %',       `${qq.slow_pct||0}%`,       'Of total questions',      qq.slow_pct>1?'text-red-600':'text-slate-800'],
                          ['Full Joins',   fmtNum(qq.full_joins||0),   'SELECT_FULL_JOIN',        qq.full_joins>0?'text-orange-600':'text-slate-800'],
                          ['Select Scan',  fmtNum(qq.select_scan||0),  'Full table scans (SQL)',  qq.select_scan>1000?'text-orange-600':'text-slate-800'],
                          ['Net Recv',     `${qq.network_recv_kb_s||0} KB/s`, 'Bytes received/sec', 'text-slate-800'],
                          ['Net Send',     `${qq.network_send_kb_s||0} KB/s`, 'Bytes sent/sec',    'text-slate-800'],
                          ['Commits',      fmtNum(qq.commits||0),      'Com_commit',              'text-slate-800'],
                          ['Rollbacks',    fmtNum(qq.rollbacks||0),    'Com_rollback',            qq.rollbacks>0?'text-orange-600':'text-slate-800'],
                        ].map(([l,v,d,cls]) => (
                          <div key={l} className="bg-slate-50 rounded-lg px-3 py-2 border border-slate-100">
                            <p className="text-[9px] text-slate-400 font-bold uppercase">{l}</p>
                            <p className={`text-sm font-bold ${cls}`}>{v}</p>
                            <p className="text-[9px] text-slate-400">{d}</p>
                          </div>
                        ))}
                      </div>
                    </Panel>
                  </div>
                  )}

                  {/* ── CONNECTION EFFICIENCY ── */}
                  {(perfSection==='all'||perfSection==='queries') && (
                  <Panel title="Connection & Thread Efficiency">
                    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
                      {[
                        ['Active Conns',      co.current||0,              co.current>co.max_connections*0.8?'text-red-600':'text-slate-800'],
                        ['Max Connections',   co.max_connections||0,      'text-slate-800'],
                        ['Usage %',           `${co.usage_pct||0}%`,      co.usage_pct>80?'text-red-600':'text-slate-800'],
                        ['Max Ever Used',     co.max_used||0,             'text-slate-800'],
                        ['Aborted Clients',   co.aborted_clients||0,      co.aborted_clients>0?'text-orange-600':'text-slate-800'],
                        ['Aborted Connects',  co.aborted_connects||0,     co.aborted_connects>0?'text-red-600':'text-slate-800'],
                        ['Threads Running',   co.threads_running||0,      'text-slate-800'],
                        ['Threads Cached',    co.threads_cached||0,       'text-slate-800'],
                        ['Threads Created',   fmtNum(co.threads_created||0), 'text-slate-800'],
                        ['Cache Hit %',       `${co.cache_hit_pct||0}%`,  co.cache_hit_pct<90?'text-orange-600':'text-slate-800'],
                        ['Total Connections', fmtNum(co.total_created||0),'text-slate-800'],
                        ['MaxConn Errors',    co.errors_maxconn||0,       co.errors_maxconn>0?'text-red-600':'text-slate-800'],
                      ].map(([l,v,cls]) => (
                        <div key={l} className="bg-slate-50 rounded-xl p-3 border border-slate-100">
                          <p className="text-[9px] text-slate-400 font-bold uppercase leading-tight mb-1">{l}</p>
                          <p className={`text-base font-black ${cls}`}>{v}</p>
                        </div>
                      ))}
                    </div>
                  </Panel>
                  )}

                  {/* ── TABLE I/O STATS (PS) ── */}
                  {(perfSection==='all'||perfSection==='io') && ps && tio.length > 0 && (
                  <Panel title="Table I/O Wait Statistics (Performance Schema)">
                    <div className="overflow-x-auto rounded-xl border border-slate-100">
                      <table className="w-full text-[11px]">
                        <thead className="bg-slate-50">
                          <tr>
                            {['Schema','Table','Fetch','Insert','Update','Delete','Total Wait (ms)','Avg Wait (ms)','Fetch ms','Insert ms','Update ms','Delete ms'].map(h => (
                              <th key={h} className="px-3 py-2 text-left text-[10px] font-bold uppercase text-slate-500 whitespace-nowrap">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {tio.map((t,i) => (
                            <tr key={i} className="border-t border-slate-50 hover:bg-slate-50/80">
                              <td className="px-3 py-1.5 text-slate-500 font-mono text-[10px]">{t.schema}</td>
                              <td className="px-3 py-1.5 font-semibold text-slate-800">{t.table}</td>
                              <td className="px-3 py-1.5 text-right text-blue-700">{fmtNum(t.fetch)}</td>
                              <td className="px-3 py-1.5 text-right text-green-700">{fmtNum(t.insert)}</td>
                              <td className="px-3 py-1.5 text-right text-orange-700">{fmtNum(t.update)}</td>
                              <td className="px-3 py-1.5 text-right text-red-700">{fmtNum(t.delete)}</td>
                              <td className="px-3 py-1.5 text-right font-bold text-slate-800">{fmtNum(t.total_ms)}</td>
                              <td className="px-3 py-1.5 text-right text-slate-600">{t.avg_ms}</td>
                              <td className="px-3 py-1.5 text-right text-blue-600">{t.fetch_ms}</td>
                              <td className="px-3 py-1.5 text-right text-green-600">{t.insert_ms}</td>
                              <td className="px-3 py-1.5 text-right text-orange-600">{t.update_ms}</td>
                              <td className="px-3 py-1.5 text-right text-red-600">{t.delete_ms}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Panel>
                  )}

                  {/* ── MEMORY CONSUMERS (PS) ── */}
                  {(perfSection==='all'||perfSection==='bufpool') && ps && mem.length > 0 && (
                  <Panel title="Memory Consumers (Performance Schema)">
                    <div className="overflow-x-auto rounded-xl border border-slate-100">
                      <table className="w-full text-[11px]">
                        <thead className="bg-slate-50">
                          <tr>
                            <th className="px-3 py-2 text-left text-[10px] font-bold uppercase text-slate-500">Memory Event</th>
                            <th className="px-3 py-2 text-right text-[10px] font-bold uppercase text-slate-500">Current (MB)</th>
                            <th className="px-3 py-2 text-right text-[10px] font-bold uppercase text-slate-500">High (MB)</th>
                            <th className="px-3 py-2 text-right text-[10px] font-bold uppercase text-slate-500">Alloc Count</th>
                            <th className="px-3 py-2 text-left text-[10px] font-bold uppercase text-slate-500 w-[25%]">Usage Bar</th>
                          </tr>
                        </thead>
                        <tbody>
                          {mem.map((m2, i) => {
                            const maxMem = mem[0]?.current_mb || 1;
                            const pct = Math.round(m2.current_mb / maxMem * 100);
                            return (
                              <tr key={i} className="border-t border-slate-50 hover:bg-slate-50/80">
                                <td className="px-3 py-1.5 font-mono text-[10px] text-slate-700 truncate max-w-[250px]">{m2.event_name.replace('memory/','')}</td>
                                <td className="px-3 py-1.5 text-right font-bold text-blue-700">{Number(m2.current_mb||0).toFixed(2)}</td>
                                <td className="px-3 py-1.5 text-right text-slate-500">{Number(m2.high_mb||0).toFixed(2)}</td>
                                <td className="px-3 py-1.5 text-right text-slate-500">{fmtNum(m2.count_used)}</td>
                                <td className="px-3 py-1.5">
                                  <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                                    <div className="h-full bg-blue-400 rounded-full" style={{width:`${pct}%`}}/>
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

                  {/* ── ACTIVE TRANSACTIONS ── */}
                  {(perfSection==='all'||perfSection==='locking') && trx.length > 0 && (
                  <Panel title={`Active Transactions (${trx.length})`}>
                    <div className="overflow-x-auto rounded-xl border border-slate-100">
                      <table className="w-full text-[11px]">
                        <thead className="bg-slate-50">
                          <tr>
                            {['TRX ID','State','Duration','User','Host','Rows Locked','Rows Modified','Isolation','SQL'].map(h=>(
                              <th key={h} className="px-3 py-2 text-left text-[10px] font-bold uppercase text-slate-500 whitespace-nowrap">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {trx.map((t,i) => (
                            <tr key={i} className={`border-t border-slate-50 hover:bg-slate-50 ${t.duration_sec>30?'bg-red-50/60':t.duration_sec>10?'bg-amber-50/40':''}`}>
                              <td className="px-3 py-1.5 font-mono text-[10px] text-slate-600">{t.trx_id}</td>
                              <td className="px-3 py-1.5"><span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${t.state==='RUNNING'?'bg-green-100 text-green-700':t.state==='LOCK WAIT'?'bg-red-100 text-red-700':'bg-slate-100 text-slate-600'}`}>{t.state}</span></td>
                              <td className="px-3 py-1.5 font-semibold text-center whitespace-nowrap"><span className={t.duration_sec>30?'text-red-600':t.duration_sec>10?'text-orange-500':'text-slate-700'}>{t.duration_sec}s</span></td>
                              <td className="px-3 py-1.5 text-slate-700">{t.user}</td>
                              <td className="px-3 py-1.5 text-slate-500 text-[10px]">{t.host}</td>
                              <td className="px-3 py-1.5 text-center font-bold text-red-600">{t.rows_locked}</td>
                              <td className="px-3 py-1.5 text-center font-semibold text-slate-700">{t.rows_modified}</td>
                              <td className="px-3 py-1.5 text-[10px] text-slate-500">{t.isolation}</td>
                              <td className="px-3 py-1.5 font-mono text-[10px] text-slate-600 max-w-[200px]"><div className="truncate" title={t.query}>{t.query||'—'}</div></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Panel>
                  )}

                  {/* ── LOCK WAITS ── */}
                  {(perfSection==='all'||perfSection==='locking') && lkw.length > 0 && (
                  <Panel title={`Lock Wait Chain (${lkw.length} waiters)`}>
                    <div className="space-y-3">
                      {lkw.map((lw,i) => (
                        <div key={i} className="flex items-start gap-3 bg-red-50 border border-red-100 rounded-xl p-3">
                          <div className="flex-1 min-w-0">
                            <p className="text-[10px] font-bold text-red-700 uppercase mb-1">Waiting ({lw.waiting_user}) — {lw.wait_sec}s</p>
                            <p className="font-mono text-[10px] text-slate-700 truncate">{lw.waiting_query||'—'}</p>
                          </div>
                          <div className="flex-shrink-0 text-slate-400 text-lg">→</div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[10px] font-bold text-orange-700 uppercase mb-1">Blocked by ({lw.blocking_user})</p>
                            <p className="font-mono text-[10px] text-slate-700 truncate">{lw.blocking_query||'—'}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </Panel>
                  )}

                  {/* ── SERVER CONFIG ── */}
                  {(perfSection==='all'||perfSection==='config') && (
                  <Panel title="Server Configuration (Performance-Relevant Parameters)">
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                      {[
                        ['innodb_buffer_pool_size',       `${cfg.innodb_buffer_pool_size_mb||0} MB`],
                        ['innodb_buffer_pool_instances',  cfg.innodb_buffer_pool_instances||1],
                        ['innodb_log_file_size',          `${cfg.innodb_log_file_size_mb||0} MB`],
                        ['innodb_flush_log_at_trx_commit',cfg.innodb_flush_log_at_trx_commit||'1'],
                        ['innodb_flush_method',           cfg.innodb_flush_method||'fsync'],
                        ['innodb_io_capacity',            cfg.innodb_io_capacity||'200'],
                        ['innodb_io_capacity_max',        cfg.innodb_io_capacity_max||'2000'],
                        ['innodb_read_io_threads',        cfg.innodb_read_io_threads||'4'],
                        ['innodb_write_io_threads',       cfg.innodb_write_io_threads||'4'],
                        ['innodb_file_per_table',         cfg.innodb_file_per_table||'ON'],
                        ['sort_buffer_size',              `${cfg.sort_buffer_size_kb||0} KB`],
                        ['join_buffer_size',              `${cfg.join_buffer_size_kb||0} KB`],
                        ['read_buffer_size',              `${cfg.read_buffer_size_kb||0} KB`],
                        ['read_rnd_buffer_size',          `${cfg.read_rnd_buffer_size_kb||0} KB`],
                        ['max_allowed_packet',            `${cfg.max_allowed_packet_mb||0} MB`],
                        ['table_open_cache',              cfg.table_open_cache||'2000'],
                        ['max_connections',               cfg.max_connections||'151'],
                        ['thread_cache_size',             cfg.thread_cache_size||'9'],
                        ['long_query_time',               `${cfg.long_query_time||10}s`],
                        ['slow_query_log',                cfg.slow_query_log||'OFF'],
                        ['performance_schema',            cfg.performance_schema||'OFF'],
                        ['query_cache_type',              cfg.query_cache_type||'OFF'],
                        ['wait_timeout',                  `${cfg.wait_timeout||28800}s`],
                        ['interactive_timeout',           `${cfg.interactive_timeout||28800}s`],
                      ].map(([param, val]) => {
                        const isOn   = String(val).toUpperCase() === 'ON';
                        const isOff  = String(val).toUpperCase() === 'OFF';
                        const isBad  = (param==='slow_query_log'&&isOff)||(param==='performance_schema'&&isOff);
                        return (
                          <div key={param} className={`rounded-lg px-3 py-2 border ${isBad?'bg-amber-50 border-amber-200':'bg-slate-50 border-slate-100'}`}>
                            <p className="text-[9px] font-mono text-slate-400 truncate" title={param}>{param}</p>
                            <p className={`text-sm font-bold truncate ${isOn?'text-emerald-600':isOff?'text-slate-500':'text-slate-800'}`}>{val}</p>
                          </div>
                        );
                      })}
                    </div>
                  </Panel>
                  )}

                  {/* ── KEY CACHE (MyISAM) ── */}
                  {(perfSection==='all'||perfSection==='bufpool') && (kc.read_requests||0) > 0 && (
                  <Panel title="MyISAM Key Cache">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {[
                        ['Key Buffer Size', `${kc.buffer_size_mb||0} MB`,'text-slate-800'],
                        ['Hit Ratio',       `${kc.hit_ratio||0}%`,       kc.hit_ratio<95?'text-orange-600':'text-slate-800'],
                        ['Read Requests',   fmtNum(kc.read_requests||0), 'text-slate-800'],
                        ['Physical Reads',  fmtNum(kc.reads||0),         'text-slate-800'],
                        ['Write Requests',  fmtNum(kc.write_requests||0),'text-slate-800'],
                        ['Physical Writes', fmtNum(kc.writes||0),        'text-slate-800'],
                        ['Blocks Used',     fmtNum(kc.blocks_used||0),   'text-slate-800'],
                        ['Blocks Unused',   fmtNum(kc.blocks_unused||0), 'text-slate-800'],
                      ].map(([l,v,cls]) => (
                        <div key={l} className="bg-slate-50 rounded-xl p-3 border border-slate-100">
                          <p className="text-[9px] text-slate-400 font-bold uppercase">{l}</p>
                          <p className={`text-sm font-bold ${cls}`}>{v}</p>
                        </div>
                      ))}
                    </div>
                  </Panel>
                  )}

                </>
              );
            })()}
          </div>
        )}

        {/* ══ QUERIES ═══════════════════════════════════════════════ */}
        {activeTab === 'queries' && (
          <div className="space-y-5">
            {long_running_queries.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-2xl p-5">
                <div className="flex items-center gap-3 mb-3">
                  <AlertTriangle className="text-red-500" size={20} />
                  <h3 className="font-bold text-red-700">{long_running_queries.length} Long-Running Queries</h3>
                </div>
                {long_running_queries.map((q, i) => (
                  <div key={i} className="bg-white rounded-xl p-3 text-xs font-mono border border-red-100 mb-2">
                    <span className="font-bold text-red-600">ID:{q.Id}</span>
                    <span className="ml-3 text-slate-500">User: {q.User}</span>
                    <span className="ml-3 text-orange-600 font-bold">Time: {q.Time}s</span>
                    <div className="mt-1 text-slate-600 truncate">{String(q.Info || '').slice(0, 200)}</div>
                  </div>
                ))}
              </div>
            )}

            <div className="bg-cyan-50 border border-cyan-200 rounded-xl px-4 py-2 flex items-center gap-2 text-cyan-700 text-xs font-semibold">
              <Eye size={13} /> Click any row to see the full query and kill command
            </div>

            <Panel title={`Full Process List (${process_list.length})`}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50">
                    <tr>{['ID','User','Host','DB','Command','Time (s)','State','Query'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wider">{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {process_list.map((p, i) => {
                      const isExp = expandedProcId === p.Id;
                      return (
                        <React.Fragment key={i}>
                          <tr
                            className={`border-t border-slate-100 cursor-pointer transition-colors ${isExp ? 'bg-cyan-50' : Number(p.Time) > 5 ? 'bg-yellow-50 hover:bg-yellow-100' : 'hover:bg-slate-50'}`}
                            onClick={() => setExpandedProcId(isExp ? null : p.Id)}>
                            <td className="px-4 py-2.5 font-mono text-xs text-slate-500">
                              <div className="flex items-center gap-1">
                                {isExp ? <ChevronUp size={10} className="text-cyan-600" /> : <ChevronDown size={10} className="text-slate-300" />}
                                {p.Id}
                              </div>
                            </td>
                            <td className="px-4 py-2.5 font-semibold text-slate-800">{p.User}</td>
                            <td className="px-4 py-2.5 text-xs text-slate-400">{p.Host}</td>
                            <td className="px-4 py-2.5 text-xs">{p.db || '—'}</td>
                            <td className="px-4 py-2.5 text-xs">
                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${p.Command === 'Sleep' ? 'bg-slate-100 text-slate-500' : 'bg-blue-100 text-blue-700'}`}>
                                {p.Command}
                              </span>
                            </td>
                            <td className={`px-4 py-2.5 font-bold text-sm ${Number(p.Time) > 5 ? 'text-red-600' : Number(p.Time) > 1 ? 'text-orange-600' : 'text-slate-600'}`}>
                              {p.Time}
                            </td>
                            <td className="px-4 py-2.5 text-xs text-slate-400 max-w-[120px] truncate">{p.State || '—'}</td>
                            <td className="px-4 py-2.5 font-mono text-xs text-slate-500 max-w-[220px] truncate">{p.Info || '—'}</td>
                          </tr>
                          {isExp && (
                            <tr>
                              <td colSpan={8} className="p-0"><ProcessDetail p={p} /></td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                    {process_list.length === 0 && (
                      <tr><td colSpan={8} className="text-center py-10 text-slate-400">No active processes</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Panel>

            <div className="grid grid-cols-3 gap-4">
              <ClickableKpi title="Total Processes"  value={process_list.length}
                accent="blue"  hint="All current connections"
                onClick={() => setExpandedProcId(null)} />
              <ClickableKpi title="Long Running >1s" value={long_running_queries.length}
                accent={long_running_queries.length > 0 ? 'red' : 'green'}
                hint={long_running_queries.length > 0 ? 'Click to highlight in table above' : 'None running'}
                onClick={() => { if (long_running_queries[0]) setExpandedProcId(long_running_queries[0].Id); }} />
              <ClickableKpi title="Slow Queries" value={fmtNum(query_stats.Slow_queries)}
                accent={Number(query_stats.Slow_queries) > 0 ? 'orange' : 'green'}
                hint="Click to open Slow Queries page"
                onClick={() => navigate(`/mysql-dashboard/${id}/slow-queries`)} />
            </div>
          </div>
        )}

        {/* ══ DATABASES ═════════════════════════════════════════════ */}
        {activeTab === 'databases' && (
          <div className="space-y-3">
            <div className="bg-cyan-50 border border-cyan-200 rounded-xl px-4 py-2 flex items-center gap-2 text-cyan-700 text-xs font-semibold">
              <Eye size={13} /> Click any database row to browse its tables
            </div>
          <Panel title={`Databases (${databases.length})`}>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50">
                  <tr>{['Database','Tables','Size (MB)','Action'].map(h => (
                    <th key={h} className="px-5 py-3 text-left text-xs font-bold text-slate-400 uppercase">{h}</th>
                  ))}</tr>
                </thead>
                <tbody>
                  {databases.map((db, i) => (
                    <tr key={i}
                      className="border-t border-slate-100 hover:bg-cyan-50 cursor-pointer transition-colors group"
                      onClick={() => { setSelDb(db.name); setActiveTab('tables'); }}>
                      <td className="px-5 py-4 font-bold text-cyan-700 flex items-center gap-1.5">
                        {db.name}
                        <Eye size={11} className="opacity-0 group-hover:opacity-60 text-cyan-500 transition-opacity flex-shrink-0" />
                      </td>
                      <td className="px-5 py-4 font-mono text-sm">{db.tables_count}</td>
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm">{db.size_mb} MB</span>
                          <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden max-w-[80px]">
                            <div className="h-full bg-cyan-500 rounded-full"
                              style={{ width: `${Math.min(100, (db.size_mb / Math.max(...databases.map(d => d.size_mb), 1)) * 100)}%` }} />
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <button onClick={e => { e.stopPropagation(); setSelDb(db.name); setActiveTab('tables'); }}
                          className="px-3 h-8 bg-cyan-700 text-white text-xs font-semibold rounded-xl hover:bg-cyan-800">
                          View Tables
                        </button>
                      </td>
                    </tr>
                  ))}
                  {databases.length === 0 && (
                    <tr><td colSpan={4} className="text-center py-12 text-slate-400">No databases found</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
          </div>
        )}

        {/* ══ TABLES — advanced explorer ═══════════════════════════ */}
        {activeTab === 'tables' && (
          <div className="flex gap-4 h-[calc(100vh-220px)] min-h-[500px]">

            {/* ─ Left: DB list ─ */}
            <div className="w-48 flex-shrink-0 bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 bg-slate-50/60 flex items-center gap-2">
                <Database size={13} className="text-cyan-600 flex-shrink-0" />
                <span className="font-bold text-slate-700 text-[12px]">Databases</span>
                {!dbListLoading && dbListData?.data && (
                  <span className="ml-auto text-[10px] bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded-full font-bold">
                    {dbListData.data.length}
                  </span>
                )}
              </div>
              <div className="overflow-y-auto flex-1">
                {dbListLoading ? (
                  <div className="py-10 flex justify-center"><Loader2 size={18} className="animate-spin text-slate-400" /></div>
                ) : (dbListData?.data || []).map(db => (
                  <button key={db.name} onClick={() => { setSelDb(db.name); setSelTable(null); setTblSearch(''); }}
                    className={`w-full text-left px-4 py-3 border-b border-slate-50 last:border-0 transition-all ${selDb === db.name ? 'bg-cyan-50 border-l-2 border-l-cyan-500' : 'hover:bg-slate-50'}`}>
                    <p className={`font-semibold text-[12px] truncate ${selDb === db.name ? 'text-cyan-700' : 'text-slate-700'}`}>{db.name}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-slate-400">{db.tables} tbls</span>
                      <span className="text-[10px] text-slate-400">{db.size_human}</span>
                    </div>
                  </button>
                ))}
                {!dbListLoading && (dbListData?.data || []).length === 0 && (
                  <p className="text-center py-8 text-[11px] text-slate-400">No databases</p>
                )}
              </div>
            </div>

            {/* ─ Middle: Table list ─ */}
            <div className="w-64 flex-shrink-0 bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col overflow-hidden">
              <div className="px-3 py-3 border-b border-slate-100 bg-slate-50/60">
                <div className="flex items-center gap-1.5 mb-2">
                  <Table size={12} className="text-slate-400 flex-shrink-0" />
                  <span className="font-bold text-slate-700 text-[12px]">{selDb ? `${selDb}` : 'Tables'}</span>
                  {tblListData?.data && (
                    <span className="ml-auto text-[10px] bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded-full font-bold">
                      {tblListData.data.length}
                    </span>
                  )}
                </div>
                <div className="relative">
                  <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input value={tblSearch} onChange={e => setTblSearch(e.target.value)} placeholder="Search…"
                    className="h-7 w-full pl-7 pr-2 rounded-lg border border-slate-200 text-[11px] outline-none focus:border-cyan-400 bg-white" />
                </div>
              </div>
              <div className="overflow-y-auto flex-1">
                {!selDb ? (
                  <p className="py-10 text-center text-[11px] text-slate-400">Select a database</p>
                ) : tblListLoading ? (
                  <div className="py-10 flex justify-center"><Loader2 size={18} className="animate-spin text-slate-400" /></div>
                ) : (tblListData?.data || [])
                    .filter(t => !tblSearch || t.name.toLowerCase().includes(tblSearch.toLowerCase()))
                    .map(t => (
                  <button key={t.name} onClick={() => { setSelTable(t.name); setTblSub('columns'); }}
                    className={`w-full text-left px-3 py-2.5 border-b border-slate-50 last:border-0 transition-all ${selTable === t.name ? 'bg-cyan-50 border-l-2 border-l-cyan-500' : 'hover:bg-slate-50'}`}>
                    <p className={`font-semibold text-[11px] truncate ${selTable === t.name ? 'text-cyan-700' : 'text-slate-700'}`}>{t.name}</p>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      <span className="text-[9px] bg-slate-100 text-slate-500 px-1.5 rounded-full font-bold">{t.engine}</span>
                      <span className="text-[9px] text-slate-400">{t.row_estimate != null ? fmtNum(t.row_estimate) + ' rows' : '—'}</span>
                      <span className="text-[9px] text-slate-400">{t.size_human}</span>
                    </div>
                  </button>
                ))}
                {!tblListLoading && selDb && (tblListData?.data || []).length === 0 && (
                  <p className="text-center py-8 text-[11px] text-slate-400">No tables</p>
                )}
              </div>
            </div>

            {/* ─ Right: Table detail ─ */}
            <div className="flex-1 min-w-0 bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col overflow-hidden">
              {!selTable ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center py-20">
                  <div className="w-16 h-16 rounded-2xl bg-slate-50 border border-slate-100 flex items-center justify-center mb-4">
                    <Table size={28} className="text-slate-200" />
                  </div>
                  <p className="font-semibold text-slate-500">Select a table to inspect</p>
                  <p className="text-[12px] text-slate-400 mt-1">Columns, indexes, constraints, DDL, and sample data</p>
                </div>
              ) : (
                <>
                  {/* detail header */}
                  <div className="flex-shrink-0 border-b border-slate-100 px-4 py-3 bg-slate-50/60">
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <div className="flex items-center gap-1.5">
                        <Database size={12} className="text-slate-400" />
                        <span className="text-[11px] text-slate-400">{selDb}</span>
                        <span className="text-slate-300 mx-1">/</span>
                        <span className="font-black text-slate-900 text-[14px]">{selTable}</span>
                      </div>
                      {tblDetailData?.status_info && (
                        <>
                          <span className="text-[10px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full font-bold">{tblDetailData.status_info.ENGINE}</span>
                          <span className="text-[10px] text-slate-400">{tblDetailData.status_info.total_size_human}</span>
                          <span className="text-[10px] text-slate-400">{fmtNum(tblDetailData.status_info.TABLE_ROWS)} rows</span>
                        </>
                      )}
                      {tblDetailLoading && <Loader2 size={12} className="animate-spin text-slate-400" />}
                    </div>
                    {/* sub-tabs */}
                    <div className="flex gap-0.5 overflow-x-auto">
                      {[
                        { id: 'columns',     label: 'Columns',     icon: Layers   },
                        { id: 'indexes',     label: 'Indexes',     icon: Key      },
                        { id: 'constraints', label: 'Constraints', icon: LinkIcon  },
                        { id: 'fk',          label: 'Foreign Keys',icon: GitBranch},
                        { id: 'triggers',    label: 'Triggers',    icon: Zap      },
                        { id: 'ddl',         label: 'DDL',         icon: Code2    },
                        { id: 'sample',      label: 'Sample Data', icon: Table    },
                      ].map(st => (
                        <button key={st.id} onClick={() => setTblSub(st.id)}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold whitespace-nowrap transition-all ${tblSubTab === st.id ? 'bg-white shadow-sm text-cyan-700 border border-slate-200' : 'text-slate-500 hover:text-slate-700 hover:bg-white/60'}`}>
                          <st.icon size={11} />
                          {st.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* detail content */}
                  <div className="flex-1 overflow-auto p-4">
                    {tblDetailLoading ? (
                      <div className="py-16 flex justify-center"><Loader2 size={24} className="animate-spin text-slate-400" /></div>
                    ) : tblSubTab === 'columns' ? (
                      <table className="w-full text-[12px]">
                        <thead className="sticky top-0 bg-slate-50 z-10">
                          <tr>{['#','Name','Type','Key','Nullable','Default','Extra','Comment'].map(h => (
                            <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wide whitespace-nowrap border-b border-slate-200">{h}</th>
                          ))}</tr>
                        </thead>
                        <tbody>
                          {(tblDetailData?.columns || []).map((c, i) => (
                            <tr key={i} className="border-b border-slate-50 hover:bg-slate-50/80">
                              <td className="px-3 py-2.5 text-slate-400 font-mono text-[10px]">{c.position}</td>
                              <td className="px-3 py-2.5 font-bold text-cyan-700">{c.name}</td>
                              <td className="px-3 py-2.5 font-mono text-slate-700">{c.type}</td>
                              <td className="px-3 py-2.5">
                                {c.key_type && <span className={`px-1.5 py-0.5 rounded-md text-[9px] font-black ${c.key_type === 'PRI' ? 'bg-yellow-100 text-yellow-700' : c.key_type === 'UNI' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'}`}>{c.key_type}</span>}
                              </td>
                              <td className="px-3 py-2.5 text-center">
                                {c.nullable === 'YES' ? <span className="text-slate-400 text-[10px]">NULL</span> : <span className="text-red-500 font-bold text-[10px]">NOT NULL</span>}
                              </td>
                              <td className="px-3 py-2.5 font-mono text-slate-500 text-[10px]">{c.default_value ?? '—'}</td>
                              <td className="px-3 py-2.5 text-slate-500 text-[10px]">{c.extra || '—'}</td>
                              <td className="px-3 py-2.5 text-slate-400 text-[10px] max-w-[140px] truncate">{c.comment || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : tblSubTab === 'indexes' ? (
                      <div className="space-y-3">
                        {(tblDetailData?.indexes || []).map((idx, i) => (
                          <div key={i} className="bg-slate-50 rounded-xl border border-slate-200 p-4">
                            <div className="flex items-center gap-2 mb-2 flex-wrap">
                              <Key size={13} className="text-slate-400 flex-shrink-0" />
                              <span className="font-black text-slate-900">{idx.name}</span>
                              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${idx.unique ? 'bg-blue-100 text-blue-700' : 'bg-slate-200 text-slate-600'}`}>
                                {idx.unique ? 'UNIQUE' : 'INDEX'}
                              </span>
                              <span className="text-[10px] bg-slate-200 text-slate-600 px-2 py-0.5 rounded-full font-bold">{idx.type}</span>
                              {idx.cardinality != null && <span className="text-[10px] text-slate-400">cardinality: {fmtNum(idx.cardinality)}</span>}
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {(idx.columns || []).map((col, j) => (
                                <div key={j} className="flex items-center gap-1 bg-white border border-slate-200 rounded-lg px-2.5 py-1.5">
                                  <span className="text-[9px] text-slate-400 font-bold">{col.seq}.</span>
                                  <span className="font-mono font-bold text-[11px] text-cyan-700">{col.name}</span>
                                  {col.sub_part && <span className="text-[9px] text-slate-400">({col.sub_part})</span>}
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                        {!(tblDetailData?.indexes || []).length && <p className="text-center py-8 text-slate-400">No indexes</p>}
                      </div>
                    ) : tblSubTab === 'constraints' ? (
                      <div className="space-y-2">
                        {(tblDetailData?.constraints || []).map((c, i) => (
                          <div key={i} className="flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
                            <span className={`text-[10px] font-black px-2 py-1 rounded-lg ${c.type === 'PRIMARY KEY' ? 'bg-yellow-100 text-yellow-700' : c.type === 'UNIQUE' ? 'bg-blue-100 text-blue-700' : c.type === 'FOREIGN KEY' ? 'bg-violet-100 text-violet-700' : 'bg-slate-200 text-slate-600'}`}>{c.type}</span>
                            <span className="font-mono font-semibold text-slate-800">{c.name}</span>
                          </div>
                        ))}
                        {!(tblDetailData?.constraints || []).length && <p className="text-center py-8 text-slate-400">No constraints</p>}
                      </div>
                    ) : tblSubTab === 'fk' ? (
                      <div className="space-y-3">
                        {(tblDetailData?.foreign_keys || []).map((fk, i) => (
                          <div key={i} className="bg-slate-50 rounded-xl border border-slate-200 p-4">
                            <div className="flex items-center gap-2 mb-2">
                              <GitBranch size={12} className="text-violet-500" />
                              <span className="font-bold text-slate-900 text-[13px]">{fk.name}</span>
                            </div>
                            <div className="grid grid-cols-2 gap-x-6 text-[11px]">
                              <div><span className="text-slate-400">Column:</span> <code className="font-mono text-cyan-700 font-bold">{fk.column_name}</code></div>
                              <div><span className="text-slate-400">→ References:</span> <code className="font-mono text-violet-700 font-bold">{fk.ref_schema}.{fk.ref_table}.{fk.ref_column}</code></div>
                              <div className="mt-1"><span className="text-slate-400">On Update:</span> <span className="font-semibold text-slate-700">{fk.on_update}</span></div>
                              <div className="mt-1"><span className="text-slate-400">On Delete:</span> <span className="font-semibold text-slate-700">{fk.on_delete}</span></div>
                            </div>
                          </div>
                        ))}
                        {!(tblDetailData?.foreign_keys || []).length && <p className="text-center py-8 text-slate-400">No foreign keys</p>}
                      </div>
                    ) : tblSubTab === 'triggers' ? (
                      <div className="space-y-3">
                        {(tblDetailData?.triggers || []).map((tr, i) => (
                          <div key={i} className="bg-slate-50 rounded-xl border border-slate-200 p-4">
                            <div className="flex items-center gap-2 mb-2 flex-wrap">
                              <Zap size={12} className="text-amber-500" />
                              <span className="font-black text-slate-900">{tr.name}</span>
                              <span className="text-[10px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-bold">{tr.timing} {tr.event}</span>
                              <span className="text-[10px] text-slate-400">{tr.definer}</span>
                            </div>
                            <pre className="text-[10px] font-mono bg-white border border-slate-200 rounded-lg px-3 py-2 overflow-x-auto text-slate-700 whitespace-pre-wrap max-h-40">{tr.body}</pre>
                          </div>
                        ))}
                        {!(tblDetailData?.triggers || []).length && <p className="text-center py-8 text-slate-400">No triggers defined</p>}
                      </div>
                    ) : tblSubTab === 'ddl' ? (
                      <div>
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">CREATE TABLE statement</span>
                          <button onClick={() => navigator.clipboard.writeText(tblDetailData?.ddl || '')}
                            className="flex items-center gap-1.5 h-7 px-3 rounded-lg border border-slate-200 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 transition-all">
                            <Copy size={11} /> Copy DDL
                          </button>
                        </div>
                        <pre className="font-mono text-[11px] bg-slate-900 text-green-400 rounded-2xl p-5 overflow-x-auto whitespace-pre leading-relaxed max-h-[440px]">
                          {tblDetailData?.ddl || '— DDL unavailable —'}
                        </pre>
                      </div>
                    ) : tblSubTab === 'sample' ? (
                      <div>
                        {tblSampleLoading ? (
                          <div className="py-16 flex justify-center"><Loader2 size={24} className="animate-spin text-slate-400" /></div>
                        ) : (
                          <>
                            <p className="text-[11px] text-slate-400 mb-3">
                              Showing {tblSampleData?.returned || 0} of {fmtNum(tblSampleData?.total_rows)} rows
                            </p>
                            <div className="overflow-auto max-h-[440px]">
                              <table className="w-full text-[11px]">
                                <thead className="sticky top-0 bg-slate-900 z-10">
                                  <tr>
                                    {(tblSampleData?.col_names || []).map(c => (
                                      <th key={c} className="px-3 py-2.5 text-left font-mono font-bold text-green-400 whitespace-nowrap border-r border-slate-700 last:border-0">{c}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {(tblSampleData?.data || []).map((row, i) => (
                                    <tr key={i} className={`border-b border-slate-100 ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'} hover:bg-cyan-50/30`}>
                                      {(tblSampleData?.col_names || []).map(c => (
                                        <td key={c} className="px-3 py-2 font-mono text-slate-700 max-w-[180px] truncate border-r border-slate-100 last:border-0" title={String(row[c] ?? '')}>
                                          {row[c] === null ? <span className="text-slate-300 italic">NULL</span> : String(row[c]).length > 40 ? String(row[c]).slice(0,40) + '…' : String(row[c])}
                                        </td>
                                      ))}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </>
                        )}
                      </div>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* ══ LOCKS ═════════════════════════════════════════════════ */}
        {activeTab === 'locks' && (
          <div className="space-y-5">
            {innodbLoading ? <TabLoader /> : (() => {
              const m   = innodbData?.metrics || {};
              const txns = innodbData?.active_transactions || [];
              return (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <ClickableKpi title="Deadlocks"     value={m.deadlocks}
                      accent={m.deadlocks > 0 ? 'red' : 'green'} hint="Total since last restart"
                      onClick={() => setDrillModal({ title: 'Deadlock Info', subtitle: `${m.deadlocks} deadlock(s) detected`,
                        content: <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700 space-y-2">
                          <p className="font-bold">{m.deadlocks} Deadlock(s) recorded since server restart.</p>
                          <p>To inspect the last deadlock, run:</p>
                          <code className="block bg-red-100 rounded px-3 py-2 font-mono text-xs">SHOW ENGINE INNODB STATUS\G</code>
                          <p className="text-xs text-red-600">Fix: Review transaction ordering, add indexes to reduce lock scope, or use SELECT ... FOR UPDATE SKIP LOCKED.</p>
                        </div>
                      })} />
                    <ClickableKpi title="Lock Waits"    value={fmtNum(m.lock_waits)}
                      accent={m.lock_waits > 0 ? 'orange' : 'green'} hint="Row-level waits"
                      onClick={() => setExpandedTxnId(txns.find(t => t.rows_locked > 0)?.trx_id || null)} />
                    <ClickableKpi title="Avg Lock Wait" value={`${m.lock_time_avg_ms}ms`}
                      accent="blue" hint="Average wait time"
                      onClick={() => {}} />
                    <ClickableKpi title="Active Txns"   value={txns.length}
                      accent={txns.length > 5 ? 'orange' : 'green'} hint="Click to see longest-running"
                      onClick={() => { const long = [...txns].sort((a,b)=>(b.rows_locked||0)-(a.rows_locked||0))[0]; if(long) setExpandedTxnId(long.trx_id); }} />
                  </div>

                  <Panel title={`Active Transactions (${txns.length})`}
                    action={<span className="text-[10px] text-slate-400">Click row to expand details</span>}>
                    {txns.length === 0 ? (
                      <div className="text-center py-10">
                        <CheckCircle2 className="mx-auto text-green-400 mb-3" size={36} />
                        <p className="text-slate-500 font-semibold">No active transactions</p>
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-slate-50">
                            <tr>{['Trx ID','State','Started','Rows Locked','Rows Modified','Query'].map(h => (
                              <th key={h} className="px-4 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase">{h}</th>
                            ))}</tr>
                          </thead>
                          <tbody>
                            {txns.map((t, i) => {
                              const isExpT = expandedTxnId === t.trx_id;
                              return (
                                <React.Fragment key={i}>
                                  <tr
                                    className={`border-t border-slate-100 cursor-pointer transition-colors ${isExpT ? 'bg-orange-50' : 'hover:bg-slate-50'}`}
                                    onClick={() => setExpandedTxnId(isExpT ? null : t.trx_id)}>
                                    <td className="px-4 py-3 font-mono text-xs">
                                      <div className="flex items-center gap-1">
                                        {isExpT ? <ChevronUp size={10} className="text-orange-600" /> : <ChevronDown size={10} className="text-slate-300" />}
                                        {t.trx_id}
                                      </div>
                                    </td>
                                    <td className="px-4 py-3">
                                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${t.state === 'RUNNING' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                                        {t.state}
                                      </span>
                                    </td>
                                    <td className="px-4 py-3 text-xs text-slate-400">{t.started?.slice(0,19)}</td>
                                    <td className="px-4 py-3 font-bold text-orange-600">{t.rows_locked}</td>
                                    <td className="px-4 py-3 text-slate-700">{t.rows_modified}</td>
                                    <td className="px-4 py-3 font-mono text-[10px] text-slate-500 max-w-[250px] truncate">{t.query || '—'}</td>
                                  </tr>
                                  {isExpT && (
                                    <tr><td colSpan={6} className="p-0"><TransactionDetail t={t} /></td></tr>
                                  )}
                                </React.Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Panel>

                  {m.deadlocks > 0 && (
                    <div className="bg-red-50 border border-red-200 rounded-2xl p-5">
                      <div className="flex items-center gap-2 text-red-700 font-bold mb-2">
                        <AlertTriangle size={18} /> {m.deadlocks} Deadlock{m.deadlocks > 1 ? 's' : ''} detected
                      </div>
                      <p className="text-sm text-red-600">
                        Consider reviewing transaction ordering, adding proper indexes, or using SELECT ... FOR UPDATE SKIP LOCKED.
                      </p>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {/* ══ REPLICATION — advanced monitor ════════════════════════ */}
        {activeTab === 'replication' && (() => {
          const rd = replData || {};
          const health     = rd.health || 'unknown';
          const details    = rd.health_detail || [];
          const isGalera   = !!rd.is_galera;
          const isSlave    = !!rd.is_slave;
          const isMaster   = !!rd.is_master;
          const galera     = rd.galera || {};
          const slave      = rd.slave_status || {};
          const master     = rd.master_status || {};
          const gtid       = rd.gtid || {};

          const healthColors = {
            healthy:  { bg: 'bg-green-50',  border: 'border-green-200',  text: 'text-green-800',  dot: 'bg-green-500' },
            warning:  { bg: 'bg-yellow-50', border: 'border-yellow-200', text: 'text-yellow-800', dot: 'bg-yellow-500' },
            critical: { bg: 'bg-red-50',    border: 'border-red-200',    text: 'text-red-800',    dot: 'bg-red-500' },
            unknown:  { bg: 'bg-slate-50',  border: 'border-slate-200',  text: 'text-slate-600',  dot: 'bg-slate-400' },
          };
          const hc = healthColors[health] || healthColors.unknown;

          const threadPill = (state) => {
            const ok = state === 'Yes' || state === 'Connecting';
            return (
              <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold ${ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-green-500' : 'bg-red-500'}`} />
                {state || '—'}
              </span>
            );
          };

          const lagBar = (sec) => {
            const n = Number(sec);
            if (isNaN(n)) return null;
            const pct = Math.min(100, (n / 60) * 100);
            const color = n === 0 ? 'bg-green-500' : n < 10 ? 'bg-yellow-500' : 'bg-red-500';
            return (
              <div className="mt-2">
                <div className="flex justify-between text-[10px] text-slate-500 mb-1">
                  <span>Replication Lag</span>
                  <span className="font-mono font-bold">{n}s</span>
                </div>
                <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                  <div className={`h-2 rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          };

          return (
            <div className="space-y-5">

              {/* ─ Health banner ─ */}
              <div className={`flex items-start gap-4 px-5 py-4 rounded-2xl border ${hc.bg} ${hc.border}`}>
                <div className="flex-shrink-0 mt-0.5">
                  <span className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-[12px] font-black uppercase tracking-wide ${hc.bg} ${hc.text}`}>
                    <span className={`w-2 h-2 rounded-full ${hc.dot} animate-pulse`} />
                    {health.toUpperCase()}
                  </span>
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-3 flex-wrap mb-2">
                    {isGalera  && <span className="px-2.5 py-1 text-[11px] font-bold bg-purple-100 text-purple-700 rounded-full">Galera Cluster</span>}
                    {isMaster  && <span className="px-2.5 py-1 text-[11px] font-bold bg-blue-100 text-blue-700 rounded-full">Primary / Master</span>}
                    {isSlave   && <span className="px-2.5 py-1 text-[11px] font-bold bg-cyan-100 text-cyan-700 rounded-full">Replica / Slave</span>}
                    {!isGalera && !isMaster && !isSlave && <span className="px-2.5 py-1 text-[11px] font-bold bg-slate-100 text-slate-600 rounded-full">Standalone</span>}
                    <button onClick={() => refetchRepl()} className="ml-auto flex items-center gap-1.5 h-7 px-3 rounded-lg border border-slate-200 text-[11px] text-slate-600 font-semibold hover:bg-white/80 transition-all bg-white/60">
                      <RefreshCw size={11} /> Refresh
                    </button>
                    {replLoading && <Loader2 size={14} className="animate-spin text-slate-400" />}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {details.map((d, i) => (
                      <div key={i} className={`flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg ${d.ok ? 'bg-green-100/60 text-green-700' : 'bg-red-100/60 text-red-700'}`}>
                        {d.ok ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
                        {d.message}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* ─ Galera section ─ */}
              {isGalera && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Network size={14} className="text-purple-500" />
                    <h3 className="font-black text-slate-800 text-[14px]">Galera Cluster</h3>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 text-center">
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-1">Cluster Size</p>
                      <p className="text-3xl font-black text-slate-900">{galera.cluster_size ?? '—'}</p>
                    </div>
                    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 text-center">
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-1">Node State</p>
                      <p className={`text-[14px] font-black ${galera.local_state_comment === 'Synced' ? 'text-green-600' : 'text-yellow-600'}`}>{galera.local_state_comment ?? '—'}</p>
                    </div>
                    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 text-center">
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-1">Cluster Status</p>
                      <p className={`text-[14px] font-black ${galera.cluster_status === 'Primary' ? 'text-green-600' : 'text-red-600'}`}>{galera.cluster_status ?? '—'}</p>
                    </div>
                    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 text-center">
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-1">Ready</p>
                      <p className={`text-[14px] font-black ${galera.ready === 'ON' ? 'text-green-600' : 'text-red-600'}`}>{galera.ready ?? '—'}</p>
                    </div>
                  </div>

                  {/* Galera metrics grid */}
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                    {[
                      { key: 'flow_control_paused',   label: 'FC Paused',        warn: v => parseFloat(v) > 0.1 },
                      { key: 'flow_control_sent',      label: 'FC Sent',          warn: v => parseInt(v) > 0 },
                      { key: 'flow_control_recv',      label: 'FC Recv',          warn: v => parseInt(v) > 0 },
                      { key: 'local_recv_queue_avg',   label: 'Recv Queue Avg',   warn: v => parseFloat(v) > 0 },
                      { key: 'local_send_queue_avg',   label: 'Send Queue Avg',   warn: v => parseFloat(v) > 0 },
                      { key: 'cert_failures',          label: 'Cert Failures',    warn: v => parseInt(v) > 0 },
                      { key: 'local_bf_aborts',        label: 'BF Aborts',        warn: v => parseInt(v) > 0 },
                      { key: 'replicated',             label: 'Replicated' },
                      { key: 'received',               label: 'Received' },
                      { key: 'commit_window',          label: 'Commit Window' },
                      { key: 'last_committed',         label: 'Last Committed' },
                      { key: 'protocol_version',       label: 'Protocol Version' },
                    ].filter(m => galera[m.key] != null).map(m => {
                      const v   = String(galera[m.key] ?? '—');
                      const bad = m.warn && m.warn(v);
                      return (
                        <div key={m.key} className={`rounded-xl border p-3 ${bad ? 'bg-red-50 border-red-200' : 'bg-slate-50 border-slate-100'}`}>
                          <p className="text-[9px] font-bold uppercase tracking-wide text-slate-400 mb-1">{m.label}</p>
                          <p className={`font-mono text-[12px] font-black ${bad ? 'text-red-700' : 'text-slate-800'}`}>{v}</p>
                        </div>
                      );
                    })}
                  </div>

                  {/* Galera addresses */}
                  {galera.incoming_addresses && (
                    <div className="mt-3 bg-slate-900 rounded-xl px-4 py-3">
                      <p className="text-[10px] text-slate-400 font-bold uppercase mb-1">Incoming Addresses</p>
                      <p className="font-mono text-green-400 text-[12px]">{galera.incoming_addresses}</p>
                    </div>
                  )}
                </div>
              )}

              {/* ─ Slave / Replica section ─ */}
              {isSlave && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <GitBranch size={14} className="text-cyan-600" />
                    <h3 className="font-black text-slate-800 text-[14px]">Replica Status</h3>
                  </div>

                  {/* Thread status row */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
                      <p className="text-[10px] font-bold text-slate-400 uppercase mb-2">IO Thread</p>
                      {threadPill(slave.io_running)}
                    </div>
                    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
                      <p className="text-[10px] font-bold text-slate-400 uppercase mb-2">SQL Thread</p>
                      {threadPill(slave.sql_running)}
                    </div>
                    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
                      <p className="text-[10px] font-bold text-slate-400 uppercase mb-2">Lag (seconds)</p>
                      <p className={`text-2xl font-black ${Number(slave.seconds_behind_master) === 0 ? 'text-green-600' : Number(slave.seconds_behind_master) < 10 ? 'text-yellow-600' : 'text-red-600'}`}>
                        {slave.seconds_behind_master ?? '—'}
                      </p>
                      {slave.seconds_behind_master != null && lagBar(slave.seconds_behind_master)}
                    </div>
                    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
                      <p className="text-[10px] font-bold text-slate-400 uppercase mb-2">Auto Position</p>
                      <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold ${slave.auto_position ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'}`}>
                        {slave.auto_position ? 'GTID Mode' : 'File/Pos Mode'}
                      </span>
                    </div>
                  </div>

                  {/* Detail fields */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {[
                      { label: 'Master Host',     val: slave.master_host },
                      { label: 'Master Port',     val: slave.master_port },
                      { label: 'Master User',     val: slave.master_user },
                      { label: 'Master Log File', val: slave.master_log_file },
                      { label: 'Read Log Pos',    val: slave.read_master_log_pos },
                      { label: 'Relay Log File',  val: slave.relay_log_file },
                      { label: 'Relay Log Pos',   val: slave.relay_log_pos },
                      { label: 'Exec Log Pos',    val: slave.exec_master_log_pos },
                      { label: 'Relay Master Log',val: slave.relay_master_log_file },
                      { label: 'Retrieved GTIDs', val: slave.retrieved_gtid_set },
                      { label: 'Executed GTIDs',  val: slave.executed_gtid_set },
                    ].filter(f => f.val != null).map((f, i) => (
                      <div key={i} className="bg-slate-50 rounded-xl border border-slate-100 px-4 py-3">
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-1">{f.label}</p>
                        <p className="font-mono text-[12px] text-slate-800 font-semibold break-all">{String(f.val)}</p>
                      </div>
                    ))}
                  </div>

                  {/* Errors */}
                  {(slave.last_io_error || slave.last_sql_error) && (
                    <div className="mt-3 space-y-2">
                      {slave.last_io_error  && <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-3"><AlertTriangle size={14} className="text-red-500 flex-shrink-0 mt-0.5" /><div><p className="text-[10px] font-bold text-red-700 uppercase mb-0.5">IO Error (errno {slave.last_io_errno})</p><p className="font-mono text-[11px] text-red-800">{slave.last_io_error}</p></div></div>}
                      {slave.last_sql_error && <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-3"><AlertTriangle size={14} className="text-red-500 flex-shrink-0 mt-0.5" /><div><p className="text-[10px] font-bold text-red-700 uppercase mb-0.5">SQL Error (errno {slave.last_sql_errno})</p><p className="font-mono text-[11px] text-red-800">{slave.last_sql_error}</p></div></div>}
                    </div>
                  )}
                </div>
              )}

              {/* ─ Master section ─ */}
              {isMaster && master.file && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Database size={14} className="text-blue-600" />
                    <h3 className="font-black text-slate-800 text-[14px]">Primary / Master Status</h3>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {[
                      { label: 'Binlog File',     val: master.file },
                      { label: 'Binlog Position', val: master.position },
                      { label: 'Binlog Do DB',    val: master.binlog_do_db || '(all)' },
                      { label: 'Binlog Ignore DB',val: master.binlog_ignore_db || '(none)' },
                    ].map((f, i) => (
                      <div key={i} className="bg-white rounded-2xl border border-slate-200 shadow-sm px-4 py-3">
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-1">{f.label}</p>
                        <p className="font-mono text-[13px] font-black text-blue-700 break-all">{String(f.val)}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ─ GTID section ─ */}
              {Object.values(gtid).some(v => v) && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Key size={14} className="text-amber-600" />
                    <h3 className="font-black text-slate-800 text-[14px]">GTID</h3>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {[
                      { label: 'GTID Mode',       val: gtid.gtid_mode },
                      { label: 'Domain ID',        val: gtid.gtid_domain_id },
                      { label: 'Strict Mode',      val: gtid.gtid_strict_mode },
                      { label: 'Binlog Pos',       val: gtid.gtid_binlog_pos },
                      { label: 'Slave Pos',        val: gtid.gtid_slave_pos },
                      { label: 'Current Pos',      val: gtid.gtid_current_pos },
                    ].filter(f => f.val != null).map((f, i) => (
                      <div key={i} className="bg-amber-50 rounded-xl border border-amber-100 px-4 py-3">
                        <p className="text-[10px] font-bold text-amber-600 uppercase tracking-wide mb-1">{f.label}</p>
                        <p className="font-mono text-[12px] font-bold text-amber-900 break-all">{String(f.val)}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ─ Replication variables (collapsible) ─ */}
              <div>
                <button onClick={() => setReplVarsOpen(v => !v)}
                  className="flex items-center gap-2 w-full text-left px-4 py-3 bg-slate-50 rounded-xl border border-slate-200 hover:bg-slate-100 transition-all">
                  <Settings size={13} className="text-slate-500" />
                  <span className="font-bold text-slate-700 text-[13px]">Replication Variables</span>
                  <span className="ml-auto">{replVarsOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
                </button>
                {replVarsOpen && (
                  replVarsLoading ? (
                    <div className="py-8 flex justify-center"><Loader2 size={20} className="animate-spin text-slate-400" /></div>
                  ) : (
                    <div className="mt-2 space-y-4">
                      {Object.entries(replVarsData?.categories || {}).map(([cat, vars]) => (
                        <div key={cat} className="bg-slate-50 rounded-xl border border-slate-200 overflow-hidden">
                          <div className="px-4 py-2.5 bg-slate-100/80 border-b border-slate-200">
                            <span className="font-black text-[12px] text-slate-600 uppercase tracking-wide">{cat}</span>
                          </div>
                          <div className="p-3 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-1.5">
                            {Object.entries(vars).map(([k, v]) => (
                              <div key={k} className="flex items-center gap-2 bg-white rounded-lg border border-slate-100 px-3 py-2">
                                <span className="font-mono text-[10px] text-slate-500 flex-1 min-w-0 truncate">{k}</span>
                                <span className="font-mono text-[11px] font-bold text-slate-900 flex-shrink-0 max-w-[120px] truncate">{String(v ?? '—')}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                      {!Object.keys(replVarsData?.categories || {}).length && (
                        <p className="text-center py-8 text-slate-400">No replication variables available</p>
                      )}
                    </div>
                  )
                )}
              </div>

            </div>
          );
        })()}

        {/* ══ USERS ═════════════════════════════════════════════════ */}
        {activeTab === 'users' && (
          userLoading ? <TabLoader /> : (() => {
            const users  = userData?.users  || [];
            const grants = userData?.grants || [];
            return (
              <div className="space-y-5">
                <div className="grid grid-cols-3 gap-3">
                  <MetricKpi title="Distinct Users"    value={users.length}                        accent="blue" />
                  <ClickableKpi title="Active Sessions"  value={users.reduce((a,u)=>a+u.active,0)}
                    accent="green" hint="Click to see active processes"
                    onClick={() => { setActiveTab('queries'); }} />
                  <ClickableKpi title="Sleeping Sessions" value={users.reduce((a,u)=>a+u.sleeping,0)}
                    accent="slate" hint="Click to see sleeping processes"
                    onClick={() => { setActiveTab('queries'); }} />
                </div>

                <div className="bg-cyan-50 border border-cyan-200 rounded-xl px-4 py-2 flex items-center gap-2 text-cyan-700 text-xs font-semibold">
                  <Eye size={13} /> Click any user row to see their process details
                </div>

                <Panel title="User Sessions">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50">
                        <tr>{['User','Host','Connections','Active','Sleeping'].map(h => (
                          <th key={h} className="px-4 py-3 text-left text-[10px] font-bold text-slate-400 uppercase">{h}</th>
                        ))}</tr>
                      </thead>
                      <tbody>
                        {users.map((u, i) => (
                          <tr key={i}
                            className="border-t border-slate-100 hover:bg-cyan-50 cursor-pointer transition-colors group"
                            onClick={() => setDrillModal({
                              title: `User: ${u.user}@${u.host}`,
                              subtitle: `${u.connections} connection(s) · ${u.active} active · ${u.sleeping} sleeping`,
                              content: (
                                <div className="space-y-3">
                                  <div className="grid grid-cols-3 gap-3">
                                    {[['Connections', u.connections, 'blue'], ['Active', u.active, 'green'], ['Sleeping', u.sleeping, 'slate']].map(([l,v,a]) => (
                                      <div key={l} className={`rounded-xl border p-4 bg-${a}-50 border-${a}-200 text-${a}-700`}>
                                        <p className="text-[10px] font-bold uppercase">{l}</p>
                                        <p className="text-2xl font-black mt-1">{v}</p>
                                      </div>
                                    ))}
                                  </div>
                                  <div className="bg-white border border-slate-200 rounded-xl p-4">
                                    <p className="text-xs text-slate-500 mb-2">Processes from this user in the current process list:</p>
                                    <div className="space-y-1">
                                      {process_list.filter(p => p.User === u.user).map((p, pi) => (
                                        <div key={pi} className="font-mono text-[10px] bg-slate-50 rounded-lg px-3 py-2 border border-slate-100">
                                          <span className="font-bold text-cyan-700">ID:{p.Id}</span>
                                          <span className="ml-2 text-orange-600">Time:{p.Time}s</span>
                                          <span className="ml-2 text-slate-500">{p.Command}</span>
                                          <span className="ml-2 text-slate-400 truncate">{String(p.Info || '').slice(0,100)}</span>
                                        </div>
                                      ))}
                                      {process_list.filter(p => p.User === u.user).length === 0 && (
                                        <p className="text-xs text-slate-400">No active processes for this user right now</p>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              )
                            })}>
                            <td className="px-4 py-3 font-bold text-cyan-700 flex items-center gap-1.5">
                              {u.user}
                              <Eye size={11} className="opacity-0 group-hover:opacity-60 text-cyan-500 transition-opacity" />
                            </td>
                            <td className="px-4 py-3 text-xs text-slate-400">{u.host}</td>
                            <td className="px-4 py-3 font-bold">{u.connections}</td>
                            <td className="px-4 py-3">
                              <span className="px-2 py-0.5 bg-green-100 text-green-700 text-[10px] font-bold rounded-full">{u.active}</span>
                            </td>
                            <td className="px-4 py-3">
                              <span className="px-2 py-0.5 bg-slate-100 text-slate-500 text-[10px] font-bold rounded-full">{u.sleeping}</span>
                            </td>
                          </tr>
                        ))}
                        {users.length === 0 && <tr><td colSpan={5} className="text-center py-10 text-slate-400">No users</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </Panel>

                {grants.length > 0 && (
                  <Panel title="Global Privileges">
                    <div className="flex flex-wrap gap-2">
                      {[...new Set(grants.map(g => g.grantee))].slice(0, 20).map(g => (
                        <span key={g} className="px-3 py-1.5 bg-slate-100 text-slate-700 text-xs font-semibold rounded-xl border border-slate-200">
                          {g.replace(/'/g, '').replace(/@.*/, '')}
                        </span>
                      ))}
                    </div>
                  </Panel>
                )}
              </div>
            );
          })()
        )}

        {/* ══ STORAGE ═══════════════════════════════════════════════ */}
        {activeTab === 'storage' && (
          tableLoading ? <TabLoader /> : (() => {
            const tables   = tableData?.tables || [];
            const totalMB  = tables.reduce((a, t) => a + t.total_mb, 0).toFixed(2);
            const totalIdx = tables.reduce((a, t) => a + t.index_mb, 0).toFixed(2);
            const totalData= tables.reduce((a, t) => a + t.data_mb, 0).toFixed(2);
            const topTables= tables.slice(0, 10);
            return (
              <div className="space-y-5">
                <div className="grid grid-cols-3 gap-3">
                  <ClickableKpi title="Total Size"  value={`${totalMB} MB`}  accent="orange"
                    hint="Click to see table breakdown"
                    onClick={() => setDrillModal({
                      title: 'Storage Breakdown by Table',
                      subtitle: `${tables.length} tables · ${totalMB} MB total`,
                      content: (
                        <div className="space-y-2">
                          {tables.sort((a,b) => b.total_mb - a.total_mb).map((t, i) => (
                            <div key={i} className="flex items-center justify-between bg-slate-50 rounded-xl px-4 py-2.5 border border-slate-100">
                              <span className="font-mono text-xs font-bold text-slate-700">{t.database}.{t.table}</span>
                              <div className="flex items-center gap-3 text-xs">
                                <span className="text-blue-600 font-semibold">Data: {t.data_mb} MB</span>
                                <span className="text-purple-600 font-semibold">Index: {t.index_mb} MB</span>
                                <span className="bg-orange-100 text-orange-700 font-bold px-2 py-0.5 rounded-full">{t.total_mb} MB</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )
                    })} />
                  <ClickableKpi title="Data Size"   value={`${totalData} MB`} accent="blue"
                    hint="Click to see data size per table"
                    onClick={() => setDrillModal({
                      title: 'Data Size by Table',
                      subtitle: `${totalData} MB data across ${tables.length} tables`,
                      content: (
                        <div className="space-y-2">
                          {tables.sort((a,b) => b.data_mb - a.data_mb).map((t, i) => (
                            <div key={i} className="flex items-center justify-between bg-blue-50 rounded-xl px-4 py-2.5 border border-blue-100">
                              <span className="font-mono text-xs font-bold text-slate-700">{t.database}.{t.table}</span>
                              <div className="flex items-center gap-2 text-xs">
                                <span className="text-slate-400">Rows: {(t.rows||0).toLocaleString()}</span>
                                <span className="bg-blue-200 text-blue-800 font-bold px-2 py-0.5 rounded-full">{t.data_mb} MB</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )
                    })} />
                  <ClickableKpi title="Index Size"  value={`${totalIdx} MB`} accent="purple"
                    hint="Click to see index size per table"
                    onClick={() => setDrillModal({
                      title: 'Index Size by Table',
                      subtitle: `${totalIdx} MB index across ${tables.length} tables`,
                      content: (
                        <div className="space-y-2">
                          {tables.sort((a,b) => b.index_mb - a.index_mb).map((t, i) => (
                            <div key={i} className="flex items-center justify-between bg-purple-50 rounded-xl px-4 py-2.5 border border-purple-100">
                              <span className="font-mono text-xs font-bold text-slate-700">{t.database}.{t.table}</span>
                              <span className="bg-purple-200 text-purple-800 font-bold px-2 py-0.5 rounded-full text-xs">{t.index_mb} MB</span>
                            </div>
                          ))}
                        </div>
                      )
                    })} />
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
                  <ChartCard title="Top 10 Tables by Size (MB)">
                    <ResponsiveContainer width="100%" height={280}>
                      <BarChart layout="vertical" data={topTables}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                        <XAxis type="number" tick={{ fontSize: 10 }} />
                        <YAxis width={130} type="category" dataKey="table" tick={{ fontSize: 10 }} />
                        <Tooltip formatter={v => `${v} MB`} />
                        <Bar dataKey="data_mb"  fill={C.blue}   radius={[0,4,4,0]} stackId="a" name="Data" />
                        <Bar dataKey="index_mb" fill={C.purple} radius={[0,4,4,0]} stackId="a" name="Index" />
                        <Legend />
                      </BarChart>
                    </ResponsiveContainer>
                    <div className="mt-3 space-y-1.5">
                      {topTables.map((t, i) => (
                        <button key={i}
                          onClick={() => setDrillModal({
                            title: `Table: ${t.database}.${t.table}`,
                            subtitle: `${t.total_mb} MB total · ${(t.rows||0).toLocaleString()} rows`,
                            content: (
                              <div className="space-y-3">
                                <div className="grid grid-cols-3 gap-3">
                                  {[['Total', `${t.total_mb} MB`, 'orange'], ['Data', `${t.data_mb} MB`, 'blue'], ['Index', `${t.index_mb} MB`, 'purple']].map(([l,v,a]) => (
                                    <div key={l} className={`rounded-xl border p-4 bg-${a}-50 border-${a}-200 text-${a}-700`}>
                                      <p className="text-[10px] font-bold uppercase">{l}</p>
                                      <p className="text-xl font-black mt-1">{v}</p>
                                    </div>
                                  ))}
                                </div>
                                <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2 text-sm">
                                  <div className="flex justify-between"><span className="text-slate-400">Engine</span><span className="font-mono font-bold">{t.engine || '—'}</span></div>
                                  <div className="flex justify-between"><span className="text-slate-400">Rows</span><span className="font-bold">{(t.rows||0).toLocaleString()}</span></div>
                                  <div className="flex justify-between"><span className="text-slate-400">Avg Row Length</span><span className="font-bold">{t.avg_row_length || '—'} bytes</span></div>
                                  <div className="flex justify-between"><span className="text-slate-400">Collation</span><span className="font-mono text-xs">{t.collation || '—'}</span></div>
                                </div>
                              </div>
                            )
                          })}
                          className="w-full flex items-center justify-between text-xs bg-slate-50 hover:bg-cyan-50 border border-slate-100 hover:border-cyan-200 rounded-lg px-3 py-1.5 transition-colors group">
                          <span className="font-mono font-bold text-slate-700">{i+1}. {t.table}</span>
                          <span className="text-slate-400 group-hover:text-cyan-600">{t.total_mb} MB →</span>
                        </button>
                      ))}
                    </div>
                  </ChartCard>

                  <ChartCard title="Database Size Distribution">
                    <ResponsiveContainer width="100%" height={280}>
                      <PieChart>
                        <Pie data={databases.filter(d=>d.size_mb>0)} dataKey="size_mb" nameKey="name" innerRadius={50} outerRadius={90} label={({ name, percent }) => `${name} ${(percent*100).toFixed(0)}%`}>
                          {databases.map((_, i) => <Cell key={i} fill={[C.teal,C.blue,C.green,C.orange,C.purple,C.cyan][i%6]} />)}
                        </Pie>
                        <Tooltip formatter={v => `${v} MB`} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="mt-3 space-y-1.5">
                      {databases.filter(d=>d.size_mb>0).map((db, i) => (
                        <button key={i}
                          onClick={() => { setSelDb(db.name); setActiveTab('tables'); }}
                          className="w-full flex items-center justify-between text-xs bg-slate-50 hover:bg-cyan-50 border border-slate-100 hover:border-cyan-200 rounded-lg px-3 py-1.5 transition-colors group">
                          <span className="font-mono font-bold text-slate-700">{db.name}</span>
                          <span className="text-slate-400 group-hover:text-cyan-600">{db.size_mb} MB → View Tables</span>
                        </button>
                      ))}
                    </div>
                  </ChartCard>
                </div>
              </div>
            );
          })()
        )}

        {/* ══ BACKUP & PITR ═════════════════════════════════════════ */}
        {activeTab === 'backup' && (
          <div className="space-y-5">
            {backupLoading ? <TabLoader /> : (() => {
              const bi = backupData?.backup_info || {};
              const pitr = bi.pitr_capable;
              return (
                <>
                  <div className={`rounded-2xl border p-5 ${pitr ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-3">
                        {pitr ? <CheckCircle2 className="text-green-600" size={24} /> : <XCircle className="text-red-600" size={24} />}
                        <div>
                          <h2 className="text-lg font-bold">PITR: {pitr ? 'ENABLED' : 'DISABLED'} — Binary Logging {bi.binlog_enabled || '?'}</h2>
                          <p className={`text-sm ${pitr ? 'text-green-700' : 'text-red-700'}`}>
                            {pitr ? 'Point-In-Time Recovery is available via binary logs.'
                                  : 'Enable binary logging (log_bin=ON) in my.cnf to support PITR.'}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => navigate(`/mysql-dashboard/${id}/backup`)}
                        className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold text-sm transition-colors shadow-md flex-shrink-0">
                        <Archive size={16} /> Open Backup & Restore Console
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <MetricKpi title="Binlog"    value={bi.binlog_enabled || '—'} accent={bi.binlog_enabled==='ON'?'green':'red'} />
                    <MetricKpi title="Format"    value={bi.binlog_format || '—'}  accent="blue" />
                    <MetricKpi title="GTID Mode" value={bi.gtid_mode || '—'}      accent={bi.gtid_mode==='ON'?'green':'orange'} />
                    <MetricKpi title="Durability" value={bi.durability_level || '—'} accent="blue" />
                  </div>

                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
                    <Panel title="Current Binary Log Position">
                      <div className="space-y-2 text-sm">
                        <Row label="File"     value={bi.current_binlog_file     || '—'} mono />
                        <Row label="Position" value={bi.current_binlog_position || '—'} mono />
                        <Row label="Server ID" value={bi.server_id || '—'} mono />
                        <Row label="Data Dir" value={bi.datadir   || '—'} mono />
                        <Row label="Expire Days" value={bi.expire_logs_days || '—'} />
                        <Row label="sync_binlog" value={bi.sync_binlog || '—'} />
                        <Row label="innodb_flush_log" value={bi.innodb_flush_log_at_trx_commit || '—'} />
                      </div>
                    </Panel>

                    <Panel title="Backup Strategy">
                      <div className="space-y-3 text-sm">
                        {[
                          ['Full Backup', 'mysqldump --all-databases > full.sql', 'blue'],
                          ['Hot Backup',  'xtrabackup --backup --target-dir=/backup', 'green'],
                          ['PITR Restore','mysqlbinlog --start-datetime="..." | mysql', 'purple'],
                        ].map(([t, cmd, color]) => (
                          <div key={t} className={`rounded-xl border p-3 bg-${color}-50 border-${color}-200`}>
                            <p className={`font-bold text-${color}-700 text-xs mb-1`}>{t}</p>
                            <code className="text-[10px] text-slate-600 font-mono break-all">{cmd}</code>
                          </div>
                        ))}
                      </div>
                    </Panel>
                  </div>

                  {bi.binlog_files?.length > 0 && (
                    <Panel title={`Binary Log Files (${bi.binlog_files.length})`}>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-slate-50">
                            <tr>
                              <th className="px-4 py-2.5 text-left text-xs font-bold text-slate-400">File</th>
                              <th className="px-4 py-2.5 text-right text-xs font-bold text-slate-400">Size</th>
                            </tr>
                          </thead>
                          <tbody>
                            {bi.binlog_files.map((f, i) => (
                              <tr key={i} className={`border-t border-slate-100 ${f.file === bi.current_binlog_file ? 'bg-cyan-50' : 'hover:bg-slate-50'}`}>
                                <td className="px-4 py-2.5 font-mono text-xs">
                                  {f.file}
                                  {f.file === bi.current_binlog_file && (
                                    <span className="ml-2 px-1.5 py-0.5 bg-cyan-100 text-cyan-700 text-[9px] font-bold rounded">CURRENT</span>
                                  )}
                                </td>
                                <td className="px-4 py-2.5 text-right font-mono text-xs">{fmtBytes(f.size_bytes)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </Panel>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {/* ══ LOGS ══════════════════════════════════════════════════ */}
        {activeTab === 'logs' && (
          <div className="space-y-5">

            {/* ── KPIs ── */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <ClickableKpi title="Error Log Entries"  value={error_log_count}
                accent={error_log_count > 0 ? 'red' : 'green'}
                hint="Click to view error logs"
                onClick={() => navigate(`/mysql-dashboard/${id}/error-logs`)} />
              <ClickableKpi title="Slow Queries Total" value={fmtNum(query_stats.Slow_queries)}
                accent={Number(query_stats.Slow_queries) > 0 ? 'orange' : 'green'}
                hint="Click to view slow queries"
                onClick={() => navigate(`/mysql-dashboard/${id}/slow-queries`)} />
              <MetricKpi title="Binlog"             value={binlogStatusData?.binlog_enabled ? 'ON' : (binlogStatusData ? 'OFF' : '…')} accent={binlogStatusData?.binlog_enabled ? 'green' : 'red'} />
              <MetricKpi title="Binlog Format"      value={binlogStatusData?.variables?.binlog_format || '—'} accent="blue" />
            </div>

            {/* ── Log File Paths ── */}
            <Panel title="Log File Paths">
              <div className="space-y-2 text-sm">
                <Row label="Error Log"        value={error_log_path || '—'} mono />
                <Row label="Slow Query Log"   value={slow_query_config.slow_query_log_file || '—'} mono />
                <Row label="Slow Log Enabled" value={slow_query_config.slow_query_log || '—'} />
                <Row label="Long Query Time"  value={`${slow_query_config.long_query_time || '—'} seconds`} />
              </div>
              <div className="flex gap-3 mt-5 flex-wrap">
                <button onClick={() => navigate(`/mysql-dashboard/${id}/error-logs`)}
                  className="px-4 h-9 rounded-xl bg-red-600 text-white text-xs font-bold hover:bg-red-700 flex items-center gap-2">
                  <FileText size={13} /> Error Logs
                </button>
                <button onClick={() => navigate(`/mysql-dashboard/${id}/error-analysis`)}
                  className="px-4 h-9 rounded-xl bg-cyan-700 text-white text-xs font-bold hover:bg-cyan-800 flex items-center gap-2">
                  <Zap size={13} /> AI Analysis
                </button>
                <button onClick={() => navigate(`/mysql-dashboard/${id}/slow-queries`)}
                  className="px-4 h-9 rounded-xl border border-slate-200 bg-white text-xs font-bold hover:bg-slate-50 flex items-center gap-2">
                  <Clock size={13} /> Slow Queries
                </button>
              </div>
            </Panel>

            {/* ── Binary Log Status ── */}
            {binlogStatusData && (
              <Panel title="Binary Log Status">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <div className="space-y-2 text-sm">
                    <Row label="Binary Logging"  value={binlogStatusData.binlog_enabled ? 'ON' : 'OFF'} />
                    <Row label="Format"          value={binlogStatusData.variables?.binlog_format || '—'} mono />
                    <Row label="Row Image"       value={binlogStatusData.variables?.binlog_row_image || '—'} />
                    <Row label="sync_binlog"     value={binlogStatusData.variables?.sync_binlog || '—'} mono />
                    <Row label="Expire (days)"   value={binlogStatusData.variables?.expire_logs_days || '—'} />
                    <Row label="Max Size"        value={binlogStatusData.variables?.max_binlog_size ? fmtBytes(Number(binlogStatusData.variables.max_binlog_size)) : '—'} />
                  </div>
                  <div className="space-y-2 text-sm">
                    <Row label="Current File"    value={binlogStatusData.master_status?.File || '—'} mono />
                    <Row label="Position"        value={binlogStatusData.master_status?.Position || '—'} mono />
                    <Row label="Basename"        value={binlogStatusData.binlog_basename || '—'} mono />
                    <Row label="Is Replica"      value={binlogStatusData.is_replica ? 'YES' : 'NO'} />
                    {binlogStatusData.master_error && (
                      <div className="mt-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700 font-mono break-all">
                        ⚠ {binlogStatusData.master_error}
                      </div>
                    )}
                  </div>
                </div>
              </Panel>
            )}

            {/* ── Binary Log Files ── */}
            <Panel title={`Binary Log Files${binlogsData?.data?.length ? ` (${binlogsData.data.length})` : ''}`}>
              {binlogsLoading ? (
                <div className="flex items-center gap-2 text-sm text-slate-400 py-4">
                  <Loader2 size={14} className="animate-spin" /> Loading binary logs…
                </div>
              ) : binlogsData?.status === 'disabled' || binlogsData?.status === 'error' ? (
                <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 text-sm text-amber-800">
                  <p className="font-bold mb-1">Binary logging is not available</p>
                  <pre className="text-xs font-mono whitespace-pre-wrap text-amber-700">{binlogsData.error}</pre>
                </div>
              ) : (binlogsData?.data?.length > 0) ? (
                <>
                  <div className="overflow-x-auto rounded-xl border border-slate-200">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 border-b border-slate-200">
                        <tr>
                          <th className="px-4 py-2.5 text-left font-bold text-slate-500">Log File</th>
                          <th className="px-4 py-2.5 text-right font-bold text-slate-500">Size</th>
                          <th className="px-4 py-2.5 text-center font-bold text-slate-500">Encrypted</th>
                          <th className="px-4 py-2.5 text-center font-bold text-slate-500">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {binlogsData.data.map((f, i) => {
                          const isCurrent = f.log_name === binlogStatusData?.master_status?.File;
                          const isSelected = f.log_name === selBinlog;
                          return (
                            <tr key={i}
                              className={`border-t border-slate-100 cursor-pointer transition-colors ${isSelected ? 'bg-cyan-50 border-l-4 border-l-cyan-500' : isCurrent ? 'bg-green-50' : 'hover:bg-slate-50'}`}
                              onClick={() => { setSelBinlog(f.log_name); setBinlogOffset(0); }}
                            >
                              <td className="px-4 py-2.5 font-mono">
                                {f.log_name}
                                {isCurrent && <span className="ml-2 px-1.5 py-0.5 bg-green-100 text-green-700 text-[9px] font-bold rounded-full">CURRENT</span>}
                              </td>
                              <td className="px-4 py-2.5 text-right font-mono text-slate-600">{f.size_human}</td>
                              <td className="px-4 py-2.5 text-center text-slate-500">{f.encrypted}</td>
                              <td className="px-4 py-2.5 text-center">
                                <button
                                  className="px-2.5 py-1 rounded-lg bg-slate-800 text-white text-[10px] font-bold hover:bg-slate-700 transition-colors"
                                  onClick={(e) => { e.stopPropagation(); setSelBinlog(f.log_name); setBinlogOffset(0); }}
                                >
                                  View Events
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Events for selected file */}
                  {selBinlog && (
                    <div className="mt-4 space-y-3">
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <h4 className="text-sm font-bold text-slate-700 font-mono">{selBinlog} — Events</h4>
                        <div className="flex items-center gap-2">
                          <button
                            disabled={binlogOffset === 0}
                            onClick={() => setBinlogOffset(o => Math.max(0, o - BINLOG_PAGE))}
                            className="px-3 py-1.5 text-xs font-bold rounded-lg border border-slate-200 disabled:opacity-40 hover:bg-slate-50 transition-colors"
                          >← Prev</button>
                          <span className="text-xs text-slate-400 font-mono">offset {binlogOffset}</span>
                          <button
                            disabled={!binlogEventsData?.data?.length || binlogEventsData.data.length < BINLOG_PAGE}
                            onClick={() => setBinlogOffset(o => o + BINLOG_PAGE)}
                            className="px-3 py-1.5 text-xs font-bold rounded-lg border border-slate-200 disabled:opacity-40 hover:bg-slate-50 transition-colors"
                          >Next →</button>
                          <button
                            onClick={() => setSelBinlog(null)}
                            className="px-3 py-1.5 text-xs font-bold rounded-lg bg-slate-100 hover:bg-slate-200 transition-colors text-slate-600"
                          >✕ Close</button>
                        </div>
                      </div>
                      {eventsLoading ? (
                        <div className="flex items-center gap-2 text-xs text-slate-400 py-3">
                          <Loader2 size={12} className="animate-spin" /> Loading events…
                        </div>
                      ) : (
                        <div className="overflow-x-auto rounded-xl border border-slate-200 max-h-72 overflow-y-auto">
                          <table className="w-full text-[11px]">
                            <thead className="bg-slate-800 text-white sticky top-0">
                              <tr>
                                <th className="px-3 py-2 text-left font-bold">Pos</th>
                                <th className="px-3 py-2 text-left font-bold">Event Type</th>
                                <th className="px-3 py-2 text-left font-bold">End Pos</th>
                                <th className="px-3 py-2 text-left font-bold">Server ID</th>
                                <th className="px-3 py-2 text-left font-bold">Info</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(binlogEventsData?.data || []).map((ev, i) => {
                                const evType = ev.event_type || '';
                                const rowBg =
                                  evType.includes('Write')  ? 'bg-green-50' :
                                  evType.includes('Update') ? 'bg-amber-50' :
                                  evType.includes('Delete') ? 'bg-red-50'   :
                                  evType === 'Query'        ? 'bg-blue-50'  :
                                  evType.includes('Gtid')   ? 'bg-purple-50': '';
                                return (
                                  <tr key={i} className={`border-t border-slate-100 ${rowBg}`}>
                                    <td className="px-3 py-1.5 font-mono text-slate-600">{ev.pos}</td>
                                    <td className="px-3 py-1.5">
                                      <BinlogEventBadge type={evType} />
                                    </td>
                                    <td className="px-3 py-1.5 font-mono text-slate-500">{ev.end_log_pos}</td>
                                    <td className="px-3 py-1.5 font-mono text-slate-500">{ev.server_id}</td>
                                    <td className="px-3 py-1.5 font-mono text-slate-600 max-w-xs truncate" title={ev.info}>{ev.info}</td>
                                  </tr>
                                );
                              })}
                              {!(binlogEventsData?.data?.length) && (
                                <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-400">No events found</td></tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm text-slate-400 py-4">No binary log files found.</p>
              )}
            </Panel>

            {/* ── Live Binlog Events ── */}
            <Panel title={
              <div className="flex items-center gap-3">
                <span>Live Binlog Events</span>
                {liveLoading
                  ? <Loader2 size={12} className="animate-spin text-slate-400" />
                  : <span className="flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block animate-pulse" />
                      LIVE · 5s
                    </span>
                }
                {binlogLiveData?.current_log && (
                  <span className="text-[10px] font-mono text-slate-400">{binlogLiveData.current_log} @ {binlogLiveData.current_pos}</span>
                )}
              </div>
            }>
              {binlogLiveData?.status === 'error' ? (
                <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 text-sm text-amber-800">
                  <p className="font-bold mb-1">Binary logging not enabled or insufficient privileges</p>
                  <p className="text-xs font-mono">{binlogLiveData.error}</p>
                </div>
              ) : (
                <>
                  {/* Filter pills */}
                  <div className="flex gap-2 mb-3 flex-wrap">
                    {[
                      { key: 'all',    label: 'All Events' },
                      { key: 'write',  label: 'Writes (INS/UPD/DEL)' },
                      { key: 'gtid',   label: 'GTID' },
                      { key: 'query',  label: 'DDL / Query' },
                      { key: 'other',  label: 'Other' },
                    ].map(({ key, label }) => (
                      <button
                        key={key}
                        onClick={() => setLiveFilter(key)}
                        className="px-3 py-1 rounded-full text-[10px] font-bold transition-all"
                        style={liveFilter === key
                          ? { background: '#0f172a', color: '#fff' }
                          : { background: '#f1f5f9', color: '#475569' }}
                      >{label}</button>
                    ))}
                    <span className="ml-auto text-[10px] text-slate-400 self-center">
                      {binlogLiveData?.showing || 0} events shown
                    </span>
                  </div>

                  {/* Events table */}
                  <div className="overflow-x-auto rounded-xl border border-slate-200 max-h-80 overflow-y-auto">
                    <table className="w-full text-[11px]">
                      <thead className="bg-slate-800 text-white sticky top-0">
                        <tr>
                          <th className="px-3 py-2 text-left font-bold">Pos</th>
                          <th className="px-3 py-2 text-left font-bold">Event Type</th>
                          <th className="px-3 py-2 text-left font-bold">End Pos</th>
                          <th className="px-3 py-2 text-left font-bold">Server</th>
                          <th className="px-3 py-2 text-left font-bold">Info</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(() => {
                          const evts = (binlogLiveData?.data || []).filter(ev => {
                            if (liveFilter === 'all')   return true;
                            if (liveFilter === 'write') return ev.is_write;
                            if (liveFilter === 'gtid')  return ev.is_gtid;
                            if (liveFilter === 'query') return ev.event_type === 'Query';
                            return !ev.is_write && !ev.is_gtid && ev.event_type !== 'Query';
                          });
                          if (!evts.length) return (
                            <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                              {binlogLiveData ? 'No events match the filter.' : 'Loading live events…'}
                            </td></tr>
                          );
                          return evts.map((ev, i) => {
                            const evType = ev.event_type || '';
                            const rowBg =
                              evType.includes('Write')    ? 'bg-green-50'  :
                              evType.includes('Update')   ? 'bg-amber-50'  :
                              evType.includes('Delete')   ? 'bg-red-50'    :
                              evType === 'Query'          ? 'bg-blue-50'   :
                              ev.is_gtid                  ? 'bg-purple-50' :
                              ev.is_rotate                ? 'bg-slate-100' : '';
                            return (
                              <tr key={i} className={`border-t border-slate-100 ${rowBg}`}>
                                <td className="px-3 py-1.5 font-mono text-slate-600">{ev.pos}</td>
                                <td className="px-3 py-1.5"><BinlogEventBadge type={evType} /></td>
                                <td className="px-3 py-1.5 font-mono text-slate-500">{ev.end_log_pos}</td>
                                <td className="px-3 py-1.5 font-mono text-slate-500">{ev.server_id}</td>
                                <td className="px-3 py-1.5 font-mono text-slate-600 max-w-xs truncate" title={ev.info}>{ev.info || '—'}</td>
                              </tr>
                            );
                          });
                        })()}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </Panel>

          </div>
        )}

      </div>
    </div>
  );
}

/* ─── helpers ─── */
function computeHealthScore(hs, longRunning, connPct, cachePct) {
  let score = 100;
  if (connPct > 90)  score -= 30;
  else if (connPct > 70) score -= 15;
  if (cachePct < 80) score -= 20;
  else if (cachePct < 90) score -= 10;
  if (longRunning.length > 5) score -= 15;
  else if (longRunning.length > 0) score -= 5;
  return Math.max(0, score);
}
function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  const b = Number(bytes);
  if (b > 1073741824) return `${(b/1073741824).toFixed(2)} GB`;
  if (b > 1048576) return `${(b/1048576).toFixed(2)} MB`;
  if (b > 1024) return `${(b/1024).toFixed(2)} KB`;
  return `${b} B`;
}
function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v/1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v/1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v/1e3).toFixed(1)}K`;
  return String(v);
}

/* ─── small components ─── */
function BinlogEventBadge({ type }) {
  const t = type || '';
  const cfg =
    t.includes('Write')         ? { label: t, bg: 'bg-green-100',  text: 'text-green-700'  } :
    t.includes('Update')        ? { label: t, bg: 'bg-amber-100',  text: 'text-amber-700'  } :
    t.includes('Delete')        ? { label: t, bg: 'bg-red-100',    text: 'text-red-700'    } :
    t === 'Query'               ? { label: t, bg: 'bg-blue-100',   text: 'text-blue-700'   } :
    t.includes('Gtid')          ? { label: t, bg: 'bg-purple-100', text: 'text-purple-700' } :
    t === 'Rotate'              ? { label: t, bg: 'bg-cyan-100',   text: 'text-cyan-700'   } :
    t === 'Format_desc'         ? { label: t, bg: 'bg-slate-100',  text: 'text-slate-500'  } :
    t === 'Stop'                ? { label: t, bg: 'bg-red-100',    text: 'text-red-600'    } :
                                  { label: t || '—', bg: 'bg-slate-100', text: 'text-slate-500' };
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[9px] font-bold ${cfg.bg} ${cfg.text} whitespace-nowrap`}>
      {cfg.label}
    </span>
  );
}
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
    cyan:   'border-l-cyan-500',
    teal:   'border-l-teal-500',
    green:  'border-l-green-500',
    blue:   'border-l-blue-500',
    orange: 'border-l-orange-500',
    red:    'border-l-red-500',
    purple: 'border-l-purple-500',
    slate:  'border-l-slate-400',
  };
  return (
    <div className={`bg-white rounded-xl border border-slate-200 border-l-4 ${acc[accent]||acc.slate} p-4 hover:shadow-md transition-all`}>
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
    green: 'bg-green-50 border-green-200 text-green-700',
    red:   'bg-red-50 border-red-200 text-red-700',
    orange:'bg-orange-50 border-orange-200 text-orange-700',
    blue:  'bg-blue-50 border-blue-200 text-blue-700',
    purple:'bg-purple-50 border-purple-200 text-purple-700',
    slate: 'bg-slate-50 border-slate-200 text-slate-700',
  };
  return (
    <div className={`rounded-xl border p-4 ${acc[accent]||acc.slate}`}>
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
function InfoBox({ label, value }) {
  return (
    <div className="bg-slate-50 rounded-xl border border-slate-100 p-3">
      <p className="text-[10px] text-slate-400 font-semibold uppercase mb-1">{label}</p>
      <p className="font-bold text-slate-800">{value}</p>
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
    <div className={`rounded-xl border p-4 ${warn ? 'bg-red-50 border-red-200' : 'bg-green-50 border-green-200'}`}>
      <p className="text-[10px] text-slate-400 font-bold uppercase mb-1">{label}</p>
      <p className={`font-black text-lg ${warn ? 'text-red-700' : 'text-green-700'}`}>{String(value)}</p>
    </div>
  );
}
function SparkCard({ label, data, color }) {
  return (
    <div className="bg-slate-50 rounded-xl p-3 border border-slate-100">
      <p className="text-[10px] font-semibold text-slate-500 mb-2">{label}</p>
      <ResponsiveContainer width="100%" height={60}>
        <AreaChart data={data}>
          <defs>
            <linearGradient id={`spark-${label}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area type="monotone" dataKey="v" stroke={color} strokeWidth={2} fill={`url(#spark-${label})`} dot={false} />
          <Tooltip contentStyle={{ fontSize: 10 }} />
        </AreaChart>
      </ResponsiveContainer>
      <p className="text-right text-xs font-black mt-1" style={{ color }}>{data[data.length-1]?.v}</p>
    </div>
  );
}
function TabLoader() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="w-8 h-8 border-4 border-cyan-200 border-t-cyan-600 rounded-full animate-spin" />
    </div>
  );
}
function GaugeCard({ title, pct, sub, centerLabel, centerUnit = '%', colorFn }) {
  const safePct = Math.max(0, Math.min(100, pct || 0));
  const fill = colorFn ? colorFn(safePct) : (safePct > 80 ? C.red : safePct > 60 ? C.orange : C.green);
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
  const fmt = fmtVal || (v => `${v}${unit}`);
  const latest = data[data.length - 1]?.v;
  const first  = data[0]?.v;
  const gradId = `tg-${title.replace(/\s+/g, '')}`;
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="flex justify-between items-center mb-2">
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">{title}</p>
        <span className="text-base font-black" style={{ color }}>{latest != null ? fmt(latest) : '—'}</span>
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
        <span>{first != null ? fmt(first) : '—'}</span>
        <span className="text-slate-400">{data.length} samples · 15s interval</span>
      </div>
    </div>
  );
}

/* ── Clickable metric KPI card ── */
function ClickableKpi({ title, value, accent, onClick, hint }) {
  const acc = {
    green:  'bg-green-50 border-green-200 text-green-700',
    red:    'bg-red-50 border-red-200 text-red-700',
    orange: 'bg-orange-50 border-orange-200 text-orange-700',
    blue:   'bg-blue-50 border-blue-200 text-blue-700',
    purple: 'bg-purple-50 border-purple-200 text-purple-700',
    teal:   'bg-teal-50 border-teal-200 text-teal-700',
    slate:  'bg-slate-50 border-slate-200 text-slate-700',
    cyan:   'bg-cyan-50 border-cyan-200 text-cyan-700',
    yellow: 'bg-yellow-50 border-yellow-200 text-yellow-700',
  };
  return (
    <button onClick={onClick}
      className={`rounded-xl border p-4 text-left w-full transition-all hover:shadow-md hover:scale-[1.02] active:scale-[0.98] group cursor-pointer ${acc[accent] || acc.slate}`}>
      <p className="text-[10px] font-bold uppercase tracking-wide opacity-70">{title}</p>
      <div className="flex items-center justify-between mt-1">
        <p className="text-2xl font-black">{value ?? '—'}</p>
        <ChevronRight size={14} className="opacity-0 group-hover:opacity-60 transition-opacity" />
      </div>
      {hint && <p className="text-[9px] opacity-50 mt-0.5">{hint}</p>}
    </button>
  );
}

/* ── Clickable KpiCard (top-strip variant) ── */
function ClickableKpiCard({ icon: Icon, title, value, accent, onClick }) {
  const acc = {
    cyan:   'border-l-cyan-500',
    teal:   'border-l-teal-500',
    green:  'border-l-green-500',
    blue:   'border-l-blue-500',
    orange: 'border-l-orange-500',
    red:    'border-l-red-500',
    purple: 'border-l-purple-500',
    slate:  'border-l-slate-400',
  };
  return (
    <button onClick={onClick}
      className={`bg-white rounded-xl border border-slate-200 border-l-4 ${acc[accent]||acc.slate} p-4 hover:shadow-md transition-all hover:scale-[1.02] cursor-pointer w-full text-left group`}>
      <div className="flex justify-between items-start">
        <div>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{title}</p>
          <p className="text-lg font-black text-slate-800 mt-1">{value ?? 'N/A'}</p>
        </div>
        <div className="flex items-center gap-1">
          <Icon size={20} className="text-slate-300 mt-0.5" />
          <ChevronRight size={12} className="text-slate-200 opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      </div>
    </button>
  );
}

/* ── Slide-over detail modal ── */
function DetailModal({ title, subtitle, onClose, children }) {
  React.useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex" style={{ backdropFilter: 'blur(2px)', background: 'rgba(0,0,0,0.45)' }}
      onClick={onClose}>
      <div className="ml-auto h-full flex flex-col bg-white shadow-2xl overflow-hidden"
        style={{ width: 'min(680px, 96vw)' }}
        onClick={e => e.stopPropagation()}>
        <div className="bg-gradient-to-r from-slate-900 via-cyan-900 to-teal-800 px-6 py-4 text-white flex items-start justify-between flex-shrink-0">
          <div className="min-w-0">
            <h2 className="text-lg font-black truncate">{title}</h2>
            {subtitle && <p className="text-xs text-cyan-300 mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="ml-4 p-1.5 rounded-lg hover:bg-white/10 flex-shrink-0"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 bg-slate-50">{children}</div>
      </div>
    </div>
  );
}

/* ── Process row detail ── */
function ProcessDetail({ p, onNavigate }) {
  return (
    <div className="bg-slate-50 border-t border-slate-200 px-4 py-4 space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          ['Process ID', p.Id,                    'font-mono text-xs'],
          ['User',       p.User,                   'font-semibold'],
          ['Host',       p.Host,                   'font-mono text-xs'],
          ['Database',   p.db || '—',              ''],
          ['Command',    p.Command,                ''],
          ['Time',       `${p.Time}s`,             Number(p.Time) > 5 ? 'text-red-600 font-black' : Number(p.Time) > 1 ? 'text-orange-600 font-bold' : ''],
          ['State',      p.State || '—',           'text-slate-500'],
        ].map(([label, val, cls]) => (
          <div key={label} className="bg-white rounded-xl border border-slate-200 p-3">
            <p className="text-[9px] font-bold text-slate-400 uppercase">{label}</p>
            <p className={`text-xs mt-1 text-slate-700 truncate ${cls}`}>{val}</p>
          </div>
        ))}
      </div>
      {p.Info && p.Info !== 'NULL' && (
        <div>
          <p className="text-[10px] font-bold text-slate-400 uppercase mb-1">Full Query</p>
          <div className="bg-slate-900 rounded-xl px-4 py-3 flex items-start gap-2">
            <pre className="font-mono text-[11px] text-cyan-300 flex-1 overflow-x-auto whitespace-pre-wrap">{p.Info}</pre>
            <button onClick={() => navigator.clipboard.writeText(p.Info)}
              className="flex-shrink-0 p-1 rounded hover:bg-white/10 transition-colors">
              <Copy size={11} className="text-slate-400" />
            </button>
          </div>
        </div>
      )}
      <div className="bg-orange-50 border border-orange-200 rounded-xl px-3 py-2 flex items-center gap-2">
        <code className="font-mono text-[10px] text-orange-700 flex-1">KILL {p.Id};</code>
        <button onClick={() => navigator.clipboard.writeText(`KILL ${p.Id};`)}
          className="text-[9px] font-bold text-orange-600 hover:text-orange-800 px-2 py-0.5 bg-orange-100 rounded">
          Copy KILL
        </button>
      </div>
    </div>
  );
}

/* ── Transaction row detail ── */
function TransactionDetail({ t }) {
  return (
    <div className="bg-slate-50 border-t border-slate-200 px-4 py-4 space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {[
          ['Trx ID',        t.trx_id,              'font-mono text-xs'],
          ['State',         t.state,               t.state === 'RUNNING' ? 'text-green-700 font-bold' : 'text-yellow-700 font-bold'],
          ['Started',       t.started?.slice(0,19),'font-mono text-xs'],
          ['Rows Locked',   t.rows_locked,          t.rows_locked > 0 ? 'text-red-600 font-bold' : ''],
          ['Rows Modified', t.rows_modified,        ''],
          ['Wait Time',     t.wait_time || '—',    ''],
        ].map(([label, val, cls]) => (
          <div key={label} className="bg-white rounded-xl border border-slate-200 p-3">
            <p className="text-[9px] font-bold text-slate-400 uppercase">{label}</p>
            <p className={`text-xs mt-1 text-slate-700 truncate ${cls}`}>{val ?? '—'}</p>
          </div>
        ))}
      </div>
      {t.query && (
        <div>
          <p className="text-[10px] font-bold text-slate-400 uppercase mb-1">Active Query</p>
          <div className="bg-slate-900 rounded-xl px-4 py-3 flex items-start gap-2">
            <pre className="font-mono text-[11px] text-cyan-300 flex-1 overflow-x-auto whitespace-pre-wrap">{t.query}</pre>
            <button onClick={() => navigator.clipboard.writeText(t.query)}
              className="flex-shrink-0 p-1 rounded hover:bg-white/10">
              <Copy size={11} className="text-slate-400" />
            </button>
          </div>
        </div>
      )}
      {t.rows_locked > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-xs text-red-700 font-semibold">
          ⚠ This transaction is holding {t.rows_locked} row lock{t.rows_locked > 1 ? 's' : ''}. Long-running locks can block other writes.
        </div>
      )}
    </div>
  );
}
