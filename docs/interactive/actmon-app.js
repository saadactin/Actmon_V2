/* ===========================================================================
   ACTMON Universe — application layer.

   Owns: the level stack, the environment lifecycle, contextual panels,
   search, the cinematic tour, the 2D fallback and keyboard access.

   It does NOT own the 3D substrate (actmon-scene.js) or the scene contents
   (actmon-envs.js). That split is what lets every level look genuinely
   different: adding an environment means adding one builder, not editing
   this file.

   Classic script so the document opens from file://. Nothing at module scope
   touches THREE — a blocked CDN must degrade to the 2D view, not to a blank
   page.
   =========================================================================== */
(function () {
'use strict';

var D = window.ACTMON;
var SM = window.ACTMON_SAMPLES;
var AS = window.AScene;
var ENV = window.AEnvs;
var HAS3D = typeof THREE !== 'undefined' && !!AS && !!ENV;
var GS = typeof gsap !== 'undefined' ? gsap : null;

/* ── state ─────────────────────────────────────────────────────────────── */

var stack = [{ type: 'overview' }];
var future = [];
var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
var flat2d = false;
var selected = null;                 // the node the reader last clicked
var tour = { on: false, i: 0, playing: false, timer: null };

var $ = function (s) { return document.querySelector(s); };
var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
function el(t, c, h) { var n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
var toastT;
function toast(msg) {
  var t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 2800);
}
function byId(arr, id) { for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i]; return null; }
function num(n) { return n == null ? '—' : Number(n).toLocaleString(); }

var STATUS = {
  implemented: { label: 'Implemented', cls: 'ok' },
  partial: { label: 'Partial', cls: 'warn' },
  'no-data': { label: 'No data source yet', cls: 'warn' },
  illustrative: { label: 'Illustrative', cls: 'info' },
  none: { label: 'Not implemented', cls: 'bad' },
};
function statusChip(s) { var m = STATUS[s] || STATUS.illustrative; return '<span class="chip ' + m.cls + '">' + m.label + '</span>'; }
function sampleChip() { return '<span class="chip info">' + esc(SM.SAMPLE_BANNER) + '</span>'; }

/* ── 3D runtime ────────────────────────────────────────────────────────── */

var renderer, scene, camera, camCtl, labels, raycaster, clock;
var world;                                  // the group every environment fills
var ctx = null;                             // current environment context
var currentEnvKey = null;
var currentEnvLevel = null;
var hovered = null;
var pointerNdc = null;
var drag = { on: false, x: 0, y: 0, moved: 0, pan: false };

function init3D() {
  var canvas = $('#canvas');
  renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: 'high-performance' });
  // Capped: a 3x buffer on a retina laptop is the easiest way to make this
  // unusable, for no visible gain at these geometry densities.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x04060d, 1);

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x04060d, 0.0042);

  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.5, 1600);
  camCtl = new AS.Camera(camera);
  raycaster = new THREE.Raycaster();
  pointerNdc = new THREE.Vector2(-2, -2);
  clock = new THREE.Clock();
  labels = new AS.Labels($('#labels'));

  scene.add(new THREE.AmbientLight(0x22406e, 1.65));
  var key = new THREE.DirectionalLight(0xa8dcff, 1.05); key.position.set(40, 70, 40); scene.add(key);
  var rim = new THREE.DirectionalLight(0x6f7cf7, 0.62); rim.position.set(-50, -20, -40); scene.add(rim);
  var fill = new THREE.PointLight(0x35c3f3, 1.9, 300); fill.position.set(0, 10, 0); scene.add(fill);

  starfield();
  world = new THREE.Group(); scene.add(world);

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
    var r = 420 + Math.random() * 540;
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
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
function onWheel(e) { e.preventDefault(); camCtl.zoom(e.deltaY * 0.0012); }
function onDown(e) {
  drag.on = true; drag.moved = 0; drag.x = e.clientX; drag.y = e.clientY;
  drag.pan = e.button === 2 || e.shiftKey;          // right-drag or shift-drag pans
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
  if (level.type === 'overview') return 'universe';
  if (level.type === 'module') return ENV.MODULE_ENVS[level.id] || null;
  if (level.type === 'engine') return level.id === 'postgresql' ? 'engine_postgresql' : null;
  if (level.type === 'feature') {
    if (level.kind !== 'pgtab') return null;
    return ENV.FEATURE_ENVS[level.id] || 'feat_generic';
  }
  if (level.type === 'record') return level.recordKind === 'query' ? 'detail_query' : 'detail_record';
  return null;
}

/** Levels with no environment of their own borrow the nearest ancestor that
    has one, so the camera never lands somewhere meaningless. */
function resolveEnv() {
  for (var i = stack.length - 1; i >= 0; i--) {
    var k = envKeyFor(stack[i]);
    if (k) return { key: k, level: stack[i] };
  }
  return { key: 'universe', level: { type: 'overview' } };
}

