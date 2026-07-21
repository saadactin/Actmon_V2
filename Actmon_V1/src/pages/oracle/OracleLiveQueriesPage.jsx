import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, Activity, RefreshCw, Clock, Users, Zap,
  AlertTriangle, CheckCircle2, ChevronDown, ChevronUp,
  Copy, CheckCheck, Search, Database, Server,
  TrendingUp, TrendingDown, Cpu, HardDrive, Lock,
  Eye, FileText, BarChart2, Info, Shield,
} from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip,
  BarChart, Bar, PieChart, Pie, Cell, CartesianGrid, Legend,
} from 'recharts';
import client from '../../api/client';
import PageHeader from '../../components/layout/PageHeader';

/* ─── palette ─── */
const POOL_COLORS = ['#C74634','#F97316','#F59E0B','#3B82F6','#8B5CF6','#14B8A6','#22C55E','#06B6D4'];
const C = {
  red: '#C74634', orange: '#F97316', green: '#22C55E',
  blue: '#3B82F6', purple: '#8B5CF6', teal: '#14B8A6',
  slate: '#64748B', amber: '#F59E0B', indigo: '#6366F1',
  cyan: '#06B6D4',
};
const WAIT_COLORS = {
  'User I/O':      C.orange,
  'System I/O':    C.blue,
  'Concurrency':   C.red,
  'Network':       C.teal,
  'CPU':           C.green,
  'Application':   C.purple,
  'Other':         C.slate,
};

