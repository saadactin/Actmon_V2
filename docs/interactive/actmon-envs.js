/* ===========================================================================
   Environments — one builder per explorable level.

   The contract: a builder receives a context and populates `ctx.group`. It
   returns a descriptor with the camera pose the level opens at, its ambience,
   and the picks/labels it registered. It knows nothing about navigation,
   history or panels.

   Each builder composes a DIFFERENT scene. That is the whole point of the
   rewrite — a level that reuses its parent's layout with a new title is not a
   level. Where a scene shows a quantity, the quantity is mapped to geometry:
   a table's byte count becomes its height, a query's cumulative time becomes
   its radius, a standby's lag becomes the speed of particles on its path.
   =========================================================================== */
(function () {
'use strict';

var AS = window.AScene;
var G = AS.G;
var E = {};

/* ── helpers ───────────────────────────────────────────────────────────── */

function V(x, y, z) { return new THREE.Vector3(x, y, z); }
function ring(n, r, y, startDeg, spanDeg) {
  var out = [], start = (startDeg || 0) * Math.PI / 180;
  var span = (spanDeg == null ? 360 : spanDeg) * Math.PI / 180;
  for (var i = 0; i < n; i++) {
    var a = start + (n === 1 ? 0 : (i / n) * span);
    out.push(V(Math.cos(a) * r, y || 0, Math.sin(a) * r));
  }
  return out;
}
function lerpColor(a, b, t) {
  var ca = new THREE.Color(a), cb = new THREE.Color(b);
  return ca.lerp(cb, t).getHex();
}
var TONE = { ok: 0x3ad39a, warn: 0xf2b23c, bad: 0xff6b7f, info: 0x7cd6f0, neutral: 0x6a7f9f };
function sevColor(s) {
  return s === 'critical' ? 0xff4d67 : s === 'high' ? 0xff6b7f : s === 'medium' ? 0xf2b23c : s === 'low' ? 0x7cd6f0 : 0x6a7f9f;
}

/** A ground plane that gives every environment a floor to sit on — the
    "foreground / middle / background" depth the brief asked for. Different
    per level so entering somewhere genuinely looks different. */
function floor(ctx, color, size, divisions, y) {
  var g = new THREE.GridHelper(size || 260, divisions || 44, color, color);
  g.material.transparent = true;
  g.material.opacity = 0.14;
  g.position.y = y == null ? -16 : y;
  ctx.group.add(g);
  return g;
}

/** A soft horizon disc, for atmosphere at the edge of a level. */
function horizon(ctx, color, r, y) {
  var m = new THREE.Mesh(
    new THREE.RingGeometry(r * 0.72, r, 96),
    new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false })
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = y == null ? -15.6 : y;
  ctx.group.add(m);
}

/** Register an interactive object. */
function pick(ctx, group, node, labelSpec) {
  // Raycast against a single invisible sphere rather than every child: it is
  // one test instead of dozens, and it makes thin geometry (rings, lines)
  // just as easy to hit as a solid block.
  var hit = new THREE.Mesh(
    new THREE.SphereGeometry(labelSpec && labelSpec.hitRadius ? labelSpec.hitRadius : 3.4, 8, 6),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  group.add(hit);
  hit.userData.node = node;
  hit.userData.group = group;
  ctx.picks.push(hit);
  if (labelSpec) {
    var anchor = new THREE.Object3D();
    anchor.position.y = labelSpec.lift == null ? 3.6 : labelSpec.lift;
    group.add(anchor);
    ctx.labels.add(anchor, labelSpec);
  }
  ctx.group.add(group);
  return hit;
}

function spoke(ctx, from, to, color, opts) {
  var l = AS.link(ctx.group, from, to, color, opts);
  if (l.flow) ctx.flows.push(l.flow);
  return l;
}

/* ═══════════════════════════════════════════════════════════════════════
   LEVEL 0 — the ACTMON universe
   ═══════════════════════════════════════════════════════════════════════ */

E.universe = function (ctx) {
  var D = ctx.data;
  floor(ctx, 0x1b3358, 320, 52, -20);
  horizon(ctx, 0x35c3f3, 150, -19.6);

  var hub = G.core(0x35c3f3, 1.25);
  ctx.group.add(hub);
  ctx.spinners.push({ obj: hub.userData.rings, speed: 0.07 });
  ctx.spinners.push({ obj: hub.userData.cage, speed: -0.04 });
  ctx.pulsers.push({ obj: hub.userData.pulse, base: 1, amt: 0.045, rate: 1.1 });
  ctx.labels.add(hub, { name: 'ACTMON', sub: D.META.subtitle, cta: '', nearAt: 999, midAt: 999, tone: 'accent' });

  var pts = ring(D.MODULES.length, 40, 0);
  D.MODULES.forEach(function (m, i) {
    var p = pts[i];
    // Each domain gets its own identity, not the same sphere in a new colour.
    var g;
    switch (m.id) {
      case 'database': g = G.database(m.color, 1.35); break;
      case 'cloud': g = G.cloud(m.color, 1.15); break;
      case 'infra': g = G.rack(m.color, 1.15, 0.72); break;
      case 'agents': g = G.endpoint(m.color, 1.6); break;
      case 'alerts': g = G.beacon(m.color, 1.3); break;
      case 'admin': g = G.shield(m.color, 1.2); break;
      default: g = G.node(m.color, 1.9); break;
    }
    g.position.copy(p);

    if (m.id === 'logs') {
      // Logs are a stream, so they are drawn as one rather than as an object.
      var n = 90, arr = new Float32Array(n * 3);
      for (var k = 0; k < n; k++) {
        arr[k * 3] = (Math.random() - 0.5) * 5.5;
        arr[k * 3 + 1] = (Math.random() - 0.5) * 22;
        arr[k * 3 + 2] = (Math.random() - 0.5) * 5.5;
      }
      var pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      var stream = new THREE.Points(pg, new THREE.PointsMaterial({ color: m.color, size: 0.5, transparent: true, opacity: 0.8, depthWrite: false }));
      g.add(stream);
      ctx.streams.push({ points: stream, speed: 7, span: 22 });
    }
    if (m.id === 'alerts') ctx.pulsers.push({ obj: g.userData.halo, base: 1, amt: 0.22, rate: 2.2 });
    if (m.id === 'database') ctx.spinners.push({ obj: g, speed: 0.12 });
    if (m.id === 'admin') ctx.spinners.push({ obj: g, speed: 0.08 });

    pick(ctx, g, { kind: 'module', id: m.id, label: m.label, color: m.color, focus: p, data: m },
      { name: m.label, sub: m.blurb, cta: 'Click to enter', tone: 'accent', lift: 6.2, nearAt: 54, midAt: 150, hitRadius: 5.2 });

    spoke(ctx, V(0, 0, 0), p, m.color, { flow: true, count: 7, speed: 0.19, lift: 5 });
  });

  // Neighbour ties: one system, not seven products.
  for (var j = 0; j < pts.length; j++) spoke(ctx, pts[j], pts[(j + 1) % pts.length], 0x24406b, { opacity: 0.12, lift: 2 });

  return {
    pose: { az: 0.62, el: 0.34, dist: 118, tx: 0, ty: 0, tz: 0 },
    limits: [46, 300],
    fog: 0.0042,
    title: 'ACTMON',
    subtitle: 'The complete platform — seven monitoring domains',
  };
};

/* ═══════════════════════════════════════════════════════════════════════
   LEVEL 1 — module environments (one per domain, all different)
   ═══════════════════════════════════════════════════════════════════════ */

/** Database Monitoring — a data landscape: engines standing on a lit plain,
    each a layered database structure, sized by how much of it is built. */
E.mod_database = function (ctx) {
  var D = ctx.data;
  floor(ctx, 0x1d4a6e, 300, 60, -14);
  horizon(ctx, 0x35c3f3, 130, -13.7);

  var hub = G.core(0x35c3f3, 0.62);
  hub.position.y = 12;
  ctx.group.add(hub);
  ctx.spinners.push({ obj: hub.userData.rings, speed: 0.06 });
  ctx.labels.add(hub, { name: 'Database Monitoring', sub: 'Seven engines, each with its own dashboard', nearAt: 999, midAt: 999, tone: 'accent' });

  var inner = D.ENGINES.filter(function (e) { return e.ring !== 2; });
  var outer = D.ENGINES.filter(function (e) { return e.ring === 2; });

  function place(list, radius, y) {
    var pts = ring(list.length, radius, y);
    list.forEach(function (e, i) {
      var g = G.database(e.color, e.id === 'postgresql' ? 1.5 : 1.1);
      g.position.copy(pts[i]);
      ctx.spinners.push({ obj: g, speed: e.id === 'postgresql' ? 0.16 : 0.09 });

      // A partial engine is ringed, so "not fully supported" is visible in the
      // geometry and not only in a panel.
      if (e.status !== 'implemented') {
        var r = new THREE.Mesh(new THREE.TorusGeometry(3.6, 0.07, 6, 48),
          new THREE.MeshBasicMaterial({ color: 0xf2b23c, transparent: true, opacity: 0.8 }));
        r.rotation.x = Math.PI / 2; r.position.y = -1.8;
        g.add(r);
      }
      var cap = e.id === 'postgresql' ? (D.PG_TABS.filter(function (t) { return !t.virtual; }).length + ' feature areas')
        : e.status === 'partial' ? 'Partial — via the MySQL path' : 'Dashboard implemented';
      pick(ctx, g, { kind: 'engine', id: e.id, label: e.label, color: e.color, focus: pts[i], data: e },
        { name: e.label, sub: cap, cta: e.id === 'postgresql' ? 'Click to enter' : 'Click for detail', lift: 5.4, nearAt: 46, midAt: 128, hitRadius: 4.4 });
      spoke(ctx, V(0, 12, 0), pts[i], e.color, { flow: true, count: 5, speed: 0.17 });
    });
  }
  place(inner, 34, -2);
  place(outer, 54, 6);

  return {
    pose: { az: 0.5, el: 0.3, dist: 96, tx: 0, ty: 2, tz: 0 },
    limits: [34, 210], fog: 0.0055,
    title: 'Database Monitoring',
    subtitle: 'Eight technology entries — seven with a dashboard of their own',
  };
};

/** Cloud — three provider cloud bodies, each surrounded by its real resource
    types as orbiting nodes. */
E.mod_cloud = function (ctx) {
  var D = ctx.data, SM = ctx.samples;
  floor(ctx, 0x2c3a72, 300, 48, -18);
  horizon(ctx, 0x6f7cf7, 140, -17.7);

  var pts = ring(D.PROVIDERS.length, 38, 0);
  D.PROVIDERS.forEach(function (p, i) {
    var g = G.cloud(p.color, 1.5);
    g.position.copy(pts[i]);
    ctx.pulsers.push({ obj: g, base: 1, amt: 0.025, rate: 0.5 + i * 0.13 });

    // Resource types as satellites — the count is the real scanner count.
    var sats = p.resources.length;
    var sp = ring(sats, 9.5, 0);
    p.resources.forEach(function (rname, k) {
      var s = new THREE.Mesh(new THREE.OctahedronGeometry(0.62, 0),
        AS.G.mat(p.color, { emissiveIntensity: 0.4, flat: true }));
      s.position.copy(sp[k]);
      s.position.y = Math.sin(k * 1.7) * 3.2;
      g.add(s);
    });
    var orb = new THREE.Mesh(new THREE.TorusGeometry(9.5, 0.03, 6, 72),
      new THREE.MeshBasicMaterial({ color: p.color, transparent: true, opacity: 0.22 }));
    orb.rotation.x = Math.PI / 2; g.add(orb);
    ctx.spinners.push({ obj: g, speed: 0.05 });

    pick(ctx, g, { kind: 'provider', id: p.id, label: p.label, color: p.color, focus: pts[i], data: p },
      { name: p.label, sub: p.resources.length + ' resource types discovered', cta: 'Click for detail', lift: 7.5, nearAt: 52, midAt: 140, hitRadius: 6 });

    for (var j = i + 1; j < D.PROVIDERS.length; j++) spoke(ctx, pts[i], pts[j], 0x3a4a86, { opacity: 0.1, lift: 4 });
  });

  // A visible absence: GCP is named and shown as an empty socket rather than
  // quietly left out.
  var gap = V(0, 16, 0);
  var ghost = new THREE.Mesh(new THREE.TorusGeometry(4.2, 0.06, 6, 56),
    new THREE.MeshBasicMaterial({ color: 0xff6b7f, transparent: true, opacity: 0.4 }));
  ghost.rotation.x = Math.PI / 2; ghost.position.copy(gap);
  var ghost2 = ghost.clone(); ghost2.scale.setScalar(0.6);
  var gg = new THREE.Group(); gg.add(ghost); gg.add(ghost2);
  pick(ctx, gg, { kind: 'notimpl', id: 'gcp', label: 'Google Cloud Platform', color: 0xff6b7f, focus: gap, data: D.NOT_ENGINES[1] },
    { name: 'Google Cloud', sub: 'Not implemented — no provider module exists', cta: 'Click for detail', tone: 'bad', lift: 6, nearAt: 60, midAt: 200, hitRadius: 4.6 });

  return {
    pose: { az: 0.9, el: 0.36, dist: 104, tx: 0, ty: 4, tz: 0 },
    limits: [32, 220], fog: 0.005,
    title: 'Cloud Monitoring',
    subtitle: 'AWS, Azure and OCI — discovery and inventory',
  };
};

/** Infrastructure — a datacentre floor of racks, with the monitored host's
    real gauges standing beside it as bars. */
E.mod_infra = function (ctx) {
  var D = ctx.data, SM = ctx.samples;
  floor(ctx, 0x1e5d4e, 260, 52, -12);
  horizon(ctx, 0x2fd6a6, 120, -11.7);

  // Rows of racks: a floor, not a ring. Different composition from every
  // other level on purpose.
  var cols = 5, rows = 3;
  for (var r = 0; r < rows; r++) {
    for (var c = 0; c < cols; c++) {
      if (r === 1 && c === 2) continue;         // the monitored host's slot
      var g = G.rack(0x2fd6a6, 0.95, 0.35 + ((r * cols + c) % 4) * 0.16);
      g.position.set((c - (cols - 1) / 2) * 9.5, -8.5, (r - (rows - 1) / 2) * 13);
      ctx.group.add(g);
    }
  }

  // The host under study, raised and lit.
  var host = G.rack(0x7cf5cd, 1.5, 0.85);
  host.position.set(0, -6, 0);
  ctx.group.add(host);
  ctx.pulsers.push({ obj: host, base: 1, amt: 0.012, rate: 0.9 });
  pick(ctx, host, { kind: 'host', id: 'pg-prod-01', label: SM.SAMPLE_HOST.name, color: 0x2fd6a6, focus: V(0, -4, 0), data: SM.SAMPLE_HOST },
    { name: SM.SAMPLE_HOST.name, sub: SM.SAMPLE_HOST.os + ' — illustrative host', cta: 'Click for detail', lift: 6.5, nearAt: 48, midAt: 130, hitRadius: 5 });

  // Gauges as physical bars — value drives height, tone drives colour.
  var gp = ring(SM.SAMPLE_HOST.gauges.length, 17, -8, 200, 140);
  SM.SAMPLE_HOST.gauges.forEach(function (gauge, i) {
    var h = 1 + (gauge.value / 100) * 11;
    var col = gauge.tone === 'warn' ? TONE.warn : gauge.tone === 'bad' ? TONE.bad : TONE.ok;
    var bar = G.slab(col, 2.3, h, 2.3, { emissiveIntensity: 0.3 });
    bar.position.copy(gp[i]);
    // A ghost column showing the 100 % envelope, so a reading is legible as a
    // proportion and not only as a height.
    var ghost = new THREE.Mesh(new THREE.BoxGeometry(2.4, 12, 2.4),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.07 }));
    ghost.position.y = 6; bar.add(ghost);
    pick(ctx, bar, { kind: 'gauge', id: gauge.id, label: gauge.label, color: col, focus: gp[i], data: gauge },
      { name: gauge.label, sub: gauge.value + gauge.unit + ' — illustrative', lift: h + 2.4, nearAt: 40, midAt: 96, hitRadius: 2.6, tone: gauge.tone });
  });

  // Nine host tabs as a back wall of panels.
  var tp = ring(D.INFRA_TABS.length, 30, 6, 20, 320);
  D.INFRA_TABS.forEach(function (t, i) {
    var g = G.slab(0x2fd6a6, 3.4, 0.3, 2.4, { opacity: 0.85, transparent: true });
    g.position.copy(tp[i]);
    g.rotation.y = -Math.atan2(tp[i].z, tp[i].x);
    pick(ctx, g, { kind: 'infratab', id: t.id, label: t.label, color: 0x2fd6a6, focus: tp[i], data: t },
      { name: t.label, sub: t.what, cta: 'Click for detail', lift: 2.6, nearAt: 34, midAt: 92, hitRadius: 2.6 });
  });

  return {
    pose: { az: -0.5, el: 0.34, dist: 88, tx: 0, ty: -2, tz: 0 },
    limits: [26, 190], fog: 0.006,
    title: 'Infrastructure Monitoring',
    subtitle: 'Hosts, resources and services beneath the database',
  };
};

