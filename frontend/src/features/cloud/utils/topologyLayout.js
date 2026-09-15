/**
 * Layout engines — where each node is drawn.
 *
 * Positions are computed from the graph, never stored on it. That separation is
 * the reason dragging a node cannot change the topology: the graph is the fact,
 * the layout is a view of it, and a dragged position is an override applied on
 * top of a computed one.
 *
 * ## All four layouts are deterministic
 *
 * The same nodes and edges always produce the same coordinates. No force
 * simulation, no random seeding, no animation settling into place. This is a
 * deliberate choice over the force-directed layout a graph library would give
 * for free: an infrastructure diagram that rearranges itself every time you
 * open it cannot be learned, and "the database is bottom-right" is most of how
 * people navigate a diagram they look at daily. It also means a screenshot is
 * reproducible, which matters when one is pasted into an incident review.
 *
 * The cost is that these layouts do not minimise edge crossings the way a
 * force simulation does. For the shapes real cloud accounts have — wide,
 * shallow, hub-heavy — a stable grid reads better than an optimal tangle.
 */

export const CARD_W = 208;
export const CARD_H = 70;

const COL_GAP = 300;
// Clear space between two category bands, so a wrapped band cannot run into
// the next one and the three headings stay unambiguous.
const BAND_GAP = 90;
const ROW_GAP = 96;
const MARGIN_X = 150;
export const MARGIN_Y = 90;

/* Which column a category belongs to in the Architecture layout. Three
   columns, matching the headers the canvas draws. */
const COLUMN_OF_CATEGORY = {
  Organization: 0,
  Network: 0,
  Security: 0,
  Identity: 0,
  Monitoring: 0,
  Compute: 1,
  Container: 1,
  Application: 1,
  Integration: 1,
  'AI / ML': 1,
  Storage: 2,
  Database: 2,
  Analytics: 2,
  Other: 2,
};

export const ARCHITECTURE_COLUMNS = [
  'Identity, network & security',
  'Compute & application',
  'Storage & data',
];

/* The tier a category sits on in the Hierarchical layout: containers at the
   top, then network, then what runs, then what it stores. */
const TIER_OF_CATEGORY = {
  Organization: 0,
  Network: 1,
  Security: 2,
  Identity: 2,
  Compute: 3,
  Container: 3,
  Application: 4,
  Integration: 4,
  'AI / ML': 4,
  Monitoring: 4,
  Storage: 5,
  Database: 5,
  Analytics: 5,
  Other: 6,
};

export const HIERARCHY_TIERS = [
  'Accounts & containers',
  'Networks',
  'Security & identity',
  'Compute',
  'Applications & services',
  'Data',
  'Other',
];

/** Stable ordering within a group, so two renders never swap two nodes. */
function stableSort(nodes) {
  return [...nodes].sort((a, b) => {
    const at = a.type || '';
    const bt = b.type || '';
    if (at !== bt) return at < bt ? -1 : 1;
    const an = a.name || '';
    const bn = b.name || '';
    if (an !== bn) return an < bn ? -1 : 1;
    // Names are not unique; the id is the final tiebreak so the order is total.
    return a.id < b.id ? -1 : 1;
  });
}

/**
 * How many rows a band of `n` cards should use.
 *
 * A band laid out as one tall column is unusable: a category with 87 members
 * produced an 8,300px column, and fitting that into a 700px viewport is 8%
 * zoom, at which every card is an unreadable smear. Wrapping fixes that, but
 * wrapping at a FIXED row count just moves the problem sideways - OCI's 476
 * organizational nodes became 34 sub-columns and 8,400px of width, which fits
 * at 12%.
 *
 * So the row count is chosen to give the band an aspect ratio near
 * `TARGET_ASPECT`, which is roughly what a landscape viewport wants. That is
 * the best geometry can do; past a few hundred cards no zoom shows them all
 * legibly, which is what the clustering and filter controls are for.
 */
const TARGET_ASPECT = 1.9;
const CELL_W = CARD_W + 40;

function rowsFor(count) {
  if (count <= 1) return 1;
  // rows * ROW_GAP * ASPECT ~= subColumns * CELL_W, with subColumns = n / rows
  const rows = Math.sqrt((count * CELL_W) / (ROW_GAP * TARGET_ASPECT));
  return Math.max(1, Math.min(count, Math.round(rows)));
}

/**
 * Lay a band's nodes out as a grid, wrapping into sub-columns.
 * Returns the width the band consumed, so the next band starts clear of it.
 */