function buildEnv(key, level, opts) {
  opts = opts || {};
  if (ctx) { labels.clear(); AS.disposeGroup(world); }
  ctx = {
    group: world, data: D, samples: SM, labels: labels, level: level,
    picks: [], flows: [], spinners: [], pulsers: [], streams: [],
  };
  var builder = ENV[key] || ENV.universe;
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

/** Fly to a node, then descend. The camera leads the level change so the
    transition reads as travel rather than a cut. */
function flyInto(node, then) {
  if (!HAS3D || !node || !node.focus || reduced || !GS || !camCtl) { then(); return; }
  var f = node.focus;
  var az = Math.atan2(f.z, f.x);
  if (!isFinite(az)) az = camCtl.dest.az;
  camCtl.travel(
    { az: az - 0.5, el: 0.26, dist: Math.max(camCtl.limits.min, 20), tx: f.x, ty: f.y, tz: f.z },
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
    for (var s2 = 0; s2 < ctx.streams.length; s2++) {
      var st = ctx.streams[s2], pos = st.points.geometry.attributes.position, half = st.span / 2;
      for (var k = 0; k < pos.count; k++) {
        var y = pos.getY(k) - dt * st.speed;
        if (y < -half) y = half;
        pos.setY(k, y);
      }
      pos.needsUpdate = true;
    }
    if (ctx.flows.length) AS.stepFlows(ctx.flows, t);
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

/** The HUD readout naming whatever the pointer is over. */
function renderProximity() {
  var box = $('#prox');
  if (!hovered) { box.classList.remove('show'); return; }
  var n = hovered.userData.node;
  box.innerHTML = '<b>' + esc(n.label || '') + '</b><span>' + esc(kindLabel(n.kind)) + '</span>';
  box.classList.add('show');
}

function kindLabel(k) {
  return {
    module: 'Monitoring domain', engine: 'Database technology', pgtab: 'PostgreSQL section',
    provider: 'Cloud provider', infratab: 'Host tab', collect: 'Collection method',
    alerttier: 'Alert tier', channel: 'Notification channel', bit: 'Permission bit',
    query: 'Illustrative query', table: 'Illustrative table', index: 'Illustrative index',
    role: 'Illustrative role', priv: 'Privilege', standby: 'Standby', pgnode: 'Primary',
    session: 'Illustrative session', logentry: 'Illustrative log event', metric: 'Illustrative metric',
    series: 'Illustrative series', gauge: 'Illustrative gauge', host: 'Illustrative host',
    plannode: 'Plan node', fact: 'Detail', alert: 'Illustrative alert', notimpl: 'Not implemented',
    tier: 'Storage tier', monitor: 'Monitored signal', rolemember: 'Role membership',
    'role-rbac': 'Illustrative role',
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

var LEVEL_NAMES = ['Platform', 'Module', 'Technology', 'Feature', 'Detail', 'Record', 'Record'];

function render() {
  var lv = current();
  if (HAS3D && world) {
    var r = resolveEnv();
    if (r.key !== currentEnvKey || r.level !== currentEnvLevel) {
      try {
        buildEnv(r.key, r.level);
      } catch (e) {
        // One bad environment must not kill the whole session. Report it,
        // fall back to the universe, and only give up on 3D entirely if even
        // that fails — the previous version disabled 3D permanently and
        // silently on the first throw, which looked like the level simply
        // stopped working.
        if (window.console && console.warn) console.warn('[actmon] environment "' + r.key + '" failed:', e);
        try {
          buildEnv('universe', { type: 'overview' });
          toast('That level could not be drawn — showing the overview instead.');
        } catch (e2) {
          HAS3D = false;
          $('#stage').style.display = 'none';
          $('#envBar').style.display = 'none';
        }
      }
    }
  }
  renderCrumbs();
  $('#lvl').textContent = 'Level ' + (stack.length - 1) + ' · ' + (LEVEL_NAMES[Math.min(stack.length - 1, 6)]);
  $('#back').disabled = stack.length <= 1;
  $('#fwd').disabled = future.length === 0;
  renderPanel();
  if (flat2d) renderFlat();
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
  switch (node.kind) {
    case 'module': return { type: 'module', id: node.id };
    case 'engine': return node.id === 'postgresql'
      ? { type: 'engine', id: 'postgresql' }
      : { type: 'feature', id: node.id, kind: 'engine' };
    case 'pgtab': return { type: 'feature', id: node.id, kind: 'pgtab', featureData: node.data };
    case 'provider': return { type: 'feature', id: node.id, kind: 'provider' };
    case 'infratab': return { type: 'feature', id: node.id, kind: 'infratab' };
    case 'collect': return { type: 'feature', id: node.id, kind: 'collect', label: node.label };
    case 'alerttier': return { type: 'feature', id: node.id, kind: 'alerttier', label: node.label };
    case 'channel': return { type: 'feature', id: node.id, kind: 'channel', label: node.label };
    case 'query': return recordLevel('query', node, node.data, 'Query analysis', node.data.type + ' · ' + node.data.db);
    case 'role': return recordLevel('role', node, node.data, node.data.name, 'Effective privileges');
    case 'standby': return recordLevel('standby', node, node.data, node.data.name, 'Standby detail');
    case 'pgnode': return recordLevel('primary', node, node.data, node.data.name, 'Primary detail');
    case 'table': return recordLevel('table', node, node.data, node.data.name, 'Table detail');
    case 'index': return recordLevel('index', node, node.data, node.data.name, 'Index detail');
    case 'logentry': return recordLevel('logentry', node, node.data, node.data.sev + ' · ' + node.data.t, 'Log event');
    case 'session': return recordLevel('session', node, node.data, 'PID ' + node.data.pid,
      node.data.role === 'holder' ? 'Blocking session' : 'Waiting session');
    case 'metric': case 'gauge': return recordLevel('metric', node, node.data, node.data.label, 'Illustrative metric');
    case 'series': return recordLevel('series', node, node.data, node.data.label, '24 illustrative points');
    case 'host': return recordLevel('host', node, node.data, node.data.name, 'Illustrative host');
    default: return null;
  }
}

function recordLevel(kind, node, rec, title, subtitle) {
  return {
    type: 'record', recordKind: kind, id: node.id, label: title, title: title, subtitle: subtitle,
    record: rec, color: node.color, facts: factsFor(kind, rec),
  };
}

/** The satellites a Level-5 environment arranges around one record. */
function factsFor(kind, r) {
  if (!r) return [];
  if (kind === 'query') return [
    { k: 'Calls', v: num(r.calls) }, { k: 'Average', v: r.avg_ms + ' ms', tone: 'warn' },
    { k: 'Maximum', v: r.max_ms + ' ms', tone: 'bad' }, { k: 'Rows returned', v: num(r.rows) },
    { k: 'Database', v: r.db }, { k: 'User', v: r.user },
    { k: 'Cache hit', v: r.cache_hit + ' %', tone: r.cache_hit < 60 ? 'bad' : 'ok' },
    { k: 'Temp blocks', v: num(r.temp_blocks), tone: r.temp_blocks ? 'warn' : 'ok' },
  ];
  if (kind === 'role') return r.attrs.map(function (a) { return { k: a[0], v: a[1], tone: a[2] === true ? 'ok' : null }; });
  if (kind === 'standby') return [
    { k: 'State', v: r.state, tone: r.state === 'streaming' ? 'ok' : 'bad' },
    { k: 'Sync', v: r.sync },
    { k: 'Apply lag', v: r.lag_ms == null ? 'no connection' : r.lag_ms + ' ms', tone: r.lag_ms ? 'warn' : 'ok' },
    { k: 'Byte lag', v: r.byte_pretty, tone: r.byte_lag > 1e9 ? 'bad' : 'ok' },
    { k: 'Slot', v: r.slot },
    { k: 'WAL status', v: r.wal_status, tone: r.wal_status === 'lost' ? 'bad' : 'ok' },
  ];
  if (kind === 'primary') return [
    { k: 'Role', v: r.role, tone: 'ok' }, { k: 'WAL position', v: r.wal },
    { k: 'Connections', v: num(r.connections) }, { k: 'Version', v: r.version },
  ];
  if (kind === 'table') return [
    { k: 'Rows', v: num(r.rows) }, { k: 'Total size', v: r.pretty }, { k: 'Index size', v: r.idx_pretty },
    { k: 'Dead rows', v: r.dead_pct + ' %', tone: r.dead_pct > 20 ? 'bad' : r.dead_pct > 10 ? 'warn' : 'ok' },
    { k: 'Sequential scans', v: num(r.seq) }, { k: 'Index scans', v: num(r.idx) },
    { k: 'Last vacuum', v: r.vacuumed, tone: r.vacuumed === 'never' ? 'bad' : 'ok' },
  ];
  if (kind === 'index') return [
    { k: 'Columns', v: r.cols.join(', ') },
    { k: 'Scans', v: num(r.scans), tone: r.scans === 0 ? 'warn' : 'ok' },
    { k: 'Size', v: r.pretty }, { k: 'Unique', v: r.unique ? 'Yes' : 'No' },
    { k: 'Primary key', v: r.primary ? 'Yes' : 'No' },
  ].concat(r.redundant ? [{ k: 'Prefix of', v: r.redundant, tone: 'warn' }] : []);
  if (kind === 'logentry') return [
    { k: 'Severity', v: r.sev, tone: r.sev === 'FATAL' || r.sev === 'ERROR' ? 'bad' : r.sev === 'WARNING' ? 'warn' : 'info' },
    { k: 'Time', v: r.t }, { k: 'PID', v: r.pid },
    { k: 'Database', v: r.db || '—' }, { k: 'User', v: r.user || '—' }, { k: 'SQLSTATE', v: r.state || '—' },
  ];
  if (kind === 'session') return [
    { k: 'PID', v: r.pid }, { k: 'User', v: r.user }, { k: 'Database', v: r.db },
    { k: 'Lock mode', v: r.mode }, { k: 'Object', v: r.object },
    { k: 'State', v: r.state, tone: String(r.state).indexOf('idle') === 0 ? 'bad' : 'ok' },
    { k: 'Age', v: r.age_s + ' s', tone: r.age_s > 60 ? 'bad' : 'warn' },
  ];
  if (kind === 'metric') return [
    { k: 'Value', v: r.value + (r.unit || ''), tone: r.tone },
    { k: 'Ceiling used', v: r.max + (r.unit || '') },
    { k: 'Utilisation', v: Math.round((r.value / r.max) * 100) + ' %' },
  ];
  if (kind === 'series') return [
    { k: 'Points', v: r.values.length }, { k: 'Minimum', v: Math.min.apply(null, r.values) },
    { k: 'Maximum', v: Math.max.apply(null, r.values) }, { k: 'Latest', v: r.values[r.values.length - 1] },
  ];
  if (kind === 'host') return (r.gauges || []).map(function (g) { return { k: g.label, v: g.value + g.unit, tone: g.tone }; });
  return [];
}

/* ── panels ────────────────────────────────────────────────────────────── */

function closePanel() { $('#panel').classList.remove('open'); }
function openPanel() { $('#panel').classList.add('open'); }

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
    var hex = (it.color != null ? it.color : 0x35c3f3).toString(16);
    while (hex.length < 6) hex = '0' + hex;
    b.innerHTML = '<span class="swatch" style="background:#' + hex + '"></span>'
      + '<span class="nb-txt"><b>' + esc(it.label) + '</b>'
      + (it.sub ? '<small>' + esc(it.sub) + '</small>' : '') + '</span>'
      + (it.status && it.status !== 'implemented' ? statusChip(it.status) : '')
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
  else if (lv.type === 'overview') { renderOverviewPanel(body); head = { k: 'Platform', t: D.META.title, s: D.META.subtitle }; }
  else if (lv.type === 'module') {
    var m = byId(D.MODULES, lv.id);
    renderModulePanel(body, m); head = { k: 'Module · ' + m.route, t: m.label, s: m.blurb };
  } else if (lv.type === 'engine') {
    var e = byId(D.ENGINES, lv.id);
    renderEnginePanel(body, e); head = { k: 'Technology · ' + e.route, t: e.label, s: e.note };
  } else if (lv.type === 'feature') head = renderFeaturePanel(body, lv);
  else if (lv.type === 'record') head = renderRecordPanel(body, lv);
  else if (lv.type === 'walkthrough') {
    var w = D.WALKTHROUGHS[lv.id];
    renderWalkthrough(body, w); head = { k: 'Guided example', t: w.title, s: w.subtitle };
  }

  $('#pKicker').textContent = head.k;
  $('#pTitle').textContent = head.t;
  $('#pSub').textContent = head.s || '';
  openPanel();
  body.scrollTop = 0;
}

var ILLUSTRATIVE_KINDS = ['query', 'table', 'index', 'role', 'priv', 'standby', 'pgnode', 'session',
  'logentry', 'metric', 'series', 'gauge', 'host', 'plannode', 'fact', 'alert', 'rolemember', 'role-rbac'];

/** Panel for whatever 3D object is selected — the "select shows detail,
    entering shows its environment" step. */
function renderNodePanel(body, n) {
  var d = n.data || {};
  var illustrative = ILLUSTRATIVE_KINDS.indexOf(n.kind) >= 0;
  var chips = illustrative ? sampleChip() : (d.status ? statusChip(d.status) : '');
  if (chips) body.appendChild(sec(null, '<div class="chips">' + chips + '</div>'));

  if (n.kind === 'module' || n.kind === 'engine' || n.kind === 'pgtab' || n.kind === 'provider' || n.kind === 'infratab') {
    body.appendChild(sec('What it is', '<p>' + esc(d.what || d.blurb || d.note || '') + '</p>'));
    if (d.why) body.appendChild(sec('Why it matters', '<p>' + esc(d.why) + '</p>'));
  } else if (n.kind === 'query') {
    body.appendChild(sec('Statement', '<pre class="code">' + esc(d.sql) + '</pre>'
      + '<p class="srcline">Example parameter: ' + esc(d.literal) + '</p>'));
    body.appendChild(sec('Measured statistics', facts([
      ['Executions', num(d.calls)], ['Average', d.avg_ms + ' ms'], ['Maximum', d.max_ms + ' ms'],
      ['Cumulative', Math.round(d.calls * d.avg_ms / 60000) + ' min'],
      ['Rows returned', num(d.rows)], ['Database', d.db], ['User', d.user],
    ])));
  } else if (n.kind === 'role') {
    body.appendChild(sec('Attributes', facts(d.attrs.map(function (a) { return [a[0], a[1]]; }))));
    body.appendChild(sec(null, '<div class="note ok">No password or password hash is ever displayed.</div>'));
  } else if (n.kind === 'priv') {
    body.appendChild(sec('Privilege', facts([['Object', d.object], ['Kind', d.kind],
      ['Grants', d.grants.join(', ')], ['Arrives via', d.via]])));
    body.appendChild(sec('What that route means', '<p>' + esc(SM.SAMPLE_ROLE.viaLegend[d.via] || '') + '</p>'));
  } else if (['standby', 'pgnode', 'table', 'index', 'logentry', 'session', 'metric', 'series', 'gauge', 'host'].indexOf(n.kind) >= 0) {
    var kk = n.kind === 'pgnode' ? 'primary' : n.kind === 'gauge' ? 'metric' : n.kind;
    body.appendChild(sec('Detail', facts(factsFor(kk, d).map(function (f) { return [f.k, String(f.v), f.tone]; }))));
  } else if (n.kind === 'plannode') {
    body.appendChild(sec('Plan node', facts([['Node', d.node], ['Detail', d.detail || '—'],
      ['Estimated rows', num(d.rows)], ['Estimated cost', String(d.cost)]]
      .concat(d.method ? [['Sort method', d.method]] : []))));
    if (d.bad) body.appendChild(sec(null, '<div class="note bad">This node is why a finding was raised.</div>'));
  } else if (n.kind === 'alerttier') {
    body.appendChild(sec('What it means', '<p>' + esc(d.detail) + '</p>'));
    body.appendChild(sec('Examples', '<div class="chips">' + d.examples.map(function (x) { return '<span class="chip">' + esc(x) + '</span>'; }).join('') + '</div>'));
    if (d.id === 'reserved') body.appendChild(sec(null, '<div class="note bad">' + esc(D.ALERT_NOTE) + '</div>'));
  } else if (n.kind === 'notimpl') {
    body.appendChild(sec(null, '<div class="note bad"><b>' + esc(d.verdict) + '</b><br />' + esc(d.detail) + '</div>'));
  } else if (n.kind === 'bit') {
    body.appendChild(sec('Permission bit', facts([['Permission', d.label], ['Value', String(d.value)]])));
    body.appendChild(sec(null, '<div class="note">' + esc(D.RBAC.composite) + '</div>'));
  } else if (d.detail || d.sub || d.what || d.s) {
    body.appendChild(sec('Detail', '<p>' + esc(d.detail || d.sub || d.what || d.s) + '</p>'));
  }

  var eb = enterBtn(n);
  if (eb) body.appendChild(sec(null, eb));
  var clear = el('button', 'btn wide', 'Clear selection');
  clear.onclick = function () { selected = null; renderPanel(); };
  body.appendChild(sec(null, clear));
  if (d.src) body.appendChild(sec('Source', '<p class="srcline">' + esc(d.src) + '</p>'));

  return {
    k: kindLabel(n.kind), t: n.label || '',
    s: illustrative ? SM.SAMPLE_BANNER : (d.blurb || d.what || ''),
  };
}

function renderOverviewPanel(body) {
  body.appendChild(sec('What this is',
    '<p>An explorable map of the ACTMON platform. Every capability described was read out of the repository '
    + 'before it was written down, and each node carries the file it came from.</p>'
    + '<div class="note"><b>Sample mode.</b> ' + esc(D.META.disclaimer) + '</div>'));
  body.appendChild(sec('Monitoring domains', navList(D.MODULES.map(function (m) {
    return { label: m.label, sub: m.blurb, color: m.color, status: m.status, _m: m };
  }), function (it) { selected = null; go({ type: 'module', id: it._m.id }); })));
  body.appendChild(sec('Guided examples', navList([
    { label: 'Investigating a slow query', sub: 'Symptom to a checkable recommendation', color: 0x35c3f3, _w: 'slowQuery' },
    { label: 'What can this role actually do?', sub: 'Effective privileges, not direct grants', color: 0xff8fa3, _w: 'role' },
    { label: 'From metric to resolution', sub: 'The incident lifecycle', color: 0xf2b23c, _w: 'incident' },
  ], function (it) { selected = null; go({ type: 'walkthrough', id: it._w }); })));
  body.appendChild(sec('Also in the product', '<p>' + D.SUPPORT_MODULES.map(function (s) {
    return '<b>' + esc(s.label) + '</b> <span class="dim">' + esc(s.route) + '</span> — ' + esc(s.note);
  }).join('<br />') + '</p>'));
  body.appendChild(sec('Status marks',
    '<div class="chips">' + Object.keys(STATUS).map(function (k) { return statusChip(k); }).join('') + '</div>'));
}

function renderModulePanel(body, m) {
  body.appendChild(sec(null, '<div class="chips">' + statusChip(m.status) + '<span class="chip">' + esc(m.route) + '</span></div>'));
  body.appendChild(sec('What it does', '<p>' + esc(m.what) + '</p>'));
  body.appendChild(sec('Why it matters', '<p>' + esc(m.why) + '</p>'));

  if (m.children === 'engines') {
    body.appendChild(sec('Database technologies', navList(D.ENGINES.map(function (e) {
      return { label: e.label, sub: e.note, color: e.color, status: e.status, _e: e };
    }), function (it) {
      selected = null;
      if (it._e.id === 'postgresql') go({ type: 'engine', id: 'postgresql' });
      else go({ type: 'feature', id: it._e.id, kind: 'engine' });
    })));
    body.appendChild(sec('Capability comparison', comparison()));
    body.appendChild(sec('Explicitly not supported', D.NOT_ENGINES.map(function (n) {
      return '<div class="note bad" style="margin-bottom:8px"><b>' + esc(n.label) + ' — ' + esc(n.verdict) + '</b><br />' + esc(n.detail) + '</div>';
    }).join('')));
  }
  if (m.children === 'providers') {
    body.appendChild(sec('Cloud providers', navList(D.PROVIDERS.map(function (p) {
      return { label: p.label, sub: p.resources.length + ' resource types scanned', color: p.color, status: p.status, _p: p };
    }), function (it) { selected = null; go({ type: 'feature', id: it._p.id, kind: 'provider' }); })));
    body.appendChild(sec(null, '<div class="note bad"><b>' + esc(D.NOT_ENGINES[1].label) + ' — ' + esc(D.NOT_ENGINES[1].verdict) + '</b><br />' + esc(D.NOT_ENGINES[1].detail) + '</div>'));
  }
  if (m.children === 'infraTabs') {
    body.appendChild(sec('Host detail tabs', navList(D.INFRA_TABS.map(function (t) {
      return { label: t.label, sub: t.what, color: 0x2fd6a6, _t: t };
    }), function (it) { selected = null; go({ type: 'feature', id: it._t.id, kind: 'infratab' }); })));
    body.appendChild(sec('History windows', '<p>' + esc(D.INFRA_EXTRA.ranges) + '</p><p>' + esc(D.INFRA_EXTRA.fileExplorer) + '</p>'));
    body.appendChild(sec('Relating host to database', '<div class="note warn">' + esc(D.INFRA_EXTRA.correlation) + '</div>'));
    body.appendChild(sec('Illustrative host', facts(SM.SAMPLE_HOST.gauges.map(function (g) { return [g.label, g.value + g.unit, g.tone]; }))));
    body.appendChild(sec(null, '<div class="note warn">' + esc(SM.SAMPLE_HOST.note) + '</div>'));
  }
  if (m.children === 'collection') {
    body.appendChild(sec('Collection methods', navList([
      { label: D.COLLECTION.agent.label, sub: D.COLLECTION.agent.detail, color: 0x7cd6f0, _c: 'agent' },
      { label: D.COLLECTION.direct.label, sub: D.COLLECTION.direct.detail, color: 0x35c3f3, _c: 'direct' },
    ], function (it) { selected = null; go({ type: 'feature', id: it._c, kind: 'collect', label: it.label }); })));
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
    }), function (it) { selected = null; go({ type: 'feature', id: it._t.id, kind: 'alerttier', label: it._t.label }); })));
    body.appendChild(sec(null, '<div class="note warn">' + esc(D.ALERT_NOTE) + '</div>'));
    body.appendChild(sec('Notification channels', navList(D.CHANNELS.map(function (c) {
      return { label: c.label, sub: c.detail, color: 0xff8fa3, _c: c };
    }), function (it) { selected = null; go({ type: 'feature', id: it._c.id, kind: 'channel', label: it._c.label }); })));
  }
  if (m.children === 'rbac') {
    body.appendChild(sec('The model', '<p>' + esc(D.RBAC.model) + '</p><p>' + esc(D.RBAC.composite) + '</p>'));
    body.appendChild(sec('Permission bits', '<div class="chips">' + D.RBAC.bits.map(function (b) {
      return '<span class="chip">' + esc(b.label) + ' · ' + b.value + '</span>';
    }).join('') + '</div>'));
    body.appendChild(sec('Why registration matters', '<div class="note warn">' + esc(D.RBAC.ungoverned) + '</div>'));
    body.appendChild(sec('Credentials', '<div class="note ok">' + esc(D.RBAC.credentials) + '</div>'));
  }
  if (m.id === 'logs') {
    body.appendChild(sec('Illustrative events', facts(SM.SAMPLE_LOGS.slice(0, 4).map(function (l) {
      return [l.sev + ' · ' + l.t, l.msg.slice(0, 54)];
    }))));
    body.appendChild(sec('Open the PostgreSQL log environment', navList([
      { label: 'PostgreSQL Error Logs', sub: 'Severity, SQLSTATE, detail, hint and context', color: 0x9d8df1 },
    ], function () { selected = null; pgFeature('error-logs'); render(); })));
  }
  body.appendChild(sec('Source', '<p class="srcline">' + esc(m.src) + '</p>'));
}

