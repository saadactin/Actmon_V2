import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, RefreshCw, FileText, AlertTriangle,
  CheckCircle2, XCircle, AlertCircle, Info, Search,
} from 'lucide-react';
import client from '../../api/client';

const fetchErrorLogs = (id) =>
  client.get(`/connections/mssql/${id}/mssql-error-logs`).then(r => r.data);

/* ── Severity classification for MSSQL (severity integer field) ── */
function classifySeverity(log) {
  const sev = Number(log.severity ?? log.error_severity ?? log.level ?? -1);
  if (sev >= 24)      return 'FATAL';
  if (sev >= 16)      return 'ERROR';
  if (sev >= 11)      return 'WARNING';
  return 'INFO';
}

const SEV_CONFIG = {
  FATAL:   { badge: 'bg-red-200 text-red-900',    row: 'bg-red-50',       border: 'border-red-200',   icon: XCircle,       color: 'text-red-600' },
  ERROR:   { badge: 'bg-red-100 text-red-700',     row: 'bg-red-50/50',    border: 'border-red-100',   icon: AlertCircle,   color: 'text-red-500' },
  WARNING: { badge: 'bg-amber-100 text-amber-700', row: 'bg-amber-50/40',  border: 'border-amber-100', icon: AlertTriangle, color: 'text-amber-500' },
  INFO:    { badge: 'bg-slate-100 text-slate-500', row: '',                border: 'border-slate-100', icon: Info,          color: 'text-slate-400' },
};

const ALL_SEVS = ['ALL', 'FATAL', 'ERROR', 'WARNING', 'INFO'];

function Spinner() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center">
        <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mx-auto mb-3" />
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
        <button onClick={onRetry} className="mt-3 px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-bold hover:bg-red-700">
          Retry
        </button>
      </div>
    </div>
  );
}

export default function MSSQLErrorLogs() {
  const { id }            = useParams();
  const [sev, setSev]     = useState('ALL');
  const [search, setSearch] = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['mssqlErrorLogs', id],
    queryFn:  () => fetchErrorLogs(id),
    retry: false,
    refetchInterval: 30000,
  });

  if (isLoading) return <Spinner />;
  if (error)     return <Err msg={error.message} onRetry={refetch} />;

  const rawLogs = Array.isArray(data) ? data : (data?.logs || data?.error_logs || []);

  /* Annotate each log with a computed severity label */
  const logs = rawLogs.map(l => ({ ...l, _sev: classifySeverity(l) }));

  const counts = {
    FATAL:   logs.filter(l => l._sev === 'FATAL').length,
    ERROR:   logs.filter(l => l._sev === 'ERROR').length,
    WARNING: logs.filter(l => l._sev === 'WARNING').length,
    INFO:    logs.filter(l => l._sev === 'INFO').length,
  };

  const filtered = logs.filter(l => {
    const okSev    = sev === 'ALL' || l._sev === sev;
    const okSearch = !search || (l.message || l.text || l.description || '').toLowerCase().includes(search.toLowerCase());
    return okSev && okSearch;
  });

  const criticalTotal = counts.FATAL + counts.ERROR;

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
                <FileText size={18} className="text-sky-300" /> MSSQL Error Logs
              </h1>
              <p className="text-sky-300 text-xs mt-0.5">
                Severity: FATAL ≥24 · ERROR 16–23 · WARNING 11–15 · INFO &lt;11
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

        {/* Severity Count Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {(['FATAL', 'ERROR', 'WARNING', 'INFO']).map(s => {
            const cfg    = SEV_CONFIG[s];
            const Icon   = cfg.icon;
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
                      s === 'FATAL'   ? 'text-red-800' :
                      s === 'ERROR'   ? 'text-red-600' :
                      s === 'WARNING' ? 'text-amber-600' : 'text-slate-600'
                    }`}>
                      {counts[s]}
                    </p>
                  </div>
                  <Icon size={18} className={cfg.color} />
                </div>
              </button>
            );
          })}
        </div>

        {/* Critical alert banner */}
        {criticalTotal > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-3 flex items-center gap-3">
            <AlertTriangle className="text-red-500 flex-shrink-0" size={16} />
            <span className="text-red-700 text-sm font-semibold">
              {criticalTotal} fatal/error event{criticalTotal !== 1 ? 's' : ''} detected
            </span>
            <button onClick={() => setSev('FATAL')}
              className="ml-auto px-3 h-7 rounded-lg bg-red-600 text-white text-xs font-bold hover:bg-red-700">
              View Fatal
            </button>
          </div>
        )}

        {/* Filter Bar */}
        <div className="bg-white rounded-2xl border border-slate-200 p-3 flex flex-wrap gap-3 items-center">
          <div className="flex gap-1 flex-wrap">
            {ALL_SEVS.map(s => (
              <button key={s} onClick={() => setSev(s)}
                className={`px-3 h-7 rounded-lg text-xs font-bold transition-all ${
                  sev === s ? 'bg-slate-900 text-white' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}>
                {s === 'ALL' ? `All (${logs.length})` : `${s} (${counts[s]})`}
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

        {/* Log Table */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          {logs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center px-6">
              <CheckCircle2 size={32} className="text-green-400 mb-3" />
              <p className="font-semibold text-slate-700">No error log entries found</p>
              <p className="text-xs text-slate-400 mt-2 max-w-md">
                The SQL Server error log returned no entries, or the account may lack VIEW SERVER STATE permission.
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-slate-400 text-sm">No entries match the current filter</p>
            </div>
          ) : (
            <div className="overflow-auto max-h-[640px]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-white border-b border-slate-200 z-10">
                  <tr>
                    <th className="px-4 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Timestamp</th>
                    <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Severity</th>
                    <th className="px-3 py-3 text-right font-bold text-[11px] text-slate-400 whitespace-nowrap">Error #</th>
                    <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Source / State</th>
                    <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((log, i) => {
                    const cfg  = SEV_CONFIG[log._sev] || SEV_CONFIG.INFO;
                    const Icon = cfg.icon;
                    const msg  = log.message || log.text || log.description || log.error_message || '—';
                    const ts   = log.log_date || log.event_time || log.timestamp || log.logged || '';
                    const errNo = log.error_number || log.error || log.message_id || '';
                    const src  = log.source || log.error_state || log.state || '';
                    return (
                      <tr key={i} className={`border-t border-slate-100 ${cfg.row}`}>
                        <td className="px-4 py-2 font-mono text-slate-500 whitespace-nowrap">
                          {ts ? String(ts).slice(0, 19) : '—'}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${cfg.badge}`}>
                            <Icon size={9} />
                            {log._sev}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-slate-400">
                          {errNo || '—'}
                        </td>
                        <td className="px-3 py-2 text-slate-400 whitespace-nowrap max-w-[120px] truncate">
                          {src || '—'}
                        </td>
                        <td className="px-3 py-2 text-slate-700 max-w-2xl break-words">
                          {msg}
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
