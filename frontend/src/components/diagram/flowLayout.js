/**
 * Column/row placement for FlowDiagram. Pure maths, no React — kept separate so
 * it can be unit-tested against the cases that actually break topology drawing:
 * cascading replicas, a node with two parents, orphans, and cycles.
 */

export const CARD_W = 208;
export const CARD_H = 70;
export const GAP_X  = 84;   // room for an edge label to sit on the curve
export const GAP_Y  = 26;
export const PAD    = 16;

/**
 * Column per node = LONGEST path from a root. Longest, not shortest, matters:
 * if a node is reachable both directly from the leader and via a cascade, it
 * belongs at the end of the cascade — placing it by shortest path would leave
 * its incoming edge pointing backwards through the diagram.
 *
 * Relaxation rather than a topological sort, because real topologies can
 * contain cycles (a split-brain cluster where two members each report the other
 * as upstream). This terminates on them; a topo sort would not.
 */
export function layout(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (byId.has(e.from) && byId.has(e.to) && e.from !== e.to) incoming.get(e.to).push(e.from);
  }

  const maxCol = Math.max(0, nodes.length - 1);
  const col = new Map(nodes.map((n) => [n.id, n.column ?? 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false;
    for (const n of nodes) {
      if (n.column != null) continue;          // caller pinned this one
      const parents = incoming.get(n.id);
      if (!parents.length) continue;
      // Clamped: in a cycle every pass would otherwise push both members one
      // further right forever, and the column index would run past the node
      // count with nothing to show for it.
      const want = Math.min(maxCol, Math.max(...parents.map((p) => col.get(p) ?? 0)) + 1);
      if (want > (col.get(n.id) ?? 0)) { col.set(n.id, want); moved = true; }
    }
    if (!moved) break;
  }

  // Group, then COMPACT. A cycle (or a pinned column with nothing before it)
  // leaves gaps in this array, and a sparse array is genuinely dangerous here:
  // Array#map skips holes, so `Math.max(1, ...counts)` would spread `undefined`
  // and make every coordinate NaN — a silently blank diagram. Compacting drops
  // the holes and keeps `column` meaning "ordering", not "pixel position".
  const grouped = new Map();
  for (const n of nodes) {
    const c = col.get(n.id) ?? 0;
    if (!grouped.has(c)) grouped.set(c, []);
    grouped.get(c).push(n);
  }
  const columns = [...grouped.keys()].sort((a, b) => a - b).map((k) => grouped.get(k));

  const tallest = columns.reduce((m, c) => Math.max(m, c.length), 1);
  const height  = tallest * CARD_H + (tallest - 1) * GAP_Y + PAD * 2;
  const width   = columns.length * CARD_W + Math.max(0, columns.length - 1) * GAP_X + PAD * 2;

  const placed = [];
  columns.forEach((colNodes, ci) => {
    const blockH = colNodes.length * CARD_H + (colNodes.length - 1) * GAP_Y;
    const top    = (height - blockH) / 2;               // vertically centred column
    colNodes.forEach((n, ri) => {
      placed.push({
        ...n,
        x: PAD + ci * (CARD_W + GAP_X),
        y: top + ri * (CARD_H + GAP_Y),
      });
    });
  });

  return { placed, width, height, pos: new Map(placed.map((n) => [n.id, n])) };
}

/** Endpoints + bezier path for one edge. `forward` = target is to the right. */
export function edgeGeometry(a, b) {
  const forward = b.x >= a.x + CARD_W;
  const x1 = forward ? a.x + CARD_W     : a.x + CARD_W / 2;
  const y1 = forward ? a.y + CARD_H / 2 : a.y + CARD_H;
  const x2 = forward ? b.x              : b.x + CARD_W / 2;
  const y2 = forward ? b.y + CARD_H / 2 : b.y;
  // Horizontal control points for a forward edge; vertical for a wrap-back, so
  // an edge that doubles back reads as a curve instead of cutting through cards.
  const d = forward
    ? `M ${x1} ${y1} C ${x1 + GAP_X / 2} ${y1}, ${x2 - GAP_X / 2} ${y2}, ${x2} ${y2}`
    : `M ${x1} ${y1} C ${x1} ${y1 + GAP_Y}, ${x2} ${y2 - GAP_Y}, ${x2} ${y2}`;
  const labelX = forward ? (a.x + CARD_W + b.x) / 2      : (a.x + b.x) / 2 + CARD_W / 2;
  const labelY = forward ? (a.y + b.y) / 2 + CARD_H / 2  : (a.y + CARD_H + b.y) / 2;
  return { forward, x1, y1, x2, y2, d, labelX, labelY };
}
