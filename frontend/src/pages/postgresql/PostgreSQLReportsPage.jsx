import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  RefreshCw, Activity, Clock, Calendar,
  Server, Database, Users, Zap, HardDrive, RotateCcw,
  Shield, Lock, BarChart2, Cpu, Heart,
  CheckCircle2, AlertTriangle, XCircle, TrendingUp, FileText,
  Send, Bell, Archive, Layers, Radio, 
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, PieChart, Pie, Cell, Legend, LineChart, Line,
  RadarChart, Radar, PolarGrid, PolarAngleAxis,
} from 'recharts';
import client from '@/api/client';
import { PERIODS, ReportShell, shortVersion } from '@/pages/_shared/reportKit';
import { PageLoading } from '@/components/ui/Loading';

/* Identity for the shared report shell. The MySQL report supplies the same shape;
   this page used to duplicate the whole shell — header, e-mail modal, PDF capture
   and print plumbing — instead of using it. */
const ENGINE = {
  key: 'pg',
  label: 'PostgreSQL',
  emoji: '🐘',
  reportPrefix: 'pg-report',
};

/* ─── palette ─── */
const C = {
  red:    '#ef4444', orange: '#F97316', amber:  '#F59E0B',
  green:  '#22C55E', blue:   '#3B82F6', purple: '#8B5CF6',
  teal:   '#14B8A6', slate:  '#64748B', cyan:   '#06B6D4',
  indigo: '#6366F1', pg:     '#336791',
};
const POOL_COLORS = [C.pg, C.blue, C.teal, C.purple, C.orange, C.green, C.cyan, C.amber];


const api = (path, id) => client.get(`/connections/postgresql/${id}/${path}`).then(r => r.data);

function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v/1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v/1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v/1e3).toFixed(1)}K`;
  return String(v);
}
function fmtBytes(b) {
  const v = Number(b) || 0;
  if (v > 1073741824) return `${(v/1073741824).toFixed(2)} GB`;
  if (v > 1048576)    return `${(v/1048576).toFixed(2)} MB`;
  if (v > 1024)       return `${(v/1024).toFixed(2)} KB`;
  return `${v} B`;
}
function now() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'medium' });
}
function statusBadge(val) {
  const v = (val || '').toUpperCase();
  const good = ['ACTIVE','YES','OK','STREAMING','SYNC','ASYNC','CONNECTED','ONLINE','COMPLETED','TRUE','1'];
  const bad  = ['INACTIVE','NO','ERROR','FAILED','OFFLINE','FALSE','0','DISCONNECTED'];
  const warn = ['WARNING','SLOW','DEGRADED','CATCHUP'];
  const color = good.includes(v) ? 'bg-green-100 text-green-700 border-green-200'
    : bad.includes(v)  ? 'bg-red-100 text-red-700 border-red-200'
    : warn.includes(v) ? 'bg-amber-100 text-amber-700 border-amber-200'
    : 'bg-slate-100 text-slate-600 border-slate-200';
  return <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${color}`}>{val || '—'}</span>;
}

