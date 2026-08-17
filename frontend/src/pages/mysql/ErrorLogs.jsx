import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Paged } from '@/components/ui/Pagination';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  AlertTriangle, RefreshCw, CheckCircle2, XCircle, Info, AlertCircle, Search,
  Shield, Settings, Eye, EyeOff, X,
} from 'lucide-react';
import client from '@/api/client';
import EngineDashboardHeader from '@/components/layout/EngineDashboardHeader';
import { PageLoading } from '@/components/ui/Loading';
import { MYSQL_DASHBOARD_TABS, mysqlTabRoute } from '@/config/mysqlDashboardNav';

/**
 * MySQL Error Logs — ONLY error-log content lives here. AI analysis and
 * Self-Heal used to be internal tabs of this same page; both are separate
 * standalone features elsewhere (`/error-analysis`, `/self-heal`) and are no
 * longer advertised as top-level actions at all, so they don't belong mixed
 * into this page either. SSH configuration stays — it's how remote log
 * access itself gets enabled, not an unrelated feature.
 *
 * Severity/search/date filtering all happen server-side (see
 * `mysql_log_service.list_error_logs_filtered`) — this page only ever holds
 * one already-filtered page of entries, never the full log.
 */

const fetchErrorLogs = (id, params) =>
  client.get(`/connections/mysql/${id}/error-logs`, { params }).then(r => r.data);

const saveSSHConfig = (id, payload) =>
  client.put(`/connections/mysql/${id}/ssh-config`, payload).then(r => r.data);

const getSSHConfig = (id) =>
  client.get(`/connections/mysql/${id}/ssh-config`).then(r => r.data);

const SEV = {
  CRITICAL: { badge: 'bg-red-100 text-red-800 border border-red-200', row: 'bg-red-50', icon: XCircle, color: 'text-red-600' },
  ERROR:    { badge: 'bg-red-50 text-red-700 border border-red-100',   row: 'bg-rose-50/40', icon: AlertCircle, color: 'text-rose-500' },
  WARNING:  { badge: 'bg-amber-50 text-amber-700 border border-amber-100', row: 'bg-amber-50/40', icon: AlertTriangle, color: 'text-amber-500' },
  INFO:     { badge: 'bg-slate-100 text-slate-500',                    row: '', icon: Info, color: 'text-slate-400' },
};

