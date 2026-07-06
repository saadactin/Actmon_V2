import React, { useState } from 'react';
import { useNavigate, useParams, useLocation, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Eye, X, Zap, Copy, Check, ChevronRight } from 'lucide-react';
import Stepper from './components/Stepper';
import StepAgent from './steps/StepAgent';
import StepCredentials from './steps/StepCredentials';
import StepPrepare from './steps/StepPrepare';
import StepSummary from './steps/StepSummary';
import { techById } from './techConfig';
import { TechLogo } from './logos';
import { createInstallToken, saveAgentDbConfig } from '../../../api/agents';

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

  const [step, setStep] = useState(preAgent ? 1 : 0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [installInfo, setInstallInfo] = useState(null);   // { token } after finish
  const [token] = useState(makeToken);
  const [data, setData] = useState({
    agentMode: 'existing',
    agentId: preAgent,
    agentToken: preToken || undefined,
    credentials: {
      connection_name: '', environment: 'Production', host: 'localhost',
      port: tech?.port || 3306, username: 'actmon_user', password: '', database_name: '',
    },
  });

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
    if (step === 1) return c.host && c.port && c.username;
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
      await saveAgentDbConfig({
        token: useToken, db_type: tech.name, connection_name: name,
        host: c.host || 'localhost', port: Number(c.port) || tech.port,
        username: c.username, password: c.password,
        database_name: c.database_name, environment: c.environment,
      });
      qc.invalidateQueries({ queryKey: ['agents'] });
      // Only new agents need an install command; existing agents pick up the DB on the next cycle.
      setInstallInfo({ token: useToken, existing: useExisting });
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
    <div className="-mx-6 md:-mx-8 -mb-6 md:-mb-8 min-h-full bg-white flex flex-col pb-16">
      {/* Header bar */}
      <div className="flex items-center justify-between px-6 py-3.5 border-b border-slate-200 flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-md bg-gradient-to-br from-blue-500 to-sky-400 flex items-center justify-center"><Zap size={16} className="text-white" /></div>
          <span className="text-lg font-black text-slate-800">Add {tech.name} Database</span>
        </div>
        <button onClick={() => navigate(doneTo)} className="text-slate-400 hover:text-slate-700"><X size={20} /></button>
      </div>

      {/* Body: left branding panel + right content */}
      <div className="flex flex-1 min-h-0">
        {/* Left panel */}
        <aside className="hidden lg:flex flex-col w-[340px] flex-shrink-0 border-r border-slate-100 px-8 py-10">
          <div className="flex justify-center"><TechLogo id={tech.id} size={130} /></div>
          <h2 className="text-[26px] leading-tight font-black text-slate-800 mt-8">{tech.name}</h2>
          <p className="text-slate-500 mt-3 leading-relaxed">{tech.desc}</p>
        </aside>

        {/* Right content */}
        <section className="flex-1 min-w-0 flex flex-col">
          {installInfo ? (
            <InstallPanel tech={tech} existing={installInfo.existing} command={agentCommand()} onDone={() => navigate(doneTo)} />
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
              <div className="flex items-center justify-end gap-2 pl-8 pr-28 py-4 border-t border-slate-200 flex-shrink-0">
                {step > 0 && (
                  <button onClick={() => setStep(step - 1)}
                    className="h-9 px-4 rounded-lg text-slate-600 text-sm font-bold hover:bg-slate-100">Back</button>
                )}
                <button onClick={() => navigate(catalogTo)}
                  className="h-9 px-4 rounded-lg text-slate-600 text-sm font-bold hover:bg-slate-100">Cancel</button>
                {step < STEPS.length - 1 ? (
                  <button onClick={() => canNext() && setStep(step + 1)} disabled={!canNext()}
                    className="h-9 px-6 rounded-lg bg-blue-700 text-white text-sm font-bold hover:bg-blue-800 disabled:opacity-40">Next</button>
                ) : (
                  <button onClick={finish} disabled={submitting}
                    className="h-9 px-5 rounded-lg bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-2">
                    {submitting ? <Loader2 size={15} className="animate-spin" /> : <Eye size={15} />} Observe Database
                  </button>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
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
        Go to Agents <ChevronRight size={15} />
      </button>
    </div>
  );
}
