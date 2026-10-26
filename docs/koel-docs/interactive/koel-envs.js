/* ===========================================================================
   KOEL environments — one builder per explorable level.

   The composition follows the diagram rather than a template: the third-party
   column is eighteen feeders on an arc, the data centre is a floor of racks,
   and OCI is a nested box — VCN containing a public subnet above a private
   subnet, with the Siebel stack as a block inside that. Entering each one
   should look like a different place, because on the diagram they are.
   =========================================================================== */
(function () {
'use strict';

var KS = window.KScene;
var G = KS.G;
var E = {};

function V(x, y, z) { return new THREE.Vector3(x, y, z); }
function arc(n, r, y, startDeg, spanDeg) {
  var out = [], s = (startDeg || 0) * Math.PI / 180;
  var span = (spanDeg == null ? 360 : spanDeg) * Math.PI / 180;
  for (var i = 0; i < n; i++) {
    var a = s + (n === 1 ? span / 2 : (i / (n - 1)) * span);
    out.push(V(Math.cos(a) * r, y || 0, Math.sin(a) * r));
  }
  return out;
}
function ring(n, r, y, startDeg) {
  var out = [], s = (startDeg || 0) * Math.PI / 180;
  for (var i = 0; i < n; i++) {
    var a = s + (i / n) * Math.PI * 2;
    out.push(V(Math.cos(a) * r, y || 0, Math.sin(a) * r));
  }
  return out;
}

function floor(ctx, color, size, div, y) {
  var g = new THREE.GridHelper(size || 260, div || 44, color, color);
  g.material.transparent = true; g.material.opacity = 0.13;
  g.position.y = y == null ? -16 : y;
  ctx.group.add(g);
}

/** A translucent boundary box — the diagram's swimlanes, in three dimensions. */
function zoneBox(ctx, cx, cy, cz, w, h, d, color, opacity) {
  var box = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: opacity || 0.04, depthWrite: false })
  );
  box.position.set(cx, cy, cz);
  ctx.group.add(box);
  var edge = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshBasicMaterial({ color: color, wireframe: true, transparent: true, opacity: 0.22 })
  );
  edge.position.set(cx, cy, cz);
  ctx.group.add(edge);
  return box;
}

function pick(ctx, group, node, label) {
  var hit = new THREE.Mesh(
    new THREE.SphereGeometry(label && label.hitRadius ? label.hitRadius : 3.4, 8, 6),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  group.add(hit);
  hit.userData.node = node;
  hit.userData.group = group;
  ctx.picks.push(hit);
  if (label) {
    var anchor = new THREE.Object3D();
    anchor.position.y = label.lift == null ? 3.6 : label.lift;
    group.add(anchor);
    ctx.labels.add(anchor, label);
  }
  ctx.group.add(group);
  return hit;
}

function spoke(ctx, a, b, color, opts) {
  var l = KS.link(ctx.group, a, b, color, opts);
  if (l.flow) ctx.flows.push(l.flow);
  return l;
}

/** A link that says what it is and which way it goes.

    Particles alone were not enough: in the estate view they read as decoration
    rather than as direction, and nothing on screen named the connection. So
    every meaningful edge now carries a chevron at its midpoint — two, facing
    apart, when the diagram draws arrows at both ends — and, optionally, a
    caption floating above the apex. */
function arrow(ctx, a, b, color, opts) {
  opts = opts || {};
  var l = spoke(ctx, a, b, color, opts);
  var curve = l.curve;
  var mid = curve.getPoint(0.5);
  var ahead = curve.getPoint(0.54), behind = curve.getPoint(0.46);
  var dir = new THREE.Vector3(ahead.x - behind.x, ahead.y - behind.y, ahead.z - behind.z);
  if (dir.length() < 1e-6) dir.set(1, 0, 0);
  dir.normalize();

  var size = opts.arrowSize || 1.5;
  function chev(d, offset) {
    var c = new THREE.Mesh(
      new THREE.ConeGeometry(size * 0.6, size * 1.7, 12),
      G.mat(color, { emissiveIntensity: 0.55 })
    );
    var q = new THREE.Quaternion();
    q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
    c.quaternion.copy(q);
    c.position.set(mid.x + d.x * offset, mid.y + d.y * offset, mid.z + d.z * offset);
    ctx.group.add(c);
    return c;
  }

  if (opts.both) {
    chev(dir, size * 1.4);
    chev(dir.clone().multiplyScalar(-1), size * 1.4);
  } else {
    chev(dir, 0);
  }

  if (opts.label) {
    var cap = KS.textSprite(opts.label, {
      size: 34, worldHeight: opts.labelSize || 2.6, opacity: 0.95, plate: true,
    });
    cap.position.set(mid.x, mid.y + (opts.labelLift == null ? size * 3.2 : opts.labelLift), mid.z);
    ctx.group.add(cap);
  }
  return l;
}

/* ── shapes the diagram needs that the base factory has no word for ──── */

/** A firewall: a slotted barrier rather than another box. */
function firewall(color, scale) {
  scale = scale || 1;
  var g = new THREE.Group();
  for (var i = 0; i < 5; i++) {
    for (var j = 0; j < 3; j++) {
      var brick = new THREE.Mesh(
        new THREE.BoxGeometry(1.5 * scale, 0.62 * scale, 0.42 * scale),
        G.mat(color, { emissiveIntensity: 0.16 })
      );
      brick.position.set((i - 2) * 1.62 * scale + (j % 2 ? 0.4 : 0) * scale, (j - 1) * 0.72 * scale, 0);
      g.add(brick);
    }
  }
  g.add(G.glow(color, 4, 0.05));
  return g;
}

/** A VPN gateway: two cones meeting, a tunnel mouth. */
function gateway(color, scale) {
  scale = scale || 1;
  var g = new THREE.Group();
  var a = new THREE.Mesh(new THREE.ConeGeometry(1.5 * scale, 2.2 * scale, 16),
    G.mat(color, { emissiveIntensity: 0.3 }));
  a.rotation.z = Math.PI / 2; a.position.x = -1.1 * scale;
  var b = a.clone(); b.rotation.z = -Math.PI / 2; b.position.x = 1.1 * scale;
  g.add(a); g.add(b);
  for (var r = 0; r < 3; r++) {
    var t = new THREE.Mesh(new THREE.TorusGeometry((1.6 + r * 0.32) * scale, 0.05 * scale, 6, 36),
      new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.55 - r * 0.14 }));
    t.rotation.y = Math.PI / 2;
    g.add(t);
  }
  g.add(G.glow(color, 3.4 * scale, 0.07));
  return g;
}

