/* Tests the KOEL architecture document two ways:

     1. the 3D environments, built headlessly against a THREE stub, because
        jsdom has no WebGL and would otherwise only ever exercise the
        fallback;
     2. the page itself in jsdom — the layout contract, the click-to-scroll
        behaviour, and that every component in the data actually appears in
        the documentation.

   The content checks matter more here than in the ACTMON document: this one
   is a transcription, so the test's job is to prove nothing was dropped and
   nothing was invented. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = 'E:/ACTMON V1/docs/koel';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m); } else { fail++; console.log('  FAIL  ' + m); } };

/* ── minimal THREE ─────────────────────────────────────────────────────── */
class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  clone() { return new V3(this.x, this.y, this.z); }
  copy(v) { return this.set(v.x, v.y, v.z); }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  normalize() { const l = this.length() || 1; return this.multiplyScalar(1 / l); }
  length() { return Math.hypot(this.x, this.y, this.z); }
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
    // Direction chevrons are aimed by assigning a quaternion, not by rotation.
    this.quaternion = { x: 0, y: 0, z: 0, w: 1, copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; } };
  }
  add(o) { if (o) { o.__parent = this; this.children.push(o); } return this; }
  remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); return this; }
  traverse(fn) { fn(this); this.children.forEach(c => c.traverse && c.traverse(fn)); }
  lookAt() { return this; }
  getWorldPosition(t) { return (t || new V3()).copy(this.position); }
  clone() { const c = new Obj3D(); c.position.copy(this.position); return c; }
}
function Geo(name) { return function (...a) { return { type: name, args: a, dispose() {} }; }; }
class BufGeo {
  constructor() { this.attributes = {}; }
  setAttribute(k, a) { this.attributes[k] = a; return this; }
  setFromPoints(pts) { this.attributes.position = { count: pts.length }; return this; }
  dispose() {}
}
class BufAttr {
  constructor(arr, n) { this.array = arr; this.itemSize = n; this.count = arr.length / n; }
  setXYZ() {}
}
class Curve {
  constructor(a, b, c) { this.pts = [a, b, c].filter(Boolean); }
  getPoints(n) { const o = []; for (let i = 0; i <= n; i++) o.push(this.getPoint(i / n)); return o; }
  getPoint(t) { const a = this.pts[0] || new V3(), b = this.pts[this.pts.length - 1] || new V3(); return new V3().lerpVectors(a, b, t); }
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
  Color: class { constructor(h) { this.h = h | 0; } lerp() { return this; } getHex() { return this.h; } },
  Quaternion: class { constructor() { this.x = 0; this.y = 0; this.z = 0; this.w = 1; }
    setFromUnitVectors(a, b) { this.x = a.y * b.z - a.z * b.y; this.y = a.z * b.x - a.x * b.z;
      this.z = a.x * b.y - a.y * b.x; this.w = 1 + (a.x * b.x + a.y * b.y + a.z * b.z); return this; }
    copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; } },
  GridHelper: class extends Obj3D { constructor() { super(); this.material = { transparent: false, opacity: 1, dispose() {} }; } },
  MeshStandardMaterial: function (o) { return Object.assign({ dispose() {} }, o); },
  MeshBasicMaterial: function (o) { return Object.assign({ dispose() {} }, o); },
  PointsMaterial: function (o) { return Object.assign({ dispose() {} }, o); },
  SpriteMaterial: function (o) { return Object.assign({ dispose() {} }, o); },
  LineBasicMaterial: function (o) { return Object.assign({ dispose() {} }, o); },
  CanvasTexture: function () { return { dispose() {}, minFilter: null }; },
  IcosahedronGeometry: Geo('Icosahedron'), SphereGeometry: Geo('Sphere'),
  CylinderGeometry: Geo('Cylinder'), BoxGeometry: Geo('Box'), TorusGeometry: Geo('Torus'),
  ConeGeometry: Geo('Cone'), OctahedronGeometry: Geo('Octahedron'), PlaneGeometry: Geo('Plane'),
  RingGeometry: Geo('Ring'), TubeGeometry: Geo('Tube'),
  BackSide: 1, DoubleSide: 2, LinearFilter: 1,
};

