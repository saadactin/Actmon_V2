/* ===========================================================================
   KOEL Architecture Explorer — application.

   Structurally identical to ACTMON's explorer (actmon-app.js): a level stack
   with history, one 3D environment per level, select-then-enter, a side panel
   for detail, cinematic tour, search, 2D fallback and the same keyboard map.

   What differs is what the levels ARE, and what the panel is allowed to claim.
   ACTMON's panels were written from a codebase, so they state facts. This one
   has a single source — the draw.io diagram — so every statement carries a
   provenance chip saying whether it is on the diagram, implied by it, general
   product knowledge, or an open question. That chip is the equivalent of
   ACTMON's implemented/partial/not-implemented status, and it occupies the
   same place in the legend and the panel.
   =========================================================================== */
(function () {
'use strict';

var D = window.KOEL;
var KS = window.KScene;
var ENV = window.KEnvs;
var HAS3D = typeof THREE !== 'undefined' && !!KS && !!ENV;
var GS = typeof gsap !== 'undefined' ? gsap : null;

/* ── state ─────────────────────────────────────────────────────────────── */

var stack = [{ type: 'overview' }];
var future = [];
var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
var flat2d = false;
var selected = null;
var tour = { on: false, i: 0, playing: false, timer: null };

var $ = function (s) { return document.querySelector(s); };
var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
function el(t, c, h) { var n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
var toastT;
function toast(msg) {
  var t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 3400);
}
function byId(arr, id) { for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i]; return null; }
function hex(n) { var h = (n == null ? 0x35c3f3 : n).toString(16); while (h.length < 6) h = '0' + h; return '#' + h; }

/** The provenance chip — this document's equivalent of a status badge. */
function provChip(key) {
  var c = D.CLASS[key];
  if (!c) return '';
  return '<span class="chip ' + c.cls + '">' + esc(c.label) + '</span>';
}


/* ── 3D runtime ────────────────────────────────────────────────────────── */

var renderer, scene, camera, camCtl, labels, raycaster, clock;
var world;
var ctx = null;
var currentEnvKey = null;
var currentEnvLevel = null;
var hovered = null;
var pointerNdc = null;
var drag = { on: false, x: 0, y: 0, moved: 0, pan: false };

function init3D() {
  var canvas = $('#canvas');
  renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x04060d, 1);

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x04060d, 0.0034);

  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.5, 2000);
  camCtl = new KS.Camera(camera);
  raycaster = new THREE.Raycaster();
  pointerNdc = new THREE.Vector2(-2, -2);
  clock = new THREE.Clock();
  labels = new KS.Labels($('#labels'));

  scene.add(new THREE.AmbientLight(0x22406e, 1.65));
  var key = new THREE.DirectionalLight(0xa8dcff, 1.05); key.position.set(40, 80, 40); scene.add(key);
  var rim = new THREE.DirectionalLight(0xf0a07c, 0.58); rim.position.set(-60, -20, -40); scene.add(rim);
  var fill = new THREE.PointLight(0x35c3f3, 1.7, 420); fill.position.set(0, 20, 0); scene.add(fill);

  starfield();
  world = new THREE.Group(); scene.add(world);
  frameForPanel();

  window.addEventListener('resize', onResize);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointerup', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerleave', function () { if (pointerNdc) pointerNdc.set(-2, -2); });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
}

function starfield() {
  var n = 1400, pos = new Float32Array(n * 3);
  for (var i = 0; i < n; i++) {
    var r = 460 + Math.random() * 560;
    var th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    pos[i * 3 + 1] = r * Math.cos(ph) * 0.55;
    pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
  }
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({
    color: 0x89b4e0, size: 1.5, sizeAttenuation: true, transparent: true, opacity: 0.45, depthWrite: false,
  })));
}

function onResize() {
  if (!renderer) return;
  renderer.setSize(window.innerWidth, window.innerHeight);
  frameForPanel();
}

/** The side panel covers the right third of the window, so a scene centred on
    the origin loses whatever sits on that side — which is exactly what hid the
    OCI platform at the estate level.

    Rather than skew every environment's coordinates to dodge it, shift the
    camera's optical centre: render the window as a sub-rectangle of a wider
    virtual frame, offset by the panel's width. The scene then centres in the
    space the reader can actually see, and because the offset lives in the
    projection matrix, picking and label placement follow it for free. */
function frameForPanel() {
  if (!camera || !renderer) return;
  var W = window.innerWidth, H = Math.max(1, window.innerHeight);
  var panel = $('#panel');
  var shift = 0;
  if (panel && panel.classList.contains('open') && W > 820) {
    var box = panel.getBoundingClientRect();
    shift = Math.max(0, Math.min(W * 0.5, box.width || 0));
  }
  if (shift > 8) {
    camera.aspect = (W + shift) / H;
    camera.setViewOffset(W + shift, H, shift, 0, W, H);
  } else {
    if (camera.clearViewOffset) camera.clearViewOffset();
    camera.aspect = W / H;
  }
  camera.updateProjectionMatrix();
}
function onWheel(e) { e.preventDefault(); camCtl.zoom(e.deltaY * 0.0012); }
function onDown(e) {
  drag.on = true; drag.moved = 0; drag.x = e.clientX; drag.y = e.clientY;
  drag.pan = e.button === 2 || e.shiftKey;
  $('#canvas').style.cursor = 'grabbing';
}
function onMove(e) {
  if (!pointerNdc || !renderer) return;
  var r = renderer.domElement.getBoundingClientRect();
  pointerNdc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  pointerNdc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  if (drag.on) {
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    if (drag.pan) camCtl.pan(dx, dy);
    else camCtl.nudge(dx * 0.0052, dy * 0.0042);
    drag.x = e.clientX; drag.y = e.clientY;
  }
}
function onUp() {
  if (drag.on && drag.moved < 6) pickAtPointer();
  drag.on = false;
  if (renderer) $('#canvas').style.cursor = hovered ? 'pointer' : 'grab';
}
function pickAtPointer() {
  if (!ctx || !ctx.picks.length) return;
  raycaster.setFromCamera(pointerNdc, camera);
  var hit = raycaster.intersectObjects(ctx.picks, false)[0];
  if (hit) selectNode(hit.object.userData.node, hit.object);
  else { selected = null; renderPanel(); }
}

/* ── environment lifecycle ─────────────────────────────────────────────── */

function envKeyFor(level) {
  if (!level) return null;
  if (level.type === 'overview') return 'estate';
  if (level.type === 'zone') return ENV.ZONE_ENVS[level.id] || null;
  if (level.type === 'stack') return 'siebel';
  if (level.type === 'flows') return 'flows';
  return null;                                // topics borrow their ancestor
}

/** Levels with no environment of their own borrow the nearest ancestor that
    has one, so the camera never lands somewhere meaningless. */
