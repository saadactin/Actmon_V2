/* Infrastructure → host → Overview (reference layout), in the REAL app with the API answered from test fixtures
   (Chrome request interception). Nothing touches a database.
     cd frontend && npx vite --port 2106
     node src/pages/__overviewcheck__/overview.mjs <outDir> */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = process.env.APP_URL || 'http://localhost:2106';
const OUT = process.argv[2] || 'ovshots';
const PORT = 9487;
mkdirSync(OUT, { recursive: true });
const GB = 1073741824;
const now = Date.now();
const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const H = (id, name, os, status) => ({ id, server_name: name, hostname: name, ip_address: `10.0.1.${id}`, os_type: os, environment: 'Production', status, collector: 'agent', cpu_usage: '4%', ram_usage: '35%', disk_usage: '88%', last_infra_at: new Date(now - 20_000).toISOString(), db_instances: [] });
const HOSTS = [H(65, 'koebomebsdevapp01', 'Linux', 'Connected'), H(66, 'otherhost', 'Linux', 'Connected')];
let MODE = 'ok';   // ok | bare (old collector: no detail sections) | histerr
const calls = [];
const LIVE = {
  status: 'success', host: { id: 65, server_name: 'koebomebsdevapp01', hostname: 'koebomebsdevapp01', ip_address: '10.0.1.65', os_type: 'Linux', environment: 'Production', collector: 'agent', is_agent: true },
  system: { os: 'Ubuntu 22.04.3 LTS', kernel: 'Linux 5.15.0-83-generic', hostname: 'koebomebsdevapp01', architecture: 'x86-64', virtualization: 'microsoft', machine_id: 'abc123' },
  uptime: 'up 12 days, 6 hours', cpu_pct: 3.7, proc_count: 245, thread_count: 1290, boot_time: new Date(now - 12.25 * 86400000).toISOString(),
  memory: { total_mb: 32768, used_mb: 11468, free_mb: 21300, available_mb: 21300, used_pct: 35 },
  cpu_detail: { model: 'Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz', physical_cores: 8, logical: 16, sample_s: 0.5, per_core: Array.from({ length: 8 }, (_, i) => ({ id: i, pct: 20 + i * 3 })) },
  mem_detail: { platform: 'linux', total_bytes: 32 * GB, available_bytes: 20.8 * GB, used_bytes: 11.2 * GB, free_bytes: 14.8 * GB, cached_bytes: 6 * GB, used_pct: 35, pressure_score: 35 },
  filesystems: [
    { filesystem: 'nas:/backup', mount: '/prod_backup', fstype: 'nfs4', use_pct: 88, size: '200G', used: '176G', avail: '21G', size_b: 200 * GB, used_b: 176 * GB, avail_b: 21 * GB },
    { filesystem: '/dev/sda1', mount: '/', fstype: 'ext4', use_pct: 49, size: '30G', used: '14G', avail: '15G', size_b: 30 * GB, used_b: 14 * GB, avail_b: 15 * GB },
    { filesystem: 'tmpfs', mount: '/run', fstype: 'tmpfs', use_pct: 1, size: '3G', used: '1M', avail: '3G', size_b: 3 * GB, used_b: 1e6, avail_b: 3 * GB }],
  network: { total_download_mbps: 9.5, total_upload_mbps: 3.0, rate_interval_s: 15.2 },
  interfaces: [{ iface: 'lo', mac: '00:00:00:00:00:00' }, { iface: 'eth0', mac: '00:15:5d:20:4f:8a', state: 'UP' }],
  processes: [{ pid: '4820', user: 'actmon', cpu: '12.4', mem: '3.6', command: 'java', threads: 42 }, { pid: '6156', user: 'actmon', cpu: '8.3', mem: '1.3', command: 'python3', threads: 28 },
    { pid: '3320', user: 'mysql', cpu: '4.1', mem: '1', command: 'mysqld', threads: 36 }, { pid: '5268', user: 'www-data', cpu: '2.8', mem: '1', command: 'nginx', threads: 18 },
    { pid: '1896', user: 'root', cpu: '1.9', mem: '0.8', command: 'sshd', threads: 1 }, { pid: '77', user: 'root', cpu: '0.1', mem: '0.1', command: 'cron', threads: 1 }],
  mem_procs: [{ pid: 3320, name: 'mysqld', ws_bytes: 4 * GB, private_bytes: 3.8 * GB, mem_pct: 12.5, cpu: 4.1, threads: 36, user: 'mysql', status: 'Sleeping' },
    { pid: 4820, name: 'java', ws_bytes: 1.2 * GB, mem_pct: 3.7, cpu: 12.4, threads: 42, user: 'actmon', status: 'Sleeping' }],
};
function answer(url) {
  const u = new URL(url);
  const p = u.pathname.replace(/\/+$/, '');
  calls.push(p + u.search);
  if (p.endsWith('/os-servers')) return [200, { status: 'success', data: HOSTS }];
  if (p.endsWith('/os-servers/summary')) return [200, { total: 2 }];
  if (p.endsWith('/os-servers/live-status')) return [200, { status: 'success', data: [] }];
  const one = p.match(/\/os-servers\/(\d+)$/);
  if (one) { const h = HOSTS.find((x) => x.id === Number(one[1])); return h ? [200, { status: 'success', data: h }] : [404, { detail: 'Server not found' }]; }
  const det = p.match(/\/os-servers\/(\d+)\/infra-detail$/);
  if (det) {
    if (MODE === 'bare') return [200, { status: 'success', host: LIVE.host, system: { os: 'Ubuntu 22.04' }, uptime: 'up 3 days', cpu_pct: 5, memory: { total_mb: 8000, used_pct: 40 }, filesystems: [{ mount: '/', use_pct: 50, size: '30G', used: '15G', avail: '15G' }], processes: [] }];
    return [200, LIVE];
  }
  if (/\/metrics\/history\//.test(p)) {
    if (MODE === 'histerr') return [500, { detail: 'ClickHouse unavailable' }];
    return [200, { samples: Array.from({ length: 120 }, (_, i) => ({ ts: iso(now - (i + 1) * MIN), host_cpu: 3 + (i % 5) })) }];
  }
  const mm = p.match(/\/memory\/(\d+)\/history$/);
  if (mm) return MODE === 'histerr' ? [503, { detail: 'Memory history unavailable: ClickHouse is unavailable' }] : [200, { samples: Array.from({ length: 120 }, (_, k) => ({ t: Math.floor((now - (120 - k) * MIN) / MIN) * MIN, used_pct: 30 + (k % 6) })), stats: {} }];
  if (/\/disk\/\d+\/mount-history$/.test(p)) return [200, { points: Array.from({ length: 60 }, (_, k) => ({ t: Math.floor((now - (60 - k) * MIN) / MIN) * MIN, use_pct: 87.4 + k / 100 })) }];
  if (/\/disk\/\d+\/network-history$/.test(p)) return [200, { samples: Array.from({ length: 120 }, (_, k) => ({ t: Math.floor((now - (120 - k) * MIN) / MIN) * MIN, rx_bps: 1.1e6, tx_bps: 0.4e6 })) }];
  if (/\/disk\/\d+\/history$/.test(p)) return [200, { samples: [], stats: { current: null, previous: null }, mounts: [] }];
  if (/\/memory\/\d+\//.test(p)) return [200, { samples: [], stats: { current: null, previous: null }, names: [], points: [], events: [], leaks: [], recommendations: [] }];
  if (p.endsWith('/alerts/active')) return [200, [
    { id: '1:65', rule_id: 1, severity: 'critical', metric: 'disk', source: 'koebomebsdevapp01', value: 88, threshold: 85, message: 'Disk usage on /prod_backup reached 88%', created_at: new Date(now).toISOString() },
    { id: 'n9', rule_id: null, severity: 'warning', metric: 'memory', source: 'koebomebsdevapp01', message: 'Memory usage above 75% (78.6%)', created_at: new Date(now - 30 * MIN).toISOString() },
    { id: '2:66', rule_id: 2, severity: 'critical', metric: 'cpu', source: 'otherhost', message: 'OTHER HOST ALERT', created_at: new Date(now).toISOString() }]];
  if (p.endsWith('/agents')) return [200, [{ name: 'koebomebsdevapp01', hostname: 'koebomebsdevapp01', agent_version: '2.4.1' }]];
  return [200, {}];
}

const profile = mkdtempSync(join(process.env.TMP || tmpdir(), 'ov-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1660,1000', 'about:blank'], { stdio: 'ignore' });
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1660, height: h, deviceScaleFactor: 1, mobile: false }); await sleep(500);
  const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, n), Buffer.from(s.result.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 1660, height: 1000, deviceScaleFactor: 1, mobile: false });
};
let passed = 0; let failed = 0;
const ok = (c, msg) => { if (c) { passed++; console.log('  PASS ', msg); } else { failed++; console.log('  FAIL ', msg); } };
const card = (title) => `[...document.querySelectorAll('section')].find(s => (s.querySelector('h2')?.textContent || '').trim().startsWith(${JSON.stringify(title)}))`;
const arrow = (title) => `document.querySelector('[aria-label="Open all hosts — ${title}"]')`;

