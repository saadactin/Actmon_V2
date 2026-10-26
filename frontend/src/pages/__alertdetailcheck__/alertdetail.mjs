/* Alerts → click an alert → Alert Details panel. REAL app; API answered with REAL responses captured from
   production (ad_dump.json: /alerts/active, /alerts/detail, /alerts/detail/storage). Nothing touches a database.
     cd frontend && npx vite --port 2106
     node src/pages/__alertdetailcheck__/alertdetail.mjs <outDir> */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = process.env.APP_URL || 'http://localhost:2106';
const OUT = process.argv[2] || 'adshots';
const PORT = 9499;
mkdirSync(OUT, { recursive: true });
const now = Date.now();
const DUMP = JSON.parse(readFileSync('E:/tmp_actmon/ad_dump.json', 'utf8'));
const STATS = JSON.parse(readFileSync('E:/tmp_actmon/stats_dump.json', 'utf8'));
const ACTIVE = STATS.active;
const calls = []; const posts = []; const comments = [];
function answer(url, method, postData) {
  const u = new URL(url); const p = u.pathname.replace(/\/+$/, '');
  calls.push(`${method} ${p}${u.search}`);
  if (method === 'POST') posts.push({ p, body: postData ? JSON.parse(postData) : null });
  if (p.endsWith('/alerts/active') && method === 'GET') return [200, ACTIVE];
  if (p.endsWith('/alerts/active/ack')) return [200, { status: 'success', acknowledged: 1 }];
  if (p.endsWith('/alerts/detail/storage')) return [200, DUMP.storage];
  if (p.endsWith('/alerts/detail/stats')) return [200, STATS.stats];
  if (p.endsWith('/alerts/detail/comments') && method === 'GET') return [200, comments];
  if (p.endsWith('/alerts/detail/comments') && method === 'POST') { const b = JSON.parse(postData); const c = { id: comments.length + 1, username: 'qa', body: b.body, at: new Date().toISOString() }; comments.push(c); return [200, c]; }
  if (p.endsWith('/alerts/detail')) {
    const id = u.searchParams.get('id');
    if (id === DUMP.detail.alert.id) return [200, DUMP.detail];
    if (DUMP.detail_rule && id === String(DUMP.detail_rule.alert.id)) return [200, DUMP.detail_rule];
    if (id === 'gone') return [404, { detail: 'This alert is no longer active (acknowledged or resolved).' }];
    const a = ACTIVE.find((x) => String(x.id) === id);
    return a ? [200, { ...DUMP.detail, alert: a, subject: { kind: 'generic', name: null }, history: [], related: [], recent_events: [] }] : [404, { detail: 'This alert is no longer active (acknowledged or resolved).' }];
  }
  if (/oracle-datafile-mounts$/.test(p)) return [200, { datafiles: [{ tablespace: DUMP.detail.subject.name, file_name: '/u01/oradata/' + DUMP.detail.subject.name.toLowerCase() + '01.dbf', size_gb: 32, autoextend: 'YES', max_gb: 32 }] }];
  return [200, []];
}

const profile = mkdtempSync(join(process.env.TMP || tmpdir(), 'adetail-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1654,951', 'about:blank'], { stdio: 'ignore' });
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
    const [code, body] = answer(m.params.request.url, m.params.request.method, m.params.request.postData);
    send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: code, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') });
  }
};
const js = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
async function waitFor(x, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (await js(x)) return true; await sleep(150); } return false; }
const has = (t) => `document.body.innerText.includes(${JSON.stringify(t)})`;
const shot = async (n, h = 1000) => {
  await send('Emulation.setDeviceMetricsOverride', { width: 1654, height: h, deviceScaleFactor: 1, mobile: false }); await sleep(500);
  const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, n), Buffer.from(s.result.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 1654, height: 1000, deviceScaleFactor: 1, mobile: false });
};
let passed = 0; let failed = 0;
const ok = (c, msg) => { if (c) { passed++; console.log('  PASS ', msg); } else { failed++; console.log('  FAIL ', msg); } };
const card = (title) => `[...document.querySelectorAll('section')].find(s => (s.querySelector('h2')?.textContent || '').trim().startsWith(${JSON.stringify(title)}))`;
const arrow = (title) => `document.querySelector('[aria-label="Open all hosts — ${title}"]')`;

