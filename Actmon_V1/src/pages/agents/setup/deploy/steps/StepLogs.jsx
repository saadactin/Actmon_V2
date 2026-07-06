import React from 'react';
import { Info, ChevronDown } from 'lucide-react';

const POLL_INTERVALS = ['200ms', '400ms', '600ms', '800ms', '1s'];
const START_AT = ['Beginning', 'End'];

function Toggle({ on, onChange }) {
  return (
    <button type="button" onClick={() => onChange(!on)}
      className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${on ? 'bg-emerald-500' : 'bg-slate-300'}`}>
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : ''}`} />
    </button>
  );
}

const Label = ({ text, required }) => (
  <span className="flex items-center gap-1.5 text-[15px] font-black text-slate-800">
    {text} <Info size={14} className="text-slate-400" />{required && <span className="text-red-500">*</span>}
  </span>
);

// Step (manual flow) — optional host log monitoring configuration.
export default function StepLogs({ data, setData }) {
  const enabled = !!data.logsEnabled;
  // Sensible default log path for the OS chosen on the Configuration step.
  const defaultLocation = data.os === 'windows' ? 'C:\\ProgramData\\log\\*.log' : '/var/log/*.log';
  const location = data.logsLocation ?? defaultLocation;

  return (
    <div className="max-w-4xl">
      {/* Info banner */}
      <div className="rounded-lg bg-sky-50 border border-sky-200 p-4 flex items-start gap-3">
        <Info size={18} className="text-sky-600 flex-shrink-0 mt-0.5" />
        <p className="text-[15px] text-slate-600 leading-relaxed">
          To collect logs, enable log monitoring and fill in the details. You can add logs monitoring
          for the host later on, using the Add Logs flow.
        </p>
      </div>

      {/* Enable toggle */}
      <div className="flex items-center gap-3 mt-6">
        <Toggle on={enabled} onChange={(v) => setData({ logsEnabled: v })} />
        <span className="text-[15px] text-slate-700">Enable log monitoring</span>
      </div>

      {enabled && (
        <div className="mt-6 space-y-6 max-w-3xl">
          {/* Display Name */}
          <div>
            <Label text="Display Name" />
            <input value={data.logsDisplayName || ''} onChange={(e) => setData({ logsDisplayName: e.target.value })}
              className="mt-2 w-full h-11 px-3.5 rounded-lg border border-slate-300 text-[15px] outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-50" />
            <p className="text-[13px] text-slate-500 mt-1.5">The default Display Name is the plugin instance name.</p>
          </div>

          {/* Logs Location */}
          <div>
            <Label text="Logs Location" required />
            <input value={location} onChange={(e) => setData({ logsLocation: e.target.value })} spellCheck={false}
              className="mt-2 w-full h-11 px-3.5 rounded-lg border border-slate-300 text-[15px] font-mono outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-50" />
            <p className="text-[13px] text-slate-500 mt-1.5">Glob pattern of the log files to tail (e.g. <span className="font-mono">{defaultLocation}</span>).</p>
          </div>

          {/* Poll Interval */}
          <div>
            <Label text="Poll Interval" />
            <div className="relative mt-2">
              <select value={data.logsPoll || '200ms'} onChange={(e) => setData({ logsPoll: e.target.value })}
                className="w-full h-11 px-3.5 rounded-lg border border-slate-300 text-[15px] bg-white appearance-none outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-50">
                {POLL_INTERVALS.map((p) => <option key={p}>{p}</option>)}
              </select>
              <ChevronDown size={18} className="text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
          </div>

          {/* Start at */}
          <div>
            <Label text="Start at" />
            <div className="relative mt-2">
              <select value={data.logsStart || 'End'} onChange={(e) => setData({ logsStart: e.target.value })}
                className="w-full h-11 px-3.5 rounded-lg border border-slate-300 text-[15px] bg-white appearance-none outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-50">
                {START_AT.map((s) => <option key={s}>{s}</option>)}
              </select>
              <ChevronDown size={18} className="text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
