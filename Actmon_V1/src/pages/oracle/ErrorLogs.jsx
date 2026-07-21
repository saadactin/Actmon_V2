import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, RefreshCw, FileText, AlertTriangle, CheckCircle2,
  XCircle, AlertCircle, Info, Search, Users, Clock,
} from 'lucide-react';
import client from '../../api/client';
import PageHeader from '../../components/layout/PageHeader';

const fetchErrorLogs = (id) =>
  client.get(`/connections/oracle/${id}/oracle-error-logs`).then(r => r.data);

/* ── severity config ── */
const MSG_LEVEL = {
  1:  { label: 'CRITICAL', badge: 'bg-red-100 text-red-800',    row: 'bg-red-50',      icon: XCircle },
  2:  { label: 'ERROR',    badge: 'bg-red-50 text-red-700',     row: 'bg-red-50/40',   icon: AlertCircle },
  4:  { label: 'WARNING',  badge: 'bg-amber-50 text-amber-700', row: 'bg-amber-50/40', icon: AlertTriangle },
  16: { label: 'INFO',     badge: 'bg-slate-100 text-slate-500',row: '',               icon: Info },
};

function getLevelCfg(level) {
  // level can be numeric or string label
  if (typeof level === 'number' || /^\d+$/.test(level)) {
    return MSG_LEVEL[parseInt(level, 10)] || MSG_LEVEL[16];
  }
  const upper = String(level).toUpperCase();
  return Object.values(MSG_LEVEL).find(c => c.label === upper) || MSG_LEVEL[16];
}

function Spinner() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center">
        <div className="w-10 h-10 border-4 border-red-200 border-t-red-600 rounded-full animate-spin mx-auto mb-3" />
        <p className="text-slate-500 text-sm">Loading error logs…</p>
      </div>
    </div>
  );
}

