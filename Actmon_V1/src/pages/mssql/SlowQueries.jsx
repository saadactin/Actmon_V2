import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, RefreshCw, Zap, Clock, BarChart2, AlertTriangle,
  CheckCircle2, Search, Filter, ChevronDown, ChevronRight,
  XCircle, Database, TrendingUp,
} from 'lucide-react';
import client from '../../api/client';

const fetchSlowQueries = (id) =>
  client.get(`/connections/mssql/${id}/mssql-slow-queries`).then(r => r.data);

/* ── Helpers ── */
function fmtNum(n) {
  const v = Number(n);
  if (!v && v !== 0) return '—';
  return v >= 1_000_000
    ? `${(v / 1_000_000).toFixed(1)}M`
    : v >= 1_000
    ? `${(v / 1_000).toFixed(1)}K`
    : v.toLocaleString();
}

function getWarnings(q) {
  const warns = [];
  if (Number(q.avg_elapsed_ms) > 5000)
    warns.push({ level: 'error', title: 'Very Slow Query', text: `Avg elapsed ${Number(q.avg_elapsed_ms).toLocaleString()} ms exceeds 5 seconds.` });
  if (Number(q.avg_physical_reads) > 1000)
    warns.push({ level: 'warn', title: 'High Physical I/O', text: `Avg physical reads ${Number(q.avg_physical_reads).toLocaleString()} — heavy disk I/O.` });
  if (Number(q.avg_logical_reads) > 10000)
    warns.push({ level: 'warn', title: 'High Logical I/O', text: `Avg logical reads ${Number(q.avg_logical_reads).toLocaleString()} — consider index coverage.` });
  return warns;
}

