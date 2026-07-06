/**
 * PostgreSQL Host Resources + ActMon-style drill-down (on-demand).
 *   Level 1: CPU / RAM / Disk gauges (click any to drill in)
 *   Level 2: OS process explorer (DB processes tagged)
 *   Level 3: pg_stat_activity sessions for the chosen pid
 *   Level 4: query text + waits + blockers + EXPLAIN plan
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Cpu, MemoryStick, HardDrive, RefreshCw, X, ChevronRight, Database,
  Activity, Loader, AlertTriangle, Server, Clock, GitBranch,
  Stethoscope, Download, ShieldCheck, Wrench, CheckCircle2, ServerCog, History, Flame,
} from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import {
  ddHostMetrics, ddProcesses, ddProcessSessions, ddSessionDetail, ddRca,
  ddHistory, ddHistoryDetail, ddHistoryRca, pgGrantMonitor,
  mssqlOsProcesses, mssqlEnableOsVisibility,
} from '../../api/drilldown';

const colorFor = (pct) => (pct == null ? '#94a3b8' : pct >= 85 ? '#ef4444' : pct >= 65 ? '#f59e0b' : '#22c55e');
const fmtPct = (v) => (v == null ? '—' : `${v}%`);
const TECH_LABEL = { postgresql: 'PostgreSQL', mysql: 'MySQL', oracle: 'Oracle', mssql: 'SQL Server', mongodb: 'MongoDB', clickhouse: 'ClickHouse' };
const techName = (t) => TECH_LABEL[t] || 'Database';

function Gauge({ icon: Icon, label, pct, sub, onClick }) {
  const c = colorFor(pct);
  return (
    <button onClick={onClick}
      className="group relative bg-white rounded-2xl border border-slate-200 p-5 text-left shadow-sm hover:shadow-xl hover:-translate-y-0.5 transition-all">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: `${c}1a`, color: c }}><Icon size={20} /></div>
          <div>
            <p className="text-[11px] font-black text-slate-400 uppercase tracking-wider">{label}</p>
            <p className="text-2xl font-black text-slate-800 leading-none mt-0.5">{fmtPct(pct)}</p>
          </div>
        </div>
        <span className="text-[11px] font-bold text-indigo-600 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">drill in <ChevronRight size={13} /></span>
      </div>
      <div className="mt-3 h-2 rounded-full bg-slate-100 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(pct || 0, 100)}%`, background: c }} />
      </div>
      {sub && <p className="text-[11px] text-slate-400 mt-2">{sub}</p>}
    </button>
  );
}

const stateColor = (s) => {
  const k = (s || '').toLowerCase();
  if (k === 'active') return 'bg-emerald-100 text-emerald-700';
  if (k.includes('idle in transaction')) return 'bg-red-100 text-red-700';
  if (k === 'idle') return 'bg-slate-100 text-slate-500';
  return 'bg-amber-100 text-amber-700';
};

export default function HostResources({ connId, tech = 'postgresql' }) {
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const load = useCallback(() => {
    setLoading(true); setErr(null);
    ddHostMetrics(tech, connId)
      .then(setMetrics)
      .catch((e) => setErr(e?.response?.data?.detail || e.message || 'Failed to load host metrics'))
      .finally(() => setLoading(false));
  }, [connId, tech]);
  useEffect(() => { load(); }, [load]);

  // drill-down modal state
  const [drill, setDrill] = useState(null); // { sortBy: 'cpu'|'mem' }
  const [showHistory, setShowHistory] = useState(false);

  if (err) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-2xl px-5 py-4 flex items-start gap-3">
        <AlertTriangle size={18} className="text-amber-600 mt-0.5 flex-shrink-0" />
        <div className="flex-1">
          <p className="font-black text-amber-800 text-sm">Host metrics unavailable</p>
          <p className="text-amber-700 text-xs mt-0.5">{err}</p>
        </div>
        <button onClick={load} className="text-amber-700 hover:text-amber-900"><RefreshCw size={16} /></button>
      </div>
    );
  }

  return (
    <>
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Server size={16} className="text-slate-500" />
            <h3 className="text-sm font-black text-slate-700 uppercase tracking-wide">Host Resources</h3>
            {metrics?.load_avg && <span className="text-[11px] text-slate-400 font-semibold">· load {metrics.load_avg}{metrics.cpu_cores ? ` · ${metrics.cpu_cores} cores` : ''}</span>}
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setShowHistory(true)}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-bold text-slate-600 bg-slate-100 hover:bg-slate-200">
              <History size={14} /> History
            </button>
            <button onClick={load} className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:bg-slate-100 hover:text-slate-700">
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Gauge icon={Cpu}         label="CPU"  pct={metrics?.cpu_pct}  sub="Click → top processes" onClick={() => setDrill({ sortBy: 'cpu' })} />
          <Gauge icon={MemoryStick} label="RAM"  pct={metrics?.ram_pct}
            sub={metrics?.ram_used_mb != null ? `${metrics.ram_used_mb} / ${metrics.ram_total_mb} MB` : 'Click → top processes'}
            onClick={() => setDrill({ sortBy: 'mem' })} />
          <Gauge icon={HardDrive}   label="Disk (/)" pct={metrics?.disk_pct} sub="Root filesystem" onClick={() => setDrill({ sortBy: 'cpu' })} />
        </div>
      </div>

      {drill && <DrillModal connId={connId} tech={tech} sortBy={drill.sortBy} onClose={() => setDrill(null)} />}
      {showHistory && <HistoryModal connId={connId} tech={tech} onClose={() => setShowHistory(false)} />}
    </>
  );
}

/* ─────────────── Drill-down modal (levels 2 → 3 → 4) ─────────────── */
export function DrillModal({ connId, tech, sortBy: initialSort, onClose }) {
  const [step, setStep] = useState('processes');      // processes | procdetail | sessions | detail | rca
  const [sortBy, setSortBy] = useState(initialSort);
  const [pid, setPid] = useState(null);
  const [rcaTarget, setRcaTarget] = useState(null);   // {pid, cmd} or null (whole host)
  const [selectedProc, setSelectedProc] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const run = (promise) => {
    setLoading(true); setErr(null); setData(null);
    promise.then(setData)
      .catch((e) => setErr(e?.response?.data?.detail || e.message || 'Request failed'))
      .finally(() => setLoading(false));
  };
  const fetchStep = useCallback((which, p) => {
    run(which === 'processes' ? ddProcesses(tech, connId, sortBy)
      : which === 'sessions' ? ddProcessSessions(tech, connId, p)
      : ddSessionDetail(tech, connId, p));
  }, [connId, tech, sortBy]);

  useEffect(() => { if (step === 'processes') fetchStep('processes'); }, [step, sortBy, fetchStep]);

  const openSessions = (p) => {
    // For SQL Server a "process" IS a session, so skip the redundant query-list step and
    // go straight to the deep analysis (tables / indexes / missing indexes / partitioning).
    if (tech === 'mssql') { setPid(p); setStep('detail'); fetchStep('detail', p); return; }
    setPid(p); setStep('sessions'); fetchStep('sessions', p);
  };
  const openProcDetail = (p) => { setSelectedProc(p); setPid(p.pid); setStep('procdetail'); };
  const openDetail = (p) => { setPid(p); setStep('detail'); fetchStep('detail', p); };
  const openRca = (target) => {     // target = {pid, cmd} | null
    setRcaTarget(target || null); setPid(target?.pid || null); setStep('rca');
    run(ddRca(tech, connId, sortBy === 'mem' ? 'mem' : 'cpu', target?.pid, target?.cmd));
  };

  const crumbs = [
    { key: 'processes', label: 'Processes' },
    ...(step === 'procdetail' ? [{ key: 'procdetail', label: `PID ${pid} · ${selectedProc?.command || ''}` }] : []),
    ...(step === 'sessions' ? [{ key: 'sessions', label: `PID ${pid} · Queries` }] : []),
    ...(step === 'detail'
      ? (tech === 'mssql'
          ? [{ key: 'detail', label: `PID ${pid} · Analysis` }]
          : [{ key: 'sessions', label: `PID ${pid} · Queries` }, { key: 'detail', label: 'Why' }])
      : []),
    ...(step === 'rca' ? [{ key: 'rca', label: 'RCA Report' }] : []),
  ];

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex sm:items-center sm:justify-center sm:p-6" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        className="bg-white w-full h-full sm:h-[90vh] sm:max-w-5xl sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden">
        {/* header */}
        <div className="flex items-center justify-between px-6 py-4 bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-900 text-white">
          <div className="flex items-center gap-2.5 min-w-0">
            <Activity size={20} className="text-indigo-300 flex-shrink-0" />
            <div className="flex items-center gap-1.5 text-sm flex-wrap">
              {crumbs.map((c, i) => (
                <React.Fragment key={c.key}>
                  {i > 0 && <ChevronRight size={14} className="text-white/40" />}
                  <button onClick={() => { setStep(c.key); if (c.key === 'processes') fetchStep('processes'); else if (c.key === 'sessions') fetchStep('sessions', pid); }}
                    className={`font-bold ${i === crumbs.length - 1 ? 'text-white' : 'text-indigo-200 hover:text-white'}`}>
                    {c.label}
                  </button>
                </React.Fragment>
              ))}
            </div>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-xl flex items-center justify-center text-white/70 hover:bg-white/15"><X size={18} /></button>
        </div>

        {/* body */}
        <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
          {loading && <div className="flex items-center justify-center py-20 text-slate-400"><Loader size={22} className="animate-spin mr-2" /> Loading live data…</div>}
          {err && !loading && (
            <div className="bg-red-50 border border-red-200 rounded-2xl px-5 py-4 text-sm text-red-700 flex items-start gap-2">
              <AlertTriangle size={18} className="mt-0.5 flex-shrink-0" />{err}
            </div>
          )}

          {!loading && !err && step === 'processes' && (
            <ProcessList data={data} sortBy={sortBy} setSortBy={setSortBy} techLabel={techName(tech)}
              connId={connId} tech={tech} onPick={openSessions} onProcDetail={openProcDetail}
              onRca={() => openRca()} />
          )}
          {step === 'procdetail' && (
            <ProcDetail proc={selectedProc} techLabel={techName(tech)}
              onRca={() => openRca({ pid: selectedProc?.pid, cmd: selectedProc?.command })} />
          )}
          {!loading && !err && step === 'sessions' && (
            <SessionList data={data} connId={connId} techLabel={techName(tech)} onPick={openDetail}
              onGranted={() => fetchStep('sessions', pid)} />
          )}
          {!loading && !err && step === 'detail' && (
            <SessionDetail data={data} connId={connId} onRca={() => openRca({ pid })}
              onGranted={() => fetchStep('detail', pid)} />
          )}
          {!loading && !err && step === 'rca' && (
            <RcaReport data={data} resource={sortBy === 'mem' ? 'MEMORY' : 'CPU'}
              meta={{ connId, pid, host: '' }} />
          )}
        </div>
      </div>
    </div>
  );
}

