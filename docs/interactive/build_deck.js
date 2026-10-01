/* ACTMON stakeholder deck.
   Every figure here came from the repository inspection recorded in
   docs/interactive/actmon-*.js. Nothing is invented, and illustrative
   examples are labelled on the slide that uses them. */
const pptx = require('pptxgenjs');
const p = new pptx();

p.layout = 'LAYOUT_WIDE';            // 13.3 x 7.5 — set BEFORE any slide
p.author = 'ACTMON';
p.company = 'Actin';
p.title = 'ACTMON — Unified Monitoring Platform';

/* ── palette: the product's own dark navy and cyan ───────────────────── */
const NAVY = '0F1C34', NAVY2 = '16294A', INK = '0A1322';
const CYAN = '0E9FD6', CYAN_L = '7FD3F2';
const ICE = 'EEF4FB', WHITE = 'FFFFFF';
const BODY = '27384F', MUTED = '5A6E8C', LINE = 'C9D8E8';
const OK = '1E8E5A', WARN = 'B8760D', BAD = 'C2344A', GREY = '7A8BA3';

const H = 'Cambria', B = 'Calibri';     // safe-list pair
const W = 13.33, HT = 7.5;

/* ── helpers ─────────────────────────────────────────────────────────── */
const T = (s, text, o) => s.addText(text, Object.assign({ isTextBox: true, fontFace: B, color: BODY }, o));

function darkSlide() {
  const s = p.addSlide();
  s.background = { color: NAVY };
  return s;
}
function lightSlide(title, kicker) {
  const s = p.addSlide();
  s.background = { color: WHITE };
  if (kicker) {
    T(s, kicker.toUpperCase(), {
      x: 0.6, y: 0.42, w: 11.5, h: 0.3, fontSize: 11, bold: true,
      color: CYAN, charSpacing: 2, fontFace: B, margin: 0,
    });
  }
  if (title) {
    T(s, title, {
      x: 0.6, y: kicker ? 0.72 : 0.5, w: 12.1, h: 0.75,
      fontSize: 32, bold: true, color: NAVY, fontFace: H, margin: 0,
    });
  }
  return s;
}

/** The deck's one repeated motif: a numbered disc beside a titled block. */
function discBlock(s, n, x, y, w, title, body, tone) {
  const c = tone || CYAN;
  s.addShape(p.ShapeType.ellipse, {
    x: x, y: y, w: 0.46, h: 0.46, fill: { color: c },
  });
  T(s, String(n), {
    x: x, y: y + 0.04, w: 0.46, h: 0.38, fontSize: 15, bold: true,
    color: WHITE, align: 'center', fontFace: B, margin: 0,
  });
  T(s, title, {
    x: x + 0.62, y: y - 0.02, w: w - 0.62, h: 0.32, fontSize: 15, bold: true,
    color: NAVY, fontFace: B, margin: 0,
  });
  T(s, body, {
    x: x + 0.62, y: y + 0.32, w: w - 0.62, h: 0.9, fontSize: 12.5,
    color: BODY, fontFace: B, margin: 0, lineSpacingMultiple: 1.12,
  });
}

function statCard(s, x, y, w, h, value, label, sub, tone) {
  s.addShape(p.ShapeType.roundRect, {
    x: x, y: y, w: w, h: h, rectRadius: 0.08,
    fill: { color: ICE }, line: { color: LINE, width: 1 },
  });
  T(s, value, {
    x: x + 0.18, y: y + 0.14, w: w - 0.36, h: 0.62, fontSize: 30, bold: true,
    color: tone || NAVY, fontFace: H, margin: 0,
  });
  T(s, label, {
    x: x + 0.18, y: y + 0.78, w: w - 0.36, h: 0.26, fontSize: 12, bold: true,
    color: NAVY, fontFace: B, margin: 0,
  });
  if (sub) {
    T(s, sub, {
      x: x + 0.18, y: y + 1.04, w: w - 0.36, h: h - 1.14, fontSize: 10.5,
      color: MUTED, fontFace: B, margin: 0, lineSpacingMultiple: 1.1,
    });
  }
}

function card(s, x, y, w, h, title, lines, tone) {
  s.addShape(p.ShapeType.roundRect, {
    x: x, y: y, w: w, h: h, rectRadius: 0.08,
    fill: { color: WHITE }, line: { color: LINE, width: 1 },
    shadow: { type: 'outer', angle: 90, blur: 6, offset: 1, color: 'A9BDD4', opacity: 0.35 },
  });
  s.addShape(p.ShapeType.ellipse, { x: x + 0.22, y: y + 0.22, w: 0.3, h: 0.3, fill: { color: tone || CYAN } });
  T(s, title, {
    x: x + 0.62, y: y + 0.19, w: w - 0.82, h: 0.34, fontSize: 14, bold: true,
    color: NAVY, fontFace: B, margin: 0,
  });
  T(s, lines.map((l, i) => ({ text: l, options: { bullet: true, breakLine: i < lines.length - 1 } })), {
    x: x + 0.3, y: y + 0.62, w: w - 0.56, h: h - 0.8, fontSize: 11.5,
    color: BODY, fontFace: B, margin: 0, paraSpaceAfter: 5,
  });
}

function pill(s, x, y, text, tone) {
  // 0.085"/char at 10pt Calibri plus padding. The earlier 0.17 was double the
  // real glyph width, which pushed one pill past its card edge and ran the
  // channel row off the slide entirely.
  const w = Math.max(0.62, 0.085 * text.length + 0.34);
  s.addShape(p.ShapeType.roundRect, {
    x: x, y: y, w: w, h: 0.3, rectRadius: 0.15,
    fill: { color: WHITE }, line: { color: tone, width: 1 },
  });
  T(s, text, {
    x: x, y: y + 0.03, w: w, h: 0.24, fontSize: 10, bold: true,
    color: tone, align: 'center', fontFace: B, margin: 0,
  });
  return w;
}

function footnote(s, text) {
  T(s, text, {
    x: 0.6, y: 6.86, w: 12.1, h: 0.34, fontSize: 9.5, italic: true,
    color: MUTED, fontFace: B, margin: 0,
  });
}

