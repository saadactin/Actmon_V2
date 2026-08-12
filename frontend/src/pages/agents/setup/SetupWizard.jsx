import React, { useState } from 'react';
import { useNavigate, useParams, useLocation, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Copy, Check, ChevronRight } from 'lucide-react';
import Stepper from './components/Stepper';
import WizardShell, { WizardFooter } from './components/WizardShell';
import StepAgent from './steps/StepAgent';
import StepCredentials from './steps/StepCredentials';
import StepPrepare from './steps/StepPrepare';
import StepSummary from './steps/StepSummary';
import { techById } from './techConfig';
import { TechLogo } from './logos';
import { createInstallToken, saveAgentDbConfig } from '@/api/agents';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { useConfirmExit, useWizardDraft, useWizardStep } from '@/hooks/useWizard';

const STEPS = ['Agent', 'Credentials', 'Prepare', 'Summary'];
const uuid = () => (typeof window !== 'undefined' && window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-x`);
const makeToken = () => `actmon-${uuid().replace(/-/g, '')}`;

export default function SetupWizard() {
  const { tech: techId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const tech = techById(techId);
  // Keep the sidebar on Databases when this wizard is reached from the Databases menu.
  const inDb = location.pathname.startsWith('/databases');
  const catalogTo = inDb ? '/databases/add-data' : '/agents/setup';
  const doneTo = inDb ? '/databases' : '/agents';

  // Deep link (?agent=<name>&token=<agent_token>) — e.g. "Monitor database
  // performance" on the deploy-wizard Summary. The agent is pre-selected and the
  // wizard opens on Credentials with the Agent step already completed.
  const [searchParams] = useSearchParams();
  const preAgent = searchParams.get('agent') || '';
  const preToken = searchParams.get('token') || '';

  /* The step lives in the URL and the entries in session storage, so reloading
     the page returns to the same step with the same form instead of dropping the
     operator back at step 1. Secrets are not persisted — see useWizardDraft. */
  const [step, setStep] = useWizardStep({
    initial: preAgent ? 1 : 0,
    min: 0,
    max: STEPS.length - 1,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [installInfo, setInstallInfo] = useState(null);   // { token } after finish
  const [token] = useState(makeToken);
  const [data, setData, clearDraft] = useWizardDraft(`setup:${techId}`, {
    agentMode: 'existing',
    agentId: preAgent,
    agentToken: preToken || undefined,
    credentials: {
      connection_name: '', environment: 'Production', host: 'localhost',
      port: tech?.port || 3306, username: 'actmon_user', password: '', database_name: '',
    },
  });

  /* Browser Back would otherwise discard the whole setup without asking. It is
     armed until the wizard finishes — once the agent is configured there is
     nothing left to lose. */
  const exit = useConfirmExit(!installInfo);
  /* Cancel, the close button and a Previous that would leave the wizard all ask
     first — they discard the setup exactly as the browser's Back does, so they
     get the same question rather than acting silently. `ask` returns false once
     there is nothing left to lose, and then this navigates straight away. */
  const leave = (to) => {
    if (exit.ask(to)) return;
    exit.release(); clearDraft(); navigate(to);
  };
  /* Deliberate exit with nothing to discard (finished install). */
  const leaveNow = (to) => { exit.release(); clearDraft(); navigate(to); };

  if (!tech) {
    return (
      <div className="p-10 text-center">
        <p className="font-black text-slate-700">Unknown database engine.</p>
        <button onClick={() => navigate(catalogTo)} className="mt-3 text-blue-600 font-bold">← Back to engines</button>
      </div>
    );
  }

  const patch = (p) => setData((d) => ({ ...d, ...p }));
  const c = data.credentials;

  const canNext = () => {
    if (step === 0) return data.agentMode === 'new' || !!data.agentId;
    if (step === 1) return c.username && c.password;   // host/port auto-default to localhost + engine port
    return true;
  };

  // Hand the DB credentials to the agent (by token). The agent connects to the DB
  // locally and pushes its internals — no backend connection needed.
  const finish = async () => {
    setSubmitting(true); setError('');
    try {
      const name = c.connection_name || `My ${tech.name}`;
      // Existing agent → attach the DB to ITS token (it's already running). New agent → new token + install.
      const useExisting = data.agentMode === 'existing' && data.agentToken;
      const useToken = useExisting ? data.agentToken : token;
      if (!useExisting) {
        await createInstallToken({ token: useToken, token_name: name, os_type: 'windows' });
      }
      const saved = await saveAgentDbConfig({
        token: useToken, db_type: tech.name, connection_name: name,
        host: c.host || 'localhost', port: Number(c.port) || tech.port,
        username: c.username, password: c.password,
        database_name: c.database_name, environment: c.environment,
      });
      qc.invalidateQueries({ queryKey: ['agents'] });
      qc.invalidateQueries({ queryKey: ['osServers'] });
      // Only new agents need an install command; an existing agent is already
      // running, so its dashboard is real the moment this connection exists —
      // no "wait for it to appear" detour through Agents/Databases needed.
      setInstallInfo({ token: useToken, existing: useExisting, connectionId: saved?.connection_id });
    } catch (e) {
      setError(e?.response?.data?.detail || e.message || 'Failed to configure the agent.');
    } finally { setSubmitting(false); }
  };

  const agentCommand = () => {
    const base = `${window.location.origin}/api/v1`;
    const setup = `${base}/agents/install/actmon-setup.ps1?token=${token}&url=${encodeURIComponent(base)}`;
    return `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command',"iex ((New-Object Net.WebClient).DownloadString('${setup}'))"`;
  };

  return (
    <WizardShell
      title={`Add ${tech.name} Database`}
      onClose={() => leave(doneTo)}
      aside={(
        <>
          <div className="flex justify-center"><TechLogo id={tech.id} size={130} /></div>
          <h2 className="mt-8 text-[26px] font-bold leading-tight text-fg">{tech.name}</h2>
          <p className="mt-3 leading-relaxed text-muted">{tech.desc}</p>
        </>
      )}
    >
      {/* Raised when the browser's Back button is pressed mid-setup. */}
      <ConfirmDialog
        open={exit.pending}
        title="Leave setup?"
        message={`You are on step ${step + 1} of ${STEPS.length}. Leaving now discards this setup — the agent will not be configured.`}
        confirmLabel="Yes, leave"
        cancelLabel="No, stay here"
        onConfirm={() => { exit.confirm(); clearDraft(); navigate(exit.pendingTo ?? catalogTo); }}
        onCancel={exit.cancel}
      />
          {installInfo ? (
            <InstallPanel
              tech={tech}
              existing={installInfo.existing}
              command={agentCommand()}
              onDone={() => leaveNow(
                installInfo.existing && installInfo.connectionId
                  ? `/${tech.dashboardRoute}/${installInfo.connectionId}`
                  : doneTo,
              )}
            />
          ) : (
            <>
              <div className="px-8 pt-8"><Stepper steps={STEPS} current={step} /></div>
              <div className="flex-1 overflow-y-auto px-8 py-7 border-t border-slate-100 mt-6">
                {step === 0 && <StepAgent data={data} setData={patch} />}
                {step === 1 && <StepCredentials data={data} setData={patch} tech={tech} />}
                {step === 2 && <StepPrepare data={data} tech={tech} />}
                {step === 3 && <StepSummary data={data} tech={tech} />}
                {error && <p className="mt-4 text-sm font-bold text-red-600">{error}</p>}
              </div>
              {/* Back is on every step: on the first it leaves the wizard, and
                  leaving always asks first (see useConfirmExit). */}
              <WizardFooter
                onBack={() => (step > 0 ? setStep(step - 1) : leave(catalogTo))}
                onCancel={() => leave(catalogTo)}
                onNext={step < STEPS.length - 1 ? () => canNext() && setStep(step + 1) : undefined}
                nextDisabled={step < STEPS.length - 1 ? !canNext() : submitting}
                onFinish={step === STEPS.length - 1 ? finish : undefined}
                finishLabel="Observe Database"
                finishIcon="eye"
                finishing={submitting}
              />
            </>
          )}
    </WizardShell>
  );
}

