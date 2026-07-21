import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import client from '../../api/client';
import PageHeader from '../../components/layout/PageHeader';
import {
  ChevronLeft, ChevronRight, RefreshCw, Download, FileText, Heart, Activity,
  Layers, Settings, Play, Terminal, Copy, Maximize2, CheckCircle2, XCircle,
  AlertTriangle, Loader2, MinusCircle, Info, Cpu, Zap, ArrowRight, ArrowLeft,
  SkipForward, Plug, Sparkles, ShieldAlert, Wrench, Stethoscope, Server,
} from 'lucide-react';

/* ── status visuals ─────────────────────────────────────────────────────── */
const CIRCLE = {
  passed:  'bg-emerald-500 text-white border-emerald-500',
  failed:  'bg-red-500 text-white border-red-500',
  warning: 'bg-amber-500 text-white border-amber-500',
  running: 'bg-indigo-600 text-white border-indigo-600',
  info:    'bg-slate-400 text-white border-slate-400',
  skipped: 'bg-slate-200 text-slate-500 border-slate-200',
  pending: 'bg-white text-slate-400 border-slate-300',
  current: 'bg-indigo-600 text-white border-indigo-600 ring-4 ring-indigo-100',
};
const STLABEL = {
  passed: 'text-emerald-600', failed: 'text-red-500', warning: 'text-amber-600',
  running: 'text-indigo-600', skipped: 'text-slate-400', pending: 'text-slate-400', info: 'text-slate-400',
};
const qaFor = (eng, id) => {
  const d = `/${eng}-dashboard/${id}`;
  const a = [
    { icon: FileText, label: 'View Error Logs', sub: 'logs & journal', color: 'text-red-500', path: `${d}/error-logs` },
    { icon: Activity, label: 'Slow Query Analysis', sub: 'when server is up', color: 'text-amber-500', path: `${d}/slow-queries` },
    { icon: Settings, label: 'Configuration Check', sub: 'config validation', color: 'text-blue-500', path: `${d}` },
    { icon: Layers, label: 'Index Analysis', sub: 'schema diagnostics', color: 'text-violet-500', path: `${d}/index-analysis` },
  ];
  if (eng === 'mysql') a.splice(1, 0, { icon: Heart, label: 'Self-Heal Terminal', sub: 'root commands', color: 'text-pink-500', path: `${d}/self-heal` });
  return a;
};

function InfoCard({ icon: Icon, tint, title, children }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 flex-1 min-w-0">
      <div className={`flex items-center gap-2 text-[12px] font-black mb-2 ${tint}`}><Icon size={14} /> {title}</div>
      <div className="text-[12.5px] text-slate-600 leading-relaxed">{children}</div>
    </div>
  );
}

