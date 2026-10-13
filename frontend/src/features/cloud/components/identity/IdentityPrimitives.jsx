import cn from '@/lib/cn';
import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import { providerBadgeStyle } from '../../utils/providerTheme';

/**
 * Shared atoms for Identity & Access.
 *
 * Two rules run through all of them, and both exist because the alternative
 * puts a false statement in front of an operator:
 *
 * **"Not assessed" never renders as a low number.** A principal whose policies
 * could not be read is UNKNOWN, and `PrivilegeBadge` gives it its own neutral
 * chip with a tooltip saying so. Rendering it as "Read-only" — or as a blank
 * cell, which reads the same way — would turn a coverage gap into reassurance.
 *
 * **A count without its denominator is not shown.** `Tile` takes an explicit
 * `unknown` prop and renders a dash with a reason rather than a zero, so
 * "0 privileged identities" cannot appear over an account whose RBAC
 * collection was refused.
 */

// ── Privilege ───────────────────────────────────────────────────────────────
const PRIVILEGE_TONE = {
  ADMIN: 'danger',
  PRIVILEGED: 'warning',
  STANDARD: 'info',
  READ_ONLY: 'neutral',
  UNKNOWN: 'outline',
};

const PRIVILEGE_LABEL = {
  ADMIN: 'Administrative',
  PRIVILEGED: 'Privileged',
  STANDARD: 'Standard',
  READ_ONLY: 'Read-only',
  UNKNOWN: 'Not assessed',
};

const PRIVILEGE_HINT = {
  UNKNOWN: 'This identity\'s policies could not be read, so its permissions are '
    + 'unknown. It is NOT counted as unprivileged.',
  ADMIN: 'Holds unrestricted control, or can grant itself any further permission.',
  PRIVILEGED: 'Holds at least one capability from the high-impact catalog.',
  READ_ONLY: 'Can observe; the evaluated permissions confer no change.',
};

export function PrivilegeBadge({ level, size = 'xs' }) {
  const key = level || 'UNKNOWN';
  return (
    <Badge tone={PRIVILEGE_TONE[key] || 'outline'} size={size} title={PRIVILEGE_HINT[key]}>
      {PRIVILEGE_LABEL[key] || key}
    </Badge>
  );
}

// ── MFA ─────────────────────────────────────────────────────────────────────
const MFA_TONE = {
  ENABLED: 'success',
  DISABLED: 'danger',
  UNKNOWN: 'outline',
  NOT_APPLICABLE: 'neutral',
};

const MFA_LABEL = {
  ENABLED: 'MFA on',
  DISABLED: 'No MFA',
  UNKNOWN: 'MFA unknown',
  NOT_APPLICABLE: 'N/A',
};

const MFA_HINT = {
  UNKNOWN: 'The provider did not report MFA registration for this identity. '
    + 'This is a data gap, not a finding.',
  NOT_APPLICABLE: 'Workload identity — it has no interactive sign-in, so MFA does '
    + 'not apply to it.',
  DISABLED: 'The provider reports no registered MFA device.',
};

export function MfaBadge({ state, size = 'xs' }) {
  const key = state || 'UNKNOWN';
  return (
    <Badge tone={MFA_TONE[key] || 'outline'} size={size} title={MFA_HINT[key]}>
      {MFA_LABEL[key] || key}
    </Badge>
  );
}

// ── Decision ────────────────────────────────────────────────────────────────
const DECISION_TONE = {
  ALLOWED: 'danger',
  ALLOWED_UNVERIFIED: 'warning',
  DENIED: 'success',
  IMPLICIT_DENY: 'neutral',
  NOT_DETERMINED: 'outline',
};

const DECISION_LABEL = {
  ALLOWED: 'Allowed',
  ALLOWED_UNVERIFIED: 'Allowed (unverified)',
  DENIED: 'Denied — explicit',
  IMPLICIT_DENY: 'Denied — no grant',
  NOT_DETERMINED: 'Could not determine',
};

/**
 * ALLOWED is `danger` and DENIED is `success` on purpose. This is a security
 * surface: access being granted is the thing worth noticing, and colouring
 * "allowed" green would read as approval of it.
 */