/** A load balancer: one inlet fanning to several outlets. */
function balancer(color, scale) {
  scale = scale || 1;
  var g = new THREE.Group();
  var core = new THREE.Mesh(new THREE.CylinderGeometry(1.5 * scale, 1.5 * scale, 0.7 * scale, 6),
    G.mat(color, { emissiveIntensity: 0.3 }));
  g.add(core);
  for (var i = 0; i < 3; i++) {
    var a = (i / 3) * Math.PI * 2;
    var arm = new THREE.Mesh(new THREE.BoxGeometry(2.4 * scale, 0.12 * scale, 0.12 * scale),
      new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.6 }));
    arm.position.set(Math.cos(a) * 1.9 * scale, -0.5 * scale, Math.sin(a) * 1.9 * scale);
    arm.rotation.y = -a;
    g.add(arm);
  }
  g.add(G.glow(color, 3 * scale, 0.06));
  return g;
}

/** The ingestion hub: a wide collector dish, because eighteen things aim at it. */
function hub(color, scale) {
  scale = scale || 1;
  var g = new THREE.Group();
  var dish = new THREE.Mesh(new THREE.CylinderGeometry(3.6 * scale, 1.5 * scale, 1.5 * scale, 28, 1, true),
    new THREE.MeshStandardMaterial({
      color: color, metalness: 0.6, roughness: 0.3, emissive: color,
      emissiveIntensity: 0.22, side: THREE.DoubleSide, transparent: true, opacity: 0.85,
    }));
  g.add(dish);
  var stem = new THREE.Mesh(new THREE.CylinderGeometry(0.45 * scale, 0.45 * scale, 2.4 * scale, 14),
    G.mat(color, { emissiveIntensity: 0.18 }));
  stem.position.y = -1.9 * scale; g.add(stem);
  var rim = new THREE.Mesh(new THREE.TorusGeometry(3.6 * scale, 0.09 * scale, 8, 56),
    new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.8 }));
  rim.rotation.x = Math.PI / 2; rim.position.y = 0.75 * scale;
  g.add(rim);
  g.add(G.glow(color, 5 * scale, 0.06));
  return g;
}

function shapeFor(geo, color, scale) {
  switch (geo) {
    case 'wall': return firewall(color, scale);
    case 'gateway': return gateway(color, scale);
    case 'lb': return balancer(color, scale);
    case 'hub': return hub(color, scale);
    case 'database': return G.database(color, scale);
    case 'rack': return G.rack(color, scale, 0.72);
    case 'shield': return G.shield(color, scale);
    case 'slab': return G.slab(color, 3.4 * scale, 1.1 * scale, 2.6 * scale, { emissiveIntensity: 0.2 });
    default: return G.node(color, scale);
  }
}

/* ═══ LEVEL 0 — the whole estate, over the Earth ═════════════════════ */

