/* ===========================================================================
   ACTMON interactive documentation — scene, navigation and panels.

   Classic script on purpose (see actmon-data.js): the whole document has to
   open by double-clicking index.html, with no server and no build step.

   Structure:
     1. state + helpers
     2. three.js scene and the node graph
     3. camera / level transitions
     4. panel rendering
     5. search, tour, 2D fallback, keyboard
   =========================================================================== */
(function () {
'use strict';

var D = window.ACTMON;
var THREE_OK = typeof THREE !== 'undefined';
var GS = typeof gsap !== 'undefined' ? gsap : null;

/* ── 1. state ──────────────────────────────────────────────────────────── */

// A level is {type, id}. The stack IS the breadcrumb, so navigation and the
// breadcrumb can never disagree.
var stack = [{ type: 'overview' }];
var future = [];            // forward history, cleared on any new navigation
// Guarded: a browser without matchMedia would otherwise throw here and take
// the entire document down before anything rendered.
var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
var flat2d = false;
var tour = { on: false, i: 0 };

var $ = function (s) { return document.querySelector(s); };
var el = function (t, c, h) {
  var n = document.createElement(t);
  if (c) n.className = c;
  if (h != null) n.innerHTML = h;
  return n;
};
var esc = function (s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
};
var toastT;
function toast(msg) {
  var t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 2600);
}

var STATUS = {
  implemented: { label: 'Implemented', cls: 'ok' },
  partial: { label: 'Partial', cls: 'warn' },
  'no-data': { label: 'No data source yet', cls: 'warn' },
  illustrative: { label: 'Illustrative', cls: 'info' },
  none: { label: 'Not implemented', cls: 'bad' },
};
function statusChip(s) {
  var m = STATUS[s] || STATUS.illustrative;
  return '<span class="chip ' + m.cls + '">' + m.label + '</span>';
}

/* ── 2. scene ──────────────────────────────────────────────────────────── */

var scene, camera, renderer, raycaster, root;
var picks = [];             // { mesh, node } currently clickable
var labels = [];            // { node, elem, obj }
var hovered = null;
var flows = [];             // animated data-flow particle systems
// Constructed in initScene(), NOT here: if the three.js CDN is blocked — an
// offline laptop, a corporate proxy — `new THREE.Vector2()` at load time throws
// and takes the whole document down, including the 2D fallback that exists
// precisely for that case. Nothing at module scope may touch THREE.
var pointer = null;
var orbit = { az: 0, el: 0.42, dist: 62, tAz: 0, tEl: 0.42, tDist: 62, target: null };
var dragging = false, dragFrom = null, moved = 0;
var clock;

function initScene() {
  pointer = new THREE.Vector2(-2, -2);
  orbit.target = new THREE.Vector3();
  var canvas = $('#canvas');
  renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  // Cap the pixel ratio: a 3x retina buffer is the single easiest way to make
  // this unusable on a business laptop, and the gain is invisible here.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x05070f, 1);

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x05070f, 0.0075);

  camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.5, 900);
  raycaster = new THREE.Raycaster();
  clock = new THREE.Clock();

  scene.add(new THREE.AmbientLight(0x2a4a7a, 1.5));
  var key = new THREE.DirectionalLight(0x9fd8ff, 1.15); key.position.set(30, 45, 25); scene.add(key);
  var rim = new THREE.DirectionalLight(0x6f7cf7, 0.7); rim.position.set(-35, -12, -30); scene.add(rim);
  var glow = new THREE.PointLight(0x35c3f3, 2.2, 150); glow.position.set(0, 4, 0); scene.add(glow);

  root = new THREE.Group(); scene.add(root);

  starfield();
  grid();

  window.addEventListener('resize', onResize);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerleave', function () { if (pointer) pointer.set(-2, -2); });
}

function starfield() {
  var n = 900, pos = new Float32Array(n * 3);
  for (var i = 0; i < n; i++) {
    // Rejection-sampled into a shell so stars never sit inside the scene's
    // working volume, where they would read as UI dots rather than depth.
    var r = 150 + Math.random() * 260, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    pos[i * 3 + 1] = r * Math.cos(ph) * 0.6;
    pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
  }
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x7fa8d8, size: 1.1, sizeAttenuation: true, transparent: true, opacity: 0.5 })));
}

function grid() {
  var g = new THREE.GridHelper(300, 60, 0x1b3355, 0x0f1f36);
  g.position.y = -18; g.material.transparent = true; g.material.opacity = 0.32;
  scene.add(g);
}

function clearRoot() {
  for (var i = root.children.length - 1; i >= 0; i--) {
    var c = root.children[i];
    c.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { m.dispose(); }); }
    });
    root.remove(c);
  }
  picks = []; flows = []; hovered = null;
  labels.forEach(function (l) { l.elem.remove(); });
  labels = [];
}

function addLabel(text, obj, dim) {
  var e = el('div', 'lbl' + (dim ? ' dim' : ''), esc(text));
  $('#labels').appendChild(e);
  labels.push({ elem: e, obj: obj });
}

/** Central hub — the platform itself. */
function makeHub(label, color) {
  var g = new THREE.Group();
  var core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(5.2, 1),
    new THREE.MeshStandardMaterial({ color: color, metalness: 0.75, roughness: 0.22, emissive: color, emissiveIntensity: 0.28 })
  );
  g.add(core);
  var shell = new THREE.Mesh(
    new THREE.IcosahedronGeometry(7.4, 1),
    new THREE.MeshBasicMaterial({ color: color, wireframe: true, transparent: true, opacity: 0.2 })
  );
  g.add(shell);
  g.userData.spin = shell;
  root.add(g);
  addLabel(label, core);
  return g;
}

/** One explorable node. Geometry differs per kind so the scene reads as a
    system of different things rather than one shape repeated. */
function makeNode(node, kind, pos) {
  var color = node.color != null ? node.color : 0x35c3f3;
  var g = new THREE.Group();
  g.position.copy(pos);

  var geo;
  if (kind === 'db') geo = new THREE.CylinderGeometry(2.1, 2.1, 2.9, 26);
  else if (kind === 'host') geo = new THREE.BoxGeometry(3.4, 3.8, 1.9);
  else if (kind === 'cloud') geo = new THREE.OctahedronGeometry(2.5, 0);
  else if (kind === 'alert') geo = new THREE.ConeGeometry(2.1, 3.4, 4);
  else if (kind === 'tab') geo = new THREE.BoxGeometry(2.6, 2.6, 0.5);
  else geo = new THREE.SphereGeometry(2.2, 22, 16);

  var mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: color, metalness: 0.62, roughness: 0.3, emissive: color, emissiveIntensity: 0.16,
  }));
  g.add(mesh);

  // A soft halo doubles as the hover affordance — scaling it is cheaper and
  // steadier than animating the emissive of a lit material.
  var halo = new THREE.Mesh(
    new THREE.SphereGeometry(3.5, 18, 14),
    new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.07, side: THREE.BackSide })
  );
  g.add(halo);

  if (node.status && node.status !== 'implemented') {
    var ringColor = node.status === 'partial' || node.status === 'no-data' ? 0xf2b23c : 0xff6b7f;
    var ring = new THREE.Mesh(
      new THREE.TorusGeometry(3.15, 0.08, 8, 40),
      new THREE.MeshBasicMaterial({ color: ringColor, transparent: true, opacity: 0.75 })
    );
    ring.rotation.x = Math.PI / 2;
    g.add(ring);
  }

  root.add(g);
  mesh.userData.node = node; mesh.userData.group = g; mesh.userData.halo = halo;
  picks.push(mesh);
  addLabel(node.label, g);
  return g;
}

function connect(a, b, color, animated) {
  var pts = [];
  var steps = 22;
  for (var i = 0; i <= steps; i++) {
    var t = i / steps;
    var p = new THREE.Vector3().lerpVectors(a, b, t);
    p.y += Math.sin(t * Math.PI) * 2.2;   // gentle arc, so overlapping links stay legible
    pts.push(p);
  }
  var g = new THREE.BufferGeometry().setFromPoints(pts);
  root.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: 0.2 })));

  if (animated) {
    var n = 5, arr = new Float32Array(n * 3);
    var pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    var pts3 = new THREE.Points(pg, new THREE.PointsMaterial({ color: color, size: 0.62, transparent: true, opacity: 0.9 }));
    root.add(pts3);
    flows.push({ points: pts3, curve: pts, offset: Math.random(), count: n });
  }
}

