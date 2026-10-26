/* ===========================================================================
   KOEL architecture document — page assembly.

   Layout contract, the same one ACTMON's Knowledge Centre follows:
     · the 3D sits at the top, full width;
     · the documentation sits BELOW it, full width, in reading order;
     · clicking a node in the 3D scrolls the PAGE down to that node's
       documentation. No side drawer, no modal, no second click.

   What differs from ACTMON: the hero here is explorable. The estate has real
   nesting — zone, subnet, stack — so entering a zone rebuilds the scene
   rather than just turning the camera. Clicking a leaf still scrolls down.
   =========================================================================== */
(function () {
'use strict';

var D = window.KOEL;
var EV = window.KEnvs;
var KS = window.KScene;
var HAS3D = typeof THREE !== 'undefined' && !!KS && !!EV;
var GS = typeof gsap !== 'undefined' ? gsap : null;

var $ = function (s) { return document.querySelector(s); };
var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
function el(t, c, h) { var n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

/* ── small builders ─────────────────────────────────────────────────────── */

function h3(t) { return '<h3 class="s-h3">' + esc(t) + '</h3>'; }
function p(t) { return '<p>' + esc(t) + '</p>'; }
function note(html, tone) { return '<div class="note' + (tone ? ' ' + tone : '') + '">' + html + '</div>'; }
function list(items) {
  return '<ul class="list">' + items.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('') + '</ul>';
}
function grid(cards, cls) { return '<div class="cards' + (cls ? ' ' + cls : '') + '">' + cards.join('') + '</div>'; }

/** The provenance chip. Every claim on this page carries one, because the
    difference between "the diagram says so" and "this is how Oracle works"
    is the single most important distinction in the document. */
function provChip(key) {
  var c = D.CLASS[key];
  if (!c) return '';
  return '<span class="chip ' + c.cls + '" title="' + esc(c.label) + '">' + esc(c.label) + '</span>';
}

function table(cols, rows) {
  return '<div class="t-wrap"><table class="dt"><thead><tr>'
    + cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('')
    + '</tr></thead><tbody>'
    + rows.map(function (r) {
      return '<tr>' + r.map(function (c) { return '<td>' + (c && c.html ? c.html : esc(c)) + '</td>'; }).join('') + '</tr>';
    }).join('')
    + '</tbody></table></div>';
}

function hex(n) { return '#' + ('000000' + n.toString(16)).slice(-6); }

/** One component, documented. Used for every on-prem, OCI and Siebel node so
    they are described identically — the reader learns the shape once. */
function componentCard(c) {
  var b = '';
  b += '<div class="dcard-h"><b>' + esc(c.label) + '</b>' + provChip(c.cls) + '</div>';
  if (c.sub) b += '<p class="dcard-sub">' + esc(c.sub) + '</p>';
  b += '<div class="dcard-b">';
  if (c.count) b += '<p><span class="big">' + c.count + '</span> <span class="dim">on the diagram</span></p>';
  b += '<p>' + esc(c.what) + '</p>';
  if (c.why) b += '<p>' + esc(c.why) + '</p>';
  if (c.nodes) b += '<div class="chips">' + c.nodes.map(function (n) { return '<span class="chip info">' + esc(n) + '</span>'; }).join('') + '</div>';
  if (c.critical) b += note('<b>Single point of failure.</b> ' + esc(c.critical), 'bad');
  if (c.note) b += note(esc(c.note), 'warn');
  if (c.contextNote) b += note('<b>Where this comes from.</b> ' + esc(c.contextNote), 'grey');
  if (c.unknown) {
    b += '<p class="m-sub">Not answered by the diagram</p>' + list(c.unknown);
  }
  b += '</div>';
  var tint = ' style="border-left:3px solid ' + hex(c.color) + '"';
  return '<article class="dcard" id="c-' + esc(c.id) + '"' + tint + '>' + b + '</article>';
}

/* ── sections ───────────────────────────────────────────────────────────── */

var SECTIONS = [];
function section(id, title, kicker, build) { SECTIONS.push({ id: id, title: title, kicker: kicker, build: build }); }

section('overview', 'How to read this document', 'Start here', function () {
  var o = '';
  o += p('This describes the KOEL hybrid estate: an Oracle ERP and Siebel CRM landscape running in Oracle '
       + 'Cloud Infrastructure, joined by one encrypted tunnel to an on-premises data centre that receives '
       + 'eighteen external data feeds.');

  o += note('<b>One source, and it matters.</b> ' + esc(D.META.disclaimer), 'warn');

  o += h3('Every claim is labelled');
  o += p('Four labels appear throughout. They are the difference between what KOEL has drawn and what is '
       + 'generally true of the products it names.');
  o += (function () {
    var rows = Object.keys(D.CLASS).map(function (k) {
      var c = D.CLASS[k];
      var meaning = {
        diagram: 'Stated on the diagram — the node, its label, or an edge that is literally in the file.',
        implied: 'Follows necessarily from what is drawn. For example: a feed whose only connection is to the '
               + 'integration server must reach the estate through it.',
        context: 'True of the named product in general. It describes Oracle ERP, Siebel or an HSM — not KOEL\'s '
               + 'particular configuration of it.',
        unknown: 'A question the diagram does not answer. Listed so it can be asked, rather than guessed.',
      }[k];
      return [{ html: '<span class="chip ' + c.cls + '">' + esc(c.label) + '</span>' }, meaning];
    });
    return table(['Label', 'What it means'], rows);
  })();

  o += h3('The estate in numbers');
  var priv = D.PRIVATE_SUBNET.length, pub = D.PUBLIC_SUBNET.length;
  var siebelTotal = D.SIEBEL.reduce(function (a, c) { return a + (c.count || 1); }, 0);
  var counts = [
    ['3', 'Zones', 'Third-party, on-premises, OCI'],
    [String(D.FEEDS.length), 'External feeds', 'All converging on one integration server'],
    [String(D.ONPREM.length), 'On-premises components', 'Identity, edge, ingestion, two databases, legacy BI'],
    [String(pub + priv), 'OCI components', pub + ' public subnet, ' + priv + ' private subnet'],
    [String(siebelTotal), 'Siebel servers', D.SIEBEL.map(function (c) { return c.count + '×'; }).join(' + ') + ' across ' + D.SIEBEL.length + ' tiers'],
    [String(D.FLOWS.length), 'Connections drawn', D.FLOWS.filter(function (f) { return f.dir === 'bidirectional'; }).length + ' of them two-way'],
  ];
  o += grid(counts.map(function (c) {
    return '<article class="dcard"><div class="dcard-b"><p><span class="big">' + esc(c[0]) + '</span></p>'
      + '<div class="dcard-h"><b>' + esc(c[1]) + '</b></div><p>' + esc(c[2]) + '</p></div></article>';
  }), 'c3');

  o += h3('Using the picture at the top');
  o += p('The visualisation above is the same estate. Click a zone to enter it; click a component inside a '
       + 'zone and this page scrolls to its entry. The breadcrumb takes you back out. Everything the picture '
       + 'shows is also written below, so nothing depends on the 3D working.');
  return o;
});

section('zones', 'The three zones', 'Structure', function () {
  var o = p('The diagram divides the estate into three columns. Reading left to right they are the systems '
          + 'KOEL does not own, the data centre it does, and the cloud region where production runs.');
  o += grid(D.ZONES.map(function (z) {
    return '<article class="dcard" id="c-' + esc(z.id) + '" style="border-left:3px solid ' + hex(z.color) + '">'
      + '<div class="dcard-h"><b>' + esc(z.label) + '</b>' + provChip(z.cls) + '</div>'
      + '<p class="dcard-sub">' + esc(z.diagramLabel.replace(/\n/g, ' · ')) + '</p>'
      + '<div class="dcard-b"><p>' + esc(z.what) + '</p><p>' + esc(z.why) + '</p></div></article>';
  }), 'c3');

  o += note('The only thing joining the second and third zones is a single encrypted tunnel. Everything '
    + 'hybrid &mdash; and on this diagram that includes the SFTP bridge that carries all eighteen feeds into '
    + 'the ERP &mdash; depends on it.', 'bad');
  return o;
});

section('feeds', 'Third-party integration ecosystem', '18 external feeds', function () {
  var o = p('Eighteen external systems send data into KOEL. The diagram names each one and gives its protocol. '
          + 'All eighteen converge on a single component: the integration server\'s SFTP mount point.');

  o += h3('By category');
  o += grid(Object.keys(D.FEED_KINDS).map(function (k) {
    var kind = D.FEED_KINDS[k];
    var n = D.FEEDS.filter(function (f) { return f.kind === k; }).length;
    return '<article class="dcard" style="border-left:3px solid ' + hex(kind.color) + '">'
      + '<div class="dcard-h"><b>' + esc(kind.label) + '</b><span class="chip">' + n + ' feed' + (n === 1 ? '' : 's') + '</span></div>'
      + '<div class="dcard-b"><p>' + esc(kind.note) + '</p></div></article>';
  }), 'c3');

  o += h3('Every feed, as the diagram names it');
  o += table(['#', 'Feed', 'Protocol', 'Category'], D.FEEDS.map(function (f, i) {
    var kind = D.FEED_KINDS[f.kind];
    return [
      String(i + 1),
      { html: '<b id="c-feed-' + i + '">' + esc(f.n) + '</b>' },
      { html: '<span class="chip info">' + esc(f.p) + '</span>' },
      { html: '<span class="chip" style="color:' + hex(kind.color) + ';border-color:' + hex(kind.color) + '55">' + esc(kind.label) + '</span>' },
    ];
  }));

  var protos = {};
  D.FEEDS.forEach(function (f) { protos[f.p] = (protos[f.p] || 0) + 1; });
  o += note('<b>Five transport shapes in one hub.</b> '
    + esc(Object.keys(protos).map(function (k) { return k + ' (' + protos[k] + ')'; }).join(', '))
    + '. A webhook is pushed to you; an SFTP drop is waited for; an HTTP/s call is made by you. They fail in '
    + 'different ways and need different detection &mdash; a webhook that stops arriving looks exactly like a '
    + 'quiet day unless something is watching for the silence.', 'info');

  o += note('<b>Two vendors appear twice.</b> Taxilla arrives both over HTTP/s and as an SFTP portal; Locus '
    + 'arrives directly and again behind MRC Dispatch. Counting vendors rather than feeds gives sixteen, '
    + 'not eighteen.', 'grey');
  return o;
});

section('onprem', 'On-premises data centre', 'KOEL internal network', function () {
  var o = p('KOEL\'s own network. Identity and edge security sit here, the eighteen feeds land here, and two '
          + 'production databases were never moved to the cloud.');
  o += D.ONPREM.map(componentCard).join('');
  return o;
});

section('oci', 'Oracle Cloud Infrastructure', 'One region, one VCN', function () {
  var o = p('One OCI region holds the production workloads inside a single virtual cloud network. The VCN is '
          + 'split into a public subnet &mdash; the DMZ edge &mdash; and a private subnet holding everything '
          + 'that actually runs the business.');

  o += h3('Public subnet — DMZ edge tier');
  o += D.PUBLIC_SUBNET.map(componentCard).join('');

  o += h3('Private subnet — secured application &amp; data tier');
  o += p('Eight components: the ERP application and database, two presentation layers, an HSM, the integration '
       + 'tooling and the analytics warehouse with its own APEX front end.');
  o += D.PRIVATE_SUBNET.map(componentCard).join('');
  return o;
});

section('siebel', 'Siebel Cloud CRM stack', 'Inside the private subnet', function () {
  var total = D.SIEBEL.reduce(function (a, c) { return a + (c.count || 1); }, 0);
  var o = p('The Siebel deployment is drawn as a block of its own inside the OCI private subnet. It is the '
          + 'most heavily replicated part of the estate: ' + total + ' servers across ' + D.SIEBEL.length
          + ' tiers, with its own dedicated database rather than a share of the ERP\'s.');
  o += D.SIEBEL.map(componentCard).join('');
  o += note('Every Siebel tier is at least doubled. Set against the ERP application tier\'s single compute '
    + 'node next door, that is the diagram\'s sharpest internal contrast &mdash; and the clearest question to '
    + 'put to whoever owns the infrastructure.', 'warn');
  return o;
});

section('flows', 'Data flows', 'The eight connections drawn', function () {
  var o = p('Eight edges appear in the diagram. Each is reproduced here with its label, direction and '
          + 'endpoints exactly as drawn.');

  o += table(['Connection', 'From', 'To', 'Direction'], D.FLOWS.map(function (f) {
    return [
      { html: '<b>' + esc(f.label) + '</b>' },
      esc(f.from), esc(f.to),
      { html: '<span class="chip ' + (f.dir === 'bidirectional' ? 'info' : '') + '">' + esc(f.dir) + '</span>' },
    ];
  }));

  o += h3('What each one carries');
  o += D.FLOWS.map(function (f) {
    var b = '<article class="dcard" id="c-' + esc(f.id) + '">'
      + '<div class="dcard-h"><b>' + esc(f.label) + '</b>'
      + '<span class="chip ' + (f.dir === 'bidirectional' ? 'info' : 'grey') + '">' + esc(f.dir) + '</span>'
      + provChip(f.cls) + '</div>'
      + '<p class="dcard-sub">' + esc(f.from) + '  →  ' + esc(f.to) + '</p>'
      + '<div class="dcard-b"><p>' + esc(f.what) + '</p><p>' + esc(f.why) + '</p>';
    if (f.critical) b += note('<b>No alternative path is drawn.</b> If this connection stops, the diagram '
      + 'shows nothing that takes over.', 'bad');
    if (f.note) b += note(esc(f.note), 'warn');
    return b + '</div></article>';
  }).join('');
  return o;
});

section('observations', 'What the diagram tells you', 'Read from the picture', function () {
  var o = p('These follow from the diagram itself &mdash; from a label it carries, a count it gives, or an '
          + 'edge it draws (or does not). Each names its evidence so it can be checked against the file.');
  var order = { high: 0, medium: 1, low: 2 };
  var sorted = D.OBSERVATIONS.slice().sort(function (a, b) { return order[a.sev] - order[b.sev]; });
  o += sorted.map(function (ob) {
    return '<div class="finding f-' + esc(ob.sev) + '">'
      + '<div class="f-top"><b>' + esc(ob.title) + '</b>'
      + '<span class="chip ' + (ob.sev === 'high' ? 'bad' : ob.sev === 'medium' ? 'warn' : 'info') + '">' + esc(ob.sev) + '</span>'
      + provChip(ob.cls) + '</div>'
      + '<p>' + esc(ob.detail) + '</p>'
      + '<p class="f-ev">Evidence: ' + esc(ob.evidence) + '</p>'
      + '</div>';
  }).join('');
  o += note('Severity here means how much the diagram\'s own content points at it, not an assessment of KOEL\'s '
    + 'running estate. A "high" entry is one the picture states plainly &mdash; it may already be mitigated by '
    + 'something the picture does not show.', 'grey');
  return o;
});

section('questions', 'What the diagram does not say', 'Take these to their owners', function () {
  var o = p('Eight things this document cannot answer, with who would know. These are the gaps worth closing '
          + 'before the diagram is used to make a decision.');
  o += '<div class="wf">' + D.OPEN_QUESTIONS.map(function (q, i) {
    return '<div class="wf-step"><div class="wf-n">' + (i + 1) + '</div><div>'
      + '<b>' + esc(q.q) + '</b>'
      + '<p>' + esc(q.why) + '</p>'
      + '<p class="dim" style="font-size:.8125rem">Ask: ' + esc(q.ask) + '</p>'
      + '</div></div>';
  }).join('') + '</div>';
  return o;
});

section('monitoring', 'Where monitoring would go', 'A proposal, not a finding', function () {
  var o = note('<b>This section is a proposal.</b> Nothing below is stated by the diagram. It is what the '
    + 'drawn topology suggests is worth instrumenting, offered so it can be argued with.', 'warn');

  o += p('The diagram has three places where a single failure has estate-wide reach, and they are the natural '
       + 'first three things to watch.');

  var props = [
    ['The integration server', 'All eighteen feeds land here and one bridge leaves it. Per-feed arrival '
      + 'freshness matters more than host health: a feed that stops arriving is invisible unless an expected '
      + 'interval is recorded for it.',
      'Per-feed last-seen time against an expected window; SFTP mount reachability; the bridge into the ERP.'],
    ['The VPN tunnel', 'One encrypted path joins the data centre to the cloud. The diagram shows no second '
      + 'route, so tunnel state is hybrid availability.',
      'Tunnel up/down, both gateway endpoints, round-trip latency across it.'],
    ['The ERP application tier', 'Drawn as a single compute node while everything around it is redundant. '
      + 'Here, host-level metrics genuinely are service availability.',
      'Process liveness, CPU, memory and disk on the one node; the SFTP mount it depends on.'],
    ['Oracle ERP database (2-node RAC)', 'Redundant, so the question is cluster health rather than host health.',
      'Per-instance status, which node is serving, interconnect health, the App-DB connection itself.'],
    ['Siebel stack', 'Twelve servers across five tiers. Tier-level aggregation is more informative than twelve '
      + 'separate host alarms.',
      'Count of healthy members per tier; the dedicated database pair; the ERP cross-link.'],
    ['ODI and ADW', 'Batch, not request/response. A pipeline that silently stops produces stale answers rather '
      + 'than errors.',
      'ETL run completion and duration; warehouse load freshness; the Siebel sync.'],
  ];
  o += grid(props.map(function (x) {
    return '<article class="dcard"><div class="dcard-h"><b>' + esc(x[0]) + '</b></div>'
      + '<div class="dcard-b"><p>' + esc(x[1]) + '</p>'
      + '<p class="m-sub">Worth watching</p><p>' + esc(x[2]) + '</p></div></article>';
  }), 'c2');

  o += note('Four components have no edges drawn &mdash; the SQL Server cluster, the PLM database, the HSM and '
    + 'anything behind the public load balancer. They cannot be placed in a monitoring plan until the open '
    + 'questions above are answered, because what matters about a system depends on what depends on it.', 'grey');
  return o;
});

/* ── the 3D hero: an explorable level stack ─────────────────────────────── */

var renderer, scene, camera, camCtl, raycaster, clock, world, labels;
var ctx = null;             // the live environment's build context
var stack = [];             // breadcrumb: [{env, label}]
var hovered = null, highlighted = null, pointer = null;
var drag = { on: false, x: 0, y: 0, moved: 0 };

/** Which documentation section a node belongs to. */
function sectionFor(node) {
  if (!node) return 'overview';
  switch (node.kind) {
    case 'zone': return node.id === 'thirdparty' ? 'feeds' : node.id === 'onprem' ? 'onprem' : 'oci';
    case 'feed': return 'feeds';
    case 'onprem': return 'onprem';
    // The Siebel tiers are drawn inside the OCI private subnet but
    // documented in their own section, so they must land there.
    case 'oci': return String(node.id).indexOf('siebel') === 0 ? 'siebel' : 'oci';
    case 'siebel': return 'siebel';
    case 'flow': return 'flows';
    default: return 'overview';
  }
}

/** Which deeper environment a node opens, if any. */
function childEnv(node) {
  if (!node) return null;
  if (node.kind === 'zone') return EV.ZONE_ENVS[node.id] || null;
  if (node.kind === 'oci' && String(node.id).indexOf('siebel') === 0) return 'siebel';
  return null;
}

function newCtx() {
  if (ctx) { KS.disposeGroup(ctx.group); world.remove(ctx.group); }
  labels.clear();
  var g = new THREE.Group();
  world.add(g);
  ctx = { group: g, picks: [], flows: [], spinners: [], pulsers: [], labels: labels, data: D };
  return ctx;
}

function enter(envName, label, instant) {
  var fn = EV[envName];
  if (!fn) return;
  var c = newCtx();
  var meta;
  try {
    meta = fn(c) || {};
  } catch (err) {
    if (window.console && console.warn) console.warn('[koel] environment "' + envName + '" failed:', err);
    // Recover to the estate rather than leaving an empty canvas, unless the
    // estate is what just failed — then drop to the flat fallback.
    if (envName !== 'estate') { enter('estate', 'Estate', true); return; }
    goFlat();
    return;
  }
  hovered = null; highlighted = null;

  var top = stack[stack.length - 1];
  if (!top || top.env !== envName) stack.push({ env: envName, label: label || meta.title || envName });
  if (stack.length > 4) stack.splice(1, 1);

  if (meta.limits) camCtl.setLimits(meta.limits[0], meta.limits[1]);
  if (scene.fog && meta.fog) scene.fog.density = meta.fog;
  if (meta.pose) {
    if (instant || reduced || !GS) camCtl.jump(meta.pose);
    else camCtl.travel(meta.pose, { duration: 1.15 });
  }
  $('#heroTitle').textContent = meta.title || '';
  $('#heroSub').textContent = meta.subtitle || '';
  drawCrumbs();
}

function drawCrumbs() {
  var bar = $('#crumbs');
  bar.innerHTML = '';
  stack.forEach(function (s, i) {
    if (i) bar.appendChild(el('span', 'cr-sep', '&rsaquo;'));
    var b = el('button', 'cr' + (i === stack.length - 1 ? ' on' : ''), esc(s.label));
    b.onclick = function () {
      if (i === stack.length - 1) return;
      stack = stack.slice(0, i);
      enter(s.env, s.label);
    };
    bar.appendChild(b);
  });
  $('#heroBack').style.display = stack.length > 1 ? '' : 'none';
}

function goUp() {
  if (stack.length < 2) return;
  var prev = stack[stack.length - 2];
  stack = stack.slice(0, stack.length - 2);
  enter(prev.env, prev.label);
}

function initHero() {
  var canvas = $('#heroCanvas');
  renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setClearColor(0x04060d, 1);

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x04060d, 0.0034);
  camera = new THREE.PerspectiveCamera(45, 1, 0.5, 2000);
  camCtl = new KS.Camera(camera);
  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2(-2, -2);
  clock = new THREE.Clock();
  labels = new KS.Labels($('#heroLabels'));
  resize();

  scene.add(new THREE.AmbientLight(0x22406e, 1.6));
  var k = new THREE.DirectionalLight(0xa8dcff, 1.05); k.position.set(40, 80, 40); scene.add(k);
  var r2 = new THREE.DirectionalLight(0xf0a07c, 0.55); r2.position.set(-60, -20, -40); scene.add(r2);
  var pl = new THREE.PointLight(0x35c3f3, 1.6, 420); pl.position.set(0, 20, 0); scene.add(pl);

  world = new THREE.Group(); scene.add(world);
  enter('estate', 'Estate', true);

  window.addEventListener('resize', resize);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', function (e) { drag.on = true; drag.moved = 0; drag.x = e.clientX; drag.y = e.clientY; });
  window.addEventListener('pointerup', onUp);
  canvas.addEventListener('wheel', function (e) {
    // This is a long document; trapping the wheel would make the page feel
    // broken. Zoom needs a modifier.
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    camCtl.zoom(e.deltaY * 0.0014);
  }, { passive: false });
  canvas.addEventListener('pointerleave', function () { pointer.set(-2, -2); });
  tick();
}

function resize() {
  if (!renderer) return;
  var box = $('#hero').getBoundingClientRect();
  renderer.setSize(box.width, box.height, false);
  frameUnderCopy(box.width, Math.max(1, box.height));
}

/** The hero's title block occupies the top third of the frame, so a scene
    centred on the viewport puts its captions straight through the headline.
    Shift the camera's optical centre downward — render the hero as the TOP
    slice of a taller virtual frame — so the estate settles into the clear
    space beneath the copy. The offset lives in the projection matrix, so
    picking and label placement follow it automatically. */
function frameUnderCopy(w, h) {
  if (!camera) return;
  var drop = Math.min(300, h * 0.32);
  if (drop > 8) {
    camera.aspect = w / (h + drop);
    camera.setViewOffset(w, h + drop, 0, 0, w, h);
  } else {
    if (camera.clearViewOffset) camera.clearViewOffset();
    camera.aspect = w / h;
  }
  camera.updateProjectionMatrix();
}

function onMove(e) {
  if (!pointer || !renderer) return;
  var box = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - box.left) / box.width) * 2 - 1;
  pointer.y = -((e.clientY - box.top) / box.height) * 2 + 1;
  if (drag.on) {
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    camCtl.nudge(dx * 0.005, dy * 0.004);
    drag.x = e.clientX; drag.y = e.clientY;
  }
}

