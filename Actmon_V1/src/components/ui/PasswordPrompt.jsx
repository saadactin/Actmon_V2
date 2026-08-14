import React, { useState } from 'react';
import { ShieldCheck, X, Eye, EyeOff, Loader2, Check, AlertTriangle } from 'lucide-react';

// The axios response interceptor flattens every failure to `new Error(detail)`, so
// error.response is gone — the real text lives on error.message. Support both shapes.
export const errText = (e, fb = 'Something went wrong. The host may be unreachable.') =>
  e?.response?.data?.detail || e?.message || fb;

// Reusable password re-auth modal for control actions (start/stop/restart, kill, reboot, …).
// onConfirm(password) must return the API call's promise.
export function PasswordPrompt({ title, confirmLabel = 'Confirm', danger, onConfirm, onClose }) {
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const go = async () => {
    if (!pw) { setMsg({ ok: false, text: 'Enter your password to confirm.' }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await onConfirm(pw);
      setMsg({ ok: true, text: r?.message || 'Done.' });
      setTimeout(onClose, 900);
    } catch (e) { setMsg({ ok: false, text: errText(e, 'Action failed.') }); }
    finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className={`px-5 py-4 text-white flex items-center justify-between ${danger ? 'bg-gradient-to-r from-red-700 to-red-500' : 'bg-gradient-to-r from-slate-900 to-slate-700'}`}>
          <div className="flex items-center gap-2.5"><ShieldCheck size={18} /><h3 className="font-black text-[15px]">{title}</h3></div>
          <button onClick={onClose} className="text-white/70 hover:text-white"><X size={18} /></button>
        </div>
        <div className="p-5">
          <label className="block text-[13px] font-bold text-slate-600 mb-1.5">Confirm your password to run this command</label>
          <div className="relative">
            <input type={show ? 'text' : 'password'} value={pw} onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && go()} placeholder="Your ActMon login password" autoFocus
              className="w-full h-10 px-3 pr-9 rounded-lg border border-slate-300 text-[14px] outline-none focus:border-blue-400" />
            <button onClick={() => setShow((v) => !v)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400">{show ? <EyeOff size={15} /> : <Eye size={15} />}</button>
          </div>
          {msg && <p className={`text-[13px] font-semibold mt-3 flex items-center gap-1.5 ${msg.ok ? 'text-emerald-600' : 'text-red-600'}`}>{msg.ok ? <Check size={14} /> : <AlertTriangle size={14} />}{msg.text}</p>}
          <div className="flex justify-end gap-2 mt-5">
            <button onClick={onClose} className="h-10 px-4 rounded-lg border border-slate-300 text-slate-600 text-[14px] font-bold hover:bg-slate-100">Cancel</button>
            <button onClick={go} disabled={busy}
              className={`h-10 px-5 rounded-lg text-white text-[14px] font-bold disabled:opacity-50 flex items-center gap-2 ${danger ? 'bg-red-600 hover:bg-red-700' : 'bg-slate-800 hover:bg-slate-700'}`}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}{confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
