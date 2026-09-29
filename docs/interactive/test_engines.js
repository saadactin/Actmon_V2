/* Every database technology must now get the level-2 treatment PostgreSQL had:
   its own environment, its own real tab list, and every tab reachable with
   substantive content. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = 'E:/ACTMON V1/docs/interactive';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m); } else { fail++; console.log('  FAIL  ' + m); } };

/* minimal THREE (same shape as test_envs.js) */
class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  clone() { return new V3(this.x, this.y, this.z); }
  copy(v) { return this.set(v.x, v.y, v.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  normalize() { const l = this.length() || 1; return this.multiplyScalar(1 / l); }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  lerpVectors(a, b, t) { this.x = a.x + (b.x - a.x) * t; this.y = a.y + (b.y - a.y) * t; this.z = a.z + (b.z - a.z) * t; return this; }
  setScalar(s) { return this.set(s, s, s); }
  getWorldPosition(t) { return (t || new V3()).copy(this); }
  project() { return this; }
}
class Obj3D {
  constructor() { this.children = []; this.position = new V3(); this.rotation = new V3(); this.scale = new V3(1, 1, 1); this.userData = {}; }
  add(o) { if (o) this.children.push(o); return this; }
  remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); return this; }
  traverse(fn) { fn(this); this.children.forEach(c => c.traverse && c.traverse(fn)); }
  lookAt() { return this; }
  getWorldPosition(t) { return (t || new V3()).copy(this.position); }
  clone() { const c = new Obj3D(); c.position.copy(this.position); return c; }
}
function Geo(n) { return function (...a) { return { type: n, args: a, dispose() {} }; }; }
function Mat(o) { return Object.assign({ dispose() {} }, o); }
const THREE = {
  Vector3: V3, Vector2: class { constructor(x, y) { this.x = x; this.y = y; } set() {} },
  Object3D: Obj3D, Group: Obj3D,
  Mesh: class extends Obj3D { constructor(g, m) { super(); this.geometry = g; this.material = m; } },
  Points: class extends Obj3D { constructor(g, m) { super(); this.geometry = g; this.material = m; } },
  Line: class extends Obj3D { constructor(g, m) { super(); this.geometry = g; this.material = m; } },
  Sprite: class extends Obj3D { constructor(m) { super(); this.material = m; } },
  BufferGeometry: class { constructor() { this.attributes = {}; } setAttribute(k, a) { this.attributes[k] = a; return this; } setFromPoints(p) { this.attributes.position = { count: p.length }; return this; } dispose() {} },
  BufferAttribute: class { constructor(a, n) { this.array = a; this.count = a.length / n; } setXYZ() {} setY() {} getY() { return 0; } },
  QuadraticBezierCurve3: class { constructor(a, b, c) { this.a = a; this.c = c; } getPoints(n) { const o = []; for (let i = 0; i <= n; i++) o.push(this.getPoint(i / n)); return o; } getPoint(t) { return new V3().lerpVectors(this.a, this.c, t); } },
  CatmullRomCurve3: class { constructor(p) { this.p = p; } getPoints() { return this.p; } getPoint(t) { return this.p[0]; } },
  Color: class { constructor(h) { this.h = h | 0; } lerp() { return this; } getHex() { return this.h; } },
  GridHelper: class extends Obj3D { constructor() { super(); this.material = { transparent: false, opacity: 1, dispose() {} }; } },
  MeshStandardMaterial: Mat, MeshBasicMaterial: Mat, PointsMaterial: Mat, SpriteMaterial: Mat, LineBasicMaterial: Mat,
  CanvasTexture: function () { return { dispose() {}, minFilter: null }; },
  IcosahedronGeometry: Geo('Icosahedron'), SphereGeometry: Geo('Sphere'), CylinderGeometry: Geo('Cylinder'),
  BoxGeometry: Geo('Box'), TorusGeometry: Geo('Torus'), ConeGeometry: Geo('Cone'),
  OctahedronGeometry: Geo('Octahedron'), PlaneGeometry: Geo('Plane'), RingGeometry: Geo('Ring'), TubeGeometry: Geo('Tube'),
  BackSide: 1, DoubleSide: 2, LinearFilter: 1,
};
const sandbox = {
  THREE, console, Math, Date, Set, Map, Array, Object, JSON, String, Number, isFinite, parseFloat, Float32Array,
  window: {},
  document: { createElement: () => ({ className: '', innerHTML: '', style: {}, classList: { add() {} }, appendChild() {}, remove() {}, querySelector: () => ({ textContent: '' }), getContext: () => null }) },
};
sandbox.window.document = sandbox.document;
vm.createContext(sandbox);
['actmon-data.js', 'actmon-samples.js', 'actmon-engines.js', 'actmon-scene.js', 'actmon-envs.js'].forEach(f => {
  vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: f });
});
const D = sandbox.window.ACTMON, EN = sandbox.window.ACTMON_ENGINES;
const AS = sandbox.window.AScene, E = sandbox.window.AEnvs;