function onUp() {
  if (drag.on && drag.moved < 6 && pointer && ctx) {
    raycaster.setFromCamera(pointer, camera);
    var hit = raycaster.intersectObjects(ctx.picks, false)[0];
    if (hit) select(hit.object.userData.node);
  }
  drag.on = false;
}

/** The required interaction. A zone descends a level AND scrolls to its
    documentation; everything else scrolls to its own entry and flashes it.
    Never a panel, never a modal, never a second click. */
function select(node) {
  if (!node) return;
  highlighted = node;
  var sec = sectionFor(node);
  var child = childEnv(node);
  if (child) {
    enter(child, node.label);
    goToSection(sec, null);
  } else {
    goToSection(sec, cardIdFor(node));
  }
}

function cardIdFor(node) {
  if (node.kind === 'feed') return 'c-' + node.id;      // c-feed-<i>
  return 'c-' + node.id;
}

function tick() {
  requestAnimationFrame(tick);
  if (!renderer || !ctx) return;
  var dt = Math.min(0.05, clock.getDelta()), t = clock.elapsedTime;
  camCtl.step(dt, reduced);

  if (!reduced) {
    ctx.spinners.forEach(function (s) { s.obj.rotation.y += dt * s.speed; });
    ctx.pulsers.forEach(function (u) { var v = u.base + Math.sin(t * u.rate) * u.amt; u.obj.scale.set(v, v, v); });
    if (ctx.flows.length) KS.stepFlows(ctx.flows, t);
  }

  if (pointer) {
    raycaster.setFromCamera(pointer, camera);
    var h = raycaster.intersectObjects(ctx.picks, false)[0];
    var obj = h ? h.object : null;
    if (obj !== hovered) {
      hovered = obj;
      renderer.domElement.style.cursor = obj ? 'pointer' : 'grab';
    }
  }

  var selGroup = null;
  if (highlighted) {
    ctx.picks.forEach(function (pk) { if (pk.userData.node.id === highlighted.id) selGroup = pk.userData.group; });
  }
  labels.update(camCtl, camera, renderer,
    hovered ? hovered.userData.group : null, selGroup, ctx.picks, raycaster);

  renderer.render(scene, camera);
}

