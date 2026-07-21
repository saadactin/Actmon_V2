import React from 'react';
import { DEPLOY_GROUPS } from '../deployConfig';
import { DeployIcon } from '../deployIcons';

// Step 1 — choose how the ActMon Agent is deployed.
export default function StepDeployment({ data, setData }) {
  const selected = data.method;
  return (
    <div className="max-w-3xl">
      <p className="text-[15px] text-slate-600 mb-6">Deploy the ActMon Agent to add an integration e.g. MySQL, Kafka. Select a method for deploying the Agent:</p>

      {DEPLOY_GROUPS.map((group) => (
        <div key={group.title} className="mb-7">
          <h4 className="text-[16px] font-black text-slate-800 mb-3">{group.title}</h4>
          <div className="space-y-4">
            {group.methods.map((m) => {
              const active = selected === m.id;
              return (
                <label key={m.id} className="flex items-start gap-3 cursor-pointer">
                  <input type="radio" name="deploy-method" checked={active} onChange={() => setData({ method: m.id })}
                    className="mt-1 w-4 h-4 accent-blue-600 flex-shrink-0" />
                  <span className="flex-shrink-0 mt-0.5"><DeployIcon id={m.id} /></span>
                  <div>
                    <p className="text-[16px] font-bold text-slate-800 leading-none">{m.name}</p>
                    <p className="text-[15px] text-slate-500 mt-1.5 leading-relaxed">
                      {m.recommended && <span className="font-bold text-slate-600">[Recommended] </span>}{m.desc}
                    </p>
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