function placeBand(nodes, originX, positions) {
  if (!nodes.length) return CARD_W;
  const rows = rowsFor(nodes.length);
  const subColumns = Math.ceil(nodes.length / rows);
  nodes.forEach((node, i) => {
    // Column-major: consecutive nodes fill a column downwards before starting
    // the next one, so a band reads the way a list does.
    const column = Math.floor(i / rows);
    const row = i % rows;
    positions[node.id] = {
      x: originX + column * CELL_W + CARD_W / 2,
      y: MARGIN_Y + row * ROW_GAP + CARD_H / 2,
    };
  });
  return subColumns * CELL_W;
}

function bandHeight(nodes) {
  if (!nodes.length) return 0;
  return rowsFor(nodes.length) * ROW_GAP;
}

/* ── Architecture: three category bands, each wrapping as it grows ────────── */
function architecture(nodes) {
  const bands = [[], [], []];
  stableSort(nodes).forEach((node) => {
    const index = COLUMN_OF_CATEGORY[node.category] ?? 2;
    bands[index].push(node);
  });

  const positions = {};
  const lanes = [];
  let x = MARGIN_X;
  bands.forEach((band, i) => {
    const consumed = placeBand(band, x, positions);
    lanes.push({
      label: ARCHITECTURE_COLUMNS[i],
      orientation: 'column',
      at: x + Math.max(consumed - 40, CARD_W) / 2,
      count: band.length,
    });
    // A band with nothing in it still reserves a slot, so the three headings
    // stay in the same order and place regardless of what the account holds.
    x += Math.max(consumed, CARD_W + 40) + BAND_GAP;
  });

  return {
    positions,
    height: Math.max(560, MARGIN_Y * 2 + Math.max(...bands.map(bandHeight), ROW_GAP)),
    width: x - BAND_GAP + MARGIN_X,
    lanes,
  };
}

/* ── Hierarchical: tiers top to bottom ──────────────────────────────────── */
function hierarchical(nodes) {
  const tiers = HIERARCHY_TIERS.map(() => []);
  stableSort(nodes).forEach((node) => {
    const index = TIER_OF_CATEGORY[node.category] ?? 6;
    tiers[index].push(node);
  });

  const positions = {};
  const usedTiers = [];
  let y = MARGIN_Y;
  let width = 0;
  tiers.forEach((tier, i) => {
    if (!tier.length) return;
    // A tier wraps at a width that suits a wide screen rather than stretching
    // the canvas to 300 columns.
    const perRow = Math.max(1, Math.min(tier.length, 10));
    tier.forEach((node, index) => {
      const row = Math.floor(index / perRow);
      const column = index % perRow;
      positions[node.id] = {
        x: MARGIN_X + column * (CARD_W + 40) + CARD_W / 2,
        y: y + row * ROW_GAP + CARD_H / 2,
      };
    });
    const rows = Math.ceil(tier.length / perRow);
    width = Math.max(width, MARGIN_X * 2 + perRow * (CARD_W + 40));
    usedTiers.push({
      label: HIERARCHY_TIERS[i],
      orientation: 'row',
      at: y + CARD_H / 2,
      count: tier.length,
    });
    y += rows * ROW_GAP + 56;
  });

  return {
    positions,
    height: Math.max(560, y + MARGIN_Y),
    width: Math.max(width, 900),
    lanes: usedTiers,
  };
}