/** Agents — endpoints transmitting packets inward to the platform. */
E.mod_agents = function (ctx) {
  var D = ctx.data;
  floor(ctx, 0x23506b, 260, 44, -16);

  var hub = G.core(0x7cd6f0, 0.75);
  ctx.group.add(hub);
  ctx.spinners.push({ obj: hub.userData.rings, speed: 0.08 });
  ctx.labels.add(hub, { name: 'ACTMON server', sub: 'Receives what the agents collect', nearAt: 999, midAt: 999, tone: 'accent' });

  // Endpoints on an outer shell, each streaming packets in — the animated
  // data-flow the brief asked for, pointed at the thing receiving it.
  var eps = ring(9, 34, 0);
  eps.forEach(function (p, i) {
    p.y = Math.sin(i * 1.3) * 8;
    var g = G.endpoint(0x7cd6f0, 1.25);
    g.position.copy(p);
    g.lookAt(0, 0, 0);
    ctx.group.add(g);
    spoke(ctx, p, V(0, 0, 0), 0x7cd6f0, { flow: true, count: 5, speed: 0.3, lift: 3 });
  });

  // The three real collection methods as selectable structures.
  var specs = [
    { id: 'agent', label: 'Host agent', color: 0x7cd6f0, geo: 'endpoint', sub: 'MSI on Windows, .deb/.rpm on Linux' },
    { id: 'direct', label: 'Server-direct', color: 0x35c3f3, geo: 'database', sub: 'MySQL, MariaDB and PostgreSQL only' },
    { id: 'cloudapi', label: 'Cloud provider API', color: 0x6f7cf7, geo: 'cloud', sub: 'No agent installed at all' },
  ];
  var sp = ring(specs.length, 16, 13);
  specs.forEach(function (s, i) {
    var g = s.geo === 'endpoint' ? G.endpoint(s.color, 1.5) : s.geo === 'database' ? G.database(s.color, 0.8) : G.cloud(s.color, 0.8);
    g.position.copy(sp[i]);
    pick(ctx, g, { kind: 'collect', id: s.id, label: s.label, color: s.color, focus: sp[i], data: s },
      { name: s.label, sub: s.sub, cta: 'Click for detail', lift: 4.4, nearAt: 40, midAt: 110, hitRadius: 3.6 });
  });

  // The storage tiers, below, receiving what arrives.
  var tiers = [
    { label: 'Redis — hot tier', color: 0xff6b7f, x: -15, sub: 'Latest value plus a one-hour ring' },
    { label: 'ClickHouse — history', color: 0xfbd42c, x: 0, sub: 'Per-module, per-technology tables' },
    { label: 'PostgreSQL — configuration', color: 0x4a9fd8, x: 15, sub: 'Connections, roles, rules, audit' },
  ];
  tiers.forEach(function (t) {
    var p = V(t.x, -17, 8);
    var g = G.database(t.color, 0.8);
    g.position.copy(p);
    pick(ctx, g, { kind: 'tier', id: t.label, label: t.label, color: t.color, focus: p, data: t },
      { name: t.label, sub: t.sub, lift: 4, nearAt: 36, midAt: 96, hitRadius: 3.2 });
    spoke(ctx, V(0, 0, 0), p, t.color, { flow: true, count: 4, speed: 0.24 });
  });

  return {
    pose: { az: 0.7, el: 0.3, dist: 92, tx: 0, ty: -2, tz: 0 },
    limits: [28, 190], fog: 0.0055,
    title: 'Agents & Collection',
    subtitle: 'How ACTMON reaches a monitored system',
  };
};