await send('Runtime.enable');
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/v1/*' }] });
await send('Emulation.setDeviceMetricsOverride', { width: 1654, height: 1000, deviceScaleFactor: 1, mobile: false });
const payload = Buffer.from(JSON.stringify({ sub: 'qa', exp: Math.floor(now / 1000) + 3600 })).toString('base64url');
await send('Page.navigate', { url: `${ORIGIN}/login` });
await sleep(1500);
await js(`localStorage.setItem('actmon_token', 'x.${payload}.y'); localStorage.setItem('actmon_user', JSON.stringify({ id: 1, username: 'qa', role_id: 1, org_id: 1 })); true`);

const D = DUMP.detail; const SUB = D.subject;
const P = `document.querySelector('[aria-label="Alert details"]')`;
console.log('=== alerts list (reference 1) ===');
await send('Page.navigate', { url: `${ORIGIN}/alerts` });
ok(await waitFor(`document.querySelectorAll('tbody tr').length > 3 && document.body.innerText.includes('Severity Distribution')`, 30000), 'list page renders with trend + distribution');
const T = 'document.body.innerText';
ok(await js(`/Active Alerts/.test(${T}) && ${T}.includes('Currently firing') && ${T}.includes('Immediate attention') && ${T}.includes('Needs review') && ${T}.includes('Acknowledged (24h)')`), 'five summary cards');
ok(await js(`${T}.includes(${JSON.stringify(String(ACTIVE.length))})`), `active count = live list (${ACTIVE.length})`);
const exp = Math.round(100 * (STATS.stats.current.total - STATS.stats.previous.total) / STATS.stats.previous.total);
ok(await js(`${T}.includes('${exp}%')`), `% change = raised 24 h vs previous 24 h (${exp}%)`);
ok(await js(`${T}.includes('Last Updated')`), 'Last Updated indicator');
ok(await js(`['Sr. No.','Alert','Source','Severity','Value','Age','Actions'].every(h => [...document.querySelectorAll('thead th')].some(t => t.textContent.trim() === h))`), 'table columns match the reference');
await js(`(() => { const i = document.querySelector('input[aria-label="Search alerts"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Tablespace'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await sleep(600);
await js(`(() => { const r = [...document.querySelectorAll('tbody tr')].find(x => /Tablespace/.test(x.innerText)); const c = r && r.querySelector('td'); c && (c.querySelector('input,button,[role=checkbox]') || c).click(); return true; })()`);
await sleep(500);
ok(await js(`document.body.innerText.includes('Acknowledge selected (1)')`), 'row checkbox selects an alert (Acknowledge selected appears)');
ok(await js(`![...document.querySelectorAll('tbody tr')].some(r => /NaN/.test(r.innerText))`), 'no NaN values');
await js(`(() => { const s = document.querySelector('select[aria-label="Severity"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'critical'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
ok(await waitFor(`[...document.querySelectorAll('tbody tr')].some(r => r.innerText.includes('%') && !!r.querySelector('span.rounded-full span'))`), 'Value column shows % with bar');
await shot('alerts-list.png', 951);

await send('Page.navigate', { url: `${ORIGIN}/alerts?sev=critical` });
ok(await waitFor(`document.querySelectorAll('tbody tr').length > 3`, 30000), 'alerts list renders');
const firstMsg = await js(`document.querySelector('tbody tr').innerText.slice(0, 80)`);
await js(`document.querySelector('tbody tr').click(), true`);
ok(await waitFor(`!!document.querySelector('[aria-label="Alert details"]')`), `clicking the FIRST alert opens the details panel (${String(firstMsg).replace(/\s+/g, ' ').slice(0, 60)})`);
ok(await js(`/[?&]alert=/.test(location.search) && /sev=critical/.test(location.search)`), 'URL keeps the list context and the open alert (?alert=...)');
ok(await js(`!!document.querySelector('tbody tr.ring-2')`), 'the open alert stays highlighted in the list');

console.log('=== tablespace alert, real data ===');
await send('Page.navigate', { url: `${ORIGIN}/alerts?alert=${encodeURIComponent(D.alert.id)}` });
ok(await waitFor(`(${P})?.innerText.includes(${JSON.stringify(D.alert.message)})`, 30000), 'header shows the real alert message');
ok(await js(`${P}.innerText.includes('Disk usage') && ${P}.innerText.includes('Critical') && /#ALRT-\\d{8}-\\d+/.test(${P}.innerText)`), 'title, severity and alert ID');
ok(await js(`['Database','Oracle','Disk Usage','Tablespace',${JSON.stringify(SUB.name)}].every(t => ${P}.innerText.includes(t))`), 'classification tags (real tech: Oracle)');
ok(await waitFor(`${P}.innerText.includes(${JSON.stringify(SUB.used_pct + '%')}) && !!${P}.querySelector('.recharts-pie')`), 'donut with real usage %');
ok(await waitFor(`!!${P}.querySelector('.recharts-area-area')`), 'usage trend from stored history');
ok(await js(`${P}.innerText.includes('Warning: 70%') && ${P}.innerText.includes('Critical: 85%')`), 'real thresholds (collector 85 %, storage view 70 %)');
ok(await waitFor(`${P}.innerText.includes('/u01/oradata/')`), 'datafile location from the existing Oracle endpoint');
ok(await js(`${P}.innerText.includes(${JSON.stringify((D.target.host && D.target.host.server_name) || '')})`), 'host & database info');
ok(await js(`${P}.innerText.includes('Open in DB Console') && ${P}.innerText.includes('View Tablespace') && ${P}.innerText.includes('Check Logs') && !${P}.innerText.includes('Run Disk Cleanup')`), 'only supported quick actions (no fake cleanup/resize)');
await shot('alert-detail.png', 951);
await shot('alert-detail-full.png', 1500);
const tabsOk = [];
for (const [label, expect] of [['Metrics & Graphs', 'Value at Each Notification'], ['Affected Objects', `Objects in ${SUB.name}`], ['Recent Events', 'Recent Events on'], ['Related Alerts', 'Other Active Alerts'], ['Suggested Actions', 'ALTER TABLESPACE'], ['History', 'History of this alert'], ['Comments', 'No comments yet']]) {
  await js(`[...${P}.querySelectorAll('[role=tab]')].find(b => b.textContent.startsWith(${JSON.stringify(label)})).click(), true`);
  tabsOk.push((await waitFor(`${P}.innerText.includes(${JSON.stringify(expect)})`, 6000)) ? label : `!${label}`);
}
ok(tabsOk.every((x) => !x.startsWith('!')), `every tab opens real content (${tabsOk.join(', ')})`);
await js(`(() => { const t = ${P}.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'Raised with DBA team'); t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await js(`[...${P}.querySelectorAll('button')].find(b => b.textContent === 'Add Comment').click(), true`);
ok((await waitFor(`${P}.innerText.includes('Raised with DBA team')`)) && posts.some((x) => x.p.endsWith('/comments') && x.body.alert_key === D.alert_key), 'comment saved against the alert subject');
await js(`[...${P}.querySelectorAll('button')].find(b => b.textContent.includes('Acknowledge')).click(), true`);
ok(await waitFor(`${P}.innerText.includes('Acknowledged')`), 'Acknowledge works');
const ackPost = posts.find((x) => x.p.endsWith('/alerts/active/ack'));
ok(ackPost && ackPost.body.ids.length === 1 && ackPost.body.ids[0] === Number(String(D.alert.id).slice(1)), `acknowledges ONLY this alert (${JSON.stringify(ackPost && ackPost.body)})`);
await js(`[...${P}.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Close').click(), true`);
ok(await waitFor(`!document.querySelector('[aria-label="Alert details"]') && !/alert=/.test(location.search)`), 'Close returns to the list');

console.log('=== other states ===');
if (DUMP.detail_rule) {
  await send('Page.navigate', { url: `${ORIGIN}/alerts?alert=${encodeURIComponent(DUMP.detail_rule.alert.id)}` });
  ok((await waitFor(`(${P})?.innerText.includes('Alert Summary')`, 20000)) && !(await js(`[...${P}.querySelectorAll('button')].some(b => b.textContent.includes('Acknowledge'))`)), 'rule alert: summary layout, no acknowledge (live state)');
}
await send('Page.navigate', { url: `${ORIGIN}/alerts?alert=gone` });
ok(await waitFor(`(${P})?.innerText.includes('This alert is no longer active')`, 20000), 'resolved / missing alert: clear message');
ok(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 3).join(' | ')})`);
console.log(`\n${passed} passed, ${failed} failed`);
chrome.kill(); process.exit(failed ? 1 : 0);
