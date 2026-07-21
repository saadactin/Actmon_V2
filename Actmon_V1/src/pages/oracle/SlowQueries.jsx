import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  RefreshCw, Zap, Clock, BarChart2, AlertTriangle,
  CheckCircle2, Search, ChevronDown, ChevronRight, HardDrive, Filter,
  Copy,
} from 'lucide-react';
import client from '../../api/client';
import PageHeader from '../../components/layout/PageHeader';

const fetchSlowQueries = (id) =>
  client.get(`/connections/oracle/${id}/oracle-slow-queries`).then(r => r.data);

/* ── helpers ── */
function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs transition-all"
    >
      <Copy size={11} />
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

function KpiCard({ icon, label, value, accent = 'slate' }) {
  const border = ({ red: 'border-l-red-500', orange: 'border-l-orange-500', yellow: 'border-l-yellow-400', slate: 'border-l-slate-300' })[accent] || 'border-l-slate-300';
  return (
    <div className={`bg-white rounded-2xl border border-slate-200 border-l-4 ${border} p-4`}>
      <div className="flex justify-between items-start">
        <div>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{label}</p>
          <p className="text-xl font-black text-slate-800 mt-1">{value ?? '—'}</p>
        </div>
        {icon}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center">
        <div className="w-10 h-10 border-4 border-orange-200 border-t-orange-600 rounded-full animate-spin mx-auto mb-3" />
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
        <button onClick={onRetry} className="mt-3 px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-bold">Retry</button>
      </div>
    </div>
  );
}