/* Banner shown when the monitoring role can't read other users' query text. */
function GrantBanner({ connId, onGranted }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const grant = () => {
    setBusy(true);
    pgGrantMonitor(connId).then((r) => { setRes(r); if (r.status === 'success') setTimeout(onGranted, 600); })
      .catch((e) => setRes({ status: 'failed', message: e?.response?.data?.detail || e.message }))
      .finally(() => setBusy(false));
  };
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-2xl px-5 py-4 mb-3">
      <div className="flex items-start gap-3">
        <AlertTriangle size={18} className="text-amber-600 mt-0.5 flex-shrink-0" />
        <div className="flex-1">
          <p className="font-black text-amber-800 text-sm">Limited visibility — query text hidden</p>
          <p className="text-amber-700 text-xs mt-0.5">The monitoring user lacks the <b>pg_monitor</b> role, so PostgreSQL hides other users' SQL (<code>&lt;insufficient privilege&gt;</code>). Grant it to see every query.</p>
          {res && (
            <div className={`mt-2 text-xs ${res.status === 'success' ? 'text-emerald-700' : 'text-red-700'}`}>
              {res.message}
              {res.manual_sql && <pre className="mt-1 bg-white border border-amber-200 rounded-lg p-2 text-slate-700 whitespace-pre-wrap">{res.manual_sql}{res.manual_shell ? `\n# or as OS postgres:\n${res.manual_shell}` : ''}</pre>}
            </div>
          )}
        </div>
        <button onClick={grant} disabled={busy}
          className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-[12px] font-bold disabled:opacity-60">
          {busy ? <Loader size={14} className="animate-spin" /> : <ShieldCheck size={14} />} Grant monitoring access
        </button>
      </div>
    </div>
  );
}