/* ── page assembly ──────────────────────────────────────────────────────── */

function buildPage() {
  var main = $('#doc');
  SECTIONS.forEach(function (s) {
    var sec = el('section', 'sect');
    sec.id = 'sec-' + s.id;
    sec.setAttribute('tabindex', '-1');
    sec.innerHTML = '<div class="s-wrap">'
      + '<p class="s-kicker">' + esc(s.kicker) + '</p>'
      + '<h2 class="s-title">' + esc(s.title) + '</h2>'
      + '<div class="s-body">' + s.build() + '</div>'
      + '<button class="s-top">Back to the top &uarr;</button>'
      + '</div>';
    main.appendChild(sec);
  });
  $$('.s-top').forEach(function (b) {
    b.onclick = function () { window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' }); };
  });

  var nav = $('#secNav');
  SECTIONS.forEach(function (s) {
    var b = el('button', 'sn', esc(s.title));
    b.dataset.sec = s.id;
    b.onclick = function () { goToSection(s.id, null); };
    nav.appendChild(b);
  });
}

function goToSection(id, cardId) {
  var target = document.getElementById('sec-' + id);
  if (!target) return;
  var card = cardId ? document.getElementById(cardId) : null;
  (card || target).scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: card ? 'center' : 'start' });
  try { target.focus({ preventScroll: true }); } catch (e) { /* older browsers */ }
  markActive(id);
  if (card) {
    card.classList.add('flash');
    setTimeout(function () { card.classList.remove('flash'); }, 1700);
  }
}

