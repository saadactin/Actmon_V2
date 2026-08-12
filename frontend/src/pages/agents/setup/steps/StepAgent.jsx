import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Server, Loader2, ChevronRight } from 'lucide-react';
import { listAgents } from '@/api/agents';

function Toggle({ on, onChange }) {
  return (
    <button type="button" onClick={() => onChange(!on)}
      className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${on ? 'bg-blue-600' : 'bg-slate-300'}`}>
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : ''}`} />
    </button>
  );
}

// Step 1 — pick an existing agent/collector or choose to deploy a new one.
export default function StepAgent({ data, setData }) {
  const navigate = useNavigate();
  const { data: agents = [], isLoading, refetch, isFetching } = useQuery({ queryKey: ['agents'], queryFn: listAgents });
  const [k8sOnly, setK8sOnly] = useState(false);
  // Only host agents carry a token and can host a DB plugin — hide token-less rows
  // (those are DB connections, not agents, and can't be attached to).
  const selectable = (agents || []).filter((a) => a.agent_token);

  return (
    <div className="space-y-8 max-w-3xl">
      {/* Existing agents */}
      <div>
        <h3 className="text-[19px] font-black text-slate-800">Select an existing Agent</h3>
        <p className="text-[15px] text-slate-500 mt-1">Select an existing Agent from the list to deploy the plugin.</p>

        <div className="flex items-center gap-3 mt-4">
          <Toggle on={k8sOnly} onChange={setK8sOnly} />
          <span className="text-[15px] text-slate-700">List only Agents running inside a Kubernetes cluster.</span>
        </div>

        <div className="mt-5">
          {isLoading ? (
            <div className="py-8 text-center text-[15px] text-slate-400"><Loader2 size={18} className="animate-spin inline mr-2" />Loading agents…</div>
          ) : selectable.length === 0 ? (
            <p className="text-center text-[15px] font-black text-slate-700 py-3">There are no Agents suitable for adding the plugin. Deploy one below.</p>
          ) : (
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <table className="w-full text-[15px]">
                <thead className="bg-slate-50 text-[13px] uppercase text-slate-400 font-black">
                  <tr><th className="px-4 py-3 text-left w-10"></th><th className="px-4 py-3 text-left">Agent</th><th className="px-4 py-3 text-left">Engine</th><th className="px-4 py-3 text-left">Status</th></tr>
                </thead>
                <tbody>
                  {selectable.map((a) => (
                    <tr key={a.name} onClick={() => setData({ agentMode: 'existing', agentId: a.name, agentToken: a.agent_token })}
                      className={`border-t border-slate-100 cursor-pointer ${data.agentMode === 'existing' && data.agentId === a.name ? 'bg-blue-50' : 'hover:bg-slate-50'}`}>
                      <td className="px-4 py-3"><input type="radio" readOnly checked={data.agentMode === 'existing' && data.agentId === a.name} /></td>
                      <td className="px-4 py-3 font-bold text-slate-800">{a.name}</td>
                      <td className="px-4 py-3 text-slate-500">{a.db_type}</td>
                      <td className="px-4 py-3"><span className={`text-[12px] font-bold px-2 py-0.5 rounded-full ${a.status === 'online' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{a.status || 'unknown'}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <button onClick={() => refetch()}
          className="mt-4 h-9 px-4 rounded-lg border border-slate-300 text-slate-700 text-[13px] font-black uppercase tracking-wide hover:bg-slate-50 flex items-center gap-1.5">
          {isFetching && <Loader2 size={13} className="animate-spin" />} Refresh Agents List
        </button>
      </div>

      <div className="border-t border-slate-100" />

      {/* Deploy new */}
      <div>
        <h3 className="text-[19px] font-black text-slate-800">Deploy a new Agent</h3>
        <p className="text-[15px] text-slate-500 mt-1">If your Agent isn't on the list, deploy a new one.</p>

        <button onClick={() => navigate('/agents/deploy')}
          className="mt-4 w-full text-left rounded-lg border border-slate-200 bg-slate-50/70 hover:border-slate-300 p-5 flex items-center gap-4 transition-all">
          <div className="w-12 h-12 rounded-lg bg-sky-100 text-sky-600 flex items-center justify-center flex-shrink-0"><Server size={24} /></div>
          <div className="flex-1">
            <p className="text-[16px] font-black text-slate-800">Deploy a new Agent</p>
            <p className="text-[15px] text-slate-500 mt-1 leading-relaxed">Observe the performance, stability and health of the desired entity using an ActMon Agent and the corresponding plugin.</p>
          </div>
          <ChevronRight size={18} className="text-slate-300 flex-shrink-0" />
        </button>
      </div>
    </div>
  );
}
