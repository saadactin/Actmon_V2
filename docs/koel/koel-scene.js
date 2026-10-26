/* ===========================================================================
   Scene engine — renderer, camera controller, label LOD, geometry factory.

   Split out from the app because these four things have nothing to do with
   ACTMON: they are the 3D substrate every environment is built on. The
   environments themselves live in actmon-envs.js and know nothing about
   cameras or raycasting.

   Classic script (no modules) so the document opens from file://. Everything
   is published on window.AScene. Nothing here touches THREE at load time — a
   blocked CDN must not take the document down.
   =========================================================================== */
(function () {
'use strict';

var S = {};            // the public surface
var GS = typeof gsap !== 'undefined' ? gsap : null;

/* ── camera controller ───────────────────────────────────────────────────
   Spherical around a movable target. Every motion goes through a target pose
   that is eased toward, so a wheel, a click, a breadcrumb and the tour all
   produce the same quality of movement — the brief's "intentional
   acceleration, no disorienting spins". Azimuth is never wrapped, so a tween
   from 350° to 10° travels 20° forward rather than 340° backward. */
function Camera(cam) {
  this.cam = cam;
  this.cur = { az: 0.6, el: 0.36, dist: 120, tx: 0, ty: 0, tz: 0 };
  this.dest = { az: 0.6, el: 0.36, dist: 120, tx: 0, ty: 0, tz: 0 };
  this.limits = { min: 14, max: 320, elMin: -0.45, elMax: 1.24 };
  this.travelling = false;
  this._tween = null;
}

Camera.prototype.setLimits = function (min, max) {
  this.limits.min = min; this.limits.max = max;
  this.dest.dist = Math.max(min, Math.min(max, this.dest.dist));
};

/** Snap with no animation — used when a scene is swapped under the camera. */
Camera.prototype.jump = function (pose) {
  Object.assign(this.dest, pose);
  Object.assign(this.cur, this.dest);
  this.apply();
};

/** Cinematic move. `arc` lifts the camera on the way so a long travel reads as
    a flight rather than a dolly. */
Camera.prototype.travel = function (pose, opts) {
  opts = opts || {};
  var self = this;
  var dur = opts.duration != null ? opts.duration : 1.5;

  if (this._tween) { this._tween.kill(); this._tween = null; }
  if (!GS || opts.instant) { this.jump(pose); if (opts.onDone) opts.onDone(); return; }

  // Shortest angular path, so the scene never spins the long way round.
  var target = Object.assign({}, pose);
  if (target.az != null) {
    var d = target.az - this.dest.az;
    while (d > Math.PI) { target.az -= Math.PI * 2; d = target.az - this.dest.az; }
    while (d < -Math.PI) { target.az += Math.PI * 2; d = target.az - this.dest.az; }
  }

  this.travelling = true;
  var lift = opts.arc ? Math.min(0.28, Math.abs((target.dist || this.dest.dist) - this.dest.dist) / 400) : 0;

  this._tween = GS.timeline({
    onComplete: function () { self.travelling = false; self._tween = null; if (opts.onDone) opts.onDone(); },
  });
  if (lift > 0) {
    this._tween.to(this.dest, { el: this.dest.el + lift, duration: dur * 0.42, ease: 'sine.inOut' }, 0);
  }
  this._tween.to(this.dest, Object.assign({ duration: dur, ease: 'power2.inOut' }, target), 0);
};

Camera.prototype.nudge = function (dAz, dEl) {
  this.dest.az -= dAz;
  this.dest.el = Math.max(this.limits.elMin, Math.min(this.limits.elMax, this.dest.el + dEl));
};

Camera.prototype.zoom = function (delta) {
  this.dest.dist = Math.max(this.limits.min, Math.min(this.limits.max, this.dest.dist * (1 + delta)));
};

Camera.prototype.pan = function (dx, dy) {
  // Pan in the camera's own screen plane, otherwise dragging feels wrong at
  // any elevation other than horizontal.
  var right = new THREE.Vector3(), up = new THREE.Vector3();
  this.cam.matrixWorld.extractBasis(right, up, new THREE.Vector3());
  var k = this.cur.dist * 0.0016;
  this.dest.tx -= (right.x * dx - up.x * dy) * k;
  this.dest.ty -= (right.y * dx - up.y * dy) * k;
  this.dest.tz -= (right.z * dx - up.z * dy) * k;
};

Camera.prototype.step = function (dt, reduced) {
  var k = reduced ? 1 : 1 - Math.pow(0.0012, dt);   // frame-rate independent ease
  var c = this.cur, d = this.dest;
  c.az += (d.az - c.az) * k;
  c.el += (d.el - c.el) * k;
  c.dist += (d.dist - c.dist) * k;
  c.tx += (d.tx - c.tx) * k;
  c.ty += (d.ty - c.ty) * k;
  c.tz += (d.tz - c.tz) * k;
  this.apply();
};

Camera.prototype.apply = function () {
  var c = this.cur;
  this.cam.position.set(
    c.tx + Math.cos(c.az) * Math.cos(c.el) * c.dist,
    c.ty + Math.sin(c.el) * c.dist,
    c.tz + Math.sin(c.az) * Math.cos(c.el) * c.dist
  );
  this.cam.lookAt(c.tx, c.ty, c.tz);
};

/* ── label LOD ───────────────────────────────────────────────────────────
   Three tiers driven by camera distance, plus occlusion and a greedy
   de-overlap pass. This is what replaces the old "static text permanently
   glued to every object".

     far     — a small dot only; the scene stays legible at a glance
     mid     — the name
     near    — the name, a one-line purpose, and an Enter affordance

   Anything the pointer is over, or that is selected, is promoted to `near`
   regardless of distance, because the reader has just expressed interest in
   exactly that object. */
function Labels(layer) {
  this.layer = layer;
  this.items = [];
  this._v = null;
  this._boxes = [];
}

Labels.prototype.clear = function () {
  this.items.forEach(function (i) { if (i.el.parentNode) i.el.remove(); });
  this.items = [];
};

Labels.prototype.add = function (obj, spec) {
  var e = document.createElement('div');
  e.className = 'lbl3';
  e.innerHTML =
    '<span class="lbl3-dot"></span>'
    + '<span class="lbl3-body">'
    + '<span class="lbl3-name"></span>'
    + '<span class="lbl3-sub"></span>'
    + '<span class="lbl3-cta"></span>'
    + '</span>';
  e.querySelector('.lbl3-name').textContent = spec.name || '';
  e.querySelector('.lbl3-sub').textContent = spec.sub || '';
  e.querySelector('.lbl3-cta').textContent = spec.cta || '';
  if (spec.tone) e.classList.add('tone-' + spec.tone);
  this.layer.appendChild(e);
  var item = { obj: obj, el: e, spec: spec, tier: -1, near: spec.nearAt || 46, mid: spec.midAt || 130 };
  this.items.push(item);
  return item;
};

Labels.prototype.update = function (cam, camera, renderer, hoveredObj, selectedObj, occluders, raycaster) {
  if (!this._v) this._v = new THREE.Vector3();
  var v = this._v, W = window.innerWidth, H = window.innerHeight;
  var camPos = camera.position;
  this._boxes.length = 0;
  var placed = this._boxes;

  // Nearest first: when two labels collide the closer one keeps its spot,
  // which is the one the reader is most likely looking at.
  var ordered = this.items.slice().sort(function (a, b) {
    a.obj.getWorldPosition(v); var da = v.distanceTo(camPos);
    b.obj.getWorldPosition(v); var db = v.distanceTo(camPos);
    return da - db;
  });

  for (var i = 0; i < ordered.length; i++) {
    var it = ordered[i], el = it.el;
    it.obj.getWorldPosition(v);
    var dist = v.distanceTo(camPos);
    v.project(camera);

    if (v.z > 1 || v.x < -1.25 || v.x > 1.25 || v.y < -1.3 || v.y > 1.3) { el.style.display = 'none'; continue; }

    var isHot = (hoveredObj && it.obj === hoveredObj) || (selectedObj && it.obj === selectedObj);
    var tier = (isHot || it.spec.alwaysOn) ? 2 : dist < it.near ? 2 : dist < it.mid ? 1 : 0;

    // Occlusion: a label sitting behind solid geometry reads as a bug. Only
    // demote it — never hide it entirely, or objects behind the hub become
    // unfindable.
    if (!isHot && !it.spec.alwaysOn && occluders && occluders.length && raycaster) {
      it.obj.getWorldPosition(v);
      var dir = v.clone().sub(camPos).normalize();
      raycaster.set(camPos, dir);
      var hits = raycaster.intersectObjects(occluders, false);
      if (hits.length && hits[0].distance < dist - 3.2) tier = Math.min(tier, 0);
      it.obj.getWorldPosition(v); v.project(camera);
    }

    var x = (v.x * 0.5 + 0.5) * W;
    var y = (-v.y * 0.5 + 0.5) * H;

    // De-overlap: push down until clear of everything already placed. Cheap,
    // stable, and good enough for the tens of labels a level ever has.
    var w = tier === 2 ? 220 : tier === 1 ? 130 : 22;
    var h = tier === 2 ? 58 : tier === 1 ? 22 : 14;
    var tries = 0;
    while (tries < 12) {
      var clash = false;
      for (var b = 0; b < placed.length; b++) {
        var p = placed[b];
        if (Math.abs(x - p.x) < (w + p.w) * 0.42 && Math.abs(y - p.y) < (h + p.h) * 0.62) { clash = true; break; }
      }
      if (!clash) break;
      y += h * 0.82; tries++;
    }
    placed.push({ x: x, y: y, w: w, h: h });

    el.style.display = 'block';
    el.style.transform = 'translate(-50%,-50%) translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
    if (tier !== it.tier) {
      el.classList.toggle('t0', tier === 0);
      el.classList.toggle('t1', tier === 1);
      el.classList.toggle('t2', tier === 2);
      it.tier = tier;
    }
    el.classList.toggle('sel', selectedObj === it.obj);
    // Fade with distance inside a tier, so approach feels continuous rather
    // than stepped.
    el.style.opacity = tier === 0 ? String(Math.max(0.28, Math.min(1, 320 / dist / 3))) : '1';
  }
};

/* ── geometry factory ────────────────────────────────────────────────────
   Reusable, procedural, and disposed centrally. Each maker returns a Group so
   an environment can position one thing and trust its internals. */
var G = {};

function mat(color, opts) {
  opts = opts || {};
  return new THREE.MeshStandardMaterial({
    color: color,
    metalness: opts.metalness != null ? opts.metalness : 0.55,
    roughness: opts.roughness != null ? opts.roughness : 0.34,
    emissive: opts.emissive != null ? opts.emissive : color,
    emissiveIntensity: opts.emissiveIntensity != null ? opts.emissiveIntensity : 0.14,
    transparent: !!opts.transparent,
    opacity: opts.opacity != null ? opts.opacity : 1,
    flatShading: !!opts.flat,
  });
}
G.mat = mat;

function glow(color, r, opacity) {
  return new THREE.Mesh(
    new THREE.SphereGeometry(r, 16, 12),
    new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: opacity == null ? 0.07 : opacity, side: THREE.BackSide, depthWrite: false })
  );
}
G.glow = glow;

