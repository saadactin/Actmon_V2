import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  RefreshCw, ChevronDown, ChevronRight, AlertTriangle,
  CheckCircle2, Search, Zap, Clock, ArrowLeft,
  TrendingDown, BarChart2, Info, XCircle, Filter,
  Database,
} from 'lucide-react';
import client from '../../api/client';

const fetchSlowQueries = (id) =>
  client.get(`/connections/postgresql/${id}/pg-slow-queries`).then(r => r.data);

export default function SlowQueries() {
  const { id } = useParams();
  const [expanded, setExpanded]       = useState(null);
  const [search, setSearch]           = useState('');
  const [minTime, setMinTime]         = useState(0);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['pgSlowQueries', id],
    queryFn: () => fetchSlowQueries(id),
    retry: false,
    refetchInterval: 30000,
  });

  if (isLoading) return <Spinner label="Loading slow queries…" />;
  if (error)     return <Err msg={error.message} onRetry={refetch} />;

  const queries    = data?.queries || [];
  const source     = data?.source || 'pg_stat_statements';
  const pgssAvail  = data?.pg_stat_statements_available !== false;
  const pgssError  = data?.error;

  const uniqueCount  = queries.length;
  const avgTime      = queries.length
    ? (queries.reduce((s, q) => s + (+q.mean_exec_time || 0), 0) / queries.length).toFixed(2)
    : 0;
  const maxTime      = queries.length
    ? Math.max(...queries.map(q => +q.max_exec_time || 0)).toFixed(2)
    : 0;
  const cacheMissCount = queries.filter(q => +q.shared_blks_read > 0).length;

  const filtered = queries.filter(q => {
    const okSearch = !search || (q.query || '').toLowerCase().includes(search.toLowerCase());
    const okTime   = +q.mean_exec_time >= minTime;
    return okSearch && okTime;
  });

  return (
    <div className="min-h-screen bg-slate-50">

      {/* Header */}
      <div className="bg-gradient-to-r from-slate-900 via-blue-900 to-indigo-800 text-white px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to={`/postgresql-dashboard/${id}`}
              className="w-9 h-9 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 flex items-center justify-center">
              <ArrowLeft size={16} />
            </Link>
            <div>
              <h1 className="text-xl font-black tracking-tight flex items-center gap-2">
                <Zap size={18} className="text-yellow-400" /> Slow Queries
              </h1>
              <p className="text-blue-300 text-xs mt-0.5">
                Source: {source === 'pg_stat_activity' ? 'pg_stat_activity (live sessions)' : 'pg_stat_statements (cumulative digest)'}
              </p>
            </div>
          </div>
          <button onClick={() => refetch()}
            className="flex items-center gap-2 px-4 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg text-sm font-semibold">
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
      </div>

      <div className="p-5 space-y-4">

        {/* KPI row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard icon={<BarChart2 size={18} className="text-slate-400" />}
            label="Unique Queries" value={uniqueCount} />
          <KpiCard icon={<Clock size={18} className="text-orange-400" />}
            label="Avg Time (ms)" value={`${avgTime} ms`} />
          <KpiCard icon={<AlertTriangle size={18} className="text-red-400" />}
            label="Max Time (ms)" value={`${maxTime} ms`} accent={+maxTime > 5000 ? 'red' : 'slate'} />
          <KpiCard icon={<TrendingDown size={18} className="text-yellow-500" />}
            label="Cache Miss Queries" value={cacheMissCount} accent={cacheMissCount > 0 ? 'yellow' : 'slate'} />
        </div>

        {/* pg_stat_statements not available banner */}
        {!pgssAvail && (
          <div className="bg-orange-50 border border-orange-300 rounded-2xl p-4 space-y-2">
            <div className="flex items-center gap-2 font-bold text-orange-800">
              <AlertTriangle size={16} /> pg_stat_statements is not available on this server
            </div>
            <p className="text-xs text-orange-700">
              The <code className="mx-1">pg_stat_statements</code> extension is required for detailed slow query analysis.
              Falling back to <code>pg_stat_activity</code> for live session data only.
            </p>
            <div className="bg-white border border-orange-200 rounded-xl p-3 text-xs font-mono text-slate-700 space-y-1">
              <p className="text-slate-400 font-sans font-bold mb-1">To enable pg_stat_statements:</p>
              <p>-- In postgresql.conf:</p>
              <p>shared_preload_libraries = 'pg_stat_statements'</p>
              <p className="text-slate-400 font-sans mt-2">-- After restart, in your database:</p>
              <p>CREATE EXTENSION IF NOT EXISTS pg_stat_statements;</p>
            </div>
          </div>
        )}

        {pgssError && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3 flex items-start gap-2 text-xs text-amber-700">
            <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
            <span><strong>Query fetch error:</strong> {pgssError}</span>
          </div>
        )}

        {/* Source badge */}
        <div className={`rounded-2xl border p-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs ${
          pgssAvail ? 'bg-blue-50 border-blue-200' : 'bg-amber-50 border-amber-200'
        }`}>
          <span className="font-bold text-slate-700">Data Source:</span>
          <span className={`font-black px-2 py-0.5 rounded-full text-[10px] ${
            source === 'pg_stat_activity'
              ? 'bg-amber-100 text-amber-700'
              : 'bg-blue-100 text-blue-700'
          }`}>
            {source === 'pg_stat_activity' ? 'pg_stat_activity' : 'pg_stat_statements'}
          </span>
          {pgssAvail && (
            <span className="text-slate-500">
              Tracks cumulative query digests — resets on server restart or <code>pg_stat_statements_reset()</code>
            </span>
          )}
        </div>

        {/* Filters */}
        <div className="bg-white rounded-2xl border border-slate-200 p-3 flex flex-wrap gap-3 items-center">
          <Filter size={14} className="text-slate-400 flex-shrink-0" />
          <div className="relative flex-1 min-w-44">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search query text…"
              className="w-full pl-8 pr-3 h-9 rounded-xl border border-slate-200 text-sm outline-none focus:border-blue-500" />
          </div>
          <select value={minTime} onChange={e => setMinTime(Number(e.target.value))}
            className="h-9 px-3 rounded-xl border border-slate-200 text-sm outline-none bg-white">
            <option value={0}>All times</option>
            <option value={100}>≥ 100 ms</option>
            <option value={500}>≥ 500 ms</option>
            <option value={1000}>≥ 1 s</option>
            <option value={5000}>≥ 5 s</option>
            <option value={10000}>≥ 10 s</option>
          </select>
          <span className="text-xs text-slate-400">
            {filtered.length} / {queries.length} queries
          </span>
        </div>

        {/* Query table */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
              <CheckCircle2 size={32} className="text-green-300 mb-3" />
              <p className="font-semibold text-slate-600">No query data available</p>
              <p className="text-xs text-slate-400 mt-2 max-w-md">
                {queries.length > 0
                  ? 'Try relaxing the filters above.'
                  : !pgssAvail
                    ? 'Enable pg_stat_statements to capture query statistics.'
                    : 'No statement data in pg_stat_statements yet. Run some queries and refresh.'}
              </p>
              {queries.length === 0 && (
                <button onClick={() => refetch()} className="mt-3 px-4 py-2 bg-blue-600 text-white rounded-xl text-xs font-bold hover:bg-blue-700">
                  <RefreshCw size={12} className="inline mr-1" /> Refresh Now
                </button>
              )}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="w-8 px-3 py-3"></th>
                  <th className="px-4 py-3 text-left text-[11px] font-bold text-slate-400">Query</th>
                  <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Avg Time</th>
                  <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Max Time</th>
                  <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Calls</th>
                  <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Rows</th>
                  <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Cache Hit%</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((q, i) => {
                  const key    = `${i}__${(q.query || '').slice(0, 40)}`;
                  const isOpen = expanded === key;
                  const avg    = +q.mean_exec_time || 0;
                  const max    = +q.max_exec_time  || 0;
                  const calls  = +q.calls          || 0;
                  const hit    = +q.shared_blks_hit  || 0;
                  const read   = +q.shared_blks_read || 0;
                  const cacheHitPct = (hit + read) > 0
                    ? ((hit / (hit + read)) * 100).toFixed(1)
                    : null;
                  return (
                    <React.Fragment key={key}>
                      <tr className={`border-b border-slate-100 cursor-pointer transition-colors ${isOpen ? 'bg-blue-50' : 'hover:bg-slate-50'}`}
                        onClick={() => setExpanded(isOpen ? null : key)}>
                        <td className="px-3 py-3 text-slate-400">
                          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </td>
                        <td className="px-4 py-3 max-w-xs">
                          <div className="flex items-center gap-2">
                            {read > 0 && <span className="w-2 h-2 rounded-full bg-yellow-400 flex-shrink-0" title="Cache miss detected" />}
                            <span className="font-mono text-xs text-slate-700 truncate">
                              {(q.query || '').slice(0, 90)}
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-3 text-right">
                          <span className={`text-xs font-black ${avg > 10000 ? 'text-red-600' : avg > 2000 ? 'text-orange-500' : 'text-slate-700'}`}>
                            {avg.toFixed(2)} ms
                          </span>
                        </td>
                        <td className="px-3 py-3 text-right text-xs font-semibold text-slate-600">{max.toFixed(2)} ms</td>
                        <td className="px-3 py-3 text-right text-xs text-slate-500">{calls.toLocaleString()}</td>
                        <td className="px-3 py-3 text-right text-xs text-slate-500">{(+q.rows || 0).toLocaleString()}</td>
                        <td className="px-3 py-3 text-right text-xs">
                          {cacheHitPct !== null ? (
                            <span className={`font-bold ${+cacheHitPct < 90 ? 'text-red-600' : +cacheHitPct < 99 ? 'text-orange-500' : 'text-green-600'}`}>
                              {cacheHitPct}%
                            </span>
                          ) : <span className="text-slate-300">—</span>}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-blue-50 border-b border-blue-100">
                          <td colSpan={7} className="px-5 py-5">
                            <QueryDetail q={q} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

      </div>
    </div>
  );
}

/* ── Query Detail ─────────────────────────────────────────────────────────── */

function QueryDetail({ q }) {
  const calls      = +q.calls            || 1;
  const avg        = +q.mean_exec_time   || 0;
  const max        = +q.max_exec_time    || 0;
  const total      = +q.total_exec_time  || 0;
  const rows       = +q.rows             || 0;
  const hit        = +q.shared_blks_hit  || 0;
  const read       = +q.shared_blks_read || 0;
  const cacheHitPct = (hit + read) > 0
    ? ((hit / (hit + read)) * 100).toFixed(1)
    : null;

  const warnings = [];
  if (read > 0 && cacheHitPct !== null && +cacheHitPct < 90)
    warnings.push({ level: 'warn', title: 'Low Cache Hit Rate',
      text: `Cache hit rate is ${cacheHitPct}% — ${read.toLocaleString()} blocks read from disk.`,
      fix: 'Increase shared_buffers, or check if the working set fits in memory.' });
  if (avg > 10000)
    warnings.push({ level: 'error', title: 'Very Slow Query',
      text: `Avg execution ${avg.toFixed(0)} ms exceeds 10 seconds.`,
      fix: 'Run EXPLAIN ANALYZE, review indexes, and consider query rewrite or caching.' });
  if (avg > 2000 && avg <= 10000)
    warnings.push({ level: 'warn', title: 'Slow Query',
      text: `Avg execution ${avg.toFixed(0)} ms — noticeably slow.`,
      fix: 'Check for missing indexes or sequential scans with EXPLAIN ANALYZE.' });
  if (calls > 10000)
    warnings.push({ level: 'warn', title: 'High Call Frequency',
      text: `This query ran ${calls.toLocaleString()} times. Even small optimizations will have large impact.`,
      fix: 'Consider result caching, connection pooling, or batching if appropriate.' });

  return (
    <div className="space-y-4">

      <div>
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Full Query</p>
        <pre className="bg-white border border-slate-200 rounded-xl p-3 text-xs font-mono text-slate-800 overflow-auto max-h-52 whitespace-pre-wrap break-all">
          {q.query || '(empty)'}
        </pre>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Pill label="Avg Time"        value={`${avg.toFixed(2)} ms`} />
        <Pill label="Max Time"        value={`${max.toFixed(2)} ms`} />
        <Pill label="Total Time"      value={`${total.toFixed(2)} ms`} />
        <Pill label="Total Calls"     value={calls.toLocaleString()} />
        <Pill label="Rows Returned"   value={(+q.rows || 0).toLocaleString()} />
        <Pill label="Blks Hit"        value={hit.toLocaleString()} />
        <Pill label="Blks Read"       value={read.toLocaleString()} warn={read > 0} />
        <Pill label="Cache Hit %"     value={cacheHitPct !== null ? `${cacheHitPct}%` : '—'} warn={cacheHitPct !== null && +cacheHitPct < 90} />
      </div>

      {warnings.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Performance Issues</p>
          {warnings.map((w, i) => (
            <div key={i} className={`rounded-xl border px-3 py-2 text-xs ${w.level === 'error' ? 'bg-red-50 border-red-200 text-red-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
              <div className="flex items-center gap-2 font-bold mb-0.5">
                {w.level === 'error' ? <XCircle size={12} /> : <AlertTriangle size={12} />}
                {w.title}
              </div>
              <p>{w.text}</p>
              {w.fix && <p className="mt-1 text-slate-500 italic">{w.fix}</p>}
            </div>
          ))}
        </div>
      )}

      <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-700 flex items-start gap-2">
        <Info size={13} className="flex-shrink-0 mt-0.5" />
        <span>
          Run <code className="font-mono font-bold">EXPLAIN (ANALYZE, BUFFERS)</code> on this query in your PostgreSQL client for a detailed execution plan with buffer statistics.
        </span>
      </div>

    </div>
  );
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function KpiCard({ icon, label, value, accent = 'slate' }) {
  const border = ({ red:'border-l-red-500', yellow:'border-l-yellow-400', green:'border-l-green-500', slate:'border-l-slate-300' })[accent] || 'border-l-slate-300';
  return (
    <div className={`bg-white rounded-2xl border border-slate-200 border-l-4 ${border} p-4`}>
      <div className="flex justify-between items-start">
        <div>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{label}</p>
          <p className="text-xl font-black text-slate-800 mt-1">{value}</p>
        </div>
        {icon}
      </div>
    </div>
  );
}

function Pill({ label, value, warn }) {
  return (
    <div className={`rounded-xl border p-2.5 ${warn ? 'bg-amber-50 border-amber-200' : 'bg-white border-slate-200'}`}>
      <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide">{label}</p>
      <p className={`font-bold text-sm mt-0.5 ${warn ? 'text-amber-700' : 'text-slate-800'}`}>{value}</p>
    </div>
  );
}

function Spinner({ label }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center">
        <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mx-auto mb-3" />
        <p className="text-slate-500 text-sm">{label}</p>
      </div>
    </div>
  );
}

function Err({ msg, onRetry }) {
  return (
    <div className="p-6">
      <div className="bg-red-50 border border-red-200 rounded-2xl p-6 max-w-lg">
        <AlertTriangle className="text-red-500 mb-2" size={20} />
        <p className="font-bold text-red-700">Failed to load slow queries</p>
        <p className="text-sm text-red-600 mt-1">{msg}</p>
        <button onClick={onRetry} className="mt-3 px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-bold">Retry</button>
      </div>
    </div>
  );
}