await send('Runtime.enable');
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/v1/*' }] });
await send('Emulation.setDeviceMetricsOverride', { width: 1660, height: 1000, deviceScaleFactor: 1, mobile: false });
const payload = Buffer.from(JSON.stringify({ sub: 'qa', exp: Math.floor(now / 1000) + 3600 })).toString('base64url');
await send('Page.navigate', { url: `${ORIGIN}/login` });
await sleep(1500);
await js(`localStorage.setItem('actmon_token', 'x.${payload}.y'); localStorage.setItem('actmon_user', JSON.stringify({ id: 1, username: 'qa', role_id: 1, org_id: 1 })); true`);

console.log('=== overview layout & real values ===');
await send('Page.navigate', { url: `${ORIGIN}/infra/65` });
ok(await waitFor(`${has('koebomebsdevapp01')} && ${has('Ubuntu 22.04.3 LTS')} && ${has('Host ID: 65')} && ${has('IP: 10.0.1.65')} && ${has('Agent: v2.4.1')} && ${has('Uptime: 12 days, 6 hours')}`, 30000), 'header: OS, host id, IP, agent version, uptime');
ok(await waitFor(`/CPU Usage\\s*3\\.7%/.test(document.body.innerText)`), 'CPU card = live 3.7%');
ok(await js(`/Memory Usage\\s*35\\.0%/.test(document.body.innerText)`), 'memory card = live 35.0%');
ok(await js(`/Disk Usage \\(\\/prod_backup\\)\\s*88\\.0%/.test(document.body.innerText)`), 'disk card = fullest real filesystem (/prod_backup 88%)');
ok(await js(`/Network I\\/O\\s*12\\.5 Mbps/.test(document.body.innerText)`), 'network card = rx+tx 12.5 Mbps');
ok(await js(`/Running Processes\\s*245/.test(document.body.innerText) && ${has('1,290 threads')}`), 'running processes 245 + threads');
ok(await js(`/System Uptime\\s*12 days, 6 hours/.test(document.body.innerText) && ${has('Last Boot')}`), 'uptime + last boot');
ok(await waitFor(`document.querySelectorAll('.recharts-area-area').length >= 3`), 'three utilisation charts drawn');
ok(await js(`${has('CPU Utilization')} && ${has('Memory Utilization')} && ${has('Disk Utilization (/prod_backup)')}`), 'chart titles incl. mount');
ok(await waitFor(`(${card('CPU Usage by Core')})?.querySelectorAll('.recharts-bar-rectangle').length === 8`), 'per-core bars (8)');
const memLeg = await js(`(${card('Memory Usage Breakdown')})?.innerText || ''`);
ok(memLeg.includes('Used Memory') && memLeg.includes('Buffers / Cache') && memLeg.includes('Free Memory'), 'memory donut legend');
const dl = await js(`(${card('Disk Usage Breakdown')})?.innerText || ''`);
ok(dl.includes('Used Space') && dl.includes('176.0 GB') && dl.includes('Free Space') && dl.includes('21.0 GB') && dl.includes('Reserved Space') && dl.includes('3.0 GB'), 'disk donut: used/free/reserved = 176/21/3 GB');
ok(await js(`(${card('Recent Alerts')}).innerText.includes('Disk usage on /prod_backup') && !(${card('Recent Alerts')}).innerText.includes('OTHER HOST')`), 'alerts filtered to this host');
ok(await js(`(${card('Recent Alerts')}).innerText.includes('Active now')`), 'rule alert labelled Active now (no invented time)');
const si = await js(`(${card('System Information')})?.innerText || ''`);
ok(['Linux 5.15.0-83-generic', '8 (16 Logical)', '32.0 GB', '230.0 GB', '10.0.1.65', '00:15:5d:20:4f:8a', 'v2.4.1'].every((x) => si.includes(x)), 'system information (tmpfs excluded from disk total, real MAC)');
await js(`document.querySelector('[aria-label="Show all system details"]').click(), true`);
ok(await waitFor(`(${card('System Information')}).innerText.includes('abc123')`), 'expand shows full inventory (Machine ID)');
await shot('overview-1660.png', 1700);

console.log('=== processes ===');
const pt = await js(`(${card('Top Processes by Resource Usage')})?.innerText || ''`);
ok(pt.includes('java') && pt.includes('12.4%') && !pt.includes('cron'), 'CPU tab: top 5 by CPU');
await js(`[...document.querySelectorAll('[role=tab]')].find(b => b.textContent === 'Memory').click(), true`);
ok(await waitFor(`(${card('Top Processes by Resource Usage')}).innerText.includes('4.0 GB') && (${card('Top Processes by Resource Usage')}).querySelector('tbody tr td:nth-child(2)').textContent === 'mysqld'`), 'Memory tab: memory-ranked list (mysqld 4.0 GB first)');
await js(`[...document.querySelectorAll('[role=tab]')].find(b => b.textContent === 'Disk').click(), true`);
ok(await waitFor(`(${card('Top Processes by Resource Usage')}).innerText.includes('Per-process disk I/O is not collected')`), 'Disk tab: honest not-collected state');
await js(`[...document.querySelectorAll('[role=tab]')].find(b => b.textContent === 'CPU').click(), true`);
await js(`[...document.querySelectorAll('button')].find(b => b.textContent === 'View All').click(), true`);
ok(await waitFor(`(${card('Top Processes by Resource Usage')}).innerText.includes('cron')`), 'View All');

console.log('=== time controls & drill-down ===');
let before = calls.length;
await js(`(() => { const s = document.querySelector('select[aria-label="Time range"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, '3'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
await sleep(1200);
const after = calls.slice(before);
ok(after.some((c) => c.includes('/memory/65/history?minutes=360')) && after.some((c) => c.includes('/disk/65/network-history?minutes=360')) && after.some((c) => /metrics\/history.*minutes=720/.test(c)), '6 h range refetches memory, network, CPU history');
before = calls.length;
await js(`document.querySelector('[aria-label="Auto refresh"]').click(), true`);
ok(await js(`document.querySelector('[aria-label="Auto refresh"]').getAttribute('aria-checked') === 'false'`), 'auto refresh toggles off');
const box = await js(`(() => { const r = (${card('Memory Utilization')}).querySelector('.recharts-area-area').getBoundingClientRect(); return { x: r.left + r.width * 0.6, y: r.top + r.height * 0.5 }; })()`);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y }); await sleep(250);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
ok(await waitFor(`(${card('Memory Utilization')}).innerText.includes('Inspect in Memory Consumption')`), 'chart point click shows time + value');
await js(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Inspect in Memory Consumption')).click(), true`);
ok(await waitFor(`location.pathname === '/memory/65' && /range=360/.test(location.search) && /at=\\d+/.test(location.search)`), 'opens Memory Consumption with range + time');
ok(await waitFor(`${has('Memory Consumption - koebomebsdevapp01')} && /Selected .*\\d/.test(document.body.innerText) && document.querySelector('select[aria-label="Time range"]').value === '3'`), 'memory page opens on the same range with that point selected');

console.log('=== other states ===');
await send('Page.navigate', { url: `${ORIGIN}/infra/65/ports` });
ok(await waitFor(`!${has('Top Processes by Resource Usage')} && !document.querySelector('select[aria-label="Time range"]')`), 'other tabs unaffected (no overview controls)');
MODE = 'bare';
await send('Page.navigate', { url: `${ORIGIN}/infra/65` });
ok(await waitFor(`${has('Per-core usage not reported yet')} && ${has('Exact sizes not reported yet')}`, 20000), 'old collector: honest not-reported states, no zeros');
ok(await js(`/Running Processes\\s*N\\/A/.test(document.body.innerText)`), 'process count N/A when not collected');
MODE = 'histerr';
await send('Page.navigate', { url: `${ORIGIN}/infra/65` });
ok(await waitFor(`(${card('Memory Utilization')})?.innerText.includes('History could not be loaded')`, 20000), 'history failure shown as an error');
MODE = 'ok';
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
await send('Page.navigate', { url: `${ORIGIN}/infra/65` });
await waitFor(`document.querySelectorAll('.recharts-area-area').length >= 3`, 20000);
await sleep(600);
ok(await js(`document.documentElement.scrollWidth <= window.innerWidth + 1`), 'phone width: no horizontal page scroll');

ok(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 3).join(' | ')})`);
console.log(`\n${passed} passed, ${failed} failed`);
chrome.kill();
process.exit(failed ? 1 : 0);