/** The platform core. Layered on purpose — the brief's complaint about "a
    simple blue polygon" was fair. */
G.core = function (color, scale) {
  scale = scale || 1;
  var g = new THREE.Group();

  var inner = new THREE.Mesh(new THREE.IcosahedronGeometry(3.1 * scale, 2), mat(color, { emissiveIntensity: 0.65, roughness: 0.18, metalness: 0.9 }));
  g.add(inner); g.userData.pulse = inner;

  var cage = new THREE.Mesh(new THREE.IcosahedronGeometry(4.6 * scale, 1),
    new THREE.MeshBasicMaterial({ color: color, wireframe: true, transparent: true, opacity: 0.28 }));
  g.add(cage); g.userData.cage = cage;

  var shell = new THREE.Mesh(new THREE.IcosahedronGeometry(6.4 * scale, 3),
    new THREE.MeshStandardMaterial({ color: color, metalness: 0.95, roughness: 0.12, transparent: true, opacity: 0.1, side: THREE.DoubleSide }));
  g.add(shell);

  // Three rings on different axes — the "orbital rings" read as machinery
  // rather than decoration because they are unequal and slightly tilted.
  var rings = new THREE.Group();
  [[8.2 * scale, 0.055, 0], [10.4 * scale, 0.04, 1.1], [12.6 * scale, 0.03, -0.62]].forEach(function (r, i) {
    var t = new THREE.Mesh(new THREE.TorusGeometry(r[0], r[1] * scale, 8, 96),
      new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.42 - i * 0.1 }));
    t.rotation.x = Math.PI / 2 + r[2] * 0.5;
    t.rotation.z = r[2];
    rings.add(t);
  });
  g.add(rings); g.userData.rings = rings;
  g.add(glow(color, 9 * scale, 0.055));
  return g;
};

