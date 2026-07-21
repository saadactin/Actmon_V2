import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, RefreshCw, FileText, Search, AlertTriangle,
  CheckCircle2, XCircle, AlertCircle, Info, Bug,
  ChevronDown, ChevronRight,
} from 'lucide-react';
import client from '../../api/client';

const fetchErrorLogs = (id) =>
  client.get(`/connections/clickhouse/${id}/ch-error-logs`).then(r => r.data);

/* ── Severity config ── */
const SEV_ORDER = ['Fatal', 'Critical', 'Error', 'Warning', 'Notice', 'Information', 'Debug', 'Trace'];

const SEV_CFG = {
  Fatal:       { badge: 'bg-red-200 text-red-900',      row: 'bg-red-50',        border: 'border-red-300',    icon: XCircle,      dot: 'bg-red-600'    },
  Critical:    { badge: 'bg-red-100 text-red-800',      row: 'bg-red-50/60',     border: 'border-red-200',    icon: XCircle,      dot: 'bg-red-500'    },
  Error:       { badge: 'bg-orange-100 text-orange-800',row: 'bg-orange-50/40',  border: 'border-orange-200', icon: AlertCircle,  dot: 'bg-orange-500' },
  Warning:     { badge: 'bg-amber-100 text-amber-800',  row: 'bg-amber-50/30',   border: 'border-amber-200',  icon: AlertTriangle,dot: 'bg-amber-500'  },
  Notice:      { badge: 'bg-yellow-100 text-yellow-800',row: '',                  border: 'border-yellow-200', icon: Info,         dot: 'bg-yellow-400' },
  Information: { badge: 'bg-blue-100 text-blue-700',    row: '',                  border: 'border-blue-100',   icon: Info,         dot: 'bg-blue-400'   },
  Debug:       { badge: 'bg-slate-100 text-slate-500',  row: '',                  border: 'border-slate-100',  icon: Bug,          dot: 'bg-slate-400'  },
  Trace:       { badge: 'bg-slate-50 text-slate-400',   row: '',                  border: 'border-slate-100',  icon: Bug,          dot: 'bg-slate-300'  },
};

const FALLBACK_CFG = { badge: 'bg-slate-100 text-slate-500', row: '', border: 'border-slate-100', icon: Info, dot: 'bg-slate-300' };

function normalizeSeverity(raw) {
  if (!raw) return 'Information';
  const lower = String(raw).toLowerCase();
  for (const s of SEV_ORDER) {
    if (lower === s.toLowerCase() || lower.includes(s.toLowerCase())) return s;
  }
  return 'Information';
}

/* ── Source tabs ── */
const SOURCE_TABS = ['All', 'text_log', 'query_exceptions'];