function InstallPanel({ tech, existing, command, onDone }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard?.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 1600); };
  return (
    <div className="flex-1 overflow-y-auto px-8 py-8 border-t border-slate-100 mt-6">
      <div className="flex items-center gap-2.5 mb-1">
        <Check size={18} className="text-emerald-600" />
        <h3 className="text-[17px] font-black text-slate-800">
          {existing ? `${tech.name} attached to the agent` : 'Credentials saved to the agent'}
        </h3>
      </div>
      {existing ? (
        <p className="text-sm text-slate-600 mb-5">
          The selected agent will start collecting {tech.name} within a minute. It appears in Agents and Databases
          with live metrics — no reinstall needed.
        </p>
      ) : (
        <>
          <p className="text-sm text-slate-600 mb-5">
            Run this on the host where {tech.name} is installed (Administrator). The agent connects to {tech.name}
            locally and pushes its metrics — no direct connection from ActMon needed.
          </p>
          <div className="relative rounded-lg border border-slate-200 bg-slate-50 max-w-4xl">
            <button onClick={copy} className="absolute top-2.5 right-2.5 text-slate-500 hover:text-blue-600" title="Copy">
              {copied ? <Check size={17} className="text-emerald-600" /> : <Copy size={17} />}
            </button>
            <pre className="p-4 pr-12 text-[12.5px] leading-relaxed font-mono text-slate-800 whitespace-pre-wrap break-all">{command}</pre>
          </div>
          <div className="mt-4 flex items-center gap-2.5 text-sm text-slate-500">
            <Loader2 size={15} className="animate-spin text-blue-500" />
            Once the agent runs, this database appears in Agents and Databases with live metrics.
          </div>
        </>
      )}
      <button onClick={onDone}
        className="mt-6 h-10 px-6 rounded-lg bg-blue-700 text-white text-sm font-bold hover:bg-blue-800 flex items-center gap-2">
        {existing ? `Open ${tech.name} Dashboard` : 'Go to Agents'} <ChevronRight size={15} />
      </button>
    </div>
  );
}
