import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Steps from '@/components/ui/Steps';
import { PageLoading } from '@/components/ui/Loading';
import AuthShell, { AuthField } from '@/pages/auth/AuthShell';
import { createAdmin, getSetupStatus } from '@/api/auth';

/**
 * First-run setup: create the Super Admin on a fresh install.
 *
 * The installer's DB step seeds organization #1, the Super Admin role and every
 * page grant, but leaves users empty on purpose — so this is the only screen that
 * works before any account exists. It shares AuthShell with sign-in, because the
 * two are the same moment for a new operator and looked like two products before.
 *
 * Three things here are load-bearing:
 *   · the gate — if an admin already exists this page must not be reachable, so it
 *     redirects to /login rather than offering a form the backend will 409
 *   · db_ready — with no role/page rows the submit can only fail; Next is held and
 *     the fix is named, instead of letting them fill three steps first
 *   · validation mirrors the backend's exactly (name, e-mail shape, username,
 *     6-char password), so the form never passes something the API rejects
 */

const STEPS = ['Welcome', 'Your details', 'Account', 'Finish'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const errText = (e) => e?.response?.data?.detail || e?.message || 'Something went wrong.';

const BLANK = {
  employee_name: '', email: '', mobile: '', employee_code: '',
  username: '', password: '', confirm: '',
};

export default function FirstRunSetup() {
  const navigate = useNavigate();

  const [checking, setChecking] = useState(true);
  const [orgName, setOrgName] = useState('');
  const [dbReady, setDbReady] = useState(true);

  const [step, setStep] = useState(0);
  const [d, setD] = useState(BLANK);
  const [touched, setTouched] = useState({});
  const [showPw, setShowPw] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  const set = (k) => (e) => setD((p) => ({ ...p, [k]: e.target.value }));
  const touch = (k) => () => setTouched((p) => ({ ...p, [k]: true }));

  /* Gate: this page exists only while the system has no users. */
  useEffect(() => {
    let alive = true;
    getSetupStatus()
      .then((s) => {
        if (!alive) return;
        if (!s?.needs_setup) { navigate('/login', { replace: true }); return; }
        setOrgName(s.org_name || '');
        setDbReady(!!s.db_ready);
        setChecking(false);
      })
      .catch(() => {
        /* A failure here almost always means the database isn't provisioned — show
           the wizard with that warning rather than a blank screen. */
        if (alive) { setDbReady(false); setChecking(false); }
      });
    return () => { alive = false; };
  }, [navigate]);

  const emailOk = EMAIL_RE.test(d.email.trim());
  const detailsOk = d.employee_name.trim().length > 0 && emailOk;
  const accountOk = d.username.trim().length >= 3 && d.password.length >= 6 && d.password === d.confirm;
  const stepOk = [dbReady, detailsOk, accountOk, true][step];

  const err = {
    employee_name: touched.employee_name && !d.employee_name.trim() ? 'A name is required.' : '',
    email: touched.email && !emailOk ? 'Enter a valid e-mail address.' : '',
    username: touched.username && d.username.trim().length < 3 ? 'At least 3 characters.' : '',
    password: touched.password && d.password.length < 6 ? 'At least 6 characters.' : '',
    confirm: touched.confirm && d.confirm !== d.password ? 'The passwords do not match.' : '',
  };

  /* Blocked Next marks the step's fields touched, so the reason becomes visible
     instead of the button just refusing silently. */
  const next = () => {
    if (stepOk) { setStep((s) => Math.min(s + 1, STEPS.length - 1)); return; }
    if (step === 1) setTouched((p) => ({ ...p, employee_name: true, email: true }));
    if (step === 2) setTouched((p) => ({ ...p, username: true, password: true, confirm: true }));
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const r = await createAdmin({
        employee_name: d.employee_name.trim(),
        email: d.email.trim(),
        mobile: d.mobile.trim(),
        employee_code: d.employee_code.trim(),
        username: d.username.trim(),
        password: d.password,
      });
      setDone(r);
      setD((p) => ({ ...p, password: '', confirm: '' })); // don't keep it in state
      setStep(3);
    } catch (e) {
      setError(errText(e));
    } finally {
      setSubmitting(false);
    }
  };

  /* The gate check renders inside the same frame, not a bare full-page spinner —
     otherwise the first paint is one layout and the second is another. */
  if (checking) {
    return (
      <AuthShell width="lg" footnote="First-run setup">
        <PageLoading title="Checking setup…" />
      </AuthShell>
    );
  }

  return (
    <AuthShell
      width="lg"
      headline={<>Let&rsquo;s get<br />ActMon running</>}
      blurb="A few details and your Super Admin account is ready. From there you can add database servers, deploy agents and invite the rest of your team."
      features={[['shield', 'Super Admin'], ['users', 'RBAC ready'], ['database', 'All engines']]}
      footnote="First-run setup"
    >
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-fg">
          {step === 3 ? 'All set' : 'Welcome to ActMon'}
        </h2>
        <p className="mt-1 text-[13px] text-muted">
          First-run setup{orgName ? <> · <span className="font-semibold text-fg">{orgName}</span></> : null}
        </p>
      </div>

      <Steps steps={STEPS} current={step} className="mb-7" />

      {!dbReady && step === 0 && (
        <Notice tone="warning" title="Database not provisioned.">
          Run <span className="font-mono font-semibold">python install.py</span> (or just its
          database step) first, then reload this page.
        </Notice>
      )}

      {/* ── 0 · Welcome ── */}
      {step === 0 && (
        <div className="py-2 text-center">
          <span className="mx-auto grid h-16 w-16 place-items-center rounded-card bg-accent-soft text-accent-text">
            <Icon name="database" size={30} />
          </span>
          <h3 className="mt-4 text-lg font-bold text-fg">Create your Super Admin</h3>
          <p className="mx-auto mt-2 max-w-sm text-[13px] text-muted">
            The database already has the Super Admin role and every page permission.
            All that&rsquo;s left is the account that owns them — it takes a minute.
          </p>
        </div>
      )}

      {/* ── 1 · Your details ── */}
      {step === 1 && (
        <div className="space-y-4">
          <p className="text-[13px] text-muted">
            Who is the administrator? Fields marked <span className="text-danger-fg">*</span> are required.
          </p>

          <AuthField id="employee_name" label="Full name" icon="user" required error={err.employee_name}>
            <Input
              id="employee_name"
              value={d.employee_name}
              onChange={set('employee_name')}
              onBlur={touch('employee_name')}
              placeholder="e.g. Suyash Gaikwad"
              autoComplete="name"
              autoFocus
            />
          </AuthField>

          <AuthField
            id="email"
            label="E-mail"
            icon="mail"
            required
            error={err.email}
            hint="Sign-in codes are sent here, so it has to be a mailbox you can read."
          >
            <Input
              id="email"
              type="email"
              value={d.email}
              onChange={set('email')}
              onBlur={touch('email')}
              placeholder="you@company.com"
              autoComplete="email"
            />
          </AuthField>

          <div className="grid gap-4 sm:grid-cols-2">
            <AuthField id="mobile" label="Mobile" icon="phone" hint="Optional">
              <Input
                id="mobile"
                value={d.mobile}
                onChange={set('mobile')}
                placeholder="Optional"
                autoComplete="tel"
              />
            </AuthField>
            <AuthField id="employee_code" label="Employee code" icon="id-card" hint="Optional — EMP001 if blank">
              <Input id="employee_code" value={d.employee_code} onChange={set('employee_code')} placeholder="EMP001" />
            </AuthField>
          </div>
        </div>
      )}

      {/* ── 2 · Account ── */}
      {step === 2 && (
        <div className="space-y-4">
          <p className="text-[13px] text-muted">Choose the sign-in credentials for this administrator.</p>

          <AuthField id="new_username" label="Username" icon="user" required error={err.username}>
            <Input
              id="new_username"
              value={d.username}
              onChange={set('username')}
              onBlur={touch('username')}
              placeholder="superadmin"
              autoComplete="username"
              autoFocus
            />
          </AuthField>

          <AuthField id="new_password" label="Password" icon="key" required error={err.password}>
            <div className="relative flex items-center">
              <Input
                id="new_password"
                type={showPw ? 'text' : 'password'}
                value={d.password}
                onChange={set('password')}
                onBlur={touch('password')}
                placeholder="At least 6 characters"
                autoComplete="new-password"
                className="pr-9"
                wrapperClassName="flex-1"
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                aria-label={showPw ? 'Hide password' : 'Show password'}
                className="absolute right-2 grid h-6 w-6 place-items-center rounded-sm text-subtle transition-colors hover:text-fg"
              >
                <Icon name="eye" size={15} />
              </button>
            </div>
          </AuthField>

          <AuthField id="confirm_password" label="Confirm password" icon="key" required error={err.confirm}>
            <Input
              id="confirm_password"
              type={showPw ? 'text' : 'password'}
              value={d.confirm}
              onChange={set('confirm')}
              onBlur={touch('confirm')}
              placeholder="Re-enter the password"
              autoComplete="new-password"
            />
          </AuthField>
        </div>
      )}

      {/* ── 3 · Finish ── */}
      {step === 3 && done && (
        <div className="py-2 text-center">
          <span className="mx-auto grid h-16 w-16 place-items-center rounded-card bg-success-soft text-success-fg">
            <Icon name="celebrate" size={30} />
          </span>
          <h3 className="mt-4 text-lg font-bold text-fg">You&rsquo;re ready to sign in</h3>
          <p className="mt-2 text-[13px] text-muted">
            Super Admin <span className="font-semibold text-fg">{done.username}</span> was created with full access.
          </p>

          <dl className="mx-auto mt-5 max-w-sm space-y-1.5 rounded-card border border-border bg-sunken p-4 text-left text-[13px]">
            {[
              ['Name', d.employee_name],
              ['E-mail', d.email],
              ['Username', done.username],
              ['Role', `${done.role || 'Super Admin'} (all pages)`],
            ].map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <dt className="w-20 shrink-0 text-subtle">{k}</dt>
                <dd className="min-w-0 truncate-safe font-medium text-fg">{v}</dd>
              </div>
            ))}
          </dl>

          <Notice tone="info" className="mx-auto mt-5 max-w-sm text-left" title="One more step at sign-in.">
            Every sign-in sends a 6-digit code to the e-mail above.
          </Notice>

          <Button
            variant="primary"
            size="lg"
            className="mt-5"
            iconRight="chevron-right"
            onClick={() => navigate('/login', { replace: true })}
          >
            Go to sign in
          </Button>
        </div>
      )}

      {error && step !== 3 && <Notice tone="danger" className="mt-4 mb-0" title="Setup failed.">{error}</Notice>}

      {/* ── Footer ── */}
      {step !== 3 && (
        <div className="mt-8 flex items-center justify-between gap-3 border-t border-border pt-5">
          <Button
            variant="secondary"
            icon="chevron-left"
            disabled={step === 0}
            onClick={() => { setError(null); setStep((s) => Math.max(s - 1, 0)); }}
          >
            Back
          </Button>

          {step < 2 ? (
            <Button variant="primary" iconRight="chevron-right" disabled={!stepOk} onClick={next}>
              Next
            </Button>
          ) : (
            <Button
              variant="primary"
              icon="check"
              loading={submitting}
              disabled={!accountOk}
              onClick={submit}
            >
              Create Super Admin
            </Button>
          )}
        </div>
      )}
    </AuthShell>
  );
}
