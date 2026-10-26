/* End-to-end click-through of the Oracle service drill-down in the REAL app
   (router, auth guard, layout, pages), with the API answered from fixtures by
   intercepting requests in Chrome. Nothing touches a database.

   cd frontend && npx vite --port 5200      (terminal 1)
   node src/pages/oracle/serviceDrill/__drillcheck__/drill.mjs <outDir> */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = process.env.APP_URL || 'http://localhost:5200';
const OUT = process.argv[2] || 'drillshots';
const PORT = 9451;
mkdirSync(OUT, { recursive: true });

/* ── fixtures: the shapes oracle_service_drill_service.py returns ── */
const NOW = new Date().toISOString();
const SVC = 'APPLSYS.WF_CONTROL';
const INSTANCES = [
  { inst_id: 1, instance_number: 1, instance_name: 'KCDB1', host_name: 'node01', version: '19.21.0.0.0', instance_status: 'OPEN', database_status: 'ACTIVE', startup_time: NOW },
  { inst_id: 2, instance_number: 2, instance_name: 'KCDB2', host_name: 'node02', version: '19.21.0.0.0', instance_status: 'OPEN', database_status: 'ACTIVE', startup_time: NOW },
];
const FIX = {
  services: { status: 'success', services: [
    { service_name: SVC, network_name: SVC, status: 'partial', instances: [{ instance_number: 1, status: 'online' }, { instance_number: 2, status: 'offline' }] },
    { service_name: 'ebs_KPATCH', network_name: 'ebs_KPATCH', status: 'online', instances: [{ instance_number: 1, status: 'online' }, { instance_number: 2, status: 'online' }] },
  ], active_read: true, errors: [] },
  detail: { status: 'success', service: { service_name: SVC, network_name: SVC, creation_date: NOW, config: { goal: 'NONE', clb_goal: 'LONG', enabled: 'YES' } },
    database: { name: 'KPATCH', db_unique_name: 'KPATCH', database_role: 'PRIMARY', open_mode: 'READ WRITE', cdb: 'NO' },
    overall: 'partial', active_instances: 1,
    instances: [{ ...INSTANCES[0], service_status: 'active', sessions: { total: 2, active: 1, inactive: 1 } },
      { ...INSTANCES[1], service_status: 'not_active', sessions: { total: 0, active: 0, inactive: 0 } }],
    sessions: { total: 2, active: 1, truncated: false },
    metrics: [{ inst_id: 1, end_time: NOW, elapsed_ms_per_call: 1.25, cpu_ms_per_call: 0.4, calls_per_sec: 12.5 }],
    alerts: [], read_at: NOW, errors: ['gv$servicemetric(dbtimepersec): ORA-00904 example of a partial read'] },
  instance: { status: 'success', service: { service_name: SVC }, instance: INSTANCES[0], service_status: 'active', role: 'PRIMARY',
    sessions: { total: 2, active: 1, truncated: false },
    waits: [{ event: 'db file sequential read', wait_class: 'User I/O', sessions: 1, max_seconds: 3 }],
    sysmetrics: { 'Host CPU Utilization (%)': { value: 32.4 }, 'Average Active Sessions': { value: 1.8 } },
    memory: { sga_mb: 8192, pga_allocated_mb: 1024 }, service_metrics: [], read_at: NOW, errors: [] },
  sessions: { status: 'success', inst_id: 1, cap: 500, truncated: false, read_at: NOW, errors: [], sessions: [
    { inst_id: 1, sid: 1345, serial: 22111, username: 'APPLSYS', machine: 'app-server-01', program: 'Forms', status: 'ACTIVE', sql_id: '8x3k2m1nq4abc', event: 'db file sequential read', wait_class: 'User I/O', last_call_et: 4 },
    { inst_id: 1, sid: 1456, serial: 33221, username: 'APPLSYS', machine: 'app-server-02', program: 'Concurrent Manager', status: 'INACTIVE', sql_id: null, event: 'SQL*Net message from client', wait_class: 'Idle', last_call_et: 300 },
  ] },
  session: { status: 'success', read_at: NOW, errors: [],
    session: { inst_id: 1, sid: 1345, serial: 22111, username: 'APPLSYS', machine: 'app-server-01', program: 'Forms', status: 'ACTIVE', service_name: SVC, event: 'db file sequential read', wait_class: 'User I/O', seconds_in_wait: 3, logon_time: NOW, last_call_et: 4, sql_id: '8x3k2m1nq4abc', prev_sql_id: '9k2h1mpqa1xyz' },
    stats: { 'CPU used by this session': 1250, 'session logical reads': 256432, 'physical reads': 1245, 'execute count': 1024 },
    current_sql: { sql_id: '8x3k2m1nq4abc', text: 'SELECT fnd_request_id, phase_code FROM fnd_concurrent_requests WHERE status_code = :1' },
    previous_sql: { sql_id: '9k2h1mpqa1xyz', text: null } },
  sql: { status: 'success', sql_id: '8x3k2m1nq4abc', read_at: NOW, errors: [], text: 'SELECT fnd_request_id, phase_code FROM fnd_concurrent_requests WHERE status_code = :1', text_available: true,
    summary: { executions: 124, elapsed_s: 32.5, cpu_s: 10.2, buffer_gets: 51200, disk_reads: 300, rows_processed: 1240, elapsed_ms_per_exec: 262.1, buffer_gets_per_exec: 412.9, plan_hash_values: ['1234567'] },
    children: [{ inst_id: 1, child_number: 0, plan_hash_value: '1234567', parsing_schema: 'APPS', executions: 124, elapsed_s: 32.5, buffer_gets: 51200, rows_processed: 1240, last_active_time: NOW }] },
};