/* ═══ 1. title ═══════════════════════════════════════════════════════ */
{
  const s = darkSlide();
  s.addShape(p.ShapeType.ellipse, { x: 9.6, y: -1.6, w: 6.4, h: 6.4, fill: { color: NAVY2 } });
  s.addShape(p.ShapeType.ellipse, { x: 11.0, y: -0.3, w: 2.2, h: 2.2, fill: { color: CYAN }, });
  T(s, 'PRODUCT OVERVIEW', {
    x: 0.9, y: 2.0, w: 8, h: 0.3, fontSize: 12, bold: true, color: CYAN_L, charSpacing: 3, margin: 0,
  });
  T(s, 'ACTMON', {
    x: 0.9, y: 2.42, w: 9, h: 1.3, fontSize: 60, bold: true, color: WHITE, fontFace: H,
    charSpacing: 6, margin: 0,
  });
  T(s, 'Unified database, cloud and infrastructure monitoring', {
    x: 0.9, y: 3.72, w: 8.6, h: 0.5, fontSize: 20, color: CYAN_L, fontFace: B, margin: 0,
  });
  T(s, 'One tool for the database, the host it runs on, and the cloud account that pays for it.', {
    x: 0.9, y: 4.3, w: 8.4, h: 0.6, fontSize: 14, color: 'B9CBE2', fontFace: B, margin: 0,
  });
  T(s, 'Built from source-code inspection  ·  branch actmon_sept22', {
    x: 0.9, y: 6.5, w: 9, h: 0.3, fontSize: 11, color: '8EA6C4', fontFace: B, margin: 0,
  });
  s.addNotes('Opening slide. ACTMON is a monitoring platform covering three domains that are normally three separate tools. Everything in this deck was verified against the source code.');
}

/* ═══ 2. the problem ═════════════════════════════════════════════════ */
{
  const s = lightSlide('Four problems this solves', 'Why ACTMON exists');
  const items = [
    ['Three tools, three truths', 'Database metrics in one tool, host metrics in another, cloud inventory in a third. Correlating an incident means three logins and a guess.'],
    ['Failures that are invisible', 'A blocked query burns no CPU. A stopped replica is silent until you need it. A WAL archive fills a disk weeks after the first warning sign.'],
    ['Unowned cloud drift', 'Resources appear faster than anyone tracks them. You cannot monitor or cost-control a resource nobody knew existed.'],
    ['Opinion instead of evidence', '"The database is slow" has to become a specific statement about a specific object, with the number that proves it.'],
  ];
  items.forEach((it, i) => {
    discBlock(s, i + 1, i % 2 ? 7.0 : 0.6, 1.95 + Math.floor(i / 2) * 2.1, 5.8, it[0], it[1]);
  });
  s.addNotes('Four concrete problems. The second is the one DBAs recognise instantly — the failure modes that produce no obvious signal.');
}

/* ═══ 3. domains ═════════════════════════════════════════════════════ */
{
  const s = lightSlide('Seven monitoring domains', 'What it covers');
  const doms = [
    ['Database Monitoring', ['Eight technology entries', 'Seven with their own dashboard'], CYAN],
    ['Cloud Monitoring', ['AWS, Azure and OCI', 'Discovery and inventory'], '6F7CF7'],
    ['Infrastructure', ['Nine host sections', 'CPU, disk, services, config files'], OK],
    ['Agents & Collection', ['Agent, SSH or direct', 'Windows MSI, Linux .deb/.rpm'], '2A9FBF'],
    ['Alerts & Notifications', ['43 rule types, 9 channels', 'Evaluation tier shown per rule'], WARN],
    ['Logs & Diagnostics', ['Per-engine log readers', 'Severity, SQLSTATE, context'], '8B6FD4'],
    ['Administration & Access', ['Permission bitmask per page', 'Encrypted credentials, audit log'], 'C2567A'],
  ];
  doms.slice(0, 4).forEach((d, i) => card(s, 0.6 + i * 3.08, 1.9, 2.88, 2.1, d[0], d[1], d[2]));
  doms.slice(4).forEach((d, i) => card(s, 0.6 + i * 3.08, 4.25, 2.88, 2.1, d[0], d[1], d[2]));
  footnote(s, 'Source: frontend/src/config/navigation.js and the route table in App.jsx.');
  s.addNotes('Seven domains. Each is a genuine module with its own routes and backend services, not a menu label.');
}

/* ═══ 4. architecture ════════════════════════════════════════════════ */
{
  const s = lightSlide('How a measurement reaches the screen', 'Architecture');
  const steps = [
    ['Monitored system', 'Database, host or cloud account'],
    ['Collection', 'Agent, SSH or provider API'],
    ['Backend', 'FastAPI services, classification'],
    ['Storage', 'Redis, ClickHouse, PostgreSQL'],
    ['Dashboard', 'React frontend'],
    ['Alerts', 'Rule evaluation, notification'],
  ];
  const bw = 1.92, gap = 0.12;
  steps.forEach((st, i) => {
    const x = 0.6 + i * (bw + gap);
    s.addShape(p.ShapeType.roundRect, {
      x: x, y: 2.1, w: bw, h: 1.5, rectRadius: 0.08,
      fill: { color: i === 0 ? NAVY : ICE }, line: { color: i === 0 ? NAVY : LINE, width: 1 },
    });
    T(s, st[0], {
      x: x + 0.12, y: 2.28, w: bw - 0.24, h: 0.5, fontSize: 12.5, bold: true,
      color: i === 0 ? WHITE : NAVY, fontFace: B, margin: 0,
    });
    T(s, st[1], {
      x: x + 0.12, y: 2.78, w: bw - 0.24, h: 0.72, fontSize: 10.5,
      color: i === 0 ? 'C9DCF0' : MUTED, fontFace: B, margin: 0, lineSpacingMultiple: 1.1,
    });
    if (i < steps.length - 1) {
      T(s, '>', { x: x + bw, y: 2.62, w: gap + 0.08, h: 0.4, fontSize: 15, bold: true, color: CYAN, align: 'center', fontFace: B, margin: 0 });
    }
  });
  T(s, 'Storage is deliberately split across three technologies', {
    x: 0.6, y: 4.1, w: 12.1, h: 0.35, fontSize: 15, bold: true, color: NAVY, fontFace: B, margin: 0,
  });
  const tiers = [
    ['Redis', 'Hot tier', 'Latest value plus a one-hour ring. This is what a live dashboard reads.'],
    ['ClickHouse', 'History', 'Per-module, per-technology tables holding what the hot tier displaced.'],
    ['PostgreSQL', 'Configuration', 'Connections, roles, permissions, alert rules and audit records.'],
  ];
  tiers.forEach((t, i) => {
    statCard(s, 0.6 + i * 4.08, 4.58, 3.88, 1.9, t[0], t[1], t[2], CYAN);
  });
  footnote(s, 'Verified against services/common/metrics_pipeline.py and services/common/db_proxy_service.py.');
  s.addNotes('The three-tier storage split answers three different questions: what is it now, what was it last Tuesday, and what must survive a restart.');
}

