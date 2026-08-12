import Icon from '@/components/ui/Icon';
import { bandFor } from './status';

/**
 * A single ratio against a limit — the right form for "68% of 100%", where a
 * two-slice pie would be noise.
 *
 * The fill carries severity (good → warning → serious → critical) and the
 * unfilled track is a lighter step of that same colour, so the state reads across
 * the whole bar rather than only in the filled part. The percentage is always
 * printed, which is also the relief channel for the sub-3:1 status steps.
 */
export default function Meter({ label, value, icon, hint, color }) {
  const pct = Number.isFinite(value) ? Math.min(Math.max(value, 0), 100) : 0;
  const band = bandFor(pct);
  // An explicit colour means the CALLER already judged this value (e.g.
  // availability, where high is good — the inverse of bandFor's utilisation
  // scale), so the auto status badge below is suppressed: "Critical" printed
  // next to 100% availability would be actively wrong, not just unstyled.
  const tint = color || band.color;
  const hasData = Number.isFinite(value) && value > 0;

  return (
    <div>
      <div className="flex items-baseline gap-1.5">
        {icon && <Icon name={icon} size={13} className="shrink-0 self-center text-subtle" />}
        <span className="text-[11px] font-semibold text-muted">{label}</span>
        <span className="ml-auto text-[15px] leading-none font-bold text-fg">
          {hasData ? `${Math.round(pct)}%` : '—'}
        </span>
      </div>

      <div
        className="relative mt-1.5 h-2 overflow-hidden rounded-sm"
        role="meter"
        aria-valuenow={hasData ? Math.round(pct) : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        style={{
          // lighter step of the fill's own colour, not a neutral grey
          background: hasData
            ? `color-mix(in srgb, ${tint} 16%, var(--chart-track))`
            : 'var(--chart-track)',
        }}
      >
        <span
          className="absolute inset-y-0 left-0 transition-[width] duration-[var(--dur-normal)] ease-[var(--ease-out)]"
          style={{ width: `${pct}%`, background: tint, borderRadius: '0 4px 4px 0' }}
        />
      </div>

      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-[10px] text-subtle">{hint}</span>
        {hasData && !color && (
          <span className="flex items-center gap-1 text-[10px] font-semibold text-muted">
            <Icon name={band.icon} size={9} strokeWidth={3} style={{ color: band.color }} />
            {band.label}
          </span>
        )}
      </div>
    </div>
  );
}
