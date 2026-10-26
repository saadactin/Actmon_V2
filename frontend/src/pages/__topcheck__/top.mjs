/* Monitoring Overview — Top CPU / Memory / Disk Hosts cards, in the REAL app (router,
   auth guard, layout) with the API answered from fixtures by intercepting requests in
   Chrome. Nothing touches a database.

   cd frontend && npx vite --port 2106          (terminal 1)
   node src/pages/__topcheck__/top.mjs <outDir> */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = process.env.APP_URL || 'http://localhost:2106';
const OUT = process.argv[2] || 'topshots';
const PORT = 9467;
mkdirSync(OUT, { recursive: true });

/* ── fixtures in the GET /os-servers/ shape (os_server_service.svc_list_os_servers) ──
   status is the stored host status; cpu/ram/disk are the stored "NN%" strings. */
const H = (id, name, os, status, cpu, ram, disk, dbs = []) => ({
  id, server_name: name, hostname: name.toLowerCase(), ip_address: `10.0.0.${id}`, os_type: os, environment: 'Production',
  database_services: dbs, status, db_status: dbs.length ? 'Running' : 'Unknown', collector: 'agent', db_instances: [],
  cpu_usage: cpu, ram_usage: ram, disk_usage: disk,
});
const HOSTS = [
  H(1, 'ACTIN-CS-16', 'Windows', 'Connected', '92%', '64%', '62%'),
  H(2, 'ACTIN-CS-85', 'Windows', 'Connected', '78%', '95%', '88%', ['oracle']),
  H(3, 'koebomebstestdb', 'Linux', 'Connected', '61%', '72%', '93%', ['oracle']),
  H(4, 'GennovaSrv', 'Linux', 'Warning', '48%', '86%', '71%', ['mssql']),
  H(5, 'amtktdbsrv', 'Windows', 'Connected', 'N/A', '38%', '40%', ['postgresql']), // no CPU reading
  H(6, 'K-Test', 'Windows', 'Disconnected', '99%', '99%', '99%'),                    // offline: frozen
  H(7, 'ACTIN-CS-89', 'Windows', 'Disconnected', '97%', '97%', '97%'),               // offline: frozen
  H(8, 'KPATCH-13', null, 'Connected', '20%', '30%', '10%', ['oracle']),            // OS not reported
  H(9, 'IDLE-01', 'Linux', 'Connected', '0%', '5%', '3%'),                          // a real 0% reading
];
let MODE = 'ok'; // ok | empty | error | slow
function answer(url) {
  const p = new URL(url).pathname.replace(/\/+$/, '');
  if (p.endsWith('/os-servers')) {
    if (MODE === 'error') return [500, { detail: 'boom' }];
    return [200, { status: 'success', data: MODE === 'empty' ? [] : HOSTS }];
  }
  if (p.endsWith('/os-servers/summary')) return [200, { total: 9, connected: 6, warning: 1, disconnected: 2 }];
  if (p.endsWith('/alerts/active')) return [200, [{ id: '1:7', rule_id: 1, rule_name: 'Host down', severity: 'critical', metric: 'host_down', source: 'ACTIN-CS-89', message: 'Host down', created_at: new Date().toISOString() }]];
  if (p.endsWith('/cloud/accounts')) return [200, [{ id: 1, provider: 'azure' }, { id: 2, provider: 'aws' }]];
  if (p.endsWith('/agents')) return [200, []];
  return [200, {}];
}

/* ── chrome ── */
const profile = mkdtempSync(join(process.env.TMP || tmpdir(), 'top-'));
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
    if (MODE === 'slow' && m.params.request.url.includes('/os-servers/') && !m.params.request.url.includes('summary')) await sleep(4000);
    send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: code,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') });
  }
};
const js = async (expr) => (await Promise.race([send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }), sleep(20000).then(() => ({}))])).result?.result?.value;
async function waitFor(expr, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr)) return true; await sleep(120); } return false; }
const hasText = (t) => `document.body.innerText.includes(${JSON.stringify(t)})`;
const card = (title) => `[...document.querySelectorAll('section')].find(s => s.querySelector('h2') && s.querySelector('h2').textContent.trim().startsWith(${JSON.stringify(title)}))`;
const cardText = (title) => js(`(${card(title)})?.innerText || ''`);
const rowsOf = (title) => js(`[...((${card(title)})?.querySelectorAll('tbody tr') || [])].map(tr => [...tr.cells].map(c => c.innerText.trim()).concat([tr.querySelector('[aria-label]')?.getAttribute('aria-label') || '']))`);
const shot = async (n) => { const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, n), Buffer.from(s.result.data, 'base64')); };
let passed = 0; let failed = 0;
const ok = (c, msg) => { if (c) { passed++; console.log('  PASS ', msg); } else { failed++; console.log('  FAIL ', msg); } };

