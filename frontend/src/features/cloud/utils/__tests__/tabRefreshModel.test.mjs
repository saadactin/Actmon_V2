/**
 * Per-tab refresh — pure logic.
 *
 * Run: node src/features/cloud/utils/__tests__/tabRefreshModel.test.mjs
 *
 * What matters most here is honesty: a tab's refresh must never be captioned
 * as a provider re-read when it only re-read stored data, a viewer must never
 * be offered provider work, and provider work must be held while "Refresh
 * all" is already rewriting the account. Every check calls the production
 * functions — no re-implemented rule (see test-mirrors-prove-nothing).
 */
import {
  DELEGATED_TABS, SOURCE_ASSESS, SOURCE_PROVIDER, SOURCE_STORED, TAB_REFRESH,
  TAB_REFRESH_ACTIONS, tabRefreshError, tabRefreshLabel, tabRefreshOutcome,
  tabRefreshPlan,
} from '../tabRefreshModel.js';
import { REFRESH_ALL_LABEL } from '../refreshModel.js';

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) pass += 1; else fail += 1;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`);
};

console.log('\n1. Every declared tab is well-formed');
{
  const bad = Object.entries(TAB_REFRESH)
    .filter(([, e]) => !TAB_REFRESH_ACTIONS[e.action] || !e.noun);
  check('every tab names a known action and a noun', bad.length === 0,
    bad.map(([k]) => k).join(', '));
  const labels = Object.values(TAB_REFRESH).map((e) => tabRefreshLabel(e.noun));
  check('every label has the one shape "Refresh <tab>"',
    labels.every((l) => /^Refresh [a-z]/.test(l)), labels.join(' | '));
  check('no tab is labelled like the header button', !labels.includes(REFRESH_ALL_LABEL));
  check('Security Center main tab delegates to its sub-tabs',
    DELEGATED_TABS.includes('security') && !TAB_REFRESH.security);
  check('an unknown tab has no refresh', tabRefreshPlan('nope', { canExecute: true }) === null);
}

console.log('\n2. Where the data comes from');
{
  const src = (k) => tabRefreshPlan(k, { canExecute: true }).source;
  check('resources re-reads the provider (a discovery scan)', src('resources') === SOURCE_PROVIDER
    && tabRefreshPlan('resources', { canExecute: true }).action === 'discovery');
  check('cost re-reads the provider', src('cost') === SOURCE_PROVIDER);
  check('events re-reads the provider', src('events') === SOURCE_PROVIDER);
  check('certificates re-reads the provider', src('security.certificates') === SOURCE_PROVIDER);
  check('identity re-reads the provider', src('security.identity') === SOURCE_PROVIDER);
  check('findings re-evaluates, no provider call', src('security.findings') === SOURCE_ASSESS);
  check('topology and drift are derived: stored re-read only',
    src('topology') === SOURCE_STORED && src('drift') === SOURCE_STORED);
  check('only the scan runs in the background',
    Object.keys(TAB_REFRESH).filter((k) => tabRefreshPlan(k, { canExecute: true }).background)
      .join(',') === 'resources');
  check('a stored re-read says nothing is fetched',
    /Nothing is fetched/.test(tabRefreshPlan('topology', { canExecute: true }).title));
}

console.log('\n3. Permissions and busy state');
{
  const viewer = tabRefreshPlan('security.certificates', { canExecute: false });
  check('a viewer gets the stored re-read, never provider work',
    viewer.action === 'reload' && viewer.source === SOURCE_STORED);
  check('a viewer keeps the tab\'s own label', viewer.label === 'Refresh certificates');
  const held = tabRefreshPlan('cost', { canExecute: true, busy: true });
  check('provider work is held while Refresh all runs', held.disabled === true
    && /already/.test(held.title));
  check('assessments are held too (they would race the refresh\'s own)',
    tabRefreshPlan('security.findings', { canExecute: true, busy: true }).disabled);
  check('a stored re-read still works while busy — it shows progress so far',
    tabRefreshPlan('topology', { canExecute: true, busy: true }).disabled === false);
  check('idle provider work is enabled',
    tabRefreshPlan('cost', { canExecute: true, busy: false }).disabled === false);
}

console.log('\n4. Captions never claim more than the response did');
{
  check('reload says stored', tabRefreshOutcome('reload', {}) === 'Re-read stored data');
  check('scan says started, not done', /started/.test(tabRefreshOutcome('discovery', { id: 'x' })));
  check('assess counts findings',
    tabRefreshOutcome('assess', { findings: 1234 }) === 'Re-evaluated · 1,234 findings');
  check('certificates counts objects and names failed stores',
    tabRefreshOutcome('certificates', { objects: 38, scopes_failed: 2 })
      === 'Read 38 objects from the provider · 2 stores could not be read');
  check('identity Collected counts grants',
    tabRefreshOutcome('identity', { identity: { status: 'Collected', grants: 7 } })
      === 'Read 7 grants from the provider');
  check('identity NotSupported is not called a failure',
    /inventory/.test(tabRefreshOutcome('identity', { identity: { status: 'NotSupported' } })));
  check('identity refusal keeps last known',
    /refused.*kept last known/.test(
      tabRefreshOutcome('identity', { identity: { status: 'PermissionDenied' } })));
  check('events counts and names failed scopes',
    tabRefreshOutcome('events', { events_stored: 5, scopes_failed: 1 })
      === 'Collected 5 new events · 1 scopes failed');
  check('cost success counts facts',
    tabRefreshOutcome('cost', { ingestion: { ok: true, inserted: 3, updated: 27 } })
      === 'Re-read billing · 3 written, 27 corrected');
  check('cost refusal says the old numbers were kept, and why',
    /kept last known cost \(Too many requests\)/.test(tabRefreshOutcome('cost',
      { ingestion: { ok: false, error: { message: 'Too many requests' } } })));
}

console.log('\n5. Errors');
{
  check('409 is "already running", not a failure',
    /Already running/.test(tabRefreshError({ response: { status: 409, data: { detail: { message: 'x' } } } })));
  check('object detail message is shown',
    tabRefreshError({ response: { status: 500, data: { detail: { message: 'boom' } } } })
      === 'Refresh failed · boom');
  check('string detail is shown',
    tabRefreshError({ response: { status: 404, data: { detail: 'Account not found' } } })
      === 'Refresh failed · Account not found');
  check('a network error without response still reads',
    tabRefreshError(new Error('Network Error')) === 'Refresh failed · Network Error');
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
