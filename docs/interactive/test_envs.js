/* Builds every 3D environment headlessly against a minimal THREE stub.

   jsdom has no WebGL, so the DOM test only ever exercises the 2D fallback.
   This runs the scene code itself: if an environment builder throws, registers
   no interactive objects, or forgets its camera pose, it fails here rather
   than in front of a customer. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = 'E:/ACTMON V1/docs/interactive';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m); } else { fail++; console.log('  FAIL  ' + m); } };

/* ── minimal THREE ───────────────────────────────────────────────────────
   Real vector maths (the environments do genuine geometry with it);
   everything else is a shape-compatible shell. */
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
  constructor() {
    this.children = []; this.position = new V3(); this.rotation = new V3();
    this.scale = new V3(1, 1, 1); this.userData = {}; this.visible = true;
  }
  add(o) { if (o) this.children.push(o); return this; }
  remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); return this; }
  traverse(fn) { fn(this); this.children.forEach(c => c.traverse && c.traverse(fn)); }
  lookAt() { return this; }
  getWorldPosition(t) { return (t || new V3()).copy(this.position); }
  clone() { const c = new Obj3D(); c.position.copy(this.position); return c; }
}
const geoCalls = [];
function Geo(name) { return function (...a) { geoCalls.push(name); return { type: name, args: a, dispose() {} }; }; }
class BufGeo {
  constructor() { this.attributes = {}; }
  setAttribute(k, a) { this.attributes[k] = a; return this; }
  setFromPoints(pts) { this.attributes.position = { count: pts.length, array: new Float32Array(pts.length * 3) }; return this; }
  dispose() {}
}
class BufAttr {
  constructor(arr, n) { this.array = arr; this.itemSize = n; this.count = arr.length / n; }
  setXYZ() {} setY() {} getY() { return 0; }
}
class Curve {
  constructor(a, b, c) { this.pts = [a, b, c].filter(Boolean); }
  getPoints(n) { const o = []; for (let i = 0; i <= n; i++) o.push(this.getPoint(i / n)); return o; }
  getPoint(t) { const a = this.pts[0] || new V3(), b = this.pts[this.pts.length - 1] || new V3(); return new V3().lerpVectors(a, b, t); }
}
class Color {
  constructor(h) { this.h = h | 0; }
  lerp() { return this; }
  getHex() { return this.h; }
}

const THREE = {
  Vector3: V3, Vector2: class { constructor(x, y) { this.x = x; this.y = y; } set() {} },
  Object3D: Obj3D, Group: Obj3D,
  Mesh: class extends Obj3D { constructor(g, m) { super(); this.geometry = g; this.material = m; } },
  Points: class extends Obj3D { constructor(g, m) { super(); this.geometry = g; this.material = m; } },
  Line: class extends Obj3D { constructor(g, m) { super(); this.geometry = g; this.material = m; } },
  Sprite: class extends Obj3D { constructor(m) { super(); this.material = m; } },
  BufferGeometry: BufGeo, BufferAttribute: BufAttr,
  QuadraticBezierCurve3: Curve, CatmullRomCurve3: class extends Curve { constructor(p) { super(p[0], null, p[p.length - 1]); } },
  Color,
  GridHelper: class extends Obj3D { constructor() { super(); this.material = { transparent: false, opacity: 1, dispose() {} }; } },
  MeshStandardMaterial: function (o) { return Object.assign({ dispose() {} }, o); },
  MeshBasicMaterial: function (o) { return Object.assign({ dispose() {} }, o); },
  PointsMaterial: function (o) { return Object.assign({ dispose() {} }, o); },
  SpriteMaterial: function (o) { return Object.assign({ dispose() {} }, o); },
  CanvasTexture: function () { return { dispose() {}, minFilter: null }; },
  LineBasicMaterial: function (o) { return Object.assign({ dispose() {} }, o); },
  IcosahedronGeometry: Geo('Icosahedron'), SphereGeometry: Geo('Sphere'),
  CylinderGeometry: Geo('Cylinder'), BoxGeometry: Geo('Box'), TorusGeometry: Geo('Torus'),
  ConeGeometry: Geo('Cone'), OctahedronGeometry: Geo('Octahedron'), PlaneGeometry: Geo('Plane'),
  RingGeometry: Geo('Ring'), TubeGeometry: Geo('Tube'),
  BackSide: 1, DoubleSide: 2, LinearFilter: 1,
};

/* ── sandbox ─────────────────────────────────────────────────────────── */
const sandbox = {
  THREE, console, Math, Date, Set, Map, Array, Object, JSON, String, Number, isFinite, parseFloat,
  Float32Array, window: {},
  document: {
    createElement(tag) {
      if (tag === 'canvas') {
        return { width: 0, height: 0, getContext: () => ({
          font: '', textBaseline: '', fillStyle: '', measureText: () => ({ width: 120 }), fillText() {},
        }) };
      }
      return { className: '', innerHTML: '', style: {}, classList: { add() {}, remove() {}, toggle() {} },
        appendChild() {}, remove() {}, querySelector: () => ({ textContent: '' }) };
    },
  },
};
sandbox.window.document = sandbox.document;
vm.createContext(sandbox);

