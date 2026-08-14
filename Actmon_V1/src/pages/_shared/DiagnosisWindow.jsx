/*
 * DiagnosisWindow — the one shared "why is this database unhealthy" report,
 * identical in structure across every OS and every database technology.
 * Only the data and the available actions change per environment; the
 * section order and layout never do (per the enterprise diagnosis spec).
 *
 * Reuses, rather than duplicates:
 *  - RSection / KStat / RTable / C palette   (pages/_shared/reportKit.jsx)
 *  - PasswordPrompt + errText                (components/ui/PasswordPrompt.jsx)
 *  - serviceAction (the already password-gated + audited service control API)
 *  - the backend orchestrator's normalized /diagnose/overview contract, which
 *    itself reuses diagnose_engine, host_action_service and each engine's own
 *    dashboard/error-log services — this component never invents data; a
 *    section with nothing real to show says so via `available:false`.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  X, RefreshCw, Server, Activity, Wifi, HeartPulse, AlertOctagon, FileText,
  Clock3, Search, Sparkles, Wrench, Copy, Download, ChevronDown, ChevronRight,
  CheckCircle2, XCircle, AlertTriangle, Loader2, Power, PlayCircle, Cpu,
} from 'lucide-react';
import client from '../../api/client';
import { serviceAction } from '../../api/servers';
import { PasswordPrompt, errText } from '../../components/ui/PasswordPrompt';
import { usePermissions } from '../../hooks/usePermissions';
import { RSection, KStat, RTable, C } from './reportKit';

/* ─── small local helpers (status/severity vocabulary is this feature's own) ─── */
const SEV_STYLE = {
  Critical: { bg: '#FDE7E9', fg: '#A4262C', dot: '#A4262C' },
  High:     { bg: '#FDE7E9', fg: '#A4262C', dot: '#D83B01' },
  Medium:   { bg: '#FFF4CE', fg: '#8A6D00', dot: '#D83B01' },
  Low:      { bg: '#DFF6DD', fg: '#107C10', dot: '#107C10' },
};
function SeverityBadge({ severity }) {
  const s = SEV_STYLE[severity] || SEV_STYLE.Low;
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold"
      style={{ background: s.bg, color: s.fg }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.dot }} />
      {severity || 'Unknown'}
    </span>
  );
}
const OK_WORDS = ['running', 'active', 'ok', 'healthy', 'true', 'online', 'primary', 'open'];
const BAD_WORDS = ['stopped', 'failed', 'down', 'false', 'offline', 'error'];
function TriBadge({ value }) {
  const v = String(value ?? '').toLowerCase();
  const cls = OK_WORDS.includes(v) ? 'bg-green-100 text-green-700'
    : BAD_WORDS.includes(v) ? 'bg-red-100 text-red-700'
    : 'bg-slate-100 text-slate-600';
  return <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${cls}`}>{value ?? '—'}</span>;
}
function Unavailable({ reason }) {
  return (
    <div className="flex items-start gap-2.5 bg-slate-50 border border-slate-200 rounded-lg p-3 text-[13px] text-slate-500">
      <AlertOctagon size={15} className="text-slate-400 flex-shrink-0 mt-0.5" />
      <span>{reason || 'Not available for this environment yet.'}</span>
    </div>
  );
}
function CheckRow({ c }) {
  const [open, setOpen] = useState(false);
  const icon = c.status === 'running' ? <Loader2 size={14} className="animate-spin text-blue-500" />
    : c.status === 'passed' ? <CheckCircle2 size={14} className="text-green-600" />
    : c.status === 'warning' ? <AlertTriangle size={14} className="text-amber-500" />
    : c.status === 'failed' ? <XCircle size={14} className="text-red-600" />
    : <Clock3 size={14} className="text-slate-300" />; // skipped / pending
  return (
    <div className="border-b border-slate-100 last:border-0">
      <button onClick={() => c.evidence && setOpen((v) => !v)}
        className="w-full flex items-center gap-2.5 py-2 text-left">
        {icon}
        <span className="text-[12.5px] font-semibold text-slate-700 flex-1">{c.title}</span>
        <span className="text-[11px] text-slate-400">{c.group}</span>
        {c.evidence && (open ? <ChevronDown size={13} className="text-slate-400" /> : <ChevronRight size={13} className="text-slate-400" />)}
      </button>
      {open && (
        <div className="mb-2 ml-6 bg-slate-900 text-slate-200 rounded-lg p-2.5 text-[11px] font-mono whitespace-pre-wrap max-h-40 overflow-y-auto">
          {c.detail}{c.evidence ? `\n\n${c.evidence}` : ''}
        </div>
      )}
    </div>
  );
}

const fetchOverview = (id) => client.get(`/databases/${id}/diagnose/overview`).then((r) => r.data);
const fetchPlan = (id) => client.get(`/databases/${id}/diagnose/plan`).then((r) => r.data);
const runOneCheck = (id, checkId) => client.get(`/databases/${id}/diagnose/check/${checkId}`).then((r) => r.data);
const postRca = (id, results) => client.post(`/databases/${id}/diagnose/rca`, { results }).then((r) => r.data.rca);
const postAi = (id, bundle) => client.post(`/databases/${id}/diagnose/ai-analysis`, bundle).then((r) => r.data.ai);
const postReport = (id, results, ai) => client.post(`/databases/${id}/diagnose/report`, { results, ai }).then((r) => r.data.report);

export default function DiagnosisWindow({ connId, open, onClose, connName }) {
  const qc = useQueryClient();
  const { canHere } = usePermissions();
  const canAct = canHere('edit');

  const [overview, setOverview] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [checks, setChecks] = useState([]);
  const [checksRunning, setChecksRunning] = useState(false);
  const [rca, setRca] = useState(null);
  const [ai, setAi] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [report, setReport] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [copyMsg, setCopyMsg] = useState('');
  const [actionPrompt, setActionPrompt] = useState(null); // { action, unit }
  const [recovery, setRecovery] = useState(null); // { ok, steps: [...] }

  const load = useCallback(async () => {
    if (!connId) return;
    setLoading(true); setLoadErr(null);
    setChecks([]); setRca(null); setAi(null); setReport(null); setRecovery(null);
    try {
      const ov = await fetchOverview(connId);
      if (ov.status !== 'success') throw new Error(ov.error || 'Diagnosis failed to load.');
      setOverview(ov);

      if (ov.os_checks_supported) {
        const plan = await fetchPlan(connId);
        const list = plan.checks || [];
        setChecksRunning(true);
        const results = [];
        for (const c of list) {
          setChecks((prev) => [...prev, { ...c, status: 'running' }]);
          // eslint-disable-next-line no-await-in-loop
          const r = await runOneCheck(connId, c.id);
          results.push(r);
          setChecks((prev) => prev.map((x) => (x.id === c.id ? { ...c, ...r } : x)));
        }
        setChecksRunning(false);
        const rcaRes = await postRca(connId, results);
        setRca(rcaRes);
      } else {
        const rcaRes = await postRca(connId, []);
        setRca(rcaRes);
      }
    } catch (e) {
      setLoadErr(errText(e, 'Could not load diagnosis.'));
    } finally {
      setLoading(false);
    }
  }, [connId]);

  useEffect(() => { if (open) load(); }, [open, load]);

  const runAi = async () => {
    if (!overview) return;
    setAiLoading(true);
    try {
      const bundle = { ...overview, checks, root_cause_analysis: rca };
      setAi(await postAi(connId, bundle));
    } catch (e) {
      setAi({ available: false, reason: errText(e, 'ActmonAI analysis failed.') });
    } finally { setAiLoading(false); }
  };

  const genReport = async () => {
    setReportLoading(true);
    try { setReport(await postReport(connId, checks, ai)); }
    catch (e) { setReport(`Report generation failed: ${errText(e)}`); }
    finally { setReportLoading(false); }
  };
  const copyReport = async () => {
    const text = report || await postReport(connId, checks, ai).then((r) => { setReport(r); return r; });
    await navigator.clipboard.writeText(text);
    setCopyMsg('Copied!'); setTimeout(() => setCopyMsg(''), 1500);
  };

  const runServiceAction = async (pw) => {
    const { action, unit } = actionPrompt;
    const r = await serviceAction(overview.server_id, unit, action, pw);
    setActionPrompt(null);
    setRecovery({ ok: null, message: 'Verifying recovery…' });
    qc.invalidateQueries({ queryKey: ['services', overview.server_id] });
    // Re-run diagnosis to verify Service → Connectivity → DB Health after the action.
    const fresh = await fetchOverview(connId);
    setOverview(fresh);
    const svcOk = fresh.service_process?.available && OK_WORDS.includes(String(fresh.service_process.service_status).toLowerCase());
    const dbOk = fresh.connectivity?.db_connection_test === true;
    setRecovery({
      ok: svcOk && dbOk,
      message: svcOk && dbOk
        ? 'Recovery Successful — service is running and the database is accepting connections.'
        : `Recovery Failed — service_status=${fresh.service_process?.service_status ?? 'unknown'}, db_connection_test=${fresh.connectivity?.db_connection_test ?? 'unknown'}.`,
    });
    return r;
  };

  if (!open) return null;

  const h = overview?.header;
  const sp = overview?.service_process;
  const conn = overview?.connectivity;
  const dh = overview?.database_health;
  const hh = overview?.host_os_health;
  const le = overview?.latest_error;
  const efl = overview?.error_files_logs;
  const timeline = overview?.timeline || [];
  const summary = overview?.summary;

  const svcRunning = sp?.available && OK_WORDS.includes(String(sp.service_status).toLowerCase());
  const svcStopped = sp?.available && BAD_WORDS.includes(String(sp.service_status).toLowerCase());

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full my-6 flex flex-col" style={{ maxWidth: 'min(1200px, 96vw)' }}
        onClick={(e) => e.stopPropagation()}>

        {/* ── 1. Header ── */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4 flex-shrink-0 bg-[#FAF9F8] rounded-t-2xl">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2.5 rounded-xl bg-[#DEECF9] text-brand-primary flex-shrink-0"><Search size={18} /></div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="font-bold text-[16px] text-slate-800 truncate">
                  Diagnosis — {connName || h?.database_name || `Connection ${connId}`}
                </h2>
                {h && <SeverityBadge severity={h.severity} />}
              </div>
              <p className="text-[12px] text-slate-500 mt-0.5">
                {h ? `${h.technology} · ${h.host}:${h.port} · ${h.os_type || 'OS unknown'} · Status: ${h.current_status}` : 'Loading…'}
                {h?.duration_seconds ? ` · Down ${Math.round(h.duration_seconds / 60)}m` : ''}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button onClick={load} disabled={loading} title="Refresh diagnosis"
              className="p-2 rounded-lg border border-slate-300 hover:bg-slate-100 disabled:opacity-50">
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            </button>
            <button onClick={onClose} className="p-2 rounded-lg border border-slate-300 hover:bg-slate-100"><X size={16} /></button>
          </div>
        </div>

        <div className="overflow-y-auto p-5" style={{ maxHeight: '82vh' }}>
          {loadErr && (
            <div className="mb-4 bg-red-50 border border-red-200 text-red-700 text-[13px] rounded-lg p-3">{loadErr}</div>
          )}
          {!overview && loading && (
            <div className="flex items-center justify-center py-20 text-slate-400 gap-2"><Loader2 className="animate-spin" size={18} /> Running diagnosis…</div>
          )}

          {overview && (
            <>
              {/* ── 2. Diagnosis Summary ── */}
              <RSection title="Diagnosis Summary" icon={HeartPulse} color={C.blue}>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <KStat label="Current Status" value={summary?.current_status} color={svcStopped ? C.red : C.green} />
                  <KStat label="Confidence" value={rca ? `${rca.confidence}%` : '—'} />
                  <KStat label="Detected At" value={rca?.detected_at || summary?.detected_at || '—'} />
                  <KStat label="Last Heartbeat" value={summary?.last_successful_heartbeat ? new Date(summary.last_successful_heartbeat).toLocaleString() : '—'} />
                </div>
                <div className="mt-3 bg-blue-50 border border-blue-100 rounded-lg p-3">
                  <p className="text-[11px] font-bold text-blue-500 uppercase tracking-wide mb-1">Primary Diagnosis / Root Cause</p>
                  <p className="text-[13.5px] text-slate-700 font-semibold">
                    {rca?.primary_cause || (checksRunning ? 'Running diagnostic checks…' : (rca?.reason || 'Diagnosis not yet run.'))}
                  </p>
                </div>
              </RSection>

              {/* ── 3. Latest Error ── */}
              <RSection title="Latest Error" icon={AlertOctagon} color={C.red}>
                {le?.available ? (
                  <div className="border-l-4 rounded-lg p-3 bg-red-50" style={{ borderColor: C.red }}>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[11px] font-bold text-red-600 uppercase">{le.severity}</span>
                      <span className="text-[11px] text-slate-400">{le.timestamp || ''}</span>
                    </div>
                    <p className="text-[13px] font-mono text-slate-700 whitespace-pre-wrap break-all">{le.message || '(no message text)'}</p>
                    {le.source && <p className="text-[11px] text-slate-400 mt-1.5">Source: {le.source}{le.log_file ? ` · ${le.log_file}` : ''}</p>}
                  </div>
                ) : <Unavailable reason={le?.reason} />}
              </RSection>

              {/* ── 4. Service / Process Status ── */}
              <RSection title="Service / Process Status" icon={Server} color={C.indigo}>
                {sp?.available ? (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <KStat label="Service Name" value={sp.service_name} />
                    <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide mb-1">Service Status</p>
                      <TriBadge value={sp.service_status} />
                    </div>
                    <KStat label="Process / PID" value={sp.process_name ? `${sp.process_name} (${sp.pid})` : '—'} />
                    <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide mb-1">DB Accepting Connections</p>
                      <TriBadge value={sp.db_accepting_connections === null ? undefined : sp.db_accepting_connections} />
                    </div>
                  </div>
                ) : <Unavailable reason={sp?.reason} />}
              </RSection>

              {/* ── 5. Connectivity ── */}
              <RSection title="Connectivity" icon={Wifi} color={C.cyan}>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-2">
                  <KStat label="Host : Port" value={`${conn?.host}:${conn?.port}`} />
                  <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide mb-1">Port Listening</p>
                    <TriBadge value={conn?.port_listening === null ? undefined : conn?.port_listening} />
                  </div>
                  <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide mb-1">DB Connection Test</p>
                    <TriBadge value={conn?.db_connection_test === null ? undefined : conn?.db_connection_test} />
                  </div>
                  <KStat label="Latency" value={conn?.latency_ms != null ? `${conn.latency_ms} ms` : '—'} />
                </div>
                {conn?.result && <p className="text-[12px] text-slate-500 font-mono bg-slate-50 rounded-lg p-2 whitespace-pre-wrap break-all">{conn.result}</p>}
              </RSection>

              {/* ── 6. Database Health ── */}
              <RSection title="Database Health" icon={Activity} color={C.green}>
                {dh?.available ? (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {dh.items.map((it) => <KStat key={it.label} label={it.label} value={it.value} />)}
                  </div>
                ) : <Unavailable reason={dh?.reason} />}
              </RSection>

              {/* ── 7. Host / OS Health ── */}
              <RSection title="Host / OS Health" icon={Cpu} color={C.purple}>
                {hh?.available ? (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <KStat label="CPU" value={hh.cpu} color={Number(hh.cpu) > 85 ? C.red : C.slate} />
                    <KStat label="Memory" value={hh.memory} color={Number(hh.memory) > 85 ? C.red : C.slate} />
                    <KStat label="Disk" value={hh.disk} color={Number(hh.disk) > 90 ? C.red : C.slate} />
                    <KStat label="Uptime" value={hh.uptime} />
                  </div>
                ) : <Unavailable reason={hh?.reason} />}
              </RSection>

              {/* ── 8. Error Files & Logs ── */}
              <RSection title="Error Files & Logs" icon={FileText} color={C.orange}>
                {efl?.available && efl.entries?.length ? (
                  <>
                    <RTable headers={['Timestamp', 'Severity', 'Message']}
                      rows={efl.entries.slice(0, 15).map((e) => [e.timestamp || '—', e.severity, <span className="font-mono break-all">{e.message}</span>])} />
                    <div className="flex items-center gap-2 mt-3">
                      {efl.log_file && <span className="text-[11px] text-slate-400 font-mono">{efl.log_file}</span>}
                      <button onClick={load} className="ml-auto text-[12px] text-blue-600 hover:underline flex items-center gap-1"><RefreshCw size={12} /> Refresh Logs</button>
                      <button onClick={() => navigator.clipboard.writeText(efl.entries.map((e) => `${e.timestamp} [${e.severity}] ${e.message}`).join('\n'))}
                        className="text-[12px] text-blue-600 hover:underline flex items-center gap-1"><Copy size={12} /> Copy</button>
                    </div>
                  </>
                ) : <Unavailable reason={efl?.reason} />}
              </RSection>

              {/* ── 9. Diagnosis Timeline ── */}
              <RSection title="Diagnosis Timeline" icon={Clock3} color={C.slate}>
                <div className="space-y-0">
                  {timeline.map((t, i) => (
                    <div key={t.label} className="flex items-start gap-3">
                      <div className="flex flex-col items-center">
                        <span className={`w-2.5 h-2.5 rounded-full ${t.available ? 'bg-blue-500' : 'bg-slate-200'}`} />
                        {i < timeline.length - 1 && <span className="w-px flex-1 bg-slate-200 my-0.5" style={{ minHeight: 18 }} />}
                      </div>
                      <div className="pb-3 -mt-0.5">
                        <p className={`text-[13px] font-semibold ${t.available ? 'text-slate-700' : 'text-slate-400'}`}>{t.label}</p>
                        <p className="text-[11px] text-slate-400">{t.available ? (t.timestamp ? new Date(t.timestamp).toLocaleString() : t.timestamp) : 'Not available'}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </RSection>

              {/* ── 10. Root Cause Analysis ── */}
              <RSection title="Root Cause Analysis" icon={Search} color={C.red}>
                {rca && !rca.insufficient ? (
                  <div className="space-y-2">
                    <p className="text-[13.5px] font-bold text-slate-800">{rca.primary_cause}</p>
                    <p className="text-[12px] text-slate-500">Confidence: {rca.confidence}%</p>
                    {rca.evidence?.length > 0 && (
                      <ul className="list-disc list-inside text-[12.5px] text-slate-600 space-y-1">
                        {rca.evidence.map((e, i) => <li key={i}>{typeof e === 'string' ? e : JSON.stringify(e)}</li>)}
                      </ul>
                    )}
                  </div>
                ) : (
                  <Unavailable reason={rca?.reason || 'Root cause could not be determined from the available diagnostics.'} />
                )}
                {rca?.missing_checks?.length > 0 && (
                  <p className="text-[11px] text-slate-400 mt-2">Missing checks: {rca.missing_checks.join(', ')}</p>
                )}
                {checks.length > 0 && (
                  <div className="mt-4 border-t border-slate-100 pt-2">
                    <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide mb-1">
                      Diagnostic Checks {checksRunning && <Loader2 size={11} className="inline animate-spin ml-1" />}
                    </p>
                    {checks.map((c) => <CheckRow key={c.id} c={c} />)}
                  </div>
                )}
              </RSection>

              {/* ── 11. ActmonAI Analysis ── */}
              <RSection title="ActmonAI Analysis" icon={Sparkles} color={C.indigo}>
                {!ai && (
                  <button onClick={runAi} disabled={aiLoading || checksRunning}
                    className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[13px] font-bold disabled:opacity-50">
                    {aiLoading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Run ActmonAI Analysis
                  </button>
                )}
                {ai?.available && (
                  <div className="space-y-2 mt-1">
                    <p className="text-[13.5px] text-slate-700">{ai.diagnosis}</p>
                    <p className="text-[13px] font-bold text-slate-800">Root cause: {ai.root_cause}</p>
                    {ai.evidence?.length > 0 && (
                      <ul className="list-disc list-inside text-[12.5px] text-slate-600 space-y-1">
                        {ai.evidence.map((e, i) => <li key={i}>{e}</li>)}
                      </ul>
                    )}
                    <p className="text-[13px] text-slate-700"><span className="font-bold">Recommended:</span> {ai.recommended_resolution}</p>
                    <p className="text-[11px] text-slate-400">Confidence: {ai.confidence}%</p>
                  </div>
                )}
                {ai && !ai.available && <Unavailable reason={ai.reason} />}
              </RSection>

              {/* ── 12 & 13. Recommended Actions / Start-Restart Service ── */}
              <RSection title="Recommended Actions" icon={Wrench} color={C.amber}>
                <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide mb-2">Safe Diagnostic Actions</p>
                <div className="flex flex-wrap gap-2 mb-3">
                  <button onClick={load} className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 rounded-lg text-[12.5px] font-semibold text-slate-700">
                    <RefreshCw size={13} /> Re-run Diagnosis
                  </button>
                </div>
                {overview.server_id && sp?.available && (
                  <>
                    <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide mb-2">Recovery Actions</p>
                    <div className="flex flex-wrap gap-2 mb-2">
                      {svcStopped && canAct && (
                        <button onClick={() => setActionPrompt({ action: 'start', unit: sp.service_name })}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-[12.5px] font-bold">
                          <PlayCircle size={13} /> Start Service
                        </button>
                      )}
                      {svcRunning && canAct && (
                        <button onClick={() => setActionPrompt({ action: 'restart', unit: sp.service_name })}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-[12.5px] font-bold">
                          <Power size={13} /> Restart Service
                        </button>
                      )}
                      {!canAct && <p className="text-[12px] text-slate-400 italic">You don't have permission to perform recovery actions here.</p>}
                    </div>
                    {!svcStopped && !svcRunning && (
                      <p className="text-[12px] text-slate-400 italic mb-2">Service state is unknown — no restart action is offered until it can be confirmed, to avoid restarting something unrelated.</p>
                    )}
                  </>
                )}
                {recovery && (
                  <div className={`mt-2 flex items-center gap-2 rounded-lg p-3 text-[13px] font-semibold ${recovery.ok === true ? 'bg-green-50 text-green-700' : recovery.ok === false ? 'bg-red-50 text-red-700' : 'bg-slate-50 text-slate-500'}`}>
                    {recovery.ok === true ? <CheckCircle2 size={15} /> : recovery.ok === false ? <XCircle size={15} /> : <Loader2 size={15} className="animate-spin" />}
                    {recovery.message}
                  </div>
                )}
              </RSection>

              {/* ── 14. Diagnostic Report ── */}
              <RSection title="Diagnostic Report" icon={FileText} color={C.teal} className="mb-2">
                <div className="flex flex-wrap gap-2 mb-3">
                  <button onClick={genReport} disabled={reportLoading}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-[12.5px] font-bold disabled:opacity-50">
                    {reportLoading ? <Loader2 size={13} className="animate-spin" /> : <FileText size={13} />} Generate Report
                  </button>
                  <button onClick={copyReport} className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 rounded-lg text-[12.5px] font-semibold text-slate-700">
                    <Copy size={13} /> {copyMsg || 'Copy Report'}
                  </button>
                  {report && (
                    <a download={`actmon-diagnosis-conn${connId}.txt`}
                      href={`data:text/plain;charset=utf-8,${encodeURIComponent(report)}`}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 rounded-lg text-[12.5px] font-semibold text-slate-700">
                      <Download size={13} /> Download
                    </a>
                  )}
                </div>
                {report && <pre className="bg-slate-900 text-slate-200 rounded-lg p-3 text-[11px] font-mono whitespace-pre-wrap max-h-80 overflow-y-auto">{report}</pre>}
              </RSection>
            </>
          )}
        </div>

        {actionPrompt && (
          <PasswordPrompt
            title={`${actionPrompt.action === 'start' ? 'Start' : 'Restart'} — ${h?.database_name} (${actionPrompt.unit})`}
            confirmLabel={actionPrompt.action === 'start' ? 'Start Service' : 'Restart Service'}
            onConfirm={(pw) => runServiceAction(pw)}
            onClose={() => setActionPrompt(null)}
          />
        )}
      </div>
    </div>
  );
}