/* ── Sub-components ── */
function KpiCard({ icon, label, value, accent = 'slate' }) {
  const borders = {
    red: 'border-l-red-500', yellow: 'border-l-yellow-400',
    green: 'border-l-green-500', blue: 'border-l-blue-500',
    slate: 'border-l-slate-300',
  };
  return (
    <div className={`bg-white rounded-2xl border border-slate-200 border-l-4 ${borders[accent] || borders.slate} p-4`}>
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

function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-semibold transition-all flex-shrink-0"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

function QueryDetail({ q }) {
  const warnings = getWarnings(q);
  const sql = q.sql_text || '';
  return (
    <div className="space-y-4 py-1">
      <div>
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Full SQL Text</p>
        <div className="flex items-start gap-2">
          <pre className="flex-1 bg-white border border-slate-200 rounded-xl p-3 text-xs font-mono text-slate-800 overflow-auto max-h-52 whitespace-pre-wrap break-all">
            {sql || '(empty)'}
          </pre>
          <CopyBtn text={sql} />
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          { label: 'Avg Elapsed (ms)',  value: fmtNum(q.avg_elapsed_ms),    warn: Number(q.avg_elapsed_ms) > 5000 },
          { label: 'Execution Count',   value: fmtNum(q.execution_count),   warn: false },
          { label: 'Total CPU (ms)',    value: fmtNum(q.total_cpu_ms),      warn: false },
          { label: 'Avg Logical Reads', value: fmtNum(q.avg_logical_reads), warn: Number(q.avg_logical_reads) > 10000 },
          { label: 'Avg Phys. Reads',   value: fmtNum(q.avg_physical_reads),warn: Number(q.avg_physical_reads) > 1000 },
          { label: 'Database',          value: q.db_name || '—',            warn: false },
          { label: 'Last Execution',    value: q.last_execution_time ? String(q.last_execution_time).slice(0, 19) : '—', warn: false },
        ].map(({ label, value, warn }) => (
          <div key={label} className={`rounded-xl border p-2.5 ${warn ? 'bg-amber-50 border-amber-200' : 'bg-white border-slate-200'}`}>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide">{label}</p>
            <p className={`font-bold text-sm mt-0.5 ${warn ? 'text-amber-700' : 'text-slate-800'}`}>{value}</p>
          </div>
        ))}
      </div>

      {warnings.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Performance Issues</p>
          {warnings.map((w, i) => (
            <div key={i} className={`rounded-xl border px-3 py-2 text-xs flex items-start gap-2 ${
              w.level === 'error'
                ? 'bg-red-50 border-red-200 text-red-800'
                : 'bg-amber-50 border-amber-200 text-amber-800'
            }`}>
              {w.level === 'error'
                ? <XCircle size={12} className="flex-shrink-0 mt-0.5" />
                : <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />}
              <div>
                <p className="font-bold">{w.title}</p>
                <p>{w.text}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center">
        <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mx-auto mb-3" />
        <p className="text-slate-500 text-sm">Loading slow queries…</p>
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
        <button onClick={onRetry} className="mt-3 px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-bold hover:bg-red-700">Retry</button>
      </div>
    </div>
  );
}

/* ── Main Page ── */
export default function MSSQLSlowQueries() {
  const { id } = useParams();
  const [expanded, setExpanded] = useState(null);
  const [search, setSearch]     = useState('');
  const [dbFilter, setDbFilter] = useState('');
  const [minElapsed, setMinElapsed] = useState(0);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['mssqlSlowQueries', id],
    queryFn:  () => fetchSlowQueries(id),
    retry: false,
    refetchInterval: 30000,
  });

  if (isLoading) return <Spinner />;
  if (error)     return <Err msg={error.message} onRetry={refetch} />;

  const queries = Array.isArray(data) ? data : (data?.queries || data?.slow_queries || []);

  const totalQueries    = queries.length;
  const avgElapsed      = queries.length
    ? Math.round(queries.reduce((s, q) => s + (Number(q.avg_elapsed_ms) || 0), 0) / queries.length)
    : 0;
  const maxElapsed      = queries.length
    ? Math.max(...queries.map(q => Number(q.avg_elapsed_ms) || 0))
    : 0;
  const highLogicalReads = queries.filter(q => Number(q.avg_logical_reads) > 10000).length;

  const dbs = [...new Set(queries.map(q => q.db_name).filter(Boolean))];

  const filtered = queries.filter(q => {
    const okSearch  = !search || (q.sql_text || '').toLowerCase().includes(search.toLowerCase());
    const okDb      = !dbFilter || q.db_name === dbFilter;
    const okElapsed = Number(q.avg_elapsed_ms) >= minElapsed;
    return okSearch && okDb && okElapsed;
  });

  return (
    <div className="min-h-screen bg-slate-50">

      {/* Header */}
      <div className="bg-gradient-to-r from-slate-900 via-blue-800 to-sky-700 text-white px-6 py-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-4">
            <Link to={`/mssql-dashboard/${id}`}
              className="w-9 h-9 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 flex items-center justify-center">
              <ArrowLeft size={16} />
            </Link>
            <div>
              <h1 className="text-xl font-black tracking-tight flex items-center gap-2">
                <Zap size={18} className="text-yellow-400" /> MSSQL Slow Queries
              </h1>
              <p className="text-sky-300 text-xs mt-0.5">
                Source: sys.dm_exec_query_stats — top queries by elapsed time
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

        {/* KPI Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard icon={<BarChart2 size={18} className="text-slate-400" />}
            label="Total Queries" value={totalQueries} />
          <KpiCard icon={<Clock size={18} className="text-orange-400" />}
            label="Avg Elapsed (ms)" value={fmtNum(avgElapsed)} accent="blue" />
          <KpiCard icon={<AlertTriangle size={18} className="text-red-400" />}
            label="Max Elapsed" value={`${fmtNum(maxElapsed)} ms`} accent={maxElapsed > 5000 ? 'red' : 'slate'} />
          <KpiCard icon={<TrendingUp size={18} className="text-yellow-500" />}
            label="High Logical Reads" value={highLogicalReads} accent={highLogicalReads > 0 ? 'yellow' : 'slate'} />
        </div>

        {/* Filters */}
        <div className="bg-white rounded-2xl border border-slate-200 p-3 flex flex-wrap gap-3 items-center">
          <Filter size={14} className="text-slate-400 flex-shrink-0" />
          <div className="relative flex-1 min-w-44">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search SQL text…"
              className="w-full pl-8 pr-3 h-9 rounded-xl border border-slate-200 text-sm outline-none focus:border-blue-500" />
          </div>
          <select value={dbFilter} onChange={e => setDbFilter(e.target.value)}
            className="h-9 px-3 rounded-xl border border-slate-200 text-sm outline-none bg-white">
            <option value="">All Databases</option>
            {dbs.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <select value={minElapsed} onChange={e => setMinElapsed(Number(e.target.value))}
            className="h-9 px-3 rounded-xl border border-slate-200 text-sm outline-none bg-white">
            <option value={0}>All times</option>
            <option value={500}>≥ 500 ms</option>
            <option value={1000}>≥ 1s</option>
            <option value={5000}>≥ 5s</option>
            <option value={10000}>≥ 10s</option>
            <option value={30000}>≥ 30s</option>
          </select>
          <span className="text-xs text-slate-400">
            {filtered.length} / {queries.length} queries
          </span>
        </div>

        {/* Query Table */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
              <CheckCircle2 size={32} className="text-green-300 mb-3" />
              <p className="font-semibold text-slate-600">No slow query data available</p>
              <p className="text-xs text-slate-400 mt-2 max-w-md">
                {queries.length > 0 ? 'Try relaxing the filters above.' : 'No data returned from sys.dm_exec_query_stats. Run some queries first.'}
              </p>
              {queries.length === 0 && (
                <button onClick={() => refetch()} className="mt-3 px-4 py-2 bg-blue-600 text-white rounded-xl text-xs font-bold hover:bg-blue-700">
                  <RefreshCw size={12} className="inline mr-1" /> Refresh Now
                </button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="w-8 px-3 py-3" />
                    <th className="px-4 py-3 text-left text-[11px] font-bold text-slate-400">SQL Text</th>
                    <th className="px-3 py-3 text-left text-[11px] font-bold text-slate-400 whitespace-nowrap">Database</th>
                    <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Avg Elapsed (ms)</th>
                    <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Exec Count</th>
                    <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Total CPU (ms)</th>
                    <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Avg Log. Reads</th>
                    <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Avg Phys. Reads</th>
                    <th className="px-3 py-3 text-left text-[11px] font-bold text-slate-400 whitespace-nowrap">Last Executed</th>
                    <th className="px-3 py-3 text-left text-[11px] font-bold text-slate-400 whitespace-nowrap">Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((q, i) => {
                    const key    = `${i}__${(q.sql_text || '').slice(0, 40)}`;
                    const isOpen = expanded === key;
                    const warns  = getWarnings(q);
                    const avgMs  = Number(q.avg_elapsed_ms) || 0;
                    return (
                      <React.Fragment key={key}>
                        <tr
                          className={`border-b border-slate-100 cursor-pointer transition-colors ${isOpen ? 'bg-blue-50' : 'hover:bg-slate-50'}`}
                          onClick={() => setExpanded(isOpen ? null : key)}
                        >
                          <td className="px-3 py-3 text-slate-400">
                            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </td>
                          <td className="px-4 py-3 max-w-xs">
                            <div className="flex items-center gap-2">
                              {warns.length > 0 && (
                                <span className="w-2 h-2 rounded-full bg-red-400 flex-shrink-0" title={warns.map(w => w.title).join(', ')} />
                              )}
                              <span className="font-mono text-xs text-slate-700 truncate">
                                {(q.sql_text || '').slice(0, 90)}
                              </span>
                            </div>
                          </td>
                          <td className="px-3 py-3">
                            <span className="flex items-center gap-1 text-xs text-slate-500">
                              <Database size={11} />
                              {q.db_name || '—'}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-right">
                            <span className={`text-xs font-black ${
                              avgMs > 10000 ? 'text-red-600' : avgMs > 5000 ? 'text-orange-500' : 'text-slate-700'
                            }`}>
                              {fmtNum(avgMs)}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-right text-xs text-slate-500">{fmtNum(q.execution_count)}</td>
                          <td className="px-3 py-3 text-right text-xs text-slate-500">{fmtNum(q.total_cpu_ms)}</td>
                          <td className="px-3 py-3 text-right">
                            <span className={`text-xs ${Number(q.avg_logical_reads) > 10000 ? 'font-bold text-amber-600' : 'text-slate-500'}`}>
                              {fmtNum(q.avg_logical_reads)}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-right">
                            <span className={`text-xs ${Number(q.avg_physical_reads) > 1000 ? 'font-bold text-orange-600' : 'text-slate-500'}`}>
                              {fmtNum(q.avg_physical_reads)}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-xs text-slate-400 whitespace-nowrap">
                            {q.last_execution_time ? String(q.last_execution_time).slice(0, 19) : '—'}
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex gap-1 flex-wrap">
                              {warns.map((w, wi) => (
                                <span key={wi} className={`px-1.5 py-0.5 rounded text-[9px] font-bold whitespace-nowrap ${
                                  w.level === 'error'
                                    ? 'bg-red-100 text-red-700'
                                    : 'bg-amber-100 text-amber-700'
                                }`}>
                                  {w.title}
                                </span>
                              ))}
                            </div>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-blue-50 border-b border-blue-100">
                            <td colSpan={10} className="px-5 py-4">
                              <QueryDetail q={q} />
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

      </div>
    </div>
  );
}
