import React from 'react';
import { Server, Database, User, Globe, CheckCircle2 } from 'lucide-react';
import { TechLogo } from '../logos';

const Row = ({ icon: Icon, label, value }) => (
  <div className="flex items-center gap-3 py-3 border-b border-slate-100 last:border-0">
    <Icon size={17} className="text-slate-400 flex-shrink-0" />
    <span className="text-[15px] text-slate-500 w-40 flex-shrink-0">{label}</span>
    <span className="text-[15px] font-bold text-slate-800 truncate">{value || <span className="text-slate-300 font-normal">—</span>}</span>
  </div>
);

// Step 4 — review everything before observing the database.
export default function StepSummary({ data, tech }) {
  const c = data.credentials;
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-[19px] font-black text-slate-800">Summary</h3>
        <p className="text-[15px] text-slate-500 mt-1">Review your configuration. Click <span className="font-bold text-slate-700">Observe Database</span> to begin monitoring.</p>
      </div>

      <div className="rounded-xl border border-slate-200 p-4">
        <div className="flex items-center gap-3 pb-3 mb-1 border-b border-slate-100">
          <TechLogo id={tech.id} size={44} />
          <div>
            <p className="text-[16px] font-black text-slate-800">{tech.name}</p>
            <p className="text-[13px] text-slate-500">{c.connection_name || `My ${tech.name}`}</p>
          </div>
        </div>
        <Row icon={Server} label="Agent" value={data.agentMode === 'new' ? 'New agent (deploy)' : data.agentId} />
        <Row icon={Globe} label="Host : Port" value={`${c.host}:${c.port}`} />
        <Row icon={User} label="Username" value={c.username} />
        <Row icon={Database} label={tech.id === 'oracle' ? 'Service / SID' : 'Database'} value={c.database_name} />
        <Row icon={CheckCircle2} label="Environment" value={c.environment} />
      </div>
    </div>
  );
}
