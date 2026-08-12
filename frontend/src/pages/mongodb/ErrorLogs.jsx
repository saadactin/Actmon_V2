import React, { useState } from 'react';
import { Paged } from '@/components/ui/Pagination';
import PageHeader from '@/components/layout/PageHeader';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, RefreshCw, FileText, AlertTriangle, CheckCircle2,
  XCircle, AlertCircle, Info, Search, Shield,
} from 'lucide-react';
import client from '@/api/client';
import { PageLoading } from '@/components/ui/Loading';

const fetchErrorLogs = (id) =>
  client.get(`/connections/mongodb/${id}/mongo-error-logs`).then(r => r.data);

/* ── severity mapping ── */
const SEV_MAP = {
  F: 'FATAL',
  E: 'ERROR',
  W: 'WARNING',
  I: 'INFO',
  D: 'DEBUG',
  D1: 'DEBUG',
  D2: 'DEBUG',
  D3: 'DEBUG',
  D4: 'DEBUG',
  D5: 'DEBUG',
};

function resolveSeverity(raw) {
  if (!raw) return 'INFO';
  const up = String(raw).toUpperCase().trim();
  return SEV_MAP[up] || SEV_MAP[up[0]] || up;
}

const SEV_CFG = {
  FATAL:   { badge: 'bg-red-200 text-red-900',      row: 'bg-red-50',       icon: XCircle,        ring: 'text-red-600' },
  ERROR:   { badge: 'bg-red-100 text-red-700',       row: 'bg-red-50/50',    icon: AlertCircle,    ring: 'text-red-500' },
  WARNING: { badge: 'bg-amber-100 text-amber-700',   row: 'bg-amber-50/40',  icon: AlertTriangle,  ring: 'text-amber-500' },
  INFO:    { badge: 'bg-slate-100 text-slate-600',   row: '',                icon: Info,           ring: 'text-slate-400' },
  DEBUG:   { badge: 'bg-blue-50 text-blue-600',      row: '',                icon: Info,           ring: 'text-blue-400' },
};

function getSevCfg(sev) {
  return SEV_CFG[sev] || SEV_CFG.INFO;
}

const SEVERITY_ORDER = ['ALL', 'FATAL', 'ERROR', 'WARNING', 'INFO', 'DEBUG'];

/* ── KPI card ── */
function SevCard({ label, count, sev, active, onClick }) {
  const cfg  = getSevCfg(sev);
  const Icon = cfg.icon;
  return (
    <button onClick={onClick}
      className={`rounded-2xl border p-4 text-left hover:shadow-md transition-all w-full ${
        active ? `${cfg.badge} border-2 shadow-md` : 'bg-white border-slate-200'
      }`}>
      <div className="flex justify-between items-start">
        <div>
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">{label}</p>
          <p className={`text-2xl font-black mt-1 ${
            sev === 'FATAL'   ? 'text-red-700'   :
            sev === 'ERROR'   ? 'text-red-600'   :
            sev === 'WARNING' ? 'text-amber-600' :
            sev === 'INFO'    ? 'text-slate-600' : 'text-blue-600'
          }`}>{count}</p>
        </div>
        <Icon size={18} className={cfg.ring} />
      </div>
    </button>
  );
}