/* ── Radial: the focus at the centre, hops in rings ─────────────────────── */
function radial(nodes, edges, focusId) {
  const positions = {};
  if (!focusId || !nodes.some((n) => n.id === focusId)) {
    return architecture(nodes);
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const adjacency = new Map();
  edges.forEach((edge) => {
    if (!byId.has(edge.source) || !byId.has(edge.target)) return;
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, []);
    adjacency.get(edge.source).push(edge.target);
    adjacency.get(edge.target).push(edge.source);
  });

  // Breadth-first, so a node's ring is its true hop distance.
  const ring = new Map([[focusId, 0]]);
  const queue = [focusId];
  while (queue.length) {
    const current = queue.shift();
    (adjacency.get(current) || []).forEach((next) => {
      if (ring.has(next)) return;
      ring.set(next, ring.get(current) + 1);
      queue.push(next);
    });
  }

  const rings = new Map();
  nodes.forEach((node) => {
    // Nodes with no connection to the focus go in an outer band of their own
    // rather than being dropped — hiding them would misrepresent the scope.
    const depth = ring.has(node.id) ? ring.get(node.id) : -1;
    if (!rings.has(depth)) rings.set(depth, []);
    rings.get(depth).push(node);
  });

  const depths = [...rings.keys()].filter((d) => d >= 0).sort((a, b) => a - b);
  const maxDepth = depths.length ? depths[depths.length - 1] : 0;
  const disconnected = rings.get(-1) || [];
  const ringGap = 250;
  const outer = (maxDepth + (disconnected.length ? 1 : 0)) * ringGap;
  const size = Math.max(760, outer * 2 + CARD_W * 2 + MARGIN_X);
  const cx = size / 2;
  const cy = size / 2;

  positions[focusId] = { x: cx, y: cy };
  depths.filter((d) => d > 0).forEach((depth) => {
    const members = stableSort(rings.get(depth));
    const radius = depth * ringGap;
    // Enough angular room that cards on a ring do not overlap; a crowded ring
    // is pushed outward instead of letting cards collide.
    const circumference = 2 * Math.PI * radius;
    const needed = members.length * (CARD_W + 26);
    const scale = needed > circumference ? needed / circumference : 1;
    members.forEach((node, i) => {
      const angle = (i / members.length) * Math.PI * 2 - Math.PI / 2;
      positions[node.id] = {
        x: cx + Math.cos(angle) * radius * scale,
        y: cy + Math.sin(angle) * radius * scale,
      };
    });
  });

  if (disconnected.length) {
    const members = stableSort(disconnected);
    const radius = (maxDepth + 1) * ringGap;
    const circumference = 2 * Math.PI * radius;
    const needed = members.length * (CARD_W + 26);
    const scale = needed > circumference ? needed / circumference : 1;
    members.forEach((node, i) => {
      const angle = (i / members.length) * Math.PI * 2 - Math.PI / 2;
      positions[node.id] = {
        x: cx + Math.cos(angle) * radius * scale,
        y: cy + Math.sin(angle) * radius * scale,
      };
    });
  }

  return {
    positions,
    height: size,
    width: size,
    lanes: [],
    rings: depths.map((depth) => ({ depth, count: (rings.get(depth) || []).length })),
  };
}

