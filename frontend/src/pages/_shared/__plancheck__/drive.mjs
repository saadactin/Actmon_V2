/* Drives the real PlanCanvas in headless Chrome: clicks each control, clicks a
   node, switches every details tab, pans and wheel-zooms, and asserts what
   actually changed on screen. A build proves the component compiles; only this
   proves the zoom button zooms. */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL_BASE = process.env.PLANCHECK_URL || 'http://localhost:5199/src/pages/_shared/__plancheck__/index.html';
const PORT = 9444;

const profile = mkdtempSync(join(tmpdir(), 'plancheck-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1600,1000', URL_BASE,
], { stdio: 'ignore' });

async function target() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
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
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
  return r.result?.result?.value;
};

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ', m); } else { fail++; console.log('  FAIL ', m); } };

// Wait for React to mount the canvas.
for (let i = 0; i < 80; i++) {
  if (await evalJs('!!document.querySelector(".pc-node")')) break;
  await sleep(250);
}

const clickByTitle = async (title) => evalJs(
  `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.title===${JSON.stringify(title)}); if(!b) return false; b.click(); return true; })()`);
const zoom = () => evalJs(
  `(() => { const el=[...document.querySelectorAll('.pc-toolbar span')].find(s=>/%$/.test(s.textContent.trim())); return el?parseInt(el.textContent):null; })()`);
const transform = () => evalJs('document.querySelector(".pc-canvas").style.transform');

console.log('=== it renders the plan ===');
const counts = await evalJs(`({
  nodes: document.querySelectorAll('.pc-node[data-kind]').length,
  edges: document.querySelectorAll('path.pc-edge').length,
  ids: [...document.querySelectorAll('.pc-node .pc-id')].map(e=>e.textContent).join(','),
})`);
ok(counts.nodes === 14, `every plan step is drawn, and only plan steps (${counts.nodes} nodes)`);
ok(counts.edges === 13, `every parent-child edge is drawn (${counts.edges} edges for 14 steps)`);
ok(counts.ids.startsWith('0,'), 'steps carry their Oracle operation id');

const overlap = await evalJs(`(() => {
  const r=[...document.querySelectorAll('.pc-node[data-kind]')].map(e=>e.getBoundingClientRect());
  for(let i=0;i<r.length;i++)for(let j=i+1;j<r.length;j++){
    const a=r[i],b=r[j];
    if(a.left<b.right-1&&b.left<a.right-1&&a.top<b.bottom-1&&b.top<a.bottom-1) return {i,j};
  } return null; })()`);
ok(overlap === null, 'no two nodes overlap');

const fitsOnLoad = await evalJs(`(() => {
  const s=document.querySelector('.pc-stage').getBoundingClientRect();
  const r=[...document.querySelectorAll('.pc-node[data-kind]')].map(e=>e.getBoundingClientRect());
  return r.every(b=>b.left>=s.left-1&&b.right<=s.right+1&&b.top>=s.top-1&&b.bottom<=s.bottom+1); })()`);
ok(fitsOnLoad, 'the whole plan fits inside the stage on load, unclipped');

/* A card whose content is taller than the card hides a line behind the one
   below it — which is what the per-card "ESTIMATED" caption used to do to the
   object name. */
const spilling = await evalJs(`(() => [...document.querySelectorAll('.pc-node[data-kind]')]
  .filter(e => e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1)
  .map(e => ({ t: e.textContent.slice(0, 28), dy: e.scrollHeight - e.clientHeight })))()`);
ok(spilling.length === 0,
   `no card's content spills out of it${spilling.length ? ` (${JSON.stringify(spilling.slice(0, 3))})` : ''}`);

console.log('\n=== severity and family come from the data ===');
const kinds = await evalJs(`(() => {
  const g={};
  document.querySelectorAll('.pc-node[data-kind]').forEach(e=>{g[e.dataset.kind]=(g[e.dataset.kind]||0)+1;});
  const sev={};
  document.querySelectorAll('.pc-node[data-severity]').forEach(e=>{sev[e.dataset.severity]=(sev[e.dataset.severity]||0)+1;});
  return {g,sev}; })()`);
ok(kinds.g.access === 3, 'table and index reads are classed as access');
ok(kinds.g.join >= 2, 'joins and unions are classed as joins');
ok((kinds.sev.critical || 0) >= 1, 'the costliest branch is marked critical');
ok((kinds.sev.warning || 0) >= 1, 'a full scan is marked warning');

console.log('\n=== the toolbar controls work ===');
const z0 = await zoom();
ok(typeof z0 === 'number' && z0 > 0, `the zoom readout shows a percentage (${z0}%)`);
await clickByTitle('Zoom in'); await sleep(80);
const z1 = await zoom();
ok(z1 > z0, `Zoom in increases the scale (${z0}% -> ${z1}%)`);
await clickByTitle('Zoom out'); await sleep(80);
const z2 = await zoom();
ok(z2 < z1, `Zoom out decreases it (${z1}% -> ${z2}%)`);
const t_before = await transform();
await clickByTitle('Zoom in'); await clickByTitle('Zoom in'); await sleep(80);
await clickByTitle('Fit'); await sleep(120);
const z3 = await zoom();
ok(z3 === z0, `Fit returns to the fitted zoom (${z3}%)`);
ok((await transform()) === t_before, 'Fit restores the original position too');

