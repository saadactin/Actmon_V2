import React, { useState, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, RefreshCw, Clock, AlertTriangle, Search, Filter,
  ChevronDown, ChevronRight, Check, Copy, Download, Terminal,
  Zap, Activity, Database, BarChart2, FileText, AlertCircle,
  Info, TrendingDown, Eye, Inbox, Settings, Brain, XCircle,
  CheckCircle2, Lightbulb, RotateCcw,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from 'recharts';
import client from '../../api/client';

// ── palette ──────────────────────────────────────────────────────────────────
const C = { green: '#00ED64', dark: '#00684A', navy: '#001E2B', emerald: '#00C851', teal: '#14B8A6', blue: '#3B82F6', orange: '#F97316', red: '#EF4444', yellow: '#EAB308', purple: '#8B5CF6' };

// ── API ───────────────────────────────────────────────────────────────────────
const fetchSlowOps   = (id) => client.get(`/connections/mongodb/${id}/mongo-slow-operations`).then(r => r.data);
const fetchProfiler  = (id) => client.get(`/connections/mongodb/${id}/mongo-profiler`).then(r => r.data);
const analyzeGroq    = (id, payload) => client.post(`/connections/mongodb/${id}/mongo-slow-ops/analyze-groq`, payload).then(r => r.data);

// ── helpers ───────────────────────────────────────────────────────────────────
function fmtMs(ms) {
  const m = Number(ms) || 0;
  if (m >= 60000) return `${(m / 60000).toFixed(1)}m`;
  if (m >= 1000)  return `${(m / 1000).toFixed(2)}s`;
  return `${m}ms`;
}
function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}
function getDuration(op) {
  return op.millis != null ? Number(op.millis) : (Number(op.secs_running) || 0) * 1000;
}
function durColor(ms) {
  if (ms >= 30000) return 'text-red-600 font-black';
  if (ms >= 5000)  return 'text-orange-500 font-bold';
  if (ms >= 1000)  return 'text-yellow-600 font-bold';
  return 'text-slate-600';
}
function durBg(ms) {
  if (ms >= 30000) return 'bg-red-50/60';
  if (ms >= 5000)  return 'bg-orange-50/50';
  if (ms >= 1000)  return 'bg-yellow-50/40';
  return '';
}
function sevLabel(ms) {
  if (ms >= 30000) return { label: 'Critical', cls: 'bg-red-100 text-red-700 border-red-200' };
  if (ms >= 5000)  return { label: 'High',     cls: 'bg-orange-100 text-orange-700 border-orange-200' };
  if (ms >= 1000)  return { label: 'Medium',   cls: 'bg-yellow-100 text-yellow-700 border-yellow-200' };
  return             { label: 'Low',      cls: 'bg-green-100 text-green-700 border-green-200' };
}

// ── sub-components ────────────────────────────────────────────────────────────
function KpiCard({ icon: Icon, label, value, accent, sub }) {
  const borders = { red: 'border-l-red-500', orange: 'border-l-orange-400', green: 'border-l-green-500', blue: 'border-l-blue-500', slate: 'border-l-slate-300' };
  return (
    <div className={`bg-white rounded-2xl border border-slate-200 border-l-4 ${borders[accent] || borders.slate} p-4 hover:shadow-md transition-all`}>
      <div className="flex justify-between items-start">
        <div>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{label}</p>
          <p className="text-xl font-black text-slate-800 mt-1">{value}</p>
          {sub && <p className="text-[10px] text-slate-400 mt-0.5">{sub}</p>}
        </div>
        <Icon size={18} className="text-slate-300 flex-shrink-0" />
      </div>
    </div>
  );
}

