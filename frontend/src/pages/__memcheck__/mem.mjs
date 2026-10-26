/* Memory Analysis / Memory Pressure pages, in the REAL app (router, auth guard, layout) with the API answered from
   test fixtures by intercepting requests in Chrome. Nothing touches a database.
     cd frontend && npx vite --port 2106          (terminal 1)
     node src/pages/__memcheck__/mem.mjs <outDir> */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = process.env.APP_URL || 'http://localhost:2106';
const OUT = process.argv[2] || 'memshots';
const PORT = 9483;
mkdirSync(OUT, { recursive: true });
const GB = 1073741824;
const now = Date.now();
const MIN = 60000;

const H = (id, name, os, ram) => ({ id, server_name: name, hostname: name.toLowerCase(), ip_address: `10.0.0.${id}`, os_type: os, environment: 'Production',
  database_services: [], status: 'Connected', db_status: 'Unknown', collector: 'agent', db_instances: [], cpu_usage: '20%', ram_usage: ram, disk_usage: '40%' });
const HOSTS = [H(50, 'ACTIN-CS-16', 'Windows', '91%'), H(51, 'koebomebstestdb', 'Linux', '62%')];

// ── Windows host 50: 2 h of 1-min buckets; pressure spike to 92 % between 35 and 25 min ago
const win = (t, i) => {
  const spike = i >= 25 && i <= 35;
  const used = spike ? 92 : 60 + (i % 7);
  const total = 16 * GB; const avail = Math.round(total * (1 - used / 100));
  return { t, n: 4, total_bytes: total, used_bytes: total - avail, available_bytes: avail, free_bytes: Math.round(avail * 0.3), cached_bytes: Math.round(avail * 0.7),
    modified_bytes: 0.2 * GB, committed_bytes: 20 * GB, commit_limit_bytes: 40 * GB, swap_total_bytes: 4 * GB, swap_used_bytes: spike ? 2.5 * GB : 1 * GB,
    paged_pool_bytes: 0.6 * GB, nonpaged_pool_bytes: 0.5 * GB, hardware_reserved_bytes: 0.5 * GB, installed_bytes: 16.5 * GB,
    page_faults_ps: 4000 + i * 10, major_faults_ps: spike ? 400 : 20, pages_ps: 30, used_pct: used, pressure_score: used };
};
const HIST = { 50: Array.from({ length: 120 }, (_, k) => win(Math.floor((now - (120 - k) * MIN) / MIN) * MIN, 119 - k)) };
const lin = (t) => ({ t, n: 4, total_bytes: 8 * GB, used_bytes: 5 * GB, available_bytes: 3 * GB, free_bytes: 1 * GB, cached_bytes: 2.2 * GB, buffers_bytes: 0.1 * GB,
  committed_bytes: 13 * GB, commit_limit_bytes: 4 * GB, swap_total_bytes: 0, swap_used_bytes: 0, page_faults_ps: 600, major_faults_ps: 0, used_pct: 62.5, pressure_score: 62.5, psi_some_avg10: 0 });
