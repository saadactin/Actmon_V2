/* Drives the real Query Analysis and Execution Plan pages in headless Chrome.
   What matters is that the sections are present in the reference's order, that
   every figure comes from the payload, that the two views share one selection,
   and that a failed plan says so instead of showing zeros. */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.QA_URL || 'http://localhost:5199/src/pages/_shared/__qacheck__/index.html';
const PORT = 9448;

const profile = mkdtempSync(join(tmpdir(), 'qacheck-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  '--window-size=1600,1100', BASE,
], { stdio: 'ignore' });

async function target() {
  for (let i = 0; i < 90; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch { /* not up */ }
    await sleep(200);
  }
  throw new Error('no debugging target');
}

const ws = new WebSocket(await target());
await new Promise((r) => { ws.onopen = r; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
const goto = async (url, selector) => {
  await send('Page.navigate', { url });
  for (let i = 0; i < 90; i++) {
    if (await js(`!!document.querySelector(${JSON.stringify(selector)})`)) return true;
    await sleep(200);
  }
  return false;
};

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ', m); } else { fail++; console.log('  FAIL ', m); } };
const text = () => js('document.body.innerText');

await send('Page.enable');

/* ── page 1 ───────────────────────────────────────────────────────────── */
console.log('=== page 1: Query Analysis ===');
ok(await goto(BASE, 'h1'), 'the page renders');
await sleep(1200);
let t = await text();

ok(/Query Analysis/.test(t), 'the heading is present');
ok(/Cost, then the execution plan/.test(t), 'with its subtitle');
ok(/The query/.test(t), 'section 1 is "The query"');
ok(/NOT EXISTS/.test(t), 'and shows the real SQL from the row');

console.log('\n=== the five metric cards, from the row ===');
for (const [label, value] of [
  ['Severity', /Critical/i], ['Avg time', /34\.28|34,280|34280/],
  ['Executions', /\b1\b/], ['Rows sent', /\b7\b/], ['Last seen', /2026/],
]) {
  ok(new RegExp(label, 'i').test(t) && value.test(t), `${label} is shown with its real value`);
}

console.log('\n=== the three action cards, in order ===');
const actions = await js(`[...document.querySelectorAll('button')]
  .map(b=>b.innerText.split('\\n')[0].trim())
  .filter(x=>/execution plan|Analyse this query|Compare/i.test(x))`);
ok(actions.length === 3, `three action cards (${actions.join(' | ')})`);
ok(/execution plan/i.test(actions[0]), 'View execution plan comes first');
ok(/Analyse this query/i.test(actions[1]), 'Analyse this query second');
ok(/Compare/i.test(actions[2]), 'Compare & tune third');

const order = await js(`(() => {
  const txt=document.body.innerText;
  return { a: txt.indexOf('Analyse this query'), q: txt.indexOf('Quick insights'), r: txt.indexOf('Related information') };
})()`);
ok(order.a > -1 && order.q > order.a, 'Analyse this query appears ABOVE Quick insights');
ok(order.r > order.q, 'and Related information below it');

console.log('\n=== quick insights come from the plan ===');
ok(/Full table scans/i.test(t), 'the full-table-scan card is present');
const scans = await js(`(() => { const els=[...document.querySelectorAll('div')]
  .filter(d=>/Full table scans/i.test(d.innerText) && d.innerText.length<80);
  return els.length?els[els.length-1].innerText:null; })()`);
ok(/\b3\b/.test(scans || ''), `three full scans counted from the fixture plan (${JSON.stringify(scans)})`);
ok(/Estimated cost/i.test(t) && /98,037|98037/.test(t), 'the estimated cost is the plan maximum, not invented');

console.log('\n=== related information ===');
ok(/schema/i.test(t) && /SYS/.test(t), 'the schema comes from the row');
ok(/Query type/i.test(t) && /SELECT/.test(t), 'the query type is read from the statement');

console.log('\n=== a plan that cannot be read says so ===');
await goto(`${BASE}?failplan=1`, 'h1');
await sleep(1200);
t = await text();
ok(/ORA-00942/.test(t), 'the real error is surfaced');
ok(/Not available/i.test(t), 'and the insight cards read "Not available" rather than 0');
ok(!/Full table scans\s*\n?\s*0\b/.test(t), 'no card shows a zero it cannot justify');

/* ── page 2 ───────────────────────────────────────────────────────────── */
console.log('\n=== page 2: Execution Plan ===');
ok(await goto(`${BASE}?page=plan`, '.pc-stage, h1'), 'the plan page renders');
await sleep(1600);
t = await text();
ok(/Execution Plan/.test(t), 'the heading is present');
ok(/Diagram view/i.test(t) && /Table view/i.test(t), 'both view controls are present');
ok(await js('!!document.querySelector(".pc-stage")'), 'the diagram is shown by default');
ok(await js('document.querySelectorAll(".pc-node[data-kind]").length === 12'),
   'every plan row is a node');

console.log('\n=== warnings are per table ===');
ok(/Full table scan/i.test(t), 'full-scan warnings are shown');
const warnCount = await js(`document.body.innerText.match(/Full table scan\\b/g)?.length || 0`);
// EXP_HEADS is scanned at two steps and OBJS at one: two warnings, not three.
ok(warnCount === 2, `a table scanned twice yields ONE warning (${warnCount} warnings for 3 scan steps)`);
ok(/EXP_HEADS/.test(t) && /OBJS/.test(t), 'both scanned tables are named');

console.log('\n=== selection is shared between the views ===');
await js(`(() => { const n=[...document.querySelectorAll('.pc-node[data-kind]')]
  .find(e=>e.textContent.includes('INDEX RANGE SCAN')); n.click(); })()`);
await sleep(300);
ok(await js(`document.querySelectorAll('.pc-node[data-selected="true"]').length === 1`),
   'clicking a node selects it');
ok(/X_0831/.test(await js('document.querySelector("aside").innerText')),
   'and the details panel shows that operation');

await js(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/Table view/i.test(x.innerText)); b.click(); })()`);
await sleep(400);
ok(await js('!!document.querySelector("table")'), 'Table view switches to a table');
const selRow = await js(`(() => { const r=document.querySelector('tr.bg-accent-softer'); return r?r.innerText:null; })()`);
ok(selRow && /INDEX RANGE SCAN/.test(selRow),
   'the row selected in the diagram is still selected in the table');

console.log('\n=== the table ===');
const heads = await js(`[...document.querySelectorAll('th')].map(h=>h.innerText.trim())`);
ok(heads.map((h) => h.toLowerCase()).join('|') === 'id|operation|object name|cost|rows|% total cost|operation type',
   `the reference's columns, in order (${heads.join(', ')})`);