/* ═══ 5. collection methods ══════════════════════════════════════════ */
{
  const s = lightSlide('Not everything uses an agent', 'How ACTMON connects');
  card(s, 0.6, 1.95, 3.88, 2.5, 'Installed agent', [
    'A collector on the monitored host',
    'Windows: MSI behind a .bat',
    'Linux: .deb / .rpm behind a shell script',
    'Enrolled with a single-use token',
  ], CYAN);
  card(s, 4.72, 1.95, 3.88, 2.5, 'Server-direct', [
    'ACTMON connects from its own server',
    'Nothing installed on the target',
    'MySQL, MariaDB and PostgreSQL only',
    'Never when the host is loopback',
  ], WARN);
  card(s, 8.84, 1.95, 3.88, 2.5, 'Provider API', [
    'Cloud accounts only',
    'Authenticates and walks regions',
    'Nothing installed at all',
  ], '6F7CF7');
  s.addShape(p.ShapeType.roundRect, {
    x: 0.6, y: 4.75, w: 12.12, h: 1.55, rectRadius: 0.08,
    fill: { color: ICE }, line: { color: LINE, width: 1 },
  });
  T(s, 'Why server-direct is restricted', {
    x: 0.9, y: 4.95, w: 11.5, h: 0.3, fontSize: 14, bold: true, color: NAVY, fontFace: B, margin: 0,
  });
  T(s, 'On a loopback host, "localhost" means the agent machine — a different computer from the ACTMON server. '
    + 'A direct attempt there can only mislead: at best it fails with an unrelated error, at worst it silently '
    + 'monitors the wrong database. SQL Server, Oracle, MongoDB and ClickHouse are reached through the agent path.', {
    x: 0.9, y: 5.3, w: 11.5, h: 0.85, fontSize: 12.5, color: BODY, fontFace: B, margin: 0, lineSpacingMultiple: 1.15,
  });
  footnote(s, 'Source: services/common/db_proxy_service.py — _DIRECT_CAPABLE and _can_go_direct.');
  s.addNotes('Important for a client conversation: ask whether their databases are bound to localhost, because that decides whether an agent is required.');
}

/* ═══ 6. database technologies ═══════════════════════════════════════ */
{
  const s = lightSlide('Eight database technologies', 'Database monitoring');
  const engines = [
    ['PostgreSQL', '16 + 1', 'agent or direct', OK],
    ['Oracle', '20', 'agent only', OK],
    ['SQL Server', '16', 'agent only', OK],
    ['MySQL', '15', 'agent or direct', OK],
    ['MariaDB', '15', 'via MySQL path', WARN],
    ['MongoDB', '14', 'agent only', OK],
    ['ClickHouse', '13', 'agent only', OK],
    ['Azure Cosmos DB', '9', 'agent only', OK],
  ];
  engines.forEach((e, i) => {
    const x = 0.6 + (i % 4) * 3.08, y = 1.95 + Math.floor(i / 4) * 1.72;
    s.addShape(p.ShapeType.roundRect, {
      x: x, y: y, w: 2.88, h: 1.5, rectRadius: 0.08,
      fill: { color: WHITE }, line: { color: LINE, width: 1 },
    });
    T(s, e[0], { x: x + 0.2, y: y + 0.16, w: 2.5, h: 0.32, fontSize: 13.5, bold: true, color: NAVY, fontFace: B, margin: 0 });
    T(s, e[1], { x: x + 0.2, y: y + 0.5, w: 1.2, h: 0.42, fontSize: 22, bold: true, color: CYAN, fontFace: H, margin: 0 });
    T(s, 'sections', { x: x + 0.2, y: y + 0.93, w: 1.4, h: 0.24, fontSize: 10, color: MUTED, fontFace: B, margin: 0 });
    const pLabel = e[3] === WARN ? 'Partial' : 'Full';
    const pW = Math.max(0.62, 0.085 * pLabel.length + 0.34);
    pill(s, x + 2.88 - 0.2 - pW, y + 0.58, pLabel, e[3]);   // right-aligned in the card
    T(s, e[2], { x: x + 0.2, y: y + 1.16, w: 2.5, h: 0.24, fontSize: 9.5, color: MUTED, fontFace: B, margin: 0 });
  });
  T(s, 'Each dashboard uses that engine\'s own vocabulary — SQL Server says Logins and Always On, MongoDB says '
    + 'Collections. Renaming them to match PostgreSQL would misrepresent the product.', {
    x: 0.6, y: 5.5, w: 12.1, h: 0.6, fontSize: 12.5, color: BODY, fontFace: B, margin: 0, lineSpacingMultiple: 1.15,
  });
  footnote(s, 'Section counts read from each engine\'s own nav config. PostgreSQL has 16 dashboard tabs plus a Query Analysis detail page.');
  s.addNotes('Eight entries, seven dashboards. MariaDB is handled through the MySQL code path and is marked partial for that reason.');
}