E.estate = function (ctx) {
  var D = ctx.data;

  // The planet sits below the estate, filling the lower half of the frame.
  // It is a setting, not a claim: see the panel note — the diagram names no
  // country, region or data-centre site anywhere.
  var earth = KS.G.earth(30);
  earth.position.set(0, -40, 0);
  earth.rotation.z = 0.41;                       // axial tilt, for the look
  ctx.group.add(earth);
  ctx.spinners.push({ obj: earth.userData.spin, speed: 0.022 });

  // Three platforms, left to right in the order data travels. The previous
  // version drew three big empty wireframe boxes with specks inside them;
  // nothing about that said what was where, or which way anything moved.
  var LANE = [
    { zone: D.ZONES[0], x: -66, lift: 18 },      // third-party
    { zone: D.ZONES[1], x: 0, lift: 13 },        // on-premises
    { zone: D.ZONES[2], x: 68, lift: 31 },       // OCI
  ];
  var DECK = 8;

  function pad(x, color, radius) {
    var g = new THREE.Group();
    g.position.set(x, DECK, 0);
    var disc = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius * 0.88, 1.1, 48),
      new THREE.MeshStandardMaterial({
        color: color, metalness: 0.6, roughness: 0.45,
        emissive: color, emissiveIntensity: 0.16, transparent: true, opacity: 0.4,
      })
    );
    disc.position.y = -1.4;
    g.add(disc);
    var ring = new THREE.Mesh(
      new THREE.TorusGeometry(radius, 0.16, 8, 72),
      new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.75 })
    );
    ring.rotation.x = Math.PI / 2; ring.position.y = -0.85;
    g.add(ring);

    // A light column down to the planet, so each platform is anchored to the
    // Earth rather than floating in a void.
    var beam = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.1, radius * 0.5, 34, 20, 1, true),
      new THREE.MeshBasicMaterial({
        color: color, transparent: true, opacity: 0.07,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    beam.position.y = -18.5;
    g.add(beam);
    return g;
  }

  function caption(g, text, y, size) {
    var sp = KS.textSprite(text, { size: 30, worldHeight: size || 2.6, opacity: 0.94, plate: true });
    sp.position.set(0, y, 0);
    g.add(sp);
  }

  LANE.forEach(function (lane, li) {
    var z = lane.zone;
    var radius = li === 2 ? 17 : 13;
    var g = pad(lane.x, z.color, radius);

    if (z.id === 'thirdparty') {
      // Eighteen feeders in three readable ranks, tinted by what they are,
      // all facing the way they send.
      D.FEEDS.forEach(function (f, i) {
        var col = D.FEED_KINDS[f.kind].color;
        var row = i % 6, colIdx = Math.floor(i / 6);
        var m = G.slab(col, 5.2, 0.8, 1.9, { emissiveIntensity: 0.34 });
        m.position.set((colIdx - 1) * 6.6, 1.4 + row * 2.3, 0);
        g.add(m);
      });
      caption(g, D.FEEDS.length + ' external feeds · 5 protocols', -6.5, 2.7);

    } else if (z.id === 'onprem') {
      // Seven components in a 4 + 3 grid on the deck, the hub raised and lit.
      D.ONPREM.forEach(function (c, i) {
        var m = shapeFor(c.geo, c.color, 0.62);
        var row = i < 4 ? 0 : 1, col = i < 4 ? i : i - 4;
        var n = i < 4 ? 4 : 3;
        m.position.set((col - (n - 1) / 2) * 5.6, c.id === 'sftp' ? 6.2 : 2.4, row * 6.4 - 3.2);
        if (c.id === 'sftp') {
          ctx.spinners.push({ obj: m, speed: 0.22 });
          ctx.pulsers.push({ obj: m, base: 1, amt: 0.035, rate: 1.3 });
        }
        g.add(m);
      });
      caption(g, D.ONPREM.length + ' components · 1 ingestion hub', -6.5, 2.7);

    } else {
      // The VCN as three stacked, labelled decks — the nesting the diagram
      // draws, at a glance.
      var decks = [
        { n: D.PUBLIC_SUBNET.length, label: 'Public subnet · DMZ edge', color: 0x0284c7, y: 16, w: 26 },
        { n: D.PRIVATE_SUBNET.length, label: 'Private subnet · app & data', color: 0x16a34a, y: 9, w: 30 },
        { n: D.SIEBEL.reduce(function (a, c) { return a + (c.count || 1); }, 0),
          label: 'Siebel CRM stack', color: 0xd97706, y: 2.2, w: 27 },
      ];
      decks.forEach(function (d) {
        var plate = G.slab(d.color, d.w, 1.1, 15, { emissiveIntensity: 0.26 });
        plate.position.y = d.y;
        g.add(plate);
        for (var i = 0; i < d.n; i++) {
          var cell = new THREE.Mesh(
            new THREE.BoxGeometry(1.5, 1.5, 1.5),
            G.mat(d.color, { emissiveIntensity: 0.5 })
          );
          var per = Math.min(d.n, 6);
          cell.position.set(((i % per) - (per - 1) / 2) * 2.6, d.y + 1.5, Math.floor(i / per) * 2.6 - 1.4);
          g.add(cell);
        }
        var sp = KS.textSprite(d.n + ' · ' + d.label, { size: 26, worldHeight: 2.2, opacity: 0.92, plate: true });
        sp.position.set(0, d.y + 3.4, 0);
        g.add(sp);
      });
      caption(g, 'One OCI region · one VCN', -6.5, 2.7);
      ctx.pulsers.push({ obj: g, base: 1, amt: 0.008, rate: 0.5 });
    }

    pick(ctx, g, { kind: 'zone', id: z.id, label: z.label, color: z.color,
      focus: new THREE.Vector3(lane.x, DECK, 0), data: z },
      { name: z.label, sub: z.what, cta: 'Click to enter', tone: 'accent',
        lift: lane.lift, alwaysOn: true, hitRadius: radius });
  });

  // ── the flows, named and pointed ────────────────────────────────────────
  var P = function (x, y) { return V(x, y == null ? DECK : y, 0); };

  arrow(ctx, P(-55, 11), P(-15, 11), 0x0284c7, {
    flow: true, count: 18, speed: 0.16, lift: 11, size: 0.62, opacity: 0.22,
    label: '18 ingestion feeds →', arrowSize: 1.9, labelLift: 6.5, labelSize: 3.4,
  });

  arrow(ctx, P(13, 12), P(51, 12), 0xf59e0b, {
    flow: true, count: 9, speed: 0.24, lift: 14, opacity: 0.24,
    both: true, label: 'IPsec / MACsec tunnel ⇄', arrowSize: 2, labelLift: 8.5, labelSize: 3.4,
  });
  spoke(ctx, P(51, 12), P(13, 12), 0xf59e0b,
    { flow: true, count: 9, speed: 0.24, lift: 14, reverse: true, opacity: 0.04 });

  arrow(ctx, P(15, 1), P(58, 1), 0x35c3f3, {
    flow: true, count: 6, speed: 0.19, lift: -8, opacity: 0.18, size: 0.5,
    label: 'SFTP mount bridge → ERP', arrowSize: 1.7, labelLift: -12, labelSize: 3,
  });

  // The one-line reading of the whole picture.
  var legend = KS.textSprite(
    'Who sends it   →   where it lands   →   where it runs',
    { size: 34, worldHeight: 4.6, opacity: 0.9, plate: true }
  );
  legend.position.set(-14, -7, 0);
  ctx.group.add(legend);

  return {
    // The three platforms are strung out along X, so the camera has to sit on
    // Z and look at them broadside. At az near 0 it stared down the length of
    // the estate: the near platform loomed, the far one shrank to nothing, and
    // all three projected on top of each other. A few degrees off 90 keeps
    // some perspective without reintroducing that. ty looks above the decks,
    // which drops the whole estate clear of the environment title.
    pose: { az: Math.PI / 2 + 0.07, el: 0.19, dist: 200, tx: 0, ty: 2, tz: 0 },
    limits: [80, 380], fog: 0.0019,
    title: 'KOEL hybrid estate',
    subtitle: 'Left to right, the way data travels — 18 external feeds, one data centre, one OCI region',
  };
};