function ring(count, radius, angleOf, y) {
  var out = [];
  for (var i = 0; i < count; i++) {
    var a = (angleOf ? angleOf(i) : (i / count) * 360) * Math.PI / 180;
    out.push(new THREE.Vector3(Math.cos(a) * radius, y || 0, Math.sin(a) * radius));
  }
  return out;
}

/* ── build each level ──────────────────────────────────────────────────── */

function buildOverview() {
  clearRoot();
  var hub = makeHub('ACTMON', 0x35c3f3);
  var pts = ring(D.MODULES.length, 24, function (i) { return D.MODULES[i].angle; }, 0);
  D.MODULES.forEach(function (m, i) {
    var node = Object.assign({}, m, { _kind: 'module' });
    var kind = m.id === 'database' ? 'db' : m.id === 'infra' ? 'host'
      : m.id === 'cloud' ? 'cloud' : m.id === 'alerts' ? 'alert' : 'node';
    makeNode(node, kind, pts[i]);
    connect(new THREE.Vector3(0, 0, 0), pts[i], m.color, true);
  });
  // Neighbour links: the modules are one system, not seven separate products.
  for (var j = 0; j < pts.length; j++) {
    connect(pts[j], pts[(j + 1) % pts.length], 0x2a4a7a, false);
  }
  setOrbit(0.42, 62);
  return hub;
}

function buildEngines() {
  clearRoot();
  makeHub('Database\nMonitoring', 0x35c3f3);
  var r1 = D.ENGINES.filter(function (e) { return e.ring !== 2; });
  var r2 = D.ENGINES.filter(function (e) { return e.ring === 2; });
  var p1 = ring(r1.length, 22, function (i) { return r1[i].angle; }, 0);
  r1.forEach(function (e, i) {
    makeNode(Object.assign({}, e, { _kind: 'engine' }), 'db', p1[i]);
    connect(new THREE.Vector3(0, 0, 0), p1[i], e.color, true);
  });
  var p2 = ring(r2.length, 34, function (i) { return r2[i].angle; }, 7);
  r2.forEach(function (e, i) {
    makeNode(Object.assign({}, e, { _kind: 'engine' }), 'cloud', p2[i]);
    connect(new THREE.Vector3(0, 0, 0), p2[i], e.color, true);
  });
  setOrbit(0.4, 58);
}

function buildPg() {
  clearRoot();
  makeHub('PostgreSQL', 0x4a9fd8);
  var tabs = D.PG_TABS;
  var pts = ring(tabs.length, 27, function (i) { return tabs[i].angle; }, 0);
  tabs.forEach(function (t, i) {
    var node = Object.assign({}, t, { _kind: 'pgtab', color: t.virtual ? 0x6f7cf7 : 0x4a9fd8 });
    makeNode(node, 'tab', pts[i]);
    connect(new THREE.Vector3(0, 0, 0), pts[i], t.virtual ? 0x6f7cf7 : 0x2f6f9f, i % 3 === 0);
  });
  setOrbit(0.5, 66);
}

function buildProviders() {
  clearRoot();
  makeHub('Cloud', 0x6f7cf7);
  var pts = ring(D.PROVIDERS.length, 21, function (i) { return D.PROVIDERS[i].angle; }, 0);
  D.PROVIDERS.forEach(function (p, i) {
    makeNode(Object.assign({}, p, { _kind: 'provider' }), 'cloud', pts[i]);
    connect(new THREE.Vector3(0, 0, 0), pts[i], p.color, true);
    // resource satellites — visual density proportional to what is scanned
    var sats = Math.min(p.resources.length, 9);
    for (var k = 0; k < sats; k++) {
      var a = (k / sats) * Math.PI * 2;
      var sp = new THREE.Vector3(pts[i].x + Math.cos(a) * 6, Math.sin(a * 2) * 2.4, pts[i].z + Math.sin(a) * 6);
      var m = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 10, 8),
        new THREE.MeshBasicMaterial({ color: p.color, transparent: true, opacity: 0.55 })
      );
      m.position.copy(sp); root.add(m);
    }
  });
  setOrbit(0.44, 56);
}

function buildInfra() {
  clearRoot();
  makeHub('Infrastructure', 0x2fd6a6);
  var pts = ring(D.INFRA_TABS.length, 20, null, 0);
  D.INFRA_TABS.forEach(function (t, i) {
    makeNode(Object.assign({}, t, { _kind: 'infratab', color: 0x2fd6a6, status: 'implemented' }), 'host', pts[i]);
    connect(new THREE.Vector3(0, 0, 0), pts[i], 0x2fd6a6, i % 2 === 0);
  });
  setOrbit(0.42, 54);
}

function buildCollection() {
  clearRoot();
  makeHub('ACTMON server', 0x7cd6f0);
  var specs = [
    { id: 'agent', label: 'Host agent', color: 0x7cd6f0, angle: 210, kind: 'host', status: 'implemented' },
    { id: 'direct', label: 'Server-direct', color: 0x35c3f3, angle: 330, kind: 'db', status: 'partial' },
    { id: 'cloudapi', label: 'Cloud provider API', color: 0x6f7cf7, angle: 90, kind: 'cloud', status: 'implemented' },
  ];
  var pts = ring(specs.length, 19, function (i) { return specs[i].angle; }, 0);
  specs.forEach(function (s, i) {
    makeNode(Object.assign({}, s, { _kind: 'collect' }), s.kind, pts[i]);
    connect(new THREE.Vector3(0, 0, 0), pts[i], s.color, true);
  });
  // the two storage tiers, below
  var tiers = [
    { label: 'Redis · hot', color: 0xff6b7f, x: -11 },
    { label: 'ClickHouse · history', color: 0xfbd42c, x: 0 },
    { label: 'PostgreSQL · config', color: 0x4a9fd8, x: 11 },
  ];
  tiers.forEach(function (t) {
    var p = new THREE.Vector3(t.x, -13, 4);
    var m = new THREE.Mesh(
      new THREE.CylinderGeometry(1.7, 1.7, 2.3, 22),
      new THREE.MeshStandardMaterial({ color: t.color, metalness: 0.6, roughness: 0.35, emissive: t.color, emissiveIntensity: 0.12 })
    );
    m.position.copy(p); root.add(m);
    var holder = new THREE.Group(); holder.position.copy(p); root.add(holder);
    addLabel(t.label, holder, true);
    connect(new THREE.Vector3(0, 0, 0), p, t.color, true);
  });
  setOrbit(0.5, 56);
}

function buildAlerts() {
  clearRoot();
  makeHub('Alert engine', 0xf2b23c);
  var pts = ring(D.ALERT_TIERS.length, 18, function (i) { return i * 120; }, 0);
  D.ALERT_TIERS.forEach(function (t, i) {
    var color = t.tone === 'ok' ? 0x3ad39a : t.tone === 'info' ? 0x7cd6f0 : 0xf2b23c;
    makeNode(Object.assign({}, t, {
      _kind: 'alerttier', color: color,
      status: t.id === 'reserved' ? 'no-data' : 'implemented',
      label: t.label + ' · ' + t.count,
    }), 'alert', pts[i]);
    connect(new THREE.Vector3(0, 0, 0), pts[i], color, true);
  });
  // channels as an outer ring
  var cp = ring(D.CHANNELS.length, 32, null, -6);
  D.CHANNELS.forEach(function (c, i) {
    makeNode(Object.assign({}, c, { _kind: 'channel', color: 0xff8fa3, status: 'implemented' }), 'node', cp[i]);
  });
  setOrbit(0.46, 66);
}

function buildRbac() {
  clearRoot();
  makeHub('Access control', 0xff8fa3);
  var pts = ring(D.RBAC.bits.length, 19, null, 0);
  D.RBAC.bits.forEach(function (b, i) {
    makeNode({
      _kind: 'bit', id: 'bit-' + b.value, label: b.label + ' · ' + b.value,
      color: 0xff8fa3, status: 'implemented', bit: b,
    }, 'node', pts[i]);
    connect(new THREE.Vector3(0, 0, 0), pts[i], 0xff8fa3, false);
  });
  setOrbit(0.44, 52);
}

