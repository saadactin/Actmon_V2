/* Drives the content-area loader through its real lifecycle in a browser and
   checks the object-by-object build; writes timed screenshots of it.

   node tour.mjs <outDir>
   env: LOADER_URL (harness page), CHROME_PATH (a Chromium / headless shell) */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.LOADER_URL || 'http://127.0.0.1:5200/src/components/loader/__loadercheck__/index.html';
const OUT = process.argv[2] || 'tour';
const PORT = 9449;
mkdirSync(OUT, { recursive: true });

const profile = mkdtempSync(join(process.env.TMP || tmpdir(), 'loadertour-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1500,1000', 'about:blank',
], { stdio: 'ignore' });

let wsUrl;
for (let i = 0; i < 100 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl; } catch { /* starting */ }
  if (!wsUrl) await sleep(200);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0;
const pending = new Map();
const requested = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') console.log('  PAGE ERROR', (m.params.exceptionDetails?.exception?.description || '').split(String.fromCharCode(10))[0]);
  if (m.method === 'Network.requestWillBeSent') requested.push(m.params.request.url);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
async function waitFor(expr, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr)) return true; await sleep(100); } return false; }
const shot = async (name) => { const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, name), Buffer.from(s.result.data, 'base64')); return s.result.data; };

let passed = 0; let failed = 0;
const ok = (c, msg) => { if (c) { passed++; console.log('  PASS ', msg); } else { failed++; console.log('  FAIL ', msg); } };

await send('Runtime.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });

/* How much of the loader is lit, from a real screenshot of its box: the share
   of bright pixels. As objects arrive the share must rise. */
async function litShare() {
  const r = await js(`(() => { const b = document.querySelector('.actmon-loader').getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height - 120 }; })()`);
  const s = await send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 0.25 } });
  return js(`(async () => { const im = new Image(); im.src = 'data:image/png;base64,${s.result.data}'; await im.decode();
    const k = document.createElement('canvas'); k.width = im.width; k.height = im.height; const g = k.getContext('2d'); g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, k.width, k.height).data; let n = 0;
    for (let i = 0; i < d.length; i += 4) if ((d[i] + d[i + 1] + d[i + 2]) > 200) n++;
    return n / (k.width * k.height); })()`);
}

console.log('=== the build, object by object ===');
await send('Page.navigate', { url: `${BASE}?mode=page&variant=oracleRac` });
ok(await waitFor(`document.querySelector('.actmon-loader')?.dataset.webgl === 'true'`, 25000), 'the WebGL scene comes up');
// Pause the scene and render it at fixed points on its own timeline, so each
// capture shows exactly that moment of the build however slow the renderer.
await js('window.__actmonScene.setPaused(true)');
const lit = [];
for (const at of [0.4, 1.0, 1.8, 2.4, 2.9, 3.4, 4.3, 5.0, 6.0, 6.9, 7.6, 8.6, 10.0]) {
  await js(`window.__actmonScene.seek(${at})`);
  await sleep(150);
  lit.push([at, await litShare()]);
  await shot(`build-${String(at).replace('.', '_')}s.png`);
}
console.log('    lit share over time:', lit.map(([a, s]) => `${a}s=${(s * 100).toFixed(1)}%`).join('  '));
ok(lit.at(-1)[1] > lit[0][1] * 2, `the scene fills in as objects arrive (${(lit[0][1] * 100).toFixed(1)}% → ${(lit.at(-1)[1] * 100).toFixed(1)}%)`);
const steps = lit.filter((_, i) => i > 0 && lit[i][1] > lit[i - 1][1]).length;
ok(steps >= 7, `it builds progressively, not in one jump (${steps} rising samples of ${lit.length - 1})`);
await js('window.__actmonScene.setPaused(false)');
await sleep(500);

const f1 = await shot('_a.png'); await sleep(700); const f2 = await shot('_b.png');
ok(f1 !== f2, 'after the build the scene keeps moving (frames differ)');

console.log('=== layout ===');
const box = await js(`(() => { const h = document.getElementById('page-header').getBoundingClientRect(); const l = document.querySelector('.actmon-loader').getBoundingClientRect();
  return { headerBottom: h.bottom, top: l.top, bottom: Math.round(l.bottom), vh: innerHeight, pos: getComputedStyle(document.querySelector('.actmon-loader')).position }; })()`);
ok(box.top >= box.headerBottom && box.pos !== 'fixed', `the loader sits under the page header, not over it (${JSON.stringify(box)})`);
ok(box.vh - box.bottom < 140, `no large blank band under the loader (${Math.round(box.vh - box.bottom)}px to the viewport bottom)`);
ok(!(await js(`/\\d+%/.test(document.querySelector('.actmon-foot')?.textContent || '')`)), 'no percentage is shown for an unmeasured request');
ok(!requested.some((u) => /\/loader\/step\d+\.(png|webp)/.test(u)), 'none of the reference images is loaded (no slideshow)');

console.log('=== real RAC nodes ===');
await js(`window.__page.nodes([{ instance_name: 'KCDB1', host_name: 'node01', instance_status: 'OPEN' }, { instance_name: 'KCDB2', host_name: 'node02', instance_status: 'MOUNTED' }])`);
await sleep(600);
const labels = await js(`[...document.querySelectorAll('.actmon-node-label')].map(e => e.textContent + '|' + e.dataset.state)`);
ok(labels.length === 2 && labels[0].startsWith('KCDB1') && labels[1].endsWith('connecting'), `real instances with their real state: ${JSON.stringify(labels)}`);
await shot('rac-nodes.png');

console.log('=== completion ===');
await js(`window.__page.succeed()`);
ok(await waitFor(`document.querySelector('.actmon-loader')?.dataset.stage === '10'`, 2000), 'success starts the reveal');
await sleep(200); await shot('reveal.png');
ok(await waitFor(`!!document.getElementById('page-dashboard')`, 2000), 'then the real content replaces the loader');
ok(await js(`document.querySelectorAll('.actmon-canvas').length`) === 0, 'and the canvas is released');

await js(`window.__page.restart()`); await sleep(80); await js(`window.__page.succeed()`); await sleep(150);
ok(await js(`!!document.getElementById('page-dashboard') && !document.querySelector('.actmon-loader')`), 'a fast request never shows the loader');

await js(`window.__page.restart()`);
await waitFor(`!!document.querySelector('.actmon-loader')`, 3000); await sleep(600);
await js(`window.__page.fail()`); await sleep(150);
ok(await js(`!!document.getElementById('page-error') && !document.querySelector('.actmon-loader')`), 'a failure goes straight to the error UI');

console.log(`\n  ${passed} passed, ${failed} failed`);
ws.close(); chrome.kill();
process.exit(failed ? 1 : 0);