/* ── Dependency: upstream left, focus centre, downstream right ──────────── */
function dependency(nodes, edges, focusId) {
  if (!focusId || !nodes.some((n) => n.id === focusId)) {
    return hierarchical(nodes);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Direction here is the stored edge direction, which is what "upstream" and
  // "downstream" mean for a dependency chart: the things that point AT the
  // focus, and the things it points at.
  const upstream = new Set();
  const downstream = new Set();
  edges.forEach((edge) => {
    if (!byId.has(edge.source) || !byId.has(edge.target)) return;
    if (edge.target === focusId) upstream.add(edge.source);
    if (edge.source === focusId) downstream.add(edge.target);
  });

  const rest = nodes.filter(
    (n) => n.id !== focusId && !upstream.has(n.id) && !downstream.has(n.id),
  );
  const bands = [
    { label: 'Depends on this', nodes: stableSort(nodes.filter((n) => upstream.has(n.id))) },
    { label: 'Selected', nodes: [byId.get(focusId)] },
    { label: 'This depends on', nodes: stableSort(nodes.filter((n) => downstream.has(n.id))) },
    { label: 'Not directly related', nodes: rest },
  ];

  const positions = {};
  const lanes = [];
  let x = MARGIN_X;
  bands.forEach((band) => {
    if (!band.nodes.length) return;
    const consumed = placeBand(band.nodes, x, positions);
    lanes.push({
      label: band.label,
      orientation: 'column',
      at: x + Math.max(consumed - 40, CARD_W) / 2,
      count: band.nodes.length,
    });
    x += Math.max(consumed, CARD_W + 40) + BAND_GAP;
  });

  return {
    positions,
    height: Math.max(560, MARGIN_Y * 2 + Math.max(...bands.map((b) => bandHeight(b.nodes)), ROW_GAP)),
    width: x - BAND_GAP + MARGIN_X,
    lanes,
  };
}

/**
 * Compute a layout.
 *
 * `overrides` are user-dragged positions and win over the computed ones. They
 * are applied last so switching layout keeps a node the user deliberately
 * moved where they put it.
 */
export function computeLayout({ layout, nodes, edges, focusId, overrides }) {
  let result;
  switch (layout) {
    case 'hierarchical':
      result = hierarchical(nodes);
      break;
    case 'radial':
      result = radial(nodes, edges, focusId);
      break;
    case 'dependency':
      result = dependency(nodes, edges, focusId);
      break;
    case 'architecture':
    default:
      result = architecture(nodes);
      break;
  }

  if (overrides && Object.keys(overrides).length) {
    let { width, height } = result;
    Object.entries(overrides).forEach(([id, position]) => {
      if (!result.positions[id]) return; // dragged then filtered out
      result.positions[id] = position;
      width = Math.max(width, position.x + CARD_W);
      height = Math.max(height, position.y + CARD_H);
    });
    result = { ...result, width, height };
  }
  return result;
}

/** The bounding box of a set of positions, for fit-to-screen / fit-to-selection. */
export function boundsOf(positions, ids) {
  const list = (ids ? ids.map((id) => positions[id]) : Object.values(positions)).filter(Boolean);
  if (!list.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  list.forEach(({ x, y }) => {
    minX = Math.min(minX, x - CARD_W / 2);
    maxX = Math.max(maxX, x + CARD_W / 2);
    minY = Math.min(minY, y - CARD_H / 2);
    maxY = Math.max(maxY, y + CARD_H / 2);
  });
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Zoom and pan that bring `bounds` fully into a viewport of `vw` × `vh`. */
export function fitTo(bounds, vw, vh, { padding = 60, maxZoom = 1.4 } = {}) {
  if (!bounds || !vw || !vh) return null;
  const zoom = Math.max(
    0.08,
    Math.min(
      maxZoom,
      Math.min((vw - padding * 2) / Math.max(bounds.width, 1),
        (vh - padding * 2) / Math.max(bounds.height, 1)),
    ),
  );
  return {
    zoom,
    pan: {
      x: vw / 2 - (bounds.minX + bounds.width / 2) * zoom,
      y: vh / 2 - (bounds.minY + bounds.height / 2) * zoom,
    },
  };
}

/**
 * Group nodes for clustering (section 46).
 *
 * A group is (container, type) — a resource group's disks, a compartment's
 * volumes — because that is the grouping a person would draw a box around. The
 * cluster is a rendering decision only; the underlying nodes are never
 * removed from the data, so an individual resource stays inspectable.
 */
export function clusterNodes(nodes, edges, { minSize = 8, expanded } = {}) {
  // Grouped on a composite key held as an object rather than a joined string.
  // A container name can contain any character — resource groups and
  // compartments are user-named — so splitting a joined key back apart is a
  // bug waiting for the first group called "web app 1".
  const groups = new Map();
  nodes.forEach((node) => {
    if (node.is_synthetic) return;
    const container = node.resource_group || node.compartment_name || node.account_name || 'Ungrouped';
    const id = `cluster::${container}::${node.type}`;
    let group = groups.get(id);
    if (!group) {
      group = { id, container, type: node.type, members: [] };
      groups.set(id, group);
    }
    group.members.push(node);
  });

  const clustered = [];
  const collapsedIds = new Set();
  groups.forEach((group) => {
    if (group.members.length < minSize) return;
    // A cluster the user has expanded is simply never formed. Not building it
    // is much simpler than building it and undoing it, and it means an
    // expanded group behaves exactly like an ungrouped one rather than
    // almost like one.
    if (expanded?.has(group.id)) return;
    group.members.forEach((member) => collapsedIds.add(member.id));
    const sample = group.members[0];
    clustered.push({
      id: group.id,
      is_cluster: true,
      member_ids: group.members.map((member) => member.id),
      name: `${group.type} (${group.members.length})`,
      cluster_container: group.container,
      type: group.type,
      category: sample.category,
      provider: sample.provider,
      account_name: sample.account_name,
      region: sample.region,
      status: null,
      health: 'Unknown',
      drift_count: group.members.reduce((sum, m) => sum + (m.drift_count || 0), 0),
      event_count: group.members.reduce((sum, m) => sum + (m.event_count || 0), 0),
      exposed: group.members.some((m) => m.exposed),
      connection_count: group.members.reduce((sum, m) => sum + (m.connection_count || 0), 0),
    });
  });

  if (!clustered.length) return { nodes, edges, clusters: [] };

  const clusterOf = new Map();
  clustered.forEach((cluster) => {
    cluster.member_ids.forEach((id) => clusterOf.set(id, cluster.id));
  });

  const keptNodes = nodes.filter((n) => !collapsedIds.has(n.id)).concat(clustered);
  // Rewrite edges onto the cluster, then dedupe: forty volumes attached to one
  // instance become a single edge labelled once, which is the entire point.
  const seen = new Set();
  const keptEdges = [];
  edges.forEach((edge) => {
    const source = clusterOf.get(edge.source) || edge.source;
    const target = clusterOf.get(edge.target) || edge.target;
    if (source === target) return;
    const key = `${source}->${target}:${edge.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    // A rewritten edge needs its own id, and it must be stable across renders
    // or React would remount every line on each pass.
    keptEdges.push({ ...edge, source, target, id: `c:${key}` });
  });

  return { nodes: keptNodes, edges: keptEdges, clusters: clustered };
}