/* ═══ 7. not supported ═══════════════════════════════════════════════ */
{
  const s = lightSlide('What ACTMON does not do', 'Stated plainly');
  T(s, 'A product overview that only lists strengths is not useful in a procurement conversation. These are '
    + 'the limits, taken from the code rather than from a roadmap.', {
    x: 0.6, y: 1.9, w: 12.1, h: 0.5, fontSize: 13.5, color: BODY, fontFace: B, margin: 0,
  });
  const gaps = [
    ['Google Cloud Platform', 'Not implemented', 'The cloud service contains providers for AWS, Azure and OCI only. There is no GCP provider, scanner or authentication module, so Cloud SQL and other GCP services are not discoverable.'],
    ['Redis as a monitored database', 'Not a monitored technology', 'Redis appears in the codebase twice for unrelated reasons: as ACTMON\'s own hot metrics tier, and as an Azure resource the scanner inventories. Neither is database monitoring.'],
    ['25 of 43 alert rule types', 'No data source yet', 'A rule in this tier can be created and saved and will look configured, but the backend cannot raise it. The product shows this tier in its own UI so the gap is visible before it matters.'],
    ['Cloud cost budgets', 'API not integrated', 'Cost data is collected, but each provider\'s Budgets API is explicitly listed as not integrated in the capability declaration.'],
  ];
  gaps.forEach((g, i) => {
    const y = 2.6 + i * 1.08;
    s.addShape(p.ShapeType.roundRect, {
      x: 0.6, y: y, w: 12.12, h: 0.95, rectRadius: 0.06,
      fill: { color: WHITE }, line: { color: LINE, width: 1 },
    });
    T(s, g[0], { x: 0.85, y: y + 0.13, w: 3.3, h: 0.3, fontSize: 13, bold: true, color: NAVY, fontFace: B, margin: 0 });
    pill(s, 0.85, y + 0.5, g[1], i === 3 ? WARN : BAD);
    T(s, g[2], { x: 4.4, y: y + 0.14, w: 8.1, h: 0.7, fontSize: 11.5, color: BODY, fontFace: B, margin: 0, lineSpacingMultiple: 1.1 });
  });
  s.addNotes('Lead with this in a client meeting rather than letting them find it. The alert-tier point is the one that matters operationally.');
}

/* ═══ 8. dashboard KPIs ══════════════════════════════════════════════ */
{
  const s = lightSlide('Every number on the dashboard is defined', 'Dashboard');
  T(s, 'Six headline counts, three resource gauges and five charts. Each one is documented with its scope, '
    + 'formula, data source, refresh interval and how to verify it independently.', {
    x: 0.6, y: 1.9, w: 12.1, h: 0.5, fontSize: 13.5, color: BODY, fontFace: B, margin: 0,
  });
  const kpis = [
    ['Database Server', 'Hosts running a database engine, bucketed by service state'],
    ['Infra Hosts', 'Registered OS hosts, with a connected-share percentage'],
    ['Cloud Accounts', 'Registered accounts — not resources'],
    ['Agents', 'Installed agent processes, not saved connections'],
    ['SSH Hosts', 'Hosts collected over SSH'],
    ['Active Alerts', 'Firing alerts, split by severity'],
  ];
  kpis.forEach((k, i) => {
    const x = 0.6 + (i % 3) * 4.08, y = 2.6 + Math.floor(i / 3) * 1.12;
    s.addShape(p.ShapeType.roundRect, { x: x, y: y, w: 3.88, h: 0.98, rectRadius: 0.06, fill: { color: ICE }, line: { color: LINE, width: 1 } });
    T(s, k[0], { x: x + 0.2, y: y + 0.12, w: 3.5, h: 0.28, fontSize: 13, bold: true, color: NAVY, fontFace: B, margin: 0 });
    T(s, k[1], { x: x + 0.2, y: y + 0.42, w: 3.5, h: 0.46, fontSize: 10.5, color: MUTED, fontFace: B, margin: 0, lineSpacingMultiple: 1.08 });
  });
  T(s, 'Refresh is not uniform', { x: 0.6, y: 5.0, w: 12.1, h: 0.32, fontSize: 15, bold: true, color: NAVY, fontFace: B, margin: 0 });
  const refresh = [['Alerts', '15 s'], ['Summary', '30 s'], ['Agents', '30 s'], ['Hosts', '60 s'], ['Cloud', '60 s']];
  refresh.forEach((r, i) => {
    const x = 0.6 + i * 2.46;
    s.addShape(p.ShapeType.roundRect, { x: x, y: 5.42, w: 2.26, h: 0.88, rectRadius: 0.06, fill: { color: WHITE }, line: { color: LINE, width: 1 } });
    T(s, r[1], { x: x + 0.15, y: 5.52, w: 1.96, h: 0.42, fontSize: 20, bold: true, color: CYAN, fontFace: H, margin: 0 });
    T(s, r[0], { x: x + 0.15, y: 5.95, w: 1.96, h: 0.26, fontSize: 11, color: MUTED, fontFace: B, margin: 0 });
  });
  footnote(s, 'The five feeds poll independently, so two tiles can disagree briefly. That is expected, not a fault.');
  s.addNotes('The refresh table pre-empts the most common support question: why do two numbers on the same screen disagree.');
}

