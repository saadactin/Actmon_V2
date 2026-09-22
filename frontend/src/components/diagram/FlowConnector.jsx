import cn from '@/lib/cn';

/**
 * A single horizontal connector for cards laid out in a flex row.
 *
 * FlowDiagram owns its own layout, so it can draw curves between arbitrary
 * points. This is for the other case: rich interactive cards (the host cluster
 * page's TopologyNodeCard, with its terminal and dashboard actions) that must
 * keep their own flex layout, where all we need is the LINE between them.
 *
 * It replaces what used to sit there — two floating 1px stubs that stopped
 * short of both cards, with a dashed circle badge between them — so the
 * relationship now actually reads as a connection rather than as decoration.
 * Same neutral line weight and arrowhead as FlowDiagram.
 *
 *   <FlowConnector label="stream" />
 *   <FlowConnector label="wsrep" bidirectional tone="accent" />
 */
export default function FlowConnector({ label, bidirectional = false, tone, className }) {
  const stroke = tone === 'accent' ? 'var(--accent)' : 'var(--border-strong)';
  const id = bidirectional ? 'fc-arrow-both' : 'fc-arrow';
  return (
    <div className={cn('flex shrink-0 flex-col items-center justify-center self-center px-1', className)}>
      <svg width="56" height="16" viewBox="0 0 56 16" aria-hidden="true" style={{ color: stroke }}>
        <defs>
          <marker id={id} viewBox="0 0 8 8" refX="7" refY="4"
                  markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
          </marker>
        </defs>
        <line
          x1={bidirectional ? 8 : 2} y1="8" x2="48" y2="8"
          stroke="currentColor" strokeWidth="1.5"
          markerEnd={`url(#${id})`}
          markerStart={bidirectional ? `url(#${id})` : undefined}
        />
      </svg>
      {label && (
        <span className="mt-0.5 whitespace-nowrap text-[9px] font-semibold uppercase tracking-wide text-subtle">
          {label}
        </span>
      )}
    </div>
  );
}