function answer(url) {
  const u = new URL(url);
  const p = u.pathname;
  const svc = u.searchParams.get('service');
  if (p.endsWith('/oracle-service-detail')) {
    if (svc === 'NOPE') return [200, { status: 'not_found', error: "Service 'NOPE' is not in DBA_SERVICES.", errors: [] }];
    if (svc === 'BROKEN') return [500, { detail: 'agent did not answer' }];
    return [200, FIX.detail];
  }
  if (p.endsWith('/oracle-service-instance')) return [200, FIX.instance];
  if (p.endsWith('/oracle-service-sessions')) return [200, FIX.sessions];
  if (p.endsWith('/oracle-session-detail')) return [200, FIX.session];
  if (p.endsWith('/oracle-sql-detail')) return [200, FIX.sql];
  if (p.endsWith('/oracle-services')) return [200, FIX.services];
  if (p.endsWith('/oracle-rac-nodes')) return [200, { status: 'success', nodes: INSTANCES.map((i) => ({ ...i, instance_status: 'OPEN' })) }];
  return [200, {}];
}

/* ── chrome ── */
const profile = mkdtempSync(join(process.env.TMP || tmpdir(), 'drill-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1500,1000', 'about:blank'], { stdio: 'ignore' });
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
const apiCalls = [];
ws.onmessage = async (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') console.log('  PAGE ERROR', (m.params.exceptionDetails?.exception?.description || '').split(String.fromCharCode(10))[0]);
  if (m.method === 'Fetch.requestPaused') {
    const [code, body] = answer(m.params.request.url);
    apiCalls.push(m.params.request.url);
    if (m.params.request.url.includes('/oracle-sql-detail')) await sleep(2500);
    send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: code,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(JSON.stringify(body)).toString('base64') });
  }
};
const js = async (expr) => (await Promise.race([send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }), sleep(20000).then(() => ({}))])).result?.result?.value;
async function waitFor(expr, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr)) return true; await sleep(120); } return false; }
const hasText = (t) => `document.body.innerText.includes(${JSON.stringify(t)})`;
const path = () => js('location.pathname');
const clickText = (t, sel = '*') => js(`(() => { const t = ${JSON.stringify(t)};
  const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.offsetParent && e.textContent.trim().includes(t));
  const el = els.sort((a, b) => a.textContent.length - b.textContent.length)[0];
  if (!el) return false; (el.closest('[role=button],button,a,tr') || el).click(); return true; })()`);
const shot = async (n) => { const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, n), Buffer.from(s.result.data, 'base64')); };

let passed = 0; let failed = 0;
const ok = (c, msg) => { if (c) { passed++; console.log('  PASS ', msg); } else { failed++; console.log('  FAIL ', msg); } };

