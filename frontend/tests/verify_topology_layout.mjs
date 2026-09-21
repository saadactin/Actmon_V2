// utils/topologyLayout.js — graph placement, fit-to-screen, clustering.
//
// The highest-value assertion in the whole frontend test suite is section 2:
// EVERY node gets a finite x/y in EVERY layout, for every category the model
// defines. A single NaN coordinate does not throw and does not log — it
// silently blanks the entire canvas, and with the Vite HMR overlay disabled
// there is nothing on screen to say why. The usual cause is a category that
// exists in topologyModel's CATEGORY_ORDER but is missing from this file's
// (unexported) COLUMN_OF_CATEGORY / TIER_OF_CATEGORY maps, which yields
// `undefined` for the column index and NaN for every coordinate derived from
// it. Testing the OUTCOME rather than the private maps is deliberate: it
// catches that bug without depending on internals, and it keeps working if
// the maps are ever restructured.
import {
  ARCHITECTURE_COLUMNS, CARD_H, CARD_W, HIERARCHY_TIERS,
  boundsOf, clusterNodes, computeLayout, fitTo,
} from '../src/features/cloud/utils/topologyLayout.js';
import { CATEGORY_ORDER } from '../src/features/cloud/utils/topologyModel.js';

let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  (cond ? pass++ : fail++);
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`);
};

const LAYOUTS = ['architecture', 'hierarchical', 'radial', 'dependency'];

/** A node per category the model knows about, plus a few extras, so a
 *  category missing from either placement map shows up as a NaN here. */
const nodesForEveryCategory = () => CATEGORY_ORDER.map((category, i) => ({
  id: `n${i}`,
  name: `node-${i}`,
  type: `Type${i % 4}`,
  category,
  provider: 'AWS',
  account_name: 'acct',
}));

const sampleEdges = (nodes) => nodes.slice(1).map((n, i) => ({
  id: `e${i}`, source: nodes[i].id, target: n.id, type: 'depends_on',
}));

console.log('\n1. The placement maps cover every category the model defines');
{
  check('topologyModel exports a non-trivial CATEGORY_ORDER to test against',
    Array.isArray(CATEGORY_ORDER) && CATEGORY_ORDER.length >= 8,
    `${CATEGORY_ORDER.length} categories`);
  check('the architecture layout declares a header per column it can place into',
    ARCHITECTURE_COLUMNS.length >= 3, `${ARCHITECTURE_COLUMNS.length} columns`);
  check('the hierarchical layout declares a header per tier it can place into',
    HIERARCHY_TIERS.length >= 6, `${HIERARCHY_TIERS.length} tiers`);
}

console.log('\n2. THE ONE: every node lands at a finite coordinate, in every layout');
{
  const nodes = nodesForEveryCategory();
  const edges = sampleEdges(nodes);

  for (const layout of LAYOUTS) {
    const result = computeLayout({ layout, nodes, edges, focusId: nodes[0].id });
    const placed = Object.keys(result.positions);
    check(`${layout}: every node is placed (none silently dropped)`,
      placed.length === nodes.length, `${placed.length}/${nodes.length}`);

    const bad = Object.entries(result.positions)
      .filter(([, p]) => !Number.isFinite(p.x) || !Number.isFinite(p.y))
      .map(([id, p]) => `${id}=(${p.x},${p.y})`);
    check(`${layout}: NO node has a NaN or Infinite coordinate `
      + `(one NaN blanks the whole canvas, with nothing logged)`,
      bad.length === 0, bad.slice(0, 5).join(' '));

    check(`${layout}: the canvas has finite, positive dimensions`,
      Number.isFinite(result.width) && Number.isFinite(result.height)
      && result.width > 0 && result.height > 0,
      `${result.width}x${result.height}`);
  }

  // A category the model has never heard of must still place, not NaN.
  const unknownCategory = [{ id: 'x', name: 'x', type: 'T', category: 'Something New' }];
  for (const layout of LAYOUTS) {
    const result = computeLayout({ layout, nodes: unknownCategory, edges: [] });
    const p = result.positions.x;
    check(`${layout}: an UNKNOWN category still lands at a finite coordinate`,
      p && Number.isFinite(p.x) && Number.isFinite(p.y), JSON.stringify(p));
  }
}

console.log('\n3. Layout is deterministic — a graph must not jitter between renders');
{
  const nodes = nodesForEveryCategory();
  const edges = sampleEdges(nodes);
  const a = computeLayout({ layout: 'architecture', nodes, edges });
  const b = computeLayout({ layout: 'architecture', nodes, edges });
  check('two calls on the same input give identical positions',
    JSON.stringify(a.positions) === JSON.stringify(b.positions));

  // The stableSort guarantee: the API may return the same nodes in a
  // different order between polls, and the graph must not visibly reshuffle.
  const shuffled = [...nodes].reverse();
  const c = computeLayout({ layout: 'architecture', nodes: shuffled, edges });
  check('a SHUFFLED input array gives the same positions (stableSort holds) — '
    + 'otherwise the graph reshuffles itself on every refetch',
    JSON.stringify(a.positions) === JSON.stringify(c.positions));
}

console.log('\n4. An unknown layout falls back to architecture, never to a blank canvas');
{
  const nodes = nodesForEveryCategory();
  const fallback = computeLayout({ layout: 'not-a-layout', nodes, edges: [] });
  const architecture = computeLayout({ layout: 'architecture', nodes, edges: [] });
  check('a typo\'d layout id produces the architecture layout, not an empty one',
    JSON.stringify(fallback.positions) === JSON.stringify(architecture.positions));
  check('a typo\'d layout id still places every node',
    Object.keys(fallback.positions).length === nodes.length);
}

console.log('\n5. Dragged positions (overrides) survive, and grow the canvas');
{
  const nodes = nodesForEveryCategory();
  const overrides = { n0: { x: 9000, y: 7000 } };
  const result = computeLayout({ layout: 'architecture', nodes, edges: [], overrides });
  check('an override wins over the computed position',
    result.positions.n0.x === 9000 && result.positions.n0.y === 7000,
    JSON.stringify(result.positions.n0));
  check('the canvas grows to contain a dragged node, so it stays reachable',
    result.width >= 9000 + CARD_W && result.height >= 7000 + CARD_H,
    `${result.width}x${result.height}`);

  // A node dragged and then filtered out of the graph must not reappear as a
  // phantom at a stale coordinate.
  const ghost = computeLayout({
    layout: 'architecture', nodes, edges: [], overrides: { 'not-in-graph': { x: 1, y: 2 } },
  });
  check('an override for a node no longer in the graph is ignored, not resurrected',
    ghost.positions['not-in-graph'] === undefined);
}

console.log('\n6. boundsOf: null rather than an Infinity box');
{
  check('boundsOf({}) is null, never an Infinity-valued box '
    + '(an Infinity box reaches fitTo and produces zoom 0 — a blank viewport)',
    boundsOf({}) === null);
  check('boundsOf(positions, [missing-id]) is null', boundsOf({ a: { x: 0, y: 0 } }, ['nope']) === null);

  const single = boundsOf({ a: { x: 0, y: 0 } });
  check('a single node\'s bounds are exactly one card wide and tall '
    + '(the half-card margin keeps fit-to-screen from clipping the edges)',
    single.width === CARD_W && single.height === CARD_H,
    `${single.width}x${single.height}`);

  const two = boundsOf({ a: { x: 0, y: 0 }, b: { x: 500, y: 300 } });
  check('bounds span both nodes', two.width === 500 + CARD_W && two.height === 300 + CARD_H,
    `${two.width}x${two.height}`);
  check('every bound is finite',
    [two.minX, two.minY, two.maxX, two.maxY].every(Number.isFinite));
}

console.log('\n7. fitTo: clamped zoom, centred result, no division by a zero viewport');
{
  check('fitTo(null, ...) is null', fitTo(null, 800, 600) === null);
  check('fitTo with a zero-width viewport is null, not a divide-by-zero '
    + '(this happens on first paint, before the container is measured)',
    fitTo({ minX: 0, minY: 0, maxX: 10, maxY: 10, width: 10, height: 10 }, 0, 600) === null);
  check('fitTo with a zero-height viewport is null',
    fitTo({ minX: 0, minY: 0, maxX: 10, maxY: 10, width: 10, height: 10 }, 800, 0) === null);

  const tiny = fitTo({ minX: 0, minY: 0, maxX: 10, maxY: 10, width: 10, height: 10 }, 1600, 1200);
  check('a tiny graph clamps at maxZoom 1.4, it does not zoom to 40x',
    tiny.zoom === 1.4, String(tiny.zoom));

  const huge = fitTo({ minX: 0, minY: 0, maxX: 1e6, maxY: 1e6, width: 1e6, height: 1e6 }, 800, 600);
  check('a huge graph clamps at the 0.08 floor, it does not vanish',
    huge.zoom === 0.08, String(huge.zoom));

  const bounds = { minX: 100, minY: 50, maxX: 500, maxY: 350, width: 400, height: 300 };
  const fit = fitTo(bounds, 800, 600);
  const centreX = (bounds.minX + bounds.width / 2) * fit.zoom + fit.pan.x;
  const centreY = (bounds.minY + bounds.height / 2) * fit.zoom + fit.pan.y;
  check('the bounds centre maps to the viewport centre — fit-to-selection '
    + 'that leaves the selection off-screen is the classic failure',
    Math.abs(centreX - 400) < 0.001 && Math.abs(centreY - 300) < 0.001,
    `(${centreX}, ${centreY})`);
  check('zoom and pan are all finite',
    Number.isFinite(fit.zoom) && Number.isFinite(fit.pan.x) && Number.isFinite(fit.pan.y));
}

console.log('\n8. clusterNodes: threshold, expansion, and what a cluster claims');
{
  const mk = (i, over = {}) => ({
    id: `d${i}`, name: `disk-${i}`, type: 'Disk', category: 'Storage',
    resource_group: 'rg-1', provider: 'AWS', ...over,
  });

  const few = Array.from({ length: 5 }, (_, i) => mk(i));
  const notClustered = clusterNodes(few, [], { minSize: 8 });
  check('a group below minSize is not clustered, and the ORIGINAL arrays are '
    + 'returned unchanged (needless new objects force a full re-render)',
    notClustered.clusters.length === 0 && notClustered.nodes === few);

  const ten = Array.from({ length: 10 }, (_, i) => mk(i));
  const clustered = clusterNodes(ten, [], { minSize: 8 });
  check('a group at or above minSize is clustered', clustered.clusters.length === 1);
  check('the cluster holds every member id', clustered.clusters[0].member_ids.length === 10);
  check('the cluster is named "<type> (<count>)"',
    clustered.clusters[0].name === 'Disk (10)', clustered.clusters[0].name);
  check('the ten members are replaced by the one cluster node',
    clustered.nodes.length === 1 && clustered.nodes[0].is_cluster === true,
    String(clustered.nodes.length));

  // Boundary: exactly minSize clusters, one below does not.
  check('exactly minSize members clusters',
    clusterNodes(Array.from({ length: 8 }, (_, i) => mk(i)), [], { minSize: 8 }).clusters.length === 1);
  check('one below minSize does not',
    clusterNodes(Array.from({ length: 7 }, (_, i) => mk(i)), [], { minSize: 8 }).clusters.length === 0);

  const expanded = clusterNodes(ten, [], { minSize: 8, expanded: new Set(['cluster::rg-1::Disk']) });
  check('an EXPANDED group is never formed at all, so it behaves exactly like '
    + 'an ungrouped one rather than almost like one',
    expanded.clusters.length === 0 && expanded.nodes.length === 10);

  const withSynthetic = [...ten, { id: 'syn', name: 'vpc', type: 'Disk', category: 'Network', resource_group: 'rg-1', is_synthetic: true }];
  const syn = clusterNodes(withSynthetic, [], { minSize: 8 });
  check('a synthetic container node is never swallowed into a cluster',
    syn.nodes.some((n) => n.id === 'syn'));

  // The container name is user-supplied and may contain anything, including
  // the separator the group key is built from.
  const hostile = Array.from({ length: 10 }, (_, i) => mk(i, { resource_group: 'web app 1::x' }));
  const hostileResult = clusterNodes(hostile, [], { minSize: 8 });
  check('a container name containing "::" still clusters, and its name survives intact',
    hostileResult.clusters.length === 1
    && hostileResult.clusters[0].cluster_container === 'web app 1::x',
    hostileResult.clusters[0]?.cluster_container);
}

console.log('\n9. Cluster rollups never hide a problem');
{
  const members = Array.from({ length: 10 }, (_, i) => ({
    id: `d${i}`, name: `d${i}`, type: 'Disk', category: 'Storage', resource_group: 'rg',
    drift_count: 1, event_count: 2, connection_count: 1,
    exposed: i === 3, // exactly one exposed member
    health: 'Healthy', status: 'Running',
  }));
  const { clusters } = clusterNodes(members, [], { minSize: 8 });
  const cluster = clusters[0];

  check('ONE exposed member makes the whole cluster read as exposed — an '
    + 'exposed resource hidden inside a tidy cluster is a security-visible bug',
    cluster.exposed === true);
  check('drift counts sum across members', cluster.drift_count === 10, String(cluster.drift_count));
  check('event counts sum across members', cluster.event_count === 20, String(cluster.event_count));
  check('connection counts sum across members', cluster.connection_count === 10);
  check('a cluster\'s health is "Unknown", never inherited from one sample member '
    + '(ten resources do not share one health)', cluster.health === 'Unknown', cluster.health);
  check('a cluster\'s status is null, not one member\'s status', cluster.status === null,
    String(cluster.status));
}

console.log('\n10. Cluster edge rewriting: N edges collapse to one, self-edges vanish');
{
  const disks = Array.from({ length: 10 }, (_, i) => ({
    id: `d${i}`, name: `d${i}`, type: 'Disk', category: 'Storage', resource_group: 'rg',
  }));
  const host = { id: 'vm1', name: 'vm1', type: 'VM', category: 'Compute', resource_group: 'rg' };
  const edges = disks.map((d, i) => ({ id: `e${i}`, source: d.id, target: 'vm1', type: 'attached_to' }));

  const result = clusterNodes([...disks, host], edges, { minSize: 8 });
  const toHost = result.edges.filter((e) => e.target === 'vm1');
  check('ten disk→instance edges collapse to ONE cluster→instance edge',
    toHost.length === 1, `${toHost.length} edges`);
  check('the rewritten edge has a stable id (React would remount every line otherwise)',
    typeof toHost[0].id === 'string' && toHost[0].id.startsWith('c:'), toHost[0].id);

  // Two disks in the same cluster, linked to each other: that edge is now
  // a loop on the cluster and must disappear rather than render as an artifact.
  const selfEdges = [{ id: 'self', source: 'd0', target: 'd1', type: 'depends_on' }];
  const selfResult = clusterNodes(disks, selfEdges, { minSize: 8 });
  check('an edge between two members of the SAME cluster is dropped, not drawn '
    + 'as a self-loop artifact', selfResult.edges.length === 0, String(selfResult.edges.length));
}

console.log('\n11. A clustered graph still lays out at finite coordinates');
{
  const disks = Array.from({ length: 10 }, (_, i) => ({
    id: `d${i}`, name: `d${i}`, type: 'Disk', category: 'Storage', resource_group: 'rg',
  }));
  const host = { id: 'vm1', name: 'vm1', type: 'VM', category: 'Compute', resource_group: 'rg' };
  const edges = disks.map((d, i) => ({ id: `e${i}`, source: d.id, target: 'vm1', type: 'attached_to' }));
  const clustered = clusterNodes([...disks, host], edges, { minSize: 8 });

  for (const layout of LAYOUTS) {
    const result = computeLayout({
      layout, nodes: clustered.nodes, edges: clustered.edges, focusId: 'vm1',
    });
    const bad = Object.values(result.positions).filter((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y));
    check(`${layout}: a CLUSTERED graph places at finite coordinates too `
      + `(a cluster's category comes from a sample member, which is where an `
      + `undefined can creep in)`, bad.length === 0, `${bad.length} bad`);
  }
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) process.exit(1);
