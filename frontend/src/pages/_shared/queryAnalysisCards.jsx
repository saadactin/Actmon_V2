/**
 * The cards shared by Query Analysis and Execution Plan.
 *
 * Colour here is meaning, not decoration: the three action cards are told
 * apart by hue because they lead to three different places, and a metric or
 * insight card takes its tone from the value it is showing. Everything draws
 * on the app's existing tokens rather than a second palette, so these pages
 * follow the operator's theme like the rest of ACTMON.
 *
 * Every card distinguishes "no finding" from "could not be determined": a
 * value of `null` renders "Not available", a value of 0 renders 0. On a strip
 * of four confident numbers that difference is the whole point.
 */
import Icon from '@/components/ui/Icon';
import { cn } from '@/lib/cn';

const NA = <span className="text-subtle">Not available</span>;

const ACTION_TONES = {
  primary: {
    card: 'border-transparent text-white',
    style: { background: 'linear-gradient(135deg, var(--accent), var(--accent-active, var(--accent)))' },
    icon: 'bg-white/20 text-white',
    sub: 'text-white/85',
    arrow: 'text-white/90',
  },
  success: {
    card: 'border-success-soft bg-success-soft/50 text-fg',
    icon: 'bg-success-soft text-success-fg',
    sub: 'text-muted',
    arrow: 'text-success-fg',
    title: 'text-success-fg',
  },
  accent: {
    card: 'border-accent-border bg-accent-softer text-fg',
    icon: 'bg-accent-soft text-accent-text',
    sub: 'text-muted',
    arrow: 'text-accent-text',
    title: 'text-accent-text',
  },
};

/**
 * One of the "What's next?" cards. Rendered as a button, because every one of
 * them does something — a card that only looked clickable would be worse than
 * no card.
 */
export function ActionCard({ icon, title, body, tone = 'accent', onClick, disabled, busy }) {
  const t = ACTION_TONES[tone] || ACTION_TONES.accent;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={cn(
        'group flex w-full items-start gap-3 rounded-card border p-card text-left transition-all',
        t.card,
        disabled ? 'cursor-not-allowed opacity-55' : 'hover:shadow-md',
      )}
      style={t.style}
    >
      <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-control', t.icon)}>
        <Icon name={busy ? 'spinner' : icon} size={18} className={busy ? 'animate-spin' : undefined} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block text-[15px] font-black leading-tight', t.title)}>{title}</span>
        <span className={cn('mt-1 block text-[12px] leading-snug', t.sub)}>{body}</span>
      </span>
      <Icon
        name="chevron-right"
        size={16}
        className={cn('mt-0.5 shrink-0 transition-transform group-hover:translate-x-0.5', t.arrow)}
      />
    </button>
  );
}

const METRIC_TONES = {
  danger: { icon: 'bg-danger-soft text-danger-fg', value: 'text-danger-fg' },
  warning: { icon: 'bg-warning-soft text-warning-fg', value: 'text-warning-fg' },
  success: { icon: 'bg-success-soft text-success-fg', value: 'text-success-fg' },
  accent: { icon: 'bg-accent-soft text-accent-text', value: 'text-fg' },
  neutral: { icon: 'bg-sunken text-muted', value: 'text-fg' },
};

/** A figure with its label — the metric strip and the Related-information
 *  strip are the same card at two sizes. */
export function MetricCard({ icon, label, value, sub, tone = 'accent', compact }) {
  const t = METRIC_TONES[tone] || METRIC_TONES.accent;
  const shown = value === null || value === undefined || value === '' ? NA : value;
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-card border border-border bg-surface px-3 py-2.5">
      <span className={cn('grid shrink-0 place-items-center rounded-control', t.icon, compact ? 'h-8 w-8' : 'h-9 w-9')}>
        <Icon name={icon} size={compact ? 14 : 16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate-safe text-[11px] font-bold uppercase tracking-wide text-muted">{label}</span>
        <span className={cn('block truncate-safe font-black leading-tight', compact ? 'text-[14px]' : 'text-[17px]', t.value)}>
          {shown}
        </span>
        {sub && <span className="block truncate-safe text-[11px] text-subtle">{sub}</span>}
      </span>
    </div>
  );
}