function resolveEnv() {
  for (var i = stack.length - 1; i >= 0; i--) {
    var k = envKeyFor(stack[i]);
    if (k) return { key: k, level: stack[i] };
  }
  return { key: 'estate', level: { type: 'overview' } };
}

function buildEnv(key, level, opts) {
  opts = opts || {};
  if (ctx) { labels.clear(); KS.disposeGroup(world); }
  ctx = { group: world, data: D, labels: labels, level: level,
    picks: [], flows: [], spinners: [], pulsers: [] };
  var builder = ENV[key] || ENV.estate;
  var desc = builder(ctx);
  ctx.desc = desc;
  currentEnvKey = key;
  currentEnvLevel = level;
  selected = null;
  hovered = null;

  if (desc.limits) camCtl.setLimits(desc.limits[0], desc.limits[1]);
  if (scene.fog && desc.fog != null) {
    if (GS && !reduced && !opts.instant) GS.to(scene.fog, { density: desc.fog, duration: 1.1, overwrite: true });
    else scene.fog.density = desc.fog;
  }
  camCtl.travel(desc.pose, { instant: opts.instant || reduced, duration: 1.45, arc: true });

  $('#envTitle').textContent = desc.title || '';
  $('#envSub').textContent = desc.subtitle || '';
  $('#envBar').classList.add('show');
  return desc;
}

/** Fly to a node, then descend — the camera leads the level change so the
    transition reads as travel rather than a cut. */
function flyInto(node, then) {
  if (!HAS3D || !node || !node.focus || reduced || !GS || !camCtl) { then(); return; }
  var f = node.focus;
  var az = Math.atan2(f.z, f.x);
  if (!isFinite(az)) az = camCtl.dest.az;
  camCtl.travel(
    { az: az - 0.5, el: 0.26, dist: Math.max(camCtl.limits.min, 22), tx: f.x, ty: f.y, tz: f.z },
    { duration: 1.0, onDone: then }
  );
}

/* ── render loop ───────────────────────────────────────────────────────── */

function tick() {
  requestAnimationFrame(tick);
  if (!renderer) return;
  var dt = Math.min(0.05, clock.getDelta());
  var t = clock.elapsedTime;

  camCtl.step(dt, reduced);

  if (ctx && !reduced) {
    for (var i = 0; i < ctx.spinners.length; i++) ctx.spinners[i].obj.rotation.y += dt * ctx.spinners[i].speed;
    for (var p = 0; p < ctx.pulsers.length; p++) {
      var u = ctx.pulsers[p];
      var s = u.base + Math.sin(t * u.rate) * u.amt;
      u.obj.scale.set(s, s, s);
    }
    if (ctx.flows.length) KS.stepFlows(ctx.flows, t);
  }

  if (ctx && ctx.picks.length && pointerNdc) {
    raycaster.setFromCamera(pointerNdc, camera);
    var hit = raycaster.intersectObjects(ctx.picks, false)[0];
    var h = hit ? hit.object : null;
    if (h !== hovered) {
      hovered = h;
      if (!drag.on) $('#canvas').style.cursor = h ? 'pointer' : 'grab';
      renderProximity();
    }
  }

  if (labels && ctx) {
    labels.update(camCtl, camera, renderer,
      hovered ? hovered.userData.group : null,
      selected && selected.obj ? selected.obj.userData.group : null,
      ctx.picks, raycaster);
  }

  renderer.render(scene, camera);
}

function renderProximity() {
  var box = $('#prox');
  if (!hovered) { box.classList.remove('show'); return; }
  var n = hovered.userData.node;
  box.innerHTML = '<b>' + esc(n.label || '') + '</b><span>' + esc(kindLabel(n.kind)) + '</span>';
  box.classList.add('show');
}

function kindLabel(k) {
  return {
    zone: 'Zone', feed: 'Third-party feed', onprem: 'On-premises component',
    oci: 'OCI component', siebel: 'Siebel tier', flow: 'Connection',
  }[k] || 'Object';
}

/* ── navigation ────────────────────────────────────────────────────────── */

function go(level, fromHistory) {
  if (!fromHistory) future = [];
  stack.push(level);
  render();
}
function backTo(depth) { while (stack.length > depth + 1) future.unshift(stack.pop()); selected = null; render(); }
function goBack() { if (stack.length <= 1) return; future.unshift(stack.pop()); selected = null; render(); }
function goForward() { if (!future.length) return; stack.push(future.shift()); selected = null; render(); }
function reset() { stack = [{ type: 'overview' }]; future = []; selected = null; closePanel(); render(); }
function current() { return stack[stack.length - 1]; }

var LEVEL_NAMES = ['Estate', 'Zone', 'Stack', 'Detail', 'Detail'];

function render() {
  if (HAS3D && world) {
    var r = resolveEnv();
    if (r.key !== currentEnvKey || r.level !== currentEnvLevel) {
      try {
        buildEnv(r.key, r.level);
      } catch (e) {
        // One bad environment must not end the session. Report it, fall back
        // to the estate, and only give up on 3D if even that fails.
        if (window.console && console.warn) console.warn('[koel] environment "' + r.key + '" failed:', e);
        try {
          buildEnv('estate', { type: 'overview' });
          toast('That level could not be drawn — showing the estate instead.');
        } catch (e2) {
          HAS3D = false;
          $('#stage').style.display = 'none';
          $('#envBar').style.display = 'none';
        }
      }
    }
  }
  renderCrumbs();
  $('#lvl').textContent = 'Level ' + (stack.length - 1) + ' · ' + (LEVEL_NAMES[Math.min(stack.length - 1, 4)]);
  $('#back').disabled = stack.length <= 1;
  $('#fwd').disabled = future.length === 0;
  renderPanel();
  if (flat2d) renderFlat();
}

var TOPICS = {
  observations: { title: 'What the diagram tells you', sub: 'Read from the picture itself' },
  questions: { title: 'What the diagram does not say', sub: 'Eight gaps, and who could close them' },
  monitoring: { title: 'Where monitoring would go', sub: 'A proposal, not a finding' },
  provenance: { title: 'How to read this document', sub: 'One source, and four labels' },
};

function titleOf(l) {
  if (l.type === 'overview') return 'Estate';
  if (l.type === 'zone') { var z = byId(D.ZONES, l.id); return z ? z.label : l.id; }
  if (l.type === 'stack') return 'Siebel Cloud CRM Stack';
  if (l.type === 'flows') return 'Data flows';
  if (l.type === 'topic') return (TOPICS[l.id] || {}).title || l.id;
  return l.label || l.id || '—';
}

function renderCrumbs() {
  var c = $('#crumbs'); c.innerHTML = '';
  stack.forEach(function (l, i) {
    if (i > 0) c.appendChild(el('span', 'crumb-sep', '›'));
    var b = el('button', 'crumb', esc(titleOf(l)));
    if (i === stack.length - 1) b.setAttribute('aria-current', 'page');
    b.onclick = function () { backTo(i); };
    c.appendChild(b);
  });
}

