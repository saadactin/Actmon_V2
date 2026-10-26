/* Dashboard "Recent Alerts": one row per host + category + severity, newest message shown, the rest counted.
   REAL app, API answered with the LIVE /alerts/active response captured from production (alerts_live.json).
     cd frontend && npx vite --port 2106
     node src/pages/__alertscheck__/alerts.mjs <outDir> */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = process.env.APP_URL || 'http://localhost:2106';
const OUT = process.argv[2] || 'alertshots';
const PORT = 9497;
mkdirSync(OUT, { recursive: true });
const now = Date.now();
// live capture, with the timestamps repaired the way the fixed backend now sends them (UTC "Z")
const ALERTS = JSON.parse(readFileSync('E:/tmp_actmon/alerts_live.json', 'utf8')).map((a) => ({ ...a, created_at: a.created_at.replace(/\+05:30Z$/, '+05:30') }));
function answer(url) {
  const p = new URL(url).pathname.replace(/\/+$/, '');
  if (p.endsWith('/alerts/active')) return [200, ALERTS];
  if (p.endsWith('/os-servers')) return [200, { status: 'success', data: [] }];
  return [200, []];
}

const profile = mkdtempSync(join(process.env.TMP || tmpdir(), 'alerts-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
let wsUrl;
for (let i = 0; i < 80 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl; } catch { /* */ } if (!wsUrl) await sleep(200); }
const ws = new WebSocket(wsUrl);
await new Promise((r) => { ws.onopen = r; });
let mid = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res) => { const i = ++mid; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const pageErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') pageErrors.push((m.params.exceptionDetails?.exception?.description || '').split('\n')[0]);
  if (m.method === 'Fetch.requestPaused') {
    const [code, body] = answer(m.params.request.url, m.params.request.method);
    send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: code, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') });
  }
};
const js = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
async function waitFor(x, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (await js(x)) return true; await sleep(150); } return false; }
const has = (t) => `document.body.innerText.includes(${JSON.stringify(t)})`;
const shot = async (n, h = 1000) => {
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: h, deviceScaleFactor: 1, mobile: false }); await sleep(500);
  const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, n), Buffer.from(s.result.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
};
let passed = 0; let failed = 0;
const ok = (c, msg) => { if (c) { passed++; console.log('  PASS ', msg); } else { failed++; console.log('  FAIL ', msg); } };
const card = (title) => `[...document.querySelectorAll('section')].find(s => (s.querySelector('h2')?.textContent || '').trim().startsWith(${JSON.stringify(title)}))`;
const arrow = (title) => `document.querySelector('[aria-label="Open all hosts — ${title}"]')`;

await send('Runtime.enable');
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/v1/*' }] });
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
const payload = Buffer.from(JSON.stringify({ sub: 'qa', exp: Math.floor(now / 1000) + 3600 })).toString('base64url');
await send('Page.navigate', { url: `${ORIGIN}/login` });
await sleep(1500);
await js(`localStorage.setItem('actmon_token', 'x.${payload}.y'); localStorage.setItem('actmon_user', JSON.stringify({ id: 1, username: 'qa', role_id: 1, org_id: 1 })); true`);

await send('Page.navigate', { url: `${ORIGIN}/dashboard` });
const panel = `[...document.querySelectorAll('section')].find(s => (s.innerText || '').startsWith('Recent Alerts'))`;
ok(await waitFor(`!!(${panel})?.querySelector('li')`, 30000), 'Recent Alerts renders');
const raw = await js(`JSON.stringify([...(${panel}).querySelectorAll('li')].map(li => li.innerText))`);
const rows = JSON.parse(raw || '[]').map((t) => t.split(String.fromCharCode(10)).map((x) => x.trim()).filter(Boolean).join(' | '));
console.log(rows.slice(0, 8).join('\n'));
const keyOf = (r) => { const p = r.split(' | ').filter((x) => !/^×\d+$/.test(x)); return [p[0], p[p.length - 2], p[p.length - 1]].join('|'); };
// every group of look-alikes in the LIVE data must collapse to one row with the right count
const groups = {};
for (const x of ALERTS) { const k = [x.source, x.metric || x.rule_name, x.severity].join('|'); groups[k] = (groups[k] || 0) + 1; }
const devKey = Object.keys(groups).find((k) => k.startsWith('Dev Db|disk|critical'));
ok(devKey && groups[devKey] > 1, `live data really has ${groups[devKey]} Dev Db disk-critical alerts`);
await js(`[...(${panel}).querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Critical')).click(), true`);
await sleep(500);
const crit = JSON.parse(await js(`JSON.stringify([...(${panel}).querySelectorAll('li')].map(li => li.innerText))`)).map((t) => t.split(String.fromCharCode(10)).map((y) => y.trim()).filter(Boolean).join(' | '));
const dev = crit.filter((r) => r.startsWith('Dev Db') && / \| Disk \| Critical$/.test(r.replace(/ \| ×\d+/, '')));
ok(dev.length === 1 && dev[0].includes(`×${groups[devKey]}`), `Critical tab: Dev Db · Disk is ONE row "×${groups[devKey]}" (${dev[0] || 'missing'})`);
ok(rows.every((r) => r.split(' | ').length >= 2), 'every row shows its latest message (which tablespace / service)');
ok(new Set(rows.map(keyOf)).size === rows.length, 'no two rows for the same host + category + severity');
await shot('recent-alerts.png');
ok(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`);
console.log(`\n${passed} passed, ${failed} failed`);
chrome.kill(); process.exit(failed ? 1 : 0);