export function DecisionBadge({ decision, certain = true, size = 'xs' }) {
  const key = decision || 'NOT_DETERMINED';
  return (
    <Badge
      tone={DECISION_TONE[key] || 'outline'}
      size={size}
      title={certain ? undefined
        : 'At least one link of the provider\'s decision chain was unavailable, so '
          + 'this is "nothing we can see stops it" rather than a verified allow.'}
    >
      {DECISION_LABEL[key] || key}
      {!certain && <Icon name="info" size={11} />}
    </Badge>
  );
}

// ── Usage ───────────────────────────────────────────────────────────────────
const USAGE_TONE = {
  OBSERVED: 'success',
  NOT_OBSERVED_HIGH_CONFIDENCE: 'warning',
  NOT_OBSERVED_LOW_CONFIDENCE: 'neutral',
  UNKNOWN: 'outline',
};

const USAGE_LABEL = {
  OBSERVED: 'Observed',
  NOT_OBSERVED_HIGH_CONFIDENCE: 'Not observed',
  NOT_OBSERVED_LOW_CONFIDENCE: 'Not observed (low confidence)',
  UNKNOWN: 'No usable data',
};

export function UsageBadge({ state, reason, size = 'xs' }) {
  const key = state || 'UNKNOWN';
  return (
    <Badge tone={USAGE_TONE[key] || 'outline'} size={size} title={reason || undefined}>
      {USAGE_LABEL[key] || key}
    </Badge>
  );
}

// ── Provider ────────────────────────────────────────────────────────────────
/** Uses the shared provider theme so the chip mixes against the live theme. */
export function ProviderBadge({ provider, size = 'xs' }) {
  if (!provider) return null;
  return (
    <Badge size={size} style={providerBadgeStyle(provider)}>
      {String(provider).toUpperCase()}
    </Badge>
  );
}

// ── External ────────────────────────────────────────────────────────────────
export function ExternalBadge({ state, size = 'xs' }) {
  if (!state || state === 'INTERNAL') return null;
  const tone = state === 'ANONYMOUS' ? 'danger' : state === 'EXTERNAL' ? 'warning' : 'outline';
  const label = state === 'ANONYMOUS' ? 'Any principal'
    : state === 'EXTERNAL' ? 'External' : 'Origin unknown';
  const hint = state === 'ANONYMOUS'
    ? 'A wildcard principal: this is not cross-account access, it is public access.'
    : state === 'UNKNOWN'
      ? 'The principal could not be resolved to an account or tenant, so whether it '
        + 'is external is unknown. It is shown rather than assumed internal.'
      : 'A principal from outside this account or tenant. External is a fact, not a '
        + 'verdict — review the risk factors.';
  return <Badge tone={tone} size={size} title={hint}>{label}</Badge>;
}

// ── Dashboard tile ──────────────────────────────────────────────────────────
/**
 * A count tile. `unknown` renders a dash with a reason instead of a number,
 * which is the only honest rendering when the figure is not knowable.
 */
export function Tile({ label, value, detail, tone, unknown, unknownReason, onClick, icon }) {
  const interactive = typeof onClick === 'function';
  const Wrapper = interactive ? 'button' : 'div';
  return (
    <Wrapper
      type={interactive ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'min-w-0 rounded-control border border-border bg-surface px-3 py-2.5 text-left',
        interactive && 'transition-colors hover:border-accent focus:outline-none '
          + 'focus-visible:ring-2 focus-visible:ring-accent',
      )}
      title={unknown ? unknownReason : detail}
    >
      <div className="flex items-center gap-1.5">
        {icon && <Icon name={icon} size={12} className="shrink-0 text-muted" />}
        <span className="truncate-safe text-micro font-semibold uppercase tracking-wider text-muted">
          {label}
        </span>
      </div>
      <div className={cn('mt-1 text-[18px] font-bold tabular-nums',
        unknown ? 'text-muted' : tone || 'text-fg')}
      >
        {unknown ? '—' : value}
      </div>
      {(unknown ? unknownReason : detail) && (
        <div className="truncate-safe text-micro text-subtle">
          {unknown ? unknownReason : detail}
        </div>
      )}
    </Wrapper>
  );
}