/** A database: stacked platters with a lit seam, not a plain cylinder. */
G.database = function (color, scale) {
  scale = scale || 1;
  var g = new THREE.Group();
  for (var i = 0; i < 4; i++) {
    var d = new THREE.Mesh(
      new THREE.CylinderGeometry(2.1 * scale, 2.1 * scale, 0.52 * scale, 40),
      mat(color, { metalness: 0.7, roughness: 0.28, emissiveIntensity: 0.1 })
    );
    d.position.y = (i - 1.5) * 0.74 * scale;
    g.add(d);
    var seam = new THREE.Mesh(
      new THREE.TorusGeometry(2.13 * scale, 0.035 * scale, 6, 48),
      new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.75 })
    );
    seam.rotation.x = Math.PI / 2;
    seam.position.y = d.position.y + 0.26 * scale;
    g.add(seam);
  }
  g.add(glow(color, 3.6 * scale, 0.05));
  return g;
};

/** A server rack: a slotted chassis with per-unit activity lights. */
G.rack = function (color, scale, activity) {
  scale = scale || 1;
  var g = new THREE.Group();
  var body = new THREE.Mesh(new THREE.BoxGeometry(2.6 * scale, 4.6 * scale, 1.9 * scale),
    mat(0x16233c, { metalness: 0.75, roughness: 0.45, emissiveIntensity: 0.02 }));
  g.add(body);
  var units = 7;
  for (var i = 0; i < units; i++) {
    var lit = activity == null ? (i % 2 === 0) : (i / units) < activity;
    var slot = new THREE.Mesh(
      new THREE.BoxGeometry(2.3 * scale, 0.34 * scale, 0.06),
      new THREE.MeshBasicMaterial({ color: lit ? color : 0x24344f, transparent: true, opacity: lit ? 0.92 : 0.5 })
    );
    slot.position.set(0, (i - (units - 1) / 2) * 0.58 * scale, 0.98 * scale);
    g.add(slot);
  }
  g.add(glow(color, 3.4 * scale, 0.04));
  return g;
};