function buildLogs() {
  clearRoot();
  makeHub('Logs', 0x9d8df1);
  // A log is a stream, so it is drawn as one: columns of particles falling
  // through the hub rather than nodes on a ring.
  for (var s = 0; s < 5; s++) {
    var n = 40, arr = new Float32Array(n * 3);
    var ang = (s / 5) * Math.PI * 2, rad = 13;
    for (var i = 0; i < n; i++) {
      arr[i * 3] = Math.cos(ang) * rad + (Math.random() - 0.5) * 2.4;
      arr[i * 3 + 1] = -20 + Math.random() * 40;
      arr[i * 3 + 2] = Math.sin(ang) * rad + (Math.random() - 0.5) * 2.4;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    var p = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x9d8df1, size: 0.55, transparent: true, opacity: 0.75 }));
    p.userData.stream = true; root.add(p);
  }
  setOrbit(0.3, 52);
}

/* ── 3. camera ─────────────────────────────────────────────────────────── */

function setOrbit(elv, dist) {
  orbit.tEl = elv; orbit.tDist = dist;
  if (reduced) { orbit.el = elv; orbit.dist = dist; }
}

function applyCamera() {
  var d = orbit.dist, a = orbit.az, e = orbit.el;
  camera.position.set(
    Math.cos(a) * Math.cos(e) * d,
    Math.sin(e) * d,
    Math.sin(a) * Math.cos(e) * d
  );
  camera.lookAt(orbit.target);
}