/** Clicking selects and opens the panel. Descending is a separate, explicit
    act, so a reader can inspect without being teleported. */
function selectNode(node, obj) {
  selected = { node: node, obj: obj };
  if (HAS3D && node.focus && !reduced && camCtl) {
    camCtl.travel({
      tx: node.focus.x, ty: node.focus.y, tz: node.focus.z,
      dist: Math.max(camCtl.limits.min, camCtl.dest.dist * 0.8),
    }, { duration: 0.8 });
  }
  renderPanel();
  renderProximity();
}

function enterNode(node) {
  var next = childLevelFor(node);
  if (!next) { toast('This object has no deeper level — its detail is in the panel.'); return; }
  flyInto(node, function () { go(next); });
}

function childLevelFor(node) {
  if (!node) return null;
  if (node.kind === 'zone') return { type: 'zone', id: node.id };
  // The Siebel tiers are drawn inside the OCI private subnet; entering one
  // opens the stack's own level, which is where the per-tier counts live.
  if (node.kind === 'oci' && String(node.id).indexOf('siebel') === 0) return { type: 'stack', id: 'siebel' };
  return null;
}

/* ── panels ────────────────────────────────────────────────────────────── */

var frameT;
function reframe() {
  clearTimeout(frameT);
  frameT = setTimeout(frameForPanel, reduced ? 20 : 520);   // after the slide
}
function closePanel() { $('#panel').classList.remove('open'); reframe(); }
function openPanel() { $('#panel').classList.add('open'); reframe(); }

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
    b.innerHTML = '<span class="swatch" style="background:' + hex(it.color) + '"></span>'
      + '<span class="nb-txt"><b>' + esc(it.label) + '</b>'
      + (it.sub ? '<small>' + esc(it.sub) + '</small>' : '') + '</span>'
      + '<span class="arrow">›</span>';
    b.onclick = function () { onPick(it); };
    w.appendChild(b);
  });
  return w;
}
function facts(rows) {
  var dl = el('dl', 'kv');
  rows.forEach(function (r) {
    dl.appendChild(el('dt', null, esc(r[0])));
    dl.appendChild(el('dd', r[2] ? 'v-' + r[2] : null, esc(r[1])));
  });
  return dl;
}
function tiles(rows) {
  var w = el('div', 'tiles');
  rows.forEach(function (r) {
    var d = el('div', 'tile');
    d.innerHTML = '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>';
    w.appendChild(d);
  });
  return w;
}
function enterBtn(node) {
  var next = childLevelFor(node);
  if (!next) return null;
  var b = el('button', 'btn primary wide');
  b.innerHTML = 'Enter ' + esc(node.label || titleOf(next)) + ' <span class="arrow">›</span>';
  b.onclick = function () { enterNode(node); };
  return b;
}

function renderPanel() {
  var lv = current();
  var body = $('#pBody'); body.innerHTML = '';
  var head = { k: '', t: '', s: '' };

  if (selected && selected.node) head = renderNodePanel(body, selected.node);
  else if (lv.type === 'overview') head = renderOverviewPanel(body);
  else if (lv.type === 'zone') head = renderZonePanel(body, byId(D.ZONES, lv.id));
  else if (lv.type === 'stack') head = renderStackPanel(body);
  else if (lv.type === 'flows') head = renderFlowsPanel(body);
  else if (lv.type === 'topic') head = renderTopicPanel(body, lv.id);

  $('#pKicker').textContent = head.k;
  $('#pTitle').textContent = head.t;
  $('#pSub').textContent = head.s || '';
  openPanel();
  body.scrollTop = 0;
}

/* ── panel: a selected 3D object ───────────────────────────────────────── */

function renderNodePanel(body, n) {
  var d = n.data || {};

  if (n.kind === 'feed') {
    var kind = D.FEED_KINDS[d.kind] || {};
    body.appendChild(sec(null, '<div class="chips">' + provChip('diagram')
      + '<span class="chip info">' + esc(d.p) + '</span></div>'));
    body.appendChild(sec('What the diagram says', '<p>One of the eighteen external feeds. The diagram gives '
      + 'its name and its protocol, and draws it into the Integration Server’s SFTP mount point.</p>'));
    body.appendChild(sec('Facts', facts([
      ['Name on the diagram', d.n],
      ['Protocol', d.p],
      ['Category', kind.label || '—'],
      ['Terminates at', 'Integration Server — SFTP Mount Point'],
    ])));
    if (kind.note) body.appendChild(sec('About this category', '<p>' + esc(kind.note) + '</p>'));
    body.appendChild(sec(null, '<div class="note warn"><b>Not answered by the diagram.</b> What this feed '
      + 'carries, how often it arrives, and what happens downstream of the integration server.</div>'));
    return { k: 'Third-party feed', t: d.n, s: d.p + ' · ' + (kind.label || '') };
  }

  if (n.kind === 'flow') {
    body.appendChild(sec(null, '<div class="chips">' + provChip(d.cls)
      + '<span class="chip ' + (d.dir === 'bidirectional' ? 'info' : '') + '">' + esc(d.dir) + '</span>'
      + (d.critical ? '<span class="chip bad">no alternative path drawn</span>' : '') + '</div>'));
    body.appendChild(sec('What it is', '<p>' + esc(d.what) + '</p>'));
    body.appendChild(sec('Why it matters', '<p>' + esc(d.why) + '</p>'));
    body.appendChild(sec('Endpoints', facts([
      ['From', d.from], ['To', d.to], ['Direction', d.dir],
    ])));
    if (d.note) body.appendChild(sec('Worth knowing', '<div class="note warn">' + esc(d.note) + '</div>'));
    if (d.critical) body.appendChild(sec(null, '<div class="note bad"><b>Single path.</b> The diagram draws '
      + 'nothing that takes over if this connection stops.</div>'));
    return { k: 'Connection', t: d.label, s: d.from + ' → ' + d.to };
  }

  // Zones and components share one shape, so the reader learns it once.
  var chips = provChip(d.cls);
  if (d.critical) chips += '<span class="chip bad">single point of failure</span>';
  if (d.count) chips += '<span class="chip">' + d.count + ' on the diagram</span>';
  body.appendChild(sec(null, '<div class="chips">' + chips + '</div>'));

  body.appendChild(sec('What it is', '<p>' + esc(d.what) + '</p>'));
  if (d.why) body.appendChild(sec('Why it matters', '<p>' + esc(d.why) + '</p>'));
  if (d.diagramLabel) {
    body.appendChild(sec('Label on the diagram',
      '<pre class="code">' + esc(d.diagramLabel) + '</pre>'));
  }
  if (d.sub) body.appendChild(sec('Sub-label on the diagram', '<p class="dim">' + esc(d.sub) + '</p>'));
  if (d.nodes) {
    body.appendChild(sec('Nodes named', '<div class="chips">'
      + d.nodes.map(function (x) { return '<span class="chip info">' + esc(x) + '</span>'; }).join('') + '</div>'));
  }
  if (d.critical) body.appendChild(sec('Single point of failure', '<div class="note bad">' + esc(d.critical) + '</div>'));
  if (d.note) body.appendChild(sec('Worth knowing', '<div class="note warn">' + esc(d.note) + '</div>'));
  if (d.contextNote) {
    body.appendChild(sec('Where this comes from',
      '<div class="note"><b>' + esc(D.CLASS.context.label) + '.</b> ' + esc(d.contextNote) + '</div>'));
  }
  if (d.unknown) {
    body.appendChild(sec('Not answered by the diagram',
      '<ul class="list">' + d.unknown.map(function (u) { return '<li>' + esc(u) + '</li>'; }).join('') + '</ul>'));
  }

  // Connections this component takes part in, read straight from the edges.
  var touching = D.FLOWS.filter(function (f) {
    var name = (d.label || '').replace(/^\d+x\s*/, '');
    return (f.from + ' ' + f.to).indexOf(name) >= 0;
  });
  if (touching.length) {
    body.appendChild(sec('Connections drawn to it', navList(touching.map(function (f) {
      return { label: f.label, sub: f.from + ' → ' + f.to, color: f.critical ? 0xff6b7f : 0x35c3f3, flow: f };
    }), function (it) { stack = [{ type: 'overview' }, { type: 'flows' }]; future = []; selected = null; render(); })));
  } else if (n.kind !== 'zone') {
    body.appendChild(sec('Connections drawn to it',
      '<div class="note warn">None. This component has no edges in the diagram, so what depends on it — '
      + 'and what it depends on — is unknown from this source.</div>'));
  }

  var eb = enterBtn(n);
  if (eb) body.appendChild(sec(null, eb));

  return { k: kindLabel(n.kind), t: d.label || n.label, s: d.sub || '' };
}