/* ── Main page ── */
export default function ErrorLogs() {
  const { id } = useParams();
  const [alertSearch, setAlertSearch]       = useState('');
  const [levelFilter, setLevelFilter]       = useState('ALL');
  const [blockingSearch, setBlockingSearch] = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['oracleErrorLogs', id],
    queryFn: () => fetchErrorLogs(id),
    retry: false,
    refetchInterval: 30000,
  });

  if (isLoading) return <Spinner />;

  if (error) return (
    <div className="p-6">
      <div className="bg-red-50 border border-red-200 rounded-2xl p-6 max-w-lg">
        <AlertTriangle className="text-red-500 mb-2" size={20} />
        <p className="font-bold text-red-700">Failed to load Oracle error logs</p>
        <p className="text-sm text-red-600 mt-1">{error.message}</p>
        <button onClick={() => refetch()} className="mt-3 px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-bold">Retry</button>
      </div>
    </div>
  );

  const alertLogs       = data?.alert_logs        || [];
  const blockingSessions = data?.blocking_sessions || [];

  /* alert log level counts */
  const countByLabel = alertLogs.reduce((acc, log) => {
    const cfg = getLevelCfg(log.message_level);
    acc[cfg.label] = (acc[cfg.label] || 0) + 1;
    return acc;
  }, {});

  const LEVEL_FILTERS = ['ALL', 'CRITICAL', 'ERROR', 'WARNING', 'INFO'];

  const filteredAlerts = alertLogs.filter(log => {
    const cfg    = getLevelCfg(log.message_level);
    const okLvl  = levelFilter === 'ALL' || cfg.label === levelFilter;
    const okSrch = !alertSearch || (log.message_text || '').toLowerCase().includes(alertSearch.toLowerCase())
      || (log.component_id || '').toLowerCase().includes(alertSearch.toLowerCase());
    return okLvl && okSrch;
  });

  const filteredBlocking = blockingSessions.filter(s =>
    !blockingSearch ||
    (s.username || '').toLowerCase().includes(blockingSearch.toLowerCase()) ||
    (s.event || '').toLowerCase().includes(blockingSearch.toLowerCase()) ||
    (s.wait_class || '').toLowerCase().includes(blockingSearch.toLowerCase()) ||
    String(s.sid || '').includes(blockingSearch)
  );

  const critErrors = (countByLabel['CRITICAL'] || 0) + (countByLabel['ERROR'] || 0);

  return (
    <div className="min-h-full bg-brand-bg">

      <PageHeader
        icon={FileText}
        title="Oracle Error Logs"
        subtitle="Alert Log entries and active blocking sessions"
        accent="oracle"
        backTo={`/oracle-dashboard/${id}`}
        crumbs={[{ label: 'Databases', to: '/databases' }, { label: 'Oracle', to: `/oracle-dashboard/${id}` }, { label: 'Error Logs' }]}
        actions={(
          <button onClick={() => refetch()}
            className="flex items-center gap-2 px-4 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg text-sm font-semibold text-white">
            <RefreshCw size={13} /> Refresh
          </button>
        )}
      />

      <div className="py-5 space-y-6">

        {/* ── Alert Log section ── */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <FileText size={16} className="text-red-500" />
            <h2 className="font-bold text-slate-800">Alert Log</h2>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-500">
              {alertLogs.length} entries
            </span>
            {critErrors > 0 && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-700">
                {critErrors} critical/error
              </span>
            )}
          </div>

          {/* Level summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {(['CRITICAL', 'ERROR', 'WARNING', 'INFO']).map(label => {
              const cfg  = Object.values(MSG_LEVEL).find(c => c.label === label);
              const Icon = cfg.icon;
              const cnt  = countByLabel[label] || 0;
              const active = levelFilter === label;
              return (
                <button key={label}
                  onClick={() => setLevelFilter(active ? 'ALL' : label)}
                  className={`rounded-2xl border p-4 text-left hover:shadow-md transition-all ${
                    active ? `${cfg.badge} border-2 shadow-md` : 'bg-white border-slate-200'
                  }`}>
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="text-[10px] font-bold text-slate-400 uppercase">{label}</p>
                      <p className={`text-2xl font-black mt-1 ${
                        label === 'CRITICAL' ? 'text-red-700' :
                        label === 'ERROR'    ? 'text-red-600' :
                        label === 'WARNING'  ? 'text-amber-600' : 'text-slate-600'
                      }`}>{cnt}</p>
                    </div>
                    <Icon size={18} className={
                      label === 'CRITICAL' ? 'text-red-500' :
                      label === 'ERROR'    ? 'text-red-400' :
                      label === 'WARNING'  ? 'text-amber-500' : 'text-slate-400'
                    } />
                  </div>
                </button>
              );
            })}
          </div>

          {critErrors > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-2xl p-3 flex items-center gap-3">
              <AlertTriangle className="text-red-500 flex-shrink-0" size={16} />
              <span className="text-red-700 text-sm font-semibold">
                {critErrors} critical/error event{critErrors !== 1 ? 's' : ''} detected in alert log
              </span>
            </div>
          )}

          {/* Filter bar */}
          <div className="bg-white rounded-2xl border border-slate-200 p-3 flex flex-wrap gap-3 items-center">
            <div className="flex gap-1 flex-wrap">
              {LEVEL_FILTERS.map(lv => (
                <button key={lv} onClick={() => setLevelFilter(lv)}
                  className={`px-3 h-7 rounded-lg text-xs font-bold transition-all ${
                    levelFilter === lv ? 'bg-slate-900 text-white' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}>
                  {lv === 'ALL' ? `All (${alertLogs.length})` : `${lv} (${countByLabel[lv] || 0})`}
                </button>
              ))}
            </div>
            <div className="relative ml-auto">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={alertSearch} onChange={e => setAlertSearch(e.target.value)}
                placeholder="Search messages or component…"
                className="pl-7 pr-3 h-8 rounded-xl border border-slate-200 text-xs outline-none focus:border-red-500 w-60" />
            </div>
            <span className="text-xs text-slate-400">{filteredAlerts.length} entries</span>
          </div>

          {/* Alert log table */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            {alertLogs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center px-6">
                <CheckCircle2 size={32} className="text-green-400 mb-3" />
                <p className="font-semibold text-slate-700">No alert log entries found</p>
                <p className="text-xs text-slate-400 mt-2 max-w-md">
                  Ensure the Oracle connection has access to V$DIAG_ALERT_EXT or the alert log XML table.
                </p>
              </div>
            ) : filteredAlerts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <p className="text-slate-400 text-sm">No entries match the current filter</p>
              </div>
            ) : (
              <div className="overflow-auto max-h-[500px]">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-white border-b border-slate-200 z-10">
                    <tr>
                      <th className="px-4 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Timestamp</th>
                      <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Level</th>
                      <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Component</th>
                      <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400">Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAlerts.map((log, i) => {
                      const cfg  = getLevelCfg(log.message_level);
                      const Icon = cfg.icon;
                      return (
                        <tr key={i} className={`border-t border-slate-100 ${cfg.row}`}>
                          <td className="px-4 py-2.5 font-mono text-slate-500 whitespace-nowrap">
                            {log.originating_timestamp || '—'}
                          </td>
                          <td className="px-3 py-2.5">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${cfg.badge}`}>
                              <Icon size={9} />
                              {cfg.label}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-slate-400 whitespace-nowrap">
                            {log.component_id || '—'}
                          </td>
                          <td className="px-3 py-2.5 text-slate-700 max-w-2xl break-words">
                            {log.message_text || '—'}
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

        {/* ── Blocking Sessions section ── */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Users size={16} className="text-orange-500" />
            <h2 className="font-bold text-slate-800">Blocking Sessions</h2>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
              blockingSessions.length > 0 ? 'bg-orange-100 text-orange-700' : 'bg-green-100 text-green-700'
            }`}>
              {blockingSessions.length} session{blockingSessions.length !== 1 ? 's' : ''}
            </span>
          </div>

          {blockingSessions.length > 0 && (
            <div className="bg-orange-50 border border-orange-200 rounded-2xl p-3 flex items-center gap-3">
              <AlertTriangle className="text-orange-500 flex-shrink-0" size={16} />
              <span className="text-orange-700 text-sm font-semibold">
                {blockingSessions.length} blocking session{blockingSessions.length !== 1 ? 's' : ''} detected — investigate wait events
              </span>
            </div>
          )}

          {/* Blocking sessions filter */}
          <div className="bg-white rounded-2xl border border-slate-200 p-3 flex flex-wrap gap-3 items-center">
            <div className="relative flex-1 min-w-44">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={blockingSearch} onChange={e => setBlockingSearch(e.target.value)}
                placeholder="Search username, event or SID…"
                className="w-full pl-8 pr-3 h-9 rounded-xl border border-slate-200 text-sm outline-none focus:border-orange-500" />
            </div>
            <span className="text-xs text-slate-400">{filteredBlocking.length} sessions</span>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            {blockingSessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center px-6">
                <CheckCircle2 size={32} className="text-green-400 mb-3" />
                <p className="font-semibold text-slate-700">No blocking sessions</p>
                <p className="text-xs text-slate-400 mt-2">No sessions are currently blocked or waiting in V$SESSION.</p>
              </div>
            ) : filteredBlocking.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <p className="text-slate-400 text-sm">No sessions match the current filter</p>
              </div>
            ) : (
              <div className="overflow-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="px-4 py-3 text-left font-bold text-[11px] text-slate-400">SID</th>
                      <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Serial#</th>
                      <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400">Username</th>
                      <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400">Wait Event</th>
                      <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400">Wait Class</th>
                      <th className="px-3 py-3 text-right font-bold text-[11px] text-slate-400 whitespace-nowrap">Seconds in Wait</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredBlocking.map((s, i) => {
                      const secs = parseInt(s.seconds_in_wait, 10) || 0;
                      return (
                        <tr key={i} className={`border-t border-slate-100 ${secs > 60 ? 'bg-red-50' : secs > 10 ? 'bg-amber-50/40' : 'hover:bg-slate-50'}`}>
                          <td className="px-4 py-2.5 font-mono font-bold text-slate-700">{s.sid ?? '—'}</td>
                          <td className="px-3 py-2.5 font-mono text-slate-500">{s['serial#'] ?? s.serial ?? '—'}</td>
                          <td className="px-3 py-2.5 font-semibold text-slate-700">{s.username || 'SYS'}</td>
                          <td className="px-3 py-2.5 text-slate-600 max-w-xs truncate" title={s.event}>{s.event || '—'}</td>
                          <td className="px-3 py-2.5">
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                              s.wait_class === 'Idle'         ? 'bg-slate-100 text-slate-500' :
                              s.wait_class === 'User I/O'     ? 'bg-blue-100 text-blue-700' :
                              s.wait_class === 'Application'  ? 'bg-orange-100 text-orange-700' :
                              s.wait_class === 'Concurrency'  ? 'bg-red-100 text-red-700' :
                              s.wait_class === 'Configuration'? 'bg-purple-100 text-purple-700' :
                              'bg-slate-100 text-slate-600'
                            }`}>
                              {s.wait_class || '—'}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Clock size={11} className={secs > 60 ? 'text-red-500' : secs > 10 ? 'text-amber-500' : 'text-slate-400'} />
                              <span className={`font-black text-xs ${secs > 60 ? 'text-red-600' : secs > 10 ? 'text-amber-600' : 'text-slate-600'}`}>
                                {secs.toLocaleString()}s
                              </span>
                            </div>
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
    </div>
  );
}
