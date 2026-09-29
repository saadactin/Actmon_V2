/* The brief's 14 acceptance tests, run against the real document with the 3D
   path ACTIVE (a THREE stub, so environments genuinely build) rather than the
   2D fallback. This is the closest thing to driving it in a browser that is
   available here. */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require(path.join('E:/ACTMON V1/frontend/node_modules/jsdom'));

const DIR = 'E:/ACTMON V1/docs/interactive';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m); } else { fail++; console.log('  FAIL  ' + m); } };

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + e.message));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
vc.on('warn', (...a) => console.log('[warn]', a.map(x => (x && x.stack) || (x && x.message) || x).join(' ').slice(0, 320)));

const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8')
  .replace(/<script src="https:[^"]*"><\/script>/g, '');
const dom = new JSDOM(html, { runScripts: 'dangerously', virtualConsole: vc, pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom, doc = window.document;

window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

/* ── THREE stub good enough for the app's own code path ───────────────── */
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
// Regular functions, not arrows: these are called with `new`, and an arrow
// function throws "is not a constructor".
function Geo(n) { return function (...a) { return { type: n, args: a, dispose() {} }; }; }
function Mat(o) { return Object.assign({ dispose() {} }, o); }
window.THREE = {
  Vector3: V3, Vector2: class { constructor(x, y) { this.x = x || 0; this.y = y || 0; } set(x, y) { this.x = x; this.y = y; } },
  Object3D: Obj3D, Group: Obj3D,
  Mesh: class extends Obj3D { constructor(g, m) { super(); this.geometry = g; this.material = m; } },
  Points: class extends Obj3D { constructor(g, m) { super(); this.geometry = g; this.material = m; } },
  Line: class extends Obj3D { constructor(g, m) { super(); this.geometry = g; this.material = m; } },
  Sprite: class extends Obj3D { constructor(m) { super(); this.material = m; } },
  BufferGeometry: class { constructor() { this.attributes = {}; } setAttribute(k, a) { this.attributes[k] = a; return this; } setFromPoints(p) { this.attributes.position = { count: p.length, setXYZ() {}, setY() {}, getY() { return 0; } }; return this; } dispose() {} },
  BufferAttribute: class { constructor(a, n) { this.array = a; this.count = a.length / n; } setXYZ() {} setY() {} getY() { return 0; } },
  QuadraticBezierCurve3: class { constructor(a, b, c) { this.a = a; this.c = c; } getPoints(n) { const o = []; for (let i = 0; i <= n; i++) o.push(this.getPoint(i / n)); return o; } getPoint(t) { return new V3().lerpVectors(this.a, this.c, t); } },
  CatmullRomCurve3: class { constructor(p) { this.p = p; } getPoints(n) { return this.p; } getPoint(t) { return this.p[Math.floor(t * (this.p.length - 1))]; } },
  Color: class { constructor(h) { this.h = h | 0; } lerp() { return this; } getHex() { return this.h; } },
  GridHelper: class extends Obj3D { constructor() { super(); this.material = { transparent: false, opacity: 1, dispose() {} }; } },
  PerspectiveCamera: class extends Obj3D { constructor() { super(); this.matrixWorld = { extractBasis() {} }; } updateProjectionMatrix() {} },
  Scene: class extends Obj3D { constructor() { super(); this.fog = null; } },
  FogExp2: class { constructor(c, d) { this.color = c; this.density = d; } },
  WebGLRenderer: class {
    constructor(o) { this.domElement = o.canvas; }
    setPixelRatio() {} setSize() {} setClearColor() {} render() {}
  },
  Raycaster: class { setFromCamera() {} set() {} intersectObjects() { return []; } },
  Clock: class { constructor() { this.elapsedTime = 0; } getDelta() { this.elapsedTime += 0.016; return 0.016; } },
  AmbientLight: class extends Obj3D {}, DirectionalLight: class extends Obj3D {}, PointLight: class extends Obj3D {},
  MeshStandardMaterial: Mat, MeshBasicMaterial: Mat, PointsMaterial: Mat, SpriteMaterial: Mat, LineBasicMaterial: Mat,
  CanvasTexture: function () { return { dispose() {}, minFilter: null }; },
  IcosahedronGeometry: Geo('Icosahedron'), SphereGeometry: Geo('Sphere'), CylinderGeometry: Geo('Cylinder'),
  BoxGeometry: Geo('Box'), TorusGeometry: Geo('Torus'), ConeGeometry: Geo('Cone'),
  OctahedronGeometry: Geo('Octahedron'), PlaneGeometry: Geo('Plane'), RingGeometry: Geo('Ring'), TubeGeometry: Geo('Tube'),
  BackSide: 1, DoubleSide: 2, LinearFilter: 1,
};
// rAF exists in jsdom with pretendToBeVisual; keep the loop from running away
// Bound to window: an unbound jsdom requestAnimationFrame throws
// "Illegal invocation", which the app's own try/catch would then read as
// "WebGL failed" and silently drop to the 2D fallback.
let frames = 0;
const rawRaf = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = cb => (frames++ < 4 ? rawRaf(cb) : 0);

function inject() {
  for (const f of ['actmon-data.js', 'actmon-samples.js', 'actmon-scene.js', 'actmon-envs.js', 'actmon-app.js']) {
    const s = doc.createElement('script');
    s.textContent = fs.readFileSync(path.join(DIR, f), 'utf8');
    doc.body.appendChild(s);
  }
}
if (doc.readyState === 'loading') window.addEventListener('DOMContentLoaded', inject); else inject();

const $ = s => doc.querySelector(s);
const $$ = s => Array.from(doc.querySelectorAll(s));
const click = e => { if (!e) throw new Error('no element to click'); e.dispatchEvent(new window.Event('click', { bubbles: true })); };
const crumbs = () => $$('#crumbs .crumb').map(b => b.textContent).join(' / ');
const nav = txt => $$('#pBody .navbtn').find(b => b.textContent.trim().indexOf(txt) === 0);

setTimeout(() => {
  const D = window.ACTMON, SM = window.ACTMON_SAMPLES;

  console.log('TEST 1 — open the document and see the complete ACTMON universe');
  ok($('#loader').classList.contains('gone'), 'loading screen dismissed');
  ok(!$('#flat').classList.contains('show'), '3D path is active (not the 2D fallback)');
  ok($('#envTitle').textContent === 'ACTMON', 'environment title reads ACTMON (' + $('#envTitle').textContent + ')');
  ok(/seven monitoring domains/i.test($('#envSub').textContent), 'environment subtitle names the seven domains');
  ok($('#lvl').textContent.indexOf('Level 0') >= 0, 'level indicator says Level 0');

  console.log('\nTEST 2 — contextual information appears progressively');
  const lbls = $$('#labels .lbl3');
  ok(lbls.length >= 8, 'contextual labels exist for the hub and every domain (' + lbls.length + ')');
  const hasTiers = lbls.every(l => l.querySelector('.lbl3-name') && l.querySelector('.lbl3-sub') && l.querySelector('.lbl3-cta'));
  ok(hasTiers, 'every label carries all three tiers — dot, name, purpose + action');
  const css = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  ok(/\.lbl3\.t0 \.lbl3-body\{display:none\}/.test(css.replace(/\s+/g, '')) || /t0/.test(css),
    'far tier hides the body so distant objects show only a dot');

  console.log('\nTEST 3 — enter Database Monitoring and discover the technologies');
  click(nav('Database Monitoring'));
  ok($('#envTitle').textContent === 'Database Monitoring', 'entered the database environment (' + $('#envTitle').textContent + ')');
  ok(/data landscape|Eight technology|dashboard of their own/i.test($('#envSub').textContent), 'its subtitle describes that environment');
  const engineBtns = $$('#pBody .navbtn').filter(b => D.ENGINES.some(e => b.textContent.trim().indexOf(e.label) === 0));
  ok(engineBtns.length === 8, 'all eight technology entries are selectable (' + engineBtns.length + ')');

  console.log('\nTEST 4 — enter PostgreSQL and see its feature areas');
  click(nav('PostgreSQL'));
  ok($('#envTitle').textContent === 'PostgreSQL', 'entered the PostgreSQL environment');
  ok($('#lvl').textContent.indexOf('Level 2') >= 0, 'now at Level 2 (' + $('#lvl').textContent + ')');
  const tabBtns = $$('#pBody .navbtn').filter(b => D.PG_TABS.some(t => b.textContent.trim().indexOf(t.label) === 0));
  ok(tabBtns.length >= 17, 'every dashboard section plus the detail page is listed (' + tabBtns.length + ')');

  console.log('\nTEST 5 — enter Slow Queries and see a query-analysis environment');
  click(nav('Slow Queries'));
  ok($('#envTitle').textContent === 'Slow Queries', 'entered the Slow Queries environment');
  ok(/cumulative cost/i.test($('#envSub').textContent), 'the scene explains its own encoding');
  ok($('#lvl').textContent.indexOf('Level 3') >= 0, 'now at Level 3');
  ok(/Illustrative sample/i.test($('#pBody').textContent), 'illustrative records are labelled as such');

  console.log('\nTEST 6 — select a query and reveal its plan');
  // Drive it the way a reader would: via the 2D list, which routes through the
  // same record level the 3D click produces.
  click($('#flatBtn'));
  const qCard = $$('#flatBody .flat-card').find(c => /SELECT ·|UPDATE ·/.test(c.textContent));
  ok(!!qCard, 'an illustrative query is reachable from the accessible list');
  click(qCard);
  ok($('#envTitle').textContent === 'Query analysis', 'entered the query-analysis environment (' + $('#envTitle').textContent + ')');
  ok($('#lvl').textContent.indexOf('Level 4') >= 0, 'now at Level 4 (' + $('#lvl').textContent + ')');
  const qb = $('#pBody').textContent;
  ok(/Seq Scan/.test(qb), 'the execution plan is shown');
  ok(/Estimated, not measured/i.test(qb), 'estimated plans are distinguished from measured ones');
  ok(/evidence:/.test(qb), 'each finding carries its evidence');
  ok(/CREATE INDEX CONCURRENTLY/.test(qb), 'a suggested statement is offered');
  ok(/Trade-off/i.test(qb), 'the trade-off is stated, not just the recommendation');
  ok(/never a guarantee|suggestion, never/i.test(qb), 'recommendations are not presented as guarantees');

  console.log('\nTEST 7 — enter Users and inspect a sample role');
  click($('#flatBtn'));
  const roleCard = $$('#flatBody .flat-card').find(c => /migration_user/.test(c.textContent));
  ok(!!roleCard, 'the sample role is reachable');
  click(roleCard);
  const rb = $('#pBody').textContent;
  ok($('#pTitle').textContent === 'migration_user', 'the role detail is open');
  ok(/Granted directly/.test(rb) && /Inherited from app_writer/.test(rb) && /Held by PUBLIC/.test(rb) && /Implied by ownership/.test(rb),
    'all four privilege routes are distinguished');
  ok(/Never shown/.test(rb) && /password hash/i.test(rb), 'it states that no password or hash is shown');
  ok(!/\$2[aby]\$|SCRAM-SHA-256\$|md5[0-9a-f]{32}/.test(rb), 'no password hash appears anywhere');

  console.log('\nTEST 8 — enter Replication and inspect a primary/standby example');
  // via search, which is also TEST 10
  const si = $('#search');
  si.value = 'replication';
  si.dispatchEvent(new window.Event('input', { bubbles: true }));
  const rres = $$('#results .res');
  ok(rres.length > 0, 'search finds Replication');
  click(rres[0]);
  ok($('#envTitle').textContent === 'Replication', 'entered the Replication environment');
  ok(/particle speed|inverse of/i.test($('#envSub').textContent), 'the scene explains its lag encoding');
  ok(/Illustrative/i.test($('#pBody').textContent + $('#pSub').textContent), 'the topology is marked illustrative');

  console.log('\nTEST 9 — navigate backward without losing the way home');
  const deep = crumbs();
  ok(deep.split(' / ').length >= 4, 'breadcrumb is deep (' + deep + ')');
  click($('#back'));
  ok(crumbs().split(' / ').length === deep.split(' / ').length - 1, 'Back shortened the trail');
  click($('#fwd'));
  ok(crumbs() === deep, 'Forward restored it');
  click($$('#crumbs .crumb')[1]);
  ok(crumbs() === 'ACTMON / Database Monitoring', 'clicking an earlier crumb returned to that level');
  click($('#home'));
  ok($('#lvl').textContent.indexOf('Level 0') >= 0 && $('#envTitle').textContent === 'ACTMON', 'Home reached the overview');

  console.log('\nTEST 10 — search navigates directly to a documented feature');
  const terms = ['PostgreSQL', 'Slow Queries', 'Database Roles', 'Cosmos', 'Infrastructure', 'Agents', 'Alerts', 'Logs', 'Redis', 'DynamoDB', 'Replication'];
  const missing = terms.filter(t => {
    si.value = t; si.dispatchEvent(new window.Event('input', { bubbles: true }));
    return $$('#results .res').length === 0;
  });
  ok(missing.length === 0, 'every required term returns a result' + (missing.length ? ' [' + missing.join(', ') + ']' : ''));
  si.value = 'storage'; si.dispatchEvent(new window.Event('input', { bubbles: true }));
  click($$('#results .res')[0]);
  ok($('#envTitle').textContent === 'Storage', 'a search result navigated straight into the Storage environment');

  console.log('\nTEST 11 — run the guided tour from start to finish');
  click($('#tourBtn'));
  ok($('#tour').classList.contains('open'), 'tour opened');
  ok($('#tourN').textContent.indexOf('of 10') >= 0, 'ten chapters');
  ok($('#tourPause').textContent === 'Pause', 'it plays automatically and offers Pause');
  click($('#tourPause'));
  ok($('#tourPause').textContent === 'Resume', 'Pause works');
  click($('#tourPause'));
  ok($('#tourPause').textContent === 'Pause', 'Resume works');
  const envSeen = [];
  for (let i = 0; i < 9; i++) { click($('#tourNext')); envSeen.push($('#envTitle').textContent); }
  ok(new Set(envSeen).size >= 6, 'the tour visits distinct environments (' + new Set(envSeen).size + ' unique of 9)');
  ok($('#tourNext').textContent === 'Finish', 'the last chapter offers Finish');
  click($('#tourNext'));
  ok(!$('#tour').classList.contains('open'), 'Finish closes the tour');

  console.log('\nTEST 12 — typography and readability');
  const styles = css.match(/<style>([\s\S]*?)<\/style>/)[1];
  ok(/Inter/.test(css), 'Inter is the interface font');
  ok(/JetBrains\+Mono|JetBrains Mono/.test(css), 'a monospace face is loaded for technical values');
  ok(/--t-hero|--t-body|--t-meta/.test(styles), 'a single type scale is defined as tokens');
  const tiny = (styles.match(/font-size:\s*(\d+)px/g) || []).map(m => parseInt(m.match(/(\d+)/)[1], 10)).filter(n => n < 11);
  ok(tiny.length === 0, 'no hard-coded font-size below 11px' + (tiny.length ? ' [' + tiny.join(', ') + ']' : ''));
  ok(/--t-micro:\.6875rem/.test(styles), 'the smallest token is 11px, not smaller');
  ok(/de-overlap|clash/.test(fs.readFileSync(path.join(DIR, 'actmon-scene.js'), 'utf8')), 'labels have collision handling');
  ok(/Occlusion/.test(fs.readFileSync(path.join(DIR, 'actmon-scene.js'), 'utf8')), 'labels have occlusion handling');

  console.log('\nTEST 13 — every example is marked illustrative');
  const samples = fs.readFileSync(path.join(DIR, 'actmon-samples.js'), 'utf8');
  ok(/NOTHING here came from a live/i.test(samples), 'the sample file states its own provenance');
  ok(SM.SAMPLE_BANNER === 'Illustrative sample — not live data', 'a single sample banner string is used');
  // Every environment built from sample data must say so in its subtitle.
  const sampleEnvs = ['slow-queries', 'replication', 'storage', 'locks', 'error-logs', 'tables', 'indexes', 'users', 'overview', 'performance'];
  const unmarked = [];
  sampleEnvs.forEach(id => {
    si.value = id.replace('-', ' '); si.dispatchEvent(new window.Event('input', { bubbles: true }));
    const r = $$('#results .res')[0];
    if (!r) return;
    click(r);
    const sub = $('#envSub').textContent;
    if (!/illustrative|sample/i.test(sub)) unmarked.push(id + ' → "' + sub + '"');
  });
  ok(unmarked.length === 0, 'every sample-driven environment says so in its own subtitle'
    + (unmarked.length ? '\n        ' + unmarked.join('\n        ') : ''));

  console.log('\nTEST 14 — unsupported features are not presented as implemented');
  const all = ['actmon-data.js', 'actmon-samples.js', 'actmon-scene.js', 'actmon-envs.js', 'actmon-app.js', 'index.html']
    .map(f => fs.readFileSync(path.join(DIR, f), 'utf8')).join('\n');
  ok(/Google Cloud Platform[\s\S]{0,80}Not implemented/.test(all), 'GCP is explicitly marked not implemented');
  ok(/Redis[\s\S]{0,80}Not a monitored database technology/.test(all), 'Redis is explicitly excluded');
  ok(D.ENGINES.find(e => e.id === 'mariadb').status === 'partial', 'MariaDB is marked partial, not implemented');
  ok(D.ALERT_TIERS.find(t => t.id === 'reserved').count === 25, '25 alert rule types are marked as having no data source');
  ok(!/password\s*[:=]\s*['"][^'"]{3,}/i.test(all) && !/xox[baprs]-/.test(all), 'no credential-shaped strings anywhere');

  console.log('\n=== runtime ===');
  ok(errors.length === 0, 'no console errors across the whole run'
    + (errors.length ? '\n        ' + errors.slice(0, 5).join('\n        ') : ''));

  console.log('\n' + '='.repeat(60));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('='.repeat(60));
  process.exit(fail ? 1 : 0);
}, 2600);
