/* Drive headless Chrome over the harness at each width the brief names, and
   assert the acceptance criteria from the measured geometry. */
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const HARNESS = join(import.meta.dirname, 'harness.html');
const MEASURE = readFileSync(join(import.meta.dirname, 'measure.js'), 'utf8');
const WIDTHS = [1920, 1600, 1366, 1024, 820, 390];

const PORT = 9333;
const profile = mkdtempSync(join(tmpdir(), 'raclayout-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--force-prefers-reduced-motion',
  `file:///${HARNESS.replace(/\\/g, '/')}`,
], { stdio: 'ignore' });

async function cdp() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Chrome did not expose a debugging target');
}

const ws = new WebSocket(await cdp());
await new Promise((res) => { ws.onopen = res; });
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

/* The harness is a large inlined stylesheet; without waiting, the first
   measurement can land before the document has finished parsing and the
   elements it looks for do not exist yet. */
for (let i = 0; i < 100; i++) {
  const r = await send('Runtime.evaluate', {
    expression: 'document.readyState === "complete" && !!document.querySelector("[data-storage]")',
    returnByValue: true,
  });
  if (r.result?.result?.value === true) break;
  await sleep(100);
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('    PASS ', m); } else { fail++; console.log('    FAIL ', m); } };

for (const width of WIDTHS) {
  await send('Emulation.setDeviceMetricsOverride', {
    width, height: 1200, deviceScaleFactor: 1, mobile: width < 700,
  });
  await sleep(120);
  const res = await send('Runtime.evaluate', { expression: MEASURE, returnByValue: true, awaitPromise: false });
  const g = res.result?.result?.value;
  if (!g) { console.log(`\n  ${width}px — measurement failed`, JSON.stringify(res).slice(0, 300)); fail++; continue; }

  const stacked = width < 1024;
  console.log(`\n  ── ${width}px ${stacked ? '(stacked)' : '(three columns)'} ──`);

  ok(g.overflowing.length === 0,
     `nothing overflows its box${g.overflowing.length ? ` (${JSON.stringify(g.overflowing.slice(0, 3))})` : ''}`);
  ok(g.clipped.length === 0,
     `no text is clipped${g.clipped.length ? ` (${JSON.stringify(g.clipped.slice(0, 3))})` : ''}`);
  ok(g.interChildrenOutside.length === 0,
     `every interconnect label stays inside its column${g.interChildrenOutside.length ? ` (${g.interChildrenOutside.map((x) => x.label)})` : ''}`);

  if (!stacked) {
    ok(g.gapN1toInter >= -0.5 && g.gapIntertoN2 >= -0.5,
       `the interconnect column touches neither card (${g.gapN1toInter.toFixed(1)}px / ${g.gapIntertoN2.toFixed(1)}px)`);
    ok(g.node1.r <= g.node2.l,
       'the two node cards do not overlap each other');
    ok(g.widths.delta < 1,
       `both cards have equal width (${g.widths.n1.toFixed(0)}px vs ${g.widths.n2.toFixed(0)}px)`);
    ok(g.widths.inter >= 180 && g.widths.inter <= 240,
       `the centre column stays within 180–240px (${g.widths.inter.toFixed(0)}px)`);
    ok(Math.abs(g.rail.l - g.node1.r) < 1.5 && Math.abs(g.node2.l - g.rail.r) < 1.5,
       `the rail spans exactly card edge to card edge (${g.railVsCards.railLeftMinusNode1Right.toFixed(1)}px / ${g.railVsCards.node2LeftMinusRailRight.toFixed(1)}px)`);
    const mid = (g.node1.r + g.node2.l) / 2;
    ok(Math.abs((g.inter.l + g.inter.r) / 2 - mid) < 1,
       'the interconnect is centred between the cards');
  } else {
    ok(g.node1.b <= g.node2.t, 'stacked cards do not overlap vertically');
    ok(g.widths.delta < 1, 'stacked cards keep equal width');
  }

  ok(g.storageClearance.belowConn >= -0.5,
     `the storage card clears the connector row (${g.storageClearance.belowConn.toFixed(1)}px)`);
  ok(g.storageClearance.legendGap > 8,
     `the legend is clear of the storage card (${g.storageClearance.legendGap.toFixed(1)}px)`);
  ok(Math.abs((g.storage.l + g.storage.r) / 2 - (g.conn.l + g.conn.r) / 2) < 1,
     'the storage card is centred');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
ws.close();
chrome.kill();
process.exit(fail ? 1 : 0);
