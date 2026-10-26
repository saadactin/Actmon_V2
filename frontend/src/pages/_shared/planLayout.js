/**
 * Execution-plan graph: shape, classification and tidy-tree layout.
 *
 * Kept out of the component because these are the decisions worth testing —
 * a diagram that places a node in the wrong column, or paints a cheap step
 * red, is wrong in a way no build or render check would notice.
 *
 * WHAT THE DATA IS. Every figure here comes from `v$sql_plan`, which is the
 * optimizer's PLAN, not a record of the run: COST, CARDINALITY, BYTES,
 * CPU_COST and IO_COST are all estimates made before the query executed.
 * Oracle keeps actual per-step figures in `v$sql_plan_statistics_all`, and
 * only when the statement ran under STATISTICS_LEVEL=ALL or a
 * gather_plan_statistics hint — this payload carries none of them. So nothing
 * in this module may be presented as a measurement, and there is deliberately
 * no per-node elapsed time: there is no honest source for one.
 */

/** A number Oracle actually reported, or null. 0 is a real value. */
export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ── classification ──────────────────────────────────────────────────────
   Grouped by what the step DOES, because that is what a reader scans for:
   where rows are fetched, where they are joined, where they are sorted. */

const KIND_RULES = [
  { kind: 'access', re: /^(TABLE ACCESS|INDEX|MAT_VIEW ACCESS|EXTERNAL TABLE ACCESS|FIXED TABLE|FIXED INDEX)/i },
  { kind: 'join', re: /(JOIN|NESTED LOOPS|MERGE JOIN|UNION|MINUS|INTERSECT|CONNECT BY)/i },
  { kind: 'sort', re: /(SORT|GROUP BY|WINDOW|BUFFER|AGGREGATE)/i },
  { kind: 'filter', re: /(FILTER|COUNT|FIRST ROW|STOPKEY)/i },
];

/** Which family a plan step belongs to. Falls back to `operation`, which is
 *  the honest answer for the steps Oracle does not categorise. */
export function classifyOperation(operation, options) {
  const text = [operation, options].filter(Boolean).join(' ');
  if (!text.trim()) return 'operation';
  for (const { kind, re } of KIND_RULES) if (re.test(text)) return kind;
  return 'operation';
}

/**
 * How severe a step looks, from its share of the plan's estimated cost.
 *
 * `planCost` is the root step's cost, which in Oracle is cumulative — it
 * already contains every descendant. A share is therefore "how much of the
 * plan's cost this branch accounts for", not "how much this one step added",
 * and the details panel says so rather than letting the colour imply
 * otherwise.
 *
 * A full table scan is called out at warning even when it is cheap, because
 * cheap today is a function of today's row count.
 */
export function severityFor({ cost, operation, options }, planCost) {
  const c = num(cost);
  const total = num(planCost);
  const share = c != null && total ? c / total : null;
  const fullScan = /TABLE ACCESS/i.test(operation || '') && /FULL/i.test(options || '');

  if (share != null && share >= 0.5) return 'critical';
  if (fullScan && share != null && share >= 0.2) return 'critical';
  if (share != null && share >= 0.2) return 'warning';
  if (fullScan) return 'warning';
  return null;
}

/* ── graph ───────────────────────────────────────────────────────────── */

/**
 * Normalise `v$sql_plan` rows into a tree, keeping each row intact under
 * `raw` so the details panel can show every column Oracle gave us rather
 * than the handful the card has room for.
 */
export function buildPlanGraph(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;

  const planCost = rows.reduce((max, r) => Math.max(max, num(r.cost) ?? 0), 0);

  const byId = new Map();
  rows.forEach((r) => {
    const id = num(r.id);
    const cost = num(r.cost);
    byId.set(id, {
      id,
      parentId: num(r.parent_id),
      depth: num(r.depth) ?? 0,
      operation: (r.operation || '').trim(),
      options: (r.options || '').trim(),
      label: [r.operation, r.options].filter(Boolean).join(' ').trim() || 'UNKNOWN',
      objectName: r.object_name || null,
      objectOwner: r.object_owner || null,
      objectType: r.object_type || null,
      cost,
      cardinality: num(r.cardinality),
      bytes: num(r.bytes),
      cpuCost: num(r.cpu_cost),
      ioCost: num(r.io_cost),
      accessPredicates: r.access_predicates || null,
      filterPredicates: r.filter_predicates || null,
      // A share of the plan's own total, so it cannot exceed 100% and does
      // not depend on any figure outside this payload.
      costShare: cost != null && planCost ? cost / planCost : null,
      kind: classifyOperation(r.operation, r.options),
      severity: severityFor(r, planCost),
      raw: r,
      children: [],
    });
  });

  let root = null;
  for (const r of rows) {
    const node = byId.get(num(r.id));
    const parent = byId.get(num(r.parent_id));
    if (parent && parent !== node) parent.children.push(node);
    else if (!root) root = node;
  }
  // Oracle numbers the root 0; fall back to the first row when a plan has
  // aged partially out of the shared pool and row 0 is missing.
  root = byId.get(0) || root || byId.get(num(rows[0].id)) || null;
  if (!root) return null;

  // Children in plan order, which is execution order within a parent.
  const sortKids = (n) => {
    n.children.sort((a, b) => a.id - b.id);
    n.children.forEach(sortKids);
  };
  sortKids(root);

  return { root, byId, planCost, count: byId.size };
}