/**
 * A Quick-insight card.
 *
 * `count` null means the plan could not tell us — which is NOT the same as
 * zero, and reads differently here on purpose. A real 0 is a finding ("no full
 * table scans") and is shown in the neutral tone rather than the alarming one.
 */
export function InsightCard({ icon, label, count, unit, goodWhenZero = true, note, tone: toneProp }) {
  const unavailable = count === null || count === undefined;
  const tone = toneProp || (unavailable ? 'neutral'
    : (goodWhenZero && count === 0) ? 'success'
      : count > 0 ? 'warning' : 'neutral');
  const t = METRIC_TONES[tone] || METRIC_TONES.neutral;
  return (
    <div className={cn(
      'flex min-w-0 items-center gap-2.5 rounded-card border px-3 py-2.5',
      tone === 'warning' ? 'border-warning-soft bg-warning-soft/40'
        : tone === 'success' ? 'border-success-soft bg-success-soft/30'
          : 'border-border bg-surface',
    )}>
      <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-control', t.icon)}>
        <Icon name={icon} size={16} />
      </span>
      {/* A column, not three stacked inline spans: at 18px the value's own line
          box overlapped the note under it. */}
      <span className="flex min-w-0 flex-1 flex-col justify-center leading-tight">
        <span className="truncate-safe text-[12px] font-bold text-fg">{label}</span>
        <span className={cn('text-[18px] font-black leading-[1.15]', t.value)}>
          {unavailable ? NA : (
            <>
              {typeof count === 'number' ? count.toLocaleString() : count}
              {unit ? <span className="ml-1 text-[12px] font-bold">{unit}</span> : null}
            </>
          )}
        </span>
        {note && <span className="truncate-safe text-[11px] text-subtle">{note}</span>}
      </span>
    </div>
  );
}

/**
 * A full-table-scan warning. One per table, never per plan step — see
 * `fullScanWarnings` for why that distinction matters.
 */
export function ScanWarning({ warning }) {
  const name = warning.object
    ? `${warning.owner ? `${warning.owner}.` : ''}${warning.object}`
    : `Step ${warning.steps[0]}`;
  return (
    <div className="flex items-start gap-2.5 rounded-card border border-danger-soft bg-danger-soft/40 px-3 py-2.5">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-control bg-danger-soft text-danger-fg">
        <Icon name="alert" size={15} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-black text-danger-fg">Full table scan</span>
        <span className="block truncate-safe font-mono text-[12px] text-fg">{name}</span>
        <span className="mt-0.5 block text-[11px] leading-snug text-muted">
          {warning.rows === null
            ? 'The optimizer gave no row estimate for this step.'
            : <>Reads an estimated <strong>{warning.rows.toLocaleString()}</strong> rows.</>}
          {warning.steps.length > 1
            ? ` Scanned at steps ${warning.steps.join(', ')}.`
            : ` At step ${warning.steps[0]}.`}
          {' '}Every row is read to satisfy the predicate; an index on the filtered
          column would let Oracle skip most of them.
        </span>
      </span>
    </div>
  );
}

/** Section heading with the numbered marker the page uses. */
export function SectionHead({ n, title, subtitle, actions }) {
  return (
    <header className="mb-gutter-sm flex flex-wrap items-start gap-2.5">
      {n !== undefined && (
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent text-[13px] font-black text-accent-fg">
          {n}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <h2 className="text-[16px] font-black leading-tight text-fg">{title}</h2>
        {subtitle && <p className="mt-0.5 text-[12px] text-muted">{subtitle}</p>}
      </span>
      {actions}
    </header>
  );
}