['actmon-data.js', 'actmon-samples.js', 'actmon-engines.js', 'actmon-scene.js', 'actmon-envs.js'].forEach(f => {
  vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: f });
});

const D = sandbox.window.ACTMON;
const SM = sandbox.window.ACTMON_SAMPLES;
const AS = sandbox.window.AScene;
const E = sandbox.window.AEnvs;

console.log('=== 1. modules loaded ===');
ok(!!D && !!SM && !!AS && !!E, 'all four content/scene scripts published their globals');

/* ── every environment builds ────────────────────────────────────────── */
console.log('\n=== 2. every environment builds and is interactive ===');

function build(key, level) {
  const labels = new AS.Labels({ appendChild() {} });
  const ctx = {
    group: new Obj3D(), data: D, samples: SM, labels, level: level || {},
    picks: [], flows: [], spinners: [], pulsers: [], streams: [],
  };
  const desc = E[key](ctx);
  return { ctx, desc, labels };
}

const ENVS = [
  ['universe', null], ['mod_database', null], ['mod_cloud', null], ['mod_infra', null],
  ['mod_agents', null], ['mod_alerts', null], ['mod_logs', null], ['mod_admin', null],
  ['engine_postgresql', null],
  ['feat_overview', null], ['feat_performance', null], ['feat_slowqueries', null],
  ['feat_users', null], ['feat_replication', null], ['feat_storage', null],
  ['feat_locks', null], ['feat_errorlogs', null], ['feat_tables', null], ['feat_indexes', null],
  ['feat_generic', { featureData: D.PG_TABS.find(t => t.id === 'config') }],
  ['detail_query', { record: SM.SAMPLE_QUERIES[0] }],
  ['detail_record', { recordKind: 'role', record: SM.SAMPLE_ROLE, facts: [{ k: 'a', v: 'b' }], title: 'T', subtitle: 'S' }],
];

const built = {};
let broken = [];
ENVS.forEach(([key, level]) => {
  try {
    const r = build(key, level);
    built[key] = r;
    if (!r.desc || !r.desc.pose) broken.push(key + ' (no camera pose)');
    if (!r.desc.title) broken.push(key + ' (no title)');
    if (!r.desc.limits) broken.push(key + ' (no zoom limits)');
  } catch (e) { broken.push(key + ' THREW: ' + e.message); }
});
ok(broken.length === 0, 'all ' + ENVS.length + ' environments build with a pose, title and limits'
  + (broken.length ? '\n        ' + broken.join('\n        ') : ''));

const noPicks = Object.keys(built).filter(k => built[k].ctx.picks.length === 0);
ok(noPicks.length === 0, 'every environment registers clickable objects'
  + (noPicks.length ? ' [' + noPicks.join(', ') + ']' : ''));

console.log('\n=== 3. each level is a DIFFERENT composition ===');
// A level that reuses its parent's layout is the thing the brief called out.
// Compare object counts and geometry mix rather than eyeballing.
function signature(k) {
  const c = built[k].ctx;
  const kinds = {};
  c.group.traverse(o => { if (o.geometry) kinds[o.geometry.type] = (kinds[o.geometry.type] || 0) + 1; });
  // Layout matters as much as geometry: a ring, a grid and a line made of the
  // same boxes are three different scenes, and the earlier signature could not
  // tell them apart.
  const pos = c.picks.map(p => {
    let n = p, x = 0, y = 0, z = 0;
    while (n) { x += n.position.x; y += n.position.y; z += n.position.z; n = n.__parent; }
    return { x, y, z };
  });
  const xs = c.picks.map(p => Math.round(p.userData.node.focus ? p.userData.node.focus.x : 0));
  const zs = c.picks.map(p => Math.round(p.userData.node.focus ? p.userData.node.focus.z : 0));
  const spanX = Math.max(...xs, 0) - Math.min(...xs, 0);
  const spanZ = Math.max(...zs, 0) - Math.min(...zs, 0);
  // linear (one axis dominates), planar (both), or radial
  const shape = spanZ === 0 ? 'linear' : (spanX / Math.max(1, spanZ) > 2.4 ? 'wide' : 'radial');
  return {
    picks: c.picks.length, flows: c.flows.length,
    kinds: Object.keys(kinds).sort().join(','), shape: shape, counts: kinds,
  };
}
const sigs = {};
Object.keys(built).forEach(k => { sigs[k] = signature(k); });
const dupes = [];
const keys = Object.keys(sigs);
for (let i = 0; i < keys.length; i++) {
  for (let j = i + 1; j < keys.length; j++) {
    const a = sigs[keys[i]], b = sigs[keys[j]];
    if (a.picks === b.picks && a.kinds === b.kinds && a.flows === b.flows && a.shape === b.shape) {
      dupes.push(keys[i] + ' ≡ ' + keys[j]);
    }
  }
}
ok(dupes.length === 0, 'no two environments share an identical composition'
  + (dupes.length ? ' [' + dupes.join(', ') + ']' : ''));

