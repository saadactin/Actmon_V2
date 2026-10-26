/* The layout and classification behind the execution-plan diagram.
   A node placed in the wrong column, or a cheap step painted red, is wrong in
   a way no build and no render check would catch. */
import {
  buildPlanGraph, classifyOperation, edgePath, fitScale, layoutTree, num, severityFor,
  NODE_W, NODE_H, GAP_X,
} from 'file:///E:/ACTMON%20V1/frontend/src/pages/_shared/planLayout.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ', m); } else { fail++; console.log('  FAIL ', m); } };

/* A real shape: SELECT over a filter with two children, one of them a full
   scan, mirroring the plan in the screenshot. */
const ROWS = [
  { id: 0, parent_id: null, depth: 0, operation: 'SELECT STATEMENT', options: '', cost: 4205394 },
  { id: 1, parent_id: 0, depth: 1, operation: 'TEMP TABLE TRANSFORMATION', options: '', cost: 0 },
  { id: 2, parent_id: 1, depth: 2, operation: 'LOAD AS SELECT', options: 'CURSOR DURATION MEMORY', cost: 0 },
  { id: 3, parent_id: 2, depth: 3, operation: 'FILTER', options: '', cost: 0 },
  {
    id: 4, parent_id: 3, depth: 4, operation: 'TABLE ACCESS', options: 'FULL',
    object_owner: 'SYS', object_name: 'EXP_HEAD$', object_type: 'TABLE',
    cost: 4781, cardinality: 1574316, bytes: null, cpu_cost: null, io_cost: null,
    filter_predicates: '"E"."OBJ#" IS NOT NULL',
  },
  {
    id: 5, parent_id: 3, depth: 4, operation: 'INDEX', options: 'RANGE SCAN',
    object_owner: 'SYS', object_name: 'I_OBJ1', object_type: 'INDEX',
    cost: 3, cardinality: 1, access_predicates: '"O"."OBJ#"="E"."OBJN"',
  },
  { id: 6, parent_id: 1, depth: 2, operation: 'HASH JOIN', options: 'ANTI', cost: 10199, cardinality: 1574293 },
];

console.log('=== a value Oracle did not report is not a number ===');
ok(num(null) === null && num(undefined) === null && num('') === null, 'absent is null');
ok(num(0) === 0, 'zero is a real value and survives');
ok(num('4781') === 4781, 'a numeric string is read');
ok(num('n/a') === null, 'unparseable text is null, not NaN');

console.log('\n=== steps are grouped by what they do ===');
ok(classifyOperation('TABLE ACCESS', 'FULL') === 'access', 'a table read is an access');
ok(classifyOperation('INDEX', 'RANGE SCAN') === 'access', 'an index read is an access');
ok(classifyOperation('HASH JOIN', 'ANTI') === 'join', 'a hash join is a join');
ok(classifyOperation('NESTED LOOPS', '') === 'join', 'nested loops is a join');
ok(classifyOperation('UNION-ALL', '') === 'join', 'a union combines row sources');
ok(classifyOperation('SORT', 'AGGREGATE') === 'sort', 'a sort is a sort');
ok(classifyOperation('HASH', 'GROUP BY') === 'sort', 'a group by is grouped with sorts');
ok(classifyOperation('FILTER', '') === 'filter', 'a filter is a filter');
ok(classifyOperation('COUNT', 'STOPKEY') === 'filter', 'count stopkey is a filter');
ok(classifyOperation('SELECT STATEMENT', '') === 'operation', 'the root is a plain operation');
ok(classifyOperation('', '') === 'operation', 'an unnamed step still classifies');

console.log('\n=== severity comes from the data, never from the operation name alone ===');
ok(severityFor({ cost: 60, operation: 'HASH JOIN' }, 100) === 'critical',
   'a step holding half the plan cost is critical');
ok(severityFor({ cost: 25, operation: 'HASH JOIN' }, 100) === 'warning',
   'a fifth of the plan cost is a warning');
ok(severityFor({ cost: 5, operation: 'HASH JOIN' }, 100) === null,
   'a cheap join is not coloured');
ok(severityFor({ cost: 1, operation: 'TABLE ACCESS', options: 'FULL' }, 100) === 'warning',
   'a cheap full scan still warns — cheap today depends on today\'s row count');
ok(severityFor({ cost: 30, operation: 'TABLE ACCESS', options: 'FULL' }, 100) === 'critical',
   'an expensive full scan is critical');
ok(severityFor({ cost: null, operation: 'HASH JOIN' }, 100) === null,
   'a step with no cost is not guessed at');
ok(severityFor({ cost: 50, operation: 'HASH JOIN' }, 0) === null,
   'with no plan total there is no share, so no verdict');