/* ═══ LEVEL 1 — third-party ecosystem ════════════════════════════════ */

E.zone_thirdparty = function (ctx) {
  var D = ctx.data;
  floor(ctx, 0x1e3a6e, 300, 46, -40);

  // Eighteen names will not fit as HTML labels — the de-overlap pass can place
  // perhaps six before it starts stacking them. So each feed gets its name in
  // the scene, on a fixed two-column board where nothing can collide.
  var target = V(44, 0, 0);
  var h = hub(0x0284c7, 1.9);
  h.position.copy(target);
  ctx.group.add(h);
  ctx.spinners.push({ obj: h, speed: 0.1 });
  ctx.pulsers.push({ obj: h, base: 1, amt: 0.02, rate: 1.2 });
  ctx.labels.add(h, {
    name: 'Integration Server — SFTP Mount Point',
    sub: 'Central ingestion hub for all 18 feeds',
    alwaysOn: true, tone: 'accent', lift: 0,
  });

  var COLS = 2, ROWS = 9, COLX = [-54, -14], ROWY = 8.8;
  D.FEEDS.forEach(function (f, i) {
    var kind = D.FEED_KINDS[f.kind];
    var col = Math.floor(i / ROWS), row = i % ROWS;
    var p = V(COLX[col], (ROWS - 1) / 2 * ROWY - row * ROWY, col === 0 ? -10 : 8);

    var g = new THREE.Group();
    g.position.copy(p);
    var card = G.slab(kind.color, 7, 1.1, 3.4, { emissiveIntensity: 0.32 });
    g.add(card);
    var name = KS.textSprite(f.n, { size: 30, worldHeight: 2.7, opacity: 0.96, plate: true });
    name.position.set(0, 3.2, 0);
    g.add(name);
    var proto = KS.textSprite(f.p, { size: 24, worldHeight: 1.9, opacity: 0.8, plate: true });
    proto.position.set(0, -2.6, 0);
    g.add(proto);

    pick(ctx, g, { kind: 'feed', id: 'feed-' + i, label: f.n, color: kind.color, focus: p, data: f },
      { name: f.n, sub: f.p + '  ·  ' + kind.label, cta: 'Click for detail',
        lift: 5.4, nearAt: 34, midAt: 95, hitRadius: 4 });

    // Protocol decides the flow: a webhook pushes in bursts, SFTP moves files.
    spoke(ctx, p, target, kind.color, {
      flow: true, count: f.p === 'Webhook' ? 2 : 4,
      speed: f.p.indexOf('HTTP') >= 0 ? 0.3 : 0.14,
      lift: 4, opacity: 0.18, size: 0.5,
    });
  });

  var conv = KS.textSprite('all 18 terminate here  →', { size: 32, worldHeight: 3.2, opacity: 0.95, plate: true });
  conv.position.set(16, 24, 0);
  ctx.group.add(conv);

  var cap = KS.textSprite('18 feeds · 6 banking · 5 protocols · one landing point',
    { size: 32, worldHeight: 3.4, opacity: 0.9, plate: true });
  cap.position.set(0, -50, 0);
  ctx.group.add(cap);

  return {
    pose: { az: Math.PI / 2 + 0.05, el: 0.05, dist: 152, tx: -4, ty: 0, tz: 0 },
    limits: [40, 260], fog: 0.0022,
    title: 'Third-Party Integration Ecosystem',
    subtitle: '18 external feeds, every one of them ending at the same integration server',
  };
};