/** A volumetric-ish cloud: overlapping translucent blobs, cheap and stable. */
G.cloud = function (color, scale) {
  scale = scale || 1;
  var g = new THREE.Group();
  var offs = [[0, 0, 0, 2.3], [1.8, 0.5, 0.4, 1.7], [-1.9, 0.2, -0.5, 1.6], [0.5, 1.2, -1.4, 1.35], [-0.7, -0.8, 1.2, 1.25]];
  offs.forEach(function (o) {
    var m = new THREE.Mesh(new THREE.SphereGeometry(o[3] * scale, 18, 14),
      new THREE.MeshStandardMaterial({
        color: color, metalness: 0.1, roughness: 0.85, transparent: true, opacity: 0.2,
        emissive: color, emissiveIntensity: 0.22, depthWrite: false,
      }));
    m.position.set(o[0] * scale, o[1] * scale, o[2] * scale);
    g.add(m);
  });
  g.add(glow(color, 4.4 * scale, 0.06));
  return g;
};

/** An endpoint device — an agent. */
G.endpoint = function (color, scale) {
  scale = scale || 1;
  var g = new THREE.Group();
  var b = new THREE.Mesh(new THREE.BoxGeometry(1.9 * scale, 1.25 * scale, 0.32 * scale), mat(0x17253f, { metalness: 0.8, roughness: 0.4 }));
  g.add(b);
  var screen = new THREE.Mesh(new THREE.PlaneGeometry(1.55 * scale, 0.95 * scale),
    new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.8 }));
  screen.position.z = 0.17 * scale; g.add(screen);
  var stand = new THREE.Mesh(new THREE.CylinderGeometry(0.1 * scale, 0.34 * scale, 0.62 * scale, 12), mat(0x17253f));
  stand.position.y = -0.92 * scale; g.add(stand);
  return g;
};

