/**
 * Shared presentation pieces for Cost Intelligence.
 *
 * These exist so the accuracy rules are enforced in ONE place rather than
 * re-decided per component:
 *
 *  - `Amount` renders NA (with a reason) when a value is missing, and a real 0
 *    as "0". No component formats money directly.
 *  - `Provenance` puts the source under every headline figure, so a price-list
 *    estimate can never be read as billed spend.
 *  - `ChartEmpty` is shown instead of an axis at zero when a provider returned
 *    nothing — an empty chart that looks like ₹0 is the single most misleading
 *    thing this page could draw.
 */
import { useState } from 'react';
import cn from '@/lib/cn';
import Badge from '@/components/ui/Badge';
import {
  AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight, HelpCircle, Info,
} from 'lucide-react';
import {
  NA, changeLabel, compact, exact, isMissing, relativeTime, sourceLabel,
} from '../../utils/costFormat';

/**
 * A money figure. Missing -> "NA" with an explanatory tooltip; present ->
 * compact text whose `title` carries the exact amount, because compacting
 * ₹4,523,727.04 to ₹45.23L loses precision the reader may need.
 */
export function Amount({ value, currency, reason, size = 'md', className }) {
  const missing = isMissing(value);
  const sizes = {
    xl: 'text-[26px] font-bold tracking-tight',
    lg: 'text-[20px] font-bold tracking-tight',
    md: 'text-[15px] font-semibold',
    sm: 'text-[13px] font-medium',
  };
  if (missing) {
    return (
      <span
        className={cn(sizes[size], 'text-muted inline-flex items-center gap-1', className)}
        title={reason || 'This value is not available from the provider.'}
      >
        {NA}
        {reason && <Info size={13} className="text-subtle" aria-hidden />}
        <span className="sr-only">
          {reason ? `Not available: ${reason}` : 'Not available'}
        </span>
      </span>
    );
  }
  return (
    <span
      className={cn(sizes[size], 'text-fg tabular-nums', className)}
      title={exact(value, currency)}
    >
      {compact(value, currency)}
    </span>
  );
}

/** Period-over-period change. Never renders an infinity; "New" when the
 *  previous period had no spend. Carries an arrow AND a word, so the meaning
 *  does not depend on colour alone. */
export function ChangeChip({ change, className }) {
  const { text, direction, tone, reason } = changeLabel(change);
  const Icon = direction === 'up' ? ArrowUpRight
    : direction === 'down' ? ArrowDownRight : ArrowRight;
  return (
    <Badge tone={tone} size="xs" className={className} title={reason || undefined}>
      <Icon size={11} aria-hidden />
      {text}
      <span className="sr-only">
        {direction === 'up' ? ' increase' : direction === 'down' ? ' decrease' : ''}
      </span>
    </Badge>
  );
}

/** Where a number came from. Rendered small, under the figure it describes. */
export function Provenance({ source, period, retrievedAt, cached, currency, className }) {
  const parts = [];
  if (source) parts.push(sourceLabel(source));
  if (currency) parts.push(currency);
  if (period?.start && period?.end) {
    parts.push(`${period.start} → ${period.end}`);
  }
  if (cached) parts.push('Cached');
  if (retrievedAt) parts.push(relativeTime(retrievedAt));
  if (!parts.length) return null;
  return (
    <p className={cn('text-[11px] text-subtle', className)}>{parts.join(' · ')}</p>
  );
}

/**
 * Empty state for a chart. Deliberately NOT an axis drawn at zero: a chart
 * whose provider returned nothing must say so, because a flat line at ₹0 reads
 * as "we spent nothing" rather than "we do not know".
 */
export function ChartEmpty({ title = 'No billing data available', reason, onWhy, height = 220 }) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 rounded-control border border-dashed border-border bg-sunken text-center"
      style={{ height }}
    >
      <AlertTriangle size={20} className="text-subtle" aria-hidden />
      <p className="text-[13px] font-medium text-muted">{title}</p>
      {reason && <p className="max-w-md px-4 text-[11px] text-subtle">{reason}</p>}
      {onWhy && (
        <button
          type="button"
          onClick={onWhy}
          className="inline-flex items-center gap-1 text-[11px] font-semibold text-accent-text hover:underline"
        >
          <HelpCircle size={12} aria-hidden />
          Why?
        </button>
      )}
    </div>
  );
}

/**
 * A control that a provider cannot answer. Stays VISIBLE and disabled with the
 * reason, rather than disappearing — a missing control looks like a product
 * that never had the feature, while a disabled one with a tooltip tells the
 * user what to change.
 */
export function CapabilityGate({ available, reason, children, label }) {
  const [open, setOpen] = useState(false);
  if (available) return children;
  return (
    <span className="relative inline-flex">
      <span
        className="cursor-not-allowed opacity-50"
        aria-disabled="true"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        {children}
      </span>
      {open && reason && (
        <span
          role="tooltip"
          className="absolute left-0 top-full z-30 mt-1 w-72 rounded-control border border-border bg-surface p-2.5 text-[11px] leading-relaxed text-muted shadow-lg"
        >
          <span className="mb-1 block font-semibold text-fg">
            {label || 'Not available'}
          </span>
          {reason}
        </span>
      )}
    </span>
  );
}

/** Tooltip body shared by the charts. Always shows the EXACT amount — a chart
 *  that only ever shows an approximation has no way to inspect the real value. */
export function ChartTooltip({ active, payload, label, currency, totalLabel = 'Total' }) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter((p) => !isMissing(p.value));
  const total = rows.reduce((sum, p) => sum + Number(p.value), 0);
  return (
    <div className="rounded-control border border-border bg-surface p-2.5 shadow-lg">
      <p className="mb-1.5 text-[11px] font-bold text-fg">{label}</p>
      <div className="space-y-1">
        {rows.map((p) => (
          <div key={p.dataKey ?? p.name} className="flex items-center gap-2 text-[11px]">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: p.color || p.fill }}
              aria-hidden
            />
            <span className="text-muted">{p.name}</span>
            <span className="ml-auto font-semibold tabular-nums text-fg">
              {exact(p.value, currency)}
            </span>
          </div>
        ))}
      </div>
      {rows.length > 1 && (
        <div className="mt-1.5 flex items-center gap-2 border-t border-border pt-1.5 text-[11px]">
          <span className="font-semibold text-muted">{totalLabel}</span>
          <span className="ml-auto font-bold tabular-nums text-fg">
            {exact(total, currency)}
          </span>
        </div>
      )}
    </div>
  );
}

/** Section heading used inside tab panels. */
export function PanelHeading({ title, description, right }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-[14px] font-semibold text-fg">{title}</h3>
        {description && <p className="mt-0.5 text-[11.5px] text-muted">{description}</p>}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  );
}

/**
 * Banner shown when analytics need more stored history than exists. Names the
 * shortfall and the fix rather than rendering an empty chart.
 */
export function InsufficientHistory({ available, required, reason, onBackfill }) {
  return (
    <div className="rounded-control border border-dashed border-border bg-sunken p-4 text-center">
      <Info size={18} className="mx-auto mb-1.5 text-subtle" aria-hidden />
      <p className="text-[13px] font-medium text-fg">Not enough billing history yet</p>
      <p className="mx-auto mt-1 max-w-lg text-[11.5px] leading-relaxed text-muted">
        {reason || `This needs at least ${required} days of stored history; ${available} day(s) are available.`}
      </p>
      {onBackfill && (
        <button
          type="button"
          onClick={onBackfill}
          className="mt-2.5 rounded-control border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-fg hover:bg-sunken"
        >
          Backfill history
        </button>
      )}
    </div>
  );
}