/* ═══ 9. worked metric: Avg CPU ══════════════════════════════════════ */
{
  const s = lightSlide('Worked example: Avg. CPU Usage', 'How a metric is documented');
  s.addShape(p.ShapeType.roundRect, { x: 0.6, y: 1.9, w: 6.0, h: 2.5, rectRadius: 0.08, fill: { color: ICE }, line: { color: LINE, width: 1 } });
  T(s, 'What it actually measures', { x: 0.85, y: 2.08, w: 5.5, h: 0.3, fontSize: 14, bold: true, color: NAVY, fontFace: B, margin: 0 });
  T(s, [
    { text: 'The unweighted mean of the latest CPU reading of every host whose reading parses above zero.', options: { bullet: true, breakLine: true } },
    { text: 'A HOST metric — not the database engine\'s own CPU.', options: { bullet: true, breakLine: true } },
    { text: 'Latest sample, not an average over a time window.', options: { bullet: true, breakLine: true } },
    { text: 'Not weighted by core count: a 2-core and a 64-core host count equally.', options: { bullet: true } },
  ], { x: 0.85, y: 2.44, w: 5.5, h: 1.8, fontSize: 11.5, color: BODY, fontFace: B, margin: 0, paraSpaceAfter: 6 });

  s.addShape(p.ShapeType.roundRect, { x: 6.9, y: 1.9, w: 5.82, h: 2.5, rectRadius: 0.08, fill: { color: INK }, line: { color: INK, width: 1 } });
  T(s, 'The calculation, from the source', { x: 7.15, y: 2.08, w: 5.3, h: 0.3, fontSize: 14, bold: true, color: CYAN_L, fontFace: B, margin: 0 });
  T(s, 'mean(\n  hosts.map(h => parseFloat(h.cpu_usage))\n       .filter(v => v > 0)\n)\n\nmean(a) = Math.round(sum(a) / a.length)', {
    x: 7.15, y: 2.46, w: 5.3, h: 1.3, fontSize: 11, color: 'A9E4FF', fontFace: 'Courier New', margin: 0, lineSpacingMultiple: 1.1,
  });
  T(s, 'useDashboardData.js:141, mean() at :23', { x: 7.15, y: 3.92, w: 5.3, h: 0.28, fontSize: 9.5, color: '8EA6C4', fontFace: 'Courier New', margin: 0 });

  T(s, 'Three findings from tracing it', { x: 0.6, y: 4.62, w: 12.1, h: 0.32, fontSize: 15, bold: true, color: NAVY, fontFace: B, margin: 0 });
  const finds = [
    ['Offline hosts are included', 'The chart beside it deliberately excludes them, calling their reading "frozen, not live". The gauge applies no status filter, so the two panels can disagree.', BAD],
    ['A genuinely idle host is dropped', 'The >0 filter cannot tell "reported 0%" from "did not report". Both are removed, which biases the mean upward.', WARN],
    ['Rounded twice, and unweighted', 'Rounded to a whole percent at write, rounded again after averaging.', GREY],
  ];
  finds.forEach((f, i) => {
    const x = 0.6 + i * 4.08;
    s.addShape(p.ShapeType.roundRect, { x: x, y: 5.04, w: 3.88, h: 1.6, rectRadius: 0.06, fill: { color: WHITE }, line: { color: f[2], width: 1 } });
    T(s, f[0], { x: x + 0.2, y: 5.18, w: 3.5, h: 0.5, fontSize: 12, bold: true, color: f[2], fontFace: B, margin: 0 });
    T(s, f[1], { x: x + 0.2, y: 5.66, w: 3.5, h: 0.88, fontSize: 10.5, color: BODY, fontFace: B, margin: 0, lineSpacingMultiple: 1.08 });
  });
  footnote(s, 'This level of detail exists for every dashboard metric in the interactive documentation.');
  s.addNotes('This slide is the proof of rigour. The findings are real discrepancies found by tracing the code, not hypotheticals.');
}

/* ═══ 10. infrastructure ═════════════════════════════════════════════ */
{
  const s = lightSlide('The host underneath the database', 'Infrastructure');
  T(s, 'Most "database problems" are host problems. A query that got slower because the disk got slower is only '
    + 'diagnosable if both are visible from the same tool.', {
    x: 0.6, y: 1.9, w: 12.1, h: 0.5, fontSize: 13.5, color: BODY, fontFace: B, margin: 0,
  });
  const tabs = ['Overview', 'Ports', 'Processes', 'Storage', 'Network', 'Services', 'Diagnostics', 'IP Configuration', 'Config Files'];
  tabs.forEach((t, i) => {
    const x = 0.6 + (i % 3) * 4.08, y = 2.6 + Math.floor(i / 3) * 0.72;
    s.addShape(p.ShapeType.roundRect, { x: x, y: y, w: 3.88, h: 0.6, rectRadius: 0.06, fill: { color: ICE }, line: { color: LINE, width: 1 } });
    s.addShape(p.ShapeType.ellipse, { x: x + 0.2, y: y + 0.18, w: 0.24, h: 0.24, fill: { color: OK } });
    T(s, t, { x: x + 0.56, y: y + 0.15, w: 3.1, h: 0.3, fontSize: 12.5, bold: true, color: NAVY, fontFace: B, margin: 0 });
  });
  T(s, 'History windows of 1 hour to 7 days, at per-minute to hourly granularity, plus a file explorer for '
    + 'reading configuration off the host.', {
    x: 0.6, y: 4.95, w: 12.1, h: 0.5, fontSize: 12.5, color: BODY, fontFace: B, margin: 0,
  });
  s.addShape(p.ShapeType.roundRect, { x: 0.6, y: 5.5, w: 12.12, h: 1.05, rectRadius: 0.06, fill: { color: 'FDF6E8' }, line: { color: WARN, width: 1 } });
  T(s, 'On correlation', { x: 0.88, y: 5.64, w: 2.4, h: 0.28, fontSize: 12.5, bold: true, color: WARN, fontFace: B, margin: 0 });
  T(s, 'If PostgreSQL query times rise and the same host shows elevated disk latency in the same window, both are '
    + 'visible in one tool. A correlation in time is not proof of cause, and neither the product nor this '
    + 'documentation claims otherwise.', {
    x: 3.4, y: 5.62, w: 9.1, h: 0.8, fontSize: 11.5, color: BODY, fontFace: B, margin: 0, lineSpacingMultiple: 1.1,
  });
  s.addNotes('Nine host sections. The correlation caveat matters — it is the difference between a monitoring tool and a diagnosis tool.');
}