/* ═══ LEVEL 1 — on-premises data centre ══════════════════════════════ */

E.zone_onprem = function (ctx) {
  var D = ctx.data;
  floor(ctx, 0x3f4a5f, 240, 40, -30);

  // Two rows, and the split is the point: the diagram draws edges to exactly
  // two of these seven. The rest are production systems whose place in the
  // flow it never states.
  var CONNECTED = ['sftp', 'onprem_vpn'];
  var lay = {
    // Upper band: the two components the diagram actually connects.
    sftp: V(-20, 15, 0), onprem_vpn: V(26, 15, 0),
    // Lower band: the five it draws nothing to.
    ad: V(-58, -17, 0), firewall: V(-29, -17, 0), sqlserver: V(0, -17, 0),
    discoverer: V(29, -17, 0), plm: V(58, -17, 0),
  };

  D.ONPREM.forEach(function (c) {
    var p = lay[c.id];
    var connected = CONNECTED.indexOf(c.id) >= 0;
    var g = shapeFor(c.geo, c.color, connected ? 1.25 : 0.85);
    g.position.copy(p);
    if (c.id === 'sftp') {
      ctx.spinners.push({ obj: g, speed: 0.1 });
      ctx.pulsers.push({ obj: g, base: 1, amt: 0.02, rate: 1.1 });
    }
    if (!connected) {
      // A dashed ring is how this document says "no edges drawn" — an absence
      // that is itself information, not a gap in the drawing.
      var ring = new THREE.Mesh(new THREE.TorusGeometry(5, 0.09, 6, 44),
        new THREE.MeshBasicMaterial({ color: 0x8496b3, transparent: true, opacity: 0.55 }));
      ring.rotation.x = Math.PI / 2; ring.position.y = -3.4;
      g.add(ring);
    }
    var name = KS.textSprite(c.label, { size: 28, worldHeight: 2.5, opacity: 0.95, plate: true });
    name.position.set(0, connected ? 8.5 : 6.4, 0);
    g.add(name);

    pick(ctx, g, { kind: 'onprem', id: c.id, label: c.label, color: c.color, focus: p, data: c },
      { name: c.label, sub: c.sub || String(c.what).slice(0, 70), cta: 'Click for detail',
        tone: c.critical ? 'warn' : connected ? undefined : 'warn',
        lift: connected ? 13 : 11, nearAt: 40, midAt: 110, hitRadius: 5 });
  });

  var shelf = KS.textSprite('No connections drawn to these five on the diagram',
    { size: 28, worldHeight: 2.9, opacity: 0.85, plate: true });
  shelf.position.set(0, -30, 0);
  ctx.group.add(shelf);

  // The three edges the diagram draws across this zone's boundary.
  arrow(ctx, V(-70, 15, 0), lay.sftp, 0x0284c7, {
    flow: true, count: 10, speed: 0.2, lift: 6,
    label: '18 feeds in  →', arrowSize: 1.7, labelLift: 6, labelSize: 3 });
  // Routed high so it clears the VPN gateway it passes over.
  arrow(ctx, lay.sftp, V(72, 32, 0), 0x0284c7, {
    flow: true, count: 5, speed: 0.22, lift: 7,
    label: 'SFTP mount bridge  →  Oracle ERP', arrowSize: 1.7, labelLift: 7, labelSize: 3 });
  arrow(ctx, lay.onprem_vpn, V(74, 4, 0), 0xf59e0b, {
    flow: true, count: 6, speed: 0.26, lift: -5, both: true,
    label: 'IPsec / MACsec tunnel  ⇄  OCI', arrowSize: 1.7, labelLift: -7, labelSize: 3 });

  return {
    pose: { az: Math.PI / 2 + 0.05, el: 0.11, dist: 150, tx: 0, ty: 2, tz: 0 },
    limits: [42, 280], fog: 0.0024,
    title: 'On-Premises Data Centre',
    subtitle: 'Seven components — and the diagram draws edges to only two of them',
  };
};