const sandbox = {
  THREE, console, Math, Date, Set, Map, Array, Object, JSON, String, Number, isFinite, parseFloat,
  Float32Array, window: {},
  document: {
    createElement(tag) {
      if (tag === 'canvas') {
        return { width: 0, height: 0, getContext: () => ({
          font: '', textBaseline: '', fillStyle: '', measureText: () => ({ width: 120 }), fillText() {},
          // Captions draw a rounded backing plate before their text.
          beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arcTo() {}, fill() {},
        }) };
      }
      // Labels build their inner markup and then query it back, so the stub
      // element needs querySelector or every environment dies on its first label.
      return { className: '', innerHTML: '', style: {}, parentNode: null,
        classList: { add() {}, remove() {}, toggle() {} },
        appendChild() {}, remove() {}, querySelector: () => ({ textContent: '' }) };
    },
  },
};
sandbox.window.document = sandbox.document;
vm.createContext(sandbox);
['koel-data.js', 'koel-scene.js', 'koel-envs.js'].forEach(f => {
  vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: f });
});

const D = sandbox.window.KOEL;
const KS = sandbox.window.KScene;
const EV = sandbox.window.KEnvs;

console.log('=== 1. modules load ===');
ok(!!D && !!KS && !!EV, 'koel-data, koel-scene and koel-envs all published their globals');

console.log('\n=== 2. the transcription is complete ===');
ok(D.ZONES.length === 3, 'three zones (' + D.ZONES.length + ')');
ok(D.FEEDS.length === 18, 'eighteen third-party feeds, as the diagram\'s own heading claims (' + D.FEEDS.length + ')');
ok(D.ONPREM.length === 7, 'seven on-premises components (' + D.ONPREM.length + ')');
ok(D.PUBLIC_SUBNET.length === 2 && D.PRIVATE_SUBNET.length === 8,
  'OCI: ' + D.PUBLIC_SUBNET.length + ' public + ' + D.PRIVATE_SUBNET.length + ' private');
ok(D.SIEBEL.length === 5, 'five Siebel tiers (' + D.SIEBEL.length + ')');
ok(D.FLOWS.length === 8, 'eight connections (' + D.FLOWS.length + ')');

const ALL = [].concat(D.ONPREM, D.PUBLIC_SUBNET, D.PRIVATE_SUBNET, D.SIEBEL);
const ids = ALL.map(c => c.id);
ok(new Set(ids).size === ids.length, 'every component id is unique');
const missing = ALL.filter(c => !c.what || !c.label || !c.cls);
ok(missing.length === 0, 'every component has a label, a description and a provenance class'
  + (missing.length ? ' [' + missing.map(c => c.id).join(', ') + ']' : ''));
const badCls = ALL.concat(D.ZONES, D.FLOWS).filter(c => !D.CLASS[c.cls]);
ok(badCls.length === 0, 'every provenance class is one of the four defined ones'
  + (badCls.length ? ' [' + badCls.map(c => c.id + '=' + c.cls).join(', ') + ']' : ''));

// Protocols and categories must come from the diagram's own vocabulary.
const kinds = new Set(D.FEEDS.map(f => f.kind));
ok([...kinds].every(k => !!D.FEED_KINDS[k]), 'every feed category is defined');
ok(D.FEEDS.every(f => f.p && f.n), 'every feed has a name and a protocol');
const banks = D.FEEDS.filter(f => f.kind === 'bank').length;
ok(banks === 6, 'six banking feeds, matching the observation that says so (' + banks + ')');