/** An alert beacon whose severity drives colour and pulse. */
G.beacon = function (color, scale) {
  scale = scale || 1;
  var g = new THREE.Group();
  var cone = new THREE.Mesh(new THREE.ConeGeometry(1.25 * scale, 2.4 * scale, 5), mat(color, { emissiveIntensity: 0.4, flat: true }));
  g.add(cone);
  var halo = new THREE.Mesh(new THREE.TorusGeometry(1.7 * scale, 0.05 * scale, 6, 40),
    new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.6 }));
  halo.rotation.x = Math.PI / 2; halo.position.y = -1.2 * scale;
  g.add(halo); g.userData.halo = halo;
  g.add(glow(color, 2.6 * scale, 0.09));
  return g;
};

/** A key/shield for access control. */
G.shield = function (color, scale) {
  scale = scale || 1;
  var g = new THREE.Group();
  var s = new THREE.Mesh(new THREE.OctahedronGeometry(1.7 * scale, 0), mat(color, { emissiveIntensity: 0.3, flat: true }));
  s.scale.set(1, 1.35, 0.55);
  g.add(s);
  var ring = new THREE.Mesh(new THREE.TorusGeometry(2.3 * scale, 0.045 * scale, 6, 48),
    new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.5 }));
  ring.rotation.x = Math.PI / 2;
  g.add(ring);
  return g;
};

/** A flat data slab — used for features, tables, parameters. Height can encode
    a value, which is how Storage and Tables become data visualisations rather
    than decoration. */
G.slab = function (color, w, h, d, opts) {
  opts = opts || {};
  var g = new THREE.Group();
  var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, opts));
  m.position.y = h / 2;
  g.add(m);
  var cap = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.98, d * 0.98),
    new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.55 }));
  cap.rotation.x = -Math.PI / 2; cap.position.y = h + 0.02;
  g.add(cap);
  return g;
};

/** A session / node marker. */
G.node = function (color, scale) {
  scale = scale || 1;
  var g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.IcosahedronGeometry(1.15 * scale, 1), mat(color, { emissiveIntensity: 0.28 })));
  g.add(glow(color, 1.9 * scale, 0.09));
  return g;
};

/* ── the Earth ─────────────────────────────────────────────────────────────
   A setting, not a map. The diagram names no country, region or site, so the
   land here is deliberately coarse — a dot field rasterised from lat/lon
   boxes — and nothing in the document reads a location off it. What the globe
   is for is scale: it makes "these feeds come from outside" and "this crosses
   from a data centre to a cloud region" read as distance rather than as two
   boxes side by side. */

/* [lonMin, lonMax, latMin, latMax] — approximate continental extents. */
var LAND = [
  // North America
  [-168, -141, 54, 71], [-141, -60, 50, 71], [-130, -66, 43, 56], [-124, -70, 30, 49],
  [-117, -97, 25, 33], [-106, -86, 16, 25], [-92, -83, 8, 18], [-85, -75, 17, 23],
  [-55, -20, 60, 83],                                            // Greenland
  // South America
  [-81, -50, 0, 12], [-80, -35, -15, 0], [-73, -38, -30, -15], [-75, -54, -45, -30], [-75, -65, -55, -45],
  // Europe
  [-9, 3, 36, 44], [-5, 20, 42, 50], [-5, 15, 50, 55], [-8, -1, 50, 59],
  [4, 31, 54, 61], [5, 25, 61, 71], [20, 45, 45, 60], [24, 60, 55, 70],
  // Africa
  [-17, 12, 12, 33], [12, 34, 15, 32], [-17, 15, 4, 13], [8, 30, -5, 13],
  [28, 43, 2, 18], [12, 32, -18, -5], [30, 41, -18, -2], [14, 33, -35, -18], [43, 52, 3, 12],
  // Asia
  [33, 60, 13, 32], [35, 48, 32, 40], [44, 62, 35, 48], [60, 76, 24, 40],
  [68, 90, 8, 32], [88, 98, 20, 30], [95, 110, 8, 24], [95, 120, -10, 7],
  [100, 123, 20, 42], [75, 135, 38, 54], [60, 145, 50, 72], [130, 146, 31, 46],
  [117, 127, 5, 19], [50, 80, 40, 55],
  // Australia and New Zealand
  [113, 154, -39, -11], [166, 179, -47, -34],
  // Antarctica
  [-180, 180, -90, -70],
];

function isLand(lon, lat) {
  for (var i = 0; i < LAND.length; i++) {
    var b = LAND[i];
    if (lon >= b[0] && lon <= b[1] && lat >= b[2] && lat <= b[3]) return true;
  }
  return false;
}

