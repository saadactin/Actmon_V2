/* CPU Performance page, in the REAL app (router, auth guard, layout) with the API answered from fixtures by
   intercepting requests in Chrome. Nothing touches a database.
     cd frontend && npx vite --port 2106          (terminal 1)
     node src/pages/__cpucheck__/cpu.mjs <outDir> */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = process.env.APP_URL || 'http://localhost:2106';
const OUT = process.argv[2] || 'cpushots';
const PORT = 9481;
mkdirSync(OUT, { recursive: true });

const H = (id, name, os, status, cpu, ram, disk) => ({ id, server_name: name, hostname: name.toLowerCase(), ip_address: `10.0.0.${id}`, os_type: os,
  environment: 'Production', database_services: [], status, db_status: 'Unknown', collector: 'agent', db_instances: [], cpu_usage: cpu, ram_usage: ram, disk_usage: disk });
const HOSTS = [H(50, 'ACTIN-CS-16', 'Windows', 'Connected', '92%', '64%', '62%'), H(51, 'koebomebstestdb', 'Linux', 'Connected', '61%', '72%', '93%')];
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');           // ClickHouse UTC format
// 2 h of 1-minute samples (the page asks for 2x the 1 h window): a spike 30-25 min ago, the rest 20-40 %
const SERIES = {
  'ACTIN-CS-16': Array.from({ length: 120 }, (_, i) => ({ ts: iso(now - (i + 1) * 60_000), host_cpu: i >= 25 && i <= 30 ? 80 + (i % 3) * 5 : 20 + (i % 10) * 2, kind: 'infra', tech: 'host' })),
  koebomebstestdb: Array.from({ length: 60 }, (_, i) => ({ ts: iso(now - (i + 1) * 60_000), host_cpu: 33, kind: 'infra', tech: 'host' })),
};
let HIST_MODE = 'ok';   // ok | empty | error
const calls = [];