/* ── panel: levels ─────────────────────────────────────────────────────── */

function renderOverviewPanel(body) {
  var siebelTotal = D.SIEBEL.reduce(function (a, c) { return a + (c.count || 1); }, 0);

  body.appendChild(sec(null, '<div class="note warn"><b>One source, and it matters.</b> '
    + esc(D.META.disclaimer) + '</div>'));

  body.appendChild(sec('About the globe', '<p>The Earth is a setting, not a map. The diagram names no '
    + 'country, region or data-centre site anywhere, so nothing here should be read as a location — the '
    + 'platforms are placed left to right in the order data travels, and that is all the arrangement means.</p>'));

  body.appendChild(sec('Reading the picture', '<p>Three platforms, left to right: who sends the data, where '
    + 'it lands, and where it runs. Every connection between them carries its name and an arrowhead — one '
    + 'head where the diagram draws one direction, two where it draws both.</p>'));

  body.appendChild(sec('The estate in numbers', tiles([
    ['Zones', '3'],
    ['External feeds', String(D.FEEDS.length)],
    ['On-premises', String(D.ONPREM.length)],
    ['OCI components', String(D.PUBLIC_SUBNET.length + D.PRIVATE_SUBNET.length)],
    ['Siebel servers', String(siebelTotal)],
    ['Connections', String(D.FLOWS.length)],
  ])));

  body.appendChild(sec('Enter a zone', navList(D.ZONES.map(function (z) {
    return { label: z.label, sub: z.what, color: z.color, go: { type: 'zone', id: z.id } };
  }), function (it) { go(it.go); })));

  body.appendChild(sec('Or go straight to', navList([
    { label: 'Siebel Cloud CRM Stack', sub: siebelTotal + ' servers across ' + D.SIEBEL.length + ' tiers', color: 0xd97706, go: { type: 'stack', id: 'siebel' } },
    { label: 'Data flows', sub: 'The eight connections the diagram draws', color: 0x35c3f3, go: { type: 'flows' } },
    { label: TOPICS.observations.title, sub: D.OBSERVATIONS.length + ' things the picture states plainly', color: 0xf2b23c, go: { type: 'topic', id: 'observations' } },
    { label: TOPICS.questions.title, sub: D.OPEN_QUESTIONS.length + ' gaps worth closing', color: 0x8496b3, go: { type: 'topic', id: 'questions' } },
    { label: TOPICS.monitoring.title, sub: 'A proposal, clearly marked as one', color: 0x2fd6a6, go: { type: 'topic', id: 'monitoring' } },
    { label: TOPICS.provenance.title, sub: 'What the four labels mean', color: 0x7cd6f0, go: { type: 'topic', id: 'provenance' } },
  ], function (it) { go(it.go); })));

  return { k: 'Estate', t: D.META.title, s: D.META.subtitle };
}

function renderZonePanel(body, z) {
  if (!z) return { k: '', t: '—', s: '' };
  body.appendChild(sec(null, '<div class="chips">' + provChip(z.cls) + '</div>'));
  body.appendChild(sec('What it is', '<p>' + esc(z.what) + '</p>'));
  body.appendChild(sec('Why it matters', '<p>' + esc(z.why) + '</p>'));
  body.appendChild(sec('Label on the diagram', '<pre class="code">' + esc(z.diagramLabel) + '</pre>'));

  if (z.id === 'thirdparty') {
    var byKind = {};
    D.FEEDS.forEach(function (f) { (byKind[f.kind] = byKind[f.kind] || []).push(f); });
    body.appendChild(sec('By category', facts(Object.keys(byKind).map(function (k) {
      return [D.FEED_KINDS[k].label, String(byKind[k].length)];
    }))));
    var protos = {};
    D.FEEDS.forEach(function (f) { protos[f.p] = (protos[f.p] || 0) + 1; });
    body.appendChild(sec('By protocol', facts(Object.keys(protos).map(function (k) { return [k, String(protos[k])]; }))));
    body.appendChild(sec(null, '<div class="note"><b>Five transport shapes in one hub.</b> A webhook is pushed '
      + 'to you; an SFTP drop is waited for; an HTTP/s call is made by you. They fail in different ways — a '
      + 'webhook that stops arriving looks exactly like a quiet day unless something watches for the silence.</div>'));
    body.appendChild(sec(null, '<div class="note warn"><b>Two vendors appear twice.</b> Taxilla arrives both '
      + 'over HTTP/s and as an SFTP portal; Locus arrives directly and again behind MRC Dispatch. Counting '
      + 'vendors rather than feeds gives sixteen, not eighteen.</div>'));
    body.appendChild(sec('Click any feed in the scene for its detail', ''));
  } else if (z.id === 'onprem') {
    body.appendChild(sec('Components', facts(D.ONPREM.map(function (c) {
      return [c.label, c.sub || '—', c.critical ? 'bad' : null];
    }))));
    body.appendChild(sec(null, '<div class="note warn">A dashed ring in the scene marks a component with no '
      + 'edges drawn to it. That is information, not an omission: the diagram does not say what uses it.</div>'));
  } else {
    body.appendChild(sec('Public subnet — DMZ edge', facts(D.PUBLIC_SUBNET.map(function (c) { return [c.label, c.sub || '—']; }))));
    body.appendChild(sec('Private subnet — application & data', facts(D.PRIVATE_SUBNET.map(function (c) {
      return [c.label, c.sub || '—', c.critical ? 'bad' : null];
    }))));
    body.appendChild(sec(null, navList([{ label: 'Siebel Cloud CRM Stack',
      sub: 'Drawn as a block inside the private subnet', color: 0xd97706 }],
      function () { go({ type: 'stack', id: 'siebel' }); })));
  }
  return { k: 'Zone', t: z.label, s: z.what };
}