/* ── Main page ── */
export default function ErrorLogs() {
  const { id } = useParams();
  const [sevFilter, setSevFilter] = useState('ALL');
  const [search,    setSearch]    = useState('');

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['mongoErrorLogs', id],
    queryFn:  () => fetchErrorLogs(id),
    retry: false,
    refetchInterval: 30000,
  });

  /* ── loading ── */
  if (isLoading) return (
    <PageLoading title="Loading error logs…" />
  );

  /* ── error ── */
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

  /* normalise entries — backend may use different field names */
  const rawLogs = data?.logs || data?.entries || data?.error_logs || [];

  const logs = rawLogs.map(entry => ({
    ...entry,
    _severity: resolveSeverity(entry.severity || entry.s || entry.level || 'I'),
    _logged:   entry.logged || entry.timestamp || entry.t || entry.time || '—',
    _component:entry.component || entry.c || entry.ctx || '—',
    _context:  entry.context || entry.ctx || entry.attr?.ctx || '—',
    _message:  entry.message || entry.msg || entry.attr?.message || '—',
  }));

  /* counts */
  const counts = {
    FATAL:   logs.filter(l => l._severity === 'FATAL').length,
    ERROR:   logs.filter(l => l._severity === 'ERROR').length,
    WARNING: logs.filter(l => l._severity === 'WARNING').length,
    INFO:    logs.filter(l => l._severity === 'INFO').length,
    DEBUG:   logs.filter(l => l._severity === 'DEBUG').length,
  };

  /* filtered list */
  const filtered = logs.filter(l => {
    const okSev    = sevFilter === 'ALL' || l._severity === sevFilter;
    const okSearch = !search ||
      l._message.toLowerCase().includes(search.toLowerCase()) ||
      l._component.toLowerCase().includes(search.toLowerCase()) ||
      l._context.toLowerCase().includes(search.toLowerCase());
    return okSev && okSearch;
  });

  const criticalCount = counts.FATAL + counts.ERROR;

  return (
    <div>

      {/* ── Header ── */}
      <PageHeader
        icon={FileText}
        title="Error Logs"
        subtitle="MongoDB diagnostic log — severity-filtered view"
        backTo={`/mongodb-dashboard/${id}`}
        actions={(
          <button onClick={() => refetch()}
            className="flex items-center gap-2 h-9 px-4 rounded-control border border-border text-[13px] font-semibold text-muted hover:bg-sunken hover:text-fg">
            <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} /> Refresh
          </button>
        )}
      />

      <div className="p-5 space-y-4">

        {/* ── Severity KPI cards ── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          {(['FATAL', 'ERROR', 'WARNING', 'INFO', 'DEBUG'] ).map(sev => (
            <SevCard
              key={sev}
              label={sev}
              count={counts[sev]}
              sev={sev}
              active={sevFilter === sev}
              onClick={() => setSevFilter(sevFilter === sev ? 'ALL' : sev)}
            />
          ))}
        </div>

        {/* ── Critical alert banner ── */}
        {criticalCount > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-3 flex items-center gap-3">
            <Shield className="text-red-500 flex-shrink-0" size={16} />
            <span className="text-red-700 text-sm font-semibold">
              {criticalCount} fatal/error event{criticalCount !== 1 ? 's' : ''} detected in MongoDB logs
            </span>
          </div>
        )}

        {/* ── Filter bar ── */}
        <div className="bg-white rounded-2xl border border-slate-200 p-3 flex flex-wrap gap-3 items-center">
          <div className="flex gap-1 flex-wrap">
            {SEVERITY_ORDER.map(s => (
              <button key={s} onClick={() => setSevFilter(s)}
                className={`px-3 h-7 rounded-lg text-xs font-bold transition-all ${
                  sevFilter === s ? 'bg-slate-900 text-white' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}>
                {s === 'ALL' ? `All (${logs.length})` : `${s} (${counts[s] ?? 0})`}
              </button>
            ))}
          </div>
          <div className="relative ml-auto">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search messages, components..."
              className="pl-8 pr-3 h-8 rounded-xl border border-slate-200 text-xs outline-none focus:border-emerald-400 w-60" />
          </div>
          <span className="text-xs text-slate-400">{filtered.length} entries</span>
        </div>

        {/* ── Log table ── */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          {logs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center px-6">
              <CheckCircle2 size={32} className="text-emerald-400 mb-3" />
              <p className="font-semibold text-slate-700">No log entries found</p>
              <p className="text-xs text-slate-400 mt-2 max-w-md">
                The MongoDB diagnostic log returned no entries. Ensure the log level is configured and the server has write access to the log path.
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-slate-400 text-sm">No entries match the current filter</p>
            </div>
          ) : (
            <div className="overflow-auto max-h-[640px]">
              <Paged rows={filtered} unit="log entries">{(pageRows, pager) => (<>
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-white border-b border-slate-200 z-10">
                  <tr>
                    <th className="px-4 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Logged</th>
                    <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Severity</th>
                    <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Component</th>
                    <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Context</th>
                    <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((log, i) => {
                    const cfg  = getSevCfg(log._severity);
                    const Icon = cfg.icon;
                    return (
                      <tr key={i} className={`border-t border-slate-100 ${cfg.row}`}>
                        <td className="px-4 py-2 font-mono text-slate-400 whitespace-nowrap text-[10px]">
                          {log._logged}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${cfg.badge}`}>
                            <Icon size={9} />
                            {log._severity}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-slate-500 whitespace-nowrap font-mono text-[10px]">
                          {log._component}
                        </td>
                        <td className="px-3 py-2 text-slate-400 whitespace-nowrap font-mono text-[10px]">
                          {log._context}
                        </td>
                        <td className="px-3 py-2 text-slate-700 max-w-2xl break-words">
                          {log._message}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {pager}
              </>)}</Paged>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
