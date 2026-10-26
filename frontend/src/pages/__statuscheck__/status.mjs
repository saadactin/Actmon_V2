/* Monitoring Overview — Database Server / Infra Hosts status tiles and the filtered
   lists they open, in the REAL app (router, auth guard, layout, the real Database
   Servers and Infrastructure pages) with the API answered from fixtures by
   intercepting requests in Chrome. Nothing touches a database.

   cd frontend && npx vite --port 2106          (terminal 1)
   node src/pages/__statuscheck__/status.mjs <outDir> */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = process.env.APP_URL || 'http://localhost:2106';
const OUT = process.argv[2] || 'statusshots';
const PORT = 9469;
mkdirSync(OUT, { recursive: true });

/* ── fixtures: GET /os-servers/ (stored status) + GET /os-servers/live-status (poller) ──
   Expected after the live merge (the InfraPage / DatabaseServersPage rule):
     infra 9            = online 1,2,5,6,8 (5) · warning 4 (1) · offline 3,7,9 (3)
     database instances 8 = one per host + technology, by THAT engine's status
       (live db_services, else the stored instance status; rac-peer keeps its own):
       online  ACTIN-CS-85/Oracle, amtktdbsrv/PostgreSQL, KPATCH-13/Oracle        (3)
       warning GennovaSrv/SQL Server                                              (1)
       offline ACTIN-CS-85/MySQL, koebomebstestdb/Oracle, ACTIN-CS-89/MySQL       (3)
       unknown NOSTATUS-01/ClickHouse                                             (1)       */
const H = (id, name, os, status, dbs, extra = {}) => ({
  id, server_name: name, hostname: name.toLowerCase(), ip_address: `10.0.0.${id}`, os_type: os, environment: 'Production',
  database_services: dbs.map(([t]) => t), status, db_status: dbs.length ? 'Running' : 'Unknown', collector: 'agent', node_type: 'Standalone',
  db_instances: dbs.map(([t, st]) => ({ db_type: t, port: 1521, status: st, connection_id: null })), cpu_usage: '10%', ram_usage: '20%', disk_usage: '30%', ...extra,
});
const HOSTS = [
  H(1, 'ACTIN-CS-16', 'Windows', 'Connected', []),
  H(2, 'ACTIN-CS-85', 'Windows', 'Connected', [['oracle', 'Running'], ['mysql', 'Stopped']]),   // two engines → two rows
  H(3, 'koebomebstestdb', 'Linux', 'Connected', [['oracle', 'Running']]),                       // live: down + Oracle stopped
  H(4, 'GennovaSrv', 'Linux', 'Warning', [['mssql', 'Degraded']]),
  H(5, 'amtktdbsrv', 'Windows', 'Connected', [['postgresql', 'Running']]),
  H(6, 'K-Test', 'Windows', 'Disconnected', []),                                                // live: Connected
  H(7, 'ACTIN-CS-89', 'Windows', 'Disconnected', [['mysql', 'Running']]),                       // live: MySQL stopped
  H(8, 'KPATCH-13', 'Linux', 'Connected', [['oracle', 'Running']], { collector: 'rac-peer' }),  // live says down; own collector stands
  H(9, 'NOSTATUS-01', 'Linux', null, [['clickhouse', 'Unknown']]),                              // no reading → Unknown
];
const LIVE = { data: [
  { id: 3, os_status: 'Disconnected', db_status: 'Stopped', db_services: { oracle: 'Stopped' } },
  { id: 6, os_status: 'Connected', db_status: 'Unknown', db_services: {} },
  { id: 7, os_status: 'Disconnected', db_status: 'Stopped', db_services: { mysql: 'Stopped' } },
  { id: 8, os_status: 'Disconnected', db_status: 'Stopped', db_services: { oracle: 'Stopped' } },
] };
function answer(url) {
  const p = new URL(url).pathname.replace(/\/+$/, '');
  if (p.endsWith('/os-servers')) return [200, { status: 'success', data: HOSTS }];
  if (p.endsWith('/os-servers/live-status')) return [200, LIVE];
  if (p.endsWith('/os-servers/summary')) return [200, { total: 9, connected: 6, warning: 1, disconnected: 2, clusters: 0 }];
  if (p.endsWith('/alerts/active')) return [200, []];
  if (p.endsWith('/cloud/accounts')) return [200, [{ id: 1, provider: 'azure' }]];
  if (p.endsWith('/agents')) return [200, []];
  if (/\/connections\//.test(p)) return [200, []];
  return [200, {}];
}

/* ── chrome ── */
const profile = mkdtempSync(join(process.env.TMP || tmpdir(), 'status-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1920,1080', 'about:blank'], { stdio: 'ignore' });
let wsUrl;
for (let i = 0; i < 80 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl; } catch { /* starting */ }
  if (!wsUrl) await sleep(200);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => { ws.onopen = r; });