function renderStackPanel(body) {
  var total = D.SIEBEL.reduce(function (a, c) { return a + (c.count || 1); }, 0);
  body.appendChild(sec(null, '<div class="chips">' + provChip('diagram')
    + '<span class="chip">' + total + ' servers</span></div>'));
  body.appendChild(sec('What it is', '<p>The Siebel deployment, drawn as a block of its own inside the OCI '
    + 'private subnet. It is the most heavily replicated part of the estate, and it keeps its own database '
    + 'rather than sharing the ERP’s.</p>'));
  body.appendChild(sec('Tiers', facts(D.SIEBEL.map(function (c) {
    return [c.label.replace(/^\d+x\s*/, ''), String(c.count)];
  }))));
  body.appendChild(sec(null, '<div class="note warn">Every Siebel tier is at least doubled. Set against the '
    + 'ERP application tier’s single compute node next door, that is the diagram’s sharpest internal '
    + 'contrast — and the clearest question to put to whoever owns the infrastructure.</div>'));
  body.appendChild(sec(null, '<div class="note"><b>Two BI Publishers.</b> This stack has its own BIP server, '
    + 'and the ERP tier has another. Two report estates, two patch cycles, two sets of templates.</div>'));
  return { k: 'Stack', t: 'Siebel Cloud CRM Stack', s: total + ' servers across ' + D.SIEBEL.length + ' tiers' };
}

function renderFlowsPanel(body) {
  body.appendChild(sec(null, '<div class="chips">' + provChip('diagram') + '</div>'));
  body.appendChild(sec('What this level shows', '<p>Each of the eight edges in the diagram, as an object of '
    + 'its own. Two-headed arrows are the connections drawn bidirectional; a red one is a connection with no '
    + 'alternative path drawn beside it.</p>'));
  body.appendChild(sec('The connections', facts(D.FLOWS.map(function (f) {
    return [f.label, f.dir, f.critical ? 'bad' : (f.dir === 'bidirectional' ? 'info' : null)];
  }))));
  body.appendChild(sec(null, '<div class="note">Click any connection in the scene for its endpoints and what '
    + 'the diagram says it carries.</div>'));
  return { k: 'Connections', t: 'Data flows', s: D.FLOWS.length + ' edges, exactly as drawn' };
}

function renderTopicPanel(body, id) {
  var meta = TOPICS[id] || {};

  if (id === 'provenance') {
    body.appendChild(sec(null, '<div class="note warn"><b>One source.</b> ' + esc(D.META.disclaimer) + '</div>'));
    var meanings = {
      diagram: 'Literally in the file — a node, a label, or an edge.',
      implied: 'Follows necessarily from what is drawn. A feed whose only connection is to the integration '
             + 'server must reach the estate through it.',
      context: 'True of the named product in general. It describes Oracle ERP, Siebel or an HSM — not KOEL’s '
             + 'particular configuration of it.',
      unknown: 'A question the diagram does not answer, listed so it can be asked rather than guessed.',
    };
    Object.keys(D.CLASS).forEach(function (k) {
      body.appendChild(sec(null, '<div class="viagroup"><p class="via-h">' + provChip(k) + '</p>'
        + '<p class="via-d">' + esc(meanings[k]) + '</p></div>'));
    });
    body.appendChild(sec(null, '<div class="note">No IP address, hostname, credential or connection string '
      + 'appears anywhere in this document. None was available, and none was invented.</div>'));
    return { k: 'Reading guide', t: meta.title, s: meta.sub };
  }

  if (id === 'observations') {
    var order = { high: 0, medium: 1, low: 2 };
    D.OBSERVATIONS.slice().sort(function (a, b) { return order[a.sev] - order[b.sev]; }).forEach(function (ob) {
      var w = el('div', 'finding');
      w.innerHTML = '<div class="f-top"><b>' + esc(ob.title) + '</b>'
        + '<span class="chip ' + (ob.sev === 'high' ? 'bad' : ob.sev === 'medium' ? 'warn' : 'info') + '">' + esc(ob.sev) + '</span>'
        + provChip(ob.cls) + '</div>'
        + '<p class="f-act">' + esc(ob.detail) + '</p>'
        + '<p class="f-ev">Evidence: ' + esc(ob.evidence) + '</p>';
      body.appendChild(w);
    });
    body.appendChild(sec(null, '<div class="note"><b>Severity means how plainly the picture states it</b>, not '
      + 'an assessment of the running estate. A &ldquo;high&rdquo; entry may already be mitigated by something '
      + 'the picture does not show.</div>'));
    return { k: 'Observations', t: meta.title, s: meta.sub };
  }

  if (id === 'questions') {
    D.OPEN_QUESTIONS.forEach(function (q, i) {
      var w = el('div', 'wt-step');
      w.innerHTML = '<p class="wt-t">' + (i + 1) + '. ' + esc(q.q) + '</p>'
        + '<p class="wt-b">' + esc(q.why) + '</p>'
        + '<p class="f-to">Ask: ' + esc(q.ask) + '</p>';
      body.appendChild(w);
    });
    return { k: 'Open questions', t: meta.title, s: meta.sub };
  }

  // monitoring
  body.appendChild(sec(null, '<div class="note warn"><b>This section is a proposal.</b> Nothing below is '
    + 'stated by the diagram. It is what the drawn topology suggests is worth instrumenting, offered so it '
    + 'can be argued with.</div>'));
  [
    ['The integration server', 'All eighteen feeds land here and one bridge leaves it. Per-feed arrival '
      + 'freshness matters more than host health: a feed that stops arriving is invisible unless an expected '
      + 'interval is recorded for it.',
      'Per-feed last-seen time against an expected window; SFTP mount reachability; the bridge into the ERP.'],
    ['The VPN tunnel', 'One encrypted path joins the data centre to the cloud, with no second route drawn. '
      + 'Tunnel state is hybrid availability.',
      'Tunnel up/down, both gateway endpoints, round-trip latency across it.'],
    ['The ERP application tier', 'Drawn as a single compute node while everything around it is redundant. '
      + 'Here host-level metrics genuinely are service availability.',
      'Process liveness, CPU, memory and disk on the one node; the SFTP mount it depends on.'],
    ['Oracle ERP database (2-node RAC)', 'Redundant, so the question is cluster health rather than host health.',
      'Per-instance status, which node is serving, interconnect health, the App-DB connection itself.'],
    ['Siebel stack', 'Twelve servers across five tiers. Tier-level aggregation is more informative than twelve '
      + 'separate host alarms.',
      'Count of healthy members per tier; the dedicated database pair; the ERP cross-link.'],
    ['ODI and ADW', 'Batch, not request/response. A pipeline that silently stops produces stale answers rather '
      + 'than errors.',
      'ETL run completion and duration; warehouse load freshness; the Siebel sync.'],
  ].forEach(function (x) {
    var w = el('div', 'viagroup');
    w.innerHTML = '<p class="via-h">' + esc(x[0]) + '</p><p class="via-d">' + esc(x[1]) + '</p>'
      + '<div class="privrow"><code>Worth watching</code><span></span></div>'
      + '<p class="f-act">' + esc(x[2]) + '</p>';
    body.appendChild(w);
  });
  body.appendChild(sec(null, '<div class="note warn">Four components have no edges drawn — the SQL Server '
    + 'cluster, the PLM database, the HSM, and anything behind the public load balancer. They cannot be placed '
    + 'in a monitoring plan until the open questions are answered, because what matters about a system depends '
    + 'on what depends on it.</div>'));
  return { k: 'Proposal', t: meta.title, s: meta.sub };
}

