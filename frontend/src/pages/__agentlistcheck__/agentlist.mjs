/* Agents page list with the LIVE /agents/ response, in the REAL app with the API answered from test fixtures (Chrome request
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
const PORT = 9495;
mkdirSync(OUT, { recursive: true });
const now = Date.now();
const A = (id, name, db_type, status) => ({ id, name, db_type, hostname: name, ip_address: '10.0.0.1', environment: 'Production', status, last_heartbeat: new Date(now - 15000).toISOString(), agent_host_cpu: 10, agent_host_memory: 50, active_sessions: 0 });
let AGENTS = JSON.parse((await import('node:fs')).readFileSync('E:/tmp_actmon/agents_live.json', 'utf8'));   // the exact live /agents/ response
const calls = [];
let FAIL = false;
const SERVERS = JSON.parse((await import('node:fs')).readFileSync('E:/tmp_actmon/servers_live.json', 'utf8'));   // live /os-servers/ response
function answer(url, method) {
  { const pp = new URL(url).pathname.replace(/\/+$/, ''); if (pp.endsWith('/os-servers')) return [200, SERVERS]; if (pp.endsWith('/os-servers/live-status')) return [200, { status: 'success', data: [] }]; }
  if (FAIL && new URL(url).pathname.replace(/\/+$/, '').endsWith('/agents')) return [500, { detail: 'Internal Server Error' }];
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

const profile = mkdtempSync(join(process.env.TMP || tmpdir(), 'alist-'));
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

const HOSTS = AGENTS.filter((a) => !a.has_connection && String(a.db_type).toLowerCase() === 'host');
await js(`localStorage.setItem('actmon_agents_view', 'list'); true`);
await send('Page.navigate', { url: `${ORIGIN}/agents` });
ok(await waitFor(`/\\d+ of \\d+ agents/.test(document.body.innerText)`, 30000), 'list renders with the live response');
const total = await js(`Number((document.body.innerText.match(/(\\d+) of (\\d+) agents/) || [])[2])`);
ok(total === HOSTS.length, `only host agents: ${total} shown, ${HOSTS.length} expected (live data has ${AGENTS.length} rows)`);
ok(await js(`[...document.querySelectorAll('th, [role=columnheader]')].some(h => h.textContent.trim() === 'OS Server')`), 'OS Server column');
ok(!(await js(`[...document.querySelectorAll('th, [role=columnheader]')].some(h => h.textContent.trim() === 'Engine')`)), 'redundant Engine column replaced');
const rows = await js(`[...document.querySelectorAll('tbody tr')].map(r => r.innerText.replace(/\s+/g, ' '))`);
ok(rows.some((r) => r.includes('Linux')), 'OS shown per row');
ok(!rows.some((r) => /Oracle Dev server|Postgresql-Windows|KPATCH-12/.test(r)), 'no database agents in the list');
await shot('alist.png');
// ── grid: the Infrastructure card for every host agent
await js(`localStorage.setItem('actmon_agents_view', 'grid'); true`);
await send('Page.navigate', { url: `${ORIGIN}/agents` });
ok(await waitFor(`[...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Details').length >= 10`, 30000), 'grid renders Infrastructure-style cards (Details buttons)');
const cards = await js(`[...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Details').length`);
ok(cards === HOSTS.length || cards === 10, `one card per host agent on the page (${cards})`);
ok(await js(`${has('ActMon Agent')} && /Disk\\s*\\d+%/.test(document.body.innerText)`), 'cards show collector tag and Disk like Infrastructure');
const srvList = SERVERS.data || SERVERS;
const gen = srvList.find((x) => x.server_name === 'koebomebsdevdb0');
ok(!gen || await js(`(() => { const c = [...document.querySelectorAll('[role=button], div')].find(d => d.querySelector && d.innerText && d.innerText.startsWith('koebomebsdevdb0') && d.innerText.includes('Details')); return !!c && c.innerText.includes(${JSON.stringify(String(Math.round(parseFloat(gen?.cpu_usage || 0))))} + '%'); })()`), 'card values come from the same host record as Infrastructure');
const widths = await js(`JSON.stringify([...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Details').slice(0, 4).map(b => Math.round(b.closest('[role=button]')?.getBoundingClientRect().width || 0)))`);
const w = JSON.parse(widths); ok(w.length > 1 && w.every((x) => x > 300 && Math.abs(x - w[0]) < 2), `cards fill equal grid columns (${widths})`);
ok(await js(`!!document.querySelector('[aria-label="Remove agent koebomebsdevdb0"]')`), 'Remove sits in the card action row');
await js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Details').click(), true`);
ok(await waitFor(`location.pathname.startsWith('/agents/')`), 'Details opens the agent page');
await send('Page.navigate', { url: `${ORIGIN}/agents` });
await waitFor(`[...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Details').length >= 10`, 30000);
await shot('agents-grid.png');
FAIL = true;
await send('Page.navigate', { url: `${ORIGIN}/agents` });
ok(await waitFor(has('Agents could not be loaded'), 30000) && !(await js(has('No host agents registered'))), 'API failure shows an error, not "no agents"');
ok(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`);
console.log(`\n${passed} passed, ${failed} failed`);
chrome.kill(); process.exit(failed ? 1 : 0);
