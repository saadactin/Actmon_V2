import React, { useState, useEffect, useRef } from 'react';
import { Paged } from '@/components/ui/Pagination';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, RefreshCw, FileText, ArrowLeft,
  CheckCircle2, XCircle, Info, AlertCircle, Search,
  Bug, ChevronDown, ChevronUp, Copy, Database, User,
  Clock, Hash, Terminal, Loader2, Wifi, WifiOff,
  Activity, BarChart3, Shield, Sparkles, Brain, Zap,
  ShieldAlert, Lightbulb, Wrench, X, Code2, BookOpen,
  Target, TrendingUp,
} from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
  BarChart, Bar, Cell,
} from 'recharts';
import client from '@/api/client';
import PageHeader from '@/components/layout/PageHeader';
import { PageLoading } from '@/components/ui/Loading';

const REFRESH_MS  = 10000;
const SEVS        = ['ALL', 'FATAL', 'ERROR', 'WARNING', 'LOG', 'INFO', 'DEBUG'];

const SEV_CFG = {
  FATAL:   { badge: 'bg-red-100 text-red-800 border-red-200',   row: 'bg-red-50/60',      bar: '#dc2626', icon: XCircle,       label: 'FATAL' },
  ERROR:   { badge: 'bg-red-50 text-red-700 border-red-100',    row: 'bg-red-50/30',      bar: '#ef4444', icon: AlertCircle,   label: 'ERROR' },
  WARNING: { badge: 'bg-amber-50 text-amber-700 border-amber-100', row: 'bg-amber-50/30', bar: '#f59e0b', icon: AlertTriangle, label: 'WARN' },
  LOG:     { badge: 'bg-blue-50 text-blue-700 border-blue-100', row: 'bg-blue-50/20',     bar: '#3b82f6', icon: FileText,      label: 'LOG' },
  INFO:    { badge: 'bg-slate-100 text-slate-600 border-slate-200', row: '',              bar: '#64748b', icon: Info,          label: 'INFO' },
  DEBUG:   { badge: 'bg-purple-50 text-purple-700 border-purple-100', row: 'bg-purple-50/20', bar: '#8b5cf6', icon: Bug,      label: 'DEBUG' },
};

const fetchLogs = (id) =>
  client.get(`/connections/postgresql/${id}/pg-error-logs`).then(r => r.data);

function fmtTs(ts) {
  if (!ts) return '—';
  const s = String(ts);
  return s.length > 23 ? s.slice(0, 23) : s;
}