/* ─── helpers ─── */
function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v/1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v/1e3).toFixed(1)}K`;
  return String(v);
}
function waitColor(ev) {
  const wc = (ev || '').trim();
  if (/I\/O|read|write/i.test(wc)) return C.orange;
  if (/lock|latch|enq/i.test(wc))  return C.red;
  if (/network|sql\*net/i.test(wc)) return C.teal;
  if (/CPU|on cpu/i.test(wc))      return C.green;
  return C.slate;
}
function waitExplain(event, waitClass) {
  const ev = (event || '').toLowerCase();
  const wc = (waitClass || '').toLowerCase();
  if (/db file sequential read/i.test(ev))   return { why: 'Single-block I/O read — often index scan or undo read. Check if index is selective or if table needs caching.', action: 'Review index selectivity, consider larger DB_CACHE_SIZE.' };
  if (/db file scattered read/i.test(ev))    return { why: 'Multi-block I/O — full table scan in progress. Large tables without proper indexes.', action: 'Add indexes or partition the table. Increase db_file_multiblock_read_count.' };
  if (/log file sync/i.test(ev))             return { why: 'Waiting for LGWR to flush redo log to disk on COMMIT. High commit frequency.', action: 'Batch commits, use NOLOGGING where safe, or use faster disk for redo logs.' };
  if (/enq: tx/i.test(ev))                  return { why: 'Row-level lock contention — another session holds a lock on required rows.', action: 'Identify and kill blocking session. Review commit frequency in OLTP workloads.' };
  if (/latch/i.test(ev))                     return { why: 'Shared memory structure contention (latch). High concurrency on hot blocks.', action: 'Increase freelists, use ASSM, partition hot tables, or use RAC.' };
  if (/sql\*net/i.test(ev))                  return { why: 'Network round-trip between client and database. Result set being transferred.', action: 'Reduce fetch size, use connection pooling, move application closer to DB.' };
  if (/cpu/i.test(wc))                       return { why: 'Session is actively consuming CPU — parsing, sorting, or processing large datasets.', action: 'Check for missing indexes, cartesian joins, or inefficient sort operations.' };
  if (/concurrency/i.test(wc))               return { why: 'Waiting for a shared internal resource (buffer busy, cache contention).', action: 'Reduce contention by spreading data access across more blocks.' };
  return { why: `Waiting on: ${event || 'Unknown event'}.`, action: 'Investigate v$session_wait for more details.' };
}

const REFRESH_MS = 5000;

export default function OracleLiveQueriesPage() {
  const { id } = useParams();
  const [search, setSearch]           = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL'); // ALL | ACTIVE | INACTIVE
  const [expanded, setExpanded]       = useState(null);
  const [planData, setPlanData]       = useState({});
  const [planLoading, setPlanLoading] = useState({});
  const [copied, setCopied]           = useState(null);
  const [countdown, setCountdown]     = useState(5);
  const [history, setHistory]         = useState([]);
  const [waitHistory, setWaitHistory] = useState([]);
  const countRef = useRef(null);

  /* ── fetch live queries ── */
  const { data, isLoading, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey:        ['oracleLiveQ', id],
    queryFn:         () => client.get(`/connections/oracle/${id}/oracle-live-queries`).then(r => r.data),
    refetchInterval: REFRESH_MS,
    retry:           false,
  });

  /* ── countdown timer ── */
  useEffect(() => {
    setCountdown(5);
    if (countRef.current) clearInterval(countRef.current);
    countRef.current = setInterval(() => setCountdown(c => c <= 1 ? 5 : c - 1), 1000);
    return () => clearInterval(countRef.current);
  }, [dataUpdatedAt]);

  /* ── build sparkline history ── */
  useEffect(() => {
    if (!data) return;
    const queries = data.queries || [];
    const ts = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const active   = queries.filter(q => q.status === 'ACTIVE').length;
    const waiting  = queries.filter(q => q.wait_event && !/idle/i.test(q.wait_event)).length;
    const maxWait  = Math.max(0, ...queries.map(q => Number(q.seconds_in_wait) || 0));
    const avgWait  = queries.length > 0
      ? (queries.reduce((s, q) => s + (Number(q.seconds_in_wait) || 0), 0) / queries.length)
      : 0;

    setHistory(prev => [...prev.slice(-30), { ts, active, waiting, maxWait, total: queries.length }]);

    // Wait class distribution
    const wc = queries.reduce((acc, q) => {
      const k = q.wait_class || (q.wait_event ? 'Other' : 'CPU');
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    setWaitHistory(prev => [...prev.slice(-20), { ts, ...wc }]);
  }, [data]);

  /* ── fetch execution plan ── */
  const fetchPlan = useCallback(async (sqlId) => {
    if (!sqlId || planData[sqlId]) return;
    setPlanLoading(p => ({ ...p, [sqlId]: true }));
    try {
      const res = await client.get(`/connections/oracle/${id}/oracle-sql-plan?sql_id=${sqlId}`);
      setPlanData(p => ({ ...p, [sqlId]: res.data }));
    } catch {
      setPlanData(p => ({ ...p, [sqlId]: { error: true } }));
    } finally {
      setPlanLoading(p => ({ ...p, [sqlId]: false }));
    }
  }, [id, planData]);

  const toggleExpand = (idx, sqlId) => {
    if (expanded === idx) { setExpanded(null); return; }
    setExpanded(idx);
    if (sqlId) fetchPlan(sqlId);
  };

  const copySQL = (text, key) => {
    navigator.clipboard.writeText(text || '').then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    });
  };

  /* ── helpers ── */
  function fmtIdle(secs) {
    const s = Number(secs) || 0;
    if (s < 60)   return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s/60)}m ago`;
    return `${Math.floor(s/3600)}h ago`;
  }

  /* ── derived ── */
  const queries  = data?.queries  || [];
  const conn     = data?.connection || {};
  const active   = queries.filter(q => q.status === 'ACTIVE').length;
  const inactive = queries.filter(q => q.status === 'INACTIVE').length;
  const waiting  = queries.filter(q => q.wait_event && !/idle/i.test(q.wait_event || '')).length;
  const maxWait  = Math.max(0, ...queries.map(q => Number(q.seconds_in_wait) || 0));
  const blocking = queries.filter(q => q.blocking_session).length;

  const activeOnly   = queries.filter(q => q.status === 'ACTIVE');
  const waitPieData  = Object.entries(
    activeOnly.reduce((acc, q) => {
      const k = q.wait_class || (q.wait_event ? 'Other' : 'CPU');
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {})
  ).map(([name, value]) => ({ name, value }));

  const durationBuckets = [
    { name: '< 1s',  value: activeOnly.filter(q => (Number(q.seconds_in_wait)||0) < 1).length,   fill: C.green  },
    { name: '1–5s',  value: activeOnly.filter(q => { const v=Number(q.seconds_in_wait)||0; return v>=1&&v<5; }).length,  fill: C.amber  },
    { name: '5–30s', value: activeOnly.filter(q => { const v=Number(q.seconds_in_wait)||0; return v>=5&&v<30; }).length, fill: C.orange },
    { name: '30s+',  value: activeOnly.filter(q => (Number(q.seconds_in_wait)||0)>=30).length,    fill: C.red    },
  ];

  const filtered = queries.filter(q => {
    if (statusFilter === 'ACTIVE'   && q.status !== 'ACTIVE')   return false;
    if (statusFilter === 'INACTIVE' && q.status !== 'INACTIVE') return false;
    if (!search) return true;
    const s = search.toLowerCase();
    return [q.username, q.sql_id, q.wait_event, q.machine, q.sql_text, q.status, q.program].some(f =>
      (f || '').toLowerCase().includes(s)
    );
  });

  return (
    <div className="min-h-full bg-brand-bg">

      <PageHeader
        icon={Activity}
        title="Live Query Monitor"
        subtitle={`${conn.name || 'Oracle'} — ${conn.host || ''}:${conn.port || ''}${conn.service_name ? ` / ${conn.service_name}` : ''}`}
        accent="oracle"
        backTo={`/oracle-dashboard/${id}`}
        crumbs={[{ label: 'Databases', to: '/databases' }, { label: 'Oracle', to: `/oracle-dashboard/${id}` }, { label: 'Live Queries' }]}
        actions={(
          <>
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500 text-white text-[10px] font-black">
              <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
              LIVE
            </span>
            <div className="relative">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search queries…"
                className="pl-8 pr-3 py-1.5 w-44 rounded-lg text-xs bg-white/10 border border-white/20 text-white placeholder-white/40 focus:outline-none focus:bg-white/20" />
            </div>
            <button onClick={() => refetch()}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/10 hover:bg-white/20 border border-white/20 text-white">
              <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} />
              <span className="w-5 h-5 rounded-full text-[10px] font-black flex items-center justify-center bg-white/20 text-white">{countdown}</span>
            </button>
          </>
        )}
      />

      <div className="py-5 space-y-4">

        {/* ─── KPI STRIP ─── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-6 gap-3">
          {[
            { label: 'Total Sessions', value: queries.length, color: C.indigo, icon: Users },
            { label: 'Active Now',     value: active,   color: active > 0 ? C.green : C.slate,  icon: Activity,
              sub: active > 0 ? 'executing SQL' : 'none executing' },
            { label: 'Idle Sessions',  value: inactive, color: C.slate,  icon: Clock,
              sub: inactive > 0 ? 'connected, idle' : '—' },
            { label: 'Blocking',       value: blocking, color: blocking > 0 ? C.red : C.green,   icon: Lock,
              sub: blocking > 0 ? 'lock chains!' : 'no locks' },
            { label: 'Max Wait (s)',   value: maxWait > 0 ? maxWait.toFixed(1) : '—',
              color: maxWait > 30 ? C.red : maxWait > 5 ? C.orange : C.slate, icon: TrendingUp,
              sub: maxWait > 30 ? 'critical!' : maxWait > 5 ? 'elevated' : 'normal' },
            { label: 'Auto-Refresh',  value: `${countdown}s`, color: C.teal, icon: RefreshCw,
              sub: 'every 5s' },
          ].map(({ label, value, color, icon: Icon, sub }) => (
            <div key={label} className="bg-white rounded-xl border border-slate-200 p-4"
              style={{ borderLeft: `3px solid ${color}` }}>
              <div className="flex justify-between items-start gap-2">
                <div className="min-w-0">
                  <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{label}</p>
                  <p className="text-[18px] font-black mt-0.5" style={{ color }}>{value}</p>
                  {sub && <p className="text-[9px] text-slate-300 mt-0.5">{sub}</p>}
                </div>
                <Icon size={16} style={{ color, opacity: 0.4 }} className="mt-0.5 flex-shrink-0" />
              </div>
            </div>
          ))}
        </div>

        {/* ─── LIVE CHARTS ─── */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">

          {/* Sessions over time */}
          <div className="bg-white rounded-xl border border-slate-200 p-4 xl:col-span-2">
            <div className="flex justify-between items-center mb-3">
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wide">Sessions Over Time</p>
              <div className="flex items-center gap-3 text-[10px] text-slate-400">
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500" />Active</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-orange-500" />Waiting</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500" />Max Wait(s)</span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={120}>
              <AreaChart data={history}>
                <defs>
                  {[['grad-a', C.green], ['grad-w', C.orange], ['grad-m', C.red]].map(([id, c]) => (
                    <linearGradient key={id} id={id} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor={c} stopOpacity={0.2} />
                      <stop offset="95%" stopColor={c} stopOpacity={0} />
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis dataKey="ts" hide />
                <YAxis hide domain={[0, 'auto']} />
                <Tooltip contentStyle={{ fontSize: 10, padding: '4px 8px', borderRadius: 8 }}
                  labelFormatter={v => `Time: ${v}`} />
                <Area type="monotone" dataKey="active"  stroke={C.green}  fill="url(#grad-a)" strokeWidth={2} dot={false} name="Active" />
                <Area type="monotone" dataKey="waiting" stroke={C.orange} fill="url(#grad-w)" strokeWidth={2} dot={false} name="Waiting" />
                <Area type="monotone" dataKey="maxWait" stroke={C.red}    fill="url(#grad-m)" strokeWidth={1.5} dot={false} name="Max Wait(s)" strokeDasharray="4 2" />
              </AreaChart>
            </ResponsiveContainer>
            <div className="flex justify-between text-[9px] text-slate-300 mt-1">
              <span>{history.length > 0 ? history[0]?.ts : '—'}</span>
              <span>{history.length} samples · 5s interval</span>
            </div>
          </div>

          {/* Wait class pie */}
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-3">Wait Class Distribution</p>
            {waitPieData.length > 0 ? (
              <ResponsiveContainer width="100%" height={140}>
                <PieChart>
                  <Pie data={waitPieData} dataKey="value" nameKey="name"
                    innerRadius={35} outerRadius={55}
                    label={({ name, percent }) => percent > 0.08 ? `${(percent*100).toFixed(0)}%` : ''}>
                    {waitPieData.map((entry, i) => (
                      <Cell key={i} fill={WAIT_COLORS[entry.name] || POOL_COLORS[i % 8]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v, n) => [v, n]} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[140px] text-slate-400">
                <div className="text-center">
                  <CheckCircle2 size={24} className="mx-auto mb-2 text-green-400" />
                  <p className="text-xs">No waits</p>
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-2 mt-2">
              {waitPieData.map((d, i) => (
                <span key={d.name} className="text-[10px] flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ background: WAIT_COLORS[d.name] || '#64748B' }} />
                  {d.name} ({d.value})
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Duration buckets + wait detail bar */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-3">Query Duration Buckets</p>
            <ResponsiveContainer width="100%" height={120}>
              <BarChart data={durationBuckets} barCategoryGap="30%">
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                <Tooltip />
                <Bar dataKey="value" radius={[4,4,0,0]} name="Sessions">
                  {durationBuckets.map((d, i) => <Cell key={i} fill={d.fill} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-3">Top Wait Events</p>
            <div className="space-y-2">
              {(() => {
                const waitMap = queries.reduce((acc, q) => {
                  if (!q.wait_event || /idle/i.test(q.wait_event)) return acc;
                  acc[q.wait_event] = (acc[q.wait_event] || 0) + 1;
                  return acc;
                }, {});
                const sorted = Object.entries(waitMap).sort((a, b) => b[1] - a[1]).slice(0, 5);
                const max = sorted[0]?.[1] || 1;
                return sorted.length > 0 ? sorted.map(([ev, cnt]) => (
                  <div key={ev}>
                    <div className="flex justify-between text-[11px] mb-0.5">
                      <span className="font-semibold text-slate-700 truncate max-w-[70%]">{ev}</span>
                      <span className="font-black text-slate-800">{cnt}</span>
                    </div>
                    <div className="h-1.5 bg-slate-100 rounded-full">
                      <div className="h-1.5 rounded-full" style={{ width: `${(cnt/max)*100}%`, background: waitColor(ev) }} />
                    </div>
                  </div>
                )) : <p className="text-center text-slate-400 text-xs py-4">✓ No active waits</p>;
              })()}
            </div>
          </div>
        </div>

        {/* ─── QUERY TABLE ─── */}
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3"
            style={{ borderLeft: '3px solid #C74634' }}>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <Activity size={14} style={{ color: C.red }} />
                <h3 className="font-black text-slate-800 text-sm uppercase tracking-tight">
                  Sessions ({filtered.length})
                </h3>
                {isFetching && <RefreshCw size={12} className="animate-spin text-slate-400" />}
              </div>
              {/* Status filter tabs */}
              <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-0.5">
                {[['ALL', `All (${queries.length})`], ['ACTIVE', `Active (${active})`], ['INACTIVE', `Idle (${inactive})`]].map(([v, label]) => (
                  <button key={v} onClick={() => setStatusFilter(v)}
                    className={`px-2.5 py-1 rounded-md text-[10px] font-bold transition-all ${
                      statusFilter === v ? 'bg-white text-red-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'
                    }`}>{label}</button>
                ))}
              </div>
            </div>
            <span className="text-[10px] text-slate-400">Click any row for deep analysis + execution plan</span>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <div className="w-10 h-10 border-4 border-red-100 border-t-red-500 rounded-full animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-16">
              <CheckCircle2 size={32} className="mx-auto mb-3 text-green-400" />
              <p className="font-bold text-slate-600">
                {queries.length === 0 ? 'No connected sessions' : `No ${statusFilter === 'ACTIVE' ? 'active' : statusFilter === 'INACTIVE' ? 'idle' : ''} sessions match`}
              </p>
              <p className="text-xs text-slate-400 mt-1">
                {queries.length === 0 ? 'No user sessions found — Oracle may be idle or no clients are connected'
                  : `${queries.length} total sessions — try a different filter`}
              </p>
            </div>
          ) : (
            <div>
              {/* Table header */}
              <div className="grid gap-0 text-[10px] font-bold text-slate-400 uppercase tracking-wide bg-slate-50 border-b border-slate-200 px-4 py-2"
                style={{ gridTemplateColumns: '55px 100px 85px 105px 170px 75px 120px 1fr 40px' }}>
                <span>SID</span>
                <span>Username</span>
                <span>Status</span>
                <span>SQL ID</span>
                <span>Wait / State</span>
                <span>Wait/Idle</span>
                <span>Machine</span>
                <span>SQL Preview</span>
                <span></span>
              </div>

              {filtered.map((q, i) => {
                const isExp      = expanded === i;
                const isActive   = q.status === 'ACTIVE';
                const waitSecs   = Number(q.seconds_in_wait) || 0;
                const idleSecs   = Number(q.last_call_et) || 0;
                const wcolor     = isActive ? waitColor(q.wait_event) : C.slate;
                const effectiveSql = q.sql_text || q.sql_fulltext || '';
                const displaySqlId = q.sql_id || q.prev_sql_id || '';
                const plan       = planData[q.sql_id];
                const planLoad   = planLoading[q.sql_id];
                const { why, action } = waitExplain(q.wait_event, q.wait_class);

                return (
                  <div key={i} className={`border-b border-slate-100 ${isExp ? 'bg-slate-50' : ''} ${!isActive ? 'opacity-75' : ''}`}>
                    {/* Row */}
                    <div
                      className={`grid items-center gap-0 px-4 py-2.5 cursor-pointer hover:opacity-100 hover:bg-slate-50/80 transition-all text-xs ${
                        q.blocking_session ? 'bg-red-50/50' : isActive ? '' : ''
                      }`}
                      style={{ gridTemplateColumns: '55px 100px 85px 105px 170px 75px 120px 1fr 40px' }}
                      onClick={() => toggleExpand(i, q.sql_id || q.prev_sql_id)}>

                      <span className="font-mono text-slate-500 text-[11px]">{q.sid}</span>

                      <span className={`font-black truncate text-[11px] ${isActive ? 'text-red-700' : 'text-slate-500'}`}>
                        {q.username || 'SYS'}
                      </span>

                      <span>
                        {isActive ? (
                          <span className="flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                            <span className="text-[10px] font-black text-green-700">ACTIVE</span>
                          </span>
                        ) : (
                          <span className="text-[10px] font-bold text-slate-400">
                            idle {fmtIdle(idleSecs)}
                          </span>
                        )}
                      </span>

                      <span className="font-mono text-[10px] text-indigo-600 truncate">{displaySqlId || '—'}</span>

                      <span className="flex items-center gap-1.5">
                        {isActive ? (
                          <>
                            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: wcolor }} />
                            <span className="truncate text-[10px]" style={{ color: wcolor }}>
                              {q.wait_event || 'On CPU'}
                            </span>
                          </>
                        ) : (
                          <span className="text-[10px] text-slate-400 italic">
                            {q.state || 'WAITING'} for client
                          </span>
                        )}
                      </span>

                      <span className={`font-black text-sm ${
                        isActive && waitSecs > 30 ? 'text-red-600' :
                        isActive && waitSecs > 5  ? 'text-orange-500' :
                        isActive ? 'text-green-600' : 'text-slate-400'
                      }`}>
                        {isActive && waitSecs > 0 ? `${waitSecs}s`
                          : !isActive && idleSecs > 0 ? fmtIdle(idleSecs)
                          : '—'}
                      </span>

                      <span className="text-[10px] text-slate-400 truncate">{(q.machine || '').split('\\').pop()?.slice(0, 16) || '—'}</span>

                      <span className="font-mono text-[10px] text-slate-500 truncate">
                        {isActive ? (effectiveSql || '—').slice(0, 65)
                          : effectiveSql ? `[last] ${effectiveSql.slice(0, 55)}` : '(no recent SQL)'}
                      </span>

                      <span className="flex items-center justify-end">
                        {isExp ? <ChevronUp size={14} className="text-slate-400" /> : <ChevronDown size={14} className="text-slate-400" />}
                      </span>
                    </div>

                    {/* ── EXPANDED DEEP ANALYSIS ── */}
                    {isExp && (
                      <div className="px-4 pb-5 bg-slate-50 border-t border-slate-100 space-y-4">

                        {/* Session meta */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3">
                          {[
                            ['SID / Serial',  `${q.sid} / ${q.serial_number || '—'}`],
                            ['OS User',        q.osuser || '—'],
                            ['Program',       (q.program || '—').slice(0, 35)],
                            ['Module',        (q.module  || '—').slice(0, 30)],
                            ['Machine',        q.machine  || '—'],
                            ['Logon Time',     q.logon_time || '—'],
                            ['Last Call',      idleSecs > 0 ? fmtIdle(idleSecs) : '—'],
                            ['Status',         q.status || '—'],
                          ].map(([l, v]) => (
                            <div key={l} className="bg-white rounded-lg p-3 border border-slate-200">
                              <p className="text-[10px] text-slate-400 font-bold uppercase">{l}</p>
                              <p className="text-xs font-bold text-slate-700 mt-0.5 break-all">{v}</p>
                            </div>
                          ))}
                        </div>

                        {/* ── WAIT ANALYSIS ── */}
                        <div className="bg-gradient-to-r from-orange-50 to-amber-50 border border-orange-200 rounded-xl p-4">
                          <div className="flex items-center gap-2 mb-3">
                            <div className="w-6 h-6 rounded-lg bg-orange-100 flex items-center justify-center">
                              <AlertTriangle size={13} className="text-orange-600" />
                            </div>
                            <h4 className="font-black text-orange-800 text-sm">Wait Analysis</h4>
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 font-bold">
                              {q.wait_event || 'CPU'} · {q.wait_class || 'On CPU'}
                            </span>
                          </div>
                          <div className="grid sm:grid-cols-2 gap-3">
                            <div>
                              <p className="text-[10px] font-black text-orange-700 uppercase mb-1">Why is this waiting?</p>
                              <p className="text-xs text-orange-900 leading-relaxed">{why}</p>
                            </div>
                            <div>
                              <p className="text-[10px] font-black text-orange-700 uppercase mb-1">Recommended Action</p>
                              <p className="text-xs text-orange-900 leading-relaxed">{action}</p>
                            </div>
                          </div>
                        </div>

                        {/* ── FULL SQL ── */}
                        <div className="bg-slate-900 rounded-xl overflow-hidden">
                          <div className="flex items-center justify-between px-4 py-2 border-b border-slate-700">
                            <div className="flex items-center gap-2">
                              <FileText size={12} className="text-green-400" />
                              <span className="text-green-400 text-[11px] font-bold">
                                {isActive ? 'Current SQL' : 'Last Executed SQL'} — SID {q.sid} / {q.username}
                              </span>
                              {!isActive && q.prev_sql_id && (
                                <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400">
                                  prev_sql_id: {q.prev_sql_id}
                                </span>
                              )}
                            </div>
                            <button
                              onClick={() => copySQL(q.sql_fulltext || q.sql_text || effectiveSql, `sql-${i}`)}
                              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold bg-slate-700 hover:bg-slate-600 text-white transition-colors">
                              {copied === `sql-${i}` ? <CheckCheck size={10} className="text-green-400" /> : <Copy size={10} />}
                              {copied === `sql-${i}` ? 'Copied!' : 'Copy'}
                            </button>
                          </div>
                          <pre className="p-4 text-green-300 text-[11px] font-mono whitespace-pre-wrap break-all max-h-52 overflow-y-auto leading-relaxed">
                            {q.sql_fulltext || q.sql_text || effectiveSql || '— No recent SQL (session is idle / waiting for client) —'}
                          </pre>
                        </div>

                        {/* ── EXECUTION PLAN ── */}
                        {displaySqlId && (
                          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                            <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100 bg-slate-50">
                              <BarChart2 size={13} className="text-indigo-600" />
                              <h4 className="font-black text-slate-800 text-sm">Execution Plan</h4>
                              <span className="text-[10px] text-slate-400">SQL ID: {q.sql_id}</span>
                              {planLoad && <RefreshCw size={11} className="animate-spin text-slate-400 ml-1" />}
                            </div>

                            {planLoad ? (
                              <div className="flex items-center justify-center py-8">
                                <div className="w-8 h-8 border-3 border-indigo-100 border-t-indigo-500 rounded-full animate-spin" />
                                <span className="ml-3 text-xs text-slate-400">Loading execution plan…</span>
                              </div>
                            ) : plan?.error ? (
                              <p className="text-center text-slate-400 text-xs py-6">Execution plan not available for this SQL ID</p>
                            ) : plan ? (
                              <div>
                                {/* SQL stats row */}
                                {plan.sql_stats && (
                                  <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 p-4 border-b border-slate-100">
                                    {[
                                      ['Executions',   fmtNum(plan.sql_stats.executions)],
                                      ['Elapsed (ms)', fmtNum(plan.sql_stats.elapsed_ms)],
                                      ['CPU (ms)',     fmtNum(plan.sql_stats.cpu_ms)],
                                      ['Buf Gets',     fmtNum(plan.sql_stats.buffer_gets)],
                                      ['Disk Reads',   fmtNum(plan.sql_stats.disk_reads)],
                                      ['Avg (ms)',     fmtNum(plan.sql_stats.avg_elapsed_ms)],
                                    ].map(([l, v]) => (
                                      <div key={l} className="text-center">
                                        <p className="text-[10px] text-slate-400 font-bold uppercase">{l}</p>
                                        <p className="text-sm font-black text-slate-800 mt-0.5">{v}</p>
                                      </div>
                                    ))}
                                  </div>
                                )}

                                {/* Index usage */}
                                {plan.indexes_used?.length > 0 && (
                                  <div className="px-4 py-3 border-b border-slate-100 bg-blue-50/50">
                                    <p className="text-[10px] font-black text-blue-700 uppercase mb-2 flex items-center gap-1.5">
                                      <Database size={10} /> Indexes Used ({plan.indexes_used.length})
                                    </p>
                                    <div className="flex flex-wrap gap-2">
                                      {plan.indexes_used.map((idx, j) => (
                                        <div key={j} className="bg-white border border-blue-200 rounded-lg px-3 py-1.5">
                                          <p className="font-black text-blue-800 text-[11px]">{idx.index_name}</p>
                                          <p className="text-[10px] text-blue-600">{idx.operation} · Cost: {idx.cost ?? '—'}</p>
                                          {idx.access && <p className="text-[10px] text-slate-500 mt-0.5 truncate max-w-[200px]">Access: {idx.access}</p>}
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                {/* Plan steps */}
                                {plan.plan?.length > 0 ? (
                                  <div className="overflow-x-auto">
                                    <table className="w-full text-xs">
                                      <thead>
                                        <tr className="bg-slate-50 border-b border-slate-200">
                                          {['ID','Operation','Object','Type','Cost','Rows','Bytes','Access Predicate','Filter Predicate'].map(h => (
                                            <th key={h} className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                                          ))}
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {plan.plan.map((step, j) => (
                                          <tr key={j} className={`border-b border-slate-100 ${j % 2 === 1 ? 'bg-slate-50/40' : ''} ${(step.object_type||'').toUpperCase().includes('INDEX') ? 'bg-blue-50/30' : ''}`}>
                                            <td className="px-3 py-2 font-mono text-slate-400">{step.id}</td>
                                            <td className="px-3 py-2">
                                              <span style={{ paddingLeft: (step.depth || 0) * 12 }}
                                                className={`font-semibold ${step.object_type?.includes('INDEX') ? 'text-blue-700' : 'text-slate-700'}`}>
                                                {step.operation} {step.options || ''}
                                              </span>
                                            </td>
                                            <td className="px-3 py-2 font-bold text-indigo-700">{step.object_name || '—'}</td>
                                            <td className="px-3 py-2 text-[10px] text-slate-500">{step.object_type || '—'}</td>
                                            <td className="px-3 py-2 font-mono">{step.cost ?? '—'}</td>
                                            <td className="px-3 py-2 font-mono">{fmtNum(step.cardinality)}</td>
                                            <td className="px-3 py-2 font-mono">{fmtNum(step.bytes)}</td>
                                            <td className="px-3 py-2 text-[10px] text-green-700 max-w-[160px] truncate">{step.access_predicates || '—'}</td>
                                            <td className="px-3 py-2 text-[10px] text-orange-700 max-w-[160px] truncate">{step.filter_predicates || '—'}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                ) : (
                                  <p className="text-center text-slate-400 text-xs py-6">No plan steps found — SQL may be cached without a plan</p>
                                )}
                              </div>
                            ) : (
                              <div className="flex items-center justify-center py-8">
                                <div className="w-8 h-8 border-3 border-indigo-100 border-t-indigo-500 rounded-full animate-spin" />
                              </div>
                            )}
                          </div>
                        )}

                        {/* ── COLUMN / OBJECT STATS ── */}
                        {plan?.wait_info && Object.keys(plan.wait_info).length > 0 && (
                          <div className="bg-gradient-to-r from-indigo-50 to-purple-50 border border-indigo-200 rounded-xl p-4">
                            <p className="text-[10px] font-black text-indigo-700 uppercase mb-3 flex items-center gap-1.5">
                              <Info size={11} /> Session Wait State (from v$session)
                            </p>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                              {[
                                ['State',       plan.wait_info.state],
                                ['Wait Event',  plan.wait_info.wait_event],
                                ['Wait Class',  plan.wait_info.wait_class],
                                ['Seconds',     plan.wait_info.seconds_in_wait?.toFixed(1)],
                              ].map(([l, v]) => (
                                <div key={l}>
                                  <p className="text-[10px] text-indigo-500 font-bold uppercase">{l}</p>
                                  <p className="text-xs font-black text-indigo-900 mt-0.5">{v || '—'}</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

