import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import AuthShell, { AuthField } from '@/pages/auth/AuthShell';
import { getSetupStatus } from '@/api/auth';
import useAuth from '@/hooks/useAuth';

/**
 * Sign-in. The flow is the existing one, unchanged: credentials → e-mailed 6-digit
 * code → session. Only the presentation is rebuilt, on the token components, so the
 * page follows the app's theme and accent instead of pulling in a second UI kit.
 *
 * Three behaviours here are not decoration and are kept deliberately:
 *   · the resend cooldown is mirrored client-side, so the button self-disables
 *     rather than firing requests that can only come back 429
 *   · a dead OTP token bounces back to the credentials step WITH the reason —
 *     otherwise Verify and Resend both just repeat the same error forever
 *   · after verifying, it lands on the first page the role may actually open,
 *     read from the server-filtered menu, not a hardcoded /dashboard
 */

const OTP_LENGTH = 6;

/** 6-box code entry: auto-advance, backspace/arrows, and paste-the-whole-code. */
function OtpBoxes({ value, onChange, disabled }) {
  const refs = useRef([]);

  const setAt = (i, ch) => {
    const digit = ch.replace(/\D/g, '').slice(-1);
    const arr = (value || '').padEnd(OTP_LENGTH, ' ').split('');
    arr[i] = digit || ' ';
    onChange(arr.join('').replace(/ /g, '').slice(0, OTP_LENGTH));
    if (digit && i < OTP_LENGTH - 1) refs.current[i + 1]?.focus();
  };

  const onKey = (i, e) => {
    if (e.key === 'Backspace' && !value[i] && i > 0) refs.current[i - 1]?.focus();
    if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus();
    if (e.key === 'ArrowRight' && i < OTP_LENGTH - 1) refs.current[i + 1]?.focus();
  };

  const onPaste = (e) => {
    const text = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, OTP_LENGTH);
    if (!text) return;
    onChange(text);
    refs.current[Math.min(text.length, OTP_LENGTH - 1)]?.focus();
    e.preventDefault();
  };

  return (
    <div className="flex justify-center gap-2 sm:gap-2.5" onPaste={onPaste}>
      {Array.from({ length: OTP_LENGTH }).map((_, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          value={value[i] || ''}
          disabled={disabled}
          onChange={(e) => setAt(i, e.target.value)}
          onKeyDown={(e) => onKey(i, e)}
          maxLength={1}
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label={`Digit ${i + 1} of ${OTP_LENGTH}`}
          className="h-14 w-11 rounded-card border-2 border-border bg-sunken text-center text-2xl font-bold text-fg
                     transition-colors outline-none focus:border-accent focus:bg-surface sm:w-12"
        />
      ))}
    </div>
  );
}