/* ═══ 11. cloud ══════════════════════════════════════════════════════ */
{
  const s = lightSlide('Three cloud providers', 'Cloud monitoring');
  const provs = [
    ['Amazon Web Services', '16', ['EC2, EBS, RDS, Aurora clusters', 'Lambda, EKS, DynamoDB, Redshift', 'ElastiCache, ELB, VPC, subnets', 'Security groups, IAM, API Gateway, Bedrock']],
    ['Microsoft Azure', '10', ['Virtual machines, managed disks', 'Azure SQL, PostgreSQL, MySQL', 'Cosmos DB, Cache for Redis', 'AKS, storage accounts, networking']],
    ['Oracle Cloud', '16', ['Compute, block and boot volumes', 'Object storage, file systems', 'Databases, DB systems, MySQL', 'NoSQL tables, VCN, WAF, analytics']],
  ];
  provs.forEach((pv, i) => {
    const x = 0.6 + i * 4.08;
    s.addShape(p.ShapeType.roundRect, { x: x, y: 1.95, w: 3.88, h: 3.1, rectRadius: 0.08, fill: { color: WHITE }, line: { color: LINE, width: 1 },
      shadow: { type: 'outer', angle: 90, blur: 6, offset: 1, color: 'A9BDD4', opacity: 0.3 } });
    T(s, pv[0], { x: x + 0.22, y: 2.12, w: 3.44, h: 0.34, fontSize: 14, bold: true, color: NAVY, fontFace: B, margin: 0 });
    T(s, pv[1], { x: x + 0.22, y: 2.5, w: 1.0, h: 0.46, fontSize: 24, bold: true, color: CYAN, fontFace: H, margin: 0 });
    T(s, 'resource types\ndiscovered', { x: x + 1.15, y: 2.56, w: 2.4, h: 0.5, fontSize: 10, color: MUTED, fontFace: B, margin: 0, lineSpacingMultiple: 0.95 });
    T(s, pv[2].map((l, j) => ({ text: l, options: { bullet: true, breakLine: j < pv[2].length - 1 } })), {
      x: x + 0.32, y: 3.12, w: 3.3, h: 1.8, fontSize: 10.5, color: BODY, fontFace: B, margin: 0, paraSpaceAfter: 4,
    });
  });
  T(s, 'Four words that are not interchangeable', { x: 0.6, y: 5.3, w: 12.1, h: 0.32, fontSize: 15, bold: true, color: NAVY, fontFace: B, margin: 0 });
  const terms = [['Registered account', 'A credential set ACTMON can use'], ['Discovered resource', 'Found during a region walk'],
    ['Active resource', 'Provider says it is running'], ['Monitored resource', 'Metrics are collected for it']];
  terms.forEach((t, i) => {
    const x = 0.6 + i * 3.08;
    s.addShape(p.ShapeType.roundRect, { x: x, y: 5.72, w: 2.88, h: 0.82, rectRadius: 0.06, fill: { color: ICE }, line: { color: LINE, width: 1 } });
    T(s, t[0], { x: x + 0.16, y: 5.83, w: 2.6, h: 0.26, fontSize: 11.5, bold: true, color: NAVY, fontFace: B, margin: 0 });
    T(s, t[1], { x: x + 0.16, y: 6.09, w: 2.6, h: 0.4, fontSize: 10, color: MUTED, fontFace: B, margin: 0, lineSpacingMultiple: 1.05 });
  });
  footnote(s, 'The dashboard tile counts registered accounts. One account with ten thousand resources still counts as one.');
  s.addNotes('The four-term distinction prevents the most common misunderstanding in a cloud demo.');
}

/* ═══ 12. alerts ═════════════════════════════════════════════════════ */
{
  const s = lightSlide('What can actually fire', 'Alerts & notifications');
  const chart = [{
    name: 'Rule types',
    labels: ['Checked live', 'Agent-reported', 'No data source yet'],
    values: [5, 13, 25],
  }];
  s.addChart(p.ChartType.bar, chart, {
    x: 0.6, y: 1.95, w: 6.1, h: 2.9, barDir: 'bar',
    showTitle: true, title: 'All 43 alert rule types, by evaluation tier',
    titleFontSize: 13, titleColor: NAVY, titleFontFace: B,
    chartColors: [OK, CYAN, WARN],
    varyColors: true,
    showValue: true, dataLabelPosition: 'outEnd', dataLabelColor: BODY,
    dataLabelFontSize: 11, dataLabelFontFace: B,
    catAxisLabelColor: BODY, catAxisLabelFontSize: 11, catAxisLabelFontFace: B,
    valAxisLabelColor: MUTED, valAxisLabelFontSize: 10,
    valGridLine: { color: 'E4EBF3', size: 1 }, catGridLine: { style: 'none' },
    showLegend: false, valAxisMaxVal: 30,
  });
  s.addShape(p.ShapeType.roundRect, { x: 6.95, y: 1.95, w: 5.77, h: 2.9, rectRadius: 0.08, fill: { color: 'FBECEE' }, line: { color: BAD, width: 1 } });
  T(s, 'The number that matters', { x: 7.2, y: 2.14, w: 5.3, h: 0.3, fontSize: 14, bold: true, color: BAD, fontFace: B, margin: 0 });
  T(s, '25', { x: 7.2, y: 2.5, w: 1.5, h: 0.85, fontSize: 52, bold: true, color: BAD, fontFace: H, margin: 0 });
  T(s, 'of 43 rule types have no data source yet. A rule in that tier can be created and saved, will look '
    + 'configured, and will never fire.', {
    x: 8.6, y: 2.62, w: 3.9, h: 0.9, fontSize: 11.5, color: BODY, fontFace: B, margin: 0, lineSpacingMultiple: 1.12,
  });
  T(s, 'The product surfaces this tier in its own UI. The source comment explains why: "I made a rule and it '
    + 'never fired" is otherwise impossible to diagnose from the frontend.', {
    x: 7.2, y: 3.62, w: 5.3, h: 1.0, fontSize: 11.5, italic: true, color: MUTED, fontFace: B, margin: 0, lineSpacingMultiple: 1.12,
  });

  T(s, 'Nine notification channels', { x: 0.6, y: 5.1, w: 12.1, h: 0.32, fontSize: 15, bold: true, color: NAVY, fontFace: B, margin: 0 });
  const chans = ['Email', 'Microsoft Teams', 'Slack', 'Telegram', 'WhatsApp', 'Generic webhook', 'PagerDuty', 'Jira Service Management', 'ServiceNow'];
  // Wrap rather than run off the edge: measure before placing, and start a new
  // row when the next pill would cross the right margin.
  const LEFT = 0.6, RIGHT = 12.72;
  let cx = LEFT, cy = 5.56;
  chans.forEach((c) => {
    const w = Math.max(0.62, 0.085 * c.length + 0.34);
    if (cx + w > RIGHT) { cx = LEFT; cy += 0.42; }
    pill(s, cx, cy, c, CYAN);
    cx += w + 0.14;
  });
  footnote(s, 'Source: frontend/src/config/alertCatalog.js and notificationChannels.js.');
  s.addNotes('Do not hide the 25. A client who discovers it after purchase has a much worse conversation than one told up front.');
}