function comparison() {
  var w = el('div');
  var rows = D.ENGINES.map(function (e) {
    return '<tr><td class="c-name">' + esc(e.label) + '</td><td>' + statusChip(e.status) + '</td>'
      + '<td class="c-reach">' + (e.direct ? 'agent or direct' : 'agent') + '</td></tr>';
  }).join('');
  w.innerHTML = '<table class="cmp"><thead><tr><th>Engine</th><th>Status</th><th>Reach</th></tr></thead>'
    + '<tbody>' + rows + '</tbody></table>'
    + '<p class="cmp-note">&ldquo;direct&rdquo; means ACTMON may connect from its own server without an agent. '
    + 'That is attempted only for MySQL, MariaDB and PostgreSQL, and never when the host is loopback.</p>';
  return w;
}

function renderEnginePanel(body, e) {
  var realTabs = D.PG_TABS.filter(function (t) { return !t.virtual; }).length;
  body.appendChild(sec(null, '<div class="chips">' + statusChip(e.status) + '<span class="chip">' + esc(e.route) + '</span>'
    + '<span class="chip info">' + realTabs + ' dashboard tabs</span><span class="chip info">+1 detail page</span></div>'));
  body.appendChild(sec('Instance', facts([
    ['Instance', SM.SAMPLE_HEALTH.instance], ['Version', SM.SAMPLE_HEALTH.version],
    ['Database', SM.SAMPLE_HEALTH.db], ['Host', SM.SAMPLE_HEALTH.host + ':' + SM.SAMPLE_HEALTH.port],
    ['Uptime', SM.SAMPLE_HEALTH.uptime],
  ])));
  body.appendChild(sec(null, '<p class="srcline">' + esc(SM.SAMPLE_BANNER) + '</p>'));
  body.appendChild(sec('Dashboard sections', navList(D.PG_TABS.map(function (t) {
    return {
      label: t.label + (t.virtual ? '  (detail page)' : ''), sub: t.what,
      color: t.virtual ? 0x6f7cf7 : 0x4a9fd8, status: t.status, _t: t,
    };
  }), function (it) { selected = null; go({ type: 'feature', id: it._t.id, kind: 'pgtab', featureData: it._t }); })));
  body.appendChild(sec('Guided examples', navList([
    { label: 'Investigating a slow query', sub: 'Seven steps, one statement', color: 0x35c3f3, _w: 'slowQuery' },
    { label: 'What can migration_user do?', sub: 'Effective privilege inspection', color: 0xff8fa3, _w: 'role' },
  ], function (it) { selected = null; go({ type: 'walkthrough', id: it._w }); })));
  body.appendChild(sec('Source', '<p class="srcline">' + esc(e.src) + '</p>'));
}

