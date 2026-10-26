/* Add-Database wizard → existing agent: the browser names the agent and never handles its token.
   REAL app, API answered from test fixtures (Chrome request interception). Nothing touches a database.
     cd frontend && npx vite --port 2106
     node src/pages/__wizardcheck__/wizard.mjs <outDir> */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = process.env.APP_URL || 'http://localhost:2106';
const OUT = process.argv[2] || 'wizshots';
const PORT = 9493;
mkdirSync(OUT, { recursive: true });
const now = Date.now();
// The API no longer sends tokens — only whether a host agent has one.
const AGENTS = [
  { id: 76, name: 'koebomebsdevapp01', db_type: 'Host', status: 'online', has_agent_token: true, environment: 'Production', last_heartbeat: new Date(now).toISOString() },
  { id: 65, name: 'K-Test', db_type: 'Oracle', status: 'online', has_agent_token: false, environment: 'Production', last_heartbeat: new Date(now).toISOString() },
];
const bodies = [];
function answer(url, method, postData) {
  const u = new URL(url);
  const p = u.pathname.replace(/\/+$/, '');
  if (method === 'POST') bodies.push({ path: p, body: postData ? JSON.parse(postData) : null });
  if (p.endsWith('/agents') && method === 'GET') return [200, AGENTS];
  if (p.endsWith('/agents/db-test')) return [200, { ok: true, message: 'Connected via agent.' }];
  if (p.endsWith('/agents/db-config') && method === 'POST') return [200, { status: 'success', db_type: 'MySQL', connection_id: 42 }];
  if (p.endsWith('/os-servers')) return [200, { status: 'success', data: [] }];
  return [200, []];
}

const profile = mkdtempSync(join(process.env.TMP || tmpdir(), 'wiz-'));
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
    const [code, body] = answer(m.params.request.url, m.params.request.method, m.params.request.postData);
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

const clickText = (t) => js(`(() => { const b = [...document.querySelectorAll('button, tr, label')].find(x => x.textContent.trim() === ${JSON.stringify(t)} || (x.tagName === 'TR' && x.textContent.includes(${JSON.stringify(t)}))); if (b) { b.click(); return true; } return false; })()`);
const setVal = (sel, v) => js(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); if (!i) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

console.log('=== existing agent, named — no token in the browser ===');
await js(`sessionStorage.clear(); true`);
await send('Page.navigate', { url: `${ORIGIN}/agents/setup/databases/mysql` });
ok(await waitFor(`${has('koebomebsdevapp01')}`, 30000), 'existing host agent is listed (has_agent_token)');
ok(await js(`!document.body.innerText.includes('K-Test')`), 'database agents (no token) are not offered');
await clickText('koebomebsdevapp01');
await sleep(300);
await clickText('Next');
ok(await waitFor(`!!document.querySelector('input[type=password]')`, 10000), 'moved on to credentials');
await setVal('input[type=password]', 'pw');
const before = bodies.length;
await clickText('Test via agent');
await sleep(1500);
const test = bodies.slice(before).find((b) => b.path.endsWith('/agents/db-test'));
ok(test && test.body.agent_name === 'koebomebsdevapp01' && !('token' in test.body), `db-test sends agent_name, no token (${JSON.stringify(test?.body && { agent_name: test.body.agent_name, token: test.body.token })})`);
await shot('wizard-credentials.png');
await setVal('input[placeholder="My MySQL"]', 'qa-mysql');
for (let i = 0; i < 4 && !bodies.some((b) => b.path.endsWith('/agents/db-config')); i++) {
  await sleep(600);
  await js(`(() => { const b = [...document.querySelectorAll('button')].reverse().find(x => /^(Next|Observe Database|Finish|Save|Done)/.test(x.textContent.trim()) && !x.disabled); b && b.click(); return !!b; })()`);
}
await sleep(1500);
const cfg = bodies.find((b) => b.path.endsWith('/agents/db-config'));
ok(cfg && cfg.body.agent_name === 'koebomebsdevapp01' && !('token' in cfg.body), `db-config sends agent_name, no token (${JSON.stringify(cfg?.body && { agent_name: cfg.body.agent_name, token: cfg.body.token })})`);
ok(!bodies.some((b) => b.path.endsWith('/install-token')), 'no new install token minted for an existing agent');
await shot('wizard-done.png');

ok(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 3).join(' | ')})`);
console.log(`\n${passed} passed, ${failed} failed`);
chrome.kill();
process.exit(failed ? 1 : 0);