/* ─────────────── History (logged CPU/RAM over time + spike analysis) ─────────────── */
function HistoryModal({ connId, tech, onClose }) {
  const [hours, setHours] = useState(6);
  const [samples, setSamples] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('chart');   // chart | detail | rca
  const [sel, setSel] = useState(null);
  const [detail, setDetail] = useState(null);
  const [rca, setRca] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setLoading(true);
    ddHistory(tech, connId, hours).then((d) => setSamples(d.samples || [])).finally(() => setLoading(false));
  }, [connId, tech, hours]);

  const openDetail = (id) => { setSel(id); setView('detail'); setBusy(true); setDetail(null); ddHistoryDetail(tech, connId, id).then(setDetail).finally(() => setBusy(false)); };
  const openRca = () => { setView('rca'); setBusy(true); setRca(null); ddHistoryRca(tech, connId, sel, 'cpu').then(setRca).finally(() => setBusy(false)); };

  const events = samples.filter((s) => s.is_event);
  const chartData = samples.map((s) => ({
    t: new Date(s.captured_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    cpu: s.cpu_pct, ram: s.ram_pct,
  }));

  const crumbs = [
    { key: 'chart', label: 'History' },
    ...(view !== 'chart' ? [{ key: 'detail', label: `Sample #${sel}` }] : []),
    ...(view === 'rca' ? [{ key: 'rca', label: 'RCA Report' }] : []),
  ];

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex sm:items-center sm:justify-center sm:p-6" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-white w-full h-full sm:h-[90vh] sm:max-w-5xl sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-900 text-white">
          <div className="flex items-center gap-2.5 text-sm flex-wrap">
            <History size={20} className="text-indigo-300" />
            {crumbs.map((c, i) => (
              <React.Fragment key={c.key}>
                {i > 0 && <ChevronRight size={14} className="text-white/40" />}
                <button onClick={() => { if (c.key === 'chart') setView('chart'); else if (c.key === 'detail') setView('detail'); }}
                  className={`font-bold ${i === crumbs.length - 1 ? 'text-white' : 'text-indigo-200 hover:text-white'}`}>{c.label}</button>
              </React.Fragment>
            ))}
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-xl flex items-center justify-center text-white/70 hover:bg-white/15"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
          {view === 'chart' && (
            <>
              <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                <p className="text-sm font-bold text-slate-600">Logged host utilization · click a spike below to analyse it</p>
                <div className="flex items-center gap-1 bg-white rounded-xl border border-slate-200 p-1">
                  {[[1, '1h'], [6, '6h'], [24, '24h']].map(([h, l]) => (
                    <button key={h} onClick={() => setHours(h)}
                      className={`px-3 py-1 rounded-lg text-[11px] font-bold ${hours === h ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-100'}`}>{l}</button>
                  ))}
                </div>
              </div>

              {loading ? (
                <div className="flex items-center justify-center py-20 text-slate-400"><Loader size={22} className="animate-spin mr-2" /> Loading history…</div>
              ) : samples.length === 0 ? (
                <div className="bg-white rounded-2xl border border-slate-200 py-16 text-center">
                  <History size={28} className="text-slate-300 mx-auto mb-3" />
                  <p className="text-slate-500 font-bold">No samples yet</p>
                  <p className="text-slate-400 text-sm mt-1">The collector logs a sample every minute — check back shortly.</p>
                </div>
              ) : (
                <>
                  <div className="bg-white rounded-2xl border border-slate-200 p-4 mb-4" style={{ height: 280 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={chartData} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                        <defs>
                          <linearGradient id="cpuG" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#6366f1" stopOpacity={0.4} /><stop offset="100%" stopColor="#6366f1" stopOpacity={0} /></linearGradient>
                          <linearGradient id="ramG" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#22c55e" stopOpacity={0.3} /><stop offset="100%" stopColor="#22c55e" stopOpacity={0} /></linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                        <XAxis dataKey="t" tick={{ fontSize: 11, fill: '#94a3b8' }} />
                        <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#94a3b8' }} unit="%" />
                        <Tooltip />
                        <Area type="monotone" dataKey="cpu" name="CPU %" stroke="#6366f1" strokeWidth={2} fill="url(#cpuG)" />
                        <Area type="monotone" dataKey="ram" name="RAM %" stroke="#22c55e" strokeWidth={2} fill="url(#ramG)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>

                  <div className="flex items-center gap-2 mb-2">
                    <Flame size={15} className="text-rose-500" />
                    <h4 className="text-sm font-black text-slate-700">High-utilization events ({events.length})</h4>
                  </div>
                  {events.length === 0 ? (
                    <p className="text-sm text-slate-400 bg-white rounded-2xl border border-slate-200 p-4">No spikes captured in this window — CPU/RAM stayed within normal limits. 👍</p>
                  ) : (
                    <div className="space-y-2">
                      {events.slice().reverse().map((s) => (
                        <button key={s.id} onClick={() => openDetail(s.id)}
                          className="w-full text-left bg-white rounded-2xl border border-slate-200 p-4 hover:shadow-lg hover:border-rose-300 transition-all flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3">
                            <span className="w-10 h-10 rounded-xl bg-rose-100 text-rose-600 flex items-center justify-center"><Flame size={18} /></span>
                            <div>
                              <p className="font-bold text-slate-800 text-sm">{new Date(s.captured_at).toLocaleString()}</p>
                              <p className="text-[11px] text-slate-400">CPU {s.cpu_pct ?? '—'}% · RAM {s.ram_pct ?? '—'}% · Disk {s.disk_pct ?? '—'}%</p>
                            </div>
                          </div>
                          <span className="text-[11px] font-bold text-rose-600 flex items-center gap-1">analyse <ChevronRight size={13} /></span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {view === 'detail' && (
            busy ? <div className="flex items-center justify-center py-20 text-slate-400"><Loader size={22} className="animate-spin mr-2" /> Loading snapshot…</div>
            : detail ? (
              <div className="space-y-4">
                <div className="bg-white rounded-2xl border border-slate-200 p-4 flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <p className="text-sm font-black text-slate-800">Snapshot · {new Date(detail.captured_at).toLocaleString()}</p>
                    <p className="text-[11px] text-slate-400">CPU {detail.cpu_pct}% · RAM {detail.ram_pct}% · Disk {detail.disk_pct}%</p>
                  </div>
                  <button onClick={openRca} className="inline-flex items-center gap-1.5 h-9 px-4 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 text-white text-[12px] font-bold shadow hover:shadow-lg">
                    <Stethoscope size={15} /> Generate RCA Report
                  </button>
                </div>
                <div className="bg-white rounded-2xl border border-slate-200 p-4">
                  <h4 className="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-2">Processes at that moment</h4>
                  <table className="w-full text-sm">
                    <thead className="text-[11px] uppercase text-slate-400 font-black"><tr><th className="text-left py-1">PID</th><th className="text-left">User</th><th className="text-right">CPU%</th><th className="text-right">MEM%</th><th className="text-left pl-3">Command</th></tr></thead>
                    <tbody>
                      {(detail.top_processes || []).map((p) => (
                        <tr key={p.pid} className={`border-t border-slate-100 ${p.is_db ? 'bg-indigo-50/40' : ''}`}>
                          <td className="py-1.5 font-mono text-xs">{p.pid}</td><td className="text-slate-500">{p.user}</td>
                          <td className="text-right font-bold" style={{ color: colorFor(p.cpu_pct) }}>{p.cpu_pct}</td>
                          <td className="text-right font-bold" style={{ color: colorFor(p.mem_pct) }}>{p.mem_pct}</td>
                          <td className="pl-3 font-mono text-xs text-slate-700">{p.command}{p.is_db && <span className="ml-2 text-[10px] font-black px-1.5 py-0.5 rounded bg-indigo-600 text-white">DB</span>}</td>
                        </tr>
                      ))}
                      {(detail.top_processes || []).length === 0 && <tr><td colSpan={5} className="py-6 text-center text-slate-400">No process detail stored for this sample.</td></tr>}
                    </tbody>
                  </table>
                </div>
                {(detail.active_sessions || []).length > 0 && (
                  <div className="bg-white rounded-2xl border border-slate-200 p-4">
                    <h4 className="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-2">Active queries at that moment</h4>
                    <div className="space-y-2">
                      {detail.active_sessions.map((s, i) => (
                        <div key={i} className="text-xs">
                          <div className="flex justify-between text-slate-500"><span>PID {s.pid} · {s.usename}@{s.datname}</span><span>{s.query_seconds ?? 0}s · {s.wait_event || 'no wait'}</span></div>
                          <code className="block font-mono text-slate-700 bg-slate-50 rounded px-2 py-1 mt-0.5 line-clamp-2 break-all">{s.query}</code>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : <div className="text-slate-400 text-sm">No snapshot.</div>
          )}

          {view === 'rca' && (
            busy ? <div className="flex items-center justify-center py-20 text-slate-400"><Loader size={22} className="animate-spin mr-2" /> Building RCA…</div>
            : rca ? <RcaReport data={rca} resource="CPU" /> : <div className="text-slate-400 text-sm">No RCA.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function WindowsProcesses({ connId }) {
  const [state, setState] = useState('idle'); // idle | loading | data | needsEnable
  const [res, setRes2] = useState({ processes: [] });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const procs = res.processes || [];

  const load = () => {
    setState('loading');
    mssqlOsProcesses(connId).then((d) => {
      setNote(d.note || '');
      if (d.needs_enable) { setState('needsEnable'); }
      else { setRes2(d); setState('data'); }
    }).catch((e) => { setNote(e?.response?.data?.detail || e.message); setState('data'); setRes2({ processes: [] }); });
  };
  const enable = () => {
    setBusy(true);
    mssqlEnableOsVisibility(connId).then((r) => {
      if (r.status === 'success') load(); else setNote(r.message);
    }).finally(() => setBusy(false));
  };

  if (state === 'idle') {
    return (
      <button onClick={load} className="mt-3 inline-flex items-center gap-1.5 h-9 px-4 rounded-xl bg-slate-900 text-white text-[12px] font-bold hover:bg-slate-700">
        <Activity size={14} /> Identify the Windows process
      </button>
    );
  }
  if (state === 'loading') return <div className="mt-3 text-sm text-slate-400 flex items-center gap-2"><Loader size={16} className="animate-spin" /> Reading Windows processes…</div>;
  if (state === 'needsEnable') {
    return (
      <div className="mt-3 bg-slate-50 border border-slate-200 rounded-2xl p-4">
        <p className="text-sm font-bold text-slate-700">Windows process visibility is off</p>
        <p className="text-xs text-slate-500 mt-0.5">{note} Enabling uses <b>xp_cmdshell</b> (sysadmin-only). Do this only on servers you administer.</p>
        <button onClick={enable} disabled={busy} className="mt-2.5 inline-flex items-center gap-1.5 h-9 px-4 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-[12px] font-bold disabled:opacity-60">
          {busy ? <Loader size={14} className="animate-spin" /> : <ShieldCheck size={14} />} Enable Windows process visibility
        </button>
      </div>
    );
  }
  return (
    <div className="mt-3 bg-white rounded-2xl border border-slate-200 p-4">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-[11px] font-black text-slate-400 uppercase tracking-wider">Windows processes · real-time CPU%</h4>
        <button onClick={load} className="text-slate-400 hover:text-slate-700"><RefreshCw size={13} /></button>
      </div>
      {/* total bar */}
      <div className="flex items-center gap-3 mb-3 text-xs">
        <span className="font-black text-slate-700">Total host CPU in use: <span style={{ color: colorFor(res.total_cpu_pct) }}>{res.total_cpu_pct ?? '—'}%</span></span>
        <span className="text-slate-400">Idle: {res.idle_pct ?? '—'}%</span>
        {res.cpu_cores ? <span className="text-slate-400">· {res.cpu_cores} cores</span> : null}
      </div>
      <div className="h-2 rounded-full bg-slate-100 overflow-hidden mb-3">
        <div className="h-full rounded-full" style={{ width: `${Math.min(res.total_cpu_pct || 0, 100)}%`, background: colorFor(res.total_cpu_pct) }} />
      </div>
      <table className="w-full text-xs">
        <thead className="text-[10px] uppercase text-slate-400 font-black">
          <tr>
            <th className="text-left py-1">Process</th><th className="text-right">PID</th>
            <th className="text-right">CPU % (now)</th><th className="text-right">CPU (s) total</th><th className="text-right">Memory</th>
          </tr>
        </thead>
        <tbody>
          {procs.map((p, i) => {
            const isSql = /sqlservr/i.test(p.name);
            return (
              <tr key={i} className={`border-t border-slate-100 ${isSql ? 'bg-indigo-50/40' : i === 0 && p.cpu_pct > 0 ? 'bg-amber-50/60' : ''}`}>
                <td className="py-1.5 font-mono">{p.name}{isSql && <span className="ml-2 text-[9px] font-black px-1.5 py-0.5 rounded bg-indigo-600 text-white">SQL</span>}{!isSql && i === 0 && p.cpu_pct > 0 && <span className="ml-2 text-[9px] font-black px-1.5 py-0.5 rounded bg-amber-500 text-white">TOP</span>}</td>
                <td className="text-right text-slate-500">{p.pid}</td>
                <td className="text-right font-black" style={{ color: colorFor(p.cpu_pct) }}>{p.cpu_pct}%</td>
                <td className="text-right text-slate-500">{Number(p.cpu_seconds).toLocaleString()}</td>
                <td className="text-right text-slate-500">{p.mem_mb} MB</td>
              </tr>
            );
          })}
          {procs.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-slate-400">{note || 'No process data.'}</td></tr>}
        </tbody>
      </table>
      <p className="text-[11px] text-slate-400 mt-2">{note}</p>
    </div>
  );
}

function ProcessList({ data, sortBy, setSortBy, onPick, onProcDetail, onRca, techLabel = 'Database', connId, tech }) {
  const rows = data?.processes || [];
  const sysCpu = data?.system_cpu_pct;
  const dbCpu = data?.db_cpu_pct;
  const cores = data?.cpu_cores;
  return (
    <>
      {/* summary strip */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="bg-white rounded-2xl border border-slate-200 p-4">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">System CPU</p>
          <p className="text-2xl font-black mt-0.5" style={{ color: colorFor(sysCpu) }}>{sysCpu == null ? '—' : `${sysCpu}%`}</p>
          <p className="text-[11px] text-slate-400">{cores ? `across ${cores} core${cores > 1 ? 's' : ''}` : ''}</p>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-4">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">{techLabel} share</p>
          <p className="text-2xl font-black text-indigo-600 mt-0.5">{dbCpu == null ? '—' : `${dbCpu}%`}</p>
          <p className="text-[11px] text-slate-400">of total host CPU</p>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-4">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Other / OS</p>
          <p className="text-2xl font-black mt-0.5" style={{ color: colorFor(sysCpu == null || dbCpu == null ? null : Math.max(sysCpu - dbCpu, 0)) }}>{sysCpu == null || dbCpu == null ? '—' : `${Math.max(Math.round((sysCpu - dbCpu) * 10) / 10, 0)}%`}</p>
          <p className="text-[11px] text-slate-400">non-database processes</p>
        </div>
      </div>

      {/* Honest explanation when the host load is NOT the database (e.g. Windows SQL Server) */}
      {data?.is_external && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl px-5 py-3.5 mb-4 flex items-start gap-3">
          <AlertTriangle size={18} className="text-amber-600 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <p className="font-black text-amber-800 text-sm">The database is not the CPU consumer</p>
            <p className="text-amber-700 text-xs mt-0.5">{data.note}</p>
            {tech === 'mssql' && <WindowsProcesses connId={connId} />}
            {onRca && (
              <button onClick={onRca}
                className="mt-3 inline-flex items-center gap-1.5 h-9 px-4 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 text-white text-[12px] font-bold shadow hover:shadow-lg transition-all">
                <Stethoscope size={15} /> Generate RCA Report
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <p className="text-sm font-bold text-slate-600">
          {data?.is_external ? `${techLabel} sessions · ranked by cumulative CPU time (${techLabel} is using ${dbCpu ?? 0}% of host now)`
            : `Real-time processes · each value = share of total host ${sortBy === 'mem' ? 'memory' : 'CPU'}`}
        </p>
        <div className="flex items-center gap-1 bg-white rounded-xl border border-slate-200 p-1">
          {[['cpu', 'By CPU'], ['mem', 'By Memory']].map(([k, l]) => (
            <button key={k} onClick={() => setSortBy(k)}
              className={`px-3 py-1 rounded-lg text-[11px] font-bold ${sortBy === k ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-100'}`}>{l}</button>
          ))}
        </div>
      </div>
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[11px] uppercase text-slate-400 font-black">
            <tr>
              <th className="px-4 py-2.5 text-left">PID</th><th className="px-4 py-2.5 text-left">User</th>
              <th className="px-4 py-2.5 text-right">{data?.is_external ? 'CPU TIME · %SQL' : 'CPU%'}</th><th className="px-4 py-2.5 text-right">MEM%</th>
              <th className="px-4 py-2.5 text-right">RSS</th><th className="px-4 py-2.5 text-left">Command</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.pid} onClick={() => (p.is_db ? onPick(p.pid) : onProcDetail(p))}
                className={`border-t border-slate-100 cursor-pointer ${p.is_db ? 'bg-indigo-50/40' : ''} hover:bg-slate-50`}>
                <td className="px-4 py-2.5 font-mono text-xs">{p.pid}</td>
                <td className="px-4 py-2.5 text-slate-500">{p.user}</td>
                <td className="px-4 py-2.5 text-right font-bold text-slate-700">
                  {p.cpu_ms != null
                    ? <span>{(p.cpu_ms / 1000).toFixed(1)}s {p.cpu_share_pct != null && <span className="text-slate-400 font-semibold">· {p.cpu_share_pct}%</span>}</span>
                    : <span style={{ color: colorFor(p.cpu_pct) }}>{p.cpu_pct}</span>}
                </td>
                <td className="px-4 py-2.5 text-right font-bold" style={{ color: colorFor(p.mem_pct) }}>{p.mem_pct}</td>
                <td className="px-4 py-2.5 text-right text-slate-500">{p.rss_mb} MB</td>
                <td className="px-4 py-2.5">
                  <span className="font-mono text-xs text-slate-700">{p.command}</span>
                  {p.is_db && <span className="ml-2 inline-flex items-center gap-1 text-[10px] font-black px-2 py-0.5 rounded-full bg-indigo-600 text-white"><Database size={10} /> DB</span>}
                </td>
                <td className="px-3 py-2.5 text-right whitespace-nowrap text-slate-300">
                  <ChevronRight size={15} className="inline" />
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-400">No process data.</td></tr>}
          </tbody>
        </table>
      </div>
      {data?.is_external && (
        <p className="text-[11px] text-slate-400 mt-2"><b>%SQL</b> = each session's share of SQL Server's <i>own</i> CPU (which is only {dbCpu ?? 0}% of the host). The host's {sysCpu ?? 0}% is mostly <b>non-SQL</b> — use <b>Identify the Windows process</b> above to see it.</p>
      )}
      <p className="text-[11px] text-slate-400 mt-3">Click a row to drill in — {techLabel} rows open their live <b>queries</b>; other processes open a detail view. The <b>RCA report</b> is generated at the final step.</p>
    </>
  );
}

function SessionList({ data, connId, onPick, onGranted, techLabel = 'Database' }) {
  const rows = data?.sessions || [];
  return (
    <>
      {data?.limited && <GrantBanner connId={connId} onGranted={onGranted} />}
      {data?.note && <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 mb-3">{data.note}</p>}
      <p className="text-sm font-bold text-slate-600 mb-3">
        {data?.matched_pid ? `Live query for PID ${data.pid}` : `Active ${techLabel} sessions`}
      </p>
      <div className="space-y-2.5">
        {rows.map((s) => (
          <button key={s.pid} onClick={() => onPick(s.pid)}
            className="w-full text-left bg-white rounded-2xl border border-slate-200 p-4 hover:shadow-lg hover:border-indigo-300 transition-all">
            <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-slate-500">PID {s.pid}</span>
                <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${stateColor(s.state)}`}>{(s.state || 'unknown').toUpperCase()}</span>
                {s.wait_event && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">wait: {s.wait_event_type}/{s.wait_event}</span>}
              </div>
              <div className="flex items-center gap-3 text-[11px] text-slate-500">
                <span className="flex items-center gap-1"><Clock size={11} /> {s.query_seconds ?? 0}s</span>
                <span>{s.usename}@{s.datname}</span>
                <ChevronRight size={14} className="text-indigo-400" />
              </div>
            </div>
            <code className="block text-xs text-slate-700 font-mono bg-slate-50 rounded-lg px-3 py-2 line-clamp-2 break-all">{s.query || '—'}</code>
          </button>
        ))}
        {rows.length === 0 && <div className="bg-white rounded-2xl border border-slate-200 py-12 text-center text-slate-400">No active query — this backend is idle.</div>}
      </div>
    </>
  );
}

function SessionDetail({ data, connId, onRca, onGranted }) {
  const d = data?.detail || {};
  const a = data?.analysis;
  const blockers = Array.isArray(d.blocked_by) ? d.blocked_by : [];
  const Field = ({ label, value }) => (
    <div className="bg-white rounded-xl border border-slate-200 px-4 py-3">
      <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">{label}</p>
      <p className="text-sm font-bold text-slate-800 mt-0.5 break-all">{value == null || value === '' ? '—' : String(value)}</p>
    </div>
  );
  const used = (i) => (i.seeks || 0) + (i.scans || 0) + (i.lookups || 0);
  return (
    <div className="space-y-4">
      {data?.limited && <GrantBanner connId={connId} onGranted={onGranted} />}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Field label="State" value={d.state} />
        <Field label="Wait" value={d.wait_event ? `${d.wait_event_type || ''}${d.wait_event_type ? '/' : ''}${d.wait_event}` : 'none'} />
        <Field label="Running for" value={d.query_seconds != null ? `${d.query_seconds}s` : '—'} />
        <Field label="User" value={d.usename} />
        <Field label="Database" value={d.datname} />
        <Field label="Client" value={d.client_addr} />
        <Field label="CPU (ms)" value={d.cpu_ms != null ? Number(d.cpu_ms).toLocaleString() : '—'} />
        <Field label="Reads / Writes" value={d.reads != null ? `${Number(d.reads).toLocaleString()} / ${Number(d.writes || 0).toLocaleString()}` : '—'} />
      </div>

      {blockers.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-2xl px-5 py-4 flex items-start gap-3">
          <GitBranch size={18} className="text-red-600 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-black text-red-800 text-sm">Blocked by PID(s): {blockers.join(', ')}</p>
            <p className="text-red-700 text-xs mt-0.5">This query is waiting on a lock held by another session.</p>
          </div>
        </div>
      )}

      {d.query ? (
        <div>
          <p className="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-2">Last query</p>
          <pre className="bg-slate-900 text-emerald-200 rounded-2xl p-4 text-xs overflow-x-auto whitespace-pre-wrap break-all">{d.query}</pre>
        </div>
      ) : (
        <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5">
          No user query — this session is idle or its last activity was internal monitoring. The database health analysis below still applies.
        </p>
      )}

      {a?.top_queries?.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-4">
          <h4 className="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-2">Top queries by CPU · {a.database}</h4>
          <div className="space-y-2">
            {a.top_queries.slice(0, 6).map((q, i) => (
              <div key={i} className="text-xs">
                <div className="flex justify-between text-slate-500">
                  <span>{q.execution_count ?? '—'} execs · {q.avg_reads != null ? `${Number(q.avg_reads).toLocaleString()} avg reads` : ''}</span>
                  <span className="font-bold text-orange-600">{q.total_cpu_ms != null ? `${Number(q.total_cpu_ms).toLocaleString()} ms total` : ''}{q.avg_cpu_ms != null ? ` · ${q.avg_cpu_ms} ms avg` : ''}</span>
                </div>
                <code className="block font-mono text-slate-700 bg-slate-50 rounded px-2 py-1 mt-0.5 line-clamp-2 break-all">{q.query}</code>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Deep database analysis (step-wise, BEFORE the RCA) ── */}
      {a ? (
        <>
          <div className="flex items-center gap-2 pt-1">
            <Database size={16} className="text-indigo-500" />
            <h3 className="text-sm font-black text-slate-700 uppercase tracking-wide">Deep analysis · {a.database}</h3>
          </div>

          {a.tables?.length > 0 && (
            <div className="bg-white rounded-2xl border border-slate-200 p-4">
              <h4 className="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-2">Largest tables (size & rows)</h4>
              <table className="w-full text-xs">
                <thead className="text-[10px] uppercase text-slate-400 font-black"><tr><th className="text-left py-1">Table</th><th className="text-right">Rows</th><th className="text-right">Total MB</th><th className="text-right">Index MB</th></tr></thead>
                <tbody>
                  {a.tables.slice(0, 10).map((t, i) => (
                    <tr key={i} className={`border-t border-slate-100 ${(t.row_count || 0) > 1000000 ? 'bg-amber-50/60' : ''}`}>
                      <td className="py-1.5 font-mono">{t.schema_name}.{t.table_name}</td>
                      <td className="text-right">{Number(t.row_count || 0).toLocaleString()}</td>
                      <td className="text-right font-bold">{t.total_mb}</td>
                      <td className="text-right text-slate-500">{t.index_mb}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {a.missing_indexes?.length > 0 && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4">
              <h4 className="text-[11px] font-black text-emerald-600 uppercase tracking-wider mb-2">Missing indexes — create these</h4>
              <div className="space-y-2">
                {a.missing_indexes.map((m, i) => (
                  <div key={i}>
                    <div className="flex justify-between text-xs"><span className="font-bold text-slate-700">[{m.table}]</span><span className="text-emerald-700 font-black">≈ {m.impact}% faster · {m.uses} uses</span></div>
                    <code className="block font-mono text-[11px] text-slate-700 bg-white rounded px-2 py-1 mt-0.5 break-all">{m.ddl}</code>
                  </div>
                ))}
              </div>
            </div>
          )}

          {a.indexes?.length > 0 && (
            <div className="bg-white rounded-2xl border border-slate-200 p-4">
              <h4 className="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-2">Index usage (seeks / scans / lookups / writes)</h4>
              <table className="w-full text-xs">
                <thead className="text-[10px] uppercase text-slate-400 font-black"><tr><th className="text-left py-1">Table · Index</th><th className="text-right">Seek</th><th className="text-right">Scan</th><th className="text-right">Lookup</th><th className="text-right">Writes</th></tr></thead>
                <tbody>
                  {a.indexes.slice(0, 12).map((ix, i) => {
                    const unused = used(ix) === 0 && (ix.updates || 0) > 0 && ix.type_desc !== 'CLUSTERED';
                    return (
                      <tr key={i} className={`border-t border-slate-100 ${unused ? 'bg-red-50/60' : ''}`}>
                        <td className="py-1.5 font-mono">{ix.table_name} · {ix.index_name}{unused && <span className="ml-2 text-[9px] font-black px-1.5 py-0.5 rounded bg-red-500 text-white">UNUSED</span>}</td>
                        <td className="text-right">{Number(ix.seeks).toLocaleString()}</td>
                        <td className="text-right">{Number(ix.scans).toLocaleString()}</td>
                        <td className="text-right">{Number(ix.lookups).toLocaleString()}</td>
                        <td className="text-right text-slate-500">{Number(ix.updates).toLocaleString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {a.partition_candidates?.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
              <h4 className="text-[11px] font-black text-amber-600 uppercase tracking-wider mb-2">Partitioning candidates (very large, un-partitioned)</h4>
              <div className="space-y-1.5">
                {a.partition_candidates.map((t, i) => (
                  <div key={i} className="flex justify-between text-xs text-slate-700">
                    <span className="font-mono">[{t.table_name}]</span>
                    <span className="text-amber-700 font-bold">{Number(t.row_count).toLocaleString()} rows · not partitioned</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {a.recommendations?.length > 0 && (
            <div className="bg-white rounded-2xl border border-slate-200 p-4">
              <h4 className="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-2">Recommendations</h4>
              <ul className="space-y-1.5">
                {a.recommendations.map((r, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-slate-700"><span className="mt-1 w-1.5 h-1.5 rounded-full bg-indigo-400 flex-shrink-0" />{r}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : data?.plan && (
        <div>
          <p className="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-2">Execution plan</p>
          <pre className="bg-white border border-slate-200 rounded-2xl p-4 text-xs text-slate-700 overflow-x-auto whitespace-pre-wrap">{data.plan}</pre>
        </div>
      )}

      {/* RCA generated only at the FINAL step, after the deep analysis */}
      <div className="flex justify-end pt-2 border-t border-slate-100">
        <button onClick={onRca}
          className="inline-flex items-center gap-1.5 h-10 px-5 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 text-white text-sm font-bold shadow hover:shadow-lg transition-all">
          <Stethoscope size={16} /> Generate RCA Report
        </button>
      </div>
    </div>
  );
}

/* ─────────────── Process detail (drill step for non-DB processes) ─────────────── */
function ProcDetail({ proc, onRca, techLabel = 'the database' }) {
  if (!proc) return null;
  const Field = ({ label, value, color }) => (
    <div className="bg-white rounded-xl border border-slate-200 px-4 py-3">
      <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">{label}</p>
      <p className="text-lg font-black mt-0.5" style={color ? { color } : undefined}>{value}</p>
    </div>
  );
  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-11 h-11 rounded-xl bg-slate-100 flex items-center justify-center"><ServerCog size={22} className="text-slate-500" /></div>
          <div>
            <h3 className="text-lg font-black text-slate-800 font-mono">{proc.command}</h3>
            <p className="text-xs text-slate-400">PID {proc.pid} · owner {proc.user} · non-database process</p>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Field label="CPU (host share)" value={`${proc.cpu_pct ?? 0}%`} color={colorFor(proc.cpu_pct)} />
        <Field label="Memory" value={`${proc.mem_pct ?? 0}%`} color={colorFor(proc.mem_pct)} />
        <Field label="RSS" value={`${proc.rss_mb ?? 0} MB`} />
        <Field label="Owner" value={proc.user} />
      </div>
      <div className="bg-slate-50 border border-slate-200 rounded-2xl px-5 py-4 text-sm text-slate-600">
        This is not a {techLabel} process. To understand <b>what it is and why it's consuming {`${proc.cpu_pct ?? 0}%`} CPU</b> — and confirm {techLabel} isn't the cause — generate the RCA report.
      </div>
      <div className="flex justify-end">
        <button onClick={onRca}
          className="inline-flex items-center gap-1.5 h-10 px-5 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 text-white text-sm font-bold shadow hover:shadow-lg transition-all">
          <Stethoscope size={16} /> Generate RCA Report
        </button>
      </div>
    </div>
  );
}

/* ─────────────── RCA Report (final step) — fancy, AI-narrated, PDF ─────────────── */
const SEV = {
  Critical: { bg: 'from-red-600 to-rose-700', chip: 'bg-red-100 text-red-700', dot: 'bg-red-500' },
  High:     { bg: 'from-orange-500 to-red-600', chip: 'bg-orange-100 text-orange-700', dot: 'bg-orange-500' },
  Medium:   { bg: 'from-amber-500 to-orange-500', chip: 'bg-amber-100 text-amber-700', dot: 'bg-amber-500' },
  Low:      { bg: 'from-emerald-500 to-teal-600', chip: 'bg-emerald-100 text-emerald-700', dot: 'bg-emerald-500' },
};

function RcaReport({ data, resource }) {
  const rca = data?.rca || {};
  const ev = data?.evidence || {};
  const isDb = data?.is_db_related;
  const engLabel = techName(ev.engine);
  const sev = SEV[rca.severity] || SEV.Medium;
  const now = new Date().toLocaleString();
  const reportRef = useRef(null);
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    if (!reportRef.current) return;
    setDownloading(true);
    try {
      await captureRcaPdf(reportRef.current, `ActMon-RCA-${resource}-${Date.now()}.pdf`);
    } catch (e) {
      console.error('[ActMon] RCA PDF error:', e);
      alert('Could not generate PDF: ' + (e?.message || e));
    } finally {
      setDownloading(false);
    }
  };

  const TONE = {
    slate: { ic: 'text-slate-500', dot: 'bg-slate-400' },
    indigo: { ic: 'text-indigo-500', dot: 'bg-indigo-400' },
    orange: { ic: 'text-orange-500', dot: 'bg-orange-400' },
    emerald: { ic: 'text-emerald-500', dot: 'bg-emerald-400' },
  };
  const Section = ({ icon: Icon, title, items, tone = 'slate' }) => {
    const t = TONE[tone] || TONE.slate;
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <div className="flex items-center gap-2 mb-3">
          <Icon size={16} className={t.ic} />
          <h4 className="text-sm font-black text-slate-700 uppercase tracking-wide">{title}</h4>
        </div>
        <ul className="space-y-2">
          {(items || []).map((s, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-slate-700">
              <span className={`mt-1.5 w-1.5 h-1.5 rounded-full ${t.dot} flex-shrink-0`} />{s}
            </li>
          ))}
          {(!items || items.length === 0) && <li className="text-sm text-slate-400">—</li>}
        </ul>
      </div>
    );
  };

  return (
    <div className="space-y-4" ref={reportRef}>
      {/* hero */}
      <div className={`rounded-2xl bg-gradient-to-br ${sev.bg} text-white p-6 relative overflow-hidden`}>
        <div className="absolute inset-0 opacity-[0.07]" style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '26px 26px' }} />
        <div className="relative flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Stethoscope size={20} />
              <span className="text-[11px] font-black uppercase tracking-widest opacity-80">Root Cause Analysis · {resource}</span>
            </div>
            <h3 className="text-xl font-black leading-tight max-w-2xl">{rca.title || rca.issue || 'Analysis'}</h3>
            {rca.issue && rca.title && <p className="text-sm opacity-90 mt-1 max-w-2xl">{rca.issue}</p>}
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <span className="text-[11px] font-black px-2.5 py-1 rounded-full bg-white/20 backdrop-blur">{rca.severity || 'Medium'} severity</span>
              <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-white/15">{isDb ? 'Database-related' : 'External (not the DB)'}</span>
              <span className="text-[11px] opacity-80">Generated {now}</span>
            </div>
          </div>
          <button onClick={handleDownload} disabled={downloading} data-noprint
            className="inline-flex items-center gap-2 h-10 px-4 rounded-xl bg-white text-slate-800 font-bold text-sm shadow-lg hover:bg-slate-100 disabled:opacity-70">
            {downloading ? <Loader size={16} className="animate-spin" /> : <Download size={16} />}
            {downloading ? 'Generating…' : 'Download PDF'}
          </button>
        </div>
      </div>

      {/* Step-wise decision path */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <p className="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-3">Decision path</p>
        <ol className="space-y-2.5">
          {[
            { t: `${resource} at ${ev.host_util_pct ?? '—'}% on the host`, ok: true },
            { t: `Split: ${engLabel} ${ev.db_share_pct ?? 0}% vs other/OS ${ev.external_share_pct ?? 0}% → ${isDb ? `${engLabel} IS the consumer` : 'NOT the database'}`, ok: true },
            ...(isDb
              ? [
                  { t: `Database under load: ${ev.analysis_db || ev.top_consumer?.db_name || '—'}`, ok: true },
                  { t: ev.top_consumer ? `Top query/session: ${ev.top_consumer.db_name || ''} ${ev.top_consumer.session_id != null ? '(session ' + ev.top_consumer.session_id + ')' : ''}` : 'Heaviest queries identified', ok: true },
                  { t: ev.missing_indexes?.length ? `${ev.missing_indexes.length} missing index(es) → create them` : 'No missing indexes detected', ok: !ev.missing_indexes?.length },
                  { t: ev.big_tables?.length ? `${ev.big_tables.length} very large table(s) → consider partitioning` : 'No partitioning needed', ok: !ev.big_tables?.length },
                ]
              : [
                  { t: ev.top_external_process ? `Top offender: ${ev.top_external_process.command} (PID ${ev.top_external_process.pid})` : 'A non-database OS process is the cause', ok: false },
                  { t: 'OS-level process list needs a host agent (Windows) / SSH (Linux)', ok: false },
                ]),
          ].map((s, i) => (
            <li key={i} className="flex items-start gap-2.5 text-sm">
              <span className={`mt-0.5 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black flex-shrink-0 ${s.ok ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{i + 1}</span>
              <span className="text-slate-700">{s.t}</span>
            </li>
          ))}
        </ol>
      </div>

      {/* DB vs external banner */}
      <div className={`rounded-2xl border px-5 py-4 flex items-start gap-3 ${isDb ? 'bg-indigo-50 border-indigo-200' : 'bg-slate-50 border-slate-200'}`}>
        {isDb ? <Database size={18} className="text-indigo-600 mt-0.5" /> : <ServerCog size={18} className="text-slate-500 mt-0.5" />}
        <div>
          <p className="font-black text-sm text-slate-800">
            {isDb ? `${engLabel} is driving ${resource} (${ev.db_share_pct}% vs ${ev.external_share_pct}% other)`
                  : `${resource} pressure is from a non-database process (${ev.external_share_pct}% other vs ${ev.db_share_pct}% ${engLabel})`}
          </p>
          {!isDb && ev.top_external_process && (
            <p className="text-xs text-slate-600 mt-0.5">Top offender: <b>{ev.top_external_process.command}</b> (PID {ev.top_external_process.pid}, user {ev.top_external_process.user}, {ev.top_external_process[resource === 'MEMORY' ? 'mem_pct' : 'cpu_pct']}%)</p>
          )}
        </div>
      </div>

      {/* CPU breakdown — the easy-to-understand calculation */}
      {resource === 'CPU' && (() => {
        const host = Math.round(Number(ev.host_util_pct ?? ev.host_cpu_pct ?? 0));
        const sqlc = Math.round(Number(ev.sql_server_cpu_pct ?? ev.db_share_pct ?? 0));
        // "other" = CPU we could attribute to specific non-DB processes from the sample.
        const otherRaw = Number(ev.other_cpu_pct ?? ev.external_share_pct ?? (host - sqlc));
        const other = Math.max(Math.round(otherRaw), 0);
        const idle = Math.max(100 - host, 0);
        // The host % is measured directly by the OS; per-process sampling rarely sums to it
        // (kernel/system time + short-lived or untracked processes). That residual is shown
        // explicitly so the numbers actually add up to the host total.
        const untracked = Math.max(host - sqlc - other, 0);
        const dbLabel = (ev.engine === 'mssql') ? 'SQL Server'
          : (ev.engine ? `${techName(ev.engine)} (database)` : 'Database');
        const topOs = (ev.os?.processes || []).slice(0, 4).filter((p) => p.cpu_pct > 0);
        return (
          <div className="bg-white rounded-2xl border border-slate-200 p-5">
            <h4 className="text-sm font-black text-slate-700 uppercase tracking-wide mb-1">CPU breakdown — how the {host}% is made up</h4>
            <p className="text-[11px] text-slate-500 mb-3">Total CPU in use is measured by the OS. Below, it is split into what we could trace to specific processes vs. the rest.</p>
            {/* stacked bar — SQL + traced-other + untracked + idle always fills 100% */}
            <div className="flex h-5 rounded-lg overflow-hidden mb-3 text-[10px] font-black text-white">
              {sqlc > 0 && <div style={{ width: `${sqlc}%`, background: '#6366f1' }} className="flex items-center justify-center" title={`${dbLabel} ${sqlc}%`}>{sqlc >= 6 ? `${sqlc}%` : ''}</div>}
              {other > 0 && <div style={{ width: `${other}%`, background: '#f59e0b' }} className="flex items-center justify-center" title={`Traced non-DB ${other}%`}>{other >= 6 ? `${other}%` : ''}</div>}
              {untracked > 0 && <div style={{ width: `${untracked}%`, background: '#94a3b8' }} className="flex items-center justify-center" title={`System / untracked ${untracked}%`}>{untracked >= 6 ? `${untracked}%` : ''}</div>}
              {idle > 0 && <div style={{ width: `${idle}%`, background: '#e2e8f0' }} className="flex items-center justify-center text-slate-600" title={`Idle ${idle}%`}>{idle >= 6 ? `${idle}%` : ''}</div>}
            </div>
            {/* the equation */}
            <div className="font-mono text-sm space-y-1">
              <div className="flex justify-between"><span className="flex items-center gap-2"><span className="w-3 h-3 rounded-sm" style={{ background: '#6366f1' }} /> {dbLabel}</span><span className="font-bold">{sqlc}%</span></div>
              <div className="flex justify-between"><span className="flex items-center gap-2"><span className="w-3 h-3 rounded-sm" style={{ background: '#f59e0b' }} /> Traced non-DB processes</span><span className="font-bold">{other}%</span></div>
              {untracked > 0 && (
                <div className="flex justify-between"><span className="flex items-center gap-2"><span className="w-3 h-3 rounded-sm" style={{ background: '#94a3b8' }} /> System / untracked processes</span><span className="font-bold">{untracked}%</span></div>
              )}
              <div className="flex justify-between border-t border-slate-200 pt-1 mt-1"><span className="font-black">= Total CPU in use</span><span className="font-black" style={{ color: colorFor(host) }}>{host}%</span></div>
              <div className="flex justify-between text-slate-400"><span>Idle (free)</span><span>{idle}%</span></div>
            </div>
            {topOs.length > 0 && (
              <p className="text-xs text-slate-500 mt-3">The <b>{other}%</b> traced non-DB is mainly: {topOs.map((p, i) => <span key={i}>{i ? ', ' : ''}<b>{p.name}</b> {p.cpu_pct}%</span>)}.</p>
            )}
            <p className="text-[11px] text-slate-400 mt-2">
              {sqlc}% ({dbLabel}) + {other}% (traced non-DB){untracked > 0 ? ` + ${untracked}% (system / untracked)` : ''} = {host}% in use, {idle}% idle.
              {untracked > 0 && ` The ${untracked}% "untracked" is kernel/system time plus short-lived or background processes not caught in the process snapshot — the OS counts it toward CPU, but no single process owns it.`}
            </p>
          </div>
        );
      })()}

      {/* root cause */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <h4 className="text-sm font-black text-slate-700 uppercase tracking-wide mb-2">Root cause</h4>
        <p className="text-sm text-slate-700 leading-relaxed">{rca.root_cause || '—'}</p>
      </div>

      {/* exact top consumer (named culprit) */}
      {ev.top_consumer && (
        <div className={`rounded-2xl p-4 border ${isDb ? 'bg-indigo-50 border-indigo-200' : 'bg-amber-50 border-amber-200'}`}>
          <p className={`text-[11px] font-black uppercase tracking-wider mb-1.5 ${isDb ? 'text-indigo-500' : 'text-amber-600'}`}>Top consumer</p>
          {ev.top_consumer.name ? (
            <p className="text-sm font-bold text-slate-800">
              {ev.top_consumer.name} · PID {ev.top_consumer.pid}
              {ev.top_consumer.cpu_pct != null ? ` · ${ev.top_consumer.cpu_pct}% CPU now` : ''}
              {ev.top_consumer.mem_mb != null ? ` · ${ev.top_consumer.mem_mb} MB` : ''}
              <span className="ml-2 text-[10px] font-black px-1.5 py-0.5 rounded bg-amber-500 text-white">NON-DB</span>
            </p>
          ) : (
            <>
              <p className="text-sm font-bold text-slate-800">
                {ev.top_consumer.session_id != null ? `Session ${ev.top_consumer.session_id}` : 'Query'}
                {ev.top_consumer.login_name ? ` · ${ev.top_consumer.login_name}` : ''}
                {ev.top_consumer.db_name ? ` · DB: ${ev.top_consumer.db_name}` : ''}
                {ev.top_consumer.cpu_ms != null ? ` · CPU ${Number(ev.top_consumer.cpu_ms).toLocaleString()} ms` : (ev.top_consumer.total_cpu_ms != null ? ` · CPU ${Number(ev.top_consumer.total_cpu_ms).toLocaleString()} ms` : '')}
                {ev.top_consumer.wait_type ? ` · wait: ${ev.top_consumer.wait_type}` : ''}
              </p>
              {ev.top_consumer.query && <code className="block text-xs font-mono text-slate-700 bg-white rounded-lg px-3 py-2 mt-2 break-all">{ev.top_consumer.query}</code>}
            </>
          )}
        </div>
      )}

      <Section icon={Activity}     title="Evidence"           items={rca.evidence_summary} tone="indigo" />

      {/* EXTERNAL cause → host CPU chart + the real OS processes (no DB tables/indexes shown) */}
      {!isDb && ev.os?.processes?.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-4">
          <h4 className="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-2">Windows processes consuming {resource} (live %)</h4>
          <div style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={ev.os.processes.slice(0, 8).map((p) => ({ name: p.name.replace(/\.exe$/i, ''), cpu: p.cpu_pct }))}
                margin={{ top: 6, right: 12, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#94a3b8' }} interval={0} angle={-20} textAnchor="end" height={50} />
                <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} unit="%" />
                <Tooltip />
                <Bar dataKey="cpu" fill="#f59e0b" radius={[4, 4, 0, 0]} name="CPU %" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <table className="w-full text-xs mt-2">
            <thead className="text-[10px] uppercase text-slate-400 font-black"><tr><th className="text-left py-1">Process</th><th className="text-right">PID</th><th className="text-right">CPU %</th><th className="text-right">CPU (s)</th><th className="text-right">Memory</th></tr></thead>
            <tbody>
              {ev.os.processes.slice(0, 10).map((p, i) => (
                <tr key={i} className={`border-t border-slate-100 ${/sqlservr/i.test(p.name) ? 'bg-indigo-50/40' : i === 0 ? 'bg-amber-50/60' : ''}`}>
                  <td className="py-1.5 font-mono">{p.name}</td>
                  <td className="text-right text-slate-500">{p.pid}</td>
                  <td className="text-right font-black" style={{ color: colorFor(p.cpu_pct) }}>{p.cpu_pct}%</td>
                  <td className="text-right text-slate-500">{Number(p.cpu_seconds).toLocaleString()}</td>
                  <td className="text-right text-slate-500">{p.mem_mb} MB</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[11px] text-slate-400 mt-2">Host CPU in use {ev.os.total_cpu_pct}% · idle {ev.os.idle_pct}% · {ev.os.cpu_cores} cores. SQL Server itself is only {ev.sql_server_cpu_pct}%.</p>
        </div>
      )}
      {!isDb && ev.os && !ev.os.enabled && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl px-5 py-4 text-sm text-amber-800">
          To name the Windows process here, enable Windows process visibility from the Processes view (uses xp_cmdshell).
        </div>
      )}

      {/* top queries (engine-agnostic: SQL Server / others) */}
      {ev.top_queries?.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-4">
          <h4 className="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-2">Heaviest queries by CPU</h4>
          <div className="space-y-2">
            {ev.top_queries.slice(0, 6).map((q, i) => (
              <div key={i} className="text-xs">
                <div className="flex justify-between text-slate-500">
                  <span>{q.db_name || '—'} · {q.execution_count ?? '—'} execs</span>
                  <span className="font-bold text-orange-600">{q.total_cpu_ms != null ? `${Number(q.total_cpu_ms).toLocaleString()} ms total` : ''}{q.avg_cpu_ms != null ? ` · ${q.avg_cpu_ms} ms avg` : ''}</span>
                </div>
                <code className="block font-mono text-slate-700 bg-slate-50 rounded px-2 py-1 mt-0.5 line-clamp-2 break-all">{q.query}</code>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* top waits */}
      {ev.top_waits?.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-4">
          <h4 className="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-2">Top wait types</h4>
          <div className="space-y-1.5">
            {ev.top_waits.slice(0, 6).map((w, i) => (
              <div key={i} className="flex justify-between text-xs text-slate-700">
                <span className="font-mono">{w.wait_type}</span>
                <span className="text-amber-600 font-bold">{Number(w.wait_time_ms).toLocaleString()} ms · {Number(w.waiting_tasks_count).toLocaleString()} tasks</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* evidence tables */}
      {isDb && (ev.top_statements?.length > 0 || ev.index_candidates?.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {ev.top_statements?.length > 0 && (
            <div className="bg-white rounded-2xl border border-slate-200 p-4">
              <h4 className="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-2">Top queries (pg_stat_statements)</h4>
              <div className="space-y-2">
                {ev.top_statements.map((q, i) => (
                  <div key={i} className="text-xs">
                    <div className="flex justify-between text-slate-500"><span>calls {q.calls}</span><span className="font-bold text-orange-600">{q.total_ms} ms total · {q.mean_ms} ms avg</span></div>
                    <code className="block font-mono text-slate-700 bg-slate-50 rounded px-2 py-1 mt-0.5 line-clamp-2 break-all">{q.query}</code>
                  </div>
                ))}
              </div>
            </div>
          )}
          {ev.index_candidates?.length > 0 && (
            <div className="bg-white rounded-2xl border border-slate-200 p-4">
              <h4 className="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-2">Tables likely missing an index</h4>
              <div className="space-y-1.5">
                {ev.index_candidates.map((t, i) => (
                  <div key={i} className="flex justify-between text-xs text-slate-700">
                    <span className="font-mono">{t.schemaname}.{t.relname}</span>
                    <span className="text-amber-600 font-bold">{Number(t.seq_tup_read).toLocaleString()} seq reads · {t.idx_scan} idx</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Section icon={Wrench}       title="Immediate actions"  items={rca.immediate_actions} tone="orange" />
        <Section icon={CheckCircle2} title="Permanent solution" items={rca.permanent_solution} tone="emerald" />
        <Section icon={ShieldCheck}  title="Precautions"        items={rca.precautions} tone="indigo" />
      </div>
    </div>
  );
}

/* Capture the actual colorful report DOM → multi-page A4 PDF, downloaded directly (no new tab). */
async function captureRcaPdf(node, filename) {
  const [imgMod, pdfMod] = await Promise.all([import('html-to-image'), import('jspdf')]);
  const jsPDF = pdfMod.jsPDF;
  const canvas = await imgMod.toCanvas(node, {
    pixelRatio: 2,
    backgroundColor: '#f1f5f9',
    cacheBust: true,
    filter: (n) => !(n?.getAttribute && n.getAttribute('data-noprint') !== null),
  });

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 8;
  const contentW = pageW - margin * 2;
  const pxPerMm = canvas.width / contentW;
  const pageContentPx = Math.floor((pageH - margin * 2) * pxPerMm);

  let y = 0;
  let first = true;
  while (y < canvas.height) {
    const sliceH = Math.min(pageContentPx, canvas.height - y);
    const slice = document.createElement('canvas');
    slice.width = canvas.width;
    slice.height = sliceH;
    const ctx = slice.getContext('2d');
    ctx.fillStyle = '#f1f5f9';
    ctx.fillRect(0, 0, slice.width, sliceH);
    ctx.drawImage(canvas, 0, y, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
    if (!first) pdf.addPage();
    first = false;
    pdf.addImage(slice.toDataURL('image/jpeg', 0.94), 'JPEG', margin, margin, contentW, sliceH / pxPerMm);
    y += sliceH;
  }
  pdf.save(filename);
}
