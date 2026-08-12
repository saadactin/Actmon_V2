import React from 'react';
import { Info } from 'lucide-react';

const RadioOpt = ({ active, onClick, title, desc }) => (
  <button type="button" onClick={onClick} className="flex items-start gap-3 text-left">
    <span className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${active ? 'border-blue-600' : 'border-slate-300'}`}>
      {active && <span className="w-2 h-2 rounded-full bg-blue-600" />}
    </span>
    <span>
      <span className="block text-[16px] font-bold text-slate-800 leading-none">{title}</span>
      <span className="block text-[15px] text-slate-500 mt-1.5 leading-relaxed">{desc}</span>
    </span>
  </button>
);

// Step 2 — choose or generate an ingestion token.
export default function StepToken({ data, setData }) {
  const mode = data.tokenMode || 'new';
  return (
    <div className="max-w-4xl">
      <p className="text-[15px] text-slate-600">To send data into ActMon Observability, specify an Ingestion token.</p>
      <p className="text-[15px] font-black text-slate-800 mt-1">Would you like to generate a new token, or use an existing one?</p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-5">
        <RadioOpt active={mode === 'new'} onClick={() => setData({ tokenMode: 'new' })}
          title="Generate New Token" desc="Provide a name for the ingestion token that will be created and used in the setup." />
        <RadioOpt active={mode === 'existing'} onClick={() => setData({ tokenMode: 'existing' })}
          title="Use Existing Token" desc="Select a token from the list of ingestion tokens in your organization." />
      </div>

      <div className="mt-7 pb-6 border-b border-slate-100">
        {mode === 'new' ? (
          <label className="block">
            <span className="block text-[15px] font-black text-slate-800 mb-2">Token Name</span>
            <input value={data.tokenName || ''} onChange={(e) => setData({ tokenName: e.target.value })}
              className="w-full h-11 px-3.5 rounded-lg border border-slate-300 text-[15px] outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-50" />
          </label>
        ) : (
          <label className="block">
            <span className="block text-[15px] font-black text-slate-800 mb-2">Ingestion Token</span>
            <select value={data.existingToken || ''} onChange={(e) => setData({ existingToken: e.target.value })}
              className="w-full h-11 px-3.5 rounded-lg border border-slate-300 text-[15px] outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-50 bg-white">
              <option value="">Select a token…</option>
            </select>
          </label>
        )}
      </div>

      {/* Token Tags info box */}
      <div className="mt-6 rounded-lg bg-sky-50 border border-sky-200 p-5 flex gap-3">
        <Info size={18} className="text-sky-600 flex-shrink-0 mt-0.5" />
        <div>
          <p className="font-black text-slate-800 text-[15px]">Token Tags</p>
          <p className="text-[15px] text-slate-600 mt-1.5 leading-relaxed">If a token has token tags defined, the tags will be applied to data associated with the token for all entities using the token.</p>
          <ul className="list-disc pl-5 mt-3 space-y-1 text-[15px] text-slate-600">
            <li>To configure token tags, go to <span className="font-semibold">Settings &gt; API Tokens</span> after you finish this wizard. See <a href="#" onClick={(e) => e.preventDefault()} className="text-blue-600 font-semibold hover:underline">documentation</a>.</li>
            <li>To configure entity-specific tags, add them in a next wizard step.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