function markActive(id) {
  $$('#secNav .sn').forEach(function (b) { b.classList.toggle('on', b.dataset.sec === id); });
}

function watchScroll() {
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) markActive(en.target.id.replace('sec-', ''));
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    SECTIONS.forEach(function (s) {
      var n = document.getElementById('sec-' + s.id);
      if (n) io.observe(n);
    });
  }
  window.addEventListener('scroll', function () {
    $('#toTop').classList.toggle('show', window.scrollY > 900);
  }, { passive: true });
}

/* ── search ─────────────────────────────────────────────────────────────── */

function wireSearch() {
  var input = $('#find'), box = $('#findRes');
  var items = [];
  SECTIONS.forEach(function (s) {
    items.push({ label: s.title, ctx: 'Section', sec: s.id });
    var node = document.getElementById('sec-' + s.id);
    if (!node) return;
    node.querySelectorAll('.dcard-h b, .s-h3, .f-top b, .wf-step b, table.dt tbody b').forEach(function (h) {
      items.push({ label: h.textContent.trim(), ctx: s.title, sec: s.id, el: h });
    });
  });

  input.addEventListener('input', function () {
    var q = input.value.trim().toLowerCase();
    box.innerHTML = '';
    if (!q) { box.classList.remove('show'); return; }
    var words = q.split(/\s+/);
    var hits = items.filter(function (i) {
      var hay = (i.label + ' ' + i.ctx).toLowerCase();
      return words.every(function (w) { return hay.indexOf(w) >= 0; });
    }).slice(0, 14);
    if (!hits.length) {
      box.innerHTML = '<div class="fr-none">Nothing matches &ldquo;' + esc(q) + '&rdquo;</div>';
      box.classList.add('show'); return;
    }
    hits.forEach(function (h) {
      var b = el('button', 'fr', '<b>' + esc(h.label) + '</b><span>' + esc(h.ctx) + '</span>');
      b.onclick = function () {
        box.classList.remove('show'); input.value = '';
        if (h.el) {
          h.el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
          h.el.classList.add('flash');
          setTimeout(function () { h.el.classList.remove('flash'); }, 1700);
          markActive(h.sec);
        } else goToSection(h.sec, null);
      };
      box.appendChild(b);
    });
    box.classList.add('show');
  });
  document.addEventListener('click', function (e) {
    if (!$('#findWrap').contains(e.target)) box.classList.remove('show');
  });
}

