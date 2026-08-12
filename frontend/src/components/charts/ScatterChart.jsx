import { useMemo, useState } from 'react';
import Icon from '@/components/ui/Icon';

/**
 * Two measured values plotted against each other, one bubble per entity —
 * "is CPU correlated with memory across the fleet", which a list of numbers
 * can't show and a time series doesn't apply to (there's no time axis here,
 * every host is a single point in the CURRENT moment).
 *
 * Hand-rolled SVG for the same reason as LineChart: exact control over the
 * mark spec, themed from tokens with no charting library. Bubble radius
 * carries a THIRD measurement (disk usage here) — sqrt-scaled so area, not
 * radius, is proportional to the value, which is what a reader actually
 * compares by eye.
 *
 *   points  [{ x, y, z, label, color }]  z optional (uniform radius if absent)
 */
const PAD = { top: 12, right: 16, bottom: 26, left: 34 };
const W = 600;

export default function ScatterChart({
  points = [],
  xLabel = 'X', yLabel = 'Y',
  xUnit = '%', yUnit = '%',
  xDomain = [0, 100], yDomain = [0, 100],
  height = 220,
  emptyLabel = 'No data to plot',
}) {
  const [hover, setHover] = useState(null);
  const H = height;

  const plot = useMemo(() => {
    const pts = points.filter((p) => Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)));
    if (pts.length === 0) return null;

    const [xLo, xHi] = xDomain;
    const [yLo, yHi] = yDomain;
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const x = (v) => PAD.left + ((Math.min(Math.max(v, xLo), xHi) - xLo) / (xHi - xLo || 1)) * innerW;
    const y = (v) => PAD.top + innerH - ((Math.min(Math.max(v, yLo), yHi) - yLo) / (yHi - yLo || 1)) * innerH;

    const zVals = pts.map((p) => Number(p.z) || 0);
    const zMax = Math.max(...zVals, 1);
    const radius = (z) => 5 + Math.sqrt(Math.max(Number(z) || 0, 0) / zMax) * 14;

    const xTicks = [0, 0.5, 1].map((f) => xLo + (xHi - xLo) * f);
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => yLo + (yHi - yLo) * f);

    return { pts, x, y, radius, xTicks, yTicks, innerH };
  }, [points, xDomain, yDomain, H]);

  if (!plot) {
    return (
      <div className="grid place-items-center gap-1.5 text-center" style={{ height }}>
        <Icon name="chart-bar" size={20} className="text-subtle" />
        <p className="text-[12px] font-medium text-muted">{emptyLabel}</p>
      </div>
    );
  }

  const { pts, x, y, radius, xTicks, yTicks } = plot;
  const active = hover !== null ? pts[hover] : null;

  return (
    <div className="relative" style={{ height }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full" role="img" aria-label="Scatter plot">
        {/* gridlines */}
        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--chart-grid)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            <text x={PAD.left - 6} y={y(v) + 3} textAnchor="end" fill="var(--chart-axis)" style={{ fontSize: 9 }}>{Math.round(v)}</text>
          </g>
        ))}
        {xTicks.map((v) => (
          <line key={`x${v}`} x1={x(v)} x2={x(v)} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--chart-grid)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        ))}

        {/* bubbles */}
        {pts.map((p, i) => (
          <circle
            key={i}
            cx={x(Number(p.x))} cy={y(Number(p.y))} r={radius(p.z)}
            fill={p.color || 'var(--chart-1)'} fillOpacity={hover === i ? 0.85 : 0.6}
            stroke={p.color || 'var(--chart-1)'} strokeWidth={hover === i ? 2 : 1.5}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover((h) => (h === i ? null : h))}
            onClick={p.onClick}
            style={{ cursor: p.onClick ? 'pointer' : 'default' }}
          />
        ))}

        {/* axis labels */}
        <text x={PAD.left + (W - PAD.left - PAD.right) / 2} y={H - 4} textAnchor="middle" fill="var(--chart-axis)" style={{ fontSize: 9, fontWeight: 700 }}>
          {xLabel} ({xUnit})
        </text>
        <text x={10} y={PAD.top + 4} fill="var(--chart-axis)" style={{ fontSize: 9, fontWeight: 700 }}>
          {yLabel}
        </text>
      </svg>

      {active && (
        <div
          className="pointer-events-none absolute rounded-control border border-border bg-surface px-2.5 py-1.5 text-[11px] shadow-md"
          style={{
            left: `${(x(Number(active.x)) / W) * 100}%`, top: `${(y(Number(active.y)) / H) * 100}%`,
            transform: 'translate(-50%, -120%)',
          }}
        >
          <span className="block font-bold text-fg">{active.label}</span>
          <span className="block text-subtle">
            {xLabel} {Math.round(active.x)}{xUnit} · {yLabel} {Math.round(active.y)}{yUnit}
            {active.z !== undefined && ` · disk ${Math.round(active.z)}%`}
          </span>
        </div>
      )}
    </div>
  );
}