function renderFeaturePanel(body, lv) {
  var t = byId(D.PG_TABS, lv.id);
  if (t && lv.kind === 'pgtab') {
    body.appendChild(sec(null, '<div class="chips">' + statusChip(t.status)
      + (t.virtual ? '<span class="chip info">Detail page</span>' : '')
      + (ENV.FEATURE_ENVS[t.id] ? '<span class="chip info">Bespoke 3D environment</span>' : '') + '</div>'));
    body.appendChild(sec('What it does', '<p>' + esc(t.what) + '</p>'));
    body.appendChild(sec('Why it matters', '<p>' + esc(t.why) + '</p>'));
    body.appendChild(sec('What it monitors', '<ul class="list">' + t.monitors.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'));
    if (t.sample) {
      var tiles = el('div', 'tiles');
      t.sample.forEach(function (p) { tiles.appendChild(el('div', 'tile', '<dt>' + esc(p[0]) + '</dt><dd>' + esc(p[1]) + '</dd>')); });
      var s = sec('Sample data', tiles);
      s.insertAdjacentHTML('beforeend', '<p class="srcline">' + esc(SM.SAMPLE_BANNER) + '</p>');
      body.appendChild(s);
    }
    body.appendChild(sec('An operational scenario', '<p>' + esc(t.scenario) + '</p>'));
    body.appendChild(sec('How a DBA uses it', '<div class="note">' + esc(t.dba) + '</div>'));
    if (t.safety) body.appendChild(sec('Safety', '<div class="note ok">' + esc(t.safety) + '</div>'));
    if (t.note) body.appendChild(sec('Worth knowing', '<div class="note warn">' + esc(t.note) + '</div>'));
    if (t.illustrative) body.appendChild(sec(null, '<div class="note warn"><b>Illustrative.</b> ' + esc(t.illustrative) + '</div>'));
    if (ENV.FEATURE_ENVS[t.id]) {
      body.appendChild(sec(null, '<div class="note">Click any object in the scene to inspect it, then <b>Enter</b> it for its own level.</div>'));
    }
    if (t.deepDive) {
      body.appendChild(sec('Walk through it', navList([{
        label: D.WALKTHROUGHS[t.deepDive].title, sub: D.WALKTHROUGHS[t.deepDive].subtitle, color: 0x35c3f3, _w: t.deepDive,
      }], function (it) { selected = null; go({ type: 'walkthrough', id: it._w }); })));
    }
    if (t.related && t.related.length) {
      body.appendChild(sec('Related', navList(t.related.map(function (rid) {
        var rt = byId(D.PG_TABS, rid) || byId(D.MODULES, rid);
        return { label: rt ? rt.label : rid, color: 0x6a7f9f, _r: rid, _isTab: !!byId(D.PG_TABS, rid) };
      }), function (it) {
        selected = null;
        if (it._isTab) go({ type: 'feature', id: it._r, kind: 'pgtab', featureData: byId(D.PG_TABS, it._r) });
        else go({ type: 'module', id: it._r });
      })));
    }
    return { k: 'PostgreSQL · ' + (t.virtual ? 'detail page' : 'dashboard tab'), t: t.label, s: t.what };
  }

  var p = byId(D.PROVIDERS, lv.id);
  if (p && lv.kind === 'provider') {
    body.appendChild(sec(null, '<div class="chips">' + statusChip(p.status) + '<span class="chip">' + p.resources.length + ' resource types</span></div>'));
    body.appendChild(sec('Authentication', '<p>' + esc(p.auth) + '</p>'));
    body.appendChild(sec('Resources discovered', '<div class="chips">' + p.resources.map(function (r) { return '<span class="chip">' + esc(r) + '</span>'; }).join('') + '</div>'));
    if (SM.SAMPLE_CLOUD[p.id]) {
      var s2 = sec('Illustrative inventory', facts(SM.SAMPLE_CLOUD[p.id].map(function (r) {
        return [r.name, r.type + ' · ' + r.region + ' · ' + r.state];
      })));
      s2.insertAdjacentHTML('beforeend', '<p class="srcline">' + esc(SM.SAMPLE_BANNER) + '</p>');
      body.appendChild(s2);
    }
    body.appendChild(sec('Cost data', '<div class="note warn">' + esc(p.cost) + '</div>'));
    body.appendChild(sec('Worth knowing', '<p>' + esc(p.note) + '</p>'));
    body.appendChild(sec('Source', '<p class="srcline">' + esc(p.src) + '</p>'));
    return { k: 'Cloud provider', t: p.label, s: p.resources.length + ' resource types inventoried' };
  }

  var it2 = byId(D.INFRA_TABS, lv.id);
  if (it2 && lv.kind === 'infratab') {
    body.appendChild(sec(null, '<div class="chips">' + statusChip('implemented') + '</div>'));
    body.appendChild(sec('What it shows', '<p>' + esc(it2.what) + '</p>'));
    body.appendChild(sec('History', '<p>' + esc(D.INFRA_EXTRA.ranges) + '</p>'));
    body.appendChild(sec('Relating host to database', '<div class="note warn">' + esc(D.INFRA_EXTRA.correlation) + '</div>'));
    return { k: 'Infrastructure · host tab', t: it2.label, s: it2.what };
  }

  var e = byId(D.ENGINES, lv.id);
  if (e) {
    body.appendChild(sec(null, '<div class="chips">' + statusChip(e.status) + '<span class="chip">' + esc(e.route) + '</span>'
      + '<span class="chip ' + (e.direct ? 'ok' : 'info') + '">' + (e.direct ? 'agent or direct' : 'agent only') + '</span></div>'));
    body.appendChild(sec('What is implemented', '<p>' + esc(e.note) + '</p>'));
    if (e.status === 'partial') {
      body.appendChild(sec(null, '<div class="note warn"><b>Partial.</b> This technology has no dashboard route of its own. '
        + 'It is handled through another engine\'s code path, which is why it is marked partial.</div>'));
    }
    body.appendChild(sec('Compare', comparison()));
    body.appendChild(sec('Source', '<p class="srcline">' + esc(e.src) + '</p>'));
    return { k: 'Database technology', t: e.label, s: e.note };
  }

  var ch = byId(D.CHANNELS, lv.id);
  if (ch) {
    body.appendChild(sec(null, '<div class="chips">' + statusChip('implemented') + '</div>'));
    body.appendChild(sec('Configuration', '<p>' + esc(ch.detail) + '</p>'));
    body.appendChild(sec(null, '<div class="note ok">Secrets for a channel are stored by the product and are not reproduced in this document.</div>'));
    return { k: 'Notification channel', t: ch.label, s: ch.detail };
  }

  var tier = byId(D.ALERT_TIERS, lv.id);
  if (tier) {
    body.appendChild(sec(null, '<div class="chips">' + statusChip(tier.id === 'reserved' ? 'no-data' : 'implemented')
      + '<span class="chip">' + tier.count + ' rule types</span></div>'));
    body.appendChild(sec('What it means', '<p>' + esc(tier.detail) + '</p>'));
    body.appendChild(sec('Examples', '<div class="chips">' + tier.examples.map(function (x) { return '<span class="chip">' + esc(x) + '</span>'; }).join('') + '</div>'));
    if (tier.id === 'reserved') body.appendChild(sec(null, '<div class="note bad">' + esc(D.ALERT_NOTE) + '</div>'));
    return { k: 'Alert evaluation tier', t: tier.label, s: tier.detail };
  }

  var c = D.COLLECTION[lv.id];
  if (c) {
    body.appendChild(sec('What it is', '<p>' + esc(c.detail) + '</p>'));
    if (c.platforms) body.appendChild(sec('Platforms', '<ul class="list">' + c.platforms.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'));
    if (c.enrol) body.appendChild(sec('Enrolment', '<p>' + esc(c.enrol) + '</p>'));
    if (c.rule) body.appendChild(sec('When it is used', '<div class="note">' + esc(c.rule) + '</div>'));
    if (c.why) body.appendChild(sec('Why the restriction', '<div class="note warn">' + esc(c.why) + '</div>'));
    body.appendChild(sec('Source', '<p class="srcline">' + esc(c.src) + '</p>'));
    return { k: 'Collection method', t: c.label, s: '' };
  }

  body.appendChild(sec(null, '<div class="note warn">No detail is recorded for this node.</div>'));
  return { k: 'Feature', t: titleOf(lv), s: '' };
}

function renderRecordPanel(body, lv) {
  var r = lv.record || {};
  body.appendChild(sec(null, '<div class="chips">' + sampleChip() + '</div>'));

  if (lv.recordKind === 'query') {
    body.appendChild(sec('Statement', '<pre class="code">' + esc(r.sql) + '</pre>'
      + '<p class="srcline">Example parameter: ' + esc(r.literal) + '</p>'));
    body.appendChild(sec('Measured statistics', facts([
      ['Executions', num(r.calls)], ['Average', r.avg_ms + ' ms'], ['Maximum', r.max_ms + ' ms'],
      ['Cumulative', Math.round(r.calls * r.avg_ms / 60000) + ' min'], ['Rows returned', num(r.rows)],
      ['Cache hit', r.cache_hit + ' %'], ['Temp blocks', num(r.temp_blocks)],
      ['Database', r.db], ['User', r.user],
    ])));
    body.appendChild(sec('Estimated execution plan',
      '<pre class="code">' + r.plan.map(function (n) {
        return esc('  '.repeat(n.d) + (n.d ? '└─ ' : '') + n.node + '   (rows≈' + num(n.rows) + '  cost=' + n.cost + ')'
          + (n.detail ? '\n' + '  '.repeat(n.d + 2) + n.detail : '')
          + (n.method ? '\n' + '  '.repeat(n.d + 2) + 'Sort Method: ' + n.method : ''));
      }).join('\n') + '</pre>'
      + '<div class="note warn"><b>Estimated, not measured.</b> A plain EXPLAIN computes this plan without '
      + 'executing the statement, so the row counts are the planner\'s estimates. Only EXPLAIN ANALYZE reports '
      + 'what actually happened, and ACTMON refuses that for anything that is not a plain read.</div>'));

    var fw = el('div');
    r.findings.forEach(function (f) {
      var c = el('div', 'finding');
      c.innerHTML = '<div class="f-top"><span class="chip ' + (f.sev === 'critical' || f.sev === 'high' ? 'bad' : f.sev === 'medium' ? 'warn' : 'info') + '">'
        + esc(f.sev) + '</span><b>' + esc(f.title) + '</b></div>'
        + '<p class="f-ev"><span class="dim">evidence: </span>' + esc(f.evidence) + '</p>'
        + '<p class="f-act"><b>What to do: </b>' + esc(f.action) + '</p>'
        + (f.sql ? '<pre class="code">' + esc(f.sql) + '</pre>' : '')
        + (f.tradeoff ? '<p class="f-to">Trade-off: ' + esc(f.tradeoff) + '</p>' : '');
      fw.appendChild(c);
    });
    body.appendChild(sec('Findings', fw));
    if (r.note) body.appendChild(sec(null, '<div class="note bad">' + esc(r.note) + '</div>'));
    body.appendChild(sec(null, '<div class="note">A recommendation is a suggestion, never a guarantee. '
      + 'An index helps only if the filter is selective enough that the planner chooses it.</div>'));
  } else if (lv.recordKind === 'role') {
    body.appendChild(sec('Attributes', facts(r.attrs.map(function (a) { return [a[0], a[1]]; }))));
    body.appendChild(sec('Member of', '<div class="chips">' + r.memberOf.map(function (m) {
      return '<span class="chip info">' + esc(m.name) + (m.inherit ? ' · inherited' : '') + '</span>';
    }).join('') + '</div>'));
    var pw = el('div');
    ['direct', 'app_writer', 'PUBLIC', 'owner'].forEach(function (via) {
      var list = r.privileges.filter(function (p) { return p.via === via; });
      if (!list.length) return;
      var g = el('div', 'viagroup');
      g.innerHTML = '<p class="via-h">' + esc(via === 'app_writer' ? 'Inherited from app_writer'
        : via === 'direct' ? 'Granted directly' : via === 'PUBLIC' ? 'Held by PUBLIC' : 'Implied by ownership')
        + '</p><p class="via-d">' + esc(r.viaLegend[via]) + '</p>';
      list.forEach(function (p) {
        g.insertAdjacentHTML('beforeend', '<div class="privrow"><code>' + esc(p.object) + '</code><span>' + esc(p.grants.join(', ')) + '</span></div>');
      });
      pw.appendChild(g);
    });
    body.appendChild(sec('Effective privileges, by route', pw));
    body.appendChild(sec('Owns', '<div class="chips">' + r.owns.map(function (o) { return '<span class="chip">' + esc(o) + '</span>'; }).join('') + '</div>'));
    body.appendChild(sec('Active sessions', r.sessions.length ? '' : '<p class="dim">None in this illustrative snapshot.</p>'));
    body.appendChild(sec(null, '<div class="note ok"><b>Never shown:</b> the password, the password hash, or any verifier. '
      + 'Only metadata PostgreSQL exposes safely appears here.</div>'));
    body.appendChild(sec('The lesson', '<div class="note">' + esc(r.lesson) + '</div>'));
  } else {
    body.appendChild(sec('Detail', facts((lv.facts || []).map(function (f) { return [f.k, String(f.v), f.tone]; }))));
    if (r.query) body.appendChild(sec('Statement', '<pre class="code">' + esc(r.query) + '</pre>'));
    if (r.msg) body.appendChild(sec('Message', '<p>' + esc(r.msg) + '</p>'));
    if (r.detail) body.appendChild(sec('Detail', '<pre class="code">' + esc(r.detail) + '</pre>'));
    if (r.hint) body.appendChild(sec('Hint', '<div class="note">' + esc(r.hint) + '</div>'));
    if (r.ctx) body.appendChild(sec('Context', '<p class="srcline">' + esc(r.ctx) + '</p>'));
    if (r.stmt) body.appendChild(sec('Offending statement', '<pre class="code">' + esc(r.stmt) + '</pre>'));
    if (r.note) body.appendChild(sec(null, '<div class="note warn">' + esc(r.note) + '</div>'));
    if (r.values) body.appendChild(sec('Series', '<pre class="code">' + esc(r.values.join('  ')) + '</pre>'));
    if (r.redundant) body.appendChild(sec(null, '<div class="note warn">Its columns are a prefix of <b>' + esc(r.redundant)
      + '</b>, so the longer index already serves everything this one could. Zero scans means unused <i>since the last '
      + 'statistics reset</i> — check that before dropping anything.</div>'));
  }

  var lesson = (lv.recordKind === 'standby' || lv.recordKind === 'primary') ? SM.SAMPLE_REPLICATION.lesson
    : lv.recordKind === 'session' ? SM.SAMPLE_LOCKS.lesson : null;
  if (lesson) body.appendChild(sec('The lesson', '<div class="note warn">' + esc(lesson) + '</div>'));

  return { k: 'Record · illustrative', t: lv.title, s: lv.subtitle };
}

function renderWalkthrough(body, w) {
  body.appendChild(sec(null, '<div class="note warn"><b>Illustrative.</b> ' + esc(w.subtitle) + '</div>'));
  var wrap = el('div');
  w.steps.forEach(function (s, i) {
    var st = el('div', 'wt-step done');
    st.appendChild(el('p', 'wt-t', esc((i + 1) + '. ' + s.t)));
    st.appendChild(el('p', 'wt-b', esc(s.b)));
    if (s.code) st.appendChild(el('pre', 'code', esc(s.code)));
    if (s.rows) st.appendChild(facts(s.rows));
    if (s.tab) {
      var tb = byId(D.PG_TABS, s.tab);
      var b = el('button', 'btn', 'Open ' + esc(tb ? tb.label : s.tab));
      b.onclick = function () { selected = null; pgFeature(s.tab); render(); };
      st.appendChild(b);
    }
    wrap.appendChild(st);
  });
  body.appendChild(sec('Walkthrough', wrap));
}

/* ── search ────────────────────────────────────────────────────────────── */

var ALIASES = {
  users: 'database roles role privileges grants permissions membership ownership migration_user superuser login',
  'slow-queries': 'slow query performance expensive statement execution plan',
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
  performance: 'throughput commits rollbacks cache ratio io wait events latency',
  queries: 'pg_stat_statements statement digest execution count',
  reports: 'report export csv scheduled', diagnose: 'diagnostics guided troubleshooting',
  aws: 'amazon ec2 rds s3 dynamodb lambda eks redshift elasticache vpc iam',
  azure: 'microsoft cosmos db sql postgresql mysql aks redis storage vm',
  oci: 'oracle cloud compartment compute object storage nosql autonomous',
  cosmosdb: 'cosmos azure nosql request units ru partition throttling',
  postgresql: 'postgres pg', mssql: 'sql server microsoft t-sql', mariadb: 'maria mysql fork',
};

var INDEX = [];
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
      label: t.label, ctx: 'PostgreSQL', kw: t.what + ' ' + (t.monitors || []).join(' ') + ' ' + (ALIASES[t.id] || ''),
      go: { type: 'feature', id: t.id, kind: 'pgtab', featureData: t },
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
    INDEX.push({ label: t.label, ctx: 'Infrastructure', kw: t.what, go: { type: 'feature', id: t.id, kind: 'infratab' }, pre: [{ type: 'module', id: 'infra' }] });
  });
  D.CHANNELS.forEach(function (c) {
    INDEX.push({ label: c.label, ctx: 'Notification channel', kw: c.detail, go: { type: 'feature', id: c.id, kind: 'channel', label: c.label }, pre: [{ type: 'module', id: 'alerts' }] });
  });
  D.ALERT_TIERS.forEach(function (t) {
    INDEX.push({ label: t.label + ' alerts', ctx: 'Alert tier', kw: t.detail + ' ' + t.examples.join(' '), go: { type: 'feature', id: t.id, kind: 'alerttier', label: t.label }, pre: [{ type: 'module', id: 'alerts' }] });
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
  var words = q.split(/\s+/).filter(Boolean);
  var hits = INDEX.filter(function (r) {
    var hay = (r.label + ' ' + r.ctx + ' ' + (r.kw || '')).toLowerCase();
    return words.every(function (w) { return hay.indexOf(w) >= 0; });
  }).sort(function (a, b) {
    var al = a.label.toLowerCase().indexOf(q), bl = b.label.toLowerCase().indexOf(q);
    return (al < 0 ? 99 : al) - (bl < 0 ? 99 : bl);
  }).slice(0, 12);

  box.innerHTML = ''; selIdx = -1;
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
  future = []; selected = null;
  stack.push(h.go);
  render();
  $('#results').classList.remove('show');
  $('#search').value = ''; $('#search').blur();
}

/* ── cinematic tour ────────────────────────────────────────────────────── */

function pgFeature(id) {
  var t = byId(D.PG_TABS, id);
  stack = [{ type: 'overview' }, { type: 'module', id: 'database' }, { type: 'engine', id: 'postgresql' },
  { type: 'feature', id: id, kind: 'pgtab', featureData: t }];
  future = [];
}

/** Lets the tour descend one level into whatever the environment just built,
    without needing to know its internals. */
function enterFirstOfKind(kind) {
  render();
  if (!ctx) return;
  for (var i = 0; i < ctx.picks.length; i++) {
    var n = ctx.picks[i].userData.node;
    if (n.kind === kind) {
      var next = childLevelFor(n);
      if (next) stack.push(next);
      return;
    }
  }
}

var TOUR = [
  { t: 'Discover the ACTMON universe', b: 'Seven monitoring domains around one platform. Every connection is a real relationship, and every domain is its own environment to enter.', go: function () { stack = [{ type: 'overview' }]; } },
  { t: 'Enter Database Monitoring', b: 'The scene becomes a data landscape. Eight technology entries stand on it — seven with a dashboard of their own, one riding the MySQL path.', go: function () { stack = [{ type: 'overview' }, { type: 'module', id: 'database' }]; } },
  { t: 'Explore the supported technologies', b: 'A ringed engine is partial. Redis and Google Cloud are named as absent rather than quietly omitted.', go: function () { stack = [{ type: 'overview' }, { type: 'module', id: 'database' }]; } },
  { t: 'Enter PostgreSQL', b: 'The instance sits at the centre inside its health arcs, and sixteen feature areas radiate outward along lit pathways.', go: function () { stack = [{ type: 'overview' }, { type: 'module', id: 'database' }, { type: 'engine', id: 'postgresql' }]; } },
  { t: 'Inspect Slow Queries', b: 'Four statements as towers. Width is cumulative cost, not duration — which is why the most expensive one here is not the slowest one.', go: function () { pgFeature('slow-queries'); } },
  { t: 'Explore an execution plan', b: 'Open one statement and its plan becomes a physical tree: node width is estimated cost, red marks the node a finding came from.', go: function () { pgFeature('slow-queries'); enterFirstOfKind('query'); } },
  { t: 'Inspect a role and its permissions', b: 'migration_user, with every privilege coloured by the route it arrives through — direct, inherited, PUBLIC, or ownership.', go: function () { pgFeature('users'); } },
  { t: 'Explore Replication', b: 'One primary, three standbys. Particle speed is the inverse of each standby\'s lag, and the lost slot has no flow at all.', go: function () { pgFeature('replication'); } },
  { t: 'See where storage went', b: 'A physical treemap: volume is size on disk, and the red cap is the dead-tuple share.', go: function () { pgFeature('storage'); } },
  { t: 'Return to the universe', b: 'Every level stays reachable from the breadcrumb, so nothing explored here is lost.', go: function () { stack = [{ type: 'overview' }]; } },
];

function tourStart() {
  tour.on = true; tour.i = 0; tour.playing = true;
  $('#tour').classList.add('open');
  $('#tourBtn').classList.add('on');
  tourShow();
}
function tourStop() {
  tour.on = false; tour.playing = false;
  clearTimeout(tour.timer);
  $('#tour').classList.remove('open');
  $('#tourBtn').classList.remove('on');
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

function renderFlat() {
  var b = $('#flatBody'); b.innerHTML = '';
  b.appendChild(el('h2', 'flat-h', 'ACTMON — full feature index'));
  b.appendChild(el('p', 'flat-s',
    'Every node in the 3D experience as a flat list. This is the accessible alternative: no WebGL, no pointer '
    + 'gestures, keyboard and screen-reader navigable. ' + D.META.disclaimer));

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
    function (it) { stack = [{ type: 'overview' }]; selected = null; go({ type: 'module', id: it._i }); });
  group('Database technologies', D.ENGINES.map(function (e) { return { label: e.label, sub: e.note, status: e.status, _e: e }; }),
    function (it) {
      stack = [{ type: 'overview' }, { type: 'module', id: 'database' }]; selected = null;
      if (it._e.id === 'postgresql') go({ type: 'engine', id: 'postgresql' });
      else go({ type: 'feature', id: it._e.id, kind: 'engine' });
    });
  group('PostgreSQL sections', D.PG_TABS.map(function (t) { return { label: t.label, sub: t.what, status: t.status, _t: t }; }),
    function (it) { selected = null; pgFeature(it._t.id); render(); });
  group('Cloud providers', D.PROVIDERS.map(function (p) { return { label: p.label, sub: p.resources.length + ' resource types', status: p.status, _p: p }; }),
    function (it) { stack = [{ type: 'overview' }, { type: 'module', id: 'cloud' }]; selected = null; go({ type: 'feature', id: it._p.id, kind: 'provider' }); });
  group('Infrastructure host tabs', D.INFRA_TABS.map(function (t) { return { label: t.label, sub: t.what, _t: t }; }),
    function (it) { stack = [{ type: 'overview' }, { type: 'module', id: 'infra' }]; selected = null; go({ type: 'feature', id: it._t.id, kind: 'infratab' }); });
  group('Notification channels', D.CHANNELS.map(function (c) { return { label: c.label, sub: c.detail, _c: c }; }),
    function (it) { stack = [{ type: 'overview' }, { type: 'module', id: 'alerts' }]; selected = null; go({ type: 'feature', id: it._c.id, kind: 'channel', label: it._c.label }); });
  group('Illustrative records', SM.SAMPLE_QUERIES.map(function (q) {
    return { label: q.type + ' · ' + q.avg_ms + ' ms average', sub: q.sql.replace(/\s+/g, ' ').slice(0, 84), _q: q };
  }).concat([{ label: SM.SAMPLE_ROLE.name, sub: 'Illustrative role — effective privileges', _r: true }]),
    function (it) {
      selected = null;
      if (it._q) {
        pgFeature('slow-queries');
        stack.push({
          type: 'record', recordKind: 'query', id: it._q.id, label: 'Query analysis', title: 'Query analysis',
          subtitle: it._q.type + ' · ' + it._q.db, record: it._q, color: 0x35c3f3, facts: factsFor('query', it._q),
        });
      } else {
        pgFeature('users');
        stack.push({
          type: 'record', recordKind: 'role', id: SM.SAMPLE_ROLE.name, label: SM.SAMPLE_ROLE.name,
          title: SM.SAMPLE_ROLE.name, subtitle: 'Effective privileges', record: SM.SAMPLE_ROLE,
          color: 0xff8fa3, facts: factsFor('role', SM.SAMPLE_ROLE),
        });
      }
      render();
    });
  group('Guided examples', Object.keys(D.WALKTHROUGHS).map(function (k) {
    return { label: D.WALKTHROUGHS[k].title, sub: D.WALKTHROUGHS[k].subtitle, _w: k };
  }), function (it) { stack = [{ type: 'overview' }]; selected = null; go({ type: 'walkthrough', id: it._w }); });
  group('Not supported', D.NOT_ENGINES.map(function (n) { return { label: n.label, sub: n.detail, status: 'none' }; }), function () {});
}

function toggleFlat() {
  flat2d = !flat2d;
  $('#flat').classList.toggle('show', flat2d);
  $('#flatBtn').classList.toggle('on', flat2d);
  if (flat2d) { renderFlat(); closePanel(); } else openPanel();
}

function renderLegend() {
  $('#legend').innerHTML = ['implemented', 'partial', 'no-data', 'illustrative', 'none']
    .map(function (k) { return statusChip(k); }).join('');
}

/* ── wiring ────────────────────────────────────────────────────────────── */

function wire() {
  $('#home').onclick = reset;
  $('#reset').onclick = function () { reset(); toast('Back to the platform overview.'); };
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
  'Reading the module inventory…', 'Indexing database technologies…',
  'Mapping the PostgreSQL dashboard…', 'Loading cloud provider coverage…',
  'Composing the ACTMON universe…',
];

function boot() {
  if (!D || !SM) { $('#ldStep').textContent = 'Content failed to load — a script is missing.'; return; }
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
      // Report before degrading. A silent catch here turns any startup fault —
      // a missing WebGL context, a typo in a builder — into "the 3D just
      // doesn't work", with nothing to go on.
      if (window.console && console.warn) console.warn('[actmon] 3D startup failed, using the 2D view:', err);
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