export default function DatabaseDiagnosis() {
  const { connId } = useParams();
  const navigate = useNavigate();
  const [meta, setMeta]   = useState(null);
  const [conn, setConn]   = useState(null);
  const [ctx, setCtx]     = useState(null);
  const [steps, setSteps] = useState([]);
  const [cur, setCur]     = useState(0);
  const [rca, setRca]     = useState(null);
  const [busy, setBusy]   = useState(false);
  const [copied, setCopied] = useState(false);
  const [svcMsg, setSvcMsg] = useState(null);
  const termRef = useRef(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [planR, det, cx] = await Promise.all([
        client.get(`/databases/${connId}/diagnose/plan`).then(r => r.data).catch(() => ({})),
        client.get(`/databases/${connId}/diagnose/connect`).then(r => r.data).catch(() => ({})),
        client.get(`/databases/${connId}/diagnose/context`).then(r => r.data).catch(() => ({})),
      ]);
      if (!alive) return;
      setMeta({ engine: planR.engine, ...det });
      setConn(det); setCtx(cx);
      setSteps((planR.checks || []).map(c => ({ ...c, status: 'pending', output: '', detail: '', analysis: null })));
    })();
    return () => { alive = false; };
  }, [connId]);

  const eng = (meta?.db_type || '').toLowerCase();
  const step = steps[cur] || {};

  const runStep = useCallback(async (i) => {
    if (i < 0 || i >= steps.length) return;
    setBusy(true);
    setSteps(prev => prev.map((s, idx) => idx === i ? { ...s, status: 'running' } : s));
    let res;
    try { res = await client.get(`/databases/${connId}/diagnose/check/${steps[i].id}`).then(r => r.data); }
    catch (e) { res = { status: 'skipped', detail: 'Request failed', output: String(e?.message || e) }; }
    setSteps(prev => prev.map((s, idx) => idx === i
      ? { ...s, status: res.status || 'info', detail: res.detail || '', output: res.output || res.evidence || '', analysis: res.analysis || null } : s));
    setBusy(false);
    setTimeout(() => termRef.current?.scrollTo(0, termRef.current.scrollHeight), 100);
  }, [connId, steps]);

  const runAll = async () => { for (let i = 0; i < steps.length; i++) { setCur(i); /* eslint-disable-next-line no-await-in-loop */ await runStep(i); } await finish(); };
  const next = () => { if (cur < steps.length - 1) setCur(cur + 1); else finish(); };
  const prev = () => { if (cur > 0) setCur(cur - 1); };
  const skip = () => { setSteps(p => p.map((s, i) => i === cur && s.status === 'pending' ? { ...s, status: 'skipped', detail: 'Skipped by user' } : s)); next(); };
  const finish = async () => {
    const done = steps.map(s => ({ id: s.id, status: s.status, detail: s.detail, evidence: s.output }));
    const r = await client.post(`/databases/${connId}/diagnose/rca`, { results: done }).then(x => x.data).catch(() => null);
    setRca(r?.rca || null);
  };
  const startService = async () => {
    setSvcMsg('starting');
    try { const r = await client.post(`/databases/${connId}/diagnose/start-service`).then(x => x.data); setSvcMsg(r.active ? 'ok' : 'fail'); if (r.active) setTimeout(() => runStep(0), 1500); }
    catch { setSvcMsg('fail'); }
  };
  const copyCmd = () => { navigator.clipboard?.writeText(step.command || ''); setCopied(true); setTimeout(() => setCopied(false), 1400); };
  const downloadReport = () => {
    const L = ['ActMon — ' + (meta?.engine || '') + ' Diagnosis Report', `Host: ${meta?.host}:${meta?.port}`, ''];
    if (rca) L.push(`Overall: ${rca.overall_health} (${rca.severity}, ${rca.confidence}%)`, `Root cause: ${rca.root_cause}`, `Fix: ${rca.recommended_fix}`, '');
    steps.forEach(s => L.push(`[${(s.status || '').toUpperCase()}] ${s.title} — ${s.detail}`));
    const b = new Blob([L.join('\n')], { type: 'text/plain' }); const a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = `actmon-${eng}-diagnosis-${connId}.txt`; a.click();
  };

  const allRun = steps.length > 0 && steps.every(s => s.status !== 'pending');
  const di = ctx?.dbinfo || {};
  const journal = ctx?.journal_errors || [];
  const logErrs = ctx?.log_errors || [];
  const accent = { mysql: 'mysql', mariadb: 'mysql', postgresql: 'postgres', postgres: 'postgres', oracle: 'oracle', mssql: 'mssql' }[eng] || 'blue';

  return (
    <div className="min-h-full bg-slate-50">
      <PageHeader
        icon={Stethoscope}
        title={`${meta?.engine || 'Database'} Diagnosis Center`}
        subtitle={`${meta?.engine || ''} • ${meta?.host || ''}:${meta?.port || ''}  ·  ${di.up ? 'Running' : 'Not Running'}`}
        crumbs={[{ label: 'Databases', to: '/databases' }, { label: meta?.engine || 'Database' }, { label: 'Diagnosis Center' }]}
        backTo="/databases"
        accent={accent}
        actions={(
          <>
            <button onClick={runAll} disabled={busy}
              className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 border border-white/20 text-white text-[13px] font-bold disabled:opacity-50">
              <Zap size={14} /> Run Diagnosis
            </button>
            <button onClick={downloadReport} disabled={!allRun}
              className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 border border-white/20 text-white text-[13px] font-bold disabled:opacity-40">
              <Download size={14} /> Download RCA
            </button>
          </>
        )}
      />

      <div className="py-5 grid grid-cols-1 xl:grid-cols-[300px_minmax(0,1fr)] gap-4 items-start">
        {/* ══ LEFT ══ */}
        <div className="space-y-3">
          {/* Connection */}
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2 flex items-center gap-1.5"><Plug size={12} className="text-indigo-500" /> Connection</p>
            <p className="text-[13px] font-bold text-slate-800">{conn?.connected ? `Connected via ${conn.method?.toUpperCase()}` : 'Not connected'}</p>
            <div className="flex flex-wrap gap-1 mt-2">
              {['agent', 'ssh', 'linux', 'api'].map(m => {
                const active = conn?.method === m; const avail = (conn?.methods_available || []).includes(m);
                return <span key={m} className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${active ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : avail ? 'bg-blue-50 text-blue-600 border-blue-200' : 'bg-slate-50 text-slate-400 border-slate-200'}`}>{m.toUpperCase()}{active ? ' ✓' : ''}</span>;
              })}
            </div>
            <div className="mt-3 space-y-1 text-[12px]">
              <div className="flex justify-between gap-2"><span className="text-slate-400">Host</span><span className="font-mono font-semibold text-slate-700 truncate">{meta?.host}</span></div>
              <div className="flex justify-between gap-2"><span className="text-slate-400">OS</span><span className="font-semibold text-slate-700 truncate ml-2">{di.os || 'Linux'}</span></div>
              <div className="flex justify-between gap-2"><span className="text-slate-400">{meta?.engine} Version</span><span className="font-mono font-semibold text-slate-700 truncate ml-2">{di.version || '—'}</span></div>
            </div>
          </div>

          {/* Quick actions */}
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2 flex items-center gap-1.5"><Zap size={12} className="text-cyan-500" /> Quick Actions</p>
            <div className="space-y-1.5">
              {qaFor(eng, connId).map(({ icon: Icon, label, sub, color, path }) => (
                <button key={label} onClick={() => navigate(path)} className="w-full flex items-center gap-2.5 px-2.5 py-2 bg-slate-50 hover:bg-slate-100 rounded-lg text-left group">
                  <Icon size={15} className={color} />
                  <div className="flex-1 min-w-0"><p className="text-[12.5px] font-bold text-slate-800 leading-tight">{label}</p><p className="text-[10.5px] text-slate-400">{sub}</p></div>
                  <ChevronRight size={13} className="text-slate-300 group-hover:text-slate-500" />
                </button>
              ))}
            </div>
          </div>

          {/* DB info */}
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2 flex items-center gap-1.5"><Info size={12} className="text-slate-400" /> DB Info</p>
            <div className="space-y-1.5 text-[12px]">
              <div className="flex justify-between"><span className="text-slate-400">Uptime</span><span className={`font-black ${di.up ? 'text-emerald-600' : 'text-red-500'}`}>{di.up ? 'UP' : 'DOWN'}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">{meta?.engine} Status</span><span className={`font-bold ${di.up ? 'text-emerald-600' : 'text-red-500'}`}>{di.status || 'Unknown'}</span></div>
              <div className="flex justify-between gap-2"><span className="text-slate-400">Data Directory</span><span className="font-mono font-semibold text-slate-700 truncate ml-2">{di.data_directory || '—'}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">Port</span><span className="font-mono font-semibold text-slate-700">{di.port || meta?.port}</span></div>
              <div className="flex justify-between items-center"><span className="text-slate-400">Last Check</span>
                <button onClick={() => client.get(`/databases/${connId}/diagnose/context`).then(r => setCtx(r.data))} className="text-slate-500 hover:text-indigo-600"><RefreshCw size={12} /></button></div>
            </div>
          </div>
        </div>

        {/* ══ RIGHT ══ */}
        <div className="bg-white border border-slate-200 rounded-xl flex flex-col min-w-0">
          <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
            <span className="font-black text-slate-800 text-[14px] flex items-center gap-2"><Activity size={15} className="text-indigo-500" /> Diagnostic Checks</span>
            <span className="text-[12px] text-slate-400 font-semibold">Step {cur + 1} of {steps.length}</span>
          </div>

          {/* stepper */}
          <div className="px-5 py-4 border-b border-slate-100 overflow-x-auto">
            <div className="flex items-start gap-1 min-w-max">
              {steps.map((s, i) => {
                const cls = i === cur ? CIRCLE.current : (CIRCLE[s.status] || CIRCLE.pending);
                return (
                  <React.Fragment key={s.id}>
                    <button onClick={() => setCur(i)} className="flex flex-col items-center gap-1 w-[74px]">
                      <span className={`w-8 h-8 rounded-full border-2 flex items-center justify-center text-[12px] font-black ${cls}`}>
                        {s.status === 'running' ? <Loader2 size={14} className="animate-spin" /> :
                         s.status === 'passed' ? <CheckCircle2 size={15} /> :
                         s.status === 'failed' ? <XCircle size={15} /> :
                         s.status === 'warning' ? <AlertTriangle size={14} /> : (i + 1)}
                      </span>
                      <span className={`text-[9.5px] font-bold text-center leading-tight ${i === cur ? 'text-indigo-600' : 'text-slate-500'}`}>{s.title}</span>
                      <span className={`text-[8.5px] font-bold uppercase ${STLABEL[s.status] || 'text-slate-300'}`}>{s.status}</span>
                    </button>
                    {i < steps.length - 1 && <span className="h-0.5 w-3 bg-slate-200 mt-4 flex-shrink-0" />}
                  </React.Fragment>
                );
              })}
            </div>
          </div>

          {/* step body */}
          <div className="p-5 flex-1 space-y-4">
            <h3 className="font-black text-slate-800 text-[15px]">Step {cur + 1}: {step.title}</h3>

            <div className="flex flex-wrap gap-3">
              <InfoCard icon={Info} tint="text-blue-500" title="Why this check?">{step.why || '—'}</InfoCard>
              <InfoCard icon={CheckCircle2} tint="text-emerald-500" title="What is being checked?">{step.what || '—'}</InfoCard>
              <InfoCard icon={FileText} tint="text-violet-500" title="Files Involved">
                {(step.files || []).length ? <ul className="space-y-0.5 font-mono text-[11.5px]">{step.files.map((f, i) => <li key={i} className="truncate">{f}</li>)}</ul> : <span className="text-slate-400">—</span>}
              </InfoCard>
              <InfoCard icon={Terminal} tint="text-slate-700" title="Command to Run">
                <code className="block bg-slate-100 rounded px-2 py-1 font-mono text-[11.5px] text-slate-800 break-all">{step.command || '—'}</code>
                <p className="text-[11px] text-slate-400 mt-1">{step.command_desc}</p>
                <button onClick={copyCmd} className="mt-1.5 flex items-center gap-1 text-[11px] font-bold text-slate-500 hover:text-slate-700"><Copy size={11} /> {copied ? 'Copied' : 'Copy Command'}</button>
              </InfoCard>
            </div>

            {/* run */}
            <div className="flex items-center gap-3">
              <button onClick={() => runStep(cur)} disabled={busy}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-[13px] font-bold disabled:opacity-50">
                {busy && step.status === 'running' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Run Command
              </button>
              <span className="text-[12px] text-slate-400">Click to execute the command</span>
            </div>

            {/* terminal */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[12px] font-black text-slate-600 flex items-center gap-1.5"><Terminal size={13} /> Terminal Output <span className="text-[10px] text-emerald-500">(Live)</span></span>
                <button onClick={() => navigator.clipboard?.writeText(step.output || '')} title="Copy" className="text-slate-400 hover:text-slate-700"><Copy size={13} /></button>
              </div>
              <pre ref={termRef} className="bg-slate-950 text-slate-200 rounded-lg p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words max-h-64 overflow-y-auto min-h-[80px]">
                {step.status === 'running' ? 'Running…' : (step.output || (step.status === 'pending' ? '$ ' + (step.command || '') + '\n(click Run Command)' : '(no output)'))}
              </pre>
            </div>

            {/* bottom 3 panels */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              <div className="border border-slate-200 rounded-lg overflow-hidden min-w-0">
                <div className="px-3 py-2 bg-slate-50 border-b border-slate-100 text-[11px] font-black text-slate-500">Latest Journal Errors</div>
                <div className="max-h-52 overflow-y-auto divide-y divide-slate-50">
                  {journal.length === 0 ? <p className="p-3 text-[11.5px] text-slate-400">No entries.</p> :
                    journal.map((r, i) => (<div key={i} className="px-3 py-1.5"><span className={`text-[9px] font-black px-1 rounded mr-1 ${r.level === 'FATAL' ? 'bg-red-100 text-red-700' : r.level === 'ERROR' ? 'bg-orange-100 text-orange-700' : 'bg-slate-100 text-slate-500'}`}>{r.level}</span><span className="text-[11px] text-slate-600 break-words">{r.message}</span></div>))}
                </div>
              </div>
              <div className="border border-slate-200 rounded-lg overflow-hidden min-w-0">
                <div className="px-3 py-2 bg-slate-50 border-b border-slate-100 text-[11px] font-black text-slate-500">Latest {meta?.engine} Errors</div>
                <div className="max-h-52 overflow-y-auto divide-y divide-slate-50">
                  {logErrs.length === 0 ? <p className="p-3 text-[11.5px] text-slate-400">No entries.</p> :
                    logErrs.map((r, i) => (<div key={i} className="px-3 py-1.5"><span className={`text-[9px] font-black px-1 rounded mr-1 ${r.level === 'FATAL' ? 'bg-red-100 text-red-700' : r.level === 'ERROR' ? 'bg-orange-100 text-orange-700' : 'bg-slate-100 text-slate-500'}`}>{r.level}</span><span className="text-[11px] text-slate-600 break-words">{r.message}</span></div>))}
                </div>
              </div>
              <div className="border border-slate-200 rounded-lg overflow-hidden min-w-0">
                <div className="px-3 py-2 bg-slate-50 border-b border-slate-100 text-[11px] font-black text-slate-500 flex items-center gap-1.5"><Sparkles size={12} className="text-violet-500" /> Analysis</div>
                <div className="p-3 text-[11.5px]">
                  {!step.analysis ? <p className="text-slate-400">Run this step to see analysis.</p> : (
                    <>
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className={`text-[10px] font-black px-1.5 py-0.5 rounded ${step.analysis.status === 'OK' ? 'bg-emerald-100 text-emerald-700' : step.analysis.status === 'FAILED' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>{step.analysis.status}</span>
                        <span className="text-[10px] font-bold text-slate-400">{step.analysis.severity}</span>
                      </div>
                      <p className="font-bold text-slate-700">Root Cause</p><p className="text-slate-500 mb-1.5">{step.analysis.root_cause}</p>
                      {step.analysis.impact && <><p className="font-bold text-slate-700">Impact</p><p className="text-slate-500 mb-1.5">{step.analysis.impact}</p></>}
                      {(step.analysis.fixes || []).length > 0 && <><p className="font-bold text-slate-700">Recommended Fix</p><ul className="list-disc ml-4 text-slate-500">{step.analysis.fixes.map((f, i) => <li key={i}>{f}</li>)}</ul></>}
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* RCA (after all steps) */}
            {allRun && rca && (
              <div className="border border-indigo-200 bg-indigo-50/40 rounded-xl p-4">
                <div className="flex flex-wrap items-center gap-3 mb-2">
                  <ShieldAlert size={16} className="text-red-500" />
                  <span className="font-black text-slate-800">Root Cause Analysis</span>
                  <span className={`px-2 py-0.5 rounded-full text-[11px] font-black border ${rca.severity === 'Critical' ? 'bg-red-100 text-red-700 border-red-300' : rca.severity === 'High' ? 'bg-orange-100 text-orange-700 border-orange-300' : 'bg-amber-100 text-amber-700 border-amber-300'}`}>{rca.severity} · {rca.confidence}%</span>
                  {(rca.failed_components || []).includes('service') && <button onClick={startService} disabled={svcMsg === 'starting'} className="ml-auto h-8 px-3 rounded-lg bg-emerald-600 text-white text-[12px] font-bold hover:bg-emerald-700 flex items-center gap-1.5"><Play size={13} /> {svcMsg === 'starting' ? 'Starting…' : 'Start service'}</button>}
                </div>
                <p className="text-[14px] font-bold text-slate-800">{rca.root_cause}</p>
                <p className="text-[12.5px] text-slate-600 mt-1"><Wrench size={12} className="inline mr-1 text-slate-400" />{rca.recommended_fix}</p>
                {(rca.recovery_commands || []).length > 0 && <div className="mt-2 rounded-lg bg-slate-900 p-2.5 space-y-1">{rca.recovery_commands.map((c, i) => <code key={i} className="block text-[11.5px] font-mono text-emerald-300 break-all">$ {c}</code>)}</div>}
                {svcMsg === 'ok' && <p className="mt-2 text-[12px] text-emerald-600 font-bold">✓ Service started — re-checking…</p>}
              </div>
            )}
          </div>

          {/* footer nav */}
          <div className="border-t border-slate-100 px-5 py-3 flex items-center justify-between gap-2 flex-wrap sticky bottom-0 bg-white rounded-b-xl">
            <button onClick={prev} disabled={cur === 0} className="flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-200 text-slate-600 text-[13px] font-bold hover:bg-slate-50 disabled:opacity-40"><ArrowLeft size={14} /> Previous</button>
            <span className="text-[12px] text-slate-400 font-semibold">Step {cur + 1} of {steps.length}</span>
            <div className="flex items-center gap-2">
              <button onClick={skip} className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-200 text-slate-600 text-[13px] font-bold hover:bg-slate-50"><SkipForward size={14} /> Skip Step</button>
              {cur < steps.length - 1
                ? <button onClick={next} className="flex items-center gap-2 px-5 py-2 rounded-lg bg-indigo-600 text-white text-[13px] font-bold hover:bg-indigo-700">Next <ArrowRight size={14} /></button>
                : <button onClick={finish} className="flex items-center gap-2 px-5 py-2 rounded-lg bg-emerald-600 text-white text-[13px] font-bold hover:bg-emerald-700"><ShieldAlert size={14} /> Generate RCA</button>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