/* ═══ LEVEL 1 — OCI region ═══════════════════════════════════════════ */

E.zone_oci = function (ctx) {
  var D = ctx.data;
  floor(ctx, 0x6b2f28, 320, 48, -54);

  // Three decks instead of three nested wireframe boxes. The boxes were almost
  // entirely empty space, which is what made the components read as specks.
  function deck(y, w, d, color, title) {
    var plate = G.slab(color, w, 1.1, d, { emissiveIntensity: 0.14, transparent: true, opacity: 0.34 });
    plate.position.set(0, y, 0);
    ctx.group.add(plate);
    var edge = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.3, d),
      new THREE.MeshBasicMaterial({ color: color, wireframe: true, transparent: true, opacity: 0.35 })
    );
    edge.position.set(0, y, 0);
    ctx.group.add(edge);
    var cap = KS.textSprite(title, { size: 28, worldHeight: 3, opacity: 0.9, plate: true });
    cap.position.set(-w / 2 + 16, y + 3.2, d / 2 + 4);
    ctx.group.add(cap);
  }

  var siebelTotal = D.SIEBEL.reduce(function (a, c) { return a + (c.count || 1); }, 0);
  deck(30, 104, 26, 0x0284c7, 'Public subnet · DMZ edge · ' + D.PUBLIC_SUBNET.length + ' components');
  deck(0, 128, 34, 0x16a34a, 'Private subnet · application & data · ' + D.PRIVATE_SUBNET.length + ' components');
  deck(-34, 112, 26, 0xd97706, 'Siebel CRM stack · ' + siebelTotal + ' servers across ' + D.SIEBEL.length + ' tiers');

  var lay = {
    oci_vpn: V(-30, 36, 0), lb: V(30, 36, 0),

    // One row, left to right in the order the diagram's edges run, so no two
    // components ever share a screen column.
    erp_app: V(-56, 7, 0), erp_db: V(-40, 7, 0), bip: V(-24, 7, 0), apex: V(-8, 7, 0),
    lgm: V(8, 7, 0), odi: V(24, 7, 0), adw: V(40, 7, 0), adw_apex: V(56, 7, 0),

    siebel_gtw: V(-48, -27, 0), siebel_web: V(-24, -27, 0), siebel_app: V(0, -27, 0),
    siebel_bip: V(24, -27, 0), siebel_db: V(48, -27, 0),
  };

  function place(list, kind, scale) {
    list.forEach(function (c) {
      var p = lay[c.id];
      if (!p) return;
      var g = shapeFor(c.geo, c.color, scale);
      g.position.copy(p);
      if (c.id === 'erp_db' || c.id === 'adw') ctx.spinners.push({ obj: g, speed: 0.07 });
      if (c.id === 'erp_app') {
        // The diagram's own words — "Single Compute Node" — beside tiers that
        // are all doubled. The ring is that sentence, drawn.
        var warn = new THREE.Mesh(new THREE.TorusGeometry(5.4, 0.12, 8, 48),
          new THREE.MeshBasicMaterial({ color: 0xf2b23c, transparent: true, opacity: 0.9 }));
        warn.rotation.x = Math.PI / 2; warn.position.y = -3.6;
        g.add(warn);
        ctx.pulsers.push({ obj: warn, base: 1, amt: 0.05, rate: 1.5 });
      }
      var short = c.label.replace(/^\d+x\s*/, '').replace(/\s*\(.*\)$/, '');
      var name = KS.textSprite(short + (c.count ? '  ×' + c.count : ''),
        { size: 26, worldHeight: 2.5, opacity: 0.95, plate: true });
      name.position.set(0, lay[c.id] && Math.round(lay[c.id].x / 16) % 2 ? 11 : 6.4, 0);
      g.add(name);

      pick(ctx, g, { kind: kind, id: c.id, label: c.label, color: c.color, focus: p, data: c },
        { name: c.label, sub: c.sub || String(c.what).slice(0, 68), cta: 'Click for detail',
          tone: c.critical ? 'warn' : undefined, lift: 11, nearAt: 42, midAt: 118, hitRadius: 5 });
    });
  }

  place(D.PUBLIC_SUBNET, 'oci', 1.15);
  place(D.PRIVATE_SUBNET, 'oci', 1.05);
  place(D.SIEBEL, 'oci', 0.9);

  // Every edge the diagram draws inside OCI, named and pointed.
  // Captions ride above the name band; the two cross-deck links hang in the
  // gap between decks, where nothing else is drawn.
  arrow(ctx, lay.erp_app, lay.erp_db, 0x16a34a, {
    flow: true, count: 7, speed: 0.3, lift: 6, both: true,
    label: 'App ⇄ DB', arrowSize: 1.4, labelLift: 10, labelSize: 2.6 });
  arrow(ctx, lay.odi, lay.adw, 0xea580c, {
    flow: true, count: 5, speed: 0.2, lift: 6,
    label: 'ETL pipeline →', arrowSize: 1.4, labelLift: 10, labelSize: 2.6 });
  arrow(ctx, lay.adw, lay.adw_apex, 0x9333ea, {
    flow: true, count: 3, speed: 0.22, lift: 6,
    label: 'ADW → Analytics APEX', arrowSize: 1.4, labelLift: 16, labelSize: 2.6 });
  arrow(ctx, lay.erp_db, lay.siebel_db, 0x16a34a, {
    flow: true, count: 5, speed: 0.18, lift: 4, both: true,
    label: 'ERP DB ⇄ Siebel DB', arrowSize: 1.4, labelLift: 3, labelSize: 2.6 });
  arrow(ctx, lay.siebel_db, lay.adw, 0xea580c, {
    flow: true, count: 4, speed: 0.16, lift: 2,
    label: 'Siebel → ADW (via ODI)', arrowSize: 1.4, labelLift: -5, labelSize: 2.6 });

  // Drawn faint on purpose: the tunnel arrives at the gateway, and the diagram
  // does not carry it on to any particular backend.
  spoke(ctx, lay.oci_vpn, lay.erp_app, 0xf59e0b, { opacity: 0.12, lift: 4 });

  var note = KS.textSprite('The public load balancer has no edge leaving it on the diagram',
    { size: 26, worldHeight: 2.7, opacity: 0.82, plate: true });
  note.position.set(30, 47, 0);
  ctx.group.add(note);

  return {
    pose: { az: Math.PI / 2 + 0.07, el: 0.09, dist: 164, tx: 0, ty: 1, tz: 0 },
    limits: [60, 380], fog: 0.0017,
    title: 'Oracle Cloud Infrastructure',
    subtitle: 'One VCN — public DMZ above, the private core below, Siebel inside it',
  };
};

