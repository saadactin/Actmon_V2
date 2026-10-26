/* Drives the KOEL explorer in jsdom.

   WebGL is absent there, which is itself worth testing: the app must detect it
   and fall back to the 2D view with the full content intact. The 3D levels
   themselves are covered by test_koel.js, which builds them against a THREE
   stub.

   The checks that matter most here are the chrome parity ones — this page was
   derived from actmon-3d-explorer.html and has to keep every control that one
   has — and the content ones, because a transcription's job is to drop nothing
   and invent nothing. */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('E:/ACTMON V1/frontend/node_modules/jsdom');

const DIR = 'E:/ACTMON V1/docs/koel';
const REF = 'E:/ACTMON V1/docs/actmon-docs/actmon-3d-explorer.html';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m); } else { fail++; console.log('  FAIL  ' + m); } };

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + e.message));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

const raw = fs.readFileSync(path.join(DIR, 'koel-3d-explorer.html'), 'utf8');
const html = raw.replace(/<script src="https:[^"]*"><\/script>/g, '');
const dom = new JSDOM(html, { runScripts: 'dangerously', virtualConsole: vc, pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
const doc = window.document;
window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
window.scrollTo = () => {};
window.Element.prototype.scrollIntoView = function () {};

function inject() {
  for (const f of ['koel-data.js', 'koel-scene.js', 'koel-envs.js', 'koel-app.js']) {
    const s = doc.createElement('script');
    s.textContent = fs.readFileSync(path.join(DIR, f), 'utf8');
    doc.body.appendChild(s);
  }
}
if (doc.readyState === 'loading') window.addEventListener('DOMContentLoaded', inject); else inject();

const $ = s => doc.querySelector(s);
const $$ = s => Array.from(doc.querySelectorAll(s));
const crumbText = () => $$('#crumbs .crumb').map(b => b.textContent).join(' / ');
const click = e => e && e.dispatchEvent(new window.Event('click', { bubbles: true }));

setTimeout(() => {
  const D = window.KOEL;

  console.log('=== 1. boot ===');
  ok(!!D, 'content model loaded on window.KOEL');
  ok(!!window.KScene && !!window.KEnvs, 'scene engine and environments loaded');
  ok($('#loader').classList.contains('gone'), 'loading screen dismissed');
  ok($('#flat').classList.contains('show'), 'no WebGL -> 2D fallback shown automatically');
  ok($('#flatBody').textContent.length > 3000,
    '2D fallback carries the full content (' + $('#flatBody').textContent.length + ' chars)');
  ok(errors.length === 0, 'no runtime errors during boot' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));

  console.log('\n=== 2. chrome parity with actmon-3d-explorer.html ===');
  // Every control the reference page has must exist here too, by the same id —
  // otherwise "the same as the ACTMON explorer" is only true of the styling.
  const ref = fs.readFileSync(REF, 'utf8');
  const idsOf = src => (src.match(/\bid="([A-Za-z0-9_-]+)"/g) || []).map(m => m.slice(4, -1));
  const refIds = [...new Set(idsOf(ref))];
  const mineIds = new Set(idsOf(raw));
  const missingIds = refIds.filter(i => !mineIds.has(i));
  ok(missingIds.length === 0, 'every element id from the reference page is present ('
    + refIds.length + ' ids)' + (missingIds.length ? ' [missing: ' + missingIds.join(', ') + ']' : ''));

  const refClasses = [...new Set((ref.match(/^\.[A-Za-z0-9_-]+/gm) || []))];
  const missingCss = refClasses.filter(c => raw.indexOf(c + '{') < 0 && raw.indexOf(c + ',') < 0 && raw.indexOf(c + ' ') < 0);
  ok(missingCss.length === 0, 'the reference stylesheet survived intact ('
    + refClasses.length + ' rules)' + (missingCss.length ? ' [missing: ' + missingCss.slice(0, 6).join(', ') + ']' : ''));

  ['#back', '#fwd', '#reset', '#tourBtn', '#flatBtn', '#motionBtn', '#fsBtn',
    '#search', '#panel', '#tour', '#legend', '#prox', '#envBar', '#crumbs', '#lvl'].forEach(sel => {
    ok(!!$(sel), 'control ' + sel + ' exists');
  });
  ok(!/actmon/i.test(raw), 'no ACTMON identity left in the derived page');

  console.log('\n=== 3. the legend carries this document\'s vocabulary ===');
  const legend = $('#legend').textContent;
  const classLabels = Object.keys(D.CLASS).map(k => D.CLASS[k].label);
  ok(classLabels.every(l => legend.indexOf(l) >= 0),
    'all four provenance labels are in the legend: ' + classLabels.join(' · '));
  ok($$('#legend .chip').length === classLabels.length,
    'one chip per provenance class (' + $$('#legend .chip').length + ')');

  console.log('\n=== 4. the 2D index lists every object ===');
  const flat = $('#flatBody').textContent;
  const ALL = [].concat(D.ONPREM, D.PUBLIC_SUBNET, D.PRIVATE_SUBNET, D.SIEBEL);
  const absent = ALL.filter(c => flat.indexOf(c.label) < 0);
  ok(absent.length === 0, 'every component is in the 2D index'
    + (absent.length ? ' [missing: ' + absent.map(c => c.label).join(', ') + ']' : ''));
  const absentFeeds = D.FEEDS.filter(f => flat.indexOf(f.n) < 0);
  ok(absentFeeds.length === 0, 'all ' + D.FEEDS.length + ' feeds are in the 2D index'
    + (absentFeeds.length ? ' [missing: ' + absentFeeds.map(f => f.n).join(', ') + ']' : ''));
  const absentFlows = D.FLOWS.filter(f => flat.indexOf(f.label) < 0);
  ok(absentFlows.length === 0, 'all ' + D.FLOWS.length + ' connections are in the 2D index'
    + (absentFlows.length ? ' [missing: ' + absentFlows.map(f => f.label).join(', ') + ']' : ''));
  ok(D.ZONES.every(z => flat.indexOf(z.label) >= 0), 'all three zones are in the 2D index');

  console.log('\n=== 5. selecting from the 2D index opens the right panel ===');
  const cards = $$('#flatBody .flat-card');
  ok(cards.length >= ALL.length + D.FEEDS.length + D.FLOWS.length,
    'the index is clickable throughout (' + cards.length + ' cards)');

  const erpCard = cards.find(c => /Oracle ERP Application Server/.test(c.textContent));
  click(erpCard);
  ok(/Oracle ERP Application Server/.test($('#pTitle').textContent),
    'clicking the ERP app server opens its panel (got "' + $('#pTitle').textContent + '")');
  ok(/Single point of failure/i.test($('#pBody').textContent),
    'its panel states the single-compute-node consequence');
  ok($('#panel').classList.contains('open'), 'the panel opened');

  const feedCard = cards.find(c => /ICICI Bank API/.test(c.textContent));
  click(feedCard);
  ok($('#pTitle').textContent === 'ICICI Bank API', 'clicking a feed opens that feed');
  ok(/HTTP\/s/.test($('#pBody').textContent), 'its protocol comes from the diagram');
  ok(/Integration Server/.test($('#pBody').textContent), 'its terminating component is named');

  const flowCard = cards.find(c => /Encrypted IPsec/.test(c.textContent));
  click(flowCard);
  ok(/Encrypted IPsec/.test($('#pTitle').textContent), 'clicking a connection opens that connection');
  ok(/no alternative path/i.test($('#pBody').textContent),
    'the tunnel panel says the diagram draws no alternative path');

  console.log('\n=== 6. every level renders a panel without throwing ===');
  const before = errors.length;
  const topicCards = cards.filter(c => /How to read|does not say|tells you|monitoring would go/.test(c.textContent));
  ok(topicCards.length === 4, 'all four reading sections are reachable (' + topicCards.length + ')');
  const headings = [];
  topicCards.forEach(c => { click(c); headings.push($('#pTitle').textContent); });
  ok(headings.length === 4 && headings.every(Boolean), 'each opens with a title: ' + headings.join(' · '));
  const zoneCards = cards.filter(c => D.ZONES.some(z => c.textContent.indexOf(z.label) === 0));
  zoneCards.forEach(c => click(c));
  ok(/Oracle Cloud Infrastructure|On-Premises|Third-Party/.test($('#pTitle').textContent),
    'zone levels render (last: "' + $('#pTitle').textContent + '")');
  ok(errors.length === before, 'no errors raised while rendering every panel'
    + (errors.length > before ? ': ' + errors.slice(before, before + 3).join(' | ') : ''));

  console.log('\n=== 7. navigation: crumbs, back, forward, reset ===');
  click($('#reset'));
  ok(crumbText() === 'Estate', 'reset returns to the estate (crumbs: ' + crumbText() + ')');
  ok($('#back').disabled, 'back is disabled at the root');
  const ociCard = $$('#flatBody .flat-card').find(c => c.textContent.indexOf('Oracle Cloud Infrastructure') === 0);
  click(ociCard);
  ok(/Estate \/ .*Oracle Cloud/.test(crumbText()), 'entering a zone extends the breadcrumb (' + crumbText() + ')');
  ok(!$('#back').disabled, 'back becomes available');
  click($('#back'));
  ok(crumbText() === 'Estate', 'back returns to the estate');
  ok(!$('#fwd').disabled, 'forward becomes available after going back');
  click($('#fwd'));
  ok(/Oracle Cloud/.test(crumbText()), 'forward restores the level');
  click($('#reset'));

  console.log('\n=== 8. the level indicator counts depth ===');
  ok(/Level 0 · Estate/.test($('#lvl').textContent), 'level 0 is the estate (' + $('#lvl').textContent + ')');
  click($$('#flatBody .flat-card').find(c => c.textContent.indexOf('Oracle Cloud Infrastructure') === 0));
  ok(/Level 1 · Zone/.test($('#lvl').textContent), 'level 1 is a zone (' + $('#lvl').textContent + ')');
  click($('#reset'));

  console.log('\n=== 9. search ===');
  const si = $('#search');
  const type = q => {
    si.value = q;
    si.dispatchEvent(new window.Event('input', { bubbles: true }));
    return $$('#results .res').map(b => b.querySelector('b').textContent);
  };
  ok(type('siebel').length > 0, 'searching "siebel" returns hits (' + type('siebel').length + ')');
  ok(type('icici').indexOf('ICICI Bank API') >= 0, 'a feed is findable by name');
  ok(type('rac').some(l => /RAC|Database System/.test(l)), 'an alias finds the RAC database: ' + type('rac').join(', '));
  ok(type('hsm').some(l => /LGM/.test(l)), 'an alias finds the HSM: ' + type('hsm').join(', '));
  ok(type('tunnel').length > 0, 'the tunnel is findable by a word that is not in its label');
  ok(type('zzzznothing').length === 0 && /Nothing matches/.test($('#results').textContent),
    'an empty result says so rather than showing nothing');

  // Every indexed object must be findable by its own exact label.
  const unfindable = [];
  [].concat(
    D.ZONES.map(z => z.label), D.FEEDS.map(f => f.n), ALL.map(c => c.label), D.FLOWS.map(f => f.label)
  ).forEach(label => { if (type(label).indexOf(label) < 0) unfindable.push(label); });
  ok(unfindable.length === 0, 'every object is findable by its exact label'
    + (unfindable.length ? ' [' + unfindable.slice(0, 5).join(', ') + ']' : ''));

  click(type('ICICI Bank API').length ? $$('#results .res')[0] : null);
  ok($('#pTitle').textContent === 'ICICI Bank API' || /Third-Party/.test($('#pTitle').textContent),
    'choosing a search hit navigates to it');
  si.value = ''; si.dispatchEvent(new window.Event('input', { bubbles: true }));

  console.log('\n=== 10. guided tour ===');
  click($('#tourBtn'));
  ok($('#tour').classList.contains('open'), 'the tour opens');
  ok(/Chapter 1 of/.test($('#tourN').textContent), 'it starts at chapter 1 (' + $('#tourN').textContent + ')');
  const chapters = [];
  const errsBeforeTour = errors.length;
  for (let i = 0; i < 12; i++) {
    chapters.push($('#tourT').textContent);
    if (/Finish/.test($('#tourNext').textContent)) break;
    click($('#tourNext'));
  }
  ok(chapters.length === 10, 'the tour has 10 chapters and all of them ran (' + chapters.length + ')');
  ok(chapters.every(Boolean) && new Set(chapters).size === chapters.length, 'every chapter has a distinct title');
  ok(errors.length === errsBeforeTour, 'no errors while running the whole tour'
    + (errors.length > errsBeforeTour ? ': ' + errors.slice(errsBeforeTour, errsBeforeTour + 3).join(' | ') : ''));
  click($('#tourExit'));
  ok(!$('#tour').classList.contains('open'), 'the tour closes');
  click($('#reset'));


  console.log('');
  console.log('=== 10b. the flow is explained, not just animated ===');
  // The complaint that prompted this round: three boxes with specks in them,
  // and nothing on screen saying what moved where.
  const envs = fs.readFileSync(path.join(DIR, 'koel-envs.js'), 'utf8');
  const scene = fs.readFileSync(path.join(DIR, 'koel-scene.js'), 'utf8');
  ok(/KS\.G\.earth\(/.test(envs), 'the estate level is built over a globe');
  ok(/G\.earth = function/.test(scene) && /graticule/i.test(scene), 'the globe is a real primitive, not a sphere');
  ok(/function arrow\(/.test(envs), 'links can carry a direction and a caption');
  const captions = [...envs.matchAll(/label: '([^']+)'/g)].map(m => m[1]);
  ok(captions.length >= 9, 'every drawn connection is captioned in-scene (' + captions.length + ' captions)');
  ok(captions.some(c => /18 ingestion feeds/.test(c)), 'the ingestion path is named');
  ok(captions.some(c => /IPsec/.test(c)), 'the hybrid tunnel is named');
  ok(captions.some(c => /SFTP mount bridge/.test(c)), 'the SFTP bridge is named');
  ok(/both: true/.test(envs), 'bidirectional edges get two arrowheads');
  ok(/Who sends it/.test(envs), 'the estate carries a one-line reading of itself');
  ok(/alwaysOn: true/.test(envs), 'zone captions are pinned on rather than fading to dots');
  ok(/!it\.spec\.alwaysOn/.test(scene), 'a pinned label is exempt from occlusion demotion');
  ok(/body\.touring #legend/.test(raw), 'the legend clears out while the tour panel is up');

  click($('#reset'));
  const overview = $('#pBody').textContent;
  ok(/setting, not a map/.test(overview), 'the panel says the globe is a setting, not a location claim');
  ok(/left to right in the order data travels/.test(overview), 'and explains the arrangement');

  console.log('\n=== 11. no invented specifics ===');
  const src = ['koel-data.js', 'koel-envs.js', 'koel-app.js', 'koel-scene.js']
    .map(f => fs.readFileSync(path.join(DIR, f), 'utf8')).join('\n') + raw;
  const ips = src.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
  ok(ips.length === 0, 'no IP addresses anywhere' + (ips.length ? ' [' + ips.slice(0, 5).join(', ') + ']' : ''));
  const dsn = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"/]+:[^\s'"/@]+@/i;
  ok(!/password\s*[:=]\s*['"][^'"]{3,}/i.test(src) && !dsn.test(src),
    'no credential- or connection-string-shaped text');
  ok(/proposal/i.test(flat) || /proposal/i.test(doc.body.textContent),
    'the monitoring section is labelled a proposal');

  console.log('\n=== 12. accessibility & controls ===');
  click($('#motionBtn'));
  ok(doc.body.classList.contains('reduced'), 'reduce motion toggles on');
  click($('#motionBtn'));
  ok(!doc.body.classList.contains('reduced'), 'and back off');
  click($('#flatBtn'));
  ok(!$('#flat').classList.contains('show'), '2D view toggles off');
  click($('#flatBtn'));
  ok($('#flat').classList.contains('show'), 'and back on');
  ok($('#panel').getAttribute('role') === 'dialog', 'the panel keeps its ARIA role');
  ok($('#prox').getAttribute('aria-live') === 'polite', 'the proximity readout is announced');

  const real = errors.filter(e => !/getContext\(\) method: without installing the canvas/.test(e));
  ok(real.length === 0, 'no runtime errors in the whole session'
    + (real.length ? ': ' + real.slice(0, 4).join(' | ') : ''));

  console.log('\n' + '='.repeat(58));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('='.repeat(58));
  process.exit(fail ? 1 : 0);
}, 2600);
