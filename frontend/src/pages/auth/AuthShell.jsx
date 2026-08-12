import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';

/**
 * The frame the two pre-session pages sit in: sign-in and first-run setup.
 *
 * These are the only screens outside the app shell — there is no sidebar, no top
 * bar and, on /setup, not even a user yet. They were going to end up as two
 * separate hand-built layouts that drift apart, so the brand panel, the card and
 * the small-screen logo live here once.
 *
 *   width     'md' for sign-in, 'lg' for the wizard (it holds two-column fields)
 *   blurb     the copy under the headline on the brand panel
 *   features  the chips along the bottom of the brand panel
 */

const DEFAULT_FEATURES = [
  ['database', 'Multi-DB'],
  ['activity', 'Real-time'],
  ['shield', 'Secure RBAC'],
];

export default function AuthShell({
  headline = <>Enterprise Database<br />Monitoring Platform</>,
  blurb = 'Real-time observability across MySQL, PostgreSQL, Oracle, SQL Server, MongoDB & ClickHouse — with role-based access control.',
  features = DEFAULT_FEATURES,
  footnote = 'Enterprise observability',
  width = 'md',
  children,
}) {
  return (
    <div className="flex min-h-screen bg-bg">
      {/* ── Brand panel ── */}
      <div className="relative hidden flex-col justify-between overflow-hidden bg-inverse p-12 text-on-inverse lg:flex lg:w-[46%]">
        {/* Graph-paper wash. currentColor so it inverts with the panel's own ink. */}
        <div
          className="absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage:
              'linear-gradient(currentColor 1px,transparent 1px),linear-gradient(90deg,currentColor 1px,transparent 1px)',
            backgroundSize: '32px 32px',
          }}
        />
        <div className="relative flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-card bg-accent text-accent-fg">
            <Icon name="shield" size={22} />
          </span>
          <span className="text-2xl font-bold tracking-tight">ActMon</span>
        </div>

        <div className="relative">
          <h1 className="text-4xl font-bold leading-tight tracking-tight">{headline}</h1>
          <p className="mt-4 max-w-md opacity-80">{blurb}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            {features.map(([icon, label]) => (
              <span
                key={label}
                className="flex items-center gap-2 rounded-card border border-current/15 bg-current/5 px-3.5 py-2"
              >
                <Icon name={icon} size={16} className="opacity-80" />
                <span className="text-sm font-semibold">{label}</span>
              </span>
            ))}
          </div>
        </div>

        <p className="relative text-[11px] font-bold tracking-widest uppercase opacity-50">
          {footnote}
        </p>
      </div>

      {/* ── Content panel ── */}
      <div className="flex flex-1 items-center justify-center p-6 sm:p-10">
        <div
          className={cn(
            'w-full rounded-card border border-border bg-surface p-8 shadow-lg sm:p-10',
            width === 'lg' ? 'max-w-2xl' : 'max-w-md',
          )}
        >
          {/* The brand panel is hidden below lg, so the logo has to reappear here. */}
          <div className="mb-7 flex items-center justify-center gap-2 lg:hidden">
            <span className="grid h-10 w-10 place-items-center rounded-card bg-accent text-accent-fg">
              <Icon name="shield" size={20} />
            </span>
            <span className="text-xl font-bold text-fg">ActMon</span>
          </div>

          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * A labelled field for the pre-session forms.
 *
 * Deliberately not `ui/Field` — that one is the settings-panel row (12px label,
 * optional inline layout). These forms want a stacked 13px label with a required
 * marker and one place for the error line, so the error never lands in a different
 * spot on one screen than another.
 */
export function AuthField({ id, label, icon, required, hint, error, children }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-fg">
        {icon && <Icon name={icon} size={14} className="text-subtle" />}
        {label}
        {required && <span className="text-danger-fg" aria-hidden="true">*</span>}
      </label>
      {children}
      {error ? (
        <p className="mt-1 text-[12px] text-danger-fg">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-[12px] text-subtle">{hint}</p>
      ) : null}
    </div>
  );
}