function timeSince(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

export default function ErrorLogs() {
  const { id }                          = useParams();
  const [sev, setSev]                   = useState('ALL');
  const [search, setSearch]             = useState('');
  const [expanded, setExpanded]         = useState(null);
  const [lastRefresh, setLastRefresh]   = useState(Date.now());
  const [sinceStr, setSinceStr]         = useState('0s ago');
  const [aiEntry, setAiEntry]           = useState(null);   // log entry being analyzed
  const [aiResult, setAiResult]         = useState(null);   // { analysis } from backend
  const [aiLoading, setAiLoading]       = useState(false);
  const [aiError, setAiError]           = useState(null);

  const { data, isLoading, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey:        ['pgErrorLogs', id],
    queryFn:         () => fetchLogs(id),
    retry:           false,
    refetchInterval: REFRESH_MS,
  });

  useEffect(() => {
    if (dataUpdatedAt) setLastRefresh(dataUpdatedAt);
  }, [dataUpdatedAt]);

  useEffect(() => {
    const t = setInterval(() => setSinceStr(timeSince(lastRefresh)), 1000);
    return () => clearInterval(t);
  }, [lastRefresh]);

  const analyzeError = async (log) => {
    setAiEntry(log);
    setAiResult(null);
    setAiError(null);
    setAiLoading(true);
    try {
      const res = await client.post(`/connections/postgresql/${id}/pg-analyze-error`, {
        message:     log.message     || '',
        severity:    log.severity    || '',
        sql_state:   log.sql_state   || '',
        detail:      log.detail      || '',
        hint:        log.hint        || '',
        query:       log.query       || '',
        context:     log.context     || '',
        location:    log.location    || '',
        database:    log.database    || '',
        user:        log.user        || '',
        application: log.application || '',
        pid:         String(log.pid  || ''),
      });
      if (res.data?.status === 'error') {
        setAiError(res.data.error || 'Analysis failed');
      } else {
        setAiResult(res.data?.analysis || {});
      }
    } catch (e) {
      setAiError(e?.response?.data?.detail || e.message || 'Request failed');
    } finally {
      setAiLoading(false);
    }
  };

  const closeAiPanel = () => {
    setAiEntry(null);
    setAiResult(null);
    setAiError(null);
    setAiLoading(false);
  };

  if (isLoading) return (
    <PageLoading title="Loading error logs…" />
  );

  // Backend returned {status:"error"} as a 200 but with error payload
  const backendError = data?.status === 'error' ? data.error : null;

  if (error || backendError) return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="bg-red-50 border border-red-200 rounded-2xl p-6 max-w-2xl">
        <div className="flex items-center gap-3 mb-3">
          <AlertTriangle className="text-red-500 flex-shrink-0" size={22} />
          <p className="font-bold text-red-700 text-lg">Failed to load error logs</p>
        </div>
        <p className="text-sm text-red-600 font-mono bg-red-100 rounded-xl p-3 break-all">
          {backendError || error?.message || 'Unknown error'}
        </p>
        <div className="flex gap-3 mt-4">
          <button onClick={() => refetch()} className="px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-bold hover:bg-red-700">
            Retry
          </button>
          <Link to={`/postgresql-dashboard/${id}`}
            className="px-4 py-2 border border-red-300 text-red-600 rounded-xl text-sm font-bold hover:bg-red-50">
            Back to Dashboard
          </Link>
        </div>
      </div>
    </div>
  );

  const logs     = data?.logs     || [];
  const counts   = data?.counts   || {};
  const source   = data?.source   || 'none';
  const logPath  = data?.log_path || '';
  const note     = data?.note     || '';
  const dbStats  = data?.db_stats || {};

  const critCount = (counts.FATAL || 0) + (counts.ERROR || 0);
  const totalShown = logs.length;

  const filtered = logs.filter(l => {
    const okSev    = sev === 'ALL' || l.severity === sev;
    const needle   = search.toLowerCase();
    const okSearch = !needle || [l.message, l.detail, l.hint, l.query, l.database, l.user].some(f =>
      (f || '').toLowerCase().includes(needle)
    );
    return okSev && okSearch;
  });

  // Build a mini timeline — bucket by hour/minute based on density
  const timeline = (() => {
    const buckets = {};
    logs.forEach(l => {
      const ts = String(l.timestamp || '').slice(0, 16); // YYYY-MM-DD HH:MM
      if (!ts) return;
      if (!buckets[ts]) buckets[ts] = { t: ts, FATAL: 0, ERROR: 0, WARNING: 0, LOG: 0, INFO: 0, DEBUG: 0 };
      buckets[ts][l.severity] = (buckets[ts][l.severity] || 0) + 1;
    });
    return Object.values(buckets).sort((a, b) => a.t.localeCompare(b.t)).slice(-30);
  })();

  const sourceLabel = source === 'csv_log'
    ? `CSV log · ${logPath}`
    : source === 'stderr_log'
      ? `Stderr log · ${logPath}`
      : source === 'pg_stat_activity'
        ? 'pg_stat_activity (live sessions)'
        : 'Unknown source';

  return (
    <div className="min-h-full bg-brand-bg">

      <PageHeader
        icon={FileText}
        title="Error Logs"
        subtitle={sourceLabel}
        accent="postgres"
        backTo={`/postgresql-dashboard/${id}`}
        crumbs={[{ label: 'Databases', to: '/databases' }, { label: 'PostgreSQL', to: `/postgresql-dashboard/${id}` }, { label: 'Error Logs' }]}
        actions={(
          <div className="flex items-center gap-2">
            {/* LIVE badge */}
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-green-500/20 border border-green-400/40 rounded-xl">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400" />
              </span>
              <span className="text-green-300 text-xs font-bold">LIVE · 10s</span>
            </div>
            <span className="text-white/40 text-xs">{sinceStr}</span>
            <button onClick={() => refetch()}
              className="flex items-center gap-2 px-4 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg text-sm font-semibold text-white transition-all">
              <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} /> Refresh
            </button>
          </div>
        )}
      />

      {/* ── ACTMON AI ANALYSIS PANEL ──────────────────────────────── */}
      {aiEntry && (
        <div className="fixed inset-0 z-50 flex items-stretch justify-end">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={closeAiPanel} />
          <div className="relative z-10 w-full max-w-2xl flex flex-col shadow-2xl">

            {/* Header */}
            <div className="bg-gradient-to-r from-violet-900 via-indigo-900 to-blue-900 px-6 py-5 flex-shrink-0">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center">
                    <Brain size={20} className="text-violet-300" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-white font-black text-lg">Actmon AI Analysis</h2>
                      <span className="flex items-center gap-1 px-2 py-0.5 bg-violet-500/30 border border-violet-400/40 rounded-full text-[10px] font-bold text-violet-300">
                        <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />
                        LIVE
                      </span>
                    </div>
                    <p className="text-indigo-300 text-xs mt-0.5">PostgreSQL 17 · Error Intelligence</p>
                  </div>
                </div>
                <button onClick={closeAiPanel}
                  className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center text-white/60 hover:text-white transition-all">
                  <X size={15} />
                </button>
              </div>

              {/* Error being analyzed */}
              <div className="mt-4 bg-black/30 rounded-xl p-3 border border-white/10">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-black ${
                    aiEntry.severity === 'FATAL' ? 'bg-red-500/30 text-red-300' :
                    aiEntry.severity === 'ERROR' ? 'bg-red-400/25 text-red-300' :
                    aiEntry.severity === 'WARNING' ? 'bg-amber-400/25 text-amber-300' :
                    'bg-blue-400/25 text-blue-300'
                  }`}>{aiEntry.severity}</span>
                  {aiEntry.sql_state && <span className="text-[10px] text-slate-400 font-mono bg-white/10 px-1.5 py-0.5 rounded">{aiEntry.sql_state}</span>}
                  {aiEntry.database && <span className="text-[10px] text-slate-400">{aiEntry.database}</span>}
                </div>
                <p className="text-white/90 text-xs font-mono leading-relaxed line-clamp-3">{aiEntry.message}</p>
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto bg-slate-50">
              {aiLoading && (
                <div className="flex flex-col items-center justify-center h-80 gap-4">
                  <div className="relative">
                    <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-xl">
                      <Brain size={28} className="text-white" />
                    </div>
                    <div className="absolute inset-0 rounded-2xl border-2 border-violet-400 animate-ping opacity-30" />
                  </div>
                  <div className="text-center">
                    <p className="text-slate-700 font-bold">Analyzing error…</p>
                    <p className="text-slate-400 text-xs mt-1">Actmon AI is diagnosing root cause and preparing fix</p>
                  </div>
                  <div className="flex gap-1.5 mt-1">
                    {[0,1,2,3,4].map(i => (
                      <div key={i} className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce"
                        style={{ animationDelay: `${i * 0.12}s` }} />
                    ))}
                  </div>
                </div>
              )}

              {aiError && !aiLoading && (
                <div className="p-6">
                  <div className="bg-red-50 border border-red-200 rounded-2xl p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <AlertTriangle size={16} className="text-red-500" />
                      <span className="font-bold text-red-700 text-sm">Analysis Failed</span>
                    </div>
                    <p className="text-red-600 text-xs font-mono">{aiError}</p>
                    <button onClick={() => analyzeError(aiEntry)}
                      className="mt-3 px-4 py-1.5 bg-red-600 text-white text-xs font-bold rounded-lg hover:bg-red-700">
                      Retry
                    </button>
                  </div>
                </div>
              )}

              {aiResult && !aiLoading && (
                <div className="p-5 space-y-4">

                  {/* What is this error */}
                  <AiSection
                    icon={BookOpen} color="blue"
                    title="What is this error?"
                    content={aiResult.what}
                  />

                  {/* Root Cause */}
                  <AiSection
                    icon={Target} color="orange"
                    title="Root Cause"
                    content={aiResult.root_cause}
                  />

                  {/* Immediate Fix */}
                  <AiSection
                    icon={Wrench} color="green"
                    title="Immediate Fix"
                    content={aiResult.immediate_fix}
                    ordered
                  />

                  {/* SQL Fix */}
                  {aiResult.sql_fix && (
                    <div className="rounded-2xl border border-slate-200 overflow-hidden bg-white">
                      <div className="flex items-center justify-between px-4 py-3 bg-slate-900 border-b border-slate-700">
                        <div className="flex items-center gap-2">
                          <Code2 size={14} className="text-green-400" />
                          <span className="text-xs font-black text-slate-200 uppercase tracking-wide">SQL / Config Fix</span>
                        </div>
                        <button onClick={() => navigator.clipboard.writeText(aiResult.sql_fix)}
                          className="flex items-center gap-1 px-2.5 py-1 bg-white/10 hover:bg-white/20 rounded-lg text-[10px] text-slate-300 font-bold transition-all">
                          <Copy size={9} /> Copy
                        </button>
                      </div>
                      <pre className="p-4 text-[12px] text-green-400 font-mono whitespace-pre-wrap break-all leading-relaxed bg-slate-900 max-h-48 overflow-y-auto">
                        {aiResult.sql_fix}
                      </pre>
                    </div>
                  )}

                  {/* Prevention */}
                  <AiSection
                    icon={ShieldAlert} color="purple"
                    title="Prevention Strategy"
                    content={aiResult.prevention}
                  />

                  {/* Severity / Impact */}
                  {aiResult.severity_note && (
                    <div className={`rounded-2xl border-2 p-4 ${
                      aiEntry.severity === 'FATAL' || aiEntry.severity === 'ERROR'
                        ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200'
                    }`}>
                      <div className="flex items-center gap-2 mb-2">
                        <ShieldAlert size={15} className={aiEntry.severity === 'ERROR' ? 'text-red-500' : 'text-amber-500'} />
                        <span className={`text-xs font-black uppercase tracking-wide ${aiEntry.severity === 'ERROR' ? 'text-red-700' : 'text-amber-700'}`}>
                          Business Impact
                        </span>
                      </div>
                      <p className={`text-sm leading-relaxed ${aiEntry.severity === 'ERROR' ? 'text-red-700' : 'text-amber-700'}`}>
                        {aiResult.severity_note}
                      </p>
                    </div>
                  )}

                  {/* Related Errors */}
                  {aiResult.related_errors && (
                    <AiSection
                      icon={TrendingUp} color="slate"
                      title="Related Errors & Side Effects"
                      content={aiResult.related_errors}
                    />
                  )}

                </div>
              )}
            </div>

            {/* Footer */}
            <div className="bg-white border-t border-slate-200 px-5 py-3 flex items-center justify-between flex-shrink-0">
              <p className="text-[10px] text-slate-400 flex items-center gap-1.5">
                <Brain size={10} className="text-violet-400" />
                Powered by Actmon AI · PostgreSQL 17 DBA Intelligence
              </p>
              {aiResult && (
                <button onClick={() => analyzeError(aiEntry)} disabled={aiLoading}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-600 hover:bg-violet-700 text-white text-xs font-bold rounded-lg transition-all disabled:opacity-50">
                  <RefreshCw size={11} className={aiLoading ? 'animate-spin' : ''} />
                  Re-analyze
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="py-5 space-y-4">

        {/* ── SEVERITY KPI CARDS ────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {['FATAL','ERROR','WARNING','LOG','INFO','DEBUG'].map(s => {
            const cfg  = SEV_CFG[s];
            const Icon = cfg.icon;
            const cnt  = counts[s] || 0;
            const active = sev === s;
            return (
              <button key={s} onClick={() => setSev(active ? 'ALL' : s)}
                className={`rounded-2xl border-2 p-4 text-left transition-all hover:shadow-md hover:scale-[1.02] ${
                  active ? `${cfg.badge} shadow-lg scale-[1.02]` : 'bg-white border-slate-200 hover:border-slate-300'
                }`}>
                <div className="flex justify-between items-start">
                  <div>
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">{s}</p>
                    <p className={`text-3xl font-black mt-1 ${
                      active ? '' :
                      s === 'FATAL'   ? (cnt > 0 ? 'text-red-700'   : 'text-slate-300') :
                      s === 'ERROR'   ? (cnt > 0 ? 'text-red-600'   : 'text-slate-300') :
                      s === 'WARNING' ? (cnt > 0 ? 'text-amber-600' : 'text-slate-300') :
                      s === 'LOG'     ? 'text-blue-600' :
                      s === 'DEBUG'   ? 'text-purple-600' :
                      'text-slate-500'
                    }`}>{cnt}</p>
                  </div>
                  <Icon size={20} className={
                    active ? '' :
                    s === 'FATAL'   ? (cnt > 0 ? 'text-red-600'   : 'text-slate-200') :
                    s === 'ERROR'   ? (cnt > 0 ? 'text-red-500'   : 'text-slate-200') :
                    s === 'WARNING' ? (cnt > 0 ? 'text-amber-500' : 'text-slate-200') :
                    s === 'LOG'     ? 'text-blue-400'   :
                    s === 'DEBUG'   ? 'text-purple-400' :
                    'text-slate-400'
                  } />
                </div>
                {cnt > 0 && s !== 'LOG' && s !== 'INFO' && s !== 'DEBUG' && (
                  <div className="mt-2 h-1 bg-red-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${Math.min(100, cnt / Math.max(1, totalShown) * 100 * 10)}%`, background: cfg.bar }} />
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* ── CRITICAL ALERT BANNER ─────────────────────────────── */}
        {critCount > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-3 flex items-center gap-3">
            <div className="w-8 h-8 bg-red-100 rounded-xl flex items-center justify-center flex-shrink-0">
              <AlertTriangle className="text-red-600" size={16} />
            </div>
            <div>
              <span className="text-red-700 text-sm font-black">
                {critCount} critical event{critCount !== 1 ? 's' : ''} detected
              </span>
              <p className="text-red-500 text-xs mt-0.5">
                {counts.FATAL > 0 && `${counts.FATAL} FATAL`}
                {counts.FATAL > 0 && counts.ERROR > 0 && ' · '}
                {counts.ERROR > 0 && `${counts.ERROR} ERROR`}
              </p>
            </div>
            <button onClick={() => setSev('ERROR')} className="ml-auto px-3 py-1 bg-red-600 text-white text-xs font-bold rounded-lg hover:bg-red-700">
              Filter Errors
            </button>
          </div>
        )}

        {/* ── DB STATS ROW ───────────────────────────────────────── */}
        {Object.keys(dbStats).length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              ['Backends',    dbStats.numbackends,     'blue'],
              ['Commits',     dbStats.xact_commit,     'green'],
              ['Rollbacks',   dbStats.xact_rollback,   dbStats.xact_rollback > 0 ? 'orange' : 'slate'],
              ['Deadlocks',   dbStats.deadlocks,       dbStats.deadlocks > 0 ? 'red' : 'green'],
              ['Checksum Fails', dbStats.checksum_failures, dbStats.checksum_failures > 0 ? 'red' : 'green'],
            ].map(([label, val, accent]) => {
              const colors = { blue:'bg-blue-50 border-blue-200 text-blue-700', green:'bg-green-50 border-green-200 text-green-700', orange:'bg-orange-50 border-orange-200 text-orange-700', red:'bg-red-50 border-red-200 text-red-700', slate:'bg-slate-50 border-slate-200 text-slate-600' };
              return (
                <div key={label} className={`rounded-xl border p-3 ${colors[accent] || colors.slate}`}>
                  <p className="text-[10px] font-bold uppercase tracking-wide opacity-70">{label}</p>
                  <p className="text-xl font-black mt-0.5">{val ?? '—'}</p>
                </div>
              );
            })}
          </div>
        )}

        {/* ── TIMELINE CHART ────────────────────────────────────── */}
        {timeline.length > 2 && (
          <div className="bg-white rounded-2xl border border-slate-200 p-4">
            <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-3">Error Timeline</h3>
            <ResponsiveContainer width="100%" height={100}>
              <BarChart data={timeline} margin={{ left: 0, right: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis dataKey="t" tick={{ fontSize: 8 }} tickFormatter={t => t.slice(11)} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 8 }} axisLine={false} tickLine={false} width={25} />
                <Tooltip contentStyle={{ fontSize: 10, padding: '4px 8px' }} />
                <Bar dataKey="FATAL"   stackId="a" fill="#dc2626" name="Fatal" />
                <Bar dataKey="ERROR"   stackId="a" fill="#ef4444" name="Error" />
                <Bar dataKey="WARNING" stackId="a" fill="#f59e0b" name="Warning" />
                <Bar dataKey="LOG"     stackId="a" fill="#3b82f6" name="Log" radius={[2,2,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* ── FILTER BAR ─────────────────────────────────────────── */}
        <div className="bg-white rounded-2xl border border-slate-200 p-3 flex flex-wrap gap-3 items-center">
          <div className="flex gap-1 flex-wrap">
            {SEVS.map(s => (
              <button key={s} onClick={() => setSev(s)}
                className={`px-3 h-7 rounded-lg text-xs font-bold transition-all ${
                  sev === s ? 'bg-slate-900 text-white shadow-sm' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}>
                {s === 'ALL' ? `All (${logs.length})` : `${s} (${counts[s] ?? 0})`}
              </button>
            ))}
          </div>
          <div className="relative ml-auto">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search message, query, user, db…"
              className="pl-7 pr-3 h-8 rounded-xl border border-slate-200 text-xs outline-none focus:border-blue-500 w-64 bg-slate-50" />
          </div>
          <span className="text-xs text-slate-400 font-semibold">{filtered.length} entries</span>
        </div>

        {/* ── LOG TABLE ──────────────────────────────────────────── */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">

          {logs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center px-6">
              <CheckCircle2 size={36} className="text-green-400 mb-3" />
              <p className="font-bold text-slate-700 text-lg">No log entries found</p>
              {note ? (
                <div className="mt-3 max-w-2xl bg-amber-50 border border-amber-200 rounded-xl p-4 text-left">
                  <p className="text-xs font-bold text-amber-700 mb-1">Backend note:</p>
                  <p className="text-xs text-amber-600 font-mono break-all">{note}</p>
                  <div className="mt-3 text-xs text-slate-600 space-y-1">
                    <p className="font-bold text-slate-700">To enable CSV logging in postgresql.conf:</p>
                    <pre className="bg-white rounded p-2 border border-slate-200 font-mono text-[11px] mt-1">{`log_destination = 'csvlog'
logging_collector = on
log_directory = 'log'
log_filename = 'postgresql-%Y-%m-%d_%H%M%S.csv'
log_min_messages = warning
log_min_error_statement = error`}</pre>
                    <p className="text-slate-400 mt-1">Then reload: <code className="bg-slate-100 px-1 rounded">SELECT pg_reload_conf();</code></p>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-slate-400 mt-2 max-w-md">No log entries were retrieved from {sourceLabel}</p>
              )}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Search size={24} className="text-slate-300 mb-2" />
              <p className="text-slate-400 text-sm">No entries match the current filter</p>
            </div>
          ) : (
            <div className="overflow-auto max-h-[680px]">
              <Paged rows={filtered} unit="log entries">{(pageRows, pager) => (<>
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-white border-b border-slate-200 z-10 shadow-sm">
                  <tr>
                    <th className="w-8" />
                    <th className="px-4 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Timestamp</th>
                    <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Severity</th>
                    <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">DB · User</th>
                    <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">PID</th>
                    <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400">Message</th>
                    <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">AI</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((log, i) => {
                    const cfg  = SEV_CFG[log.severity] || SEV_CFG.INFO;
                    const Icon = cfg.icon;
                    const isExp = expanded === i;
                    const hasDetail = log.detail || log.hint || log.query || log.context || log.location || log.sql_state;
                    return (
                      <React.Fragment key={i}>
                        <tr
                          onClick={() => hasDetail && setExpanded(isExp ? null : i)}
                          className={`border-t border-slate-100 ${cfg.row} ${hasDetail ? 'cursor-pointer hover:brightness-95' : ''} ${isExp ? 'border-l-2 border-l-blue-400' : ''}`}>
                          <td className="w-8 pl-3 text-slate-300">
                            {hasDetail && (isExp ? <ChevronUp size={12}/> : <ChevronDown size={12}/>)}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-slate-500 whitespace-nowrap text-[11px]">
                            {fmtTs(log.timestamp)}
                          </td>
                          <td className="px-3 py-2.5">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${cfg.badge}`}>
                              <Icon size={9} />{log.raw_severity || log.severity}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 whitespace-nowrap">
                            {log.database && <span className="text-blue-700 font-semibold">{log.database}</span>}
                            {log.database && log.user && <span className="text-slate-300 mx-1">·</span>}
                            {log.user && <span className="text-slate-500">{log.user}</span>}
                            {!log.database && !log.user && <span className="text-slate-300">—</span>}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-slate-400 text-[11px]">{log.pid || '—'}</td>
                          <td className="px-3 py-2.5 text-slate-700 max-w-xl">
                            <p className="truncate max-w-[360px]">{log.message || '—'}</p>
                            {log.detail && !isExp && (
                              <p className="text-slate-400 text-[10px] truncate max-w-[360px] mt-0.5">Detail: {log.detail}</p>
                            )}
                          </td>
                          <td className="px-3 py-2.5">
                            <button
                              onClick={e => { e.stopPropagation(); analyzeError(log); }}
                              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-gradient-to-r from-violet-500 to-indigo-600 text-white text-[10px] font-bold hover:from-violet-600 hover:to-indigo-700 transition-all shadow-sm whitespace-nowrap"
                              title="Analyze with Actmon AI">
                              <Sparkles size={9} /> Analyze
                            </button>
                          </td>
                        </tr>
                        {isExp && (
                          <tr className="border-t border-blue-100 bg-slate-900">
                            <td colSpan={6} className="px-5 py-4">
                              <div className="space-y-3">
                                {/* Meta row */}
                                <div className="flex flex-wrap gap-2 text-[10px]">
                                  {log.sql_state && (
                                    <span className="bg-slate-700 px-2 py-0.5 rounded text-slate-300 font-mono">
                                      SQL State: {log.sql_state}
                                    </span>
                                  )}
                                  {log.command_tag && (
                                    <span className="bg-slate-700 px-2 py-0.5 rounded text-slate-300">
                                      Cmd: {log.command_tag}
                                    </span>
                                  )}
                                  {log.application && (
                                    <span className="bg-slate-700 px-2 py-0.5 rounded text-slate-300">
                                      App: {log.application}
                                    </span>
                                  )}
                                  {log.session_id && (
                                    <span className="bg-slate-700 px-2 py-0.5 rounded text-slate-300 font-mono">
                                      Session: {log.session_id}
                                    </span>
                                  )}
                                </div>

                                {/* Message */}
                                <DetailBlock label="Message" color="text-white" content={log.message} />
                                {log.detail   && <DetailBlock label="Detail"   color="text-blue-300"  content={log.detail} />}
                                {log.hint     && <DetailBlock label="Hint"     color="text-green-300" content={log.hint} />}
                                {log.context  && <DetailBlock label="Context"  color="text-amber-300" content={log.context} />}
                                {log.location && <DetailBlock label="Location" color="text-slate-400" content={log.location} />}
                                {log.query    && (
                                  <div>
                                    <div className="flex items-center justify-between mb-1">
                                      <span className="text-[10px] font-bold text-slate-400 uppercase">Query</span>
                                      <button onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(log.query); }}
                                        className="flex items-center gap-1 px-2 py-0.5 bg-slate-700 rounded text-[10px] text-slate-300 hover:bg-slate-600">
                                        <Copy size={9} /> Copy
                                      </button>
                                    </div>
                                    <pre className="font-mono text-[11px] text-green-400 whitespace-pre-wrap break-all bg-slate-800 rounded-lg p-3 max-h-40 overflow-y-auto">
                                      {log.query}
                                    </pre>
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
              {pager}
              </>)}</Paged>
            </div>
          )}
        </div>

        {/* ── SETUP GUIDE (shown when source is fallback) ─────────── */}
        {source === 'pg_stat_activity' && logs.length === 0 && (
          <div className="bg-white rounded-2xl border border-amber-200 p-5">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-8 h-8 bg-amber-100 rounded-xl flex items-center justify-center"><Terminal size={16} className="text-amber-600" /></div>
              <div>
                <p className="font-bold text-slate-800">Enable PostgreSQL CSV Logging</p>
                <p className="text-xs text-slate-500">For full error log access, configure your PostgreSQL server:</p>
              </div>
            </div>
            <pre className="bg-slate-900 rounded-xl p-4 text-green-400 font-mono text-xs overflow-x-auto">{`# postgresql.conf
log_destination = 'csvlog'
logging_collector = on
log_directory = 'log'
log_filename = 'postgresql-%Y-%m-%d_%H%M%S.csv'
log_min_messages = warning
log_min_error_statement = error
log_connections = on
log_disconnections = on
log_duration = off
log_line_prefix = '%t [%p]: [%l-1] user=%u,db=%d,app=%a,client=%h '`}</pre>
            <p className="text-xs text-slate-400 mt-2">After editing, run: <code className="bg-slate-100 px-1.5 py-0.5 rounded font-mono">SELECT pg_reload_conf();</code></p>
          </div>
        )}

      </div>
    </div>
  );
}

function DetailBlock({ label, color, content }) {
  return (
    <div>
      <p className={`text-[10px] font-bold uppercase mb-0.5 ${color || 'text-slate-400'}`}>{label}</p>
      <p className="text-slate-200 text-xs font-mono whitespace-pre-wrap break-all leading-relaxed">{content}</p>
    </div>
  );
}

function AiSection({ icon: Icon, title, color, content, ordered }) {
  const colorMap = {
    blue:   { bg: 'bg-blue-50',   border: 'border-blue-200',   icon: 'text-blue-600',   title: 'text-blue-800',  header: 'bg-blue-100' },
    orange: { bg: 'bg-orange-50', border: 'border-orange-200', icon: 'text-orange-600', title: 'text-orange-800',header: 'bg-orange-100' },
    green:  { bg: 'bg-green-50',  border: 'border-green-200',  icon: 'text-green-600',  title: 'text-green-800', header: 'bg-green-100' },
    purple: { bg: 'bg-purple-50', border: 'border-purple-200', icon: 'text-purple-600', title: 'text-purple-800',header: 'bg-purple-100' },
    slate:  { bg: 'bg-slate-50',  border: 'border-slate-200',  icon: 'text-slate-600',  title: 'text-slate-700', header: 'bg-slate-100' },
  };
  const c = colorMap[color] || colorMap.slate;
  if (!content) return null;

  // Normalize: handle arrays, objects, or plain strings safely
  const text = Array.isArray(content)
    ? content.join('\n')
    : typeof content === 'object' && content !== null
      ? Object.entries(content).map(([k, v]) => `${k}: ${v}`).join('\n')
      : String(content ?? '');

  if (!text.trim()) return null;

  const lines = text.split('\n').filter(Boolean);
  const isStepList = ordered || lines.some(l => /^\d+[\.\)]\s/.test(l.trim()));

  return (
    <div className={`rounded-2xl border ${c.border} overflow-hidden`}>
      <div className={`flex items-center gap-2 px-4 py-2.5 ${c.header}`}>
        <Icon size={14} className={c.icon} />
        <span className={`text-xs font-black uppercase tracking-wide ${c.title}`}>{title}</span>
      </div>
      <div className={`px-4 py-3 ${c.bg}`}>
        {isStepList ? (
          <ol className="space-y-1.5">
            {lines.map((line, i) => {
              const clean = line.replace(/^\d+[\.\)]\s*/, '').trim();
              return (
                <li key={i} className="flex items-start gap-2.5 text-sm text-slate-700 leading-relaxed">
                  <span className={`flex-shrink-0 w-5 h-5 rounded-full ${c.header} ${c.title} text-[10px] font-black flex items-center justify-center mt-0.5`}>
                    {i + 1}
                  </span>
                  <span>{clean || line}</span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-line">{text}</p>
        )}
      </div>
    </div>
  );
}
