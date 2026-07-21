import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, RefreshCw, Search, Filter, Zap, Clock,
  BarChart2, AlertTriangle, CheckCircle2, ChevronDown,
  ChevronRight, Database, User, XCircle,
} from 'lucide-react';
import client from '../../api/client';

const fetchSlowQueries = (id) =>
  client.get(`/connections/clickhouse/${id}/ch-slow-queries`).then(r => r.data);

/* ── helpers ── */
function fmtBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
  if (b >= 1048576)    return `${(b / 1048576).toFixed(2)} MB`;
  if (b >= 1024)       return `${(b / 1024).toFixed(2)} KB`;
  return `${b} B`;
}

function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

const QUERY_TYPES = ['ALL', 'Select', 'Insert', 'Create', 'Drop', 'Alter', 'Unknown'];

export default function SlowQueries() {
  const { id } = useParams();
  const [expanded, setExpanded] = useState(null);
  const [search, setSearch]     = useState('');
  const [minDur, setMinDur]     = useState(0);
  const [typeFilter, setTypeFilter] = useState('ALL');
  const [userFilter, setUserFilter] = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['chSlowQueries', id],
    queryFn: () => fetchSlowQueries(id),
    retry: false,
    refetchInterval: 30000,
  });

  if (isLoading) return <Spinner label="Loading slow queries…" />;
  if (error)     return <Err msg={error.message} onRetry={refetch} />;

  const queries = data?.queries || data || [];
  const rows    = Array.isArray(queries) ? queries : [];

  /* KPIs */
  const total      = rows.length;
  const durations  = rows.map(q => Number(q.query_duration_ms) || 0);
  const avgDur     = total ? Math.round(durations.reduce((a, v) => a + v, 0) / total) : 0;
  const maxDur     = total ? Math.max(...durations) : 0;
  const failed     = rows.filter(q => (q.type || '').toLowerCase().includes('exception') || String(q.exception || '').length > 0).length;

  const users = [...new Set(rows.map(q => q.user).filter(Boolean))];

  const filtered = rows.filter(q => {
    const okSearch = !search || (q.query || '').toLowerCase().includes(search.toLowerCase());
    const okDur    = Number(q.query_duration_ms) >= minDur;
    const okType   = typeFilter === 'ALL' || (q.type || '').toLowerCase().includes(typeFilter.toLowerCase());
    const okUser   = !userFilter || q.user === userFilter;
    return okSearch && okDur && okType && okUser;
  });

  return (
    <div className="min-h-screen bg-slate-50">

      {/* Header */}
      <div className="bg-gradient-to-r from-slate-900 via-yellow-900 to-amber-800 text-white px-6 py-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-4">
            <Link to={`/clickhouse-dashboard/${id}`}
              className="w-9 h-9 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 flex items-center justify-center">
              <ArrowLeft size={16} />
            </Link>
            <div>
              <h1 className="text-xl font-black tracking-tight flex items-center gap-2">
                <Zap size={18} className="text-yellow-400" /> ClickHouse Slow Queries
              </h1>
              <p className="text-yellow-300 text-xs mt-0.5">
                Source: system.query_log — completed queries ordered by duration
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
            label="Total Queries" value={fmtNum(total)} />
          <KpiCard icon={<Clock size={18} className="text-amber-400" />}
            label="Avg Duration" value={`${fmtNum(avgDur)} ms`} />
          <KpiCard icon={<AlertTriangle size={18} className="text-orange-400" />}
            label="Max Duration" value={`${fmtNum(maxDur)} ms`}
            accent={maxDur > 60000 ? 'red' : maxDur > 10000 ? 'yellow' : 'slate'} />
          <KpiCard icon={<XCircle size={18} className="text-red-400" />}
            label="Failed Queries" value={failed}
            accent={failed > 0 ? 'red' : 'slate'} />
        </div>

        {/* Filters */}
        <div className="bg-white rounded-2xl border border-slate-200 p-3 flex flex-wrap gap-3 items-center">
          <Filter size={14} className="text-slate-400 flex-shrink-0" />
          <div className="relative flex-1 min-w-44">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search query text…"
              className="w-full pl-8 pr-3 h-9 rounded-xl border border-slate-200 text-sm outline-none focus:border-amber-500" />
          </div>
          <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
            className="h-9 px-3 rounded-xl border border-slate-200 text-sm outline-none bg-white">
            {QUERY_TYPES.map(t => <option key={t} value={t}>{t === 'ALL' ? 'All Types' : t}</option>)}
          </select>
          <select value={userFilter} onChange={e => setUserFilter(e.target.value)}
            className="h-9 px-3 rounded-xl border border-slate-200 text-sm outline-none bg-white">
            <option value="">All Users</option>
            {users.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
          <select value={minDur} onChange={e => setMinDur(Number(e.target.value))}
            className="h-9 px-3 rounded-xl border border-slate-200 text-sm outline-none bg-white">
            <option value={0}>All durations</option>
            <option value={100}>≥ 100ms</option>
            <option value={500}>≥ 500ms</option>
            <option value={1000}>≥ 1s</option>
            <option value={5000}>≥ 5s</option>
            <option value={30000}>≥ 30s</option>
          </select>
          <span className="text-xs text-slate-400">
            {filtered.length} / {total} queries
          </span>
        </div>

        {/* Query table */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center px-6">
              <CheckCircle2 size={32} className="text-green-300 mb-3" />
              <p className="font-semibold text-slate-600">
                {total > 0 ? 'No queries match the current filters.' : 'No slow query data available.'}
              </p>
              <p className="text-xs text-slate-400 mt-1 max-w-md">
                {total === 0 && 'Ensure query logging is enabled in ClickHouse and queries have been executed.'}
              </p>
              {total === 0 && (
                <button onClick={() => refetch()} className="mt-3 px-4 py-2 bg-amber-600 text-white rounded-xl text-xs font-bold hover:bg-amber-700">
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
                    <th className="px-4 py-3 text-left text-[11px] font-bold text-slate-400">Query</th>
                    <th className="px-3 py-3 text-left text-[11px] font-bold text-slate-400 whitespace-nowrap">Event Time</th>
                    <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Duration (ms)</th>
                    <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Read Rows</th>
                    <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Read Bytes</th>
                    <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Result Rows</th>
                    <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Memory</th>
                    <th className="px-3 py-3 text-left text-[11px] font-bold text-slate-400 whitespace-nowrap">Type</th>
                    <th className="px-3 py-3 text-left text-[11px] font-bold text-slate-400 whitespace-nowrap">User</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((q, i) => {
                    const key    = `row-${i}-${q.query_id || i}`;
                    const isOpen = expanded === key;
                    const dur    = Number(q.query_duration_ms) || 0;
                    const isSlow = dur > 10000;
                    const isMed  = dur > 1000;
                    return (
                      <React.Fragment key={key}>
                        <tr
                          className={`border-b border-slate-100 cursor-pointer transition-colors ${isOpen ? 'bg-amber-50' : 'hover:bg-slate-50'}`}
                          onClick={() => setExpanded(isOpen ? null : key)}>
                          <td className="px-3 py-3 text-slate-400">
                            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </td>
                          <td className="px-4 py-3 max-w-xs">
                            <span className="font-mono text-xs text-slate-700 truncate block">
                              {String(q.query || '').slice(0, 90)}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-xs text-slate-500 whitespace-nowrap">
                            {String(q.event_time || '').slice(0, 19)}
                          </td>
                          <td className="px-3 py-3 text-right">
                            <span className={`text-xs font-black ${isSlow ? 'text-red-600' : isMed ? 'text-orange-500' : 'text-slate-700'}`}>
                              {fmtNum(dur)}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-right text-xs font-mono text-slate-600">{fmtNum(q.read_rows)}</td>
                          <td className="px-3 py-3 text-right text-xs font-mono text-slate-600">{fmtBytes(q.read_bytes)}</td>
                          <td className="px-3 py-3 text-right text-xs font-mono text-slate-600">{fmtNum(q.result_rows)}</td>
                          <td className="px-3 py-3 text-right text-xs font-mono text-slate-600">{fmtBytes(q.memory_usage)}</td>
                          <td className="px-3 py-3">
                            <TypeBadge type={q.type} />
                          </td>
                          <td className="px-3 py-3 text-xs text-amber-700 font-semibold whitespace-nowrap">
                            <span className="flex items-center gap-1">
                              <User size={11} className="text-slate-400" />
                              {q.user || '—'}
                            </span>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-amber-50 border-b border-amber-100">
                            <td colSpan={10} className="px-5 py-5">
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

/* ── Query Detail Panel ── */
function QueryDetail({ q }) {
  const dur = Number(q.query_duration_ms) || 0;

  const warnings = [];
  if (dur > 60000)
    warnings.push({ level: 'error', title: 'Extremely Slow Query',
      text: `Duration ${fmtNum(dur)}ms exceeds 60 seconds. This may block resources.`,
      fix: 'Check for missing projections, optimize WHERE clauses, or use sampling.' });
  if (Number(q.read_rows) > 100_000_000)
    warnings.push({ level: 'warn', title: 'High Row Scan',
      text: `Scanned ${fmtNum(q.read_rows)} rows — very high I/O cost.`,
      fix: 'Add a partition key filter or use MergeTree projections to reduce scan scope.' });
  if (Number(q.memory_usage) > 1073741824)
    warnings.push({ level: 'warn', title: 'High Memory Usage',
      text: `Query consumed ${fmtBytes(q.memory_usage)} of memory.`,
      fix: 'Consider using max_memory_usage setting or reduce result set size.' });

  return (
    <div className="space-y-4">

      <div>
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Full Query</p>
        <pre className="bg-white border border-slate-200 rounded-xl p-3 text-xs font-mono text-slate-800 overflow-auto max-h-52 whitespace-pre-wrap break-all">
          {q.query || '(empty)'}
        </pre>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Pill label="Query ID"        value={String(q.query_id || '—').slice(0, 20)} />
        <Pill label="Duration"        value={`${fmtNum(dur)} ms`} warn={dur > 10000} />
        <Pill label="Read Rows"       value={fmtNum(q.read_rows)} />
        <Pill label="Read Bytes"      value={fmtBytes(q.read_bytes)} />
        <Pill label="Result Rows"     value={fmtNum(q.result_rows)} />
        <Pill label="Memory Usage"    value={fmtBytes(q.memory_usage)} warn={Number(q.memory_usage) > 1073741824} />
        <Pill label="Type"            value={q.type || '—'} />
        <Pill label="User"            value={q.user || '—'} />
      </div>

      {warnings.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Performance Issues</p>
          {warnings.map((w, i) => (
            <div key={i} className={`rounded-xl border px-3 py-2 text-xs ${
              w.level === 'error' ? 'bg-red-50 border-red-200 text-red-800' : 'bg-amber-50 border-amber-200 text-amber-800'
            }`}>
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

    </div>
  );
}

/* ── Type Badge ── */
function TypeBadge({ type }) {
  const t = String(type || '').toLowerCase();
  const cls =
    t.includes('select')   ? 'bg-blue-100 text-blue-700'   :
    t.includes('insert')   ? 'bg-green-100 text-green-700' :
    t.includes('create')   ? 'bg-teal-100 text-teal-700'   :
    t.includes('drop')     ? 'bg-red-100 text-red-700'     :
    t.includes('alter')    ? 'bg-purple-100 text-purple-700' :
    t.includes('exception') ? 'bg-red-100 text-red-700'    :
                              'bg-slate-100 text-slate-600';
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold whitespace-nowrap ${cls}`}>
      {type || '—'}
    </span>
  );
}

/* ── Shared atoms ── */
function KpiCard({ icon, label, value, accent = 'slate' }) {
  const border = ({
    red: 'border-l-red-500', yellow: 'border-l-yellow-400',
    green: 'border-l-green-500', slate: 'border-l-slate-300',
  })[accent] || 'border-l-slate-300';
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
      <p className={`font-bold text-sm mt-0.5 truncate ${warn ? 'text-amber-700' : 'text-slate-800'}`}>{value}</p>
    </div>
  );
}

function Spinner({ label }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center">
        <div className="w-10 h-10 border-4 border-yellow-200 border-t-yellow-500 rounded-full animate-spin mx-auto mb-3" />
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
