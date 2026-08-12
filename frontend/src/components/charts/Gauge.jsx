import Icon from '@/components/ui/Icon';
import { bandFor } from './status';

/**
 * Ring for a 0–100% ratio — the gauge alternative to a Meter.
 *
 * `sweep` closes the ring (360°, the default) or opens it into a dial. A closed
 * ring reads as one of a set, which is what a row of three resources wants; an
 * open arc distinguishes "empty" from "full" more clearly when it stands alone.
 *
 * `showValue` decides where the number lives:
 *   true  (default) the percentage sits in the hole with the label under it, and
 *         the band is named below the ring. A gauge shown on its own has to be
 *         readable on its own.
 *   false the hole carries only the label, and the CALLER prints the values —
 *         see ChartBody's ratio/gauge case, which lays them out in a row beneath
 *         three rings. At that diameter a percentage and a label stacked in one
 *         hole are both too small to read.
 *
 * `color` overrides the utilisation band. Pass it where the card's job is to
 * compare different resources rather than to judge one — three rings all sitting
 * in the same band would otherwise be indistinguishable. Leave it off and the ring
 * wears its band, so the colour still means severity.
 */
export default function Gauge({
  label,
  value,
  icon,
  color,
  size = 132,
  thickness = 17,
  sweep = 360,
  showValue = true,
}) {
  const pct = Number.isFinite(value) ? Math.min(Math.max(value, 0), 100) : 0;
  const hasData = Number.isFinite(value) && value > 0;
  const band = bandFor(pct);
  const tint = color || band.color;

  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const closed = sweep >= 360;
  const START = closed ? -90 : 135; // closed rings start at 12 o'clock
  const span = closed ? 359.999 : sweep;

  const track = describeArc(cx, cy, r, START, START + span);
  const fill = describeArc(cx, cy, r, START, START + (span * pct) / 100);

  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: size, height: closed ? size : size * 0.86 }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          role="meter"
          aria-valuenow={hasData ? Math.round(pct) : undefined}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${label}${hasData ? `: ${Math.round(pct)}%` : ''}`}
          className="absolute top-0 left-0"
        >
          <path d={track} fill="none" strokeWidth={thickness} stroke="var(--chart-track)" />
          {pct > 0 && (
            <path
              d={fill}
              fill="none"
              stroke={tint}
              strokeWidth={thickness}
              strokeLinecap={closed && pct >= 100 ? 'butt' : 'round'}
              style={{ transition: 'stroke var(--dur-normal) var(--ease)' }}
            />
          )}
        </svg>

        <div className="absolute inset-0 grid place-items-center px-4 text-center">
          {showValue ? (
            <span>
              <span className="block text-[19px] leading-none font-bold text-fg">
                {hasData ? `${Math.round(pct)}%` : '—'}
              </span>
              <span className="mt-1 flex items-center justify-center gap-1 text-[10px] font-semibold text-muted">
                {icon && <Icon name={icon} size={10} />}
                {label}
              </span>
            </span>
          ) : (
            <span className="flex items-center gap-1 text-[13px] font-semibold text-muted">
              {icon && <Icon name={icon} size={12} />}
              {label}
            </span>
          )}
        </div>
      </div>

      {showValue && hasData && (
        <span className="flex items-center gap-1 text-[10px] font-semibold text-muted">
          <Icon name={band.icon} size={9} strokeWidth={3} style={{ color: band.color }} />
          {band.label}
        </span>
      )}
    </div>
  );
}

/** Arc path between two angles (degrees, clockwise from 3 o'clock). */
function describeArc(cx, cy, r, startDeg, endDeg) {
  const p = (deg) => {
    const a = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const sweep = Math.max(endDeg - startDeg, 0.001);
  const [x1, y1] = p(startDeg);
  const [x2, y2] = p(startDeg + sweep);
  const large = sweep > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}