/* ── flat fallback: the hero becomes buttons that do the same job ───────── */

function goFlat() {
  HAS3D = false;
  $('#hero').classList.add('flat');
  var fb = $('#heroFallback');
  if (fb.childElementCount) return;
  var entries = D.ZONES.map(function (z) { return { label: z.label, blurb: z.what, sec: z.id === 'thirdparty' ? 'feeds' : z.id }; });
  entries.push({ label: 'Siebel Cloud CRM Stack', blurb: 'Twelve servers across five tiers.', sec: 'siebel' });
  entries.push({ label: 'Data flows', blurb: 'The eight connections the diagram draws.', sec: 'flows' });
  entries.push({ label: 'What the diagram tells you', blurb: 'Observations read from the picture itself.', sec: 'observations' });
  entries.forEach(function (e2) {
    var b = el('button', 'hfb', '<b>' + esc(e2.label) + '</b><span>' + esc(e2.blurb) + '</span>');
    b.onclick = function () { goToSection(e2.sec, null); };
    fb.appendChild(b);
  });
}

/* ── boot ───────────────────────────────────────────────────────────────── */

function boot() {
  if (!D) {
    var step = $('#ldStep');
    if (step) step.textContent = 'Content failed to load — koel-data.js is missing.';
    return;
  }
  buildPage();
  watchScroll();
  wireSearch();

  $('#toTop').onclick = function () { window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' }); };
  $('#heroScroll').onclick = function () { goToSection(SECTIONS[0].id, null); };
  $('#heroBack').onclick = goUp;
  $('#brandBtn').onclick = function () { window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' }); };
  $('#motionBtn').onclick = function () {
    reduced = !reduced;
    document.body.classList.toggle('reduced', reduced);
    $('#motionBtn').textContent = reduced ? 'Motion reduced' : 'Reduce motion';
    $('#motionBtn').classList.toggle('on', reduced);
  };
  $('#printBtn').onclick = function () { window.print(); };

  document.addEventListener('keydown', function (e) {
    if (e.target && e.target.tagName === 'INPUT') {
      if (e.key === 'Escape') { e.target.value = ''; $('#findRes').classList.remove('show'); e.target.blur(); }
      return;
    }
    if (e.key === '/') { e.preventDefault(); $('#find').focus(); }
    if (e.key === 'Escape' || e.key === 'Backspace') goUp();
    if (e.key === 'Home' || e.key === '0') window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
  });

  if (reduced) {
    document.body.classList.add('reduced');
    $('#motionBtn').classList.add('on');
    $('#motionBtn').textContent = 'Motion reduced';
  }

  if (HAS3D) {
    try { initHero(); }
    catch (err) {
      if (window.console && console.warn) console.warn('[koel] hero failed, showing the flat header:', err);
      goFlat();
    }
  }
  if (!HAS3D) goFlat();

  $('#loader').classList.add('gone');
  setTimeout(function () { $('#loader').style.display = 'none'; }, 600);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