// Flow endpoints must name things that exist.
const names = ALL.map(c => c.label).concat(D.ZONES.map(z => z.label));
const orphanFlows = D.FLOWS.filter(f => {
  const hit = s => names.some(n => n.indexOf(s.replace(/\s*\(.*\)$/, '')) >= 0 || s.indexOf(n) >= 0);
  return !hit(f.from) || !hit(f.to);
});
ok(orphanFlows.length === 0, 'every connection names endpoints that exist in the component list'
  + (orphanFlows.length ? ' [' + orphanFlows.map(f => f.id).join(', ') + ']' : ''));

console.log('\n=== 3. every environment builds and is interactive ===');
function build(key) {
  const ctx = { group: new Obj3D(), data: D, labels: new KS.Labels({ appendChild() {} }),
    picks: [], flows: [], spinners: [], pulsers: [] };
  const desc = EV[key](ctx);
  return { ctx, desc };
}
const ENVS = ['estate', 'zone_thirdparty', 'zone_onprem', 'zone_oci', 'siebel', 'flows'];
const built = {};
const broken = [];
ENVS.forEach(k => {
  try {
    const r = build(k);
    built[k] = r;
    if (!r.desc || !r.desc.pose) broken.push(k + ' (no camera pose)');
    if (!r.desc || !r.desc.title) broken.push(k + ' (no title)');
    if (!r.desc || !r.desc.limits) broken.push(k + ' (no zoom limits)');
  } catch (e) { broken.push(k + ' THREW: ' + e.message); }
});
ok(broken.length === 0, 'all ' + ENVS.length + ' environments build with a pose, title and limits'
  + (broken.length ? '\n        ' + broken.join('\n        ') : ''));
ok(Object.keys(built).length === ENVS.length, 'every environment produced a scene to inspect ('
  + Object.keys(built).length + '/' + ENVS.length + ')');
const noPicks = Object.keys(built).filter(k => built[k].ctx.picks.length === 0);
ok(noPicks.length === 0, 'every environment registers clickable objects'
  + (noPicks.length ? ' [' + noPicks.join(', ') + ']' : ''));

console.log('\n=== 4. the scene has as many objects as the diagram has things ===');
const counts = {
  estate: 3,
  zone_thirdparty: 18,
  zone_onprem: D.ONPREM.length,
  // The OCI level draws the Siebel block inside the private subnet, as the
  // diagram nests it — so its clickable count includes the Siebel tiers.
  zone_oci: D.PUBLIC_SUBNET.length + D.PRIVATE_SUBNET.length + D.SIEBEL.length,
  siebel: D.SIEBEL.length,
  flows: D.FLOWS.length,
};
const wrong = Object.keys(counts).filter(k => !built[k] || built[k].ctx.picks.length !== counts[k]);
ok(wrong.length === 0, 'object count matches the data in every level'
  + (wrong.length ? ' [' + wrong.map(k => k + ': ' + (built[k] ? built[k].ctx.picks.length : 'did not build') + ' vs ' + counts[k]).join(', ') + ']' : ''));

// Every clickable thing must carry the id the page needs to scroll to a card.
const noId = [];
Object.keys(built).forEach(k => built[k].ctx.picks.forEach(p => {
  const n = p.userData.node;
  if (!n || !n.id || !n.kind) noId.push(k + '/' + (n && n.label));
}));
ok(noId.length === 0, 'every clickable object carries an id and a kind' + (noId.length ? ' [' + noId.join(', ') + ']' : ''));

console.log('\n=== 5. each level is a different composition ===');
function signature(k) {
  const c = built[k].ctx;
  const kindCount = {};
  c.group.traverse(o => { if (o.geometry) kindCount[o.geometry.type] = (kindCount[o.geometry.type] || 0) + 1; });
  return { picks: c.picks.length, flows: c.flows.length, kinds: Object.keys(kindCount).sort().join(',') };
}
const sigs = {};
Object.keys(built).forEach(k => { sigs[k] = signature(k); });
const dupes = [];
const keys = Object.keys(sigs);
for (let i = 0; i < keys.length; i++) {
  for (let j = i + 1; j < keys.length; j++) {
    const a = sigs[keys[i]], b = sigs[keys[j]];
    if (a.picks === b.picks && a.kinds === b.kinds && a.flows === b.flows) dupes.push(keys[i] + ' = ' + keys[j]);
  }
}
ok(dupes.length === 0, 'no two levels share an identical composition' + (dupes.length ? ' [' + dupes.join(', ') + ']' : ''));
Object.keys(sigs).forEach(k => {
  console.log('     ' + k.padEnd(18) + ' picks=' + String(sigs[k].picks).padStart(3)
    + '  flows=' + String(sigs[k].flows).padStart(3) + '  geometry: ' + sigs[k].kinds);
});