/* ═══ 13. security ═══════════════════════════════════════════════════ */
{
  const s = lightSlide('Access control and credentials', 'Security & administration');
  T(s, 'A monitoring tool holds credentials for every production database in the estate. Access control is not '
    + 'an afterthought here, it is the containment boundary.', {
    x: 0.6, y: 1.9, w: 12.1, h: 0.5, fontSize: 13.5, color: BODY, fontFace: B, margin: 0,
  });
  T(s, 'Permissions are a bitmask, per role, per page', { x: 0.6, y: 2.58, w: 12.1, h: 0.32, fontSize: 15, bold: true, color: NAVY, fontFace: B, margin: 0 });
  const bits = [['View', 1], ['Add', 2], ['Edit', 4], ['Delete', 8], ['Print', 16], ['Export', 32], ['Execute', 64], ['Approve', 128], ['Restart', 256]];
  bits.forEach((b, i) => {
    const x = 0.6 + i * 1.36;
    s.addShape(p.ShapeType.roundRect, { x: x, y: 3.0, w: 1.22, h: 0.86, rectRadius: 0.06, fill: { color: ICE }, line: { color: LINE, width: 1 } });
    T(s, String(b[1]), { x: x, y: 3.1, w: 1.22, h: 0.36, fontSize: 17, bold: true, color: CYAN, align: 'center', fontFace: H, margin: 0 });
    T(s, b[0], { x: x, y: 3.46, w: 1.22, h: 0.26, fontSize: 10, color: NAVY, align: 'center', fontFace: B, margin: 0 });
  });
  T(s, 'Full Access is the composite value 511 — every bit set.', { x: 0.6, y: 3.96, w: 12.1, h: 0.3, fontSize: 12, italic: true, color: MUTED, fontFace: B, margin: 0 });

  card(s, 0.6, 4.45, 3.88, 2.0, 'Credentials', [
    'Encrypted at rest',
    'Never returned to the browser',
    'No password, token or connection string appears in any API response',
  ], OK);
  card(s, 4.72, 4.45, 3.88, 2.0, 'Page registration', [
    'A URL absent from page_master is ungoverned',
    'Any signed-in user can reach it',
    'Registering a page is part of shipping it',
  ], WARN);
  card(s, 8.84, 4.45, 3.88, 2.0, 'Audit', [
    'Configuration changes written to an audit log',
    'Held alongside the operational data',
  ], CYAN);
  s.addNotes('The page-registration point is a genuine design constraint worth raising with a security reviewer.');
}

/* ═══ 14. workflow ═══════════════════════════════════════════════════ */
{
  const s = lightSlide('From symptom to a checkable recommendation', 'Example workflow');
  T(s, 'Illustrative — a worked example, not a recording of a real incident.', {
    x: 0.6, y: 1.88, w: 12.1, h: 0.3, fontSize: 11.5, italic: true, color: MUTED, fontFace: B, margin: 0,
  });
  const steps = [
    ['The symptom', 'The ticket list feels slow. Overview shows 18 of 100 connections used and a 99.2% cache hit ratio — the instance is not saturated.'],
    ['Find the statement', 'Slow Queries lists four over the threshold. One averages 1,830 ms and has run 4,200 times today — over two hours of cumulative server time.'],
    ['Read the plan', 'A plain EXPLAIN computes the plan without executing anything. It shows a sequential scan over ticket_events filtering on created_at.'],
    ['Check what exists', 'Before claiming an index is missing, ACTMON reads the table\'s real indexes. Only the primary key is present — so this is a genuine gap.'],
    ['The recommendation', 'Each finding carries the number it came from, plus the CREATE INDEX statement and its trade-off.'],
    ['A human decides', 'ACTMON does not create the index. It presents the evidence and the trade-off; the original statement is never rewritten or replaced.'],
  ];
  steps.forEach((st, i) => {
    discBlock(s, i + 1, i % 2 ? 7.0 : 0.6, 2.4 + Math.floor(i / 2) * 1.55, 5.8, st[0], st[1]);
  });
  footnote(s, 'EXPLAIN ANALYZE genuinely runs a statement, so it is a separate confirmed action and is refused for anything that is not a plain read.');
  s.addNotes('This is the demo to give. It ends with a human decision, which is the honest position.');
}

/* ═══ 15. deployment ═════════════════════════════════════════════════ */
{
  const s = lightSlide('What a deployment needs', 'Deployment & operations');
  const comps = [
    ['ACTMON server', 'FastAPI backend, React frontend, served behind a reverse proxy.'],
    ['PostgreSQL', 'ACTMON\'s own configuration store — connections, roles, permissions, alert rules, audit.'],
    ['Redis', 'The hot metrics tier: latest value plus a one-hour ring.'],
    ['ClickHouse', 'Metric history, per module and technology.'],
    ['Cloud service', 'A separate microservice for cloud providers. Optional — its absence is not a dashboard failure.'],
    ['Agents', 'On monitored hosts, where an agent is used. MSI on Windows, .deb/.rpm on Linux.'],
  ];
  comps.forEach((c, i) => {
    const x = 0.6 + (i % 3) * 4.08, y = 1.95 + Math.floor(i / 3) * 1.72;
    s.addShape(p.ShapeType.roundRect, { x: x, y: y, w: 3.88, h: 1.5, rectRadius: 0.08, fill: { color: WHITE }, line: { color: LINE, width: 1 } });
    s.addShape(p.ShapeType.ellipse, { x: x + 0.22, y: y + 0.22, w: 0.3, h: 0.3, fill: { color: CYAN } });
    T(s, c[0], { x: x + 0.62, y: y + 0.19, w: 3.1, h: 0.32, fontSize: 13, bold: true, color: NAVY, fontFace: B, margin: 0 });
    T(s, c[1], { x: x + 0.3, y: y + 0.62, w: 3.3, h: 0.78, fontSize: 10.5, color: BODY, fontFace: B, margin: 0, lineSpacingMultiple: 1.1 });
  });
  s.addShape(p.ShapeType.roundRect, { x: 0.6, y: 5.42, w: 12.12, h: 1.1, rectRadius: 0.06, fill: { color: 'FDF6E8' }, line: { color: WARN, width: 1 } });
  T(s, 'Before a deployment claim', { x: 0.88, y: 5.56, w: 3.2, h: 0.28, fontSize: 12.5, bold: true, color: WARN, fontFace: B, margin: 0 });
  T(s, 'Whether a given installation keeps all data on-premises depends on how it is configured — the cloud '
    + 'module talks to provider APIs by design. Confirm the actual network boundaries for the specific '
    + 'deployment rather than assuming either answer.', {
    x: 4.2, y: 5.54, w: 8.3, h: 0.85, fontSize: 11.5, color: BODY, fontFace: B, margin: 0, lineSpacingMultiple: 1.1,
  });
  s.addNotes('Do not promise "nothing leaves your network" without checking the cloud module configuration for that customer.');
}