/* ═══ LEVEL 2 — the Siebel stack on its own ══════════════════════════ */

E.siebel = function (ctx) {
  var D = ctx.data;
  floor(ctx, 0x6b4a16, 200, 34, -34);

  var total = D.SIEBEL.reduce(function (a, c) { return a + (c.count || 1); }, 0);
  var STEP = 27;
  var left = -(D.SIEBEL.length - 1) / 2 * STEP;

  D.SIEBEL.forEach(function (c, i) {
    var n = c.count || 1;
    var g = new THREE.Group();
    g.position.set(left + i * STEP, 0, 0);

    // The count is the height of the column, so "four app servers" is
    // something you can see rather than something you have to read.
    for (var k = 0; k < n; k++) {
      var unit = shapeFor(c.geo, c.color, 0.8);
      unit.position.y = k * 5.4 - (n - 1) * 2.7;
      g.add(unit);
      if (c.id === 'siebel_db') ctx.spinners.push({ obj: unit, speed: 0.08 });
    }

    var pad = new THREE.Mesh(
      new THREE.CylinderGeometry(7.4, 6.6, 0.7, 32),
      new THREE.MeshStandardMaterial({
        color: c.color, metalness: 0.6, roughness: 0.5,
        emissive: c.color, emissiveIntensity: 0.14, transparent: true, opacity: 0.4,
      })
    );
    pad.position.y = -(n - 1) * 2.7 - 4.4;
    g.add(pad);

    var short = c.label.replace(/^\d+x\s*/, '');
    var name = KS.textSprite(short, { size: 28, worldHeight: 2.8, opacity: 0.96, plate: true });
    name.position.set(0, (n - 1) * 2.7 + 7.4, 0);
    g.add(name);

    var count = KS.textSprite('×' + n, { size: 40, worldHeight: 4, opacity: 0.95, plate: true });
    count.position.set(0, -(n - 1) * 2.7 - 9.6, 0);
    g.add(count);

    pick(ctx, g, { kind: 'siebel', id: c.id, label: c.label, color: c.color,
      focus: g.position.clone(), data: c },
      { name: c.label, sub: c.sub || c.what, cta: 'Click for detail',
        lift: (n - 1) * 2.7 + 13, nearAt: 44, midAt: 120, hitRadius: 8 });
  });

  var none = KS.textSprite('The diagram draws no edges inside this stack — only its tiers and counts',
    { size: 28, worldHeight: 3.2, opacity: 0.86, plate: true });
  none.position.set(0, 27, 0);
  ctx.group.add(none);

  // Composed from the data, never written out by hand: a count typed into a
  // caption is a count that will be wrong the next time the data changes.
  var tally = D.SIEBEL.map(function (c) {
    return c.count + '× ' + c.label.replace(/^\d+x\s*/, '').replace(/^Siebel\s*/, '');
  }).join('   ·   ');
  var cap = KS.textSprite(tally + '   =   ' + total + ' servers',
    { size: 28, worldHeight: 3.2, opacity: 0.9, plate: true });
  cap.position.set(0, -27, 0);
  ctx.group.add(cap);

  return {
    pose: { az: Math.PI / 2 + 0.04, el: 0.07, dist: 154, tx: 0, ty: 0, tz: 0 },
    limits: [40, 260], fog: 0.0018,
    title: 'Siebel Cloud CRM Stack',
    subtitle: total + ' servers across ' + D.SIEBEL.length + ' tiers, with its own dedicated database',
  };
};

