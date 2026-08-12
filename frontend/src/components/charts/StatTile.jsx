import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';

/** 1,284 → "1,284"; 12,900 → "12.9K". Keeps a headline number short. */
export function compact(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const v = Number(n);
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 10_000) return `${(v / 1000).toFixed(1)}K`;
  return v.toLocaleString();
}

/**
 * Pad a small whole count to two digits — "6" reads as "06".
 *
 * Only for values that are actually short: padding stops at two digits and never
 * touches a formatted string like "12.9K", so a fleet of 6 and a fleet of 1,284
 * both stay honest.
 */
function padded(n) {
  const text = compact(n);
  return /^\d$/.test(text) ? `0${text}` : text;
}

const ICON_TONES = {
  neutral: 'bg-sunken text-muted',
  accent: 'bg-accent-soft text-accent-text',
  good: 'bg-success-soft text-success-fg',
  warning: 'bg-warning-soft text-warning-fg',
  danger: 'bg-danger-soft text-danger-fg',
  info: 'bg-info-soft text-info-fg',
};

const VALUE_TONES = {
  neutral: 'text-fg',
  accent: 'text-accent-text',
  good: 'text-success-fg',
  warning: 'text-warning-fg',
  danger: 'text-danger-fg',
  info: 'text-info-fg',
};

/**
 * A headline number — the right form for "how many agents", where a one-bar bar
 * chart would be silly.
 *
 * Reads top-to-bottom: what it is, then how many, then the split. The count is the
 * largest thing in the card, so a row of these scans as a row of numbers.
 *
 * `tone` colours the icon disc; `valueTone` colours the count. They are separate
 * because a count is only worth colouring when the colour carries meaning.
 *
 * Proportional figures on the value on purpose: `tabular-nums` gives every digit
 * the width of a zero, which makes a number like 121 look loose at this size.
 * Tabular is reserved for columns (see ChartCard's table view).
 */
export default function StatTile({
  label, value, sub, icon, tone = 'accent', valueTone = 'neutral', onClick, loading,
}) {
  const Wrapper = onClick ? 'button' : 'div';

  return (
    <Wrapper
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'card flex flex-col gap-3.5 px-card py-card text-left',
        loading && 'opacity-55',
        onClick && 'transition-colors hover:border-strong hover:bg-raised',
      )}
    >
      <span className="flex items-center gap-3">
        <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-full', ICON_TONES[tone] || ICON_TONES.accent)}>
          <Icon name={icon} size={18} />
        </span>
        <span className="truncate-safe min-w-0 flex-1 text-[15px] font-medium text-fg">{label}</span>
      </span>

      <span className="min-w-0">
        <span className={cn('block text-[30px] leading-none font-bold', VALUE_TONES[valueTone] || VALUE_TONES.neutral)}>
          {padded(value)}
        </span>
        {sub && <span className="truncate-safe mt-2 block text-[12px] text-subtle">{sub}</span>}
      </span>
    </Wrapper>
  );
}