/** Alerts — three tiers as beacon clusters, sized by rule count, with the
    channels arrayed beyond them. */
E.mod_alerts = function (ctx) {
  var D = ctx.data, SM = ctx.samples;
  floor(ctx, 0x5a4420, 260, 44, -16);
  horizon(ctx, 0xf2b23c, 118, -15.7);

  var tp = ring(D.ALERT_TIERS.length, 26, 0);
  D.ALERT_TIERS.forEach(function (t, i) {
    var col = t.tone === 'ok' ? TONE.ok : t.tone === 'info' ? TONE.info : TONE.warn;
    var g = new THREE.Group();
    g.position.copy(tp[i]);
    // One beacon per rule type: the "no data source yet" cluster is visibly
    // the biggest, which is the honest headline.
    var bp = ring(t.count, 1.2 + t.count * 0.28, 0);
    for (var k = 0; k < t.count; k++) {
      var b = G.beacon(col, 0.34);
      b.position.copy(bp[k]);
      b.position.y = Math.sin(k * 2.1) * 1.4;
      g.add(b);
    }
    var base = new THREE.Mesh(new THREE.CylinderGeometry(1.4 + t.count * 0.28, 1.6 + t.count * 0.28, 0.4, 40),
      AS.G.mat(col, { emissiveIntensity: 0.22, transparent: true, opacity: 0.55 }));
    base.position.y = -2.2; g.add(base);
    ctx.spinners.push({ obj: g, speed: t.id === 'reserved' ? 0.03 : 0.07 });

    pick(ctx, g, { kind: 'alerttier', id: t.id, label: t.label, color: col, focus: tp[i], data: t },
      { name: t.label + ' — ' + t.count + ' rule types', sub: t.detail, cta: 'Click for detail',
        tone: t.id === 'reserved' ? 'warn' : 'ok', lift: 5.5, nearAt: 46, midAt: 130, hitRadius: 5 });
  });

  var cp = ring(D.CHANNELS.length, 46, -4);
  D.CHANNELS.forEach(function (c, i) {
    var g = G.node(0xff8fa3, 0.9);
    g.position.copy(cp[i]);
    pick(ctx, g, { kind: 'channel', id: c.id, label: c.label, color: 0xff8fa3, focus: cp[i], data: c },
      { name: c.label, sub: c.detail, lift: 2.8, nearAt: 34, midAt: 94, hitRadius: 2.4 });
    spoke(ctx, V(0, 0, 0), cp[i], 0xff8fa3, { opacity: 0.12, lift: 5 });
  });

  // Three sample firing alerts, illuminating their resource.
  SM.SAMPLE_ALERTS.forEach(function (a, i) {
    var p = V((i - 1) * 9, 15, -6);
    var g = G.beacon(sevColor(a.sev), 0.85);
    g.position.copy(p);
    ctx.pulsers.push({ obj: g.userData.halo, base: 1, amt: 0.3, rate: 2.6 - i * 0.4 });
    pick(ctx, g, { kind: 'alert', id: 'alert-' + i, label: a.title, color: sevColor(a.sev), focus: p, data: a },
      { name: a.title, sub: a.res + ' · ' + a.t + ' — illustrative', tone: a.sev === 'critical' ? 'bad' : 'warn',
        cta: 'Click for detail', lift: 3.4, nearAt: 40, midAt: 108, hitRadius: 2.8 });
  });

  return {
    pose: { az: 1.1, el: 0.34, dist: 104, tx: 0, ty: 2, tz: 0 },
    limits: [30, 210], fog: 0.0052,
    title: 'Alerts & Notifications',
    subtitle: '43 rule types across three evaluation tiers, nine channels',
  };
};

/** Logs — a descending river of events with a selectable timeline. */
E.mod_logs = function (ctx) {
  var SM = ctx.samples;
  floor(ctx, 0x3a2f6b, 240, 40, -22);

  // Several falling columns for texture…
  for (var s = 0; s < 7; s++) {
    var n = 130, arr = new Float32Array(n * 3);
    var ang = (s / 7) * Math.PI * 2, rad = 20 + (s % 3) * 5;
    for (var i = 0; i < n; i++) {
      arr[i * 3] = Math.cos(ang) * rad + (Math.random() - 0.5) * 4;
      arr[i * 3 + 1] = -24 + Math.random() * 48;
      arr[i * 3 + 2] = Math.sin(ang) * rad + (Math.random() - 0.5) * 4;
    }
    var pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    var p = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0x9d8df1, size: 0.42, transparent: true, opacity: 0.55, depthWrite: false }));
    ctx.group.add(p);
    ctx.streams.push({ points: p, speed: 5 + s, span: 48 });
  }

  // …and the real sample entries as a selectable vertical timeline.
  var spine = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 34, 8),
    new THREE.MeshBasicMaterial({ color: 0x9d8df1, transparent: true, opacity: 0.3 }));
  ctx.group.add(spine);

  SM.SAMPLE_LOGS.forEach(function (lg, i) {
    var y = 15 - i * 6;
    var col = lg.sev === 'FATAL' ? 0xff4d67 : lg.sev === 'ERROR' ? 0xff6b7f
      : lg.sev === 'WARNING' ? 0xf2b23c : 0x7cd6f0;
    var g = G.node(col, lg.sev === 'FATAL' || lg.sev === 'ERROR' ? 1.15 : 0.75);
    g.position.set(i % 2 ? 7 : -7, y, 0);
    var tie = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([V(0, y, 0), g.position.clone()]),
      new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.4 })
    );
    ctx.group.add(tie);
    pick(ctx, g, { kind: 'logentry', id: 'log-' + i, label: lg.sev + ' ' + lg.t, color: col, focus: g.position.clone(), data: lg },
      { name: lg.sev + ' · ' + lg.t, sub: lg.msg.slice(0, 64), cta: 'Click for detail',
        tone: lg.sev === 'FATAL' || lg.sev === 'ERROR' ? 'bad' : lg.sev === 'WARNING' ? 'warn' : 'info',
        lift: 2.6, nearAt: 44, midAt: 120, hitRadius: 2.4 });
  });

  return {
    pose: { az: 0.3, el: 0.12, dist: 74, tx: 0, ty: 0, tz: 0 },
    limits: [24, 170], fog: 0.006,
    title: 'Logs & Diagnostics',
    subtitle: 'Six illustrative PostgreSQL log events on a selectable timeline',
  };
};