console.log('\n=== the graph keeps every column Oracle returned ===');
const g = buildPlanGraph(ROWS);
ok(g.root.id === 0, 'row 0 is the root');
ok(g.count === 7, 'every row became a node');
ok(g.root.children.length === 1, 'the root has one child');
ok(g.byId.get(3).children.map((c) => c.id).join(',') === '4,5', 'children are in plan order');
ok(g.byId.get(4).raw.filter_predicates === '"E"."OBJ#" IS NOT NULL',
   'the original row is kept, so the details panel can show columns the card has no room for');
ok(g.byId.get(4).objectName === 'EXP_HEAD$' && g.byId.get(4).objectType === 'TABLE',
   'object identity is carried through');
ok(g.byId.get(4).severity === 'warning', 'the full scan is flagged from its own numbers');
ok(g.byId.get(0).severity === 'critical', 'the step holding all the cost is critical');
ok(Math.abs(g.byId.get(4).costShare - 4781 / 4205394) < 1e-9, 'cost share is of the plan total');
ok(g.byId.get(5).bytes === null, 'a column Oracle left empty stays null, not 0');
ok(buildPlanGraph([]) === null && buildPlanGraph(null) === null, 'no rows means no graph');

console.log('\n=== nothing is presented as a measurement ===');
const SRC = (await import('node:fs')).readFileSync(
  'E:/ACTMON V1/frontend/src/pages/_shared/planLayout.js', 'utf8');
ok(!/\belapsed|actualTime|\bduration\b/i.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '')),
   'the module invents no per-step elapsed time — v$sql_plan has none');
ok(/estimate/i.test(SRC), 'and says in the file that these figures are estimates');

console.log('\n=== layout: siblings never collide ===');
const L = layoutTree(g.root);
ok(L.nodes.length === 7, 'every node is placed');
const byId = new Map(L.nodes.map((n) => [n.node.id, n]));
ok(byId.get(4).y === byId.get(5).y, 'siblings share a row');
ok(byId.get(4).x + byId.get(4).w <= byId.get(5).x, 'and do not overlap horizontally');
ok(byId.get(5).x - (byId.get(4).x + byId.get(4).w) === GAP_X, 'with exactly the configured gap');
ok(byId.get(0).y === 0 && byId.get(1).y === NODE_H + 58, 'depth drives the row');

const parentCentre = byId.get(3).x + NODE_W / 2;
const kidsCentre = (byId.get(4).x + (byId.get(5).x + NODE_W)) / 2;
ok(Math.abs(parentCentre - kidsCentre) < 0.5, 'a parent is centred over its children');

console.log('\n=== layout: two deep branches do not land on each other ===');
const WIDE = [
  { id: 0, parent_id: null, operation: 'SELECT STATEMENT', cost: 10 },
  { id: 1, parent_id: 0, operation: 'HASH JOIN' },
  { id: 2, parent_id: 0, operation: 'HASH JOIN' },
  { id: 3, parent_id: 1, operation: 'TABLE ACCESS', options: 'FULL' },
  { id: 4, parent_id: 1, operation: 'TABLE ACCESS', options: 'FULL' },
  { id: 5, parent_id: 2, operation: 'TABLE ACCESS', options: 'FULL' },
  { id: 6, parent_id: 2, operation: 'TABLE ACCESS', options: 'FULL' },
];
const W = layoutTree(buildPlanGraph(WIDE).root);
const row = W.nodes.filter((n) => n.y === W.nodes.find((x) => x.node.id === 3).y)
  .sort((a, b) => a.x - b.x);
ok(row.length === 4, 'all four leaves share the bottom row');
let clear = true;
for (let i = 1; i < row.length; i++) if (row[i].x < row[i - 1].x + row[i - 1].w) clear = false;
ok(clear, 'no two leaves overlap, even across different branches');
const b1 = W.nodes.find((n) => n.node.id === 1);
const b2 = W.nodes.find((n) => n.node.id === 2);
ok(b1.x + b1.w <= b2.x, 'the two branch roots are side by side, not stacked');

console.log('\n=== edges ===');
const p = byId.get(3); const c = byId.get(4);
const d = edgePath(p, c);
ok(d.startsWith(`M ${p.x + p.w / 2} ${p.y + p.h}`), 'an edge leaves the parent\'s bottom centre');
ok(d.trim().endsWith(`${c.x + c.w / 2} ${c.y}`), 'and arrives at the child\'s top centre');
ok(edgePath(byId.get(0), byId.get(1)).split('L').length === 2,
   'a single child gets a straight stem, not a pointless dog-leg');

console.log('\n=== fit ===');
ok(fitScale({ width: 1000, height: 500 }, { width: 500, height: 500 }) < 0.5,
   'wide content scales down to fit');
ok(fitScale({ width: 100, height: 100 }, { width: 1000, height: 1000 }) === 1,
   'a small plan is not blown up past 1:1');
ok(fitScale(null, { width: 100, height: 100 }) === 1, 'no content means no scaling');
ok(fitScale({ width: 1e6, height: 1e6 }, { width: 10, height: 10 }) >= 0.1,
   'an enormous plan still has a usable floor');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
