import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, RefreshCw, FileText, ArrowLeft,
  CheckCircle2, XCircle, Info, AlertCircle, Search, Zap,
  Bug,
} from 'lucide-react';
import client from '../../api/client';

const fetchErrorLogs = (id) =>
  client.get(`/connections/postgresql/${id}/pg-error-logs`).then(r => r.data);

const SEVS = ['ALL', 'FATAL', 'ERROR', 'WARNING', 'LOG', 'INFO', 'DEBUG'];

const SEV = {
  FATAL:   { badge: 'bg-red-100 text-red-900',      row: 'bg-red-50',        border: 'border-red-300',    icon: XCircle },
  ERROR:   { badge: 'bg-red-50 text-red-700',        row: 'bg-red-50/40',     border: 'border-red-200',    icon: AlertCircle },
  WARNING: { badge: 'bg-amber-50 text-amber-700',    row: 'bg-amber-50/40',   border: 'border-amber-100',  icon: AlertTriangle },
  LOG:     { badge: 'bg-blue-50 text-blue-700',      row: 'bg-blue-50/20',    border: 'border-blue-100',   icon: FileText },
  INFO:    { badge: 'bg-slate-100 text-slate-500',   row: '',                 border: 'border-slate-100',  icon: Info },
  DEBUG:   { badge: 'bg-purple-50 text-purple-600',  row: 'bg-purple-50/20',  border: 'border-purple-100', icon: Bug },
};

