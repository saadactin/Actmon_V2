import { useEffect, useState } from 'react';
import cn from '@/lib/cn';

const RANK_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

/**
 * Horizontal ranked bar chart — the "Destination Ports" bar shape from the
 * design mockup, repointed at real data (top hosts by CPU%) since we don't
 * track network ports. Unlike the mockup, the value label sits permanently
 * at the end of each bar rather than only appearing on hover: this app's own
 * chart convention (see Dashboard.jsx) is that no number is ever reachable
 * only by hovering.
 */
export default function RankedBarChart({ title, titleNote, unit = '', rows = [], max, className }) {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGrown(true), 30);
    return () => clearTimeout(t);
  }, [rows]);

  const scaleMax = max ?? Math.max(1, ...rows.map((r) => r.value));
  const ticks = 5;

  return (
    <section className={cn('card flex flex-col gap-4 px-card py-card', className)}>
      <h2 className="flex items-baseline gap-2 text-[17px] font-bold text-fg">
        <span className="truncate-safe">{title}</span>
        {titleNote && <span className="shrink-0 text-[13px] font-normal text-subtle">{titleNote}</span>}
      </h2>

      {rows.length === 0 ? (
        <p className="py-10 text-center text-[12px] text-subtle">No data yet.</p>
      ) : (
        <>
          <div className="relative border-l border-border">
            <div className="pointer-events-none absolute inset-0 flex justify-between">
              {Array.from({ length: ticks }).map((_, i) => (
                <span key={i} className="h-full border-l border-dashed border-border first:border-l-0" />
              ))}
            </div>
            <div className="relative flex flex-col gap-3 py-1">
              {rows.map((r, i) => {
                const pct = Math.min(100, (r.value / scaleMax) * 100);
                return (
                  <div key={r.key} className="flex items-center gap-3" title={r.label}>
                    <span className="h-11 flex-1 rounded-r-[10px] bg-sunken">
                      <span
                        className="flex h-full items-center justify-end rounded-r-[10px] pr-2 text-[11px] font-bold text-on-inverse transition-[width] duration-700 ease-out hover:brightness-110"
                        style={{ width: grown ? `${pct}%` : 0, background: RANK_COLORS[i % RANK_COLORS.length] }}
                      >
                        {pct > 18 && <span className="tabular-nums">{Math.round(r.value)}{unit}</span>}
                      </span>
                    </span>
                    {pct <= 18 && (
                      <span className="w-14 shrink-0 text-[11px] font-bold text-fg tabular-nums">{Math.round(r.value)}{unit}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex justify-between text-[11px] text-subtle">
            {Array.from({ length: ticks + 1 }).map((_, i) => (
              <span key={i}>{Math.round((scaleMax / ticks) * i)}{unit}</span>
            ))}
          </div>

          <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
            {rows.map((r, i) => (
              <li key={r.key} className="flex items-center gap-1.5 text-[12px] text-muted">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: RANK_COLORS[i % RANK_COLORS.length] }} />
                <span className="truncate-safe max-w-[180px]">{r.label}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
