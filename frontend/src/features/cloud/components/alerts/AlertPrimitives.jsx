import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import cn from '@/lib/cn';
import { relativeTime } from '../../utils/resourceModel';
import {
  CATEGORY_META, NOTIFICATION_META, RESULT_META, SEVERITY_META, STATE_META,
  categoryMeta, humanDuration, notificationMeta, resultMeta, severityMeta,
} from '../../utils/alertModel';

/**
 * Shared rendering for the Alerts tab.
 *
 * The VOCABULARY — what a severity, an evaluation state, a lifecycle state or a
 * notification status means — lives in `utils/alertModel.js`, not here. Two
 * reasons. It is the part that can be wrong in a way nobody sees (UNKNOWN
 * quietly painted as healthy), so it needs to be testable without a DOM; and
 * keeping one mapping rather than a `tone` guess per call site is what stops
 * two panels disagreeing about whether "could not evaluate" is a warning.
 *
 * Every badge carries its word as well as its colour. Colour alone never
 * carries meaning here.
 */

// Re-exported so callers do not have to know which half of the pair a name
// lives in, and so this stays the single import for the whole tab.
export {
  CATEGORY_META, NOTIFICATION_META, RESULT_META, SEVERITY_META, STATE_META,
  categoryMeta, humanDuration, notificationMeta, resultMeta, severityMeta,
};

export function SeverityBadge({ severity, size = 'sm' }) {
  const meta = severityMeta(severity);
  return (
    <Badge tone={meta.tone} size={size}>
      <Icon name={meta.icon} size={11} />
      {meta.label}
    </Badge>
  );
}

export function ResultBadge({ state, size = 'sm' }) {
  const meta = resultMeta(state);
  return (
    <Badge tone={meta.tone} size={size} title={meta.help}>
      <Icon name={meta.icon} size={11} />
      {meta.label}
    </Badge>
  );
}

export function StateBadge({ state, size = 'sm' }) {
  const meta = STATE_META[state] || { tone: 'neutral', label: state || '—' };
  return <Badge tone={meta.tone} size={size}>{meta.label}</Badge>;
}

export function NotificationBadge({ status, size = 'sm' }) {
  // No attempt recorded is its own state — not "failed", and not a blank cell
  // that reads as "nothing to see here". Rendered as plain text rather than a
  // badge so it does not compete with the statuses that mean something.
  if (!status) {
    return (
      <span
        className="text-meta text-subtle"
        title="No notification attempt is recorded for this alert."
      >
        Not attempted
      </span>
    );
  }
  const meta = notificationMeta(status);
  return <Badge tone={meta.tone} size={size} title={meta.help}>{meta.label}</Badge>;
}

/** A timestamp that says "never" rather than rendering an empty cell — the
 *  difference between "this has not run" and "we forgot to show it". */
export function When({ iso, never = 'Never', title }) {
  if (!iso) return <span className="text-subtle" title={title}>{never}</span>;
  const rel = relativeTime(iso);
  return (
    <span title={new Date(iso).toLocaleString()}>
      {rel || new Date(iso).toLocaleString()}
    </span>
  );
}

/** A number that is genuinely unknown renders as NA, never as 0. */
export const Count = ({ value, suffix = '' }) => (
  typeof value === 'number'
    ? <span className="tabular-nums">{value.toLocaleString()}{suffix}</span>
    : <span className="text-subtle" title="Not reported">NA</span>
);

/** The banner that appears whenever email cannot actually be delivered.
 *  Names every blocker separately, because "email is not working" is four
 *  different problems with four different fixes. */
export function DeliveryBanner({ delivery, onFix, fixing, className }) {
  if (!delivery || delivery.ready) return null;
  const fixable = (delivery.blockers || []).some((b) => b.fixable_here);
  return (
    <div className={cn(
      'flex flex-wrap items-start gap-3 rounded-control border border-warning bg-warning-soft px-3 py-2.5',
      className,
    )}
    >
      <Icon name="alert" size={15} className="mt-0.5 shrink-0 text-warning-fg" />
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-semibold text-fg">
          Alerts will be recorded, but no email can be delivered
        </p>
        <ul className="mt-1 space-y-0.5">
          {(delivery.blockers || []).map((b) => (
            <li key={b.code} className="text-meta leading-snug text-muted">{b.message}</li>
          ))}
        </ul>
      </div>
      {fixable && onFix && (
        <button
          type="button"
          onClick={onFix}
          disabled={fixing}
          className="shrink-0 rounded-control border border-border bg-surface px-2.5 py-1 text-meta font-semibold text-fg hover:bg-sunken disabled:opacity-50"
        >
          {fixing ? 'Enabling…' : 'Enable email delivery'}
        </button>
      )}
    </div>
  );
}

/** "Why did this fire?" — the evaluation snapshot, rendered from the same
 *  numbers the decision used. A missing value shows NA and says why. */
export function WhyPanel({ explain, className }) {
  if (!explain) {
    return (
      <p className={cn('text-[12px] text-muted', className)}>
        No evaluation snapshot was recorded for this alert. Alerts raised before
        rules existed do not carry one.
      </p>
    );
  }
  const rows = [
    ['Condition', explain.condition],
    ['Expected', explain.threshold_label && explain.operator
      ? `${explain.operator.replace(/_/g, ' ')} ${explain.threshold_label}`
      : null],
    ['Observed', explain.observed_label],
    ['Result', explain.result],
    ['Data as of', explain.as_of ? new Date(explain.as_of).toLocaleString() : null],
  ].filter(([, v]) => v);

  return (
    <div className={cn('rounded-control border border-border bg-sunken p-3', className)}>
      <dl className="space-y-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-3 text-[12px]">
            <dt className="w-24 shrink-0 text-muted">{k}</dt>
            <dd className="min-w-0 font-medium text-fg">{v}</dd>
          </div>
        ))}
      </dl>
      {explain.detail && (
        <p className="mt-2 border-t border-border pt-2 text-meta leading-snug text-muted">
          {explain.detail}
        </p>
      )}
      {!!explain.samples?.length && (
        <div className="mt-2 border-t border-border pt-2">
          <p className="mb-1 text-micro font-semibold uppercase tracking-wider text-subtle">
            Examples
          </p>
          <ul className="space-y-1">
            {explain.samples.map((s, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <li key={`${s.name}-${i}`} className="text-meta leading-snug">
                <span className="font-medium text-fg">{s.name}</span>
                {s.type && <span className="text-subtle"> · {s.type}</span>}
                {s.detail && <span className="block text-muted">{s.detail}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
