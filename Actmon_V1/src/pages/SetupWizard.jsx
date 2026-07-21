import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Shield, User, Mail, Phone, IdCard, KeyRound, Eye, EyeOff, Check,
  ChevronRight, ChevronLeft, Loader2, AlertTriangle, PartyPopper, Database,
} from 'lucide-react';
import { getSetupStatus, createAdmin } from '../api/setup';

const STEPS = ['Welcome', 'Your details', 'Account', 'Finish'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const errText = (e) => e?.response?.data?.detail || e?.message || 'Something went wrong.';

function Stepper({ current }) {
  return (
    <div className="flex items-center justify-center gap-1.5 sm:gap-3 mb-8">
      {STEPS.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <React.Fragment key={label}>
            <div className="flex items-center gap-2">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[13px] font-black transition-all
                ${done ? 'bg-emerald-500 text-white' : active ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200' : 'bg-slate-200 text-slate-500'}`}>
                {done ? <Check size={15} /> : i + 1}
              </div>
              <span className={`hidden sm:block text-[13px] font-bold ${active ? 'text-slate-800' : 'text-slate-400'}`}>{label}</span>
            </div>
            {i < STEPS.length - 1 && <div className={`w-6 sm:w-10 h-0.5 rounded ${done ? 'bg-emerald-400' : 'bg-slate-200'}`} />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function Fld({ icon: Icon, label, required, children, hint, error }) {
  return (
    <div>
      <label className="flex items-center gap-1.5 text-[13px] font-bold text-slate-600 mb-1.5">
        {Icon && <Icon size={14} className="text-slate-400" />} {label}
        {required && <span className="text-red-500">*</span>}
      </label>
      {children}
      {error ? <p className="text-[12px] text-red-500 mt-1">{error}</p>
        : hint ? <p className="text-[12px] text-slate-400 mt-1">{hint}</p> : null}
    </div>
  );
}

const inputCls = "w-full h-11 px-3.5 rounded-xl border border-slate-300 text-[14px] outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 transition-all";

export default function SetupWizard() {
  const navigate = useNavigate();
  const [checking, setChecking] = useState(true);
  const [step, setStep] = useState(0);
  const [orgName, setOrgName] = useState('');
  const [dbReady, setDbReady] = useState(true);
  const [d, setD] = useState({ employee_name: '', email: '', mobile: '', employee_code: '', username: '', password: '', confirm: '' });
  const [touched, setTouched] = useState({});
  const [showPw, setShowPw] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  const set = (k, v) => setD((p) => ({ ...p, [k]: v }));
  const touch = (k) => setTouched((p) => ({ ...p, [k]: true }));

  // Gate: only show the wizard while setup is actually needed.
  useEffect(() => {
    let alive = true;
    getSetupStatus()
      .then((s) => {
        if (!alive) return;
        if (!s.needs_setup) { navigate('/login', { replace: true }); return; }
        setOrgName(s.org_name || '');
        setDbReady(!!s.db_ready);
        setChecking(false);
      })
      .catch(() => { if (alive) { setDbReady(false); setChecking(false); } });
    return () => { alive = false; };
  }, [navigate]);

  const emailOk = EMAIL_RE.test(d.email.trim());
  const detailsOk = d.employee_name.trim().length > 0 && emailOk;
  const accountOk = d.username.trim().length >= 3 && d.password.length >= 6 && d.password === d.confirm;

  const canNext = (step === 0 && dbReady) || (step === 1 && detailsOk) || (step === 2 && accountOk);

  const next = () => {
    if (step === 1 && !detailsOk) { setTouched({ ...touched, employee_name: true, email: true }); return; }
    if (step === 2 && !accountOk) { setTouched({ ...touched, username: true, password: true, confirm: true }); return; }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const submit = async () => {
    setSubmitting(true); setError(null);
    try {
      const r = await createAdmin({
        employee_name: d.employee_name.trim(), email: d.email.trim(),
        mobile: d.mobile.trim(), employee_code: d.employee_code.trim(),
        username: d.username.trim(), password: d.password,
      });
      setDone(r);
      setStep(3);
    } catch (e) { setError(errText(e)); }
    finally { setSubmitting(false); }
  };

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 size={26} className="animate-spin text-indigo-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-900 to-slate-800 flex items-center justify-center p-4">
      <div className="w-full max-w-xl bg-white rounded-2xl shadow-2xl overflow-hidden">
        {/* header */}
        <div className="px-7 py-5 bg-gradient-to-r from-indigo-600 to-blue-600 text-white flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center"><Shield size={20} /></div>
          <div>
            <h1 className="text-lg font-black leading-tight">Welcome to ActMon</h1>
            <p className="text-indigo-100 text-[12px]">First-run setup{orgName ? ` - ${orgName}` : ''}</p>
          </div>
        </div>

        <div className="p-7">
          <Stepper current={step} />

          {!dbReady && step === 0 && (
            <div className="mb-4 rounded-xl bg-amber-50 border border-amber-200 p-3.5 flex items-start gap-2.5">
              <AlertTriangle size={18} className="text-amber-500 flex-shrink-0 mt-0.5" />
              <p className="text-[13px] text-amber-800">The database isn't provisioned yet. Run <span className="font-mono font-bold">python install.py</span> (or its DB step) first, then reload this page.</p>
            </div>
          )}

          {/* Step 0 — Welcome */}
          {step === 0 && (
            <div className="text-center py-2">
              <div className="w-16 h-16 rounded-2xl bg-indigo-50 flex items-center justify-center mx-auto mb-4"><Database size={30} className="text-indigo-600" /></div>
              <h2 className="text-xl font-black text-slate-800">Let's create your Super Admin</h2>
              <p className="text-slate-500 text-[14px] mt-2 max-w-sm mx-auto">
                Your database is set up with the Super Admin role and all page permissions.
                Now create the administrator account that owns them - it takes a minute.
              </p>
            </div>
          )}

          {/* Step 1 — Employee details (mandatory) */}
          {step === 1 && (
            <div className="space-y-4">
              <p className="text-[13px] text-slate-500">Tell us who the administrator is. Fields marked <span className="text-red-500">*</span> are required.</p>
              <Fld icon={User} label="Full name" required error={touched.employee_name && !d.employee_name.trim() ? 'Name is required.' : ''}>
                <input className={inputCls} value={d.employee_name} onChange={(e) => set('employee_name', e.target.value)} onBlur={() => touch('employee_name')} placeholder="e.g. Suyash Gaikwad" autoFocus />
              </Fld>
              <Fld icon={Mail} label="Email" required error={touched.email && !emailOk ? 'A valid email is required.' : ''}>
                <input className={inputCls} value={d.email} onChange={(e) => set('email', e.target.value)} onBlur={() => touch('email')} placeholder="you@company.com" type="email" />
              </Fld>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Fld icon={Phone} label="Mobile" hint="Optional">
                  <input className={inputCls} value={d.mobile} onChange={(e) => set('mobile', e.target.value)} placeholder="Optional" />
                </Fld>
                <Fld icon={IdCard} label="Employee code" hint="Optional - auto if blank">
                  <input className={inputCls} value={d.employee_code} onChange={(e) => set('employee_code', e.target.value)} placeholder="EMP001" />
                </Fld>
              </div>
            </div>
          )}

          {/* Step 2 — Account */}
          {step === 2 && (
            <div className="space-y-4">
              <p className="text-[13px] text-slate-500">Choose the sign-in credentials for this administrator.</p>
              <Fld icon={User} label="Username" required error={touched.username && d.username.trim().length < 3 ? 'At least 3 characters.' : ''}>
                <input className={inputCls} value={d.username} onChange={(e) => set('username', e.target.value)} onBlur={() => touch('username')} placeholder="superadmin" autoFocus />
              </Fld>
              <Fld icon={KeyRound} label="Password" required error={touched.password && d.password.length < 6 ? 'At least 6 characters.' : ''}>
                <div className="relative">
                  <input className={inputCls + ' pr-11'} type={showPw ? 'text' : 'password'} value={d.password} onChange={(e) => set('password', e.target.value)} onBlur={() => touch('password')} placeholder="At least 6 characters" />
                  <button type="button" onClick={() => setShowPw((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">{showPw ? <EyeOff size={16} /> : <Eye size={16} />}</button>
                </div>
              </Fld>
              <Fld icon={KeyRound} label="Confirm password" required error={touched.confirm && d.confirm !== d.password ? 'Passwords do not match.' : ''}>
                <input className={inputCls} type={showPw ? 'text' : 'password'} value={d.confirm} onChange={(e) => set('confirm', e.target.value)} onBlur={() => touch('confirm')} placeholder="Re-enter password" />
              </Fld>
            </div>
          )}

          {/* Step 3 — Finish */}
          {step === 3 && done && (
            <div className="text-center py-3">
              <div className="w-16 h-16 rounded-2xl bg-emerald-50 flex items-center justify-center mx-auto mb-4"><PartyPopper size={30} className="text-emerald-600" /></div>
              <h2 className="text-xl font-black text-slate-800">You're all set!</h2>
              <p className="text-slate-500 text-[14px] mt-2">
                Super Admin <span className="font-bold text-slate-700">{done.username}</span> was created with full access.
              </p>
              <div className="mt-5 rounded-xl bg-slate-50 border border-slate-200 p-4 text-left text-[13px] text-slate-600 max-w-sm mx-auto space-y-1">
                <p><span className="text-slate-400">Name:</span> {d.employee_name}</p>
                <p><span className="text-slate-400">Email:</span> {d.email}</p>
                <p><span className="text-slate-400">Username:</span> {done.username}</p>
                <p><span className="text-slate-400">Role:</span> Super Admin (all pages)</p>
              </div>
              <button onClick={() => navigate('/login', { replace: true })}
                className="mt-6 h-11 px-6 rounded-xl bg-indigo-600 text-white font-bold hover:bg-indigo-700 transition-all">
                Go to Sign In
              </button>
            </div>
          )}

          {error && step !== 3 && (
            <div className="mt-4 rounded-xl bg-red-50 border border-red-200 p-3 flex items-start gap-2.5">
              <AlertTriangle size={17} className="text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-[13px] text-red-700">{error}</p>
            </div>
          )}

          {/* footer nav */}
          {step !== 3 && (
            <div className="flex items-center justify-between mt-8">
              <button onClick={() => setStep((s) => Math.max(s - 1, 0))} disabled={step === 0}
                className="h-11 px-4 rounded-xl border border-slate-300 text-slate-600 font-bold text-[14px] hover:bg-slate-50 disabled:opacity-40 flex items-center gap-1.5">
                <ChevronLeft size={16} /> Back
              </button>
              {step < 2 ? (
                <button onClick={next} disabled={!canNext}
                  className="h-11 px-6 rounded-xl bg-indigo-600 text-white font-bold text-[14px] hover:bg-indigo-700 disabled:opacity-40 flex items-center gap-1.5">
                  Next <ChevronRight size={16} />
                </button>
              ) : (
                <button onClick={submit} disabled={!accountOk || submitting}
                  className="h-11 px-6 rounded-xl bg-emerald-600 text-white font-bold text-[14px] hover:bg-emerald-700 disabled:opacity-40 flex items-center gap-2">
                  {submitting ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} Create Super Admin
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