/** Administration — a relationship graph: roles to pages to permission bits. */
E.mod_admin = function (ctx) {
  var D = ctx.data;
  floor(ctx, 0x5c2a3a, 240, 40, -18);

  var centre = G.shield(0xff8fa3, 1.5);
  ctx.group.add(centre);
  ctx.spinners.push({ obj: centre, speed: 0.06 });
  ctx.labels.add(centre, { name: 'Access control', sub: 'A permission bitmask per role, per page', nearAt: 999, midAt: 999, tone: 'accent' });

  // Permission bits as a graduated arc: bit value drives height, so the
  // doubling is visible rather than asserted.
  var bp = ring(D.RBAC.bits.length, 24, -6, 180, 200);
  D.RBAC.bits.forEach(function (b, i) {
    var h = 1.2 + Math.log2(b.value + 1) * 1.5;
    var g = G.slab(lerpColor(0xff8fa3, 0x6f7cf7, i / D.RBAC.bits.length), 2, h, 2, { emissiveIntensity: 0.26 });
    g.position.copy(bp[i]);
    pick(ctx, g, { kind: 'bit', id: 'bit-' + b.value, label: b.label, color: 0xff8fa3, focus: bp[i], data: b },
      { name: b.label, sub: 'Bit value ' + b.value, lift: h + 2, nearAt: 34, midAt: 88, hitRadius: 2.2 });
  });

  // Sample roles orbiting.
  var roles = [
    { n: 'Super Admin', s: 'Full Access — 511 on every page' },
    { n: 'DBA', s: 'View, Edit, Execute on database pages' },
    { n: 'Viewer', s: 'View only' },
  ];
  var rp = ring(roles.length, 15, 10);
  roles.forEach(function (r, i) {
    var g = G.node(0xff8fa3, 1.3);
    g.position.copy(rp[i]);
    pick(ctx, g, { kind: 'role-rbac', id: r.n, label: r.n, color: 0xff8fa3, focus: rp[i], data: r },
      { name: r.n, sub: r.s + ' — illustrative', lift: 3, nearAt: 36, midAt: 96, hitRadius: 2.6 });
    spoke(ctx, V(0, 0, 0), rp[i], 0xff8fa3, { opacity: 0.2, flow: true, count: 3, speed: 0.14 });
  });

  return {
    pose: { az: 0.85, el: 0.36, dist: 80, tx: 0, ty: 0, tz: 0 },
    limits: [26, 170], fog: 0.0055,
    title: 'Administration & Access Control',
    subtitle: 'Roles, pages and a nine-bit permission mask',
  };
};

/* ═══════════════════════════════════════════════════════════════════════
   LEVEL 3 — the PostgreSQL environment
   ═══════════════════════════════════════════════════════════════════════ */

E.engine_postgresql = function (ctx) {
  var D = ctx.data, SM = ctx.samples;
  floor(ctx, 0x1f4f7a, 300, 60, -13);
  horizon(ctx, 0x4a9fd8, 128, -12.7);

  // The instance itself: a large layered database at the centre, with its
  // health ring reading the sample metrics.
  var core = G.database(0x4a9fd8, 2.4);
  core.position.y = 2;
  ctx.group.add(core);
  ctx.spinners.push({ obj: core, speed: 0.06 });
  ctx.labels.add(core, { name: SM.SAMPLE_HEALTH.instance, sub: SM.SAMPLE_HEALTH.version + ' — illustrative', nearAt: 999, midAt: 999, tone: 'accent' });

  // Health arcs: one per metric, arc length = value / max.
  SM.SAMPLE_HEALTH.metrics.forEach(function (m, i) {
    var frac = Math.max(0.04, Math.min(1, m.value / m.max));
    var col = m.tone === 'warn' ? TONE.warn : m.tone === 'bad' ? TONE.bad : TONE.ok;
    var r = 9 + i * 1.5;
    var arc = new THREE.Mesh(
      new THREE.TorusGeometry(r, 0.11, 8, 96, Math.PI * 2 * frac),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85 })
    );
    arc.rotation.x = Math.PI / 2;
    arc.rotation.z = -Math.PI / 2;
    arc.position.y = 2;
    ctx.group.add(arc);
    var track = new THREE.Mesh(new THREE.TorusGeometry(r, 0.035, 6, 96),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.12 }));
    track.rotation.x = Math.PI / 2; track.position.y = 2;
    ctx.group.add(track);
  });

  // Feature areas as illuminated pathways leading outward — the brief's
  // "structured database environment with illuminated data pathways".
  var tabs = D.PG_TABS;
  var pts = ring(tabs.length, 42, 0);
  tabs.forEach(function (t, i) {
    var col = t.virtual ? 0x6f7cf7 : 0x4a9fd8;
    var g = G.slab(col, 4.2, 1.1 + (t.deepDive ? 1.8 : 0), 3.2, { emissiveIntensity: t.deepDive ? 0.34 : 0.16 });
    g.position.copy(pts[i]);
    g.rotation.y = -Math.atan2(pts[i].z, pts[i].x) + Math.PI / 2;

    // A marker post so the object reads from a distance.
    var post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 5.5, 8),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5 }));
    post.position.y = 3.4; g.add(post);

    pick(ctx, g, { kind: 'pgtab', id: t.id, label: t.label, color: col, focus: pts[i], data: t },
      { name: t.label + (t.virtual ? '  ·  detail page' : ''), sub: t.what,
        cta: E['feat_' + t.id] ? 'Click to enter' : 'Click for detail',
        lift: 6.4, nearAt: 44, midAt: 124, hitRadius: 3.6 });

    spoke(ctx, V(0, 2, 0), pts[i], col, { flow: !!t.deepDive, count: 4, speed: 0.2, lift: 3 });
  });

  return {
    pose: { az: 0.55, el: 0.42, dist: 116, tx: 0, ty: 2, tz: 0 },
    limits: [30, 240], fog: 0.0042,
    title: 'PostgreSQL',
    subtitle: '16 dashboard tabs plus the Query Analysis detail page',
  };
};

/* ═══════════════════════════════════════════════════════════════════════
   LEVEL 4 — feature environments
   ═══════════════════════════════════════════════════════════════════════ */

/** Slow Queries — statements as towers. Radius maps to cumulative cost, so
    the most expensive statement is physically the biggest thing present even
    when it is not the slowest. */