/* ── search ────────────────────────────────────────────────────────────── */

var ALIASES = {
  thirdparty: 'feeds external bank tax sftp webhook http ingestion vendor integration',
  onprem: 'data centre datacenter on-premises internal ad firewall vpn sftp sql server discoverer plm legacy',
  oci: 'oracle cloud infrastructure vcn subnet erp rac apex bip hsm odi adw warehouse siebel',
  sftp: 'integration server mount point ingestion hub landing zone eighteen feeds',
  erp_app: 'application tier single compute node spof',
  erp_db: 'rac real application clusters dbcli database two node',
  adw: 'autonomous data warehouse analytics',
  odi: 'oracle data integrator etl pipeline',
  lgm: 'hsm hardware security module digital signature webtel signing keys',
  onprem_vpn: 'ipsec macsec tunnel encrypted backbone hybrid gateway',
  oci_vpn: 'drg dynamic routing gateway tunnel',
  lb: 'load balancer public dmz edge',
  firewall: 'edge security inspection rules',
  ad: 'active directory identity access manager authentication',
  plm: 'product lifecycle management cad engineering',
  discoverer: 'legacy bi reporting end of life',
  sqlserver: 'microsoft internal database high availability cluster',
};

var INDEX = [];
function buildIndex() {
  D.ZONES.forEach(function (z) {
    INDEX.push({ label: z.label, ctx: 'Zone', kw: z.what + ' ' + (ALIASES[z.id] || ''),
      go: { type: 'zone', id: z.id } });
  });
  D.FEEDS.forEach(function (f, i) {
    var kind = D.FEED_KINDS[f.kind] || {};
    INDEX.push({ label: f.n, ctx: 'Third-party feed · ' + f.p, kw: f.p + ' ' + (kind.label || ''),
      go: { type: 'zone', id: 'thirdparty' }, focusId: 'feed-' + i });
  });
  D.ONPREM.forEach(function (c) {
    INDEX.push({ label: c.label, ctx: 'On-premises', kw: (c.sub || '') + ' ' + c.what + ' ' + (ALIASES[c.id] || ''),
      go: { type: 'zone', id: 'onprem' }, focusId: c.id });
  });
  D.PUBLIC_SUBNET.concat(D.PRIVATE_SUBNET).forEach(function (c) {
    INDEX.push({ label: c.label, ctx: 'OCI', kw: (c.sub || '') + ' ' + c.what + ' ' + (ALIASES[c.id] || ''),
      go: { type: 'zone', id: 'oci' }, focusId: c.id });
  });
  D.SIEBEL.forEach(function (c) {
    INDEX.push({ label: c.label, ctx: 'Siebel tier', kw: c.what + ' siebel crm',
      go: { type: 'stack', id: 'siebel' }, focusId: c.id });
  });
  D.FLOWS.forEach(function (f) {
    INDEX.push({ label: f.label, ctx: 'Connection', kw: f.from + ' ' + f.to + ' ' + f.what,
      go: { type: 'flows' }, focusId: f.id });
  });
  Object.keys(TOPICS).forEach(function (k) {
    INDEX.push({ label: TOPICS[k].title, ctx: 'Reading', kw: TOPICS[k].sub, go: { type: 'topic', id: k } });
  });
  D.OPEN_QUESTIONS.forEach(function (q) {
    INDEX.push({ label: q.q, ctx: 'Open question', kw: q.why + ' ' + q.ask, go: { type: 'topic', id: 'questions' } });
  });
  D.OBSERVATIONS.forEach(function (o) {
    INDEX.push({ label: o.title, ctx: 'Observation', kw: o.detail, go: { type: 'topic', id: 'observations' } });
  });
}

var selIdx = -1;
function runSearch(q) {
  var box = $('#results');
  q = (q || '').trim().toLowerCase();
  if (!q) { box.classList.remove('show'); box.innerHTML = ''; return; }
  var words = q.split(/\s+/).filter(Boolean);
  var hits = INDEX.filter(function (r) {
    var hay = (r.label + ' ' + r.ctx + ' ' + (r.kw || '')).toLowerCase();
    return words.every(function (w) { return hay.indexOf(w) >= 0; });
  }).sort(function (a, b) {
    var al = a.label.toLowerCase().indexOf(q), bl = b.label.toLowerCase().indexOf(q);
    return (al < 0 ? 99 : al) - (bl < 0 ? 99 : bl);
  }).slice(0, 12);

  box.innerHTML = ''; selIdx = -1;
  if (!hits.length) {
    box.innerHTML = '<div class="res-none">Nothing matches &ldquo;' + esc(q) + '&rdquo;</div>';
    box.classList.add('show'); return;
  }
  hits.forEach(function (h, i) {
    var b = el('button', 'res', '<b>' + esc(h.label) + '</b><span>' + esc(h.ctx) + '</span>');
    b.onclick = function () { jump(h); };
    b.dataset.i = i;
    box.appendChild(b);
  });
  box.classList.add('show');
}

/** A hit navigates to the level that holds it and, where the hit names a
    specific object, selects that object so the panel opens on it directly. */
function jump(h) {
  stack = [{ type: 'overview' }];
  future = []; selected = null;
  if (h.go.type !== 'overview') stack.push(h.go);
  render();
  if (h.focusId && ctx) {
    for (var i = 0; i < ctx.picks.length; i++) {
      if (ctx.picks[i].userData.node.id === h.focusId) {
        selectNode(ctx.picks[i].userData.node, ctx.picks[i]);
        break;
      }
    }
  }
  $('#results').classList.remove('show');
  $('#search').value = ''; $('#search').blur();
}

