import { useState } from 'react';
import cn from '@/lib/cn';
import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';

/**
 * Recursive execution-plan tree, rendered as boxes-and-lines — the classic
 * org-chart CSS pattern (no diagramming library; a query plan is a narrow
 * tree, not a general graph, so hand-rolled layout math would be overkill).
 * Consumes the normalized shape planTree.js's adapters produce:
 *   { id, label, sublabel, rows, costLabel, flagged, children: [] }
 */
export default function PlanDiagram({ tree }) {
  if (!tree) {
    return <p className="text-[12px] text-subtle">Nothing to diagram for this plan.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-card border border-border bg-sunken p-gutter">
      <div className="flex justify-center">
        <PlanNode node={tree} />
      </div>
    </div>
  );
}

function PlanNode({ node }) {
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = (node.children || []).length > 0;

  return (
    <div className="flex flex-col items-center">
      <button
        type="button"
        onClick={() => hasChildren && setCollapsed((c) => !c)}
        className={cn(
          'flex min-w-[140px] flex-col gap-0.5 rounded-card border px-3 py-2 text-left shadow-sm transition-colors',
          node.flagged
            ? 'border-danger-border bg-danger-soft hover:bg-danger-soft/70'
            : 'border-border bg-surface hover:bg-raised',
          hasChildren && 'cursor-pointer',
        )}
      >
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-bold text-fg">{node.label}</span>
          {node.flagged && <Badge tone="danger" size="xs">flagged</Badge>}
          {hasChildren && (
            <Icon
              name={collapsed ? 'chevron-right' : 'chevron-down'}
              size={12}
              className="ml-auto shrink-0 text-subtle"
            />
          )}
        </span>
        {node.sublabel && (
          <span className="truncate font-mono text-[11px] text-muted">{node.sublabel}</span>
        )}
        {(node.rows != null || node.costLabel) && (
          <span className="flex items-center gap-2 text-[10px] text-subtle">
            {node.rows != null && <span>{node.rows} rows</span>}
            {node.costLabel && <span>{node.costLabel}</span>}
          </span>
        )}
      </button>

      {hasChildren && !collapsed && (
        <>
          <span className="h-3 w-px bg-border" />
          <div className="flex items-start gap-6">
            {node.children.map((child) => (
              <div key={child.id} className="flex flex-col items-center">
                <span className="h-3 w-px bg-border" />
                <PlanNode node={child} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