let mid = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res) => { const i = ++mid; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const pageErrors = [];
ws.onmessage = async (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') { const d = (m.params.exceptionDetails?.exception?.description || '').split('\n')[0]; pageErrors.push(d); console.log('  PAGE ERROR', d); }
  if (m.method === 'Fetch.requestPaused') {
    const [code, body] = answer(m.params.request.url);
    send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: code,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') });
  }
};
const js = async (expr) => (await Promise.race([send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }), sleep(20000).then(() => ({}))])).result?.result?.value;
async function waitFor(expr, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr)) return true; await sleep(120); } return false; }
const hasText = (t) => `document.body.innerText.includes(${JSON.stringify(t)})`;
const loc = () => js('location.pathname + location.search');
const shot = async (n) => { const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, n), Buffer.from(s.result.data, 'base64')); };
let passed = 0; let failed = 0;
const ok = (c, msg) => { if (c) { passed++; console.log('  PASS ', msg); } else { failed++; console.log('  FAIL ', msg); } };

// A summary tile, found by its label.
const tile = (label) => `[...document.querySelectorAll('.card')].find(c => (c.innerText || '').trim().startsWith(${JSON.stringify(label)}))`;
const clickPart = (label, part) => js(`(() => { const t = ${tile(label)}; const b = t && [...t.querySelectorAll('button')].find(x => x.textContent.trim().endsWith(${JSON.stringify(part)})); if (!b) return false; b.click(); return true; })()`);
// Host names must appear in the visible page text, the hidden ones must not.
const visible = (names, hidden = []) => `(() => { const t = document.body.innerText; return ${JSON.stringify(names)}.every(n => t.includes(n)) && ${JSON.stringify(hidden)}.every(n => !t.includes(n)); })()`;