/* ── cinematic tour ────────────────────────────────────────────────────── */

function atZone(id) { stack = [{ type: 'overview' }, { type: 'zone', id: id }]; future = []; }

/** Lets the tour select the first object of a kind in whatever the
    environment just built, without needing to know its internals. */
function selectFirst(matcher) {
  render();
  if (!ctx) return;
  for (var i = 0; i < ctx.picks.length; i++) {
    var n = ctx.picks[i].userData.node;
    if (matcher(n)) { selectNode(n, ctx.picks[i]); return; }
  }
}

var TOUR = [
  { t: 'The KOEL estate', b: 'Three zones: eighteen external systems on the left, KOEL’s own data centre in the middle, and the OCI region on the right. One encrypted tunnel joins the second to the third.', go: function () { stack = [{ type: 'overview' }]; future = []; } },
  { t: 'Eighteen feeds, one landing point', b: 'Every external system converges on a single integration server. Particle speed follows protocol — the webhook pushes in bursts, the SFTP drops crawl.', go: function () { atZone('thirdparty'); } },
  { t: 'Banking is the largest category', b: 'Six of the eighteen are banks, and they are the feeds with the least tolerance for a missed file.', go: function () { atZone('thirdparty'); selectFirst(function (n) { return n.kind === 'feed' && n.data && n.data.kind === 'bank'; }); } },
  { t: 'The on-premises data centre', b: 'Identity, edge security and the ingestion hub — plus two databases that never moved. A dashed ring marks a component with no edges drawn to it.', go: function () { atZone('onprem'); } },
  { t: 'The busiest junction on the diagram', b: 'Eighteen feeds in, one SFTP mount bridge out. Everything external enters the estate through this one component.', go: function () { atZone('onprem'); selectFirst(function (n) { return n.id === 'sftp'; }); } },
  { t: 'Into Oracle Cloud Infrastructure', b: 'One VCN: a public DMZ above, the private application and data tier below, and the Siebel stack as a block inside it.', go: function () { atZone('oci'); } },
  { t: 'The one component without redundancy', b: 'The ERP application tier is labelled "Single Compute Node" while the database beside it is 2-node RAC and every Siebel tier is doubled. The ring around it is the diagram’s own word, not an opinion.', go: function () { atZone('oci'); selectFirst(function (n) { return n.id === 'erp_app'; }); } },
  { t: 'The Siebel stack', b: 'Twelve servers across five tiers, with a dedicated database that the diagram links directly to the ERP’s. Database-to-database coupling between two packaged products is worth understanding carefully.', go: function () { stack = [{ type: 'overview' }, { type: 'zone', id: 'oci' }, { type: 'stack', id: 'siebel' }]; future = []; } },
  { t: 'The eight connections', b: 'Every edge as an object. Red means the diagram draws no alternative path — and on this picture, the hybrid tunnel is one of them.', go: function () { stack = [{ type: 'overview' }, { type: 'flows' }]; future = []; } },
  { t: 'What the diagram does not say', b: 'Eight questions this document cannot answer, each with who would know. Those gaps are the most useful thing here.', go: function () { stack = [{ type: 'overview' }, { type: 'topic', id: 'questions' }]; future = []; } },
];

function tourStart() {
  tour.on = true; tour.i = 0; tour.playing = true;
  $('#tour').classList.add('open');
  $('#tourBtn').classList.add('on');
  document.body.classList.add('touring');
  tourShow();
}
function tourStop() {
  tour.on = false; tour.playing = false;
  clearTimeout(tour.timer);
  $('#tour').classList.remove('open');
  $('#tourBtn').classList.remove('on');
  document.body.classList.remove('touring');
}
function tourShow() {
  var c = TOUR[tour.i];
  $('#tourN').textContent = 'Chapter ' + (tour.i + 1) + ' of ' + TOUR.length;
  $('#tourT').textContent = c.t;
  $('#tourB').textContent = c.b;
  $('#tourProg').style.width = (((tour.i + 1) / TOUR.length) * 100) + '%';
  $('#tourPrev').disabled = tour.i === 0;
  $('#tourNext').textContent = tour.i === TOUR.length - 1 ? 'Finish' : 'Next';
  $('#tourPause').textContent = tour.playing ? 'Pause' : 'Resume';
  future = []; selected = null;
  c.go();
  render();
  scheduleTour();
}
function scheduleTour() {
  clearTimeout(tour.timer);
  if (!tour.on || !tour.playing) return;
  tour.timer = setTimeout(function () {
    if (tour.i >= TOUR.length - 1) { tour.playing = false; $('#tourPause').textContent = 'Resume'; return; }
    tourNext();
  }, reduced ? 4200 : 9000);
}
function tourNext() {
  if (tour.i >= TOUR.length - 1) { tourStop(); toast('Tour finished — explore freely.'); return; }
  tour.i++; tourShow();
}
function tourPrev() { if (tour.i > 0) { tour.i--; tourShow(); } }
function tourToggle() {
  tour.playing = !tour.playing;
  $('#tourPause').textContent = tour.playing ? 'Pause' : 'Resume';
  if (tour.playing) scheduleTour(); else clearTimeout(tour.timer);
}

/* ── 2D fallback ───────────────────────────────────────────────────────── */

function flatGroup(b, title, items, onPick) {
  b.appendChild(el('p', 'flat-sec-h', esc(title)));
  var g = el('div', 'flat-grid');
  items.forEach(function (it) {
    var c = el('button', 'flat-card', '<b>' + esc(it.label) + '</b><p>' + esc(it.sub || '') + '</p>');
    c.onclick = function () { onPick(it); };
    g.appendChild(c);
  });
  b.appendChild(g);
}