/* Pan by dragging, not by writing style.transform: React diffs against its
   own previous props, so an imperative style change it does not know about is
   never corrected — the test would be measuring its own edit, not Centre. */
for (const [type, x, y] of [['mousePressed', 600, 400], ['mouseMoved', 1000, 700], ['mouseReleased', 1000, 700]]) {
  await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1 });
  await sleep(40);
}
const offCentre = await evalJs(`(() => {
  const s=document.querySelector('.pc-stage').getBoundingClientRect();
  const c=document.querySelector('.pc-canvas').getBoundingClientRect();
  return Math.abs((c.left+c.right)/2-(s.left+s.right)/2); })()`);
ok(offCentre > 100, `the drag moved the plan off centre first (${offCentre.toFixed(0)}px)`);
await clickByTitle('Centre'); await sleep(120);
const centred = await evalJs(`(() => {
  const s=document.querySelector('.pc-stage').getBoundingClientRect();
  const c=document.querySelector('.pc-canvas').getBoundingClientRect();
  return Math.abs((c.left+c.right)/2-(s.left+s.right)/2); })()`);
ok(centred < 2, `Centre re-centres the plan (${centred.toFixed(1)}px off)`);

await clickByTitle('Reset'); await sleep(120);
ok((await zoom()) === z0, 'Reset returns to the fitted view');

console.log('\n=== wheel zoom and drag pan ===');
const zBeforeWheel = await zoom();
await send('Input.dispatchMouseEvent', {
  type: 'mouseWheel', x: 700, y: 400, deltaX: 0, deltaY: -240, modifiers: 2,
});
await sleep(120);
ok((await zoom()) > zBeforeWheel, `the wheel zooms in (${zBeforeWheel}% -> ${await zoom()}%)`);

await clickByTitle('Reset'); await sleep(120);
const posBefore = await evalJs('document.querySelector(".pc-canvas").getBoundingClientRect().left');
for (const [type, x, y] of [['mousePressed', 700, 500], ['mouseMoved', 820, 560], ['mouseReleased', 820, 560]]) {
  await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1 });
  await sleep(40);
}
const posAfter = await evalJs('document.querySelector(".pc-canvas").getBoundingClientRect().left');
ok(Math.abs(posAfter - posBefore - 120) < 4, `dragging pans the canvas (moved ${(posAfter - posBefore).toFixed(0)}px for a 120px drag)`);

console.log('\n=== the minimap ===');
ok(await evalJs('!!document.querySelector(".pc-minimap")'), 'a minimap is shown for a plan this size');
ok(await evalJs('document.querySelectorAll(".pc-mini-node").length >= 14'), 'it carries every node');
ok(await evalJs('!!document.querySelector(".pc-mini-view")'), 'and shows the current viewport');

console.log('\n=== selecting a node ===');
await evalJs(`(() => { const n=[...document.querySelectorAll('.pc-node[data-kind]')]
  .find(e=>e.textContent.includes('TABLE ACCESS FULL')); n.click(); return true; })()`);
await sleep(150);
const panel = await evalJs('document.querySelector("aside").textContent');
ok(/Operation details/.test(panel), 'the details panel opens');
ok(/EXP_HEAD\$/.test(panel), "it shows the selected step's object");
ok(await evalJs(`document.querySelectorAll('.pc-node[data-selected="true"]').length === 1`),
   'exactly one node reads as selected');

for (const [tab, expect] of [
  ['Predicate', /OBJ#/],
  ['Columns', /projection|not part of this plan payload/i],
  ['Statistics', /estimate/i],
  ['Details', /Operation id/],
]) {
  await evalJs(`(() => { const b=[...document.querySelectorAll('aside button')].find(x=>x.textContent.trim()===${JSON.stringify(tab)}); b.click(); return true; })()`);
  await sleep(90);
  const text = await evalJs('document.querySelector("aside").textContent');
  ok(expect.test(text), `the ${tab} tab shows its content`);
}

console.log('\n=== nothing is presented as a measurement ===');
const stage = await evalJs('document.querySelector(".pc-stage").textContent');
ok(/optimizer estimates/i.test(stage) && /not measurements/i.test(stage),
   'the stage states that the figures are optimizer estimates, not measurements');
ok(!/\bTime\b/.test(stage), 'no node claims an elapsed time — v$sql_plan has none');
await evalJs(`(() => { const b=[...document.querySelectorAll('aside button')].find(x=>x.textContent.trim()==='Statistics'); b.click(); return true; })()`);
await sleep(90);
const statsText = await evalJs('document.querySelector("aside").textContent');
ok(/STATISTICS_LEVEL=ALL|gather_plan_statistics/.test(statsText),
   'and the panel says where actual figures would come from');

console.log('\n=== the empty case ===');
await send('Page.navigate', { url: `${URL_BASE}?empty=1` });
await sleep(1500);
for (let i = 0; i < 40; i++) {
  if (await evalJs('!!document.getElementById("root") && document.getElementById("root").textContent.length > 0')) break;
  await sleep(200);
}
const emptyText = await evalJs('document.getElementById("root").textContent');
ok(/aged out of the shared pool|Nothing to diagram/.test(emptyText),
   'a plan with no rows explains why instead of rendering an empty box');

console.log(`\n  ${pass} passed, ${fail} failed`);
ws.close();
chrome.kill();
process.exit(fail ? 1 : 0);