export default function Login() {
  const { login, verifyOtp, resendOtp, loading, error: authError, setError } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [step, setStep] = useState('credentials');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});

  const [otpToken, setOtpToken] = useState(null);
  const [email, setEmail] = useState('');
  const [devOtp, setDevOtp] = useState(null);
  const [code, setCode] = useState('');
  const [resent, setResent] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  const isExpired = searchParams.get('expired') === 'true';

  /* First-run gate: with no admin yet, sign-in is impossible — send them to setup. */
  useEffect(() => {
    let alive = true;
    getSetupStatus()
      .then((s) => { if (alive && s?.needs_setup) navigate('/setup', { replace: true }); })
      .catch(() => { /* the gate is a convenience; a failure must not block sign-in */ });
    return () => { alive = false; };
  }, [navigate]);

  /* Mirror the server's resend cooldown so the button disables itself. */
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const id = setInterval(() => setCooldown((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  /* Once the OTP token is dead — expired, retired, resend cap hit — nothing on this
     screen can recover it: Verify and Resend both just repeat the error. Go back to
     the credentials step and carry the reason across. */
  useEffect(() => {
    if (step !== 'otp' || !authError) return;
    if (/session expired|please login again|please sign in again/i.test(authError)) {
      setStep('credentials');
      setCode('');
      setOtpToken(null);
      setDevOtp(null);
      setCooldown(0);
    }
  }, [authError, step]);

  const onCredentials = async (e) => {
    e.preventDefault();
    const errs = {};
    if (username.trim().length < 3) errs.username = 'Username must be at least 3 characters';
    if (password.length < 5) errs.password = 'Password must be at least 5 characters';
    setFieldErrors(errs);
    if (Object.keys(errs).length) return;

    const res = await login(username.trim(), password);
    if (res?.otpRequired) {
      setOtpToken(res.otpToken);
      setEmail(res.email || '');
      setDevOtp(res.devOtp || null);
      setStep('otp');
    }
  };

  /** The first page this role is actually allowed to open. */
  const firstAllowedPath = (menu) => {
    const dig = (nodes) => {
      for (const n of nodes || []) {
        if (n.url) return n.url;
        const child = dig(n.children);
        if (child) return child;
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
    if (code.trim().length < OTP_LENGTH) { setError(`Enter the ${OTP_LENGTH}-digit code`); return; }
    const data = await verifyOtp(otpToken, code.trim());
    if (data) navigate(firstAllowedPath(data.menu), { replace: true });
  };

  const onResend = async () => {
    if (resending || cooldown > 0) return;
    setResending(true);
    setError(null);
    try {
      const res = await resendOtp(otpToken);
      /* Only a replacement token counts as success. Flashing "code resent"
         unconditionally put a green confirmation next to a red error and wiped the
         digits the user had already typed. */
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
    setStep('credentials');
    setCode('');
    setError(null);
    setOtpToken(null);
    setDevOtp(null);
    setCooldown(0);
    setResent(false);
  };

  return (
    <AuthShell>
      {step === 'credentials' ? (
        <>
        <h2 className="text-2xl font-bold text-fg">Welcome back</h2>
        <p className="mt-1 mb-7 text-[13px] text-muted">Sign in to your ActMon account to continue.</p>

        {isExpired && <Notice tone="warning" title="Session expired.">Please sign in again.</Notice>}
        {authError && <Notice tone="danger" title="Sign-in blocked.">{authError}</Notice>}

        <form className="space-y-5" onSubmit={onCredentials}>
          <AuthField id="username" label="Username" icon="user" error={fieldErrors.username}>
            <Input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="your.username"
              icon="user"
              autoComplete="username"
              autoFocus
            />
          </AuthField>

          <AuthField id="password" label="Password" icon="key" error={fieldErrors.password}>
            <div className="relative flex items-center">
              <Input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                icon="key"
                autoComplete="current-password"
                className="pr-9"
                wrapperClassName="flex-1"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-2 grid h-6 w-6 place-items-center rounded-sm text-subtle transition-colors hover:text-fg"
              >
                <Icon name="eye" size={15} />
              </button>
            </div>
          </AuthField>

          <Button type="submit" variant="primary" size="lg" loading={loading} className="w-full">
            {loading ? 'Verifying…' : 'Continue'}
          </Button>
        </form>

        <p className="mt-6 flex items-center justify-center gap-1.5 text-[12px] text-subtle">
          <Icon name="shield" size={13} />
          A one-time code is e-mailed on every sign-in.
        </p>
        </>
      ) : (
        <>
        <div className="mb-6 text-center">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-accent-soft text-accent-text">
            <Icon name="bell" size={22} />
          </span>
          <h2 className="mt-4 text-2xl font-bold text-fg">Check your e-mail</h2>
          <p className="mt-1 text-[13px] text-muted">
            We sent a {OTP_LENGTH}-digit code{email ? <> to <span className="font-semibold text-fg">{email}</span></> : null}.
          </p>
        </div>

        {authError && <Notice tone="danger" title="Verification failed.">{authError}</Notice>}
        {resent && <Notice tone="success" title="Code resent.">Check your inbox for the new code.</Notice>}
        {devOtp && (
          <Notice tone="info" title="Development mode.">
            Code: <span className="font-mono font-bold">{devOtp}</span>
          </Notice>
        )}

        <form className="space-y-6" onSubmit={onVerify}>
          <OtpBoxes value={code} onChange={setCode} disabled={loading} />

          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={loading}
            disabled={code.length < OTP_LENGTH}
            className="w-full"
          >
            {loading ? 'Verifying…' : 'Verify and sign in'}
          </Button>
        </form>

        <div className="mt-6 flex items-center justify-between text-[12px]">
          <button
            type="button"
            onClick={backToLogin}
            className="flex items-center gap-1 font-semibold text-muted transition-colors hover:text-fg"
          >
            <Icon name="chevron-left" size={14} /> Back to sign in
          </button>
          <button
            type="button"
            onClick={onResend}
            disabled={resending || cooldown > 0}
            className="flex items-center gap-1 font-semibold text-accent-text transition-colors hover:underline disabled:pointer-events-none disabled:text-subtle"
          >
            <Icon name="refresh" size={13} className={resending ? 'animate-spin' : undefined} />
            {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
          </button>
        </div>
        </>
      )}
    </AuthShell>
  );
}