/** Surface position for a latitude/longitude, at radius r. */
function latLon(lat, lon, r) {
  var p = lat * Math.PI / 180, t = lon * Math.PI / 180;
  return new THREE.Vector3(
    r * Math.cos(p) * Math.cos(t),
    r * Math.sin(p),
    -r * Math.cos(p) * Math.sin(t)
  );
}
S.latLon = latLon;

G.earth = function (r, opts) {
  opts = opts || {};
  r = r || 26;
  var outer = new THREE.Group();

  // Everything that turns lives on an inner group, so the axial tilt applied
  // to the outer one stays put while the planet spins beneath it.
  var spin = new THREE.Group();
  outer.add(spin);
  outer.userData.spin = spin;

  var ocean = new THREE.Mesh(
    new THREE.SphereGeometry(r * 0.985, 48, 32),
    new THREE.MeshStandardMaterial({
      color: 0x0b2746, metalness: 0.15, roughness: 0.92,
      emissive: 0x071a2e, emissiveIntensity: 1,
    })
  );
  spin.add(ocean);

  // Graticule every 15 degrees — the thing that makes a sphere read as a globe.
  var gratMat = new THREE.LineBasicMaterial({ color: 0x3f7fb8, transparent: true, opacity: 0.22 });
  var lat, lon, i, pts;
  for (lat = -75; lat <= 75; lat += 15) {
    pts = [];
    for (i = 0; i <= 72; i++) pts.push(latLon(lat, (i / 72) * 360 - 180, r));
    spin.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), gratMat));
  }
  for (lon = -180; lon < 180; lon += 15) {
    pts = [];
    for (i = 0; i <= 72; i++) pts.push(latLon((i / 72) * 180 - 90, lon, r));
    spin.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), gratMat));
  }

  // Dot field: faint everywhere, bright over land. Longitude spacing widens
  // toward the poles so the dots stay evenly spread instead of bunching.
  var seaPts = [], landPts = [];
  for (lat = -87; lat <= 87; lat += 2.6) {
    var cos = Math.cos(lat * Math.PI / 180);
    var step = 2.6 / Math.max(0.12, cos);
    for (lon = -180; lon < 180; lon += step) {
      (isLand(lon, lat) ? landPts : seaPts).push(latLon(lat, lon, r * 1.004));
    }
  }
  function dots(list, color, size, opacity) {
    var arr = new Float32Array(list.length * 3);
    for (var k = 0; k < list.length; k++) {
      arr[k * 3] = list[k].x; arr[k * 3 + 1] = list[k].y; arr[k * 3 + 2] = list[k].z;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    return new THREE.Points(g, new THREE.PointsMaterial({
      color: color, size: size, sizeAttenuation: true,
      transparent: true, opacity: opacity, depthWrite: false,
    }));
  }
  spin.add(dots(seaPts, 0x1d4a74, r * 0.012, 0.42));
  spin.add(dots(landPts, opts.land || 0x4fd4a8, r * 0.022, 0.95));

  // Atmosphere — a back-facing shell, which is the cheap way to get a limb glow.
  var atm = new THREE.Mesh(
    new THREE.SphereGeometry(r * 1.14, 36, 24),
    new THREE.MeshBasicMaterial({
      color: opts.glow || 0x3a8fd0, transparent: true, opacity: 0.07,
      side: THREE.BackSide, depthWrite: false,
    })
  );
  outer.add(atm);
  var rim = new THREE.Mesh(
    new THREE.SphereGeometry(r * 1.035, 36, 24),
    new THREE.MeshBasicMaterial({
      color: opts.glow || 0x59b4ea, transparent: true, opacity: 0.045,
      side: THREE.BackSide, depthWrite: false,
    })
  );
  outer.add(rim);

  outer.userData.radius = r;
  return outer;
};

S.G = G;

/* ── connections and flows ─────────────────────────────────────────────── */

/** A curved link. `flow` gives it travelling particles whose speed can encode
    a real quantity (replication lag, throughput). */
