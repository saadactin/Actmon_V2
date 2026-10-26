/* Agents page → Remove agent, in the REAL app with the API answered from test fixtures (Chrome request
   interception). Nothing touches a database.
     cd frontend && npx vite --port 2106
     node src/pages/__agentscheck__/agents.mjs <outDir> */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = process.env.APP_URL || 'http://localhost:2106';
const OUT = process.argv[2] || 'agentshots';
const PORT = 9491;
mkdirSync(OUT, { recursive: true });
const now = Date.now();
const A = (id, name, db_type, status) => ({ id, name, db_type, hostname: name, ip_address: '10.0.0.1', environment: 'Production', status, last_heartbeat: new Date(now - 15000).toISOString(), agent_host_cpu: 10, agent_host_memory: 50, active_sessions: 0 });
let AGENTS = [A(50, 'ACTIN-CS-16', 'Host', 'online'), A(57, 'ACTIN-CS-85', 'Host', 'offline'), A(70, 'koebomebstestdb', 'Host', 'online'), A(65, 'K-Test', 'Oracle', 'online')];
const calls = [];
function answer(url, method) {
  const u = new URL(url);
  const p = u.pathname.replace(/\/+$/, '');
  calls.push(`${method} ${p}`);
  if (p.endsWith('/agents') && method === 'GET') return [200, AGENTS];
  const plan = p.match(/\/agents\/by-id\/(\d+)\/removal-plan$/);
  if (plan) {
    const id = Number(plan[1]);
    return id === 57
      ? [200, { agent_id: 57, agent_name: 'ACTIN-CS-85', kind: 'host', db_type: 'Host', host: { id: 52, name: 'ACTIN-CS-85', ip: '172.24.0.1', collector: 'agent' }, tokens: 1, db_targets: [], connection: null, data_rows: { agent_metrics: 1520, agent_notifications: 3 } }]
      : [200, { agent_id: id, agent_name: 'K-Test', kind: 'database', db_type: 'Oracle', host: null, tokens: 0, db_targets: [{ id: 3, db_type: 'Oracle', name: 'K-Test' }], connection: { id: 9, name: 'K-Test', db_type: 'oracle' }, data_rows: {} }];
  }
  const del = p.match(/\/agents\/by-id\/(\d+)$/);
  if (del && method === 'DELETE') { AGENTS = AGENTS.filter((a) => a.id !== Number(del[1])); return [200, { status: 'success' }]; }
  if (p.endsWith('/os-servers')) return [200, { status: 'success', data: [] }];
  return [200, []];
}

const profile = mkdtempSync(join(process.env.TMP || tmpdir(), 'agents-'));
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

const setPerms = async (perms) => js(`localStorage.setItem('actmon_perms', ${JSON.stringify(JSON.stringify(perms.permissions))}); localStorage.setItem('actmon_perm_catalog', ${JSON.stringify(JSON.stringify(perms.catalog))}); localStorage.setItem('actmon_governed', ${JSON.stringify(JSON.stringify(['/agents']))}); true`);
const CATALOG = [{ permission_name: 'view', permission_value: 1 }, { permission_name: 'delete', permission_value: 8 }];

console.log('=== admin (view + delete) ===');
await setPerms({ permissions: [{ page_url: '/agents', permission: 9 }], catalog: CATALOG });
await js(`localStorage.setItem('actmon_agents_view', 'list'); true`);
await send('Page.navigate', { url: `${ORIGIN}/agents` });
await sleep(800);

ok(await waitFor(`!!document.querySelector('[aria-label="Remove agent ACTIN-CS-85"]')`, 30000), 'list view: Remove button on each row');
ok(await js(`[...document.querySelectorAll('th, [role=columnheader]')].some(h => h.textContent.trim() === 'Actions')`), 'Actions column');
await js(`document.querySelector('[aria-label="Remove agent ACTIN-CS-85"]').click(), true`);
ok(await waitFor(`${has('Remove agent “ACTIN-CS-85”?')} && ${has('revoked')} && ${has('172.24.0.1')} && ${has('1,520 metric samples')}`), 'dialog lists exactly what is removed (host, token revoked, data)');
ok(!calls.some((c) => c.startsWith('DELETE')), 'opening the dialog deletes nothing');
const confirmBtn = `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Remove agent')`;
ok(await js(`${confirmBtn}.disabled`), 'Remove disabled until the name is typed');
await js(`(() => { const i = document.querySelector('[aria-label="Type the agent name to confirm"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'ACTIN-CS-8'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
ok(await js(`${confirmBtn}.disabled`), 'wrong name keeps it disabled');
await js(`(() => { const i = document.querySelector('[aria-label="Type the agent name to confirm"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'ACTIN-CS-85'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
ok(await waitFor(`!${confirmBtn}.disabled`), 'exact name enables Remove');
await shot('remove-dialog.png');
await js(`${confirmBtn}.click(), true`);
ok(await waitFor(`!${has('Remove agent “ACTIN-CS-85”?')} && !document.querySelector('[aria-label="Remove agent ACTIN-CS-85"]')`), 'agent removed and gone from the list');
ok(calls.includes('DELETE /api/v1/agents/by-id/57'), 'DELETE sent for that agent id only');
ok(await js(`!!document.querySelector('[aria-label="Remove agent koebomebstestdb"]')`), 'other agents untouched');
ok(!(await js(`!!document.querySelector('[aria-label="Remove agent K-Test"]')`)) && !(await js(has('K-Test'))), 'database agents are not listed (hosts only)');
await js(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Grid'); b && b.click(); return true; })()`);
ok(await waitFor(`!!document.querySelector('[aria-label="Remove agent koebomebstestdb"]')`), 'grid view: Remove on each card');

console.log('=== view-only user ===');
await setPerms({ permissions: [{ page_url: '/agents', permission: 1 }], catalog: CATALOG });
await js(`localStorage.setItem('actmon_agents_view', 'list'); true`);
await send('Page.navigate', { url: `${ORIGIN}/agents` });
await sleep(800);

ok(await waitFor(`${has('koebomebstestdb')}`, 30000) && !(await js(`!!document.querySelector('[aria-label^="Remove agent"]')`)), 'no Remove button without delete permission');

ok(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 3).join(' | ')})`);
console.log(`\n${passed} passed, ${failed} failed`);
chrome.kill();
process.exit(failed ? 1 : 0);
