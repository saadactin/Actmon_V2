/* Infrastructure → Overview (fleet), in the REAL app with the API answered from test fixtures (Chrome request
   interception). Nothing touches a database.
     cd frontend && npx vite --port 2106
     node src/pages/__fleetcheck__/fleet.mjs <outDir> */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = process.env.APP_URL || 'http://localhost:2106';
const OUT = process.argv[2] || 'fleetshots';
const PORT = 9489;
mkdirSync(OUT, { recursive: true });
const now = Date.now();
const MIN = 60000;
// 14 hosts: 4 Windows / 10 Linux, 13 agent + 1 SSH, 2 offline (their readings must NOT count), one online host with no reading
const mk = (id, name, os, status, cpu, ram, disk, collector = 'agent', env = 'Production') => ({ id, server_name: name, hostname: name, ip_address: `10.240.72.${id}`, os_type: os, environment: env, status, collector, cpu_usage: cpu, ram_usage: ram, disk_usage: disk, db_instances: [], database_services: [] });
const HOSTS = [
  mk(1, 'koebomebspatdb01', 'Linux', 'Connected', '97%', '70%', '88%'), mk(2, 'ACTIN-CS-16', 'Windows', 'Connected', '30%', '80%', '94%'),
  mk(3, 'koebomebsdevdb0', 'Linux', 'Connected', '24%', '81%', '88%'), mk(4, 'ACTIN-CS-89', 'Windows', 'Connected', '18%', '76%', '60%'),
  mk(5, 'koebomebstestdb', 'Linux', 'Connected', '17%', '73%', '40%'), mk(6, 'amtktdbsrv', 'Linux', 'Connected', '5%', '9%', '30%', 'ssh'),
  mk(7, 'lin7', 'Linux', 'Connected', '4%', '50%', '50%'), mk(8, 'lin8', 'Linux', 'Connected', '3%', '40%', '45%'), mk(9, 'lin9', 'Linux', 'Connected', '2%', '30%', '35%'),
  mk(10, 'lin10', 'Linux', 'Connected', '1%', '20%', '25%'), mk(11, 'lin11', 'Linux', 'Connected', '1%', '20%', '25%'), mk(12, 'newwin', 'Windows', 'Connected', null, null, null),
  mk(13, 'ACTIN-CS-85', 'Windows', 'Disconnected', '99%', '99%', '99%'), mk(14, 'GennovaSrv', 'Linux', 'Disconnected', '99%', '99%', '99%'),
];
let MODE = 'ok';
const calls = [];
function answer(url) {
  const u = new URL(url);
  const p = u.pathname.replace(/\/+$/, '');
  calls.push(p + u.search);
  if (p.endsWith('/os-servers')) return [200, { status: 'success', data: HOSTS }];
  if (p.endsWith('/os-servers/summary')) return [200, { total: 14 }];
  if (p.endsWith('/os-servers/live-status')) return [200, { status: 'success', data: [] }];
  if (p.endsWith('/infra-fleet/history')) {
    if (MODE === 'err') return [503, { detail: 'Fleet history unavailable: ClickHouse is unavailable' }];
    const one = u.searchParams.get('server_id');
    return [200, { hosts: one ? 1 : 14, samples: Array.from({ length: 120 }, (_, k) => ({ t: Math.floor((now - (120 - k) * MIN) / MIN) * MIN, cpu: k < 60 ? 15 : 20, memory: k < 60 ? 55 : 57, disk: 60, hosts: 11 })) }];
  }
  const one = p.match(/\/os-servers\/(\d+)$/);
  if (one) { const h = HOSTS.find((x) => x.id === Number(one[1])); return h ? [200, { status: 'success', data: h }] : [404, { detail: 'Server not found' }]; }
  if (/\/infra-detail$/.test(p)) return [200, { status: 'success', host: {}, system: {}, filesystems: [], processes: [] }];
  if (p.endsWith('/alerts/active')) return [200, []];
  if (p.endsWith('/agents')) return [200, []];
  return [200, { samples: [] }];
}