function SevBadge({ sev }) {
  const cfg = SEV[sev] || SEV.INFO;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${cfg.badge}`}>
      <Icon size={9} /> {sev}
    </span>
  );
}

function SSHConfigModal({ id, sshData, onClose, onSaved }) {
  const [form, setForm] = useState({
    ssh_host: sshData?.ssh_host || '',
    ssh_port: sshData?.ssh_port || 22,
    ssh_user: sshData?.ssh_user || '',
    // Never pre-filled — the API only ever returns a mask placeholder here,
    // never the real password. Blank means "keep the stored credential";
    // the user only fills this in to set a NEW one.
    ssh_password: '',
  });
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const handle = async () => {
    setSaving(true); setMsg(null);
    try {
      const res = await saveSSHConfig(id, {
        ssh_host: form.ssh_host || null,
        ssh_port: parseInt(form.ssh_port) || 22,
        ssh_user: form.ssh_user,
        ssh_password: form.ssh_password,
      });
      if (res.status === 'success') {
        setMsg({ ok: true, text: res.message || 'SSH credentials saved.' });
        setTimeout(() => { onSaved(form); onClose(); }, 1200);
      } else {
        setMsg({ ok: false, text: res.message || 'SSH test failed.' });
      }
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="bg-gradient-to-r from-slate-800 to-slate-700 text-white rounded-t-2xl px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings size={16} className="text-cyan-300" />
            <span className="font-bold text-sm">SSH Configuration</span>
          </div>
          <button onClick={onClose} className="text-white/60 hover:text-white text-lg leading-none">✕</button>
        </div>
        <div className="p-5 space-y-3">
          <p className="text-xs text-slate-500">SSH credentials allow reading remote log files directly from the server.</p>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="text-xs font-semibold text-slate-500 mb-1 block">SSH Host (optional)</label>
              <input value={form.ssh_host} onChange={e => setForm(f => ({...f, ssh_host: e.target.value}))}
                placeholder="same as DB host"
                className="w-full border border-slate-200 rounded-xl px-3 h-9 text-sm outline-none focus:border-cyan-500" />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-500 mb-1 block">Port</label>
              <input value={form.ssh_port} onChange={e => setForm(f => ({...f, ssh_port: e.target.value}))}
                type="number"
                className="w-full border border-slate-200 rounded-xl px-3 h-9 text-sm outline-none focus:border-cyan-500" />
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-500 mb-1 block">Username</label>
            <input value={form.ssh_user} onChange={e => setForm(f => ({...f, ssh_user: e.target.value}))}
              className="w-full border border-slate-200 rounded-xl px-3 h-9 text-sm outline-none focus:border-cyan-500" />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-500 mb-1 block">Password</label>
            <div className="relative">
              <input value={form.ssh_password} onChange={e => setForm(f => ({...f, ssh_password: e.target.value}))}
                type={show ? 'text' : 'password'}
                placeholder={sshData?.configured ? 'Leave blank to keep the saved password' : ''}
                className="w-full border border-slate-200 rounded-xl px-3 pr-10 h-9 text-sm outline-none focus:border-cyan-500" />
              <button onClick={() => setShow(s => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                {show ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>
          {msg && (
            <div className={`rounded-xl px-3 py-2 text-xs font-semibold ${msg.ok ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
              {msg.ok ? '✓ ' : '✗ '}{msg.text}
            </div>
          )}
          <button onClick={handle} disabled={saving || !form.ssh_user || (!form.ssh_password && !sshData?.configured)}
            className="w-full h-10 rounded-xl bg-slate-900 text-white text-sm font-bold disabled:opacity-50 hover:bg-slate-700 transition-colors">
            {saving ? 'Testing & Saving…' : 'Test & Save SSH Config'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ErrorDetailModal({ entry, onClose }) {
  if (!entry) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <SevBadge sev={entry.severity} />
            <span className="text-sm font-bold text-slate-800">{entry.error_code || 'Error detail'}</span>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <div className="p-5 space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase">Timestamp</p>
              <p className="font-mono text-slate-700">{entry.logged || '—'}</p>
            </div>
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase">Source / Component</p>
              <p className="font-mono text-slate-700">{entry.subsystem || 'MySQL'}</p>
            </div>
          </div>
          <div>
            <p className="text-[10px] font-bold text-slate-400 uppercase mb-1">Message</p>
            <p className="bg-slate-50 border border-slate-200 rounded-xl p-3 font-mono text-xs text-slate-700 whitespace-pre-wrap break-words leading-relaxed">
              {entry.message}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ErrorLogs() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [sev, setSev] = useState('ALL');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 220);
    return () => clearTimeout(t);
  }, [search]);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [showSSH, setShowSSH] = useState(false);
  const [sshData, setSshData] = useState(null);
  const [selected, setSelected] = useState(null);

  const params = {
    severity: sev !== 'ALL' ? sev : undefined,
    search: debouncedSearch.trim() || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    page_size: 500,
  };

  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ['mysqlErrorLogs', id, params],
    queryFn: () => fetchErrorLogs(id, params),
    retry: false,
    refetchInterval: 60000,
    // `keepPreviousData: true` is a v4 option — this app is on v5, where it
    // was replaced by `placeholderData: keepPreviousData`. The old boolean
    // form is silently ignored by v5 (no error, no effect), so the previous
    // page's data was NEVER actually being retained across a severity/
    // search/date change: every filter click created a genuinely new query
    // key with no data yet, so `isLoading` (which is `isPending && isFetching`
    // in v5) went true and the full-page loader fired every time. With the
    // real v5 option, changing a filter keeps showing the last-known rows
    // as `data` while `isFetching` alone goes true in the background, so
    // `isLoading` only reflects the genuine first load.
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    getSSHConfig(id).then(r => { if (r?.ssh_user) setSshData(r); }).catch(() => {});
  }, [id]);

  const logs = data?.logs || [];
  const source = data?.source || 'unknown';
  const logPath = data?.log_path || '';
  const note = data?.note || '';
  const summary = data?.summary || {};
  const counts = summary.severities || { CRITICAL: 0, ERROR: 0, WARNING: 0, INFO: 0 };
  const hasSSH = !!(sshData?.ssh_user);

  const sourceLabel = {
    performance_schema: 'performance_schema.error_log (MySQL Error Log)',
    performance_schema_errors: 'performance_schema error summary',
    ssh_file: `SSH file: ${logPath}`,
    ssh_journald: 'SSH journald (systemd)',
    ssh_syslog: 'SSH syslog',
    file: `Log file: ${logPath}`,
    none: 'Not accessible — error logging disabled on server',
  }[source] || source;

  if (isLoading) return <PageLoading title="Loading error logs…" />;

  return (
    <div className="flex min-h-full flex-col">
      {showSSH && (
        <SSHConfigModal id={id} sshData={sshData} onClose={() => setShowSSH(false)}
          onSaved={(d) => { setSshData(d); refetch(); }} />
      )}
      {selected && <ErrorDetailModal entry={selected} onClose={() => setSelected(null)} />}

      <EngineDashboardHeader
        tech="mysql"
        connectionId={id}
        tabs={MYSQL_DASHBOARD_TABS}
        activeTab="error-logs"
        onTabChange={(t) => navigate(mysqlTabRoute(id, t))}
        onRefresh={() => refetch()}
        isFetching={isFetching}
      />

      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-black text-slate-800">Error Logs</h1>
            <p className="text-xs text-slate-500">{sourceLabel}</p>
          </div>
          <button onClick={() => setShowSSH(true)}
            className={`flex items-center gap-2 px-3 h-8 border rounded-lg text-xs font-semibold ${
              hasSSH ? 'bg-green-50 border-green-200 text-green-700' : 'bg-amber-50 border-amber-200 text-amber-700'
            }`}>
            {hasSSH ? <><Shield size={12} /> SSH ✓ Configured</> : <><Settings size={12} /> Configure SSH</>}
          </button>
        </div>

        {error ? (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-6 max-w-lg">
            <AlertTriangle className="text-red-500 mb-2" size={20} />
            <p className="font-bold text-red-700">Failed to load error logs</p>
            <p className="text-sm text-red-600 mt-1">{error.message}</p>
            <button onClick={() => refetch()} className="mt-3 px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-bold hover:bg-red-700">Retry</button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {['CRITICAL', 'ERROR', 'WARNING', 'INFO'].map(s => {
                const cfg = SEV[s];
                const Icon = cfg.icon;
                const active = sev === s;
                return (
                  <button key={s} onClick={() => setSev(active ? 'ALL' : s)}
                    className={`rounded-2xl border p-4 text-left hover:shadow-md transition-all ${
                      active ? `${cfg.badge} border-2 shadow-md` : 'bg-white border-slate-200'
                    }`}>
                    <div className="flex justify-between items-start">
                      <div>
                        <p className="text-[10px] font-bold text-slate-400 uppercase">{s}</p>
                        <p className={`text-2xl font-black mt-1 ${cfg.color}`}>{counts[s] || 0}</p>
                      </div>
                      <Icon size={18} className={cfg.color} />
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-3 flex flex-wrap gap-3 items-center">
              <div className="flex gap-1 flex-wrap">
                {['ALL', 'CRITICAL', 'ERROR', 'WARNING', 'INFO'].map(s => (
                  <button key={s} onClick={() => setSev(s)}
                    className={`px-3 h-7 rounded-lg text-xs font-bold transition-all ${
                      sev === s ? 'bg-slate-900 text-white' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}>
                    {s === 'ALL' ? 'All' : s}
                  </button>
                ))}
              </div>
              <div className="relative">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Search messages…"
                  className="pl-7 pr-3 h-8 rounded-xl border border-slate-200 text-xs outline-none focus:border-cyan-500 w-52" />
              </div>
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
                className="h-8 rounded-xl border border-slate-200 px-2 text-xs outline-none focus:border-cyan-500" />
              <span className="text-xs text-slate-400">to</span>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
                className="h-8 rounded-xl border border-slate-200 px-2 text-xs outline-none focus:border-cyan-500" />
              <span className="ml-auto flex items-center gap-1.5 text-xs text-slate-400">
                {isFetching && !isLoading && (
                  <RefreshCw size={11} className="animate-spin text-slate-300" />
                )}
                {data?.total_filtered ?? logs.length} entries
              </span>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              {logs.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-center px-6">
                  {source === 'none' ? (
                    <>
                      <AlertTriangle size={32} className="text-amber-400 mb-3" />
                      <p className="font-semibold text-slate-700 text-base">Error logging is not accessible</p>
                      <p className="text-xs text-slate-500 mt-2 max-w-lg leading-relaxed">{note}</p>
                      {!hasSSH && (
                        <button onClick={() => setShowSSH(true)}
                          className="mt-4 px-4 py-2 bg-slate-900 text-white rounded-xl text-xs font-bold hover:bg-slate-700 flex items-center gap-2">
                          <Settings size={13} /> Configure SSH
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <CheckCircle2 size={32} className="text-green-400 mb-3" />
                      <p className="font-semibold text-slate-700">No log entries match these filters</p>
                      <p className="text-xs text-slate-400 mt-2">{note || 'Database appears healthy.'}</p>
                    </>
                  )}
                </div>
              ) : (
                <div className="overflow-auto max-h-[600px]">
                  {/* Keyed on the filter values so changing severity/search/
                      date remounts just this pager back to page 1 (per the
                      "reset pagination to page 1 on filter change"
                      requirement) — `Paged` otherwise keeps its own internal
                      page state across `rows` changes, only clamping it if
                      the new list is shorter than the page it was on. This
                      remounts the table/pager only, not the page around it. */}
                  <Paged key={`${sev}|${debouncedSearch}|${dateFrom}|${dateTo}`} rows={logs} unit="log entries">{(pageRows, pager) => (<>
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-white border-b border-slate-200 z-10">
                        <tr>
                          <th className="px-4 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Timestamp</th>
                          <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Severity</th>
                          <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Error Code</th>
                          <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Source/Component</th>
                          <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400">Message</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pageRows.map((log, i) => (
                          <tr key={i}
                            onClick={() => setSelected(log)}
                            className={`border-t border-slate-100 cursor-pointer hover:bg-slate-100 transition-colors ${SEV[log.severity]?.row || ''}`}>
                            <td className="px-4 py-2 font-mono text-slate-500 whitespace-nowrap text-[11px]">{log.logged || '—'}</td>
                            <td className="px-3 py-2"><SevBadge sev={log.severity} /></td>
                            <td className="px-3 py-2 font-mono text-slate-500 whitespace-nowrap">{log.error_code || '—'}</td>
                            <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{log.subsystem || 'MySQL'}</td>
                            <td className="px-3 py-2 text-slate-700 max-w-2xl truncate">{log.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {pager}
                  </>)}</Paged>
                </div>
              )}
            </div>

            {note && logs.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2 text-xs text-amber-700">
                ⚠ {note}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