E.feat_slowqueries = function (ctx) {
  var SM = ctx.samples;
  floor(ctx, 0x2a4a7a, 200, 36, -10);

  var qs = SM.SAMPLE_QUERIES;
  var maxTotal = Math.max.apply(null, qs.map(function (q) { return q.calls * q.avg_ms; }));
  var pts = ring(qs.length, 20, -8);

  qs.forEach(function (q, i) {
    var total = q.calls * q.avg_ms;
    var rad = 1.4 + (total / maxTotal) * 3.4;
    var h = 3 + (q.avg_ms / 3200) * 13;
    var col = sevColor(q.severity);

    var g = new THREE.Group();
    g.position.copy(pts[i]);
    var tower = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad * 1.12, h, 26),
      AS.G.mat(col, { emissiveIntensity: 0.26 }));
    tower.position.y = h / 2; g.add(tower);
    // Banding: one ring per 1000 calls, so frequency is readable as texture.
    var bands = Math.max(1, Math.min(10, Math.round(q.calls / 10000) + 1));
    for (var b = 0; b < bands; b++) {
      var r = new THREE.Mesh(new THREE.TorusGeometry(rad * 1.04, 0.05, 6, 40),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.7 }));
      r.rotation.x = Math.PI / 2;
      r.position.y = (b + 1) * (h / (bands + 1));
      g.add(r);
    }
    g.add(AS.G.glow(col, rad + 2, 0.06));
    if (q.severity === 'critical') ctx.pulsers.push({ obj: tower, base: 1, amt: 0.03, rate: 1.7 });

    pick(ctx, g, { kind: 'query', id: q.id, label: q.type + ' on ' + (q.sql.match(/FROM\s+(\w+)|UPDATE\s+(\w+)/i) || [])[0], color: col, focus: pts[i], data: q },
      { name: q.severity.toUpperCase() + ' · ' + Math.round(q.avg_ms) + ' ms avg',
        sub: q.calls.toLocaleString() + ' calls · ' + Math.round(total / 60000) + ' min total',
        cta: 'Click to inspect', tone: q.severity === 'critical' ? 'bad' : q.severity === 'high' ? 'bad' : 'warn',
        lift: h + 2.6, nearAt: 40, midAt: 110, hitRadius: rad + 1.4 });
  });

  var legend = AS.textSprite('Tower width = cumulative cost   ·   height = average duration', { size: 34, worldHeight: 1.5, opacity: 0.55 });
  legend.position.set(0, -12.5, 0);
  ctx.group.add(legend);

  return {
    pose: { az: 0.6, el: 0.28, dist: 62, tx: 0, ty: -2, tz: 0 },
    limits: [18, 150], fog: 0.006,
    title: 'Slow Queries',
    subtitle: 'Four illustrative statements — width is cumulative cost, not duration',
  };
};

/** Users — a privilege relationship graph. Direct, inherited, PUBLIC and
    ownership each get their own colour and their own edge. */
E.feat_users = function (ctx) {
  var SM = ctx.samples, R = SM.SAMPLE_ROLE;
  floor(ctx, 0x5c2a3a, 200, 34, -14);

  var VIA = { direct: 0x3ad39a, app_writer: 0x7cd6f0, PUBLIC: 0xf2b23c, owner: 0xff8fa3 };

  var role = G.shield(0xff8fa3, 1.6);
  role.position.set(0, 4, 0);
  ctx.group.add(role);
  ctx.spinners.push({ obj: role, speed: 0.07 });
  pick(ctx, role, { kind: 'role', id: R.name, label: R.name, color: 0xff8fa3, focus: V(0, 4, 0), data: R },
    { name: R.name, sub: 'Illustrative role — click for full attributes', cta: 'Click to inspect',
      nearAt: 999, midAt: 999, tone: 'accent', lift: 5.4, hitRadius: 4 });

  // The role it inherits from, above — height encodes that privileges flow down.
  var parent = G.node(0x7cd6f0, 1.4);
  parent.position.set(0, 16, 0);
  pick(ctx, parent, { kind: 'rolemember', id: 'app_writer', label: 'app_writer', color: 0x7cd6f0, focus: V(0, 16, 0), data: R.memberOf[0] },
    { name: 'app_writer', sub: 'Member of — INHERIT is on, so its privileges arrive automatically',
      lift: 3, nearAt: 40, midAt: 110, hitRadius: 2.6, tone: 'info' });
  spoke(ctx, V(0, 16, 0), V(0, 4, 0), 0x7cd6f0, { flow: true, count: 5, speed: 0.3, lift: 1 });

  // Privileges as objects on the floor, grouped by kind, coloured by route.
  var byKind = {};
  R.privileges.forEach(function (p) { (byKind[p.kind] = byKind[p.kind] || []).push(p); });
  var kinds = Object.keys(byKind);
  var kp = ring(kinds.length, 22, -6);

  kinds.forEach(function (kind, ki) {
    var list = byKind[kind];
    var sub = ring(list.length, 3 + list.length * 1.1, 0);
    list.forEach(function (p, i) {
      var col = VIA[p.via] || 0x6a7f9f;
      var g = kind === 'table' ? G.slab(col, 2.2, 1.4, 2.2, { emissiveIntensity: 0.3 })
        : kind === 'database' ? G.database(col, 0.55)
          : G.node(col, 0.85);
      g.position.copy(kp[ki]).add(sub[i]);
      pick(ctx, g, { kind: 'priv', id: p.object, label: p.object, color: col, focus: g.position.clone(), data: p },
        { name: p.object, sub: p.grants.join(', ') + '  ·  via ' + p.via,
          lift: 2.6, nearAt: 30, midAt: 78, hitRadius: 2,
          tone: p.via === 'direct' ? 'ok' : p.via === 'PUBLIC' ? 'warn' : 'info' });
      spoke(ctx, V(0, 4, 0), g.position.clone(), col, { opacity: 0.3, lift: 3, flow: p.via !== 'direct', count: 3, speed: 0.16 });
    });
    var caption = AS.textSprite(kind.toUpperCase() + ' PRIVILEGES', { size: 30, worldHeight: 1.2, opacity: 0.45 });
    caption.position.copy(kp[ki]); caption.position.y = -3.5;
    ctx.group.add(caption);
  });

  return {
    pose: { az: 0.7, el: 0.44, dist: 70, tx: 0, ty: 2, tz: 0 },
    limits: [20, 160], fog: 0.0055,
    title: 'Users & Roles',
    subtitle: 'One illustrative role — edge colour is the route each privilege arrives by: direct, inherited, PUBLIC or ownership',
  };
};

/** Replication — a real topology. Particle speed on each path is the inverse
    of that standby's lag, and the lost slot visibly has no flow at all. */
E.feat_replication = function (ctx) {
  var SM = ctx.samples, R = SM.SAMPLE_REPLICATION;
  floor(ctx, 0x1f4f7a, 220, 36, -14);

  var pri = G.database(0x3ad39a, 1.9);
  pri.position.set(-24, 4, 0);
  ctx.group.add(pri);
  ctx.spinners.push({ obj: pri, speed: 0.08 });
  pick(ctx, pri, { kind: 'pgnode', id: 'primary', label: R.primary.name, color: 0x3ad39a, focus: V(-24, 4, 0), data: R.primary },
    { name: R.primary.name + ' · PRIMARY', sub: R.primary.version + ' — illustrative', cta: 'Click for detail',
      tone: 'ok', lift: 6, nearAt: 999, midAt: 999, hitRadius: 5 });

  var sp = [V(24, 12, -14), V(24, 2, 0), V(24, -8, 14)];
  R.standbys.forEach(function (s, i) {
    var healthy = s.state === 'streaming';
    var col = s.wal_status === 'lost' ? TONE.bad : s.lag_ms > 100 ? TONE.warn : TONE.ok;
    var g = G.database(col, 1.4);
    g.position.copy(sp[i]);
    ctx.spinners.push({ obj: g, speed: healthy ? 0.08 : 0.005 });

    pick(ctx, g, { kind: 'standby', id: s.name, label: s.name, color: col, focus: sp[i], data: s },
      { name: s.name, sub: s.state + ' · ' + s.sync + (s.lag_ms == null ? ' · no connection' : ' · ' + s.lag_ms + ' ms lag'),
        cta: 'Click for detail', tone: s.wal_status === 'lost' ? 'bad' : s.lag_ms > 100 ? 'warn' : 'ok',
        lift: 5, nearAt: 46, midAt: 130, hitRadius: 4 });

    // Speed is the data: 0 ms lag streams briskly, 240 ms crawls, and a lost
    // slot has no particles because nothing is flowing.
    var speed = !healthy ? 0 : s.lag_ms === 0 ? 0.34 : 0.34 / (1 + s.lag_ms / 120);
    spoke(ctx, V(-24, 4, 0), sp[i], col, {
      flow: healthy, count: healthy ? 8 : 0, speed: speed, lift: 6,
      opacity: healthy ? 0.3 : 0.12,
    });

    // A WAL backlog bar for the broken one.
    if (s.wal_status === 'lost') {
      var bar = G.slab(TONE.bad, 1.6, 9, 1.6, { emissiveIntensity: 0.4 });
      bar.position.set(sp[i].x + 7, sp[i].y - 4, sp[i].z);
      ctx.group.add(bar);
      var cap = AS.textSprite('WAL retained: ' + s.byte_pretty, { size: 30, worldHeight: 1.3, color: '#ff9fb0' });
      cap.position.set(sp[i].x + 7, sp[i].y + 7, sp[i].z);
      ctx.group.add(cap);
    }
  });

  return {
    pose: { az: 0.1, el: 0.3, dist: 86, tx: 0, ty: 2, tz: 0 },
    limits: [24, 190], fog: 0.005,
    title: 'Replication',
    subtitle: 'Illustrative topology — particle speed is the inverse of each standby\'s lag',
  };
};