await send('Runtime.enable');
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/v1/*' }] });
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
const payload = Buffer.from(JSON.stringify({ sub: 'qa', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
await send('Page.navigate', { url: `${ORIGIN}/login` });
await sleep(1500);
await js(`localStorage.setItem('actmon_token', 'x.${payload}.y'); localStorage.setItem('actmon_user', JSON.stringify({ id: 1, username: 'qa', role_id: 1, org_id: 1 })); true`);
const openDash = async () => { await send('Page.navigate', { url: `${ORIGIN}/dashboard` }); return waitFor(`(${tile('Database Server')})?.innerText.includes('Online') && document.body.innerText.includes('Top CPU Hosts')`, 30000); };

console.log('=== summary tiles ===');
ok(await openDash(), 'dashboard renders');
await sleep(700);
await shot('status-1920.png');
ok(!(await js(`[...document.querySelectorAll('.card')].some(c => /^Agents\\b/.test((c.innerText || '').trim()))`)), 'the Agents summary card is gone');
for (const l of ['Database Server', 'Infra Hosts', 'Cloud Accounts', 'SSH Hosts', 'Active Alerts']) ok(await js(`!!(${tile(l)})`), `"${l}" card kept`);
const tops = await js(`['Database Server','Infra Hosts','Cloud Accounts','SSH Hosts','Active Alerts'].map(l => Math.round([...document.querySelectorAll('.card')].find(c => (c.innerText || '').trim().startsWith(l)).getBoundingClientRect().top))`);
ok(new Set(tops).size === 1, `the five cards share one row at 1920 (${tops})`);
const db = await js(`${tile('Database Server')}.innerText`);
ok(/\b08\b/.test(db) && db.includes('3 Online') && db.includes('1 Warning') && db.includes('3 Offline') && db.includes('1 Unknown'), `Database Server 8 instances = 3 Online + 1 Warning + 3 Offline + 1 Unknown (got: ${db.replace(/\n/g, ' | ')})`);
const inf = await js(`${tile('Infra Hosts')}.innerText`);
ok(/\b09\b/.test(inf) && inf.includes('5 Online') && inf.includes('1 Warning') && inf.includes('3 Offline') && !inf.includes('Healthy'), `Infra Hosts 9 = 5 Online + 1 Warning + 3 Offline, no "Healthy" (got: ${inf.replace(/\n/g, ' | ')})`);
ok(await js(`(() => { const b = [...${tile('Infra Hosts')}.querySelectorAll('button')]; return getComputedStyle(b.find(x => x.textContent.includes('Online'))).color !== getComputedStyle(b.find(x => x.textContent.includes('Offline'))).color; })()`), 'Online and Offline in different colours');

console.log('=== database server navigation ===');
// The list's rows as "Technology/Server/DB status".
const dbRows = () => js(`[...document.querySelectorAll('tbody tr')].filter(tr => tr.cells.length >= 8).map(tr => [tr.cells[1].innerText.replace(/[^A-Za-z ]/g, '').trim(), tr.cells[2].innerText.split('\\n')[0].trim(), tr.cells[7].innerText.trim()].join('/'))`);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const DB_ON = ['Oracle/ACTIN-CS-85/Running', 'PostgreSQL/amtktdbsrv/Running', 'Oracle/KPATCH-13/Running'];
const DB_OFF = ['MySQL/ACTIN-CS-85/Stopped', 'Oracle/koebomebstestdb/Stopped', 'MySQL/ACTIN-CS-89/Stopped'];
const DB_WARN = ['SQL Server/GennovaSrv/Degraded'];
const DB_UNK = ['ClickHouse/NOSTATUS-01/Unknown'];
ok(await clickPart('Database Server', 'Online'), 'click Database Server → Online');
ok(await waitFor(`(location.pathname + location.search) === '/databases?status=online'`, 8000), `lands on /databases?status=online (at ${await loc()})`);
ok(await waitFor(hasText('Database Servers — Online') && hasText('Database Technology'), 15000), 'title says Online; the list has a Database Technology column');
await waitFor(`document.querySelectorAll('tbody tr').length > 0`, 8000);
let r = await dbRows(); console.log('  online rows:', JSON.stringify(r));
ok(same(r, DB_ON), 'one row per online database technology (ACTIN-CS-85 appears for its running Oracle only)');
await shot('db-online.png');
await send('Page.reload');
ok(await waitFor(hasText('Database Servers — Online'), 20000) && same(await (async () => { await waitFor(`document.querySelectorAll('tbody tr').length > 0`, 8000); return dbRows(); })(), DB_ON), 'a reload keeps the Online filter');
ok(await openDash(), 'back to dashboard');
ok(await clickPart('Database Server', 'Offline'), 'click Database Server → Offline');
ok(await waitFor(`(location.pathname + location.search) === '/databases?status=offline'`, 8000), 'lands on /databases?status=offline');
ok(await waitFor(hasText('Database Servers — Offline'), 15000), 'title says Offline');
await waitFor(`document.querySelectorAll('tbody tr').length > 0`, 8000);
r = await dbRows(); console.log('  offline rows:', JSON.stringify(r));
ok(same(r, DB_OFF), 'one row per offline database technology (incl. the stopped MySQL on an online host)');
ok(await js(`(() => { const b = [...document.querySelectorAll('button[aria-pressed]')].find(x => /^WARNING/i.test(x.innerText.trim().split('\\n').find(l => /[a-z]/i.test(l)) || '')); if (!b) return false; b.click(); return true; })()`), "switch the page's own filter to Warning");
ok(await waitFor(`location.search === '?status=warning'`, 5000) && same(await dbRows(), DB_WARN), 'the URL follows the page filter (status=warning → SQL Server on GennovaSrv)');
ok(await openDash(), 'back to dashboard');
await waitFor(`(${tile('Database Server')})?.innerText.includes('Unknown')`, 8000);
ok(await clickPart('Database Server', 'Unknown'), 'click Database Server → Unknown');
await waitFor(`location.search === '?status=unknown' && document.body.innerText.includes('Database Technology') && document.body.innerText.includes('NOSTATUS-01')`, 10000);
ok(same(await dbRows(), DB_UNK), 'Unknown lists the instance with no reading, never guessed online or offline');
ok(await openDash(), 'back to dashboard');
ok(await js(`(() => { ${tile('Database Server')}.querySelector('button').click(); return true; })()`), 'click the Database Server heading');
ok(await waitFor(`(location.pathname + location.search) === '/databases?status=all'`, 8000), 'lands on /databases?status=all');
await waitFor(`document.body.innerText.includes('Database Technology') && [...document.querySelectorAll('tbody tr')].filter(tr => tr.cells.length >= 8).length >= 8`, 10000);
r = await dbRows();
ok(same(r, [...DB_ON, ...DB_OFF, ...DB_WARN, ...DB_UNK]), `all 8 instances, none for hosts without a database (got ${r.length})`);
ok(await js(`(() => { const b = [...document.querySelectorAll('tbody tr')].find(tr => tr.innerText.includes('amtktdbsrv')).querySelector('button[title^="Open the"]'); b.click(); return true; })()`), 'Open on a row');
ok(await waitFor(`location.pathname === '/postgresql-servers'`, 6000), `with no registered connection, Open falls back to that technology's server page (at ${await loc()})`);
await send('Page.navigate', { url: `${ORIGIN}/databases` });
ok(await waitFor(hasText('Choose Technology'), 15000), 'plain /databases is still the technology chooser');
await send('Page.navigate', { url: `${ORIGIN}/oracle-servers` });
const perTech = await waitFor(`/Oracle DB Servers/i.test(document.body.innerText) && !/All Database/i.test(document.body.innerText)`, 15000);
if (!perTech) console.log('  body:', JSON.stringify((await js('document.body.innerText')).slice(0, 300)));
ok(perTech, 'per-technology pages unchanged');

console.log('=== infra host navigation ===');
const IN_ON = ['ACTIN-CS-16', 'ACTIN-CS-85', 'amtktdbsrv', 'K-Test', 'KPATCH-13'];
const IN_OFF = ['koebomebstestdb', 'ACTIN-CS-89', 'NOSTATUS-01'];
ok(await openDash(), 'back to dashboard');
ok(await clickPart('Infra Hosts', 'Online'), 'click Infra Hosts → Online');
ok(await waitFor(`(location.pathname + location.search) === '/infra/hosts?status=online'`, 8000), 'lands on /infra/hosts?status=online');
ok(await waitFor(visible(['Status: Online · 5 of 9', ...IN_ON], [...IN_OFF, 'GennovaSrv']), 15000), 'only the 5 online hosts, with "Status: Online · 5 of 9"');
await shot('infra-online.png');
await send('Page.reload');
ok(await waitFor(visible(['Status: Online', ...IN_ON], IN_OFF), 20000), 'a reload keeps the Online filter');
ok(await openDash(), 'back to dashboard');
ok(await clickPart('Infra Hosts', 'Offline'), 'click Infra Hosts → Offline');
ok(await waitFor(`location.search === '?status=offline'`, 8000) && await waitFor(visible(['Status: Offline · 3 of 9', ...IN_OFF], IN_ON), 15000), 'only the 3 offline hosts (a missing status counts as offline, as on this page)');
ok(await js(`(() => { const r = [...document.querySelectorAll('tbody tr, .card')].find(x => x.offsetParent && x.innerText.includes('ACTIN-CS-89') && !x.innerText.includes('koebomebstestdb')); if (!r) return false; (r.querySelector('button, a') || r).click(); return true; })()`), 'click a host in the filtered list');
ok(await waitFor(`location.pathname === '/infra/7'`, 8000), `host detail navigation still works (at ${await loc()})`);
ok(await openDash(), 'back to dashboard');
ok(await js(`(() => { ${tile('Infra Hosts')}.querySelector('button').click(); return true; })()`), 'click the Infra Hosts heading');
ok(await waitFor(`(location.pathname + location.search) === '/infra/hosts'`, 8000) && await waitFor(visible([...IN_ON, ...IN_OFF, 'GennovaSrv']), 15000), 'all 9 hosts, unfiltered');
ok(await js(`(() => { const i = document.querySelector('input[placeholder^="Search host"]'); if (!i) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'gennova'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), 'type in the existing host search');
ok(await waitFor(visible(['GennovaSrv'], ['ACTIN-CS-85', 'K-Test']), 5000), 'existing search still filters');

console.log('=== other sections untouched ===');
ok(await openDash(), 'dashboard');
const titles = await js(`[...document.querySelectorAll('h2')].map(h => h.textContent.trim())`);
console.log('  sections:', JSON.stringify(titles));
ok(['Top CPU Hosts (Top 5)', 'Top Memory Hosts (Top 5)', 'Top Disk Hosts (Top 5)', 'Recent Alerts', 'Fleet Health', 'Hosts by OS'].every((t) => titles.includes(t)), 'Top Hosts cards, Recent Alerts and the charts are all still there');
ok(titles.includes('Cloud by Provider') || titles.includes('Hosts by Environment'), 'the distribution card is still there (Cloud by Provider, or Hosts by Environment when no cloud data)');
ok(await js('document.documentElement.scrollWidth <= window.innerWidth + 1'), 'no horizontal scroll at 1920');
for (const [w, h] of [[1440, 900], [1280, 800], [900, 900]]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  ok(await openDash(), `renders at ${w}px`);
  ok(await js('document.documentElement.scrollWidth <= window.innerWidth + 1'), `no horizontal scroll at ${w}px`);
  ok(await js(`['Database Server','Infra Hosts','Cloud Accounts','SSH Hosts','Active Alerts'].every(l => { const c = [...document.querySelectorAll('.card')].find(x => (x.innerText || '').trim().startsWith(l)); return c && c.scrollWidth <= c.clientWidth + 1; })`), `summary cards do not overflow at ${w}px`);
  await shot(`status-${w}.png`);
}
ok(pageErrors.length === 0, `no page errors (${pageErrors.length})`);
console.log(`\n${passed} passed, ${failed} failed`);
chrome.kill();
process.exit(failed ? 1 : 0);