function link(scene, a, b, color, opts) {
  opts = opts || {};
  var lift = opts.lift != null ? opts.lift : a.distanceTo(b) * 0.14;
  var mid = new THREE.Vector3().lerpVectors(a, b, 0.5);
  mid.y += lift;
  var curve = new THREE.QuadraticBezierCurve3(a.clone(), mid, b.clone());
  var pts = curve.getPoints(opts.segments || 34);

  var line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: opts.opacity != null ? opts.opacity : 0.2 })
  );
  scene.add(line);

  var flow = null;
  if (opts.flow) {
    var n = opts.count || 6;
    var arr = new Float32Array(n * 3);
    var pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    var p = new THREE.Points(pg, new THREE.PointsMaterial({
      color: opts.flowColor || color, size: opts.size || 0.55,
      transparent: true, opacity: 0.95, depthWrite: false,
    }));
    scene.add(p);
    flow = { points: p, curve: curve, count: n, speed: opts.speed == null ? 0.22 : opts.speed, offset: Math.random(), dir: opts.reverse ? -1 : 1 };
  }
  return { line: line, flow: flow, curve: curve };
}
S.link = link;

/** Advance every flow. Speed is per-flow so a lagging standby genuinely
    crawls compared with a healthy one. */
S.stepFlows = function (flows, t) {
  for (var i = 0; i < flows.length; i++) {
    var f = flows[i];
    var pos = f.points.geometry.attributes.position;
    for (var j = 0; j < f.count; j++) {
      var u = ((t * f.speed * f.dir) + f.offset + j / f.count) % 1;
      if (u < 0) u += 1;
      var v = f.curve.getPoint(u);
      pos.setXYZ(j, v.x, v.y, v.z);
    }
    pos.needsUpdate = true;
  }
};

/* ── disposal ──────────────────────────────────────────────────────────── */

S.disposeGroup = function (group) {
  var geos = [], mats = [];
  group.traverse(function (o) {
    if (o.geometry) geos.push(o.geometry);
    if (o.material) {
      if (Array.isArray(o.material)) mats = mats.concat(o.material);
      else mats.push(o.material);
    }
  });
  // De-duplicate: shared materials disposed twice throw in some three builds.
  var seenG = new Set(), seenM = new Set();
  geos.forEach(function (g) { if (!seenG.has(g)) { seenG.add(g); g.dispose(); } });
  mats.forEach(function (m) { if (!seenM.has(m)) { seenM.add(m); if (m.map) m.map.dispose(); m.dispose(); } });
  while (group.children.length) group.remove(group.children[0]);
};

/* ── canvas text sprite, for in-scene readouts ─────────────────────────── */

S.textSprite = function (text, opts) {
  opts = opts || {};
  var pad = 16, fs = opts.size || 44;
  var c = document.createElement('canvas');
  var ctx = c.getContext && c.getContext('2d');
  // A 2D context can be unavailable — a hardened browser, a headless runtime.
  // An in-scene caption is a nicety; losing one must never take the whole
  // environment down, so return an empty object the scene can still hold.
  if (!ctx) return new THREE.Object3D();
  ctx.font = '600 ' + fs + 'px Inter, "Segoe UI", system-ui, sans-serif';
  var w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  var h = fs + pad * 2;
  c.width = w; c.height = h;
  ctx = c.getContext('2d');
  // A caption floating over a busy scene needs something behind it. Without
  // the plate, flow labels disappeared the moment they crossed the globe.
  if (opts.plate) {
    ctx.fillStyle = opts.plateColor || 'rgba(6,12,24,.74)';
    var rr = h / 2;
    ctx.beginPath();
    ctx.moveTo(rr, 0); ctx.lineTo(w - rr, 0);
    ctx.arcTo(w, 0, w, rr, rr); ctx.lineTo(w, h - rr);
    ctx.arcTo(w, h, w - rr, h, rr); ctx.lineTo(rr, h);
    ctx.arcTo(0, h, 0, h - rr, rr); ctx.lineTo(0, rr);
    ctx.arcTo(0, 0, rr, 0, rr);
    ctx.closePath(); ctx.fill();
  }
  ctx.font = '600 ' + fs + 'px Inter, "Segoe UI", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = opts.color || '#dcebff';
  ctx.fillText(text, pad, h / 2);
  var tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: opts.opacity == null ? 0.9 : opts.opacity }));
  var scale = (opts.worldHeight || 2.2);
  sp.scale.set(scale * (w / h), scale, 1);
  return sp;
};

S.Camera = Camera;
S.Labels = Labels;

window.KScene = S;   // same engine, KOEL namespace
})();
