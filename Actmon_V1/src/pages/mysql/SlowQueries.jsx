import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  RefreshCw, ChevronDown, ChevronRight, AlertTriangle,
  CheckCircle2, Search, Zap, Clock, ArrowLeft,
  TrendingDown, BarChart2, Info, XCircle, Filter,
} from 'lucide-react';
import client from '../../api/client';

const fetchSlowQueries = (id) =>
  client.get(`/connections/mysql/${id}/slow-queries`).then(r => r.data);

const runExplain = (id, query, database) =>
  client.post(`/connections/mysql/${id}/explain`, { query, database }).then(r => r.data);

export default function SlowQueries() {
  const { id } = useParams();
  const [expanded, setExpanded]       = useState(null);
  const [explainData, setExplainData] = useState({});
  const [explainLoad, setExplainLoad] = useState({});
  const [search, setSearch]           = useState('');
  const [minTime, setMinTime]         = useState(0);
  const [dbFilter, setDbFilter]       = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['mysqlSlowQueries', id],
    queryFn: () => fetchSlowQueries(id),
    retry: false,
    refetchInterval: 30000,
  });

  const handleExplain = async (sql, db, key) => {
    setExplainLoad(p => ({ ...p, [key]: true }));
    try {
      const r = await runExplain(id, sql, db);
      setExplainData(p => ({ ...p, [key]: r }));
    } catch (e) {
      setExplainData(p => ({ ...p, [key]: { error: e.message } }));
    } finally {
      setExplainLoad(p => ({ ...p, [key]: false }));
    }
  };

  if (isLoading) return <Spinner label="Loading slow queries…" />;
  if (error)     return <Err msg={error.message} onRetry={refetch} />;

  const config               = data?.slow_log_config || {};
  const allQueries           = [...(data?.perf_schema_queries || []), ...(data?.file_queries || [])].filter(q => !q.error);
  const source               = data?.source || 'performance_schema';
  const fileError            = data?.file_error;
  const perf_error           = data?.perf_schema_error;
  const consumers            = data?.perf_consumers || {};
  const perfSchemaEnabled    = data?.perf_schema_enabled;
  const consumersJustEnabled = data?.consumers_auto_enabled;
  const perfSchemaOff        = perfSchemaEnabled === false;

  const maxTime   = allQueries.length ? Math.max(...allQueries.map(q => +q.max_exec_sec || 0)) : 0;
  const avgAll    = allQueries.length
    ? (allQueries.reduce((s, q) => s + (+q.avg_exec_sec || 0), 0) / allQueries.length).toFixed(3)
    : 0;
  const noIndex   = allQueries.filter(q => +q.no_index_count > 0).length;
  const totalCalls = allQueries.reduce((s, q) => s + (+q.count_calls || 0), 0);
  const dbs       = [...new Set(allQueries.map(q => q.db_name).filter(Boolean))];

  const filtered = allQueries.filter(q => {
    const okSearch = !search || (q.sql_text || '').toLowerCase().includes(search.toLowerCase());
    const okTime   = +q.avg_exec_sec >= minTime;
    const okDb     = !dbFilter || q.db_name === dbFilter;
    return okSearch && okTime && okDb;
  });

  return (
    <div className="min-h-screen bg-slate-50">

      {/* Header */}
      <div className="bg-gradient-to-r from-slate-900 via-cyan-900 to-teal-800 text-white px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to={`/mysql-dashboard/${id}`}
              className="w-9 h-9 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 flex items-center justify-center">
              <ArrowLeft size={16} />
            </Link>
            <div>
              <h1 className="text-xl font-black tracking-tight flex items-center gap-2">
                <Zap size={18} className="text-yellow-400" /> Slow Queries
              </h1>
              <p className="text-cyan-300 text-xs mt-0.5">
                {source.includes('file')
                  ? 'Source: slow log file + performance_schema'
                  : 'Source: performance_schema.events_statements_summary_by_digest'}
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
            label="Unique Queries" value={allQueries.length} />
          <KpiCard icon={<Clock size={18} className="text-orange-400" />}
            label="Avg Query Time" value={`${avgAll}s`} />
          <KpiCard icon={<AlertTriangle size={18} className="text-red-400" />}
            label="Max Query Time" value={`${maxTime}s`} accent={maxTime > 10 ? 'red' : 'slate'} />
          <KpiCard icon={<TrendingDown size={18} className="text-yellow-500" />}
            label="No-Index Scans" value={noIndex} accent={noIndex > 0 ? 'yellow' : 'slate'} />
        </div>

        {/* Config badge */}
        <div className={`rounded-2xl border p-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs ${
          config.enabled ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'
        }`}>
          <span className="font-bold text-slate-700">Slow Log:</span>
          <span className={`font-black ${config.enabled ? 'text-green-700' : 'text-amber-700'}`}>
            {config.enabled ? '✓ ON' : '⚠ OFF — showing Performance Schema digest data'}
          </span>
          <span className="text-slate-500">Threshold: {config.long_query_time}s</span>
          {config.log_file && (
            <span className="text-slate-400 font-mono truncate max-w-sm">{config.log_file}</span>
          )}
          {fileError && (
            <span className="text-amber-600 ml-auto text-right max-w-md">{fileError}</span>
          )}
        </div>

        {/* Filters */}
        <div className="bg-white rounded-2xl border border-slate-200 p-3 flex flex-wrap gap-3 items-center">
          <Filter size={14} className="text-slate-400 flex-shrink-0" />
          <div className="relative flex-1 min-w-44">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search SQL text…"
              className="w-full pl-8 pr-3 h-9 rounded-xl border border-slate-200 text-sm outline-none focus:border-cyan-500" />
          </div>
          <select value={dbFilter} onChange={e => setDbFilter(e.target.value)}
            className="h-9 px-3 rounded-xl border border-slate-200 text-sm outline-none bg-white">
            <option value="">All Databases</option>
            {dbs.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <select value={minTime} onChange={e => setMinTime(Number(e.target.value))}
            className="h-9 px-3 rounded-xl border border-slate-200 text-sm outline-none bg-white">
            <option value={0}>All times</option>
            <option value={0.1}>≥ 0.1s</option>
            <option value={0.5}>≥ 0.5s</option>
            <option value={1}>≥ 1s</option>
            <option value={5}>≥ 5s</option>
            <option value={10}>≥ 10s</option>
          </select>
          <span className="text-xs text-slate-400">
            {filtered.length} / {allQueries.length} queries · {totalCalls.toLocaleString()} total calls
          </span>
        </div>

        {/* Performance Schema OFF banner */}
        {perfSchemaOff && (
          <div className="bg-orange-50 border border-orange-300 rounded-2xl p-4 space-y-2">
            <div className="flex items-center gap-2 font-bold text-orange-800">
              <AlertTriangle size={16} /> Performance Schema is DISABLED on this server
            </div>
            <p className="text-xs text-orange-700">
              <code>performance_schema = OFF</code> — slow query analysis requires Performance Schema to be enabled.
              The slow log file (<code>{config.log_file || 'slow.log'}</code>) is on the remote server and cannot be read from the backend.
            </p>
            <div className="bg-white border border-orange-200 rounded-xl p-3 text-xs font-mono text-slate-700 space-y-1">
              <p className="text-slate-400 font-sans font-bold mb-1">To enable on MariaDB/MySQL — add to <code>/etc/mysql/mariadb.conf.d/50-server.cnf</code>:</p>
              <p>performance_schema = ON</p>
              <p className="text-slate-400 font-sans mt-2">Then restart:</p>
              <p>sudo systemctl restart mariadb</p>
            </div>
            <p className="text-[11px] text-orange-600">After restart, run some queries on the database and refresh this page.</p>
          </div>
        )}

        {/* Consumer status banner */}
        {!perfSchemaOff && consumersJustEnabled && (
          <div className="bg-blue-50 border border-blue-200 rounded-2xl p-3 flex items-start gap-2 text-xs text-blue-700">
            <Info size={14} className="flex-shrink-0 mt-0.5" />
            <span>
              <strong>Performance Schema consumers auto-enabled.</strong> Future queries will now be tracked.
              Run some queries on the database and refresh this page to see data.
            </span>
          </div>
        )}
        {perf_error && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3 flex items-start gap-2 text-xs text-amber-700">
            <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
            <span><strong>Performance Schema error:</strong> {perf_error}</span>
          </div>
        )}

        {/* Query table */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
              <CheckCircle2 size={32} className="text-green-300 mb-3" />
              <p className="font-semibold text-slate-600">No query data available</p>
              <p className="text-xs text-slate-400 mt-2 max-w-md">
                {allQueries.length > 0
                  ? 'Try relaxing the filters above.'
                  : consumersJustEnabled
                    ? 'Performance Schema consumers were just enabled. Run some queries on the database, then refresh.'
                    : 'No statement digest data in performance_schema yet. Run queries on the database to populate this view, then refresh.'}
              </p>
              {allQueries.length === 0 && (
                <button onClick={() => refetch()} className="mt-3 px-4 py-2 bg-cyan-600 text-white rounded-xl text-xs font-bold hover:bg-cyan-700">
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
                  <th className="px-3 py-3 text-left text-[11px] font-bold text-slate-400 whitespace-nowrap">Database</th>
                  <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Avg Time</th>
                  <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Max Time</th>
                  <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Calls</th>
                  <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Rows/Call</th>
                  <th className="px-3 py-3 text-left text-[11px] font-bold text-slate-400 whitespace-nowrap">Last Seen</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((q, i) => {
                  const key    = `${i}__${(q.sql_text || '').slice(0, 40)}`;
                  const isOpen = expanded === key;
                  const avg    = +q.avg_exec_sec || 0;
                  const max    = +q.max_exec_sec  || 0;
                  const noIdx  = +q.no_index_count || 0;
                  const calls  = +q.count_calls   || 1;
                  const rowsPer = calls > 0 ? Math.round((+q.rows_examined || 0) / calls) : 0;
                  return (
                    <React.Fragment key={key}>
                      <tr className={`border-b border-slate-100 cursor-pointer transition-colors ${isOpen ? 'bg-cyan-50' : 'hover:bg-slate-50'}`}
                        onClick={() => setExpanded(isOpen ? null : key)}>
                        <td className="px-3 py-3 text-slate-400">
                          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </td>
                        <td className="px-4 py-3 max-w-xs">
                          <div className="flex items-center gap-2">
                            {noIdx > 0 && <span className="w-2 h-2 rounded-full bg-yellow-400 flex-shrink-0" title="No index used" />}
                            <span className="font-mono text-xs text-slate-700 truncate">
                              {(q.sql_text || '').slice(0, 90)}
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-3 text-xs text-slate-500">{q.db_name || '—'}</td>
                        <td className="px-3 py-3 text-right">
                          <span className={`text-xs font-black ${avg > 10 ? 'text-red-600' : avg > 2 ? 'text-orange-500' : 'text-slate-700'}`}>
                            {avg}s
                          </span>
                        </td>
                        <td className="px-3 py-3 text-right text-xs font-semibold text-slate-600">{max}s</td>
                        <td className="px-3 py-3 text-right text-xs text-slate-500">{calls.toLocaleString()}</td>
                        <td className="px-3 py-3 text-right text-xs text-slate-500">{rowsPer.toLocaleString()}</td>
                        <td className="px-3 py-3 text-xs text-slate-400 whitespace-nowrap">{q.last_seen || '—'}</td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-cyan-50 border-b border-cyan-100">
                          <td colSpan={8} className="px-5 py-5">
                            <QueryDetail
                              q={q} queryKey={key} connId={id}
                              onExplain={handleExplain}
                              explainResult={explainData[key]}
                              explainLoading={explainLoad[key]}
                            />
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

function QueryDetail({ q, queryKey, connId, onExplain, explainResult, explainLoading }) {
  const sql      = q.sql_text || '';
  const db       = q.db_name;
  const calls    = +q.count_calls   || 1;
  const examined = +q.rows_examined || 0;
  const returned = +q.rows_returned || 0;
  const ratio    = returned > 0 ? Math.round(examined / returned) : 0;
  const noIdx    = +q.no_index_count || 0;

  const warnings = [];
  if (noIdx > 0)
    warnings.push({ level: 'warn', title: 'No Index Used',
      text: `Ran ${noIdx} executions without a usable index — likely full table scan.`,
      fix: 'Add an index covering the columns in your WHERE / JOIN clause.' });
  if (examined > 100_000)
    warnings.push({ level: 'warn', title: 'High Row Scan',
      text: `Scans ~${examined.toLocaleString()} rows total. Very high I/O cost.`,
      fix: 'Ensure selective indexes exist and run ANALYZE TABLE.' });
  if (ratio > 100)
    warnings.push({ level: 'error', title: 'Inefficient Filter',
      text: `Examined/returned ratio ${ratio}:1 — returning only ~${Math.round(100/ratio)}% of scanned rows.`,
      fix: 'Create a more selective index or a covering index for this query pattern.' });
  if (q.avg_exec_sec > 10)
    warnings.push({ level: 'error', title: 'Very Slow Query',
      text: `Avg execution ${q.avg_exec_sec}s exceeds 10 seconds.`,
      fix: 'Profile with EXPLAIN, review indexes, consider caching or query rewrite.' });

  return (
    <div className="space-y-4">

      <div>
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Full Query</p>
        <pre className="bg-white border border-slate-200 rounded-xl p-3 text-xs font-mono text-slate-800 overflow-auto max-h-52 whitespace-pre-wrap break-all">
          {sql || '(empty)'}
        </pre>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Pill label="Avg Time"       value={`${q.avg_exec_sec}s`} />
        <Pill label="Max Time"       value={`${q.max_exec_sec}s`} />
        <Pill label="Total Time"     value={`${q.total_exec_sec}s`} />
        <Pill label="Total Calls"    value={calls.toLocaleString()} />
        <Pill label="Rows Examined"  value={examined.toLocaleString()} />
        <Pill label="Rows Returned"  value={returned.toLocaleString()} />
        <Pill label="No-Index Runs"  value={noIdx} warn={noIdx > 0} />
        <Pill label="Examine:Return" value={`${ratio}:1`} warn={ratio > 100} />
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

      <div>
        <div className="flex items-center gap-3 mb-2">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">EXPLAIN Analysis</p>
          <button onClick={() => onExplain(sql, db, queryKey)} disabled={explainLoading}
            className="px-3 h-7 rounded-lg bg-slate-900 text-white text-xs font-bold hover:bg-slate-700 disabled:opacity-50 flex items-center gap-1">
            <Zap size={11} />
            {explainLoading ? 'Running…' : explainResult ? 'Re-run EXPLAIN' : 'Run EXPLAIN'}
          </button>
        </div>
        {explainResult && <ExplainPanel result={explainResult} />}
      </div>

    </div>
  );
}

/* ── EXPLAIN Panel ────────────────────────────────────────────────────────── */

function ExplainPanel({ result }) {
  if (result?.error)
    return (
      <div className="text-red-700 text-xs bg-red-50 border border-red-200 rounded-xl p-3">
        EXPLAIN failed: {result.error}
      </div>
    );

  const rows  = result?.explain_rows || result?.rows || [];
  const hints = analyzeExplain(rows);

  if (!rows.length)
    return <div className="text-slate-400 text-xs italic">No EXPLAIN output returned</div>;

  return (
    <div className="space-y-3">
      {hints.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Optimization Hints</p>
          {hints.map((h, i) => (
            <div key={i} className={`rounded-xl border px-3 py-2 text-xs flex gap-2 ${
              h.level === 'critical' ? 'bg-red-50 border-red-200 text-red-800' :
              h.level === 'warn'    ? 'bg-amber-50 border-amber-200 text-amber-800' :
                                       'bg-blue-50 border-blue-200 text-blue-800'
            }`}>
              <span className="mt-0.5 flex-shrink-0">
                {h.level === 'critical' ? <XCircle size={12} /> :
                 h.level === 'warn'     ? <AlertTriangle size={12} /> : <Info size={12} />}
              </span>
              <div>
                <p className="font-bold">{h.title}</p>
                <p>{h.text}</p>
                {h.fix && <p className="mt-0.5 font-mono opacity-75 text-[10px]">{h.fix}</p>}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              {['#','select_type','table','type','possible_keys','key','rows','Extra'].map(c => (
                <th key={c} className="px-2 py-2 text-left font-bold text-[10px] text-slate-400">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className={`border-t border-slate-100 ${row.type === 'ALL' ? 'bg-red-50' : row.type === 'index' ? 'bg-amber-50' : ''}`}>
                <td className="px-2 py-2 font-mono">{row.id}</td>
                <td className="px-2 py-2 text-slate-600">{row.select_type}</td>
                <td className="px-2 py-2 font-semibold text-slate-800">{row.table}</td>
                <td className="px-2 py-2"><TypeBadge type={row.type} /></td>
                <td className="px-2 py-2 text-slate-400 max-w-[140px] truncate" title={row.possible_keys}>{row.possible_keys || '—'}</td>
                <td className="px-2 py-2 font-semibold text-cyan-700">{row.key || '—'}</td>
                <td className="px-2 py-2 text-right font-mono">{(+row.rows || 0).toLocaleString()}</td>
                <td className="px-2 py-2 text-slate-500 max-w-[200px] truncate" title={row.Extra}>{row.Extra || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function analyzeExplain(rows) {
  const hints = [];
  rows.forEach(row => {
    if (row.type === 'ALL')
      hints.push({ level: 'critical', title: 'Full Table Scan',
        text: `Table "${row.table}" scans all ~${(+row.rows||0).toLocaleString()} rows.`,
        fix: row.possible_keys
          ? `Keys exist (${row.possible_keys}) but not used — check data types.`
          : `Add an index on the columns used in WHERE/JOIN for "${row.table}".` });
    if (row.type === 'index')
      hints.push({ level: 'warn', title: 'Full Index Scan',
        text: `"${row.table}" scans entire index "${row.key}". Still expensive.`,
        fix: 'Add a covering index matching your WHERE + ORDER BY columns.' });
    if (row.Extra?.includes('Using filesort'))
      hints.push({ level: 'warn', title: 'Filesort',
        text: `Extra sort pass on "${row.table}". Slow for large result sets.`,
        fix: 'Create a composite index: (WHERE columns) + ORDER BY columns.' });
    if (row.Extra?.includes('Using temporary'))
      hints.push({ level: 'warn', title: 'Temporary Table',
        text: `Query builds a temp table on "${row.table}" (GROUP BY / DISTINCT).`,
        fix: 'Add an index covering GROUP BY columns, or reduce grouping scope.' });
    if (!row.key && row.possible_keys)
      hints.push({ level: 'warn', title: 'Index Not Chosen',
        text: `Available indexes (${row.possible_keys}) not used for "${row.table}".`,
        fix: 'Run ANALYZE TABLE, or use FORCE INDEX to verify.' });
    if (row.Extra?.includes('Using join buffer'))
      hints.push({ level: 'warn', title: 'Join Buffer',
        text: `Join buffer used for "${row.table}" — missing index on join column.`,
        fix: `Add an index on the JOIN column of "${row.table}".` });
  });
  return hints;
}

function TypeBadge({ type }) {
  const cls = ({ ALL:'bg-red-100 text-red-700', index:'bg-orange-100 text-orange-700', range:'bg-yellow-100 text-yellow-700', ref:'bg-blue-100 text-blue-700', eq_ref:'bg-green-100 text-green-700', const:'bg-teal-100 text-teal-700', system:'bg-teal-100 text-teal-700' })[type] || 'bg-slate-100 text-slate-700';
  return <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${cls}`}>{type || '—'}</span>;
}

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
        <div className="w-10 h-10 border-4 border-cyan-200 border-t-cyan-600 rounded-full animate-spin mx-auto mb-3" />
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