export default function ErrorLogs() {
  const { id } = useParams();
  const [sevFilter, setSevFilter]       = useState('All');
  const [sourceTab, setSourceTab]       = useState('All');
  const [search, setSearch]             = useState('');
  const [expanded, setExpanded]         = useState(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['chErrorLogs', id],
    retry: false,
    queryFn: () => fetchErrorLogs(id),
    refetchInterval: 30000,
  });

  if (isLoading) return <Spinner />;
  if (error)     return <Err msg={error.message} onRetry={refetch} />;

  /* Normalise entries from both sources */
  const textLogs      = (data?.text_log || []).map(e => ({ ...e, _source: 'text_log',        severity: normalizeSeverity(e.level || e.severity) }));
  const queryExcepts  = (data?.query_exceptions || data?.query_log_exceptions || []).map(e => ({ ...e, _source: 'query_exceptions', severity: normalizeSeverity(e.type || e.exception_code || 'Error') }));
  const allLogs       = [...textLogs, ...queryExcepts].sort((a, b) =>
    String(b.event_time || b.event_date || '').localeCompare(String(a.event_time || a.event_date || ''))
  );

  /* Counts per severity */
  const counts = {};
  SEV_ORDER.forEach(s => { counts[s] = allLogs.filter(l => l.severity === s).length; });
  const criticalCount = (counts.Fatal || 0) + (counts.Critical || 0) + (counts.Error || 0);

  /* Filter */
  const filtered = allLogs.filter(l => {
    const okSev    = sevFilter === 'All' || l.severity === sevFilter;
    const okSrc    = sourceTab === 'All' || l._source === sourceTab;
    const msgText  = l.message || l.exception || l.value || '';
    const okSearch = !search || msgText.toLowerCase().includes(search.toLowerCase());
    return okSev && okSrc && okSearch;
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
                <FileText size={18} className="text-yellow-300" /> ClickHouse Error Logs
              </h1>
              <p className="text-yellow-300 text-xs mt-0.5">
                Sources: system.text_log + system.query_log exceptions
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

        {/* Severity cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-2">
          {SEV_ORDER.map(s => {
            const cfg    = SEV_CFG[s] || FALLBACK_CFG;
            const Icon   = cfg.icon;
            const active = sevFilter === s;
            return (
              <button key={s} onClick={() => setSevFilter(active ? 'All' : s)}
                className={`rounded-2xl border p-3 text-left hover:shadow-md transition-all ${
                  active ? `${cfg.badge} ${cfg.border} border-2 shadow-md` : 'bg-white border-slate-200'
                }`}>
                <div className="flex items-center justify-between gap-1 mb-1">
                  <Icon size={13} className={counts[s] > 0 ? 'text-current' : 'text-slate-300'} />
                  <span className={`text-[9px] font-bold px-1 rounded ${cfg.dot} bg-opacity-20`}>&nbsp;</span>
                </div>
                <p className="text-[9px] font-bold text-slate-400 uppercase leading-none">{s}</p>
                <p className={`text-xl font-black mt-0.5 ${active ? 'text-current' : counts[s] > 0 && ['Fatal','Critical','Error'].includes(s) ? 'text-red-600' : counts[s] > 0 && s === 'Warning' ? 'text-amber-600' : 'text-slate-700'}`}>
                  {counts[s] || 0}
                </p>
              </button>
            );
          })}
        </div>

        {/* Critical alert banner */}
        {criticalCount > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-3 flex items-center gap-3">
            <AlertTriangle className="text-red-500 flex-shrink-0" size={16} />
            <span className="text-red-700 text-sm font-semibold">
              {criticalCount} critical/error event{criticalCount !== 1 ? 's' : ''} detected in ClickHouse logs
            </span>
          </div>
        )}

        {/* Filter bar */}
        <div className="bg-white rounded-2xl border border-slate-200 p-3 flex flex-wrap gap-3 items-center">
          {/* Source tabs */}
          <div className="flex gap-1">
            {SOURCE_TABS.map(s => (
              <button key={s} onClick={() => setSourceTab(s)}
                className={`px-3 h-7 rounded-lg text-xs font-bold transition-all ${
                  sourceTab === s ? 'bg-slate-900 text-white' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}>
                {s === 'All' ? `All (${allLogs.length})` :
                 s === 'text_log' ? `text_log (${textLogs.length})` :
                 `query exceptions (${queryExcepts.length})`}
              </button>
            ))}
          </div>
          {/* Severity pills */}
          <div className="flex gap-1 flex-wrap">
            {['All', ...SEV_ORDER].map(s => {
              const active = sevFilter === s;
              const cnt = s === 'All' ? allLogs.length : counts[s] || 0;
              return (
                <button key={s} onClick={() => setSevFilter(s)}
                  className={`px-2 h-6 rounded-md text-[10px] font-bold transition-all ${
                    active ? 'bg-amber-600 text-white' : 'border border-slate-200 text-slate-500 hover:bg-slate-50'
                  }`}>
                  {s} {cnt > 0 && <span className="opacity-70">({cnt})</span>}
                </button>
              );
            })}
          </div>
          <div className="relative ml-auto">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search messages…"
              className="pl-7 pr-3 h-8 rounded-xl border border-slate-200 text-xs outline-none focus:border-amber-500 w-56" />
          </div>
          <span className="text-xs text-slate-400">{filtered.length} entries</span>
        </div>

        {/* Log table */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          {allLogs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center px-6">
              <CheckCircle2 size={32} className="text-green-400 mb-3" />
              <p className="font-semibold text-slate-700">No log entries found</p>
              <p className="text-xs text-slate-400 mt-2 max-w-md">
                system.text_log may be disabled or empty. Ensure log_level is set appropriately in ClickHouse config.
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-slate-400 text-sm">No entries match the current filters.</p>
            </div>
          ) : (
            <div className="overflow-auto max-h-[640px]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-white border-b border-slate-200 z-10">
                  <tr>
                    <th className="w-8 px-3 py-3" />
                    <th className="px-4 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Timestamp</th>
                    <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Severity</th>
                    <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Source</th>
                    <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Logger / Query ID</th>
                    <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((log, i) => {
                    const cfg  = SEV_CFG[log.severity] || FALLBACK_CFG;
                    const Icon = cfg.icon;
                    const key  = `log-${i}`;
                    const isOpen = expanded === key;
                    const msgText = log.message || log.exception || log.value || '—';
                    const isTruncated = msgText.length > 140;
                    return (
                      <React.Fragment key={key}>
                        <tr
                          className={`border-t border-slate-100 ${cfg.row} ${isTruncated ? 'cursor-pointer' : ''} hover:brightness-95 transition-all`}
                          onClick={() => isTruncated && setExpanded(isOpen ? null : key)}>
                          <td className="px-3 py-2.5 text-slate-400">
                            {isTruncated
                              ? (isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />)
                              : <span className="w-3.5 inline-block" />
                            }
                          </td>
                          <td className="px-4 py-2.5 font-mono text-slate-500 whitespace-nowrap">
                            {String(log.event_time || log.event_date || '—').slice(0, 19)}
                          </td>
                          <td className="px-3 py-2.5">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${cfg.badge}`}>
                              <Icon size={9} />
                              {log.severity}
                            </span>
                          </td>
                          <td className="px-3 py-2.5">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              log._source === 'text_log'
                                ? 'bg-yellow-100 text-yellow-700'
                                : 'bg-orange-100 text-orange-700'
                            }`}>
                              {log._source === 'text_log' ? 'text_log' : 'query_log'}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 font-mono text-[10px] text-slate-400 max-w-[150px] truncate">
                            {log.logger_name || log.query_id || '—'}
                          </td>
                          <td className="px-3 py-2.5 text-slate-700 max-w-2xl">
                            <span className={isTruncated && !isOpen ? 'truncate block' : ''}>
                              {isTruncated && !isOpen ? msgText.slice(0, 140) + '…' : msgText.slice(0, 140)}
                            </span>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className={`border-t border-slate-100 ${cfg.row}`}>
                            <td colSpan={6} className="px-6 py-4">
                              <LogDetail log={log} />
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

/* ── Log Detail ── */
function LogDetail({ log }) {
  const msgText = log.message || log.exception || log.value || '—';
  return (
    <div className="space-y-3">
      <div>
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Full Message</p>
        <pre className="bg-white border border-slate-200 rounded-xl p-3 text-xs font-mono text-slate-800 overflow-auto max-h-52 whitespace-pre-wrap break-all">
          {msgText}
        </pre>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {log.logger_name  && <DetailPill label="Logger"      value={log.logger_name} />}
        {log.query_id     && <DetailPill label="Query ID"    value={String(log.query_id).slice(0, 24)} />}
        {log.thread_id    && <DetailPill label="Thread ID"   value={log.thread_id} />}
        {log.source_file  && <DetailPill label="Source File" value={log.source_file} />}
        {log.source_line  && <DetailPill label="Source Line" value={log.source_line} />}
        {log.user         && <DetailPill label="User"        value={log.user} />}
        {log.exception_code && <DetailPill label="Error Code" value={log.exception_code} warn />}
        {log.stack_trace  && <DetailPill label="Stack Trace" value="(see below)" />}
      </div>
      {log.stack_trace && (
        <div>
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Stack Trace</p>
          <pre className="bg-white border border-slate-200 rounded-xl p-3 text-[10px] font-mono text-slate-600 overflow-auto max-h-40 whitespace-pre-wrap">
            {log.stack_trace}
          </pre>
        </div>
      )}
    </div>
  );
}

function DetailPill({ label, value, warn }) {
  return (
    <div className={`rounded-xl border p-2.5 ${warn ? 'bg-amber-50 border-amber-200' : 'bg-white border-slate-200'}`}>
      <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide">{label}</p>
      <p className={`font-bold text-xs mt-0.5 truncate ${warn ? 'text-amber-700' : 'text-slate-700'}`}>{value}</p>
    </div>
  );
}

function Spinner() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center">
        <div className="w-10 h-10 border-4 border-yellow-200 border-t-yellow-500 rounded-full animate-spin mx-auto mb-3" />
        <p className="text-slate-500 text-sm">Loading error logs…</p>
      </div>
    </div>
  );
}

function Err({ msg, onRetry }) {
  return (
    <div className="p-6">
      <div className="bg-red-50 border border-red-200 rounded-2xl p-6 max-w-lg">
        <AlertTriangle className="text-red-500 mb-2" size={20} />
        <p className="font-bold text-red-700">Failed to load error logs</p>
        <p className="text-sm text-red-600 mt-1">{msg}</p>
        <button onClick={onRetry} className="mt-3 px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-bold">Retry</button>
      </div>
    </div>
  );
}