/** Storage — a physical treemap. Table byte count drives volume directly. */
E.feat_storage = function (ctx) {
  var SM = ctx.samples;
  floor(ctx, 0x1d5a4a, 200, 36, -1);

  var tabs = SM.SAMPLE_TABLES.slice().sort(function (a, b) { return b.bytes - a.bytes; });
  var maxB = tabs[0].bytes;

  // Squarified-ish strip layout: a real treemap, not a bar chart in a circle.
  var cols = 3, cell = 11;
  tabs.forEach(function (t, i) {
    var frac = t.bytes / maxB;
    var side = 3.2 + Math.sqrt(frac) * 5.4;
    var h = 1.2 + frac * 14;
    var dead = t.dead_pct / 100;
    var col = lerpColor(0x2fd6a6, 0xff6b7f, Math.min(1, dead * 2.4));
    var x = ((i % cols) - (cols - 1) / 2) * cell;
    var z = (Math.floor(i / cols) - 0.5) * cell;

    var g = G.slab(col, side, h, side, { emissiveIntensity: 0.2 });
    g.position.set(x, 0, z);

    // The dead-tuple share as a translucent cap — bloat you can see.
    if (dead > 0.02) {
      var capH = h * dead;
      var capm = new THREE.Mesh(new THREE.BoxGeometry(side * 1.01, capH, side * 1.01),
        new THREE.MeshBasicMaterial({ color: 0xff6b7f, transparent: true, opacity: 0.42 }));
      capm.position.y = h - capH / 2;
      g.add(capm);
    }
    pick(ctx, g, { kind: 'table', id: t.name, label: t.name, color: col, focus: V(x, h / 2, z), data: t },
      { name: t.name, sub: t.pretty + ' · ' + t.dead_pct + ' % dead · ' + t.rows.toLocaleString() + ' rows',
        cta: 'Click for detail', tone: t.dead_pct > 20 ? 'bad' : t.dead_pct > 10 ? 'warn' : 'ok',
        lift: h + 2.4, nearAt: 34, midAt: 92, hitRadius: side * 0.72 });
  });

  var legend = AS.textSprite('Volume = size on disk   ·   red cap = dead tuples', { size: 32, worldHeight: 1.4, opacity: 0.55 });
  legend.position.set(0, -3.5, 17);
  ctx.group.add(legend);

  return {
    pose: { az: 0.75, el: 0.52, dist: 52, tx: 0, ty: 2, tz: 0 },
    limits: [16, 130], fog: 0.0065,
    title: 'Storage',
    subtitle: 'Six illustrative tables — volume is size on disk, the red cap is bloat',
  };
};

/** Locks — a blocking graph. One holder, two waiters, edges pointing the
    right way. */
E.feat_locks = function (ctx) {
  var SM = ctx.samples, L = SM.SAMPLE_LOCKS;
  floor(ctx, 0x5c3a20, 180, 30, -12);

  var obj = G.slab(0xf2b23c, 6, 1.2, 6, { emissiveIntensity: 0.22 });
  obj.position.set(0, -1, 0);
  ctx.group.add(obj);
  var objCap = AS.textSprite(L.holder.object, { size: 32, worldHeight: 1.5, opacity: 0.7 });
  objCap.position.set(0, 1.6, 0); ctx.group.add(objCap);

  var hp = V(0, 12, 0);
  var holder = G.node(0xff6b7f, 1.9);
  holder.position.copy(hp);
  ctx.pulsers.push({ obj: holder, base: 1, amt: 0.06, rate: 0.8 });
  pick(ctx, holder, { kind: 'session', id: 'pid-' + L.holder.pid, label: 'PID ' + L.holder.pid, color: 0xff6b7f, focus: hp, data: Object.assign({ role: 'holder' }, L.holder) },
    { name: 'PID ' + L.holder.pid + ' · BLOCKING', sub: L.holder.state + ' for ' + L.holder.age_s + ' s',
      cta: 'Click to inspect', tone: 'bad', lift: 3.4, nearAt: 999, midAt: 999, hitRadius: 3 });
  spoke(ctx, hp, V(0, -1, 0), 0xff6b7f, { opacity: 0.45, lift: 2 });

  var wp = [V(-16, 4, -6), V(16, 4, 6)];
  L.waiters.forEach(function (w, i) {
    var g = G.node(0xf2b23c, 1.3);
    g.position.copy(wp[i]);
    pick(ctx, g, { kind: 'session', id: 'pid-' + w.pid, label: 'PID ' + w.pid, color: 0xf2b23c, focus: wp[i], data: Object.assign({ role: 'waiter' }, w) },
      { name: 'PID ' + w.pid + ' · WAITING', sub: 'blocked by ' + L.holder.pid + ' · ' + w.age_s + ' s',
        cta: 'Click to inspect', tone: 'warn', lift: 3, nearAt: 44, midAt: 118, hitRadius: 2.6 });
    // Flow runs waiter → holder: the direction of the dependency.
    spoke(ctx, wp[i], hp, 0xf2b23c, { flow: true, count: 4, speed: 0.12, lift: 4, opacity: 0.28 });
  });

  return {
    pose: { az: 0.5, el: 0.26, dist: 58, tx: 0, ty: 4, tz: 0 },
    limits: [18, 140], fog: 0.006,
    title: 'Locks',
    subtitle: 'Illustrative blocking chain — two sessions waiting on one idle holder',
  };
};

/** Error Logs — a navigable timeline, severity driving size and colour. */
E.feat_errorlogs = function (ctx) {
  var SM = ctx.samples;
  floor(ctx, 0x3a2f6b, 180, 30, -12);

  var spine = new THREE.Mesh(new THREE.BoxGeometry(56, 0.12, 0.12),
    new THREE.MeshBasicMaterial({ color: 0x9d8df1, transparent: true, opacity: 0.4 }));
  ctx.group.add(spine);

  SM.SAMPLE_LOGS.forEach(function (lg, i) {
    var x = -26 + i * 10.5;
    var col = lg.sev === 'FATAL' ? 0xff4d67 : lg.sev === 'ERROR' ? 0xff6b7f
      : lg.sev === 'WARNING' ? 0xf2b23c : 0x7cd6f0;
    var big = lg.sev === 'FATAL' || lg.sev === 'ERROR';
    var h = big ? 9 : 4;
    // A beacon on a mast, not a bar: an event is a moment, and severity should
    // read as a signal light rather than as a quantity.
    var g = new THREE.Group();
    var mast = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, h, 8),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55 }));
    mast.position.y = h / 2; g.add(mast);
    var lamp = G.beacon(col, big ? 0.9 : 0.55);
    lamp.position.y = h + 1.1; g.add(lamp);
    g.position.set(x, 0, 0);
    if (big) ctx.pulsers.push({ obj: lamp.userData.halo, base: 1, amt: 0.26, rate: 1.9 });
    pick(ctx, g, { kind: 'logentry', id: 'log-' + i, label: lg.sev, color: col, focus: V(x, h / 2, 0), data: lg },
      { name: lg.sev + ' · ' + lg.t, sub: lg.msg.slice(0, 58) + (lg.msg.length > 58 ? '…' : ''),
        cta: 'Click to inspect', tone: big ? 'bad' : lg.sev === 'WARNING' ? 'warn' : 'info',
        lift: h + 3.4, nearAt: 40, midAt: 108, hitRadius: 2.2 });
    var tick = AS.textSprite(lg.t.slice(0, 5), { size: 26, worldHeight: 1, opacity: 0.45 });
    tick.position.set(x, -2.4, 0); ctx.group.add(tick);
  });

  return {
    pose: { az: 0.18, el: 0.22, dist: 62, tx: 0, ty: 2, tz: 0 },
    limits: [18, 140], fog: 0.006,
    title: 'Error Logs',
    subtitle: 'Six illustrative entries — bar height is severity, left to right is time',
  };
};

