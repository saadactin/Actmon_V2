import React, { useRef, useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { getSetupStatus } from '../api/setup';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as zod from 'zod';
import { useAuth } from '../hooks/useAuth';
import { Button, Input, Field, Spinner, MessageBar, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';
import { Eye, EyeOff, Shield, MailCheck, ArrowLeft, RefreshCw, Database, Activity, Lock } from 'lucide-react';

const loginSchema = zod.object({
  username: zod.string().min(3, 'Username must be at least 3 characters'),
  password: zod.string().min(5, 'Password must be at least 5 characters'),
});

const TRUSTED = ['/actin logo.png', '/Emcure.png', '/kirlsokar logo.png'];

/* ── 6-box OTP input (auto-advance, backspace, paste) ── */
function OtpBoxes({ value, onChange, disabled }) {
  const refs = useRef([]);
  const setAt = (i, ch) => {
    const d = ch.replace(/\D/g, '').slice(-1);
    const arr = (value || '').padEnd(6, ' ').split('');
    arr[i] = d || ' ';
    onChange(arr.join('').replace(/ /g, '').slice(0, 6));
    if (d && i < 5) refs.current[i + 1]?.focus();
  };
  const onKey = (i, e) => {
    if (e.key === 'Backspace' && !value[i] && i > 0) refs.current[i - 1]?.focus();
    if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus();
    if (e.key === 'ArrowRight' && i < 5) refs.current[i + 1]?.focus();
  };
  const onPaste = (e) => {
    const t = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
    if (t) { onChange(t); refs.current[Math.min(t.length, 5)]?.focus(); e.preventDefault(); }
  };
  return (
    <div className="flex gap-2 sm:gap-2.5 justify-center" onPaste={onPaste}>
      {Array.from({ length: 6 }).map((_, i) => (
        <input key={i} ref={(el) => (refs.current[i] = el)} value={value[i] || ''} disabled={disabled}
          onChange={(e) => setAt(i, e.target.value)} onKeyDown={(e) => onKey(i, e)}
          maxLength={1} inputMode="numeric" autoComplete="one-time-code" autoFocus={i === 0}
          className="w-11 h-14 sm:w-12 rounded-xl border-2 border-slate-200 bg-slate-50 text-center text-2xl font-black text-slate-800
                     focus:outline-none focus:border-indigo-500 focus:bg-white focus:ring-4 focus:ring-indigo-100 transition-all" />
      ))}
    </div>
  );
}

export const Login = () => {
  const { login, verifyOtp, resendOtp, loading, error: authError, setError } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // First-run gate: if no admin exists yet, send the user to the setup wizard.
  useEffect(() => {
    let alive = true;
    getSetupStatus()
      .then((s) => { if (alive && s?.needs_setup) navigate('/setup', { replace: true }); })
      .catch(() => {});
    return () => { alive = false; };
  }, [navigate]);
  const [showPassword, setShowPassword] = useState(false);

  const [step, setStep] = useState('credentials');
  const [otpToken, setOtpToken] = useState(null);
  const [email, setEmail] = useState('');
  const [devOtp, setDevOtp] = useState(null);
  const [code, setCode] = useState('');
  const [resent, setResent] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);   // seconds left before Resend is allowed again

  // Mirrors the server-side resend cooldown so the button self-disables instead
  // of letting the user fire requests that can only come back as 429s.
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const id = setInterval(() => setCooldown((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  // Once the OTP token is dead (expired / retired / resend cap hit) nothing on
  // this screen can recover it — Verify and Resend both just repeat the same
  // error, which is the trap in the reported bug. Bounce back to sign-in and
  // carry the reason across so the user knows why.
  useEffect(() => {
    if (step !== 'otp' || !authError) return;
    if (/session expired|please login again|please sign in again/i.test(authError)) {
      setStep('credentials'); setCode(''); setOtpToken(null); setDevOtp(null); setCooldown(0);
    }
  }, [authError, step]);

  const isExpired = searchParams.get('expired') === 'true';
  const { register, handleSubmit, formState: { errors } } = useForm({
    resolver: zodResolver(loginSchema), defaultValues: { username: '', password: '' },
  });

  const onCredentials = async (data) => {
    const res = await login(data.username, data.password);
    if (res?.otpRequired) { setOtpToken(res.otpToken); setEmail(res.email || ''); setDevOtp(res.devOtp || null); setStep('otp'); }
  };
  // first page the user is actually allowed to open (menu is already View-filtered server-side)
  const firstAllowedPath = (menu) => {
    const dig = (nodes) => {
      for (const n of nodes || []) {
        if (n.url) return n.url;
        const c = dig(n.children); if (c) return c;
      }
      return null;
    };
    for (const m of menu || []) {
      const p = dig(m.children);
      if (p) return p;
      if (m.route) return m.route;
    }
    return '/dashboard';
  };
  const onVerify = async (e) => {
    e.preventDefault();
    if (code.trim().length < 6) { setError('Enter the 6-digit code'); return; }
    const data = await verifyOtp(otpToken, code.trim());
    if (data) navigate(firstAllowedPath(data.menu), { replace: true });
  };
  const onResend = async () => {
    if (resending || cooldown > 0) return;
    setResending(true);
    setError(null);
    try {
      const res = await resendOtp(otpToken);
      // Only treat this as a success when a replacement token actually came
      // back. The old code unconditionally flashed "Code resent" — so a failed
      // resend showed a green confirmation next to a red error, and wiped the
      // code the user had already typed.
      if (res?.otp_token) {
        setOtpToken(res.otp_token);
        setDevOtp(res.dev_otp || null);
        setCode('');
        setCooldown(res.resend_cooldown || 30);
        setResent(true);
        setTimeout(() => setResent(false), 3000);
      }
    } finally {
      setResending(false);
    }
  };
  const backToLogin = () => {
    setStep('credentials'); setCode(''); setError(null);
    setOtpToken(null); setDevOtp(null); setCooldown(0); setResent(false);
  };

  return (
    <div className="min-h-screen flex bg-slate-100">
      {/* ── Brand panel ── */}
      <div className="hidden lg:flex lg:w-[46%] relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-indigo-950 text-white flex-col justify-between p-12">
        <div className="absolute inset-0 opacity-[0.05]" style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '32px 32px' }} />
        <div className="absolute -top-24 -right-24 w-96 h-96 rounded-full bg-indigo-500/20 blur-3xl" />
        <div className="absolute -bottom-32 -left-16 w-96 h-96 rounded-full bg-blue-500/10 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-[#0078D4] flex items-center justify-center shadow-lg"><Shield className="h-6 w-6 text-white" /></div>
          <span className="text-2xl font-black tracking-tight">ActMon</span>
        </div>
        <div className="relative">
          <h1 className="text-4xl font-black leading-tight tracking-tight">Enterprise Database<br />Monitoring Platform</h1>
          <p className="text-slate-300/80 mt-4 max-w-md">Real-time observability across MySQL, PostgreSQL, Oracle, SQL Server, MongoDB &amp; ClickHouse — with role-based access control.</p>
          <div className="flex gap-3 mt-8">
            {[{ i: Database, t: 'Multi-DB' }, { i: Activity, t: 'Real-time' }, { i: Lock, t: 'Secure RBAC' }].map(({ i: I, t }) => (
              <div key={t} className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-white/5 border border-white/10 backdrop-blur-sm">
                <I size={16} className="text-indigo-300" /><span className="text-sm font-semibold">{t}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="relative">
          <p className="text-[11px] uppercase tracking-widest text-slate-400 font-bold mb-3">Trusted by leading organizations</p>
          <div className="flex flex-wrap items-center gap-3">
            {TRUSTED.map((src) => (
              <div key={src} className="h-9 px-3 rounded-lg bg-white/90 flex items-center justify-center">
                <img src={encodeURI(src)} alt="" className="h-5 max-w-[70px] object-contain" onError={(e) => { e.currentTarget.parentElement.style.display = 'none'; }} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Form panel ── */}
      <div className="flex-1 flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-md bg-white rounded-3xl border border-slate-200 shadow-[0_24px_60px_-30px_rgba(15,23,42,0.35)] p-8 sm:p-10">
          <div className="lg:hidden flex items-center gap-2 justify-center mb-7">
            <div className="w-10 h-10 rounded-xl bg-[#0078D4] flex items-center justify-center"><Shield className="h-5 w-5 text-white" /></div>
            <span className="text-xl font-black text-slate-800">ActMon</span>
          </div>

          {step === 'credentials' ? (
            <>
              <h2 className="text-2xl font-black text-slate-800">Welcome back</h2>
              <p className="text-sm text-slate-500 mt-1 mb-7">Sign in to your ActMon account to continue.</p>
              {isExpired && <MessageBar intent="warning" className="mb-4"><MessageBarBody><MessageBarTitle>Session Expired</MessageBarTitle>Please log in again.</MessageBarBody></MessageBar>}
              {authError && <MessageBar intent="error" className="mb-4"><MessageBarBody><MessageBarTitle>Sign-in blocked</MessageBarTitle>{authError}</MessageBarBody></MessageBar>}
              <form className="space-y-5" onSubmit={handleSubmit(onCredentials)}>
                <Field label="Username" validationState={errors.username ? 'error' : 'none'} validationMessage={errors.username?.message}>
                  <Input {...register('username')} disabled={loading} className="w-full" placeholder="Enter username" size="large" />
                </Field>
                <Field label="Password" validationState={errors.password ? 'error' : 'none'} validationMessage={errors.password?.message}>
                  <div className="relative flex items-center">
                    <Input {...register('password')} type={showPassword ? 'text' : 'password'} disabled={loading} className="w-full pr-10" placeholder="Enter password" size="large" />
                    <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 text-gray-400 hover:text-gray-600 z-10">
                      {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                    </button>
                  </div>
                </Field>
                <Button type="submit" disabled={loading} appearance="primary" style={{ width: '100%', height: '44px' }} className="font-semibold">
                  {loading ? <Spinner size="tiny" label="Sending code…" /> : 'Sign In'}
                </Button>
              </form>
            </>
          ) : (
            <form onSubmit={onVerify}>
              <div className="flex flex-col items-center text-center mb-6">
                <div className="w-14 h-14 rounded-2xl bg-emerald-50 flex items-center justify-center mb-3"><MailCheck className="h-7 w-7 text-emerald-600" /></div>
                <h2 className="text-2xl font-black text-slate-800">Verify it's you</h2>
                <p className="text-sm text-slate-500 mt-1">Enter the 6-digit code sent to</p>
                <p className="text-sm font-bold text-slate-800">{email}</p>
                {devOtp && <p className="mt-2 text-xs font-mono px-2.5 py-1 rounded-md bg-amber-50 text-amber-700 border border-amber-200">DEV code: {devOtp}</p>}
              </div>

              {authError && <MessageBar intent="error" className="mb-5"><MessageBarBody><MessageBarTitle>Verification Failed</MessageBarTitle>{authError}</MessageBarBody></MessageBar>}

              <OtpBoxes value={code} onChange={setCode} disabled={loading} />

              <Button type="submit" disabled={loading || code.length < 6} appearance="primary" style={{ width: '100%', height: '44px' }} className="font-semibold mt-7">
                {loading ? <Spinner size="tiny" label="Verifying…" /> : 'Verify & Sign In'}
              </Button>

              <div className="mt-5 pt-4 border-t border-slate-100 flex items-center justify-between">
                <button type="button" onClick={backToLogin}
                  className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-slate-800 transition-colors">
                  <ArrowLeft className="h-4 w-4" /> Back to login
                </button>
                <button type="button" onClick={onResend} disabled={resending || resent || cooldown > 0}
                  className={`inline-flex items-center gap-1.5 text-sm font-bold transition-colors ${
                    resent ? 'text-emerald-600' : cooldown > 0 || resending ? 'text-slate-400' : 'text-[#0078D4] hover:text-blue-700'}`}>
                  <RefreshCw className={`h-3.5 w-3.5 ${resending ? 'animate-spin' : ''}`} />
                  {resending ? 'Sending…' : resent ? 'Code resent' : cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
                </button>
              </div>
            </form>
          )}

          <p className="text-center text-xs text-slate-400 mt-9">ActMon Enterprise Security v2026.1 · All rights reserved.</p>
        </div>
      </div>
    </div>
  );
};
