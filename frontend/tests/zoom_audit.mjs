/**
 * Browser-zoom audit — drives headless Chrome against the running app and
 * measures every page at the zoom levels people actually use.
 *
 * Browser zoom does not shrink the page; it shrinks the CSS viewport. A 1920 ×
 * 950 window at 150% is a 1280 × 633 CSS-pixel viewport drawn at 1.5× density,
 * which is exactly what this emulates. So "does it work at 175%?" becomes
 * measurable rather than a matter of squinting.
 *
 * Needs the app running (Vite on 2106; the cloud service on 8001 for real cloud
 * data). Not one of the offline `verify_*` suites for that reason.
 *
 *   node tests/zoom_audit.mjs                       every page, 100–200%
 *   node tests/zoom_audit.mjs --pages events,cost   a subset (names below)
 *   node tests/zoom_audit.mjs --zooms 1,1.5,2       chosen zoom levels
 *   node tests/zoom_audit.mjs --shots out/dir       also save screenshots
 *   node tests/zoom_audit.mjs --json report.json    full findings as JSON
 *
 * Per page and zoom it reports:
 *   overflowX    document / <main> wider than the viewport — <main> clips with
 *                overflow-x:hidden, so that width is content nobody can reach
 *   offscreen    visible elements past the right edge with no scrolling
 *                ancestor to bring them back
 *   hiddenScroll scroll strips that overflow behind a hidden scrollbar
 *   covered      controls whose centre is painted over by something else
 *   chrome%      share of the viewport height taken by the pinned nav + header
 *   tiny         visible text nodes rendered below 11px (and below 12px)
 *
 * Exit code is 1 when any page breaks a hard rule (overflow, offscreen,
 * covered controls, pinned chrome over 45% of the viewport).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE = process.env.ZOOM_AUDIT_BASE || 'http://localhost:2106';
const ACCOUNT = process.env.ZOOM_AUDIT_ACCOUNT || '79142744-5f10-4639-a217-ebfe37d757ba';
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SCREEN = { w: 1920, h: 950 };

const acct = (tab) => `/cloud/oci-accounts/${ACCOUNT}/${tab}`;
const PAGES = {
  'cloud-overview': acct('overview'),
  intelligence: acct('intelligence'),
  resources: acct('resources'),
  cost: acct('cost'),
  security: acct('security'),
  'security-certs': `${acct('security')}?view=certificates`,
  'security-compliance': `${acct('security')}?view=compliance`,
  topology: acct('topology'),
  drift: acct('drift'),
  events: acct('events'),
  'cloud-alerts': acct('alerts'),
  cloud: '/cloud',
  'oci-accounts': '/cloud/oci-accounts',
  'cloud-resources': '/cloud/resources',
  certificates: '/cloud/certificates',
  clients: '/cloud/clients',
  dashboard: '/dashboard',
  databases: '/databases',
  agents: '/agents',
  infra: '/infra',
  alerts: '/alerts',
  administration: '/administration',
  settings: '/settings',
  help: '/help-center',
};

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};
const pageNames = opt('pages') ? opt('pages').split(',') : Object.keys(PAGES);
const zooms = (opt('zooms') || '1,1.25,1.5,1.75,2').split(',').map(Number);
const shotsDir = opt('shots');
const jsonOut = opt('json');
const settleMs = Number(opt('settle') || 9000);

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/* ── the in-page measurement ─────────────────────────────────────────────── */
// Serialised into the page. Plain ES2020, no closures over node scope.
const MEASURE = String.raw`(() => {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const main = document.querySelector('main');
  const describe = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = (typeof el.className === 'string' ? el.className : '')
      .split(/\s+/).filter(Boolean).slice(0, 4).join('.');
    const text = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return el.tagName.toLowerCase() + id + (cls ? '.' + cls : '') + (text ? ' "' + text + '"' : '');
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const scrollsX = (el) => {
    const o = getComputedStyle(el).overflowX;
    return o === 'auto' || o === 'scroll';
  };
  const clipsX = (el) => getComputedStyle(el).overflowX === 'hidden';
  const out = { vw, vh };

  out.docOverflowX = Math.max(0, document.documentElement.scrollWidth - vw);
  out.mainOverflowX = main ? Math.max(0, main.scrollWidth - main.clientWidth) : 0;

  const nav = document.querySelector('header');
  out.navH = nav ? Math.round(nav.getBoundingClientRect().height) : 0;
  const ph = document.querySelector('.page-header');
  out.headerH = ph ? Math.round(ph.getBoundingClientRect().height) : 0;
  out.headerPinned = !!ph && getComputedStyle(ph).position === 'sticky';
  out.chromePct = Math.round(100 * (out.navH + (out.headerPinned ? out.headerH : 0)) / vh);

  const all = [...document.querySelectorAll('body *')];

  // Past the right edge, with nothing between it and <main> able to scroll it
  // into view. Only the outermost offender is reported, not its descendants.
  const offscreen = [];
  for (const el of all) {
    if (!visible(el)) continue;
    // SVG clips its own content (a pannable canvas); the <svg> box is what counts.
    if (el.tagName !== 'svg' && el.closest('svg')) continue;
    const r = el.getBoundingClientRect();
    if (r.right <= vw + 1 || r.left >= vw) continue;
    let a = el.parentElement; let rescued = false;
    while (a && a !== document.body) {
      if (scrollsX(a) && a !== main) { rescued = true; break; }
      a = a.parentElement;
    }
    if (rescued) continue;
    if (offscreen.some((o) => o.el.contains(el))) continue;
    offscreen.push({ el, over: Math.round(r.right - vw) });
  }
  out.offscreen = offscreen.slice(0, 8).map((o) => describe(o.el) + ' +' + o.over + 'px');
  out.offscreenCount = offscreen.length;

  // Scroll strips whose overflow sits behind a hidden scrollbar, and boxes that
  // clip content with overflow-x:hidden (ellipsis text is fine and excluded).
  const hidden = [];
  for (const el of all) {
    if (el === main || !visible(el)) continue;
    const over = el.scrollWidth - el.clientWidth;
    if (over < 4 || el.clientWidth === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.textOverflow === 'ellipsis' || cs.webkitLineClamp !== 'none') continue;
    if (scrollsX(el) && cs.scrollbarWidth === 'none') hidden.push(describe(el) + ' hidden-scrollbar +' + over + 'px');
    else if (clipsX(el) && el.children.length) hidden.push(describe(el) + ' clipped +' + over + 'px');
  }
  out.hiddenScroll = hidden.slice(0, 8);
  out.hiddenScrollCount = hidden.length;

  // Controls painted over by something that is not part of them — the floating
  // assistant over a nav item, a pinned header over a button. Measured at the
  // scroll position the page loads at.
  const covered = [];
  let underFloating = 0;
  for (const el of document.querySelectorAll('a[href], button, input, select, [role="tab"]')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2; const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x >= vw || y >= vh) continue;
    const top = document.elementFromPoint(x, y);
    if (!top || el.contains(top) || top.contains(el)) continue;
    if (el.closest('label') && el.closest('label').contains(top)) continue;
    // A floating launcher over page content is expected; content scrolls out
    // from under it (the content shell reserves clearance). Counted, not failed.
    if (top.closest('[data-floating]')) { underFloating += 1; continue; }
    const host = top.closest('svg') ? top.closest('svg').parentElement : top;
    covered.push(describe(el) + ' under ' + describe(host));
  }
  out.covered = covered.slice(0, 8);
  out.coveredCount = covered.length;
  out.underFloating = underFloating;

  // Rendered text size. Text in the viewport only.
  let t11 = 0; let t12 = 0; let total = 0; let svgTiny = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const tinySamples = [];
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (!n.textContent.trim()) continue;
    const p = n.parentElement;
    if (!p || !visible(p)) continue;
    const r = p.getBoundingClientRect();
    if (r.bottom < 0 || r.top > vh) continue;
    const fs = parseFloat(getComputedStyle(p).fontSize);
    // Text drawn inside a chart or canvas scales with it; reported apart.
    if (p.closest('svg')) { if (fs < 11) svgTiny += 1; continue; }
    total += 1;
    if (fs < 11) { t11 += 1; if (tinySamples.length < 5) tinySamples.push(fs + 'px "' + n.textContent.trim().slice(0, 24) + '"'); }
    if (fs < 12) t12 += 1;
  }
  out.text = { total, below11: t11, below12: t12, svgBelow11: svgTiny, samples: tinySamples };
  return out;
})()`;

