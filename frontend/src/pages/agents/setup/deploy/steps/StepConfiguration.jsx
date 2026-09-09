import React from 'react';
import { Info, Plus, X, Cpu } from 'lucide-react';

function Toggle({ on, onChange }) {
  return (
    <button type="button" onClick={() => onChange(!on)}
      className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${on ? 'bg-emerald-500' : 'bg-slate-300'}`}>
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : ''}`} />
    </button>
  );
}

function LinuxIcon({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <ellipse cx="12" cy="14" rx="6" ry="7.5" fill="#1a1a1a" />
      <ellipse cx="12" cy="15.5" rx="3.4" ry="4.5" fill="#fff" />
      <ellipse cx="10.4" cy="8.4" rx="1.2" ry="1.6" fill="#fff" /><ellipse cx="13.6" cy="8.4" rx="1.2" ry="1.6" fill="#fff" />
      <circle cx="10.6" cy="8.6" r="0.7" fill="#1a1a1a" /><circle cx="13.4" cy="8.6" r="0.7" fill="#1a1a1a" />
      <path d="M10.6 10.4c.6.7 2.2.7 2.8 0-.4.9-2.4.9-2.8 0z" fill="#F6B60B" />
      <path d="M11 10.2l1-1 1 1c-.3.5-1.7.5-2 0z" fill="#F6B60B" />
      <path d="M8.6 20c-.6.8-2 .8-2.2 0 .4-1 1.6-1.6 2.2-1z" fill="#F6B60B" /><path d="M15.4 20c.6.8 2 .8 2.2 0-.4-1-1.6-1.6-2.2-1z" fill="#F6B60B" />
    </svg>
  );
}

function WindowsIcon({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <rect x="3" y="3" width="8" height="8" rx="0.5" fill="#F25022" />
      <rect x="13" y="3" width="8" height="8" rx="0.5" fill="#7FBA00" />
      <rect x="3" y="13" width="8" height="8" rx="0.5" fill="#00A4EF" />
      <rect x="13" y="13" width="8" height="8" rx="0.5" fill="#FFB900" />
    </svg>
  );
}

const OsOption = ({ active, onClick, icon, label }) => (
  <button type="button" onClick={onClick} className="flex items-center gap-3 text-left">
    <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${active ? 'border-blue-600' : 'border-slate-300'}`}>
      {active && <span className="w-2 h-2 rounded-full bg-blue-600" />}
    </span>
    {icon}
    <span className="text-[15px] font-bold text-slate-800">{label}</span>
  </button>
);

// Step 3 (manual flow) — target OS + agent configuration options.
export default function StepConfiguration({ data, setData }) {
  const os = data.os || 'linux';
  const arch = data.arch || 'amd64';
  const tags = data.tags || [];
  const setTag = (i, k, v) => setData({ tags: tags.map((t, idx) => (idx === i ? { ...t, [k]: v } : t)) });
  const addTag = () => setData({ tags: [...tags, { key: '', value: '' }] });
  const removeTag = (i) => setData({ tags: tags.filter((_, idx) => idx !== i) });

  return (
    <div className="max-w-4xl">
      <p className="text-[15px] font-semibold text-slate-800">Select the operating system of the target host where the ActMon Observability Agent will be installed:</p>
      <div className="flex flex-col gap-4 mt-4 pb-6 border-b border-slate-100">
        <OsOption active={os === 'linux'} onClick={() => setData({ os: 'linux' })} icon={<LinuxIcon />} label="Linux" />
        <OsOption active={os === 'windows'} onClick={() => setData({ os: 'windows' })} icon={<WindowsIcon />} label="Windows" />
      </div>

      <p className="text-[15px] font-semibold text-slate-800 mt-6">Select the architecture of the target host:</p>
      <div className="flex flex-col gap-4 mt-4 pb-6 border-b border-slate-100">
        <OsOption active={arch === 'amd64'} onClick={() => setData({ arch: 'amd64' })} icon={<Cpu size={20} className="text-amber-500" />} label="AMD64" />
        <OsOption active={arch === 'arm'} onClick={() => setData({ arch: 'arm' })} icon={<Cpu size={20} className="text-amber-500" />} label="ARM" />
      </div>

      <p className="text-[15px] font-black text-slate-800 mt-6">Other configuration options:</p>
      <div className="mt-4 space-y-4">
        <div>
          <div className="flex items-center gap-3">
            <Toggle on={!!data.setupHostname} onChange={(v) => setData({ setupHostname: v })} />
            <span className="text-[15px] text-slate-700">Set up host name</span>
          </div>
          {data.setupHostname && (
            <input value={data.hostname || ''} onChange={(e) => setData({ hostname: e.target.value })} placeholder="Host name"
              className="mt-3 w-full max-w-md h-11 px-3.5 rounded-lg border border-slate-300 text-[15px] outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-50" />
          )}
        </div>
      </div>

      <div className="mt-5 rounded-lg bg-sky-50 border border-sky-200 p-4 flex gap-3">
        <Info size={18} className="text-sky-600 flex-shrink-0 mt-0.5" />
        <p className="text-[15px] text-slate-600 leading-relaxed">
          The Agent can be configured to use an explicit HTTP proxy server to forward connections to ActMon Observability endpoints. See{' '}
          <a href="#" onClick={(e) => e.preventDefault()} className="text-blue-600 font-semibold hover:underline">Configure proxy for ActMon Observability Agents</a> for details.
        </p>
      </div>

      <p className="text-[15px] font-black text-slate-800 mt-7">Tags</p>

      {tags.length > 0 && (
        <div className="mt-3 space-y-3">
          {tags.map((t, i) => {
            const keyErr = !(t.key || '').trim();
            const valErr = !(t.value || '').trim();
            return (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-3 items-start">
                <div>
                  {i === 0 && <label className="block text-[13px] font-bold text-slate-700 mb-1.5">Key</label>}
                  <input value={t.key} onChange={(e) => setTag(i, 'key', e.target.value)} placeholder="Key"
                    className={`w-full h-11 px-3.5 rounded-md border text-[15px] outline-none focus:ring-2 focus:ring-blue-50 ${keyErr ? 'border-red-400 focus:border-red-400' : 'border-slate-300 focus:border-blue-400'}`} />
                  {keyErr && <p className="text-[12px] font-bold text-red-600 mt-1">Required field</p>}
                </div>
                <div>
                  {i === 0 && <label className="block text-[13px] font-bold text-slate-700 mb-1.5">Value</label>}
                  <input value={t.value} onChange={(e) => setTag(i, 'value', e.target.value)} placeholder="Value"
                    className={`w-full h-11 px-3.5 rounded-md border text-[15px] outline-none focus:ring-2 focus:ring-blue-50 ${valErr ? 'border-red-400 focus:border-red-400' : 'border-slate-300 focus:border-blue-400'}`} />
                  {valErr && <p className="text-[12px] font-bold text-red-600 mt-1">Required field</p>}
                </div>
                <button onClick={() => removeTag(i)} className={`h-10 w-10 flex items-center justify-center rounded-md border border-slate-300 text-slate-500 hover:text-red-500 hover:border-red-300 ${i === 0 ? 'mt-[26px]' : ''}`}>
                  <X size={16} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <button onClick={addTag}
        className="mt-3 h-9 px-4 rounded-md border border-slate-300 text-slate-700 text-[12px] font-black uppercase tracking-wide hover:bg-slate-50 flex items-center gap-1.5">
        <Plus size={14} /> Add Tag
      </button>
    </div>
  );
}