/* ── Main page ── */
export default function SlowQueries() {
  const { id } = useParams();
  const [expanded, setExpanded] = useState(null);
  const [search, setSearch]     = useState('');
  const [schemaFilter, setSchemaFilter] = useState('');
  const [minElapsed, setMinElapsed]     = useState(0);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['oracleSlowQueries', id],
    queryFn: () => fetchSlowQueries(id),
    retry: false,
    refetchInterval: 30000,
  });

  if (isLoading) return <Spinner />;
  if (error)     return <Err msg={error.message} onRetry={refetch} />;

  // Be defensive: the endpoint may return an array, {slow_queries:[…]}, or (on a
  // backend hiccup) an error object — never let a non-array reach .filter()/.map().
  const rawQueries = data?.slow_queries ?? data;
  const queries = Array.isArray(rawQueries) ? rawQueries : [];

  const uniqueCount  = queries.length;
  const avgElapsed   = queries.length
    ? (queries.reduce((s, q) => s + (parseFloat(q.avg_elapsed_sec) || 0), 0) / queries.length).toFixed(3)
    : 0;
  const maxElapsed   = queries.length
    ? Math.max(...queries.map(q => parseFloat(q.avg_elapsed_sec) || 0)).toFixed(3)
    : 0;
  const highDiskRead = queries.filter(q => (parseFloat(q.avg_disk_reads) || 0) > 1000).length;

  const schemas = [...new Set(queries.map(q => q.parsing_schema_name).filter(Boolean))];

  const filtered = queries.filter(q => {
    const okSearch = !search || (q.sql_text || '').toLowerCase().includes(search.toLowerCase())
      || (q.sql_id || '').toLowerCase().includes(search.toLowerCase());
    const okSchema = !schemaFilter || q.parsing_schema_name === schemaFilter;
    const okTime   = parseFloat(q.avg_elapsed_sec) >= minElapsed;
    return okSearch && okSchema && okTime;
  });

  return (
    <div className="min-h-full bg-brand-bg">

      <PageHeader
        icon={Zap}
        title="Oracle Slow Queries"
        subtitle="Source: V$SQLAREA — top SQL by average elapsed time"
        accent="oracle"
        backTo={`/oracle-dashboard/${id}`}
        crumbs={[{ label: 'Databases', to: '/databases' }, { label: 'Oracle', to: `/oracle-dashboard/${id}` }, { label: 'Slow Queries' }]}
        actions={(
          <button onClick={() => refetch()}
            className="flex items-center gap-2 px-4 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg text-sm font-semibold text-white">
            <RefreshCw size={13} /> Refresh
          </button>
        )}
      />

      <div className="py-5 space-y-4">

        {/* KPI row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard
            icon={<BarChart2 size={18} className="text-slate-400" />}
            label="Unique SQLs"
            value={uniqueCount}
          />
          <KpiCard
            icon={<Clock size={18} className="text-orange-400" />}
            label="Avg Elapsed (s)"
            value={`${avgElapsed}s`}
          />
          <KpiCard
            icon={<AlertTriangle size={18} className="text-red-400" />}
            label="Max Elapsed"
            value={`${maxElapsed}s`}
            accent={parseFloat(maxElapsed) > 10 ? 'red' : 'slate'}
          />
          <KpiCard
            icon={<HardDrive size={18} className="text-yellow-500" />}
            label="High Disk Read Queries"
            value={highDiskRead}
            accent={highDiskRead > 0 ? 'yellow' : 'slate'}
          />
        </div>

        {/* Filters */}
        <div className="bg-white rounded-2xl border border-slate-200 p-3 flex flex-wrap gap-3 items-center">
          <Filter size={14} className="text-slate-400 flex-shrink-0" />
          <div className="relative flex-1 min-w-44">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search SQL text or SQL_ID…"
              className="w-full pl-8 pr-3 h-9 rounded-xl border border-slate-200 text-sm outline-none focus:border-orange-500"
            />
          </div>
          <select value={schemaFilter} onChange={e => setSchemaFilter(e.target.value)}
            className="h-9 px-3 rounded-xl border border-slate-200 text-sm outline-none bg-white">
            <option value="">All Schemas</option>
            {schemas.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={minElapsed} onChange={e => setMinElapsed(Number(e.target.value))}
            className="h-9 px-3 rounded-xl border border-slate-200 text-sm outline-none bg-white">
            <option value={0}>All elapsed times</option>
            <option value={0.1}>≥ 0.1s</option>
            <option value={0.5}>≥ 0.5s</option>
            <option value={1}>≥ 1s</option>
            <option value={5}>≥ 5s</option>
            <option value={10}>≥ 10s</option>
          </select>
          <span className="text-xs text-slate-400">
            {filtered.length} / {queries.length} queries
          </span>
        </div>

        {/* Table */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
              <CheckCircle2 size={32} className="text-green-300 mb-3" />
              <p className="font-semibold text-slate-600">No slow query data</p>
              <p className="text-xs text-slate-400 mt-2 max-w-md">
                {queries.length > 0
                  ? 'Try relaxing the filters above.'
                  : 'No SQL statements found in V$SQLAREA. Ensure the Oracle connection has SELECT on V$SQLAREA.'}
              </p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="w-8 px-3 py-3" />
                  <th className="px-4 py-3 text-left text-[11px] font-bold text-slate-400">SQL ID</th>
                  <th className="px-4 py-3 text-left text-[11px] font-bold text-slate-400">SQL (truncated)</th>
                  <th className="px-3 py-3 text-left text-[11px] font-bold text-slate-400">Schema</th>
                  <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Executions</th>
                  <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Avg Elapsed</th>
                  <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Avg CPU</th>
                  <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Avg Disk R.</th>
                  <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Avg Buf Gets</th>
                  <th className="px-3 py-3 text-left text-[11px] font-bold text-slate-400 whitespace-nowrap">Last Active</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((q, i) => {
                  const key     = q.sql_id || `row-${i}`;
                  const isOpen  = expanded === key;
                  const elapsed = parseFloat(q.avg_elapsed_sec) || 0;
                  const diskR   = parseFloat(q.avg_disk_reads)  || 0;
                  return (
                    <React.Fragment key={key}>
                      <tr
                        className={`border-b border-slate-100 cursor-pointer transition-colors ${isOpen ? 'bg-orange-50' : 'hover:bg-slate-50'}`}
                        onClick={() => setExpanded(isOpen ? null : key)}
                      >
                        <td className="px-3 py-3 text-slate-400">
                          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-600 whitespace-nowrap">{q.sql_id || '—'}</td>
                        <td className="px-4 py-3 max-w-xs">
                          <span className="font-mono text-xs text-slate-700 truncate block max-w-xs">
                            {(q.sql_text || '').slice(0, 80)}{(q.sql_text || '').length > 80 ? '…' : ''}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-xs text-slate-500 whitespace-nowrap">{q.parsing_schema_name || '—'}</td>
                        <td className="px-3 py-3 text-right text-xs text-slate-600">{Number(q.executions || 0).toLocaleString()}</td>
                        <td className="px-3 py-3 text-right">
                          <span className={`text-xs font-black ${elapsed > 10 ? 'text-red-600' : elapsed > 2 ? 'text-orange-500' : 'text-slate-700'}`}>
                            {elapsed.toFixed(3)}s
                          </span>
                        </td>
                        <td className="px-3 py-3 text-right text-xs text-slate-500">{parseFloat(q.avg_cpu_sec || 0).toFixed(3)}s</td>
                        <td className="px-3 py-3 text-right">
                          <span className={`text-xs font-semibold ${diskR > 1000 ? 'text-yellow-600' : 'text-slate-500'}`}>
                            {Number(Math.round(diskR)).toLocaleString()}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-right text-xs text-slate-500">
                          {Number(Math.round(parseFloat(q.avg_buffer_gets) || 0)).toLocaleString()}
                        </td>
                        <td className="px-3 py-3 text-xs text-slate-400 whitespace-nowrap">{q.last_active_time || '—'}</td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-orange-50 border-b border-orange-100">
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
          )}
        </div>

      </div>
    </div>
  );
}

/* ── Query Detail panel ── */
function QueryDetail({ q }) {
  const elapsed    = parseFloat(q.avg_elapsed_sec) || 0;
  const cpu        = parseFloat(q.avg_cpu_sec)     || 0;
  const diskReads  = parseFloat(q.avg_disk_reads)  || 0;
  const bufGets    = parseFloat(q.avg_buffer_gets) || 0;
  const executions = parseInt(q.executions, 10)    || 0;
  const rows       = parseInt(q.rows_processed, 10) || 0;

  const warnings = [];
  if (elapsed > 10)
    warnings.push({ level: 'error', title: 'Very Slow Query', text: `Avg elapsed ${elapsed.toFixed(3)}s exceeds 10 seconds.`, fix: 'Review execution plan, consider adding hints or indexes.' });
  if (diskReads > 10000)
    warnings.push({ level: 'error', title: 'Excessive Physical I/O', text: `Avg ${Math.round(diskReads).toLocaleString()} disk reads per execution.`, fix: 'Check for missing indexes or full table scans in execution plan.' });
  if (diskReads > 1000 && diskReads <= 10000)
    warnings.push({ level: 'warn', title: 'High Physical Reads', text: `Avg ${Math.round(diskReads).toLocaleString()} disk reads per execution.`, fix: 'Investigate buffer cache hit ratio and access path.' });
  if (bufGets > 100000)
    warnings.push({ level: 'warn', title: 'High Logical Reads', text: `Avg ${Math.round(bufGets).toLocaleString()} buffer gets per execution — high CPU pressure.`, fix: 'Consider tuning the query or adding a suitable index.' });

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Full SQL Text</p>
        <div className="flex items-start gap-2">
          <pre className="flex-1 bg-white border border-slate-200 rounded-xl p-3 text-xs font-mono text-slate-800 overflow-auto max-h-52 whitespace-pre-wrap break-all">
            {q.sql_text || '(empty)'}
          </pre>
          <CopyBtn text={q.sql_text || ''} />
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-2">
        {[
          { label: 'SQL ID',          value: q.sql_id || '—' },
          { label: 'Executions',      value: executions.toLocaleString() },
          { label: 'Avg Elapsed',     value: `${elapsed.toFixed(3)}s` },
          { label: 'Avg CPU',         value: `${cpu.toFixed(3)}s` },
          { label: 'Avg Disk Reads',  value: Math.round(diskReads).toLocaleString(), warn: diskReads > 1000 },
          { label: 'Avg Buffer Gets', value: Math.round(bufGets).toLocaleString(),   warn: bufGets > 100000 },
          { label: 'Rows Processed',  value: rows.toLocaleString() },
          { label: 'Parsing Schema',  value: q.parsing_schema_name || '—' },
          { label: 'Last Active',     value: q.last_active_time || '—' },
        ].map(({ label, value, warn }) => (
          <div key={label} className={`rounded-xl border p-2.5 ${warn ? 'bg-amber-50 border-amber-200' : 'bg-white border-slate-200'}`}>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide">{label}</p>
            <p className={`font-bold text-sm mt-0.5 break-all ${warn ? 'text-amber-700' : 'text-slate-800'}`}>{value}</p>
          </div>
        ))}
      </div>

      {warnings.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Performance Issues</p>
          {warnings.map((w, i) => (
            <div key={i} className={`rounded-xl border px-3 py-2 text-xs ${w.level === 'error' ? 'bg-red-50 border-red-200 text-red-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
              <div className="flex items-center gap-2 font-bold mb-0.5">
                <AlertTriangle size={12} />
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
