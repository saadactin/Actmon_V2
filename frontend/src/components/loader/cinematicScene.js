/**
 * The loading world, assembled object by object.
 *
 * One clock drives everything. Each object has its own entry window on that
 * clock and eases in on its own — the floor, then the rings drawing their
 * circles, the database segments landing one at a time, the racks rising in
 * turn with their unit lights switching on, the cloud and agent forms, the
 * network paths drawing outward, and only then the pulses that travel them.
 * After the build the scene never stops: rings turn, lights blink, pulses
 * run, particles drift — until the page's real request finishes and the
 * caller calls `setDone()`, which fades the world out.
 *
 * This clock is an ANIMATION timeline, not a progress measure. It says
 * nothing about how far the request has got, and the loader shows no number
 * derived from it.
 *
 * Written against three directly: the scene is built once, owns its render
 * loop, is never re-rendered by React, pauses when the tab is hidden and
 * releases every GPU resource on dispose.
 */
import * as THREE from 'three';

import { nodeState } from './stages';

const CYAN = 0x22d3ee;
const BLUE = 0x3b82f6;
const DEEP = 0x0b2a6b;
const VIOLET = 0x8b5cf6;
const ICE = 0xa5f3fc;
const NODE_COLOUR = { known: 0x22d3ee, connecting: 0xf59e0b, failed: 0xef4444, unknown: 0x64748b };

/** When the build is complete, in seconds. Exported for the loader's CSS
 *  delays (logo, status panels) so DOM and WebGL stay in step. */
export const TIMELINE = {
  floor: 0, rings: 0.5, logo: 1.2, core: 2.0, beam: 3.6, racks: 4.0,
  rac: 5.4, cloud: 5.8, agents: 6.2, paths: 6.7, pulses: 7.6, panels: 8.2, built: 9.0,
};

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch {
    return false;
  }
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const easeOut = (x) => 1 - (1 - x) ** 3;
const easeBack = (x) => { const c = 1.6; return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2; };
/** 0→1 progress of a window [start, start+dur] at time t. */
const win = (t, start, dur) => clamp01((t - start) / dur);

function fadeable(root) {
  root.traverse((o) => {
    if (o.material && o.material.userData.base === undefined) {
      o.material.transparent = true;
      o.material.userData.base = o.material.opacity ?? 1;
    }
  });
  return root;
}
function setAlpha(root, a) {
  root.visible = a > 0.005;
  root.traverse((o) => { if (o.material) o.material.opacity = (o.material.userData.base ?? 1) * a; });
}