function renderFlat() {
  var b = $('#flatBody'); b.innerHTML = '';
  b.appendChild(el('h2', 'flat-h', 'KOEL — full estate index'));
  b.appendChild(el('p', 'flat-s',
    'Every object in the 3D experience as a flat list. This is the accessible alternative: no WebGL, no '
    + 'pointer precision and no motion required. Selecting anything opens the same panel the 3D opens.'));

  flatGroup(b, 'Zones', D.ZONES.map(function (z) { return { label: z.label, sub: z.what, go: { type: 'zone', id: z.id } }; }),
    function (it) { stack = [{ type: 'overview' }, it.go]; future = []; selected = null; render(); });

  flatGroup(b, 'Third-party feeds (' + D.FEEDS.length + ')', D.FEEDS.map(function (f, i) {
    return { label: f.n, sub: f.p + ' · ' + (D.FEED_KINDS[f.kind] || {}).label, feed: f, i: i };
  }), function (it) {
    stack = [{ type: 'overview' }, { type: 'zone', id: 'thirdparty' }]; future = [];
    render();
    selected = { node: { kind: 'feed', id: 'feed-' + it.i, label: it.feed.n, data: it.feed } };
    renderPanel();
  });

  flatGroup(b, 'On-premises data centre', D.ONPREM.map(function (c) {
    return { label: c.label, sub: c.sub || c.what, c: c, kind: 'onprem' };
  }), flatPickComponent);

  flatGroup(b, 'OCI — public subnet', D.PUBLIC_SUBNET.map(function (c) {
    return { label: c.label, sub: c.sub || c.what, c: c, kind: 'oci' };
  }), flatPickComponent);

  flatGroup(b, 'OCI — private subnet', D.PRIVATE_SUBNET.map(function (c) {
    return { label: c.label, sub: c.sub || c.what, c: c, kind: 'oci' };
  }), flatPickComponent);

  flatGroup(b, 'Siebel Cloud CRM stack', D.SIEBEL.map(function (c) {
    return { label: c.label, sub: c.sub || c.what, c: c, kind: 'siebel' };
  }), flatPickComponent);

  flatGroup(b, 'Connections (' + D.FLOWS.length + ')', D.FLOWS.map(function (f) {
    return { label: f.label, sub: f.from + ' → ' + f.to, f: f };
  }), function (it) {
    stack = [{ type: 'overview' }, { type: 'flows' }]; future = [];
    render();
    selected = { node: { kind: 'flow', id: it.f.id, label: it.f.label, data: it.f } };
    renderPanel();
  });

  flatGroup(b, 'Reading the document', Object.keys(TOPICS).map(function (k) {
    return { label: TOPICS[k].title, sub: TOPICS[k].sub, go: { type: 'topic', id: k } };
  }), function (it) { stack = [{ type: 'overview' }, it.go]; future = []; selected = null; render(); });
}

function flatPickComponent(it) {
  var zone = it.kind === 'onprem' ? { type: 'zone', id: 'onprem' }
    : it.kind === 'siebel' ? { type: 'stack', id: 'siebel' } : { type: 'zone', id: 'oci' };
  stack = [{ type: 'overview' }, zone]; future = [];
  render();
  selected = { node: { kind: it.kind, id: it.c.id, label: it.c.label, data: it.c } };
  renderPanel();
}

function toggleFlat() {
  flat2d = !flat2d;
  $('#flat').classList.toggle('show', flat2d);
  $('#flatBtn').classList.toggle('on', flat2d);
  if (flat2d) { renderFlat(); closePanel(); } else openPanel();
}

/** The legend carries this document's status vocabulary: not implemented /
    partial, but how each claim is known. */
function renderLegend() {
  $('#legend').innerHTML = Object.keys(D.CLASS).map(function (k) { return provChip(k); }).join('');
}

/* ── wiring ────────────────────────────────────────────────────────────── */

function wire() {
  $('#home').onclick = reset;
  $('#reset').onclick = function () { reset(); toast('Back to the estate overview.'); };
  $('#back').onclick = goBack;
  $('#fwd').onclick = goForward;
  $('#pClose').onclick = closePanel;
  $('#tourBtn').onclick = function () { if (tour.on) tourStop(); else tourStart(); };
  $('#tourNext').onclick = function () { tour.playing = false; $('#tourPause').textContent = 'Resume'; clearTimeout(tour.timer); tourNext(); };
  $('#tourPrev').onclick = function () { tour.playing = false; $('#tourPause').textContent = 'Resume'; clearTimeout(tour.timer); tourPrev(); };
  $('#tourPause').onclick = tourToggle;
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
      if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
      else toast('Full screen is not available in this browser.');
    } else document.exitFullscreen();
  };

  var si = $('#search');
  si.addEventListener('input', function () { runSearch(si.value); });
  si.addEventListener('keydown', function (e) {
    var items = $$('#results .res');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      items.forEach(function (x) { x.classList.remove('sel'); });
      selIdx = (selIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[selIdx].classList.add('sel');
      items[selIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') { if (items.length) items[selIdx >= 0 ? selIdx : 0].click(); }
    else if (e.key === 'Escape') { si.value = ''; runSearch(''); si.blur(); }
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
        else if (selected) { selected = null; renderPanel(); }
        else if ($('#panel').classList.contains('open')) closePanel();
        else if (stack.length > 1) goBack();
        else reset();
        break;
      case 'Backspace': e.preventDefault(); goBack(); break;
      case 'Enter': if (selected) enterNode(selected.node); break;
      case '0': reset(); break;
      case 't': case 'T': if (tour.on) tourStop(); else tourStart(); break;
      case 'f': case 'F': toggleFlat(); break;
      case 'm': case 'M': $('#motionBtn').click(); break;
      case '/': e.preventDefault(); $('#search').focus(); break;
      case '+': case '=': if (camCtl) camCtl.zoom(-0.18); break;
      case '-': case '_': if (camCtl) camCtl.zoom(0.18); break;
      case 'ArrowRight': if (tour.on) tourNext(); else if (camCtl) camCtl.nudge(-0.22, 0); break;
      case 'ArrowLeft': if (tour.on) tourPrev(); else if (camCtl) camCtl.nudge(0.22, 0); break;
      case 'ArrowUp': if (camCtl) camCtl.nudge(0, -0.1); break;
      case 'ArrowDown': if (camCtl) camCtl.nudge(0, 0.1); break;
      case '?': toast('0 reset · Backspace back · Enter descend · T tour · F 2D · M motion · / search · arrows orbit · ± zoom'); break;
      default: break;
    }
  });
}

/* ── boot ──────────────────────────────────────────────────────────────── */

var STEPS = [
  'Reading the architecture diagram…', 'Indexing the third-party feeds…',
  'Mapping the on-premises data centre…', 'Laying out the OCI region…',
  'Composing the estate…',
];

function boot() {
  if (!D) { $('#ldStep').textContent = 'Content failed to load — koel-data.js is missing.'; return; }
  buildIndex(); renderLegend(); wire();
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
    if (i >= STEPS.length) { clearInterval(iv); setTimeout(finish, 240); }
  }, reduced ? 55 : 230);
}

function finish() {
  if (HAS3D) {
    try {
      init3D();
      tick();
    } catch (err) {
      // Report before degrading. A silent catch turns any startup fault into
      // "the 3D just doesn't work", with nothing to go on.
      if (window.console && console.warn) console.warn('[koel] 3D startup failed, using the 2D view:', err);
      HAS3D = false;
    }
  }
  if (!HAS3D) {
    flat2d = true;
    $('#flat').classList.add('show');
    $('#flatBtn').classList.add('on');
    $('#stage').style.display = 'none';
    $('#envBar').style.display = 'none';
  }
  render();
  $('#loader').classList.add('gone');
  setTimeout(function () { $('#loader').style.display = 'none'; }, 700);
  if (!HAS3D) toast('WebGL is unavailable — the full content is here in 2D.');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
