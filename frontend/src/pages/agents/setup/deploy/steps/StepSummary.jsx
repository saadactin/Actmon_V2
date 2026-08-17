import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Loader2, Pencil, Database, Settings } from 'lucide-react';
import { listAgents } from '@/api/agents';
import { QK } from '@/api/queryKeys';

const Row = ({ label, value }) => (
  <div className="grid grid-cols-1 sm:grid-cols-[260px_1fr] gap-1 sm:gap-4 py-2.5">
    <span className="text-[15px] text-slate-500">{label}</span>
    <span className="text-[15px] text-slate-800 break-all">{value || <span className="text-slate-400">—</span>}</span>
  </div>
);

const StatusRow = ({ ok, okText, waitText, links }) => (
  <div className="grid grid-cols-1 sm:grid-cols-[260px_1fr] gap-1 sm:gap-4 py-2.5 sm:items-center">
    <span className="flex items-center gap-2">
      {ok ? <CheckCircle2 size={17} className="text-emerald-600 flex-shrink-0" />
        : <Loader2 size={16} className="text-blue-500 animate-spin flex-shrink-0" />}
      <span className={`text-[15px] font-bold ${ok ? 'text-emerald-700' : 'text-blue-600'}`}>{ok ? okText : waitText}</span>
    </span>
    <span className="flex items-center gap-2 text-[15px]">{links}</span>
  </div>
);

const L = ({ onClick, children }) => (
  <button onClick={onClick} className="text-blue-600 font-semibold hover:underline">{children}</button>
);
const Sep = () => <span className="text-slate-300">|</span>;

// Final step — review the deployed agent, host, and log settings; jump-off actions.
export default function StepSummary({ data, goToStep }) {
  const navigate = useNavigate();

  // Live agent lookup by the ingestion token used in this wizard run.
  const { data: agents = [] } = useQuery({ queryKey: QK.agents, queryFn: listAgents, refetchInterval: 5000 });
  const agent = agents.find((a) => a.agent_token === data.token)
    || agents.find((a) => data.tokenName && (a.name || '').toLowerCase().startsWith(data.tokenName.toLowerCase()));
  const online = agent?.status === 'online';
  const agentName = agent?.name || data.tokenName || '—';

  return (
    <div className="max-w-4xl">
      {/* ── AGENT DETAILS ── */}
      <div className="flex items-center gap-3">
        <h3 className="text-[15px] font-black text-slate-800 uppercase tracking-wide">Agent Details</h3>
        <button onClick={() => goToStep?.('Configuration')}
          className="flex items-center gap-1 text-[13px] font-black text-blue-600 uppercase tracking-wide hover:underline">
          <Pencil size={12} /> Edit
        </button>
      </div>
      <div className="mt-2 divide-y divide-slate-100 border-b border-slate-200 pb-2">
        <Row label="Agent Name" value={agentName} />
        <Row label="Client ID" value={data.sessionId} />
        <StatusRow ok={online} okText="Agent entity is available." waitText="Waiting for the Agent entity…"
          links={<><span className="text-slate-500">View</span> <L onClick={() => navigate('/agents')}>Agent list</L> <Sep />
            <L onClick={() => agent && navigate(`/agents/${encodeURIComponent(agent.name)}`)}>Agent Details</L></>} />
      </div>

      {/* ── HOST DETAILS ── */}
      <h3 className="text-[15px] font-black text-slate-800 uppercase tracking-wide mt-7">Host Details</h3>
      <div className="mt-2 divide-y divide-slate-100 border-b border-slate-200 pb-2">
        <Row label="Host Display Name" value={data.setupHostname && data.hostname ? data.hostname : agentName} />
        <StatusRow ok={online} okText="Metrics are available." waitText="Waiting for host metrics…"
          links={<><span className="text-slate-500">View</span> <L onClick={() => navigate('/infra')}>Host list</L> <Sep />
            <L onClick={() => navigate('/infra')}>Host details</L></>} />
      </div>

      {/* ── LOGS DETAILS ── */}
      {data.logsEnabled && (
        <>
          <h3 className="text-[15px] font-black text-slate-800 uppercase tracking-wide mt-7">Logs Details</h3>
          <div className="mt-2 divide-y divide-slate-100 border-b border-slate-200 pb-2">
            <Row label="Display Name" value={data.logsDisplayName} />
            <Row label="Logs Location" value={data.logsLocation ?? (data.os === 'windows' ? 'C:\\ProgramData\\log\\*.log' : '/var/log/*.log')} />
            <Row label="Poll Interval" value={data.logsPoll || '200ms'} />
            <Row label="Start at" value={data.logsStart || 'End'} />
            <StatusRow ok okText="Log monitoring is enabled" waitText=""
              links={<L onClick={() => navigate('/logs')}>Analyze logs</L>} />
          </div>
        </>
      )}

      {/* ── ADDITIONAL ACTIONS ── */}
      <h3 className="text-[15px] font-black text-slate-800 uppercase tracking-wide mt-7">Additional Actions</h3>
      <div className="mt-3 space-y-4 max-w-2xl">
        <button onClick={() => navigate('/agents/setup?tab=Databases', {
            // Enrollment token passed via router state, not a query string —
            // this is a same-app wizard hand-off, not a link meant to be
            // bookmarked/shared, so it has no reason to sit in the address
            // bar or browser history. AgentSetupPage falls back to the
            // (legacy) query-string param if state is absent, e.g. on a
            // hard refresh of the destination page.
            state: { agent: agent?.name || data.tokenName || '', token: data.token || '' },
          })}
          className="w-full text-left rounded-lg border border-slate-200 bg-slate-50/80 hover:border-blue-300 hover:bg-blue-50/30 p-5 flex items-start gap-4 transition-all">
          <div className="w-11 h-11 rounded-lg bg-orange-100 text-orange-500 flex items-center justify-center flex-shrink-0"><Database size={24} /></div>
          <div>
            <p className="text-[16px] font-black text-slate-800">Monitor database performance</p>
            <p className="text-[15px] text-slate-500 mt-1 leading-relaxed">Monitor database reliability, availability, and performance, including query optimization.</p>
          </div>
        </button>
        <button onClick={() => navigate('/agents/setup?tab=Integrations')}
          className="w-full text-left rounded-lg border border-slate-200 bg-slate-50/80 hover:border-blue-300 hover:bg-blue-50/30 p-5 flex items-start gap-4 transition-all">
          <div className="w-11 h-11 rounded-lg bg-violet-100 text-violet-500 flex items-center justify-center flex-shrink-0"><Settings size={24} /></div>
          <div>
            <p className="text-[16px] font-black text-slate-800">Add integrations</p>
            <p className="text-[15px] text-slate-500 mt-1 leading-relaxed">Extend ActMon Observability through a native open-source (OpenTelemetry) framework as well as third party integrations using our agent.</p>
          </div>
        </button>
      </div>
    </div>
  );
}
