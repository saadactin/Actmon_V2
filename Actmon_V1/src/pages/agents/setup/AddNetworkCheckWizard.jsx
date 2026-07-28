import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { X, Zap, Radio, Network, Plug, Loader2 } from 'lucide-react';
import { createExternalCheck } from '../../../api/digitalExperience';

// Ping / DNS / TCP Port / UDP Port share the exact same fields (name, target,
// [port], interval) — one wizard with a `type` param instead of four
// near-identical copies of AddWebsiteWizard.
const TYPE_INFO = {
  ping:     { title: 'Ping',     icon: Radio,   needsPort: false, targetLabel: 'IP address or hostname', targetPlaceholder: 'e.g. 8.8.8.8 or example.com', desc: 'Check the availability of a specified IP and domain address.' },
  dns:      { title: 'DNS',      icon: Network, needsPort: false, targetLabel: 'Hostname to resolve', targetPlaceholder: 'e.g. example.com', desc: 'Check the functionality of your DNS server.' },
  tcp_port: { title: 'TCP Port', icon: Plug,    needsPort: true,  targetLabel: 'Hostname or IP address', targetPlaceholder: 'e.g. example.com', desc: 'Check the availability of your hostname and a specified port.' },
  udp_port: { title: 'UDP Port', icon: Plug,    needsPort: true,  targetLabel: 'Hostname or IP address', targetPlaceholder: 'e.g. example.com', desc: 'Check the availability of your hostname and a specified port.' },
};
const INTERVALS = [
  { label: '1 minute', sec: 60 }, { label: '5 minutes', sec: 300 }, { label: '10 minutes', sec: 600 },
  { label: '15 minutes', sec: 900 }, { label: '30 minutes', sec: 1800 }, { label: '1 hour', sec: 3600 },
];

export default function AddNetworkCheckWizard() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const type = TYPE_INFO[params.get('type')] ? params.get('type') : 'ping';
  const info = TYPE_INFO[type];
  const Icon = info.icon;
  const close = () => navigate('/agents/setup');

  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [port, setPort] = useState('');
  const [intervalSec, setIntervalSec] = useState(300);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const canSave = name.trim() && target.trim() && (!info.needsPort || (port && Number(port) > 0 && Number(port) <= 65535));

  const create = async () => {
    setSaving(true); setError(null);
    try {
      await createExternalCheck({
        name: name.trim(), check_type: type, target: target.trim(),
        port: info.needsPort ? Number(port) : null,
        interval_seconds: intervalSec, enabled: true, config: {},
      });
      navigate('/agents/setup');
    } catch (e) {
      setError(e?.response?.data?.detail || e.message || `Failed to create ${info.title} monitor.`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="-mx-6 md:-mx-8 -mb-6 md:-mb-8 min-h-screen bg-white flex flex-col">
      <div className="flex items-center justify-between px-6 py-3.5 border-b border-slate-200">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-md bg-gradient-to-br from-blue-500 to-sky-400 flex items-center justify-center"><Zap size={16} className="text-white" /></div>
          <span className="text-lg font-black text-slate-800">Add {info.title}</span>
        </div>
        <button onClick={close} className="text-slate-400 hover:text-slate-700"><X size={20} /></button>
      </div>

      <div className="flex-1 flex justify-center px-6 py-10">
        <div className="w-full max-w-[560px] space-y-6">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-blue-100 flex items-center justify-center"><Icon size={22} className="text-blue-600" /></div>
            <div>
              <h2 className="text-lg font-black text-slate-800">{info.title}</h2>
              <p className="text-[13px] text-slate-500">{info.desc}</p>
            </div>
          </div>

          <div>
            <label className="block text-[15px] font-bold text-slate-700 mb-1.5">Name<span className="text-rose-500"> *</span></label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`What should we call this ${info.title.toLowerCase()} check?`}
              className="w-full h-11 px-3.5 rounded-md border border-slate-300 text-[15px] focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none" />
          </div>

          <div>
            <label className="block text-[15px] font-bold text-slate-700 mb-1.5">{info.targetLabel}<span className="text-rose-500"> *</span></label>
            <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={info.targetPlaceholder}
              className="w-full h-11 px-3.5 rounded-md border border-slate-300 text-[15px] focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none" />
          </div>

          {info.needsPort && (
            <div>
              <label className="block text-[15px] font-bold text-slate-700 mb-1.5">Port<span className="text-rose-500"> *</span></label>
              <input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} placeholder="e.g. 443"
                className="w-full h-11 px-3.5 rounded-md border border-slate-300 text-[15px] focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none" />
            </div>
          )}

          <div>
            <label className="block text-[15px] font-bold text-slate-700 mb-1.5">Test Interval<span className="text-rose-500"> *</span></label>
            <select value={intervalSec} onChange={(e) => setIntervalSec(Number(e.target.value))}
              className="w-full h-11 px-3.5 rounded-md border border-slate-300 text-[15px] outline-none focus:border-blue-500">
              {INTERVALS.map((i) => <option key={i.sec} value={i.sec}>{i.label}</option>)}
            </select>
          </div>

          {error && <p className="text-[13px] font-semibold text-rose-600 bg-rose-50 border border-rose-200 rounded-md px-3.5 py-2.5">{error}</p>}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button onClick={close} className="h-9 px-5 rounded-md text-[13px] font-black uppercase tracking-wide text-slate-600 hover:bg-slate-50">Cancel</button>
            <button onClick={create} disabled={!canSave || saving}
              className="h-9 px-6 rounded-md bg-blue-600 text-white text-[13px] font-black uppercase tracking-wide hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2">
              {saving && <Loader2 size={14} className="animate-spin" />}{saving ? 'Creating…' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