console.log('=== 1. tab inventories match the real nav configs ===');
ok(!!EN, 'engine module loaded');
// These counts were read out of each engine's nav config.
const EXPECTED = { mysql: 15, mariadb: 15, oracle: 20, mssql: 16, mongodb: 14, clickhouse: 13, cosmosdb: 9 };
const wrong = [];
Object.keys(EXPECTED).forEach(id => {
  const n = EN.ENGINE_TABS[id] ? EN.ENGINE_TABS[id].tabs.length : 0;
  if (n !== EXPECTED[id]) wrong.push(id + ': ' + n + ' (expected ' + EXPECTED[id] + ')');
});
ok(wrong.length === 0, 'every engine has its recorded number of sections' + (wrong.length ? ' [' + wrong.join(', ') + ']' : ''));
Object.keys(EN.ENGINE_TABS).forEach(id => {
  const e = D.ENGINES.find(x => x.id === id);
  console.log('     ' + (e ? e.label : id).padEnd(18) + String(EN.ENGINE_TABS[id].tabs.length).padStart(3) + ' sections');
});

console.log('\n=== 2. every engine in the catalogue has sections ===');
const covered = D.ENGINES.filter(e => e.id !== 'postgresql').map(e => e.id);
const uncovered = covered.filter(id => !EN.ENGINE_TABS[id]);
ok(uncovered.length === 0, 'no engine is left without a tab list' + (uncovered.length ? ' [' + uncovered.join(', ') + ']' : ''));
ok(D.PG_TABS.length === 17, 'PostgreSQL still has its 16 tabs + detail page');

console.log('\n=== 3. engine vocabulary is preserved, not normalised ===');
const mssql = EN.ENGINE_TABS.mssql.tabs;
ok(mssql.some(t => t.label === 'Logins'), 'SQL Server says "Logins", not "Users"');
ok(mssql.some(t => t.label === 'Always On'), 'SQL Server says "Always On", not "Replication"');
ok(EN.ENGINE_TABS.oracle.tabs.some(t => t.label === 'Top SQL'), 'Oracle says "Top SQL"');
ok(EN.ENGINE_TABS.mongodb.tabs.some(t => t.label === 'Collections'), 'MongoDB says "Collections", not "Tables"');
ok(EN.ENGINE_TABS.clickhouse.tabs.some(t => t.label === 'Partitions')
  && EN.ENGINE_TABS.clickhouse.tabs.some(t => t.label === 'Merges'), 'ClickHouse keeps Partitions and Merges');
ok(EN.ENGINE_TABS.mysql.tabs.some(t => t.label === 'Binary Logs'), 'MySQL keeps Binary Logs');

console.log('\n=== 4. every section explains itself ===');
const thin = [];
Object.keys(EN.ENGINE_TABS).forEach(id => {
  EN.ENGINE_TABS[id].tabs.forEach(t => {
    if (!t.what || t.what.length < 25) thin.push(id + '/' + t.id + ' (what)');
    if (!t.why || t.why.length < 25) thin.push(id + '/' + t.id + ' (why)');
  });
});
ok(thin.length === 0, 'every section has a substantive what and why' + (thin.length ? ' [' + thin.slice(0, 6).join(', ') + ']' : ''));

