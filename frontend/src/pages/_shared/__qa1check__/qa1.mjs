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

/* ── fixtures ── */
const ROW = { query_id: '2u5j3mb3p0bbc', query_text: 'select /*+ FIRST_ROWS(1) */ tab.rowid, tab.msgid, tab.priority from "APPLSYS"."FND_CP_TM_AQTB" tab where tab.subscriber = :1 and tab.name = :2 order by tab.priority desc',
  severity: 'low', average_execution_time: 3440, execution_count: 9700, rows_returned: 1024, user_name: 'ITC', schema_name: 'ITC',
  last_seen: '2026-10-15T06:10:00', _raw: { avg_buffer_gets: 1082.5 } };
const analyzeBodies = [];
const planCalls = [];
let failPlan = false;
function answer(url, post) {
  const p = new URL(url).pathname;
  if (p.endsWith('/oracle-sql-plan')) planCalls.push(url);
  if (p.endsWith('/oracle-sql-plan') && failPlan) return [500, { detail: 'agent did not answer' }];
  if (p.endsWith('/oracle-sql-detail')) return [200, { status: 'success', sql_id: ROW.query_id, text: ROW.query_text, errors: [],
    summary: { executions: 9700, elapsed_s: 33400, cpu_s: 28200, buffer_gets: 10500250, disk_reads: 12400, elapsed_ms_per_exec: 3440, plan_hash_values: ['2250149426'] },
    children: [{ inst_id: 1, child_number: 0, plan_hash_value: '2250149426', parsing_schema: 'ITC', optimizer_mode: 'ALL_ROWS', executions: 9700, elapsed_s: 33400, last_active_time: '2026-10-15T18:10:00' }] }];
  if (p.endsWith('/oracle-sql-plan-stats')) return [200, { status: 'success', collected: false, steps: [], note: 'Actual rows and time per step are not collected for this cursor. Oracle records them only with STATISTICS_LEVEL=ALL or the gather_plan_statistics hint.' }];
  if (p.endsWith('/oracle-sql-trend')) return [200, { status: 'success', points: [{ t: '2026-10-15T17:00', executions: 9000, avg_elapsed_ms: 3300 }, { t: '2026-10-15T18:00', executions: 9700, avg_elapsed_ms: 3440 }] }];
  if (p.endsWith('/oracle-top-sql')) return [200, { status: 'success', sql: [{ sql_id: '8d3nwxk24j9g0', plan_hash_value: 1380356856, executions: 4200, avg_elapsed_ms: 1020, elapsed_ms: 4300000, parsing_schema_name: 'ITC', sql_text: 'select 1 from dual' }] }];
  if (p.endsWith('/oracle-sql-plan')) return [200, { status: 'success', plan: [
    { id: 0, operation: 'SELECT STATEMENT', depth: 0, cost: 12, cardinality: 1 },
    { id: 1, parent_id: 0, operation: 'SORT', options: 'ORDER BY', depth: 1, cost: 12, cardinality: 1 },
    { id: 2, parent_id: 1, operation: 'TABLE ACCESS', options: 'FULL', object_owner: 'APPLSYS', object_name: 'FND_CP_TM_AQTB', object_type: 'TABLE', depth: 2, cost: 10, cardinality: 250, filter_predicates: 'TAB.SUBSCRIBER=:1' },
    { id: 3, parent_id: 1, operation: 'INDEX', options: 'RANGE SCAN', object_owner: 'APPLSYS', object_name: 'FND_CP_TM_AQTB_N1', object_type: 'INDEX', depth: 2, cost: 2, cardinality: 20, access_predicates: 'NAME=:2' },
  ] }];
  if (p.endsWith('/oracle-slow-queries')) return [200, { normalized: [ROW, { ...ROW, query_id: '9vg2cynpk1ggu', query_text: 'SELECT c.TABLE_NAME FROM dual c' }], normalized_total: 2 }];
  if (p.endsWith('/analyze-groq')) { analyzeBodies.push(post); return [200, { status: 'error', error: 'AI analysis not configured in this test' }]; }
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
    const [code, body] = answer(m.params.request.url, m.params.request.postData);
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
const open = async () => {
  await send('Page.navigate', { url: `${ORIGIN}${base}/overview` });
  await waitFor(`!!document.querySelector('nav, header')`, 20000);
  await js(`(() => { history.pushState({ usr: { row: ${JSON.stringify(ROW)} }, key: 'qa1', idx: 1 }, '', '${base}/slow-queries/detail'); dispatchEvent(new PopStateEvent('popstate', { state: history.state })); return true; })()`);
};
console.log('=== Query Analysis — screen 1 ===');
await send('Emulation.setDeviceMetricsOverride', { width: 1660, height: 1000, deviceScaleFactor: 1, mobile: false });
await open();
ok(await waitFor(hasText('Execution Statistics') && hasText('Analysis & Optimization'), 25000), 'screen 1 renders its three sections');
ok(await waitFor(hasText('FND_CP_TM_AQTB'), 3000), 'the captured statement is in the editor');
ok(await waitFor(`[...document.querySelectorAll('p')].some(p => p.textContent === 'Object Types') && document.body.innerText.includes('TABLE, INDEX')`, 8000), 'Object Types from the execution plan');
ok(await js(`(() => { const c = [...document.querySelectorAll('p')].find(p => p.textContent === 'Tables'); return c && c.nextElementSibling.textContent.trim() === '1'; })()`), 'Tables counted from the plan (1)');
ok(await js(hasText('10.5M')), 'Buffer gets derived from avg × executions (1,082.5 × 9,700 ≈ 10.5M)');
ok(await js(hasText('2u5j3mb3p0bbc')), 'SQL ID shown');
const cards = await js(`(() => { const g = [...document.querySelectorAll('.grid')].find(x => x.children.length === 10 && x.textContent.includes('Severity')); return g ? [...g.children].map(c => Math.round(c.getBoundingClientRect().top)) : []; })()`);
ok(cards.length === 10 && new Set(cards).size === 2, `10 cards in two rows (${JSON.stringify(cards)})`);
await sleep(600);
await shot('qa1.png');

await js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Format').click()`);
ok(await waitFor(`document.querySelector('textarea').value.startsWith('SELECT')`, 2000), 'Format upper-cases and splits clauses');
ok(await js(`document.querySelector('textarea').value.includes(String.fromCharCode(10) + 'FROM')`), 'FROM on its own line');
ok(await js(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('View execution plan') && b.disabled)`), 'editing disables View execution plan (plan is the captured cursor)');
const planBefore = planCalls.length;
await js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Analyze').click()`);
ok(await waitFor(hasText('an edited statement has no cursor yet'), 4000), 'Analyze on edited text explains why it cannot plan it');
ok(planCalls.length === planBefore, 'and requests no plan for text typed in the browser');
await js(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Analyse this query')).click()`);
ok(await waitFor(hasText('Analysis failed.'), 5000), '"Analyse this query" calls the AI analysis API (error state shown)');
let sent = null; try { sent = JSON.parse(analyzeBodies[0] || 'null'); } catch { /* not JSON */ }
if (!sent?.sql_text?.startsWith('SELECT')) console.log('    sent debug:', analyzeBodies.length, String(analyzeBodies[0]).slice(0, 160));
ok(!!sent?.sql_text?.startsWith('SELECT'), 'the edited text is what was sent');
await js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Clear').click()`);
await js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Analyze').click()`);
ok(await waitFor(hasText('Enter a SQL statement to analyse.'), 2000), 'Clear empties the editor and Analyze validates it');

await open();
await waitFor(hasText('Execution Statistics'), 20000);
await js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Recent Queries').click()`);
ok(await waitFor(hasText('9vg2cynpk1ggu'), 5000), 'Recent Queries lists statements from the slow-query API');
await js(`[...document.querySelectorAll('tr')].find(r => r.textContent.includes('9vg2cynpk1ggu')).click()`);
ok(await waitFor(`document.querySelector('textarea') && document.querySelector('textarea').value.includes('c.TABLE_NAME')`, 5000), 'picking one opens it on screen 1');

await open();
await waitFor(hasText('Execution Statistics'), 20000);
await js(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('View execution plan')).click()`);
ok(await waitFor(`location.search === '?view=results' && location.hash === '#qa-plan'`, 10000), 'View execution plan (Oracle) analyses, then opens the results at the plan');

console.log('=== Analyze -> results ===');
await open();
await waitFor(hasText('Execution Statistics'), 20000);
await js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Analyze').click()`);
ok(await waitFor(`location.search === '?view=results'`, 15000), 'Analyze opens the results screen after the reads succeed');
ok(await waitFor(hasText('Performance Insights') && hasText('Execution Details'), 10000), 'results screen renders its sections');
ok(await js(hasText('TABLE ACCESS FULL')), 'plan table shows the returned plan');
ok(await js(hasText('Full table scan detected') && hasText('Evidence:')), 'full-scan insight with its evidence');
ok(await js(`!/missing index/i.test(document.body.innerText)`), 'never claims a "missing index" (the scanned table has an index step here, so no candidate either)');
ok(await js(hasText('ALL_ROWS') && hasText('2250149426')), 'execution details from V$SQL');
ok(await js(hasText('not collected for this cursor')), 'actual rows: says they were not collected (no invented actuals)');
await shot('qa2-results.png');
await js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Back').click()`);
ok(await waitFor(`location.search === '' && document.body.innerText.includes('Execution Statistics')`, 8000), 'Back returns to screen 1');
await js(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('View execution plan')).click()`);
ok(await waitFor(`location.search === '?view=results' && location.hash === '#qa-plan'`, 8000), 'View execution plan opens the results at the plan');

console.log('=== failure ===');
failPlan = true;
await open();
await waitFor(hasText('Execution Statistics'), 20000);
await js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Analyze').click()`);
ok(await waitFor(hasText('Analysis could not be completed.'), 10000), 'a failed plan read shows the error');
ok(await js(`location.search === '' && [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Retry')`), 'stays on screen 1 with Retry');
ok(await js(`document.querySelector('textarea').value.includes('FND_CP_TM_AQTB')`), 'the SQL is kept');
failPlan = false;

await send('Emulation.setDeviceMetricsOverride', { width: 820, height: 1100, deviceScaleFactor: 1, mobile: false });
await open();
await waitFor(hasText('Execution Statistics'), 20000);
ok(await js(`document.documentElement.scrollWidth <= innerWidth + 1`), 'no horizontal page scroll at tablet width');
await shot('qa1-narrow.png');

console.log(`\n  ${passed} passed, ${failed} failed`);
ws.close(); chrome.kill();
process.exit(failed ? 1 : 0);
