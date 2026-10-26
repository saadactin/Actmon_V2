/* Capture the harness so the rendering can be looked at, not just measured. */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL_BASE = process.env.QA_URL || 'http://localhost:5199/src/pages/_shared/__qacheck__/index.html';
const OUT = process.argv[2] || 'plan-canvas.png';
const PORT = 9449;

const profile = mkdtempSync(join(tmpdir(), 'qashot-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1600,1000', URL_BASE,
], { stdio: 'ignore' });

async function target() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
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

await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1400, deviceScaleFactor: 1, mobile: false });
for (let i = 0; i < 80; i++) {
  const r = await send('Runtime.evaluate', { expression: '!!document.querySelector("h1")', returnByValue: true });
  if (r.result?.result?.value) break;
  await sleep(250);
}
// Let the WebGL scene come up before the shutter.
await sleep(2200);

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
console.log('wrote', OUT);
ws.close();
chrome.kill();