const profile = mkdtempSync(join(process.env.TMP || tmpdir(), 'fleet-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1586,1000', 'about:blank'], { stdio: 'ignore' });
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
    const [code, body] = answer(m.params.request.url);
    send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: code, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') });
  }
};
const js = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
async function waitFor(x, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (await js(x)) return true; await sleep(150); } return false; }
const has = (t) => `document.body.innerText.includes(${JSON.stringify(t)})`;
const shot = async (n, h = 1000) => {
  await send('Emulation.setDeviceMetricsOverride', { width: 1586, height: h, deviceScaleFactor: 1, mobile: false }); await sleep(500);
  const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, n), Buffer.from(s.result.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 1586, height: 1000, deviceScaleFactor: 1, mobile: false });
};
let passed = 0; let failed = 0;
const ok = (c, msg) => { if (c) { passed++; console.log('  PASS ', msg); } else { failed++; console.log('  FAIL ', msg); } };
const card = (title) => `[...document.querySelectorAll('section')].find(s => (s.querySelector('h2')?.textContent || '').trim().startsWith(${JSON.stringify(title)}))`;
const arrow = (title) => `document.querySelector('[aria-label="Open all hosts — ${title}"]')`;

await send('Runtime.enable');
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/v1/*' }] });
await send('Emulation.setDeviceMetricsOverride', { width: 1586, height: 1000, deviceScaleFactor: 1, mobile: false });
const payload = Buffer.from(JSON.stringify({ sub: 'qa', exp: Math.floor(now / 1000) + 3600 })).toString('base64url');
await send('Page.navigate', { url: `${ORIGIN}/login` });
await sleep(1500);
await js(`localStorage.setItem('actmon_token', 'x.${payload}.y'); localStorage.setItem('actmon_user', JSON.stringify({ id: 1, username: 'qa', role_id: 1, org_id: 1 })); true`);

console.log('=== Infrastructure overview ===');
await send('Page.navigate', { url: `${ORIGIN}/infra` });
ok(await waitFor(`${has('14 hosts')} && ${has('Needs Attention')}`, 30000), 'page renders with header summary');
const T = 'document.body.innerText';
ok(await js(`/Total Hosts\\s*14\\s*86% Healthy/.test(${T})`), 'Total Hosts 14, 86% healthy (12/14)');
ok(await js(`/Online\\s*12\\s*86% of 14 hosts/.test(${T})`), 'Online 12');
ok(await js(`/Warning\\s*00\\s*0% of 14 hosts/.test(${T})`), 'Warning 00');
ok(await js(`/Offline\\s*02\\s*14% of 14 hosts/.test(${T})`), 'Offline 02');
// live hosts with a reading (11): cpu avg = (97+30+24+18+17+5+4+3+2+1+1)/11 = 18.36; offline 99% excluded, null excluded
ok(await js(`${T}.includes('CPU 18%') && ${T}.includes('RAM 50%') && ${T}.includes('Disk 53%')`), 'averages over online hosts with a reading only (offline 99% excluded)');
const legend = (title) => `(${card(title)})?.innerText || ''`;
ok(/Windows\s*4/.test(await js(legend('OS Platform'))) && /Linux\s*10/.test(await js(legend('OS Platform'))), 'OS donut: Windows 4 / Linux 10');
ok(/ActMon Agent\s*13/.test(await js(legend('Collector'))) && /SSH \(poll\)\s*1/.test(await js(legend('Collector'))), 'Collector donut: 13 agent / 1 SSH');
ok(/Production\s*14/.test(await js(legend('Environments'))), 'Environments donut');
const na = await js(legend('Needs Attention'));
ok(na.includes('ACTIN-CS-85') && na.includes('GennovaSrv') && na.includes('ALL (2)') && na.includes('Critical (2)') && na.includes('Warning (0)'), 'Needs Attention: the 2 offline hosts, chip counts');
await js(`[...document.querySelectorAll('[role=tab]')].find(b => b.textContent.startsWith('Warning (')).click(), true`);
ok(await waitFor(`(${card('Needs Attention')}).innerText.includes('All warning clear')`), 'Warning chip filters the list');
await js(`[...document.querySelectorAll('[role=tab]')].find(b => b.textContent.startsWith('ALL')).click(), true`);
const top = await js(`[...(${card('Top Hosts By CPU')}).querySelectorAll('tbody tr')].map(r => r.cells[1].innerText.trim())`);
ok(JSON.stringify(top) === JSON.stringify(['koebomebspatdb01', 'ACTIN-CS-16', 'koebomebsdevdb0', 'ACTIN-CS-89', 'koebomebstestdb', 'amtktdbsrv']), `Top 6 by CPU, offline excluded (${(top || []).join(', ')})`);
const red = await js(`getComputedStyle((${card('Top Hosts By CPU')}).querySelector('tbody tr td:nth-child(5) span span')).backgroundColor`);
ok(red === 'rgb(239, 68, 68)', `97% bar is red (${red})`);
const ar = await js(legend('Average Resource Usage'));
ok(ar.includes('18%') && ar.includes('50%') && ar.includes('53%') && ar.includes('vs previous hour'), 'gauges show latest averages + previous-hour comparison');
ok(await waitFor(`(${card('Average Resource Usage')}).querySelectorAll('.recharts-area-area').length === 3`), 'three gauge trend lines');
await shot('fleet-1586.png', 1100);

console.log('=== drill-downs ===');
await js(`[...(${card('Top Hosts By CPU')}).querySelectorAll('button')].find(b => b.textContent.includes('koebomebspatdb01')).click(), true`);
ok(await waitFor(`location.pathname === '/cpu-performance/1'`), 'top CPU host → CPU Consumption');
for (const [title, label, expectPath, expectCount] of [['Host Status', 'Offline', 'status=offline', 2], ['OS Platform', 'Windows', 'os=Windows', 4], ['Collector', 'SSH (poll)', 'collector=ssh', 1], ['Environments', 'Production', 'env=Production', 14]]) {
  await send('Page.navigate', { url: `${ORIGIN}/infra` });
  await waitFor(`!!(${card(title)})`, 20000);
  await js(`[...(${card(title)}).querySelectorAll('button')].find(b => b.textContent.startsWith(${JSON.stringify(label)})).click(), true`);
  ok(await waitFor(`location.pathname === '/infra/hosts' && location.search.includes(${JSON.stringify(expectPath)})`), `${title} → ${label} opens hosts with ${expectPath}`);
  const names = await js(`(async () => { await new Promise(r => setTimeout(r, 1200)); return ${JSON.stringify(HOSTS.map((h) => h.server_name))}.filter(n => document.body.innerText.includes(n)).length; })()`);
  const pagerTotal = await js(`(document.body.innerText.match(/of\\s+(\\d+)\\s+hosts/) || [])[1]`);
  ok(names === expectCount || (names === 10 && Number(pagerTotal) === expectCount), `filtered list = ${expectCount} hosts (visible ${names}, pager total ${pagerTotal})`);
}
await send('Page.navigate', { url: `${ORIGIN}/infra` });
await waitFor(`!!(${card('Needs Attention')})`, 20000);
await js(`[...(${card('Needs Attention')}).querySelectorAll('li button')].find(b => b.textContent.includes('GennovaSrv')).click(), true`);
ok(await waitFor(`location.pathname === '/infra/14'`), 'Needs Attention host → its host page');
await send('Page.navigate', { url: `${ORIGIN}/infra` });
await waitFor(`!!(${card('Average Resource Usage')})`, 20000);
await js(`[...(${card('Average Resource Usage')}).querySelectorAll('button')].find(b => b.title === 'All hosts by Memory').click(), true`);
ok(await waitFor(`location.pathname === '/hosts/top/memory'`), 'Memory gauge → all hosts by memory');

console.log('=== states ===');
MODE = 'err';
await send('Page.navigate', { url: `${ORIGIN}/infra` });
ok(await waitFor(`(${card('Average Resource Usage')})?.innerText.includes('history could not be loaded')`, 20000), 'history failure stated, gauges still show latest readings');
ok(await js(`(${card('Average Resource Usage')}).innerText.includes('18%')`), 'latest averages still shown without history');
MODE = 'ok';
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
await send('Page.navigate', { url: `${ORIGIN}/infra` });
await waitFor(`!!(${card('Needs Attention')})`, 20000);
await sleep(500);
ok(await js(`document.documentElement.scrollWidth <= window.innerWidth + 1`), 'phone width: no horizontal page scroll');

ok(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 3).join(' | ')})`);
console.log(`\n${passed} passed, ${failed} failed`);
chrome.kill();
process.exit(failed ? 1 : 0);