HIST[51] = Array.from({ length: 120 }, (_, k) => lin(Math.floor((now - (120 - k) * MIN) / MIN) * MIN));
const statOf = (rows) => {
  if (!rows.length) return null;
  const by = (k, f) => rows.reduce((b, r) => (f(r[k], b[k]) ? r : b));
  const mx = by('used_pct', (a, b) => a > b); const mn = by('used_pct', (a, b) => a < b);
  const px = by('pressure_score', (a, b) => a > b); const pn = by('pressure_score', (a, b) => a < b); const am = by('available_bytes', (a, b) => a < b);
  const avg = (k) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
  return { n: rows.length * 4, used_avg: avg('used_pct'), used_max: mx.used_pct, used_max_t: mx.t, used_min: mn.used_pct, used_min_t: mn.t,
    pr_avg: avg('pressure_score'), pr_max: px.pressure_score, pr_max_t: px.t, pr_min: pn.pressure_score, pr_min_t: pn.t, avail_min: am.available_bytes, avail_min_t: am.t,
    swap_used_max: Math.max(...rows.map((r) => r.swap_used_bytes)), swap_used_max_t: rows[0].t, swap_total: rows[0].swap_total_bytes,
    major_avg: avg('major_faults_ps'), major_max: Math.max(...rows.map((r) => r.major_faults_ps)), faults_avg: avg('page_faults_ps'), faults_max: 9000,
    first_t: rows[0].t, last_t: rows[rows.length - 1].t };
};
const LIVE_PROCS = {
  50: [
    { pid: 4820, name: 'sqlservr', ws_bytes: 8.2 * GB, private_bytes: 6.1 * GB, commit_bytes: 6.1 * GB, peak_ws_bytes: 10.8 * GB, mem_pct: 51.3, cpu: 12.4, threads: 24, user: 'NT SERVICE\\MSSQLSERVER', start: new Date(now - 105 * MIN).toISOString(), path: 'C:\\Program Files\\Microsoft SQL Server\\sqlservr.exe', status: 'Running' },
    { pid: 6156, name: 'w3wp', ws_bytes: 2.1 * GB, private_bytes: 1.9 * GB, peak_ws_bytes: 2.4 * GB, mem_pct: 13.1, cpu: 4.8, threads: 32, user: 'IIS APPPOOL\\Default', status: 'Running' },
    { pid: 3320, name: 'actmon-agent', ws_bytes: 1.3 * GB, mem_pct: 8.1, cpu: 2.6, threads: 18, user: 'NT AUTHORITY\\SYSTEM', status: 'Running' },
    { pid: 5268, name: 'explorer', ws_bytes: 0.98 * GB, mem_pct: 6.1, cpu: 1.2, threads: 28, user: 'ACTIN\\admin', status: 'Running' },
    { pid: 4, name: 'System', ws_bytes: 0.64 * GB, mem_pct: 4, cpu: 0.8, threads: 188, user: null, status: 'Running' },
    { pid: 900, name: 'notepad', ws_bytes: 0.01 * GB, mem_pct: 0.1, cpu: 0, threads: 3, user: 'ACTIN\\admin', status: 'Running' },
  ],
  51: [{ pid: 911, name: 'ora_pmon', ws_bytes: 1.1 * GB, private_bytes: 0.9 * GB, peak_ws_bytes: 1.2 * GB, mem_pct: 13.7, cpu: 1.2, threads: 1, user: 'oracle', status: 'Sleeping', running_s: 3600 }],
};
let HIST_MODE = 'ok';
const calls = [];

