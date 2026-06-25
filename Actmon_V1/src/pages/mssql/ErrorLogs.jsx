import React, { useState, useEffect, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, RefreshCw, FileText, AlertTriangle,
  CheckCircle2, XCircle, AlertCircle, Info, Search,
  Terminal, Play, ShieldCheck, ShieldAlert, ShieldX, Database,
  Activity, ChevronRight, X, Loader2, HardDrive, Clock, Stethoscope, Wrench,
} from 'lucide-react';
import client from '../../api/client';

const fetchErrorLogs = (id) =>
  client.get(`/connections/mssql/${id}/mssql-error-logs`).then(r => r.data);

const deepAnalyze = (id, body) =>
  client.post(`/mssql/${id}/error-deep-analysis`, body).then(r => r.data);
const runCommand = (id, body) =>
  client.post(`/mssql/${id}/run-command`, body).then(r => r.data);

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
  const [selected, setSelected] = useState(null);   // error row → opens analysis drawer

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
                      <tr key={i} onClick={() => setSelected({ ...log, _msg: msg, _errNo: errNo })}
                        className={`group border-t border-slate-100 cursor-pointer hover:bg-blue-50/60 transition-colors ${cfg.row}`}>
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
                          <div className="flex items-center gap-2">
                            <span className="flex-1">{msg}</span>
                            <span className="flex items-center gap-1 text-[10px] font-bold text-blue-600 whitespace-nowrap opacity-0 group-hover:opacity-100">
                              Analyze <ChevronRight size={11} />
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

      {selected && (
        <ErrorDetailDrawer connId={id} row={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Error analysis + self-heal drawer (opens when an error row is clicked)
   ════════════════════════════════════════════════════════════════════════════ */

const RISK = {
  safe:      { label: 'Safe',      cls: 'bg-green-100 text-green-700',  Icon: ShieldCheck },
  caution:   { label: 'Caution',   cls: 'bg-amber-100 text-amber-700',  Icon: ShieldAlert },
  dangerous: { label: 'Write/DDL', cls: 'bg-red-100 text-red-700',      Icon: ShieldX },
};

function ErrorDetailDrawer({ connId, row, onClose }) {
  const [a, setA]           = useState(null);    // analysis result
  const [loading, setLoad]  = useState(true);
  const [err, setErr]       = useState(null);
  const [term, setTerm]     = useState([]);      // terminal entries
  const [busy, setBusy]     = useState(false);

  useEffect(() => {
    let alive = true;
    setLoad(true); setErr(null);
    deepAnalyze(connId, {
      message: row._msg || row.message || '',
      error_number: row._errNo || row.error_number || null,
      state: row.error_state || row.state || null,
    })
      .then(d => { if (alive) { setA(d); setLoad(false); } })
      .catch(e => { if (alive) { setErr(e?.response?.data?.detail || e.message); setLoad(false); } });
    return () => { alive = false; };
  }, [connId, row]);

  const perms = a?.permissions || {};
  const canHeal = !!perms.can_self_heal;

  const run = async (step) => {
    setBusy(true);
    const stamp = new Date().toLocaleTimeString();
    setTerm(t => [...t, { kind: 'cmd', sql: step.sql, ts: stamp, status: 'running' }]);
    try {
      const res = await runCommand(connId, { sql: step.sql, database: step.database || null });
      setTerm(t => {
        const copy = [...t];
        // mark the last running entry done
        for (let i = copy.length - 1; i >= 0; i--) {
          if (copy[i].status === 'running') { copy[i] = { ...copy[i], status: res.status }; break; }
        }
        return [...copy, { kind: 'out', res, ts: new Date().toLocaleTimeString() }];
      });
    } catch (e) {
      setTerm(t => [...t, { kind: 'out', res: { status: 'error', error: e?.response?.data?.detail || e.message } }]);
    } finally {
      setBusy(false);
    }
  };

  const sevColor = a?.severity_label === 'CRITICAL' ? 'bg-red-600'
    : a?.severity_label === 'HIGH' ? 'bg-orange-500' : 'bg-amber-500';

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="w-full max-w-5xl h-full bg-slate-50 shadow-2xl flex flex-col animate-[slidein_.2s_ease]">

        {/* header */}
        <div className="bg-gradient-to-r from-slate-900 via-blue-800 to-sky-700 text-white px-6 py-4 flex items-start gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-black ${sevColor}`}>
                {a?.severity_label || 'ANALYZING'}
              </span>
              <h2 className="text-lg font-black">{loading ? 'Analyzing error…' : (a?.title || 'Error analysis')}</h2>
              {a?.error_number != null && (
                <span className="font-mono text-xs bg-white/15 px-2 py-0.5 rounded">Error {a.error_number}{a.state != null ? ` · State ${a.state}` : ''}</span>
              )}
            </div>
            <p className="text-sky-200 text-xs mt-1 font-mono break-all">{row._msg || row.message}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center flex-shrink-0">
            <X size={16} />
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="animate-spin text-blue-500" size={28} />
          </div>
        ) : err ? (
          <div className="p-6"><div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">{err}</div></div>
        ) : (
          <div className="flex-1 overflow-hidden flex">
            {/* main column */}
            <div className="flex-1 overflow-auto p-5 space-y-4">

              {/* live status */}
              <div className={`rounded-2xl border p-4 ${a.is_still_occurring ? 'bg-red-50 border-red-200' : a.is_still_occurring === false ? 'bg-green-50 border-green-200' : 'bg-slate-50 border-slate-200'}`}>
                <div className="flex items-center gap-2">
                  <Activity size={15} className={a.is_still_occurring ? 'text-red-600' : 'text-green-600'} />
                  <p className="font-bold text-sm text-slate-800">
                    {a.is_still_occurring ? 'Still occurring now (within last 15 min)'
                      : a.is_still_occurring === false ? 'Not occurring recently — looks resolved'
                      : 'Live status unknown'}
                  </p>
                  <span className="ml-auto text-xs text-slate-500">{a.occurrences} matching entr{a.occurrences === 1 ? 'y' : 'ies'} in log</span>
                </div>
              </div>

              {/* what / why / impact */}
              <Section title="What is this error?" icon={<Info size={14} className="text-blue-500" />}>
                <p className="text-sm text-slate-700">{a.what}</p>
              </Section>
              <Section title="Why is it happening?" icon={<AlertCircle size={14} className="text-orange-500" />}>
                <p className="text-sm text-slate-700">{a.why}</p>
                {(a.login || a.database) && (
                  <div className="flex gap-2 mt-2 flex-wrap">
                    {a.login && <span className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full text-[11px] font-bold">login: {a.login}</span>}
                    {a.database && <span className="px-2 py-0.5 bg-indigo-50 text-indigo-700 rounded-full text-[11px] font-bold">db: {a.database}</span>}
                  </div>
                )}
              </Section>
              {a.impact && (
                <Section title="Impact" icon={<AlertTriangle size={14} className="text-red-500" />}>
                  <p className="text-sm text-slate-700">{a.impact}</p>
                </Section>
              )}

              {/* recent occurrences */}
              {a.recent_hits?.length > 0 && (
                <Section title={`Recent occurrences (${a.recent_hits.length})`} icon={<Clock size={14} className="text-slate-400" />}>
                  <div className="space-y-1 max-h-44 overflow-auto">
                    {a.recent_hits.map((h, i) => (
                      <div key={i} className="flex gap-3 text-[11px] border-b border-slate-100 py-1">
                        <span className="font-mono text-slate-400 whitespace-nowrap">{String(h.logged).slice(0, 19)}</span>
                        <span className="text-slate-600 truncate">{h.message}</span>
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {/* embedded terminal */}
              <MiniTerminal entries={term} onClear={() => setTerm([])} />
            </div>

            {/* sidebar: diagnostics + remediation + self-heal */}
            <div className="w-[360px] border-l border-slate-200 bg-white overflow-auto p-4 space-y-5 flex-shrink-0">

              {/* permission banner */}
              <div className={`rounded-xl p-3 text-xs ${canHeal ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-amber-50 text-amber-800 border border-amber-200'}`}>
                <div className="flex items-center gap-2 font-bold mb-0.5">
                  {canHeal ? <ShieldCheck size={13} /> : <ShieldAlert size={13} />}
                  {canHeal ? 'Self-heal available' : 'Self-heal limited'}
                </div>
                <p className="opacity-80">
                  Login <b>{perms.login_name || '—'}</b>{' '}
                  {canHeal ? 'can run remediation (write/DDL) commands.'
                    : 'is read-only for remediation — only safe diagnostics will run.'}
                </p>
              </div>

              {/* diagnostics (safe) */}
              {a.diagnostics?.length > 0 && (
                <div>
                  <h3 className="text-xs font-black text-slate-500 uppercase tracking-wide flex items-center gap-1.5 mb-2">
                    <Stethoscope size={13} /> Diagnostics — safe to run
                  </h3>
                  <div className="space-y-2">
                    {a.diagnostics.map((s, i) => <CommandStep key={i} step={s} onRun={run} busy={busy} canHeal={canHeal} />)}
                  </div>
                </div>
              )}

              {/* remediation */}
              {a.remediations?.length > 0 && (
                <div>
                  <h3 className="text-xs font-black text-slate-500 uppercase tracking-wide flex items-center gap-1.5 mb-2">
                    <Wrench size={13} /> Remediation / self-heal
                  </h3>
                  <div className="space-y-2">
                    {a.remediations.map((s, i) => <CommandStep key={i} step={s} onRun={run} busy={busy} canHeal={canHeal} />)}
                  </div>
                </div>
              )}

              {/* advanced context */}
              <div className="space-y-2">
                <h3 className="text-xs font-black text-slate-500 uppercase tracking-wide mb-1">Advanced</h3>
                <Advanced ok={a.backup_relevant} icon={<HardDrive size={13} />}
                  label="Backups" note={a.backup_relevant ? 'Backup/log-backup actions are part of the fix above.' : 'Not directly related to this error.'} />
                <Advanced ok={a.exec_plan_relevant} icon={<Activity size={13} />}
                  label="Execution plan" note={a.exec_plan_relevant ? 'Query plan tuning is relevant — capture the plan of the offending query.' : 'Not a query-plan issue.'} />
                <Advanced ok icon={<Database size={13} />}
                  label="Category" note={a.category || 'general'} />
              </div>
            </div>
          </div>
        )}
      </div>
      <style>{`@keyframes slidein{from{transform:translateX(40px);opacity:.4}to{transform:translateX(0);opacity:1}}`}</style>
    </div>
  );
}

function Section({ title, icon, children }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <h3 className="text-xs font-black text-slate-500 uppercase tracking-wide flex items-center gap-1.5 mb-2">{icon} {title}</h3>
      {children}
    </div>
  );
}

function Advanced({ ok, icon, label, note }) {
  return (
    <div className={`rounded-xl border p-2.5 ${ok ? 'border-blue-200 bg-blue-50/50' : 'border-slate-200 bg-slate-50'}`}>
      <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-700">{icon} {label}</div>
      <p className="text-[10px] text-slate-500 mt-0.5">{note}</p>
    </div>
  );
}

function CommandStep({ step, onRun, busy, canHeal }) {
  const r = RISK[step.risk] || RISK.safe;
  const needsHeal = step.risk !== 'safe';
  const blocked = needsHeal && !canHeal;
  const hasPlaceholder = step.sql.includes('<') && step.sql.includes('>');
  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <div className="flex items-start gap-2">
        <span className={`px-1.5 py-0.5 rounded text-[9px] font-black inline-flex items-center gap-0.5 ${r.cls}`}>
          <r.Icon size={9} /> {r.label}
        </span>
        <p className="text-xs font-bold text-slate-800 flex-1">{step.title}</p>
      </div>
      <p className="text-[10px] text-slate-500 mt-1">{step.why}</p>
      <pre className="mt-2 bg-slate-900 text-slate-100 rounded-lg p-2 text-[10px] font-mono overflow-x-auto whitespace-pre-wrap">{step.sql}</pre>
      <div className="flex items-center gap-2 mt-2">
        <button
          disabled={busy || blocked || hasPlaceholder}
          onClick={() => onRun(step)}
          className={`px-2.5 h-7 rounded-lg text-[11px] font-bold inline-flex items-center gap-1 transition-colors ${
            blocked || hasPlaceholder ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
            : step.risk === 'dangerous' ? 'bg-red-600 text-white hover:bg-red-700'
            : step.risk === 'caution' ? 'bg-amber-500 text-white hover:bg-amber-600'
            : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
          <Play size={11} /> Run
        </button>
        {blocked && <span className="text-[10px] text-amber-600 font-semibold">needs higher permission</span>}
        {hasPlaceholder && !blocked && <span className="text-[10px] text-slate-400">fill &lt;placeholder&gt; first</span>}
      </div>
    </div>
  );
}

function MiniTerminal({ entries, onClear }) {
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [entries]);
  return (
    <div className="bg-slate-900 rounded-2xl overflow-hidden border border-slate-700">
      <div className="flex items-center gap-2 px-3 py-2 bg-slate-800 border-b border-slate-700">
        <Terminal size={13} className="text-green-400" />
        <span className="text-xs font-bold text-slate-200">Self-heal terminal</span>
        <span className="text-[10px] text-slate-500">commands run on this server</span>
        {entries.length > 0 && (
          <button onClick={onClear} className="ml-auto text-[10px] text-slate-400 hover:text-slate-200">clear</button>
        )}
      </div>
      <div className="p-3 font-mono text-[11px] max-h-72 overflow-auto space-y-2">
        {entries.length === 0 && (
          <p className="text-slate-500">Run a diagnostic or remediation step → the exact command and its output appear here.</p>
        )}
        {entries.map((e, i) => {
          if (e.kind === 'cmd') {
            return (
              <div key={i} className="text-slate-300">
                <span className="text-green-400">mssql&gt;</span> <span className="whitespace-pre-wrap">{e.sql}</span>
                {e.status === 'running' && <Loader2 size={11} className="inline ml-2 animate-spin text-amber-400" />}
              </div>
            );
          }
          const res = e.res || {};
          if (res.status === 'success') {
            return (
              <div key={i} className="text-slate-400 pl-3 border-l-2 border-slate-700">
                <div className="text-emerald-400">✓ {res.message} {res.duration_ms != null ? `(${res.duration_ms}ms)` : ''}</div>
                {res.rows?.length > 0 && (
                  <div className="mt-1 overflow-x-auto">
                    <table className="text-[10px]">
                      <thead><tr>{res.columns.map(c => <th key={c} className="text-left pr-4 text-slate-500 font-bold">{c}</th>)}</tr></thead>
                      <tbody>
                        {res.rows.slice(0, 50).map((rw, ri) => (
                          <tr key={ri}>{res.columns.map(c => <td key={c} className="pr-4 text-slate-300">{String(rw[c] ?? '')}</td>)}</tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          }
          if (res.status === 'denied') {
            return <div key={i} className="text-amber-400 pl-3 border-l-2 border-amber-700">⚠ {res.error}</div>;
          }
          return <div key={i} className="text-red-400 pl-3 border-l-2 border-red-800">✗ {res.error}</div>;
        })}
        <div ref={endRef} />
      </div>
    </div>
  );
}
