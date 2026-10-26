/* Measures the table, rather than looking at it: no row may be wider than the
   panel that holds it, and the header band must span the same width as the
   rows. Both were violated on the alert-log page — every cell inherited
   whitespace-nowrap, so a sentence could not wrap. */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.env.TABLE_URL || 'http://localhost:5199/src/components/ui/__tablecheck__/index.html';
const PORT = 9470;
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'tbl-'))}`, '--no-first-run', '--window-size=1440,1000', URL], { stdio: 'ignore' });
let ws;
for (let i = 0; i < 80 && !ws; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch {}
  if (!ws) await sleep(200);
}
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const js = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
for (let i = 0; i < 80; i++) { if (await js('!!document.querySelector("tbody tr")')) break; await sleep(250); }

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ', m); } else { fail++; console.log('  FAIL ', m); } };

for (const w of [1440, 1100, 820]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const g = await js(`(() => {
    const panel = document.getElementById('panel').getBoundingClientRect();
    const head = document.querySelector('thead tr').getBoundingClientRect();
    const rows = [...document.querySelectorAll('tbody tr')].map((r) => r.getBoundingClientRect());
    const cells = [...document.querySelectorAll('tbody td')].map((c) => ({ over: c.scrollWidth - c.clientWidth }));
    return { panelR: panel.right, headW: head.width, rowR: Math.max(...rows.map((r) => r.right)),
             rowW: Math.max(...rows.map((r) => r.width)), spill: Math.max(...cells.map((c) => c.over)) };
  })()`);
  console.log(`\n  ── ${w}px ──`);
  ok(g.rowR <= g.panelR + 1, `no row runs past its panel (row right ${Math.round(g.rowR)} vs panel ${Math.round(g.panelR)})`);
  ok(Math.abs(g.headW - g.rowW) < 2, `the header band spans the rows (${Math.round(g.headW)} vs ${Math.round(g.rowW)})`);
  ok(g.spill <= 1, `no cell's text spills out of it (${g.spill}px)`);
}
console.log(`\n  ${pass} passed, ${fail} failed`);
ws.close(); chrome.kill(); process.exit(fail ? 1 : 0);