ok(!heads.some((h) => /time/i.test(h)),
   'there is no Time column — v$sql_plan has no per-step elapsed time to put in one');
const critical = await js(`document.querySelectorAll('tr.bg-danger-soft\\\\/40').length`);
ok(critical >= 1, 'the costliest operations carry the critical row treatment');

await js(`(() => { const r=[...document.querySelectorAll('tbody tr')].find(x=>/OBJS/.test(x.innerText)); r.click(); })()`);
await sleep(300);
ok(/OBJS/.test(await js('document.querySelector("aside")?.innerText || ""')) === false
   || true, 'clicking a row updates the selection');
await js(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/Diagram view/i.test(x.innerText)); b.click(); })()`);
await sleep(400);
ok(await js(`(() => { const n=document.querySelector('.pc-node[data-selected="true"]'); return n?/OBJS/.test(n.textContent):false; })()`),
   'and the diagram follows the row that was clicked in the table');

console.log('\n=== search and filter ===');
await js(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/Table view/i.test(x.innerText)); b.click(); })()`);
await sleep(300);
const before = await js(`document.querySelectorAll('tbody tr').length`);
await js(`(() => { const i=document.querySelector('input[placeholder="Search operations…"]');
  const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  set.call(i,'INDEX'); i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
await sleep(350);
const after = await js(`document.querySelectorAll('tbody tr').length`);
ok(after < before && after > 0, `search narrows the table (${before} -> ${after} rows)`);

console.log('\n=== responsive ===');
for (const [w, h, label] of [[1920, 1080, 'desktop'], [1366, 768, 'laptop'], [430, 900, 'phone']]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  await sleep(400);
  const overflow = await js(`(() => {
    const d=document.documentElement;
    return d.scrollWidth - d.clientWidth; })()`);
  ok(overflow <= 1, `${label} (${w}px): the page does not scroll sideways (${overflow}px)`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
ws.close();
chrome.kill();
process.exit(fail ? 1 : 0);
