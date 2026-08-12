import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { useConfirmExit, useWizardDraft, useWizardStep } from '@/hooks/useWizard';
import { X, Zap } from 'lucide-react';
import Stepper from '../components/Stepper';
import { stepsForMethod } from './deployConfig';
import StepDeployment from './steps/StepDeployment';
import StepToken from './steps/StepToken';
import StepConfiguration from './steps/StepConfiguration';
import StepDistribution from './steps/StepDistribution';
import StepInstallation from './steps/StepInstallation';
import StepLogs from './steps/StepLogs';
import StepAlerts, { ALERT_TEMPLATES } from './steps/StepAlerts';
import StepSummary from './steps/StepSummary';
import Placeholder from './steps/Placeholder';
import { createRule } from '@/api/alerts';

// Small helpers for generating an ingestion token + install-session id.
// NOTE: crypto.randomUUID() only exists in a SECURE context (HTTPS/localhost). On a
// plain-HTTP deployment (e.g. http://<ip>:9181) it is undefined, so we must fall back
// to crypto.getRandomValues (available on HTTP too) — never to a literal placeholder,
// which produced tokens ending in "xxxx" that could collide across installs.
const uuid = () => {
  const c = typeof window !== 'undefined' ? window.crypto : undefined;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  // Last resort (no Web Crypto at all): time + pseudo-random hex, still unique enough.
  return `${Date.now().toString(16)}${Math.floor(Math.random() * 1e12).toString(16)}`;
};
const makeToken = () => `actmon-${uuid().replace(/-/g, '')}`;

// Teal stacked-server illustration (ActMon "Agent" style).
function ServerArt() {
  const Unit = ({ y, light }) => (
    <g>
      <rect x="30" y={y} width="160" height="56" rx="10" fill={light ? '#BEE3E8' : '#2FB6C4'} />
      <circle cx="120" cy={y + 28} r="9" fill="#fff" />
      <circle cx="150" cy={y + 28} r="9" fill="#fff" />
    </g>
  );
  return (
    <svg viewBox="0 0 220 210" className="w-full max-w-[210px]" fill="none" xmlns="http://www.w3.org/2000/svg">
      <Unit y={6} />
      <Unit y={72} light />
      <Unit y={138} />
    </svg>
  );
}