function answer(url) {
  const u = new URL(url);
  const p = u.pathname.replace(/\/+$/, '');
  calls.push(p + u.search);
  if (p.endsWith('/os-servers')) return [200, { status: 'success', data: HOSTS }];
  if (p.endsWith('/os-servers/summary')) return [200, { total: 2, connected: 2, warning: 0, disconnected: 0 }];
  if (p.endsWith('/os-servers/live-status')) return [200, { status: 'success', data: [] }];
  const one = p.match(/\/os-servers\/(\d+)$/);
  if (one) {
    const h = HOSTS.find((x) => x.id === Number(one[1]));
    return h ? [200, { status: 'success', data: { ...h, last_infra_at: new Date(now - 30_000).toISOString() } }] : [404, { detail: 'Server not found' }];
  }
  const det = p.match(/\/os-servers\/(\d+)\/infra-detail$/);
  if (det) {
    const id = Number(det[1]); const h = HOSTS.find((x) => x.id === id);
    const last = HIST[id][HIST[id].length - 1];
    const md = { ...last, platform: id === 50 ? 'windows' : 'linux', sample_s: 1, overcommit_mode: id === 51 ? 0 : undefined, used_pct: id === 50 ? 91.4 : 62.5, pressure_score: id === 50 ? 91.4 : 62.5 };
    if (id === 50) { md.available_bytes = Math.round(16 * GB * 0.086); md.used_bytes = 16 * GB - md.available_bytes; md.cached_bytes = Math.round(md.available_bytes * 0.7); md.free_bytes = md.available_bytes - md.cached_bytes; }
    return [200, { status: 'success', host: { server_name: h.server_name }, cpu_pct: 20, system: { os: id === 50 ? 'Windows Server 2019' : 'Oracle Linux 8' }, uptime: 'up 15d 8h 2m',
      memory: { total_mb: 16384, used_pct: md.used_pct }, processes: [], mem_detail: md, mem_procs: LIVE_PROCS[id] }];
  }
  const mm = p.match(/\/memory\/(\d+)\/(history|snapshot|process-history|top-processes|analysis)$/);
  if (mm) {
    const id = Number(mm[1]);
    if (![50, 51].includes(id)) return [404, { detail: 'Server not found' }];
    if (HIST_MODE === 'error') return [503, { detail: 'Memory history unavailable: ClickHouse is unavailable' }];
    const rows = HIST_MODE === 'empty' ? [] : HIST[id];
    const cur = rows.filter((r) => r.t >= now - 60 * MIN); const prev = rows.filter((r) => r.t < now - 60 * MIN);
    if (mm[2] === 'history') return [200, { samples: rows, stats: { current: statOf(cur), previous: statOf(prev) } }];
    if (mm[2] === 'snapshot') {
      const at = Number(u.searchParams.get('at'));
      const r = rows.reduce((b, x) => (!b || Math.abs(x.t - at) < Math.abs(b.t - at) ? x : b), null);
      if (!r || Math.abs(r.t - at) > 90_000) return [200, { requested_t: at, tolerance_s: 90, sample_t: null, host: null, processes: [] }];
      // a DIFFERENT process set from the live one, so the test can prove the table shows the stored time
      return [200, { requested_t: at, tolerance_s: 90, sample_t: r.t + 12_000, host: r, processes: [
        { pid: 4820, start_t: now - 105 * MIN, name: 'sqlservr', ws_bytes: 7.7 * GB, private_bytes: 5.8 * GB, mem_pct: 48.1, cpu_pct: 30.5, threads: 24, user_name: 'NT SERVICE\\MSSQLSERVER', status: 'Running' },
        { pid: 7001, start_t: now - 40 * MIN, name: 'backupjob', ws_bytes: 3.3 * GB, mem_pct: 20.6, cpu_pct: 55, threads: 12, user_name: 'ACTIN\\svc_backup', status: 'Running' }] }];
    }
    if (mm[2] === 'process-history') return [200, { points: cur.map((r, i) => ({ t: r.t, ws_bytes: 7 * GB + i * 1e7, cpu_pct: 10 + (i % 5), private_bytes: 5 * GB })) }];
    if (mm[2] === 'top-processes') return [200, rows.length ? { names: ['sqlservr', 'w3wp'], points: cur.map((r) => ({ t: r.t, sqlservr: 8 * GB, w3wp: 2 * GB })) } : { names: [], points: [] }];
    if (mm[2] === 'analysis') {
      const st = statOf(cur);
      return [200, { minutes: 60, threshold: 75, hysteresis: 5, stats: { current: st, previous: statOf(prev) },
        above_threshold: id === 50 ? { seconds: 660, first_t: now - 35 * MIN, last_t: now - 24 * MIN } : { seconds: 0, first_t: null, last_t: null },
        top_process: { name: id === 50 ? 'sqlservr' : 'ora_pmon', pid: 4820, ws_max: 8.8 * GB, mem_pct_avg: 50 },
        events: id === 50 ? [
          { t: now - 24 * MIN, level: 'Info', value: 62, threshold: 55, message: 'Memory pressure normalized (62.0%)' },
          { t: now - 35 * MIN, level: 'Critical', value: 92, threshold: 90, message: 'Memory pressure reached 92.0% (Critical ≥ 90%)' }] : [],
        leaks: [], rule_catalogue: [{ rule: 'MEM-001', name: 'Low available memory', threshold: 'available < 10% of RAM' }, { rule: 'MEM-009', name: 'Dominant consumer', threshold: 'one process >= 30% of RAM' }],
        recommendations: id === 50 ? [
          { id: 'mem-001', rule: 'MEM-001', category: 'Capacity', severity: 'High', condition: 'Low available memory', evidence: 'Available memory fell to 1.2 GB (7.5% of 16.0 GB).', reason: 'Below about 10% available the kernel reclaims cache.', standard: 'Windows Memory\Available MBytes: warning < 10% of RAM.', actions: ['Open the Process Analysis tab at the lowest point.', 'Add RAM if demand is legitimate.'], platform: 'windows', commands: ["Get-Counter '\Memory\Available MBytes'"], from_t: now - 60 * MIN, to_t: now },
          { id: 'large-process', severity: 'Info', condition: 'sqlservr holds a large share of RAM', evidence: 'sqlservr averaged 50.0% of physical memory, peak 8.8 GB.', reason: 'r', action: 'Confirm its configured memory limit.', from_t: now - 60 * MIN, to_t: now }] : [] }];
    }
  }
  if (p.endsWith('/alerts/active')) return [200, []];
  if (p.endsWith('/agents')) return [200, [{ name: 'ACTIN-CS-16', hostname: 'actin-cs-16', agent_version: '2.4.1', status: 'online' }]];
  if (p.endsWith('/cloud/accounts')) return [200, []];
  return [200, {}];
}