/* ── CDP plumbing ────────────────────────────────────────────────────────── */
async function main() {
  const profile = join(tmpdir(), `zoom-audit-${Date.now()}`);
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--hide-scrollbars=false', '--window-size=1920,950', 'about:blank',
  ], { stdio: 'ignore' });

  let tabs = null;
  for (let i = 0; i < 60 && !tabs; i += 1) {
    try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(250); }
  }
  const page = tabs.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let seq = 0; const waiting = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    seq += 1; waiting.set(seq, resolve);
    ws.send(JSON.stringify({ id: seq, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  };
  const setZoom = (z) => send('Emulation.setDeviceMetricsOverride', {
    width: Math.round(SCREEN.w / z), height: Math.round(SCREEN.h / z),
    deviceScaleFactor: z, mobile: false,
  });

  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  const report = [];
  let hardFails = 0;

  for (const name of pageNames) {
    const path = PAGES[name];
    if (!path) { console.log(`unknown page ${name}`); continue; }
    await setZoom(zooms[0]);
    await send('Page.navigate', { url: BASE + path });
    // Wait for the page itself, not a fixed delay: the first visit to a lazy
    // route pays for compiling its chunk, and measuring a spinner proves nothing.
    const started = Date.now();
    while (Date.now() - started < 45_000) {
      await sleep(500);
      // Ready = real content and no loading placeholder left anywhere in it
      // (a header renders long before a slow panel like Cost Intelligence).
      const ready = await evaluate(`(() => { const m = document.querySelector('main'); if (!m) return false; const t = m.innerText; return t.trim().length > 40 && !/\\bLoading\\b/.test(t); })()`).catch(() => false);
      if (ready) break;
    }
    await sleep(settleMs);
    console.log(`\n${name}  ${path}`);
    for (const z of zooms) {
      await setZoom(z);
      await sleep(1200);
      await evaluate('document.querySelector("main") && document.querySelector("main").scrollTo(0, 0)');
      await sleep(200);
      const m = await evaluate(MEASURE);
      const fails = [];
      if (m.docOverflowX > 1 || m.mainOverflowX > 1) fails.push(`overflowX doc ${m.docOverflowX} main ${m.mainOverflowX}`);
      if (m.offscreenCount) fails.push(`offscreen ${m.offscreenCount}`);
      if (m.coveredCount) fails.push(`covered ${m.coveredCount}`);
      if (m.chromePct > 45) fails.push(`chrome ${m.chromePct}%`);
      hardFails += fails.length ? 1 : 0;
      const pct = m.text.total ? Math.round(100 * m.text.below12 / m.text.total) : 0;
      console.log(`  ${String(Math.round(z * 100)).padStart(3)}%  ${m.vw}x${m.vh}  `
        + `chrome ${m.chromePct}%${m.headerPinned ? ' (pinned)' : ''}  hiddenScroll ${m.hiddenScrollCount}  `
        + `text<12px ${pct}% (<11px ${m.text.below11})${m.underFloating ? `  underLauncher ${m.underFloating}` : ''}  ${fails.length ? 'FAIL ' + fails.join('; ') : 'ok'}`);
      for (const line of [...m.offscreen, ...m.covered, ...m.hiddenScroll].slice(0, 6)) console.log(`        · ${line}`);
      report.push({ page: name, path, zoom: z, ...m, fails });
      if (shotsDir) {
        const shot = await send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(shotsDir, `${name}@${Math.round(z * 100)}.png`), Buffer.from(shot.result.data, 'base64'));
      }
    }
  }

  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  console.log(`\n=== ${report.length} page×zoom checks, ${hardFails} with hard failures ===`);
  ws.close();
  chrome.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* chrome may still hold it */ }
  process.exit(hardFails ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
