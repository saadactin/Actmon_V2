/* ===========================================================================
   ACTMON Knowledge Centre — long-form page.

   Layout contract, which is the point of this file:

     [ 3D hero, full viewport height ]
     [ sticky section nav             ]
     [ full-width documentation section, one per domain, stacked vertically ]

   Clicking a node in the hero highlights it and SMOOTH-SCROLLS the page down
   to that domain's section. The documentation is never in a side panel, never
   in a drawer, never in a modal, and never behind a second "enter" click.

   Content comes from the data modules; this file owns layout and interaction
   only. Classic script so the page opens from file://.
   =========================================================================== */
(function () {
'use strict';

var D = window.ACTMON;
var SM = window.ACTMON_SAMPLES;
var EN = window.ACTMON_ENGINES;
var MX = window.ACTMON_METRICS;
var AS = window.AScene;
var HAS3D = typeof THREE !== 'undefined' && !!AS;
var GS = typeof gsap !== 'undefined' ? gsap : null;

var $ = function (s) { return document.querySelector(s); };
var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
function el(t, c, h) { var n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

var STATUS = {
  verified: { label: 'Verified', cls: 'ok' },
  implemented: { label: 'Implemented', cls: 'ok' },
  partial: { label: 'Partial', cls: 'warn' },
  'no-data': { label: 'No data source yet', cls: 'warn' },
  illustrative: { label: 'Illustrative', cls: 'info' },
  unverified: { label: 'Not verified', cls: 'grey' },
  planned: { label: 'Planned', cls: 'grey' },
  none: { label: 'Not implemented', cls: 'bad' },
};
function chip(s, extra) {
  var m = STATUS[s] || STATUS.illustrative;
  // Never colour alone: each chip carries its word as well as its colour.
  return '<span class="chip ' + m.cls + (extra ? ' ' + extra : '') + '" data-status="' + s + '">' + m.label + '</span>';
}

/* ── the sections, in the order the brief specifies ─────────────────────── */

var SECTIONS = [];

function section(id, title, kicker, build, nodeId) {
  SECTIONS.push({ id: id, title: title, kicker: kicker, build: build, nodeId: nodeId });
}

/* small builders ------------------------------------------------------- */

function h3(t) { return '<h3 class="s-h3">' + esc(t) + '</h3>'; }
function p(t) { return '<p>' + esc(t) + '</p>'; }
function note(t, tone) { return '<div class="note' + (tone ? ' ' + tone : '') + '">' + t + '</div>'; }
function code(t) { return '<pre class="code">' + esc(t) + '</pre>'; }
function list(items) { return '<ul class="list">' + items.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('') + '</ul>'; }

function grid(cards, cls) {
  return '<div class="cards ' + (cls || '') + '">' + cards.join('') + '</div>';
}
function card(title, body, status, sub) {
  return '<div class="dcard"' + (status ? ' data-status="' + status + '"' : '') + '>'
    + '<div class="dcard-h"><b>' + esc(title) + '</b>' + (status ? chip(status) : '') + '</div>'
    + (sub ? '<p class="dcard-sub">' + esc(sub) + '</p>' : '')
    + '<div class="dcard-b">' + body + '</div></div>';
}
function kv(rows) {
  return '<dl class="kv">' + rows.map(function (r) {
    return '<dt>' + esc(r[0]) + '</dt><dd' + (r[2] ? ' class="v-' + r[2] + '"' : '') + '>' + esc(r[1]) + '</dd>';
  }).join('') + '</dl>';
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

/** A flow diagram, drawn in markup rather than imported as an image so it
    stays readable, selectable and printable. */
function flow(steps) {
  return '<div class="flow">' + steps.map(function (s, i) {
    return '<div class="flow-step"' + (s.tone ? ' data-tone="' + s.tone + '"' : '') + '>'
      + '<span class="flow-n">' + (i + 1) + '</span>'
      + '<b>' + esc(s.t) + '</b><span>' + esc(s.b) + '</span></div>'
      + (i < steps.length - 1 ? '<div class="flow-arrow" aria-hidden="true">&rarr;</div>' : '');
  }).join('') + '</div>';
}

/** The brief's metric template, rendered in full. */
function metricCard(m) {
  var findings = (m.findings || []).map(function (f) {
    return '<div class="finding f-' + esc(f.severity) + '">'
      + '<div class="f-top">' + chip(f.severity === 'high' ? 'none' : f.severity === 'medium' ? 'partial' : 'illustrative')
      + '<b>' + esc(f.title) + '</b></div>'
      + '<p>' + esc(f.detail) + '</p>'
      + '<p class="f-ev"><span class="dim">evidence: </span>' + esc(f.evidence) + '</p>'
      + '<p class="f-im"><span class="dim">why it matters: </span>' + esc(f.impact) + '</p>'
      + '</div>';
  }).join('');

  return '<article class="metric" id="metric-' + esc(m.id) + '" data-status="' + esc(m.status) + '">'
    + '<header class="m-head"><h4>' + esc(m.label) + '</h4>' + chip(m.status) + '</header>'
    + '<div class="m-grid">'
    + '<div class="m-col">'
    + '<p class="m-lede">' + esc(m.business) + '</p>'
    + '<div class="m-field"><span>Technical definition</span><p>' + esc(m.technical) + '</p></div>'
    + '<div class="m-field"><span>Scope — what population is measured</span><p>' + esc(m.scope) + '</p></div>'
    + '<div class="m-field"><span>Data source</span><p>' + esc(m.source) + '</p></div>'
    + '<div class="m-field"><span>Collection method</span><p>' + esc(m.collection) + '</p></div>'
    + '</div>'
    + '<div class="m-col">'
    + '<div class="m-field"><span>Calculation</span>' + code(m.formula)
    + '<p class="srcline">' + esc(m.formulaRef) + '</p></div>'
    + '<div class="m-field"><span>Units</span><p>' + esc(m.units) + '</p></div>'
    + '<div class="m-field"><span>Aggregation &amp; time window</span><p>' + esc(m.aggregation) + '</p><p>' + esc(m.window) + '</p></div>'
    + '</div>'
    + '</div>'
    + '<div class="m-field"><span>How to read it</span>' + kv(m.interpretation) + '</div>'
    + '<div class="m-field"><span>Worked example</span>' + code(m.example) + '</div>'
    + '<div class="m-two">'
    + '<div class="m-field"><span>How to verify it yourself</span><p>' + esc(m.verify) + '</p></div>'
    + '<div class="m-field"><span>Troubleshooting</span>' + list(m.troubleshooting) + '</div>'
    + '</div>'
    + (m.note ? note(esc(m.note)) : '')
    + (findings ? '<div class="m-field"><span>Findings from the trace</span>' + findings + '</div>' : '')
    + '<details class="m-src"><summary>Implementation evidence</summary>' + list(m.evidence) + '</details>'
    + '</article>';
}

/* ── section content ────────────────────────────────────────────────────── */

section('overview', 'What ACTMON is', 'The platform', function () {
  return p('ACTMON monitors three things that are normally three separate tools: the database, the host it '
    + 'runs on, and the cloud account that pays for it. One estate, one place to look, one set of alerts.')
    + p('It is built for the people who get paged — database administrators, infrastructure engineers and '
      + 'the managers who need evidence rather than assurances.')
    + note('<b>Everything on this page was read out of the ACTMON source before it was written down.</b> '
      + 'Each claim names the file it came from. Where a trace could not be completed, it says so rather than '
      + 'filling the gap.')
    + h3('The problems it addresses')
    + grid([
      card('Three tools, three truths', p('Database metrics in one tool, host metrics in another, cloud inventory in a third. Correlating an incident means three logins and a guess.'), null),
      card('Invisible failures', p('A blocked query burns no CPU. A stopped replica is silent until you need it. A WAL archive fills a disk weeks after the first warning.'), null),
      card('Unowned cloud drift', p('Resources are created faster than anyone tracks. You cannot monitor or cost-control what nobody knew existed.'), null),
      card('Evidence, not opinion', p('"The database is slow" becomes a specific statement about a specific object, with the number that proves it.'), null),
    ])
    + h3('The seven monitoring domains')
    + grid(D.MODULES.map(function (m) {
      return card(m.label, p(m.blurb) + '<p class="srcline">' + esc(m.src) + '</p>', m.status, m.route);
    }), 'c3')
    + h3('Also in the product')
    + p(D.SUPPORT_MODULES.map(function (s) { return s.label + ' (' + s.route + ') — ' + s.note; }).join(' · '));
});

section('architecture', 'Platform architecture', 'How it fits together', function () {
  return p('ACTMON reaches a monitored system in one of three ways, and which one applies is decided in code '
    + 'rather than by configuration preference.')
    + flow([
      { t: 'Monitored system', b: 'A database, a host, or a cloud account' },
      { t: 'Collection', b: 'Installed agent, SSH, or a provider API' },
      { t: 'ACTMON backend', b: 'FastAPI services, classification' },
      { t: 'Storage', b: 'Redis hot tier, ClickHouse history, PostgreSQL config' },
      { t: 'Dashboard', b: 'React frontend reading the API' },
      { t: 'Alerts', b: 'Rule evaluation, then notification' },
    ])
    + note('This flow is <b>verified</b> against services/common/metrics_pipeline.py and '
      + 'services/common/db_proxy_service.py. It is not an illustrative diagram.', 'ok')
    + h3('The three collection methods')
    + grid([
      card('Installed agent', p(D.COLLECTION.agent.detail) + list(D.COLLECTION.agent.platforms)
        + p('Enrolment: ' + D.COLLECTION.agent.enrol) + '<p class="srcline">' + esc(D.COLLECTION.agent.src) + '</p>', 'implemented'),
      card('Server-direct', p(D.COLLECTION.direct.detail) + note(esc(D.COLLECTION.direct.rule), 'warn')
        + p(D.COLLECTION.direct.why) + '<p class="srcline">' + esc(D.COLLECTION.direct.src) + '</p>', 'partial'),
      card('Provider API', p('Cloud monitoring authenticates to the provider and walks its regions. Nothing is installed on the cloud side at all.'), 'implemented'),
    ], 'c3')
    + note(esc(D.COLLECTION.note), 'warn')
    + h3('Where monitoring data is stored')
    + table(['Tier', 'Technology', 'What lives there'],
      D.PIPELINE.tiers.map(function (t) { return [t.label, t.id === 'hot' ? 'Redis' : t.id === 'cold' ? 'ClickHouse' : t.id === 'durable' ? 'PostgreSQL' : '—', t.detail]; }))
    + note(esc(D.PIPELINE.note))
    + '<p class="srcline">' + esc(D.PIPELINE.src) + '</p>';
}, 'agents');

section('dashboard', 'Dashboard &amp; KPI dictionary', 'Every number, traced', function () {
  var intro = p('Every metric below was followed from its label in the UI, through the calculation, to the '
    + 'field it reads. The template is the same for all of them: what it means, what it measures, where the '
    + 'number comes from, the formula, how to read it, how to check it yourself, and what to do when it '
    + 'looks wrong.')
    + note('<b>Read this first.</b> Several of these metrics mean something narrower than their label '
      + 'suggests, and three carry findings that would change how you act on them. Those are stated on the '
      + 'metric, not hidden in a footnote.', 'warn');

  var byGroup = { counts: [], resources: [], charts: [], behaviour: [] };
  MX.METRICS.forEach(function (m) { (byGroup[m.group] || byGroup.counts).push(m); });

  var out = intro;
  [['counts', 'Headline counts'], ['resources', 'Resource gauges'],
   ['charts', 'Charts and feeds'], ['behaviour', 'Refresh behaviour']].forEach(function (g) {
    if (!byGroup[g[0]].length) return;
    out += h3(g[1]) + byGroup[g[0]].map(metricCard).join('');
  });

  out += h3('What the trace could not establish')
    + note('These are listed rather than guessed. Each names the file to read next.', 'grey')
    + table(['Item', 'Why it is open', 'Where to look'],
      MX.UNVERIFIED.map(function (u) { return [u.item, u.why, u.read]; }));
  return out;
});

section('database', 'Database monitoring', 'Eight technologies', function () {
  var engines = D.ENGINES.map(function (e) {
    var meta = EN.ENGINE_TABS[e.id];
    var n = e.id === 'postgresql' ? D.PG_TABS.filter(function (t) { return !t.virtual; }).length
      : meta ? meta.tabs.length : 0;
    return card(e.label,
      p(e.note)
      + kv([['Route', e.route], ['Sections', String(n)], ['Reach', e.direct ? 'agent or server-direct' : 'agent only']])
      + (meta && meta.shared ? note(esc(meta.shared), 'warn') : '')
      + (meta && meta.note ? note(esc(meta.note)) : '')
      + '<p class="srcline">' + esc(e.src) + '</p>',
      e.status);
  });

  var notSupported = D.NOT_ENGINES.map(function (n) {
    return card(n.label, p(n.detail), 'none', n.verdict);
  });

  var pgTabs = table(['Section', 'What it does', 'Why it matters'],
    D.PG_TABS.map(function (t) { return [t.label, t.what, t.why]; }));

  var otherTabs = Object.keys(EN.ENGINE_TABS).map(function (id) {
    var e = D.ENGINES.filter(function (x) { return x.id === id; })[0];
    if (!e) return '';
    return '<details class="eng"><summary><b>' + esc(e.label) + '</b> — '
      + EN.ENGINE_TABS[id].tabs.length + ' sections</summary>'
      + table(['Section', 'What it does', 'Why it matters'],
        EN.ENGINE_TABS[id].tabs.map(function (t) {
          return [t.label + (t.conditional ? ' (conditional)' : ''), t.what, t.why];
        }))
      + '</details>';
  }).join('');

  return p('Seven engines have a dashboard of their own; MariaDB rides the MySQL path. Each dashboard is '
    + 'built around what that engine actually exposes, in that engine\'s own vocabulary — SQL Server says '
    + 'Logins and Always On, MongoDB says Collections, and renaming them would misrepresent the product.')
    + grid(engines, 'c3')
    + h3('Explicitly not supported')
    + grid(notSupported, 'c2')
    + h3('PostgreSQL — the one traced section by section')
    + pgTabs
    + h3('The other engines, section by section')
    + note(esc(EN.ENGINE_DEPTH_NOTE), 'warn')
    + otherTabs;
}, 'database');

section('infrastructure', 'Infrastructure monitoring', 'The host underneath', function () {
  return p('Most "database problems" are host problems. A query that got slower because the disk got slower '
    + 'is only diagnosable if both are visible from the same tool.')
    + h3('Host detail sections')
    + grid(D.INFRA_TABS.map(function (t) { return card(t.label, p(t.what), 'implemented'); }), 'c3')
    + h3('History')
    + p(D.INFRA_EXTRA.ranges)
    + p(D.INFRA_EXTRA.fileExplorer)
    + h3('Relating host health to database health')
    + note(esc(D.INFRA_EXTRA.correlation), 'warn')
    + h3('Illustrative host')
    + grid(SM.SAMPLE_HOST.gauges.map(function (g) {
      return card(g.label, '<p class="big">' + g.value + g.unit + '</p>', 'illustrative');
    }), 'c4')
    + note(esc(SM.SAMPLE_HOST.note), 'warn');
}, 'infra');

section('cloud', 'Cloud monitoring', 'Three providers', function () {
  var cards = D.PROVIDERS.map(function (pv) {
    return card(pv.label,
      p(pv.auth)
      + '<p class="m-sub">Resource types discovered</p>'
      + '<div class="chips">' + pv.resources.map(function (r) { return '<span class="chip">' + esc(r) + '</span>'; }).join('') + '</div>'
      + note(esc(pv.cost), 'warn')
      + p(pv.note)
      + '<p class="srcline">' + esc(pv.src) + '</p>',
      pv.status);
  });
  return p('A separate microservice authenticates to a cloud account, walks its regions and inventories what '
    + 'is running. Three providers are implemented.')
    + grid(cards, 'c3')
    + note('<b>' + esc(D.NOT_ENGINES[1].label) + ' — ' + esc(D.NOT_ENGINES[1].verdict) + '.</b> '
      + esc(D.NOT_ENGINES[1].detail), 'bad')
    + h3('Account, resource, monitored resource — three different things')
    + table(['Term', 'What it means here'], [
      ['Registered account', 'A credential set ACTMON can authenticate with. This is what the Cloud Accounts tile counts.'],
      ['Discovered resource', 'Something the scanner found during a region walk.'],
      ['Active resource', 'A discovered resource whose provider state says it is running.'],
      ['Monitored resource', 'A resource ACTMON collects metrics for. Discovery alone does not imply this.'],
    ])
    + note('The dashboard tile counts <b>registered accounts</b>. An account with ten thousand discovered '
      + 'resources still counts as one.', 'warn');
}, 'cloud');

section('alerts', 'Alerts &amp; notifications', 'What can actually fire', function () {
  return p('Rules are evaluated against collected data and delivered through nine channels. The catalogue '
    + 'is candid about which rules the backend can actually raise, and that candour is the most important '
    + 'thing on this page.')
    + h3('The three evaluation tiers')
    + grid(D.ALERT_TIERS.map(function (t) {
      return card(t.label + ' — ' + t.count + ' rule types',
        p(t.detail) + '<div class="chips">' + t.examples.map(function (x) { return '<span class="chip">' + esc(x) + '</span>'; }).join('') + '</div>',
        t.id === 'reserved' ? 'no-data' : 'implemented');
    }), 'c3')
    + note('<b>' + esc(D.ALERT_NOTE) + '</b>', 'bad')
    + h3('The lifecycle')
    + flow([
      { t: 'Collect', b: 'A sample arrives from an agent or a direct read' },
      { t: 'Evaluate', b: 'A rule is checked — if its tier permits' },
      { t: 'Raise', b: 'An alert is created with a severity' },
      { t: 'Notify', b: 'Delivered through the configured channels' },
      { t: 'Investigate', b: 'The operator opens the affected resource' },
      { t: 'Resolve', b: 'A human decides and acts' },
    ])
    + h3('Notification channels')
    + grid(D.CHANNELS.map(function (c) { return card(c.label, p(c.detail), 'implemented'); }), 'c3')
    + note('Channel secrets — webhook URLs, bot tokens, access tokens — are stored by the product and are '
      + 'not reproduced anywhere in this document.', 'ok');
}, 'alerts');

section('security', 'Administration, access &amp; security', 'The containment boundary', function () {
  return p('A monitoring tool holds credentials for every production database in the estate. Access control '
    + 'is not an afterthought here, it is the containment boundary.')
    + h3('The permission model')
    + p(D.RBAC.model)
    + table(['Permission', 'Bit value'], D.RBAC.bits.map(function (b) { return [b.label, String(b.value)]; }))
    + p(D.RBAC.composite)
    + h3('Why page registration matters')
    + note(esc(D.RBAC.ungoverned), 'warn')
    + h3('Credentials')
    + note(esc(D.RBAC.credentials), 'ok')
    + p(D.RBAC.audit);
}, 'admin');

section('logs', 'Logs, history &amp; retention', 'What the log tells you', function () {
  return p('Metrics tell you something changed. The log usually tells you what. A checkpoint storm and a '
    + 'deadlock look identical in a graph of transaction latency.')
    + h3('Illustrative log events')
    + table(['Time', 'Severity', 'Message', 'SQLSTATE'],
      SM.SAMPLE_LOGS.map(function (l) { return [l.t, l.sev, l.msg, l.state || '—']; }))
    + note('Illustrative sample — not live data.', 'info')
    + h3('Retention')
    + p('The two-tier pipeline decides how long a number survives: Redis holds the latest value plus a '
      + 'one-hour ring, and ClickHouse holds the per-technology history. Configuration, roles and audit '
      + 'records live in ACTMON\'s own PostgreSQL database.')
    + note('Exact retention windows are a deployment configuration rather than a product constant, and were '
      + 'not traced to a setting. Treat the tiering as verified and the durations as deployment-specific.', 'grey');
}, 'logs');

section('workflows', 'Example workflows', 'How it is actually used', function () {
  var w = D.WALKTHROUGHS;
  return Object.keys(w).map(function (k) {
    var x = w[k];
    return '<div class="wf">' + h3(x.title)
      + note(esc(x.subtitle), 'info')
      + x.steps.map(function (s, i) {
        return '<div class="wf-step"><span class="wf-n">' + (i + 1) + '</span><div><b>' + esc(s.t) + '</b>'
          + '<p>' + esc(s.b) + '</p>' + (s.code ? code(s.code) : '') + '</div></div>';
      }).join('')
      + '</div>';
  }).join('');
});

section('status', 'Implementation status &amp; limitations', 'Stated, not implied', function () {
  var rows = [];
  D.MODULES.forEach(function (m) { rows.push([m.label, { html: chip(m.status) }, m.route, m.src]); });
  D.ENGINES.forEach(function (e) { rows.push([e.label, { html: chip(e.status) }, e.route, e.src]); });
  D.PROVIDERS.forEach(function (pv) { rows.push([pv.label, { html: chip(pv.status) }, 'cloud provider', pv.src]); });
  D.NOT_ENGINES.forEach(function (n) { rows.push([n.label, { html: chip('none') }, n.verdict, '—']); });

  return p('Every documented item carries one of these marks. Colour is never the only signal — each chip '
    + 'carries its word too.')
    + '<div class="legend">' + ['verified', 'partial', 'no-data', 'illustrative', 'unverified', 'none']
      .map(function (k) { return chip(k); }).join('') + '</div>'
    + table(['Item', 'Status', 'Route / verdict', 'Source'], rows)
    + h3('Known limitations of this document')
    + list([
      'Verified against branch actmon_sept22. It will drift as the product changes; every claim names its source file so re-checking is mechanical.',
      'PostgreSQL is the one engine traced section by section. For the others the section list is verified and each entry explains what that section is for, not every control inside it.',
      'Retention durations are deployment configuration and were not traced to a setting.',
      'The three items in the dashboard section marked "Not verified" name the file to read next.',
      'All metrics, hostnames, queries and log lines used as examples are illustrative. Nothing is read from a live installation.',
    ]);
});

section('glossary', 'Glossary', 'Plain English first', function () {
  var terms = [
    ['Agent', 'A small collector process installed on a monitored host. It reports host metrics and can proxy database queries from the host itself.'],
    ['Server-direct', 'ACTMON connecting straight to a database from its own server, with nothing installed on the target. Attempted only for MySQL, MariaDB and PostgreSQL, and never when the host is loopback.'],
    ['Collector', 'Whatever produces a metric sample — an agent, an SSH session, or a cloud provider API.'],
    ['Hot tier', 'Redis. Holds the latest value plus a one-hour ring. This is what a live dashboard reads.'],
    ['History tier', 'ClickHouse. Per-module, per-technology tables holding what the hot tier displaced.'],
    ['Evaluation tier', 'Whether an alert rule can actually fire: live, agent-reported, or no data source yet.'],
    ['Effective privilege', 'What a database role can actually do, counting direct grants, inherited grants, PUBLIC and ownership — rarely the same as what was granted to it by name.'],
    ['Illustrative', 'An invented example, included so the document is explorable without a live system. Never a measurement.'],
    ['Page registration', 'Adding a URL to page_master. A URL absent from it is ungoverned, meaning any signed-in user can reach it.'],
  ];
  return table(['Term', 'Meaning'], terms);
});

/* ── the 3D hero ───────────────────────────────────────────────────────── */

var renderer, scene, camera, camCtl, raycaster, clock, world, labels;
var picks = [], flows = [], spinners = [], pulsers = [];
var pointer = null, hovered = null, highlighted = null;
var drag = { on: false, x: 0, y: 0, moved: 0 };

function initHero() {
  var canvas = $('#heroCanvas');
  renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  resize();
  renderer.setClearColor(0x04060d, 1);

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x04060d, 0.0046);
  camera = new THREE.PerspectiveCamera(45, 1, 0.5, 1400);
  camCtl = new AS.Camera(camera);
  camCtl.setLimits(52, 190);
  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2(-2, -2);
  clock = new THREE.Clock();
  labels = new AS.Labels($('#heroLabels'));

  scene.add(new THREE.AmbientLight(0x22406e, 1.6));
  var k = new THREE.DirectionalLight(0xa8dcff, 1.05); k.position.set(40, 70, 40); scene.add(k);
  var r = new THREE.DirectionalLight(0x6f7cf7, 0.6); r.position.set(-50, -20, -40); scene.add(r);
  scene.add(Object.assign(new THREE.PointLight(0x35c3f3, 1.8, 300), { position: new THREE.Vector3(0, 10, 0) }));

  world = new THREE.Group(); scene.add(world);
  buildUniverse();

  window.addEventListener('resize', resize);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', function (e) { drag.on = true; drag.moved = 0; drag.x = e.clientX; drag.y = e.clientY; });
  window.addEventListener('pointerup', onUp);
  canvas.addEventListener('wheel', function (e) {
    // The hero must never swallow page scroll — this is a long document and
    // trapping the wheel would make it feel broken. Zoom only with a modifier.
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
  if (camera) { camera.aspect = box.width / Math.max(1, box.height); camera.updateProjectionMatrix(); }
}

function buildUniverse() {
  var G = AS.G;
  var grid = new THREE.GridHelper(300, 50, 0x1b3358, 0x1b3358);
  grid.material.transparent = true; grid.material.opacity = 0.12; grid.position.y = -22;
  world.add(grid);

  var hub = G.core(0x35c3f3, 1.3);
  world.add(hub);
  spinners.push({ obj: hub.userData.rings, speed: 0.07 });
  pulsers.push({ obj: hub.userData.pulse, base: 1, amt: 0.045, rate: 1.1 });
  labels.add(hub, { name: 'ACTMON', sub: D.META.subtitle, nearAt: 999, midAt: 999, tone: 'accent' });

  var n = D.MODULES.length;
  D.MODULES.forEach(function (m, i) {
    var a = (m.angle || (i / n) * 360) * Math.PI / 180;
    var pos = new THREE.Vector3(Math.cos(a) * 42, 0, Math.sin(a) * 42);
    var g = m.id === 'database' ? G.database(m.color, 1.4)
      : m.id === 'cloud' ? G.cloud(m.color, 1.2)
      : m.id === 'infra' ? G.rack(m.color, 1.2, 0.7)
      : m.id === 'agents' ? G.endpoint(m.color, 1.7)
      : m.id === 'alerts' ? G.beacon(m.color, 1.35)
      : m.id === 'admin' ? G.shield(m.color, 1.25)
      : G.node(m.color, 2);
    g.position.copy(pos);
    if (m.id === 'database' || m.id === 'admin') spinners.push({ obj: g, speed: 0.11 });
    if (m.id === 'alerts') pulsers.push({ obj: g.userData.halo, base: 1, amt: 0.2, rate: 2.1 });

    // The ring that lights up when a node is the current section.
    var halo = new THREE.Mesh(new THREE.TorusGeometry(6.4, 0.11, 8, 64),
      new THREE.MeshBasicMaterial({ color: m.color, transparent: true, opacity: 0 }));
    halo.rotation.x = Math.PI / 2;
    g.add(halo);

    var hit = new THREE.Mesh(new THREE.SphereGeometry(5.6, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
    g.add(hit);
    hit.userData.node = { id: m.id, label: m.label, color: m.color, halo: halo, group: g, section: sectionForNode(m.id) };
    picks.push(hit);

    var anchor = new THREE.Object3D(); anchor.position.y = 6.4; g.add(anchor);
    labels.add(anchor, {
      name: m.label, sub: m.blurb, cta: 'Click to read below',
      tone: 'accent', nearAt: 62, midAt: 180,
    });

    world.add(g);
    var link = AS.link(world, new THREE.Vector3(0, 0, 0), pos, m.color, { flow: true, count: 6, speed: 0.18, lift: 5 });
    if (link.flow) flows.push(link.flow);
  });
}

/** Which documentation section a hero node scrolls to. */
function sectionForNode(id) {
  for (var i = 0; i < SECTIONS.length; i++) if (SECTIONS[i].nodeId === id) return SECTIONS[i].id;
  return { database: 'database', cloud: 'cloud', infra: 'infrastructure', agents: 'architecture',
    alerts: 'alerts', logs: 'logs', admin: 'security' }[id] || 'overview';
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
  if (drag.on && drag.moved < 6 && pointer) {
    raycaster.setFromCamera(pointer, camera);
    var hit = raycaster.intersectObjects(picks, false)[0];
    if (hit) selectNode(hit.object.userData.node);
  }
  drag.on = false;
}

/** The required interaction, in one place: highlight, then scroll the PAGE
    down to that section. No panel, no modal, no second click. */
function selectNode(node) {
  highlight(node);
  goToSection(node.section, true);
}

function highlight(node) {
  picks.forEach(function (pk) {
    var n = pk.userData.node;
    var on = node && n.id === node.id;
    if (n.halo) n.halo.material.opacity = on ? 0.85 : 0;
    if (n.group) n.group.scale.setScalar(on ? 1.12 : 1);
  });
  highlighted = node || null;
  if (node && camCtl && !reduced) {
    var f = node.group.position;
    camCtl.travel({ az: Math.atan2(f.z, f.x) - 0.5, el: 0.34, dist: 78 }, { duration: 1.1 });
  }
}

function tick() {
  requestAnimationFrame(tick);
  if (!renderer) return;
  var dt = Math.min(0.05, clock.getDelta()), t = clock.elapsedTime;
  camCtl.step(dt, reduced);

  if (!reduced) {
    spinners.forEach(function (s) { s.obj.rotation.y += dt * s.speed; });
    pulsers.forEach(function (u) { var v = u.base + Math.sin(t * u.rate) * u.amt; u.obj.scale.set(v, v, v); });
    if (flows.length) AS.stepFlows(flows, t);
  }

  if (pointer) {
    raycaster.setFromCamera(pointer, camera);
    var h = raycaster.intersectObjects(picks, false)[0];
    var obj = h ? h.object : null;
    if (obj !== hovered) {
      hovered = obj;
      renderer.domElement.style.cursor = obj ? 'pointer' : 'grab';
    }
  }

  labels.update(camCtl, camera, renderer,
    hovered ? hovered.userData.node.group : null,
    highlighted ? highlighted.group : null, picks, raycaster);

  renderer.render(scene, camera);
}

/* ── page assembly ─────────────────────────────────────────────────────── */

function buildPage() {
  var main = $('#doc');
  SECTIONS.forEach(function (s) {
    var sec = el('section', 'sect');
    sec.id = 'sec-' + s.id;
    sec.setAttribute('tabindex', '-1');
    sec.innerHTML = '<div class="s-wrap">'
      + '<p class="s-kicker">' + esc(s.kicker) + '</p>'
      + '<h2 class="s-title">' + s.title + '</h2>'
      + '<div class="s-body">' + s.build() + '</div>'
      + '<button class="s-top">Back to the top &uarr;</button>'
      + '</div>';
    main.appendChild(sec);
  });
  $$('.s-top').forEach(function (b) {
    b.onclick = function () {
      window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
      highlight(null);
    };
  });

  var nav = $('#secNav');
  SECTIONS.forEach(function (s) {
    var b = el('button', 'sn', s.title.replace(/&amp;/g, '&'));
    b.dataset.sec = s.id;
    b.onclick = function () { goToSection(s.id, true); };
    nav.appendChild(b);
  });
}

function goToSection(id, withHighlight) {
  var target = document.getElementById('sec-' + id);
  if (!target) return;
  target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  // Focus for keyboard and screen-reader users, without stealing the smooth
  // scroll (preventScroll keeps the browser from jumping).
  try { target.focus({ preventScroll: true }); } catch (e) { /* older browsers */ }
  markActive(id);
  if (withHighlight) {
    var node = null;
    picks.forEach(function (pk) { if (pk.userData.node.section === id) node = pk.userData.node; });
    if (node) highlight(node);
  }
}

function markActive(id) {
  $$('#secNav .sn').forEach(function (b) { b.classList.toggle('on', b.dataset.sec === id); });
}

/** Keeps the sticky nav and the 3D highlight in step with where the reader
    actually is, so scrolling by hand behaves like clicking a node. */
function watchScroll() {
  var secs = SECTIONS.map(function (s) { return document.getElementById('sec-' + s.id); }).filter(Boolean);
  if (!('IntersectionObserver' in window)) return;
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      var id = en.target.id.replace('sec-', '');
      markActive(id);
      var node = null;
      picks.forEach(function (pk) { if (pk.userData.node.section === id) node = pk.userData.node; });
      if (node && node !== highlighted) highlight(node);
      else if (!node) highlight(null);
    });
  }, { rootMargin: '-45% 0px -50% 0px' });
  secs.forEach(function (s) { io.observe(s); });

  window.addEventListener('scroll', function () {
    $('#toTop').classList.toggle('show', window.scrollY > 900);
    $('#secNav').classList.toggle('stuck', window.scrollY > window.innerHeight * 0.8);
  }, { passive: true });
}

/* ── search + status filter ────────────────────────────────────────────── */

function wireSearch() {
  var input = $('#find'), box = $('#findRes');
  var items = [];
  SECTIONS.forEach(function (s) {
    var node = document.getElementById('sec-' + s.id);
    items.push({ label: s.title.replace(/&amp;/g, '&'), ctx: 'Section', sec: s.id });
    if (!node) return;
    node.querySelectorAll('.metric h4, .dcard-h b, .s-h3, .eng summary b').forEach(function (h) {
      items.push({ label: h.textContent.trim(), ctx: s.title.replace(/&amp;/g, '&'), sec: s.id, el: h });
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
    if (!hits.length) { box.innerHTML = '<div class="fr-none">Nothing matches &ldquo;' + esc(q) + '&rdquo;</div>'; box.classList.add('show'); return; }
    hits.forEach(function (h) {
      var b = el('button', 'fr', '<b>' + esc(h.label) + '</b><span>' + esc(h.ctx) + '</span>');
      b.onclick = function () {
        box.classList.remove('show'); input.value = '';
        if (h.el) {
          h.el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
          h.el.classList.add('flash');
          setTimeout(function () { h.el.classList.remove('flash'); }, 1600);
          markActive(h.sec);
        } else goToSection(h.sec, true);
      };
      box.appendChild(b);
    });
    box.classList.add('show');
  });
  document.addEventListener('click', function (e) {
    if (!$('#findWrap').contains(e.target)) box.classList.remove('show');
  });
}

function wireFilters() {
  $$('#statusFilter .sf').forEach(function (b) {
    b.onclick = function () {
      var want = b.dataset.status;
      $$('#statusFilter .sf').forEach(function (x) { x.classList.toggle('on', x === b); });
      document.body.dataset.filter = want;
      var n = want === 'all' ? 0 : $$('[data-status="' + want + '"]').length;
      $('#filterNote').textContent = want === 'all' ? '' : n + ' item' + (n === 1 ? '' : 's') + ' marked ' + (STATUS[want] || {}).label;
    };
  });
}

/* ── boot ──────────────────────────────────────────────────────────────── */

function boot() {
  if (!D || !MX || !EN || !SM) {
    $('#ldStep').textContent = 'Content failed to load — a script is missing.';
    return;
  }
  buildPage();
  watchScroll();
  wireSearch();
  wireFilters();

  $('#toTop').onclick = function () {
    window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
    highlight(null);
  };
  $('#heroScroll').onclick = function () { goToSection(SECTIONS[0].id, false); };
  $('#motionBtn').onclick = function () {
    reduced = !reduced;
    document.body.classList.toggle('reduced', reduced);
    $('#motionBtn').textContent = reduced ? 'Motion reduced' : 'Reduce motion';
    $('#motionBtn').classList.toggle('on', reduced);
  };
  $('#printBtn').onclick = function () { window.print(); };

  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT') {
      if (e.key === 'Escape') { e.target.value = ''; $('#findRes').classList.remove('show'); e.target.blur(); }
      return;
    }
    if (e.key === '/') { e.preventDefault(); $('#find').focus(); }
    if (e.key === 'Home' || e.key === '0') { window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' }); highlight(null); }
    if (e.key === 'Escape') highlight(null);
  });

  if (reduced) {
    document.body.classList.add('reduced');
    $('#motionBtn').classList.add('on');
    $('#motionBtn').textContent = 'Motion reduced';
  }

  if (HAS3D) {
    try { initHero(); }
    catch (err) {
      if (window.console && console.warn) console.warn('[actmon] hero failed, showing the 2D header:', err);
      HAS3D = false;
    }
  }
  if (!HAS3D) {
    $('#hero').classList.add('flat');
    // Without WebGL the hero becomes a plain set of buttons that do exactly
    // what the 3D nodes do — scroll to the section. Nothing is lost but the
    // picture.
    var fb = $('#heroFallback');
    D.MODULES.forEach(function (m) {
      var b = el('button', 'hfb', '<b>' + esc(m.label) + '</b><span>' + esc(m.blurb) + '</span>');
      b.onclick = function () { goToSection(sectionForNode(m.id), false); };
      fb.appendChild(b);
    });
  }

  $('#loader').classList.add('gone');
  setTimeout(function () { $('#loader').style.display = 'none'; }, 600);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