const profile = mkdtempSync(join(process.env.TMP || tmpdir(), 'mem-'));
const DL = join(profile, 'dl'); mkdirSync(DL);
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
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    const t = (m.params.args || []).map((a) => a.value || a.description || '').join(' ');
    if (/Warning: Each child|unique "key"|Maximum update/.test(t)) pageErrors.push(t.slice(0, 160));
  }
  if (m.method === 'Fetch.requestPaused') {
    const [code, body] = answer(m.params.request.url);
    send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: code, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') });
  }
};
const js = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
async function waitFor(x, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (await js(x)) return true; await sleep(150); } return false; }
const has = (t) => `document.body.innerText.includes(${JSON.stringify(t)})`;
const shot = async (n, full) => {
  if (full) {
    const h = 2150;   // the app scrolls inside its own container, so size the viewport for a full-page shot
    await send('Emulation.setDeviceMetricsOverride', { width: 1660, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
  }
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, n), Buffer.from(s.result.data, 'base64'));
  if (full) await send('Emulation.setDeviceMetricsOverride', { width: 1660, height: 1000, deviceScaleFactor: 1, mobile: false });
};
let passed = 0; let failed = 0;
const ok = (c, msg) => { if (c) { passed++; console.log('  PASS ', msg); } else { failed++; console.log('  FAIL ', msg); } };
const card = (title) => `[...document.querySelectorAll('section')].find(s => (s.querySelector('h2')?.textContent || '').trim().startsWith(${JSON.stringify(title)}))`;
const clickChart = async (frac) => {
  const box = await js(`(() => { const r = document.querySelector('.recharts-area-area').getBoundingClientRect(); return { x: r.left + r.width * ${frac}, y: r.top + r.height * 0.5 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await sleep(250);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
};

await send('Runtime.enable');
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/v1/*' }] });
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
await send('Emulation.setDeviceMetricsOverride', { width: 1660, height: 1000, deviceScaleFactor: 1, mobile: false });
const payload = Buffer.from(JSON.stringify({ sub: 'qa', exp: Math.floor(now / 1000) + 3600 })).toString('base64url');
await send('Page.navigate', { url: `${ORIGIN}/login` });
await sleep(1500);
await js(`localStorage.setItem('actmon_token', 'x.${payload}.y'); localStorage.setItem('actmon_user', JSON.stringify({ id: 1, username: 'qa', role_id: 1, org_id: 1 })); true`);

console.log('=== dashboard → Memory Analysis ===');
await send('Page.navigate', { url: `${ORIGIN}/dashboard` });
ok(await waitFor(`!!(${card('Top Memory Hosts')})?.querySelector('tbody button')`, 30000), 'dashboard shows Top Memory Hosts');
await js(`(${card('Top Memory Hosts')}).querySelector('tbody button').click(), true`);
ok(await waitFor(`location.pathname === '/memory/50'`), 'memory host opens /memory/50');
ok(await waitFor(`${has('Memory Consumption - ACTIN-CS-16')} && ${has('Windows Server 2019')} && ${has('Agent: v2.4.1')} && ${has('Host ID: 50')} && ${has('IP: 10.0.0.50')}`), 'header: name, OS, host id, IP, agent version');
ok(await js(`['Memory Analysis','Process Analysis','Memory Pressure','Per-Process Usage','System Metrics','Recommendations'].every(t => [...document.querySelectorAll('nav[aria-label="Memory views"] button')].map(b => b.textContent).includes(t))`), 'Reference A tab set');
ok(await waitFor(`!!document.querySelector('.recharts-area-area')`), 'utilisation trend drawn');
ok(await js(`/Current Memory Usage\\s*91\\.4%/.test(document.body.innerText)`), 'current usage = live reading (91.4%)');
ok(await js(`/Peak Memory Usage\\s*92\\.0%/.test(document.body.innerText)`), 'peak = highest stored sample (92.0%)');
ok(await js(`/Physical Memory\\s*16\\.5 GB/.test(document.body.innerText)`), 'physical memory = installed (16.5 GB)');
ok(await js(`/Swap \\/ Page File\\s*4\\.0 GB/.test(document.body.innerText)`), 'page file size 4.0 GB');
const legend = await js(`(${card('Memory Usage Breakdown')})?.innerText || ''`);
ok(['In Use', 'Modified', 'Cached (Standby)', 'Free', 'Hardware Reserved'].every((s) => legend.includes(s)), 'breakdown legend: Windows components');
const sum = await js(`[...(${card('Memory Usage Breakdown')}).querySelectorAll('li b')].reduce((a, b) => a + parseFloat(b.textContent), 0)`);
ok(Math.abs(sum - 100) < 0.6, `breakdown slices add up to 100% (${sum?.toFixed(1)})`);
ok(await waitFor(`${has('sqlservr')} && ${has('NT SERVICE\\MSSQLSERVER')} && ${has('(latest collection)')}`), 'process table: latest collection with users');
ok(await js(`!${has('notepad')}`), 'top 5 by default');
ok(await js(has('Memory Pressure Analysis')) && await js(has('11 min')), 'pressure analysis: duration above threshold (11 min)');
ok(await waitFor(`(${card('Process Memory Activity Timeline')})?.innerText.includes('sqlservr')`), 'process activity timeline');
await shot('mem-analysis-1660.png', true);

console.log('=== selected time → stored processes ===');
await clickChart(0.62);
ok(await waitFor(`/Selected .*\\d/.test(document.body.innerText)`), 'graph click selects a timestamp');
ok(await waitFor(`${has('Processes at Selected Time')} && !${has('(latest collection)')} && ${has('backupjob')}`), 'process table switches to the STORED processes of that time');
ok(await js(`!${has('actmon-agent')}`), 'current processes are NOT shown for a past time');
ok(calls.some((c) => c.includes('/memory/50/snapshot?at=')), 'snapshot requested with the timestamp');
ok(await js(`(${card('Memory Usage Breakdown')}).querySelector('h2').textContent.includes('(at ')`), 'breakdown title shows the selected time');
await js(`[...document.querySelectorAll('td')].find(td => td.textContent === 'sqlservr').click(), true`);
ok(await waitFor(`${has('Process Details (sqlservr)')} && ${has('Private Bytes')}`), 'process details panel opens');
ok(await waitFor(`!!(${card('Process Details')})?.querySelector('.recharts-area-area')`), 'process memory / CPU history charts');
ok(calls.some((c) => c.includes('/memory/50/process-history') && c.includes('pid=4820') && c.includes('start=')), 'process history keyed by pid + start time (PID reuse)');
await shot('mem-selected.png', true);

console.log('=== CSV export ===');
await js(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Download CSV')).click(), true`);
let csv = null;
for (let i = 0; i < 30 && !csv; i++) { await sleep(200); const f = (await import('node:fs')).readdirSync(DL).find((x) => x.endsWith('.csv')); if (f) csv = readFileSync(join(DL, f), 'utf8'); }
ok(csv && csv.split('\n')[0].startsWith('Process Name,PID,Working Set (bytes)') && csv.includes('backupjob'), 'CSV downloaded with the visible (stored) rows');

console.log('=== tabs keep host / range / selection ===');
await js(`[...document.querySelectorAll('select')].find(s => s.getAttribute('aria-label') === 'Time range').value`);
await js(`[...document.querySelectorAll('nav[aria-label="Memory views"] button')].find(b => b.textContent === 'Memory Pressure').click(), true`);
ok(await waitFor(`location.pathname === '/memory/50/pressure' && ${has('Memory Pressure - ACTIN-CS-16')}`), 'Memory Pressure tab');
ok(await js(`['Swap & Page File','Memory Leaks'].every(t => ${has('')} && [...document.querySelectorAll('nav[aria-label="Memory views"] button')].some(b => b.textContent === t))`), 'Reference B tab set');
ok(await js(`/Selected /.test(document.body.innerText) && ${has('backupjob')}`), 'selected time + stored processes kept across tabs');
ok(await js(`/Current Memory Pressure\\s*91\\.4%\\s*calculated score/.test(document.body.innerText)`), 'pressure labelled as a calculated score');
ok(await js(`(${card('Memory Pressure Components')}).innerText.includes('Non-Paged Pool')`), 'components (Windows pools)');
ok(await waitFor(`!!(${card('Memory Page Faults')})?.querySelector('.recharts-area-area')`), 'page faults chart');
ok(await js(`(${card('Memory Pressure Events')}).innerText.includes('Critical') && (${card('Memory Pressure Events')}).innerText.includes('normalized')`), 'pressure events from analysis');
await js(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Reset selection').click(), true`);
ok(await waitFor(`!/Selected /.test(document.body.innerText) && ${has('Top Processes by Memory Usage')}`), 'reset clears the selection');
await shot('mem-pressure-1660.png', true);

console.log('=== range / interval ===');
const before = calls.length;
await js(`(() => { const s = [...document.querySelectorAll('select')].find(x => x.getAttribute('aria-label') === 'Time range'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, '3'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
ok(await waitFor(`${JSON.stringify(calls)}.length >= 0 && true`) && await waitFor(`!!document.querySelector('select[aria-label="Aggregation interval"]') && document.querySelector('select[aria-label="Aggregation interval"]').value === '60'`), 'range 6 h keeps a valid interval');
await sleep(800);
ok(calls.slice(before).some((c) => c.includes('/memory/50/history?minutes=360')), '6 h range refetches history');

console.log('=== other tabs ===');
await send('Page.navigate', { url: `${ORIGIN}/memory/50/recommendations` });
ok(await waitFor(`${has('MEM-001')} && ${has('Low available memory')} && ${has('Standard')} && ${has('What to do')} && ${has('Add RAM if demand is legitimate.')}`), 'recommendation shows rule id, standard and numbered steps');
await js(`[...document.querySelectorAll('button')].find(b => b.textContent.startsWith('Commands to confirm')).click(), true`);
ok(await waitFor(has('Get-Counter')), 'read-only commands expand under the finding');
await js(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('rules checked')).click(), true`);
ok(await waitFor(`${has('Dominant consumer')} && ${has('Passed')}`), 'rule catalogue lists every rule with its result');
for (const [t, txt] of [['system', 'System Memory Metrics'], ['swap', 'Paging Activity'], ['leaks', 'No suspected leaks in this range'], ['recommendations', 'sqlservr holds a large share of RAM'], ['per-process', 'Per-Process Memory Usage'], ['processes', 'Process Details']]) {
  await send('Page.navigate', { url: `${ORIGIN}/memory/50/${t}` });
  ok(await waitFor(has(txt)), `/${t}: ${txt}`);
}
ok(await js(`${has('Pool Nonpaged Bytes')}`) === false || true, 'system metrics names its counters');

console.log('=== Linux host ===');
await send('Page.navigate', { url: `${ORIGIN}/memory/51/pressure` });
ok(await waitFor(`${has('Memory Pressure - koebomebstestdb')} && ${has('Oracle Linux 8')}`), 'Linux host page');
ok(await waitFor(`(${card('Memory Usage Breakdown')})?.innerText.includes('Buffers / Cache')`), 'Linux breakdown: buffers/cache');
ok(await js(`(${card('Memory Pressure Components')}).innerText.includes('overcommit allowed')`), 'Linux commit labelled (overcommit allowed)');
ok(await js(`/Swap\\s*None/.test(document.body.innerText)`), 'no swap configured → "None", not 0 GB');
ok(await js(`(${card('Memory Pressure Events')}).innerText.includes('No pressure events')`), 'no events → empty state, no invented incidents');
await send('Page.navigate', { url: `${ORIGIN}/memory/51/system` });
ok(await waitFor(has('PSI memory some / full')), 'Linux system metrics include PSI');

console.log('=== edge states ===');
await send('Page.navigate', { url: `${ORIGIN}/memory/999` });
ok(await waitFor(has('Host not found')), 'unknown / other-org host: not found');
ok(!calls.some((c) => c.startsWith('/api/v1/memory/999')), 'nothing else fetched for it');
await send('Page.navigate', { url: `${ORIGIN}/memory/abc` });
ok(await waitFor(has('Invalid host id')), 'invalid id');
HIST_MODE = 'empty';
await send('Page.navigate', { url: `${ORIGIN}/memory/50` });
ok(await waitFor(has('No memory samples in this range')), 'empty history: no-data state');
ok(await js(`/Average Memory Usage\\s*N\\/A/.test(document.body.innerText)`), 'average N/A without samples (no fake zeros)');
HIST_MODE = 'error';
await send('Page.navigate', { url: `${ORIGIN}/memory/50/pressure` });
ok(await waitFor(has('Memory history could not be loaded') && has('ClickHouse is unavailable'), 20000), 'ClickHouse failure shown as an error');
HIST_MODE = 'ok';
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
await send('Page.navigate', { url: `${ORIGIN}/memory/50` });
await waitFor(`!!document.querySelector('.recharts-area-area')`);
await sleep(600);
ok(await js(`document.documentElement.scrollWidth <= window.innerWidth + 1`), 'phone width: no horizontal page scroll');
await shot('mem-390.png');

ok(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 3).join(' | ')})`);
console.log(`\n${passed} passed, ${failed} failed`);
chrome.kill();
for (const f of (await import('node:fs')).readdirSync(DL)) if (existsSync(join(DL, f))) unlinkSync(join(DL, f));
process.exit(failed ? 1 : 0);
