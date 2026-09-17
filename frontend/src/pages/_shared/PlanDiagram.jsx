import { useState } from 'react';
import cn from '@/lib/cn';
import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';

/**
 * Recursive execution-plan tree, rendered as a real org-chart — a wrapping
 * <ul>/<li> structure whose ::before/::after pseudo-elements draw every
 * parent→child edge (straight stem for a single child, a horizontal bracket
 * spanning all of them for several) purely in CSS. No diagramming library:
 * a query plan is a narrow tree, not a general graph, and the classic
 * "family tree" CSS recipe (below in PD_CSS) draws exact, gap-free
 * connectors without any JS layout math. Consumes the normalized shape
 * planTree.js's adapters produce:
 *   { id, label, sublabel, rows, costLabel, flagged, children: [] }
 */
export default function PlanDiagram({ tree }) {
  if (!tree) {
    return <p className="text-[12px] text-subtle">Nothing to diagram for this plan.</p>;
  }
  return (
    <div className="rounded-card border border-border bg-sunken p-gutter">
      <div className="mb-3 flex items-center gap-1.5 text-[11px] font-medium text-subtle">
        <Icon name="chevron-up" size={12} className="text-muted" />
        <span>Reads bottom-up — each box&rsquo;s children run first and feed their rows into it.</span>
      </div>
      <div className="pd-tree overflow-x-auto pb-2">
        <ul>
          <li>
            <PlanNode node={tree} root />
          </li>
        </ul>
      </div>
      <style>{PD_CSS}</style>
    </div>
  );
}

function PlanNode({ node, root }) {
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = (node.children || []).length > 0;

  return (
    <div className="flex flex-col items-center">
      {!root && <Icon name="chevron-up" size={11} className="mb-1 shrink-0 text-muted" />}
      <button
        type="button"
        onClick={() => hasChildren && setCollapsed((c) => !c)}
        className={cn(
          'pd-node relative z-10 flex min-w-[160px] flex-col gap-1 rounded-card border-2 bg-surface px-3.5 py-2.5 text-left shadow-sm transition-all',
          node.flagged
            ? 'pd-node-flagged border-danger-border bg-danger-soft hover:bg-danger-soft/70'
            : 'border-border-strong hover:border-accent hover:shadow-md',
          hasChildren && 'cursor-pointer',
        )}
      >
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px] font-bold text-fg">{node.label}</span>
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
          <span className="flex items-center gap-2 text-[10px] font-semibold text-subtle">
            {node.rows != null && <span>{node.rows} rows</span>}
            {node.costLabel && <span>{node.costLabel}</span>}
          </span>
        )}
      </button>

      {hasChildren && !collapsed && (
        <ul>
          {node.children.map((child) => (
            <li key={child.id}>
              <PlanNode node={child} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The well-known pure-CSS "org chart" recipe: every <ul> lays its <li>s out
// in a row, and each <li>'s ::before/::after draw its own half of the
// horizontal bracket plus the vertical drop into its box, so a group of
// siblings gets one continuous bracket with no per-node layout math. A
// lone child skips the bracket (only-child rule below) and gets a single
// straight stem instead. `ul ul::before` draws the stem from a parent box
// down to the top of its children's bracket, so every edge — 1 child or
// several — is a single unbroken line into the box above it.
const PD_LINE = 'var(--border-strong)';
const PD_CSS = `
.pd-tree ul {
  position: relative;
  display: flex;
  justify-content: center;
  padding-top: 22px;
  margin: 0;
}
.pd-tree > ul { padding-top: 0; }
.pd-tree li {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  list-style: none;
  padding: 22px 12px 0 12px;
}
.pd-tree > ul > li { padding-top: 0; }
.pd-tree li::before, .pd-tree li::after {
  content: '';
  position: absolute;
  top: 0;
  right: 50%;
  width: 50%;
  height: 22px;
  border-top: 2px solid ${PD_LINE};
}
.pd-tree li::after {
  right: auto;
  left: 50%;
  border-left: 2px solid ${PD_LINE};
}
.pd-tree li:only-child::before, .pd-tree li:only-child::after { display: none; }
.pd-tree li:only-child { padding-top: 0; }
.pd-tree > ul > li::before, .pd-tree > ul > li::after { display: none; }
.pd-tree li:first-child::before, .pd-tree li:last-child::after { border-color: transparent; }
.pd-tree li:last-child::before { border-right: 2px solid ${PD_LINE}; border-radius: 0 6px 0 0; }
.pd-tree li:first-child::after { border-radius: 6px 0 0 0; }
.pd-tree ul ul::before {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  width: 0;
  height: 22px;
  border-left: 2px solid ${PD_LINE};
}
/* the edge feeding a flagged (full scan) node up into its parent reads red,
   so the exact path that's costing you is visible at a glance, not just the
   box at its end */
.pd-tree li:has(> div > .pd-node-flagged)::before,
.pd-tree li:has(> div > .pd-node-flagged)::after,
.pd-tree ul:has(> li > div > .pd-node-flagged)::before {
  border-color: var(--danger-border, var(--danger));
}
`;