function answer(url) {
  const u = new URL(url);
  const p = u.pathname.replace(/\/+$/, '');
  calls.push(p);
  if (p.endsWith('/os-servers')) return [200, { status: 'success', data: HOSTS }];
  if (p.endsWith('/os-servers/summary')) return [200, { total: 2, connected: 2, warning: 0, disconnected: 0 }];
  if (p.endsWith('/os-servers/live-status')) return [200, { status: 'success', data: [] }];
  const one = p.match(/\/os-servers\/(\d+)$/);
  if (one) {
    const h = HOSTS.find((x) => x.id === Number(one[1]));
    return h ? [200, { status: 'success', data: { ...h, last_infra_at: new Date(now - 60_000).toISOString() } }] : [404, { detail: 'Server not found' }];
  }
  const det = p.match(/\/os-servers\/(\d+)\/infra-detail$/);
  if (det) {
    const h = HOSTS.find((x) => x.id === Number(det[1]));
    const procs = h.id === 50
      ? [{ pid: '4820', user: '', cpu: '48', mem: '10.1', command: 'sqlservr', threads: 64 }, { pid: '6156', user: '', cpu: '18', mem: '3.4', command: 'w3wp', threads: 31 }, { pid: '3320', user: '', cpu: '8', mem: '1.6', command: 'actmon-agent', threads: 9 }, { pid: '900', user: '', cpu: '4', mem: '1', command: 'svchost', threads: 12, instances: 40 }, { pid: '777', user: '', cpu: '2', mem: '1', command: 'chrome', threads: 20 }, { pid: '778', user: '', cpu: '1', mem: '1', command: 'notepad', threads: 3 }]
      : [{ pid: '911', user: 'oracle', cpu: '22', mem: '30', command: 'ora_pmon', threads: 1, running_s: 3600 }];
    const cd = h.id === 50
      ? { model: 'Intel(R) Xeon(R) Gold 6248R CPU @ 3.00GHz', max_mhz: 2993, sockets: 1, physical_cores: 8, logical: 16, per_core: Array.from({ length: 16 }, (_, i) => ({ id: String(i), pct: 10 + i * 5 })), user_pct: 70.1, privileged_pct: 20.2, interrupt_pct: 1.1, dpc_pct: 0.7, context_switches_per_s: 12432, interrupts_per_s: 8800, dpcs_per_s: 3512, sample_s: 1 }
      : { model: 'AMD EPYC 7763 64-Core Processor', max_mhz: null, sockets: 1, physical_cores: 1, logical: 2, per_core: [{ id: 0, pct: 60 }, { id: 1, pct: 62 }], user_pct: 40, system_pct: 13.3, iowait_pct: 6.7, irq_pct: 0, steal_pct: 0, idle_pct: 40, context_switches_per_s: 2000, interrupts_per_s: 600, runnable_tasks: 3, sample_s: 0.5 };
    const procsNow = h.id === 51 ? [{ pid: 911, cpu: 30, cpu_user: 24, cpu_kernel: 6, ppid: 1, user: 'oracle', mem: 30, threads: 1, running_s: 3600, command: 'ora_pmon_kcdb1' },
      { pid: 912, cpu: 10, cpu_user: 8, cpu_kernel: 2, ppid: 1, user: 'oracle', mem: 2, threads: 1, running_s: 3600, command: 'ora_dbw0_kcdb1' },
      { pid: 990, cpu: 6, cpu_user: 4, cpu_kernel: 2, ppid: 911, user: 'oracle', mem: 1, threads: 1, running_s: 60, command: 'oracle_990_kc' }] : undefined;
    return [200, { status: 'success', procs_now: procsNow, host: { server_name: h.server_name, os_type: h.os_type }, cpu_pct: parseFloat(h.cpu_usage), system: { os: h.os_type === 'Windows' ? 'Windows Server 2019' : 'Oracle Linux 8' }, uptime: 'up 15 days', processes: procs, cpu_detail: cd, memory: { total_mb: 65536 }, queue_length: h.id === 50 ? 3 : undefined, load: h.id === 51 ? { one: 1.21, five: 0.98, fifteen: 0.75 } : undefined, poll_interval_s: 15 }];
  }
  const hist = p.match(/\/metrics\/history\/(.+)$/);
  if (hist) {
    if (HIST_MODE === 'error') return [500, { detail: 'ClickHouse unavailable' }];
    return [200, { agent: decodeURIComponent(hist[1]), source: 'clickhouse', samples: HIST_MODE === 'empty' ? [] : SERIES[decodeURIComponent(hist[1])] || [] }];
  }
  const cat = p.match(/\/cpu\/(\d+)\/categories$/);
  if (cat) return [200, { samples: Array.from({ length: 30 }, (_, i) => ({ t: now - (30 - i) * 60_000, user: 30 + (i % 5), system: 10, iowait: 5, irq: 1, steal: 0, idle: 54 - (i % 5), busy: 46 })) }];
  const pat = p.match(/\/cpu\/(\d+)\/processes$/);
  if (pat) { const at = Number(u.searchParams.get('at')); return [200, { ts: at, processes: [{ pid: 4242, name: 'stored_proc', cpu_pct: 33.3, mem_pct: 2, threads: 7, user_name: 'svc', running_s: 900 }] }]; }
  if (/\/cpu\/\d+\/process-detail$/.test(p)) return [200, { exists: true, platform: 'linux', via: 'agent', full_access: false, ppid: 1, exe: '/usr/bin/stored_proc', cwd: '/opt/app', cpu_time_s: 3725.5, cpu_user_s: 3000, cpu_kernel_s: 725.5, start_time_epoch: now / 1000 - 900, state: 'S (sleeping)', threads: 7, context_switches: 12345, ctx_voluntary: 12000, ctx_involuntary: 345, nice: 0, command_line: '/usr/bin/stored_proc --password=****** --port 9000', command_masked: true, open_files_count: 42 }];
  const ptr = p.match(/\/cpu\/(\d+)\/process-trend$/);
  if (ptr) return [200, { samples: Array.from({ length: 20 }, (_, i) => ({ t: now - (20 - i) * 60_000, cpu: 20 + i, mem: 10 })) }];
  if (p.endsWith('/alerts/active')) return [200, []];
  if (p.endsWith('/agents')) return [200, [{ name: 'ACTIN-CS-16', hostname: 'actin-cs-16', agent_version: '1.4.2', status: 'online' }]];
  if (p.endsWith('/cloud/accounts')) return [200, []];
  return [200, {}];
}

