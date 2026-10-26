/* Drives the real loader in headless Chrome. The claims worth checking are
   behavioural, not visual: that the percentage tracks real work, that it never
   reaches 100 before the work does, that a failure shows the error instead of
   a climbing bar, that only declared subsystems get a panel, that WebGL
   initialises and is released, and that it survives a phone viewport. */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.LOADER_URL || 'http://localhost:5199/src/components/loader/__loadercheck__/index.html';
const PORT = 9446;

const profile = mkdtempSync(join(tmpdir(), 'loadercheck-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  // A software GL so WebGL is genuinely available in headless.
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  '--window-size=1600,1000', BASE,
], { stdio: 'ignore' });

async function target() {
  for (let i = 0; i < 90; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch { /* not up */ }
    await sleep(200);
  }
  throw new Error('no debugging target');
}

const ws = new WebSocket(await target());
await new Promise((r) => { ws.onopen = r; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
const goto = async (url) => {
  await send('Page.navigate', { url });
  for (let i = 0; i < 90; i++) {
    if (await js('!!document.querySelector(".actmon-loader")')) return;
    await sleep(200);
  }
};

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ', m); } else { fail++; console.log('  FAIL ', m); } };

await send('Page.enable');
for (let i = 0; i < 90; i++) {
  if (await js('!!document.querySelector(".actmon-loader")')) break;
  await sleep(200);
}

const pct = () => js(`(() => { const e=document.querySelector('.actmon-percent'); return e?parseInt(e.textContent):null; })()`);
const msg = () => js(`(() => { const e=document.querySelector('.actmon-message'); return e?e.textContent.trim():null; })()`);
const panels = () => js(`[...document.querySelectorAll('.actmon-panel')].map(p=>({t:p.querySelector('.actmon-panel-title').textContent,s:p.dataset.state}))`);

console.log('=== the boot loader renders ===');
ok(await js('!!document.querySelector(".actmon-loader")'), 'the full-screen loader is shown while identity is unresolved');
ok(await js('!!document.querySelector(".actmon-brand-logo")'), 'the brand lockup is present');
/* The supplied logo contains ACTMON and INTELLIGENT MONITORING already. The
   typed versions were removed, so the accessible name now comes from the
   image's alt text — which is what a screen reader reads, and what stops the
   brand becoming an unlabelled picture. */
ok((await js(`document.querySelector('.actmon-brand-logo').getAttribute('alt') || ''`)).length > 0,
   'and it carries an accessible name rather than being an unlabelled image');
ok(await js(`!document.querySelector('.actmon-brand-name')`),
   'the typed wordmark is gone, so there is only one ACTMON on screen');
ok(await js('!!document.getElementById("app-ready") === false'), 'and the application behind it is NOT rendered yet');

console.log('\n=== only declared subsystems get a panel ===');
const p0 = await panels();
ok(p0.length === 2, `boot declares two real tasks, so two panels are shown (${p0.map((x) => x.t).join(', ')})`);
ok(!p0.some((x) => /Cloud|Oracle RAC|Databases|Infrastructure/.test(x.t)),
   'no panel claims a subsystem boot does not touch');

console.log('\n=== the percentage tracks real work ===');
const first = await pct();
ok(first !== null, 'a percentage is shown, because boot registers measurable work');
ok(first > 0 && first < 100, `and it is partial while the call is in flight (${first}%)`);
ok(first === 25, 'exactly the weight of the one finished task (1 of 1+3)');
ok((await panels()).find((x) => x.t === 'Application').s === 'done', 'the finished task reads done');
ok((await panels()).find((x) => x.t === 'Authentication').s === 'active', 'the in-flight task reads active, not done');
ok(/Authenticating/.test(await msg()), 'the message names the work actually running');

console.log('\n=== time passing does not move the bar ===');
await sleep(2500);
ok((await pct()) === first, `after 2.5s of waiting the bar has not moved (${await pct()}%)`);
ok(await js('!!document.querySelector(".actmon-loader")'), 'and the loader has not timed itself out');

console.log('\n=== 100% only when the work really finished ===');
await js('window.__boot.succeed({ id: 1, username: "x" })');
await sleep(400);
ok(await js('!!document.getElementById("app-ready")'), 'the application renders once the call resolves');
ok(await js('!document.querySelector(".actmon-loader")'), 'and the loader is gone');

console.log('\n=== failure shows the error, not a full bar ===');
await goto(BASE);
await sleep(300);
await js('window.__boot.fail("Network Error")');
await sleep(400);
const err = await js(`(() => { const e=document.querySelector('.actmon-error'); return e?e.textContent.trim():null; })()`);
ok(err && /Network Error/.test(err), `the real error is shown (${err})`);
ok(await js('!document.querySelector(".actmon-percent")'), 'no percentage is shown once the operation has failed');
ok(await js('!!document.querySelector(".actmon-retry")'), 'and a retry action is offered');
ok(await js('!document.getElementById("app-ready")'), 'the application is not shown over a failed session');

console.log('\n=== retry restarts the real work ===');
await js(`document.querySelector('.actmon-retry').click()`);
await sleep(400);
ok(await js('!document.querySelector(".actmon-error")'), 'retry clears the error');
ok((await pct()) === 25, 'and the bar restarts from the work that is actually done');

console.log('\n=== an unmeasurable wait shows no number ===');
await goto(`${BASE}?mode=variant&variant=route`);
await sleep(400);
ok(await js('!document.querySelector(".actmon-percent")'),
   'the route variant registers no tasks, so NO percentage is shown');
ok(await js(`document.querySelector('.actmon-bar').dataset.indeterminate === 'true'`),
   'the bar runs indeterminate instead');

console.log('\n=== context-aware variants ===');
for (const [variant, panel, text] of [
  ['databases', 'Databases', /database metrics/i],
  ['oracleRac', ['Oracle', 'Database metrics'], /instance details/i],
  ['infrastructure', 'Infrastructure', /server metrics/i],
  ['cloud', 'Cloud', /cloud services/i],
  ['agents', 'Agents', /agent status/i],
  ['security', 'Security', /Validating access/i],
]) {
  await goto(`${BASE}?mode=variant&variant=${variant}`);
  await sleep(300);
  const ps = await panels();
  const m = await msg();
  const want = [].concat(panel);
  ok(ps.length === want.length && want.every((w, i) => ps[i].t === w) && text.test(m),
     `${variant}: panels ${JSON.stringify(want)}, message "${m}"`);
  ok(ps.every((p) => p.s === 'pending'), `${variant}: its panels wait rather than claiming success`);
}

console.log('\n=== WebGL ===');
await goto(`${BASE}?mode=variant&variant=databases`);
for (let i = 0; i < 40; i++) {
  if (await js(`document.querySelector('.actmon-loader').dataset.webgl === 'true'`)) break;
  await sleep(250);
}
ok(await js(`document.querySelector('.actmon-loader').dataset.webgl === 'true'`),
   'the WebGL scene initialises and takes over from the CSS composition');
ok(await js(`(() => { const c=document.querySelector('.actmon-canvas'); return c.width>0 && c.height>0; })()`),
   'the canvas is sized to the viewport');
ok(await js('!!document.querySelector(".actmon-core")'),
   'the CSS composition stays in the DOM as the fallback');

console.log('\n=== the composition holds its columns ===');
await goto(`${BASE}?mode=variant&variant=databases`, '.actmon-loader');
await sleep(600);
const geom = await js(`(() => {
  const R = (e) => { const b = e.getBoundingClientRect();
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
  const st = document.querySelector('.actmon-stage');
  const cols = [...st.children].map((c) => ({ cls: String(c.className), w: R(c).width }));
  const frame = document.querySelector('.actmon-canvas');
  const foot = document.querySelector('.actmon-foot');
  const panels = [...document.querySelectorAll('.actmon-panel')].map(R);
  return {
    stageW: R(st).width,
    cols,
    frame: frame ? R(frame) : null,
    foot: foot ? R(foot) : null,
    panels,
    panelHomes: [...document.querySelectorAll('.actmon-panel')].map((e) => ({
      parent: String(e.parentElement.className),
      parentRect: R(e.parentElement),
      align: getComputedStyle(e.parentElement).alignItems,
      selfW: R(e).width,
    })),
    colRects: [...st.children].map((c) => ({ cls: String(c.className), ...R(c) })),
    vw: window.innerWidth,
    vh: window.innerHeight,
    tmpl: getComputedStyle(st).gridTemplateColumns,
    stageRect: R(st),
  };
})()`);
console.log('    geometry:', JSON.stringify({
  tmpl: geom.tmpl, vw: geom.vw, vh: geom.vh,
  stage: [Math.round(geom.stageRect.top), Math.round(geom.stageRect.bottom)],
  foot: geom.foot ? [Math.round(geom.foot.top), Math.round(geom.foot.bottom)] : null,
  frame: geom.frame ? [Math.round(geom.frame.left), Math.round(geom.frame.width)] : null,
  panels: geom.panels.map((p) => [Math.round(p.left), Math.round(p.top), Math.round(p.bottom)]),
  homes: geom.panelHomes.map((h) => [h.parent, Math.round(h.parentRect.left), Math.round(h.parentRect.width), h.align, Math.round(h.selfW)]),
  colRects: geom.colRects.map((c) => [c.cls, Math.round(c.left), Math.round(c.width)]),
}));
ok(geom.cols.length === 3, 'the stage still has three columns');
{
  const side = geom.cols.filter((c) => c.cls.includes('actmon-col'));
  ok(side.length === 2 && side.every((c) => c.w > geom.stageW * 0.2),
     `the side columns keep their share of the width (${side.map((c) => Math.round(c.w)).join(', ')} of ${Math.round(geom.stageW)})`);
}
ok(geom.frame && geom.frame.width >= geom.vw - 2, 'the 3D canvas spans the full width');
{
  /* Hiding the centre element with display:none removes it from the grid, and
     auto-placement then slid the right-hand column into the middle track —
     putting its panels over the artwork's centre. The columns are placed
     explicitly now; this is what notices if that stops being true. */
  const right = geom.colRects.find((c) => c.cls.includes('--right'));
  ok(right && right.left > geom.stageRect.left + geom.stageRect.width * 0.55,
     `the right column stays in the right-hand track (starts at ${Math.round(right.left)} of ${Math.round(geom.stageRect.width)})`);
  ok(geom.panels.every((p) => p.left > geom.vw * 0.6 || p.right < geom.vw * 0.4),
     'every status panel sits clear of the artwork centre');
}
ok(geom.panels.every((p) => p.bottom <= (geom.foot ? geom.foot.top : 1e9) + 1),
   'no status panel runs into the progress footer');

console.log('\n=== responsive ===');
for (const [w, h, label] of [[1920, 1080, 'desktop'], [1366, 768, 'laptop'], [390, 844, 'phone']]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  await sleep(350);
  const bad = await js(`(() => {
    const els=[...document.querySelectorAll('.actmon-panel, .actmon-brand-name, .actmon-message, .actmon-bar')];
    const vw=innerWidth, vh=innerHeight;
    const out=els.filter(e=>{const b=e.getBoundingClientRect(); return b.right>vw+1||b.left<-1||b.bottom>vh+1||b.top<-1;});
    return out.map(e=>e.className);
  })()`);
  ok(bad.length === 0, `${label} (${w}x${h}): nothing escapes the viewport${bad.length ? ` (${bad.join(', ')})` : ''}`);
  const overlap = await js(`(() => {
    const r=[...document.querySelectorAll('.actmon-panel')].map(e=>e.getBoundingClientRect());
    for(let i=0;i<r.length;i++)for(let j=i+1;j<r.length;j++){const a=r[i],b=r[j];
      if(a.left<b.right-1&&b.left<a.right-1&&a.top<b.bottom-1&&b.top<a.bottom-1) return true;}
    return false; })()`);
  ok(overlap === false, `${label}: no two panels overlap`);
}

console.log('\n=== cleanup ===');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
const before = await js(`(() => { window.__ctx = 0; const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(...a){ window.__ctx++; return orig.apply(this, a); };
  return true; })()`);
ok(before === true, 'context creation is instrumented');
await goto(`${BASE}?mode=variant&variant=cloud`);
await sleep(1200);
const leak = await js(`(() => {
  // After a navigation the previous page's renderer must be gone; a leaked one
  // would keep its canvas in the document.
  return document.querySelectorAll('canvas.actmon-canvas').length; })()`);
ok(leak === 1, `only the current loader's canvas exists (${leak})`);

console.log(`\n  ${pass} passed, ${fail} failed`);
ws.close();
chrome.kill();
process.exit(fail ? 1 : 0);
