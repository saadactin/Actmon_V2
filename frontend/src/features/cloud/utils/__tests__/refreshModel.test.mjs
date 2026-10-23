/**
 * Account refresh — pure logic.
 *
 * Run: node src/features/cloud/utils/__tests__/refreshModel.test.mjs
 *
 * The invalidation predicate gets most of the attention here because it is the
 * one piece that fails silently: if it matches nothing, every panel keeps
 * showing pre-refresh data and the only symptom is a user reaching for F5. If
 * it matches too much, one account's refresh drags every other account's
 * provider-backed queries along with it.
 */
import {
  attemptFailureView, busyRefusal, busyView, componentProgress, durationText, isActive,
  isBusy, isTerminal, lastRefreshedView, mentionsAccount, outcomeMessage, REFRESH_ALL_LABEL,
  REFRESHED_ROOTS, reloadWarning, shouldInvalidate, syncDecision,
} from '../refreshModel.js';

let pass = 0;
let fail = 0;
const results = [];

function check(name, cond, detail) {
  if (cond) { pass += 1; results.push(`  PASS  ${name}`); } else {
    fail += 1;
    results.push(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`);
  }
}
const eq = (name, got, want) => check(
  name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
);

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

/* ── Status helpers ──────────────────────────────────────────────────────── */
check('SUCCEEDED is terminal', isTerminal('SUCCEEDED'));
check('PARTIAL is terminal', isTerminal('PARTIAL'));
check('FAILED is terminal', isTerminal('FAILED'));
check('CANCELLED is terminal', isTerminal('CANCELLED'));
check('RUNNING is not terminal', !isTerminal('RUNNING'));
check('QUEUED is not terminal', !isTerminal('QUEUED'));
check('QUEUED is active', isActive('QUEUED'));
check('SUCCEEDED is not active', !isActive('SUCCEEDED'));
check('unknown status is neither', !isTerminal('WAT') && !isActive('WAT'));

/* ── mentionsAccount ─────────────────────────────────────────────────────── */
check('finds a bare id', mentionsAccount([A], A));
check('finds an id inside an object', mentionsAccount([{ account_id: A }], A));
check('finds an id nested two deep',
  mentionsAccount([{ filters: { account_id: A } }], A));
check('does not match a different account', !mentionsAccount([B], A));
check('does not match a substring',
  !mentionsAccount([`${A}-suffix`], A));
check('ignores numbers and booleans', !mentionsAccount([30, true, null], A));
check('empty accountId never matches', !mentionsAccount([A], null));
check('stops recursing on deeply nested structures',
  !mentionsAccount([[[[[[A]]]]]], A));

/* ── shouldInvalidate ────────────────────────────────────────────────────── */
// Real keys, copied from the hooks that build them.
const REAL_KEYS = [
  ['cloudOverview', 'inventory', A, null],
  ['cloudOverview', 'posture', A],
  ['cloudOverview', 'costTotal', A],
  ['cloudOverview', 'costSeries', A, 30],
  ['cloudOverview', 'events', A, '7d'],
  ['cloudOverview', 'topology', A],
  ['cloudOverview', 'discovery', A],
  ['cloudOverview', 'changes', A, 30],
  ['cloudResources', 'query', A, { status: 'RUNNING' }, {}],
  ['cloudResources', 'summary', A, {}],
  ['cloudResources', 'facets', A, {}],
  ['securityCenter', 'overview', A],
  ['securityCenter', 'findings', A, {}],
  ['securityCenter', 'score', A],
  ['internetExposure', A],
  ['iamReview', A],
  ['costAnalytics', A],
  ['costHistory', A, 30, 'service', {}],
  ['costQuality', A],
  ['costCoverage', A],
  ['costAnomalies', A, 30, {}],
  ['driftChanges', A, 30, {}],
  ['driftSummary', A, 30],
  ['driftFacets', A, 30],
  ['cloudEvents', { account_id: A }, {}],
  ['cloudEventStats', { account_id: A }],
  ['cloudEventFacets', A, '7d'],
  ['topology', A, { view: null }],
  ['cloudAlerts', 'summary', A],
  ['cloudAlerts', 'instances', A, {}],
  ['accountDiagnostics', A],
];
REAL_KEYS.forEach((key) => {
  check(`invalidates ${key[0]}/${key[1] ?? ''}`.trim(), shouldInvalidate(key, A),
    `key ${JSON.stringify(key)} did not match`);
});

// The isolation guarantee: the same keys for ANOTHER account must not match.
REAL_KEYS.forEach((key) => {
  check(`leaves other account's ${key[0]} alone`, !shouldInvalidate(key, B));
});

// Roots that are not account data must be left alone even when the id appears.
[
  ['cloudEventSettings'],
  ['cloudEventSavedQueries'],
  ['costMetrics'],
  ['costAlertPolicies'],
  ['appTheme', A],
  ['discoveryStatus', A],
].forEach((key) => {
  check(`does not invalidate ${key[0]}`, !shouldInvalidate(key, A));
});

check('a root with no account in the key does not match',
  !shouldInvalidate(['cloudResources', 'accountCounts'], A));
check('the root alone is not enough',
  !shouldInvalidate(['cloudOverview'], A));
check('a non-array key is refused', !shouldInvalidate('cloudOverview', A));
check('a missing accountId invalidates nothing',
  !shouldInvalidate(['cloudOverview', 'posture', A], null));
check('every declared root is a non-empty string',
  REFRESHED_ROOTS.every((r) => typeof r === 'string' && r.length > 0));
check('no duplicate roots',
  new Set(REFRESHED_ROOTS).size === REFRESHED_ROOTS.length);

/* ── componentProgress ───────────────────────────────────────────────────── */
const COMPONENTS = {
  connection: { label: 'Account connection', status: 'SUCCEEDED' },
  resources: { label: 'Resource discovery', status: 'SUCCEEDED' },
  drift: { label: 'Configuration drift', status: 'SUCCEEDED' },
  cost: { label: 'Cost data', status: 'RUNNING' },
  security: { label: 'Security assessment', status: 'PENDING' },
  events: { label: 'Event collection', status: 'PENDING' },
};
const prog = componentProgress(COMPONENTS);
eq('progress counts total', prog.total, 6);
eq('progress counts finished components', prog.done, 3);
eq('progress names the running component', prog.running, 'Cost data');
eq('progress lists no failures yet', prog.failed, []);
check('progress carries no percentage field',
  !('percent' in prog) && !('pct' in prog));

const partial = componentProgress({
  ...COMPONENTS,
  cost: { label: 'Cost data', status: 'FAILED' },
  security: { label: 'Security assessment', status: 'SKIPPED' },
  events: { label: 'Event collection', status: 'SUCCEEDED' },
});
eq('failed components are named', partial.failed, ['Cost data']);
eq('skipped components are named', partial.skipped, ['Security assessment']);
eq('nothing is running once everything settled', partial.running, null);
eq('empty components give a zero total', componentProgress(null).total, 0);

/* ── outcomeMessage ──────────────────────────────────────────────────────── */
eq('success message', outcomeMessage({ status: 'SUCCEEDED', components: COMPONENTS }),
  'Account refresh completed.');

const partialMsg = outcomeMessage({
  status: 'PARTIAL',
  components: {
    cost: { label: 'Cost data', status: 'FAILED' },
    security: { label: 'Security assessment', status: 'SKIPPED' },
  },
});
check('partial message names what failed', partialMsg.includes('Cost data'), partialMsg);
check('partial message names what was skipped',
  partialMsg.includes('Security assessment'), partialMsg);
check('partial message says old data was kept',
  partialMsg.includes('Previous data was kept'), partialMsg);

const failMsg = outcomeMessage({
  status: 'FAILED',
  error: 'The AWS credentials were rejected.',
  components: {},
});
check('failure message carries the real reason',
  failMsg.includes('The AWS credentials were rejected.'), failMsg);
check('failure message reassures that data was kept',
  failMsg.includes('Existing data was kept'), failMsg);
check('failure with no recorded reason still says data was kept',
  outcomeMessage({ status: 'FAILED', components: {} })
    .includes('Existing data was kept'));
check('cancelled message says data was kept',
  outcomeMessage({ status: 'CANCELLED', components: {} })
    .includes('Existing data was kept'));
eq('a running refresh has no outcome message',
  outcomeMessage({ status: 'RUNNING', components: COMPONENTS }), null);
eq('no refresh, no message', outcomeMessage(null), null);

// No message may claim success the record does not carry.
['PARTIAL', 'FAILED', 'CANCELLED'].forEach((status) => {
  const msg = outcomeMessage({ status, components: {} }) || '';
  check(`${status} never reads as a plain success`,
    !/^Account refresh completed\.$/.test(msg), msg);
});

/* ── One name ────────────────────────────────────────────────────────────── */
eq('the one refresh control is called Refresh all', REFRESH_ALL_LABEL, 'Refresh all');

/* ── Every tab re-reads when the account's data changes ──────────────────── */
// The old header invalidated only when the SAME mounted instance watched its
// own refresh finish: start one, switch tabs, and nothing re-read.
const V1 = '2026-09-29T09:04:52+00:00';
const V2 = '2026-09-29T09:06:33+00:00';
eq('first sighting records the version without re-reading',
  syncDecision(undefined, V1), { invalidate: false, remember: true });
eq('a newer version re-reads every tab', syncDecision(V1, V2),
  { invalidate: true, remember: true });
eq('the same version does nothing', syncDecision(V2, V2),
  { invalidate: false, remember: false });
eq('an older version (a lagging poll) does nothing', syncDecision(V2, V1),
  { invalidate: false, remember: false });
eq('no version yet does nothing', syncDecision(V1, null),
  { invalidate: false, remember: false });
eq('an unparseable version does nothing', syncDecision(V1, 'soon'),
  { invalidate: false, remember: false });
check('versions compare as instants, not strings: +05:30 vs Z',
  syncDecision('2026-09-29T09:10:00Z', '2026-09-29T14:45:00+05:30').invalidate);

/* ── Busy: a refresh OR a plain scan ─────────────────────────────────────── */
check('a running refresh is busy', isBusy({ is_running: true, is_busy: true }));
check('a plain scan is busy too', isBusy({ is_running: false, is_busy: true }));
check('an older payload without is_busy falls back to is_running',
  isBusy({ is_running: true }));
check('nothing running is not busy', !isBusy({ is_running: false, is_busy: false }));
check('no payload is not busy', !isBusy(null));

const running = busyView({
  current: { status: 'RUNNING', components: COMPONENTS },
}, null);
eq('a running refresh shows stages, not a percentage', running.text, '3 of 6 · Cost data');
eq('...and its components', running.kind, 'refresh');
eq('...and how many resources its sweep has committed so far',
  busyView({ current: { status: 'RUNNING', components: COMPONENTS },
    current_scan: { job_id: 'j', resources_found: 223 } }, null).text,
  '3 of 6 · Cost data · 223 found so far');
const scanning = busyView({ current: null, active_scan: { job_id: 'j', resources_found: 1234 } }, null);
eq('a plain scan says it is scanning, with what it has found',
  scanning.text, `Scanning · ${(1234).toLocaleString()} found so far`);
eq('...and has no refresh components to show', scanning.components, null);
eq('nothing running shows nothing', busyView({ current: null, active_scan: null }, null), null);
const lagging = busyView({ current: { status: 'RUNNING', components: COMPONENTS } },
  { status: 'SUCCEEDED', components: COMPONENTS });
check('a watched record that already finished defers to the poll, not the other way',
  lagging && lagging.kind === 'refresh');

/* ── Last refreshed ──────────────────────────────────────────────────────── */
const partialLast = lastRefreshedView({ last_refreshed: {
  at: V2, status: 'PARTIAL', scopes_read: 218, scopes_attempted: 272,
  note: 'Resource discovery was incomplete.',
} });
check('a partial refresh says Partial', partialLast.partial);
check('...and why, with the scope count', partialLast.detail.includes('218 of 272 scopes read')
  && partialLast.detail.includes('Resource discovery was incomplete.'), partialLast.detail);
eq('it carries the time for the header', partialLast.at, V2);
const cleanLast = lastRefreshedView({ last_refreshed: { at: V2, status: 'SUCCEEDED' } });
check('a clean refresh is not Partial and carries no reason',
  !cleanLast.partial && cleanLast.detail === null);
eq('never refreshed has no time', lastRefreshedView({ last_refreshed: null }).at, null);

/* ── A refused start is the answer, not an error ─────────────────────────── */
const err409 = (detail) => ({ response: { status: 409, data: { detail } } });
eq('409 with a refresh latches onto it',
  busyRefusal(err409({ refresh: { refresh_id: 'r1' } })), { kind: 'refresh', refreshId: 'r1' });
eq('409 with a plain scan says a scan is running',
  busyRefusal(err409({ scan: { job_id: 'j1' } })), { kind: 'scan', jobId: 'j1' });
eq('a 500 is a real error', busyRefusal({ response: { status: 500, data: { detail: 'x' } } }), null);
eq('a network error is a real error', busyRefusal({ message: 'Network Error' }), null);

/* ── An incomplete sweep ─────────────────────────────────────────────────── */
const incomplete = {
  ...COMPONENTS,
  resources: { label: 'Resource discovery', status: 'SUCCEEDED', incomplete: true },
  cost: { label: 'Cost data', status: 'SUCCEEDED' },
  security: { label: 'Security assessment', status: 'SUCCEEDED' },
  events: { label: 'Event collection', status: 'SUCCEEDED' },
};
eq('a SUCCEEDED-but-incomplete component is named', componentProgress(incomplete).incomplete,
  ['Resource discovery']);
eq('...and is not counted as failed', componentProgress(incomplete).failed, []);
const incompleteMsg = outcomeMessage({ status: 'PARTIAL', components: incomplete });
check('the outcome says it read only part of the account',
  incompleteMsg.includes('Resource discovery read only part of the account'), incompleteMsg);
check('...never that the refresh completed', !incompleteMsg.startsWith('Account refresh completed'));
const bothMsg = outcomeMessage({
  status: 'PARTIAL',
  components: { ...incomplete, cost: { label: 'Cost data', status: 'FAILED' } },
});
check('a failure and an incomplete sweep are both named',
  bothMsg.includes('Cost data could not be updated')
  && bothMsg.includes('Resource discovery read only part of the account'), bothMsg);

/* ── Auto-reload: the restart that kept killing refreshes ────────────────── */
// Every FAILED refresh from 12 to 23 Oct 2026 was "Interrupted: the service
// restarted": the service ran `uvicorn --reload` and code was being saved.
eq('seconds read as seconds', durationText(40), '40 s');
eq('minutes are rounded', durationText(211), '4 min');
eq('hours carry their minutes', durationText(5633), '1 h 34 min');
eq('a whole hour drops the minutes', durationText(7200), '2 h');
eq('nonsense is null, not "NaN min"', durationText('x'), null);

const unguarded = { service: { auto_reload: 'unguarded' }, typical_duration_s: 5467 };
const warn = reloadWarning(unguarded);
check('a bare --reload service warns before a refresh starts', !!warn);
check('...says a save stops a running refresh', /stops a refresh/.test(warn.label), warn.label);
check('...with this account\'s typical length', warn.text.includes('1 h 31 min'), warn.text);
check('...and how to avoid it', warn.text.includes('dev_server.py'), warn.text);
check('no typical length is not printed as "null"',
  !reloadWarning({ service: { auto_reload: 'unguarded' } }).text.includes('null'));
// The backend sends null, not undefined, for an account with no finished
// refresh, and Number(null) is 0.
check('a null typical length is left out, not printed as "0 s"',
  !reloadWarning({ service: { auto_reload: 'unguarded' }, typical_duration_s: null })
    .text.includes('typically'));
eq('the guarded dev server needs no warning',
  reloadWarning({ service: { auto_reload: 'guarded' } }), null);
eq('no reload needs no warning', reloadWarning({ service: { auto_reload: 'off' } }), null);
eq('an older backend without the field needs no warning', reloadWarning({}), null);

const interrupted = {
  status: 'FAILED',
  error_code: 'interrupted',
  error: 'Interrupted: the service restarted while this refresh was running, so its outcome is unknown.',
  started_at: '2026-10-23T05:29:21Z',
  completed_at: '2026-10-23T05:32:53Z',
};
const why = attemptFailureView(interrupted);
check('an interrupted attempt says the service restarted, and when',
  why.reason.includes('restarted 4 min into the refresh'), why.reason);
check('...that existing data was kept', why.reason.includes('Existing data was kept'));
check('...and keeps the stored error for the tooltip', why.detail === interrupted.error);
check('no recorded times still gives a reason',
  attemptFailureView({ status: 'FAILED', error_code: 'interrupted' }).reason
    .includes('restarted during the refresh'));
eq('another failure shows its own error',
  attemptFailureView({ status: 'FAILED', error: 'Credentials rejected.' }).reason,
  'Credentials rejected.');
eq('a successful attempt has no failure view',
  attemptFailureView({ status: 'SUCCEEDED' }), null);

/* ── Report ──────────────────────────────────────────────────────────────── */
console.log('\nAccount refresh — model tests\n');
console.log(results.join('\n'));
console.log(`\nPASS ${pass}  FAIL ${fail}\n`);
process.exit(fail ? 1 : 0);
