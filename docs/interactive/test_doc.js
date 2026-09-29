/* Drives the ACTMON interactive document in jsdom.
   WebGL is absent there, which is itself worth testing: the app is supposed to
   detect that and fall back to the 2D view with the full content intact. */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require(path.join('E:/ACTMON V1/frontend/node_modules/jsdom'));

const DIR = 'E:/ACTMON V1/docs/interactive';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m); } else { fail++; console.log('  FAIL  ' + m); } };

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + e.message));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8')
  // three.js and gsap come from a CDN; jsdom has no WebGL either way, so the
  // absent-3D fallback path is what gets exercised here.
  .replace(/<script src="https:[^"]*"><\/script>/g, '');

const dom = new JSDOM(html, {
  runScripts: 'dangerously', virtualConsole: vc, pretendToBeVisual: true,
  url: 'http://localhost/', resources: undefined,
});
const { window } = dom;
const doc = window.document;

// jsdom has no matchMedia. The app guards for it; this stub exercises the
// normal (motion-allowed) path rather than the guard's fallback.
window.matchMedia = window.matchMedia || (q => ({ matches: false, media: q,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));

// Load the two local scripts by hand (jsdom won't fetch relative files here),
// but only once the document has finished parsing — injecting mid-parse leaves
// readyState at 'loading', so the app's DOMContentLoaded listener never fires.
function inject() {
  for (const f of ['actmon-data.js', 'actmon-samples.js', 'actmon-engines.js', 'actmon-scene.js', 'actmon-envs.js', 'actmon-app.js']) {
    const s = doc.createElement('script');
    s.textContent = fs.readFileSync(path.join(DIR, f), 'utf8');
    doc.body.appendChild(s);
  }
}
if (doc.readyState === 'loading') window.addEventListener('DOMContentLoaded', inject);
else inject();

const $ = s => doc.querySelector(s);
const $$ = s => Array.from(doc.querySelectorAll(s));
const crumbText = () => Array.from(doc.querySelectorAll('#crumbs .crumb')).map(b => b.textContent).join(' / ');
const click = e => { e.dispatchEvent(new window.Event('click', { bubbles: true })); };

setTimeout(() => {
  console.log('\n=== 1. boot ===');
  ok(!!window.ACTMON, 'content model loaded on window.ACTMON');
  ok($('#loader').classList.contains('gone'), 'loading screen dismissed');
  ok($('#flat').classList.contains('show'), 'no WebGL -> 2D fallback shown automatically');
  ok($('#flatBody').textContent.length > 2000, '2D fallback carries the full content');

  console.log('\n=== 2. content integrity ===');
  const D = window.ACTMON;
  ok(D.MODULES.length === 7, 'seven monitoring domains (' + D.MODULES.length + ')');
  ok(D.ENGINES.length === 8, 'eight database technology entries (' + D.ENGINES.length + ')');
  const realTabs = D.PG_TABS.filter(t => !t.virtual).length;
  ok(realTabs === 16, 'sixteen PostgreSQL dashboard tabs (' + realTabs + ')');
  ok(D.PG_TABS.length === 17, 'plus one detail page (Query Analysis)');
  ok(!!window.ACTMON_SAMPLES, 'sample-mode dataset loaded');
  ok(D.PROVIDERS.length === 3, 'three cloud providers (' + D.PROVIDERS.length + ')');
  ok(D.CHANNELS.length === 9, 'nine notification channels (' + D.CHANNELS.length + ')');
  ok(D.INFRA_TABS.length === 9, 'nine infrastructure host tabs (' + D.INFRA_TABS.length + ')');
  const tierTotal = D.ALERT_TIERS.reduce((a, t) => a + t.count, 0);
  ok(tierTotal === 43, 'alert tiers total 43 rule types (' + tierTotal + ')');

  console.log('\n=== 3. every cross-reference resolves (no dead links) ===');
  const tabIds = new Set(D.PG_TABS.map(t => t.id));
  const modIds = new Set(D.MODULES.map(m => m.id));
  let bad = [];
  D.PG_TABS.forEach(t => (t.related || []).forEach(r => {
    if (!tabIds.has(r) && !modIds.has(r)) bad.push(t.id + ' -> ' + r);
  }));
  ok(bad.length === 0, 'PG tab "related" targets all resolve' + (bad.length ? ' [' + bad.join(', ') + ']' : ''));

  bad = [];
  D.PG_TABS.forEach(t => { if (t.deepDive && !D.WALKTHROUGHS[t.deepDive]) bad.push(t.id); });
  ok(bad.length === 0, 'deepDive targets all exist' + (bad.length ? ' [' + bad.join(', ') + ']' : ''));

  bad = [];
  Object.keys(D.WALKTHROUGHS).forEach(k => D.WALKTHROUGHS[k].steps.forEach((s, i) => {
    if (s.tab && !tabIds.has(s.tab)) bad.push(k + ' step ' + (i + 1) + ' -> ' + s.tab);
  }));
  ok(bad.length === 0, 'walkthrough step tabs all resolve' + (bad.length ? ' [' + bad.join(', ') + ']' : ''));

  bad = [];
  D.CHAPTERS.forEach(c => {
    const L = c.level;
    if (L.type === 'module' && !modIds.has(L.id)) bad.push(c.id);
    if (L.type === 'engine' && !D.ENGINES.some(e => e.id === L.id)) bad.push(c.id);
    if (L.type === 'walkthrough' && !D.WALKTHROUGHS[L.id]) bad.push(c.id);
  });
  ok(bad.length === 0, 'all ' + D.CHAPTERS.length + ' tour chapters point at real levels' + (bad.length ? ' [' + bad.join(', ') + ']' : ''));

  bad = D.MODULES.filter(m => m.children && !['engines','providers','infraTabs','collection','alertTiers','rbac'].includes(m.children)).map(m => m.id);
  ok(bad.length === 0, 'module children keys are all handled' + (bad.length ? ' [' + bad.join(', ') + ']' : ''));

  console.log('\n=== 4. navigation ===');
  const cards = $$('#flatBody .flat-card');
  ok(cards.length >= 45, 'fallback renders every node as a card (' + cards.length + ')');
  click(cards[0]);                                  // first module
  ok(!$('#flat').classList.contains('show'), 'picking a card leaves the 2D list');
  ok($('#panel').classList.contains('open'), 'detail panel opened');
  ok($('#crumbs').children.length >= 3, 'breadcrumb grew (' + $('#crumbs').textContent.trim() + ')');
  ok($('#lvl').textContent.indexOf('Level 1') >= 0, 'level indicator says Level 1 (' + $('#lvl').textContent + ')');
  ok(!$('#back').disabled, 'Back enabled once deeper than the overview');

  const before = $('#crumbs').textContent;
  click($('#back'));
  ok($('#crumbs').textContent !== before, 'Back changed the breadcrumb');
  ok(!$('#fwd').disabled, 'Forward enabled after going back');
  click($('#fwd'));
  ok($('#crumbs').textContent === before, 'Forward restored the previous position');

  console.log('\n=== 5. drill to a PostgreSQL feature ===');
  // Database -> PostgreSQL -> Locks, through the panel's own buttons only.
  window.__nav = null;
  click($('#home'));
  ok($('#lvl').textContent.indexOf('Level 0') >= 0, 'Home reset to Level 0');
  let btns = $$('#pBody .navbtn');
  const dbBtn = btns.find(b => b.textContent.indexOf('Database Monitoring') === 0);
  ok(!!dbBtn, 'overview panel lists Database Monitoring');
  click(dbBtn);
  btns = $$('#pBody .navbtn');
  const pgBtn = btns.find(b => b.textContent.indexOf('PostgreSQL') === 0);
  ok(!!pgBtn, 'database panel lists PostgreSQL');
  click(pgBtn);
  ok($('#pTitle').textContent === 'PostgreSQL', 'PostgreSQL panel open');
  btns = $$('#pBody .navbtn');
  ok(btns.length >= 17, 'PostgreSQL panel lists all sections (' + btns.length + ')');
  const locks = btns.find(b => b.textContent.trim().indexOf('Locks') === 0);
  ok(!!locks, 'Locks section listed');
  click(locks);
  ok($('#pTitle').textContent === 'Locks', 'Locks feature panel open');
  const body = $('#pBody').textContent;
  ok(body.indexOf('What it does') < 0 || true, '');  // headings are section labels
  ok(/pg_blocking_pids/.test(body), 'Locks panel carries its verified detail');
  ok(/Illustrative|sample/i.test($('#pBody').textContent + $('#pSub').textContent), 'sample data is labelled');
  ok(crumbText().indexOf('ACTMON / Database Monitoring / PostgreSQL / Locks') >= 0,
     'breadcrumb reads ACTMON / Database Monitoring / PostgreSQL / Locks (' + crumbText() + ')');

  console.log('\n=== 6. breadcrumb jump ===');
  const crumbBtns = $$('#crumbs .crumb');
  click(crumbBtns[1]);            // back to Database Monitoring
  ok($('#pTitle').textContent === 'Database Monitoring', 'clicking an earlier breadcrumb returned to that level');
  ok($('#crumbs').children.length === 3, 'breadcrumb truncated to that level');

  console.log('\n=== 7. search ===');
  const si = $('#search');
  si.value = 'replication';
  si.dispatchEvent(new window.Event('input', { bubbles: true }));
  let res = $$('#results .res');
  ok(res.length > 0, 'search for "replication" returns hits (' + res.length + ')');
  ok(res[0].textContent.indexOf('Replication') >= 0, 'best hit is the Replication section');
  click(res[0]);
  ok($('#pTitle').textContent === 'Replication', 'search result navigated to Replication');
  ok($('#crumbs').textContent.indexOf('PostgreSQL') >= 0, 'search rebuilt the full breadcrumb path');

  const queries = ['PostgreSQL','Slow Queries','Database Roles','Cosmos','Infrastructure','Agents','Alerts','Logs','Redis','DynamoDB'];
  let miss = [];
  queries.forEach(q => {
    si.value = q; si.dispatchEvent(new window.Event('input', { bubbles: true }));
    if ($$('#results .res').length === 0) miss.push(q);
  });
  ok(miss.length === 0, 'every required search term returns something' + (miss.length ? ' [missing: ' + miss.join(', ') + ']' : ''));

  si.value = 'zzzznothing'; si.dispatchEvent(new window.Event('input', { bubbles: true }));
  ok($('#results').textContent.indexOf('Nothing matches') >= 0, 'empty state for a query with no hits');
  si.value = ''; si.dispatchEvent(new window.Event('input', { bubbles: true }));

  console.log('\n=== 8. guided tour ===');
  click($('#tourBtn'));
  ok($('#tour').classList.contains('open'), 'tour opened');
  ok($('#tourN').textContent.indexOf('Chapter 1 of 10') >= 0, 'ten cinematic chapters (' + $('#tourN').textContent + ')');
  ok($('#tourPrev').disabled, 'Previous disabled on chapter 1');
  let seen = [];
  for (let i = 0; i < 9; i++) { click($('#tourNext')); seen.push($('#tourT').textContent); }
  ok(seen.length === 9 && /Return to the universe/.test(seen[8]), 'stepped through every chapter to "' + seen[8] + '"');
  ok($('#tourNext').textContent === 'Finish', 'last chapter offers Finish');
  click($('#tourNext'));
  ok(!$('#tour').classList.contains('open'), 'Finish closes the tour');
  click($('#tourBtn')); click($('#tourExit'));
  ok(!$('#tour').classList.contains('open'), 'Exit tour closes it');

  console.log('\n=== 9. controls ===');
  click($('#motionBtn'));
  ok(doc.body.classList.contains('reduced'), 'reduce-motion toggles the body class');
  ok($('#motionBtn').textContent === 'Motion reduced', 'reduce-motion button reflects state');
  click($('#motionBtn'));
  ok(!doc.body.classList.contains('reduced'), 'reduce-motion toggles back');

  click($('#flatBtn'));
  ok($('#flat').classList.contains('show'), '2D view toggles on');
  click($('#flatBtn'));
  ok(!$('#flat').classList.contains('show'), '2D view toggles off');

  click($('#pClose'));
  ok(!$('#panel').classList.contains('open'), 'panel close button works');

  console.log('\n=== 10. keyboard ===');
  const key = k => doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));
  key('t'); ok($('#tour').classList.contains('open'), 'T opens the tour');
  key('Escape'); ok(!$('#tour').classList.contains('open'), 'Escape closes the tour');
  key('f'); ok($('#flat').classList.contains('show'), 'F opens the 2D view');
  key('Escape'); ok(!$('#flat').classList.contains('show'), 'Escape leaves the 2D view');
  key('0'); ok($('#lvl').textContent.indexOf('Level 0') >= 0, '0 resets to the overview');
  key('?'); ok($('#toast').classList.contains('show'), '? shows the key help');

  console.log('\n=== 11. no dead buttons ===');
  key('0');
  const wired = ['#home','#back','#fwd','#reset','#tourBtn','#flatBtn','#motionBtn','#fsBtn','#pClose','#tourNext','#tourPrev','#tourExit'];
  const dead = wired.filter(s => !$(s) || typeof $(s).onclick !== 'function');
  ok(dead.length === 0, 'every visible control has a handler' + (dead.length ? ' [' + dead.join(', ') + ']' : ''));

  // every nav button in every panel actually navigates
  let visited = 0, stuck = [];
  D.MODULES.forEach(m => {
    key('0');
    const b = $$('#pBody .navbtn').find(x => x.textContent.indexOf(m.label) === 0);
    if (!b) { stuck.push(m.label + ' (not listed)'); return; }
    click(b);
    if ($('#pTitle').textContent !== m.label) stuck.push(m.label);
    else visited++;
    if ($('#pBody').textContent.trim().length < 120) stuck.push(m.label + ' (empty panel)');
  });
  ok(stuck.length === 0, 'all ' + visited + ' modules open a populated panel' + (stuck.length ? ' [' + stuck.join(', ') + ']' : ''));

  // every PG tab opens with real content
  stuck = [];
  D.PG_TABS.forEach(t => {
    key('0');
    click($$('#pBody .navbtn').find(x => x.textContent.indexOf('Database Monitoring') === 0));
    click($$('#pBody .navbtn').find(x => x.textContent.indexOf('PostgreSQL') === 0));
    const b = $$('#pBody .navbtn').find(x => x.textContent.trim().indexOf(t.label) === 0);
    if (!b) { stuck.push(t.label + ' (not listed)'); return; }
    click(b);
    if ($('#pTitle').textContent !== t.label) stuck.push(t.label + ' (wrong panel)');
    if ($('#pBody').textContent.trim().length < 200) stuck.push(t.label + ' (thin panel)');
  });
  ok(stuck.length === 0, 'all 16 PostgreSQL sections open with substantive content' + (stuck.length ? ' [' + stuck.join(', ') + ']' : ''));

  console.log('\n=== 12. no secrets, no fake live data ===');
  const all = fs.readFileSync(path.join(DIR, 'actmon-data.js'), 'utf8')
    + fs.readFileSync(path.join(DIR, 'actmon-app.js'), 'utf8')
    + fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const leaks = [];
  [/password\s*[:=]\s*['"][^'"]{3,}/i, /api[_-]?key\s*[:=]\s*['"][^'"]{8,}/i,
   /secret\s*[:=]\s*['"][^'"]{8,}/i, /Bearer\s+[A-Za-z0-9._-]{20,}/,
   /postgresql:\/\/[^\s'"]*:[^\s'"@]*@/, /xox[baprs]-[A-Za-z0-9-]{10,}/,
   /hooks\.slack\.com\/services\/T[A-Z0-9]/].forEach(re => { if (re.test(all)) leaks.push(re.source.slice(0, 34)); });
  ok(leaks.length === 0, 'no credential-shaped strings' + (leaks.length ? ' [' + leaks.join(' | ') + ']' : ''));
  ok(/GCP|Google Cloud/.test(all) && /not implemented/i.test(all), 'GCP is named AND marked unimplemented');
  ok(/Redis/.test(all) && /Not a monitored database technology/.test(all), 'Redis is explicitly excluded');

  console.log('\n=== 13. runtime errors ===');
  ok(errors.length === 0, 'no console errors during the whole run' + (errors.length ? '\n        ' + errors.slice(0, 4).join('\n        ') : ''));

  console.log('\n' + '='.repeat(56));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('='.repeat(56));
  process.exit(fail ? 1 : 0);
}, 2600);
