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

/* ── fixtures: the shapes oracle_perf_service.py and oracle-top-sql return ── */
const now = new Date(); now.setSeconds(0, 0);
const pad = (n) => String(n).padStart(2, '0');
const dbLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const points = Array.from({ length: 60 }, (_, i) => {
  const d = new Date(now.getTime() - (59 - i) * 60000);
  const w = Math.sin(i / 6) * 0.5 + 0.5;
  return { t: dbLocal(d), cpu_pct: 35 + w * 30 + (i === 25 ? 40 : 0), aas: 0.8 + w, active_sessions: Math.round(4 + w * 6), wait_ratio: 20 + w * 10,
    logical_bytes_s: (8 + w * 10) * 2 ** 30, physical_bytes_s: (1 + w) * 2 ** 30, read_iops: 15000 + w * 20000, write_iops: 3000 + w * 4000,
    iops: 18000 + w * 24000, read_bytes_s: 2 ** 28, write_bytes_s: 2 ** 26, redo_bytes_s: 2 ** 22 * (1 + w),
    pga_alloc_bytes: (9 + w * 3) * 2 ** 30, pga_used_bytes: (4 + w) * 2 ** 30 };
});
const tzOff = (() => { const o = -now.getTimezoneOffset(); return `${o >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(o) / 60))}:${pad(Math.abs(o) % 60)}`; })();
const FIX = {
  hist: { status: 'success', points, minutes: 60, requested_minutes: 60, clamped: false, max_minutes: 60, db_tz: tzOff, errors: [] },
  top: { status: 'success', as_of: 'now', errors: [],
    top_sessions: [{ inst_id: 1, sid: 324, serial: 56123, username: 'APPS', program: 'JDBC Thin Client', cpu_pct: 72.4, sql_id: '8ds3nwks24j9g' },
      { inst_id: 1, sid: 412, serial: 33411, username: 'APPS', program: 'Forms', cpu_pct: 12.6 }],
    top_sql: [{ sql_id: '8ds3nwks24j9g', sessions: 3, username: 'APPS' }], top_waits: [{ event: 'db file sequential read', wait_class: 'User I/O', sessions: 4 }] },
  sql: { status: 'success', sql: [{ sql_id: '8ds3nwks24j9g', plan_hash_value: 954188016, child_number: 0, executions: 1048306, avg_elapsed_ms: 0.04, cpu_ms: 27260, buffer_gets: 1050214, disk_reads: 22, elapsed_ms: 39310, last_active_time: '2026-10-15 05:35:42', sql_text: 'SELECT SUM(COALESCE(AVG_ABOUR_INVOICE_AMT ...', parsing_schema_name: 'APPS' }] },
};
function answer(url) {
  const p = new URL(url).pathname;
  if (p.endsWith('/oracle-perf-history')) return [200, FIX.hist];
  if (p.endsWith('/oracle-perf-top-now')) return [200, FIX.top];
  if (p.endsWith('/oracle-top-sql')) return [200, FIX.sql];
  if (p.endsWith('/oracle-perf-top-at')) return [200, { status: 'success', as_of: 'x', top_sessions: null, errors: [],
    top_sql: [{ sql_id: 'storedsql0001', executions: 42, avg_elapsed_ms: 12.5, cpu_ms: 300, total_ms: 525 }], top_sql_at: '2026-10-15 05:20:00',
    top_waits: [{ event: 'log file sync', wait_class: 'Commit', time_waited_ms: 900, count: 30 }], top_waits_at: '2026-10-15 05:20:00' }];
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

// Click a button inside the "Top 5 at Selected Time" card only — the
// dashboard's own tab bar has buttons with the same labels.
const clickInTop5 = (label) => js(`(() => { const card = [...document.querySelectorAll('section')].find(x => x.textContent.includes('Top 5 at Selected Time'));
  const b = card && [...card.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
const base = '/oracle-dashboard/5';
console.log('=== Performance screen ===');
await send('Emulation.setDeviceMetricsOverride', { width: 1660, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${ORIGIN}${base}/performance` });
ok(await waitFor(hasText('Average Active Sessions') && hasText('Historical Top SQL'), 30000), 'the new Performance view renders');
ok(await waitFor(hasText('Memory & wait details')), 'the existing memory and wait panels are still below it');
ok(await js(hasText('JDBC Thin Client')), 'latest minute: live Top Sessions shown');
ok(await js(hasText('8ds3nwks24j9g')), 'Historical Top SQL lists rows from V$SQL');
await sleep(800);
await shot('perf-top.png');
await send('Emulation.setDeviceMetricsOverride', { width: 1660, height: 2200, deviceScaleFactor: 1, mobile: false });
await sleep(800);
await shot('perf-full.png');
await send('Emulation.setDeviceMetricsOverride', { width: 1660, height: 1000, deviceScaleFactor: 1, mobile: false });

// Click an earlier point on the main chart.
const box = await js(`(() => { const s = [...document.querySelectorAll('svg')].find(x => x.getAttribute('height') === '300'); if (!s) return null; const b = s.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
ok(!!box, 'main chart found');
if (box) {
  const cx = box.x + 58 + (box.w - 74) * 0.3; const cy = box.y + box.h / 2;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
}
ok(await waitFor(hasText('No stored session snapshot near this moment.'), 6000), 'an earlier minute with no stored sessions says so');
ok(!(await js(hasText('JDBC Thin Client'))), 'and current sessions are no longer shown under that timestamp');
await clickInTop5('Top SQL');
ok(await waitFor(hasText('storedsql0001'), 4000), 'an earlier minute: Top SQL from the stored snapshot');
await clickInTop5('Top Wait Events');
ok(await waitFor(hasText('log file sync'), 4000), 'an earlier minute: wait events from the stored snapshot');
await shot('perf-earlier.png');

await js(`(() => { const b = [...document.querySelectorAll('section button')].find(x => x.textContent.trim() === 'Active Sessions'); b && b.click(); return !!b; })()`);
ok(await waitFor(`[...document.querySelectorAll('h3')].some(h => h.textContent.trim() === 'Active Sessions')`), 'a metric tab switches the main chart');

await clickText('8ds3nwks24j9g', 'td');
ok(await waitFor(`location.pathname.endsWith('/slow-queries/detail')`), 'a SQL row opens the SQL detail page');

console.log(`\n  ${passed} passed, ${failed} failed`);
ws.close(); chrome.kill();
process.exit(failed ? 1 : 0);