export function createCinematicScene(canvas, { reducedMotion = false, onLabels } = {}) {
  const owned = [];
  const T = (o) => { owned.push(o); return o; };
  const std = (p) => T(new THREE.MeshStandardMaterial(p));
  const glow = (color, opacity = 1) => T(new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false,
  }));

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  // Depth fog belongs to the dark (space) look. On a light theme it would fade the whole scene into white, so
  // the scene is drawn without it there.
  const theme = document.documentElement.getAttribute('data-theme') || document.querySelector('[data-theme]')?.getAttribute('data-theme');
  if (theme !== 'light' && theme !== 'paper') scene.fog = new THREE.FogExp2(0x040915, 0.03);
  else {
    // light themes: fade only the far distance into the page colour, so the floor grid does not bunch into
    // lines at the horizon while the scene in the middle stays crisp
    let bg = 0xf4f6fa;
    try { const v = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(); if (v) bg = new THREE.Color(v).getHex(); } catch { /* default */ }
    scene.fog = new THREE.Fog(bg, 20, 46);
  }
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 120);

  scene.add(new THREE.AmbientLight(0x3b5bdb, 0.9));
  const key = new THREE.PointLight(CYAN, 90, 40); key.position.set(0, 8, 6); scene.add(key);
  const rim = new THREE.PointLight(VIOLET, 40, 40); rim.position.set(-11, 5, -8); scene.add(rim);
  const fill = new THREE.PointLight(BLUE, 40, 40); fill.position.set(11, 3, 6); scene.add(fill);

  const world = new THREE.Group();
  scene.add(world);
  const anims = []; // (t, dt) => void, one per object

  /* ── 1. floor ── */
  const floor = new THREE.Group();
  const grid = new THREE.GridHelper(80, 64, BLUE, DEEP);
  grid.position.y = -2.25; grid.material.opacity = 0.18;
  T(grid.geometry); T(grid.material);
  floor.add(grid);
  const disc = new THREE.Mesh(T(new THREE.CircleGeometry(6.4, 96)), glow(BLUE, 0.18));
  disc.rotation.x = -Math.PI / 2; disc.position.y = -2.2;
  floor.add(disc);
  world.add(fadeable(floor));
  anims.push((t) => setAlpha(floor, easeOut(win(t, TIMELINE.floor, 1.0))));

  /* ── 2. rings: each draws its circle, then turns on its own ── */
  [[3.0, CYAN, 0.95, 0.35], [3.8, BLUE, 0.75, -0.22], [4.7, CYAN, 0.6, 0.15], [5.6, VIOLET, 0.5, -0.1]].forEach(([r, c, o, speed], i) => {
    const pts = []; const N = 192;
    for (let k = 0; k <= N; k++) { const a = (k / N) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)); }
    const geo = T(new THREE.BufferGeometry().setFromPoints(pts));
    const line = new THREE.Line(geo, T(new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: o })));
    const tube = new THREE.Mesh(T(new THREE.TorusGeometry(r, 0.035 + (i % 2) * 0.015, 8, 160)), glow(c, o * 0.8));
    tube.rotation.x = Math.PI / 2;
    const arc = new THREE.Mesh(T(new THREE.TorusGeometry(r, 0.08, 6, 48, Math.PI / 3)), glow(ICE, o));
    arc.rotation.x = Math.PI / 2;
    const g = new THREE.Group(); g.add(line, tube, arc); g.position.y = -2.05;
    world.add(fadeable(g));
    const start = TIMELINE.rings + i * 0.22;
    anims.push((t, dt) => {
      const d = easeOut(win(t, start, 0.9));
      geo.setDrawRange(0, Math.floor(d * (N + 1)));
      g.visible = d > 0;
      tube.material.opacity = o * 0.8 * easeOut(win(t, start + 0.7, 0.6));
      arc.material.opacity = o * easeOut(win(t, start + 0.7, 0.6));
      g.rotation.y += dt * speed;
    });
  });

  /* ── 4. the database core: four segments land one at a time ── */
  const core = new THREE.Group();
  world.add(core);
  const segs = [];
  for (let i = 0; i < 4; i++) {
    const L = new THREE.Group();
    const body = new THREE.Mesh(T(new THREE.CylinderGeometry(2, 2, 0.78, 72)),
      std({ color: 0x0d2f7a, emissive: BLUE, emissiveIntensity: 0.35, metalness: 0.85, roughness: 0.22 }));
    const edge = new THREE.Mesh(T(new THREE.TorusGeometry(2.0, 0.05, 8, 96)), glow(CYAN, 1));
    edge.rotation.x = Math.PI / 2; edge.position.y = 0.4;
    const lip = new THREE.Mesh(T(new THREE.TorusGeometry(2.0, 0.03, 8, 96)), glow(ICE, 0.8));
    lip.rotation.x = Math.PI / 2; lip.position.y = -0.4;
    L.add(body, edge, lip);
    for (let d = 0; d < 3; d++) {
      const led = new THREE.Mesh(T(new THREE.SphereGeometry(0.05, 8, 6)), glow(ICE, 1));
      led.position.set(0.9 + d * 0.22, 0, 1.8); L.add(led);
    }
    fadeable(L);
    const home = -1.55 + i * 0.86;
    core.add(L);
    segs.push(L);
    const start = TIMELINE.core + i * 0.38;
    anims.push((t) => {
      const k = win(t, start, 0.7);
      L.position.y = home + (1 - easeOut(k)) * 3.2;
      setAlpha(L, easeOut(k));
      // A brief flare on the edge as the segment lands.
      const land = win(t, start + 0.6, 0.5);
      edge.scale.setScalar(1 + (land > 0 && land < 1 ? Math.sin(land * Math.PI) * 0.06 : 0));
    });
  }
  const cap = new THREE.Mesh(T(new THREE.CylinderGeometry(1.98, 1.98, 0.06, 72)), glow(CYAN, 0.55));
  cap.position.y = 1.62; world.add(cap);
  anims.push((t) => { cap.material.opacity = 0.55 * easeOut(win(t, TIMELINE.core + 1.6, 0.5)); });
  anims.push((t) => { core.rotation.y = t * 0.15; core.position.y = Math.sin(t * 0.7) * 0.05; });

  /* scan beam, shafts, sweep ring */
  const beam = new THREE.Mesh(T(new THREE.CylinderGeometry(0.6, 2.1, 12, 48, 1, true)),
    T(new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })));
  beam.position.y = 4; world.add(beam);
  const shafts = new THREE.InstancedMesh(T(new THREE.BoxGeometry(0.04, 6, 0.04)), glow(CYAN, 0), 40);
  { const m = new THREE.Matrix4(); for (let i = 0; i < 40; i++) { const a = (i / 40) * Math.PI * 2; const r = 2.6 + (i % 5) * 0.75; m.makeTranslation(Math.cos(a) * r, 0.4 + (i % 3) * 0.6, Math.sin(a) * r); shafts.setMatrixAt(i, m); } }
  world.add(shafts);
  const sweep = new THREE.Mesh(T(new THREE.TorusGeometry(2.2, 0.035, 8, 96)), glow(ICE, 0));
  sweep.rotation.x = Math.PI / 2; world.add(sweep);
  anims.push((t) => {
    const on = easeOut(win(t, TIMELINE.beam, 1.0));
    beam.material.opacity = (0.07 + Math.sin(t * 1.5) * 0.025) * on;
    shafts.material.opacity = 0.3 * on * (0.7 + Math.sin(t * 2.3) * 0.3);
    const sk = (t * 0.33) % 1;
    sweep.position.y = -1.9 + sk * 3.6;
    sweep.material.opacity = 0.9 * Math.sin(sk * Math.PI) * on;
  });

  /* ── 5. racks: rise in turn, then their unit lights switch on ── */
  const pad = (x, z, r = 1.2) => {
    const g = new THREE.Group(); g.position.set(x, -2.15, z);
    const base = new THREE.Mesh(T(new THREE.CylinderGeometry(r, r * 1.08, 0.12, 48)),
      std({ color: 0x08214f, emissive: BLUE, emissiveIntensity: 0.55, metalness: 0.6, roughness: 0.3 }));
    const halo = new THREE.Mesh(T(new THREE.TorusGeometry(r * 1.02, 0.04, 8, 64)), glow(CYAN, 0.95));
    halo.rotation.x = Math.PI / 2; halo.position.y = 0.08;
    const wave = new THREE.Mesh(T(new THREE.TorusGeometry(r * 0.7, 0.025, 8, 64)), glow(CYAN, 0.6));
    wave.rotation.x = Math.PI / 2; wave.position.y = 0.05;
    g.add(base, halo, wave); g.userData.wave = wave;
    return g;
  };
  const targets = []; // { pos, start } — where network paths go
  const RACKS = [[-6.6, -2.4], [6.6, -2.4], [-7.8, 0.8], [7.8, 0.8], [-6.2, 3.8], [6.2, 3.8]];
  RACKS.forEach(([x, z], k) => {
    const g = new THREE.Group();
    g.add(pad(0, 0)); g.children[0].position.set(0, -0.1, 0);
    const m = std({ color: 0x0b2458, emissive: 0x1e40af, emissiveIntensity: 0.35, metalness: 0.75, roughness: 0.3 });
    const leds = [];
    for (let u = 0; u < 5; u++) {
      const unit = new THREE.Mesh(T(new THREE.BoxGeometry(1.2, 0.26, 0.9)), m);
      unit.position.y = 0.2 + u * 0.31; g.add(unit);
      // A lit edge round each unit's face, so the rack reads as hardware.
      const rim = new THREE.LineSegments(T(new THREE.EdgesGeometry(T(new THREE.BoxGeometry(1.2, 0.26, 0.02)))),
        T(new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0.55 })));
      rim.position.set(0, 0.2 + u * 0.31, 0.46); g.add(rim);
      const led = new THREE.Mesh(T(new THREE.BoxGeometry(0.55, 0.04, 0.02)), glow(CYAN, 1));
      led.position.set(-0.2, 0.2 + u * 0.31, 0.46); g.add(led);
      const dot = new THREE.Mesh(T(new THREE.SphereGeometry(0.035, 6, 4)), glow(0x4ade80, 1));
      dot.position.set(0.42, 0.2 + u * 0.31, 0.46); g.add(dot);
      leds.push({ led, dot, phase: Math.random() * 6 });
    }
    g.position.set(x, -2.05, z);
    // Faces turned toward the viewer, so the unit lights are seen.
    g.lookAt(x * 0.35, -2.05, 30);
    world.add(fadeable(g));
    const start = TIMELINE.racks + k * 0.28;
    targets.push({ pos: new THREE.Vector3(x, -1.4, z), start });
    anims.push((t) => {
      const e = win(t, start, 0.8);
      g.position.y = -2.05 - (1 - easeOut(e)) * 1.6;
      setAlpha(g, easeOut(e));
      g.traverse((o) => { if (o.userData.wave) { const w = (t * 0.55 + k * 0.2) % 1; o.userData.wave.scale.setScalar(0.6 + w * 1.1); o.userData.wave.material.opacity *= (1 - w); } });
      // Each unit's light comes on in turn, then blinks on its own rhythm.
      leds.forEach((L, u) => {
        const on = easeOut(win(t, start + 0.5 + u * 0.14, 0.25));
        L.led.material.opacity *= on * (0.55 + Math.sin(t * 5 + L.phase) * 0.45);
        L.dot.material.opacity *= on * (Math.sin(t * 9 + L.phase * 2) > -0.2 ? 1 : 0.15);
      });
    });
  });

  /* ── 6. cloud forms and agent devices: scale into place ── */
  const scaleIn = (g, start, baseScale = 1) => {
    world.add(fadeable(g));
    anims.push((t) => {
      const e = win(t, start, 0.7);
      g.scale.setScalar(baseScale * Math.max(0.001, easeBack(e)));
      setAlpha(g, easeOut(e));
      g.position.y = g.userData.y + Math.sin(t * 0.9 + g.userData.y * 3) * 0.12;
    });
  };
  const cloudMat = std({ color: 0x5aa9ff, emissive: 0x2b7bff, emissiveIntensity: 0.6, metalness: 0.2, roughness: 0.35 });
  [[-4.2, -5.6], [4.2, -5.6]].forEach(([x, z], i) => {
    const g = new THREE.Group();
    [[0, 0.5, 0.55], [-0.55, 0.35, 0.4], [0.58, 0.38, 0.45], [0.1, 0.8, 0.38]].forEach(([cx, cy, r]) => {
      const s = new THREE.Mesh(T(new THREE.SphereGeometry(r, 24, 16)), cloudMat); s.position.set(cx, cy, 0); g.add(s);
    });
    g.position.set(x, 0.9, z); g.userData.y = 0.9;
    scaleIn(g, TIMELINE.cloud + i * 0.3, 1.2);
    targets.push({ pos: new THREE.Vector3(x, 1.2, z), start: TIMELINE.cloud + i * 0.3 });
  });
  [[-3.6, 5.6], [3.6, 5.6]].forEach(([x, z], i) => {
    const g = new THREE.Group();
    const screen = new THREE.Mesh(T(new THREE.BoxGeometry(1.4, 0.9, 0.08)),
      std({ color: 0x0a1f4d, emissive: BLUE, emissiveIntensity: 0.5, metalness: 0.6, roughness: 0.3 }));
    screen.position.y = 0.6; g.add(screen);
    const stand = new THREE.Mesh(T(new THREE.BoxGeometry(0.1, 0.4, 0.1)), std({ color: 0x0a1f4d, metalness: 0.8, roughness: 0.3 }));
    stand.position.y = 0.0; g.add(stand);
    // Heartbeat trace in neutral grey: the loader does not know the agents' status.
    const ys = [0, 0, 0.25, -0.22, 0.18, 0, 0];
    const pts = [-0.55, -0.25, -0.12, -0.02, 0.08, 0.2, 0.55].map((px, j) => new THREE.Vector3(px, 0.6 + ys[j], 0.06));
    const trace = new THREE.Line(T(new THREE.BufferGeometry().setFromPoints(pts)), T(new THREE.LineBasicMaterial({ color: 0x94a3b8, transparent: true })));
    g.add(trace);
    g.position.set(x, -1.5, z); g.userData.y = -1.5;
    g.lookAt(x * 0.3, -1.5, 30); // screen toward the viewer
    scaleIn(g, TIMELINE.agents + i * 0.3, 1);
    anims.push((t) => { trace.material.opacity *= 0.45 + Math.max(0, Math.sin(t * 4 + i)) * 0.55; });
    targets.push({ pos: new THREE.Vector3(x, -1.2, z), start: TIMELINE.agents + i * 0.3 });
  });

  /* ── 7–8. paths draw outward, then pulses travel them ── */
  const paths = [];
  targets.forEach((tg, i) => {
    const from = new THREE.Vector3(0, -1.0, 0);
    const mid = from.clone().lerp(tg.pos, 0.5); mid.y += 2.2;
    const curve = new THREE.QuadraticBezierCurve3(from, mid, tg.pos);
    const SEG = 90;
    const geo = T(new THREE.BufferGeometry().setFromPoints(curve.getPoints(SEG)));
    const line = new THREE.Line(geo, T(new THREE.LineDashedMaterial({ color: CYAN, transparent: true, opacity: 0.65, dashSize: 0.1, gapSize: 0.13 })));
    line.computeLineDistances();
    const COUNT = 6;
    const dots = new THREE.Points(
      T(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3))),
      T(new THREE.PointsMaterial({ color: ICE, size: 0.16, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })),
    );
    const pulse = new THREE.Mesh(T(new THREE.SphereGeometry(0.14, 12, 10)), glow(ICE, 0));
    world.add(line, dots, pulse);
    const drawStart = Math.max(TIMELINE.paths + i * 0.1, tg.start + 0.6);
    const pulseStart = Math.max(TIMELINE.pulses, drawStart + 0.8);
    paths.push({ curve });
    anims.push((t) => {
      geo.setDrawRange(0, Math.floor(easeOut(win(t, drawStart, 0.8)) * (SEG + 1)));
      line.visible = t >= drawStart;
      const on = easeOut(win(t, pulseStart, 0.5));
      dots.material.opacity = on; pulse.material.opacity = on;
      if (on <= 0) return;
      const arr = dots.geometry.attributes.position.array;
      for (let k = 0; k < COUNT; k++) {
        const v = curve.getPoint((t * 0.3 + k / COUNT + i * 0.11) % 1);
        arr[k * 3] = v.x; arr[k * 3 + 1] = v.y; arr[k * 3 + 2] = v.z;
      }
      dots.geometry.attributes.position.needsUpdate = true;
      pulse.position.copy(curve.getPoint(1 - ((t * 0.5 + i * 0.17) % 1)));
    });
  });

  /* ── 9. floating monitoring panels behind the core: shapes, no numbers ── */
  {
    const pm = T(new THREE.MeshBasicMaterial({ color: 0x0e2a5c, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
    const fm = T(new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0.7 }));
    const plane = T(new THREE.PlaneGeometry(2.6, 1.5));
    const edges = T(new THREE.EdgesGeometry(plane));
    [-1.5, -0.5, 0.5, 1.5].forEach((k, i) => {
      const p = new THREE.Group();
      const a = k * 0.36;
      const home = new THREE.Vector3(Math.sin(a) * 10.5, 3.2 - Math.abs(k) * 0.35, -Math.cos(a) * 10.5 + 3);
      p.position.copy(home); p.lookAt(0, 2.4, 8);
      p.add(new THREE.Mesh(plane, pm));
      p.add(new THREE.LineSegments(edges, fm));
      const bm = glow(CYAN, 0.8);
      for (let b = 0; b < 6; b++) {
        const h = 0.25 + ((b * 37 + i * 11) % 9) / 11;
        const bar = new THREE.Mesh(T(new THREE.PlaneGeometry(0.2, h)), bm);
        bar.position.set(-0.95 + b * 0.38, -0.62 + h / 2, 0.01); p.add(bar);
      }
      world.add(fadeable(p));
      const start = TIMELINE.panels + i * 0.18;
      anims.push((t) => {
        const e = easeOut(win(t, start, 0.8));
        setAlpha(p, e);
        p.position.set(home.x, home.y - (1 - e) * 1.2 + Math.sin(t * 0.6 + i) * 0.08, home.z);
      });
    });
  }

  /* drifting data particles */
  const MOTES = 240;
  const motePos = new Float32Array(MOTES * 3);
  for (let i = 0; i < MOTES; i++) { motePos[i * 3] = (Math.random() - 0.5) * 40; motePos[i * 3 + 1] = Math.random() * 12 - 2; motePos[i * 3 + 2] = (Math.random() - 0.5) * 30; }
  const motes = new THREE.Points(
    T(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(motePos, 3))),
    T(new THREE.PointsMaterial({ color: CYAN, size: 0.07, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })),
  );
  world.add(motes);
  anims.push((t, dt) => {
    motes.material.opacity = 0.6 * easeOut(win(t, 0.3, 2));
    const mp = motes.geometry.attributes.position.array;
    for (let i = 0; i < MOTES; i++) { mp[i * 3 + 1] += dt * 0.25; if (mp[i * 3 + 1] > 10) mp[i * 3 + 1] = -2; }
    motes.geometry.attributes.position.needsUpdate = true;
  });

  /* ── real RAC nodes (Oracle pages), labelled from GV$INSTANCE ── */
  const racGroup = new THREE.Group(); world.add(racGroup);
  let racNodes = [];
  function setNodes(list) {
    racNodes.forEach((n) => racGroup.remove(n.obj));
    racNodes = [];
    (Array.isArray(list) ? list : []).slice(0, 4).forEach((n, i) => {
      const st = nodeState(n);
      const obj = new THREE.Group();
      const x = -3.4 - i * 1.5; const z = 2.6 + (i % 2) * 0.9;
      const p = pad(0, 0, 0.8); p.position.set(0, -0.1, 0); obj.add(p);
      for (let s = 0; s < 3; s++) {
        const c = new THREE.Mesh(T(new THREE.CylinderGeometry(0.45, 0.45, 0.2, 32)),
          std({ color: 0x0d2f7a, emissive: NODE_COLOUR[st], emissiveIntensity: 0.5, metalness: 0.8, roughness: 0.25 }));
        c.position.y = 0.2 + s * 0.25; obj.add(c);
      }
      obj.position.set(x, -2.05, z);
      racGroup.add(fadeable(obj));
      racNodes.push({ key: `rac-${i}`, label: n.instance_name || null, sub: n.host_name || '', state: st, obj, anchor: new THREE.Vector3(x, -0.6, z) });
    });
  }
  anims.push((t) => {
    const e = easeOut(win(t, TIMELINE.rac, 0.7));
    racNodes.forEach((n) => setAlpha(n.obj, e));
  });

  /* ── camera: a slow dolly in during the build, then a gentle orbit ── */
  let w = 1; let h = 1;
  const look = new THREE.Vector3(0, 0.2, 0);
  const resize = () => {
    w = canvas.clientWidth || 1; h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = camera.aspect < 1.4 ? 50 : 36;
    camera.updateProjectionMatrix();
  };
  resize();

  let fadeStart = null;
  function placeCamera(t) {
    const d = easeOut(win(t, 0, TIMELINE.built));
    const z = 27 - d * 7.5;
    const y = 8.5 - d * 1.8;
    const orbit = Math.sin(t * 0.11) * 1.4;
    camera.position.set(orbit, y + Math.sin(t * 0.2) * 0.2, z);
    camera.lookAt(look);
  }

  const clock = new THREE.Clock();
  let t = reducedMotion ? TIMELINE.built + 1 : 0;

  function frame(dt) {
    anims.forEach((fn) => fn(t, dt));
    placeCamera(t);
    if (fadeStart !== null) {
      const f = easeOut(clamp01((t - fadeStart) / 0.5));
      world.scale.setScalar(1 + f * 0.12);
      renderer.domElement.style.opacity = String(1 - f);
    }
    if (onLabels) {
      const out = [];
      const v = new THREE.Vector3();
      const a = easeOut(win(t, TIMELINE.rac + 0.4, 0.6));
      racNodes.forEach((n) => {
        if (!n.label) return;
        v.copy(n.anchor).project(camera);
        out.push({ key: n.key, label: n.label, sub: n.sub, state: n.state, x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, alpha: a });
      });
      onLabels(out);
    }
    renderer.render(scene, camera);
  }

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { resize(); if (reducedMotion) frame(0); }) : null;
  ro?.observe(canvas);

  let raf = 0; let paused = false; let disposed = false;
  const loop = () => {
    if (disposed) return;
    raf = requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.05);
    if (paused) return;
    t += dt;
    frame(dt);
  };
  if (reducedMotion) frame(0); else raf = requestAnimationFrame(loop);

  return {
    setNodes(list) { setNodes(list); if (reducedMotion) frame(0); },
    /** The real request finished: fade the world out. */
    setDone() { if (fadeStart === null) fadeStart = t; if (reducedMotion) frame(0); },
    /** Seconds into the build — exposed for tests. */
    get time() { return t; },
    /** Render the build at a given second (tests, and stills). */
    seek(time) { t = Math.max(0, time); frame(0); },
    resize,
    setPaused(v) { paused = !!v; clock.getDelta(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      scene.traverse((o) => { o.geometry?.dispose?.(); });
      owned.forEach((d) => d?.dispose?.());
      owned.length = 0;
      scene.clear();
      renderer.dispose();
      renderer.forceContextLoss?.();
    },
  };
}