/** Tables — structures whose height is row count and footprint is size. */
E.feat_tables = function (ctx) {
  var SM = ctx.samples;
  floor(ctx, 0x1f4f7a, 200, 36, -1);

  var tabs = SM.SAMPLE_TABLES;
  var maxRows = Math.max.apply(null, tabs.map(function (t) { return t.rows; }));
  var pts = ring(tabs.length, 20, 0);

  tabs.forEach(function (t, i) {
    var h = 1.5 + (t.rows / maxRows) * 13;
    var side = 2.4 + (t.bytes / 5e9) * 4;
    // Scan ratio drives colour: mostly-sequential access is the warning sign.
    var seqRatio = t.seq / Math.max(1, t.seq + t.idx);
    var col = lerpColor(0x4a9fd8, 0xf2b23c, Math.min(1, seqRatio * 3));

    // Stacked platters rather than a block: a table belongs to a database, and
    // the layer count is the row magnitude, so the object reads as data at a
    // glance and cannot be confused with the Storage treemap's solid volumes.
    var g = new THREE.Group();
    var layers = Math.max(2, Math.min(9, Math.round(Math.log10(Math.max(10, t.rows)))* 2));
    for (var L = 0; L < layers; L++) {
      var platter = new THREE.Mesh(
        new THREE.CylinderGeometry(side * 0.62, side * 0.62, (h / layers) * 0.62, 30),
        AS.G.mat(col, { emissiveIntensity: 0.18 })
      );
      platter.position.y = (L + 0.5) * (h / layers);
      g.add(platter);
      var seam = new THREE.Mesh(new THREE.TorusGeometry(side * 0.64, 0.035, 6, 40),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.6 }));
      seam.rotation.x = Math.PI / 2;
      seam.position.y = platter.position.y;
      g.add(seam);
    }
    g.add(AS.G.glow(col, side, 0.045));
    g.position.copy(pts[i]);
    pick(ctx, g, { kind: 'table', id: t.name, label: t.name, color: col, focus: pts[i], data: t },
      { name: t.name, sub: t.rows.toLocaleString() + ' rows · ' + t.pretty + ' · ' + t.idx.toLocaleString() + ' index scans',
        cta: 'Click for detail', lift: h + 2.4, nearAt: 34, midAt: 94, hitRadius: side * 0.8 });
  });

  var legend = AS.textSprite('Platter count = row magnitude   ·   radius = size on disk   ·   amber = mostly sequential access', { size: 30, worldHeight: 1.3, opacity: 0.5 });
  legend.position.set(0, -3, 26);
  ctx.group.add(legend);

  return {
    pose: { az: 0.65, el: 0.42, dist: 62, tx: 0, ty: 3, tz: 0 },
    limits: [18, 150], fog: 0.006,
    title: 'Tables',
    subtitle: 'Six illustrative tables — height is rows, footprint is size on disk',
  };
};

/** Indexes — each one drawn as an actual B-tree: a root, branches and leaves.
    Fan-out is the column count, luminosity is the scan count, and an index
    nothing reads is visibly dark and dead rather than merely labelled so. */
E.feat_indexes = function (ctx) {
  var SM = ctx.samples;
  floor(ctx, 0x1f4f7a, 190, 32, -14);

  var idx = SM.SAMPLE_INDEXES;
  var maxScan = Math.max.apply(null, idx.map(function (i) { return i.scans; }));
  // A shelf rather than a ring, so it cannot be confused with the Tables
  // environment's circle of platters.
  var perRow = 3;

  idx.forEach(function (ix, i) {
    var lit = ix.scans / Math.max(1, maxScan);
    var dead = ix.scans === 0;
    var col = dead ? 0x44556e : lerpColor(0x2a6f9f, 0x7cf5cd, Math.sqrt(lit));
    var g = new THREE.Group();
    g.position.set(((i % perRow) - (perRow - 1) / 2) * 16, 0, (Math.floor(i / perRow) - 0.5) * 17);

    var emissive = dead ? 0.015 : 0.12 + lit * 0.55;
    var root = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1, 1.6), AS.G.mat(col, { emissiveIntensity: emissive }));
    root.position.y = 8; g.add(root);

    // Branch level — one node per indexed column, so a composite index is
    // visibly wider than a single-column one.
    var fan = Math.max(2, Math.min(4, ix.cols.length + 1));
    var branches = [];
    for (var b2 = 0; b2 < fan; b2++) {
      var bx = (b2 - (fan - 1) / 2) * 3.6;
      var node = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.8, 1.3), AS.G.mat(col, { emissiveIntensity: emissive * 0.8 }));
      node.position.set(bx, 4, 0);
      g.add(node); branches.push(node.position.clone());
      g.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([V(0, 7.5, 0), V(bx, 4.4, 0)]),
        new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: dead ? 0.18 : 0.5 })
      ));
    }
    // Leaf level.
    branches.forEach(function (bp) {
      for (var L = -1; L <= 1; L += 2) {
        var lx = bp.x + L * 1.5;
        var leaf = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, 0.9), AS.G.mat(col, { emissiveIntensity: emissive * 0.6 }));
        leaf.position.set(lx, 0.6, 0);
        g.add(leaf);
        g.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([bp.clone(), V(lx, 1, 0)]),
          new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: dead ? 0.14 : 0.4 })
        ));
      }
    });

    if (dead) {
      var slash = new THREE.Mesh(new THREE.BoxGeometry(11, 0.16, 0.16),
        new THREE.MeshBasicMaterial({ color: 0xf2b23c, transparent: true, opacity: 0.85 }));
      slash.position.y = 4.4; slash.rotation.z = -0.5;
      g.add(slash);
    } else {
      g.add(AS.G.glow(col, 6 + lit * 3, 0.03 + lit * 0.07));
      // Reads travelling down the tree — only where reads actually happen.
      spoke(ctx, V(g.position.x, 8, g.position.z), V(g.position.x, 0.6, g.position.z), col,
        { flow: true, count: 3, speed: 0.1 + lit * 0.4, lift: 0.2, opacity: 0.2 });
    }

    pick(ctx, g, { kind: 'index', id: ix.name, label: ix.name, color: col, focus: V(g.position.x, 4, g.position.z), data: ix },
      { name: ix.name, sub: ix.scans.toLocaleString() + ' scans · ' + ix.pretty + ' · ' + ix.cols.join(', '),
        cta: 'Click for detail', tone: dead ? 'warn' : 'ok',
        lift: 10.6, nearAt: 36, midAt: 98, hitRadius: 6 });
  });

  var legend = AS.textSprite('Each index as a B-tree  ·  fan-out = indexed columns  ·  brightness = scans  ·  struck through = never used',
    { size: 28, worldHeight: 1.25, opacity: 0.52 });
  legend.position.set(0, -4, 22);
  ctx.group.add(legend);

  return {
    pose: { az: -0.35, el: 0.28, dist: 66, tx: 0, ty: 3, tz: 0 },
    limits: [18, 150], fog: 0.0058,
    title: 'Indexes',
    subtitle: 'Six illustrative indexes drawn as B-trees — dark and struck through means unused',
  };
};

/** Overview — the health console: gauges as rings around a live core. */
E.feat_overview = function (ctx) {
  var SM = ctx.samples, H = SM.SAMPLE_HEALTH;
  floor(ctx, 0x1f4f7a, 180, 30, -12);

  var core = G.core(0x3ad39a, 0.9);
  ctx.group.add(core);
  ctx.spinners.push({ obj: core.userData.rings, speed: 0.1 });
  ctx.pulsers.push({ obj: core.userData.pulse, base: 1, amt: 0.05, rate: 1.45 });

  var pts = ring(H.metrics.length, 19, 0);
  H.metrics.forEach(function (m, i) {
    var frac = Math.max(0.05, Math.min(1, m.value / m.max));
    var col = m.tone === 'warn' ? TONE.warn : m.tone === 'bad' ? TONE.bad : TONE.ok;
    var g = new THREE.Group();
    g.position.copy(pts[i]);
    var track = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.16, 8, 64),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.14 }));
    var fill = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.22, 8, 64, Math.PI * 2 * frac),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.95 }));
    fill.rotation.z = Math.PI / 2;
    g.add(track); g.add(fill);
    g.lookAt(0, 0, 0);
    pick(ctx, g, { kind: 'metric', id: m.id, label: m.label, color: col, focus: pts[i], data: m },
      { name: m.value + m.unit, sub: m.label + ' — illustrative', tone: m.tone,
        lift: 4, nearAt: 34, midAt: 92, hitRadius: 2.8 });
    spoke(ctx, V(0, 0, 0), pts[i], col, { opacity: 0.16, flow: true, count: 3, speed: 0.2 });
  });

  return {
    pose: { az: 0.6, el: 0.3, dist: 54, tx: 0, ty: 0, tz: 0 },
    limits: [16, 130], fog: 0.0062,
    title: 'Overview',
    subtitle: 'Six illustrative health gauges — arc length is the value against its ceiling',
  };
};