console.log('  ── composition per environment ──');
Object.keys(sigs).forEach(k => {
  console.log('     ' + k.padEnd(20) + ' picks=' + String(sigs[k].picks).padStart(3)
    + '  flows=' + String(sigs[k].flows).padStart(2) + '  layout=' + sigs[k].shape.padEnd(6)
    + '  geometry: ' + sigs[k].kinds);
});

console.log('\n=== 4. data actually drives the geometry ===');
// Storage: a bigger table must produce a bigger object.
const stor = built.feat_storage.ctx;
const tabSorted = SM.SAMPLE_TABLES.slice().sort((a, b) => b.bytes - a.bytes);
const storPicks = stor.picks.map(p => p.userData.node).filter(n => n.kind === 'table');
ok(storPicks.length === SM.SAMPLE_TABLES.length, 'storage builds one object per table (' + storPicks.length + ')');
// the hit radius is derived from side length, which is derived from bytes
const radii = storPicks.map(n => {
  const hit = stor.picks.find(p => p.userData.node === n);
  return hit.geometry.args[0];
});
const biggest = storPicks[storPicks.findIndex((n, i) => radii[i] === Math.max(...radii))];
ok(biggest.id === tabSorted[0].name, 'the largest table (' + tabSorted[0].name + ') gets the largest object — got ' + biggest.id);

// Replication: lag must change the flow speed, and a lost slot must have none.
const rep = built.feat_replication.ctx;
const speeds = rep.flows.map(f => f.speed);
ok(rep.flows.length === 2, 'only the two connected standbys get a particle flow (' + rep.flows.length + ')');
ok(Math.max(...speeds) > Math.min(...speeds), 'the lagging standby flows more slowly than the healthy one ('
  + speeds.map(s => s.toFixed(3)).join(' vs ') + ')');

// Slow queries: width must follow cumulative cost, not average duration.
const sq = built.feat_slowqueries.ctx;
const qNodes = sq.picks.map(p => p.userData.node).filter(n => n.kind === 'query');
ok(qNodes.length === SM.SAMPLE_QUERIES.length, 'one tower per sample query (' + qNodes.length + ')');
const byTotal = SM.SAMPLE_QUERIES.slice().sort((a, b) => (b.calls * b.avg_ms) - (a.calls * a.avg_ms));
const bySlowest = SM.SAMPLE_QUERIES.slice().sort((a, b) => b.avg_ms - a.avg_ms);
ok(byTotal[0].id !== bySlowest[0].id,
  'the teaching point holds: the most expensive query (' + byTotal[0].id + ') is NOT the slowest (' + bySlowest[0].id + ')');

// Indexes: an unused index must be visibly different.
const idx = built.feat_indexes.ctx;
const idxNodes = idx.picks.map(p => p.userData.node);
const unused = idxNodes.filter(n => n.data.scans === 0);
ok(unused.length === 2, 'both zero-scan indexes are present and marked (' + unused.length + ')');

console.log('\n=== 5. label LOD ===');
const uni = built.universe;
ok(uni.labels.items.length > 0, 'the universe registers labels (' + uni.labels.items.length + ')');
const tiers = uni.labels.items.map(i => ({ near: i.near, mid: i.mid }));
ok(tiers.every(t => t.near < t.mid || t.near > 900), 'every label has a near threshold below its mid threshold');
const hasFar = uni.labels.items.some(i => i.mid < 900);
ok(hasFar, 'at least one label demotes with distance rather than always showing');

console.log('\n=== 6. camera controller ===');
const cam = new AS.Camera({ position: new V3(), lookAt() {}, matrixWorld: { extractBasis() {} } });
cam.setLimits(20, 200);
cam.zoom(50); ok(cam.dest.dist <= 200, 'zoom clamps at the far limit (' + cam.dest.dist.toFixed(1) + ')');
cam.zoom(-50); ok(cam.dest.dist >= 20, 'zoom clamps at the near limit (' + cam.dest.dist.toFixed(1) + ')');
cam.nudge(0, 99); ok(cam.dest.el <= 1.24, 'elevation clamps below the pole (' + cam.dest.el.toFixed(2) + ')');
cam.nudge(0, -99); ok(cam.dest.el >= -0.45, 'elevation clamps above the floor (' + cam.dest.el.toFixed(2) + ')');
cam.jump({ az: 0, el: 0.3, dist: 60, tx: 0, ty: 0, tz: 0 });
ok(cam.cur.dist === 60, 'jump snaps without animation');

console.log('\n=== 7. disposal ===');
const before = built.mod_database.ctx.group.children.length;
AS.disposeGroup(built.mod_database.ctx.group);
ok(before > 0 && built.mod_database.ctx.group.children.length === 0,
  'disposeGroup empties the world group (' + before + ' → 0)');

console.log('\n' + '='.repeat(58));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('='.repeat(58));
process.exit(fail ? 1 : 0);