console.log('\n=== 5. each engine builds its own distinct environment ===');
function build(engineId) {
  const e = D.ENGINES.find(x => x.id === engineId);
  const labels = new AS.Labels({ appendChild() {} });
  const ctx = {
    group: new Obj3D(), data: D, samples: sandbox.window.ACTMON_SAMPLES, labels,
    level: { engineData: e, engineTabs: EN.ENGINE_TABS[engineId].tabs },
    picks: [], flows: [], spinners: [], pulsers: [], streams: [],
  };
  const desc = E.engine_generic(ctx);
  return { ctx, desc };
}
const builtE = {}; const broke = [];
Object.keys(EN.ENGINE_TABS).forEach(id => {
  try {
    const r = build(id);
    builtE[id] = r;
    if (!r.desc.pose || !r.desc.title || !r.desc.limits) broke.push(id + ' (incomplete descriptor)');
    if (r.ctx.picks.length !== EN.ENGINE_TABS[id].tabs.length) {
      broke.push(id + ' (' + r.ctx.picks.length + ' objects for ' + EN.ENGINE_TABS[id].tabs.length + ' tabs)');
    }
  } catch (err) { broke.push(id + ' THREW: ' + err.message); }
});
ok(broke.length === 0, 'all ' + Object.keys(EN.ENGINE_TABS).length + ' engine environments build, one object per section'
  + (broke.length ? '\n        ' + broke.join('\n        ') : ''));

// Central identity must differ by family, or "every module looks identical"
// is simply true again at this level.
function centreShapes(id) {
  const kinds = new Set();
  const g = builtE[id].ctx.group;
  g.children.slice(0, 3).forEach(c => c.traverse(o => { if (o.geometry) kinds.add(o.geometry.type); }));
  return [...kinds].sort().join(',');
}
const mongoC = centreShapes('mongodb'), chC = centreShapes('clickhouse'), myC = centreShapes('mysql'), cosC = centreShapes('cosmosdb');
ok(new Set([mongoC, chC, cosC]).size === 3, 'MongoDB, ClickHouse and Cosmos each get a different central structure');
console.log('     MySQL      ' + myC);
console.log('     MongoDB    ' + mongoC);
console.log('     ClickHouse ' + chC);
console.log('     Cosmos DB  ' + cosC);

// Oracle's 20 sections must split into two rings; Cosmos's 9 must not.
const oraclePicks = builtE.oracle.ctx.picks.map(p => Math.round(Math.hypot(p.userData.node.focus.x, p.userData.node.focus.z)));
const cosmosPicks = builtE.cosmosdb.ctx.picks.map(p => Math.round(Math.hypot(p.userData.node.focus.x, p.userData.node.focus.z)));
ok(new Set(oraclePicks).size >= 2, 'Oracle\'s 20 sections spread over two rings (' + [...new Set(oraclePicks)].join(', ') + ')');
ok(new Set(cosmosPicks).size === 1, 'Cosmos DB\'s 9 sit on one ring (' + [...new Set(cosmosPicks)].join(', ') + ')');

console.log('\n=== 6. conditional sections are marked, not hidden ===');
const cond = EN.ENGINE_TABS.oracle.tabs.filter(t => t.conditional);
ok(cond.length === 1 && cond[0].id === 'dataguard', 'Data Guard is flagged conditional');
ok(EN.ORACLE_CONDITIONAL.length === 5, 'the five topology-dependent sections are recorded (' + EN.ORACLE_CONDITIONAL.length + ')');
ok(EN.ORACLE_CONDITIONAL.every(c => c.when), 'each says the condition it appears under');

console.log('\n=== 7. depth is disclosed, not implied ===');
ok(/traced\s+exhaustively for PostgreSQL only/i.test(EN.ENGINE_DEPTH_NOTE), 'the depth caveat names PostgreSQL as the exception');
const allInventory = Object.keys(EN.ENGINE_TABS).every(id => EN.ENGINE_TABS[id].depth === 'inventory');
ok(allInventory, 'every non-PostgreSQL engine is marked inventory-depth');
ok(!!EN.ENGINE_TABS.mariadb.shared, 'MariaDB states that it rides the MySQL path');

console.log('\n' + '='.repeat(58));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('='.repeat(58));
process.exit(fail ? 1 : 0);