function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      className="flex-shrink-0 flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold transition-all"
      style={copied ? { background: '#dcfce7', color: '#166534', border: '1px solid #bbf7d0' } : { background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0' }}>
      {copied ? <Check size={10} /> : <Copy size={10} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function TabBtn({ active, onClick, icon: Icon, label, badge }) {
  return (
    <button onClick={onClick}
      className={`relative flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-t-xl whitespace-nowrap border-b-2 transition-all ${
        active ? 'border-green-500 text-green-700 bg-white' : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50'
      }`}>
      <Icon size={14} />
      {label}
      {badge > 0 && (
        <span className="absolute -top-1 -right-1 h-4 min-w-4 px-0.5 flex items-center justify-center rounded-full bg-red-500 text-white text-[9px] font-black">{badge}</span>
      )}
    </button>
  );
}

function ExpandedRow({ op }) {
  const ms = getDuration(op);
  const filterStr = op.filter ? JSON.stringify(op.filter, null, 2) : (op.query ? JSON.stringify(op.query, null, 2) : null);
  const plan = op.planSummary || op.plan_summary || null;
  return (
    <div className="px-4 py-3 bg-slate-50 border-t border-slate-100 space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        {[
          ['Duration', fmtMs(ms)],
          ['Docs Examined', fmtNum(op.docsExamined || 0)],
          ['Keys Examined', fmtNum(op.keysExamined || 0)],
          ['Docs Returned', fmtNum(op.nreturned || 0)],
          ['Client',  op.client || '—'],
          ['App',     op.appName || '—'],
          ['Op ID',   op.opid || '—'],
          ['Lock Wait', op.waitingForLock ? 'Yes' : 'No'],
        ].map(([k, v]) => (
          <div key={k} className="bg-white rounded-lg p-2.5 border border-slate-100">
            <p className="text-[10px] text-slate-400 font-bold uppercase">{k}</p>
            <p className="font-mono font-semibold text-slate-700 mt-0.5 truncate">{v}</p>
          </div>
        ))}
      </div>
      {plan && (
        <div className="bg-white rounded-xl border border-slate-200 p-3">
          <p className="text-[10px] font-bold text-slate-400 uppercase mb-1.5">Query Plan</p>
          <p className="font-mono text-xs text-slate-600">{plan}</p>
        </div>
      )}
      {filterStr && (
        <div className="bg-white rounded-xl border border-slate-200 p-3">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[10px] font-bold text-slate-400 uppercase">Query Filter</p>
            <CopyBtn text={filterStr} />
          </div>
          <pre className="font-mono text-xs text-slate-600 overflow-x-auto whitespace-pre-wrap max-h-32">{filterStr}</pre>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function SlowOperations() {
  const { id } = useParams();
  const [tab,       setTab]       = useState('overview');
  const [search,    setSearch]    = useState('');
  const [nsFilter,  setNsFilter]  = useState('');
  const [srcFilter, setSrcFilter] = useState('all');
  const [minMs,     setMinMs]     = useState(100);
  const [sortCol,   setSortCol]   = useState('duration');
  const [sortDir,   setSortDir]   = useState('desc');
  const [expanded,  setExpanded]  = useState(null);
  const [dbFilter,  setDbFilter]  = useState('');

  const { data: slowData, isLoading: slowLoading, refetch: refetchSlow, isFetching } = useQuery({
    queryKey: ['mongoSlowOps', id],
    queryFn:  () => fetchSlowOps(id),
    retry: false,
    refetchInterval: 15000,
  });

  const { data: profData, isLoading: profLoading, refetch: refetchProf } = useQuery({
    queryKey: ['mongoProfilerDetail', id],
    queryFn:  () => fetchProfiler(id),
    retry: false,
    refetchInterval: 20000,
    enabled: tab === 'profiler',
  });

  // ── computed ──────────────────────────────────────────────────────────────
  const allOps = useMemo(() => (slowData?.all_ops || []), [slowData]);

  const filtered = useMemo(() => {
    let list = allOps;
    if (srcFilter !== 'all') list = list.filter(o => o.source === srcFilter);
    if (nsFilter)  list = list.filter(o => (o.ns || '').toLowerCase().includes(nsFilter.toLowerCase()));
    if (search)    list = list.filter(o => (o.ns || '').toLowerCase().includes(search.toLowerCase()) || (o.op || '').toLowerCase().includes(search.toLowerCase()));
    list = list.filter(o => getDuration(o) >= minMs);
    list = [...list].sort((a, b) => {
      let av = 0, bv = 0;
      if (sortCol === 'duration')     { av = getDuration(a); bv = getDuration(b); }
      else if (sortCol === 'docs')    { av = a.docsExamined || 0; bv = b.docsExamined || 0; }
      else if (sortCol === 'keys')    { av = a.keysExamined || 0; bv = b.keysExamined || 0; }
      else if (sortCol === 'returned'){ av = a.nreturned || 0; bv = b.nreturned || 0; }
      return sortDir === 'desc' ? bv - av : av - bv;
    });
    return list;
  }, [allOps, srcFilter, nsFilter, search, minMs, sortCol, sortDir]);

  const kpis = useMemo(() => {
    const critical = allOps.filter(o => getDuration(o) >= 30000).length;
    const high     = allOps.filter(o => { const d = getDuration(o); return d >= 5000 && d < 30000; }).length;
    const avgMs    = allOps.length ? Math.round(allOps.reduce((a, o) => a + getDuration(o), 0) / allOps.length) : 0;
    const maxMs    = allOps.length ? Math.max(...allOps.map(o => getDuration(o))) : 0;
    return { critical, high, avgMs, maxMs };
  }, [allOps]);

  const opTypeData = useMemo(() => {
    const m = {};
    allOps.forEach(o => { const k = o.op || 'other'; m[k] = (m[k] || 0) + 1; });
    return Object.entries(m).map(([name, value]) => ({ name, value }));
  }, [allOps]);

  const durBuckets = useMemo(() => {
    const b = { '100ms-1s': 0, '1s-5s': 0, '5s-30s': 0, '30s+': 0 };
    allOps.forEach(o => {
      const ms = getDuration(o);
      if (ms < 1000) b['100ms-1s']++;
      else if (ms < 5000) b['1s-5s']++;
      else if (ms < 30000) b['5s-30s']++;
      else b['30s+']++;
    });
    return Object.entries(b).map(([range, count]) => ({ range, count }));
  }, [allOps]);

  const top10 = useMemo(() => [...allOps].sort((a, b) => getDuration(b) - getDuration(a)).slice(0, 10), [allOps]);

  const nsDistrib = useMemo(() => {
    const m = {};
    allOps.forEach(o => { const k = o.ns || 'unknown'; m[k] = (m[k] || 0) + 1; });
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([ns, count]) => ({ ns, count }));
  }, [allOps]);

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortCol(col); setSortDir('desc'); }
  };

  const SortIcon = ({ col }) => (
    <span className="ml-1 text-[10px]">{sortCol === col ? (sortDir === 'desc' ? '▼' : '▲') : '↕'}</span>
  );

  const exportCSV = () => {
    const headers = ['Source', 'Op', 'Namespace', 'Duration(ms)', 'DocsExamined', 'KeysExamined', 'DocsReturned', 'Plan', 'Client', 'Timestamp'];
    const rows = filtered.map(o => [
      o.source || '', o.op || '', o.ns || '', getDuration(o),
      o.docsExamined || 0, o.keysExamined || 0, o.nreturned || 0,
      o.planSummary || '', o.client || '', o.ts || '',
    ]);
    const csv = [headers, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `mongodb-slow-ops-${id}.csv`;
    a.click();
  };

  // ── loading ───────────────────────────────────────────────────────────────
  if (slowLoading) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="text-center">
        <div className="w-10 h-10 border-4 border-green-200 border-t-green-600 rounded-full animate-spin mx-auto mb-3" />
        <p className="text-slate-500 font-semibold text-sm">Loading slow operations…</p>
      </div>
    </div>
  );

  const PIE_COLORS = [C.green, C.blue, C.orange, C.red, C.purple, C.teal, C.yellow];

  return (
    <div className="min-h-screen bg-slate-50">

      {/* ── Header ── */}
      <div style={{ background: `linear-gradient(135deg, ${C.navy} 0%, #0a2d1f 60%, #003d2a 100%)` }} className="text-white px-6 py-5 shadow-2xl">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-4">
            <Link to={`/mongodb-dashboard/${id}`}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all"
              style={{ background: 'rgba(0,237,100,0.12)', color: C.green, border: '1px solid rgba(0,237,100,0.25)' }}>
              <ArrowLeft size={13} /> Dashboard
            </Link>
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl flex items-center justify-center text-xl"
                style={{ background: 'rgba(0,237,100,0.15)', border: '1px solid rgba(0,237,100,0.35)' }}>🐢</div>
              <div>
                <h1 className="text-xl font-black">Slow Operations</h1>
                <p className="text-xs mt-0.5" style={{ color: C.green }}>MongoDB · Connection #{id}</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {allOps.length > 0 && (
              <button onClick={exportCSV}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all"
                style={{ background: 'rgba(0,237,100,0.1)', borderColor: 'rgba(0,237,100,0.3)' }}>
                <Download size={12} /> Export CSV
              </button>
            )}
            <button onClick={() => refetchSlow()}
              className="flex items-center gap-2 px-4 py-1.5 rounded-xl text-sm font-semibold border transition-all"
              style={{ background: 'rgba(0,237,100,0.1)', borderColor: 'rgba(0,237,100,0.3)' }}>
              <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>

        {/* KPI strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Total Slow Ops', value: allOps.length, color: allOps.length > 0 ? C.red : C.green },
            { label: 'Critical (>30s)', value: kpis.critical, color: kpis.critical > 0 ? C.red : C.green },
            { label: 'Avg Duration', value: fmtMs(kpis.avgMs), color: C.orange },
            { label: 'Max Duration', value: fmtMs(kpis.maxMs), color: kpis.maxMs > 30000 ? C.red : C.orange },
          ].map(k => (
            <div key={k.label} className="rounded-2xl px-4 py-3" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}>
              <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: 'rgba(255,255,255,0.5)' }}>{k.label}</p>
              <p className="text-2xl font-black mt-0.5" style={{ color: k.color }}>{k.value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Tab bar ── */}
      <div className="bg-white border-b border-slate-200 px-6 flex gap-1 overflow-x-auto">
        <TabBtn active={tab === 'overview'}    onClick={() => setTab('overview')}    icon={Activity}  label="Overview" />
        <TabBtn active={tab === 'explorer'}    onClick={() => setTab('explorer')}    icon={Search}    label="Operation Explorer" badge={filtered.length} />
        <TabBtn active={tab === 'profiler'}    onClick={() => setTab('profiler')}    icon={Terminal}  label="Profiler" />
        <TabBtn active={tab === 'reports'}     onClick={() => setTab('reports')}     icon={FileText}  label="Reports" />
        <TabBtn active={tab === 'aianalysis'}  onClick={() => setTab('aianalysis')}  icon={Brain}     label="AI Analysis" />
      </div>

      {/* ── Content ── */}
      <div className="p-5">

        {/* ════ OVERVIEW ════ */}
        {tab === 'overview' && (
          <div className="space-y-5">
            {allOps.length === 0 ? (
              <div className="bg-white rounded-2xl border border-slate-200 py-20 flex flex-col items-center text-center">
                <div className="h-16 w-16 rounded-2xl flex items-center justify-center text-3xl mb-4" style={{ background: 'rgba(0,237,100,0.1)' }}>✅</div>
                <p className="font-bold text-slate-700 text-lg">No slow operations detected</p>
                <p className="text-slate-400 text-sm mt-1">Everything running within normal thresholds.</p>
                <p className="text-xs text-slate-400 mt-1">{slowData?.note || 'Enable profiling for historical data.'}</p>
              </div>
            ) : (
              <>
                {/* Severity breakdown */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {[
                    { label: 'Critical (>30s)', count: allOps.filter(o => getDuration(o) >= 30000).length, cls: 'bg-red-50 border-red-200 text-red-700' },
                    { label: 'High (5s–30s)',   count: allOps.filter(o => { const d = getDuration(o); return d >= 5000 && d < 30000; }).length, cls: 'bg-orange-50 border-orange-200 text-orange-700' },
                    { label: 'Medium (1s–5s)', count: allOps.filter(o => { const d = getDuration(o); return d >= 1000 && d < 5000; }).length, cls: 'bg-yellow-50 border-yellow-200 text-yellow-700' },
                    { label: 'Low (<1s)',       count: allOps.filter(o => getDuration(o) < 1000).length, cls: 'bg-green-50 border-green-200 text-green-700' },
                  ].map(s => (
                    <div key={s.label} className={`rounded-2xl border p-4 ${s.cls}`}>
                      <p className="text-[10px] font-bold uppercase tracking-wide opacity-70">{s.label}</p>
                      <p className="text-3xl font-black mt-1">{s.count}</p>
                    </div>
                  ))}
                </div>

                {/* Charts row */}
                <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                  {/* Duration distribution */}
                  <div className="bg-white rounded-2xl border border-slate-200 p-5">
                    <h3 className="font-bold text-slate-800 text-sm mb-4">Duration Distribution</h3>
                    <ResponsiveContainer width="100%" height={180}>
                      <BarChart data={durBuckets}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                        <XAxis dataKey="range" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                        <Tooltip cursor={{ fill: '#f8fafc' }} />
                        <Bar dataKey="count" radius={[5, 5, 0, 0]}>
                          {durBuckets.map((_, i) => <Cell key={i} fill={[C.green, C.yellow, C.orange, C.red][i]} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Op type pie */}
                  <div className="bg-white rounded-2xl border border-slate-200 p-5">
                    <h3 className="font-bold text-slate-800 text-sm mb-4">Operation Types</h3>
                    <ResponsiveContainer width="100%" height={180}>
                      <PieChart>
                        <Pie data={opTypeData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70}
                          label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                          {opTypeData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Top namespaces */}
                  <div className="bg-white rounded-2xl border border-slate-200 p-5">
                    <h3 className="font-bold text-slate-800 text-sm mb-4">Top Namespaces</h3>
                    <div className="space-y-2">
                      {nsDistrib.slice(0, 6).map((d, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <span className="text-[10px] font-mono text-slate-600 truncate flex-1 max-w-[160px]">{d.ns}</span>
                          <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden max-w-[80px]">
                            <div className="h-full rounded-full" style={{ width: `${(d.count / (nsDistrib[0]?.count || 1)) * 100}%`, background: C.green }} />
                          </div>
                          <span className="text-xs font-bold text-slate-700 w-6 text-right">{d.count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Top 10 slowest */}
                <div className="bg-white rounded-2xl border border-slate-200 p-5">
                  <h3 className="font-bold text-slate-800 text-sm mb-4">Top 10 Slowest Operations</h3>
                  <div className="space-y-2">
                    {top10.map((op, i) => {
                      const ms = getDuration(op);
                      const sev = sevLabel(ms);
                      return (
                        <div key={i} className={`flex items-center gap-3 p-3 rounded-xl border ${i === 0 ? 'border-red-200 bg-red-50/30' : 'border-slate-100 bg-slate-50/30'}`}>
                          <span className="flex-shrink-0 h-6 w-6 rounded-full bg-slate-200 flex items-center justify-center text-[10px] font-black text-slate-600">
                            {i + 1}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-bold text-slate-700 truncate">{op.ns || '—'}</p>
                            <p className="text-[10px] text-slate-400">{op.op || '—'} · {op.planSummary || 'no plan'}</p>
                          </div>
                          <span className={`px-2 py-0.5 rounded-full border text-[10px] font-bold ${sev.cls}`}>{sev.label}</span>
                          <span className={`text-sm font-black ${durColor(ms)}`}>{fmtMs(ms)}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ════ EXPLORER ════ */}
        {tab === 'explorer' && (
          <div className="space-y-4">
            {/* Filter bar */}
            <div className="bg-white rounded-2xl border border-slate-200 p-4 flex flex-wrap items-center gap-3">
              <div className="relative">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Search namespace or op type…"
                  className="h-9 pl-8 pr-4 w-56 rounded-xl border border-slate-200 text-sm outline-none focus:border-green-400" />
              </div>
              <div className="relative">
                <Filter size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input value={nsFilter} onChange={e => setNsFilter(e.target.value)}
                  placeholder="Filter namespace…"
                  className="h-9 pl-8 pr-4 w-44 rounded-xl border border-slate-200 text-sm outline-none focus:border-green-400" />
              </div>
              <select value={srcFilter} onChange={e => setSrcFilter(e.target.value)}
                className="h-9 px-3 rounded-xl border border-slate-200 text-sm outline-none focus:border-green-400 bg-white">
                <option value="all">All Sources</option>
                <option value="currentOp">Current Operations</option>
                <option value="profiler">Profiler History</option>
              </select>
              <div className="flex items-center gap-2">
                <Clock size={13} className="text-slate-400" />
                <span className="text-xs text-slate-500 font-semibold">Min:</span>
                <input type="number" value={minMs} onChange={e => setMinMs(Number(e.target.value) || 0)}
                  className="h-9 w-20 px-3 rounded-xl border border-slate-200 text-sm outline-none focus:border-green-400" />
                <span className="text-xs text-slate-400">ms</span>
              </div>
              <span className="text-xs text-slate-400 ml-auto">{filtered.length} results</span>
            </div>

            {/* Table */}
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="w-8 px-3 py-3" />
                      {[
                        { col: null,       label: 'Source' },
                        { col: null,       label: 'Op' },
                        { col: null,       label: 'Namespace' },
                        { col: 'duration', label: 'Duration' },
                        { col: 'docs',     label: 'Docs Exam.' },
                        { col: 'keys',     label: 'Keys Exam.' },
                        { col: 'returned', label: 'Returned' },
                        { col: null,       label: 'Plan' },
                        { col: null,       label: 'Timestamp' },
                      ].map(({ col, label }) => (
                        <th key={label}
                          onClick={col ? () => toggleSort(col) : undefined}
                          className={`px-3 py-3 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap ${col ? 'cursor-pointer hover:text-slate-600' : ''}`}>
                          {label}{col && <SortIcon col={col} />}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.slice(0, 200).map((op, i) => {
                      const ms  = getDuration(op);
                      const sev = sevLabel(ms);
                      const isOpen = expanded === i;
                      return (
                        <React.Fragment key={i}>
                          <tr
                            onClick={() => setExpanded(isOpen ? null : i)}
                            className={`border-t border-slate-100 cursor-pointer hover:bg-slate-50 ${durBg(ms)}`}>
                            <td className="px-3 py-2.5 text-slate-400">
                              {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                            </td>
                            <td className="px-3 py-2.5">
                              <span className={`px-2 py-0.5 rounded text-[9px] font-bold ${op.source === 'currentOp' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'}`}>
                                {op.source === 'currentOp' ? 'Live' : 'History'}
                              </span>
                            </td>
                            <td className="px-3 py-2.5">
                              <span className="px-2 py-0.5 rounded-full text-[9px] font-bold"
                                style={{ background: 'rgba(0,237,100,0.1)', color: C.dark }}>
                                {op.op || '—'}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 font-mono text-slate-600 max-w-[200px] truncate">{op.ns || '—'}</td>
                            <td className={`px-3 py-2.5 text-sm ${durColor(ms)}`}>{fmtMs(ms)}</td>
                            <td className="px-3 py-2.5 font-mono">{fmtNum(op.docsExamined || 0)}</td>
                            <td className="px-3 py-2.5 font-mono">{fmtNum(op.keysExamined || 0)}</td>
                            <td className="px-3 py-2.5 font-mono">{fmtNum(op.nreturned || 0)}</td>
                            <td className="px-3 py-2.5 text-[10px] text-slate-400 max-w-[120px] truncate">{op.planSummary || '—'}</td>
                            <td className="px-3 py-2.5 font-mono text-[9px] text-slate-400 whitespace-nowrap">{op.ts || '—'}</td>
                          </tr>
                          {isOpen && (
                            <tr>
                              <td colSpan={10} className="p-0">
                                <ExpandedRow op={op} />
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                    {filtered.length === 0 && (
                      <tr>
                        <td colSpan={10}>
                          <div className="py-16 flex flex-col items-center text-center">
                            <Inbox size={40} className="text-slate-200 mb-3" />
                            <p className="font-semibold text-slate-500">No operations match current filters</p>
                            <p className="text-xs text-slate-400 mt-1">Try reducing the minimum duration threshold.</p>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ════ PROFILER ════ */}
        {tab === 'profiler' && (
          profLoading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-8 h-8 border-4 border-green-200 border-t-green-600 rounded-full animate-spin" />
            </div>
          ) : (
            <div className="space-y-5">
              {/* Profiler levels */}
              <div className="bg-white rounded-2xl border border-slate-200 p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-bold text-slate-800 text-sm">Profiler Status per Database</h3>
                  <button onClick={refetchProf}
                    className="flex items-center gap-1 text-xs text-green-600 font-semibold hover:text-green-800">
                    <RefreshCw size={11} className={profLoading ? 'animate-spin' : ''} /> Refresh
                  </button>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                  {Object.entries(profData?.profiler_levels || {}).map(([dbName, level]) => (
                    <div key={dbName} className={`rounded-xl border p-3 ${level >= 1 ? 'bg-green-50 border-green-200' : 'bg-slate-50 border-slate-200'}`}>
                      <p className="text-[10px] font-bold text-slate-500 uppercase">{dbName}</p>
                      <p className={`font-black text-lg mt-1 ${level >= 1 ? 'text-green-700' : 'text-slate-400'}`}>
                        Level {level}
                        <span className="text-xs font-normal ml-1">{level === 0 ? '(Off)' : level === 1 ? '(Slow)' : '(All)'}</span>
                      </p>
                    </div>
                  ))}
                  {Object.keys(profData?.profiler_levels || {}).length === 0 && (
                    <p className="text-xs text-slate-400 col-span-4">No databases accessible for profiling info.</p>
                  )}
                </div>
                {!Object.values(profData?.profiler_levels || {}).some(l => l >= 1) && (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
                    <AlertTriangle size={16} className="inline mr-2 text-amber-500" />
                    Profiler is off on all databases. Enable slow-query profiling with:
                    <div className="mt-2 flex items-start gap-2">
                      <code className="font-mono text-xs bg-white px-2 py-1.5 rounded border border-amber-200 flex-1 block">
                        db.setProfilingLevel(1, {'{'}slowms: 100{'}'})
                      </code>
                      <CopyBtn text="db.setProfilingLevel(1, { slowms: 100 })" />
                    </div>
                  </div>
                )}
              </div>

              {/* Profiled ops table */}
              <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                  <h3 className="font-bold text-slate-800 text-sm">
                    Profiled Operations ({(profData?.ops || []).length})
                  </h3>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400">From system.profile collections</span>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50">
                      <tr>{['DB', 'Op', 'Namespace', 'Duration', 'Docs Exam.', 'Keys Exam.', 'Returned', 'Plan', 'Client', 'Timestamp'].map(h => (
                        <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                      ))}</tr>
                    </thead>
                    <tbody>
                      {(profData?.ops || []).slice(0, 100).map((op, i) => (
                        <tr key={i} className={`border-t border-slate-100 hover:bg-slate-50 ${op.millis > 5000 ? 'bg-red-50/30' : op.millis > 1000 ? 'bg-yellow-50/30' : ''}`}>
                          <td className="px-3 py-2.5 font-bold" style={{ color: C.dark }}>{op.db}</td>
                          <td className="px-3 py-2.5">
                            <span className="px-2 py-0.5 rounded-full text-[9px] font-bold" style={{ background: 'rgba(0,237,100,0.1)', color: C.dark }}>
                              {op.op || '—'}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 font-mono text-slate-500 max-w-[160px] truncate">{op.ns}</td>
                          <td className={`px-3 py-2.5 font-bold ${op.millis > 5000 ? 'text-red-600' : op.millis > 1000 ? 'text-orange-500' : 'text-slate-700'}`}>
                            {fmtMs(op.millis)}
                          </td>
                          <td className="px-3 py-2.5 font-mono">{fmtNum(op.docsExamined || 0)}</td>
                          <td className="px-3 py-2.5 font-mono">{fmtNum(op.keysExamined || 0)}</td>
                          <td className="px-3 py-2.5 font-mono">{fmtNum(op.nreturned || 0)}</td>
                          <td className="px-3 py-2.5 text-[10px] text-slate-400 max-w-[120px] truncate">{op.planSummary || '—'}</td>
                          <td className="px-3 py-2.5 text-[10px] text-slate-400 max-w-[100px] truncate">{op.client || '—'}</td>
                          <td className="px-3 py-2.5 font-mono text-[9px] text-slate-400 whitespace-nowrap">{op.ts || '—'}</td>
                        </tr>
                      ))}
                      {(profData?.ops || []).length === 0 && (
                        <tr><td colSpan={10}>
                          <div className="py-16 flex flex-col items-center text-center">
                            <Terminal size={40} className="text-slate-200 mb-3" />
                            <p className="font-semibold text-slate-500">No profiler data</p>
                            <p className="text-xs text-slate-400 mt-1">Enable with: db.setProfilingLevel(1, {'{'}slowms: 100{'}'})</p>
                          </div>
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )
        )}

        {/* ════ AI ANALYSIS ════ */}
        {tab === 'aianalysis' && (
          <AIAnalysisTab connId={id} allOps={allOps} top10={top10} />
        )}

        {/* ════ REPORTS ════ */}
        {tab === 'reports' && (
          <div className="space-y-5 max-w-3xl">
            {/* Summary stats */}
            <div className="bg-white rounded-2xl border border-slate-200 p-6">
              <h3 className="font-bold text-slate-800 mb-4">Performance Summary</h3>
              <div className="grid grid-cols-2 gap-4">
                {[
                  ['Total Slow Operations', allOps.length],
                  ['Critical (>30s)',        kpis.critical],
                  ['High (5s–30s)',          kpis.high],
                  ['Average Duration',      fmtMs(kpis.avgMs)],
                  ['Max Duration',          fmtMs(kpis.maxMs)],
                  ['From Live (currentOp)', (slowData?.current_ops || []).length],
                  ['From Profiler History', (slowData?.profile_ops  || []).length],
                  ['Unique Namespaces',     new Set(allOps.map(o => o.ns)).size],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between py-2 border-b border-slate-100">
                    <span className="text-sm text-slate-500">{k}</span>
                    <span className="text-sm font-bold text-slate-800">{v}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Export actions */}
            <div className="bg-white rounded-2xl border border-slate-200 p-6">
              <h3 className="font-bold text-slate-800 mb-4">Export Data</h3>
              <div className="space-y-3">
                <button onClick={exportCSV}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-green-200 bg-green-50 hover:bg-green-100 transition-colors text-left">
                  <div className="h-8 w-8 rounded-lg bg-green-500 flex items-center justify-center flex-shrink-0">
                    <Download size={14} className="text-white" />
                  </div>
                  <div>
                    <p className="font-semibold text-green-800 text-sm">Export CSV Report</p>
                    <p className="text-xs text-green-600">{filtered.length} operations · namespace, duration, docs examined, plan summary</p>
                  </div>
                </button>
              </div>
            </div>

            {/* Recommendations */}
            <div className="bg-white rounded-2xl border border-slate-200 p-6">
              <h3 className="font-bold text-slate-800 mb-4">Recommendations</h3>
              <div className="space-y-3">
                {kpis.critical > 0 && (
                  <div className="flex items-start gap-3 p-3 bg-red-50 border border-red-200 rounded-xl">
                    <AlertCircle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-semibold text-red-800 text-sm">{kpis.critical} Critical operation(s) detected</p>
                      <p className="text-xs text-red-600 mt-0.5">Operations running longer than 30 seconds indicate serious performance issues. Check for full collection scans and missing indexes.</p>
                    </div>
                  </div>
                )}
                {allOps.filter(o => o.planSummary === 'COLLSCAN').length > 0 && (
                  <div className="flex items-start gap-3 p-3 bg-orange-50 border border-orange-200 rounded-xl">
                    <AlertTriangle size={16} className="text-orange-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-semibold text-orange-800 text-sm">{allOps.filter(o => o.planSummary === 'COLLSCAN').length} COLLSCAN operation(s)</p>
                      <p className="text-xs text-orange-600 mt-0.5">Collection scans read every document. Add indexes on frequently queried fields.</p>
                    </div>
                  </div>
                )}
                <div className="flex items-start gap-3 p-3 bg-blue-50 border border-blue-200 rounded-xl">
                  <Info size={16} className="text-blue-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold text-blue-800 text-sm">Enable profiling for richer history</p>
                    <p className="text-xs text-blue-600 mt-0.5">Run <code className="font-mono bg-white px-1 rounded">db.setProfilingLevel(1, {'{'} slowms: 100 {'}'})</code> to capture queries over 100ms in system.profile.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

// ── AI Analysis tab component ────────────────────────────────────────────────
function AIAnalysisPanel({ connId, op }) {
  const [loading, setLoading] = useState(false);
  const [result,  setResult]  = useState(null);
  const [error,   setError]   = useState(null);

  async function run() {
    setLoading(true); setResult(null); setError(null);
    try {
      const r = await analyzeGroq(connId, {
        ns:            op.ns            || '',
        op:            op.op            || '',
        millis:        getDuration(op),
        docs_examined: op.docsExamined  || 0,
        keys_examined: op.keysExamined  || 0,
        docs_returned: op.nreturned     || 0,
        plan_summary:  op.planSummary   || '',
        filter_json:   op.filter ? JSON.stringify(op.filter) : (op.query ? JSON.stringify(op.query) : ''),
        client:        op.client        || '',
      });
      if (r.status === 'error') { setError(r.error); return; }
      setResult(r.analysis);
    } catch (e) { setError(e?.message || 'Analysis failed'); }
    finally { setLoading(false); }
  }

  const SEV = {
    critical: 'bg-red-100 text-red-800 border-red-200',
    high:     'bg-orange-100 text-orange-800 border-orange-200',
    medium:   'bg-amber-100 text-amber-800 border-amber-200',
    low:      'bg-green-100 text-green-800 border-green-200',
  };

  if (!result && !loading && !error) return (
    <div className="flex items-center gap-3 p-4 bg-slate-50 rounded-xl border border-slate-200">
      <Brain size={18} className="text-slate-400 flex-shrink-0" />
      <div className="flex-1">
        <p className="text-sm font-semibold text-slate-700">ActMon AI Analysis</p>
        <p className="text-xs text-slate-400 mt-0.5">Send this operation to the AI engine for DBA-level insights and index recommendations.</p>
      </div>
      <button onClick={run}
        className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold text-white transition-all"
        style={{ background: 'linear-gradient(135deg, #00684A 0%, #00ED64 100%)' }}>
        <Brain size={13} /> Analyze with ActMon AI
      </button>
    </div>
  );

  if (loading) return (
    <div className="flex items-center gap-3 p-4 bg-slate-50 rounded-xl border border-slate-200">
      <div className="w-5 h-5 border-2 border-green-200 border-t-green-600 rounded-full animate-spin flex-shrink-0" />
      <span className="text-sm text-slate-600">Running ActMon AI analysis — usually 5–10 seconds…</span>
    </div>
  );

  if (error) return (
    <div className="flex items-center gap-3 p-4 bg-red-50 rounded-xl border border-red-200">
      <XCircle size={16} className="text-red-500 flex-shrink-0" />
      <div className="flex-1">
        <p className="text-sm font-bold text-red-700">Analysis failed</p>
        <p className="text-xs text-red-500 mt-0.5">{error}</p>
      </div>
      <button onClick={run} className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-bold">
        <RotateCcw size={11} /> Retry
      </button>
    </div>
  );

  const a = result;
  return (
    <div className="space-y-4 mt-3">
      <div style={{ background: 'linear-gradient(135deg, #001E2B 0%, #0a2d1f 100%)' }}
        className="rounded-xl p-4 text-white">
        <div className="flex items-center gap-3 mb-2">
          <Brain size={16} className="text-green-400" />
          <span className="font-bold text-sm">ActMon AI Analysis</span>
          {a.severity && (
            <span className={`ml-auto px-2.5 py-0.5 rounded-full border text-[10px] font-black uppercase ${SEV[a.severity] || SEV.medium}`}>
              {a.severity}
            </span>
          )}
          <button onClick={run} title="Re-analyze"
            className="p-1.5 rounded-lg hover:bg-white/10 transition-colors ml-1">
            <RotateCcw size={12} />
          </button>
        </div>
        {a.summary && <p className="text-xs text-slate-300 leading-relaxed">{a.summary}</p>}
      </div>

      {a.root_cause && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <p className="text-[10px] font-bold text-amber-600 uppercase mb-1">Root Cause</p>
          <p className="text-xs text-amber-900 leading-relaxed">{a.root_cause}</p>
        </div>
      )}

      {a.issues?.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-bold text-slate-400 uppercase">Issues Detected ({a.issues.length})</p>
          {a.issues.map((issue, i) => (
            <div key={i} className={`rounded-xl border px-4 py-3 ${SEV[issue.severity] || SEV.medium}`}>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-white/60 border">{issue.type}</span>
                {issue.collection && <span className="text-[10px] font-mono">{issue.collection}</span>}
              </div>
              <p className="text-xs leading-relaxed">{issue.description}</p>
              {issue.evidence && <p className="text-[10px] font-mono mt-1.5 opacity-70">Evidence: {issue.evidence}</p>}
            </div>
          ))}
        </div>
      )}

      {a.index_recommendations?.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-bold text-slate-400 uppercase">Index Recommendations</p>
          {a.index_recommendations.map((rec, i) => (
            <div key={i} className="bg-green-50 border border-green-200 rounded-xl p-4">
              <div className="flex items-start gap-2">
                <Lightbulb size={14} className="text-green-600 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold text-green-800">{rec.collection}</p>
                  <p className="text-xs text-green-700 mt-0.5">{rec.reason}</p>
                  {rec.create_cmd && (
                    <div className="mt-2 bg-white rounded-lg border border-green-100 p-2 flex items-start gap-2">
                      <pre className="font-mono text-[10px] text-slate-700 flex-1 overflow-x-auto whitespace-pre-wrap">{rec.create_cmd}</pre>
                      <CopyBtn text={rec.create_cmd} />
                    </div>
                  )}
                  {rec.estimated_improvement && (
                    <p className="text-[10px] text-green-600 mt-1 font-semibold">Expected: {rec.estimated_improvement}</p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {a.query_optimization?.applicable && a.query_optimization.suggestions?.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <p className="text-[10px] font-bold text-blue-600 uppercase mb-2">Query Optimization</p>
          <ul className="space-y-1">
            {a.query_optimization.suggestions.map((s, i) => (
              <li key={i} className="text-xs text-blue-800 flex items-start gap-2">
                <span className="flex-shrink-0 mt-0.5">•</span>{s}
              </li>
            ))}
          </ul>
          {a.query_optimization.expected_gain && (
            <p className="text-[10px] font-bold text-blue-700 mt-2">Expected gain: {a.query_optimization.expected_gain}</p>
          )}
        </div>
      )}

      {a.priority_actions?.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-[10px] font-bold text-slate-400 uppercase mb-2">Priority Actions</p>
          <ol className="space-y-1.5">
            {a.priority_actions.map((act, i) => (
              <li key={i} className="text-xs text-slate-700 flex items-start gap-2">
                <span className="flex-shrink-0 w-4 h-4 rounded-full bg-slate-100 text-[9px] font-black flex items-center justify-center mt-0.5">{i + 1}</span>
                {act.replace(/^\d+\.\s*/, '')}
              </li>
            ))}
          </ol>
        </div>
      )}

      {a.business_impact && (
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
          <p className="text-[10px] font-bold text-slate-400 uppercase mb-1">Business Impact</p>
          <p className="text-xs text-slate-600 leading-relaxed">{a.business_impact}</p>
          {a.estimated_overall_improvement && (
            <p className="text-xs font-bold text-slate-700 mt-2">Overall expected improvement: {a.estimated_overall_improvement}</p>
          )}
        </div>
      )}
    </div>
  );
}

function AIAnalysisTab({ connId, allOps, top10 }) {
  const [selected, setSelected] = useState(null);
  const collscans = allOps.filter(o => o.planSummary === 'COLLSCAN' || (o.plan_summary || '').includes('COLLSCAN'));
  const critical  = allOps.filter(o => getDuration(o) >= 30000);

  return (
    <div className="space-y-5">
      <div style={{ background: 'linear-gradient(135deg, #001E2B 0%, #0a2d1f 100%)' }}
        className="rounded-2xl p-6 text-white flex items-start gap-4">
        <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ background: 'rgba(0,237,100,0.15)', border: '1px solid rgba(0,237,100,0.3)' }}>
          <Brain size={24} style={{ color: '#00ED64' }} />
        </div>
        <div>
          <h2 className="font-black text-lg">ActMon AI — Slow Operation Analysis</h2>
          <p className="text-xs mt-1" style={{ color: '#00ED64' }}>
            Powered by LLaMA 3.3 70B via Groq · Select any operation for DBA-level insights and index recommendations
          </p>
          <div className="flex gap-3 mt-3 flex-wrap">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-red-500/20 border border-red-400/30">
              <XCircle size={12} className="text-red-400" />
              <span className="text-xs font-bold">{critical.length} Critical (&gt;30s)</span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-orange-400/20 border border-orange-400/30">
              <AlertTriangle size={12} className="text-orange-400" />
              <span className="text-xs font-bold">{collscans.length} COLLSCAN</span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white/5 border border-white/10">
              <Clock size={12} className="text-slate-400" />
              <span className="text-xs font-bold">{allOps.length} total slow ops</span>
            </div>
          </div>
        </div>
      </div>

      {allOps.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 py-20 flex flex-col items-center text-center">
          <CheckCircle2 size={48} className="text-green-400 mx-auto mb-4" />
          <p className="font-black text-lg text-slate-800">No slow operations to analyze</p>
          <p className="text-slate-400 text-sm mt-2">Enable profiling or reduce the threshold to capture more data.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">

          {/* Left: operation picker */}
          <div className="space-y-3">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Select an operation to analyze</p>

            {(collscans.length > 0 || critical.length > 0) && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                <p className="text-[10px] font-bold text-amber-600 uppercase mb-2">Recommended picks</p>
                <div className="space-y-1.5">
                  {[...critical, ...collscans].slice(0, 3).map((op, i) => {
                    const ms = getDuration(op);
                    const isSelected = selected === op;
                    return (
                      <button key={i} onClick={() => setSelected(op)}
                        className={`w-full text-left px-3 py-2 rounded-lg border transition-all text-xs ${
                          isSelected ? 'bg-amber-200 border-amber-400 font-bold' : 'bg-white border-amber-100 hover:border-amber-300'
                        }`}>
                        <div className="flex items-center justify-between">
                          <span className="font-mono truncate max-w-[220px]">{op.ns || '—'}</span>
                          <span className={`ml-2 font-black flex-shrink-0 ${ms >= 30000 ? 'text-red-600' : 'text-orange-600'}`}>{fmtMs(ms)}</span>
                        </div>
                        <p className="text-[10px] text-slate-500 mt-0.5">{op.op || '—'} · {op.planSummary || 'no plan'}</p>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100">
                <p className="text-xs font-bold text-slate-600">Top {top10.length} Slowest Operations</p>
              </div>
              <div className="overflow-y-auto max-h-[440px]">
                {top10.map((op, i) => {
                  const ms = getDuration(op);
                  const sev = sevLabel(ms);
                  const isSelected = selected === op;
                  return (
                    <button key={i} onClick={() => setSelected(op)}
                      className={`w-full text-left px-4 py-3 border-b border-slate-100 last:border-0 transition-all hover:bg-slate-50 ${
                        isSelected ? 'bg-green-50 border-l-4 border-l-green-500' : ''
                      }`}>
                      <div className="flex items-center gap-2">
                        <span className="w-5 h-5 rounded-full bg-slate-100 text-[10px] font-black flex items-center justify-center flex-shrink-0">{i + 1}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-bold text-slate-700 truncate">{op.ns || '—'}</p>
                          <p className="text-[10px] text-slate-400">{op.op || '—'} · {op.planSummary || 'no plan'}</p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className={`px-2 py-0.5 rounded-full border text-[9px] font-bold ${sev.cls}`}>{sev.label}</span>
                          <span className={`text-sm font-black ${durColor(ms)}`}>{fmtMs(ms)}</span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Right: AI panel */}
          <div>
            {selected ? (
              <div className="space-y-3">
                <div className="bg-white rounded-2xl border border-slate-200 p-4">
                  <p className="text-[10px] font-bold text-slate-400 uppercase mb-2">Selected Operation</p>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    {[
                      ['Namespace', selected.ns || '—'],
                      ['Op Type',   selected.op || '—'],
                      ['Duration',  fmtMs(getDuration(selected))],
                      ['Docs Exam', selected.docsExamined || 0],
                      ['Plan',      selected.planSummary || '—'],
                      ['Client',    selected.client || '—'],
                    ].map(([k, v]) => (
                      <div key={k} className="bg-slate-50 rounded-lg p-2">
                        <p className="text-[10px] text-slate-400 font-bold uppercase">{k}</p>
                        <p className="font-mono font-semibold text-slate-700 truncate mt-0.5">{v}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <AIAnalysisPanel connId={connId} op={selected} key={`${selected.ns}-${getDuration(selected)}`} />
              </div>
            ) : (
              <div className="bg-white rounded-2xl border border-slate-200 p-12 flex flex-col items-center text-center h-full min-h-[300px] justify-center">
                <Brain size={40} className="text-slate-200 mb-4" />
                <p className="font-bold text-slate-500">Select an operation from the list</p>
                <p className="text-xs text-slate-400 mt-1">Pick any operation to get AI-powered DBA analysis.</p>
              </div>
            )}
          </div>

        </div>
      )}
    </div>
  );
}