// ── Coverage ────────────────────────────────────────────────────────────────
/**
 * The banner that keeps every number on this page honest. Rendered whenever
 * the analysis is missing, partial, or could not evaluate some principals.
 */
export function CoverageNote({ analysis, coverage, className }) {
  if (!analysis) return null;
  const status = analysis.status;
  const notRun = !status || status === 'NeverRun';
  const notAssessed = coverage?.not_assessed || analysis.unevaluated_count || 0;
  if (!notRun && status === 'Complete' && !notAssessed) return null;

  const tone = notRun || status === 'Failed' ? 'border-danger' : 'border-warning';
  return (
    <div className={cn('rounded-control border bg-surface px-3 py-2', tone, className)}>
      <div className="flex items-start gap-2">
        <Icon name="info" size={14} className="mt-0.5 shrink-0 text-muted" />
        <div className="min-w-0 text-[12px] leading-relaxed text-fg">
          {notRun && (
            <p>
              The identity analysis has never run for this account.
              {' '}
              <span className="text-muted">
                Nothing on this page is a statement about the estate — use
                “Refresh identity &amp; access” to collect and evaluate it.
              </span>
            </p>
          )}
          {!notRun && status === 'Failed' && (
            <p>
              The last identity analysis failed.
              {analysis.error_detail && (
                <span className="mt-0.5 block text-meta text-subtle">
                  {analysis.error_detail}
                </span>
              )}
            </p>
          )}
          {!notRun && notAssessed > 0 && (
            <p>
              {notAssessed}
              {' '}
              identit
              {notAssessed === 1 ? 'y was' : 'ies were'}
              {' '}
              not assessed — their policies or role assignments could not be read.
              <span className="mt-0.5 block text-meta text-subtle">
                They are excluded from every privilege count below rather than counted
                as unprivileged.
              </span>
            </p>
          )}
          {Array.isArray(analysis.missing_stages) && analysis.missing_stages.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {analysis.missing_stages.slice(0, 4).map((gap, i) => (
                <li key={`${gap.stage}-${i}`} className="text-meta text-subtle">
                  <span className="font-semibold text-muted">{gap.stage}</span>
                  {gap.missing_permission && (
                    <>
                      {' — grant '}
                      <code className="rounded bg-neutral-soft px-1">
                        {gap.missing_permission}
                      </code>
                    </>
                  )}
                  {gap.detail && !gap.missing_permission && ` — ${gap.detail}`}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Window ──────────────────────────────────────────────────────────────────
/** The observation period, rendered wherever a usage number is. Never omitted. */
export function WindowNote({ window: w, className }) {
  if (!w) {
    return (
      <p className={cn('text-meta text-subtle', className)}>
        No observation window — no usage analysis has run.
      </p>
    );
  }
  return (
    <p className={cn('text-meta text-subtle', className)}>
      Observation window:
      {' '}
      <span className="font-semibold text-muted">
        {w.days}
        {' days'}
      </span>
      {typeof w.events_in_window === 'number' && (
        <>
          {' · '}
          {w.events_in_window.toLocaleString()}
          {' events analysed'}
        </>
      )}
      {w.start && w.end && (
        <>
          {' · '}
          {String(w.start).slice(0, 10)}
          {' to '}
          {String(w.end).slice(0, 10)}
        </>
      )}
    </p>
  );
}

// ── Empty / unknown value ───────────────────────────────────────────────────
export function Unknown({ reason, children }) {
  return (
    <span className="text-muted" title={reason}>
      {children || 'Unknown'}
      {reason && <span className="mt-0.5 block text-micro text-subtle">{reason}</span>}
    </span>
  );
}

/** A relative date that renders "Never reported" rather than an invented one. */
export function LastUsed({ at, source }) {
  if (!at) {
    return (
      <span className="text-muted" title="The provider did not report a last-used date.">
        Not reported
      </span>
    );
  }
  const date = new Date(at);
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  return (
    <span title={source ? `Source: ${source}` : undefined}>
      {date.toISOString().slice(0, 10)}
      <span className="ml-1 text-meta text-subtle">
        {days <= 0 ? 'today' : `${days}d ago`}
      </span>
    </span>
  );
}
