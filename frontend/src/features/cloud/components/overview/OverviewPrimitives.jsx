import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import cn from '@/lib/cn';
import { relativeTime } from '../../utils/resourceModel';

/**
 * The Overview's shared building blocks.
 *
 * `Panel` exists so every widget on the page handles absence the same way.
 * The four states below are genuinely different and are never collapsed:
 *
 *   loading    we are still asking
 *   error      we asked and it failed — say why, keep the rest of the page
 *   empty      we asked, it answered, there is nothing
 *   unsupported the provider cannot answer this at all
 *
 * A dashboard that renders all four as a blank space or a zero is worse than
 * one that renders nothing, because the zero looks like an answer.
 */

export function Panel({
  title, icon, subtitle, scope, updatedAt, source, action, children,
  loading, error, empty, emptyMessage, className, dense,
}) {
  return (
    <section className={cn('card flex flex-col', className)}>
      <header className={cn(
        'flex flex-wrap items-start justify-between gap-2 border-b border-border px-4',
        dense ? 'py-2.5' : 'py-3',
      )}
      >
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-[13px] font-bold text-fg">
            {icon && <Icon name={icon} size={15} className="text-accent-text" />}
            {title}
          </h3>
          {/* Scope is stated, not assumed. A page where one card is
              account-wide and the next is region-scoped, with nothing saying
              so, invites conclusions that are simply wrong. */}
          {(subtitle || scope) && (
            <p className="mt-0.5 text-[11px] leading-snug text-muted">{subtitle || scope}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {updatedAt && (
            <span
              className="text-[10px] text-subtle"
              title={source ? `Source: ${source}` : undefined}
            >
              {relativeTime(updatedAt) ? `Updated ${relativeTime(updatedAt)}` : null}
            </span>
          )}
          {action}
        </div>
      </header>

      <div className={cn('min-h-0 flex-1', dense ? 'p-3' : 'p-4')}>
        {loading ? <PanelSkeleton />
          : error ? <PanelError error={error} />
            : empty ? <PanelEmpty>{emptyMessage}</PanelEmpty>
              : children}
      </div>
    </section>
  );
}

export const PanelSkeleton = ({ rows = 4 }) => (
  <div className="space-y-2">
    {Array.from({ length: rows }).map((_, i) => (
      // eslint-disable-next-line react/no-array-index-key
      <div key={i} className="h-5 animate-pulse rounded bg-sunken" />
    ))}
  </div>
);

/** A failed widget states what failed and stays out of the way of the rest of
 *  the page. It never renders as zero or as an empty chart. */
export function PanelError({ error }) {
  const envelope = error?.response?.data?.detail?.error;
  const category = envelope?.category;
  const message = envelope?.message
    || error?.response?.data?.detail
    || error?.message
    || 'This data could not be loaded.';

  const HINTS = {
    permission_denied: 'The credentials for this account are missing the permission this data needs.',
    authentication: 'The stored credentials were rejected by the provider.',
    rate_limited: 'The provider throttled the request. It will be retried.',
    unsupported: 'This provider integration does not report this data.',
    not_found: 'Nothing was found for this account.',
  };

  return (
    <div className="flex items-start gap-2 rounded-control border border-dashed border-border px-3 py-4 text-[12px]">
      <Icon name="alert" size={14} className="mt-0.5 shrink-0 text-warning-fg" />
      <div className="min-w-0">
        <p className="font-semibold text-fg">Unavailable</p>
        <p className="mt-0.5 leading-snug text-muted">
          {typeof message === 'string' ? message : 'This data could not be loaded.'}
        </p>
        {category && HINTS[category] && (
          <p className="mt-1 leading-snug text-subtle">{HINTS[category]}</p>
        )}
      </div>
    </div>
  );
}

export const PanelEmpty = ({ children }) => (
  <p className="rounded-control border border-dashed border-border px-3 py-6 text-center text-[12px] text-muted">
    {children || 'Nothing to show.'}
  </p>
);

/** A labelled horizontal bar. Used for types, regions, status and severity, so
 *  those four read as one family rather than four chart libraries. */
export function BarRow({
  label, value, total, tone = 'accent', onClick, suffix, title,
}) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  const Element = onClick ? 'button' : 'div';
  const TONE_BG = {
    accent: 'bg-accent',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
    info: 'bg-info',
    neutral: 'bg-neutral-soft',
  };

  return (
    <Element
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      title={title || `${label}: ${value}${total ? ` (${pct.toFixed(1)}%)` : ''}`}
      className={cn(
        'group grid w-full grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-2 rounded-control px-1 py-1 text-left',
        onClick && 'hover:bg-sunken',
      )}
    >
      <span className="truncate text-[12px] text-muted group-hover:text-fg">{label}</span>
      <span className="h-2 overflow-hidden rounded-full bg-sunken" aria-hidden="true">
        <span
          className={cn('block h-full rounded-full', TONE_BG[tone] || TONE_BG.accent)}
          style={{ width: `${Math.max(pct, value > 0 ? 2 : 0)}%` }}
        />
      </span>
      <span className="tabular-nums text-[12px] font-semibold text-fg">
        {value.toLocaleString()}
        {suffix}
      </span>
    </Element>
  );
}

/** One KPI. Clickable ones carry an arrow so it is visible which are. */
export function Kpi({
  label, value, sub, tone = 'neutral', icon, onClick, title, loading, unavailable,
}) {
  const Element = onClick ? 'button' : 'div';
  const TONE_TEXT = {
    danger: 'text-danger',
    warning: 'text-warning-fg',
    success: 'text-success-fg',
    neutral: 'text-fg',
  };

  return (
    <Element
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      title={title}
      className={cn(
        'card group px-4 py-3 text-left transition-colors',
        onClick && 'cursor-pointer hover:border-accent hover:bg-sunken',
      )}
    >
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
        {icon && <Icon name={icon} size={13} className="text-subtle" />}
        <span className="min-w-0 truncate">{label}</span>
        {onClick && (
          <Icon
            name="arrow-right"
            size={12}
            className="ml-auto shrink-0 text-subtle opacity-0 transition-opacity group-hover:opacity-100"
          />
        )}
      </div>
      {loading ? (
        <div className="h-7 w-20 animate-pulse rounded bg-sunken" />
      ) : (
        <div className={cn(
          'text-xl font-bold tabular-nums',
          unavailable ? 'text-subtle' : TONE_TEXT[tone] || TONE_TEXT.neutral,
        )}
        >
          {value}
        </div>
      )}
      {sub && <div className="mt-0.5 text-[11px] leading-snug text-muted">{sub}</div>}
    </Element>
  );
}

/** Freshness pill. Stale inventory must never look like fresh inventory. */
export function FreshnessBadge({ severity, label, title }) {
  const META = {
    FRESH: { tone: 'success', text: 'Fresh', icon: 'check' },
    AGING: { tone: 'info', text: 'Aging', icon: 'clock' },
    STALE: { tone: 'warning', text: 'Stale', icon: 'clock' },
    CRITICALLY_STALE: { tone: 'danger', text: 'Critically stale', icon: 'alert' },
    NEVER_SEEN: { tone: 'neutral', text: 'Never scanned', icon: 'help' },
  };
  const meta = META[severity] || META.NEVER_SEEN;
  return (
    <Badge tone={meta.tone} size="sm" title={title}>
      <Icon name={meta.icon} size={11} />
      {label || meta.text}
    </Badge>
  );
}

export const ViewLink = ({ onClick, children = 'View' }) => (
  <Button variant="ghost" size="sm" iconRight="arrow-right" onClick={onClick}>
    {children}
  </Button>
);
