import React, { useState } from 'react';
import { Copy, Check, ShieldCheck, Info } from 'lucide-react';
import { prepareSql } from '../techConfig';

function SqlBlock({ title, sql }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard?.writeText(sql); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  return (
    <div className="rounded-xl border border-slate-200 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 bg-slate-50 border-b border-slate-200">
        <span className="text-[13px] font-black text-slate-600 uppercase tracking-wide">{title}</span>
        <button onClick={copy} className="text-[13px] font-bold flex items-center gap-1 text-blue-600 hover:text-blue-800">
          {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
        </button>
      </div>
      <pre className="p-4 text-[14px] leading-relaxed font-mono text-slate-800 bg-white overflow-x-auto whitespace-pre">{sql}</pre>
    </div>
  );
}

// Step 3 — engine-specific script to create a read-only monitoring user + grants.
export default function StepPrepare({ data, tech }) {
  const c = data.credentials;
  const { createUser, grant } = prepareSql(tech.id, { username: c.username, password: c.password || '<password>', database: c.database_name });

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-[19px] font-black text-slate-800">Prepare your database</h3>
        <p className="text-[15px] text-slate-500 mt-1">Run the following as a privileged user to create the monitoring account the agent will use.</p>
      </div>

      <div className="flex items-start gap-2.5 rounded-xl bg-emerald-50 border border-emerald-200 p-3.5">
        <ShieldCheck size={18} className="text-emerald-600 flex-shrink-0 mt-0.5" />
        <p className="text-[15px] text-emerald-800"><span className="font-black">Least privilege.</span> These grants are read-only monitoring permissions. ActMon never issues writes against your database.</p>
      </div>

      <SqlBlock title="1 · Create monitoring user" sql={createUser} />
      <SqlBlock title="2 · Grant monitoring privileges" sql={grant} />

      <div className="flex items-start gap-2 text-[15px] text-slate-500">
        <Info size={15} className="flex-shrink-0 mt-0.5" />
        <span>Once the user exists, use the credentials from the previous step. You can verify by running <span className="font-mono text-slate-700">Test connection</span> again before finishing.</span>
      </div>
    </div>
  );
}