/* ═══ LEVEL 2 — every connection, as an ordered list ═════════════════ */

E.flows = function (ctx) {
  var D = ctx.data;
  floor(ctx, 0x2a3f5f, 220, 36, -48);

  var ROW = 13;
  var top = (D.FLOWS.length - 1) / 2 * ROW;

  D.FLOWS.forEach(function (f, i) {
    var two = f.dir === 'bidirectional';
    var col = f.critical ? 0xff6b7f : two ? 0x35c3f3 : 0x3ad39a;
    var y = top - i * ROW;
    var g = new THREE.Group();
    g.position.set(0, y, 0);

    // The track: a node at each end and a bar between them. Direction is the
    // arrowhead — one for a one-way edge, two facing apart for a two-way one,
    // which is exactly how the diagram draws them.
    var a = G.node(col, 0.85); a.position.x = -22; g.add(a);
    var b = G.node(col, 0.85); b.position.x = 22; g.add(b);
    var bar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.22, 44, 10),
      G.mat(col, { emissiveIntensity: 0.4 })
    );
    bar.rotation.z = Math.PI / 2;
    g.add(bar);

    function head(x, dir) {
      var c = new THREE.Mesh(new THREE.ConeGeometry(1.15, 2.8, 14), G.mat(col, { emissiveIntensity: 0.6 }));
      c.rotation.z = dir > 0 ? -Math.PI / 2 : Math.PI / 2;
      c.position.x = x;
      g.add(c);
    }
    if (two) { head(16, 1); head(-16, -1); } else { head(14, 1); }

    if (f.critical) {
      var halo = new THREE.Mesh(
        new THREE.TorusGeometry(26, 0.12, 8, 64),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.45 })
      );
      halo.rotation.x = Math.PI / 2;
      g.add(halo);
      ctx.pulsers.push({ obj: halo, base: 1, amt: 0.03, rate: 1.4 });
    }

    var name = KS.textSprite(f.label, { size: 30, worldHeight: 3, opacity: 0.96, plate: true });
    name.position.set(0, 4.2, 0);
    g.add(name);

    var short = function (t) { return t.replace(/\s*\(.*\)$/, '').replace(/^\d+x\s*/, ''); };
    var ends = KS.textSprite(short(f.from) + '   ' + (two ? '⇄' : '→') + '   ' + short(f.to),
      { size: 24, worldHeight: 2.1, opacity: 0.82, plate: true });
    ends.position.set(0, -4.2, 0);
    g.add(ends);

    pick(ctx, g, { kind: 'flow', id: f.id, label: f.label, color: col,
      focus: new THREE.Vector3(0, y, 0), data: f },
      { name: f.label, sub: f.from + '  →  ' + f.to, cta: 'Click for detail',
        tone: f.critical ? 'bad' : undefined, lift: 7, nearAt: 999, midAt: 999, hitRadius: 7 });
  });

  var cap = KS.textSprite('One arrowhead = one direction  ·  two = the diagram draws both  ·  red = no alternative path drawn',
    { size: 28, worldHeight: 3, opacity: 0.88, plate: true });
  cap.position.set(0, top + ROW * 0.95, 0);
  ctx.group.add(cap);

  return {
    pose: { az: Math.PI / 2 + 0.02, el: 0.03, dist: 152, tx: 0, ty: 0, tz: 0 },
    limits: [40, 240], fog: 0.0016,
    title: 'Data flows',
    subtitle: D.FLOWS.length + ' connections, exactly as the diagram draws them',
  };
};

E.ZONE_ENVS = { thirdparty: 'zone_thirdparty', onprem: 'zone_onprem', oci: 'zone_oci' };

window.KEnvs = E;
})();