function RSection({ title, icon: Icon, color = C.pg, children, className = '', pageBreak = false }) {
  return (
    <div className={`report-card report-section bg-white rounded-xl border border-slate-200 overflow-hidden mb-4 ${pageBreak ? 'page-break' : ''} ${className}`}>
      <div className="flex items-center gap-3 px-5 py-3 border-b border-slate-100"
        style={{ borderLeft: `4px solid ${color}` }}>
        {Icon && <Icon size={15} style={{ color }} />}
        <h2 className="font-black text-slate-800 text-sm tracking-tight uppercase">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function KStat({ label, value, color = '#1e293b', sub }) {
  return (
    <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{label}</p>
      <p className="text-lg font-black mt-0.5" style={{ color }}>{value ?? '—'}</p>
      {sub && <p className="text-[9px] text-slate-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function RTable({ headers, rows, emptyMsg = 'No data' }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="bg-slate-50 border-y border-slate-200">
            {headers.map(h => (
              <th key={h} className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={headers.length} className="text-center py-6 text-slate-400">{emptyMsg}</td></tr>
          ) : rows.map((row, i) => (
            <tr key={i} className={`border-b border-slate-100 ${i % 2 === 1 ? 'bg-slate-50/40' : ''}`}>
              {row.map((cell, j) => <td key={j} className="px-3 py-2 text-slate-700">{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UsageBar({ label, pct, sub, color }) {
  const c = pct > 85 ? C.red : pct > 70 ? C.orange : (color || C.teal);
  return (
    <div className="mb-3">
      <div className="flex justify-between items-center mb-1">
        <span className="text-xs font-bold text-slate-700 truncate max-w-[200px]">{label}</span>
        <span className="text-xs font-black ml-2" style={{ color: c }}>{pct}%</span>
      </div>
      <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
        <div className="h-2 rounded-full transition-all" style={{ width: `${Math.min(100,pct)}%`, background: c }} />
      </div>
      {sub && <p className="text-[10px] text-slate-400 mt-0.5">{sub}</p>}
    </div>
  );
}

/* ─── Email / Schedule Modal ─── */

/* ─── main component ─── */
export default function PostgreSQLReportsPage() {
  const { id } = useParams();
  const [period, setPeriod]                 = useState('live');
  const [genTime, setGenTime]               = useState(now);

  const ri = period === 'live' ? 30000 : false;

  // ── 12 existing calls (no duplicates) ──
  const { data: dash,   isLoading: l1, refetch: r1 } = useQuery({ queryKey: ['rpt-pg-dash',   id], queryFn: () => api('monitoring-dashboard',   id), refetchInterval: ri });
  const { data: slowD }   = useQuery({ queryKey: ['rpt-pg-slow',   id], queryFn: () => api('pg-slow-queries',    id), refetchInterval: period === 'live' ? 15000 : false });
  const { data: idxD }    = useQuery({ queryKey: ['rpt-pg-idx',    id], queryFn: () => api('pg-index-analysis',  id), refetchInterval: ri });
  const { data: replD }   = useQuery({ queryKey: ['rpt-pg-repl',   id], queryFn: () => api('replication-detail', id), refetchInterval: ri });
  const { data: tablesD } = useQuery({ queryKey: ['rpt-pg-tables', id], queryFn: () => api('tables-detail',      id), refetchInterval: ri });
  const { data: storageD }= useQuery({ queryKey: ['rpt-pg-stor',   id], queryFn: () => api('storage-detail',     id), refetchInterval: ri });
  const { data: usersD }  = useQuery({ queryKey: ['rpt-pg-users',  id], queryFn: () => api('users-detail',       id), refetchInterval: ri });
  const { data: walD }    = useQuery({ queryKey: ['rpt-pg-wal',    id], queryFn: () => api('pg-wal-stats',        id), refetchInterval: ri });
  const { data: ckptD }   = useQuery({ queryKey: ['rpt-pg-ckpt',   id], queryFn: () => api('pg-checkpoint-stats',id), refetchInterval: ri });
  const { data: sessD }   = useQuery({ queryKey: ['rpt-pg-sess',   id], queryFn: () => api('pg-session-details', id), refetchInterval: ri });
  const { data: backupD } = useQuery({ queryKey: ['rpt-pg-bkp',    id], queryFn: () => api('backup-summary',     id), refetchInterval: ri });
  const { data: queriesD }= useQuery({ queryKey: ['rpt-pg-qry',    id], queryFn: () => api('queries-detail',     id), refetchInterval: ri });

  // ── 5 new unique calls (data not available in any above endpoint) ──
  const { data: slruD }   = useQuery({ queryKey: ['rpt-pg-slru',   id], queryFn: () => api('pg-slru-stats',       id), refetchInterval: ri, staleTime: 60000 });
  const { data: sslD }    = useQuery({ queryKey: ['rpt-pg-ssl',    id], queryFn: () => api('pg-ssl-stats',         id), refetchInterval: ri, staleTime: 60000 });
  const { data: dbHlthD } = useQuery({ queryKey: ['rpt-pg-dbh',    id], queryFn: () => api('pg-database-health',  id), refetchInterval: ri });
  const { data: storObjD }= useQuery({ queryKey: ['rpt-pg-sobj',   id], queryFn: () => api('pg-storage-objects',  id), refetchInterval: ri, staleTime: 60000 });
  const { data: cfgD }    = useQuery({ queryKey: ['rpt-pg-cfg',    id], queryFn: () => api('config-detail',        id), refetchInterval: false, staleTime: 300000 });

  const refetchAll = () => { r1(); setGenTime(now()); };


  /* ── derived values — field names match actual API response shapes ── */
  const hs           = dash?.health_summary || {};
  const conn         = dash?.connection || {};
  // from monitoring-dashboard nested fields (no extra API call needed)
  const dashDbs      = dash?.databases || [];
  const dashConns    = dash?.connections_detail || {};
  const dashMem      = dash?.memory || {};
  const dashBgw      = dash?.bgwriter || {};
  const dashCkpt     = dash?.checkpoints || {};
  const dashBlocking = dash?.blocking_queries || [];
  const dashLocks    = dash?.pg_locks || [];
  const dashLongRun  = dash?.long_running_queries || [];
  const dashStatStmt = dash?.pg_stat_statements || [];
  const dashUsersAct = dash?.users_activity || [];

  // slow queries: field is `queries` per service
  const slowQ        = slowD?.queries || [];

  // index analysis: correct field names
  const unusedIdx    = idxD?.unused_indexes || [];
  const allIdx       = idxD?.all_indexes || [];
  const bloatedTbls  = idxD?.bloated_tables || [];
  const idxSummary   = idxD?.summary || {};

  // replication-detail: field is `replicas` not `standbys`
  const standbys     = replD?.replicas || [];
  const replSlots    = replD?.slots || [];
  const replTopology = replD?.topology || {};
  const replPubs     = replD?.publications || [];
  const replSubs     = replD?.subscriptions || [];
  const replConflicts= replD?.conflicts || [];
  const replConfig   = replD?.rep_config || {};
  const replWal      = replD?.wal_stats || {};
  const replCkpt     = replD?.checkpoint_stats || {};

  // tables-detail: correct structure
  const tables       = tablesD?.tables || [];
  const vacuumNeeded = tablesD?.vacuum_needed || 0;
  const analyzeNeeded= tablesD?.analyze_needed || 0;
  const autovacCfg   = tablesD?.autovac_config || {};

  // storage-detail: correct field names
  const dbSizes      = storageD?.db_sizes || [];
  const tablespaces  = storageD?.tablespaces || [];
  const topTables    = storageD?.top_tables || [];
  const bloatTables  = storageD?.bloat_tables || [];
  const vacNeedTbls  = storageD?.vacuum_needed || [];
  const toastTables  = storageD?.toast_tables || [];
  const storageSumm  = storageD?.summary || {};

  // users-detail: correct field names
  const roles        = usersD?.roles || [];
  const memberships  = usersD?.memberships || [];
  const userActivity = usersD?.activity || [];
  const objOwnership = usersD?.obj_ownership || [];
  const userSummary  = usersD?.summary || {};

  // pg-wal-stats: field is `wal` not `stats`
  const walStats     = walD?.wal || {};

  // pg-checkpoint-stats: correct field names
  const ckptStats    = ckptD?.checkpoints || {};
  const bgwStats     = ckptD?.bgwriter || {};
  const ckptCfg      = ckptD?.config || {};

  // pg-session-details: correct field names
  const sessions     = sessD?.sessions || [];
  const sessSummary  = sessD?.summary || {};
  const blockers     = sessD?.blockers || [];

  const backupSum    = backupD || {};

  // queries-detail: correct field names
  const topByMean    = queriesD?.top_by_mean_time || [];
  const topByTotal   = queriesD?.top_by_total_time || [];
  const topByCalls   = queriesD?.top_by_calls || [];
  const topByIO      = queriesD?.top_by_io || [];
  const waitEvents   = queriesD?.wait_events || {};
  const activeQueries= queriesD?.active_queries || [];
  const longRunning  = queriesD?.long_running || [];
  const allBackends  = queriesD?.all_backends || [];

  // 5 new unique endpoints
  const slruPools    = slruD?.slru || [];
  const sslConns     = sslD?.connections || [];
  const sslCount     = sslD?.ssl_count || 0;
  const nonSslCount  = sslD?.non_ssl_count || 0;
  const sslCiphers   = sslD?.ciphers || {};
  const dbHealthList = dbHlthD?.databases || [];
  const vacNeedHlth  = dbHlthD?.vacuum_needed || [];
  const idxHealth    = dbHlthD?.index_health || {};
  const sequences    = dbHlthD?.sequences || [];
  const topIndexes   = storObjD?.top_indexes || [];
  const extensions   = storObjD?.extensions || [];
  const cfgGroups    = cfgD?.groups || {};
  const cfgModified  = cfgD?.modified_count || 0;
  const cfgPendingRst= cfgD?.pending_restart_count || 0;

  // ── computed scalars ──
  const activeCon  = Number(hs.active_connections || dashConns.total) || 0;
  const maxCon     = Number(hs.max_connections || dashConns.max) || 0;
  const conPct     = maxCon > 0 ? Math.min(100, Math.round(activeCon / maxCon * 100)) : 0;
  const cacheHit   = Number(hs.cache_hit_pct || hs.cache_hit_ratio) || 0;
  const dbSize     = hs.total_size || '—';
  const uptime     = hs.uptime_str || hs.uptime || '—';
  const pgVersion  = hs.version || '—';
  const replLag    = Number(standbys[0]?.byte_lag || standbys[0]?.write_lag_ms || 0);
  const hasRepl    = standbys.length > 0;
  const deadlocks  = Number(hs.deadlocks || dashDbs.reduce((s, d) => s + (d.deadlocks || 0), 0)) || 0;
  const tempFiles  = Number(hs.temp_files || dashDbs.reduce((s, d) => s + (d.temp_files || 0), 0)) || 0;

  function computeScore() {
    let s = 100;
    if (conPct > 90) s -= 30; else if (conPct > 70) s -= 15;
    if (cacheHit < 70) s -= 25; else if (cacheHit < 85) s -= 10;
    if (deadlocks > 0) s -= 10;
    if (dashBlocking.length > 0) s -= 15;
    if (Number(replTopology.max_byte_lag) > 1048576) s -= 20;
    if (cfgPendingRst > 0) s -= 5;
    return Math.max(0, Math.min(100, s));
  }
  const healthScore = computeScore();

  // pg_stat_activity reports NULL state for background/internal workers
  // (checkpointer, walwriter, autovacuum launcher, bg writer, walsender) —
  // relabel that bucket from "unknown" to something meaningful.
  const stateLabel = (s) => (!s || s === 'unknown') ? 'background/internal' : s;
  const sessByState = (dashConns.by_state
    ? Object.entries(dashConns.by_state).map(([name, value]) => ({ name: stateLabel(name), value }))
    : sessions.reduce((acc, s) => {
        const k = stateLabel(s.state);
        const ex = acc.find(x => x.name === k);
        if (ex) ex.value++; else acc.push({ name: k, value: 1 });
        return acc;
      }, [])
  );

  const periodObj = PERIODS.find(p => p.id === period) || PERIODS[0];
  const connName  = conn.name || hs.database || `PostgreSQL #${id}`;
  const subtitle  = [conn.host, shortVersion(pgVersion) ? `v${shortVersion(pgVersion)}` : null]
    .filter(Boolean).join(' · ');

  /* The header's warning chips. These were inline markup in this page's own hero;
     as data they are the shared shell's `alertBadges` contract, so every engine's
     report renders them identically. */
  const alertBadges = [
    conPct > 80 && { tone: 'red', label: `Connections ${conPct}%` },
    cacheHit < 85 && { tone: 'amber', label: `Cache Hit: ${cacheHit.toFixed(1)}%` },
    Number(hs.deadlocks) > 0 && { tone: 'red', label: `Deadlocks: ${hs.deadlocks}` },
    (dash?.blocking_queries || []).length > 0 && {
      tone: 'red',
      label: `${dash.blocking_queries.length} Blocking Quer${dash.blocking_queries.length > 1 ? 'ies' : 'y'}`,
    },
    hasRepl && Number(replLag) > 1048576 && { tone: 'amber', label: `Replication Lag: ${fmtBytes(replLag)}` },
  ].filter(Boolean);

  if (l1 && !dash) return <PageLoading title="Loading PostgreSQL report…" illustration />;

  return (
    <ReportShell
      engine={{ ...ENGINE, backTo: `/postgresql-dashboard/${id}` }}
      id={id} period={period} setPeriod={setPeriod}
      genTime={genTime} setGenTime={setGenTime} onRefresh={refetchAll}
      connName={connName} subtitle={subtitle} alertBadges={alertBadges}
    >

        {/* Print-only header */}
        <div className="hidden print:block mb-6 pb-4 border-b-2 border-slate-800">
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-2xl font-black text-slate-900">PostgreSQL Database Monitoring Report</h1>
              <p className="text-sm text-slate-600 mt-1">{connName} — {conn.host || ''} {pgVersion !== '—' ? `· v${pgVersion}` : ''}</p>
            </div>
            <div className="text-right">
              <p className="text-sm font-bold text-slate-700">{periodObj.label} Report</p>
              <p className="text-xs text-slate-500 mt-0.5">Generated: {genTime}</p>
              <p className="text-xs text-slate-500">Powered by Actmon</p>
            </div>
          </div>
        </div>

        {/* ══ 1. EXECUTIVE SUMMARY ══ */}
        <RSection title="Executive Summary" icon={Heart}
          color={healthScore >= 80 ? C.green : healthScore >= 60 ? C.amber : C.red}>
          <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3 mb-5">
            <KStat label="Health Score"   value={`${healthScore}/100`} color={healthScore >= 80 ? C.green : healthScore >= 60 ? C.amber : C.red} />
            <KStat label="Status"         value={hs.replication_state === 'standby' ? 'STANDBY' : 'PRIMARY'} color={C.green} />
            <KStat label="Uptime"         value={uptime} />
            <KStat label="Connections"    value={`${activeCon}/${maxCon}`} color={conPct > 80 ? C.red : C.green} sub={`${conPct}% used`} />
            <KStat label="Cache Hit %"    value={`${cacheHit.toFixed(1)}%`} color={cacheHit < 85 ? C.red : C.green} />
            <KStat label="Total DB Size"  value={dbSize} color={C.blue} />
            <KStat label="Deadlocks"      value={deadlocks} color={deadlocks > 0 ? C.red : C.green} />
            <KStat label="Temp Files"     value={tempFiles} color={tempFiles > 0 ? C.orange : C.green} />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3 mb-5">
            <KStat label="Standbys"       value={standbys.length} color={standbys.length > 0 ? C.green : C.slate} />
            <KStat label="Repl Slots"     value={replSlots.length} color={C.blue} />
            <KStat label="Slow Queries"   value={slowQ.length} color={slowQ.length > 10 ? C.orange : C.green} />
            <KStat label="Blocking Qrys"  value={dashBlocking.length} color={dashBlocking.length > 0 ? C.red : C.green} />
            <KStat label="Long Running"   value={longRunning.length} color={longRunning.length > 0 ? C.orange : C.green} />
            <KStat label="Vacuum Needed"  value={vacuumNeeded} color={vacuumNeeded > 0 ? C.amber : C.green} />
            <KStat label="Unused Indexes" value={unusedIdx.length} color={unusedIdx.length > 5 ? C.orange : C.green} />
            <KStat label="Config Issues"  value={cfgPendingRst > 0 ? `${cfgPendingRst} Restart` : 'OK'} color={cfgPendingRst > 0 ? C.red : C.green} />
          </div>
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Health Checks</p>
          <div className="flex flex-wrap gap-2">
            {[
              { ok: true,                           label: `DB Status: PRIMARY` },
              { ok: conPct < 80,                    label: `Connections ${conPct}%` },
              { ok: cacheHit >= 85,                 label: `Cache Hit ${cacheHit.toFixed(1)}%` },
              { ok: deadlocks === 0,                label: `Deadlocks: ${deadlocks}` },
              { ok: dashBlocking.length === 0,      label: `Blocking Queries: ${dashBlocking.length}` },
              { ok: longRunning.length === 0,       label: `Long Running: ${longRunning.length}` },
              { ok: hasRepl,                        label: `Replication: ${hasRepl ? `${standbys.length} standby(s)` : 'Standalone'}` },
              { ok: Number(replTopology.max_byte_lag || 0) < 1048576, label: `Repl Lag: ${fmtBytes(replTopology.max_byte_lag || 0)}` },
              { ok: slowQ.length <= 10,             label: `Slow Queries: ${slowQ.length}` },
              { ok: vacuumNeeded === 0,             label: `Vacuum Needed: ${vacuumNeeded}` },
              { ok: unusedIdx.length <= 5,          label: `Unused Indexes: ${unusedIdx.length}` },
              { ok: cfgPendingRst === 0,            label: `Config Restart Pending: ${cfgPendingRst}` },
            ].map(({ ok, label }) => (
              <span key={label} className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border ${
                ok ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                   : 'bg-red-50 border-red-200 text-red-700'
              }`}>
                {ok ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />}
                {label}
              </span>
            ))}
          </div>
        </RSection>

        {/* ══ 2. DATABASE STATUS + PERFORMANCE ══ */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4" style={{pageBreakBefore:'always'}}>
          <RSection title="Database Status" icon={Database} color={C.pg} className="!mb-0">
            <div className="grid grid-cols-2 gap-x-6">
              {[
                ['Connection Name',  connName],
                ['Host',             conn.host || hs.host || '—'],
                ['Port',             conn.port || hs.port || '5432'],
                ['Database',         conn.database_name || hs.database || '—'],
                ['PG Version',       pgVersion],
                ['Uptime',           uptime],
                ['Active Connections', activeCon],
                ['Max Connections',  maxCon],
                ['Cache Hit %',      `${cacheHit.toFixed(1)}%`],
                ['Total DB Size',    dbSize],
                ['Commit Ratio',     hs.commit_ratio ? `${hs.commit_ratio}%` : '—'],
                ['Deadlocks',        hs.deadlocks ?? '—'],
                ['Temp Files',       hs.temp_files ?? '—'],
                ['Replication Role', hs.replication_role || '—'],
                ['WAL Level',        hs.wal_level || '—'],
                ['Encoding',         hs.encoding || '—'],
                ['Locale',           hs.datcollate || '—'],
                ['Data Directory',   hs.data_directory || '—'],
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
              <KStat label="Cache Hit %"    value={`${cacheHit.toFixed(1)}%`}                color={cacheHit < 85 ? C.red : C.green} />
              <KStat label="Commit Ratio"   value={hs.commit_ratio ? `${hs.commit_ratio}%` : '—'} color={C.blue} />
              <KStat label="Transactions/s" value={fmtNum(hs.tps || hs.xact_per_sec)}        color={C.purple} />
              <KStat label="Deadlocks"      value={hs.deadlocks ?? '—'}                       color={(hs.deadlocks||0) > 0 ? C.red : C.green} />
              <KStat label="Temp Files"     value={hs.temp_files ?? '—'}                      color={(hs.temp_files||0) > 0 ? C.orange : C.green} />
              <KStat label="Bloat %"        value={hs.bloat_pct ? `${hs.bloat_pct}%` : '—'}  color={C.slate} />
            </div>
            {Object.keys(dashMem).length > 0 && (
              <>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">MEMORY CONFIGURATION</p>
                <div className="grid grid-cols-2 gap-2 mb-3">
                  {[
                    ['Shared Buffers',  dashMem.shared_buffers],
                    ['Effective Cache', dashMem.effective_cache_size],
                    ['Work Mem',        dashMem.work_mem],
                    ['Maint. Mem',      dashMem.maintenance_work_mem],
                  ].map(([l, v]) => v ? (
                    <div key={l} className="bg-slate-50 rounded-lg p-2 border border-slate-100">
                      <p className="text-[9px] text-slate-400 font-semibold uppercase">{l}</p>
                      <p className="text-[13px] font-black text-slate-800 font-mono">{v}</p>
                    </div>
                  ) : null)}
                </div>
              </>
            )}
            {topByMean.length > 0 && (
              <>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">TOP QUERIES — MEAN TIME</p>
                <ResponsiveContainer width="100%" height={110}>
                  <BarChart data={topByMean.slice(0,6).map((q,i) => ({
                    name: `Q${i+1}`,
                    ms: Math.round(Number(q.mean_exec_time||0)),
                  }))} margin={{ top:2, right:10, left:0, bottom:2 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize:9 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize:9 }} tickFormatter={v => `${v}ms`} axisLine={false} tickLine={false} />
                    <Tooltip formatter={v => [`${v}ms`, 'Avg']} />
                    <Bar dataKey="ms" radius={[4,4,0,0]}>
                      {topByMean.slice(0,6).map((_,i) => <Cell key={i} fill={POOL_COLORS[i%POOL_COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </>
            )}
          </RSection>
        </div>

        {/* ══ 3. CONNECTION ANALYSIS ══ */}
        <RSection title="Connection Analysis" icon={Activity} color={C.blue} pageBreak>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <KStat label="Active"     value={activeCon} color={conPct>80?C.red:C.green} sub={`${conPct}% of max`} />
            <KStat label="Max"        value={maxCon}    color={C.blue} />
            <KStat label="Idle"       value={dashConns.idle ?? sessByState.find(s=>s.name==='idle')?.value ?? '—'}                    color={C.slate} />
            <KStat label="Idle in Tx" value={dashConns.idle_in_transaction ?? sessByState.find(s=>s.name==='idle in transaction')?.value ?? '—'} color={(dashConns.idle_in_transaction||0)>0?C.orange:C.slate} />
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            {sessByState.length > 0 && (
              <div>
                <p className="text-xs font-bold text-slate-500 mb-2">CONNECTIONS BY STATE</p>
                <div className="flex items-center gap-4">
                  <div className="flex-shrink-0" style={{ width: 150, height: 150 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={sessByState} dataKey="value" nameKey="name"
                          cx="50%" cy="50%" innerRadius={42} outerRadius={68} paddingAngle={2} stroke="none">
                          {sessByState.map((_,i) => <Cell key={i} fill={POOL_COLORS[i%POOL_COLORS.length]} />)}
                        </Pie>
                        <Tooltip formatter={(v, n) => [`${v} connections`, n]} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="flex-1 min-w-0 space-y-2">
                    {(() => {
                      const tot = sessByState.reduce((s, x) => s + Number(x.value || 0), 0) || 1;
                      return sessByState.map((s, i) => (
                        <div key={s.name} className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-2 min-w-0">
                            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: POOL_COLORS[i % POOL_COLORS.length] }} />
                            <span className="text-[11px] font-semibold text-slate-600 truncate capitalize">{s.name}</span>
                          </span>
                          <span className="text-[11px] font-black text-slate-800 flex-shrink-0">
                            {s.value} <span className="text-slate-400 font-bold">({Math.round(Number(s.value || 0) / tot * 100)}%)</span>
                          </span>
                        </div>
                      ));
                    })()}
                  </div>
                </div>
              </div>
            )}
            <div>
              {dashDbs.length > 0 && (
                <>
                  <p className="text-xs font-bold text-slate-500 mb-2">CONNECTIONS BY DATABASE</p>
                  {dashDbs.slice(0,8).map((db,i) => (
                    <UsageBar key={i}
                      label={db.datname || db.database || `db${i}`}
                      pct={maxCon>0 ? Math.round((db.numbackends||0)/maxCon*100) : 0}
                      sub={`${db.numbackends||0} connections`}
                      color={POOL_COLORS[i%POOL_COLORS.length]} />
                  ))}
                </>
              )}
            </div>
          </div>
          {dashUsersAct.length > 0 && (
            <>
              <p className="text-xs font-bold text-slate-500 mt-4 mb-2">USER ACTIVITY</p>
              <RTable
                headers={['User','DB','State','Wait Event','Query Preview']}
                rows={dashUsersAct.slice(0,10).map(u => [
                  <span className="font-bold text-blue-700">{u.usename||u.username||'—'}</span>,
                  <span className="text-[10px] text-slate-500">{u.datname||u.database||'—'}</span>,
                  statusBadge(u.state),
                  <span className="text-orange-600 text-[10px]">{u.wait_event||'—'}</span>,
                  <span className="font-mono text-[10px] text-slate-400 max-w-[200px] truncate block">{(u.query||'').slice(0,80)}</span>,
                ])}
              />
            </>
          )}
          {sessions.length > 0 && (
            <>
              <p className="text-xs font-bold text-slate-500 mt-4 mb-2">SESSION DETAILS</p>
              <RTable
                headers={['PID','User','DB','State','Wait Event','App','Query Preview']}
                rows={sessions.slice(0,12).map(s => [
                  <span className="font-mono text-slate-500">{s.pid}</span>,
                  <span className="font-bold text-blue-700">{s.usename||s.username||'—'}</span>,
                  <span className="text-[10px] text-slate-500">{s.datname||s.database||'—'}</span>,
                  statusBadge(s.state),
                  <span className="text-orange-600 text-[10px]">{s.wait_event||'—'}</span>,
                  <span className="text-[10px] text-slate-500">{s.application_name||'—'}</span>,
                  <span className="font-mono text-[10px] text-slate-400 max-w-[150px] truncate block">{(s.query||'').slice(0,60)}</span>,
                ])}
                emptyMsg="No active sessions"
              />
            </>
          )}
          {blockers.length > 0 && (
            <>
              <p className="text-[10px] font-bold text-red-500 uppercase tracking-widest mt-4 mb-2">⚠ BLOCKING SESSIONS</p>
              <RTable
                headers={['Blocker PID','Blocker User','Blocked PID','Blocked User','Lock Type','Relation']}
                rows={blockers.slice(0,8).map(b => [
                  <span className="font-bold text-red-700">{b.blocker_pid||b.pid}</span>,
                  <span className="font-bold">{b.blocker_user||b.usename||'—'}</span>,
                  <span className="text-orange-600 font-bold">{b.blocked_pid||'—'}</span>,
                  b.blocked_user||'—',
                  <span className="font-mono text-[10px]">{b.locktype||'—'}</span>,
                  <span className="font-mono text-[10px]">{b.relation||'—'}</span>,
                ])}
              />
            </>
          )}
        </RSection>

        {/* ══ 4. QUERY PERFORMANCE ══ */}
        <RSection title="Query Performance" icon={Zap} color={C.purple} pageBreak>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <KStat label="Statements"   value={fmtNum(topByMean.length)} color={C.purple} />
            <KStat label="Worst Mean"   value={topByMean.length ? `${Number(topByMean[0]?.mean_exec_time||0).toFixed(0)}ms` : '—'} color={C.red} />
            <KStat label="Long Running" value={longRunning.length} color={longRunning.length>0?C.orange:C.green} />
            <KStat label="Active Now"   value={activeQueries.length} color={C.teal} />
          </div>
          {topByMean.length > 0 && (
            <>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">TOP 8 BY MEAN EXECUTION TIME</p>
              <ResponsiveContainer width="100%" height={150}>
                <BarChart data={topByMean.slice(0,8).map((q,i) => ({
                  name: `Q${i+1}`,
                  ms: Math.round(Number(q.mean_exec_time||0)),
                }))} margin={{ top:5, right:10, left:0, bottom:5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize:9 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize:9 }} tickFormatter={v => `${v}ms`} axisLine={false} tickLine={false} />
                  <Tooltip formatter={v => [`${v}ms`, 'Mean Time']} />
                  <Bar dataKey="ms" name="Mean Time (ms)" radius={[4,4,0,0]}>
                    {topByMean.slice(0,8).map((_,i) => <Cell key={i} fill={POOL_COLORS[i%POOL_COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <RTable
                headers={['#','Query Preview','Calls','Mean (ms)','Total (ms)','Rows','Hit %']}
                rows={topByMean.slice(0,10).map((q,i) => [
                  <span className="font-mono text-slate-400 text-[10px]">{i+1}</span>,
                  <span className="font-mono text-[10px] text-slate-500 max-w-[220px] truncate block">{(q.query||'').slice(0,100)}</span>,
                  fmtNum(q.calls),
                  <span className={`font-bold ${Number(q.mean_exec_time||0)>1000?'text-red-600':Number(q.mean_exec_time||0)>100?'text-orange-600':'text-green-700'}`}>
                    {Number(q.mean_exec_time||0).toFixed(2)}
                  </span>,
                  fmtNum(Math.round(Number(q.total_exec_time||0))),
                  fmtNum(q.rows),
                  q.hit_percent ? `${Number(q.hit_percent).toFixed(1)}%` : '—',
                ])}
              />
            </>
          )}
          {topByCalls.length > 0 && (
            <>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-4 mb-2">TOP BY CALL COUNT</p>
              <RTable
                headers={['Query Preview','Calls','Mean (ms)','Total (ms)']}
                rows={topByCalls.slice(0,8).map(q => [
                  <span className="font-mono text-[10px] text-slate-500 max-w-[300px] truncate block">{(q.query||'').slice(0,100)}</span>,
                  <span className="font-bold text-purple-700">{fmtNum(q.calls)}</span>,
                  Number(q.mean_exec_time||0).toFixed(2),
                  fmtNum(Math.round(Number(q.total_exec_time||0))),
                ])}
              />
            </>
          )}
          {topByIO.length > 0 && (
            <>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-4 mb-2">TOP BY I/O BLOCKS</p>
              <RTable
                headers={['Query Preview','Blks Hit','Blks Read','Local Blks','Temp Blks']}
                rows={topByIO.slice(0,8).map(q => [
                  <span className="font-mono text-[10px] text-slate-500 max-w-[240px] truncate block">{(q.query||'').slice(0,100)}</span>,
                  <span className="font-bold text-blue-700">{fmtNum(q.shared_blks_hit)}</span>,
                  <span className={`font-bold ${Number(q.shared_blks_read||0)>10000?'text-orange-600':'text-slate-700'}`}>{fmtNum(q.shared_blks_read)}</span>,
                  fmtNum(q.local_blks_hit),
                  fmtNum(q.temp_blks_read),
                ])}
              />
            </>
          )}
          {longRunning.length > 0 && (
            <>
              <p className="text-[10px] font-bold text-red-500 uppercase tracking-widest mt-4 mb-2">⚠ LONG RUNNING QUERIES</p>
              <RTable
                headers={['PID','User','DB','Duration','State','Query Preview']}
                rows={longRunning.slice(0,8).map(q => [
                  <span className="font-mono text-slate-500">{q.pid}</span>,
                  <span className="font-bold text-blue-700">{q.usename||'—'}</span>,
                  <span className="text-[10px] text-slate-500">{q.datname||'—'}</span>,
                  <span className="font-bold text-red-600">{q.duration||q.query_duration||'—'}</span>,
                  statusBadge(q.state),
                  <span className="font-mono text-[10px] text-slate-400 max-w-[200px] truncate block">{(q.query||'').slice(0,80)}</span>,
                ])}
              />
            </>
          )}
          {dashBlocking.length > 0 && (
            <>
              <p className="text-[10px] font-bold text-red-500 uppercase tracking-widest mt-4 mb-2">⚠ BLOCKING QUERIES</p>
              <RTable
                headers={['PID','User','DB','Lock Type','Relation','Query Preview']}
                rows={dashBlocking.slice(0,8).map(q => [
                  <span className="font-bold text-red-700">{q.pid}</span>,
                  <span className="font-bold">{q.usename||'—'}</span>,
                  <span className="text-[10px] text-slate-500">{q.datname||'—'}</span>,
                  <span className="font-mono text-[10px]">{q.locktype||'—'}</span>,
                  <span className="font-mono text-[10px]">{q.relation||'—'}</span>,
                  <span className="font-mono text-[10px] text-slate-400 max-w-[200px] truncate block">{(q.query||'').slice(0,80)}</span>,
                ])}
              />
            </>
          )}
        </RSection>

        {/* ══ 5. SLOW QUERIES ══ */}
        <RSection title={`Slow Queries (${slowQ.length} captured)`} icon={Clock}
          color={slowQ.length>10?C.orange:C.green} pageBreak>
          {slowQ.length === 0 ? (
            <div className="text-center py-4 flex items-center justify-center gap-2 text-green-600">
              <CheckCircle2 size={18} />
              <span className="font-bold text-sm">No slow queries captured</span>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                <KStat label="Total Slow Queries" value={slowQ.length}                                                                 color={slowQ.length>10?C.orange:C.green} />
                <KStat label="Worst Mean Time"     value={`${Number(slowQ[0]?.mean_exec_time||slowQ[0]?.mean_time||0).toFixed(0)}ms`}   color={C.red} />
                <KStat label="Total Calls"         value={fmtNum(slowQ.reduce((s,q)=>s+Number(q.calls||0),0))}                          color={C.blue} />
                <KStat label="Total Rows"          value={fmtNum(slowQ.reduce((s,q)=>s+Number(q.rows||0),0))}                           color={C.purple} />
              </div>
              {slowQ.length > 1 && (
                <>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">CALLS VS TOTAL TIME (TOP 10)</p>
                  <ResponsiveContainer width="100%" height={130}>
                    <BarChart data={slowQ.slice(0,10).map((q,i)=>({
                      name: `SQ${i+1}`,
                      calls: Number(q.calls||0),
                      total: Math.round(Number(q.total_exec_time||q.total_time||0)/1000),
                    }))} margin={{ top:5, right:10, left:0, bottom:5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize:9 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize:9 }} axisLine={false} tickLine={false} />
                      <Tooltip />
                      <Bar dataKey="calls" name="Calls"          fill={C.orange} radius={[3,3,0,0]} />
                      <Bar dataKey="total" name="Total Time (s)" fill={C.red}    radius={[3,3,0,0]} />
                      <Legend wrapperStyle={{ fontSize:10 }} />
                    </BarChart>
                  </ResponsiveContainer>
                </>
              )}
              <RTable
                headers={['#','Calls','Mean (ms)','Max (ms)','Total (ms)','Rows','Query Preview']}
                rows={slowQ.slice(0,20).map((q,i) => [
                  <span className="font-mono text-slate-400 text-[10px]">{i+1}</span>,
                  fmtNum(q.calls),
                  <span className={`font-bold ${Number(q.mean_exec_time||q.mean_time||0)>5000?'text-red-600':Number(q.mean_exec_time||q.mean_time||0)>1000?'text-orange-600':'text-slate-700'}`}>
                    {Number(q.mean_exec_time||q.mean_time||0).toFixed(2)}
                  </span>,
                  <span className="font-bold text-red-600">{Number(q.max_exec_time||q.max_time||0).toFixed(2)}</span>,
                  <span className={`font-bold ${Number(q.total_exec_time||q.total_time||0)>10000?'text-red-600':'text-slate-700'}`}>
                    {Number(q.total_exec_time||q.total_time||0).toFixed(0)}
                  </span>,
                  fmtNum(q.rows),
                  <span className="font-mono text-[10px] text-slate-500 max-w-[280px] truncate block">
                    {(q.query||'').slice(0,110)}
                  </span>,
                ])}
              />
            </>
          )}
        </RSection>

        {/* ══ 6. WAIT EVENTS ══ */}
        <RSection title="Wait Events" icon={Activity} color={C.cyan} pageBreak>
          {Object.keys(waitEvents).length === 0 ? (
            <div className="text-center py-4 flex items-center justify-center gap-2 text-green-600">
              <CheckCircle2 size={18} />
              <span className="font-bold text-sm">No active wait events</span>
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <div>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">TOP WAIT EVENTS</p>
                <ResponsiveContainer width="100%" height={Math.max(160, Object.keys(waitEvents).length * 26)}>
                  <BarChart layout="vertical"
                    data={Object.entries(waitEvents).map(([name, value]) => ({ name, value: Number(value) || 0 }))
                      .sort((a,b) => b.value - a.value).slice(0,10)}
                    margin={{ top:5, right:15, left:5, bottom:5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize:9 }} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize:9 }} width={110} axisLine={false} tickLine={false} />
                    <Tooltip />
                    <Bar dataKey="value" name="Sessions" radius={[0,4,4,0]}>
                      {Object.keys(waitEvents).slice(0,10).map((_,i) => <Cell key={i} fill={POOL_COLORS[i%POOL_COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <RTable
                headers={['Wait Event','Sessions Waiting']}
                rows={Object.entries(waitEvents).sort((a,b) => Number(b[1]) - Number(a[1])).slice(0,15).map(([k, v]) => [
                  <span className="font-semibold text-cyan-700 text-[11px]">{k}</span>,
                  <span className="font-black text-slate-800">{fmtNum(v)}</span>,
                ])}
              />
            </div>
          )}
        </RSection>

        {/* ══ 7. REPLICATION & HIGH AVAILABILITY ══ */}
        <RSection title={`Replication & HA (${standbys.length} standby${standbys.length !== 1 ? 's' : ''})`}
          icon={Radio} color={hasRepl ? C.green : C.slate} pageBreak>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <KStat label="Role"          value={hs.replication_role || (hs.replication_state === 'standby' ? 'STANDBY' : 'PRIMARY')} color={C.blue} />
            <KStat label="Standbys"      value={standbys.length}        color={standbys.length > 0 ? C.green : C.slate} />
            <KStat label="Repl Slots"    value={replSlots.length}       color={C.purple} />
            <KStat label="Max Byte Lag"  value={fmtBytes(replTopology.max_byte_lag || 0)} color={Number(replTopology.max_byte_lag||0) > 1048576 ? C.red : C.green} />
            <KStat label="WAL Level"     value={replConfig.wal_level || hs.wal_level || '—'} />
            <KStat label="Sync Commit"   value={replConfig.synchronous_commit || hs.synchronous_commit || '—'} />
            <KStat label="Publications"  value={replPubs.length}        color={C.teal} />
            <KStat label="Subscriptions" value={replSubs.length}        color={C.indigo} />
          </div>
          {standbys.length === 0 ? (
            <div className="text-center py-3 text-slate-400 text-sm">Standalone instance — no streaming replicas connected</div>
          ) : (
            <>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">CONNECTED STANDBYS</p>
              <RTable
                headers={['Application','Client Addr','State','Sync State','Sent LSN','Replay LSN','Write Lag','Flush Lag','Replay Lag','Byte Lag']}
                rows={standbys.map(s => [
                  <span className="font-bold text-blue-700">{s.application_name || '—'}</span>,
                  <span className="font-mono text-[10px]">{s.client_addr || '—'}</span>,
                  statusBadge(s.state),
                  statusBadge(s.sync_state),
                  <span className="font-mono text-[10px]">{s.sent_lsn || '—'}</span>,
                  <span className="font-mono text-[10px]">{s.replay_lsn || '—'}</span>,
                  <span className={`font-bold text-[10px] ${s.write_lag ? 'text-orange-600' : 'text-green-600'}`}>{s.write_lag || '0'}</span>,
                  <span className={`font-bold text-[10px] ${s.flush_lag ? 'text-orange-600' : 'text-green-600'}`}>{s.flush_lag || '0'}</span>,
                  <span className={`font-bold text-[10px] ${s.replay_lag ? 'text-orange-600' : 'text-green-600'}`}>{s.replay_lag || '0'}</span>,
                  <span className={`font-bold text-[10px] ${Number(s.byte_lag||0) > 1048576 ? 'text-red-600' : 'text-slate-700'}`}>{fmtBytes(s.byte_lag || 0)}</span>,
                ])}
              />
            </>
          )}
          {replSlots.length > 0 && (
            <>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-4 mb-2">REPLICATION SLOTS</p>
              <RTable
                headers={['Slot Name','Type','Active','Database','Restart LSN','Retained WAL','Wal Status']}
                rows={replSlots.map(s => [
                  <span className="font-bold text-purple-700">{s.slot_name || '—'}</span>,
                  <span className="font-mono text-[10px]">{s.slot_type || '—'}</span>,
                  statusBadge(s.active ? 'ACTIVE' : 'INACTIVE'),
                  <span className="text-[10px] text-slate-500">{s.database || '—'}</span>,
                  <span className="font-mono text-[10px]">{s.restart_lsn || '—'}</span>,
                  <span className={`font-bold text-[10px] ${Number(s.retained_bytes||0) > 104857600 ? 'text-red-600' : 'text-slate-700'}`}>{fmtBytes(s.retained_bytes || s.safe_wal_size || 0)}</span>,
                  statusBadge(s.wal_status || '—'),
                ])}
              />
            </>
          )}
          {replPubs.length > 0 && (
            <>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-4 mb-2">LOGICAL PUBLICATIONS</p>
              <RTable
                headers={['Publication','Owner','All Tables','Inserts','Updates','Deletes']}
                rows={replPubs.map(p => [
                  <span className="font-bold text-teal-700">{p.pubname || p.name || '—'}</span>,
                  p.pubowner || p.owner || '—',
                  statusBadge(p.puballtables ? 'YES' : 'NO'),
                  statusBadge(p.pubinsert ? 'YES' : 'NO'),
                  statusBadge(p.pubupdate ? 'YES' : 'NO'),
                  statusBadge(p.pubdelete ? 'YES' : 'NO'),
                ])}
              />
            </>
          )}
          {replSubs.length > 0 && (
            <>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-4 mb-2">LOGICAL SUBSCRIPTIONS</p>
              <RTable
                headers={['Subscription','Enabled','Publication','Conn Info','Worker Status']}
                rows={replSubs.map(s => [
                  <span className="font-bold text-indigo-700">{s.subname || s.name || '—'}</span>,
                  statusBadge(s.subenabled ? 'ENABLED' : 'DISABLED'),
                  <span className="text-[10px]">{(s.subpublications || s.publications || '—').toString()}</span>,
                  <span className="font-mono text-[10px] max-w-[200px] truncate block">{s.subconninfo || '—'}</span>,
                  statusBadge(s.worker_status || s.status || '—'),
                ])}
              />
            </>
          )}
          {replConflicts.length > 0 && (
            <>
              <p className="text-[10px] font-bold text-red-500 uppercase tracking-widest mt-4 mb-2">⚠ REPLICATION CONFLICTS</p>
              <RTable
                headers={['Database','Confl Tablespace','Confl Lock','Confl Snapshot','Confl Bufferpin','Confl Deadlock']}
                rows={replConflicts.map(c => [
                  <span className="font-bold text-red-700">{c.datname || c.database || '—'}</span>,
                  fmtNum(c.confl_tablespace),
                  fmtNum(c.confl_lock),
                  fmtNum(c.confl_snapshot),
                  fmtNum(c.confl_bufferpin),
                  fmtNum(c.confl_deadlock),
                ])}
              />
            </>
          )}
        </RSection>

        {/* ══ 8. WAL STATISTICS ══ */}
        <RSection title="WAL Statistics" icon={RotateCcw} color={C.indigo} pageBreak>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <KStat label="WAL Records"      value={fmtNum(walStats.wal_records)}      color={C.indigo} />
            <KStat label="WAL FPI"          value={fmtNum(walStats.wal_fpi)}          color={C.purple} />
            <KStat label="WAL Bytes"        value={fmtBytes(walStats.wal_bytes)}      color={C.blue} />
            <KStat label="WAL Buffers Full" value={fmtNum(walStats.wal_buffers_full)} color={(walStats.wal_buffers_full||0) > 0 ? C.orange : C.green} />
            <KStat label="WAL Write"        value={fmtNum(walStats.wal_write)}        color={C.teal} />
            <KStat label="WAL Sync"         value={fmtNum(walStats.wal_sync)}         color={C.cyan} />
            <KStat label="Write Time"       value={walStats.wal_write_time ? `${Number(walStats.wal_write_time).toFixed(0)}ms` : '—'} color={C.slate} />
            <KStat label="Sync Time"        value={walStats.wal_sync_time ? `${Number(walStats.wal_sync_time).toFixed(0)}ms` : '—'}  color={C.slate} />
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            {(Number(walStats.wal_records) > 0 || Number(walStats.wal_fpi) > 0) && (
              <div>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">WAL ACTIVITY</p>
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={[
                    { name: 'Records', value: Number(walStats.wal_records) || 0 },
                    { name: 'FPI',     value: Number(walStats.wal_fpi) || 0 },
                    { name: 'Write',   value: Number(walStats.wal_write) || 0 },
                    { name: 'Sync',    value: Number(walStats.wal_sync) || 0 },
                  ]} margin={{ top:5, right:10, left:0, bottom:5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize:9 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize:9 }} tickFormatter={fmtNum} axisLine={false} tickLine={false} />
                    <Tooltip formatter={v => fmtNum(v)} />
                    <Bar dataKey="value" radius={[4,4,0,0]}>
                      {['a','b','c','d'].map((_,i) => <Cell key={i} fill={POOL_COLORS[i%POOL_COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            {Object.keys(walStats).length > 0 && (
              <RTable
                headers={['Metric','Value']}
                rows={Object.entries(walStats).filter(([k]) => !['stats_reset'].includes(k)).slice(0,14).map(([k, v]) => [
                  <span className="font-semibold text-slate-600 text-[11px]">{k.replace(/_/g,' ')}</span>,
                  <span className="font-black text-slate-800">{typeof v === 'number' ? fmtNum(v) : String(v || '—')}</span>,
                ])}
              />
            )}
          </div>
        </RSection>

        {/* ══ 9. CHECKPOINT & BACKGROUND WRITER ══ */}
        <RSection title="Checkpoint & Background Writer" icon={Shield} color={C.cyan} pageBreak>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <KStat label="Checkpoints Timed" value={fmtNum(ckptStats.checkpoints_timed || ckptStats.num_timed)} color={C.cyan} />
            <KStat label="Checkpoints Req"   value={fmtNum(ckptStats.checkpoints_req || ckptStats.num_requested)} color={(ckptStats.checkpoints_req||ckptStats.num_requested||0) > 0 ? C.orange : C.green} />
            <KStat label="Buffers Ckpt"      value={fmtNum(ckptStats.buffers_checkpoint || ckptStats.buffers_written)} color={C.blue} />
            <KStat label="Write Time"        value={ckptStats.checkpoint_write_time || ckptStats.write_time ? `${Number(ckptStats.checkpoint_write_time||ckptStats.write_time||0).toFixed(0)}ms` : '—'} color={C.purple} />
            <KStat label="Sync Time"         value={ckptStats.checkpoint_sync_time || ckptStats.sync_time ? `${Number(ckptStats.checkpoint_sync_time||ckptStats.sync_time||0).toFixed(0)}ms` : '—'} color={C.slate} />
            <KStat label="Buffers Clean"     value={fmtNum(bgwStats.buffers_clean)} color={C.teal} />
            <KStat label="Maxwritten Clean"  value={fmtNum(bgwStats.maxwritten_clean)} color={(bgwStats.maxwritten_clean||0) > 0 ? C.orange : C.green} />
            <KStat label="Buffers Backend"   value={fmtNum(bgwStats.buffers_backend)} color={C.indigo} />
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">CHECKPOINTS: TIMED VS REQUESTED</p>
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={[{
                  name: 'Checkpoints',
                  Timed: Number(ckptStats.checkpoints_timed || ckptStats.num_timed) || 0,
                  Requested: Number(ckptStats.checkpoints_req || ckptStats.num_requested) || 0,
                }]} margin={{ top:5, right:10, left:0, bottom:5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize:9 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize:9 }} axisLine={false} tickLine={false} />
                  <Tooltip /><Legend wrapperStyle={{ fontSize:10 }} />
                  <Bar dataKey="Timed"     fill={C.cyan}   radius={[4,4,0,0]} />
                  <Bar dataKey="Requested" fill={C.orange} radius={[4,4,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div>
              {Object.keys(ckptCfg).length > 0 && (
                <>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">CHECKPOINT CONFIG</p>
                  <RTable
                    headers={['Setting','Value']}
                    rows={Object.entries(ckptCfg).slice(0,10).map(([k, v]) => [
                      <span className="font-semibold text-slate-600 text-[11px]">{k.replace(/_/g,' ')}</span>,
                      <span className="font-black text-slate-800 font-mono">{String(v ?? '—')}</span>,
                    ])}
                  />
                </>
              )}
            </div>
          </div>
        </RSection>

        {/* ══ 10. TABLE STATISTICS ══ */}
        <RSection title={`Table Statistics (${tables.length} tables)`} icon={HardDrive} color={C.teal} pageBreak>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <KStat label="Total Tables"   value={tables.length}   color={C.teal} />
            <KStat label="Vacuum Needed"  value={vacuumNeeded}    color={vacuumNeeded > 0 ? C.amber : C.green} />
            <KStat label="Analyze Needed" value={analyzeNeeded}   color={analyzeNeeded > 0 ? C.orange : C.green} />
            <KStat label="Autovac Enabled" value={autovacCfg.autovacuum || autovacCfg.enabled || '—'} color={C.blue} />
          </div>
          {tables.length > 0 && (
            <>
              {tables.some(t => Number(t.n_live_tup||t.live_tuples||0) + Number(t.n_dead_tup||t.dead_tuples||0) > 0) ? (
                <>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">LIVE VS DEAD TUPLES (TOP 10 BY DEAD)</p>
                  <ResponsiveContainer width="100%" height={160}>
                    <BarChart data={[...tables].sort((a,b)=>Number(b.n_dead_tup||b.dead_tuples||0)-Number(a.n_dead_tup||a.dead_tuples||0)).slice(0,10).map(t => ({
                      name: (t.relname || t.table_name || '').slice(0,12),
                      Live: Number(t.n_live_tup || t.live_tuples || 0),
                      Dead: Number(t.n_dead_tup || t.dead_tuples || 0),
                    }))} margin={{ top:5, right:10, left:0, bottom:5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize:8 }} axisLine={false} tickLine={false} angle={-15} textAnchor="end" height={45} />
                      <YAxis tick={{ fontSize:9 }} tickFormatter={fmtNum} axisLine={false} tickLine={false} />
                      <Tooltip formatter={v => fmtNum(v)} /><Legend wrapperStyle={{ fontSize:10 }} />
                      <Bar dataKey="Live" stackId="a" fill={C.teal}   radius={[0,0,0,0]} />
                      <Bar dataKey="Dead" stackId="a" fill={C.orange} radius={[4,4,0,0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </>
              ) : (
                <p className="text-[11px] text-slate-400 italic mb-3">Tuple statistics not yet collected (no ANALYZE has run on these tables). Sizes shown below.</p>
              )}
              <RTable
                headers={['Schema','Table','Size','Live Rows','Dead Rows','Dead %','Inserts','Updates','Deletes','Last Vacuum','Last Analyze']}
                rows={tables.slice(0,20).map(t => {
                  const live = Number(t.n_live_tup || t.live_tuples || 0);
                  const dead = Number(t.n_dead_tup || t.dead_tuples || 0);
                  const deadPct = (live + dead) > 0 ? Math.round(dead / (live + dead) * 100) : 0;
                  return [
                    <span className="text-[10px] font-mono text-slate-500">{t.schemaname || 'public'}</span>,
                    <span className="font-bold text-teal-700">{t.relname || t.table_name}</span>,
                    t.total_size || t.size || '—',
                    fmtNum(live),
                    <span className={`font-bold ${dead > 10000 ? 'text-orange-600' : 'text-slate-700'}`}>{fmtNum(dead)}</span>,
                    <span className={`font-bold ${deadPct > 20 ? 'text-red-600' : deadPct > 10 ? 'text-orange-600' : 'text-green-700'}`}>{deadPct}%</span>,
                    fmtNum(t.n_tup_ins || t.inserts || 0),
                    fmtNum(t.n_tup_upd || t.updates || 0),
                    fmtNum(t.n_tup_del || t.deletes || 0),
                    <span className="font-mono text-[10px] text-slate-400">{(t.last_vacuum || t.last_autovacuum || '—')?.toString().slice(0,10)}</span>,
                    <span className="font-mono text-[10px] text-slate-400">{(t.last_analyze || t.last_autoanalyze || '—')?.toString().slice(0,10)}</span>,
                  ];
                })}
                emptyMsg="No table statistics available"
              />
            </>
          )}
        </RSection>

        {/* ══ 11. INDEX ANALYSIS ══ */}
        <RSection title="Index Analysis" icon={BarChart2} color={C.amber} pageBreak>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <KStat label="Total Indexes"  value={fmtNum(idxSummary.total_indexes ?? allIdx.length)} color={C.amber} />
            <KStat label="Unused Indexes" value={unusedIdx.length} color={unusedIdx.length > 5 ? C.orange : C.green} />
            <KStat label="Bloated Tables" value={bloatedTbls.length} color={bloatedTbls.length > 0 ? C.red : C.green} />
            <KStat label="Index Size"     value={idxSummary.total_index_size || idxSummary.index_size || '—'} color={C.blue} />
          </div>
          {allIdx.length > 0 && (
            <>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">TOP INDEXES BY SCAN COUNT</p>
              <ResponsiveContainer width="100%" height={150}>
                <BarChart data={[...allIdx].sort((a,b)=>Number(b.idx_scan||b.scans||0)-Number(a.idx_scan||a.scans||0)).slice(0,10).map(idx => ({
                  name: (idx.indexname || idx.indexrelname || idx.index || '').slice(0,14),
                  scans: Number(idx.idx_scan || idx.scans || 0),
                }))} margin={{ top:5, right:10, left:0, bottom:5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize:8 }} axisLine={false} tickLine={false} angle={-15} textAnchor="end" height={45} />
                  <YAxis tick={{ fontSize:9 }} tickFormatter={fmtNum} axisLine={false} tickLine={false} />
                  <Tooltip formatter={v => [fmtNum(v), 'Scans']} />
                  <Bar dataKey="scans" radius={[4,4,0,0]}>
                    {allIdx.slice(0,10).map((_,i) => <Cell key={i} fill={POOL_COLORS[i%POOL_COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </>
          )}
          {unusedIdx.length > 0 && (
            <>
              <p className="text-[10px] font-bold text-orange-500 uppercase tracking-widest mt-4 mb-2">⚠ UNUSED INDEXES</p>
              <RTable
                headers={['Schema','Table','Index','Size','Scans']}
                rows={unusedIdx.slice(0,15).map(idx => [
                  <span className="text-[10px] font-mono text-slate-500">{idx.schemaname || idx.schema || 'public'}</span>,
                  <span className="font-bold text-amber-700">{idx.tablename || idx.relname || idx.table || '—'}</span>,
                  <span className="font-mono text-[10px] text-slate-600">{idx.indexname || idx.indexrelname || idx.index || '—'}</span>,
                  idx.index_size || idx.size || '—',
                  <span className="font-bold text-red-600">{fmtNum(idx.idx_scan || idx.scans || 0)}</span>,
                ])}
              />
            </>
          )}
          {bloatedTbls.length > 0 && (
            <>
              <p className="text-[10px] font-bold text-red-500 uppercase tracking-widest mt-4 mb-2">⚠ BLOATED TABLES</p>
              <RTable
                headers={['Schema','Table','Size','Bloat Size','Bloat %','Dead Tuples']}
                rows={bloatedTbls.slice(0,15).map(t => [
                  <span className="text-[10px] font-mono text-slate-500">{t.schemaname || t.schema || 'public'}</span>,
                  <span className="font-bold text-red-700">{t.tablename || t.relname || t.table || '—'}</span>,
                  t.table_size || t.size || '—',
                  t.bloat_size || '—',
                  <span className={`font-bold ${Number(t.bloat_pct||t.bloat_ratio||0) > 30 ? 'text-red-600' : 'text-orange-600'}`}>
                    {t.bloat_pct ?? t.bloat_ratio ?? '—'}{(t.bloat_pct ?? t.bloat_ratio) != null ? '%' : ''}
                  </span>,
                  fmtNum(t.n_dead_tup || t.dead_tuples || 0),
                ])}
              />
            </>
          )}
          {topIndexes.filter(i => (i.schema || i.schemaname) !== 'pg_toast').length > 0 && (
            <>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-4 mb-2">LARGEST INDEXES</p>
              <RTable
                headers={['Schema','Index','Table','Size','Scans','Unique','Primary']}
                rows={topIndexes.filter(i => (i.schema || i.schemaname) !== 'pg_toast').slice(0,15).map(idx => [
                  <span className="text-[10px] font-mono text-slate-500">{idx.schema || idx.schemaname || 'public'}</span>,
                  <span className="font-mono text-[10px] text-indigo-700 font-bold">{idx.index_name || idx.indexname || idx.indexrelname || '—'}</span>,
                  <span className="text-[10px] text-slate-600">{idx.table_name || idx.tablename || idx.relname || '—'}</span>,
                  <span className="font-bold">{idx.size || idx.index_size || '—'}</span>,
                  fmtNum(idx.idx_scan || idx.scans || 0),
                  statusBadge(idx.is_unique ? 'YES' : 'NO'),
                  statusBadge(idx.is_primary ? 'YES' : 'NO'),
                ])}
              />
            </>
          )}
        </RSection>

        {/* ══ 12. STORAGE & DATABASE SIZES ══ */}
        <RSection title="Storage & Database Sizes" icon={Layers} color={C.teal} pageBreak>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <KStat label="Total Size"   value={storageSumm.total_size || dbSize} color={C.teal} />
            <KStat label="Databases"    value={dbSizes.length}     color={C.blue} />
            <KStat label="Tablespaces"  value={tablespaces.length} color={C.purple} />
            <KStat label="TOAST Tables" value={toastTables.length} color={C.indigo} />
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            {dbSizes.length > 0 && (
              <div>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">DATABASE SIZES</p>
                <ResponsiveContainer width="100%" height={170}>
                  <BarChart data={[...dbSizes].sort((a,b)=>Number(b.size_bytes||b.bytes||0)-Number(a.size_bytes||a.bytes||0)).slice(0,10).map(d => ({
                    name: (d.datname || d.database || d.name || '').slice(0,12),
                    mb: Math.round((Number(d.size_bytes || d.bytes || 0)) / 1048576),
                  }))} margin={{ top:5, right:10, left:0, bottom:5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize:8 }} axisLine={false} tickLine={false} angle={-15} textAnchor="end" height={45} />
                    <YAxis tick={{ fontSize:9 }} tickFormatter={v => `${v}MB`} axisLine={false} tickLine={false} />
                    <Tooltip formatter={v => [`${fmtNum(v)} MB`, 'Size']} />
                    <Bar dataKey="mb" radius={[4,4,0,0]}>
                      {dbSizes.slice(0,10).map((_,i) => <Cell key={i} fill={POOL_COLORS[i%POOL_COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">DATABASE DETAILS</p>
              <RTable
                headers={['Database','Size','Owner','Encoding']}
                rows={dbSizes.slice(0,12).map(d => [
                  <span className="font-bold text-teal-700">{d.datname || d.database || d.name || '—'}</span>,
                  <span className="font-bold">{d.size || d.pg_size_pretty || '—'}</span>,
                  <span className="text-[10px] text-slate-500">{d.owner || d.datdba || '—'}</span>,
                  <span className="text-[10px] font-mono">{d.encoding || '—'}</span>,
                ])}
                emptyMsg="No database size data"
              />
            </div>
          </div>
          {tablespaces.length > 0 && (
            <>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-4 mb-2">TABLESPACES</p>
              <RTable
                headers={['Tablespace','Owner','Size','Location']}
                rows={tablespaces.slice(0,10).map(t => [
                  <span className="font-bold text-purple-700">{t.spcname || t.name || '—'}</span>,
                  t.owner || t.spcowner || '—',
                  <span className="font-bold">{t.size || t.pg_size_pretty || '—'}</span>,
                  <span className="font-mono text-[10px] max-w-[260px] truncate block">{t.location || t.spclocation || '—'}</span>,
                ])}
              />
            </>
          )}
          {topTables.length > 0 && (
            <>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-4 mb-2">LARGEST TABLES</p>
              <RTable
                headers={['Schema','Table','Total Size','Table Size','Index Size','TOAST Size']}
                rows={topTables.slice(0,15).map(t => [
                  <span className="text-[10px] font-mono text-slate-500">{t.schemaname || t.schema || 'public'}</span>,
                  <span className="font-bold text-teal-700">{t.tablename || t.relname || t.table || '—'}</span>,
                  <span className="font-bold">{t.total_size || t.size || '—'}</span>,
                  t.table_size || '—',
                  t.index_size || '—',
                  t.toast_size || '—',
                ])}
              />
            </>
          )}
          {toastTables.length > 0 && (
            <>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-4 mb-2">TOAST TABLES</p>
              <RTable
                headers={['Parent Table','TOAST Size','Main Size']}
                rows={toastTables.slice(0,10).map(t => [
                  <span className="font-bold text-indigo-700">{t.tablename || t.relname || t.parent || '—'}</span>,
                  <span className="font-bold text-orange-600">{t.toast_size || t.size || '—'}</span>,
                  t.main_size || t.table_size || '—',
                ])}
              />
            </>
          )}
        </RSection>

        {/* ══ 13. LOCK ANALYSIS ══ */}
        <RSection title={`Lock Analysis (${dashLocks.length} locks)`} icon={Lock}
          color={dashLocks.length > 0 ? C.orange : C.green} pageBreak>
          {dashLocks.length === 0 ? (
            <div className="text-center py-4 flex items-center justify-center gap-2 text-green-600">
              <CheckCircle2 size={18} />
              <span className="font-bold text-sm">No locks held — no contention detected</span>
            </div>
          ) : (
            <>
              {(() => {
                const byMode = dashLocks.reduce((acc, l) => {
                  const k = l.mode || l.locktype || 'unknown';
                  const ex = acc.find(x => x.name === k);
                  if (ex) ex.value++; else acc.push({ name: k, value: 1 });
                  return acc;
                }, []);
                return (
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                    <div>
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">LOCKS BY MODE</p>
                      <div className="flex items-center gap-4">
                        <div className="flex-shrink-0" style={{ width: 150, height: 150 }}>
                          <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                              <Pie data={byMode} dataKey="value" nameKey="name"
                                cx="50%" cy="50%" innerRadius={42} outerRadius={68} paddingAngle={2} stroke="none">
                                {byMode.map((_,i) => <Cell key={i} fill={POOL_COLORS[i%POOL_COLORS.length]} />)}
                              </Pie>
                              <Tooltip formatter={(v, n) => [`${v} locks`, n]} />
                            </PieChart>
                          </ResponsiveContainer>
                        </div>
                        <div className="flex-1 min-w-0 space-y-2">
                          {(() => {
                            const tot = byMode.reduce((s, x) => s + Number(x.value || 0), 0) || 1;
                            return byMode.map((m, i) => (
                              <div key={m.name} className="flex items-center justify-between gap-2">
                                <span className="flex items-center gap-2 min-w-0">
                                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: POOL_COLORS[i % POOL_COLORS.length] }} />
                                  <span className="text-[11px] font-semibold text-slate-600 truncate">{m.name}</span>
                                </span>
                                <span className="text-[11px] font-black text-slate-800 flex-shrink-0">
                                  {m.value} <span className="text-slate-400 font-bold">({Math.round(Number(m.value || 0) / tot * 100)}%)</span>
                                </span>
                              </div>
                            ));
                          })()}
                        </div>
                      </div>
                    </div>
                    <RTable
                      headers={['PID','Lock Type','Mode','Granted','Relation','DB']}
                      rows={dashLocks.slice(0,15).map(l => [
                        <span className="font-mono text-slate-500">{l.pid || '—'}</span>,
                        <span className="font-mono text-[10px]">{l.locktype || '—'}</span>,
                        <span className="font-bold text-orange-700 text-[10px]">{l.mode || '—'}</span>,
                        statusBadge(l.granted ? 'YES' : 'NO'),
                        <span className="font-mono text-[10px]">{l.relation || l.relname || '—'}</span>,
                        <span className="text-[10px] text-slate-500">{l.datname || l.database || '—'}</span>,
                      ])}
                    />
                  </div>
                );
              })()}
            </>
          )}
        </RSection>

        {/* ══ 14. DATABASE HEALTH PER DB ══ */}
        <RSection title="Database Health" icon={Heart} color={C.green} pageBreak>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <KStat label="Databases"      value={dbHealthList.length} color={C.green} />
            <KStat label="Vacuum Needed"  value={vacNeedHlth.length}  color={vacNeedHlth.length > 0 ? C.amber : C.green} />
            <KStat label="Sequences"      value={sequences.length}    color={C.blue} />
            <KStat label="Total Indexes"  value={fmtNum(idxHealth.total_indexes)} sub={idxHealth.unused_indexes != null ? `${idxHealth.unused_indexes} unused` : undefined} color={C.purple} />
          </div>
          {dbHealthList.length > 0 && (
            <>
              {dbHealthList.some(d => Number(d.deadlocks || 0) > 0 || Number(d.temp_files || 0) > 0) ? (
                <>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">DEADLOCKS / TEMP FILES PER DATABASE</p>
                  <ResponsiveContainer width="100%" height={150}>
                    <BarChart data={dbHealthList.slice(0,10).map(d => ({
                      name: (d.datname || d.database || d.name || '').slice(0,12),
                      Deadlocks: Number(d.deadlocks || 0),
                      TempFiles: Number(d.temp_files || 0),
                    }))} margin={{ top:5, right:10, left:0, bottom:5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize:8 }} axisLine={false} tickLine={false} angle={-15} textAnchor="end" height={45} />
                      <YAxis tick={{ fontSize:9 }} axisLine={false} tickLine={false} />
                      <Tooltip /><Legend wrapperStyle={{ fontSize:10 }} />
                      <Bar dataKey="Deadlocks" fill={C.red}    radius={[4,4,0,0]} />
                      <Bar dataKey="TempFiles" fill={C.orange} radius={[4,4,0,0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-green-600 mb-2">
                    <CheckCircle2 size={14} />
                    <span className="text-[11px] font-bold">No deadlocks or temp-file spills across all databases — showing cache hit ratio instead</span>
                  </div>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">CACHE HIT % PER DATABASE</p>
                  <ResponsiveContainer width="100%" height={150}>
                    <BarChart data={dbHealthList.slice(0,10).map(d => ({
                      name: (d.datname || d.database || d.name || '').slice(0,12),
                      hit: Number(d.cache_hit_pct ?? d.cache_hit_ratio ?? 0),
                    }))} margin={{ top:5, right:10, left:0, bottom:5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize:8 }} axisLine={false} tickLine={false} angle={-15} textAnchor="end" height={45} />
                      <YAxis domain={[0,100]} tick={{ fontSize:9 }} tickFormatter={v => `${v}%`} axisLine={false} tickLine={false} />
                      <Tooltip formatter={v => [`${Number(v).toFixed(2)}%`, 'Cache Hit']} />
                      <Bar dataKey="hit" name="Cache Hit %" radius={[4,4,0,0]}>
                        {dbHealthList.slice(0,10).map((d, i) => (
                          <Cell key={i} fill={Number(d.cache_hit_pct ?? d.cache_hit_ratio ?? 0) < 90 ? C.orange : C.green} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </>
              )}
              <RTable
                headers={['Database','Size','Commit Ratio','Cache Hit','Deadlocks','Temp Files','Conflicts','Connections']}
                rows={dbHealthList.slice(0,15).map(d => {
                  const commits = Number(d.xact_commit || 0);
                  const rollbacks = Number(d.xact_rollback || 0);
                  const commitRatio = (commits + rollbacks) > 0 ? (commits / (commits + rollbacks) * 100) : null;
                  return [
                  <span className="font-bold text-green-700">{d.datname || d.database || d.name || '—'}</span>,
                  d.size_bytes != null ? fmtBytes(d.size_bytes) : (d.size_mb != null ? `${d.size_mb} MB` : (d.size || '—')),
                  commitRatio != null ? `${commitRatio.toFixed(1)}%` : '—',
                  <span className={`font-bold ${Number(d.cache_hit_pct||d.cache_hit_ratio||100) < 85 ? 'text-orange-600' : 'text-green-700'}`}>
                    {(d.cache_hit_pct ?? d.cache_hit_ratio) != null ? `${Number(d.cache_hit_pct ?? d.cache_hit_ratio).toFixed(1)}%` : '—'}
                  </span>,
                  <span className={`font-bold ${Number(d.deadlocks||0) > 0 ? 'text-red-600' : 'text-slate-700'}`}>{fmtNum(d.deadlocks || 0)}</span>,
                  <span className={`font-bold ${Number(d.temp_files||0) > 0 ? 'text-orange-600' : 'text-slate-700'}`}>{fmtNum(d.temp_files || 0)}</span>,
                  fmtNum(d.conflicts || 0),
                  fmtNum(d.numbackends || d.connections || 0),
                ];})}
              />
            </>
          )}
          {sequences.length > 0 && (
            <>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-4 mb-2">SEQUENCES NEARING LIMIT</p>
              <RTable
                headers={['Sequence','Last Value','Max Value','Used %']}
                rows={sequences.slice(0,12).map(s => {
                  const pct = Number(s.used_pct ?? s.usage_pct ?? 0);
                  return [
                    <span className="font-bold text-blue-700">{s.sequencename || s.seqname || s.name || '—'}</span>,
                    fmtNum(s.last_value),
                    fmtNum(s.max_value),
                    <span className={`font-bold ${pct > 80 ? 'text-red-600' : pct > 60 ? 'text-orange-600' : 'text-green-700'}`}>
                      {pct ? `${pct.toFixed(1)}%` : '—'}
                    </span>,
                  ];
                })}
              />
            </>
          )}
          {vacNeedHlth.length > 0 && (
            <>
              <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest mt-4 mb-2">⚠ TABLES NEEDING VACUUM</p>
              <RTable
                headers={['Schema','Table','Dead Tuples','Live Tuples','Dead %','Last Autovacuum']}
                rows={vacNeedHlth.slice(0,12).map(t => {
                  const live = Number(t.n_live_tup || t.live_tuples || 0);
                  const dead = Number(t.n_dead_tup || t.dead_tuples || 0);
                  const pct = (live + dead) > 0 ? Math.round(dead / (live + dead) * 100) : 0;
                  return [
                    <span className="text-[10px] font-mono text-slate-500">{t.schemaname || 'public'}</span>,
                    <span className="font-bold text-amber-700">{t.relname || t.table_name || '—'}</span>,
                    <span className="font-bold text-orange-600">{fmtNum(dead)}</span>,
                    fmtNum(live),
                    <span className={`font-bold ${pct > 20 ? 'text-red-600' : 'text-orange-600'}`}>{pct}%</span>,
                    <span className="font-mono text-[10px] text-slate-400">{(t.last_autovacuum || t.last_vacuum || '—')?.toString().slice(0,10)}</span>,
                  ];
                })}
              />
            </>
          )}
        </RSection>

        {/* ══ 15. USERS & ROLES ══ */}
        <RSection title={`Users & Roles (${roles.length})`} icon={Shield} color={C.slate} pageBreak>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <KStat label="Total Roles"  value={roles.length} color={C.slate} />
            <KStat label="Superusers"   value={userSummary.superuser_count ?? userSummary.superusers ?? roles.filter(r => r.rolsuper || r.usesuper).length} color={C.red} />
            <KStat label="Can Login"    value={userSummary.login_roles ?? roles.filter(r => r.rolcanlogin ?? r.canlogin).length} color={C.green} />
            <KStat label="Memberships"  value={memberships.length} color={C.blue} />
          </div>
          {roles.length > 0 && (
            <RTable
              headers={['Role','Superuser','Create DB','Create Role','Can Login','Replication','Conn Limit','Valid Until']}
              rows={roles.slice(0,20).map(r => [
                <span className="font-bold text-indigo-700">{r.rolname || r.usename || r.username || '—'}</span>,
                statusBadge((r.rolsuper ?? r.usesuper) ? 'YES' : 'NO'),
                statusBadge((r.rolcreatedb ?? r.usecreatedb) ? 'YES' : 'NO'),
                statusBadge((r.rolcreaterole ?? r.usecreaterole) ? 'YES' : 'NO'),
                statusBadge((r.rolcanlogin ?? r.canlogin) ? 'YES' : 'NO'),
                statusBadge((r.rolreplication ?? r.replication) ? 'YES' : 'NO'),
                r.rolconnlimit ?? r.useconnlimit ?? '—',
                <span className="font-mono text-[10px] text-slate-400">{(r.rolvaliduntil || r.valuntil || '—')?.toString().slice(0,10)}</span>,
              ])}
            />
          )}
          {memberships.length > 0 && (
            <>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-4 mb-2">ROLE MEMBERSHIPS</p>
              <RTable
                headers={['Member Role','Member Of','Admin Option']}
                rows={memberships.slice(0,15).map(m => [
                  <span className="font-bold text-blue-700">{m.member_name || m.member || m.role || '—'}</span>,
                  <span className="font-semibold text-slate-700">{m.role_name || m.parent || m.member_of || '—'}</span>,
                  statusBadge((m.admin_option ?? m.admin) ? 'YES' : 'NO'),
                ])}
              />
            </>
          )}
          {objOwnership.length > 0 && (
            <>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-4 mb-2">OBJECT OWNERSHIP</p>
              <RTable
                headers={['Owner','Tables','Views','Indexes','Sequences']}
                rows={objOwnership.slice(0,12).map(o => [
                  <span className="font-bold text-purple-700">{o.owner || o.rolname || '—'}</span>,
                  fmtNum(o.tables ?? o.table_count ?? 0),
                  fmtNum(o.views ?? o.view_count ?? 0),
                  fmtNum(o.indexes ?? o.index_count ?? 0),
                  fmtNum(o.sequences ?? o.sequence_count ?? 0),
                ])}
              />
            </>
          )}
          {userActivity.length > 0 && (
            <>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-4 mb-2">USER ACTIVITY</p>
              <RTable
                headers={['User','DB','Total','Active','Idle','Idle in Tx','Waiting','Max Conn Age']}
                rows={userActivity.slice(0,15).map(u => [
                  <span className="font-bold text-indigo-700">{u.usename || u.username || u.rolname || '—'}</span>,
                  <span className="text-[10px] text-slate-500">{u.datname || '—'}</span>,
                  <span className="font-bold">{fmtNum(u.total ?? u.connections ?? 0)}</span>,
                  <span className={`font-bold ${Number(u.active||0) > 0 ? 'text-green-700' : 'text-slate-500'}`}>{fmtNum(u.active ?? 0)}</span>,
                  fmtNum(u.idle ?? 0),
                  <span className={`${Number(u.idle_in_txn||0) > 0 ? 'text-orange-600 font-bold' : 'text-slate-500'}`}>{fmtNum(u.idle_in_txn ?? 0)}</span>,
                  <span className={`${Number(u.waiting||0) > 0 ? 'text-red-600 font-bold' : 'text-slate-500'}`}>{fmtNum(u.waiting ?? 0)}</span>,
                  <span className="font-mono text-[10px] text-slate-400">{u.max_conn_age_s ? `${u.max_conn_age_s}s` : '—'}</span>,
                ])}
              />
            </>
          )}
        </RSection>

        {/* ══ 16. CONFIGURATION ══ */}
        <RSection title="Configuration" icon={Cpu} color={C.slate} pageBreak>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <KStat label="Config Groups"    value={Object.keys(cfgGroups).length} color={C.slate} />
            <KStat label="Modified Settings" value={cfgModified} color={cfgModified > 0 ? C.blue : C.slate} />
            <KStat label="Pending Restart"  value={cfgPendingRst} color={cfgPendingRst > 0 ? C.red : C.green} />
            <KStat label="WAL Level"         value={hs.wal_level || '—'} color={C.indigo} />
          </div>
          {Object.keys(cfgGroups).length === 0 ? (
            <p className="text-center text-slate-400 py-4">No configuration data available</p>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {Object.entries(cfgGroups).map(([groupName, settings]) => (
                <div key={groupName}>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">{groupName.replace(/_/g,' ')}</p>
                  <RTable
                    headers={['Setting','Value','Unit','Restart']}
                    rows={(Array.isArray(settings) ? settings : []).slice(0,20).map(s => [
                      <span className="font-semibold text-slate-600 text-[11px]">{(s.name || s.setting_name || '').replace(/_/g,' ')}</span>,
                      <span className="font-black text-slate-800 font-mono text-[11px]">{s.setting ?? s.value ?? '—'}</span>,
                      <span className="text-[10px] text-slate-400">{s.unit || '—'}</span>,
                      (s.pending_restart || s.requires_restart)
                        ? <span className="text-[10px] font-bold text-red-600">YES</span>
                        : <span className="text-[10px] text-slate-400">—</span>,
                    ])}
                  />
                </div>
              ))}
            </div>
          )}
        </RSection>

        {/* ══ 17. SLRU CACHE ══ */}
        <RSection title="SLRU Cache Statistics" icon={Cpu} color={C.purple} pageBreak>
          {slruPools.length === 0 ? (
            <p className="text-center text-slate-400 py-4">No SLRU cache data available (requires PostgreSQL 13+)</p>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <div>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">CACHE HIT % PER POOL</p>
                <ResponsiveContainer width="100%" height={Math.max(160, slruPools.length * 28)}>
                  <BarChart layout="vertical"
                    data={slruPools.map(p => {
                      const hit = Number(p.blks_hit || 0);
                      const read = Number(p.blks_read || 0);
                      const total = hit + read;
                      return { name: p.name || p.pool || '—', pct: total > 0 ? Math.round(hit / total * 100) : 100 };
                    })}
                    margin={{ top:5, right:25, left:5, bottom:5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                    <XAxis type="number" domain={[0,100]} tick={{ fontSize:9 }} tickFormatter={v => `${v}%`} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize:9 }} width={100} axisLine={false} tickLine={false} />
                    <Tooltip formatter={v => [`${v}%`, 'Hit Ratio']} />
                    <Bar dataKey="pct" radius={[0,4,4,0]}>
                      {slruPools.map((_,i) => <Cell key={i} fill={POOL_COLORS[i%POOL_COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <RTable
                headers={['Pool','Blks Hit','Blks Read','Blks Zeroed','Flushes','Truncates']}
                rows={slruPools.map(p => [
                  <span className="font-bold text-purple-700">{p.name || p.pool || '—'}</span>,
                  <span className="font-bold text-green-700">{fmtNum(p.blks_hit)}</span>,
                  <span className={`font-bold ${Number(p.blks_read||0) > 10000 ? 'text-orange-600' : 'text-slate-700'}`}>{fmtNum(p.blks_read)}</span>,
                  fmtNum(p.blks_zeroed),
                  fmtNum(p.flushes),
                  fmtNum(p.truncates),
                ])}
              />
            </div>
          )}
        </RSection>

        {/* ══ 18. SSL CONNECTIONS ══ */}
        <RSection title="SSL / Connection Security" icon={Lock} color={C.green} pageBreak>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <KStat label="SSL Connections"     value={sslCount}    color={C.green} />
            <KStat label="Non-SSL Connections" value={nonSslCount} color={nonSslCount > 0 ? C.orange : C.green} />
            <KStat label="SSL %"               value={(sslCount + nonSslCount) > 0 ? `${Math.round(sslCount / (sslCount + nonSslCount) * 100)}%` : '—'} color={C.blue} />
            <KStat label="Cipher Types"        value={Object.keys(sslCiphers).length} color={C.purple} />
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            {(sslCount + nonSslCount) > 0 && (
              <div>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">SSL VS NON-SSL</p>
                <div className="flex items-center gap-4">
                  <div className="flex-shrink-0" style={{ width: 150, height: 150 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={[
                          { name: 'SSL',     value: sslCount },
                          { name: 'Non-SSL', value: nonSslCount },
                        ]} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={42} outerRadius={68} paddingAngle={2} stroke="none">
                          <Cell fill={C.green} />
                          <Cell fill={C.orange} />
                        </Pie>
                        <Tooltip formatter={(v, n) => [`${v} connections`, n]} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="flex-1 min-w-0 space-y-2">
                    {(() => {
                      const tot = sslCount + nonSslCount || 1;
                      return [
                        { name: 'SSL',     value: sslCount,    color: C.green },
                        { name: 'Non-SSL', value: nonSslCount, color: C.orange },
                      ].map(s => (
                        <div key={s.name} className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-2 min-w-0">
                            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: s.color }} />
                            <span className="text-[11px] font-semibold text-slate-600 truncate">{s.name}</span>
                          </span>
                          <span className="text-[11px] font-black text-slate-800 flex-shrink-0">
                            {s.value} <span className="text-slate-400 font-bold">({Math.round(s.value / tot * 100)}%)</span>
                          </span>
                        </div>
                      ));
                    })()}
                  </div>
                </div>
              </div>
            )}
            <div>
              {Object.keys(sslCiphers).length > 0 && (
                <>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">CIPHERS IN USE</p>
                  <RTable
                    headers={['Cipher','Connections']}
                    rows={Object.entries(sslCiphers).sort((a,b)=>Number(b[1])-Number(a[1])).slice(0,12).map(([k, v]) => [
                      <span className="font-mono text-[10px] text-green-700 font-bold">{k}</span>,
                      <span className="font-black text-slate-800">{fmtNum(v)}</span>,
                    ])}
                  />
                </>
              )}
            </div>
          </div>
          {sslConns.length > 0 && (
            <>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-4 mb-2">SSL CONNECTION DETAILS</p>
              <RTable
                headers={['PID','User','SSL','Version','Cipher','Bits','Client Addr']}
                rows={sslConns.slice(0,15).map(c => [
                  <span className="font-mono text-slate-500">{c.pid || '—'}</span>,
                  <span className="font-bold text-blue-700">{c.usename || c.username || '—'}</span>,
                  statusBadge(c.ssl ? 'YES' : 'NO'),
                  <span className="font-mono text-[10px]">{c.version || c.ssl_version || '—'}</span>,
                  <span className="font-mono text-[10px]">{c.cipher || '—'}</span>,
                  c.bits || '—',
                  <span className="font-mono text-[10px]">{c.client_addr || '—'}</span>,
                ])}
              />
            </>
          )}
        </RSection>

        {/* ══ 19. BACKUP STATUS ══ */}
        <RSection title="Backup Status" icon={Archive} color={C.green} pageBreak>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <KStat label="Last Backup"   value={(backupSum.last_backup || {}).status || backupSum.last_backup_time?.toString().slice(0,10) || '—'}
              color={(backupSum.last_backup || {}).status === 'COMPLETED' ? C.green : C.orange} />
            <KStat label="Total Backups" value={backupSum.total_backups ?? '—'} color={C.blue} />
            <KStat label="Schedules"     value={backupSum.total_schedules ?? (backupSum.schedules || []).length} color={C.purple} />
            <KStat label="WAL Archiving" value={backupSum.wal_archiving || hs.archive_mode || hs.wal_level || '—'} />
          </div>
          {(backupSum.schedules || []).length > 0 ? (
            <>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">BACKUP SCHEDULES</p>
              <RTable
                headers={['Name','Type','Frequency','Next Run','Last Status','Enabled']}
                rows={(backupSum.schedules || []).slice(0,12).map(s => [
                  <span className="font-bold text-slate-700">{s.schedule_name || s.name}</span>,
                  s.backup_type || s.type || '—',
                  s.frequency || '—',
                  <span className="font-mono text-[10px]">{s.next_run_at?.slice(0,16) || '—'}</span>,
                  statusBadge(s.last_status || s.status || '—'),
                  statusBadge(s.enabled ? 'YES' : 'NO'),
                ])}
              />
            </>
          ) : (
            <p className="text-center text-slate-400 py-3 text-sm">No backup schedules configured</p>
          )}
          {(backupSum.recent_backups || []).length > 0 && (
            <>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-4 mb-2">RECENT BACKUPS</p>
              <RTable
                headers={['Backup','Type','Size','Status','Started','Duration']}
                rows={(backupSum.recent_backups || []).slice(0,10).map(b => [
                  <span className="font-bold text-green-700">{b.backup_name || b.name || '—'}</span>,
                  b.backup_type || b.type || '—',
                  b.size || b.backup_size || '—',
                  statusBadge(b.status || '—'),
                  <span className="font-mono text-[10px]">{(b.started_at || b.created_at || '—')?.toString().slice(0,16)}</span>,
                  b.duration || '—',
                ])}
              />
            </>
          )}
        </RSection>

        {/* ══ 20. INSTALLED EXTENSIONS ══ */}
        <RSection title={`Installed Extensions (${extensions.length})`} icon={Layers} color={C.indigo} pageBreak>
          {extensions.length === 0 ? (
            <p className="text-center text-slate-400 py-4">No extension data available</p>
          ) : (
            <RTable
              headers={['Extension','Installed Version','Latest Version','Description']}
              rows={extensions.slice(0,25).map(e => [
                <span className="font-bold text-indigo-700">{e.name || e.extname || '—'}</span>,
                <span className="font-mono text-[10px]">{e.installed_version || e.extversion || e.version || '—'}</span>,
                <span className={`font-mono text-[10px] ${e.default_version && e.installed_version && e.default_version !== e.installed_version ? 'text-orange-600 font-bold' : 'text-slate-400'}`}>{e.default_version || '—'}</span>,
                <span className="text-[10px] text-slate-500">{e.comment || e.description || '—'}</span>,
              ])}
            />
          )}
        </RSection>

        {/* ══ REPORT FOOTER ══ */}
        <div className="mt-6 pt-4 border-t-2 border-slate-200 flex items-center justify-between text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <span className="text-lg">🐘</span>
            <div>
              <p className="font-black text-slate-600">Actmon — PostgreSQL Database Monitoring Report</p>
              <p>{connName} — {periodObj.label} Report</p>
            </div>
          </div>
          <div className="text-right">
            <p className="font-bold text-slate-500">Generated: {genTime}</p>
            <p>Powered by Actmon — All rights reserved</p>
          </div>
        </div>

    </ReportShell>
  );
}