/* ═══ 16. status summary ═════════════════════════════════════════════ */
{
  const s = lightSlide('Implementation status at a glance', 'Where things stand');
  const chartData = [{
    name: 'Items',
    labels: ['Implemented', 'Partial', 'No data source', 'Not implemented'],
    values: [17, 2, 25, 2],
  }];
  s.addChart(p.ChartType.doughnut, chartData, {
    x: 0.6, y: 1.9, w: 5.4, h: 4.3, holeSize: 55,
    showTitle: true, title: 'Documented items by status', titleFontSize: 13, titleColor: NAVY, titleFontFace: B,
    chartColors: [OK, '7B5CC4', 'D9A441', BAD],   // Partial gets its own hue, not a second amber
    showValue: true, dataLabelPosition: 'bestFit', dataLabelColor: WHITE,
    dataLabelFontSize: 12, dataLabelFontFace: B, dataLabelFontBold: true,
    showLegend: true, legendPos: 'b', legendColor: BODY, legendFontSize: 11, legendFontFace: B,
  });
  const rows = [
    ['7 monitoring domains', 'All implemented', OK],
    ['7 database dashboards', 'Implemented; MariaDB partial', OK],
    ['3 cloud providers', 'AWS, Azure, OCI implemented', OK],
    ['9 infrastructure sections', 'Implemented', OK],
    ['9 notification channels', 'Implemented', OK],
    ['25 alert rule types', 'No data source yet', WARN],
    ['GCP, Redis monitoring', 'Not implemented', BAD],
  ];
  rows.forEach((r, i) => {
    const y = 2.1 + i * 0.62;
    s.addShape(p.ShapeType.roundRect, { x: 6.5, y: y, w: 6.22, h: 0.52, rectRadius: 0.05, fill: { color: i % 2 ? WHITE : ICE }, line: { color: LINE, width: 1 } });
    T(s, r[0], { x: 6.7, y: y + 0.11, w: 3.0, h: 0.3, fontSize: 12, bold: true, color: NAVY, fontFace: B, margin: 0 });
    T(s, r[1], { x: 9.8, y: y + 0.12, w: 2.8, h: 0.3, fontSize: 11, color: r[2], fontFace: B, margin: 0 });
  });
  footnote(s, 'Counts cover the items documented in the interactive knowledge centre; each carries the source file it was read from.');
  s.addNotes('An honest scoreboard. The amber slice is the one to talk about.');
}

/* ═══ 17. what you get ═══════════════════════════════════════════════ */
{
  const s = lightSlide('What is delivered with this', 'Documentation');
  card(s, 0.6, 1.95, 6.0, 2.5, 'Interactive knowledge centre', [
    'A 3D overview of the platform',
    'Click a domain — the page scrolls to its full documentation',
    'Thirteen full-width sections covering every module',
    'Metric dictionary with formula, source and verification',
    'Opens by double-click; no install, no server',
  ], CYAN);
  card(s, 6.9, 1.95, 5.82, 2.5, 'This presentation', [
    'Editable PowerPoint',
    'Verified figures with source references',
    'Speaker notes on every slide',
    'Suitable for client and management audiences',
  ], '6F7CF7');
  T(s, 'How accuracy was established', { x: 0.6, y: 4.68, w: 12.1, h: 0.32, fontSize: 15, bold: true, color: NAVY, fontFace: B, margin: 0 });
  const method = [
    ['Read, not inferred', 'Every capability was traced in the repository before it was written down. Each claim names its file.'],
    ['Status on every item', 'Implemented, partial, no data source, illustrative, or not implemented — stated, never implied.'],
    ['Gaps named', 'Where a trace could not be completed, the documentation says so and names the file to read next.'],
  ];
  method.forEach((m, i) => {
    const x = 0.6 + i * 4.08;
    s.addShape(p.ShapeType.roundRect, { x: x, y: 5.1, w: 3.88, h: 1.42, rectRadius: 0.06, fill: { color: ICE }, line: { color: LINE, width: 1 } });
    T(s, m[0], { x: x + 0.2, y: 5.24, w: 3.5, h: 0.3, fontSize: 12.5, bold: true, color: NAVY, fontFace: B, margin: 0 });
    T(s, m[1], { x: x + 0.2, y: 5.56, w: 3.5, h: 0.84, fontSize: 10.5, color: BODY, fontFace: B, margin: 0, lineSpacingMultiple: 1.1 });
  });
  s.addNotes('Close on method. The credibility of the whole deck rests on the claims being checkable.');
}

/* ═══ 18. closing ════════════════════════════════════════════════════ */
{
  const s = darkSlide();
  s.addShape(p.ShapeType.ellipse, { x: -2.2, y: 3.6, w: 7.2, h: 7.2, fill: { color: NAVY2 } });
  T(s, 'ACTMON', {
    x: 0.9, y: 2.3, w: 9, h: 1.0, fontSize: 46, bold: true, color: WHITE, fontFace: H, charSpacing: 5, margin: 0,
  });
  T(s, 'Three domains, one estate, one set of alerts.', {
    x: 0.9, y: 3.3, w: 9.4, h: 0.5, fontSize: 20, color: CYAN_L, fontFace: B, margin: 0,
  });
  const facts = [['8', 'database technologies'], ['3', 'cloud providers'], ['9', 'notification channels'], ['7', 'monitoring domains']];
  facts.forEach((f, i) => {
    const x = 0.9 + i * 3.0;
    T(s, f[0], { x: x, y: 4.3, w: 1.1, h: 0.7, fontSize: 40, bold: true, color: CYAN, fontFace: H, margin: 0 });
    T(s, f[1], { x: x, y: 5.0, w: 2.7, h: 0.5, fontSize: 12, color: 'B9CBE2', fontFace: B, margin: 0 });
  });
  T(s, 'All examples in this deck are illustrative. No live measurement, credential or customer datum appears anywhere.', {
    x: 0.9, y: 6.5, w: 11.5, h: 0.4, fontSize: 11, color: '8EA6C4', fontFace: B, margin: 0,
  });
  s.addNotes('Closing slide. The disclaimer line is deliberate — it is also the honest position.');
}

const OUT = 'E:/ACTMON V1/docs/actmon-docs/ACTMON_Product_Overview.pptx';
p.writeFile({ fileName: OUT }).then(() => console.log('wrote ' + OUT));