function onResize() {
  if (!renderer) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function onWheel(e) {
  e.preventDefault();
  // Clamped hard at both ends: the brief's "prevent the camera becoming lost"
  // is mostly this one line.
  orbit.tDist = Math.max(20, Math.min(150, orbit.tDist + e.deltaY * 0.055));
}

function onPointerDown(e) { dragging = true; moved = 0; dragFrom = { x: e.clientX, y: e.clientY }; }
function onPointerMove(e) {
  if (!pointer) return;
  var r = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  if (dragging && dragFrom) {
    var dx = e.clientX - dragFrom.x, dy = e.clientY - dragFrom.y;
    moved += Math.abs(dx) + Math.abs(dy);
    orbit.tAz -= dx * 0.005;
    // Elevation clamped away from the poles, where the scene flips and the
    // labels stop making sense.
    orbit.tEl = Math.max(-0.35, Math.min(1.15, orbit.tEl + dy * 0.004));
    dragFrom = { x: e.clientX, y: e.clientY };
  }
}
function onPointerUp() {
  // A drag is not a click. 6px of slop keeps trackpads usable.
  if (dragging && moved < 6) pick();
  dragging = false; dragFrom = null;
}

function pick() {
  raycaster.setFromCamera(pointer, camera);
  var hit = raycaster.intersectObjects(picks, false)[0];
  if (hit) openNode(hit.object.userData.node);
}

/* ── render loop ───────────────────────────────────────────────────────── */

var tmpV = null;   // same reason as `pointer` above
function tick() {
  if (!tmpV) tmpV = new THREE.Vector3();
  requestAnimationFrame(tick);
  if (!renderer) return;
  var dt = clock.getDelta(), t = clock.elapsedTime;

  // Eased approach, so every transition feels the same whether it came from a
  // wheel, a click, a breadcrumb or the tour.
  var k = reduced ? 1 : Math.min(1, dt * 3.4);
  orbit.az += (orbit.tAz - orbit.az) * k;
  orbit.el += (orbit.tEl - orbit.el) * k;
  orbit.dist += (orbit.tDist - orbit.dist) * k;
  applyCamera();

  if (!reduced) {
    root.children.forEach(function (c) {
      if (c.userData && c.userData.spin) c.userData.spin.rotation.y += dt * 0.12;
      if (c.userData && c.userData.stream) {
        var pos = c.geometry.attributes.position;
        for (var i = 0; i < pos.count; i++) {
          var y = pos.getY(i) - dt * 7;
          if (y < -20) y = 20;
          pos.setY(i, y);
        }
        pos.needsUpdate = true;
      }
    });
    flows.forEach(function (f) {
      var pos = f.points.geometry.attributes.position;
      for (var i = 0; i < f.count; i++) {
        var p = ((t * 0.22) + f.offset + i / f.count) % 1;
        var idx = Math.min(f.curve.length - 1, Math.floor(p * (f.curve.length - 1)));
        var v = f.curve[idx];
        pos.setXYZ(i, v.x, v.y, v.z);
      }
      pos.needsUpdate = true;
    });
  }

  // hover
  raycaster.setFromCamera(pointer, camera);
  var hit = raycaster.intersectObjects(picks, false)[0];
  var h = hit ? hit.object : null;
  if (h !== hovered) {
    if (hovered && hovered.userData.halo) scaleTo(hovered.userData.halo, 1);
    if (h && h.userData.halo) scaleTo(h.userData.halo, 1.35);
    hovered = h;
    renderer.domElement.style.cursor = h ? 'pointer' : 'grab';
  }

  // labels follow their object in screen space
  labels.forEach(function (l) {
    l.obj.getWorldPosition(tmpV);
    tmpV.project(camera);
    var vis = tmpV.z < 1;
    l.elem.style.display = vis ? 'block' : 'none';
    if (!vis) return;
    l.elem.style.left = ((tmpV.x * 0.5 + 0.5) * window.innerWidth) + 'px';
    l.elem.style.top = ((-tmpV.y * 0.5 + 0.5) * window.innerHeight - 26) + 'px';
  });

  renderer.render(scene, camera);
}

function scaleTo(obj, s) {
  if (GS && !reduced) GS.to(obj.scale, { x: s, y: s, z: s, duration: 0.28, overwrite: true });
  else obj.scale.set(s, s, s);
}

/* ── 4. navigation ─────────────────────────────────────────────────────── */

function go(level, fromHistory) {
  if (!fromHistory) future = [];
  stack.push(level);
  render();
}

function backTo(depth) {
  while (stack.length > depth + 1) future.unshift(stack.pop());
  render();
}

function goBack() {
  if (stack.length <= 1) return;
  future.unshift(stack.pop());
  render();
}

function goForward() {
  if (!future.length) return;
  stack.push(future.shift());
  render();
}

function reset() { stack = [{ type: 'overview' }]; future = []; closePanel(); render(); }

function current() { return stack[stack.length - 1]; }

var LEVEL_NAMES = ['Platform', 'Module', 'Technology', 'Feature', 'Detail'];

function render() {
  var lv = current();

  // The 3D scene is ONE part of a render, not a precondition for it. When
  // three.js is unavailable the breadcrumbs, level indicator, history buttons
  // and detail panel all still have to work — an early return here is what
  // silently broke every one of them in the 2D fallback.
  if (THREE_OK && root) {
    // Build the scene for the deepest level that HAS a scene. Feature levels
    // keep their parent's scene and just open the panel, so the camera does not
    // jump when the reader moves between sibling features.
    var sceneLevel = lv;
    if (lv.type === 'feature' || lv.type === 'walkthrough' || lv.type === 'detail') {
      for (var i = stack.length - 1; i >= 0; i--) {
        if (['overview', 'module', 'engine'].indexOf(stack[i].type) >= 0) { sceneLevel = stack[i]; break; }
      }
    }
    if (lastSceneKey !== keyOf(sceneLevel)) {
      try { buildFor(sceneLevel); lastSceneKey = keyOf(sceneLevel); }
      catch (err) { THREE_OK = false; }   // never let a scene failure block the document
    }
  }

  renderCrumbs();
  $('#lvl').textContent = 'Level ' + (stack.length - 1) + ' · ' + (LEVEL_NAMES[Math.min(stack.length - 1, 4)]);
  $('#back').disabled = stack.length <= 1;
  $('#fwd').disabled = future.length === 0;

  renderPanel(lv);
  if (flat2d) renderFlat();
}

var lastSceneKey = null;
function keyOf(l) { return l.type + ':' + (l.id || ''); }

function buildFor(l) {
  if (l.type === 'overview') return buildOverview();
  if (l.type === 'engine') return buildPg();          // PostgreSQL is the only engine with a tab graph
  if (l.type === 'module') {
    var m = byId(D.MODULES, l.id);
    var ch = m && m.children;
    if (ch === 'engines') return buildEngines();
    if (ch === 'providers') return buildProviders();
    if (ch === 'infraTabs') return buildInfra();
    if (ch === 'collection') return buildCollection();
    if (ch === 'alertTiers') return buildAlerts();
    if (ch === 'rbac') return buildRbac();
    return buildLogs();
  }
  return buildOverview();
}

/** The product has 16 dashboard tabs. PG_TABS also carries the Query Analysis
    detail page, which is reached from Slow Queries rather than the tab strip,
    so counting the array would overstate the tab count by one. */
function realTabCount() {
  return D.PG_TABS.filter(function (t) { return !t.virtual; }).length;
}

function byId(arr, id) {
  for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
  return null;
}

function titleOf(l) {
  if (l.type === 'overview') return 'ACTMON';
  if (l.type === 'module') { var m = byId(D.MODULES, l.id); return m ? m.label : l.id; }
  if (l.type === 'engine') { var e = byId(D.ENGINES, l.id); return e ? e.label : l.id; }
  if (l.type === 'feature') {
    var f = byId(D.PG_TABS, l.id) || byId(D.PROVIDERS, l.id) || byId(D.INFRA_TABS, l.id)
      || byId(D.ENGINES, l.id) || byId(D.CHANNELS, l.id);
    return f ? f.label : (l.label || l.id);
  }
  if (l.type === 'walkthrough') { var w = D.WALKTHROUGHS[l.id]; return w ? w.title : l.id; }
  if (l.type === 'detail') return l.label || l.id;
  return l.id || '—';
}

function renderCrumbs() {
  var c = $('#crumbs'); c.innerHTML = '';
  stack.forEach(function (l, i) {
    if (i > 0) c.appendChild(el('span', 'crumb-sep', '/'));
    var b = el('button', 'crumb', esc(titleOf(l)));
    if (i === stack.length - 1) b.setAttribute('aria-current', 'page');
    b.onclick = function () { backTo(i); };
    c.appendChild(b);
  });
}

/** One entry point for "the reader chose a thing". Everything — 3D clicks,
    search hits, panel buttons, the tour — comes through here. */
function openNode(node) {
  if (!node) return;
  switch (node._kind) {
    case 'module': go({ type: 'module', id: node.id }); break;
    case 'engine':
      if (node.id === 'postgresql') go({ type: 'engine', id: node.id });
      else go({ type: 'feature', id: node.id, kind: 'engine' });
      break;
    case 'pgtab': go({ type: 'feature', id: node.id, kind: 'pgtab' }); break;
    case 'provider': go({ type: 'feature', id: node.id, kind: 'provider' }); break;
    case 'infratab': go({ type: 'feature', id: node.id, kind: 'infratab' }); break;
    case 'collect': go({ type: 'detail', id: node.id, kind: 'collect', label: node.label }); break;
    case 'alerttier': go({ type: 'detail', id: node.id, kind: 'alerttier', label: node.label }); break;
    case 'channel': go({ type: 'detail', id: node.id, kind: 'channel', label: node.label }); break;
    case 'bit': go({ type: 'detail', id: node.id, kind: 'bit', label: node.label, bit: node.bit }); break;
    default: break;
  }
}

/* ── 5. panel ──────────────────────────────────────────────────────────── */

function closePanel() { $('#panel').classList.remove('open'); }
function openPanel() { $('#panel').classList.add('open'); }

function renderPanel(l) {
  var body = $('#pBody');
  body.innerHTML = '';
  var kicker = '', title = '', sub = '';

  if (l.type === 'overview') { renderOverviewPanel(body); kicker = 'Platform'; title = D.META.title; sub = D.META.subtitle; }
  else if (l.type === 'module') {
    var m = byId(D.MODULES, l.id);
    kicker = 'Module · ' + (m.route || ''); title = m.label; sub = m.blurb;
    renderModulePanel(body, m);
  }
  else if (l.type === 'engine') {
    var e = byId(D.ENGINES, l.id);
    kicker = 'Technology · ' + e.route; title = e.label; sub = e.note;
    renderEnginePanel(body, e);
  }
  else if (l.type === 'feature') { var r = renderFeaturePanel(body, l); kicker = r.k; title = r.t; sub = r.s; }
  else if (l.type === 'walkthrough') {
    var w = D.WALKTHROUGHS[l.id];
    kicker = 'Guided example'; title = w.title; sub = w.subtitle;
    renderWalkthrough(body, w);
  }
  else if (l.type === 'detail') { var d = renderDetailPanel(body, l); kicker = d.k; title = d.t; sub = d.s; }

  $('#pKicker').textContent = kicker;
  $('#pTitle').textContent = title;
  $('#pSub').textContent = sub || '';
  openPanel();
  body.scrollTop = 0;
}

function sec(title, inner) {
  var s = el('div', 'sec');
  if (title) s.appendChild(el('h3', 'sec-h', esc(title)));
  if (typeof inner === 'string') s.insertAdjacentHTML('beforeend', inner);
  else if (inner) s.appendChild(inner);
  return s;
}

function navList(items, onPick) {
  var w = el('div', 'navlist');
  items.forEach(function (it) {
    var b = el('button', 'navbtn');
    b.innerHTML =
      '<span class="swatch" style="background:#' + (it.color != null ? it.color.toString(16).padStart(6, '0') : '35c3f3') + '"></span>'
      + '<span style="min-width:0"><b>' + esc(it.label) + '</b>'
      + (it.sub ? '<small>' + esc(it.sub) + '</small>' : '') + '</span>'
      + (it.status && it.status !== 'implemented' ? statusChip(it.status) : '')
      + '<span class="arrow">&rsaquo;</span>';
    b.onclick = function () { onPick(it); };
    w.appendChild(b);
  });
  return w;
}

function renderOverviewPanel(body) {
  body.appendChild(sec('What this document is',
    '<p>An explorable map of the ACTMON platform. Every capability described here was read out of the '
    + 'repository before it was written down, and each node carries the file it came from.</p>'
    + '<div class="note"><b>Sample mode.</b> ' + esc(D.META.disclaimer) + '</div>'));

  body.appendChild(sec('Monitoring domains', navList(D.MODULES.map(function (m) {
    return { label: m.label, sub: m.blurb, color: m.color, status: m.status, _m: m };
  }), function (it) { go({ type: 'module', id: it._m.id }); })));

  body.appendChild(sec('End-to-end flow',
    '<p>' + D.PIPELINE.tiers.map(function (t, i) {
      return '<b>' + (i + 1) + '. ' + esc(t.label) + '</b> — ' + esc(t.detail);
    }).join('<br />') + '</p>'
    + '<div class="note">' + esc(D.PIPELINE.note) + '</div>'
    + '<p class="srcline">' + esc(D.PIPELINE.src) + '</p>'));

  var wt = el('div');
  wt.appendChild(navList([
    { label: 'Investigating a slow query', sub: 'Symptom to a checkable recommendation', color: 0x35c3f3, _w: 'slowQuery' },
    { label: 'What can this role actually do?', sub: 'Effective privileges, not direct grants', color: 0xff8fa3, _w: 'role' },
    { label: 'From metric to resolution', sub: 'The incident lifecycle', color: 0xf2b23c, _w: 'incident' },
  ], function (it) { go({ type: 'walkthrough', id: it._w }); }));
  body.appendChild(sec('Guided examples', wt));

  body.appendChild(sec('Also in the product',
    '<p>' + D.SUPPORT_MODULES.map(function (s) {
      return '<b>' + esc(s.label) + '</b> <span style="color:var(--dim)">' + esc(s.route) + '</span> — ' + esc(s.note);
    }).join('<br />') + '</p>'));

  body.appendChild(sec('How to read the status marks',
    '<div class="chips">' + Object.keys(STATUS).map(function (k) { return statusChip(k); }).join('') + '</div>'
    + '<p style="margin-top:9px">A node ringed in amber is partial; a node ringed in red is not implemented. '
    + 'Anything labelled illustrative is an invented example so the document is explorable offline.</p>'));
}

function renderModulePanel(body, m) {
  body.appendChild(sec(null, '<div class="chips">' + statusChip(m.status) + '<span class="chip">' + esc(m.route) + '</span></div>'));
  body.appendChild(sec('What it does', '<p>' + esc(m.what) + '</p>'));
  body.appendChild(sec('Why it matters', '<p>' + esc(m.why) + '</p>'));

  if (m.children === 'engines') {
    body.appendChild(sec('Database technologies', navList(D.ENGINES.map(function (e) {
      return { label: e.label, sub: e.note, color: e.color, status: e.status, _e: e };
    }), function (it) {
      if (it._e.id === 'postgresql') go({ type: 'engine', id: 'postgresql' });
      else go({ type: 'feature', id: it._e.id, kind: 'engine' });
    })));
    body.appendChild(sec('Capability comparison', comparisonTable()));
    body.appendChild(sec('Explicitly not supported',
      D.NOT_ENGINES.map(function (n) {
        return '<div class="note bad" style="margin-bottom:8px"><b>' + esc(n.label) + ' — ' + esc(n.verdict) + '</b><br />' + esc(n.detail) + '</div>';
      }).join('')));
  }
  if (m.children === 'providers') {
    body.appendChild(sec('Cloud providers', navList(D.PROVIDERS.map(function (p) {
      return { label: p.label, sub: p.resources.length + ' resource types scanned', color: p.color, status: p.status, _p: p };
    }), function (it) { go({ type: 'feature', id: it._p.id, kind: 'provider' }); })));
    body.appendChild(sec(null, '<div class="note bad"><b>' + esc(D.NOT_ENGINES[1].label) + ' — ' + esc(D.NOT_ENGINES[1].verdict) + '</b><br />' + esc(D.NOT_ENGINES[1].detail) + '</div>'));
  }
  if (m.children === 'infraTabs') {
    body.appendChild(sec('Host detail tabs', navList(D.INFRA_TABS.map(function (t) {
      return { label: t.label, sub: t.what, color: 0x2fd6a6, _t: t };
    }), function (it) { go({ type: 'feature', id: it._t.id, kind: 'infratab' }); })));
    body.appendChild(sec('History windows', '<p>' + esc(D.INFRA_EXTRA.ranges) + '</p><p>' + esc(D.INFRA_EXTRA.fileExplorer) + '</p>'));
    body.appendChild(sec('Relating host to database', '<div class="note warn">' + esc(D.INFRA_EXTRA.correlation) + '</div>'));
  }
  if (m.children === 'collection') {
    body.appendChild(sec('Collection methods', navList([
      { label: D.COLLECTION.agent.label, sub: D.COLLECTION.agent.detail, color: 0x7cd6f0, _c: 'agent' },
      { label: D.COLLECTION.direct.label, sub: D.COLLECTION.direct.detail, color: 0x35c3f3, _c: 'direct' },
    ], function (it) { go({ type: 'detail', id: it._c, kind: 'collect', label: it.label }); })));
    body.appendChild(sec(null, '<div class="note warn">' + esc(D.COLLECTION.note) + '</div>'));
    body.appendChild(sec('Storage tiers', '<p>' + D.PIPELINE.tiers.map(function (t) {
      return '<b>' + esc(t.label) + '</b> — ' + esc(t.detail);
    }).join('<br />') + '</p>'));
  }
  if (m.children === 'alertTiers') {
    body.appendChild(sec('Rule evaluation tiers', navList(D.ALERT_TIERS.map(function (t) {
      return {
        label: t.label + ' — ' + t.count + ' rule types', sub: t.detail,
        color: t.tone === 'ok' ? 0x3ad39a : t.tone === 'info' ? 0x7cd6f0 : 0xf2b23c,
        status: t.id === 'reserved' ? 'no-data' : 'implemented', _t: t,
      };
    }), function (it) { go({ type: 'detail', id: it._t.id, kind: 'alerttier', label: it._t.label }); })));
    body.appendChild(sec(null, '<div class="note warn">' + esc(D.ALERT_NOTE) + '</div>'));
    body.appendChild(sec('Notification channels', navList(D.CHANNELS.map(function (c) {
      return { label: c.label, sub: c.detail, color: 0xff8fa3, _c: c };
    }), function (it) { go({ type: 'detail', id: it._c.id, kind: 'channel', label: it._c.label }); })));
  }
  if (m.children === 'rbac') {
    body.appendChild(sec('The model', '<p>' + esc(D.RBAC.model) + '</p><p>' + esc(D.RBAC.composite) + '</p>'));
    body.appendChild(sec('Permission bits',
      '<div class="chips">' + D.RBAC.bits.map(function (b) {
        return '<span class="chip">' + esc(b.label) + ' · ' + b.value + '</span>';
      }).join('') + '</div>'));
    body.appendChild(sec('Why registration matters', '<div class="note warn">' + esc(D.RBAC.ungoverned) + '</div>'));
    body.appendChild(sec('Credentials', '<div class="note ok">' + esc(D.RBAC.credentials) + '</div><p style="margin-top:8px">' + esc(D.RBAC.audit) + '</p>'));
  }
  if (m.id === 'logs') {
    body.appendChild(sec('Try it', navList([
      { label: 'PostgreSQL Error Logs', sub: 'Severity, SQLSTATE, detail, hint and context', color: 0x9d8df1, _f: 'error-logs' },
    ], function () { stack = [{ type: 'overview' }, { type: 'module', id: 'database' }, { type: 'engine', id: 'postgresql' }]; go({ type: 'feature', id: 'error-logs', kind: 'pgtab' }); })));
  }
  body.appendChild(sec('Source', '<p class="srcline">' + esc(m.src) + '</p>'));
}

function comparisonTable() {
  var w = el('div');
  var rows = D.ENGINES.map(function (e) {
    return '<tr><td style="padding:6px 8px 6px 0;font-weight:600">' + esc(e.label) + '</td>'
      + '<td style="padding:6px 8px">' + statusChip(e.status) + '</td>'
      + '<td style="padding:6px 0;font-family:var(--fm);font-size:11px;color:var(--dim)">'
      + (e.direct ? 'agent or direct' : 'agent') + '</td></tr>';
  }).join('');
  w.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:12.5px">'
    + '<thead><tr style="color:var(--dim);font-size:10px;letter-spacing:.1em;text-transform:uppercase">'
    + '<th style="text-align:left;padding-bottom:6px">Engine</th><th style="text-align:left">Status</th>'
    + '<th style="text-align:left">Reach</th></tr></thead><tbody>' + rows + '</tbody></table>'
    + '<p style="margin-top:9px;font-size:12px;color:var(--muted);line-height:1.55">'
    + '&ldquo;direct&rdquo; means ACTMON may connect from its own server without an agent. That is attempted only for '
    + 'MySQL, MariaDB and PostgreSQL, and never when the host is loopback.</p>';
  return w;
}

function renderEnginePanel(body, e) {
  body.appendChild(sec(null, '<div class="chips">' + statusChip(e.status) + '<span class="chip">' + esc(e.route) + '</span>'
    + '<span class="chip info">' + realTabCount() + ' dashboard tabs</span>'
    + '<span class="chip info">+1 detail page</span></div>'));
  body.appendChild(sec('Dashboard sections', navList(D.PG_TABS.map(function (t) {
    return {
      label: t.label + (t.virtual ? '  (detail page)' : ''),
      sub: t.what, color: t.virtual ? 0x6f7cf7 : 0x4a9fd8, status: t.status, _t: t,
    };
  }), function (it) { go({ type: 'feature', id: it._t.id, kind: 'pgtab' }); })));
  body.appendChild(sec('Guided examples', navList([
    { label: 'Investigating a slow query', sub: 'Seven steps, one statement', color: 0x35c3f3, _w: 'slowQuery' },
    { label: 'What can migration_user do?', sub: 'Effective privilege inspection', color: 0xff8fa3, _w: 'role' },
  ], function (it) { go({ type: 'walkthrough', id: it._w }); })));
  body.appendChild(sec('Source', '<p class="srcline">' + esc(e.src) + '</p>'));
}

function renderFeaturePanel(body, l) {
  var t = byId(D.PG_TABS, l.id);
  if (t && l.kind === 'pgtab') {
    body.appendChild(sec(null, '<div class="chips">' + statusChip(t.status)
      + (t.virtual ? '<span class="chip info">Detail page</span>' : '') + '</div>'));
    body.appendChild(sec('What it does', '<p>' + esc(t.what) + '</p>'));
    body.appendChild(sec('Why it matters', '<p>' + esc(t.why) + '</p>'));
    body.appendChild(sec('What it monitors', '<ul class="list">' + t.monitors.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'));
    if (t.sample) {
      var tiles = el('div', 'tiles');
      t.sample.forEach(function (p) {
        tiles.appendChild(el('div', 'tile', '<dt>' + esc(p[0]) + '</dt><dd>' + esc(p[1]) + '</dd>'));
      });
      var s = sec('Sample data', tiles);
      s.insertAdjacentHTML('beforeend', '<p style="margin-top:9px;font-size:11.5px;color:var(--dim)">Illustrative values, not live measurements.</p>');
      body.appendChild(s);
    }
    body.appendChild(sec('An operational scenario', '<p>' + esc(t.scenario) + '</p>'));
    body.appendChild(sec('How a DBA uses it', '<div class="note">' + esc(t.dba) + '</div>'));
    if (t.safety) body.appendChild(sec('Safety', '<div class="note ok">' + esc(t.safety) + '</div>'));
    if (t.note) body.appendChild(sec('Worth knowing', '<div class="note warn">' + esc(t.note) + '</div>'));
    if (t.illustrative) body.appendChild(sec(null, '<div class="note warn"><b>Illustrative.</b> ' + esc(t.illustrative) + '</div>'));
    if (t.deepDive) {
      body.appendChild(sec('Walk through it', navList([{
        label: D.WALKTHROUGHS[t.deepDive].title, sub: D.WALKTHROUGHS[t.deepDive].subtitle,
        color: 0x35c3f3, _w: t.deepDive,
      }], function (it) { go({ type: 'walkthrough', id: it._w }); })));
    }
    if (t.related && t.related.length) {
      body.appendChild(sec('Related', navList(t.related.map(function (rid) {
        var rt = byId(D.PG_TABS, rid) || byId(D.MODULES, rid);
        return { label: rt ? rt.label : rid, color: 0x6a7f9f, _r: rid, _isTab: !!byId(D.PG_TABS, rid) };
      }), function (it) {
        if (it._isTab) go({ type: 'feature', id: it._r, kind: 'pgtab' });
        else go({ type: 'module', id: it._r });
      })));
    }
    return { k: 'PostgreSQL · ' + (t.virtual ? 'detail page' : 'dashboard tab'), t: t.label, s: t.what };
  }

  var p = byId(D.PROVIDERS, l.id);
  if (p && l.kind === 'provider') {
    body.appendChild(sec(null, '<div class="chips">' + statusChip(p.status) + '<span class="chip">' + p.resources.length + ' resource types</span></div>'));
    body.appendChild(sec('Authentication', '<p>' + esc(p.auth) + '</p>'));
    body.appendChild(sec('Resources discovered',
      '<div class="chips">' + p.resources.map(function (r) { return '<span class="chip">' + esc(r) + '</span>'; }).join('') + '</div>'));
    body.appendChild(sec('Cost data', '<div class="note warn">' + esc(p.cost) + '</div>'));
    body.appendChild(sec('Worth knowing', '<p>' + esc(p.note) + '</p>'));
    body.appendChild(sec('Source', '<p class="srcline">' + esc(p.src) + '</p>'));
    return { k: 'Cloud provider', t: p.label, s: p.resources.length + ' resource types inventoried' };
  }

  var it2 = byId(D.INFRA_TABS, l.id);
  if (it2 && l.kind === 'infratab') {
    body.appendChild(sec(null, '<div class="chips">' + statusChip('implemented') + '</div>'));
    body.appendChild(sec('What it shows', '<p>' + esc(it2.what) + '</p>'));
    body.appendChild(sec('History', '<p>' + esc(D.INFRA_EXTRA.ranges) + '</p>'));
    body.appendChild(sec('Relating host to database', '<div class="note warn">' + esc(D.INFRA_EXTRA.correlation) + '</div>'));
    return { k: 'Infrastructure · host tab', t: it2.label, s: it2.what };
  }

  var e = byId(D.ENGINES, l.id);
  if (e) {
    body.appendChild(sec(null, '<div class="chips">' + statusChip(e.status) + '<span class="chip">' + esc(e.route) + '</span>'
      + '<span class="chip ' + (e.direct ? 'ok' : 'info') + '">' + (e.direct ? 'agent or direct' : 'agent only') + '</span></div>'));
    body.appendChild(sec('What is implemented', '<p>' + esc(e.note) + '</p>'));
    if (e.status === 'partial') {
      body.appendChild(sec(null, '<div class="note warn"><b>Partial.</b> This technology does not have its own dashboard route. '
        + 'It is handled through another engine\'s code path, which is why it is marked partial rather than implemented.</div>'));
    }
    body.appendChild(sec('Compare', comparisonTable()));
    body.appendChild(sec('Source', '<p class="srcline">' + esc(e.src) + '</p>'));
    return { k: 'Database technology', t: e.label, s: e.note };
  }

  body.appendChild(sec(null, '<div class="note warn">No detail is recorded for this node.</div>'));
  return { k: 'Feature', t: titleOf(l), s: '' };
}

function renderDetailPanel(body, l) {
  if (l.kind === 'collect') {
    var c = D.COLLECTION[l.id];
    if (c) {
      body.appendChild(sec('What it is', '<p>' + esc(c.detail) + '</p>'));
      if (c.platforms) body.appendChild(sec('Platforms', '<ul class="list">' + c.platforms.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'));
      if (c.enrol) body.appendChild(sec('Enrolment', '<p>' + esc(c.enrol) + '</p>'));
      if (c.rule) body.appendChild(sec('When it is used', '<div class="note">' + esc(c.rule) + '</div>'));
      if (c.why) body.appendChild(sec('Why the restriction', '<div class="note warn">' + esc(c.why) + '</div>'));
      body.appendChild(sec('Source', '<p class="srcline">' + esc(c.src) + '</p>'));
      return { k: 'Collection method', t: c.label, s: '' };
    }
    body.appendChild(sec('Cloud provider API', '<p>' + esc(D.COLLECTION.note) + '</p>'));
    return { k: 'Collection method', t: l.label, s: '' };
  }
  if (l.kind === 'alerttier') {
    var t = byId(D.ALERT_TIERS, l.id);
    body.appendChild(sec(null, '<div class="chips">' + statusChip(t.id === 'reserved' ? 'no-data' : 'implemented')
      + '<span class="chip">' + t.count + ' rule types</span></div>'));
    body.appendChild(sec('What it means', '<p>' + esc(t.detail) + '</p>'));
    body.appendChild(sec('Examples', '<div class="chips">' + t.examples.map(function (x) { return '<span class="chip">' + esc(x) + '</span>'; }).join('') + '</div>'));
    if (t.id === 'reserved') body.appendChild(sec(null, '<div class="note bad">' + esc(D.ALERT_NOTE) + '</div>'));
    return { k: 'Alert evaluation tier', t: t.label, s: t.detail };
  }
  if (l.kind === 'channel') {
    var ch = byId(D.CHANNELS, l.id);
    body.appendChild(sec(null, '<div class="chips">' + statusChip('implemented') + '</div>'));
    body.appendChild(sec('Configuration', '<p>' + esc(ch.detail) + '</p>'));
    body.appendChild(sec(null, '<div class="note ok">Secrets for a channel — webhook URLs, bot tokens, access tokens — are stored '
      + 'by the product and are not reproduced anywhere in this document.</div>'));
    return { k: 'Notification channel', t: ch.label, s: ch.detail };
  }
  if (l.kind === 'bit') {
    body.appendChild(sec('The model', '<p>' + esc(D.RBAC.model) + '</p>'));
    body.appendChild(sec('This bit', '<dl class="kv"><dt>Permission</dt><dd>' + esc(l.bit.label) + '</dd>'
      + '<dt>Value</dt><dd>' + l.bit.value + '</dd></dl>'));
    body.appendChild(sec(null, '<div class="note">' + esc(D.RBAC.composite) + '</div>'));
    return { k: 'Permission bit', t: l.bit.label, s: 'Bitmask value ' + l.bit.value };
  }
  return { k: 'Detail', t: titleOf(l), s: '' };
}

function renderWalkthrough(body, w) {
  body.appendChild(sec(null, '<div class="note warn"><b>Illustrative.</b> ' + esc(w.subtitle) + '</div>'));
  var wrap = el('div');
  w.steps.forEach(function (s, i) {
    var st = el('div', 'wt-step done');
    st.appendChild(el('p', 'wt-t', esc((i + 1) + '. ' + s.t)));
    st.appendChild(el('p', 'wt-b', esc(s.b)));
    if (s.code) st.appendChild(el('pre', 'code', esc(s.code)));
    if (s.rows) {
      var dl = el('dl', 'kv');
      s.rows.forEach(function (r) {
        dl.appendChild(el('dt', null, esc(r[0])));
        dl.appendChild(el('dd', null, esc(r[1])));
      });
      st.appendChild(dl);
    }
    if (s.tab) {
      var b = el('button', 'btn', 'Open ' + esc((byId(D.PG_TABS, s.tab) || { label: s.tab }).label));
      b.style.marginTop = '8px';
      b.onclick = function () {
        stack = [{ type: 'overview' }, { type: 'module', id: 'database' }, { type: 'engine', id: 'postgresql' }];
        go({ type: 'feature', id: s.tab, kind: 'pgtab' });
      };
      st.appendChild(b);
    }
    wrap.appendChild(st);
  });
  body.appendChild(sec('Walkthrough', wrap));
}

/* ── search ────────────────────────────────────────────────────────────── */

var INDEX = [];

/** Words a reader is likely to type that are not in a node's own label.
    Keyed by node id. */
var ALIASES = {
  users: 'database roles role privileges grants permissions membership ownership migration_user superuser login',
  'slow-queries': 'slow query performance problem expensive statement',
  'query-analysis': 'explain execution plan analyse analyze optimisation optimization index recommendation rewrite',
  locks: 'blocking blocked deadlock contention waiting session',
  replication: 'standby primary replica lag wal streaming slot failover topology',
  indexes: 'index unused redundant btree scan usage',
  storage: 'disk size bloat vacuum tablespace toast capacity',
  config: 'settings parameters tuning max_connections shared_buffers work_mem wal_level',
  'error-logs': 'log logs sqlstate severity fatal error warning diagnostics',
  tables: 'schema table row count size activity',
  databases: 'database inventory owner encoding collation',
  maintenance: 'vacuum analyse archive wal cleanup housekeeping',
  overview: 'health summary status connections cache hit ratio uptime',
  performance: 'throughput commits rollbacks cache ratio io wait events',
  queries: 'pg_stat_statements statement digest execution count',
  reports: 'report export csv scheduled',
  diagnose: 'diagnostics guided troubleshooting',
  aws: 'amazon ec2 rds s3 dynamodb lambda eks redshift elasticache vpc iam',
  azure: 'microsoft cosmos db sql postgresql mysql aks redis storage vm',
  oci: 'oracle cloud compartment compute object storage nosql autonomous',
  cosmosdb: 'cosmos azure nosql request units ru partition throttling',
  postgresql: 'postgres pg',
  mssql: 'sql server microsoft t-sql',
  mariadb: 'maria mysql fork',
};

function buildIndex() {
  D.MODULES.forEach(function (m) { INDEX.push({ label: m.label, ctx: 'Module', kw: m.blurb, go: { type: 'module', id: m.id } }); });
  D.ENGINES.forEach(function (e) {
    INDEX.push({
      label: e.label, ctx: 'Database technology', kw: e.note + ' ' + (ALIASES[e.id] || ''),
      go: e.id === 'postgresql' ? { type: 'engine', id: 'postgresql' } : { type: 'feature', id: e.id, kind: 'engine' },
      pre: [{ type: 'module', id: 'database' }],
    });
  });
  D.PG_TABS.forEach(function (t) {
    INDEX.push({
      label: t.label, ctx: 'PostgreSQL',
      kw: t.what + ' ' + (t.monitors || []).join(' ') + ' ' + (ALIASES[t.id] || ''),
      go: { type: 'feature', id: t.id, kind: 'pgtab' },
      pre: [{ type: 'module', id: 'database' }, { type: 'engine', id: 'postgresql' }],
    });
  });
  D.PROVIDERS.forEach(function (p) {
    INDEX.push({
      label: p.label, ctx: 'Cloud provider', kw: p.resources.join(' ') + ' ' + (ALIASES[p.id] || ''),
      go: { type: 'feature', id: p.id, kind: 'provider' }, pre: [{ type: 'module', id: 'cloud' }],
    });
  });
  D.INFRA_TABS.forEach(function (t) {
    INDEX.push({
      label: t.label, ctx: 'Infrastructure', kw: t.what,
      go: { type: 'feature', id: t.id, kind: 'infratab' }, pre: [{ type: 'module', id: 'infra' }],
    });
  });
  D.CHANNELS.forEach(function (c) {
    INDEX.push({
      label: c.label, ctx: 'Notification channel', kw: c.detail,
      go: { type: 'detail', id: c.id, kind: 'channel', label: c.label }, pre: [{ type: 'module', id: 'alerts' }],
    });
  });
  D.ALERT_TIERS.forEach(function (t) {
    INDEX.push({
      label: t.label + ' alerts', ctx: 'Alert tier', kw: t.detail + ' ' + t.examples.join(' '),
      go: { type: 'detail', id: t.id, kind: 'alerttier', label: t.label }, pre: [{ type: 'module', id: 'alerts' }],
    });
  });
  Object.keys(D.WALKTHROUGHS).forEach(function (k) {
    INDEX.push({ label: D.WALKTHROUGHS[k].title, ctx: 'Guided example', kw: D.WALKTHROUGHS[k].subtitle, go: { type: 'walkthrough', id: k } });
  });
  D.NOT_ENGINES.forEach(function (n) {
    INDEX.push({ label: n.label, ctx: n.verdict, kw: n.detail, go: { type: 'module', id: 'database' } });
  });
}

var selIdx = -1;
function runSearch(q) {
  var box = $('#results');
  q = (q || '').trim().toLowerCase();
  if (!q) { box.classList.remove('show'); box.innerHTML = ''; return; }
  // Match on every word, not the phrase: "database roles" should find the
  // Users section even though those two words never sit together in its text.
  var words = q.split(/\s+/).filter(Boolean);
  var hits = INDEX.filter(function (r) {
    var hay = (r.label + ' ' + r.ctx + ' ' + (r.kw || '')).toLowerCase();
    return words.every(function (w) { return hay.indexOf(w) >= 0; });
  }).sort(function (a, b) {
    // Exact-ish label matches first: searching "Locks" should not surface a
    // module whose description happens to mention locking.
    var al = a.label.toLowerCase().indexOf(q), bl = b.label.toLowerCase().indexOf(q);
    return (al < 0 ? 99 : al) - (bl < 0 ? 99 : bl);
  }).slice(0, 12);

  box.innerHTML = '';
  selIdx = -1;
  if (!hits.length) { box.innerHTML = '<div class="res-none">Nothing matches &ldquo;' + esc(q) + '&rdquo;</div>'; box.classList.add('show'); return; }
  hits.forEach(function (h, i) {
    var b = el('button', 'res', '<b>' + esc(h.label) + '</b><span>' + esc(h.ctx) + '</span>');
    b.onclick = function () { jump(h); };
    b.dataset.i = i;
    box.appendChild(b);
  });
  box.classList.add('show');
}

function jump(h) {
  stack = [{ type: 'overview' }].concat(h.pre || []);
  future = [];
  stack.push(h.go);
  render();
  $('#results').classList.remove('show');
  $('#search').value = '';
  $('#search').blur();
}

/* ── tour ──────────────────────────────────────────────────────────────── */

function tourStart() {
  tour.on = true; tour.i = 0;
  $('#tour').classList.add('open');
  $('#tourBtn').classList.add('on');
  tourShow();
}
function tourStop() {
  tour.on = false;
  $('#tour').classList.remove('open');
  $('#tourBtn').classList.remove('on');
}
function tourShow() {
  var c = D.CHAPTERS[tour.i];
  $('#tourN').textContent = 'Chapter ' + (tour.i + 1) + ' of ' + D.CHAPTERS.length;
  $('#tourT').textContent = c.title;
  $('#tourB').textContent = c.body;
  $('#tourProg').style.width = (((tour.i + 1) / D.CHAPTERS.length) * 100) + '%';
  $('#tourPrev').disabled = tour.i === 0;
  $('#tourNext').textContent = tour.i === D.CHAPTERS.length - 1 ? 'Finish' : 'Next';

  var lv = c.level;
  if (lv.type === 'overview') stack = [{ type: 'overview' }];
  else if (lv.type === 'module') stack = [{ type: 'overview' }, { type: 'module', id: lv.id }];
  else if (lv.type === 'engine') stack = [{ type: 'overview' }, { type: 'module', id: 'database' }, { type: 'engine', id: lv.id }];
  else if (lv.type === 'walkthrough') stack = [{ type: 'overview' }, { type: 'walkthrough', id: lv.id }];
  future = [];
  render();
}
function tourNext() {
  if (tour.i >= D.CHAPTERS.length - 1) { tourStop(); toast('Tour finished — explore freely.'); return; }
  tour.i++; tourShow();
}
function tourPrev() { if (tour.i > 0) { tour.i--; tourShow(); } }

/* ── 2D fallback ───────────────────────────────────────────────────────── */

function renderFlat() {
  var b = $('#flatBody');
  b.innerHTML = '';
  b.appendChild(el('h2', 'flat-h', 'ACTMON — full feature index'));
  b.appendChild(el('p', 'flat-s',
    'Every node in the 3D view, as a flat list. This is the accessible alternative: it needs no WebGL, '
    + 'no pointer gestures, and works with a keyboard and a screen reader. ' + esc(D.META.disclaimer)));

  function group(title, items, onPick) {
    b.appendChild(el('p', 'flat-sec-h', esc(title)));
    var g = el('div', 'flat-grid');
    items.forEach(function (it) {
      var card = el('button', 'flat-card',
        '<b>' + esc(it.label) + (it.status && it.status !== 'implemented' ? ' ' + statusChip(it.status) : '') + '</b>'
        + '<p>' + esc(it.sub || '') + '</p>');
      card.onclick = function () { onPick(it); if (flat2d) toggleFlat(); };
      g.appendChild(card);
    });
    b.appendChild(g);
  }

  group('Monitoring domains', D.MODULES.map(function (m) { return { label: m.label, sub: m.blurb, status: m.status, _i: m.id }; }),
    function (it) { stack = [{ type: 'overview' }]; go({ type: 'module', id: it._i }); });

  group('Database technologies', D.ENGINES.map(function (e) { return { label: e.label, sub: e.note, status: e.status, _e: e }; }),
    function (it) {
      stack = [{ type: 'overview' }, { type: 'module', id: 'database' }];
      if (it._e.id === 'postgresql') go({ type: 'engine', id: 'postgresql' });
      else go({ type: 'feature', id: it._e.id, kind: 'engine' });
    });

  group('PostgreSQL dashboard sections', D.PG_TABS.map(function (t) { return { label: t.label, sub: t.what, status: t.status, _t: t }; }),
    function (it) {
      stack = [{ type: 'overview' }, { type: 'module', id: 'database' }, { type: 'engine', id: 'postgresql' }];
      go({ type: 'feature', id: it._t.id, kind: 'pgtab' });
    });

  group('Cloud providers', D.PROVIDERS.map(function (p) { return { label: p.label, sub: p.resources.length + ' resource types', status: p.status, _p: p }; }),
    function (it) { stack = [{ type: 'overview' }, { type: 'module', id: 'cloud' }]; go({ type: 'feature', id: it._p.id, kind: 'provider' }); });

  group('Infrastructure host tabs', D.INFRA_TABS.map(function (t) { return { label: t.label, sub: t.what, _t: t }; }),
    function (it) { stack = [{ type: 'overview' }, { type: 'module', id: 'infra' }]; go({ type: 'feature', id: it._t.id, kind: 'infratab' }); });

  group('Notification channels', D.CHANNELS.map(function (c) { return { label: c.label, sub: c.detail, _c: c }; }),
    function (it) { stack = [{ type: 'overview' }, { type: 'module', id: 'alerts' }]; go({ type: 'detail', id: it._c.id, kind: 'channel', label: it._c.label }); });

  group('Guided examples', Object.keys(D.WALKTHROUGHS).map(function (k) {
    return { label: D.WALKTHROUGHS[k].title, sub: D.WALKTHROUGHS[k].subtitle, _w: k };
  }), function (it) { stack = [{ type: 'overview' }]; go({ type: 'walkthrough', id: it._w }); });

  group('Not supported', D.NOT_ENGINES.map(function (n) { return { label: n.label, sub: n.detail, status: 'none' }; }), function () {});
}

function toggleFlat() {
  flat2d = !flat2d;
  $('#flat').classList.toggle('show', flat2d);
  $('#flatBtn').classList.toggle('on', flat2d);
  if (flat2d) { renderFlat(); closePanel(); }
  else openPanel();
}

/* ── legend ────────────────────────────────────────────────────────────── */

function renderLegend() {
  var l = $('#legend');
  l.innerHTML = ['implemented', 'partial', 'no-data', 'illustrative', 'none']
    .map(function (k) { return statusChip(k); }).join('');
}

/* ── wiring ────────────────────────────────────────────────────────────── */

function wire() {
  $('#home').onclick = reset;
  $('#reset').onclick = function () { reset(); toast('Back to the platform overview.'); };
  $('#back').onclick = goBack;
  $('#fwd').onclick = goForward;
  $('#pClose').onclick = closePanel;
  $('#tourBtn').onclick = function () { tour.on ? tourStop() : tourStart(); };
  $('#tourNext').onclick = tourNext;
  $('#tourPrev').onclick = tourPrev;
  $('#tourExit').onclick = tourStop;
  $('#flatBtn').onclick = toggleFlat;

  $('#motionBtn').onclick = function () {
    reduced = !reduced;
    document.body.classList.toggle('reduced', reduced);
    $('#motionBtn').classList.toggle('on', reduced);
    $('#motionBtn').textContent = reduced ? 'Motion reduced' : 'Reduce motion';
    toast(reduced ? 'Motion reduced — transitions are instant.' : 'Motion restored.');
  };

  $('#fsBtn').onclick = function () {
    if (!document.fullscreenElement) {
      (document.documentElement.requestFullscreen || function () { toast('Full screen is not available in this browser.'); }).call(document.documentElement);
    } else document.exitFullscreen();
  };

  var si = $('#search');
  si.addEventListener('input', function () { runSearch(si.value); });
  si.addEventListener('keydown', function (e) {
    var items = Array.prototype.slice.call($('#results').querySelectorAll('.res'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      items.forEach(function (x) { x.classList.remove('sel'); });
      selIdx = (selIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[selIdx].classList.add('sel');
      items[selIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      if (items.length) (items[selIdx >= 0 ? selIdx : 0]).click();
    } else if (e.key === 'Escape') { si.value = ''; runSearch(''); si.blur(); }
  });
  document.addEventListener('click', function (e) {
    if (!$('#searchWrap').contains(e.target)) $('#results').classList.remove('show');
  });

  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT') return;
    switch (e.key) {
      case 'Escape':
        if (flat2d) toggleFlat();
        else if (tour.on) tourStop();
        else if ($('#panel').classList.contains('open')) closePanel();
        else reset();
        break;
      case 'Backspace': e.preventDefault(); goBack(); break;
      case '0': reset(); break;
      case 't': case 'T': tour.on ? tourStop() : tourStart(); break;
      case 'f': case 'F': toggleFlat(); break;
      case 'm': case 'M': $('#motionBtn').click(); break;
      case '/': e.preventDefault(); $('#search').focus(); break;
      case 'ArrowRight': if (tour.on) tourNext(); break;
      case 'ArrowLeft': if (tour.on) tourPrev(); break;
      case '?': toast('Keys — 0 reset · Backspace back · T tour · F 2D view · M motion · / search · Esc close'); break;
      default: break;
    }
  });
}

/* ── boot ──────────────────────────────────────────────────────────────── */

var STEPS = [
  'Reading the module inventory…',
  'Indexing database technologies…',
  'Mapping the PostgreSQL dashboard…',
  'Loading cloud provider coverage…',
  'Building the platform scene…',
];

function boot() {
  if (!D) { document.getElementById('ldStep').textContent = 'Content failed to load — actmon-data.js is missing.'; return; }
  buildIndex();
  renderLegend();
  wire();
  if (reduced) {
    document.body.classList.add('reduced');
    $('#motionBtn').classList.add('on');
    $('#motionBtn').textContent = 'Motion reduced';
  }

  var i = 0;
  var iv = setInterval(function () {
    $('#ldFill').style.width = ((i + 1) / STEPS.length * 100) + '%';
    $('#ldStep').textContent = STEPS[i];
    i++;
    if (i >= STEPS.length) {
      clearInterval(iv);
      setTimeout(finish, 260);
    }
  }, reduced ? 60 : 260);
}

function finish() {
  if (THREE_OK) {
    try {
      initScene();
      tick();
    } catch (err) {
      // A machine with WebGL disabled must still get the whole document.
      THREE_OK = false;
      toast('3D could not start — showing the 2D view instead.');
    }
  }
  if (!THREE_OK) {
    flat2d = true;
    $('#flat').classList.add('show');
    $('#flatBtn').classList.add('on');
    $('#stage').style.display = 'none';
  }
  render();
  $('#loader').classList.add('gone');
  setTimeout(function () { $('#loader').style.display = 'none'; }, 700);
  if (!THREE_OK) toast('WebGL is unavailable — the full content is here in 2D.');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