/* ── layout ──────────────────────────────────────────────────────────── */

export const NODE_W = 212;
export const NODE_H = 70;
export const GAP_X = 26;
export const GAP_Y = 58;

/**
 * Tidy top-down tree layout.
 *
 * Each subtree is measured, then placed, then its parent is centred over it.
 * Sibling subtrees are packed side by side, so two wide branches can never
 * land on the same x — which is the failure mode of the naive
 * "x = index * width" layout, and the reason a plan with two deep branches
 * used to draw nodes on top of each other.
 */
export function layoutTree(root, opts = {}) {
  const nodeW = opts.nodeW ?? NODE_W;
  const nodeH = opts.nodeH ?? NODE_H;
  const gapX = opts.gapX ?? GAP_X;
  const gapY = opts.gapY ?? GAP_Y;
  if (!root) return { nodes: [], edges: [], width: 0, height: 0 };

  const nodes = [];
  const edges = [];

  // Pass 1: subtree width, bottom-up.
  const widthOf = (n) => {
    if (!n.children.length) { n._w = nodeW; return n._w; }
    const kids = n.children.reduce((sum, c) => sum + widthOf(c), 0)
      + gapX * (n.children.length - 1);
    n._w = Math.max(nodeW, kids);
    return n._w;
  };
  widthOf(root);

  // Pass 2: place, top-down. `left` is the subtree's left edge.
  const place = (n, left, depth) => {
    const centre = left + n._w / 2;
    const x = centre - nodeW / 2;
    const y = depth * (nodeH + gapY);
    nodes.push({ node: n, x, y, w: nodeW, h: nodeH });

    let cursor = left;
    if (n.children.length) {
      const kidsWidth = n.children.reduce((s, c) => s + c._w, 0)
        + gapX * (n.children.length - 1);
      // Children are centred under their parent, not flushed left, so a
      // parent with one narrow child does not sit off to one side of it.
      cursor = left + (n._w - kidsWidth) / 2;
    }
    n.children.forEach((c) => {
      place(c, cursor, depth + 1);
      edges.push({ from: n.id, to: c.id });
      cursor += c._w + gapX;
    });
  };
  place(root, 0, 0);

  const width = Math.max(...nodes.map((n) => n.x + n.w), nodeW);
  const height = Math.max(...nodes.map((n) => n.y + n.h), nodeH);
  nodes.forEach(({ node }) => { delete node._w; });

  return { nodes, edges, width, height };
}

/**
 * The orthogonal path from a parent's bottom edge to a child's top edge:
 * down, across at the midpoint, then down again. Returned as an SVG path so
 * the edge is one element rather than three divs.
 */
export function edgePath(parent, child) {
  const x1 = parent.x + parent.w / 2;
  const y1 = parent.y + parent.h;
  const x2 = child.x + child.w / 2;
  const y2 = child.y;
  const midY = y1 + (y2 - y1) / 2;
  if (Math.abs(x1 - x2) < 0.5) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const r = Math.min(10, Math.abs(x2 - x1) / 2, (y2 - y1) / 2);
  const dir = x2 > x1 ? 1 : -1;
  return [
    `M ${x1} ${y1}`,
    `L ${x1} ${midY - r}`,
    `Q ${x1} ${midY} ${x1 + r * dir} ${midY}`,
    `L ${x2 - r * dir} ${midY}`,
    `Q ${x2} ${midY} ${x2} ${midY + r}`,
    `L ${x2} ${y2}`,
  ].join(' ');
}

/** The zoom that fits `content` inside `viewport`, capped so a two-node plan
 *  is not blown up to fill a 1080p screen. */
export function fitScale(content, viewport, { pad = 32, max = 1 } = {}) {
  if (!content?.width || !content?.height || !viewport?.width || !viewport?.height) return 1;
  const sx = (viewport.width - pad * 2) / content.width;
  const sy = (viewport.height - pad * 2) / content.height;
  return Math.max(0.1, Math.min(max, sx, sy));
}