await send('Runtime.enable');
// The drill-down is under test, not the loader: reduced motion makes the 3D
// loader draw one still frame instead of a software-rendered loop.
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/v1/*' }] });
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
// A signed-in session, as the auth store persists it. The token is never
// verified here: every API answer comes from the fixtures above.
const payload = Buffer.from(JSON.stringify({ sub: 'qa', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
await send('Page.navigate', { url: `${ORIGIN}/login` });
await sleep(1500);
await js(`localStorage.setItem('actmon_token', 'x.${payload}.y'); localStorage.setItem('actmon_user', JSON.stringify({ id: 1, username: 'qa', role_id: 1, org_id: 1 })); true`);

const base = '/oracle-dashboard/5';
console.log('=== 1. Services (parent) ===');
await send('Page.navigate', { url: `${ORIGIN}${base}/services` });
ok(await waitFor(hasText(SVC), 25000), 'the Services table lists the service');
await shot('1-services.png');
await clickText(SVC, 'li button span');
ok(await waitFor(`location.pathname === ${JSON.stringify(`${base}/services/${encodeURIComponent(SVC)}`)}`), `service click opens its page (${await path()})`);

console.log('=== 2. Service (child) ===');
ok(await waitFor(hasText('RAC Instances')), 'service page shows its sections');
ok(await js(hasText('Partial')), 'overall status from the backend (Partial)');
ok(await js(hasText('1 / 2')), 'active instances from the backend (1 / 2)');
ok(await js(hasText('Some sections could not be read')), 'a partial read is disclosed, not hidden');
ok(await js(`[...document.querySelectorAll('nav[aria-label=Breadcrumb] a')].map(a => a.textContent).join('>') === 'Oracle Dashboard>Services'`), 'breadcrumbs: Oracle Dashboard > Services > service');
await shot('2-service.png');
await clickText('View RAC Details', 'button');
ok(await waitFor(`location.pathname.endsWith('/instances')`), 'RAC instances card opens the instance list');

console.log('=== 3. Instances (sub-child) ===');
ok(await waitFor(hasText('Service status')) && await js(hasText('KCDB2')), 'both real instances listed');
ok(await js(hasText('Not active')), 'service status per instance (KCDB2 not active)');
await shot('3-instances.png');
await clickText('KCDB1', 'td span');
ok(await waitFor(`location.pathname.endsWith('/instances/1')`), 'instance row opens instance 1 (by INST_ID)');

console.log('=== 4. Instance ===');
ok(await waitFor(hasText('Instance overview')), 'instance page renders');
ok(await js(hasText('32.4%')), 'host CPU from GV$SYSMETRIC');
ok(await js(hasText('db file sequential read')), 'current waits listed');
ok(await js(`[...document.querySelectorAll('nav[aria-label=Breadcrumb] *')].some(e => e.textContent === 'KCDB1')`), 'breadcrumb shows the instance NAME read from Oracle');
await shot('4-instance.png');
await clickText('Sessions', 'button');
ok(await waitFor(`location.pathname.endsWith('/instances/1/sessions')`), 'Sessions card opens the session list');

console.log('=== 5. Sessions ===');
ok(await waitFor(hasText('1345')), 'sessions listed');
await js(`(() => { const i = document.querySelector('input[placeholder="Search sessions…"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'Concurrent'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await sleep(300);
ok(await js(`!document.body.innerText.includes('app-server-01') && document.body.innerText.includes('app-server-02')`), 'search filters the list');
await js(`(() => { const i = document.querySelector('input[placeholder="Search sessions…"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await sleep(300);
await shot('5-sessions.png');
await clickText('1345', 'td span');
ok(await waitFor(`location.pathname.endsWith('/sessions/1345/22111')`), 'session row opens SID 1345 / SERIAL# 22111');

console.log('=== 6. Session ===');
ok(await waitFor(hasText('Session information')), 'session page renders');
ok(await js(hasText('fnd_concurrent_requests')), 'current SQL text shown');
ok(await js(hasText('Text unavailable')), 'previous SQL without text says so (no invented text)');
await shot('6-session.png');
await clickText('8x3k2m1nq4abc — SQL details', 'button');
ok(await waitFor(`location.pathname.endsWith('/sql/8x3k2m1nq4abc')`), 'SQL ID opens the SQL page');

console.log('=== 7. SQL ===');
ok(await waitFor(`!!document.querySelector('.drill-loader')`, 2000), 'while the SQL request is pending, the loader shows');
const lb = await js(`(() => { const b = document.querySelector('.drill-loader').getBoundingClientRect(); return { h: Math.round(b.height), w: Math.round(b.width) }; })()`);
ok(lb && lb.h >= 300 && lb.h <= 520, `the loader is sized to the content area, not a tall blank band (${JSON.stringify(lb)})`);
await shot('7a-loader.png');
ok(await waitFor(hasText('Child cursors')), 'SQL page renders');
ok(!(await js(`!!document.querySelector('.drill-loader')`)), 'the loader is gone once the data is there');
ok(await js(hasText('262.1 ms')), 'elapsed per execution from GV$SQL');
await shot('7-sql.png');

console.log('=== navigation ===');
await js('history.back()');
ok(await waitFor(`location.pathname.endsWith('/sessions/1345/22111')`), 'browser Back returns to the session');
await js('history.forward()');
ok(await waitFor(`location.pathname.endsWith('/sql/8x3k2m1nq4abc')`), 'browser Forward returns to the SQL');
// Mark the old document so the wait below cannot be satisfied by it.
await js('window.__beforeReload = true');
await send('Page.reload');
ok(await waitFor(`!window.__beforeReload && ${hasText('Child cursors')} && [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Back')`, 25000),
  'a refresh on the SQL page re-reads the same record');
const backBtns = await js(`[...document.querySelectorAll('button')].filter(b => b.offsetParent).map(b => b.textContent.trim()).filter(t => /back/i.test(t))`);
const clicked = await clickText('Back', 'button');
const backOk = await waitFor(`location.pathname.endsWith('/sessions/1345/22111')`);
if (!backOk) console.log('    back debug:', JSON.stringify({ clicked, backBtns, path: await path() }));
ok(backOk, 'the Back button goes one level up');
await waitFor(hasText('Session information'));
await clickText('Sessions', 'nav a');
ok(await waitFor(`location.pathname.endsWith('/instances/1/sessions')`), 'a breadcrumb jumps straight to its level');

console.log('=== back from a directly opened URL ===');
await send('Page.navigate', { url: `${ORIGIN}${base}/services/${encodeURIComponent(SVC)}/instances/1/sessions/1345/22111` });
ok(await waitFor(hasText('Session information'), 20000), 'a session page opened directly by URL renders');
await clickText('Back', 'button');
ok(await waitFor(`location.pathname.endsWith('/instances/1/sessions')`), 'Back from a direct URL goes to that instance\'s session list');
const listShown = await waitFor(hasText('Concurrent Manager'));
const cells = await js(`[...document.querySelectorAll('td span')].filter(e => e.textContent.includes('1345')).map(e => e.outerHTML.slice(0, 120))`);
const clicked2 = await clickText('1345', 'td span');
const reopened = await waitFor(`location.pathname.endsWith('/sessions/1345/22111')`);
if (!reopened) console.log('    reopen debug:', JSON.stringify({ listShown, clicked2, cells, path: await path(), text: (await js('document.body.innerText')).slice(0, 300) }));
ok(reopened, 'reopen the session from the list');
await waitFor(hasText('Session information'));
const before = await js('history.length');
await clickText('Back', 'button');
ok(await waitFor(`location.pathname.endsWith('/instances/1/sessions')`), 'Back after a click-through returns to the list');
ok((await js('history.length')) === before, 'and it used history (no new entry was pushed)');

console.log('=== states ===');
await send('Page.navigate', { url: `${ORIGIN}${base}/services/NOPE` });
ok(await waitFor(hasText('Not found.')), 'unknown service: not-found state');
await send('Page.navigate', { url: `${ORIGIN}${base}/services/BROKEN` });
ok(await waitFor(hasText('This level could not be read.'), 20000), 'API failure: error state');
ok(await js(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Retry')`), 'with a Retry button');
await shot('8-error.png');
ok(!apiCalls.some((u) => /services\/APPLSYS/.test(u)), 'all drill reads go through query params, not path-interpolated names');

console.log(`\n  ${passed} passed, ${failed} failed`);
ws.close(); chrome.kill();
process.exit(failed ? 1 : 0);
