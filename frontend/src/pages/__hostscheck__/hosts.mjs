/* Dashboard "open all hosts" → ranked lists → CPU / Memory / Disk pages, the Disk page, and the host-overview
   detail links — in the REAL app with the API answered from test fixtures (Chrome request interception).
     cd frontend && npx vite --port 2106
     node src/pages/__hostscheck__/hosts.mjs <outDir> */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = process.env.APP_URL || 'http://localhost:2106';
const OUT = process.argv[2] || 'hostshots';
const PORT = 9485;
mkdirSync(OUT, { recursive: true });
const GB = 1073741824;
const now = Date.now();
const MIN = 60000;
const H = (id, name, os, status, cpu, ram, disk) => ({ id, server_name: name, hostname: name.toLowerCase(), ip_address: `10.0.0.${id}`, os_type: os, environment: 'Production',
  database_services: [], status, db_status: 'Unknown', collector: 'agent', db_instances: [], cpu_usage: cpu, ram_usage: ram, disk_usage: disk, last_infra_at: new Date(now - 20_000).toISOString() });
const HOSTS = [
  H(50, 'ACTIN-CS-16', 'Windows', 'Connected', '42%', '78%', '94%'), H(58, 'koebomebspatdb01', 'Linux', 'Connected', '38%', '73%', '88%'),
  H(60, 'koebomebsdevdb0', 'Linux', 'Connected', '22%', '81%', '88%'), H(53, 'ACTIN-CS-89', 'Windows', 'Connected', '14%', '76%', '60%'),
  H(57, 'koebomebstestdb', 'Linux', 'Connected', '11%', '73%', '40%'), H(62, 'kapextest', 'Linux', 'Connected', '9%', '17%', '20%'),
  H(52, 'ACTIN-CS-85', 'Windows', 'Disconnected', '5%', '50%', '70%'), H(70, 'newhost', 'Linux', 'Connected', null, null, null),
];
const FS = {
  60: [{ filesystem: '/dev/mapper/ol-root', mount: '/', fstype: 'xfs', use_pct: 88, size: '30G', used: '26G', avail: '4G', size_b: 30 * GB, used_b: 26.4 * GB, avail_b: 3.6 * GB, inode_pct: 9 },
    { filesystem: '/dev/sdb1', mount: '/u01', fstype: 'ext4', use_pct: 61, size: '200G', used: '122G', avail: '78G', size_b: 200 * GB, used_b: 122 * GB, avail_b: 78 * GB, inode_pct: 2 },
    { filesystem: 'tmpfs', mount: '/run', fstype: 'tmpfs', use_pct: 1, size: '16G', used: '9M', avail: '16G', size_b: 16 * GB, used_b: 9e6, avail_b: 16 * GB }],
  50: [{ filesystem: 'C:', mount: 'C:', fstype: 'NTFS', label: '', use_pct: 94, size: '143.3 GB', used: '134.7 GB', avail: '8.6 GB', size_b: 143.3 * GB, used_b: 134.7 * GB, avail_b: 8.6 * GB }],
};
const calls = [];
function answer(url) {
  const u = new URL(url);
  const p = u.pathname.replace(/\/+$/, '');
  calls.push(p + u.search);
  if (p.endsWith('/os-servers')) return [200, { status: 'success', data: HOSTS }];
  if (p.endsWith('/os-servers/summary')) return [200, { total: 8, connected: 7, warning: 0, disconnected: 1 }];
  if (p.endsWith('/os-servers/live-status')) return [200, { status: 'success', data: [] }];
  const one = p.match(/\/os-servers\/(\d+)$/);
  if (one) { const h = HOSTS.find((x) => x.id === Number(one[1])); return h ? [200, { status: 'success', data: h }] : [404, { detail: 'Server not found' }]; }
  const det = p.match(/\/os-servers\/(\d+)\/infra-detail$/);
  if (det) {
    const id = Number(det[1]); const h = HOSTS.find((x) => x.id === id);
    return [200, { status: 'success', host: { id, server_name: h.server_name, collector: 'agent', is_agent: true }, cpu_pct: 22, system: { os: /win/i.test(h.os_type) ? 'Windows Server 2019' : 'Oracle Linux Server 8.10', hostname: h.hostname },
      uptime: 'up 9 hours, 42 minutes', memory: { total_mb: 32000, used_mb: 26000, free_mb: 6000, available_mb: 6000, used_pct: 81 }, filesystems: FS[id] || FS[60], processes: [], ports: [], interfaces: [] }];
  }
  const dh = p.match(/\/disk\/(\d+)\/history$/);
  if (dh) {
    const id = Number(dh[1]);
    const samples = Array.from({ length: 120 }, (_, k) => ({ t: Math.floor((now - (120 - k) * MIN) / MIN) * MIN, busiest: 86 + k / 60, used_bytes: 148 * GB + k * 0.01 * GB, size_bytes: 230 * GB }));
    const cur = samples.slice(60);
    return [200, { samples, stats: { current: { n: 240, avg: 87.5, max: 88, max_t: cur[59].t, min: 87, min_t: cur[0].t }, previous: { n: 240, avg: 86.5, max: 87, min: 86 } },
      mounts: id === 60 ? [{ mount: '/', growth_bytes: 0.6 * GB, rate_bytes_per_day: 14.4 * GB, days_to_full_estimate: 0.3 }, { mount: '/u01', growth_bytes: 0, rate_bytes_per_day: 0, days_to_full_estimate: null }] : [] }];
  }
  if (/\/disk\/\d+\/mount-history$/.test(p)) return [200, { points: Array.from({ length: 30 }, (_, k) => ({ t: now - (30 - k) * 2 * MIN, use_pct: 87 + k / 30, used_bytes: 26 * GB, size_bytes: 30 * GB, inode_pct: 9 })) }];
  if (/\/memory\/\d+\//.test(p)) return [200, { samples: [], stats: { current: null, previous: null }, names: [], points: [], events: [], leaks: [], recommendations: [] }];
  if (/\/metrics\/history\//.test(p)) return [200, { samples: [] }];
  if (p.endsWith('/alerts/active')) return [200, []];
  if (p.endsWith('/agents')) return [200, [{ name: 'koebomebsdevdb0', hostname: 'koebomebsdevdb0', agent_version: '1.9.0' }]];
  if (p.endsWith('/cloud/accounts')) return [200, []];
  return [200, {}];
}

const profile = mkdtempSync(join(process.env.TMP || tmpdir(), 'hosts-'));
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
    const [code, body] = answer(m.params.request.url);
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

for (const [title, metric, first, detailPath, detailText] of [
  ['Top CPU Hosts', 'cpu', 'ACTIN-CS-16', '/cpu-performance/50', 'CPU Performance'],
  ['Top Memory Hosts', 'memory', 'koebomebsdevdb0', '/memory/60', 'Memory Consumption - koebomebsdevdb0'],
  ['Top Disk Hosts', 'disk', 'ACTIN-CS-16', '/disk/50', 'Disk Consumption'],
]) {
  console.log(`=== ${title} → all hosts ===`);
  await send('Page.navigate', { url: `${ORIGIN}/dashboard` });
  ok(await waitFor(`!!${arrow(title)}`, 30000), `${title}: arrow present`);
  await js(`${arrow(title)}.click(), true`);
  ok(await waitFor(`location.pathname === '/hosts/top/${metric}'`), `arrow opens /hosts/top/${metric} (not /infra)`);
  ok(await waitFor(`${has('All Hosts by')} && ${has('ranked ·')} && document.querySelectorAll('tbody tr').length >= 8`), 'every host listed (not cut to 5)');
  const firstName = await js(`document.querySelector('tbody tr td:nth-child(2) button')?.textContent`);
  ok(firstName === first, `ranked highest first (${firstName})`);
  ok(await waitFor(`${has('Offline — last known reading, not ranked')} && ${has('ACTIN-CS-85')}`), 'offline host listed separately, not ranked');
  ok(await js(`${has('Online, no')} && ${has('newhost')}`), 'host without a reading shown as N/A, not ranked');
  if (metric === 'cpu') await shot('hosts-cpu.png');
  await js(`document.querySelector('tbody tr td:nth-child(2) button').click(), true`);
  ok(await waitFor(`location.pathname === '${detailPath}'`), `host click opens ${detailPath}`);
  ok(await waitFor(has(detailText)), `${detailText} page renders`);
}

console.log('=== ranking page controls ===');
await send('Page.navigate', { url: `${ORIGIN}/hosts/top/disk` });
await waitFor(`document.querySelectorAll('tbody tr').length >= 8`);
await js(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Highest first')).click(), true`);
ok(await waitFor(`document.querySelector('tbody tr td:nth-child(2) button')?.textContent === 'kapextest'`), 'sort toggles to lowest first');
await js(`(() => { const s = document.querySelector('select[aria-label="Operating system"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'windows'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
ok(await waitFor(`!${has('kapextest')} && ${has('ACTIN-CS-89')}`), 'OS filter');
await js(`[...document.querySelectorAll('[role=tab]')].find(b => b.textContent.includes('Memory')).click(), true`);
ok(await waitFor(`location.pathname === '/hosts/top/memory'`), 'metric tabs switch ranking');

console.log('=== Disk page ===');
await send('Page.navigate', { url: `${ORIGIN}/disk/60` });
ok(await waitFor(`${has('Disk Consumption')} && ${has('koebomebsdevdb0')} && ${has('Agent v1.9.0')}`), 'header + host card');
ok(await waitFor(`/Current Disk Usage\\s*88%/.test(document.body.innerText)`), 'current = busiest filesystem (88%)');
ok(await js(`/Total Capacity\\s*230\\.0 GB/.test(document.body.innerText)`), 'total capacity from exact bytes (tmpfs excluded)');
ok(await js(`/Peak Disk Usage\\s*88\\.0%/.test(document.body.innerText)`), 'peak from stored history');
ok(await waitFor(`!!(${card('Disk Utilization Trend')})?.querySelector('.recharts-area-area')`), 'trend chart');
ok(await waitFor(`!!(${card('Capacity by Filesystem')})?.querySelector('.recharts-bar-rectangle')`), 'capacity chart');
const fsText = await js(`(${card('Filesystems')})?.innerText || ''`);
ok(fsText.includes('/u01') && !fsText.includes('/run') && fsText.includes('~0.3 d') && fsText.includes('not growing') && fsText.includes('9%'), 'filesystem table: growth, estimate, inodes; tmpfs hidden');
await js(`[...document.querySelectorAll('td')].find(td => td.textContent === '/').click(), true`);
ok(await waitFor(`${has('Filesystem History — /')} && !!(${card('Filesystem History')})?.querySelector('.recharts-area-area')`), 'row click shows that filesystem\'s history');
ok(calls.some((c) => c.includes('/disk/60/mount-history') && c.includes('mount=%2F')), 'mount history requested for "/"');
await shot('disk-60.png', 1700);
await send('Page.navigate', { url: `${ORIGIN}/disk/999` });
ok(await waitFor(has('Host not found')), 'disk: unknown host not found');

console.log('=== host overview → consumption pages ===');
for (const [label, path] of [['Open CPU Consumption', '/cpu-performance/60'], ['Open Memory Consumption', '/memory/60'], ['Open Disk Consumption', '/disk/60']]) {
  await send('Page.navigate', { url: `${ORIGIN}/infra/60` });
  ok(await waitFor(`!!document.querySelector('[aria-label="${label}"]')`, 25000), `overview has "${label}"`);
  await js(`document.querySelector('[aria-label="${label}"]').click(), true`);
  ok(await waitFor(`location.pathname === '${path}'`), `${label} → ${path}`);
}
await shot('after-link.png');

ok(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 3).join(' | ')})`);
console.log(`\n${passed} passed, ${failed} failed`);
chrome.kill();
process.exit(failed ? 1 : 0);