await send('Runtime.enable');
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/v1/*' }] });
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
const payload = Buffer.from(JSON.stringify({ sub: 'qa', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
await send('Page.navigate', { url: `${ORIGIN}/login` });
await sleep(1500);
await js(`localStorage.setItem('actmon_token', 'x.${payload}.y'); localStorage.setItem('actmon_user', JSON.stringify({ id: 1, username: 'qa', role_id: 1, org_id: 1 })); true`);
const openDash = async (want = 'GennovaSrv') => { await send('Page.navigate', { url: `${ORIGIN}/dashboard` }); return waitFor(hasText('Top CPU Hosts') && hasText(want), 30000); };

console.log('=== the swap ===');
ok(await openDash(), 'dashboard renders with the new cards');
await sleep(800);
await shot('top-1920.png');
for (const gone of ['Avg. CPU Usage', 'Avg. Memory Usage', 'Avg. Disk Usage']) ok(!(await js(hasText(gone))), `"${gone}" gauge is gone`);
const titles = await js(`[...document.querySelectorAll('section h2')].map(h => h.textContent.trim())`);
console.log('  cards:', JSON.stringify(titles));
ok(['Top CPU Hosts (Top 5)', 'Top Memory Hosts (Top 5)', 'Top Disk Hosts (Top 5)'].every((t) => titles.includes(t)), 'the three ranking cards, titled "(Top 5)"');
ok(['Fleet Health', 'Hosts by OS', 'Cloud by Provider', 'Recent Alerts', 'Alerts By Severity', 'Servers By Database Technologies'].every((t) => titles.includes(t)), 'every other section is still there (incl. DB technologies)');
ok(!titles.includes('Engine Distribution') && !(await js(hasText('Engine Distribution'))), 'Engine Distribution is gone');
const charts = await js(`['Fleet Health','Hosts by OS','Cloud by Provider'].map(t => { const s = [...document.querySelectorAll('section')].find(x => x.querySelector('h2')?.textContent.trim() === t); const r = s.getBoundingClientRect(); const h = s.querySelector('h2').getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, hl: h.left - r.left, ht: h.top - r.top }; })`);
console.log('  charts:', JSON.stringify(charts.map((c) => [Math.round(c.l), Math.round(c.w), Math.round(c.t), Math.round(c.b)])));
ok(charts.every((c) => Math.abs(c.t - charts[0].t) < 2 && Math.abs(c.b - charts[0].b) < 2), 'the three charts share one row, top and bottom edges aligned');
ok(charts.every((c) => Math.abs(c.w - charts[0].w) < 2), 'equal widths');
ok(charts[0].l < charts[1].l && charts[1].l < charts[2].l, 'order: Fleet Health, Hosts by OS, Cloud by Provider');
ok(charts.every((c) => Math.abs(c.hl - charts[0].hl) < 2 && Math.abs(c.ht - charts[0].ht) < 2), 'headings aligned the same way in all three');
const topRight = await js(`(() => { const s = [...document.querySelectorAll('section')].find(x => x.querySelector('h2')?.textContent.trim().startsWith('Top Disk Hosts')); return s.getBoundingClientRect().right; })()`);
ok(Math.abs(charts[2].r - topRight) < 2, 'no empty fourth column: the chart row spans the same width as the Top Hosts row');
const sum = await js(`[...document.querySelectorAll('button,div')].filter(x => /^(Database Server|Infra Hosts|Cloud Accounts|Active Alerts)/.test(x.textContent.trim())).length > 0`);
ok(sum, 'summary tiles still there');

console.log('=== rankings ===');
const cpu = await rowsOf('Top CPU Hosts');
console.log('  cpu:', JSON.stringify(cpu));
ok(JSON.stringify(cpu.map((r) => r[1])) === JSON.stringify(['ACTIN-CS-16', 'ACTIN-CS-85', 'koebomebstestdb', 'GennovaSrv', 'KPATCH-13']), 'CPU: top 5 high → low (Warning host kept, offline + N/A excluded)');
ok(JSON.stringify(cpu.map((r) => r[0])) === '["1","2","3","4","5"]', 'CPU: ranks 1–5');
ok(cpu[0][3] === '92%' && cpu[4][3] === '20%', 'CPU: exact percentages at the end of the bars');
ok(cpu[0][4] === 'Windows' && cpu[2][4] === 'Linux' && cpu[4][2] === 'N/A', 'OS from os_type: Windows / Linux marks, unreported OS shows N/A (not guessed)');
const ct = await cardText('Top CPU Hosts');
ok(ct.includes('1 with no reading (N/A)') && ct.includes('2 offline, not ranked'), 'CPU footer explains the excluded hosts');
ok(!ct.includes('K-Test') && !ct.includes('ACTIN-CS-89') && !ct.includes('amtktdbsrv'), 'frozen offline values and the N/A host never appear as rows');
const mem = await rowsOf('Top Memory Hosts');
ok(JSON.stringify(mem.map((r) => r[1])) === JSON.stringify(['ACTIN-CS-85', 'GennovaSrv', 'koebomebstestdb', 'ACTIN-CS-16', 'amtktdbsrv']) && mem[0][3] === '95%', 'Memory: top 5 high → low by ram_usage');
const disk = await rowsOf('Top Disk Hosts');
ok(JSON.stringify(disk.map((r) => r[1])) === JSON.stringify(['koebomebstestdb', 'ACTIN-CS-85', 'GennovaSrv', 'ACTIN-CS-16', 'amtktdbsrv']) && disk[0][3] === '93%', 'Disk: top 5 high → low by disk_usage');
const bars = await js(`[...(${card('Top CPU Hosts')}).querySelectorAll('tbody tr')].map(tr => { const b = tr.querySelector('span[aria-hidden] > span'); return [b.style.width, getComputedStyle(b).backgroundColor]; })`);
ok(bars[0][0] === '92%' && bars[4][0] === '20%' && bars[0][1] !== bars[4][1], 'bar length = value, colour by band (high ≠ low)');

console.log('=== layout at 1920×1080 ===');
const boxes = await js(`['Top CPU Hosts','Top Memory Hosts','Top Disk Hosts','Recent Alerts'].map(t => { const r = (${card('X')}) ; return null; })`);
const rects = await js(`(() => { const get = t => { const s = [...document.querySelectorAll('section')].find(s => s.querySelector('h2')?.textContent.trim().startsWith(t)); const r = s.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
  return { cpu: get('Top CPU Hosts'), mem: get('Top Memory Hosts'), disk: get('Top Disk Hosts'), alerts: get('Recent Alerts'), fleet: get('Fleet Health') }; })()`);
ok(Math.abs(rects.cpu.t - rects.mem.t) < 2 && Math.abs(rects.mem.t - rects.disk.t) < 2, 'the three cards share one row');
ok(Math.abs(rects.cpu.w - rects.mem.w) < 2 && Math.abs(rects.mem.w - rects.disk.w) < 2 && Math.abs(rects.cpu.h - rects.disk.h) < 2, 'equal widths and heights');
ok(rects.disk.r <= rects.alerts.l + 1, 'Recent Alerts stays on the right, no overlap');
ok(rects.fleet.t >= rects.cpu.b, 'the cards sit above the lower charts');
ok(await js('document.documentElement.scrollWidth <= window.innerWidth + 1'), 'no horizontal page scroll at 1920');
ok(await js(`[...document.querySelectorAll('section tbody td')].every(td => td.scrollWidth <= td.clientWidth + 1)`), 'no cell text overflows');

console.log('=== navigation ===');
ok(await js(`(() => { const b = [...(${card('Top Memory Hosts')}).querySelectorAll('tbody button')].find(x => x.textContent.trim() === 'GennovaSrv'); b.click(); return true; })()`), 'click a host name');
ok(await waitFor(`location.pathname === '/infra/4'`, 8000), `opens that host's existing detail page (/infra/4) (at ${await js('location.pathname')})`);
ok(await openDash(), 'back to dashboard');
ok(await js(`(() => { const b = (${card('Top Disk Hosts')}).querySelector('header button'); b.click(); return true; })()`), 'click the card arrow');
ok(await waitFor(`location.pathname === '/infra/hosts'`, 8000), 'arrow opens the host list');
await js('history.back()');
ok(await waitFor(`location.pathname === '/dashboard'`, 6000), 'browser Back returns to the dashboard');

console.log('=== states ===');
MODE = 'slow';
await send('Page.navigate', { url: `${ORIGIN}/dashboard` });
ok(await waitFor(`!!(${card('Top CPU Hosts')})?.querySelector('[role=status]')`, 8000), 'loading: skeleton while hosts load');
ok(await waitFor(hasText('GennovaSrv'), 15000), 'then the rankings appear');
MODE = 'empty';
ok(await openDash('No host metrics available'), 'empty: "No host metrics available"');
ok((await cardText('Top Disk Hosts')).includes('No host metrics available') && !(await js(hasText('0%'))), 'empty: no invented 0% rows');
MODE = 'error';
await send('Page.navigate', { url: `${ORIGIN}/dashboard` });
ok(await waitFor(hasText('Host metrics could not be loaded.'), 20000), 'error: a concise message in the cards');
ok(await js(hasText('Cloud by Provider') && hasText('Recent Alerts')), 'error: the rest of the dashboard still renders');
await shot('top-error.png');
MODE = 'ok';

console.log('=== smaller widths ===');
for (const [w, h] of [[1440, 900], [1280, 800], [900, 900]]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  ok(await openDash(), `renders at ${w}px`);
  ok(await js('document.documentElement.scrollWidth <= window.innerWidth + 1'), `no horizontal scroll at ${w}px`);
  ok(await js(`[...document.querySelectorAll('section tbody td')].every(td => td.scrollWidth <= td.clientWidth + 1)`), `no cell overflow at ${w}px`);
  await shot(`top-${w}.png`);
}

ok(pageErrors.length === 0, `no page errors (${pageErrors.length})`);
console.log(`\n${passed} passed, ${failed} failed`);
chrome.kill();
process.exit(failed ? 1 : 0);
