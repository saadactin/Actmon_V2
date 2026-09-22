import { useMemo } from 'react';
import cn from '@/lib/cn';
import { layout, edgeGeometry, CARD_W, CARD_H } from './flowLayout';

/**
 * One shared relationship diagram for the whole app.
 *
 * Every "topology" in ACTMON used to be hand-rolled and none of them looked
 * alike: Patroni drew a bare 1px stub that never reached its boxes, the host
 * cluster page drew a dashed circle badge between cards, Oracle printed a
 * literal "↓ Redo Transport" with no line at all, and the agent pipeline used
 * chevrons that disappeared below the lg: breakpoint. Four separate node-box
 * implementations across two different colour systems.
 *
 * This gives all of them the same left-to-right flow: white rounded cards, real
 * curved edges that actually touch the boxes, arrowheads that show direction.
 * Nodes are real HTML — selectable, reachable by a screen reader, themed by the
 * design tokens so dark mode is free. Only the edges are SVG, because a curve
 * between two arbitrary points is the one thing CSS cannot draw.
 *
 * Callers describe RELATIONSHIPS, never positions; columns are derived from the
 * edges (see flowLayout.js). A caller that genuinely needs a fixed column can
 * still pin one via `column`.
 *
 *   <FlowDiagram
 *     nodes={[{ id:'a', label:'Leader', sublabel:'10.0.0.1', tone:'success' },
 *             { id:'b', label:'Replica', sublabel:'10.0.0.2' }]}
 *     edges={[{ from:'a', to:'b', label:'WAL streaming' }]}
 *   />
 *
 * node:  { id, label, sublabel?, meta?, tone?, dot?, title?, onClick?, column? }
 * edge:  { from, to, label?, tone?, dashed? }
 * tone:  default | accent | success | warning | danger | muted
 */

const TONES = {
  default: { border: 'var(--border-strong)', bar: 'var(--border-strong)' },
  accent:  { border: 'var(--accent-border)', bar: 'var(--accent)' },
  success: { border: 'var(--success)',       bar: 'var(--success)' },
  warning: { border: 'var(--warning)',       bar: 'var(--warning)' },
  danger:  { border: 'var(--danger)',        bar: 'var(--danger)' },
  muted:   { border: 'var(--border)',        bar: 'var(--border)' },
};
const toneOf = (t) => TONES[t] || TONES.default;

export default function FlowDiagram({
  nodes = [], edges = [], caption, className,
  emptyLabel = 'Nothing to diagram yet.',
}) {
  const { placed, width, height, pos } = useMemo(() => layout(nodes, edges), [nodes, edges]);

  if (!nodes.length) return <p className="text-[12px] text-subtle">{emptyLabel}</p>;

  const drawable = edges
    .map((e, i) => {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      return a && b ? { e, i, g: edgeGeometry(a, b) } : null;  // skip edges to nodes we were not given
    })
    .filter(Boolean);

  return (
    <div className={cn('rounded-card border border-border bg-sunken p-gutter', className)}>
      {caption && <p className="mb-3 text-[11px] font-medium text-subtle">{caption}</p>}
      <div className="overflow-x-auto pb-1">
        <div className="relative" style={{ width, height, minWidth: width }}>
          <svg
            width={width} height={height}
            className="absolute inset-0 text-border-strong"
            style={{ pointerEvents: 'none' }}
            aria-hidden="true"
          >
            <defs>
              <marker id="fd-arrow" viewBox="0 0 8 8" refX="7" refY="4"
                      markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
              </marker>
            </defs>
            {drawable.map(({ e, i, g }) => (
              <path
                key={`${e.from}-${e.to}-${i}`}
                d={g.d} fill="none" strokeWidth={1.5}
                stroke={e.tone ? toneOf(e.tone).bar : 'currentColor'}
                strokeDasharray={e.dashed ? '5,4' : undefined}
                markerEnd="url(#fd-arrow)"
                style={e.tone ? { color: toneOf(e.tone).bar } : undefined}
              />
            ))}
          </svg>

          {/* Edge labels are HTML, not SVG <text>: they inherit the app font and
              carry a chip background that masks the line running behind them. */}
          {drawable.map(({ e, i, g }) => e.label && (
            <span
              key={`l-${e.from}-${e.to}-${i}`}
              className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border border-border bg-surface px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide text-subtle"
              style={{ left: g.labelX, top: g.labelY }}
            >
              {e.label}
            </span>
          ))}

          {placed.map((n) => {
            const t = toneOf(n.tone);
            const clickable = typeof n.onClick === 'function';
            return (
              <div
                key={n.id}
                className={cn(
                  'absolute flex flex-col justify-center overflow-hidden rounded-card border bg-surface px-3.5',
                  clickable && 'cursor-pointer transition-colors hover:bg-raised',
                )}
                style={{ left: n.x, top: n.y, width: CARD_W, height: CARD_H, borderColor: t.border }}
                onClick={n.onClick}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                onKeyDown={clickable ? (ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); n.onClick(); }
                } : undefined}
                title={n.title}
              >
                <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: t.bar }} />
                <span className="flex items-center gap-1.5">
                  {n.dot && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: t.bar }} />}
                  <span className="truncate text-[13px] font-semibold leading-tight text-fg">{n.label}</span>
                </span>
                {n.sublabel && <span className="mt-0.5 truncate text-[11px] leading-tight text-muted">{n.sublabel}</span>}
                {n.meta && <span className="mt-0.5 truncate text-[10px] leading-tight text-subtle">{n.meta}</span>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