const profile = mkdtempSync(join(process.env.TMP || tmpdir(), 'cpu-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1920,1080', 'about:blank'], { stdio: 'ignore' });
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
const shot = async (n) => { const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, n), Buffer.from(s.result.data, 'base64')); };
let passed = 0; let failed = 0;
const ok = (c, msg) => { if (c) { passed++; console.log('  PASS ', msg); } else { failed++; console.log('  FAIL ', msg); } };
const card = (title) => `[...document.querySelectorAll('section')].find(s => s.querySelector('h2')?.textContent.trim().startsWith(${JSON.stringify(title)}))`;

await send('Runtime.enable');
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/v1/*' }] });
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
const payload = Buffer.from(JSON.stringify({ sub: 'qa', exp: Math.floor(now / 1000) + 3600 })).toString('base64url');
await send('Page.navigate', { url: `${ORIGIN}/login` });
await sleep(1500);
await js(`localStorage.setItem('actmon_token', 'x.${payload}.y'); localStorage.setItem('actmon_user', JSON.stringify({ id: 1, username: 'qa', role_id: 1, org_id: 1 })); true`);

console.log('=== dashboard → CPU Performance ===');
await send('Page.navigate', { url: `${ORIGIN}/dashboard` });
ok(await waitFor(`${has('Top CPU Hosts')} && !!(${card('Top CPU Hosts')})?.querySelector('tbody button')`, 30000), 'dashboard shows Top CPU Hosts');
await js(`(${card('Top CPU Hosts')}).querySelector('tbody button').click(), true`);
ok(await waitFor(`location.pathname === '/cpu-performance/50'`), 'first CPU host opens /cpu-performance/50 directly');
ok(!(await js(`location.pathname.startsWith('/infra')`)), 'not the Infrastructure overview');
ok(await waitFor(`${has('CPU Performance')} && ${has('ACTIN-CS-16')} && ${has('Windows Server 2019')} && ${has('Agent v1.4.2')}`), 'header + host card: name, OS, agent version');
ok(await waitFor(`${has("Intel(R) Xeon(R) Gold 6248R CPU @ 3.00GHz")} && ${has("2.99 GHz • 8 Cores • 16 Threads • 64.0 GB RAM")}`), 'CPU model card from cpu_detail + memory');
ok(await waitFor(`!!document.querySelector('.recharts-area-area')`), 'CPU trend drawn from history samples');
ok(await js(has('92.0%')), 'current CPU = live reading from infra-detail (92)');
const avg = await js(`(() => { const t = document.body.innerText; const m = t.match(/Average CPU Usage\\s*([\\d.]+)%/); return m && Number(m[1]); })()`);
const exp = (() => { const pts = SERIES['ACTIN-CS-16'].slice(0, 60).map((s) => s.host_cpu); return pts.reduce((a, b) => a + b, 0) / pts.length; })();
console.log('  average shown', avg, 'expected about', exp.toFixed(1));
ok(avg != null && Math.abs(avg - exp) < 1.6, 'average computed from the 1 h of samples (±1 sample at the window edge)');
ok(await js(has('Peak CPU Usage')) && await js(`/Peak CPU Usage\\s*90\\.0%/.test(document.body.innerText)`), 'peak = 90.0% (the highest fixture sample)');
ok(await js(`/Logical Processors\\s*16/.test(document.body.innerText) && ${has('8 Physical Cores')}`), 'logical processors / physical cores from cpu_detail');
ok(await js(`/Processor Queue\\s*3/.test(document.body.innerText)`) && !(await js(has('Load Average'))), 'Windows shows processor queue, not a fake load average');
ok(await waitFor(`(${card('CPU Usage by Core')})?.querySelectorAll('.recharts-bar-rectangle').length === 16`), 'per-core chart: 16 bars');
ok(await js(`${has('Context Switches/sec')} && ${has('12,432')} && ${has('DPCs Queued/sec')}`), 'CPU metrics table (Windows counters)');
ok(await waitFor(`(() => { const c = document.querySelector('[aria-label="CPU Usage by Process Category"]'); return c && c.innerText.includes('User Processes') && c.innerText.includes('Interrupts') && c.innerText.includes('Idle') && !!c.querySelector('.recharts-pie'); })()`), 'Windows category donut: real CPU time split (User / Kernel / Interrupts / Idle)');
ok(await waitFor(`!!document.querySelector('[aria-label="CPU Usage by Process Category"] .recharts-area-area')`), 'CPU Usage Trend by Category drawn from stored history');
ok(await js(has('sqlservr') && has('w3wp')) && !(await js(has('notepad'))), 'process table: top 5 of the latest snapshot');
await js(`[...document.querySelectorAll('button')].find(b => b.textContent === 'View All').click(), true`);
ok(await waitFor(has('notepad')), 'View All shows every process');
await shot('cpu-1920.png');

console.log('=== graph point → selected time ===');
const box = await js(`(() => { const r = document.querySelector('.recharts-area-area').getBoundingClientRect(); return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 }; })()`);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
await sleep(200);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
ok(await waitFor(`/Selected .*· [\\d.]+%/.test(document.body.innerText)`), 'clicking the graph selects a point (timestamp + CPU shown)');
const tbl = await js(`(${card('Top CPU Consuming Processes')})?.innerText || ''`);
ok(await waitFor(`(${card('Top CPU Consuming Processes')})?.innerText.includes('stored_proc') && (${card('Top CPU Consuming Processes')}).innerText.includes('Stored at')`), 'selected point shows the processes STORED at that time');
console.log('=== process drawer ===');
await js(`[...document.querySelectorAll('tbody tr')].find(r => r.innerText.includes('stored_proc')).click(), true`);
ok(await waitFor(`${has('Process Details')} && ${has('PID 4242')} && ${has('CPU and Memory Trend')} && ${has('Process Information')} && ${has('Available Diagnostics')}`), 'clicking a process opens the details drawer');
ok(await waitFor(`${has('/usr/bin/stored_proc')} && ${has('/opt/app')} && ${has('12,345')} && ${has('kernel')} && ${has('Open Files')} && ${has('42')}`), 'live details: parent PID, executable, cwd, CPU time, context switches, open files');
await js(`[...document.querySelectorAll('button')].find(b => b.textContent === 'View command line').click(), true`);
ok(await waitFor(`${has('--password=******')} && ${has('needs the Infrastructure')}`), 'command line shown masked, with the permission note');
await js(`[...document.querySelectorAll('button')].find(b => b.textContent.startsWith('View open files')).click(), true`);
ok(await waitFor(has('The list of paths needs the Infrastructure')), 'open files: count for everyone, list needs Execute');
ok(await waitFor(`!!document.querySelector('[role=dialog] .recharts-area-area')`), 'process CPU/memory trend drawn from stored history');
ok(await js(`!![...document.querySelectorAll('tbody tr')].find(r => r.getAttribute('aria-selected') === 'true')`), 'selected row stays highlighted');
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
ok(await waitFor(`!document.querySelector('[role=dialog]')`), 'Escape closes the drawer');
await shot('cpu-selected.png');

console.log('=== second host is its own data ===');
await send('Page.navigate', { url: `${ORIGIN}/dashboard` });
await waitFor(`!!(${card('Top CPU Hosts')})?.querySelectorAll('tbody button')[1]`, 30000);
await js(`(${card('Top CPU Hosts')}).querySelectorAll('tbody button')[1].click(), true`);
ok(await waitFor(`location.pathname === '/cpu-performance/51'`), 'second host opens /cpu-performance/51');
ok(await waitFor(has('koebomebstestdb') && has('ora_pmon')) && !(await js(has('sqlservr'))), 'shows the second host\'s processes, none of the first host\'s');
ok(await waitFor(`/Average CPU Usage\\s*33\\.0%/.test(document.body.innerText)`), 'average from the second host\'s own samples (33.0%)');
ok(await js(`/Load Average\\s*1\\.21/.test(document.body.innerText)`), 'Linux shows load average 1/5/15');
ok(await waitFor(`(() => { const c = document.querySelector('[aria-label="CPU Usage by Process Category"]'); return c && c.innerText.includes('I/O Wait') && c.innerText.includes('40%') && c.innerText.includes('60%') && !c.innerText.includes('Demo Data'.toUpperCase()) ; })()`), 'Linux category donut: real split from /proc/stat (user 40%, 60% in use)');
ok(!(await js(has('Demo Data'))), 'no Demo Data mode');
await js(`[...document.querySelectorAll('[aria-label="CPU Usage by Process Category"] tbody tr')].find(r => r.innerText.includes('User Processes')).click(), true`);
ok(await waitFor(`(() => { const c = document.querySelector('[aria-label="CPU Usage by Process Category"]'); return c.innerText.includes('All categories') && c.innerText.includes('ora_pmon_kcdb1') && c.innerText.includes('24.0%') && c.innerText.includes('Other processes'); })()`), 'User Processes drill: each process user time (ora_pmon 24.0%) + unexplained remainder');
await js(`[...document.querySelectorAll('[aria-label="CPU Usage by Process Category"] [role=radio]')].find(b => b.textContent === 'By program').click(), true`);
ok(await waitFor(`document.querySelector('[aria-label="CPU Usage by Process Category"]').innerText.includes('Oracle background processes (kcdb1)')`), 'group by program: Oracle background processes (kcdb1)');
await js(`[...document.querySelectorAll('[aria-label="CPU Usage by Process Category"] [role=radio]')].find(b => b.textContent === 'By parent').click(), true`);
ok(await waitFor(`(() => { const t = document.querySelector('[aria-label="CPU Usage by Process Category"]').innerText; return t.includes('ora_pmon_kcdb1 (PID 911)') && t.includes('Started by init'); })()`), 'group by parent: children under ora_pmon (PID 911)');
await shot('cpu-drill.png', 1300);
await js(`[...document.querySelectorAll('[aria-label="CPU Usage by Process Category"] li button')].find(b => b.innerText.includes('oracle_990_kc')).click(), true`);
ok(await waitFor(`${has('Process Details')} && ${has('PID 990')}`), 'process in the drill opens its details');
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await waitFor(`!document.querySelector('[role=dialog]')`);
await js(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('All categories')).click(), true`);
await js(`[...document.querySelectorAll('[aria-label="CPU Usage by Process Category"] tbody tr')].find(r => r.innerText.includes('I/O Wait')).click(), true`);
ok(await waitFor(`document.querySelector('[aria-label="CPU Usage by Process Category"]').innerText.includes('belongs to no process')`), 'I/O Wait drill explains it is not owned by a process');
ok(await js(has('I/O Wait') && has('Runnable Tasks')), 'Linux CPU metrics table');
await shot('cpu-linux.png');

console.log('=== memory card opens the Memory page ===');
await send('Page.navigate', { url: `${ORIGIN}/dashboard` });
await waitFor(`!!(${card('Top Memory Hosts')})?.querySelector('tbody button')`, 30000);
await js(`(${card('Top Memory Hosts')}).querySelector('tbody button').click(), true`);
ok(await waitFor(`location.pathname.startsWith('/memory/')`), 'Top Memory Hosts opens the Memory page (/memory/:id)');

console.log('=== edge states ===');
await send('Page.navigate', { url: `${ORIGIN}/cpu-performance/999` });
ok(await waitFor(has('Host not found')), 'unknown / other-org host id: Host not found');
ok(!calls.some((c) => c.includes('/os-servers/999/infra-detail')), 'nothing else is fetched for a host that is not found');
await send('Page.navigate', { url: `${ORIGIN}/cpu-performance/abc` });
ok(await waitFor(has('Invalid host id')), 'invalid id');
HIST_MODE = 'empty';
await send('Page.navigate', { url: `${ORIGIN}/cpu-performance/50` });
ok(await waitFor(has('No CPU samples in this range')), 'empty history: no-data state (no fake zeros)');
ok(await js(`/Average CPU Usage\\s*N\\/A/.test(document.body.innerText)`), 'average shows N/A when there are no samples');
HIST_MODE = 'error';
await send('Page.navigate', { url: `${ORIGIN}/cpu-performance/50` });
ok(await waitFor(has('CPU history could not be loaded'), 20000), 'history API error shown clearly');
HIST_MODE = 'ok';

ok(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`);
console.log(`\n${passed} passed, ${failed} failed`);
chrome.kill();
process.exit(failed ? 1 : 0);