export default function DeployAgentWizard() {
  const navigate = useNavigate();
  /* Step in the URL so a reload returns here rather than to step 1. */
  /* stepsForMethod() decides the flow from the method and OS, so the count is not
     known here; the page clamps with `cur = Math.min(step, last)` a few lines down,
     which is what keeps a shortened flow in range. */
  const [step, setStep] = useWizardStep({ initial: 0, min: 0, max: 32 });
  const [installed, setInstalled] = useState(false);
  /* Browser Back would discard the whole deployment; ask first, until it is done. */
  const exit = useConfirmExit(!installed);
  /* Cancel, close and a Previous that would leave all ask first — clicking
     Previous on the first step used to drop straight out to /agents. */
  const leave = (to) => {
    if (exit.ask(to)) return;
    exit.release(); navigate(to);
  };
  /* The ingestion token and session id are the one thing a reload must NOT
     regenerate — an install command already downloaded (or a target host
     already running with the old one baked in) would silently stop matching
     what the wizard shows. useWizardDraft's redaction would strip a field
     named `token` from what it persists anyway (see useWizard.js's
     SECRET_WORDS), so, same as SetupWizard.jsx, these live in their own plain
     state, generated once per mount, and everything else — method, os, arch,
     tokenName, distro, tags, … — goes through the draft below. */
  const [token] = useState(makeToken);
  const [sessionId] = useState(uuid);
  const [draft, setDraft] = useWizardDraft('deploy-agent', {
    method: 'script', tokenMode: 'new', tokenName: '', os: 'linux', arch: 'amd64',
    enableHostMonitoring: true, setupHostname: false, tags: [],
  });
  const data = { ...draft, token, sessionId };

  const patch = (p) => setDraft((d) => ({ ...d, ...p }));
  // Step list depends on the chosen deployment method AND target OS
  // (Linux manual installs get a Distribution picker before Installation).
  const steps = stepsForMethod(data.method, data.os);
  const last = steps.length - 1;
  const cur = Math.min(step, last);          // clamp if method change shortened the flow
  const name = steps[cur];
  const canNext = () => {
    if (name === 'Deployment') return !!data.method;
    if (name === 'Ingestion Token') return data.tokenMode === 'existing' ? !!data.existingToken : !!(data.tokenName || '').trim();
    if (name === 'Distribution') return !!data.distro;   // must pick a distro / package manager
    if (name === 'Installation') return installed;       // must actually install before continuing
    if (name === 'Logs') return !data.logsEnabled || !!(data.logsLocation ?? 'default').trim();
    return true;
  };

  // Finish — create the alert rules picked on the Suggested Alerts step
  // (scoped to this agent), then leave the wizard.
  const [finishing, setFinishing] = useState(false);
  const finish = async () => {
    const picked = ALERT_TEMPLATES.filter((t) => (data.alerts || []).includes(t.id));
    setFinishing(true);
    try {
      for (const t of picked) {
        // eslint-disable-next-line no-await-in-loop
        await createRule({
          name: t.name, description: t.desc, severity: t.severity, enabled: true,
          scope_type: data.tokenName ? 'agent' : 'all', scope_value: data.tokenName || null,
          ...t.rule,
        }).catch(() => {}); // duplicate/failed template must not block finishing
      }
    } finally {
      setFinishing(false);
      navigate('/agents');
    }
  };

  return (
    <div className="-mx-6 md:-mx-8 -mb-6 md:-mb-8 min-h-full bg-white flex flex-col pb-16">
      {/* Raised when the browser's Back button is pressed mid-deployment. */}
      <ConfirmDialog
        open={exit.pending}
        title="Leave agent deployment?"
        message={`You are on step ${cur + 1} of ${steps.length} (${name}). Leaving now discards this deployment — the agent will not be installed.`}
        confirmLabel="Yes, leave"
        cancelLabel="No, stay here"
        onConfirm={() => { exit.confirm(); navigate(exit.pendingTo ?? '/agents'); }}
        onCancel={exit.cancel}
      />
      {/* Header bar */}
      <div className="flex items-center justify-between px-6 py-3.5 border-b border-slate-200 flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-md bg-gradient-to-br from-blue-500 to-sky-400 flex items-center justify-center"><Zap size={16} className="text-white" /></div>
          <span className="text-lg font-black text-slate-800">Add Agent</span>
        </div>
        <button onClick={() => leave('/agents')} className="text-slate-400 hover:text-slate-700"><X size={20} /></button>
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        {/* Left branding panel */}
        <aside className="hidden lg:flex flex-col w-[340px] flex-shrink-0 border-r border-slate-100 px-8 py-10">
          <div className="flex justify-center pt-4"><ServerArt /></div>
          <h2 className="text-[26px] leading-tight font-black text-slate-800 mt-10">Agent</h2>
          <p className="text-slate-500 mt-3 leading-relaxed">Observe the performance, stability and health of the desired entity using an ActMon Agent and the corresponding integration.</p>
        </aside>

        {/* Right content */}
        <section className="flex-1 min-w-0 flex flex-col">
          <div className="px-8 pt-8"><Stepper steps={steps} current={cur} /></div>
          <div className="flex-1 overflow-y-auto px-8 py-7 border-t border-slate-100 mt-6">
            {name === 'Deployment' && <StepDeployment data={data} setData={patch} />}
            {name === 'Ingestion Token' && <StepToken data={data} setData={patch} />}
            {name === 'Configuration' && <StepConfiguration data={data} setData={patch} />}
            {name === 'Distribution' && <StepDistribution data={data} setData={patch} />}
            {name === 'Installation' && <StepInstallation data={data} onInstalled={setInstalled} />}
            {name === 'Logs' && <StepLogs data={data} setData={patch} />}
            {name === 'Suggested Alerts' && <StepAlerts data={data} setData={patch} />}
            {name === 'Summary' && <StepSummary data={data} goToStep={(s) => { const i = steps.indexOf(s); if (i >= 0) setStep(i); }} />}
            {!['Deployment', 'Ingestion Token', 'Configuration', 'Distribution', 'Installation', 'Logs', 'Suggested Alerts', 'Summary'].includes(name) && <Placeholder title={name} />}
          </div>
          <div className="flex items-center justify-between pl-8 pr-28 py-4 border-t border-slate-200 flex-shrink-0">
            <a href="#" onClick={(e) => e.preventDefault()} className="text-sm font-bold text-blue-600 hover:text-blue-800">Help &amp; User Guide</a>
            <div className="flex items-center gap-2">
              <button onClick={() => leave('/agents')} className="h-9 px-4 rounded-lg text-slate-600 text-sm font-bold hover:bg-slate-100">Cancel</button>
              {/* Present on every step: on the first it leaves the wizard, so the
                  control never disappears. */}
              <button
                onClick={() => (cur > 0 ? setStep(cur - 1) : leave('/agents'))}
                className="h-9 px-5 rounded-lg border border-slate-300 text-slate-700 text-sm font-bold hover:bg-slate-50"
              >
                Previous
              </button>
              {cur < last ? (
                <button onClick={() => canNext() && setStep(cur + 1)} disabled={!canNext()}
                  className="h-9 px-6 rounded-lg bg-blue-700 text-white text-sm font-bold hover:bg-blue-800 disabled:opacity-40">Next</button>
              ) : (
                <button onClick={finish} disabled={finishing}
                  className="h-9 px-6 rounded-lg bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 disabled:opacity-50">
                  {finishing ? 'Creating alerts…' : name === 'Summary' ? 'Close' : 'Finish'}
                </button>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