export default function ErrorLogs() {
  const { id }          = useParams();
  const [sev, setSev]         = useState('ALL');
  const [search, setSearch]   = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['pgErrorLogs', id],
    queryFn: () => fetchErrorLogs(id),
    retry: false,
    refetchInterval: 30000,
  });

  if (isLoading) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center">
        <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mx-auto mb-3" />
        <p className="text-slate-500 text-sm">Loading error logs…</p>
      </div>
    </div>
  );

  if (error) return (
    <div className="p-6">
      <div className="bg-red-50 border border-red-200 rounded-2xl p-6 max-w-lg">
        <AlertTriangle className="text-red-500 mb-2" size={20} />
        <p className="font-bold text-red-700">Failed to load error logs</p>
        <p className="text-sm text-red-600 mt-1">{error.message}</p>
        <button onClick={() => refetch()} className="mt-3 px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-bold">Retry</button>
      </div>
    </div>
  );

  const logs    = data?.logs    || [];
  const source  = data?.source  || 'unknown';
  const logPath = data?.log_path || '';
  const note    = data?.note    || '';

  const counts = {
    FATAL:   logs.filter(l => l.severity === 'FATAL').length,
    ERROR:   logs.filter(l => l.severity === 'ERROR').length,
    WARNING: logs.filter(l => l.severity === 'WARNING').length,
    LOG:     logs.filter(l => l.severity === 'LOG').length,
    INFO:    logs.filter(l => l.severity === 'INFO').length,
    DEBUG:   logs.filter(l => l.severity === 'DEBUG').length,
  };

  const filtered = logs.filter(l => {
    const okSev    = sev === 'ALL' || l.severity === sev;
    const okSearch = !search || (l.message || '').toLowerCase().includes(search.toLowerCase());
    return okSev && okSearch;
  });

  const critErrors = counts.FATAL + counts.ERROR;

  return (
    <div className="min-h-screen bg-slate-50">

      {/* Header */}
      <div className="bg-gradient-to-r from-slate-900 via-blue-900 to-indigo-800 text-white px-6 py-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-4">
            <Link to={`/postgresql-dashboard/${id}`}
              className="w-9 h-9 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 flex items-center justify-center">
              <ArrowLeft size={16} />
            </Link>
            <div>
              <h1 className="text-xl font-black tracking-tight flex items-center gap-2">
                <FileText size={18} className="text-blue-300" /> Error Logs
              </h1>
              <p className="text-blue-300 text-xs mt-0.5">
                {source === 'pg_log'
                  ? `Source: PostgreSQL log file${logPath ? ' · ' + logPath : ''}`
                  : source === 'pg_stat_activity'
                    ? 'Source: pg_stat_activity (live sessions with errors)'
                    : source === 'none'
                      ? 'Log not accessible — see details below'
                      : `Source: ${source}`}
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

        {/* Severity count cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {['FATAL','ERROR','WARNING','LOG','INFO','DEBUG'].map(s => {
            const cfg  = SEV[s];
            const Icon = cfg.icon;
            const active = sev === s;
            return (
              <button key={s} onClick={() => setSev(active ? 'ALL' : s)}
                className={`rounded-2xl border p-4 text-left hover:shadow-md transition-all ${
                  active ? `${cfg.badge} ${cfg.border} border-2 shadow-md` : 'bg-white border-slate-200'
                }`}>
                <div className="flex justify-between items-start">
                  <div>
                    <p className="text-[10px] font-bold text-slate-400 uppercase">{s}</p>
                    <p className={`text-2xl font-black mt-1 ${
                      active ? '' :
                      s === 'FATAL'   ? 'text-red-800'   :
                      s === 'ERROR'   ? 'text-red-600'   :
                      s === 'WARNING' ? 'text-amber-600' :
                      s === 'LOG'     ? 'text-blue-600'  :
                      s === 'DEBUG'   ? 'text-purple-600':
                      'text-slate-600'
                    }`}>
                      {counts[s]}
                    </p>
                  </div>
                  <Icon size={18} className={
                    s === 'FATAL'   ? 'text-red-700'    :
                    s === 'ERROR'   ? 'text-red-500'    :
                    s === 'WARNING' ? 'text-amber-500'  :
                    s === 'LOG'     ? 'text-blue-500'   :
                    s === 'DEBUG'   ? 'text-purple-500' :
                    'text-slate-400'
                  } />
                </div>
              </button>
            );
          })}
        </div>

        {/* Alert CTA */}
        {critErrors > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-3 flex items-center gap-3">
            <AlertTriangle className="text-red-500 flex-shrink-0" size={16} />
            <span className="text-red-700 text-sm font-semibold">
              {critErrors} fatal/error event{critErrors !== 1 ? 's' : ''} detected
            </span>
          </div>
        )}

        {/* Filter bar */}
        <div className="bg-white rounded-2xl border border-slate-200 p-3 flex flex-wrap gap-3 items-center">
          <div className="flex gap-1 flex-wrap">
            {SEVS.map(s => (
              <button key={s} onClick={() => setSev(s)}
                className={`px-3 h-7 rounded-lg text-xs font-bold transition-all ${
                  sev === s ? 'bg-slate-900 text-white' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}>
                {s === 'ALL'
                  ? `All (${logs.length})`
                  : `${s} (${counts[s] ?? 0})`}
              </button>
            ))}
          </div>
          <div className="relative ml-auto">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search messages…"
              className="pl-7 pr-3 h-8 rounded-xl border border-slate-200 text-xs outline-none focus:border-blue-500 w-56" />
          </div>
          <span className="text-xs text-slate-400">{filtered.length} entries</span>
        </div>

        {/* Log table */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          {logs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center px-6">
              <CheckCircle2 size={32} className="text-green-400 mb-3" />
              <p className="font-semibold text-slate-700">No log entries found</p>
              <p className="text-xs text-slate-400 mt-2 max-w-md">
                {note || (source === 'none'
                  ? 'Log file not accessible from the backend server. Ensure log_destination and log_directory are configured in postgresql.conf.'
                  : 'No log entries were retrieved.')}
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-slate-400 text-sm">No entries match the current filter</p>
            </div>
          ) : (
            <div className="overflow-auto max-h-[600px]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-white border-b border-slate-200 z-10">
                  <tr>
                    <th className="px-4 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Timestamp</th>
                    <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Severity</th>
                    <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Context</th>
                    <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((log, i) => {
                    const cfg  = SEV[log.severity] || SEV.INFO;
                    const Icon = cfg.icon;
                    return (
                      <tr key={i} className={`border-t border-slate-100 ${cfg.row}`}>
                        <td className="px-4 py-2 font-mono text-slate-500 whitespace-nowrap">
                          {log.timestamp || log.logged || '—'}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${cfg.badge}`}>
                            <Icon size={9} />
                            {log.severity}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-slate-400 whitespace-nowrap">
                          {log.context || log.subsystem || log.pid ? (
                            <span className="font-mono">
                              {[log.context, log.subsystem, log.pid ? `PID:${log.pid}` : null].filter(Boolean).join(' · ')}
                            </span>
                          ) : '—'}
                        </td>
                        <td className="px-3 py-2 text-slate-700 max-w-2xl break-words">
                          {log.message}
                          {log.detail && (
                            <p className="text-slate-400 mt-0.5 text-[10px]">Detail: {log.detail}</p>
                          )}
                          {log.hint && (
                            <p className="text-blue-500 mt-0.5 text-[10px]">Hint: {log.hint}</p>
                          )}
                        </td>
                      </tr>
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