/** Performance — three 24-point series drawn as ribbons in space. */
E.feat_performance = function (ctx) {
  var SM = ctx.samples, S = SM.SAMPLE_HEALTH.series;
  floor(ctx, 0x1f4f7a, 200, 34, -14);

  var series = [
    { key: 'tps', label: 'Transactions / sec', color: 0x35c3f3, z: -9, scale: 0.075 },
    { key: 'latency', label: 'Avg latency (ms)', color: 0xf2b23c, z: 0, scale: 0.34 },
    { key: 'cache', label: 'Cache hit %', color: 0x3ad39a, z: 9, scale: 0.9, offset: -88 },
  ];

  series.forEach(function (s) {
    var vals = S[s.key];
    var pts = vals.map(function (v, i) {
      return V(-28 + (i / (vals.length - 1)) * 56, ((v + (s.offset || 0)) * s.scale), s.z);
    });
    var curve = new THREE.CatmullRomCurve3(pts);
    var tube = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 96, 0.22, 8, false),
      AS.G.mat(s.color, { emissiveIntensity: 0.4 })
    );
    ctx.group.add(tube);

    // Per-hour posts, so the series is readable as data points not a squiggle.
    vals.forEach(function (v, i) {
      if (i % 3) return;
      var p = pts[i];
      var post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, Math.abs(p.y) + 0.1, 6),
        new THREE.MeshBasicMaterial({ color: s.color, transparent: true, opacity: 0.22 }));
      post.position.set(p.x, p.y / 2, p.z);
      ctx.group.add(post);
    });

    var g = G.node(s.color, 1.1);
    g.position.copy(pts[pts.length - 1]);
    pick(ctx, g, { kind: 'series', id: s.key, label: s.label, color: s.color, focus: pts[Math.floor(pts.length / 2)], data: { key: s.key, label: s.label, values: vals } },
      { name: s.label, sub: '24 illustrative hourly points', cta: 'Click for detail',
        lift: 2.6, nearAt: 40, midAt: 110, hitRadius: 2.2 });
  });

  var legend = AS.textSprite('24 hours, left to right — illustrative series', { size: 30, worldHeight: 1.3, opacity: 0.5 });
  legend.position.set(0, -6, 16);
  ctx.group.add(legend);

  return {
    pose: { az: -0.15, el: 0.3, dist: 74, tx: 0, ty: 2, tz: 0 },
    limits: [20, 160], fog: 0.0055,
    title: 'Performance',
    subtitle: 'Three illustrative 24-hour series — throughput, latency and cache behaviour',
  };
};

/** Generic feature environment — used where no bespoke scene exists yet.
    Still built from that feature's OWN `monitors` list, so it differs per
    feature rather than being one shared placeholder. */
E.feat_generic = function (ctx) {
  var t = ctx.level.featureData || {};
  var items = t.monitors || [];
  floor(ctx, 0x1f4f7a, 170, 30, -10);

  var core = G.slab(0x4a9fd8, 7, 1.2, 5, { emissiveIntensity: 0.22 });
  core.position.y = -0.6;
  ctx.group.add(core);
  var title = AS.textSprite(t.label || 'Feature', { size: 44, worldHeight: 2.2, opacity: 0.8 });
  title.position.set(0, 3.4, 0);
  ctx.group.add(title);

  var pts = ring(Math.max(items.length, 1), 15, 0);
  items.forEach(function (label, i) {
    var h = 2 + (i % 4) * 1.6;
    var g = G.slab(lerpColor(0x4a9fd8, 0x7cd6f0, i / Math.max(1, items.length - 1)), 2.2, h, 2.2, { emissiveIntensity: 0.2 });
    g.position.copy(pts[i]);
    pick(ctx, g, { kind: 'monitor', id: 'm' + i, label: label, color: 0x4a9fd8, focus: pts[i], data: { label: label, feature: t } },
      { name: label.length > 34 ? label.slice(0, 32) + '…' : label, sub: 'Monitored by ' + (t.label || 'this feature'),
        lift: h + 2, nearAt: 30, midAt: 80, hitRadius: 2 });
    spoke(ctx, V(0, 0, 0), pts[i], 0x4a9fd8, { opacity: 0.16 });
  });

  return {
    pose: { az: 0.6, el: 0.36, dist: 50, tx: 0, ty: 1, tz: 0 },
    limits: [16, 120], fog: 0.0065,
    title: t.label || 'Feature',
    subtitle: 'What this section monitors',
  };
};

/* ═══════════════════════════════════════════════════════════════════════
   LEVEL 5 — single-record environments
   ═══════════════════════════════════════════════════════════════════════ */

/** One query: its execution plan as a physical tree, cost driving width. */
E.detail_query = function (ctx) {
  var q = ctx.level.record;
  floor(ctx, 0x2a4a7a, 150, 26, -14);

  var plan = q.plan || [];
  var maxCost = Math.max.apply(null, plan.map(function (n) { return n.cost || 1; }));

  plan.forEach(function (n, i) {
    var y = 10 - i * 8;
    var w = 3 + (n.cost / maxCost) * 9;
    var col = n.bad ? 0xff6b7f : 0x35c3f3;
    var g = G.slab(col, w, 1.6, 4, { emissiveIntensity: n.bad ? 0.38 : 0.18 });
    g.position.set(n.d * 5 - 4, y, 0);
    if (n.bad) ctx.pulsers.push({ obj: g, base: 1, amt: 0.035, rate: 1.5 });

    pick(ctx, g, { kind: 'plannode', id: 'p' + i, label: n.node, color: col, focus: g.position.clone(), data: n },
      { name: n.node, sub: (n.rows != null ? n.rows.toLocaleString() + ' rows · ' : '') + 'cost ' + n.cost,
        tone: n.bad ? 'bad' : 'info', lift: 3.4, nearAt: 999, midAt: 999, hitRadius: 3 });

    if (i > 0) {
      var prev = plan[i - 1];
      spoke(ctx, V(prev.d * 5 - 4, 10 - (i - 1) * 8, 0), g.position.clone(), col,
        { flow: true, count: 4, speed: 0.22, lift: 1.2, opacity: 0.35, reverse: true });
    }
  });

  var caption = AS.textSprite('Plan reads bottom to top  ·  width = estimated cost  ·  red = a finding', { size: 30, worldHeight: 1.3, opacity: 0.55 });
  caption.position.set(0, -12, 0);
  ctx.group.add(caption);

  return {
    pose: { az: 0.1, el: 0.18, dist: 52, tx: 0, ty: -2, tz: 0 },
    limits: [16, 120], fog: 0.006,
    title: 'Query analysis',
    subtitle: 'Illustrative execution plan — estimated, not measured',
  };
};

/** One role, one log entry, one standby, one table… a focused single object
    with its facts as satellites. Composition differs by record kind. */
E.detail_record = function (ctx) {
  var lv = ctx.level, rec = lv.record || {}, kind = lv.recordKind;
  floor(ctx, 0x223a60, 140, 24, -12);

  var col = lv.color || 0x35c3f3;
  var centre = kind === 'role' ? G.shield(col, 1.7)
    : kind === 'standby' || kind === 'table' ? G.database(col, 1.5)
      : kind === 'session' ? G.node(col, 2.2)
        : kind === 'logentry' ? G.beacon(col, 1.4)
          : G.node(col, 2);
  ctx.group.add(centre);
  ctx.spinners.push({ obj: centre, speed: 0.05 });

  // Facts as orbiting slabs — enough to make the level feel like a place.
  var facts = lv.facts || [];
  var pts = ring(Math.max(facts.length, 1), 13, 0);
  facts.forEach(function (f, i) {
    var g = G.slab(f.tone === 'bad' ? TONE.bad : f.tone === 'warn' ? TONE.warn : f.tone === 'ok' ? TONE.ok : 0x4a9fd8,
      3, 0.6, 2, { emissiveIntensity: 0.2 });
    g.position.copy(pts[i]);
    g.position.y = Math.sin(i * 1.4) * 3.5;
    g.rotation.y = -Math.atan2(pts[i].z, pts[i].x);
    pick(ctx, g, { kind: 'fact', id: 'f' + i, label: f.k, color: 0x4a9fd8, focus: g.position.clone(), data: f },
      { name: f.k, sub: String(f.v), tone: f.tone, lift: 1.8, nearAt: 28, midAt: 74, hitRadius: 1.8 });
    spoke(ctx, V(0, 0, 0), g.position.clone(), 0x4a9fd8, { opacity: 0.18 });
  });

  return {
    pose: { az: 0.7, el: 0.3, dist: 44, tx: 0, ty: 0, tz: 0 },
    limits: [14, 110], fog: 0.0068,
    title: lv.title || 'Detail',
    subtitle: lv.subtitle || 'Illustrative record',
  };
};

/* feature id → environment builder. Anything absent falls back to
   feat_generic, which is still built from that feature's own content. */
E.FEATURE_ENVS = {
  'overview': 'feat_overview',
  'performance': 'feat_performance',
  'slow-queries': 'feat_slowqueries',
  'query-analysis': 'feat_slowqueries',
  'users': 'feat_users',
  'replication': 'feat_replication',
  'storage': 'feat_storage',
  'locks': 'feat_locks',
  'error-logs': 'feat_errorlogs',
  'tables': 'feat_tables',
  'indexes': 'feat_indexes',
};

E.MODULE_ENVS = {
  database: 'mod_database', cloud: 'mod_cloud', infra: 'mod_infra',
  agents: 'mod_agents', alerts: 'mod_alerts', logs: 'mod_logs', admin: 'mod_admin',
};

window.AEnvs = E;
})();