console.log('');
console.log('=== 5b. the estate is legible, not just animated ===');
const envSrc = fs.readFileSync(path.join(DIR, 'koel-envs.js'), 'utf8');
const sceneSrc = fs.readFileSync(path.join(DIR, 'koel-scene.js'), 'utf8');

// The globe is a real primitive with land, not a bare sphere.
ok(/G\.earth = function/.test(sceneSrc), 'the scene engine builds an Earth');
ok(/graticule/i.test(sceneSrc) && /isLand\(/.test(sceneSrc), 'it has a graticule and a land mask');
ok(/KS\.G\.earth\(/.test(envSrc), 'the estate level places one');
let earthPoints = 0;
built.estate.ctx.group.traverse(o => {
  if (o.geometry && o.geometry.attributes && o.geometry.attributes.position) {
    earthPoints = Math.max(earthPoints, o.geometry.attributes.position.count || 0);
  }
});
ok(earthPoints > 1000, 'the globe carries a real dot field (' + earthPoints + ' points in its largest buffer)');

// Every connection the reader is meant to follow names itself and points.
const arrowBlocks = envSrc.split(/(?<!function )arrow\(ctx/).slice(1);
const unlabelled = arrowBlocks.filter(b => b.slice(0, b.indexOf('});') + 1).indexOf('label:') < 0);
ok(arrowBlocks.length >= 11, 'the levels draw captioned connections (' + arrowBlocks.length + ')');
ok(unlabelled.length === 0, 'every one of them carries a caption'
  + (unlabelled.length ? ' [' + unlabelled.length + ' without]' : ''));
ok(/function arrow\(/.test(envSrc) && /opts\.both/.test(envSrc),
  'two-way edges get two arrowheads, one-way edges one');

// A camera looking down the length of a left-to-right composition is the
// fault that made the first version unreadable; these levels must look at it
// broadside, which means an azimuth near a right angle.
const posesAlongAxis = ['estate', 'zone_thirdparty', 'zone_onprem', 'zone_oci', 'siebel', 'flows']
  .filter(k => {
    const az = built[k] && built[k].desc.pose && built[k].desc.pose.az;
    return !(Math.abs(Math.abs(az) - Math.PI / 2) < 0.45);
  });
ok(posesAlongAxis.length === 0, 'every level views its composition broadside'
  + (posesAlongAxis.length ? ' [' + posesAlongAxis.join(', ') + ']' : ''));

console.log('');
console.log('=== 5c. no count is written out by hand ===');
// A number typed into a caption is a number that goes stale. One already did:
// a caption said "eleven servers" where the diagram's own counts add to twelve.
const siebelTotal = D.SIEBEL.reduce((a, c) => a + (c.count || 1), 0);
ok(/D\.SIEBEL\.reduce/.test(envSrc), 'the Siebel total is computed from the data');
ok(!new RegExp("'[^']*\\b" + siebelTotal + " servers").test(envSrc),
  'and never written into a caption as a literal');
const spelled = envSrc.match(/\b(eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|nineteen|twenty)\b/gi) || [];
ok(spelled.length === 0, 'no spelled-out counts in the scene code'
  + (spelled.length ? ' [' + spelled.join(', ') + ']' : ''));
// The only number the levels may state outright is eighteen, because the
// diagram's own heading says it.
ok(/18 ingestion feeds/.test(envSrc) && D.FEEDS.length === 18,
  "the one hardcoded count, 18, matches the diagram's own heading and the data");

console.log('\n=== 6. disposal ===');
const before = built.zone_oci.ctx.group.children.length;
KS.disposeGroup(built.zone_oci.ctx.group);
ok(before > 0 && built.zone_oci.ctx.group.children.length === 0,
  'disposeGroup empties a level before the next is built (' + before + ' -> 0)');

/* ── the page ──────────────────────────────────────────────────────────── */
const { JSDOM, VirtualConsole } = require('E:/ACTMON V1/frontend/node_modules/jsdom');
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push(e.message));
vc.on('warn', (...a) => errors.push('warn: ' + a.join(' ')));

const raw = fs.readFileSync(path.join(DIR, 'koel-architecture.html'), 'utf8');
const html = raw.replace(/<script src="https:[^"]*"><\/script>/g, '');
const dom = new JSDOM(html, { runScripts: 'dangerously', virtualConsole: vc, pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom, doc = window.document;
window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
window.IntersectionObserver = class { constructor() {} observe() {} disconnect() {} };
window.scrollTo = () => {};
window.Element.prototype.scrollIntoView = function () { window.__lastScroll = this.id; };
function inject() {
  for (const f of ['koel-data.js', 'koel-scene.js', 'koel-envs.js', 'koel-page.js']) {
    const s = doc.createElement('script');
    s.textContent = fs.readFileSync(path.join(DIR, f), 'utf8');
    doc.body.appendChild(s);
  }
}
if (doc.readyState === 'loading') window.addEventListener('DOMContentLoaded', inject); else inject();
const $ = s => doc.querySelector(s), $$ = s => [...doc.querySelectorAll(s)];

setTimeout(() => {
  console.log('\n=== 7. layout contract: documentation BELOW the 3D ===');
  ok(!!$('#hero') && !!$('#doc'), 'hero and document both exist');
  ok(doc.body.innerHTML.indexOf('id="hero"') < doc.body.innerHTML.indexOf('id="doc"'),
    'documentation comes AFTER the 3D in the DOM, not beside it');
  ok(!/id="panel"|class="[^"]*drawer/.test(raw), 'no side drawer or fixed right-hand panel');
  ok(!/<dialog|role="dialog"/i.test(raw), 'no modal used as the documentation surface');
  ok(/\.s-wrap\{max-width:var\(--wrap\)/.test(raw), 'sections use the full content width');
  const sects = $$('.sect');
  ok(sects.length >= 9, 'documentation is split into stacked full-width sections (' + sects.length + ')');
  ok(sects.every(s => s.getAttribute('tabindex') === '-1'), 'sections are focusable for keyboard landing');

  console.log('\n=== 8. click a nav entry -> the page scrolls ===');
  const navBtns = $$('#secNav .sn');
  ok(navBtns.length === sects.length, 'one nav entry per section (' + navBtns.length + ')');
  const click = label => {
    const b = navBtns.find(x => new RegExp(label, 'i').test(x.textContent));
    if (b) b.dispatchEvent(new window.Event('click', { bubbles: true }));
    return b;
  };
  click('Siebel');
  ok(window.__lastScroll === 'sec-siebel', 'clicking Siebel scrolled to sec-siebel (got ' + window.__lastScroll + ')');
  click('Data flows');
  ok(window.__lastScroll === 'sec-flows', 'clicking Data flows scrolled to sec-flows (got ' + window.__lastScroll + ')');

  console.log('\n=== 9. every component in the data reaches the page ===');
  const text = $('#doc').textContent;
  const absentComponents = ALL.filter(c => text.indexOf(c.label) < 0);
  ok(absentComponents.length === 0, 'every component is documented'
    + (absentComponents.length ? ' [missing: ' + absentComponents.map(c => c.label).join(', ') + ']' : ''));
  const absentFeeds = D.FEEDS.filter(f => text.indexOf(f.n) < 0);
  ok(absentFeeds.length === 0, 'all 18 feeds are listed'
    + (absentFeeds.length ? ' [missing: ' + absentFeeds.map(f => f.n).join(', ') + ']' : ''));
  const absentFlows = D.FLOWS.filter(f => text.indexOf(f.label) < 0);
  ok(absentFlows.length === 0, 'all 8 connections are documented'
    + (absentFlows.length ? ' [missing: ' + absentFlows.map(f => f.label).join(', ') + ']' : ''));
  ok(D.OPEN_QUESTIONS.every(q => text.indexOf(q.q) >= 0), 'every open question is on the page');
  ok(D.OBSERVATIONS.every(o => text.indexOf(o.title) >= 0), 'every observation is on the page');

  console.log('\n=== 10. a clicked 3D node has somewhere to land ===');
  // Each clickable node's card id must exist in the document, or clicking it
  // in the 3D would scroll to nothing.
  const wantIds = new Set();
  Object.keys(built).forEach(k => built[k].ctx.picks.forEach(p => {
    const n = p.userData.node;
    if (n.kind !== 'zone') wantIds.add('c-' + n.id);
  }));
  const noCard = [...wantIds].filter(id => !doc.getElementById(id));
  ok(noCard.length === 0, 'every leaf node has a documentation card to scroll to ('
    + wantIds.size + ' nodes)' + (noCard.length ? ' [missing: ' + noCard.slice(0, 8).join(', ') + ']' : ''));

  console.log('\n=== 11. provenance is visible, not just stored ===');
  Object.keys(D.CLASS).forEach(k => {
    ok(text.indexOf(D.CLASS[k].label) >= 0, 'the "' + D.CLASS[k].label + '" label appears in the document');
  });
  ok(/No repository, no configuration/i.test(text) || /no repository, configuration file or running system/i.test(raw),
    'the single-source disclaimer is stated on the page');
  ok(/proposal/i.test(text), 'the monitoring section is marked as a proposal, not a finding');

  console.log('\n=== 12. no invented specifics ===');
  // A transcription must not acquire IPs, hostnames, versions or credentials
  // that the diagram never carried.
  const src = ['koel-data.js', 'koel-envs.js', 'koel-page.js', 'koel-scene.js']
    .map(f => fs.readFileSync(path.join(DIR, f), 'utf8')).join('\n') + raw;
  const ips = (src.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || []);
  ok(ips.length === 0, 'no IP addresses anywhere' + (ips.length ? ' [' + ips.slice(0, 5).join(', ') + ']' : ''));
  // Credentials in a URL sit between the scheme and the host; a font query
  // string like "...family=Inter:wght@300" must not read as one.
  const dsn = /[a-z][a-z0-9+.-]*:\/\/[^\s'\"\/]+:[^\s'\"\/@]+@/i;
  ok(!/password\s*[:=]\s*['\"][^'\"]{3,}/i.test(src) && !dsn.test(src),
    'no credential- or connection-string-shaped text');
  const cidr = (src.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}\b/g) || []);
  ok(cidr.length === 0, 'no subnet CIDR ranges were invented for the subnets');

  console.log('\n=== 13. utilities ===');
  ok($$('#toTop').length === 1, 'back-to-top control exists');
  ok($$('.s-top').length === sects.length, 'every section has its own back-to-top');
  ok(!!$('#find'), 'search exists');
  ok(/@media print/.test(raw), 'a print stylesheet is defined');
  ok(/prefers-reduced-motion/.test(raw), 'reduced motion is honoured');
  ok($$('.hfb').length > 0, 'without WebGL the hero falls back to buttons that do the same job ('
    + $$('.hfb').length + ')');

  const real = errors.filter(e => !/getContext\(\) method: without installing the canvas/.test(e));
  ok(real.length === 0, 'no runtime errors' + (real.length ? ': ' + real.slice(0, 3).join(' | ') : ''));

  console.log('\n' + '='.repeat(58));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('='.repeat(58));
  process.exit(fail ? 1 : 0);
}, 2200);
